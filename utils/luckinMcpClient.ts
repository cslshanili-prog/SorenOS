/**
 * 瑞幸 MCP 客戶端 (Model Context Protocol over HTTP+SSE, streamable http)
 *
 * 上游: https://gwmcp.lkcoffee.com/order/user/mcp  (官方瑞幸點單 MCP server)
 * 平台: https://open.lkcoffee.com  (瑞幸 AI 開放平台)
 * Token: 登錄 open.lkcoffee.com 後複製, 每個用戶獨立, 有效期約 1 個月, 存 localStorage
 *
 * 瀏覽器無法直連 lkcoffee.com (CORS), 走中心配置的 Cloudflare Worker 透傳 (默認
 * https://sullymeow.ccwu.cc, 用戶可在「設置 → 自定義網絡代理」裡改):
 *   POST  <worker>/mcp/luckin
 *   Authorization: Bearer <user_mcp_token>
 *   body: 標準 JSON-RPC 2.0 報文
 *
 * 傳輸層與麥當勞 (utils/mcdMcpClient.ts) 完全同構: 同一套 initialize → tools/list →
 * tools/call + Mcp-Session-Id 會話管理。差異只在 URL / localStorage key, 以及參數
 * 歸一化這裡做得更"通用"(不寫死瑞幸獨有的字段校驗, 等跑通 tools/list 看到真實
 * schema 後再按需收緊)。
 */

import { getProxyWorkerUrl } from './proxyWorker';

// 走中心配置的主代理 worker（用戶可在設置裡換成自部署實例）
const mcpProxyUrl = (): string => `${getProxyWorkerUrl()}/mcp/luckin`;
const MCP_TOKEN_KEY = 'aetheros.luckin.mcpToken';
const MCP_ENABLED_KEY = 'aetheros.luckin.mcpEnabled';

export interface LuckinToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface LuckinToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

export const normalizeLuckinToolName = (toolName: string): string => {
    const raw = (toolName || '').trim();
    if (!raw) return raw;
    let s = raw;
    // 模型常給工具名加"命名空間前綴"幻覺:
    //   luckin.query-menu / functions.create-order / luckin_tools_query-stores
    // 真實瑞幸 MCP 工具名都是純 kebab-case, 不含點號, 遇到點直接取最後一段。
    const lastDot = s.lastIndexOf('.');
    if (lastDot >= 0 && lastDot < s.length - 1) {
        s = s.slice(lastDot + 1);
    }
    s = s
        .replace(/^luckin[_-]?tools?[_-]/i, '')
        .replace(/^lk[_-]?coffee[_-]/i, '')
        .replace(/^coffee[_-]?tools?[_-]/i, '')
        .trim();
    return s || raw;
};

interface McpJsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: any;
    id?: number;
}

interface McpJsonRpcResponse {
    jsonrpc: '2.0';
    id?: number;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

// ========== Token / 啟用狀態 (持久化在 localStorage) ==========

export const getLuckinToken = (): string => {
    try { return localStorage.getItem(MCP_TOKEN_KEY) || ''; } catch { return ''; }
};

export const setLuckinToken = (token: string): void => {
    try { localStorage.setItem(MCP_TOKEN_KEY, token.trim()); } catch { /* ignore */ }
};

export const isLuckinEnabled = (): boolean => {
    try { return localStorage.getItem(MCP_ENABLED_KEY) === '1'; } catch { return false; }
};

export const setLuckinEnabled = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_ENABLED_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

export const isLuckinConfigured = (): boolean => {
    return isLuckinEnabled() && getLuckinToken().length > 0;
};

// ── 備份用：把瑞幸的 token + 啟用狀態隨「設置 → 導出/導入備份」一起帶走（存 localStorage） ──
export function exportLuckinLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const tk = localStorage.getItem(MCP_TOKEN_KEY); if (tk) out[MCP_TOKEN_KEY] = tk;
        const en = localStorage.getItem(MCP_ENABLED_KEY); if (en) out[MCP_ENABLED_KEY] = en;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importLuckinLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[MCP_TOKEN_KEY] === 'string') localStorage.setItem(MCP_TOKEN_KEY, data[MCP_TOKEN_KEY]);
        if (typeof data[MCP_ENABLED_KEY] === 'string') localStorage.setItem(MCP_ENABLED_KEY, data[MCP_ENABLED_KEY]);
    } catch { /* ignore */ }
}

// ========== JSON-RPC 會話狀態 (內存, 進程級) ==========

