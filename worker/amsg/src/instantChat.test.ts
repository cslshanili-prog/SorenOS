// worker/amsg/src/instantChat.test.ts
//
// 即時對話這條路上最要命的是「順序」和「失敗就別落任務」：雲端狀態沒傳上去卻把任務
// 建了，到點那條 fire 會拿上一輪的上下文答這一輪的話——不報錯、不重試，用戶只會覺得
// 角色突然聽不懂人話。下面每條都對著一種具體的壞法。
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  applyInstantNotificationPolicy,
  buildInstantTimelyBlock,
  handleInstantChat,
  isInstantChatTask,
} from './instantChat';
import { TIME_FRAMING_CONVERSATIONAL } from '../../../utils/timeFramingNote';

const USER_ID = '3637dae1-1461-4444-a747-34e406f67acc';
const TASK_UUID = '7a1f0b4c-2c9d-4a3e-8b21-9f0f3c5d7e11';

/** 客戶端預加密的信封（內容不重要，形狀要對）。 */
const envelope = (tag: string) => ({ iv: `iv-${tag}`, authTag: `tag-${tag}`, encryptedData: `data-${tag}` });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });

/** 記下每一次內部轉發，順序本身就是要釘的東西。 */
const makeUpstream = (opts: {
  clientState?: { status: number; body?: unknown };
  scheduleMessage?: { status: number; body?: unknown };
} = {}) => {
  const calls: Array<{ method: string; path: string; search: string; headers: Record<string, string>; body: string }> = [];
  const reply = (spec: { status: number; body?: unknown } | undefined, fallback: unknown) =>
    json(spec?.status ?? 200, spec?.body ?? fallback);
  const upstream = {
    fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      calls.push({
        method: request.method.toUpperCase(),
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (url.pathname.endsWith('/client-state')) {
        return reply(opts.clientState, { success: true, data: { upserted: 3, skipped: 0 } });
      }
      if (url.pathname.endsWith('/schedule-message')) {
        return reply(opts.scheduleMessage, { success: true, data: { uuid: TASK_UUID, id: 42 } });
      }
      return json(404, { success: false });
    }),
  };
  return { upstream, calls, paths: () => calls.map((c) => `${c.method} ${c.path}`) };
};

/**
 * INSTANT_TICK 綁定的替身。記下叫醒了哪個實例、傳了哪個 uuid。
 *
 * `kick` 只負責給 DO 記下 uuid、設 alarm，真正的生成在 alarm 裡跑（另一次 invocation，
 * 走 upstream.runTask），所以這條路上根本碰不到 upstream 的執行入口——那是 DO 側的事，
 * 見 index.ts 的 InstantTickDO。
 */
const makeTick = (opts: { kick?: () => Promise<unknown> } = {}) => {
  const kicks: Array<{ instance: string; uuid: string }> = [];
  return {
    kicks,
    INSTANT_TICK: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        kick: async (uuid: string) => {
          kicks.push({ instance: id.name, uuid });
          return opts.kick ? opts.kick() : undefined;
        },
      }),
    },
  };
};

const post = (
  body: unknown,
  opts: { headers?: Record<string, string>; url?: string } = {},
) => new Request(opts.url ?? 'https://w.example/instant-chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID, ...(opts.headers ?? {}) },
  body: JSON.stringify(body),
});

const validBody = (extra: Record<string, unknown> = {}) => ({
  statePayload: envelope('state'),
  taskPayload: envelope('task'),
  ...extra,
});

/** 默認參數跑一次。重試梯子清零：釘的是「重了幾次」，不是「等了多久」。 */
const run = (args: {
  request: Request;
  env?: Record<string, unknown>;
  upstream: ReturnType<typeof makeUpstream>['upstream'];
  /** 不傳就用一個正常工作的替身；要測「Worker 是舊的」顯式傳 null。 */
  tick?: ReturnType<typeof makeTick> | null;
}) => handleInstantChat({
  request: args.request,
  env: {
    ...(args.tick === null ? {} : { INSTANT_TICK: (args.tick ?? makeTick()).INSTANT_TICK }),
    ...(args.env ?? {}),
  } as any,
  upstream: args.upstream as any,
  json,
  stateBackoffMs: [0, 0, 0],
});

