// utils/activeMsgClient.test.ts
// 迴歸守衛：
//   1. 雲端狀態上傳「不降級」。過去這一步失敗只 warn，任務照建，到點用排程那刻凍結的
//      prompt 發——用戶收到舊上下文卻完全不知道。現在網絡抖動重試、最終失敗必須拋錯。
//   2. 取消任務冪等。遠端已經沒有那一條時（一次性任務發完就刪行）不能報「取消失敗」。
//   3. 按角色對帳要認得出「老 worker 沒投影 charId」，不能把它當成「遠端一條都沒有」。
//   4. 「清除雲端狀態」清完必須把全局工具憑據補回去（它沒有別的補寫時機）。
//   5. 推送訂閱按用戶登記一份，跟本地有沒有任務無關——角色在 fire 裡給自己排的任務
//      客戶端從沒見過，照著本地清單刷是刷不到它的。排程載荷也不再帶訂閱。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// clearClientState 走的是庫客戶端而不是 fetchWithAuth，這裡把整個客戶端換成假的。
const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    clearClientState: vi.fn(),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
    getCapabilities: vi.fn(),
    getVapidPublicKey: vi.fn(),
    subscribePush: vi.fn(),
    updateMessage: vi.fn(),
    putPushSubscription: vi.fn(),
    getPushSubscription: vi.fn(),
    deletePushSubscription: vi.fn(),
    // 加密信封的封包 / 解包（庫的私有方法，客戶端通過橋接類型調）。
    _encrypt: vi.fn(),
    _decrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
// ensurePushSubscription 會先跑 KeepAlive.init()（註冊 SW 等瀏覽器副作用），測裡樁掉。
// reregister 是深度重置那條路用的（註銷 SW 再裝回來），同理。
vi.mock('./keepAlive', () => ({
  KeepAlive: {
    init: vi.fn().mockResolvedValue(undefined),
    reregister: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  ActiveMsgClient, buildFirePack, clearNamespaceValuesOrThrow, compareRemotePushSubscription,
  describeInstantChatFailure, dropStaleSubscription, maybeGzipRequestBody, putClientStateOrThrow,
  readAmsgFailKind, toRemoteAvatarUrl,
} from './activeMsgClient';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_SLOT_CURRENT_TIME, AMSG_SLOT_REALTIME_WORLD, AMSG_SLOT_SCENE,
  AMSG_SLOT_TASK_LIST, AMSG_SLOT_TIME_SINCE_USER, AMSG_SLOT_USER_CLOCK,
} from './amsgFirePack';
import { clearInstantChatPending, setInstantChatPending } from './amsgInstantChat';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from './amsgToolPack';
import * as dailySchedule from './dailySchedule';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { KeepAlive } from './keepAlive';

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000001';

// cancelTask 要走 ensureWorkerReady（讀 IndexedDB 裡的 worker 地址），測裡給一份固定配置。
/** 用例想往全局配置裡多塞幾個字段時改它（比如「上次已經探到 true」）。用完記得清。 */
const { storeConfigExtra } = vi.hoisted(() => ({ storeConfigExtra: { value: {} as Record<string, unknown> } }));

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({
      userId: TEST_USER_ID,
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: '',
      ...storeConfigExtra.value,
    }),
    // connect() 成功那條路會落盤 initializedAt，走失敗分支的用例碰不到它。
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

const ENTRIES = [{ namespace: 'amsg:char:x', key: 'fire_pack', value: '{}', updatedAt: 1 }];

/** 只需要 putClientState 這一個方法，其餘 InternalReiClient 成員用不到。 */
const clientWith = (impl: any) => ({ putClientState: impl } as any);

// 假時鐘：重試退避是真的 setTimeout（400ms + 1200ms），實測跑滿 4s。
// 用 advanceTimersByTimeAsync 把等待推掉，測的還是同一段邏輯。
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** 起 promise + 把退避時鐘推完，返回 promise 供斷言。 */
const runWithTimers = <T>(promise: Promise<T>): Promise<T> => {
  void vi.advanceTimersByTimeAsync(5_000);
  return promise;
};

describe('putClientStateOrThrow', () => {
  it('一次成功 → 不重試', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    await putClientStateOrThrow(clientWith(put), ENTRIES, '上傳雲端狀態');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('拋異常後重試，第二次成功 → 不拋錯', async () => {
    const put = vi.fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce({ success: true });
    await runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上傳雲端狀態'));
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('回 { success: false } 也算失敗並重試（只 try/catch 會漏掉這種）', async () => {
    const put = vi.fn()
      .mockResolvedValueOnce({ success: false, error: { message: 'D1 busy' } })
      .mockResolvedValueOnce({ success: true });
    await runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上傳雲端狀態'));
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('三次都失敗 → 拋錯（絕不靜默降級）', async () => {
    const put = vi.fn().mockRejectedValue(new Error('worker down'));
    await expect(runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上傳雲端狀態')))
      .rejects.toThrow(/worker down/);
    expect(put).toHaveBeenCalledTimes(3);
  });

  it('條目被 worker 點名 rejected → 立刻拋錯、不重試（重試不會變好）', async () => {
    const put = vi.fn().mockResolvedValue({
      success: true,
      data: { rejected: [{ key: 'fire_pack', message: 'value too large' }] },
    });
    await expect(putClientStateOrThrow(clientWith(put), ENTRIES, '上傳雲端狀態'))
      .rejects.toThrow(/fire_pack\(value too large\)/);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('打到網頁而不是 Worker（拿到 HTML）時給可讀的錯誤', async () => {
    const put = vi.fn().mockRejectedValue(new Error(`Unexpected token '<'`));
    await expect(runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上傳雲端狀態')))
      .rejects.toThrow(/[没沒]有打到 Worker/);
  });
});

describe('ActiveMsgClient.cancelTask', () => {
  /** safeResponseJson 讀 status、text() 和 headers（content-type），假 Response 三樣都要有。 */
  const respondWith = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('遠端確實刪掉了 → 成功', async () => {
    respondWith(200, { success: true, data: { uuid: 'task-1', message: '任務已成功取消' } });
    await expect(ActiveMsgClient.cancelTask('task-1'))
      .resolves.toMatchObject({ uuid: 'task-1', alreadyGone: false });
  });

  it('遠端本來就沒有這一條 → 也算取消成功（終態已達成，沒什麼可重試的）', async () => {
    respondWith(404, {
      success: false,
      error: { code: 'TASK_NOT_FOUND', message: '指定的任務不存在或已被刪除' },
    });
    await expect(ActiveMsgClient.cancelTask('task-gone'))
      .resolves.toMatchObject({ uuid: 'task-gone', alreadyGone: true });
  });

  it('其它錯誤照常拋，別順手一起吞掉', async () => {
    respondWith(500, {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服務器內部錯誤' },
    });
    await expect(ActiveMsgClient.cancelTask('task-1')).rejects.toThrow(/服[务務]器[内內]部[错錯][误誤]/);
  });

  it('鑑權失敗照常拋（共享密鑰填錯時必須看得見）', async () => {
    respondWith(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: '客戶端令牌無效' },
    });
    await expect(ActiveMsgClient.cancelTask('task-1')).rejects.toThrow(/客[户戶]端令牌[无無]效/);
  });
});

// 迴歸守衛：即時對話「一直等」靠這個判定器決定要不要停下來。三種結論各有各的後果，
// 而「問不到」必須拋錯 —— 靜悄悄當成 gone 的話，雲端還在生成的一輪就被判成沒了。
describe('ActiveMsgClient.getRemoteTaskStatus', () => {
  const respondWith = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient._decrypt.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('行還在 → pending，帶上遠端的重試計數與下次觸發時刻', async () => {
    const fetchMock = respondWith(200, {
      success: true,
      encrypted: true,
      version: 1,
      data: { iv: 'iv', authTag: 'tag', encryptedData: 'blob' },
    });
    reiClient._decrypt.mockResolvedValue({
      task: { uuid: 'task-1', status: 'pending', retryCount: 2, nextSendAt: '2026-08-05T10:00:00.000Z' },
    });

    await expect(ActiveMsgClient.getRemoteTaskStatus('task-1')).resolves.toEqual({
      state: 'pending',
      retryCount: 2,
      nextSendAt: '2026-08-05T10:00:00.000Z',
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/message?id=task-1');
  });

  it('行沒了（發完被刪 / 被取消）→ gone', async () => {
    respondWith(404, {
      success: false,
      error: { code: 'TASK_NOT_FOUND', message: '指定的任務不存在或已被刪除' },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-gone')).resolves.toEqual({ state: 'gone' });
  });

  it('行還在但已出清 → completed（老 worker 不帶 details，lastError 報 null）', async () => {
    respondWith(409, {
      success: false,
      error: { code: 'TASK_ALREADY_COMPLETED', message: '任務已完成或已失敗，無法更新' },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-done')).resolves.toEqual({
      state: 'completed', lastError: null,
    });
  });

  it('409 捎帶的行級失敗摘要透傳（amsg-server 2.6.0-next.15 的 details.lastError）', async () => {
    respondWith(409, {
      success: false,
      error: {
        code: 'TASK_ALREADY_COMPLETED',
        message: '任務已完成或已失敗，無法更新',
        details: {
          status: 'failed',
          lastError: { at: '2026-08-05T10:00:00.000Z', occurrence: '2026-08-05T09:58:00.000Z', reason: 'LLM_HTTP_500' },
        },
      },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-failed')).resolves.toEqual({
      state: 'completed',
      lastError: { at: '2026-08-05T10:00:00.000Z', occurrence: '2026-08-05T09:58:00.000Z', reason: 'LLM_HTTP_500' },
    });
  });

  it('網絡故障要拋，不能悄悄當成 gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    // 拋出來的是翻好的整句，不是瀏覽器那句 "Failed to fetch"（見 amsgDiagnostics）。
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-1')).rejects.toThrow(/[连連]不上你的 Worker/);
  });

  // 地址填錯時 worker 對未知路由也回 404，只是錯誤碼不同。照 HTTP 狀態判就會把
  // 「壓根沒問到這台 worker」當成「任務沒了」，等著的那一輪就此被判死。
  it('未知路由的 404 要拋，不能當成任務沒了', async () => {
    respondWith(404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Unknown route' },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-1')).rejects.toThrow(/Unknown route/);
  });
});

// 迴歸守衛：連接失敗的歸類。使用統計只發這個代號，不發報錯原文——
// 「密鑰對不上」「地址不對」「D1 沒綁」在圖上混成一格的話，看不出該修哪一段引導；
// 而把 error.message 塞進上報又會帶出 Worker 地址。兩頭都得釘住。
describe('連接失敗的歸類（AmsgFailKind）', () => {
  const respondWith = (status: number, body: unknown) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  /** 跑一次 connect，把它拋出來的錯交出來。 */
  const connectAndCatch = async (): Promise<unknown> => {
    try {
      await ActiveMsgClient.connect();
      throw new Error('connect 本該失敗');
    } catch (error) {
      return error;
    }
  };

  it.each([
    [401, '鑑權失敗'],
    [403, '鑑權失敗'],
    [404, '端點不存在'],
    [500, '建表失敗'],
  ])('init-tenant 回 %i → 代號「%s」', async (status, kind) => {
    respondWith(status, { success: false, error: { message: 'whatever' } });
    expect(readAmsgFailKind(await connectAndCatch())).toBe(kind);
  });

  it('fetch 自己炸了（斷網 / DNS / CORS）→ 網絡失敗', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(readAmsgFailKind(await connectAndCatch())).toBe('網絡失敗');
  });

  it('地址指到網頁而不是 Worker（拿到 HTML）→ 打到網頁了', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '<!doctype html><html><body>404 Not Found</body></html>',
      headers: new Headers({ 'content-type': 'text/html' }),
    }));
    expect(readAmsgFailKind(await connectAndCatch())).toBe('打到網頁了');
  });

  it('代號只是源碼裡的字面量，worker 回的報錯原文一個字都不帶出來', async () => {
    const secret = 'https://my-private-worker.invalid 的密鑰 sk-SECRET 無效';
    respondWith(401, { success: false, error: { message: secret } });
    const error = await connectAndCatch();
    // 原文該留在 toast 裡給用戶看
    expect((error as Error).message).toContain(secret);
    // 但上報只拿得到代號
    expect(readAmsgFailKind(error)).toBe('鑑權失敗');
  });

  it('沒掛代號的錯誤一律「其他」，不會把異常對象上的東西漏出去', () => {
    expect(readAmsgFailKind(new Error('sk-LEAKED'))).toBe('其他');
    expect(readAmsgFailKind(undefined)).toBe('其他');
  });
});

// 迴歸守衛：worker 缺 D1 綁定或 master key 時，上游是拋異常 → 被它的全局 catch 吞成
// 一句「服務器內部錯誤」，而那個響應不帶 CORS 頭，瀏覽器連這句話都不讓前端讀，用戶
// 只看得到 "Failed to fetch"。connect 先問一次 /config-check，把缺的那一樣直接說出來。
// 迴歸守衛：即時對話的能力門檻認的是「運行時真的有起跳器」，不是「代碼裡有這條路由」。
//
// 自更新由用戶那台 Worker 上的**舊代碼**執行，而舊代碼不認識 Durable Object——它傳上去的
// 新 bundle 不帶 INSTANT_TICK 綁定。於是會出現「instantChat:true、workerVersion 也對上了、
// 但 /instant-chat 只能回 503」的中間態。認前兩樣中的任何一樣，前端都會一邊說「已經是
// 最新版」一邊發一條掛一條。
describe('即時對話能力探測（instantTick）', () => {
  const configCheck = (data: Record<string, unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        data: { ok: true, missing: [], message: 'Worker 配置齊全。', warnings: [], ...data },
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    })));
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('起跳器接上了 → 支持', async () => {
    configCheck({ instantChat: true, instantTick: true, workerVersion: '2026-08-09' });
    expect(await ActiveMsgClient.probeInstantChatSupport()).toBe(true);
  });

  it('代碼新了但起跳器沒接上（更新過一次的中間態）→ 不支持', async () => {
    configCheck({ instantChat: true, instantTick: false, workerVersion: '2026-08-09' });
    expect(await ActiveMsgClient.probeInstantChatSupport()).toBe(false);
  });

  it('老 bundle 根本不報這個字段 → 不支持（哪怕它自稱 instantChat:true）', async () => {
    configCheck({ instantChat: true });
    expect(await ActiveMsgClient.probeInstantChatSupport()).toBe(false);
  });

  // 結論要存下來：真正攔下這一輪的是發消息路上的 resolveInstantChatReadiness，
  // 而它不做逐調用網絡探測，只認這份存量。不存 = 這道門形同虛設。
  it('每探一次就把結論存進全局配置（發消息那道門只認存量）', async () => {
    const { ActiveMsgStore } = await import('./activeMsgStore');
    (ActiveMsgStore.saveGlobalConfig as any).mockClear();
    configCheck({ instantChat: true, instantTick: false });
    await ActiveMsgClient.probeInstantChatSupport();
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenCalledWith({ instantChatSupported: false });

    (ActiveMsgStore.saveGlobalConfig as any).mockClear();
    configCheck({ instantChat: true, instantTick: true });
    await ActiveMsgClient.probeInstantChatSupport();
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenCalledWith({ instantChatSupported: true });
  });

  // ★ 核心迴歸守衛：「探不到」≠「探到了、答案是不行」。
  //
  // 這兩種從前混用同一個 false，於是一次網絡抖動（切代理節點、CF 邊緣抖一下、D1 冷啟動
  // 慢）就足以把 instantChatSupported 寫死成 false。那份存量是粘的，用戶不碰巧打開設置頁
  // 就一直卡在本地生成——線上真實故障就是這麼來的：Worker 那頭全綠（instantTick:true、
  // 庫也齊），用戶卻連著幾小時每一輪都在本地直連生成，而他的本地直連根本不通，只看得到
  // 一條讀不懂的網絡報錯，開關還寫著「已開啟」。
  describe('探不到的時候一個字都不許寫進存量', () => {
    afterEach(() => { storeConfigExtra.value = {}; });

    /** 上次已經探到「跑得動」，這次沒問到答案 → 存量必須原樣保留。 */
    const expectKeepsPreviousTrue = async () => {
      const { ActiveMsgStore } = await import('./activeMsgStore');
      (ActiveMsgStore.saveGlobalConfig as any).mockClear();
      const result = await ActiveMsgClient.probeInstantChatSupportDetailed();
      expect(result.outcome).toBe('unknown');
      expect(result.supported).toBe(true);
      expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
    };

    it('網絡異常（fetch 直接拋）→ 保留上次探到的 true', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Load failed'); }));
      await expectKeepsPreviousTrue();
    });

    it('401 → 說明共享密鑰沒填對，跟 Worker 跑不跑得動沒關係', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      vi.stubGlobal('fetch', vi.fn(async () => ({
        status: 401,
        text: async () => JSON.stringify({ success: false, error: { code: 'INVALID_CLIENT_TOKEN' } }),
        headers: new Headers({ 'content-type': 'application/json' }),
      })));
      await expectKeepsPreviousTrue();
    });

    it('5xx / 中間設備塞回來的網關頁 → 說明線路有問題，同樣不是答案', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      vi.stubGlobal('fetch', vi.fn(async () => ({
        status: 503,
        text: async () => '<html>502 Bad Gateway</html>',
        headers: new Headers({ 'content-type': 'text/html' }),
      })));
      await expectKeepsPreviousTrue();
    });

    // 別矯枉過正：真的問到「跑不動」時該寫還得寫，否則這道門就形同虛設。
    it('200 但沒有 instantTick → 這是明確答案，照寫 false', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      const { ActiveMsgStore } = await import('./activeMsgStore');
      (ActiveMsgStore.saveGlobalConfig as any).mockClear();
      configCheck({ instantChat: true });
      const result = await ActiveMsgClient.probeInstantChatSupportDetailed();
      expect(result.outcome).toBe('unsupported');
      expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenCalledWith({ instantChatSupported: false });
    });
  });
});

