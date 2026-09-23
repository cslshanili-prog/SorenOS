// 即時對話（instant chat）客戶端這一半的迴歸守衛。
//
// 釘的都是「壞了也不報錯、只表現成體驗變差」的那類行為：
//   1. POST 的形狀——任務行型 / 任務身份 / fire_pack 帶不帶 chat 段。錯一個字，
//      worker 到點要麼拿主動消息模板去答聊天，要麼整條硬失敗，而用戶只看到「一直在輸入」。
//   2. 只有 202 才算發出去。別的狀態一律「沒發出去」，絕不靜默退回本地生成。
//   3. 待收記錄扛得住重啟——它就是「正在輸入…」那盞燈的唯一依據。
//   4. 補收對帳：已經上過屏的那條不能再放一遍。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000009';

// _encrypt 換成「原樣返回明文」，測裡才讀得到兩個信封裡到底裝了什麼。
const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn().mockResolvedValue(undefined),
    _encrypt: vi.fn(async (plaintext: string) => ({
      iv: 'iv', authTag: 'tag', encryptedData: plaintext,
    })),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

// 後台任務結果的分發口：真的那份會動態 import 記憶宮殿那一整套（IndexedDB），
// 這裡只關心「補收有沒有把它交出去、銷帳判斷對不對」。
const { resultDispatch } = vi.hoisted(() => ({
  resultDispatch: { calls: [] as unknown[], contexts: [] as unknown[], settle: true },
}));
vi.mock('./amsgResults', () => ({
  dispatchAmsgResult: vi.fn(async (payload: unknown, context?: unknown) => {
    resultDispatch.calls.push(payload);
    resultDispatch.contexts.push(context);
    return resultDispatch.settle;
  }),
}));

const { storeState } = vi.hoisted(() => ({
  storeState: {
    config: {
      userId: '3f2b1c8a-9d4e-4a1b-8c2d-000000000009',
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: '',
      instantChatEnabled: true,
    } as Record<string, unknown>,
    /** 非空時 getGlobalConfig 直接 reject（模擬 IndexedDB 被別的標籤頁卡住那類異常）。 */
    configError: null as Error | null,
    inbox: [] as any[],
    saved: [] as any[],
    markedNotices: [] as Array<{ charId: string; ids: string[] }>,
  },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => {
      if (storeState.configError) throw storeState.configError;
      return storeState.config;
    },
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
    listInboxMessages: async () => storeState.inbox,
    saveInboxMessage: async (message: any) => { storeState.saved.push(message); },
    markExpiredNoticesNotified: async (charId: string, ids: string[]) => {
      storeState.markedNotices.push({ charId, ids });
    },
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY,
  AMSG_OUTBOX_ADOPTED_LS_KEY,
  OUTBOX_BACKFILL_MAX_AGE_MS,
  clearInstantChatPending,
  discardInstantChatExpiredNotices,
  drainOutbox,
  failInstantChatPending,
  getInstantChatPending,
  getStagedInstantChatExpiredNotices,
  isInstantChatReady,
  resetInstantChatReprobeCooldown,
  resolveInstantChatReadiness,
  sendInstantChatTurn,
  setInstantChatPending,
  settleInstantChatApiLog,
  settleInstantChatExpiredNotices,
  stageInstantChatExpiredNotices,
} from './amsgInstantChat';
import { FIRE_PACK_VERSION, unpackStateValue } from './amsgFirePack';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR = { id: 'char-instant-1', name: '小滿', memories: [] } as any;
const USER = { name: '小明' } as any;
const API = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-test' };

const stubFirePackDeps = () => {
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
};

/** 裝一個只認 /instant-chat 的假 fetch，返回它記下來的請求。 */
const mockInstantChatFetch = (status: number, body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => 'application/json' },
    } as any;
  }));
  return calls;
};