describe('POST /instant-chat — 鑑權', () => {
  it('配了口令而請求沒帶 → 401，而且一個字節的雲端狀態都不寫', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody()),
      env: { AMSG_SERVER_TOKEN: 'secret' },
      upstream,
    });
    expect(response.status).toBe(401);
    // 迴歸守衛：沒有這道門的話，轉發出去的 PUT /client-state 會先把狀態寫進庫，
    // 上游那邊才 401——一個沒通過鑑權的請求已經改了庫裡的數據。
    expect(calls).toHaveLength(0);
  });

  it('口令不對 → 401，同樣不轉發', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody(), { headers: { 'X-Client-Token': 'wrong' } }),
      env: { AMSG_SERVER_TOKEN: 'secret' },
      upstream,
    });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('口令對得上 → 放行，並把它原樣帶給上游（上游是權威，還要再驗一次）', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody(), { headers: { 'X-Client-Token': 'secret' } }),
      env: { AMSG_SERVER_TOKEN: 'secret' },
      upstream,
    });
    expect(response.status).toBe(202);
    expect(calls.every((c) => c.headers['x-client-token'] === 'secret')).toBe(true);
  });

  it('沒配口令 → 不校驗（跟上游同一套判據）', async () => {
    const { upstream } = makeUpstream();
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
  });

  it('缺 X-User-Id / 不是 UUID v4 → 400，不轉發', async () => {
    const { upstream, calls } = makeUpstream();
    const noUser = new Request('https://w.example/instant-chat', {
      method: 'POST', body: JSON.stringify(validBody()),
    });
    expect((await run({ request: noUser, upstream })).status).toBe(400);
    const badUser = post(validBody(), { headers: { 'X-User-Id': 'not-a-uuid' } });
    expect((await run({ request: badUser, upstream })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /instant-chat — 請求體', () => {
  it('不是 JSON 對象 → 400', async () => {
    const { upstream, calls } = makeUpstream();
    const bad = new Request('https://w.example/instant-chat', {
      method: 'POST', headers: { 'X-User-Id': USER_ID }, body: 'not json',
    });
    const response = await run({ request: bad, upstream });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe('INVALID_JSON');
    expect(calls).toHaveLength(0);
  });

  it('兩個信封形狀不對 → 400，且在任何轉發之前就擋住', async () => {
    const { upstream, calls } = makeUpstream();
    const noState = await run({ request: post({ taskPayload: envelope('t') }), upstream });
    expect(noState.status).toBe(400);
    expect((await noState.json() as any).error.code).toBe('INVALID_STATE_PAYLOAD');

    // taskPayload 不合格時同樣一次都不轉發——否則狀態先寫進去了，任務卻建不成，
    // 雲端留下一份「用戶已經說了這句」而角色永遠不會回。
    const noTask = await run({ request: post({ statePayload: envelope('s') }), upstream });
    expect(noTask.status).toBe(400);
    expect((await noTask.json() as any).error.code).toBe('INVALID_TASK_PAYLOAD');
    expect(calls).toHaveLength(0);
  });
});

// 客戶端在 body 超閾值時會 gzip 再發（這條路上的正文是整輪聊天，最大的一份）。
// 這三條釘的是「解壓這一步不能因為鏈路上有人插手就炸」——掛了的表現是所有大 body
// 的請求統統 400 INVALID_JSON，而小 body 一切正常，從外面看像是「長消息發不出去」。
describe('POST /instant-chat — gzip 上行', () => {
  const gzip = async (text: string): Promise<ArrayBuffer> => {
    const stream = new Response(new TextEncoder().encode(text)).body!
      .pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  };

  const postRaw = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('https://w.example/instant-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID, ...headers },
      body,
    });

  it('壓過的請求體解得開，轉發出去的還是原來那兩個信封', async () => {
    const { upstream, calls } = makeUpstream();
    const payload = JSON.stringify(validBody());
    const response = await run({
      request: postRaw(await gzip(payload), { 'Content-Encoding': 'gzip' }),
      upstream,
    });
    expect(response.status).toBe(202);
    // 信封原樣搬到上游，一個字段都不能在解壓途中掉（轉發時信封本身就是整個 body）。
    expect(JSON.parse(calls[0].body)).toEqual(envelope('state'));
    expect(JSON.parse(calls[1].body)).toEqual(envelope('task'));
  });

  // 最要命的一檔：`Content-Encoding` 是標準頭，鏈路上的邊緣節點會替你把請求體解開
  // 卻把頭留著（SullyOS 實測遇到過）。只看頭就去解壓的話，
  // 這裡拿到的是明文，解壓器當場拋錯，用戶側是一句「請求體不是合法的 JSON」。
  it('頭寫著 gzip、字節其實是明文（邊緣替我們解過了）→ 照常按明文讀', async () => {
    const { upstream } = makeUpstream();
    const response = await run({
      request: postRaw(JSON.stringify(validBody()), { 'Content-Encoding': 'gzip' }),
      upstream,
    });
    expect(response.status).toBe(202);
  });

  it('沒有這個頭 → 一字不差地走老路（老客戶端不壓）', async () => {
    const { upstream } = makeUpstream();
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
  });
});

describe('POST /instant-chat — 嚴格順序與失敗傳播', () => {
  it('順序：先傳雲端狀態，再建任務', async () => {
    const { upstream, paths } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });

  it('雲端狀態失敗 → 原樣把狀態碼報回去，而且**絕不建任務**', async () => {
    const { upstream, paths } = makeUpstream({
      clientState: { status: 400, body: { success: false, error: { code: 'TOO_MANY_STATE_ENTRIES' } } },
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_FAILED');
    expect(body.error.step).toBe('client-state');
    expect(body.error.upstream.error.code).toBe('TOO_MANY_STATE_ENTRIES');
    // 迴歸守衛：這一步失敗還往下建任務的話，到點那條 fire 會拿上一輪的上下文答這一輪。
    expect(paths()).toEqual(['PUT /client-state']);
  });

  // HTTP ok ≠ 都寫進去了：上游按 updatedAt 條件寫，被攔的條目在成功體 skippedEntries 裡
  // 點名。fire_pack 被攔（設備時鐘回撥過）還落任務的話，fire 會拿舊 chat 段答話——用戶
  // 拿著 202 白等一輪甚至收到答非所問，且無任何報錯。
  it('client-state 200 但 fire_pack 被條件寫攔下 → 409 INSTANT_CHAT_STATE_STALE，絕不建任務', async () => {
    const { upstream, paths } = makeUpstream({
      clientState: {
        status: 200,
        body: {
          success: true,
          data: { upserted: 2, skippedEntries: [{ namespace: 'amsg:char:c1', key: 'fire_pack' }] },
        },
      },
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_STALE');
    expect(body.error.step).toBe('client-state');
    expect(paths()).toEqual(['PUT /client-state']);
  });

  it('client-state 200、被攔的只是別的條目（非 fire_pack）→ 照常受理', async () => {
    const { upstream } = makeUpstream({
      clientState: {
        status: 200,
        body: {
          success: true,
          data: { upserted: 2, skippedEntries: [{ namespace: 'amsg:char:c1', key: 'chat_presence' }] },
        },
      },
    });
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
  });

  it('建任務失敗 → 報 schedule-message 那一步，不假裝受理', async () => {
    const { upstream } = makeUpstream({
      scheduleMessage: { status: 409, body: { success: false, error: { code: 'PUSH_SUBSCRIPTION_MISSING' } } },
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_TASK_FAILED');
    expect(body.error.step).toBe('schedule-message');
  });

  it('上游回了 200 卻沒給 uuid → 502（跟不上這一輪，寧可讓客戶端重發）', async () => {
    const { upstream } = makeUpstream({ scheduleMessage: { status: 200, body: { success: true, data: {} } } });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(502);
    expect((await response.json() as any).error.code).toBe('INSTANT_CHAT_TASK_UUID_MISSING');
  });

  it('轉發帶全套加密頭：上游照常解密 + 鑑權，包裝層不碰用戶密鑰', async () => {
    const { upstream, calls } = makeUpstream();
    await run({ request: post(validBody()), upstream });
    const state = calls.find((c) => c.path.endsWith('/client-state'))!;
    expect(state.headers['x-user-id']).toBe(USER_ID);
    expect(state.headers['x-payload-encrypted']).toBe('true');
    expect(state.headers['x-encryption-version']).toBe('1');
    // 信封原樣搬運，不重新包一層
    expect(JSON.parse(state.body)).toEqual(envelope('state'));
    const task = calls.find((c) => c.path.endsWith('/schedule-message'))!;
    expect(JSON.parse(task.body)).toEqual(envelope('task'));
  });

  it('worker 掛在子路徑下時，內部轉發跟著掛載點走（上游按後綴匹配）', async () => {
    const { upstream, calls } = makeUpstream();
    await run({
      request: post(validBody(), { url: 'https://w.example/amsg/instant-chat' }),
      upstream,
    });
    expect(calls.map((c) => c.path)).toEqual(['/amsg/client-state', '/amsg/schedule-message']);
  });

  it('202 的形狀是 { status: "accepted", uuid }', async () => {
    const { upstream } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'accepted', uuid: TASK_UUID });
  });
});

// 上游 500 的 message 是一句寫死的「服務器內部錯誤」，用戶照著它什麼也做不了。
// 真實原因（缺表、D1 超時……）由 amsg-server 2.6.0-next.16 起放在 error.cause 裡，
// 這裡必須原樣端到客戶端面前——否則他看到的還是那句什麼都沒說的話。
describe('POST /instant-chat — 把上游 error.cause 裡那句真話帶回去', () => {
  /** 上游拋異常時的真實響應：泛型 message + 帶真因的 cause。 */
  const throwsInside = (
    status = 500,
    cause: Record<string, unknown> | null = {
      stage: 'request',
      name: 'Error',
      message: 'D1_ERROR: no such table: message_outbox',
      code: 'D1_ERROR',
    },
  ) => ({
    status,
    body: {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服務器內部錯誤', ...(cause ? { cause } : {}) },
    },
  });

  it('client-state 那步：真實原因隨 upstreamLog 回給客戶端', async () => {
    const { upstream } = makeUpstream({ clientState: throwsInside() } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(500);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_FAILED');
    expect(body.error.upstreamLog).toBe('D1_ERROR: no such table: message_outbox');
  });

  it('schedule-message 那步同理', async () => {
    const { upstream } = makeUpstream({ scheduleMessage: throwsInside() } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(500);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_TASK_FAILED');
    expect(body.error.upstreamLog).toBe('D1_ERROR: no such table: message_outbox');
  });

  it('code 不是 message 前綴時兩個都帶上（光一句 message 看不出是哪類錯）', async () => {
    const { upstream } = makeUpstream({
      clientState: throwsInside(500, {
        stage: 'request', name: 'Error', message: '寫不進去', code: 'STORAGE_FAILED',
      }),
    } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect((await response.json() as any).error.upstreamLog).toBe('STORAGE_FAILED: 寫不進去');
  });

  it('沒有 code 時退回 name', async () => {
    const { upstream } = makeUpstream({
      clientState: throwsInside(500, { stage: 'request', name: 'TypeError', message: '炸了' }),
    } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect((await response.json() as any).error.upstreamLog).toBe('TypeError: 炸了');
  });

  // 4xx 是上游自己判出來的業務錯，正文裡已經寫清了原因；再綴一段內部細節只會讓人更迷惑。
  it('4xx 不帶 upstreamLog：那不是拋出來的異常，正文本身就是原因', async () => {
    const { upstream } = makeUpstream({
      clientState: { status: 400, body: { success: false, error: { code: 'TOO_MANY_STATE_ENTRIES' } } },
    } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.upstreamLog).toBeUndefined();
  });

  it('上游沒給 cause 就不帶（老 worker 不會多出一截空白）', async () => {
    const { upstream } = makeUpstream({ clientState: throwsInside(500, null) } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(500);
    expect((await response.json() as any).error.upstreamLog).toBeUndefined();
  });

  /**
   * 迴歸守衛：拿真因這件事不許再回去改全局 console。
   *
   * 這段歷史值得留一句：上游早先不回 cause，只把真因寫進自己的 console.error，
   * 於是這裡曾經永久 patch 全局 console.error 去偷聽。那是會影響整個 isolate 的副作用，
   * 而且和任何併發請求都在搶同一個全局對象。真因現在由上游隨響應體給，
   * 誰都不該再動 console。
   */
  it('不碰全局 console.error（真因來自響應體，不是偷聽日誌）', async () => {
    const original = console.error;
    const { upstream } = makeUpstream({ clientState: throwsInside() } as any);
    await run({ request: post(validBody()), upstream });
    expect(console.error).toBe(original);
  });
});

// D1 偶爾會把一次寫直接判超時（`… object to be reset`），而這一步是整條鏈上最大的一次寫
// （三十多 KB 的 fire_pack）。什麼時候來沒量出規律（2026-08-09 的觀測記在 instantChat.ts
// 那段註釋裡），而客戶端只 POST 一次 /instant-chat，它自己那把重試梯子夠不著裡面這一跳。
describe('POST /instant-chat — 雲端狀態那一步遇到 5xx 會重試', () => {
  /** 前 n 次回 5xx，之後回正常成功體。 */
  const flakyClientState = (failures: number) => {
    let seen = 0;
    const upstream = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/client-state')) {
          seen += 1;
          if (seen <= failures) {
            return json(500, {
              success: false,
              error: {
                code: 'INTERNAL_ERROR',
                message: '服務器內部錯誤',
                cause: { stage: 'request', name: 'Error', message: 'D1_ERROR: … object to be reset.' },
              },
            });
          }
          return json(200, { success: true, data: { upserted: 3, skipped: 0 } });
        }
        if (path.endsWith('/schedule-message')) return json(200, { success: true, data: { uuid: TASK_UUID } });
        return json(404, { success: false });
      }),
    };
    return { upstream, attempts: () => seen };
  };

  it('第一次超時、第二次寫進去 → 照常受理，用戶完全無感', async () => {
    const { upstream, attempts } = flakyClientState(1);
    const response = await run({ request: post(validBody()), upstream: upstream as any });
    expect(response.status).toBe(202);
    expect(attempts()).toBe(2);
  });

  it('梯子走完還是 5xx → 才報失敗，且真實原因照樣帶著', async () => {
    const { upstream, attempts } = flakyClientState(99);
    const response = await run({ request: post(validBody()), upstream: upstream as any });
    expect(response.status).toBe(500);
    expect(attempts()).toBe(3);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_FAILED');
    expect(body.error.upstreamLog).toContain('object to be reset');
  });

  // 4xx 是上游判出來的業務錯（體積超限、時間戳不合法……），重試多少次都是同一個答案，
  // 白等三次還讓用戶多盯 1.6 秒的「正在輸入」。
  it('4xx 不重試，立刻打回', async () => {
    const { upstream, calls } = makeUpstream({
      clientState: { status: 400, body: { success: false, error: { code: 'TOO_MANY_STATE_ENTRIES' } } },
    });
    expect((await run({ request: post(validBody()), upstream })).status).toBe(400);
    expect(calls.filter((c) => c.path.endsWith('/client-state'))).toHaveLength(1);
  });

  it('一次就成的正常輪次只轉發一次（別把重試變成常態）', async () => {
    const { upstream, calls } = makeUpstream();
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
    expect(calls.filter((c) => c.path.endsWith('/client-state'))).toHaveLength(1);
  });
});

describe('POST /instant-chat — 只有兩次內部轉發', () => {
  // 頂替上一條不再是包裝層的事：supersedesUuid 在加密的任務體裡，
  // 上游建新任務的同一事務裡取消舊的。包裝層多發一條 DELETE 才是迴歸。
  it('狀態在前、建任務在後，沒有第三個請求', async () => {
    const { upstream, paths } = makeUpstream();
    await run({ request: post(validBody()), upstream });
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });
});

describe('POST /instant-chat — 立即起跳', () => {
  /**
   * 實例名就是任務 uuid：一條任務一個 DO 實例，幾條聊天同時在跑才不會互相排隊。
   * DO 的 alarm 是一實例一個，共用實例就意味著共用那一個 alarm、只能挨個來。
   */
  it('回完 202 之前叫醒 DO，實例名和 uuid 都是這條任務的', async () => {
    const { upstream } = makeUpstream();
    const tick = makeTick();
    const response = await run({ request: post(validBody()), upstream, tick });

    expect(response.status).toBe(202);
    expect(tick.kicks).toEqual([{ instance: TASK_UUID, uuid: TASK_UUID }]);
  });

  /**
   * 迴歸守衛：這一跳絕不能再掛回 ctx.waitUntil。
   *
   * waitUntil 的牆鐘上限是硬性的 30 秒（從響應發出或客戶端斷開起算），而一輪帶工具
   * 循環的生成動輒幾十秒——掛上去就必被砍在半路，日誌裡只留一條
   * 「waitUntil() tasks did not complete」，用戶那邊表現為「一直等不到回覆」。
   * 生成必須跑在 DO 的 alarm 裡（獨立 invocation，15 分鐘），所以受理這一步只該叫醒
   * DO：`InstantChatUpstream` 只聲明了 fetch，壓根沒有能把生成拉進當前請求的入口。
   */
  it('受理時只發兩個轉發請求，不碰任何執行入口', async () => {
    const { upstream, paths } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });

  it('叫醒失敗不影響已經回出去的 202（任務已落庫，cron 每分鐘還會來撿）', async () => {
    const { upstream } = makeUpstream();
    const tick = makeTick({ kick: () => Promise.reject(new Error('kick boom')) });
    const response = await run({ request: post(validBody()), upstream, tick });
    expect(response.status).toBe(202);
  });

  /**
   * 迴歸守衛：老版本 Worker（沒有 INSTANT_TICK 綁定）必須明說「去更新」。
   *
   * 這裡刻意不退回 cron 兜底然後照回 202：那條路上沒有為即時對話放寬的超時，用戶會
   * 對著「正在輸入」等很久甚至等不到，而界面上沒有任何線索告訴他該做什麼。
   */
  it('沒有 INSTANT_TICK 綁定 → 503 且點名要更新 Worker', async () => {
    const { upstream } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream, tick: null });

    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_WORKER_OUTDATED');
    expect(body.error.message).toContain('更新 Worker');
    // 任務本身是建成了的，uuid 要帶回去，別讓客戶端以為整輪沒發生過。
    expect(body.error.uuid).toBe(TASK_UUID);
  });
});

describe('isInstantChatTask', () => {
  it('只認顯式為 true 的那個標記', () => {
    expect(isInstantChatTask({ amsgInstantChat: true })).toBe(true);
    expect(isInstantChatTask({ amsgInstantChat: 'true' })).toBe(false);
    expect(isInstantChatTask({ charId: 'c' })).toBe(false);
    expect(isInstantChatTask(undefined)).toBe(false);
  });
});

describe('buildInstantTimelyBlock', () => {
  const base = {
    nowMs: Date.UTC(2026, 7, 1, 0, 0),
    tz: { tzId: 'Asia/Shanghai' },
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    timeAwarenessEnabled: true,
  };

  it('寫清「現在幾點」，用的是角色自己的時區', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: [] });
    expect(block).toContain('2026年8月1日 週六 早晨 08:00');
  });

  // 報時後面必須跟那句語境框定，而且跟前台聊天用的是同一份常量。少了它，深夜的那行鍾
  // 就夠讓角色每輪往「快睡吧、明天見」上收——本地聊天治好了、雲端沒治的話，同一個角色
  // 走兩條路的分寸不一樣，而即時對話恰恰是主路徑。
  it('報時後面跟著語境框定，跟前台聊天同一份常量', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: [] });
    expect(block).toContain(TIME_FRAMING_CONVERSATIONAL);
    // 順序也釘住：框定必須緊跟在鐘點後面（貼在注意力最強的位置才起作用）。
    expect(block.indexOf('現在是')).toBeLessThan(block.indexOf(TIME_FRAMING_CONVERSATIONAL));
  });

  it('關了時間感知時框定也一起消失（沒有鍾就沒有要框的東西）', () => {
    const block = buildInstantTimelyBlock({
      ...base, timeAwarenessEnabled: false, blocks: ['\n\n【熱搜】\n- 某某'],
    });
    expect(block).not.toContain(TIME_FRAMING_CONVERSATIONAL);
  });

  it('有時差時補一行「對方那邊幾點」，同時區不補（一份提示詞裡兩個鍾會打架）', () => {
    expect(buildInstantTimelyBlock({ ...base, userTzId: 'America/New_York', blocks: [] }))
      .toContain('對方所在時區參考');
    expect(buildInstantTimelyBlock({ ...base, blocks: [] })).not.toContain('對方所在時區參考');
  });

  // 關了時間感知的架空角色在前台連今天幾號都讀不到，雲端這條路也不能偷偷報時。
  // 一個開關兩套行為的話，同一個角色在聊天裡說不出日期、在即時對話裡卻精確到分鐘。
  it('關了時間感知就一個鐘都不給（其餘塊照常拼）', () => {
    const block = buildInstantTimelyBlock({
      ...base,
      userTzId: 'America/New_York',
      timeAwarenessEnabled: false,
      blocks: ['\n\n【熱搜】\n- 某某'],
    });
    expect(block).not.toContain('現在是');
    expect(block).not.toContain('2026年8月1日');
    expect(block).not.toContain('對方所在時區參考');
    expect(block).toContain('【此刻的系統信息·僅你可見】');
    expect(block).toContain('【熱搜】');
  });

  // 時間感知關著、其餘幾塊又都是空的：這一塊沒有任何內容可說，整塊都不該有。
  // 留一行光禿禿的標題掛在對話末尾，模型只會當成沒說完的亂碼。
  it('沒時間也沒別的可說 → 整塊返回空串（調用方據此一條都不追加）', () => {
    expect(buildInstantTimelyBlock({
      ...base, timeAwarenessEnabled: false, blocks: ['', '  ', '\n\n'],
    })).toBe('');
    // 時間感知開著時不受影響：報時本身就是內容
    expect(buildInstantTimelyBlock({ ...base, blocks: [] })).toContain('現在是');
  });

  it('空塊整塊跳過（拉不到實時世界時不能留一行空標題）', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: ['', '  ', '\n\n【熱搜】\n- 某某'] });
    expect(block).toContain('【熱搜】');
    expect(block.split('\n').filter((l) => l.trim() === '【】')).toHaveLength(0);
    expect(block.endsWith('- 某某')).toBe(true);
  });
});