describe('連接前的 worker 配置自檢', () => {
  /** 按路徑分流的 fetch：沒列到的路徑一律當成功，模擬 init-tenant 那步是通的。 */
  const routeFetch = (routes: Record<string, { status: number; body: unknown }>) => {
    const spy = vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([path]) => String(url).includes(path));
      const { status, body } = hit?.[1] ?? { status: 200, body: { success: true, data: {} } };
      return {
        status,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
      };
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  const report = (patch: Record<string, unknown>) => ({
    success: true,
    data: { ok: true, missing: [], message: 'Worker 配置齊全。', warnings: [], ...patch },
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('worker 說缺 master key → 報「配置缺失」，並把「去哪兒補」原樣交給用戶', async () => {
    routeFetch({
      'config-check': {
        status: 200,
        body: report({
          ok: false,
          missing: ['AMSG_MASTER_KEY'],
          message: 'Worker 配置不完整：缺 AMSG_MASTER_KEY（在 Settings → Variables and Secrets 里加，類型選 Secret）。',
        }),
      },
    });

    const error = await ActiveMsgClient.connect().then(() => null, (e) => e);
    expect(readAmsgFailKind(error)).toBe('配置缺失');
    expect((error as Error).message).toContain('AMSG_MASTER_KEY');
    expect((error as Error).message).toContain('Secret');
  });

  it('配置缺失時不再去打 init-tenant——那一步註定失敗，且只會報回一句更含糊的話', async () => {
    const spy = routeFetch({
      'config-check': { status: 200, body: report({ ok: false, missing: ['DB'], message: '缺 D1 綁定' }) },
    });

    await ActiveMsgClient.connect().catch(() => {});
    expect(spy.mock.calls.some(([url]) => String(url).includes('init-tenant'))).toBe(false);
  });

  it('只有警告（VAPID 沒配齊）→ 連接照樣成功，但把警告帶回去讓界面提示', async () => {
    routeFetch({
      'config-check': {
        status: 200,
        body: report({ warnings: [{ code: 'VAPID_MISSING', message: 'VAPID 沒配齊，到點消息不會推送出去。' }] }),
      },
    });

    const result = await ActiveMsgClient.connect();
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(['VAPID_MISSING']);
  });

  it('舊 worker 沒有這個端點（404）→ 當它不支持自檢，照常走原來的連接流程', async () => {
    routeFetch({
      'config-check': { status: 404, body: { success: false, error: { code: 'NOT_FOUND' } } },
    });

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true, warnings: [] });
  });

  it('回執形狀對不上就不採信：寧可不自檢，也不能把一台好 worker 判成「配置缺失」', async () => {
    // 未知路徑回 200 + 一個沒有 ok/missing 的 body。照 success 採信的話，ok 會是
    // undefined，一台配置完好的 worker 就被判死了，用戶照著提示改哪兒都改不對。
    routeFetch({ 'config-check': { status: 200, body: { success: true, data: {} } } });

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });
  });

  // 迴歸守衛：握手（get-user-key）按「地址 / 用戶 id / 共享密鑰」記憶化，可用戶密鑰能在
  // 這三樣都不變的情況下換代——用戶在 Cloudflare 上換掉 AMSG_MASTER_KEY 就是。緩存不作廢
  // 的話，「重新連接並驗證」拿回來的還是握著舊密鑰的老 client：init-tenant 成功、界面報
  // 「連接成功」，此後每一次加密調用 worker 都解不開（即時對話每發一條掛一條、任務到點
  // 全失敗），只有整頁刷新能恢復。
  it('「重新連接並驗證」每按一次都真的重新握手（換過 master key 後舊密鑰必須被丟掉）', async () => {
    routeFetch({});
    reiClient.init.mockReset().mockResolvedValue(undefined);

    await ActiveMsgClient.connect();
    await ActiveMsgClient.connect();

    expect(reiClient.init).toHaveBeenCalledTimes(2);
  });
});

