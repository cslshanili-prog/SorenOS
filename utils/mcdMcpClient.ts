/**
 * 麥當勞 MCP 客戶端 (Model Context Protocol over HTTP+SSE)
 *
 * 上游: https://mcp.mcd.cn  (官方麥當勞中國 MCP server)
 * 文檔: https://open.mcd.cn/mcp/doc
 * Token: https://open.mcd.cn/mcp 申請, 每個用戶獨立, 存 localStorage
 *
 * 瀏覽器無法直連 mcd.cn (CORS), 走中心配置的 Cloudflare Worker 透傳 (默認
 * https://sullymeow.ccwu.cc, 用戶可在「設置 → 自定義網絡代理」裡改):
 *   POST  <worker>/mcp/mcd
 *   Authorization: Bearer <user_mcp_token>
 *   body: 標準 JSON-RPC 2.0 報文
 */

import { getProxyWorkerUrl } from './proxyWorker';
import { equalsAnyScript } from './scriptKey';

// 走中心配置的主代理 worker（用戶可在設置裡換成自部署實例）
const mcpProxyUrl = (): string => `${getProxyWorkerUrl()}/mcp/mcd`;
const MCP_TOKEN_KEY = 'aetheros.mcd.mcpToken';
const MCP_ENABLED_KEY = 'aetheros.mcd.mcpEnabled';

export interface McdToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface McdToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

export const normalizeMcdToolName = (toolName: string): string => {
    const raw = (toolName || '').trim();
    if (!raw) return raw;
    let s = raw;
    // 模型經常給工具名加"命名空間前綴"幻覺:
    //   mcd_goodies.query-meal-detail  (像 OpenAI Realtime / Cursor 風格)
    //   mcd.calculate-price
    //   functions.query-meals
    // 真實麥當勞 MCP 工具名都是純 kebab-case, 不含點號, 所以遇到點直接取最後一段。
    const lastDot = s.lastIndexOf('.');
    if (lastDot >= 0 && lastDot < s.length - 1) {
        s = s.slice(lastDot + 1);
    }
    // 舊規則: 剝 mcd_tools_ / mcd_tool_ / mcd-tools- 這種下劃線 / 短橫線前綴
    s = s
        .replace(/^mcd[_-]?tools?[_-]/i, '')
        .replace(/^mcd[_-]?goodies[_-]/i, '') // 同義前綴, 兼容點號被換成下劃線的情況
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

export const getMcdToken = (): string => {
    try { return localStorage.getItem(MCP_TOKEN_KEY) || ''; } catch { return ''; }
};

export const setMcdToken = (token: string): void => {
    try { localStorage.setItem(MCP_TOKEN_KEY, token.trim()); } catch { /* ignore */ }
};

export const isMcdEnabled = (): boolean => {
    try { return localStorage.getItem(MCP_ENABLED_KEY) === '1'; } catch { return false; }
};

export const setMcdEnabled = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_ENABLED_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

export const isMcdConfigured = (): boolean => {
    return isMcdEnabled() && getMcdToken().length > 0;
};

// ── 備份用：把麥當勞的 token + 啟用狀態隨「設置 → 導出/導入備份」一起帶走（存 localStorage） ──
export function exportMcdLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const tk = localStorage.getItem(MCP_TOKEN_KEY); if (tk) out[MCP_TOKEN_KEY] = tk;
        const en = localStorage.getItem(MCP_ENABLED_KEY); if (en) out[MCP_ENABLED_KEY] = en;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importMcdLocal(data: Record<string, string> | null | undefined): void {
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
let cachedTools: McdToolDef[] = [];
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
    const token = getMcdToken();
    if (!token) throw new Error('未配置麥當勞 MCP Token，請到設置 → 麥當勞填入');

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
        throw new Error(`MCP 鑑權失敗 (${resp.status}): Token 可能已過期或無效。${txt.slice(0, 120)}`);
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
            console.log('[MCD-MCP] 工具清單:', cachedTools.map(t => t.name).join(', '));
        }
    } catch (e) {
        console.warn('[MCD-MCP] tools/list 失敗:', e);
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
export const listMcdTools = async (forceRefresh = false): Promise<McdToolDef[]> => {
    if (forceRefresh) {
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
    }
    await ensureInitialized();
    return cachedTools;
};

const hasAnyCodeArg = (args: Record<string, any>, keys: string[]): boolean => {
    return keys.some((k) => {
        const v = args?.[k];
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'string') return v.trim().length > 0;
        return false;
    });
};