describe('applyInstantNotificationPolicy', () => {
  // 訂閱是按 userVisibleOnly 建的：推了卻不彈，Firefox 按配額退訂、iOS 過了寬限期直接
  // 吊銷，兩邊都靜默發生。所以即時對話這條必推的路只能標 always，打擾交給摺疊 + 靜音壓。
  // 回到 when-hidden（或任何「有時候不彈」的檔）就是把訂閱重新押上去，這條守著別退回去。
  it('標 always + 按角色摺疊：推了就一定彈，不靠不彈來防打擾', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: '來自 Nyah', body: 'hi' } }, 'char-1', true);
    expect(push.notification).toEqual({
      title: '來自 Nyah', body: 'hi', show: 'always',
      silent: 'when-visible', tag: 'amsg-instant-char-1', renotify: true,
    });
  });

  // 靜不靜音是 SW 收到這條時按窗口可見性算的。寫死 true 的話，切後台、鎖屏收到回覆
  // 也不響——worker 發推那一刻並不知道用戶在不在前台，這個判定只能推遲到 SW 去做。
  it('靜音標成 when-visible，不寫死 true（寫死了切後台也不響）', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, 'char-1');
    expect((push.notification as any).silent).toBe('when-visible');
  });

  it('沒顯式傳 charId 就從 metadata 上認', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', metadata: { charId: 'char-2' }, notification: { title: 't' } });
    expect((push.notification as any).tag).toBe('amsg-instant-char-2');
  });

  // 摺疊是為了不刷屏，但兩個角色共用一個 tag 會互相頂掉——那是真丟消息，寧可多幾條。
  it('認不出角色就不折疊（tag 留空，交給庫按 messageId 兜底）', () => {
    const push = applyInstantNotificationPolicy({ message: 'hi', notification: { title: 't' } });
    expect(push.notification).toEqual({ title: 't', show: 'always', silent: 'when-visible' });
  });

  it('載荷本來沒有 notification 就不憑空造一個（造出來只會彈一條空白橫幅）', () => {
    const push = applyInstantNotificationPolicy({ message: 'hi' });
    expect(push).not.toHaveProperty('notification');
    // 形狀不對的也當沒有，別把它塞進一個對象裡
    expect(applyInstantNotificationPolicy({ message: 'hi', notification: null }).notification).toBeNull();
  });

  // 信封的其餘部分（messageId / sessionId / 段號 / 任務身份）全交給庫去補。這裡多寫一份
  // 就是多一處會跟庫漂掉的副本，而帳本里存的本來就是庫發出去的那一份。
  // 同 tag 的通知默認是靜默替換。上一輪的橫幅還躺在通知欄沒點掉時，新一輪的第一段
  // 不帶 renotify 就會被當成替換、不出聲——用戶那句「有時候響有時候不響」就是這麼來的。
  it('每一輪的第一段帶 renotify，後面幾段不帶（一輪只響一聲）', () => {
    const first = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, 'char-1', true);
    expect((first.notification as any).renotify).toBe(true);

    const rest = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, 'char-1', false);
    expect(rest.notification).not.toHaveProperty('renotify');
  });

  // renotify 為 true 而 tag 是空串時 showNotification 直接拋 TypeError，那一條就
  // 一個字都彈不出來。認不出角色時不折疊 = 沒有 tag，這時哪怕是第一段也不能帶。
  it('沒有 tag 就絕不帶 renotify（帶了 showNotification 會拋 TypeError）', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, null, true);
    expect(push.notification).not.toHaveProperty('tag');
    expect(push.notification).not.toHaveProperty('renotify');
  });

  it('除通知策略外一個字段都不添（正文 / metadata 原樣保留）', () => {
    const push = applyInstantNotificationPolicy({ message: 'hi', metadata: { directives: [1] } });
    expect(push).toEqual({ message: 'hi', metadata: { directives: [1] } });
  });
});
