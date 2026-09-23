// utils/activeMsgClient.stateClock.test.ts
//
// 迴歸守衛（雲端拒收這一輪狀態時怎麼辦）：
//   1. 設備時鐘領先過真實時間的話，雲端 client_state 那一行會帶著一個還沒到的時刻，
//      之後每次上傳都被條件寫判成「舊的」——即時對話表現為每發一句都 409，用戶把系統
//      時間調回來也沒用（那一行在雲端，本地刪消息 / 重裝 / 重填 Worker 地址都碰不到）。
//      2026-09-01 有用戶真的這麼卡住了，這裡釘住自愈：讀回雲端那行的時間戳、對齊水位、
//      重新蓋戳發第二次。
//   2. 但不能見 409 就重發：雲端確實有更新的一份時（多設備競寫）重發也是白發，得先看
//      水位有沒有真的抬動。
//   3. 常規批量同步撞上同一道閘只有一行 log，比即時對話那條還難發現，所以它也要對齊
//      水位——只是不在這一輪重傳（下一輪打髒同步帶著更新的內容蓋過去更有道理）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
    getCapabilities: vi.fn(),
    putLlmCredentials: vi.fn(),
    deleteLlmCredentials: vi.fn(),
    _encrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000043';
const globalConfig: Record<string, unknown> = {
  userId: TEST_USER_ID,
  workerUrl: 'https://amsg.example.workers.dev',
  serverToken: '',
  llmCredentialsSupported: true,
};
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({ ...globalConfig }),
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import { amsgStateNamespace } from './amsgFirePack';
import { clearInstantChatPending } from './amsgInstantChat';
import { forgetAllCredIds } from './amsgLlmCredentials';
import { readStateClockWatermark, resetStateClock } from './amsgStateClock';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR_ID = 'char-state-clock';
const CHAR = {
  id: CHAR_ID,
  name: '小滿',
  memories: [],
  activeMsg2Config: { enabled: true, tasks: [] },
} as any;
const NAMESPACE = amsgStateNamespace(CHAR_ID);

/** 雲端那一行記著的時刻：比本機的鐘晚一小時（當初設備時鐘領先時寫進去的）。 */
const FUTURE = Date.now() + 3_600_000;

/** 這一輪 POST 出去的載荷（加密前）。 */
const capturedPayloads: any[] = [];
/** 每次 POST 的返回，按順序取；用完了就一直回最後一個。 */
let postResponses: Array<{ status: number; body: unknown }> = [];
let postedPaths: string[] = [];

const respond = () => {
  const next = postResponses.length > 1 ? postResponses.shift()! : postResponses[0];
  return {
    status: next.status,
    text: async () => JSON.stringify(next.body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
};

const STATE_STALE = {
  status: 409,
  body: { success: false, error: { code: 'INSTANT_CHAT_STATE_STALE', message: '雲端拒收了這輪的最新狀態', step: 'client-state' } },
};
const ACCEPTED = { status: 202, body: { status: 'accepted', uuid: 'instant-retried' } };

beforeEach(() => {
  resetStateClock();
  capturedPayloads.length = 0;
  postedPaths = [];
  postResponses = [ACCEPTED];
  forgetAllCredIds();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  reiClient.getClientState.mockReset().mockResolvedValue({ success: true, data: { entries: [] } });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.deleteLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { deleted: 0 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.23', features: [] });
  reiClient._encrypt.mockReset().mockImplementation(async (json: string) => {
    capturedPayloads.push(JSON.parse(json));
    return { iv: 'iv', authTag: 'tag', encryptedData: 'enc' };
  });
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojis').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
  vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const target = String(url);
    postedPaths.push(target);
    // 只有即時對話那條路吃這條響應隊列。首次調用還會捎帶握手/探測那幾個請求，
    // 讓它們也去隊列裡取的話，隊首那個 409 會被別人吃掉。
    if (target.includes('instant-chat')) return respond();
    return {
      status: 200,
      text: async () => JSON.stringify({ success: true, data: {} }),
      headers: new Headers({ 'content-type': 'application/json' }),
    };
  }));
  clearInstantChatPending(CHAR_ID);
});

