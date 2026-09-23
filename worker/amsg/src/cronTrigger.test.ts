// 暫停 / 恢復後台任務（改 Worker 自己的 cron trigger）的迴歸守衛。
//
// 釘住的幾件事：
//   1. 暫停 = 整體覆蓋成空列表，恢復 = 覆蓋成 wrangler.toml 裡那一條；兩邊都是 PUT，不是增刪單條。
//   2. 恢復時加回去的表達式必須跟 wrangler.toml 一致——worker 運行時讀不到那份配置，
//      這裡抄的一份要是漂了，「恢復」加回去的就是另一個節奏。
//   3. 沒配 CF_API_TOKEN / 共享密鑰沒過時一個 CF 請求都不發。
//   4. Cloudflare 那邊失敗要把它的報錯原樣帶出來，別只說「沒成功」。
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AMSG_CRON_EXPRESSION, handleCronTriggerRead, handleCronTriggerWrite } from './cronTrigger';

type CfCall = { method: string; path: string; body: unknown; contentType: string | null };

const ENV = {
  AMSG_SERVER_TOKEN: 'shared',
  CF_API_TOKEN: 'cf-token',
  CF_SCRIPT_NAME: 'sullyos-amsg',
  CF_ACCOUNT_ID: 'acc-1',
};

/** Cloudflare API 的完整路徑（含 /client/v4 這一段）。 */
const SCHEDULES_PATH = '/client/v4/accounts/acc-1/workers/scripts/sullyos-amsg/schedules';

const request = (method: 'GET' | 'POST', clientToken: string | null = 'shared') =>
  new Request('https://amsg.test.workers.dev/cron-trigger', {
    method,
    headers: clientToken ? { 'X-Client-Token': clientToken } : {},
  });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * 把打到 Cloudflare 的每一發記下來。schedules 的 GET 按 current 回，PUT 按 putResponse 回
 * （不給就當成功、原樣回寫）；定位 Worker 用的 settings 一律回成功。
 */
const stubCloudflare = (opts: { current?: unknown[]; putResponse?: Response } = {}) => {
  const calls: CfCall[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      contentType: new Headers(init.headers).get('content-type'),
    });
    if (path.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [] } });
    if (path === SCHEDULES_PATH && method === 'GET') {
      return Response.json({ success: true, result: { schedules: opts.current ?? [] } });
    }
    if (path === SCHEDULES_PATH && method === 'PUT') {
      return opts.putResponse ?? Response.json({ success: true, result: { schedules: JSON.parse(init.body) } });
    }
    throw new Error(`沒料到的請求：${method} ${path}`);
  }) as typeof fetch;
  return calls;
};

const schedulePuts = (calls: CfCall[]) => calls.filter((c) => c.path === SCHEDULES_PATH && c.method === 'PUT');

describe('AMSG_CRON_EXPRESSION', () => {
  it('跟 wrangler.toml 的 [triggers] crons 一致（恢復時加回去的就是這一條）', () => {
    const toml = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
    const line = toml.match(/^crons\s*=\s*\[(.*)\]/m);
    expect(line, 'wrangler.toml 裡找不到 crons = [...]').not.toBeNull();
    const crons = Array.from(line![1].matchAll(/"([^"]*)"/g), (m) => m[1]);
    expect(crons).toEqual([AMSG_CRON_EXPRESSION]);
  });
});

describe('handleCronTriggerWrite', () => {
  it('暫停 = 把 schedules 整體覆蓋成空列表', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite(ENV, request('POST'), false);
    expect(result).toEqual({ ok: true, enabled: false });
    const puts = schedulePuts(calls);
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual([]);
    expect(puts[0].contentType).toBe('application/json');
  });

  it('恢復 = 覆蓋成 wrangler.toml 裡那一條', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite(ENV, request('POST'), true);
    expect(result).toEqual({ ok: true, enabled: true });
    expect(schedulePuts(calls)[0].body).toEqual([{ cron: '* * * * *' }]);
  });

  it('Cloudflare 那邊失敗：ok:false，把它的報錯帶出來，代號 CF_ERROR', async () => {
    stubCloudflare({
      putResponse: Response.json(
        { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
        { status: 403 },
      ),
    });
    const result = await handleCronTriggerWrite(ENV, request('POST'), false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CF_ERROR');
    expect(result.message).toContain('10000: Authentication error');
  });

  it('沒配 CF_API_TOKEN：報 CF_TOKEN_MISSING，一個 CF 請求都不發', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite({ ...ENV, CF_API_TOKEN: '' }, request('POST'), false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CF_TOKEN_MISSING');
    expect(calls).toHaveLength(0);
  });

  // 這個端點能把別人的主動消息整個關掉，認證的兩道門跟 /self-update 一樣都得在。
  it('共享密鑰對不上：UNAUTHORIZED，不碰 Cloudflare', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite(ENV, request('POST', 'wrong'), false);
    expect(result).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(calls).toHaveLength(0);
  });

  it('Worker 沒設共享密鑰：SERVER_TOKEN_REQUIRED，不碰 Cloudflare', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite({ ...ENV, AMSG_SERVER_TOKEN: '' }, request('POST'), false);
    expect(result).toMatchObject({ ok: false, code: 'SERVER_TOKEN_REQUIRED' });
    expect(calls).toHaveLength(0);
  });
});

describe('handleCronTriggerRead', () => {
  it('schedules 非空 → enabled: true', async () => {
    stubCloudflare({ current: [{ cron: '* * * * *', created_on: 'x', modified_on: 'y' }] });
    expect(await handleCronTriggerRead(ENV, request('GET'))).toEqual({ supported: true, enabled: true });
  });

  it('schedules 為空 → enabled: false', async () => {
    const calls = stubCloudflare({ current: [] });
    expect(await handleCronTriggerRead(ENV, request('GET'))).toEqual({ supported: true, enabled: false });
    // 只是看一眼，不許順手改
    expect(schedulePuts(calls)).toHaveLength(0);
  });

  it('沒配 CF_API_TOKEN：supported:false + CF_TOKEN_MISSING，一個 CF 請求都不發', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerRead({ ...ENV, CF_API_TOKEN: undefined }, request('GET'));
    expect(result).toMatchObject({ supported: false, code: 'CF_TOKEN_MISSING' });
    expect(calls).toHaveLength(0);
  });

  it('共享密鑰對不上：supported:false + UNAUTHORIZED', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerRead(ENV, request('GET', null));
    expect(result).toMatchObject({ supported: false, code: 'UNAUTHORIZED' });
    expect(calls).toHaveLength(0);
  });
});
