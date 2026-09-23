#!/usr/bin/env node
/**
 * MCP CORS Proxy (with SPA Pre-warm for reply_comment)
 *
 * xiaohongshu-mcp 服務器缺少 Access-Control-Expose-Headers: Mcp-Session-Id，
 * 導致瀏覽器讀不到 session ID，MCP 協議無法正常工作。
 *
 * 這個代理轉發所有請求到 MCP 服務器，並添加正確的 CORS 頭。
 *
 * 額外功能: reply_comment SPA 預熱
 * 小紅書是 SPA，直接打開帖子 URL 時路由初始化不完整，評論區 DOM 不渲染。
 * 代理檢測到 reply_comment 調用時，先發一個 check_login 讓 MCP 瀏覽器訪問
 * 小紅書（預熱 SPA），然後再轉發原始請求。這樣 reply_comment 導航到帖子時
 * SPA JS 已緩存，評論區更可能正常渲染。
 *
 * 用法:
 *   node scripts/mcp-proxy.mjs                           # 默認: 代理 18061 → MCP 18060
 *   node scripts/mcp-proxy.mjs --port 19000              # 自定義代理端口
 *   node scripts/mcp-proxy.mjs --target http://localhost:9090  # 自定義 MCP 地址
 *   node scripts/mcp-proxy.mjs --no-prewarm              # 禁用 SPA 預熱
 *
 * 然後在應用設置裡把 MCP URL 改為: http://localhost:18061/mcp
 *
 * 通用 MCP 模式（配合設置裡的「代理 URL」）:
 *   請求帶 ?target=<url-encoded MCP URL> 時，轉發到該地址而不是 --target，
 *   與 worker/mcp-proxy 的 Cloudflare Worker 採用同一套約定。
 *   例: http://localhost:18061/?target=https%3A%2F%2Fmcp.example.com%2Fmcp
 */

import { createServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const PROXY_PORT = parseInt(getArg('--port', '18061'), 10);
const TARGET = getArg('--target', 'http://localhost:18060');
const PREWARM_ENABLED = !args.includes('--no-prewarm');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Authorization, MCP-Protocol-Version, Last-Event-ID, X-MCP-Forward-Headers',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
};

// ==================== SPA Pre-warm 邏輯 ====================

let requestIdCounter = 100000; // 給預熱請求用的高位 id，避免和前端衝突
let lastPrewarmTime = 0;
const PREWARM_COOLDOWN = 30_000; // 30 秒冷卻期，避免頻繁預熱

/**
 * 向 MCP 服務器發送一個 JSON-RPC 請求，返回完整響應文本
 */
function mcpCall(sessionId, jsonRpcBody) {
    return new Promise((resolve, reject) => {
        const targetUrl = new URL('/mcp', TARGET);
        const bodyStr = JSON.stringify(jsonRpcBody);
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;

        const req = httpRequest(
            {
                hostname: targetUrl.hostname,
                port: targetUrl.port,
                path: targetUrl.pathname,
                method: 'POST',
                headers,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString()));
                res.on('error', reject);
            },
        );
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

/**
 * 預熱: 調用 check_login 讓 MCP 瀏覽器訪問小紅書站點
 * check_login 會導航到小紅書檢查登錄狀態，從而初始化 SPA
 */
async function prewarmSPA(sessionId) {
    const now = Date.now();
    if (now - lastPrewarmTime < PREWARM_COOLDOWN) {
        console.log(`[proxy] SPA 預熱跳過（${Math.round((PREWARM_COOLDOWN - (now - lastPrewarmTime)) / 1000)}秒冷卻中）`);
        return;
    }

    console.log('[proxy] 🔥 SPA 預熱: 發送 check_login 讓瀏覽器訪問小紅書...');
    try {
        const resp = await mcpCall(sessionId, {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: 'check_login',
                arguments: {},
            },
            id: ++requestIdCounter,
        });
        lastPrewarmTime = Date.now();
        console.log(`[proxy] 🔥 SPA 預熱完成（${Date.now() - now}ms），響應: ${resp.slice(0, 100)}`);
    } catch (e) {
        console.warn(`[proxy] SPA 預熱失敗（不影響後續請求）: ${e.message}`);
    }
}

/**
 * 檢測是否是 reply_comment 相關的 tools/call 請求
 */