// 迴歸守衛：老 worker（< 2.6.0-next.5）的 GET /messages 不投影 charId，按角色過濾會
// 一條都留不下。要是照直返回空數組，面板會把該角色的任務全標成「遠端不存在」，
// 「關閉 2.0」也會以為沒什麼要取消——兩處都是拿半份證據下結論。
describe('ActiveMsgClient.listRemoteTasksForChar 的版本護欄', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('worker 有投影 → 只留本角色的行', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a', charId: 'char-1' },
      { uuid: 'task-b', charId: 'char-2' },
      { charId: 'char-1' },
    ]);
    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1').then((rows) => rows.map((r) => r.uuid)))
      .resolves.toEqual(['task-a']);
  });

  it('老 worker 沒投影（遠端有任務、charId 全空）→ 拋錯交給調用方降級', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a' },
      { uuid: 'task-b', charId: null },
    ]);
    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1'))
      .rejects.toThrow(/重新粘[贴貼]部署/);
  });

  it('遠端確實一條任務都沒有 → 空數組（跟版本無關，別誤傷）', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([]);
    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1')).resolves.toEqual([]);
  });
});

// 迴歸守衛：刪角色 / 關閉 2.0 都要把該角色的遠端任務清乾淨——worker 上的任務不隨本地
// 刪除消失，留著會到點照跑一整輪生成 + 推送（角色都沒了還在發消息，每次真燒一輪 LLM）。
describe('ActiveMsgClient.cancelAllTasksForChar', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** 遠端投影的最小形狀（只有 uuid 與子類型參與取消判定）。 */
  const remoteRows = (rows: Array<{ uuid: string; messageSubtype?: string }>) =>
    vi.spyOn(ActiveMsgClient, 'listRemoteTasksForChar')
      .mockResolvedValue(rows.map((r) => ({ ...r, lastError: null })) as any);

  it('以遠端清單為準（本地漏掉的「已過點未消費」任務也要取消到）', async () => {
    remoteRows([{ uuid: 'remote-1' }, { uuid: 'remote-2' }]);
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar('char-1', ['local-only']);
    expect(targets).toEqual(['remote-1', 'remote-2']);
    expect(failed.size).toBe(0);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(['remote-1', 'remote-2']);
  });

  it('遠端讀不到（老 worker / 斷網）→ 退回本地清單，半份證據也比不取消強', async () => {
    vi.spyOn(ActiveMsgClient, 'listRemoteTasksForChar').mockRejectedValue(new Error('offline'));
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets } = await ActiveMsgClient.cancelAllTasksForChar('char-1', ['local-1', 'local-2']);
    expect(targets).toEqual(['local-1', 'local-2']);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('單條取消失敗只記帳，剩下的照樣取消完', async () => {
    remoteRows([{ uuid: 't1' }, { uuid: 't2' }, { uuid: 't3' }]);
    vi.spyOn(ActiveMsgClient, 'cancelTask').mockImplementation(async (uuid: string) => {
      if (uuid === 't2') throw new Error('D1 busy');
      return { uuid, alreadyGone: false };
    });

    const { failed } = await ActiveMsgClient.cancelAllTasksForChar('char-1', []);
    expect([...failed]).toEqual(['t2']);
  });

  // 迴歸守衛：即時對話的行不是定時任務，是用戶此刻正等著的一輪聊天。以前這裡照遠端全量
  // 清單逐條取消，關掉角色的 2.0 開關就會把它一起掐掉：worker 那一跳永遠不會跑，客戶端
  // 的待收記錄還留著，60s 點名查到 gone、outbox 也空，最後落一句「雲端已處理這條消息，
  // 但回覆沒能取回」，用戶還得把話重發一遍。過濾口徑與面板對帳同一把尺。
  it('即時對話的行不取消（關掉 2.0 不該掐掉正在跑的那輪聊天）', async () => {
    remoteRows([
      { uuid: 'scheduled-1' },
      { uuid: 'instant-1', messageSubtype: 'instant-chat' },
      { uuid: 'scheduled-2', messageSubtype: 'chat' },
    ]);
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets } = await ActiveMsgClient.cancelAllTasksForChar('char-1', []);
    expect(targets).toEqual(['scheduled-1', 'scheduled-2']);
    expect(cancel.mock.calls.map((c) => c[0])).not.toContain('instant-1');
  });
});

