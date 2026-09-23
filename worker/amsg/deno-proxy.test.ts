/**
 * Deno 代理層的迴歸守衛。
 *
 * 這兩組斷言各自釘住一個「改壞了不會當場報錯、但線上會出怪事」的行為：
 *   - 響應頭清洗：留著 content-encoding 的話，瀏覽器會拿已經解壓過的 body 再解一次，
 *     報的錯跟真實原因八竿子打不著。
 *   - 請求改寫：host 沒換掉的話上游收到的是 deno.net 的 host；路徑前綴吃掉的話
 *     上游地址帶子路徑的人會 404。
 */
import { describe, expect, it, vi } from 'vitest';

// deno-proxy.ts 頂層就調 Deno.serve()，import 之前得先把 Deno 墊上，
// 否則模塊一加載就 ReferenceError。serve 墊成空實現，不真起服務。
vi.stubGlobal('Deno', {
  env: { get: (): string | undefined => undefined },
  serve: (): void => undefined,
});

const { buildUpstreamRequest, relayResponse, isConfigured, handleRequest } = await import('./deno-proxy');

describe('relayResponse - 響應頭清洗', () => {
  /** 造一個「上游回了壓縮響應」的場景：fetch 已經替我們解壓，但頭還留著壓縮前的描述。 */
  const upstreamResponse = () =>
    new Response('{"success":true}', {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': '1234',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'X-Amsg-Server-Version': '2.6.0',
      },
    });

  it('摘掉 content-encoding：留著的話瀏覽器會對已解壓的 body 再解一次壓', () => {
    expect(relayResponse(upstreamResponse()).headers.get('content-encoding')).toBeNull();
  });

  it('摘掉 content-length：解壓後長度已經對不上了', () => {
    expect(relayResponse(upstreamResponse()).headers.get('content-length')).toBeNull();
  });

  it('摘掉 transfer-encoding：逐跳頭，跨代理帶過去沒有意義', () => {
    expect(relayResponse(upstreamResponse()).headers.get('transfer-encoding')).toBeNull();
  });

  it('業務頭原樣留著 —— 別把 CORS 和版本號一起清掉了', () => {
    const relayed = relayResponse(upstreamResponse());
    expect(relayed.headers.get('access-control-allow-origin')).toBe('*');
    expect(relayed.headers.get('x-amsg-server-version')).toBe('2.6.0');
    expect(relayed.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('狀態碼和 body 原樣透傳', async () => {
    const relayed = relayResponse(
      new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    );
    expect(relayed.status).toBe(401);
    expect(await relayed.text()).toBe('nope');
  });
});

describe('buildUpstreamRequest - 請求改寫', () => {
  const incoming = (url: string, init?: RequestInit) => new Request(url, init);

  it('路徑和查詢串原樣接到上游域名後面', () => {
    const rewritten = buildUpstreamRequest(
      incoming('https://proxy.deno.net/init-tenant?foo=bar'),
      'https://amsg.example.workers.dev',
    );
    expect(rewritten.url).toBe('https://amsg.example.workers.dev/init-tenant?foo=bar');
  });

  it('上游地址帶子路徑時不能把前綴吃掉', () => {
    const rewritten = buildUpstreamRequest(
      incoming('https://proxy.deno.net/capabilities'),
      'https://example.com/amsg',
    );
    expect(rewritten.url).toBe('https://example.com/amsg/capabilities');
  });

  it('刪掉 host：不刪的話上游收到的是 deno.net 的 host', () => {
    const request = incoming('https://proxy.deno.net/config-check', {
      headers: { Host: 'proxy.deno.net' },
    });
    expect(buildUpstreamRequest(request, 'https://amsg.example.workers.dev').headers.get('host'))
      .toBeNull();
  });

  /**
   * 這條釘的是一次真實事故：瀏覽器要 zstd → 上游用 zstd 壓回來 → fetch 不解 zstd →
   * relayResponse 按「已解開」把 content-encoding 摘了 → 出口拿壓縮字節當明文又壓一層 →
   * 瀏覽器解完外層還是壓縮數據，整頁亂碼。
   *
   * curl 測不出來：它默認不要 zstd，上游就退回 gzip，而 gzip 恰好是 fetch 會自動解的。
   */
  it('刪掉 accept-encoding：透傳瀏覽器那份會讓上游用 fetch 解不開的編碼，最終雙層壓縮', () => {
    const request = incoming('https://proxy.deno.net/capabilities', {
      headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' },
    });
    expect(
      buildUpstreamRequest(request, 'https://amsg.example.workers.dev').headers.get('accept-encoding'),
    ).toBeNull();
  });

  it('鑑權頭和自定義頭必須原樣帶過去，否則 amsg 一律 401', () => {
    const request = incoming('https://proxy.deno.net/init-tenant', {
      method: 'POST',
      headers: {
        'X-Client-Token': 'shared-secret',
        'X-User-Id': 'u-1',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const rewritten = buildUpstreamRequest(request, 'https://amsg.example.workers.dev');
    expect(rewritten.headers.get('x-client-token')).toBe('shared-secret');
    expect(rewritten.headers.get('x-user-id')).toBe('u-1');
    expect(rewritten.headers.get('content-type')).toBe('application/json');
  });

  it('方法原樣保留，POST 的 body 跟著走', async () => {
    const request = incoming('https://proxy.deno.net/init-tenant', {
      method: 'POST',
      body: '{"probe":true}',
    });
    const rewritten = buildUpstreamRequest(request, 'https://amsg.example.workers.dev');
    expect(rewritten.method).toBe('POST');
    expect(await rewritten.text()).toBe('{"probe":true}');
  });

  it('GET 不能帶 body', () => {
    const rewritten = buildUpstreamRequest(
      incoming('https://proxy.deno.net/capabilities'),
      'https://amsg.example.workers.dev',
    );
    expect(rewritten.body).toBeNull();
  });
});

/**
 * 這組釘的是另一次真實事故：上游掛掉時代理回了 502，但沒帶 CORS 頭，
 * 瀏覽器於是只顯示「No 'Access-Control-Allow-Origin' header is present」——
 * 狀態碼和錯誤正文全被擋在外面，排查的人對著一個跟病因無關的 CORS 報錯乾瞪眼。
 */
describe('代理自造的響應必須帶 CORS 頭', () => {
  it('自檢端點帶 Access-Control-Allow-Origin', async () => {
    const response = await handleRequest(new Request('https://proxy.deno.net/__proxy-health'));
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('上游連不上時的 502 也帶 CORS —— 不帶的話這條錯誤在瀏覽器里根本讀不到', async () => {
    // 上游地址得先配上，否則會在 isConfigured 那關就返回 503，走不到 fetch 這一步。
    vi.stubGlobal('Deno', {
      env: { get: (name: string) => (name === 'AMSG_UPSTREAM' ? 'https://amsg.example.workers.dev' : undefined) },
      serve: (): void => undefined,
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('dns failure')));
    try {
      const response = await handleRequest(new Request('https://proxy.deno.net/capabilities'));
      expect(response.status).toBe(502);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect((await response.json() as { error: string }).error).toContain('連不上');
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('Deno', { env: { get: (): undefined => undefined }, serve: (): void => undefined });
    }
  });

  it('上游地址還是佔位符時回 503，同樣帶 CORS', async () => {
    const response = await handleRequest(new Request('https://proxy.deno.net/capabilities'));
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('isConfigured - 上游地址有沒有填', () => {
  it('佔位符沒改 → 判定為沒配，好讓自檢端點直說而不是悶頭轉發', () => {
    expect(isConfigured('https://sullyos-amsg.你的帳號.workers.dev')).toBe(false);
  });

  it('填了真實地址 → 通過', () => {
    expect(isConfigured('https://amsg.example.workers.dev')).toBe(true);
  });

  it('不是 http(s) 開頭 → 不通過', () => {
    expect(isConfigured('amsg.example.workers.dev')).toBe(false);
    expect(isConfigured('')).toBe(false);
  });
});