let requestIdCounter = 0;
let sessionId: string | null = null;
let initialized = false;
let cachedTools: LuckinToolDef[] = [];
let initPromise: Promise<void> | null = null;

const buildRequest = (method: string, params?: any, isNotification = false): McpJsonRpcRequest => {
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params };
    if (!isNotification) req.id = ++requestIdCounter;
    return req;
};

const parseSse = (text: string): McpJsonRpcResponse | null => {
    const dataLines: string[] = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
    }
    for (let i = dataLines.length - 1; i >= 0; i--) {
        try { return JSON.parse(dataLines[i]); } catch { /* try previous */ }
    }
    return null;
};

const parseResp = (text: string, contentType: string): McpJsonRpcResponse => {
    if (contentType.includes('text/event-stream') || /^\s*(event:|data:)/.test(text)) {
        const parsed = parseSse(text);
        if (parsed) return parsed;
    }
    try { return JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        throw new Error(`MCP: 無法解析響應: ${text.slice(0, 300)}`);
    }
};

const post = async (
    body: McpJsonRpcRequest,
    expectResponse = true
): Promise<{ response: McpJsonRpcResponse | null }> => {
    const token = getLuckinToken();
    if (!token) throw new Error('未配置瑞幸 MCP Token，請到設置 → 瑞幸填入');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${token}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const resp = await fetch(mcpProxyUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
    if (newSid) sessionId = newSid;

    if (resp.status === 401 || resp.status === 403) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP 鑑權失敗 (${resp.status}): Token 可能已過期或無效 (瑞幸 token 有效期約 1 個月)。${txt.slice(0, 120)}`);
    }
    if (resp.status === 202) return { response: null };
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    if (!expectResponse) return { response: null };

    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    return { response: parseResp(text, ct) };
};

const doInitialize = async (): Promise<void> => {
    const initReq = buildRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'AetherOS-Aetheros', version: '1.0.0' },
    });
    const { response } = await post(initReq);
    if (response?.error) throw new Error(`Initialize 失敗: ${response.error.message}`);

    // 通知 server 初始化完成 (協議要求)
    const notif = buildRequest('notifications/initialized', {}, true);
    await post(notif, false).catch(() => { /* notification 失敗不阻塞 */ });

    // 拉取工具清單
    try {
        const { response: toolsResp } = await post(buildRequest('tools/list'));
        if (toolsResp?.result?.tools && Array.isArray(toolsResp.result.tools)) {
            cachedTools = toolsResp.result.tools.map((t: any) => ({
                name: t.name,
                description: t.description || '',
                inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
            }));
            console.log('[Luckin-MCP] 工具清單:', cachedTools.map(t => t.name).join(', '));
        }
    } catch (e) {
        console.warn('[Luckin-MCP] tools/list 失敗:', e);
    }

    initialized = true;
};

const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    if (!initPromise) {
        initPromise = doInitialize().catch((e) => {
            initPromise = null;
            throw e;
        });
    }
    await initPromise;
};

// ========== 公開 API ==========

/** 拉取工具清單 (會觸發首次 initialize, 之後內存緩存) */
export const listLuckinTools = async (forceRefresh = false): Promise<LuckinToolDef[]> => {
    if (forceRefresh) {
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
    }
    await ensureInitialized();
    return cachedTools;
};

/**
 * 通用參數歸一化 (不寫死瑞幸專有字段, 只修模型最常犯的形態錯):
 *  - 任意名為 quantity / qty / count / num 的字段, 字符串數字 → 整數
 *  - items / products / goods / cartItems 數組裡每項同樣處理 quantity, 並補 productCode 同義字段
 * 等跑通 tools/list 拿到真實 schema 後, 可以在這裡按瑞幸實際字段名收緊校驗。
 */
const QTY_KEYS = ['quantity', 'qty', 'count', 'num', 'number', 'amount'];
const ITEM_LIST_KEYS = ['productList', 'items', 'products', 'goods', 'cartItems', 'skuList', 'goodsList', 'list'];
const CODE_ALIASES = ['code', 'skuCode', 'goodsCode', 'productId', 'skuId', 'goodsId', 'spuId'];

const coerceQty = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of QTY_KEYS) {
        const v = obj[k];
        if (typeof v === 'string' && /^\d+$/.test(v.trim())) obj[k] = parseInt(v.trim(), 10);
    }
};

const normalizeLuckinArgs = (args: Record<string, any>): Record<string, any> => {
    if (!args || typeof args !== 'object') return args;
    const out = { ...args };
    coerceQty(out);
    for (const listKey of ITEM_LIST_KEYS) {
        if (Array.isArray(out[listKey])) {
            out[listKey] = out[listKey].map((it: any) => {
                if (!it || typeof it !== 'object') return it;
                const ni = { ...it };
                coerceQty(ni);
                // 同義字段 → productCode (模型偶爾用錯字段名), 只在沒有 productCode 時補
                if (!ni.productCode) {
                    for (const alias of CODE_ALIASES) {
                        if (ni[alias]) { ni.productCode = ni[alias]; break; }
                    }
                }
                return ni;
            });
        }
    }
    return out;
};

/** 調用一個工具 */
export const callLuckinTool = async (toolName: string, args: Record<string, any> = {}): Promise<LuckinToolResult> => {
    try {
        const normalizedToolName = normalizeLuckinToolName(toolName);
        args = normalizeLuckinArgs(args);

        await ensureInitialized();
        const body = buildRequest('tools/call', { name: normalizedToolName, arguments: args });
        const { response } = await post(body);
        if (!response) return { success: false, error: '空響應' };
        if (response.error) return { success: false, error: `MCP 錯誤 [${response.error.code}]: ${response.error.message}` };

        const result = response.result;
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return { success: false, error: fullText || '瑞幸工具執行失敗', rawText: fullText };

            // 在混合文本(markdown 說明 + JSON)裡挖出 JSON。
            // 這類網關 MCP 習慣在響應前塞一段渲染規範說明, 然後才接真數據。
            // 數據裡有時有未轉義的真換行符 / 製表符, JSON.parse 會失敗 → 加一道修復嘗試。
            const repairJson = (s: string): string => {
                let inStr = false, esc = false, out = '';
                for (let i = 0; i < s.length; i++) {
                    const ch = s[i];
                    if (esc) { out += ch; esc = false; continue; }
                    if (ch === '\\') { out += ch; esc = true; continue; }
                    if (ch === '"') { inStr = !inStr; out += ch; continue; }
                    if (inStr && ch === '\n') { out += '\\n'; continue; }
                    if (inStr && ch === '\r') { out += '\\r'; continue; }
                    if (inStr && ch === '\t') { out += '\\t'; continue; }
                    out += ch;
                }
                return out;
            };
            const safeParse = (s: string): any => {
                try { return JSON.parse(s); } catch { /* try repair */ }
                try { return JSON.parse(repairJson(s)); } catch { return undefined; }
            };
            const tryExtractJsonFromMixed = (text: string): any => {
                if (!text) return undefined;
                // 1) 整段直接是 JSON
                const direct = safeParse(text);
                if (direct !== undefined) return direct;
                // 2) ```json 圍欄
                const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
                if (fenceMatch) {
                    const fenced = safeParse(fenceMatch[1].trim());
                    if (fenced !== undefined) return fenced;
                }
                // 3) 掃描所有 { 和 [ 起點, 用括號配平找完整結構, 選擇"最像真數據"的那個
                const candidates: any[] = [];
                const tryBalanced = (start: number, open: string, close: string) => {
                    let depth = 0, inStr = false, esc = false;
                    for (let i = start; i < text.length; i++) {
                        const ch = text[i];
                        if (esc) { esc = false; continue; }
                        if (ch === '\\') { esc = true; continue; }
                        if (ch === '"') { inStr = !inStr; continue; }
                        if (inStr) continue;
                        if (ch === open) depth++;
                        else if (ch === close) {
                            depth--;
                            if (depth === 0) {
                                const slice = text.slice(start, i + 1);
                                const parsed = safeParse(slice);
                                if (parsed && typeof parsed === 'object') {
                                    candidates.push({ parsed, len: slice.length });
                                }
                                return;
                            }
                        }
                    }
                };
                for (let i = 0; i < text.length; i++) {
                    if (text[i] === '{') tryBalanced(i, '{', '}');
                    else if (text[i] === '[') tryBalanced(i, '[', ']');
                }
                if (candidates.length) {
                    const scoreCandidate = (obj: any, len: number): number => {
                        let score = Math.min(len, 4000) / 4000;
                        if (!obj || typeof obj !== 'object') return score;
                        if (Array.isArray(obj)) return score + (obj.length > 0 ? 2 : 0);
                        const envKeys = ['success', 'code', 'message', 'msg', 'datetime', 'traceId', 'data'];
                        const envHits = envKeys.filter(k => k in obj).length;
                        if (envHits >= 3) score += 2;
                        const data = (obj as any).data;
                        if (Array.isArray(data)) score += data.length > 0 ? 8 : -2;
                        else if (data && typeof data === 'object') score += Object.keys(data).length > 0 ? 8 : -2;
                        else if (typeof data === 'string') {
                            const s = data.trim();
                            if (s && s !== '{}' && s !== '[]' && s.toLowerCase() !== 'null') score += 3;
                        } else if (data == null) {
                            score -= 3;
                        }
                        if ('properties' in obj || '$schema' in obj || 'required' in obj) score -= 3;
                        return score;
                    };
                    candidates.sort((a, b) => scoreCandidate(b.parsed, b.len) - scoreCandidate(a.parsed, a.len));
                    return candidates[0].parsed;
                }
                return undefined;
            };
            // 遞歸剝信封: 上游有時把數據再次 stringify 裝進 {data: "..."} 外殼
            const tryDeepParse = (v: any): any => {
                if (typeof v === 'string') {
                    const s = v.trim();
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try { return tryDeepParse(JSON.parse(s)); } catch { return v; }
                    }
                    return v;
                }
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    // 標準網關信封: {success, code, message/msg, data: {...}} → 自動剝到 data
                    const envelopeKeys = ['success', 'code', 'message', 'msg', 'datetime', 'traceId', 'errorCode', 'errMsg'];
                    if ('data' in v && envelopeKeys.some(k => k in v)) {
                        const inner = v.data;
                        if (inner && typeof inner === 'object') return tryDeepParse(inner);
                        if (typeof inner === 'string') {
                            const s = inner.trim();
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { return tryDeepParse(JSON.parse(s)); } catch { /* fall through */ }
                            }
                            return s;
                        }
                        return inner;
                    }
                    // 單字段殼: {data: "..."} / {result: "..."} 等
                    const keys = Object.keys(v);
                    const wrapKeys = ['data', 'result', 'response', 'body', 'payload'];
                    if (keys.length === 1 && wrapKeys.includes(keys[0]) && typeof v[keys[0]] === 'string') {
                        const inner = tryDeepParse(v[keys[0]]);
                        if (inner && typeof inner === 'object') return inner;
                    }
                    // 否則對每個 string 字段嘗試解 (一層即可)
                    const out: any = {};
                    for (const k of keys) {
                        const cv = v[k];
                        if (typeof cv === 'string') {
                            const s = cv.trim();
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { out[k] = JSON.parse(s); continue; } catch { /* ignore */ }
                            }
                        }
                        out[k] = cv;
                    }
                    return out;
                }
                return v;
            };
            let parsed: any = undefined;
            let parseRoute = 'none';
            try {
                parsed = JSON.parse(fullText);
                parseRoute = 'direct';
            } catch {
                parsed = tryExtractJsonFromMixed(fullText);
                if (parsed !== undefined) parseRoute = 'extracted';
            }
            if (parsed !== undefined) {
                const finalData = tryDeepParse(parsed);
                try {
                    const topKeys = finalData && typeof finalData === 'object' && !Array.isArray(finalData)
                        ? Object.keys(finalData).slice(0, 10).join(',')
                        : (Array.isArray(finalData) ? `[Array len=${finalData.length}]` : typeof finalData);
                    console.log(`☕ [Luckin-MCP] 工具結果 ${parseRoute} | rawLen=${fullText.length} | topKeys=${topKeys}`);
                } catch { /* ignore log errors */ }
                return { success: true, data: finalData, rawText: fullText };
            }
            console.warn(`☕ [Luckin-MCP] 工具結果 parse 全失敗, rawLen=${fullText.length}, 前 200 字: ${fullText.slice(0, 200)}`);
            return { success: true, data: fullText, rawText: fullText };
        }
        return { success: true, data: result };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
};

/** 測試連接: 僅驗證 token 是否能成功 initialize + 拿到 tools */
export const testLuckinConnection = async (): Promise<{ ok: boolean; message: string; tools?: LuckinToolDef[] }> => {
    try {
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
        const tools = await listLuckinTools(false);
        if (!tools.length) return { ok: true, message: '已連接, 但工具清單為空 (可能服務側未掛載工具)', tools };
        return { ok: true, message: `已連接, 拿到 ${tools.length} 個工具`, tools };
    } catch (e: any) {
        return { ok: false, message: e?.message || String(e) };
    }
};

/** 強制重置會話 (token 改變 / 退出登錄時調用) */
export const resetLuckinSession = (): void => {
    initialized = false;
    sessionId = null;
    cachedTools = [];
    initPromise = null;
};
