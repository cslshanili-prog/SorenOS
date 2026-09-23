// utils/realtimeFetchCore.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performSearch } from './realtimeFetchCore';

const respond = (opts: { ok?: boolean; status?: number; body: string }) => ({
  ok: opts.ok ?? true,
  status: opts.status ?? 200,
  text: async () => opts.body,
});

const mockFetch = (value: unknown, reject = false) =>
  vi.spyOn(globalThis, 'fetch' as any).mockImplementation(
    reject ? (() => Promise.reject(value)) : (() => Promise.resolve(value)),
  );

// performSearch 的 success:false 一直是兩種情況共用的：請求沒跑通，和搜過了沒結果。
// 調用方只看 success 就分不出來，於是「服務器沒應答」被角色說成「我搜了下，沒什麼」。
// reached 是用來分這兩種的，下面每條都在釘它的取值。
describe('performSearch 的 reached：請求到底跑到沒有', () => {
  afterEach(() => vi.restoreAllMocks());

  it('搜到了 → reached', async () => {
    mockFetch(respond({
      body: JSON.stringify({ web: { results: [{ title: '標題', description: '摘要', url: 'https://x.test' }] } }),
    }));
    const r = await performSearch('貓', 'key');
    expect(r).toMatchObject({ success: true, reached: true });
    expect(r.results).toHaveLength(1);
  });

  // 這條是關鍵：真的搜過了、真的一條都沒有。角色說「我搜了下沒什麼」是實話。
  it('搜過了但零結果 → 照樣算 reached', async () => {
    mockFetch(respond({ body: JSON.stringify({ web: { results: [] } }) }));
    expect(await performSearch('貓', 'key')).toMatchObject({ success: false, reached: true });
  });

  it('斷網 → 沒 reached', async () => {
    mockFetch(new Error('network down'), true);
    expect(await performSearch('貓', 'key')).toMatchObject({ success: false, reached: false });
  });

  it('非 2xx → 沒 reached', async () => {
    mockFetch(respond({ ok: false, status: 500, body: 'boom' }));
    expect(await performSearch('貓', 'key')).toMatchObject({ success: false, reached: false });
  });

  it('回了東西但不是 JSON → 沒 reached（讀不懂就不知道搜到了什麼）', async () => {
    mockFetch(respond({ body: '<html>502 Bad Gateway</html>' }));
    expect(await performSearch('貓', 'key')).toMatchObject({ success: false, reached: false });
  });

  it('沒 key 就沒發請求 → 沒 reached', async () => {
    const fetchSpy = mockFetch(respond({ body: '{}' }));
    expect(await performSearch('貓', '')).toMatchObject({ success: false, reached: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