// 迴歸守衛：排程建任務前會把整份 fire_pack PUT 上去，而用戶剛發出去的那條即時對話還
// 欠著回覆時，雲端那一份是 POST /instant-chat 帶上去的、比常規的包多一段 chat——worker
// 到點全靠它拿這一輪的對話。蓋掉的話 onBeforeFire 當場硬失敗（fire_pack 裡沒有 chat 段），
// 重試梯子上每一跳都是同一個錯，用戶最後拿到一句「即時對話沒能完成」，話還得自己重發。
// 現實觸發路徑：等回覆期間打開該角色的 2.0 面板新建 / 編輯一條定時任務（角色在本地輪裡
// 給自己排任務同理）。掛起口徑與批量同步共用 owesInstantChatReply 這一把尺。
describe('scheduleCharacterTask 與欠著的即時對話 chat 段', () => {
  const CHAR_ID = 'char-schedule-instant';

  let putBatches: Array<Array<{ namespace: string; key: string }>>;

  beforeEach(() => {
    putBatches = [];
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.putClientState.mockReset().mockImplementation(async (entries: any[]) => {
      putBatches.push(entries);
      return { success: true };
    });
    reiClient._encrypt.mockReset().mockResolvedValue({ iv: 'iv', authTag: 'tag', encryptedData: 'enc' });
    // 模板本體、表情全庫、推送登記這些都不在被測範圍，樁掉。
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    vi.spyOn(DB, 'getEmojis').mockResolvedValue([] as any);
    vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([] as any);
    vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
    vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
    vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { uuid: 'remote-uuid', status: 'pending' } }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
    clearInstantChatPending(CHAR_ID);
  });
  afterEach(() => {
    clearInstantChatPending(CHAR_ID);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const schedule = () => ActiveMsgClient.scheduleCharacterTask({
    char: { id: CHAR_ID, name: '小滿', memories: [], activeMsg2Config: { enabled: true, tasks: [] } } as any,
    config: { enabled: true, tasks: [] } as any,
    task: {
      mode: 'auto',
      firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
      recurrenceType: 'none',
    },
    userProfile: { name: '小明' } as any,
    groups: [],
    realtimeConfig: {} as any,
    apiConfig: { baseUrl: 'https://api.example.dev', apiKey: 'sk-test', model: 'gpt-test' } as any,
  });

  /** 這次排程往雲端寫了哪些 key。 */
  const writtenKeys = () => putBatches.flat().map((entry) => entry.key);

  it('沒欠著回覆 → fire_pack 照常整份覆蓋上去', async () => {
    await schedule();
    expect(writtenKeys()).toContain(AMSG_FIRE_PACK_KEY);
  });

  it('欠著回覆 → 這一批把 fire_pack 抽掉，tool_pack / tool_config 照寫、任務照建', async () => {
    setInstantChatPending(CHAR_ID, 'uuid-waiting');

    const result = await schedule();

    expect(writtenKeys(), '蓋掉 chat 段 = 用戶正等的那條回覆到點必然硬失敗')
      .not.toContain(AMSG_FIRE_PACK_KEY);
    expect(writtenKeys()).toContain(AMSG_TOOL_PACK_KEY);
    expect(writtenKeys()).toContain(AMSG_TOOL_CONFIG_KEY);
    // 任務本身照建：等回覆不是拒絕排程的理由，抽掉的那份包由銷帳後的狀態同步補上。
    expect(result.uuid).toBe('remote-uuid');
  });
});

// 迴歸守衛：刪角色時清雲端 client_state 的清法。
// 一個角色的條目不止 fire_pack / tool_pack —— 還有活躍會話租約，以及鍵名帶 clientTaskId
// 的旁路存儲（`xhs_session:<id>`，任務記錄被 prune 掉之後就再也拼不出來）。所以清法是
// 「先讀回來有什麼、再把有內容的寫空」，而不是照著已知鍵名盲寫：putClientState 是 upsert，
// 盲寫會把本來不存在的條目建出來，清理反倒變成新建。
describe('clearNamespaceValuesOrThrow', () => {
  const clientWithState = (entries: any[], put = vi.fn().mockResolvedValue({ success: true })) => ({
    getClientState: vi.fn().mockResolvedValue({ success: true, data: { entries } }),
    putClientState: put,
  } as any);

  it('讀回來有什麼清什麼，一次請求寫空（xhs_session 這種拼不出的鍵也在內）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    const client = clientWithState([
      { key: 'fire_pack', value: '{"v":2}' },
      { key: 'tool_pack', value: '{}' },
      { key: 'chat_presence', value: '{}' },
      { key: 'xhs_session:2f1c-任務id', value: '{"notes":[]}' },
    ], put);

    const cleared = await clearNamespaceValuesOrThrow(client, 'amsg:char:char-1');

    expect(cleared).toEqual(['fire_pack', 'tool_pack', 'chat_presence', 'xhs_session:2f1c-任務id']);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0].map((e: any) => [e.namespace, e.key, e.value])).toEqual([
      ['amsg:char:char-1', 'fire_pack', ''],
      ['amsg:char:char-1', 'tool_pack', ''],
      ['amsg:char:char-1', 'chat_presence', ''],
      ['amsg:char:char-1', 'xhs_session:2f1c-任務id', ''],
    ]);
  });

  it('namespace 是空的 → 一條都不寫（別把不存在的鍵 upsert 出來）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    await expect(clearNamespaceValuesOrThrow(clientWithState([], put), 'amsg:char:char-1'))
      .resolves.toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it('已經是空殼的條目跳過（重複刪同一個角色不白發請求體）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    const client = clientWithState([
      { key: 'fire_pack', value: '' },
      { key: 'tool_pack', value: '{}' },
    ], put);

    await expect(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')).resolves.toEqual(['tool_pack']);
    expect(put.mock.calls[0][0]).toHaveLength(1);
  });

  it('讀不到雲端狀態 → 拋錯（調用方按「沒清掉」提示，不能當成清乾淨了）', async () => {
    const client = {
      getClientState: vi.fn().mockResolvedValue({ success: false, error: { message: 'D1 busy' } }),
      putClientState: vi.fn(),
    } as any;
    await expect(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')).rejects.toThrow(/D1 busy/);
    expect(client.putClientState).not.toHaveBeenCalled();
  });

  it('寫空失敗 → 拋錯', async () => {
    const client = clientWithState(
      [{ key: 'fire_pack', value: '{"v":2}' }],
      vi.fn().mockRejectedValue(new Error('worker down')),
    );
    await expect(runWithTimers(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')))
      .rejects.toThrow(/worker down/);
  });
});

// 迴歸守衛：本地角色頭像是 base64，直接塞進排程請求會被 worker 拒掉並 warn
// （`avatarUrl 不合法，已置空`），每排一條任務刷一條。這裡按 worker 同一把尺先篩。
describe('toRemoteAvatarUrl', () => {
  it('公網 http(s) 圖片 URL → 原樣傳', () => {
    expect(toRemoteAvatarUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(toRemoteAvatarUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });

  it('base64 data URI → 不傳（worker 明確拒收 data:）', () => {
    expect(toRemoteAvatarUrl('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
    expect(toRemoteAvatarUrl('DATA:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
  });

  it('超過 2048 字符 → 不傳（worker 的長度上限）', () => {
    expect(toRemoteAvatarUrl(`https://example.com/${'a'.repeat(2048)}.png`)).toBeUndefined();
  });

  it('空 / 不是 URL / 非 http 協議 → 不傳', () => {
    expect(toRemoteAvatarUrl(undefined)).toBeUndefined();
    expect(toRemoteAvatarUrl('   ')).toBeUndefined();
    expect(toRemoteAvatarUrl('./avatars/sully.png')).toBeUndefined();
    expect(toRemoteAvatarUrl('blob:http://localhost/abc')).toBeUndefined();
  });
});

// 迴歸守衛：「清除雲端狀態」之後 AI 任務必須還能跑。
//
// 實測踩過：點完那個按鈕，聊多少輪天任務都一直失敗。雲端有三份數據，角色上下文
// (fire_pack) 和角色工具數據 (tool_pack) 每輪聊完都會重新同步，只有全局的 tool_config
// 是「改配置時才傳」——清空之後沒有任何一條路會補它，而 worker 到點三份缺一就硬失敗。
// 彈窗還寫著「下次聊天會重新同步」，等於界面在騙人。
//
// 任務表跟 client_state 不在一起、不受清空影響，所以「任務還活著、憑據卻沒了」
// 只有這一個入口。補傳就放在這裡，不必讓每輪同步都白傳一遍。
describe('ActiveMsgClient.clearClientState', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.clearClientState.mockReset().mockResolvedValue({ success: true, data: { deleted: 7 } });
    reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  });

  const toolConfigEntries = () => reiClient.putClientState.mock.calls.flatMap((c: any[]) => c[0]);

  it('清完立刻把全局 tool_config 補回去', async () => {
    const result = await ActiveMsgClient.clearClientState({ newsEnabled: true } as any);

    expect(result).toEqual({ deleted: 7, toolConfigRestored: true });
    const entries = toolConfigEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ namespace: 'amsg:global', key: 'tool_config' });
    expect(JSON.parse(entries[0].value)).toMatchObject({ v: 1, newsEnabled: true });
  });

  it('順序是先清後補，別把剛補的又清掉', async () => {
    const order: string[] = [];
    reiClient.clearClientState.mockImplementation(async () => {
      order.push('clear');
      return { success: true, data: { deleted: 1 } };
    });
    reiClient.putClientState.mockImplementation(async () => {
      order.push('put');
      return { success: true };
    });

    await ActiveMsgClient.clearClientState(undefined);
    expect(order).toEqual(['clear', 'put']);
  });

  it('沒配實時感知也照樣補一份（工具全關的憑據也是憑據，缺了 worker 一樣硬失敗）', async () => {
    await ActiveMsgClient.clearClientState(undefined);
    expect(toolConfigEntries()).toHaveLength(1);
  });

  it('補傳失敗 → 清空本身仍算成功，用返回值讓調用方去提示', async () => {
    reiClient.putClientState.mockRejectedValue(new Error('offline'));
    await expect(runWithTimers(ActiveMsgClient.clearClientState(undefined)))
      .resolves.toEqual({ deleted: 7, toolConfigRestored: false });
  });

  it('清空本身失敗 → 拋錯，也不去補傳（雲端還是原樣）', async () => {
    reiClient.clearClientState.mockResolvedValue({ success: false, error: { message: 'D1 busy' } });
    await expect(ActiveMsgClient.clearClientState(undefined)).rejects.toThrow(/D1 busy/);
    expect(reiClient.putClientState).not.toHaveBeenCalled();
  });
});

// 雲端狀態的寫口：調用方只給 namespace/key/value，連接與鑑權都在客戶端內部備好。
// 釘住「寫到指定 namespace/key」，免得別處為了寫一條狀態自己另建一條連接。
describe('ActiveMsgClient.writeClientStateValue', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  });

  it('把值寫到指定的 namespace/key', async () => {
    await ActiveMsgClient.writeClientStateValue('amsg:char:c1', 'self_log', '{"v":1}');

    expect(reiClient.putClientState).toHaveBeenCalledTimes(1);
    const entries = reiClient.putClientState.mock.calls[0][0];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      namespace: 'amsg:char:c1',
      key: 'self_log',
      value: '{"v":1}',
    });
    expect(entries[0].updatedAt).toEqual(expect.any(Number));
  });

  it('寫失敗要拋錯，不能靜默留著雲端的舊內容', async () => {
    reiClient.putClientState.mockResolvedValue({ success: false, error: { message: 'D1 busy' } });
    await expect(runWithTimers(ActiveMsgClient.writeClientStateValue('amsg:char:c1', 'self_log', 'x')))
      .rejects.toThrow(/D1 busy/);
  });
});

// 迴歸守衛：按 namespace 寫空的清法只服務「刪角色」。要是哪天被順手用在全局
// namespace 上，tool_config 會被清成空殼 —— 症狀跟上面那條一模一樣，而且更隱蔽
// （不是刪行，是留個空值，讀得到但 parse 不出來）。
describe('clearNamespaceValuesOrThrow 的全局 namespace 護欄', () => {
  it('全局 namespace 直接拒絕，一個請求都不發', async () => {
    const getClientState = vi.fn();
    await expect(clearNamespaceValuesOrThrow({ getClientState } as any, 'amsg:global'))
      .rejects.toThrow(/全局[云雲]端[状狀][态態]不能按 namespace 清空/);
    expect(getClientState).not.toHaveBeenCalled();
  });
});

