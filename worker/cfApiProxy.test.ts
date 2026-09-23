/**
 * 中心 worker 的 /cf-api 中轉（worker/index.js）。
 *
 * 這條路存在的唯一理由是 api.cloudflare.com 不返回 CORS 頭，瀏覽器發不出請求。
 * 轉發的又是一枚能改用戶整個帳號 Workers 的 token，所以下面幾條護欄一旦鬆掉，
 * 這個端點就從「amsg 一鍵部署的中轉」變成「公開的 CF API 中繼」。用測試釘住：
 *   - 目標 host 只能是 api.cloudflare.com，路徑只能落在帳號級資源裡
 *   - 拒絕的請求一次上游都不能發
 *   - 日誌裡不許出現 token
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error 中心 worker 是純 JS 單文件，倉庫沒開 allowJs
import worker from './index.js';

const TOKEN = 'Bearer cf-token-must-not-leak';

/** 裝一個假的上游 fetch，返回它收到的調用記錄。 */
const stubUpstream = (status = 200, body = '{"success":true}') => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fake);
    return calls;
};

const callProxy = (
    path: string,
    { method = 'POST', cfMethod = 'GET', auth = TOKEN, headers = {}, body = undefined as BodyInit | undefined } = {}
) => {
    const h: Record<string, string> = { ...headers };
    if (auth) h['Authorization'] = auth;
    if (cfMethod) h['X-CF-Method'] = cfMethod;
    const url = `https://proxy.test/cf-api?path=${encodeURIComponent(path)}`;
    return worker.fetch(new Request(url, { method, headers: h, body }), {}, { waitUntil: () => {} });
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('/cf-api 路徑白名單', () => {
    it('帳號級路徑放行，並打到 api.cloudflare.com', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts?per_page=50');

        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts?per_page=50');
        expect(calls[0].init.method).toBe('GET');
        expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe(TOKEN);
    });

    it('/zones/* 拒掉，且一次上游都不發', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/zones/abc123/dns_records', { cfMethod: 'POST' });

        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0);
    });

    it('絕對地址不能把目標帶走', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts/../../https://evil.example/steal');

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('路徑裡的 .. 直接 400', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts/../zones/abc');

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('不以 / 開頭的路徑直接 400', async () => {
        const calls = stubUpstream();
        const res = await callProxy('accounts');

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });
});

describe('/cf-api 請求約束', () => {
    it('沒有 Authorization 就不往上游發', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts', { auth: '' });

        expect(res.status).toBe(401);
        expect(calls).toHaveLength(0);
    });

    it('真正的轉發只收 POST，其餘方法 405', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts', { method: 'PUT', cfMethod: 'GET' });

        expect(res.status).toBe(405);
        expect(calls).toHaveLength(0);
    });

    it('GET 是探針：不帶憑據也回 200，且不碰上游', async () => {
        const calls = stubUpstream();
        const res = await worker.fetch(
            new Request('https://proxy.test/cf-api', { method: 'GET' }),
            {},
            { waitUntil: () => {} }
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, relay: 'cf-api' });
        expect(calls).toHaveLength(0);
    });

    it('X-CF-Method 不在名單裡就 400', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts', { cfMethod: 'TRACE' });

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('multipart 上傳時 Content-Type 原樣轉發（boundary 不能丟）', async () => {
        const calls = stubUpstream();
        const contentType = 'multipart/form-data; boundary=----SullyOSBoundary123';
        const res = await callProxy('/accounts/acc123/workers/scripts/sullyos-amsg', {
            cfMethod: 'PUT',
            headers: { 'Content-Type': contentType },
            body: 'payload-bytes',
        });

        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].init.method).toBe('PUT');
        expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(contentType);
        expect(new TextDecoder().decode(calls[0].init.body as ArrayBuffer)).toBe('payload-bytes');
    });

    it('上游狀態碼原樣透傳，前端能分辨 token 無效和權限不夠', async () => {
        stubUpstream(403, '{"success":false,"errors":[{"code":9109}]}');
        const res = await callProxy('/accounts');

        expect(res.status).toBe(403);
        expect(await res.text()).toContain('9109');
    });
});

describe('/cf-api 日誌', () => {
    it('日誌裡不出現 token 和 query（帳號 id 會留在路徑裡，可接受）', async () => {
        stubUpstream();
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await callProxy('/accounts?per_page=50');

        const logged = spy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(logged).toContain('cf-api');
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain('cf-token-must-not-leak');
        expect(logged).not.toContain('per_page');
    });
});
