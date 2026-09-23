// utils/activeMsgClient.backgroundJob.test.ts
//
// 迴歸守衛（後台任務這條路怎麼排上去）。兩條都是本地端到端跑出來的坑：
//
//   1. 到期時間必須交給服務端蓋（immediate: true），客戶端絕不能自己算一個 firstSendTime。
//      算了的話，那個時刻在「上傳輸入 → 傳憑據 → 加密 → 發請求」這一路上早就過去了，
//      上游一律打回「時間必須在未來」——雲端這條路每次都失敗、每次都退回本地跑，
//      而用戶那邊只看得到門牌照常更新，完全不知道它從來沒在雲端跑過。
//
//   2. 採樣溫度與輸出上限要原樣帶上去。上游對缺省的這兩個字段是整個省略，
//      落到供應商默認值（溫度常為 1.0，輸出上限遠小於四塊門牌全量輸出需要的量）——
//      同一批材料在本地和在雲端會整理出不一樣的門牌，而這種漂移界面上看不出來。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
    getCapabilities: vi.fn(),
    putLlmCredentials: vi.fn(),
    _encrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000077';
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

import { ActiveMsgClient, forgetBackgroundJobProbe } from './activeMsgClient';
import { forgetAllCredIds } from './amsgLlmCredentials';

const capturedPayloads: any[] = [];

beforeEach(() => {
  capturedPayloads.length = 0;
  globalConfig.llmCredentialsSupported = true;
  forgetAllCredIds();
  forgetBackgroundJobProbe();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.22', features: [] });
  reiClient._encrypt.mockReset().mockImplementation(async (json: string) => {
    capturedPayloads.push(JSON.parse(json));
    return { iv: 'iv', authTag: 'tag', encryptedData: 'enc' };
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 201,
    text: async () => JSON.stringify({ success: true, data: { uuid: 'job-remote-uuid' } }),
    headers: new Headers({ 'content-type': 'application/json' }),
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CRED_ROW = {
  credId: 'char:c-bg/memory',
  value: { apiUrl: 'https://light.example.dev/v1/chat/completions', apiKey: 'sk-light', primaryModel: 'cheap' },
};

const schedule = (extra: Record<string, unknown> = {}) => ActiveMsgClient.scheduleBackgroundJob({
  kind: 'plate-consolidate',
  charId: 'c-bg',
  charName: '小滿',
  jobKey: 'plate:job-1',
  jobId: 'job-1',
  jobInput: { v: 1, hello: 'world' },
  credRow: CRED_ROW,
  ...extra,
} as any);

/** POST 出去的那份任務載荷（雲端狀態那份沒有 messageType，據此認出來）。 */
const scheduledTask = () => capturedPayloads.filter((p) => p && 'messageType' in p).at(-1);

describe('後台任務的到期時間', () => {
  it('用 immediate: true，不自己算 firstSendTime', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.immediate).toBe(true);
    expect(task, '客戶端算出來的時刻發到服務端已是過去時，上游會打回「時間必須在未來」')
      .not.toHaveProperty('firstSendTime');
  });

  it('一次性任務、帶得上 kind 與 job 編號，且用 job 這個 subtype（不進用戶的任務清單）', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.recurrenceType).toBe('none');
    expect(task.messageSubtype).toBe('job');
    expect(task.metadata.amsgKind).toBe('plate-consolidate');
    expect(task.metadata.amsgJobId).toBe('job-1');
    expect(task.credRefs).toEqual({ chat: CRED_ROW.credId });
  });
});