// 迴歸守衛（時區統一 ①）：fire_pack 的時間參照系與「模板不烤時間」。
//   - tzId：角色開了自定義時區用角色的，沒開用設備的（worker 渲染一切時間的參照系）；
//   - 烤進模板的 buildSystemPrompt 必須收到 skipTimeAwareness——否則「現在是 X」被
//     烤死在模板裡，到點渲染時就是一句過期的時間，和槽位現算的當前時間打架；
//   - 【角色系統設定】之後補一行「設定是快照，與當前時刻矛盾以當前本地時間為準」；
//   - 槽位不動：當前時間仍由 worker 到點用 AMSG_SLOT_CURRENT_TIME 現算填入。
describe('buildFirePack 的時區參照系與模板（①）', () => {
  const baseChar = (over: Record<string, unknown> = {}) => ({
    id: 'char-1',
    name: '小滿',
    memories: [],
    ...over,
  }) as any;
  const user = { name: '小明' } as any;

  // 具體的 MockInstance 泛型跟著 buildSystemPrompt 的 11 個參數走，寫全沒有信息量。
  let systemPromptSpy: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    // 模板本體不在被測範圍：樁掉重依賴，測打包邏輯本身。
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    systemPromptSpy = vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
    vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const pack = (char: any) => buildFirePack(char, user, [], undefined, { all: [], categories: [] });

  it('角色開了自定義時區 → tzId 用角色的', async () => {
    const out = await pack(baseChar({ customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' }));
    expect(out.tzId).toBe('Asia/Tokyo');
  });

  it('沒開自定義時區 → tzId 用設備的', async () => {
    const out = await pack(baseChar());
    expect(out.tzId).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('buildSystemPrompt 收到 forFirePack —— 打包時刻的狀態一律不烤進模板', async () => {
    await pack(baseChar());
    expect(systemPromptSpy).toHaveBeenCalledTimes(1);
    // 第 12 個位置參數是 promptOptions（見 chatPrompts.buildSystemPrompt 簽名）。
    // 這個開關一次性關掉時間塊 / 真實世界感知 / 日程 / 音樂 / 剛打完電話 / 群聊相對時間 /
    // 生活記錄代記 / [schedule_message] 教學，清單見 ChatPrompts.PromptBuildOptions。
    expect(systemPromptSpy.mock.calls[0][11]).toEqual({ forFirePack: true });
  });

  it('當前時間槽位保留：worker 到點現算填入（1.0 提示塊的「現在是」也是槽位）', async () => {
    const out = await pack(baseChar());
    expect(out.template).toContain(`當前本地時間（你所在地）：${AMSG_SLOT_CURRENT_TIME}`);
    expect(out.template).toContain(`現在是 ${AMSG_SLOT_CURRENT_TIME}`);
  });

  it('隨包帶上用戶設的連發上限；沒設就不帶（worker 側用默認值）', async () => {
    const withLimit = await pack(baseChar({ activeMsg2Config: { enabled: true, maxUnansweredSends: 5 } }));
    expect(withLimit.maxUnansweredSends).toBe(5);
    const unlimited = await pack(baseChar({ activeMsg2Config: { enabled: true, maxUnansweredSends: 0 } }));
    expect(unlimited.maxUnansweredSends).toBe(0);
    const unset = await pack(baseChar());
    expect(unset.maxUnansweredSends).toBeUndefined();
  });

  // 迴歸守衛：用戶設備的時區以前一個字都沒上雲。角色只看得到自己那邊的鐘，
  // 「晚上九點跟他說一聲」在異國戀角色手裡就是排到用戶的凌晨三點，而且它無從察覺。
  it('隨包帶上用戶設備時區，並在當前時間後面留「對方那邊幾點」的槽位', async () => {
    const out = await pack(baseChar({ customTimezoneEnabled: true, customTimezone: 'America/New_York' }));
    expect(out.userTzId).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // 兩個鍾必須挨在一起、各自標明主語，別散落在 prompt 兩頭長成兩個打架的時間。
    expect(out.template).toContain(`當前本地時間（你所在地）：${AMSG_SLOT_CURRENT_TIME}`);
    expect(out.template).toContain(AMSG_SLOT_USER_CLOCK);
    expect(out.template.indexOf(AMSG_SLOT_USER_CLOCK))
      .toBeGreaterThan(out.template.indexOf(AMSG_SLOT_CURRENT_TIME));
  });

  // 迴歸守衛：前台每輪都有「你身處 X 時區……對方可能在不同時區」，而 fire 側的角色設定是
  // skipTimeAwareness 建的、整塊時間感知都被抹掉了。不在打包時補回來的話，最容易撞用戶
  // 睡覺的恰恰是主動消息。這段文案是靜態的，所以直接烤進模板。
  it('開了自定義時區的角色，時差說明烤進模板', async () => {
    const out = await pack(baseChar({ customTimezoneEnabled: true, customTimezone: 'America/New_York' }));
    expect(out.template).toContain('你身處');
    expect(out.template).toContain('存在時差');
    // 位置在當前時間之後：那句話說的就是「上面的當前時間是你那邊的」。
    expect(out.template.indexOf('你身處')).toBeGreaterThan(out.template.indexOf(AMSG_SLOT_CURRENT_TIME));
  });

  it('沒開自定義時區的角色不注入時差說明（跟前台一致）', async () => {
    expect((await pack(baseChar())).template).not.toContain('你身處');
  });

  // 迴歸守衛：1.0 提示塊裡「生活在繼續」和「別查崗」兩行。少了它們，連發幾條的
  // 主動消息容易退化成催回覆和喝水早睡式說教刷屏。
  it('1.0 提示塊帶「日子也在往前過」與「關心別變成查崗」', async () => {
    const { template } = await pack(baseChar());
    expect(template).toContain('日子也在往前過');
    expect(template).toContain('關心別變成查崗');
  });

  // 迴歸守衛：timeAwarenessEnabled=false 的架空角色在前台連今天幾號都讀不到
  // （buildTimeAwarenessBlock 直接返回空串），主動消息這邊卻精確報出年月日 + 星期。
  // 同一個開關不能有兩套行為。
  describe('關掉時間感知的角色：模板裡一個鐘都不給', () => {
    const noTime = () => pack(baseChar({
      timeAwarenessEnabled: false,
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
    }));

    it('當前時間 / 1.0 提示塊的「現在是」/ 距上次多久 / 對方那邊幾點，全都不進模板', async () => {
      const { template } = await noTime();
      expect(template).not.toContain(AMSG_SLOT_CURRENT_TIME);
      expect(template).not.toContain('當前本地時間');
      expect(template).not.toContain('現在是');
      expect(template).not.toContain(AMSG_SLOT_TIME_SINCE_USER);
      expect(template).not.toContain(AMSG_SLOT_USER_CLOCK);
      expect(template).not.toContain('你身處');
    });

    it('跟時間無關的幾段照留（別順手把整個「當前時刻補充」砍掉）', async () => {
      const { template } = await noTime();
      expect(template).toContain('【當前時刻補充】');
      expect(template).toContain(AMSG_SLOT_SCENE);
      expect(template).toContain(AMSG_SLOT_TASK_LIST);
      expect(template).toContain(AMSG_SLOT_REALTIME_WORLD);
      // 1.0 提示塊本身還在，只是不報鍾了
      expect(template).toContain('【1.0 風格主動消息提示】');
    });

    it('時間感知開著的角色照常有這幾行（免得上面幾條永遠成立）', async () => {
      const { template } = await pack(baseChar());
      expect(template).toContain(AMSG_SLOT_CURRENT_TIME);
      expect(template).toContain(AMSG_SLOT_TIME_SINCE_USER);
      expect(template).toContain(AMSG_SLOT_USER_CLOCK);
    });
  });

  // 「此刻在做什麼」不烤成文字，隨包帶原始作息表讓 worker 到點現挑。烤死的話，
  // 凌晨三點觸發時角色會照著中午打的包說「我在健身房呢」。
  it('作息表隨包帶原始數據 + 槽位跟在當前時間後面', async () => {
    vi.spyOn(dailySchedule, 'getDailyScheduleForChar').mockResolvedValue({
      id: 's', charId: 'char-1', date: '2026-08-02', generatedAt: 0,
      slots: [{ startTime: '08:00', activity: '晨跑' }],
    } as any);

    const out = await pack(baseChar({ scheduleFeatureEnabled: true }));
    expect(out.scene?.schedule?.slots).toHaveLength(1);
    expect(out.scene?.charId).toBe('char-1');
    expect(out.template).toContain(`${AMSG_SLOT_USER_CLOCK}${AMSG_SLOT_SCENE}`);
  });

  // 迴歸守衛：作息表裡只有「幾點做什麼」，沒有日期。週五晚打的包週日上午觸發時，
  // 光按牆鍾時分照樣挑得出「09:00 晨會」。帶上打包那天的日期，到點先比日期再用。
  it('作息表隨包帶打包那天的日期（角色當地日曆日）', async () => {
    vi.spyOn(dailySchedule, 'getDailyScheduleForChar').mockResolvedValue({
      id: 's', charId: 'char-1', date: '2026-08-02', generatedAt: 0,
      slots: [{ startTime: '08:00', activity: '晨跑' }],
    } as any);

    const out = await pack(baseChar({
      scheduleFeatureEnabled: true,
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
    }));
    expect(out.scene?.dateKey).toBe(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()),
    );
  });

  it('角色沒開日程 → scene 為 null（槽位到點被抹平）', async () => {
    const out = await pack(baseChar());
    expect(out.scene).toBeNull();
  });

  // 天氣 / 熱搜 / 今日節日跟當前時間一樣是「此刻的讀數」：模板裡只留槽位，worker 到點
  // 現拉現填。槽位沒了的話主動消息就退回到完全感知不到外面世界的樣子。
  it('實時世界留槽位，且模板裡沒有烤死的天氣熱搜', async () => {
    const out = await pack(baseChar());
    expect(out.template).toContain(AMSG_SLOT_REALTIME_WORLD);
    expect(out.template).not.toContain('真實世界感知系統');
    expect(out.template).not.toContain('實時天氣');
  });

  it('【角色系統設定】之後補快照說明行，位置在設定正文與對話上下文之間', async () => {
    const out = await pack(baseChar());
    const noteIdx = out.template.indexOf('最近一次聊天時的快照');
    expect(noteIdx).toBeGreaterThan(out.template.indexOf('SYS_PROMPT_MARKER'));
    expect(noteIdx).toBeLessThan(out.template.indexOf('【最近對話上下文】'));
    expect(out.template).toContain('以下方「當前時刻補充」為準');
  });

  // 迴歸守衛：歷史消息 content 是數組時（視覺模型的 [{type:'text'},{type:'image_url'}] 格式），
  // 轉寫進【最近對話上下文】的那一行不能把整段 data:image/...;base64,... 塞進模板——真機一張圖
  // 輕鬆幾百 KB base64，排程任務的載荷直接被撐成體積炸彈，模型也用不著讀 base64 才知道有圖。
  // 參照 worker 側 restoreEvalPrompt 的 flattenContent：文本部分照抄，image_url 部分壓成
  // [圖片]，別的類型丟棄。
  it('歷史裡的圖片消息壓成 [圖片] 佔位，不把 base64 編進模板', async () => {
    const longBase64 = 'data:image/png;base64,' + 'A'.repeat(500);
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({
      apiMessages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '你看這張圖' },
            { type: 'image_url', image_url: { url: longBase64 } },
          ],
        },
      ],
    } as any);

    const out = await pack(baseChar());
    expect(out.template).toContain('[圖片]');
    expect(out.template).toContain('你看這張圖');
    expect(out.template).not.toContain('data:');
  });

  it('純文本數組內容照常保留原文', async () => {
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({
      apiMessages: [
        { role: 'user', content: [{ type: 'text', text: '早上好呀' }] },
      ],
    } as any);

    const out = await pack(baseChar());
    expect(out.template).toContain('早上好呀');
  });
});

// ─── ① 訂閱自檢 ───
// 迴歸守衛：舊實現拿到已有訂閱**無條件複用**——換過 VAPID 後綁舊公鑰的訂閱發推必 403，
// 瀏覽器殭屍化的死端點（permanently-removed.invalid）也照單收。這兩種都得先退訂再重訂。

/** bytesToB64u([1,2,3]) === 'AQID'（btoa('\x01\x02\x03')），下面拿它當 VAPID 公鑰比對。 */
const VAPID_AQID = 'AQID';

const makeSub = (endpoint: string, keyBytes: number[] | null) => ({
  endpoint,
  options: { applicationServerKey: keyBytes ? Uint8Array.from(keyBytes).buffer : null },
  unsubscribe: vi.fn().mockResolvedValue(true),
  toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
});

