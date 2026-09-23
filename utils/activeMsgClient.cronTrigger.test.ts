// utils/activeMsgClient.cronTrigger.test.ts
//
// 「暫停 / 恢復後台任務」前端這一側的迴歸守衛（worker 那一側見 worker/amsg/src/cronTrigger.test.ts）。
//
// 最要緊的一條：舊版 Worker 沒有 /cron-trigger 這個端點，問狀態回 404 時必須回 null 而不是拋——
// 設置頁每次打開都會問一次，拋出去等於讓所有還沒更新 Worker 的人每次開面板都看到一條報錯。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: { init: vi.fn(), getCapabilities: vi.fn(), _encrypt: vi.fn() },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000088';
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({
      userId: TEST_USER_ID,
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: 'shared',
    }),
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ActiveMsgClient } from './activeMsgClient';

/** 讓 worker 回一份固定的 JSON。 */
const workerReplies = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({
  status,
  text: async () => JSON.stringify(body),
  headers: new Headers({ 'content-type': 'application/json' }),
})));

/** 最近一次打到 worker 的請求。 */
const lastRequest = () => {
  const calls = (globalThis.fetch as any).mock.calls as Array<[string, RequestInit]>;
  const [url, init] = calls[calls.length - 1];
  return { url: String(url), init, headers: new Headers(init.headers) };
};

beforeEach(() => {
  reiClient.init.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getCronTriggerState', () => {
  it('舊版 Worker 回 404 → null，不拋', async () => {
    workerReplies(404, null);
    await expect(ActiveMsgClient.getCronTriggerState()).resolves.toBeNull();
  });

  it('上游把它當未知路由回 NOT_FOUND → 同樣是 null', async () => {
    workerReplies(200, { success: false, error: { code: 'NOT_FOUND', message: 'no route' } });
    await expect(ActiveMsgClient.getCronTriggerState()).resolves.toBeNull();
  });

  it('連不上 Worker → null，不拋（設置頁每次打開都會問，拋出去就是每次一條報錯）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    await expect(ActiveMsgClient.getCronTriggerState()).resolves.toBeNull();
  });

  it('讀到了：把 supported / enabled 原樣帶回，請求走 GET /cron-trigger 並帶共享密鑰', async () => {
    workerReplies(200, { success: true, data: { supported: true, enabled: false } });
    expect(await ActiveMsgClient.getCronTriggerState()).toEqual({ supported: true, enabled: false });
    const { url, init, headers } = lastRequest();
    expect(url).toBe('https://amsg.example.workers.dev/cron-trigger');
    expect(init.method).toBe('GET');
    expect(headers.get('X-Client-Token')).toBe('shared');
  });

  it('端點在、但 Worker 沒配 CF_API_TOKEN：supported:false 帶代號，面板據此引導補鑰匙', async () => {
    workerReplies(200, {
      success: true,
      data: { supported: false, code: 'CF_TOKEN_MISSING', message: '沒配 CF_API_TOKEN。' },
    });
    expect(await ActiveMsgClient.getCronTriggerState()).toEqual({
      supported: false,
      code: 'CF_TOKEN_MISSING',
      message: '沒配 CF_API_TOKEN。',
    });
  });

  it('共享密鑰對不上（401）：supported:false，代號從 error 裡取', async () => {
    workerReplies(401, { success: false, error: { code: 'UNAUTHORIZED', message: '共享密鑰對不上。' } });
    expect(await ActiveMsgClient.getCronTriggerState()).toEqual({
      supported: false,
      code: 'UNAUTHORIZED',
      message: '共享密鑰對不上。',
    });
  });
});

describe('setCronTriggerEnabled', () => {
  it('暫停：POST /cron-trigger，JSON 體 { enabled: false }', async () => {
    workerReplies(200, { success: true, data: { ok: true, enabled: false } });
    const result = await ActiveMsgClient.setCronTriggerEnabled(false);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('已暫停');
    const { url, init, headers } = lastRequest();
    expect(url).toBe('https://amsg.example.workers.dev/cron-trigger');
    expect(init.method).toBe('POST');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('恢復：JSON 體 { enabled: true }', async () => {
    workerReplies(200, { success: true, data: { ok: true, enabled: true } });
    const result = await ActiveMsgClient.setCronTriggerEnabled(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('已恢復');
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({ enabled: true });
  });

  it('worker 報失敗：ok:false，把它那句話和代號帶回來', async () => {
    workerReplies(400, {
      success: false,
      error: { code: 'CF_TOKEN_MISSING', message: '沒配 CF_API_TOKEN，沒法改定時觸發。' },
    });
    expect(await ActiveMsgClient.setCronTriggerEnabled(false)).toEqual({
      ok: false,
      code: 'CF_TOKEN_MISSING',
      message: '沒配 CF_API_TOKEN，沒法改定時觸發。',
    });
  });

  it('舊版 Worker 回 404 → ok:false 說要先更新，不拋', async () => {
    workerReplies(404, null);
    const result = await ActiveMsgClient.setCronTriggerEnabled(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('更新 Worker');
  });
});
