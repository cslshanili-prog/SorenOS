// utils/activeMsgClient.credRefs.test.ts
//
// 迴歸守衛（任務怎麼帶憑據）：
//   1. 達標的 worker 上，任務只帶引用、一個內聯憑據字段都不寫——上游對「引用與內聯同傳」
//      是直接 400，寫多一個字段就是整條排程發不出去。
//   2. 不達標的 worker 上原樣走內聯老路，且一個憑據請求都不發。主動消息 2.0 對所有人開放，
//      舊 worker 是真實存在的運行時狀態，這條回落不能退化。
//   3. 雲端說「引用的憑據不存在」時當場補傳再重試一次（換過 master key / 點過清空雲端數據
//      之後，本地那本指紋底帳是髒的，不自愈的話用戶會一直排不成任務）。
//   4. 即時對話：情緒評估的副 API 憑據改走引用之後，任務 metadata 裡只剩提示詞模板。
//   5. 即時對話絕不單掛 emotion 引用——上游 scheduleTask 見到任何 credRefs 就不再複製內聯
//      三件套，只掛 emotion 的話，角色在這一輪裡自排的任務會繼承一份沒有聊天憑據的空殼。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
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

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000042';
/** 能力位在測裡現改：達標 / 不達標兩條路都要跑到。 */
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
import { forgetAllCredIds } from './amsgLlmCredentials';
import { clearInstantChatPending } from './amsgInstantChat';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR_ID = 'char-credrefs';
const CHAR = {
  id: CHAR_ID,
  name: '小滿',
  memories: [],
  activeMsg2Config: { enabled: true, tasks: [] },
} as any;
const API = { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'gpt-global' } as any;

/** 這一輪 POST 出去的那份任務載荷（加密前）。 */
const capturedPayloads: any[] = [];
/** 每次 POST 的返回，按順序取；用完了就一直回最後一個。 */
let scheduleResponses: Array<{ status: number; body: unknown }> = [];
let postedPaths: string[] = [];

const respond = () => {
  const next = scheduleResponses.length > 1 ? scheduleResponses.shift()! : scheduleResponses[0];
  return {
    status: next.status,
    text: async () => JSON.stringify(next.body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
};

beforeEach(() => {
  capturedPayloads.length = 0;
  postedPaths = [];
  scheduleResponses = [{ status: 200, body: { success: true, data: { uuid: 'remote-uuid', status: 'pending' } } }];
  globalConfig.llmCredentialsSupported = true;
  forgetAllCredIds();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.deleteLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { deleted: 3 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.17', features: [] });
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
    postedPaths.push(String(url));
    return respond();
  }));
  clearInstantChatPending(CHAR_ID);
});