describe('dropStaleSubscription（① 死端點 / 公鑰不一致先退訂）', () => {
  it('死端點（permanently-removed.invalid）→ 退訂並返回 null', async () => {
    const sub = makeSub('https://permanently-removed.invalid/x', [1, 2, 3]);
    await expect(runWithTimers(dropStaleSubscription(sub as any, VAPID_AQID))).resolves.toBeNull();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('綁的公鑰與目標 worker 不一致 → 退訂並返回 null', async () => {
    const sub = makeSub('https://fcm.googleapis.com/send/x', [9, 9, 9]);
    await expect(runWithTimers(dropStaleSubscription(sub as any, VAPID_AQID))).resolves.toBeNull();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('公鑰一致的健康訂閱 → 原樣複用，不退訂', async () => {
    const sub = makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]);
    await expect(dropStaleSubscription(sub as any, VAPID_AQID)).resolves.toBe(sub);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('公鑰讀不出來（options 拋錯）→ 按可複用處理（與 instant/proactive 同款 fall-through）', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/send/x',
      get options(): any { throw new Error('not exposed'); },
      unsubscribe: vi.fn(),
      toJSON: () => ({}),
    };
    await expect(dropStaleSubscription(sub as any, VAPID_AQID)).resolves.toBe(sub);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('沒有訂閱 → null', async () => {
    await expect(dropStaleSubscription(null, VAPID_AQID)).resolves.toBeNull();
  });
});

// 迴歸守衛（補）：建訂閱這一步不許走 ReiClient.subscribePush——那是裸的
// pushManager.subscribe()，剛退訂完的窗口期裡瀏覽器會吐 permanently-removed.invalid
// 哨兵，它照單收下。死端點一旦被登記進 worker，用戶看到「訂閱已準備完成」，到點卻一條
// 都收不到，兩邊都沒有任何報錯。這一組釘住「走帶重試的共用實現」。
describe('ActiveMsgClient.ensurePushSubscription（① 不再無條件複用舊訂閱）', () => {
  const FRESH_ENDPOINT = 'https://fcm.googleapis.com/send/fresh';

  /** subscribe() 依次吐出 endpoints 裡的端點；用盡後一直吐最後一個。 */
  const stubPushEnv = (existing: any, endpoints: string[] = [FRESH_ENDPOINT]) => {
    const queue = [...endpoints];
    const subscribe = vi.fn().mockImplementation(async () => {
      const endpoint = queue.length > 1 ? queue.shift()! : queue[0];
      return {
        endpoint,
        options: { applicationServerKey: Uint8Array.from([1, 2, 3]).buffer },
        unsubscribe: vi.fn().mockResolvedValue(true),
        toJSON: () => ({ endpoint, keys: { p256dh: 'p2', auth: 'a2' } }),
      };
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(existing), subscribe },
        }),
      },
    });
    vi.stubGlobal('window', { PushManager: class {} });
    vi.stubGlobal('Notification', { permission: 'granted' });
    return subscribe;
  };

  beforeEach(() => {
    reiClient.getVapidPublicKey.mockReset().mockResolvedValue(VAPID_AQID);
    reiClient.subscribePush.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('已有訂閱是死端點 → 退訂後重訂，返回新訂閱', async () => {
    const dead = makeSub('https://permanently-removed.invalid/x', [1, 2, 3]);
    const subscribe = stubPushEnv(dead);

    const result = await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(dead.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect((result as any).endpoint).toBe(FRESH_ENDPOINT);
  });

  it('已有訂閱綁著舊 VAPID 公鑰 → 退訂後按 worker 當前公鑰重訂', async () => {
    const stale = makeSub('https://fcm.googleapis.com/send/x', [9, 9, 9]);
    const subscribe = stubPushEnv(stale);

    const result = await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect((result as any).endpoint).toBe(FRESH_ENDPOINT);
  });

  it('訂閱一律不經 ReiClient.subscribePush（它不做殭屍重試）', async () => {
    stubPushEnv(null);

    await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(reiClient.subscribePush).not.toHaveBeenCalled();
  });

  it('重訂第一次拿到殭屍哨兵、重試拿到活端點 → 返回活的那個', async () => {
    const subscribe = stubPushEnv(null, ['https://permanently-removed.invalid/x', FRESH_ENDPOINT]);

    const result = await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect((result as any).endpoint).toBe(FRESH_ENDPOINT);
  });

  it('重試到底還是殭屍 → 拋 端點殭屍，絕不把死端點交出去', async () => {
    stubPushEnv(null, ['https://permanently-removed.invalid/x']);

    const failure = await runWithTimers(ActiveMsgClient.ensurePushSubscription().catch((e) => e));

    expect(failure).toBeInstanceOf(Error);
    expect(readAmsgFailKind(failure)).toBe('端點殭屍');
  });

  it('已有訂閱健康且公鑰一致 → 原樣複用，不重訂', async () => {
    const healthy = makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]);
    stubPushEnv(healthy);

    const result = await ActiveMsgClient.ensurePushSubscription();

    expect(healthy.unsubscribe).not.toHaveBeenCalled();
    expect(reiClient.subscribePush).not.toHaveBeenCalled();
    expect((result as any).endpoint).toBe('https://fcm.googleapis.com/send/x');
  });
});

// ─── ②③ 共用的角色/任務夾具 ───
const FUTURE_ISO = () => new Date(Date.now() + 3600_000).toISOString();
const PAST_ISO = () => new Date(Date.now() - 24 * 3600_000).toISOString();

const remoteTask = (taskUuid: string, extra: Record<string, unknown> = {}) => ({
  taskUuid,
  clientTaskId: `client-${taskUuid}`,
  mode: 'auto',
  firstSendTime: FUTURE_ISO(),
  recurrenceType: 'none',
  expirePolicy: 'expire',
  source: 'user',
  status: 'scheduled',
  createdAt: 1,
  ...extra,
});

describe('ActiveMsgClient.registerPushSubscription（② 訂閱按用戶登記一份）', () => {
  const SUB_JSON = { endpoint: 'https://fcm.googleapis.com/send/new', keys: { p256dh: 'p', auth: 'a' } };

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
    reiClient.putPushSubscription.mockReset().mockResolvedValue({ success: true, data: { updatedAt: 1 } });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('把當前訂閱覆蓋寫到 worker 上那一份', async () => {
    const ensure = vi.spyOn(ActiveMsgClient, 'ensurePushSubscription').mockResolvedValue(SUB_JSON as any);

    await ActiveMsgClient.registerPushSubscription();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription).toHaveBeenCalledWith(SUB_JSON);
  });

  // 訂閱刷新曾經是「照本地任務清單逐條 PUT」，本地沒有任務就直接收工。角色在 fire 裡
  // 給自己排的任務客戶端從沒見過，於是永遠刷不到——推不出去、狀態記不下、客戶端更不
  // 知道它存在。訂閱按用戶存一份之後，登記跟本地有沒有任務徹底無關。
  it('本地一條任務都沒有，訂閱照樣登記上去', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([{ id: 'char-x' }] as any);
    vi.spyOn(ActiveMsgClient, 'ensurePushSubscription').mockResolvedValue(SUB_JSON as any);

    await ActiveMsgClient.registerPushSubscription();

    expect(reiClient.putPushSubscription).toHaveBeenCalledWith(SUB_JSON);
    // 一條任務都沒碰：訂閱不再掛在任務行上。
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });

  it('登記失敗往外拋，調用方據此保留標記下次再試', async () => {
    vi.spyOn(ActiveMsgClient, 'ensurePushSubscription').mockResolvedValue(SUB_JSON as any);
    reiClient.putPushSubscription.mockRejectedValue(new Error('worker 拒絕了訂閱'));

    await expect(ActiveMsgClient.registerPushSubscription()).rejects.toThrow('worker 拒絕了訂閱');
  });
});

// 迴歸守衛：換一台 worker 就是換一個空的 D1，而瀏覽器這側的訂閱一個字都沒變——
// SW 的 pushsubscriptionchange 不會響，refreshPushSubscriptionIfMarked 也就沒有標記
// 可消費。於是面板全綠、連接驗證通過，worker 到點卻讀不到那份用戶級訂閱，直接拋
// PUSH_SUBSCRIPTION_MISSING：消息一條都發不出來，用戶這側看不到任何異常。
// 連接這一步必須順手把當前訂閱覆蓋寫回去。
describe('ActiveMsgClient.connect（連接後補登記推送訂閱）', () => {
  const stubConnectEnv = (permission: string, existing: any) => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(existing) },
        }),
      },
    });
    vi.stubGlobal('window', { PushManager: class {} });
    vi.stubGlobal('Notification', { permission });
    // init-tenant 一律成功：這一組測的是它之後那步補登記。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ success: true, data: {} }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
  };

  beforeEach(() => { reiClient.init.mockReset().mockResolvedValue(undefined); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('瀏覽器已有訂閱 → 連接後把它覆蓋寫到這台 worker 上', async () => {
    stubConnectEnv('granted', makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]));
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });

    expect(register).toHaveBeenCalledTimes(1);
  });

  it('通知權限還沒授予 → 不補登記，連接時也不彈權限框', async () => {
    stubConnectEnv('default', null);
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });

    expect(register).not.toHaveBeenCalled();
  });

  it('權限有了但還沒訂閱 → 那是「开启通知与推送订阅」那步的事，連接不替用戶開', async () => {
    stubConnectEnv('granted', null);
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);

    await ActiveMsgClient.connect();

    expect(register).not.toHaveBeenCalled();
  });

  // init-tenant 過了、鑑權也通了，連接本身就是成功的。補登記只是順手的一句自檢，
  // 它掛了不該把連接判成失敗——否則用戶會被指去改一堆根本沒錯的配置。
  it('補登記失敗 → 連接照樣算成功', async () => {
    stubConnectEnv('granted', makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]));
    vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockRejectedValue(new Error('worker 拒絕了訂閱'));

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });
  });
});

