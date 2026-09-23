import { describe, it, expect } from 'vitest';
import {
  buildDurableObjectPlan,
  resolveObservability,
  handleSelfUpdate,
  rebuildBindings,
  resolveScriptName,
} from './selfUpdate';

describe('buildDurableObjectPlan', () => {
  const doBinding = {
    type: 'durable_object_namespace',
    name: 'INSTANT_TICK',
    class_name: 'InstantTickDO',
  };

  it('老 Worker 上沒有起跳器 → 補 binding，同時帶 migrations 把它建出來', () => {
    const plan = buildDurableObjectPlan([
      { type: 'd1', name: 'DB', id: 'x' },
      { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
    ]);
    expect(plan.binding).toEqual(doBinding);
    expect(plan.migrations).toEqual({
      new_tag: 'amsg-instant-tick-v1',
      new_sqlite_classes: ['InstantTickDO'],
    });
  });

  /**
   * 迴歸守衛：建過之後絕不能再帶 migrations。
   *
   * Cloudflare 的 migrations 帶樂觀鎖——不給 old_tag 等於斷言「這個 Worker 一個
   * migration 都沒應用過」。自更新是會被反覆點的，第二次帶同一個 tag 會撞上
   * `10079 Actor migration tag precondition failed`，**整個自更新失敗**，用戶的
   * Worker 從此更新不動。2026-08-09 直接打 Cloudflare API 實測確認過這個行為。
   */
  it('已經有起跳器 → binding 和 migrations 都不動（重傳 migrations 會 10079）', () => {
    const plan = buildDurableObjectPlan([{ type: 'd1', name: 'DB', id: 'x' }, doBinding]);
    expect(plan.binding).toBeNull();
    expect(plan.migrations).toBeNull();
  });

  it('認的是 binding 名而不只是類型（別的 DO 不算數）', () => {
    const plan = buildDurableObjectPlan([
      { type: 'durable_object_namespace', name: 'SOMETHING_ELSE', class_name: 'OtherDO' },
    ]);
    expect(plan.binding).toEqual(doBinding);
  });
});

describe('rebuildBindings', () => {
  // Cloudflare 的上傳接口是整體替換：這一發沒帶的 binding 等於刪掉。
  // 而讀回來的密鑰只有名字沒有值，所以必須從 env 補——補漏了就是把用戶的密鑰抹了。
  it('把密鑰的值從運行時補回去', () => {
    const result = rebuildBindings(
      [
        { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
        { type: 'secret_text', name: 'VAPID_PRIVATE_KEY' },
      ],
      { AMSG_MASTER_KEY: 'mk', VAPID_PRIVATE_KEY: 'pk' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings).toEqual([
      { type: 'secret_text', name: 'AMSG_MASTER_KEY', text: 'mk' },
      { type: 'secret_text', name: 'VAPID_PRIVATE_KEY', text: 'pk' },
    ]);
  });

  it('非密鑰的 binding 原樣搬過去', () => {
    const d1 = { type: 'd1', name: 'DB', id: 'db-uuid' };
    const plain = { type: 'plain_text', name: 'SOME_VAR', text: 'v' };
    const result = rebuildBindings([d1, plain], {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // D1 的 id 必須原樣帶回，否則新版本會丟掉數據庫綁定
    expect(result.bindings).toEqual([d1, plain]);
  });

  it('補不到值時整體中止，不能悄悄少傳一條', () => {
    const result = rebuildBindings(
      [
        { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
        { type: 'secret_text', name: 'VAPID_PRIVATE_KEY' },
      ],
      { AMSG_MASTER_KEY: 'mk' }, // VAPID_PRIVATE_KEY 讀不到
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['VAPID_PRIVATE_KEY']);
  });

  it('值是空字符串也算讀不到——傳上去等於把密鑰清空', () => {
    const result = rebuildBindings([{ type: 'secret_text', name: 'AMSG_SERVER_TOKEN' }], {
      AMSG_SERVER_TOKEN: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['AMSG_SERVER_TOKEN']);
  });
});

describe('resolveScriptName', () => {
  it('從 workers.dev 域名反推 worker 名', () => {
    expect(resolveScriptName({}, 'https://sullyos-amsg.someone.workers.dev/self-update')).toBe(
      'sullyos-amsg',
    );
  });

  it('配了 CF_SCRIPT_NAME 就以它為準', () => {
    expect(
      resolveScriptName({ CF_SCRIPT_NAME: '  my-worker  ' }, 'https://other.workers.dev/self-update'),
    ).toBe('my-worker');
  });

  // 國內會在 workers.dev 外面套一層 Deno 門面。那時請求進來掛的是代理域名，
  // 照著反推會得出一個不存在的 worker 名，然後去更新「別的東西」。寧可認不出來。
  it('不是 workers.dev 域名就認不出來，交給 CF_SCRIPT_NAME', () => {
    expect(resolveScriptName({}, 'https://my-proxy.deno.net/self-update')).toBeNull();
    expect(resolveScriptName({}, 'https://amsg.example.com/self-update')).toBeNull();
  });
});

describe('resolveObservability', () => {
  // 上傳是整體覆蓋：metadata 裡不帶 observability，之前開著的實時日誌就沒了
  // （實測確認：開成 enabled:true 之後不帶這個字段重傳一次，再讀回來就沒有）。
  it('讀回來是什麼就帶上什麼', () => {
    const current = { enabled: true, logs: { enabled: true, invocation_logs: false } };
    expect(resolveObservability(current)).toEqual(current);
  });

  it('用戶明確關掉的也照樣尊重，不強行開', () => {
    expect(resolveObservability({ enabled: false })).toEqual({ enabled: false });
  });

  it('讀不到就按開啟兜底——倉庫裡的 wrangler.toml 聲明的就是開', () => {
    const fallback = { enabled: true, logs: { enabled: true } };
    expect(resolveObservability(undefined)).toEqual(fallback);
    expect(resolveObservability(null)).toEqual(fallback);
  });
});

describe('handleSelfUpdate 上傳時帶的 metadata', () => {
  const FAKE_BUNDLE = `// src_default as default\n${'x'.repeat(200 * 1024)}`;

  /** 把這次自更新打到 Cloudflare 的每一發都記下來。 */
  const runSelfUpdate = async (observability?: unknown) => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes('raw.githubusercontent.com')) return new Response(FAKE_BUNDLE);
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';
      let body: unknown = null;
      if (init.body instanceof FormData) {
        const part = init.body.get('settings') ?? init.body.get('metadata');
        body = part instanceof Blob ? JSON.parse(await part.text()) : null;
      }
      calls.push({ method, path, body });
      if (method === 'GET' && path.endsWith('/settings')) {
        return Response.json({
          success: true,
          result: {
            bindings: [{ type: 'secret_text', name: 'AMSG_MASTER_KEY' }],
            compatibility_date: '2026-01-01',
            observability,
          },
        });
      }
      return Response.json({ success: true, result: {} });
    }) as typeof fetch;

    try {
      const result = await handleSelfUpdate(
        new Request('https://amsg.test.workers.dev/self-update', {
          method: 'POST',
          headers: { 'X-Client-Token': 'shared' },
        }),
        {
          AMSG_SERVER_TOKEN: 'shared',
          CF_API_TOKEN: 'cf-token',
          CF_SCRIPT_NAME: 'sullyos-amsg',
          CF_ACCOUNT_ID: 'acc-1',
          AMSG_MASTER_KEY: 'mk',
        } as any,
      );
      return { result, calls };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const uploadMetadata = (calls: Array<{ method: string; body: any }>) =>
    calls.find((c) => c.method === 'PUT')?.body;

  it('上傳時帶上實時日誌開關，否則每更新一次就把它打回默認關', async () => {
    const observability = { enabled: true, logs: { enabled: true } };
    const { result, calls } = await runSelfUpdate(observability);

    expect(result.ok).toBe(true);
    expect(uploadMetadata(calls)?.observability).toEqual(observability);
  });

  it('原本沒設過的，上傳時按開啟兜底', async () => {
    const { calls } = await runSelfUpdate(undefined);

    expect(uploadMetadata(calls)?.observability).toEqual({ enabled: true, logs: { enabled: true } });
  });

  it('用戶明確關掉的，更新不會替他打開', async () => {
    const { calls } = await runSelfUpdate({ enabled: false });

    expect(uploadMetadata(calls)?.observability).toEqual({ enabled: false });
  });
});
