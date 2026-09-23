/**
 * SullyOS MCP CORS 代理 — 部署到「你自己的」Cloudflare 帳號
 *
 * 作用：瀏覽器直連遠程 MCP 服務器時經常被 CORS 攔住（讀不到 Mcp-Session-Id
 * 響應頭，MCP 握手直接失敗）。這個 Worker 做透明轉發並補上正確的 CORS 頭。
 *
 * 部署（二選一）：
 *   A. Cloudflare Dashboard → Workers → Create → 粘貼本文件 → Deploy
 *   B. 本目錄下執行 `wrangler deploy`
 *
 * 用法：在 SullyOS 設置的 MCP 服務器「代理 URL」裡填你的 Worker 地址，
 *      例如 https://mcp-proxy.<你的子域>.workers.dev
 *      前端會以 <代理URL>?target=<MCP服務器URL> 的形式轉發請求。
 *
 * 可選加固（強烈建議，防止別人白嫖你的 Worker 流量）：
 *   在 Worker 的環境變量裡設置 PROXY_KEY=<隨機字符串>，
 *   然後在 SullyOS 設置的「代理密鑰」裡填同一個值。
 */

const FORWARD_REQUEST_HEADERS = [
    'content-type',
    'accept',
    'authorization',
    'mcp-session-id',
    'mcp-protocol-version',
    'last-event-id',
];

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Proxy-Key, X-MCP-Forward-Headers',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Access-Control-Max-Age': '86400',
};

function corsJson(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

function isPrivateIpv4(host) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127);
}

// 只允許公網 http/https 目標，禁止把 Worker 當內網探針用
function blockedTargetReason(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { return 'target 不是合法 URL'; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '只允許 http/https';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blocked = host === 'localhost'
        || host.endsWith('.localhost')
        || host.endsWith('.local')
        || host.endsWith('.internal')
        || host === '::1'
        || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
        || isPrivateIpv4(host);
    return blocked ? '不允許代理內網/本機地址' : null;
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            const headers = new Headers(CORS_HEADERS);
            const requestedHeaders = request.headers.get('access-control-request-headers');
            if (requestedHeaders) headers.set('Access-Control-Allow-Headers', requestedHeaders);
            return new Response(null, { status: 204, headers });
        }

        if (env.PROXY_KEY) {
            const key = request.headers.get('x-proxy-key') || '';
            if (key !== env.PROXY_KEY) return corsJson(403, { error: '代理密鑰錯誤（X-Proxy-Key）' });
        }

        const target = new URL(request.url).searchParams.get('target');
        if (!target) return corsJson(400, { error: '缺少 ?target=<MCP服務器URL> 參數' });
        const blocked = blockedTargetReason(target);
        if (blocked) return corsJson(400, { error: blocked });

        const fwdHeaders = new Headers();
        for (const name of FORWARD_REQUEST_HEADERS) {
            const v = request.headers.get(name);
            if (v) fwdHeaders.set(name, v);
        }
        const blockedForwardHeaders = new Set([
            'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
            'x-proxy-key', 'x-mcp-forward-headers',
        ]);
        const customHeaderNames = (request.headers.get('x-mcp-forward-headers') || '')
            .split(',').map(name => name.trim()).filter(Boolean);
        for (const name of customHeaderNames) {
            if (blockedForwardHeaders.has(name.toLowerCase())) continue;
            const value = request.headers.get(name);
            if (value) fwdHeaders.set(name, value);
        }

        let upstream;
        try {
            upstream = await fetch(target, {
                method: request.method,
                headers: fwdHeaders,
                body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
            });
        } catch (e) {
            return corsJson(502, { error: `轉發失敗: ${e.message}` });
        }

        // 透傳響應（含 SSE 流），補 CORS 頭
        const respHeaders = new Headers(CORS_HEADERS);
        for (const name of ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control']) {
            const v = upstream.headers.get(name);
            if (v) respHeaders.set(name, v);
        }
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    },
};