describe('ActiveMsgClient.refreshApiCredentialsForPendingTasks（③ 憑據變更重傳）', () => {
  const API = { baseUrl: 'https://api.example.com/v1', apiKey: 'new-key', model: 'gpt-x' } as any;

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('只刷「開著 2.0 且 pending 的 AI 任務」，三字段載荷；單獨 API 的角色寫單獨 API 的值', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [
        remoteTask('a1'),
        remoteTask('a2', { mode: 'fixed', expirePolicy: 'force' }),   // fixed 不走 LLM，不動
        remoteTask('a3', { firstSendTime: PAST_ISO() }),               // 過點，不動
      ] } },
      { id: 'char-b', activeMsg2Config: { enabled: false, tasks: [remoteTask('b1')] } }, // 關了 2.0，不動
      { id: 'char-c', activeMsg2Config: {
        enabled: true,
        useSecondaryApi: true,
        secondaryApi: { baseUrl: 'https://sec.example.com', apiKey: 'sec-key', model: 'sec-model' },
        tasks: [remoteTask('c1')],
      } },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);

    expect(result).toEqual({ status: 'ok', updated: 2, failed: 0 });
    const byUuid = new Map(reiClient.updateMessage.mock.calls.map((c: any[]) => [c[0], c[1]]));
    expect([...byUuid.keys()].sort()).toEqual(['a1', 'c1']);
    expect(byUuid.get('a1')).toEqual({
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'new-key',
      primaryModel: 'gpt-x',
    });
    expect(byUuid.get('c1')).toEqual({
      apiUrl: 'https://sec.example.com/chat/completions',
      apiKey: 'sec-key',
      primaryModel: 'sec-model',
    });
  });

  it('角色設了專屬 chatApi、沒開單獨 API → 用角色自己的 chatApi，不是傳入的全局 API', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      {
        id: 'char-d',
        chatApi: { baseUrl: 'https://char-d.example.com', apiKey: 'char-d-key', model: 'char-d-model' },
        activeMsg2Config: { enabled: true, tasks: [remoteTask('d1')] },
      },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);

    expect(result).toEqual({ status: 'ok', updated: 1, failed: 0 });
    expect(reiClient.updateMessage).toHaveBeenCalledWith('d1', {
      apiUrl: 'https://char-d.example.com/chat/completions',
      apiKey: 'char-d-key',
      primaryModel: 'char-d-model',
    });
  });

  it('角色同時設了專屬 chatApi 和單獨 API（useSecondaryApi）→ 單獨 API 優先級更高', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      {
        id: 'char-e',
        chatApi: { baseUrl: 'https://char-e.example.com', apiKey: 'char-e-key', model: 'char-e-model' },
        activeMsg2Config: {
          enabled: true,
          useSecondaryApi: true,
          secondaryApi: { baseUrl: 'https://sec.example.com', apiKey: 'sec-key', model: 'sec-model' },
          tasks: [remoteTask('e1')],
        },
      },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);

    expect(result).toEqual({ status: 'ok', updated: 1, failed: 0 });
    expect(reiClient.updateMessage).toHaveBeenCalledWith('e1', {
      apiUrl: 'https://sec.example.com/chat/completions',
      apiKey: 'sec-key',
      primaryModel: 'sec-model',
    });
  });

  it('沒有 pending AI 任務（只剩 fixed / 全關掉）→ no-tasks，一個請求都不發', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [remoteTask('a2', { mode: 'fixed' })] } },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);
    expect(result.status).toBe('no-tasks');
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });

  it('某個角色憑據配不齊（單獨 API 缺字段）→ 該角色整組記失敗，別攔其他角色', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      { id: 'char-broken', activeMsg2Config: {
        enabled: true,
        useSecondaryApi: true,
        secondaryApi: { baseUrl: 'https://sec.example.com', apiKey: '', model: '' }, // 缺 Key/Model
        tasks: [remoteTask('x1')],
      } },
      { id: 'char-ok', activeMsg2Config: { enabled: true, tasks: [remoteTask('y1')] } },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);

    expect(result).toEqual({ status: 'partial', updated: 1, failed: 1 });
    expect(reiClient.updateMessage.mock.calls.map((c: any[]) => c[0])).toEqual(['y1']);
  });
});

describe('ActiveMsgClient.refreshCharPendingAiTaskCredentials（③ 面板保存後的單角色版）', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });

  it('fixed 再濾一遍；憑據按傳入的 config（面板手裡的最新值）算，不讀 DB', async () => {
    const result = await ActiveMsgClient.refreshCharPendingAiTaskCredentials({
      char: { id: 'char-a' } as any,
      config: {
        enabled: true,
        useSecondaryApi: true,
        secondaryApi: { baseUrl: 'https://sec.example.com', apiKey: 'sec-key', model: 'sec-model' },
      } as any,
      apiConfig: { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' } as any,
      tasks: [remoteTask('t1'), remoteTask('t2', { mode: 'fixed' })] as any,
    });

    expect(result).toEqual({ status: 'ok', updated: 1, failed: 0 });
    expect(reiClient.updateMessage).toHaveBeenCalledTimes(1);
    expect(reiClient.updateMessage.mock.calls[0][0]).toBe('t1');
    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({
      apiUrl: 'https://sec.example.com/chat/completions',
      apiKey: 'sec-key',
      primaryModel: 'sec-model',
    });
  });

  it('沒開單獨 API、角色設了專屬 chatApi → 用角色的 chatApi，不是傳入的 apiConfig', async () => {
    const result = await ActiveMsgClient.refreshCharPendingAiTaskCredentials({
      char: { id: 'char-b', chatApi: { baseUrl: 'https://char-b.example.com', apiKey: 'char-b-key', model: 'char-b-model' } } as any,
      config: { enabled: true } as any,
      apiConfig: { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' } as any,
      tasks: [remoteTask('t3')] as any,
    });

    expect(result).toEqual({ status: 'ok', updated: 1, failed: 0 });
    expect(reiClient.updateMessage).toHaveBeenCalledWith('t3', {
      apiUrl: 'https://char-b.example.com/chat/completions',
      apiKey: 'char-b-key',
      primaryModel: 'char-b-model',
    });
  });

  it('沒開單獨 API、角色也沒設專屬 chatApi → 退回傳入的 apiConfig（全局主 API）', async () => {
    const result = await ActiveMsgClient.refreshCharPendingAiTaskCredentials({
      char: { id: 'char-c' } as any,
      config: { enabled: true } as any,
      apiConfig: { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' } as any,
      tasks: [remoteTask('t4')] as any,
    });

    expect(result).toEqual({ status: 'ok', updated: 1, failed: 0 });
    expect(reiClient.updateMessage).toHaveBeenCalledWith('t4', {
      apiUrl: 'https://api.example.com/chat/completions',
      apiKey: 'k',
      primaryModel: 'm',
    });
  });

});

// listRemoteTasksForChar 的 lastError 投影（按角色過濾本身的口徑由上面那個 describe 釘著）。
describe('ActiveMsgClient.listRemoteTasksForChar 的失敗摘要投影', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('帶回 status 與收斂後的 lastError（舊 worker 沒這字段 → null）', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a', charId: 'char-1', status: 'failed', lastError: { at: '2026-07-30T15:00:10.000Z', occurrence: '2026-07-30T15:00:00.000Z', reason: 'boom' } },
      { uuid: 'task-b', charId: 'char-1', status: 'pending' },
      { uuid: 'task-c', charId: 'char-2', status: 'pending' },
    ]);

    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1')).resolves.toEqual([
      { uuid: 'task-a', status: 'failed', lastError: { at: '2026-07-30T15:00:10.000Z', occurrence: '2026-07-30T15:00:00.000Z', reason: 'boom' } },
      { uuid: 'task-b', status: 'pending', lastError: null },
    ]);
  });
});

// 上游是按任務行裡凍結的 tzId、以牆鍾推進循環任務的下次觸發時刻的。角色改了時區只刷
// fire_pack 蓋不到這份，「每天 9:00」會一直按排程那天的時區走（改到紐約就成了當地晚上）。
describe('ActiveMsgClient.refreshCharPendingTaskRow（角色資料變更後同步任務行）', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('全部 pending 任務都刷（含 fixed），載荷只有 tzId', async () => {
    const char = {
      id: 'char-a',
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
      activeMsg2Config: {
        enabled: true,
        tasks: [
          remoteTask('a1'),
          // fixed 不走 LLM 用不到憑據，但它的循環推進同樣看 tzId，所以這條也得刷。
          remoteTask('a2', { mode: 'fixed', expirePolicy: 'force' }),
          remoteTask('a3', { firstSendTime: PAST_ISO() }),   // 已過點，不動
        ],
      },
    } as any;

    const result = await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true });

    expect(result).toEqual({ status: 'ok', updated: 2, failed: 0 });
    const byUuid = new Map(reiClient.updateMessage.mock.calls.map((c: any[]) => [c[0], c[1]]));
    expect([...byUuid.keys()].sort()).toEqual(['a1', 'a2']);
    expect(byUuid.get('a1')).toEqual({ tzId: 'America/New_York' });
  });

  it('關掉自定義時區 → 回落設備時區，不把舊的自定義時區留在任務行上', async () => {
    const char = { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] } } as any;

    await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true });

    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({
      tzId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('沒有 pending 任務 → 一個請求都不發', async () => {
    const char = { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [] } } as any;

    expect((await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true })).status).toBe('no-tasks');
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });
});

// contactName 補的是 fixed 模式：AI 任務的推送標題由 worker 從 tool_pack 現取，
// 但 fixed 不走 hooks，標題直接讀任務行裡凍結的這一份。
describe('ActiveMsgClient.refreshCharPendingTaskRow — contactName', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('改名和改時區同時發生 → 一次 PUT 帶兩個字段，不打兩輪', async () => {
    const char = {
      id: 'char-a',
      name: '夜',
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
      activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] },
    } as any;

    await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true, contactName: true });

    expect(reiClient.updateMessage).toHaveBeenCalledTimes(1);
    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({
      tzId: 'America/New_York',
      contactName: '夜',
    });
  });

  it('只改名 → 載荷只有 contactName，不順手動時區', async () => {
    const char = { id: 'char-a', name: '夜', activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] } } as any;

    await ActiveMsgClient.refreshCharPendingTaskRow(char, { contactName: true });

    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({ contactName: '夜' });
  });

  it('名字是空的 → 一個請求都不發（上游要求非空，傳上去只會被打回 400）', async () => {
    const char = { id: 'char-a', name: '  ', activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] } } as any;

    expect((await ActiveMsgClient.refreshCharPendingTaskRow(char, { contactName: true })).status).toBe('no-tasks');
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });
});

// ─── ⑥ 設置頁「推送訂閱狀態」面板 ───
// 迴歸守衛：
//   a. 重置訂閱必須把新訂閱**登記回 worker**。只在瀏覽器重訂不登記的話，worker 的
//      push_subscriptions 裡還是舊端點，到點推給一個已經不存在的地址——界面全綠、
//      一條消息都收不到，正是這個按鈕要治的病。
//   b. worker 登記的端點跟本機對不上時，面板必須判成異常。這一檔正是「換過 worker /
//      在另一台設備登記過」的靜默失聯，判成正常等於把唯一的線索也抹了。
//   c. 重訂仍拿到殭屍哨兵時掛 '端點殭屍' 代號——設置頁據此把按鈕升級成「深度重置」。
//      裸 pushManager.subscribe() 會把哨兵原樣交出來，登記上去就是往庫裡寫死端點。

describe('compareRemotePushSubscription（⑥b worker 登記的是不是本機）', () => {
  const LOCAL = 'https://fcm.googleapis.com/send/local';

  it('問不到 worker → unreachable', () => {
    expect(compareRemotePushSubscription(LOCAL, null)).toBe('unreachable');
  });

  it('worker 上沒登記 → missing', () => {
    expect(compareRemotePushSubscription(LOCAL, { exists: false, endpoint: null, updatedAt: null }))
      .toBe('missing');
  });

  it('登記的端點就是本機 → matched', () => {
    expect(compareRemotePushSubscription(LOCAL, { exists: true, endpoint: LOCAL, updatedAt: 1 }))
      .toBe('matched');
  });

  it('登記著別的端點 → other-endpoint（換過 worker / 換過設備的靜默失聯）', () => {
    expect(compareRemotePushSubscription(LOCAL, {
      exists: true,
      endpoint: 'https://fcm.googleapis.com/send/another-device',
      updatedAt: 1,
    })).toBe('other-endpoint');
  });

  it('本機還沒訂閱、遠端卻登記著 → other-endpoint，不許顯示成已登記', () => {
    expect(compareRemotePushSubscription(null, {
      exists: true,
      endpoint: 'https://fcm.googleapis.com/send/another-device',
      updatedAt: 1,
    })).toBe('other-endpoint');
  });
});