afterEach(() => {
  clearInstantChatPending(CHAR_ID);
  resetStateClock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 雲端 GET 回來的那一份：fire_pack 那行記著一個還沒到的時刻。 */
const remoteHasFuturePack = () => {
  reiClient.getClientState.mockResolvedValue({
    success: true,
    data: { entries: [{ namespace: NAMESPACE, key: 'fire_pack', value: 'gz1:...', updatedAt: FUTURE }] },
  });
};

const send = () => ActiveMsgClient.sendInstantChat({
  char: CHAR,
  chatMessages: [{ role: 'user', content: '在嗎' }],
  api: { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'gpt-global' },
  userProfile: { name: '小明' } as any,
  groups: [],
  realtimeConfig: {} as any,
} as any);

/** POST 出去的雲端狀態載荷（任務那份有 messageType，據此分開）。 */
const statePayloads = () => capturedPayloads.filter((p) => p && Array.isArray(p.entries));
const firePackStampOf = (payload: any) => payload.entries.find((e: any) => e.key === 'fire_pack').updatedAt;
const instantChatPosts = () => postedPaths.filter((p) => p.includes('instant-chat'));

describe('即時對話撞上「雲端拒收這輪狀態」', () => {
  it('雲端那行落在未來 → 讀回來對齊、重新蓋戳、重發一次，這一輪發得出去', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    remoteHasFuturePack();

    const result = await send();

    expect(result.uuid).toBe('instant-retried');
    expect(instantChatPosts(), '第一次被拒之後要再發一次').toHaveLength(2);
    expect(reiClient.getClientState).toHaveBeenCalledWith(NAMESPACE);

    // 重發那一份的戳必須跨過雲端那行，否則條件寫還是攔下它。
    const [first, second] = statePayloads();
    expect(firePackStampOf(first)).toBeLessThan(FUTURE);
    expect(firePackStampOf(second)).toBeGreaterThan(FUTURE);
  });

  it('重發只換戳，不重打包（value 原樣複用）', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    remoteHasFuturePack();

    await send();

    const [first, second] = statePayloads();
    expect(second.entries.map((e: any) => e.value)).toEqual(first.entries.map((e: any) => e.value));
  });

  it('雲端讀回來的都不比本地新 → 不重發，原樣報錯（重發也是白發）', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    reiClient.getClientState.mockResolvedValue({
      success: true,
      data: { entries: [{ namespace: NAMESPACE, key: 'fire_pack', value: 'gz1:...', updatedAt: 1 }] },
    });

    await expect(send()).rejects.toThrow('即時對話沒發出去');
    expect(instantChatPosts()).toHaveLength(1);
  });

  it('雲端狀態讀不回來 → 不重發也不改口，原來的失敗原樣報出去', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    reiClient.getClientState.mockRejectedValue(new Error('網絡斷了'));

    await expect(send()).rejects.toThrow('即時對話沒發出去');
    expect(instantChatPosts()).toHaveLength(1);
  });

  it('對齊過一次之後，別的上傳路徑也跟著跨過去了（水位是共用的）', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    remoteHasFuturePack();
    await send();

    reiClient.putClientState.mockClear();
    await ActiveMsgClient.syncToolConfig({} as any);

    const [entries] = reiClient.putClientState.mock.calls.at(-1)!;
    expect(entries[0].updatedAt).toBeGreaterThan(FUTURE);
  });
});

describe('常規批量同步撞上同一道閘', () => {
  const sync = () => ActiveMsgClient.syncCharFirePacks([{
    char: CHAR,
    config: { enabled: true, tasks: [] } as any,
    userProfile: { name: '小明' } as any,
    groups: [],
    realtimeConfig: {} as any,
  }]);

  it('被攔下 → 讀回雲端時間戳對齊水位（這一輪不重傳）', async () => {
    reiClient.putClientState.mockResolvedValue({
      success: true,
      data: { upserted: 1, skippedEntries: [{ namespace: NAMESPACE, key: 'fire_pack' }] },
    });
    remoteHasFuturePack();

    await sync();

    expect(reiClient.getClientState).toHaveBeenCalledWith(NAMESPACE);
    expect(reiClient.putClientState, '對齊就夠了，這一輪不重傳').toHaveBeenCalledTimes(1);
    expect(readStateClockWatermark()).toBe(FUTURE);
  });

  it('一條都沒被攔 → 不白讀一次雲端', async () => {
    await sync();

    expect(reiClient.getClientState).not.toHaveBeenCalled();
  });
});