/**
 * 修復模型常犯的參數形態錯誤:
 *  - orderType 應該是整數 1 (到店) / 2 (外送), 模型經常給字符串 "1" / "delivery" / "DINE_IN"
 *  - items[].quantity 應該是整數, 模型經常給字符串 "1"
 *  - 到店 (orderType=1) 時 beCode 必須為 null/不傳, 模型會順手帶上空串
 * 在客戶端做一次溫和的歸一化, 避免上游 API 因為 1 vs "1" 類型不匹配返回空信封。
 */
const normalizeMcdArgs = (toolName: string, args: Record<string, any>): Record<string, any> => {
    if (!/calculate[-_]?price|create[-_]?order|submit[-_]?order/i.test(toolName)) return args;
    const out = { ...args };
    if (out.orderType != null) {
        const t = out.orderType;
        if (typeof t === 'string') {
            const s = t.trim().toLowerCase();
            if (s === '1' || s === 'pickup' || s === 'dine-in' || s === 'dine_in' || s === 'carryout' || s === 'in-store') out.orderType = 1;
            else if (s === '2' || s === 'delivery' || equalsAnyScript(s, '麦乐送') || s === '外送') out.orderType = 2;
            else if (/^\d+$/.test(s)) out.orderType = parseInt(s, 10);
        }
    }
    if (Array.isArray(out.items)) {
        out.items = out.items.map((it: any) => {
            if (!it || typeof it !== 'object') return it;
            const ni = { ...it };
            if (ni.quantity != null && typeof ni.quantity === 'string' && /^\d+$/.test(ni.quantity.trim())) {
                ni.quantity = parseInt(ni.quantity.trim(), 10);
            }
            // 同義字段: code / sku → productCode (模型偶爾會用錯字段名)
            if (!ni.productCode) {
                if (ni.code) ni.productCode = ni.code;
                else if (ni.skuCode) ni.productCode = ni.skuCode;
                else if (ni.mealCode) ni.productCode = ni.mealCode;
            }
            return ni;
        });
    }
    // 到店模式時 beCode 必須為 null/不傳, 否則上游會按外送匹配走錯路徑
    if (out.orderType === 1 && out.beCode === '') delete out.beCode;
    return out;
};