describe('ActiveMsgClient.resetPushSubscription（⑥a 重置後必須重新登記）', () => {
  const FRESH = 'https://fcm.googleapis.com/send/fresh';

  /** subscribe() 依次吐出這些端點；數組用盡後一直吐最後一個。 */
  const stubResetEnv = (existing: any, endpoints: string[]) => {
    const queue = [...endpoints];
    const subscribe = vi.fn().mockImplementation(async () => {
      const endpoint = queue.length > 1 ? queue.shift()! : queue[0];
      return {
        endpoint,
        options: { applicationServerKey: Uint8Array.from([1, 2, 3]).buffer },
        unsubscribe: vi.fn().mockResolvedValue(true),
        toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      };
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue(existing),
            subscribe,
          },
        }),
        getRegistrations: vi.fn().mockResolvedValue([{ unregister: vi.fn().mockResolvedValue(true) }]),
      },
    });
    vi.stubGlobal('window', { PushManager: class {} });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    return subscribe;
  };

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.getVapidPublicKey.mockReset().mockResolvedValue(VAPID_AQID);
    reiClient.putPushSubscription.mockReset().mockResolvedValue({ success: true, data: { updatedAt: 1 } });
    reiClient.deletePushSubscription.mockReset().mockResolvedValue({ success: true, data: { deleted: 1 } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('退掉舊訂閱、重訂一條、並把新的覆蓋登記到 worker', async () => {
    const old = makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]);
    stubResetEnv(old, [FRESH]);

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });

  it('先讓 worker 忘掉舊的那行，再登記新的', async () => {
    stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(reiClient.deletePushSubscription).toHaveBeenCalledTimes(1);
    expect(reiClient.deletePushSubscription.mock.invocationCallOrder[0])
      .toBeLessThan(reiClient.putPushSubscription.mock.invocationCallOrder[0]);
  });

  it('刪舊行失敗不攔路——重新登記本來就是覆蓋寫', async () => {
    stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);
    reiClient.deletePushSubscription.mockRejectedValue(new Error('worker 說沒有這一行'));

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });

  it('重訂第一次拿到殭屍哨兵、重試拿到活端點 → 登記的是活的那個', async () => {
    stubResetEnv(null, ['https://permanently-removed.invalid/x', FRESH]);

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(reiClient.putPushSubscription).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });

  it('⑥c 重試到底還是殭屍 → 拋 端點殭屍，且一個字都不往 worker 上寫', async () => {
    stubResetEnv(null, ['https://permanently-removed.invalid/x']);

    const failure = await runWithTimers(ActiveMsgClient.resetPushSubscription().catch((e) => e));

    expect(readAmsgFailKind(failure)).toBe('端點殭屍');
    expect(reiClient.putPushSubscription).not.toHaveBeenCalled();
  });

  it('worker 沒配 VAPID → 拋 worker沒配VAPID，不去動瀏覽器訂閱', async () => {
    const subscribe = stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);
    reiClient.getVapidPublicKey.mockResolvedValue('');

    const failure = await runWithTimers(ActiveMsgClient.resetPushSubscription().catch((e) => e));

    expect(readAmsgFailKind(failure)).toBe('worker沒配VAPID');
    expect(subscribe).not.toHaveBeenCalled();
    expect(reiClient.putPushSubscription).not.toHaveBeenCalled();
  });

  it('通知權限被拒 → 拋 權限被拒，不去動瀏覽器訂閱', async () => {
    stubResetEnv(null, [FRESH]);
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    });

    const failure = await runWithTimers(ActiveMsgClient.resetPushSubscription().catch((e) => e));

    expect(readAmsgFailKind(failure)).toBe('權限被拒');
    expect(reiClient.putPushSubscription).not.toHaveBeenCalled();
  });

  it('深度重置：註銷 SW 並重裝之後，同樣要把新訂閱登記回 worker', async () => {
    stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);

    await runWithTimers(ActiveMsgClient.deepResetPushSubscription());

    expect(navigator.serviceWorker.getRegistrations).toHaveBeenCalledTimes(1);
    expect(KeepAlive.reregister).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });
});

describe('ActiveMsgClient.getRemotePushSubscription（⑥b 問不到就說問不到）', () => {
  beforeEach(() => { reiClient.init.mockReset().mockResolvedValue(undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('worker 回了完整回執 → 原樣交出來', async () => {
    reiClient.getPushSubscription.mockResolvedValue({
      success: true,
      data: { exists: true, endpoint: 'https://fcm.googleapis.com/send/x', updatedAt: 1700 },
    });

    await expect(ActiveMsgClient.getRemotePushSubscription()).resolves.toEqual({
      exists: true,
      endpoint: 'https://fcm.googleapis.com/send/x',
      updatedAt: 1700,
    });
  });

  it('回執形狀對不上（舊 worker）→ null，不猜成「已登記」', async () => {
    reiClient.getPushSubscription.mockResolvedValue({ success: true, data: { ok: 1 } });
    await expect(ActiveMsgClient.getRemotePushSubscription()).resolves.toBeNull();
  });

  it('請求本身炸了 → null，不往外拋（面板會反覆調它）', async () => {
    reiClient.getPushSubscription.mockRejectedValue(new Error('offline'));
    await expect(ActiveMsgClient.getRemotePushSubscription()).resolves.toBeNull();
  });
});

// 上游把異常吞成一句寫死的「服務器內部錯誤」，真話只進 worker 的日誌。包裝層把那行
// 撈出來放進 upstreamLog，這裡必須原樣端到用戶面前——否則他看到的還是那句什麼都沒說的話，
// 得先知道 Cloudflare 面板裡有條日誌才查得下去。
describe('describeInstantChatFailure — 後端那句真話要露出來', () => {
  const internalError = (upstreamLog?: string) => ({
    error: {
      code: 'INSTANT_CHAT_STATE_FAILED',
      message: '雲端狀態沒傳上去，這條沒發出去',
      upstream: { success: false, error: { code: 'INTERNAL_ERROR', message: '服務器內部錯誤' } },
      ...(upstreamLog ? { upstreamLog } : {}),
    },
  });

  it('帶了 upstreamLog 就拼進去', () => {
    const text = describeInstantChatFailure(500, internalError('D1_ERROR: no such table: message_outbox'));
    expect(text).toContain('D1_ERROR: no such table: message_outbox');
    // 泛型報文照留：它說明這一步是哪一步，跟真實原因不衝突。
    expect(text).toContain('雲端狀態沒傳上去');
  });

  it('沒有 upstreamLog 時照舊（老 worker 不會多出一截空白）', () => {
    const text = describeInstantChatFailure(500, internalError());
    expect(text).toBe('即時對話沒發出去（HTTP 500 / INSTANT_CHAT_STATE_FAILED）：雲端狀態沒傳上去，這條沒發出去：服務器內部錯誤');
  });

  it('有專屬指引的錯誤碼不受影響（401 仍然只說該去核對共享密鑰）', () => {
    expect(describeInstantChatFailure(401, internalError('D1_ERROR: whatever')))
      .toBe('即時對話沒發出去：共享密鑰和 Worker 上的對不上，去「主動消息 2.0」設置裡核對一下。');
  });
});

// 大 body 走 gzip 上行（省掉密文那層 base64 的膨脹，約 25%）。這幾條釘的是
// 「壓縮絕不能變成發不出去的理由」：這條路上唯一該有的結局是「壓了」或「原樣發」，
// 任何一種失敗都必須落回明文，而不是把整輪聊天卡在發送鍵上。
describe('請求體 gzip 上行', () => {
  const bigJson = () => JSON.stringify({ v: 'ぷ'.repeat(20_000) });

  it('超閾值 → 壓，且真能解回原文', async () => {
    const original = bigJson();
    const { body, gzipped } = await maybeGzipRequestBody(original);
    expect(gzipped).toBe(true);
    expect(body).toBeInstanceOf(ArrayBuffer);
    const restored = await new Response(
      new Response(body as ArrayBuffer).body!.pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(restored).toBe(original);
  });

  it('小 body 原樣發：壓縮省下的字節還不夠抵一次 CompressionStream 的開銷', async () => {
    const small = JSON.stringify({ hello: 'world' });
    expect(await maybeGzipRequestBody(small)).toEqual({ body: small, gzipped: false });
  });

  // 按字符數粗篩會把「1 萬個漢字」（3 萬字節）判成小 body。真正的字節數只有
  // TextEncoder 算得準，粗篩之後必須再量一次。
  it('閾值按 UTF-8 字節算，不按字符數', async () => {
    // 6000 個漢字 = 6000 字符（不到 16384）但 18000 字節（超了）。
    const cjk = '字'.repeat(6000);
    expect((await maybeGzipRequestBody(JSON.stringify({ cjk }))).gzipped).toBe(true);
  });

  it('運行時沒有 CompressionStream（老 Safari）→ 退回明文，不拋', async () => {
    const original = bigJson();
    const saved = globalThis.CompressionStream;
    // @ts-expect-error 故意抹掉，模擬老 Safari
    delete globalThis.CompressionStream;
    try {
      expect(await maybeGzipRequestBody(original)).toEqual({ body: original, gzipped: false });
    } finally {
      globalThis.CompressionStream = saved;
    }
  });

  it('壓縮本身拋錯 → 退回明文，不連累這一輪發送', async () => {
    const original = bigJson();
    const saved = globalThis.CompressionStream;
    // @ts-expect-error 換成一個必炸的替身
    globalThis.CompressionStream = function Broken() { throw new Error('boom'); };
    try {
      expect(await maybeGzipRequestBody(original)).toEqual({ body: original, gzipped: false });
    } finally {
      globalThis.CompressionStream = saved;
    }
  });

  it('非字符串 body（FormData / null）原樣穿過去', async () => {
    expect(await maybeGzipRequestBody(null)).toEqual({ body: null, gzipped: false });
    expect(await maybeGzipRequestBody(undefined)).toEqual({ body: undefined, gzipped: false });
  });
});