afterEach(() => {
  clearInstantChatPending(CHAR_ID);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 排程 POST 出去的那份任務載荷（雲端狀態那份沒有 messageType，據此認出來）。 */
const scheduledTask = () => capturedPayloads.filter((p) => p && 'messageType' in p).at(-1);
/** 傳上去的憑據行（扁平化所有批次）。 */
const putRows = () => reiClient.putLlmCredentials.mock.calls.flatMap(([rows]: any[]) => rows);

const schedule = (config: any = { enabled: true, tasks: [] }) => ActiveMsgClient.scheduleCharacterTask({
  char: CHAR,
  config,
  task: { mode: 'auto', firstSendTime: new Date(Date.now() + 3600_000).toISOString(), recurrenceType: 'none' },
  userProfile: { name: '小明' } as any,
  groups: [],
  realtimeConfig: {} as any,
  apiConfig: API,
});

describe('排程任務的憑據', () => {
  it('達標的 worker：任務只帶 credRefs，內聯三件套一個字段都不寫', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.credRefs).toEqual({ chat: `char:${CHAR_ID}/chat` });
    expect(task, '引用與內聯同傳上游直接 400').not.toHaveProperty('apiUrl');
    expect(task).not.toHaveProperty('apiKey');
    expect(task).not.toHaveProperty('primaryModel');
  });

  it('憑據行在建任務之前就登記好（上游建任務前會挨個查引用）', async () => {
    await schedule();

    expect(putRows()).toEqual([{
      credId: `char:${CHAR_ID}/chat`,
      value: {
        apiUrl: 'https://api.example.dev/v1/chat/completions',
        apiKey: 'sk-global',
        primaryModel: 'gpt-global',
      },
    }]);
    expect(reiClient.putLlmCredentials.mock.invocationCallOrder[0])
      .toBeLessThan((globalThis.fetch as any).mock.invocationCallOrder.at(-1));
  });

  it('角色開了單獨 API → 那行寫的是單獨 API 的值', async () => {
    await schedule({
      enabled: true,
      tasks: [],
      useSecondaryApi: true,
      secondaryApi: { baseUrl: 'https://alt.example.dev/v1', apiKey: 'sk-alt', model: 'gpt-alt' },
    });

    expect(putRows()[0].value).toEqual({
      apiUrl: 'https://alt.example.dev/v1/chat/completions', apiKey: 'sk-alt', primaryModel: 'gpt-alt',
    });
  });

  it('值沒變 → 第二次排程一個憑據請求都不發', async () => {
    await schedule();
    reiClient.putLlmCredentials.mockClear();
    await schedule();
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  it('不達標的 worker：原樣內聯，不帶 credRefs，也不發憑據請求', async () => {
    globalConfig.llmCredentialsSupported = false;

    await schedule();

    const task = scheduledTask();
    expect(task.apiUrl).toBe('https://api.example.dev/v1/chat/completions');
    expect(task.apiKey).toBe('sk-global');
    expect(task.primaryModel).toBe('gpt-global');
    expect(task).not.toHaveProperty('credRefs');
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  it('固定消息（不走 LLM）永遠不帶憑據引用', async () => {
    await ActiveMsgClient.scheduleCharacterTask({
      char: CHAR,
      config: { enabled: true, tasks: [] } as any,
      task: {
        mode: 'fixed',
        firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
        recurrenceType: 'none',
        userMessage: '晚安',
      },
      userProfile: { name: '小明' } as any,
      groups: [],
      realtimeConfig: {} as any,
      apiConfig: API,
    });

    expect(scheduledTask()).not.toHaveProperty('credRefs');
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  it('雲端說這行憑據不存在 → 強傳一次再重排一次，用戶看不到失敗', async () => {
    // 先排一次讓本地底帳記上「傳過了」，再把雲端那行「弄丟」。
    await schedule();
    reiClient.putLlmCredentials.mockClear();
    postedPaths = [];
    scheduleResponses = [
      { status: 409, body: { success: false, error: { code: 'CREDENTIAL_NOT_FOUND', message: '憑據不存在' } } },
      { status: 200, body: { success: true, data: { uuid: 'retried-uuid', status: 'pending' } } },
    ];

    const result = await schedule();

    expect(result.uuid).toBe('retried-uuid');
    // 底帳說「沒變過」，所以這一次必須是繞過指紋的強傳，否則重排還是同一個 409。
    expect(putRows()).toHaveLength(1);
    expect(postedPaths.filter((p) => p.includes('schedule-message'))).toHaveLength(2);
  });

  it('補傳之後還是不認 → 拋錯交給用戶，不無限重試', async () => {
    scheduleResponses = [
      { status: 409, body: { success: false, error: { code: 'CREDENTIAL_NOT_FOUND', message: '憑據不存在' } } },
    ];

    await expect(schedule()).rejects.toThrow('憑據不存在');
    expect(postedPaths.filter((p) => p.includes('schedule-message'))).toHaveLength(2);
  });
});

describe('即時對話的憑據與情緒評估', () => {
  const EVAL_SPEC = {
    prompt: '模板 __EMOTION_EVAL_SYSTEM_PROMPT__ __EMOTION_EVAL_HISTORY__',
    api: { baseUrl: 'https://eval.example.dev/v1', apiKey: 'sk-eval', model: 'eval-mini' },
  };

  const send = (extra: Record<string, unknown> = {}) => {
    scheduleResponses = [{ status: 202, body: { status: 'accepted', uuid: 'instant-uuid' } }];
    return ActiveMsgClient.sendInstantChat({
      char: CHAR,
      chatMessages: [{ role: 'user', content: '在嗎' }],
      api: { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'claude-sonnet-4-thinking' },
      userProfile: { name: '小明' } as any,
      groups: [],
      realtimeConfig: {} as any,
      ...extra,
    } as any);
  };

  it('達標的 worker：聊天與情緒兩個引用一起帶，評估配置裡只剩提示詞模板', async () => {
    await send({ emotionEval: EVAL_SPEC });

    const task = scheduledTask();
    expect(task.credRefs).toEqual({
      chat: `char:${CHAR_ID}/instant`,
      emotion: `char:${CHAR_ID}/emotion`,
    });
    expect(task).not.toHaveProperty('apiKey');
    expect(task.metadata.amsgEmotionEval, '副 API 的 apiKey 不該再進任務 metadata')
      .toEqual({ prompt: EVAL_SPEC.prompt });
  });

  it('即時對話那行存的是當輪終值（-thinking 後綴不能被抹平）', async () => {
    await send({ emotionEval: EVAL_SPEC });

    const instantRow = putRows().find((row: any) => row.credId === `char:${CHAR_ID}/instant`);
    expect(instantRow.value.primaryModel).toBe('claude-sonnet-4-thinking');
    const emotionRow = putRows().find((row: any) => row.credId === `char:${CHAR_ID}/emotion`);
    expect(emotionRow.value).toEqual({
      apiUrl: 'https://eval.example.dev/v1/chat/completions', apiKey: 'sk-eval', primaryModel: 'eval-mini',
    });
  });

  it('這一輪不評估 → 只帶聊天那個引用（絕不出現單掛 emotion 的空殼）', async () => {
    await send();

    expect(scheduledTask().credRefs).toEqual({ chat: `char:${CHAR_ID}/instant` });
    expect(putRows().map((row: any) => row.credId)).toEqual([`char:${CHAR_ID}/instant`]);
  });

  it('不達標的 worker：內聯三件套 + 評估配置照舊帶憑據', async () => {
    globalConfig.llmCredentialsSupported = false;

    await send({ emotionEval: EVAL_SPEC });

    const task = scheduledTask();
    expect(task).not.toHaveProperty('credRefs');
    expect(task.apiKey).toBe('sk-global');
    expect(task.metadata.amsgEmotionEval).toEqual(EVAL_SPEC);
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  it('包裝層回「引用的憑據不存在」→ 補傳後重發一次', async () => {
    await send();
    reiClient.putLlmCredentials.mockClear();
    postedPaths = [];
    scheduleResponses = [
      {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'INSTANT_CHAT_TASK_FAILED',
            upstream: { success: false, error: { code: 'CREDENTIAL_NOT_FOUND', message: '憑據不存在' } },
          },
        },
      },
      { status: 202, body: { status: 'accepted', uuid: 'instant-retried' } },
    ];

    const result = await ActiveMsgClient.sendInstantChat({
      char: CHAR,
      chatMessages: [{ role: 'user', content: '在嗎' }],
      api: { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'claude-sonnet-4-thinking' },
      userProfile: { name: '小明' } as any,
      groups: [],
      realtimeConfig: {} as any,
    } as any);

    expect(result.uuid).toBe('instant-retried');
    expect(reiClient.putLlmCredentials).toHaveBeenCalledTimes(1);
    expect(postedPaths.filter((p) => p.includes('instant-chat'))).toHaveLength(2);
  });
});

describe('能力探測', () => {
  it('features 有 llm-credentials → 存 true；沒有 → 存 false', async () => {
    reiClient.getCapabilities.mockResolvedValue({ serverVersion: '2.6.0-next.17', features: ['llm-credentials'] });
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(true);

    reiClient.getCapabilities.mockResolvedValue({ serverVersion: '2.6.0-next.16', features: ['client-state'] });
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(false);
  });

  it('老 worker 沒有這個端點（null）/ 探測拋錯 → 一律 false', async () => {
    reiClient.getCapabilities.mockResolvedValue(null);
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(false);

    reiClient.getCapabilities.mockRejectedValue(new Error('offline'));
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(false);
  });
});

describe('刪憑據行', () => {
  it('刪角色時按名字刪那三行，並把本地底帳一起劃掉', async () => {
    await schedule();
    await ActiveMsgClient.deleteLlmCredentials({ credIds: [`char:${CHAR_ID}/chat`] });

    expect(reiClient.deleteLlmCredentials).toHaveBeenCalledWith({ credIds: [`char:${CHAR_ID}/chat`] });
    // 底帳劃掉了 → 下次排程會重新傳一遍（不然那行永遠補不回來）。
    reiClient.putLlmCredentials.mockClear();
    await schedule();
    expect(reiClient.putLlmCredentials).toHaveBeenCalledTimes(1);
  });
});