/** 調用一個工具 */
export const callMcdTool = async (toolName: string, args: Record<string, any> = {}): Promise<McdToolResult> => {
    try {
        const normalizedToolName = normalizeMcdToolName(toolName);
        // 某些工具是“按 code 查詳情”，空參幾乎必定返回“成功但無數據”的空信封，容易誤導模型和用戶。
        // 在客戶端前置兜底成明確錯誤，引導先走 query/list 拿 code 再查詳情。
        // 注意工具名: 上游官方文檔列表裡只有 `query-meal-detail` 和 `mall-product-detail`,
        //            沒有泛 `product-detail`; 而 mall-product-detail 用 spuId, 不是 productCodes,
        //            所以這裡精確匹配, 不要再用寬泛的 /product[-_]?detail/。
        // query-meal-detail 入參是單數 string `code`, 不是數組。
        // list-nutrition-foods 按官方文檔無需入參 (返回全量), 不要再攔它。
        const codeLookupRules: Array<{ pattern: RegExp; argKeys: string[]; hint: string }> = [
            { pattern: /^query[-_]?meal[-_]?detail$/i, argKeys: ['code', 'productCode', 'mealCode'], hint: 'code (單個餐品編碼 string)' },
        ];
        const hit = codeLookupRules.find((r) => r.pattern.test(normalizedToolName));
        if (hit && !hasAnyCodeArg(args, hit.argKeys)) {
            return {
                success: false,
                error: `工具 ${normalizedToolName} 需要先提供餐品 code（參數: ${hit.hint}）。請先調用 query-meals 拿到 code 後再查。`,
            };
        }

        // calculate-price / create-order 的參數前置校驗:
        // 文檔要求 items 數組每項至少有 productCode + quantity, 沒有就直接報錯引導模型修正,
        // 而不是讓上游靜默返回空信封后用戶對著空卡片發呆。
        if (/calculate[-_]?price|create[-_]?order|submit[-_]?order/i.test(normalizedToolName)) {
            const items = (args as any)?.items;
            if (!Array.isArray(items) || items.length === 0) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 需要 items 數組（每項至少有 productCode + quantity）。請先 query-meals / list-products 拿到商品 code 再調用。`,
                };
            }
            const bad = items.find((it: any) => !it || !it.productCode || it.quantity == null);
            if (bad) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 的 items 形態不對。每項必須有 productCode (商品編碼) 和 quantity (數量)。當前傳入: ${JSON.stringify(items).slice(0, 200)}`,
                };
            }
            if (!(args as any)?.storeCode) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 需要 storeCode (門店編碼)。到店場景用 query-nearby-stores 找門店, 外送場景用 delivery-query-addresses 拿地址裡的 storeCode + beCode。`,
                };
            }
            const ot = (args as any)?.orderType;
            if (ot == null || (typeof ot !== 'number' && !/^[12]$/.test(String(ot).trim()))) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 的 orderType 必須是整數 1 (到店) 或 2 (外送)。當前: ${JSON.stringify(ot)}`,
                };
            }
        }

        // 類型/字段歸一化, 修掉 string vs int / 字段名小寫差異這類坑
        args = normalizeMcdArgs(normalizedToolName, args);

        await ensureInitialized();
        const body = buildRequest('tools/call', { name: normalizedToolName, arguments: args });
        const { response } = await post(body);
        if (!response) return { success: false, error: '空響應' };
        if (response.error) return { success: false, error: `MCP 錯誤 [${response.error.code}]: ${response.error.message}` };

        const result = response.result;
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return { success: false, error: fullText || '麥當勞工具執行失敗', rawText: fullText };

            // 在混合文本(markdown 說明 + JSON)裡挖出 JSON。
            // 麥當勞 MCP 習慣在每個響應前塞一段 "## Response Structure" 渲染規範, 然後才接真數據。
            // 數據裡有時會有未轉義的真換行符 / 製表符, JSON.parse 會直接失敗 → 加一道修復嘗試。
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
                // 3) 掃描所有 { 和 [ 起點, 用括號配平找完整結構, 選擇最大的那個
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
                                return; // 找到一個合法的就回主循環找下一個起點
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
                        let score = Math.min(len, 4000) / 4000; // 輕微偏好更完整的片段，但不絕對
                        if (!obj || typeof obj !== 'object') return score;
                        if (Array.isArray(obj)) return score + (obj.length > 0 ? 2 : 0);
                        const keys = Object.keys(obj);
                        // 識別麥當勞信封
                        const envKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'data'];
                        const envHits = envKeys.filter(k => k in obj).length;
                        if (envHits >= 4) score += 2;
                        const data = (obj as any).data;
                        // 強烈偏好“有實際 data”的候選，避開 Response Structure 示例殼
                        if (Array.isArray(data)) score += data.length > 0 ? 8 : -2;
                        else if (data && typeof data === 'object') score += Object.keys(data).length > 0 ? 8 : -2;
                        else if (typeof data === 'string') {
                            const s = data.trim();
                            if (s && s !== '{}' && s !== '[]' && s.toLowerCase() !== 'null') score += 3;
                        } else if (data == null) {
                            score -= 3;
                        }
                        // JSON Schema / Response Structure 片段常見字段，適度降權
                        if ('properties' in obj || '$schema' in obj || 'required' in obj) score -= 3;
                        return score;
                    };
                    candidates.sort((a, b) => scoreCandidate(b.parsed, b.len) - scoreCandidate(a.parsed, a.len));
                    return candidates[0].parsed;
                }
                return undefined;
            };
            // 解析: 上游有時把數據再次 stringify 裝進 {data: "..."} / {result: "..."} 這類外殼,
            // 這裡遞歸剝一層, 讓卡片拿到真正的對象/數組
            const tryDeepParse = (v: any): any => {
                if (typeof v === 'string') {
                    const s = v.trim();
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try { return tryDeepParse(JSON.parse(s)); } catch { return v; }
                    }
                    return v;
                }
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    // 麥當勞響應都套一層信封: {success, code, message, datetime, traceId, data: {...}}
                    // 自動剝掉, 直接把 data 字段當成數據本體
                    const envelopeKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'msg', 'errorCode', 'errMsg'];
                    if ('data' in v && envelopeKeys.some(k => k in v)) {
                        const inner = v.data;
                        if (inner && typeof inner === 'object') return tryDeepParse(inner);
                        if (typeof inner === 'string') {
                            const s = inner.trim();
                            // 優先嘗試當 JSON 解; 解不開就當成普通文本/toon 緊湊字符串直接返回。
                            // 關鍵: list-nutrition-foods / campaign-calendar / available-coupons 這類工具
                            // data 是 toon 表 / markdown 文本, 不是 JSON, 之前會"剝不掉信封"導致前端
                            // 誤判'無數據'。這裡無論解不解得開 JSON, 都返回 inner 字符串本體。
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { return tryDeepParse(JSON.parse(s)); } catch { /* fall through to return string */ }
                            }
                            return s;
                        }
                        // null / undefined / number / boolean 等原始類型也直接返回 inner, 不要把信封帶回去
                        return inner;
                    }
                    // 單字段殼: {data: "..."} / {result: "..."} 等
                    const keys = Object.keys(v);
                    const wrapKeys = ['data', 'result', 'response', 'body', 'payload'];
                    if (keys.length === 1 && wrapKeys.includes(keys[0]) && typeof v[keys[0]] === 'string') {
                        const inner = tryDeepParse(v[keys[0]]);
                        if (inner && typeof inner === 'object') return inner;
                    }
                    // 否則對每個 string 字段嘗試解 (一層即可, 避免無限遞歸)
                    const out: any = Array.isArray(v) ? [] : {};
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
            // 先嘗試整段直接 parse, 不行再掃描混合文本
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
                // 診斷日誌: 讓用戶能看到工具到底返回了什麼形態
                try {
                    const topKeys = finalData && typeof finalData === 'object' && !Array.isArray(finalData)
                        ? Object.keys(finalData).slice(0, 10).join(',')
                        : (Array.isArray(finalData) ? `[Array len=${finalData.length}]` : typeof finalData);
                    console.log(`🍔 [MCD-MCP] 工具結果 ${parseRoute} | rawLen=${fullText.length} | topKeys=${topKeys}`);
                } catch { /* ignore log errors */ }
                // calculate-price 按文檔應返回對象 (含 productList / price 等), 永遠不應是空數組。
                // 一旦上游回了空數組, 幾乎可以確定是 storeCode/productCode/orderType/beCode 組合不被接受,
                // 把它顯式翻成錯誤, 讓模型在工具循環裡能看到並自我糾正, 而不是悶頭繼續走下單流程。
                if (Array.isArray(finalData) && finalData.length === 0
                    && /calculate[-_]?price|query[-_]?meals/i.test(normalizedToolName)) {
                    let argsEcho = '';
                    try { argsEcho = `\n你這次傳的參數: ${JSON.stringify(args)}`; } catch { /* ignore */ }
                    const isCalc = /calculate[-_]?price/i.test(normalizedToolName);
                    // 基於 args 真實形態智能猜根因, 不要寫死"到店帶了 beCode"這種死結論
                    const ot = (args as any)?.orderType;
                    const beCode = (args as any)?.beCode;
                    const hasBeCode = !!(beCode && String(beCode).trim());
                    const items = (args as any)?.items;
                    const itemArr = Array.isArray(items) ? items : [];
                    let smartHint = '';
                    if (ot === 1 && hasBeCode) {
                        smartHint = ` 看你 args 形態: 到店模式 (orderType=1) 但帶了 beCode='${beCode}'。這是錯配, 到店模式 beCode 必須不傳 / 留空。移除 beCode 重試。`;
                    } else if (ot === 2 && !hasBeCode) {
                        smartHint = ` 看你 args 形態: 外送模式 (orderType=2) 但沒傳 beCode。外送必須傳 beCode (跟 storeCode 同來自 delivery-query-addresses 的同一行)。`;
                    } else if (itemArr.length === 0) {
                        smartHint = ` 看你 args 形態: items 數組為空。`;
                    } else if (isCalc) {
                        // args 表面看沒問題, 重點查 productCode 形態
                        const codes = itemArr.map((i: any) => i?.productCode).filter(Boolean);
                        const suspect = codes.find((c: string) => /^[A-Za-z]/.test(c)); // 真實麥當勞 productCode 全是數字, 字母開頭多半是券 code
                        if (suspect) {
                            smartHint = ` 看你 args 形態: productCode='${suspect}' 以字母開頭, 真實麥當勞商品 code 都是純數字; 字母開頭通常是優惠券商品 spu code, 那種 code 必須**配對 couponId + couponCode** 一起傳 (在 items 同一項裡), 否則上游不認。要麼換成 query-meals 返回的純數字 code, 要麼補上 couponId + couponCode。`;
                        } else {
                            smartHint = ` 看你 args 形態沒明顯錯 (storeCode=${(args as any)?.storeCode}, orderType=${ot}, ${hasBeCode ? 'beCode='+beCode : '無 beCode'}, items=${JSON.stringify(itemArr)})。最可能的根因: productCode 不在該 storeCode 當前模式的菜單裡。先用同一組 (storeCode, orderType${ot===2?', beCode':''}) 調一次 query-meals 看實際有什麼 code 再回來。`;
                        }
                    } else {
                        // query-meals 空表
                        smartHint = ` 看你 args: storeCode=${(args as any)?.storeCode}, orderType=${ot}, ${hasBeCode ? 'beCode='+beCode : '無 beCode'}。如果 storeCode/beCode 來自不同 address 就會空, 必須用同一行的成對值。`;
                    }
                    const errBody = isCalc
                        ? `calculate-price 上游返回空列表 (按文檔應返回對象, 空說明上游拒絕了這組參數)。${smartHint}`
                        : `query-meals 上游返回空列表 (按文檔應返回 {categories, meals} 對象, 空說明 storeCode + beCode + orderType 三元組上游不接受)。${smartHint}`;
                    return {
                        success: false,
                        error: `${errBody}${argsEcho}`,
                        rawText: fullText,
                    };
                }
                return { success: true, data: finalData, rawText: fullText };
            }
            console.warn(`🍔 [MCD-MCP] 工具結果 parse 全失敗, rawLen=${fullText.length}, 前 200 字: ${fullText.slice(0, 200)}`);
            // 實在挖不到 JSON 就當成純文本
            return { success: true, data: fullText, rawText: fullText };
        }
        return { success: true, data: result };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
};

/** 測試連接: 僅驗證 token 是否能成功 initialize + 拿到 tools */
export const testMcdConnection = async (): Promise<{ ok: boolean; message: string; tools?: McdToolDef[] }> => {
    try {
        // 重置狀態以避免緩存的舊 session
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
        const tools = await listMcdTools(false);
        if (!tools.length) return { ok: true, message: '已連接, 但工具清單為空 (可能服務側未掛載工具)', tools };
        return { ok: true, message: `已連接, 拿到 ${tools.length} 個工具`, tools };
    } catch (e: any) {
        return { ok: false, message: e?.message || String(e) };
    }
};

/** 強制重置會話 (token 改變 / 退出登錄時調用) */
export const resetMcdSession = (): void => {
    initialized = false;
    sessionId = null;
    cachedTools = [];
    initPromise = null;
};