beforeEach(() => {
  localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
  localStorage.removeItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY);
  localStorage.removeItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  storeState.inbox = [];
  storeState.saved = [];
  storeState.markedNotices = [];
  storeState.configError = null;
  storeState.config = {
    userId: TEST_USER_ID,
    workerUrl: 'https://amsg.example.workers.dev',
    serverToken: '',
    instantChatEnabled: true,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /instant-chat 的形狀', () => {
  /** 跑一輪，返回解析好的請求體（兩個信封已經是明文）。 */
  const postOnce = async (chatMessages: Array<{ role: string; content: unknown }>, supersedesUuid?: string) => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const result = await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages, api: API, maxTokens: 8000,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      ...(supersedesUuid ? { supersedesUuid } : {}),
    });
    // 按地址挑，不按順序挑：握手時會順帶打一次 /config-check 刷能力位
    // （見 activeMsgClient 的 initializeClient），認 calls[0] 會挑到那一條。
    const call = calls.find((c) => String(c.url).includes('/instant-chat'))!;
    const body = JSON.parse(String(call.init.body));
    return {
      result,
      call,
      state: JSON.parse(body.statePayload.encryptedData),
      task: JSON.parse(body.taskPayload.encryptedData),
      supersedes: body.supersedesUuid,
    };
  };

  it('外殼是明文 JSON：兩個信封已經加密好，別再給外殼掛加密頭', async () => {
    const { call } = await postOnce([{ role: 'user', content: '在嗎' }]);
    expect(call.url).toContain('/instant-chat');
    const headers = new Headers(call.init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-User-Id')).toBe(TEST_USER_ID);
    // 掛了的話包裝層會把整個外殼當成一整份密文，statePayload / taskPayload 就解不出來。
    expect(headers.get('X-Payload-Encrypted')).toBeNull();
    expect(headers.get('X-Encryption-Version')).toBeNull();
  });

  it('任務行型是 auto + none，身份標著 instant', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在嗎' }]);
    // 'instant' 在上游是「當場跑完」的行型，走不到 fire hooks，chat 段就白傳了。
    expect(task.messageType).toBe('auto');
    expect(task.recurrenceType).toBe('none');
    // 標著 instant-chat 而不是 chat：面板對帳靠這個標籤把「用戶正等著的這一輪」
    // 跟定時任務的行分開，不然它會被當成排程補進任務清單。
    expect(task.messageSubtype).toBe('instant-chat');
    expect(task.metadata.amsgMode).toBe('instant');
    expect(task.metadata.amsgInstantChat).toBe(true);
    expect(task.metadata.charId).toBe(CHAR.id);
    expect(typeof task.metadata.amsgClientTaskId).toBe('string');
    // 防穿幫閘問的是「到點還該不該主動開口」——帶上它會把用戶正等著的回覆吞掉。
    expect(task.metadata.amsgExpirePolicy).toBeUndefined();
  });

  it('immediate: true 且不帶 firstSendTime（落庫即到期，慢機吃提前量的 400 無從發生）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在嗎' }]);
    expect(task.immediate).toBe(true);
    expect(task.firstSendTime).toBeUndefined();
  });

  it('頂替 uuid 只在加密信封裡（上游同一事務原子取消），外殼明文不帶', async () => {
    const { task, supersedes } = await postOnce([{ role: 'user', content: '在嗎' }], 'uuid-prev');
    expect(task.supersedesUuid).toBe('uuid-prev');
    expect(supersedes).toBeUndefined();
  });

  it('沒有可頂替的上一條時不帶這個鍵', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在嗎' }]);
    expect(task.supersedesUuid).toBeUndefined();
  });

  // 情緒評估要跟這一輪一起上雲（worker 跑完隨最後一條推送把結果送回來）。它裡頭有
  // 用戶副 API 的 apiKey，落點必須是加密的 taskPayload —— 掉進外殼明文或 statePayload
  // 都等於把憑據攤在網絡上。
  it('情緒評估配置進的是加密的任務信封，明文外殼裡一個字節都沒有', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const emotionEval = {
      prompt: '你是一個角色情緒分析系統。__EMOTION_EVAL_SYSTEM_PROMPT__\n__EMOTION_EVAL_HISTORY__',
      api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-secondary-KEYLEAK', model: 'eval-mini' },
    };
    await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages: [{ role: 'user', content: '在嗎' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      emotionEval,
    });

    const rawBody = String(calls[0].init.body);
    const body = JSON.parse(rawBody);
    const task = JSON.parse(body.taskPayload.encryptedData);
    expect(task.metadata.amsgEmotionEval).toEqual(emotionEval);
    // 外殼（除去兩個信封本身）不許出現副 API 的 key
    const shell = { ...body, statePayload: undefined, taskPayload: undefined };
    expect(JSON.stringify(shell)).not.toContain('sk-secondary-KEYLEAK');
    // 雲端狀態那份也不該有：它跟任務信封是兩碼事，評估配置只跟著這一輪的任務走
    expect(body.statePayload.encryptedData).not.toContain('sk-secondary-KEYLEAK');
  });

  it('沒配情緒評估就不帶這個鍵（不是塞個空對象上去）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在嗎' }]);
    expect(task.metadata.amsgEmotionEval).toBeUndefined();
  });

  it('憑據帶的是調用方給的那份（本地生成會用的同一份）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在嗎' }]);
    expect(task.apiUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(task.apiKey).toBe('sk-test');
    expect(task.primaryModel).toBe('gpt-test');
    expect(task.maxTokens).toBe(8000);
    expect(task.messages).toHaveLength(1);
  });

  it('雲端狀態是 v7 的 fire_pack，chat.messages 就是本地那串 fullMessages', async () => {
    const fullMessages = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: '今天怎麼樣' },
    ];
    const { state } = await postOnce(fullMessages);
    const firePackEntry = state.entries.find((e: any) => e.key === 'fire_pack');
    expect(firePackEntry).toBeTruthy();
    const pack = JSON.parse(await unpackStateValue(firePackEntry.value));
    expect(pack.v).toBe(FIRE_PACK_VERSION);
    expect(pack.chat.messages).toEqual(fullMessages);
    expect(typeof pack.chat.builtAt).toBe('number');
    // 排程那條路傳的那幾樣一個都不能少（worker 到點全都要讀）。
    const keys = state.entries.map((e: any) => e.key);
    expect(keys).toContain('tool_pack');
    expect(keys).toContain('tool_config');
  });

  // ── 輕量包：模板只有定時任務那條路才渲染 ──
  // 角色 2.0 關著（雲端 fire 不注入排程工具）且沒有任務時，每次發送重建一整份系統
  // 提示詞 + 近史轉寫純屬白付——主線程二次構建 + 上行幾十 KB 都發生在拿到 202 之前。
  it('角色 2.0 關著且無任務 → 模板用佔位標記，系統提示詞一次都不構建', async () => {
    const { state } = await postOnce([{ role: 'user', content: '在嗎' }]);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(false);
    // chat 段照常帶全——即時 fire 吃的是它，不是模板
    expect(pack.chat.messages).toHaveLength(1);
    expect(ChatPrompts.buildSystemPrompt).not.toHaveBeenCalled();
  });

  it('角色 2.0 開著 → 照舊帶真模板（雲端 fire 可能當場排出會消費它的任務）', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-real-template' });
    const charOn = { ...CHAR, activeMsg2Config: { enabled: true, tasks: [] } } as any;
    await ActiveMsgClient.sendInstantChat({
      char: charOn, chatMessages: [{ role: 'user', content: '在嗎' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    const body = JSON.parse(String(calls[0].init.body));
    const state = JSON.parse(body.statePayload.encryptedData);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('SYS_PROMPT_MARKER');
    expect(pack.template).not.toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(true);
  });

  // ── 圖片：雲端這條路必須跟本地跑出來的一模一樣 ──
  //
  // 拍平圖片曾經是這裡的做法，代價是模型看不到用戶剛發的那張圖，只能對著
  // 「[User sent an image]」硬答——而且答得挺像回事，用戶根本看不出是這條路缺了東西。
  // 現在原樣帶上雲，只在體積真的過不去時才從最老的開始丟，且當前這輪永不降級。

  /** 造一張「大圖」：分段形狀是真的，base64 內容用重複字符湊體積。 */
  const imageMessage = (role: string, kb: number, text = '[User sent an image]') => ({
    role,
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(kb * 1024)}` } },
    ],
  });

  const chatOf = async (state: any) => {
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    return JSON.parse(await unpackStateValue(entry.value)).chat;
  };

  it('帶圖片那條原樣上雲（結構化分段一個字都不動）', async () => {
    const structured = [
      { role: 'user', content: [
        { type: 'text', text: '[User sent an image]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const { state } = await postOnce(structured);
    const chat = await chatOf(state);
    // 迴歸守衛：拍平的話這裡會變成字符串 '[User sent an image]'，圖片就此消失
    expect(chat.messages).toEqual(structured);
    expect(JSON.stringify(chat.messages)).toContain('base64');
  });

  it('體積超標 → 從最老的消息開始丟圖片本體，文字段留下', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 三張 1 MB 的圖，預算 2 MiB：最老的那張必然要丟
    const { state } = await postOnce([
      imageMessage('user', 1024, '第一張'),
      imageMessage('assistant', 1024, '第二張'),
      { role: 'user', content: '最後這句沒有圖' },
    ]);
    const chat = await chatOf(state);
    expect(chat.messages[0].content).toBe('第一張');          // 丟成文字段
    expect(typeof chat.messages[0].content).toBe('string');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('最新那條用戶消息的圖片永遠不丟（這一輪要聊的就是它）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state } = await postOnce([
      imageMessage('user', 1024, '很久以前那張'),
      imageMessage('assistant', 1024, '角色發的那張'),
      imageMessage('user', 512, '剛發出去的這張'),
    ]);
    const chat = await chatOf(state);
    const newest = chat.messages[2];
    // 迴歸守衛：從頭往後丟的循環要是沒跳過它，用戶剛發的圖就沒了，而回復照樣有
    expect(Array.isArray(newest.content)).toBe(true);
    expect(newest.content[1].image_url.url).toContain('base64');
    // 老的兩條讓位
    expect(typeof chat.messages[0].content).toBe('string');
    warn.mockRestore();
  });

  it('只剩最新那條還是超預算 → 拋錯，不悄悄把當前這輪截斷', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(postOnce([imageMessage('user', 4096, '一張巨圖')]))
      .rejects.toThrow(/[图圖]片太大/);
    warn.mockRestore();
  });

  // ── 超預算的報錯要說真話 ──
  // 拍平循環只壓得動圖片；純文本本身就超限（長角色卡 + 世界書 + 近史）時它一條也壓
  // 不掉。以前這條路也報「圖片太大…刪掉圖片再發」——用戶沒有圖可刪，照著做永遠修不好。
  it('純文本就超預算 → 報「上下文太大」，一個字不提圖片', async () => {
    const err = await postOnce([
      { role: 'system', content: 'A'.repeat(3 * 1024 * 1024) },
      { role: 'user', content: '在嗎' },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('上下文太大');
    // 迴歸守衛：舊文案叫用戶刪圖，純文本輪裡沒有圖可刪
    expect(err.message).not.toContain('圖片');
  });

  it('小圖 + 巨文本（刪圖也救不回來）→ 同樣報上下文太大，不指錯路讓用戶刪圖', async () => {
    const err = await postOnce([
      { role: 'system', content: 'A'.repeat(3 * 1024 * 1024) },
      imageMessage('user', 16, '順手帶的小圖'),
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('上下文太大');
    expect(err.message).not.toContain('圖片');
  });

});

describe('只有 202 才算發出去', () => {
  const send = async (status: number, body: unknown) => {
    stubFirePackDeps();
    mockInstantChatFetch(status, body);
    return sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在嗎' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
  };

  it('202 → 記一筆待收記錄', async () => {
    const result = await send(202, { status: 'accepted', uuid: 'uuid-ok' });
    expect(result.ok).toBe(true);
    expect(getInstantChatPending(CHAR.id)?.uuid).toBe('uuid-ok');
  });

  it('200 但沒有 uuid → 算沒發出去（別把「可能發了」當成發了）', async () => {
    const result = await send(200, { success: true });
    expect(result.ok).toBe(false);
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('401 → 明確告訴用戶密鑰對不上，不留待收記錄', async () => {
    const result = await send(401, { success: false, error: { code: 'INVALID_CLIENT_TOKEN' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('共享密鑰');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('上游那一步掛了 → 原因帶出來，仍然算沒發出去', async () => {
    const result = await send(500, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_FAILED', message: '雲端狀態沒傳上去，這條沒發出去',
        step: 'client-state', upstream: { error: { message: 'D1 timeout' } },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('INSTANT_CHAT_STATE_FAILED');
    expect(result.error).toContain('D1 timeout');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  // firstSendTime 是設備的鐘加提前量算的，上游按自己的鐘校驗「必須在未來」——
  // 慢網大包上傳或設備時鐘偏慢都會把提前量吃光。這種失敗要指條路（重試 / 查自動
  // 對時），不能掉進一句沒人看得懂的 HTTP 400。
  it('上游打回「時間必須在未來」→ 文案指向網絡慢 / 時鐘偏慢', async () => {
    const result = await send(400, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_TASK_FAILED', message: '任務沒建起來，這條沒發出去',
        step: 'schedule-message',
        upstream: {
          success: false,
          error: {
            code: 'INVALID_TIMESTAMP', message: '時間必須在未來',
            details: { field: 'firstSendTime', reason: 'must be in the future' },
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('時鐘');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });
});

// 「API 調用記錄」的記錄點掛在全局 fetch 攔截器上，只認 /chat/completions——上雲這一輪
// 本地只發一個 POST 給自己的 Worker，那條攔不到。不專門記的話，開了即時對話之後聊天
// 在記錄裡整個消失，看著像調用憑空沒了。
describe('上雲的這一輪也進「API 調用記錄」', () => {
  /** 收走寫庫的那幾筆（apiCallLog 走動態 import('./db')，按 DB 單例打樁攔得到）。 */
  const captureLog = () => {
    const logged: any[] = [];
    vi.spyOn(DB, 'appendApiCallLog').mockImplementation(async (entry: any) => { logged.push(entry); });
    return logged;
  };

  const sendOnce = async (status: number, body: unknown) => {
    stubFirePackDeps();
    mockInstantChatFetch(status, body);
    const logged = captureLog();
    await sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在嗎' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    return logged[0];
  };

  it('202 → 落一筆標著雲端的「生成中」記錄', async () => {
    const entry = await sendOnce(202, { status: 'accepted', uuid: 'uuid-log' });
    expect(entry).toMatchObject({
      id: 'cloud-uuid-log',
      route: 'cloud-instant-chat',
      pending: true,
      ok: true,
      baseUrl: API.baseUrl,
      model: API.model,
      appName: '消息',
      charId: CHAR.id,
      charName: CHAR.name,
      // 跟本地生成那條路同一個詞，兩條路在列表裡對得起來。
      purpose: '聊天回覆',
    });
    // 輸入構成照算：這一輪到底交上去多大的東西，本地就這一份線索。
    expect(entry.promptBreakdown?.length).toBeGreaterThan(0);
  });

  it('連 202 都沒拿到 → 記一筆當場就是終態的失敗，不留「生成中」掛著', async () => {
    const entry = await sendOnce(500, { success: false, error: { code: 'X', message: '雲端掛了' } });
    expect(entry).toMatchObject({ route: 'cloud-instant-chat', pending: false, ok: false });
    expect(entry.promptBreakdown?.length).toBeGreaterThan(0);
  });

  it('還沒等到回覆就又發一條 → 上一筆收成「已頂替」，不會一直轉圈到被裁掉', async () => {
    stubFirePackDeps();
    mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-second' });
    setInstantChatPending(CHAR.id, 'uuid-first', 1_000);
    const logged = captureLog();
    await sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '還在嗎' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    // 頂掉的那一輪不算失敗：雲端把兩句合成一次回，只是它不再單獨等回覆了。
    expect(logged.find((e) => e.id === 'cloud-uuid-first')).toMatchObject({
      pending: false, superseded: true, ok: true,
    });
    expect(logged.find((e) => e.id === 'cloud-uuid-second')?.pending).toBe(true);
  });

  it('回覆回來 → 同一條記錄補上用量，時間戳一個字不動（列表順序不許跟著回覆先後跳）', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', { amsgUsage: { promptTokens: 1200, completionTokens: 80 } });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({
      id: 'cloud-uuid-log', pending: false, ok: true,
      promptTokens: 1200, completionTokens: 80,
      // 雲端只報入和出，總數本地自己加——列表頂上的合計讀的就是它。
      totalTokens: 1280,
    });
    expect(logged[0].timestamp).toBeUndefined();
    expect(logged[0].tokensPartial).toBeUndefined();
  });

  it('這一輪調過工具 → 用量標成只算末輪（雲端只報得回最後一次調用的數）', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', {
      amsgUsage: { promptTokens: 1200, completionTokens: 80 },
      amsgToolTrace: [{ name: 'web_search', count: 1 }],
    });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].tokensPartial).toBe(true);
  });

  it('雲端沒回用量 → 只銷「生成中」，不往記錄裡填 0 冒充真數', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', {});
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].pending).toBe(false);
    expect(logged[0].promptTokens).toBeUndefined();
    expect(logged[0].totalTokens).toBeUndefined();
  });

  it('雲端點名說這一輪沒成 → 那筆跟著收尾成失敗，不會一直寫著「生成中」', async () => {
    setInstantChatPending(CHAR.id, 'uuid-dead', 1_000);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    const logged = captureLog();
    await failInstantChatPending(CHAR.id, 'uuid-dead', '雲端生成失敗');
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({ id: 'cloud-uuid-dead', pending: false, ok: false });
  });
});

describe('待收記錄（「正在輸入…」那盞燈的唯一依據）', () => {
  it('落在 localStorage 裡，重啟後還在', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    // 模塊狀態每次都從存儲讀，等價於重開一次應用。
    expect(getInstantChatPending('char-a')).toEqual({ charId: 'char-a', uuid: 'uuid-a', acceptedAt: 1_000, charName: '' });
    expect(localStorage.getItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY)).toContain('uuid-a');
  });

  it('同角色只留最新一條（頂替之後舊 uuid 沒人認領了）', () => {
    setInstantChatPending('char-a', 'uuid-1', 1_000);
    setInstantChatPending('char-a', 'uuid-2', 2_000);
    expect(getInstantChatPending('char-a')?.uuid).toBe('uuid-2');
  });

  it('銷帳是冪等的', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    expect(clearInstantChatPending('char-a')).toBe(true);
    expect(clearInstantChatPending('char-a')).toBe(false);
    expect(getInstantChatPending('char-a')).toBeNull();
  });

  it('存儲裡躺著壞數據時當沒有，不能把整條路帶崩', () => {
    localStorage.setItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY, '{ 這不是 JSON');
    expect(getInstantChatPending('char-a')).toBeNull();
  });
});

// 這一輪以「沒等到回覆」收尾時，「情緒更新中」那盞燈也得跟著滅。
//
// 情緒評估的結果是搭最後一條回覆的推送回來的（metadata.amsgEmotionDone）。可這一輪
// 要是**一條推送都沒有**——模型空輸出/純拒答被 worker 判成 skip-push，或者整條 fire
// 硬失敗——那個信號永遠不會到，燈只能等 660 秒的安全網熄，期間還會彈一句「worker 可能
// 是舊版」的誤導提示。雲端已經點名說這一輪沒成，就是最確定的熄燈時機。
describe('零推送收尾時也要熄滅情緒徽章', () => {
  // node 環境沒有 window，給個最小 stub（這一組只關心派了哪些事件）。
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });

  /** 記下這一段派了哪些事件（spy 而不是手工換函數：restore 交給 vitest，漏還原不了）。 */
  const captureEvents = () => {
    const seen: Array<{ type: string; detail: any }> = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
      seen.push({ type: event?.type, detail: event?.detail });
      return true;
    });
    return { seen, restore: () => spy.mockRestore() };
  };

  it('銷帳成功 → 發一次 instant-emotion-done（徽章的熄滅信號）', async () => {
    setInstantChatPending('char-emo', 'uuid-emo', 1_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-emo', '雲端生成失敗');
    } finally {
      restore();
    }
    const done = seen.filter((e) => e.type === 'instant-emotion-done');
    expect(done).toHaveLength(1);
    expect(done[0].detail).toEqual({ charId: 'char-emo' });
  });

  // 結論遲到、用戶已經又發了一條時，銷的是新那一輪的帳才叫出事——燈也一樣：
  // 新那一輪的評估還在雲端跑著，這時候熄燈等於騙人。
  it('結論對不上當前這一輪 → 一個事件都不發（新那一輪的燈不許碰）', async () => {
    setInstantChatPending('char-emo', 'uuid-new', 2_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-old', '遲到的結論');
    } finally {
      restore();
    }
    expect(seen.some((e) => e.type === 'instant-emotion-done')).toBe(false);
    expect(getInstantChatPending('char-emo')?.uuid).toBe('uuid-new');
  });
});

describe('開關', () => {
  it('設置頁開了 + 地址填著 → 走雲端', async () => {
    expect(await isInstantChatReady()).toBe(true);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  it('開關沒開 → 不走（每條消息都讀這一份，別處不做第二道門）', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: false };
    expect(await isInstantChatReady()).toBe(false);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'disabled' });
  });

  it('地址空著 → 不走', async () => {
    storeState.config = { ...storeState.config, workerUrl: '  ' };
    expect(await isInstantChatReady()).toBe(false);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'no-worker-url' });
  });

  // ─── Worker 跑不動這條路（instantChatSupported）───
  //
  // 跑不動的 Worker 上即時對話是**發一條掛一條**：老 bundle 被 waitUntil 砍在 30 秒，
  // 新 bundle 少了起跳器直接 503。用戶開著開關也得讓位給本地生成，否則他對著
  // 「正在輸入…」等一條永遠不來的回覆，而設置頁寫著「已開啟」。

  // 存量是粘的（只有探測成功才翻得回來），所以讓位之前一定要先現探一次——下面四條釘的
  // 就是這次現探的四種去向。

  /** 存量說跑不動 + 擺好「這次現探會問到什麼」。 */
  const stageOutdatedWithProbe = (outcome: 'supported' | 'unsupported' | 'unknown') => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: false };
    // 冷卻是模塊級狀態，會串到別的用例上去。
    resetInstantChatReprobeCooldown();
    return vi.spyOn(ActiveMsgClient, 'probeInstantChatSupportDetailed').mockResolvedValue({
      outcome,
      supported: outcome === 'supported' ? true : outcome === 'unsupported' ? false : undefined,
    });
  };

  it('現探確認跑不動 → 用戶開著也不走雲端（reason worker-outdated）', async () => {
    stageOutdatedWithProbe('unsupported');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 靜音，只數次數 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'worker-outdated' });
    // 「用戶沒開」和「開了但用不了」是兩回事：混成 disabled 的話，設置頁那句提示、
    // 觀察窗那條 trace 都沒了著落。
    expect(readiness.reason).not.toBe('disabled');
    // 靜默讓位正是「靜默分流」那個坑，必須留聲。
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // ★ 這條是「一次抖動 ≠ 長期降級」的守衛。
  // 從前存量一旦是 false 就直接判死，而寫下這個 false 的可能只是一次網絡抖動——用戶不
  // 碰巧打開設置頁就一直卡在本地生成（線上真實故障：Worker 全綠，用戶連著幾小時全走本地，
  // 而他的本地直連根本不通）。現在發消息路上會現探一次，好了立刻回到雲端。
  it('存量說跑不動、現探卻發現已經好了 → 這一輪就回到雲端（不必等用戶去開設置頁）', async () => {
    stageOutdatedWithProbe('supported');
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  // 夠不著雲端時不能指人去「更新 Worker」：他多半點不動，而且問題也不在那兒。
  it('現探夠不著雲端 → 單獨一檔 worker-unreachable，不叫人去更新 Worker', async () => {
    stageOutdatedWithProbe('unknown');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 靜音，只數次數 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'worker-unreachable' });
    expect(readiness.reason).not.toBe('worker-outdated');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // 現探是加在發消息路上的，連發幾條消息不能變成一串 /config-check。
  it('冷卻期內不重複現探（連發三條只探一次）', async () => {
    const probe = stageOutdatedWithProbe('unsupported');
    vi.spyOn(console, 'warn').mockImplementation(() => { /* 靜音 */ });
    await resolveInstantChatReadiness();
    await resolveInstantChatReadiness();
    await resolveInstantChatReadiness();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('沒探過（undefined）→ 放行：不知道 ≠ 知道它不行', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: undefined };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  it('探到能跑 → 照常上雲', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: true };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  // 用戶自己沒開的時候，「Worker 行不行」根本不該被問——那一檔的原因是 disabled，
  // 報成 worker-outdated 會讓設置頁對著一個沒開的開關喊「去更新 Worker」。
  it('用戶自己沒開時，先報 disabled，不越到 worker-outdated', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: false, instantChatSupported: false };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'disabled' });
  });

  // 能力位是「上一台 Worker」留下的存量。地址都空著還報「Worker 太舊」的話，
  // 設置頁會把人指去點一個根本沒連上的東西。
  it('地址空著時報 no-worker-url，不越到 worker-outdated', async () => {
    storeState.config = { ...storeState.config, workerUrl: '  ', instantChatSupported: false };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'no-worker-url' });
  });

  // 讀配置失敗被當成「沒開」的話，這一輪會悄悄退回本地直連生成：用戶按完發送隨手鎖屏，
  // 本地 fetch 被系統掐掉，回來時既沒有回覆也沒有報錯，設置頁還寫著「已開啟」，觀察窗裡
  // 查無此事。所以它必須是單獨一檔、而且落地一條 warn。
  it('配置根本讀不出來 ≠ 沒開：單獨一檔 config-unreadable，而且不許靜默', async () => {
    storeState.configError = new Error('IndexedDB blocked by another tab');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 靜音，只數次數 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'config-unreadable' });
    expect(readiness.reason).not.toBe('disabled');
    expect(warn).toHaveBeenCalledTimes(1);
    // 只關心「走不走得通」的老調用點（設置頁互斥門）行為不變：依舊是 false，不拋。
    expect(await isInstantChatReady()).toBe(false);
  });

  // ─── 角色級開關（undefined = 跟隨全局默認開，只認顯式 false）───

  it('角色自己關了 → 不走雲端，reason char-disabled', async () => {
    const char = { activeMsg2Config: { enabled: true, instantChatEnabled: false } } as any;
    expect(await resolveInstantChatReadiness(char)).toEqual({ ready: false, reason: 'char-disabled' });
  });

  it('字段沒設 / 顯式 true → 照常上雲（undefined 就是開，沒有兼容舞步）', async () => {
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true } } as any))
      .toEqual({ ready: true });
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true, instantChatEnabled: true } } as any))
      .toEqual({ ready: true });
    // 連 activeMsg2Config 都沒有的角色也一樣是開。
    expect(await resolveInstantChatReadiness({} as any)).toEqual({ ready: true });
  });

  it('與排程開關互相獨立：enabled=false 不影響即時對話', async () => {
    // 只即時不排程：排程關著、即時字段沒設 → 照常上雲。
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: false } } as any))
      .toEqual({ ready: true });
  });

  it('char-disabled 是用戶的主動選擇，不 warn（跟「全局沒開」同一待遇）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 靜音，只數次數 */ });
    await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true, instantChatEnabled: false } } as any);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('隨這一輪上雲的作廢回執', () => {
  const NOTICE_CHAR = 'char-notice';

  it('202 之後只記帳，不銷帳（受理 ≠ 角色讀到過）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1', 'n2']);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toEqual({
      charId: NOTICE_CHAR, uuid: 'uuid-1', ids: ['n1', 'n2'],
    });
    expect(storeState.markedNotices).toEqual([]);
  });

  it('回覆真的落庫了才銷帳，而且只銷一次', async () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1', 'n2']);
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1')).toEqual(['n1', 'n2']);
    expect(storeState.markedNotices).toEqual([{ charId: NOTICE_CHAR, ids: ['n1', 'n2'] }]);
    // 台帳已經取走：同一輪的補收 / 重複沖刷再調一次不會二次銷帳。
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1')).toEqual([]);
    expect(storeState.markedNotices).toHaveLength(1);
  });

  it('銷帳認 uuid：上一輪遲到的結論碰不到新那一輪的回執', async () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new', ['n1']);
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-old')).toEqual([]);
    expect(storeState.markedNotices).toEqual([]);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)?.uuid).toBe('uuid-new');
  });

  it('連發時新那一輪頂掉舊記錄（舊的還沒銷帳，會跟著新一輪一起重注）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-2', ['n1', 'n2']);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toEqual({
      charId: NOTICE_CHAR, uuid: 'uuid-2', ids: ['n1', 'n2'],
    });
  });

  it('台帳扛得住重啟（雲端那一輪本來就可能橫跨一次刷新）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    expect(JSON.parse(localStorage.getItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY) || '{}'))
      .toEqual({ [NOTICE_CHAR]: { charId: NOTICE_CHAR, uuid: 'uuid-1', ids: ['n1'] } });
  });

  // 這一條是整個改動的由頭：雲端整輪失敗（空輸出被判 skip-push / fire 重試打光）時，
  // 回執要是已經銷過帳，角色永遠不知道那條任務被作廢過 —— 聊天裡許下的承諾憑空消失。
  it('這一輪判定失敗 → 回執退回未告知，絕不銷帳', async () => {
    setInstantChatPending(NOTICE_CHAR, 'uuid-1', 1_000);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    await failInstantChatPending(NOTICE_CHAR, 'uuid-1', '雲端生成失敗');
    expect(storeState.markedNotices).toEqual([]);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toBeNull();
  });

  it('失敗結論對不上當前這一輪 → 新那一輪的回執一根都別動', async () => {
    setInstantChatPending(NOTICE_CHAR, 'uuid-new', 2_000);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new', ['n1']);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    await failInstantChatPending(NOTICE_CHAR, 'uuid-old', '遲到的結論');
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)?.ids).toEqual(['n1']);
    expect(discardInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new')).toEqual(['n1']);
    expect(storeState.markedNotices).toEqual([]);
  });
});

describe('推送丟了的補收（服務端帳本）', () => {
  const outboxPush = (messageId: string, overrides: Record<string, any> = {}) => ({
    messageKind: 'content',
    messageType: 'instant',
    source: 'scheduled',
    message: '我在呢',
    contactName: '小滿',
    messageId,
    sessionId: 'sess-1',
    messageIndex: 1,
    totalMessages: 1,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    taskId: 7,
    taskUuid: 'uuid-round-1',
    occurrenceMs: 1_700_000_000_000,
    metadata: { charId: CHAR.id, charName: '小滿', amsgInstantChat: true },
    ...overrides,
  });

  const entry = (messageId: string, push: Record<string, any>, createdAt = Date.now()) => ({
    id: 1, messageId, taskUuid: 'uuid-round-1', sessionId: 'sess-1',
    messageIndex: 1, totalMessages: 1, createdAt, deliveredAt: null, push,
  });

  const stubOutbox = (entries: any[]) => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue(entries as any);
  };

  // 這一組測的都是「已經接上帳本之後」的常規補收。首次接管走的是另一條路（存量整批
  // 銷帳、不上屏），單獨一組在下面。
  beforeEach(() => {
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
  });

  it('帳本上的那條寫進收件箱，字段跟 SW 收真推送時寫的一份對得上', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, outboxPush(messageId))]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(1);
    expect(ackNow).toEqual([]);           // 落庫之前不許銷帳
    const saved = storeState.saved[0];
    expect(saved.charId).toBe(CHAR.id);
    expect(saved.body).toBe('我在呢');
    expect(saved.messageType).toBe('instant');
    expect(saved.taskId).toBe(7);
    expect(saved.metadata.sessionId).toBe('sess-1');
    expect(saved.sentAt).toBe(1_700_000_000_000);
  });

  // Service Worker 直送和帳本補收寫的是同一批消息、同一個主鍵，補收落庫就是整條覆蓋。
  // 要是連「到達時間」也覆蓋成現在，這條在收件箱裡躺了多久就永遠查不出來了（一律顯示
  // 剛到），而「送達時用戶在不在場」正是拿它判的——判錯的後果是：明明用戶離開時就到了、
  // 系統通知早已完整念過一遍的消息，回來還要一條條重演打字。
  it('SW 已經送到、還沒被消費的那條，補收只換內容不改它到達的時刻', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    const swReceivedAt = Date.now() - 30_000;   // SW 半分鐘前就把它存進收件箱了
    storeState.inbox = [{ messageId, receivedAt: swReceivedAt }] as any;
    stubOutbox([entry(messageId, outboxPush(messageId))]);

    await drainOutbox();

    expect(storeState.saved[0].receivedAt, '第一次落到這台設備的時刻不該被抹掉').toBe(swReceivedAt);
  });

  it('本地壓根沒有過的那條，到達時刻才記成現在', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_1';
    const before = Date.now();
    storeState.inbox = [];
    stubOutbox([entry(messageId, outboxPush(messageId))]);

    await drainOutbox();

    expect(storeState.saved[0].receivedAt).toBeGreaterThanOrEqual(before);
  });

  // 帳本是這一版才開始銷帳的，頭一次拉會把歷史積壓一次性倒出來。不掐時效的話，那些
  // 早就落過庫的老消息會因為超出近史去重的查詢窗口而重新上屏。
  it('超過時效窗口的條目不進聊天流，當場銷帳', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
    stubOutbox([entry(messageId, outboxPush(messageId), tooOld)]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual([messageId]);
  });

  // 線上真實事故的第二半：一條回覆在帳本上躺了 28 小時，用戶隔天開 App 時被自動補收
  // 按「太舊了」銷掉，一個字都沒上屏；他後來去點「找回沒收到的消息」，看到的是
  // 「帳本上沒有漏收的消息——這條鏈路是通的」。窗口拉到兩天能蓋住「隔一夜 + 第二天
  // 想起來」這個最常見的節奏，而超窗的那些必須數出來說給用戶聽。
  it('窗口是兩天：47 小時的補回來，49 小時的算作「拿不回來了」', async () => {
    const fresh = 'msg-47h';
    const stale = 'msg-49h';
    stubOutbox([
      entry(fresh, outboxPush(fresh), Date.now() - 47 * 3_600_000),
      entry(stale, outboxPush(stale), Date.now() - 49 * 3_600_000),
    ]);
    const { written, ackNow, staleDropped } = await drainOutbox();
    expect(written, '47 小時還在窗口內').toBe(1);
    expect(ackNow, '49 小時的只銷帳').toEqual([stale]);
    expect(staleDropped, '超窗的要數出來，界面靠它說話').toBe(1);
  });

  // 帳本行躺到超齡，最常見的成因根本不是「消息丟了」，而是**消息早就送達了**：收尾那筆
  // 銷帳是 fire-and-forget，用戶看完隨手鎖屏就被掐斷，帳一直掛著。不核對本地就一律按
  // 「永久拿不回來了」報的話，用戶會收到一句紅字說自己丟了消息——而那條消息就躺在聊天
  // 記錄裡，他剛剛才看過。
  it('超齡但本地已經有同 id 的消息 → 只補銷帳，不算「拿不回來了」', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
    stubOutbox([entry(messageId, outboxPush(messageId), tooOld)]);
    // 落庫的每條氣泡都繼承 metadata.activeMsg2.messageId，核對認的就是它。
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([
      { role: 'assistant', metadata: { activeMsg2: { messageId } } },
    ] as any);

    const { written, ackNow, staleDropped } = await drainOutbox();

    expect(written).toBe(0);
    expect(ackNow, '帳還是要銷，不然每趟都把它撈回來').toEqual([messageId]);
    expect(staleDropped, '消息就在聊天記錄裡，一條都沒丟').toBe(0);
  });

  it('超齡且本地確實沒有 → 照舊算「拿不回來了」', async () => {
    const messageId = 'msg-really-lost';
    const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
    stubOutbox([entry(messageId, outboxPush(messageId), tooOld)]);
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);

    const { ackNow, staleDropped } = await drainOutbox();

    expect(ackNow).toEqual([messageId]);
    expect(staleDropped).toBe(1);
  });

  // staleDropped 只數「本該收到、現在永久拿不回來」的那一檔。思維鏈、工具請求這些
  // 本來就不進聊天流，銷掉不損失任何東西——混進來的話，界面會把「丟了 1 條」說成
  // 「丟了 3 條」，用戶白緊張一場，真出事時也就不信這個數了。
  it('只數超窗的那一檔，不進聊天流的那幾類不算「丟了」', async () => {
    stubOutbox([
      entry('msg-reasoning', outboxPush('msg-reasoning', { messageKind: 'reasoning' })),
      entry('msg-tool', outboxPush('msg-tool', { messageKind: 'tool_request' })),
    ]);
    const { ackNow, staleDropped } = await drainOutbox();
    expect(ackNow).toHaveLength(2);
    expect(staleDropped).toBe(0);
  });

  // 補收回來已經沒有意義的那幾類：思維鏈要掛在正文上、工具請求那頭的雲端早就收工了、
  // 隔了一陣子的報錯彈出來只會讓人摸不著頭腦。但帳還是要銷，不然每趟都把它們撈回來。
  it.each(['reasoning', 'tool_request', 'error'])('%s 類不進聊天流，當場銷帳', async (kind) => {
    const messageId = `msg-${kind}`;
    stubOutbox([entry(messageId, outboxPush(messageId, { messageKind: kind }))]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual([messageId]);
  });

  // 後台任務（門牌整理這類）跑完送回來的結果**只走這條路**：不彈通知的結果上游只落
  // 帳本、不發推送，所以補收是它唯一的入口。跟 reasoning/error 那批一起當場銷帳丟掉的
  // 話，雲端跑完的東西會一聲不響地全部蒸發——面板全綠、日誌乾淨、就是東西沒了。
  describe('後台任務的結果（messageKind: result）', () => {
    beforeEach(() => {
      resultDispatch.calls = [];
      resultDispatch.contexts = [];
      resultDispatch.settle = true;
    });

    it('交給分發口，不寫進聊天流', async () => {
      const messageId = 'msg-result';
      const push = outboxPush(messageId, {
        messageKind: 'result',
        resultKind: 'plate-consolidate',
        message: undefined,
        items: [{ room: 'user_room', text: '小明搬去合租了' }],
      });
      stubOutbox([entry(messageId, push)]);
      const { written, ackNow } = await drainOutbox();

      expect(written).toBe(0);
      expect(storeState.saved).toHaveLength(0);
      expect(resultDispatch.calls).toEqual([push]);
      expect(ackNow).toEqual([messageId]);
    });

    it('消化失敗就不銷帳，下次上線再拉回來', async () => {
      resultDispatch.settle = false;
      const messageId = 'msg-result-retry';
      stubOutbox([entry(messageId, outboxPush(messageId, {
        messageKind: 'result', resultKind: 'plate-consolidate',
      }))]);
      const { ackNow } = await drainOutbox();
      expect(ackNow).toEqual([]);
    });

    // 迴歸守衛：這條路刻意跳過了聊天那兩天的時效窗（結果晚到本來就是常態），可跳過
    // 之後沒換上任何上限。帳本留 28 天——重裝 PWA 的用戶第一次接上帳本會把一個月前的結果
    // 一次性拉回來。這裡不替各種產物定規矩，但帳本上記的時間必須原樣交出去，認領它的
    // 那一方才判得了「陳到不能用了沒有」。
    it('時效窗那道判斷不套在結果上，但帳本上記的時間要交出去', async () => {
      const messageId = 'msg-result-old';
      const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
      stubOutbox([entry(messageId, outboxPush(messageId, {
        messageKind: 'result', resultKind: 'plate-consolidate',
      }), tooOld)]);
      await drainOutbox();
      expect(resultDispatch.calls).toHaveLength(1);
      expect(resultDispatch.contexts[0], '不交時間的話它連「這份躺了多久」都問不出來')
        .toEqual({ createdAt: tooOld });
    });
  });

  it('情緒結果顯式標成 emotion_update（沖刷管線靠它分流，認不出會當正文氣泡渲染）', async () => {
    const messageId = 'msg-emotion';
    stubOutbox([entry(messageId, outboxPush(messageId, {
      messageKind: 'emotion_update',
      messageType: undefined,
      message: '',
      metadata: { charId: CHAR.id, emotionRaw: '{"joy":1}' },
    }))]);
    const { written } = await drainOutbox();
    expect(written).toBe(1);
    expect(storeState.saved[0].messageType).toBe('emotion_update');
    expect(storeState.saved[0].metadata.emotionRaw).toBe('{"joy":1}');
  });

  it('推送載荷少了 charId → 沒有落點，丟掉並銷帳而不是造一條無主消息', async () => {
    stubOutbox([entry('msg-orphan', { messageKind: 'content', message: '孤兒' })]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual(['msg-orphan']);
  });

  // 銷帳即失憶：帳一銷，這條就再也拉不回來了。寫不進收件箱時必須留著帳。
  it('寫收件箱失敗 → 不銷帳，下次拉回來再試', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, outboxPush(messageId))]);
    const { ActiveMsgStore } = await import('./activeMsgStore');
    vi.spyOn(ActiveMsgStore, 'saveInboxMessage').mockRejectedValueOnce(new Error('quota'));
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(ackNow).toEqual([]);
  });

  it('帳本讀失敗照常拋（「沒讀到」≠「讀到了、確實沒有」，調用方才好分開收場）', async () => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockRejectedValue(new Error('offline'));
    await expect(drainOutbox()).rejects.toThrow('offline');
  });

  // 契約測試：push→inbox 的字段映射有兩份手工同步的副本（SW 的 saveContentToInbox 與
  // 這裡的補收路徑），銷帳檢查只讀 metadata.messageIndex/totalMessages、缺失當末段——
  // 任一副本漏抄這兩個字段，多段回覆的首段就會被當成末段銷帳，後續段永久丟失且無報錯。
  // 這裡釘住補收側必須把頂層段號抄進 metadata（與 sw-keep-alive.ts 的映射同一條規則；
  // 那份是 SW 代碼沒法直接 import，改動 SW 映射時這條測試就是要一起過的清單）。
  it('頂層 messageIndex/totalMessages 必須抄進 metadata（銷帳檢查只認 metadata 裡的）', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, {
      messageKind: 'content',
      message: '第一段',
      messageId,
      sessionId: 'sess_task_7@1700000000000',
      taskUuid: 'uuid-round-1',
      messageIndex: 1,
      totalMessages: 3,
      metadata: { charId: CHAR.id },
    })]);
    await drainOutbox();
    const inbox = storeState.saved[0];
    expect(inbox).toBeTruthy();
    expect(inbox.metadata.messageIndex).toBe(1);
    expect(inbox.metadata.totalMessages).toBe(3);
    expect(inbox.metadata.sessionId).toBe('sess_task_7@1700000000000');
  });
});

// 帳本上躺著的存量 ≠「我丟了的消息」：服務端從建表那一刻起就在記，而銷帳是客戶端這
// 一版才有的能力。頭一趟要是當補收放進聊天流，用戶會被這段時間收過的消息整批重放一遍
// （角色「瘋狂回覆」，而且刪掉重複消息反而會讓近史去重失效、下一趟倒得更兇）。時效
// 窗口擋不住這一檔——存量的年齡本來就在窗口之內，「昨晚更新 worker、今天升級前端」
// 就是最典型的那條時間線。
describe('第一次接上服務端帳本', () => {
  const entry = (messageId: string, taskUuid: string) => ({
    id: 1,
    messageId,
    taskUuid,
    sessionId: 'sess-x',
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: null,
    push: {
      messageKind: 'content',
      message: '這是帳本上的存量',
      messageId,
      taskUuid,
      metadata: { charId: CHAR.id, charName: '小滿' },
    },
  });

  const stubOutboxOnce = (entries: any[]) =>
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue(entries as any);

  it('存量整批銷帳，一條都不進聊天流', async () => {
    stubOutboxOnce([entry('m1', 'uuid-1'), entry('m2', 'uuid-2')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { written, ackNow } = await drainOutbox();

    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ack).toHaveBeenCalledWith(['m1', 'm2']);
    expect(ackNow).toEqual([]);      // 已經在接管裡銷掉了，不用調用方再銷一次
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeTruthy();
  });

  // 接管那一趟恰好趕上用戶發消息時，這一輪的回覆不能被當存量銷掉——否則他等來的是
  // 一句「雲端已處理，但回覆沒能取回」。
  it('此刻正等著的那一輪不算存量，照常補收上屏', async () => {
    setInstantChatPending(CHAR.id, 'uuid-awaited');
    stubOutboxOnce([entry('m-old', 'uuid-old'), entry('m-awaited', 'uuid-awaited')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { written } = await drainOutbox();

    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-awaited']);
    expect(ack).toHaveBeenCalledWith(['m-old']);
  });

  // 迴歸守衛：換設備 / 重裝 PWA / 清過 localStorage 的用戶，啟動第一趟走的就是這條路。
  // 後台任務的結果不進聊天流，沒有「存量重放刷屏」這回事，而補收是它唯一的入口（不彈
  // 通知的結果上游只落帳本、不發推送）。跟存量一起銷掉的話，雲端已經跑完的門牌整理會
  // 一聲不響地蒸發，面板全綠、日誌乾淨、就是東西沒了。
  it('後台任務的結果不算存量，照常交給分發口', async () => {
    resultDispatch.calls = [];
    resultDispatch.settle = true;
    const resultEntry = {
      ...entry('m-result', 'uuid-job'),
      push: { messageKind: 'result', resultKind: 'plate-consolidate', messageId: 'm-result' },
    };
    stubOutboxOnce([entry('m-old', 'uuid-old'), resultEntry]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { ackNow } = await drainOutbox();

    expect(ack, '結果不在整批銷帳那一批裡').toHaveBeenCalledWith(['m-old']);
    expect(resultDispatch.calls).toHaveLength(1);
    expect(ackNow, '消化成功之後才銷它自己那一條').toEqual(['m-result']);
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeTruthy();
  });

  // 先記標記再銷帳的話，銷帳一失敗，剩下的存量下一趟就會被當成補收倒進聊天流。
  it('存量沒銷乾淨 → 不記標記，下一趟重新接管', async () => {
    stubOutboxOnce([entry('m1', 'uuid-1')]);
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockRejectedValue(new Error('worker 沒應答'));

    const { written, ackNow } = await drainOutbox();

    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual([]);
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeNull();
  });

  it('接管過一次之後，帳本上的新條目照常補收', async () => {
    const list = stubOutboxOnce([entry('m-backlog', 'uuid-old')]);
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    await drainOutbox();
    expect(storeState.saved).toHaveLength(0);

    list.mockResolvedValue([entry('m-new', 'uuid-new')] as any);
    const { written } = await drainOutbox();

    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-new']);
  });

  // 自動路徑把存量整批銷掉是對的（分不清哪些是真丟的），但對「我確實少收了消息」的
  // 用戶來說，那批存量恰恰就是他要找的東西——銷了就再也拿不回來了。所以手動補收
  // 這條路要能越過接管：用戶自己知道自己丟了，這個判斷他做得了。
  it('手動補收越過首次接管，存量照樣上屏', async () => {
    stubOutboxOnce([entry('m-missed', 'uuid-missed')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { written } = await drainOutbox({ treatBacklogAsMissed: true });

    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-missed']);
    // 沒被當存量銷掉：銷帳要等落庫走完那一步（backfill 裡 written 的那條不進 ackNow）。
    expect(ack).not.toHaveBeenCalledWith(['m-missed']);
    // 手動補過一次就算接上了，後面回到自動路徑，別下次又把新條目當存量銷掉。
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeTruthy();
  });
});