// 迴歸守衛：探測把「問不到」和「問到了、答案是不行」混成同一個 false，還按 workerUrl
// 緩存了一整個會話。一次代理切換、一次 CF 邊緣抖動、一次 D1 冷啟動超時，就能把整個會話
// 釘死在本地整理，而且沒有任何日誌區分這兩件事——只有刷新頁面才翻得回來。
describe('後台任務能力探測的緩存', () => {
  const configCheck = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => ({
    status,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  })));
  const fetchCalls = () => (globalThis.fetch as any).mock.calls.length;

  it('拿到明確答覆才記緩存（支持 → 第二次不再發請求）', async () => {
    configCheck({ success: true, data: { backgroundJobs: true } });

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(true);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(true);
    expect(fetchCalls()).toBe(1);
  });

  it('明確說了不支持也記緩存（老 bundle 不會自己變新）', async () => {
    configCheck({ success: true, data: {} });

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls()).toBe(1);
  });

  // 迴歸守衛：forgetBackgroundJobProbe 只蓋得住「在設置頁點按鈕更新 Worker」這一條路，
  // 而換 bundle 不止這一條——文檔裡那條 GitHub「Sync fork」→ Cloudflare Workers Builds
  // 更新完，地址沒變、整個過程也不經過前端。把「不支持」釘死一整個會話的話，這段時間
  // 每一輪消化都在前台跑那一兩分鐘的整理，頁面一關就死，只有刷新頁面才翻得回來。
  it('存量是「不支持」時隔一陣會再問一遍', async () => {
    configCheck({ success: true, data: {} });
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls(), '同一輪裡連著提交幾個 job 不該重複問').toBe(1);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    configCheck({ success: true, data: { backgroundJobs: true } });

    expect(
      await ActiveMsgClient.probeBackgroundJobSupport(),
      'worker 已經換成新 bundle 了，前端還認著換之前那句「不支持」',
    ).toBe(true);
  });

  it('問不到（5xx）→ 這輪當不支持，但不記緩存，下輪重新問', async () => {
    configCheck({ success: false }, 503);

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls(), '緩存住的話這個會話之後每一輪消化都退回本地跑').toBe(2);
  });

  it('請求壓根沒發出去（網絡掛了）同樣不記緩存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls()).toBe(2);
  });

  // 迴歸守衛：探測原先把「問不到」和「問到了、答案是不行」壓成同一個 false。門牌那道閘
  // 要靠它區分「這條路斷了」和「這次沒問到」——混著的話，一次代理切換、一次 CF 邊緣抖動
  // 就能在任務還在雲端跑著的時候把這一輪踢回本地，同一份快照燒兩次副 API，兩份結果先後
  // 落地互相蓋（見 plateCloudGate）。
  it.each([
    ['問到了、認識後台任務', { success: true, data: { backgroundJobs: true } }, 200, 'supported'],
    ['問到了、是老 bundle', { success: true, data: {} }, 200, 'unsupported'],
    ['問不到（5xx）', { success: false }, 503, 'unknown'],
  ])('%s → %s', async (_name, body, status, expected) => {
    configCheck(body, status as number);

    expect(await ActiveMsgClient.probeBackgroundJobSupportDetailed()).toBe(expected);
  });

  it('請求沒發出去也是「問不到」，不是「不支持」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));

    expect(await ActiveMsgClient.probeBackgroundJobSupportDetailed()).toBe('unknown');
  });

  // 迴歸守衛：作廢那個函數的說明寫著「部署/更新 worker 的路徑上調一次」，實際只有設置頁的
  // 「重新連接並驗證」調了它。用戶點完「更新 Worker」（同一個地址換了 bundle），前端還認著
  // 升級前那句「不支持」——接下來這幾分鐘每一輪消化都在前台跑那一兩分鐘的整理，頁面一關就死。
  it('點過「更新 Worker」之後探測結論當場作廢', async () => {
    let upgraded = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const isSelfUpdate = String(url).includes('self-update');
      if (isSelfUpdate) upgraded = true;
      const body = isSelfUpdate
        ? { success: true, data: { message: '已經更新到最新版本。' } }
        : { success: true, data: upgraded ? { backgroundJobs: true } : {} };
      return {
        status: 200,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
      };
    }));

    expect(await ActiveMsgClient.probeBackgroundJobSupport(), '升級前是老 bundle').toBe(false);
    await ActiveMsgClient.selfUpdateWorker();

    expect(await ActiveMsgClient.probeBackgroundJobSupport(), '不作廢就得等用戶刷新頁面').toBe(true);
  });
});

describe('後台任務的採樣參數', () => {
  it('傳了就原樣帶上去', async () => {
    await schedule({ temperature: 0.3, maxTokens: 8000 });

    const task = scheduledTask();
    expect(task.temperature).toBe(0.3);
    expect(task.maxTokens).toBe(8000);
  });

  it('沒傳就一個字段都不寫（讓上游按它自己的規矩來，別憑空塞默認值）', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task).not.toHaveProperty('temperature');
    expect(task).not.toHaveProperty('maxTokens');
  });
});