function isReplyCommentCall(parsed) {
    if (parsed?.method !== 'tools/call') return false;
    const toolName = (parsed.params?.name || '').toLowerCase().replace(/[_-]/g, '');
    return toolName.includes('replycomment');
}

// ==================== Proxy Server ====================

createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        // 自定義 MCP 鑑權頭的名字由用戶配置，預檢時原樣允許瀏覽器請求的頭名。
        const requestedHeaders = req.headers['access-control-request-headers'];
        res.writeHead(204, {
            ...CORS_HEADERS,
            ...(requestedHeaders ? { 'Access-Control-Allow-Headers': requestedHeaders } : {}),
        });
        res.end();
        return;
    }

    // Collect body
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        const body = Buffer.concat(chunks);

        // 通用模式: ?target=<絕對URL> 優先於 --target（與 worker/mcp-proxy 約定一致）
        const incomingUrl = new URL(req.url, TARGET);
        const targetOverride = incomingUrl.searchParams.get('target');
        let targetUrl;
        if (targetOverride) {
            try {
                targetUrl = new URL(targetOverride);
            } catch {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
                res.end('Invalid ?target= URL');
                return;
            }
        } else {
            targetUrl = incomingUrl;
        }

        // 固定協議頭 + 前端明確聲明的自定義 MCP 頭。控制頭和代理密鑰不透傳上游。
        const fwdHeaders = {};
        if (req.headers['content-type']) fwdHeaders['Content-Type'] = req.headers['content-type'];
        if (req.headers['accept']) fwdHeaders['Accept'] = req.headers['accept'];
        if (req.headers['mcp-session-id']) fwdHeaders['Mcp-Session-Id'] = req.headers['mcp-session-id'];
        if (req.headers['authorization']) fwdHeaders['Authorization'] = req.headers['authorization'];
        if (req.headers['mcp-protocol-version']) fwdHeaders['MCP-Protocol-Version'] = req.headers['mcp-protocol-version'];
        const blockedForwardHeaders = new Set([
            'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
            'x-proxy-key', 'x-mcp-forward-headers',
        ]);
        const customHeaderNames = String(req.headers['x-mcp-forward-headers'] || '')
            .split(',').map(name => name.trim()).filter(Boolean);
        for (const name of customHeaderNames) {
            const lower = name.toLowerCase();
            if (blockedForwardHeaders.has(lower)) continue;
            const value = req.headers[lower];
            if (value !== undefined) fwdHeaders[name] = value;
        }

        // 檢測是否需要 SPA 預熱
        if (PREWARM_ENABLED && body.length > 0) {
            try {
                const parsed = JSON.parse(body.toString());
                if (isReplyCommentCall(parsed)) {
                    console.log('[proxy] 🔍 檢測到 reply_comment 調用，觸發 SPA 預熱...');
                    await prewarmSPA(req.headers['mcp-session-id']);
                }
            } catch {
                // JSON 解析失敗，正常轉發
            }
        }

        // Forward to MCP server（https 目標走 https 模塊）
        const requestFn = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
        const proxyReq = requestFn(
            {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                method: req.method,
                headers: fwdHeaders,
            },
            (proxyRes) => {
                // Build response headers: CORS + forwarded
                const respHeaders = { ...CORS_HEADERS };
                const ct = proxyRes.headers['content-type'];
                if (ct) respHeaders['Content-Type'] = ct;
                const sid = proxyRes.headers['mcp-session-id'];
                if (sid) respHeaders['Mcp-Session-Id'] = sid;

                res.writeHead(proxyRes.statusCode || 200, respHeaders);
                proxyRes.pipe(res);
            },
        );

        proxyReq.on('error', (e) => {
            console.error(`[proxy] Error forwarding to ${TARGET}: ${e.message}`);
            res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
            res.end(`Proxy error: ${e.message}`);
        });

        if (body.length > 0) proxyReq.write(body);
        proxyReq.end();
    });
}).listen(PROXY_PORT, () => {
    console.log(`MCP CORS Proxy started`);
    console.log(`  Proxy:  http://localhost:${PROXY_PORT}/mcp`);
    console.log(`  Target: ${TARGET}/mcp`);
    console.log(`  SPA Pre-warm: ${PREWARM_ENABLED ? 'ENABLED' : 'disabled'}`);
    console.log(`\nSet your MCP URL to: http://localhost:${PROXY_PORT}/mcp`);
});
