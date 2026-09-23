/**
 * mcpFireCore — 通用 MCP 的環境無關核心（瀏覽器 / amsg worker 共用葉子）。
 *
 * mcpClient.ts 管瀏覽器側的事（localStorage 配置、代理包裝、發現流程）；
 * 這裡只放兩端都要跑的純邏輯：工具名映射、JSON-RPC 傳輸、正文假調用解析、
 * 結果格式化、後台 fire 的提示詞塊與 tools 數組。
 *
 * 段落順序是固定的，新東西插進對應分區，別隨手往文件尾巴追加：
 *   共用類型 → 工具名與長度預算（含名映射）→ 工具結果回填
 *   → 正文假調用解析 → JSON-RPC 傳輸層 → 後台 fire 專用
 * 傳輸層是底座、fire 層是它的消費方，所以 fire 那幾個函數收在最後一個分區裡。
 *
 * 環境無關葉子模塊：不 import 任何帶瀏覽器依賴的東西（會進 worker bundle）。
 */

// ========== 共用類型 ==========

export interface McpFireToolDef {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: any;
    outputSchema?: any;
    /** MCP 2025-03-26+ 的工具行為提示；只把它當安全提示，不能當權限證明。 */
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

/**
 * 上雲 / 進 worker 的服務器形狀：McpServerConfig 的結構子集
 * （沒有 proxyUrl/proxyKey——worker 側 fetch 沒有 CORS，直連 url）。
 */
export interface McpFireServer {
    id: string;
    name: string;
    url: string;
    /** Bearer Token，可選（Authorization: Bearer <token>） */
    token?: string;
    customHeaders?: Array<{ name: string; value: string }>;
    /** 空/缺省 = 通用；非空 = 只有這些角色可見（與 mcpClient.getEnabledMcpServers 同語義） */
    charIds?: string[];
    tools?: McpFireToolDef[];
}

export interface McpResolvedToolCore<S extends McpFireServer = McpFireServer> {
    server: S;
    toolName: string;
    /** 工具定義本體，建映射時一併帶出，省得調用方再按名字回服務器裡反查 */
    tool: McpFireToolDef;
}

// ========== 工具名與長度預算 ==========

/** OpenAI 工具名的長度上限。 */
const DEFAULT_MAX_TOOL_NAME_LEN = 64;

/** worker 側 MCP 工具的暴露名前綴（native 聲明與正文解析統一用它路由）。 */
export const MCP_FIRE_NAME_PREFIX = 'mcp__';
/** fire 側名映射的長度預算：拼前綴後不超 OpenAI 工具名 64 上限。 */
export const MCP_FIRE_NAME_BUDGET = DEFAULT_MAX_TOOL_NAME_LEN - MCP_FIRE_NAME_PREFIX.length;

// OpenAI 工具名只允許 [A-Za-z0-9_-]，最長 64；MCP 工具名可能帶點號等。
// maxLen 可收緊：worker 側要在暴露名前面拼 `mcp__` 前綴，得先給前綴留出位置。
// 預算是算出來的（上限減前綴長度），萬一算成 0 或負數，這裡兜到至少留 1 個字符，
// 免得返回空串或者被 slice 的負數下標倒著截。
export const sanitizeMcpToolName = (name: string, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string => {
    const len = Math.max(1, maxLen);
    return (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, len);
};

/** 重名兜底後綴：基名先截到給 `_<i>` 留位的長度，避免截斷吃掉計數器後候選名不再變化。 */
export const withMcpDedupeSuffix = (base: string, i: number, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string => {
    const suffix = `_${i}`;
    // 預算比後綴本身還短時，留位長度會變負數，slice 會從尾巴倒著截、反而吐出一長串；
    // 夾到 0 之後這種極端情況拿到的是純後綴，長度仍然可控，計數器也照樣能區分。
    return base.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
};

const serverSlug = (server: McpFireServer, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string =>
    sanitizeMcpToolName(server.name, maxLen).slice(0, 20);

/**
 * 暴露名 → 真實工具 的映射。暴露名默認用工具原名（sanitize 後）；
 * 跨服務器重名時後者加 <服務器名>_ 前綴。前台 buildMcpOpenAITools 與
 * worker fire 路徑都用這一份，保證兩端看到同一套名字。
 *
 * maxNameLen：暴露名的長度預算，缺省 64（OpenAI 上限）。worker 側傳更小的值，
 * 好給後面要拼的 `mcp__` 前綴留位。
 */
export const buildMcpNameMap = <S extends McpFireServer>(
    servers: S[],
    opts: { maxNameLen?: number } = {},
): Map<string, McpResolvedToolCore<S>> => {
    const maxLen = opts.maxNameLen ?? DEFAULT_MAX_TOOL_NAME_LEN;
    const resolve = new Map<string, McpResolvedToolCore<S>>();
    for (const server of servers) {
        for (const t of server.tools || []) {
            let exposed = sanitizeMcpToolName(t.name, maxLen);
            if (resolve.has(exposed)) {
                // 帶服務器前綴再試；還撞就在後面掛計數器（計數器由 withMcpDedupeSuffix 保位）
                const prefixed = sanitizeMcpToolName(`${serverSlug(server, maxLen)}_${t.name}`, maxLen);
                exposed = prefixed;
                let i = 2;
                while (resolve.has(exposed)) exposed = withMcpDedupeSuffix(prefixed, i++, maxLen);
            }
            resolve.set(exposed, { server, toolName: t.name, tool: t });
        }
    }
    return resolve;
};

// ========== 工具結果回填 ==========

/**
 * MCP 結果（記憶檢索、網頁抓取等）體量遠超瑞幸商品列表，1500 字符會把一條
 * 完整結果攔腰截斷。上限放到 20000 只防病態超長結果炸上下文——工具循環每輪
 * 會全量重發消息，真有兆級 JSON 混進來會直接 4xx 或 token 起飛。
 */
export const MCP_RESULT_MAX_CHARS = 20000;

export const formatMcpToolResult = (data: any): string => {
    let s: string;
    try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
    return s.length > MCP_RESULT_MAX_CHARS
        ? `${s.slice(0, MCP_RESULT_MAX_CHARS)}…[結果過長已截斷, 全文共 ${s.length} 字符]`
        : s;
};

// ========== 掉格式容錯: 正文裡的"假工具調用" ==========
//
// 不支持 function calling 的模型（或被中轉剝了 tools 參數的）看到系統塊裡的
// 工具清單後, 會把調用直接"演"在正文裡, 常見形態:
//   ask_question("SullyOS")           ← 括號傳參
//   ask_question: SullyOS             ← 冒號傳參（整行）
//   get_weather({"city": "上海"})     ← 括號傳 JSON
// 與見面觀測協議同款思路的兩層容錯: FC 通道是第一層, 這裡兜第二層。
// 只認已啟用服務器的真實工具名（暴露名/原名都認, 後台還可以額外認帶前綴的寫法）,
// 避免誤傷普通文字。

export interface FakedMcpCall<S extends McpFireServer = McpFireServer> {
    exposedName: string;
    server: S;
    toolName: string;
    args: Record<string, any>;
    matched: string;
}

/** 從正文兼容調用中剝掉調用語法，只留下可以先展示給用戶的角色文字。 */
export const stripTextFakedMcpCalls = (content: string, calls: Array<{ matched: string }>): string => {
    let cleaned = content;
    for (const call of calls) cleaned = cleaned.split(call.matched).join('');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const stripQuotes = (s: string): string => {
    const t = s.trim();
    const m = t.match(/^(['"`「『])([\s\S]*)(['"`」』])$/);
    return m ? m[2] : t;
};

/** schema 的參數名順序: required 優先, 其餘按聲明序 —— 用於位置參數落位 */
const positionalKeys = (schema: any): string[] => {
    const props = schema?.properties ? Object.keys(schema.properties) : [];
    const req = Array.isArray(schema?.required) ? schema.required.filter((k: string) => props.includes(k)) : [];
    return [...req, ...props.filter(k => !req.includes(k))];
};

const coerceBySchema = (value: string, schema: any, key: string): any => {
    const type = schema?.properties?.[key]?.type;
    const v = stripQuotes(value);
    if (type === 'number' || type === 'integer') {
        const n = Number(v);
        if (Number.isFinite(n)) return type === 'integer' ? Math.trunc(n) : n;
    }
    if (type === 'boolean') {
        if (/^(true|是|[开開])$/i.test(v)) return true;
        if (/^(false|否|[关關])$/i.test(v)) return false;
    }
    return v;
};

/** 頂層逗號切分（尊重引號與花括號嵌套） */
const splitTopLevel = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0, cur = '', quote = '';
    for (const ch of s) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
};

/** 把括號裡的原始文本解析成 args 對象（JSON / kwargs / 位置參數三種形態） */
const parseFakedArgs = (inner: string, schema: any): Record<string, any> => {
    const t = inner.trim();
    if (!t) return {};
    // JSON 形態
    if (t.startsWith('{')) {
        try { return JSON.parse(t); } catch { /* 嘗試寬鬆修復 */ }
        try {
            return JSON.parse(t
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/'/g, '"')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch { /* 落回單參數 */ }
    }
    const parts = splitTopLevel(t);
    // kwargs 形態: key=value / key: value
    if (parts.every(p => /^\s*[A-Za-z_]\w*\s*[=:]/.test(p))) {
        const args: Record<string, any> = {};
        for (const p of parts) {
            const m = p.match(/^\s*([A-Za-z_]\w*)\s*[=:]\s*([\s\S]*)$/);
            if (m) args[m[1]] = coerceBySchema(m[2], schema, m[1]);
        }
        return args;
    }
    // 位置參數形態: 按 schema 聲明順序落位
    const keys = positionalKeys(schema);
    const args: Record<string, any> = {};
    parts.forEach((p, i) => {
        const key = keys[i];
        if (key) args[key] = coerceBySchema(p, schema, key);
    });
    return args;
};

/**
 * 從 AI 正文裡提取"假工具調用"。只匹配 resolve 裡已知的工具名（暴露名/真實名）。
 * 返回按出現位置排序、按 matched 文本去重的調用列表。
 *
 * alsoMatchPrefix：額外認「前綴 + 暴露名」這種寫法。後台 fire 的 native 模式裡，
 * tools 數組給模型看的名字是帶 `mcp__` 前綴的（見 buildMcpFireTools），模型掉格式
 * 把調用演進正文時寫的多半也是帶前綴那個，不認就只能把調用語法原樣推給用戶。
 * 認出來之後 exposedName 仍然回裸名，下游按暴露名查表的邏輯不用改。
 */
export const extractTextFakedMcpCalls = <S extends McpFireServer>(
    content: string,
    resolve: Map<string, McpResolvedToolCore<S>>,
    opts: { alsoMatchPrefix?: string } = {},
): FakedMcpCall<S>[] => {
    if (!content || !resolve.size) return [];

    // 名字查找表: 暴露名和真實工具名都認（模型兩種都可能寫）
    const lookup = new Map<string, { exposed: string; hit: McpResolvedToolCore<S> }>();
    for (const [exposed, hit] of resolve) {
        lookup.set(exposed, { exposed, hit });
        lookup.set(hit.toolName, { exposed, hit });
        if (opts.alsoMatchPrefix) lookup.set(`${opts.alsoMatchPrefix}${exposed}`, { exposed, hit });
    }

    const found: Array<FakedMcpCall<S> & { index: number }> = [];
    const seen = new Set<string>();

    for (const [name, { exposed, hit }] of lookup) {
        const schema = hit.tool.inputSchema;
        const esc = escapeRegExp(name);

        // 形態1: name(args) —— 前面不能是單詞字符/點/斜槓（防止匹配到更長標識符的一部分）
        const parenRe = new RegExp(`(^|[^\\w./])${esc}\\s*\\(([^)]*)\\)`, 'g');
        for (const m of content.matchAll(parenRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                args: parseFakedArgs(m[2], schema),
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }

        // 形態2: 行首 name: 值 —— 限定行首, 避免誤傷句中"提到"工具名的普通文字
        const colonRe = new RegExp(`(^|\\n)\\s*[>*-]*\\s*\`?${esc}\`?\\s*[:：]\\s*([^\\n]+)`, 'g');
        for (const m of content.matchAll(colonRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched.trim()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const keys = positionalKeys(schema);
            const value = stripQuotes(m[2].replace(/[。！？!?…\s]+$/, ''));
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                args: keys.length ? { [keys[0]]: coerceBySchema(value, schema, keys[0]) } : {},
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }
    }

    return found
        .sort((a, b) => a.index - b.index)
        .map(({ index: _index, ...call }) => call);
};

// ========== JSON-RPC 傳輸層 ==========
//
// Streamable HTTP：握手 initialize → 通知 notifications/initialized → tools/list / tools/call。
// 會話狀態和請求目標都是顯式傳參，所以瀏覽器（配置在 localStorage、請求包代理）
// 和 worker（配置隨 tool_config 上雲、直連服務器）能共用同一套收發邏輯。

/**
 * SullyOS 現在使用的是單端點 Streamable HTTP，所以不能再宣稱只屬於舊 HTTP+SSE
 * 雙端點時代的 2024-11-05。2026-07-28 是另一套無握手協議；本客戶端先把成熟且
 * 廣泛部署的 handshake era 做完整，modern era 後續單獨接入，不能只換日期冒充支持。
 */
export const MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SUPPORTED_HANDSHAKE_PROTOCOL_VERSIONS = [
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
] as const;

// 遠端 MCP / 用戶自建代理都可能保持連接不結束。不能讓一次 tools/call
// 永久卡住整條聊天鏈路（外層 isTyping 只有等 Promise 結束後才會清掉）。
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

export interface McpToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

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

/**
 * 一個 MCP 服務器連接的會話狀態。持有者自己決定生命週期：
 * 瀏覽器 = 模塊級 Map（跨輪複用）；worker = 掛在單次 fire 的 stash 上。
 */
export interface McpSessionState {
    sessionId: string | null;
    initialized: boolean;
    initPromise: Promise<void> | null;
    /** initialize 由服務端確認的版本；後續 HTTP 請求必須帶 MCP-Protocol-Version。 */
    protocolVersion: string | null;
    /** 只用於接線台診斷展示，不參與權限或行為判斷。 */
    serverInfo: { name?: string; title?: string; version?: string } | null;
    serverCapabilities: Record<string, any> | null;
    /** JSON-RPC 請求 id，每個會話各數各的 */
    nextId: number;
}

export const createMcpSessionState = (): McpSessionState =>
    ({
        sessionId: null,
        initialized: false,
        initPromise: null,
        protocolVersion: null,
        serverInfo: null,
        serverCapabilities: null,
        nextId: 0,
    });

/** 一次請求的目標：最終 URL + 請求頭構造。瀏覽器側包代理，worker 側直連。 */
export interface McpTransportTarget {
    url: string;
    headers: (
        sessionId: string | null,
        protocolVersion: string | null,
    ) => Headers | Record<string, string>;
    /**
     * fetch 當場拋異常（連不上 / 被瀏覽器攔下）時，附在報錯後面的排查提示。
     * 代理和 CORS 都是瀏覽器側才有的概念，話術由調用方給；worker 直連可以不傳。
     */
    fetchErrorHint?: string;
}

const buildRpcRequest = (
    session: McpSessionState,
    method: string,
    params?: any,
    isNotification = false,
): McpJsonRpcRequest => {
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params };
    if (!isNotification) req.id = ++session.nextId;
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

/** Streamable HTTP 的 SSE 可能保持連接；讀到當前 JSON-RPC id 的結果即可返回。 */
const readSseResponse = async (resp: Response, expectedId: number | string | undefined): Promise<McpJsonRpcResponse> => {
    const reader = resp.body?.getReader();
    if (!reader) return parseResp(await resp.text(), 'text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '';
    const parseEvent = (event: string): McpJsonRpcResponse | null => {
        const data = event.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data || data === '[DONE]') return null;
        try {
            const parsed = JSON.parse(data) as McpJsonRpcResponse;
            return expectedId == null || parsed.id === expectedId ? parsed : null;
        } catch { return null; }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            for (const event of events) {
                const parsed = parseEvent(event);
                if (parsed) return parsed;
            }
            if (done) {
                const parsed = parseEvent(buffer);
                if (parsed) return parsed;
                throw new Error('MCP SSE 流結束，但沒有收到本次請求的響應');
            }
        }
    } finally {
        await reader.cancel().catch(() => { /* 已結束或已 abort */ });
    }
};

const postCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    body: McpJsonRpcRequest,
    timeoutMs: number,
    expectResponse = true,
): Promise<{ response: McpJsonRpcResponse | null }> => {
    const headers = target.headers(session.sessionId, session.protocolVersion);

    let resp: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        try {
            resp = await fetch(target.url, {
                method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
            });
        } catch (e: any) {
            if (controller.signal.aborted) {
                throw new Error(`MCP 請求超時（${Math.round(timeoutMs / 1000)} 秒）`);
            }
            const hint = target.fetchErrorHint || '';
            throw new Error(`MCP 請求失敗: ${e?.message || e}。${hint}`);
        }

        // fetch 拿到響應頭不代表 SSE 響應體已經結束；DeepWiki / 代理若一直不關流，
        // resp.text() 同樣必須受同一個超時控制。
        const readText = async (): Promise<string> => {
            try { return await resp.text(); }
            catch (e) {
                if (controller.signal.aborted) {
                    throw new Error(`MCP 請求超時（${Math.round(timeoutMs / 1000)} 秒）`);
                }
                throw e;
            }
        };

        const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
        if (newSid) session.sessionId = newSid;

        if (resp.status === 401 || resp.status === 403) {
            const txt = await readText().catch(() => '');
            throw new Error(`MCP 鑑權失敗 (${resp.status}): Token 可能無效或過期。${txt.slice(0, 120)}`);
        }
        if (resp.status === 202) return { response: null };
        if (!resp.ok) {
            const txt = await readText().catch(() => '');
            throw new Error(`MCP HTTP ${resp.status}: ${txt.slice(0, 200)}`);
        }
        if (!expectResponse) return { response: null };

        const ct = resp.headers.get('content-type') || '';
        try {
            if (ct.includes('text/event-stream')) {
                return { response: await readSseResponse(resp, body.id) };
            }
            const text = await readText();
            return { response: parseResp(text, ct) };
        } catch (e) {
            if (controller.signal.aborted) {
                throw new Error(`MCP 請求超時（${Math.round(timeoutMs / 1000)} 秒）`);
            }
            throw e;
        }
    } finally {
        clearTimeout(timeoutId);
    }
};

const initializeCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    timeoutMs: number,
): Promise<void> => {
    const initReq = buildRpcRequest(session, 'initialize', {
        protocolVersion: MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'sullyos', title: 'SullyOS', version: '1.0.0' },
    });
    const { response } = await postCore(target, session, initReq, timeoutMs);
    if (response?.error) throw new Error(`Initialize 失敗: ${response.error.message}`);

    const negotiated = String(
        response?.result?.protocolVersion || MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION,
    );
    if (!(MCP_SUPPORTED_HANDSHAKE_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
        throw new Error(
            `MCP 協議版本不兼容：服務器選擇了 ${negotiated}。` +
            `SullyOS 的 Streamable HTTP 接線支持 ${MCP_SUPPORTED_HANDSHAKE_PROTOCOL_VERSIONS.join(' / ')}；` +
            `2024-11-05 屬於舊 HTTP+SSE 雙端點，2026-07-28 則需要新的無握手生命週期。`,
        );
    }
    session.protocolVersion = negotiated;
    session.serverInfo = response?.result?.serverInfo || null;
    session.serverCapabilities = response?.result?.capabilities || null;

    // 直連模式下讀不到 Session-Id 說明 CORS 沒暴露響應頭（服務器可能有會話但我們拿不到），
    // Streamable HTTP 無狀態服務器也可能壓根不發。這裡不硬報錯：tools/list 能通就算能用。
    const notif = buildRpcRequest(session, 'notifications/initialized', {}, true);
    await postCore(target, session, notif, timeoutMs, false).catch(() => { /* notification 失敗不阻塞 */ });

    session.initialized = true;
};

const ensureInitializedCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    timeoutMs: number,
): Promise<void> => {
    if (session.initialized) return;
    if (!session.initPromise) {
        session.initPromise = initializeCore(target, session, timeoutMs).catch((e) => {
            session.initPromise = null;
            throw e;
        });
    }
    await session.initPromise;
};

/**
 * 握手 + tools/list，返回的工具清單由調用方負責持久化。
 * 瀏覽器的「發現工具」按鈕走這裡；worker 不需要——工具清單隨 tool_config 上雲。
 */
export const discoverMcpToolsCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    timeoutMs: number,
    opts: { onStage?: (stage: 'initialize' | 'tools') => void } = {},
): Promise<McpFireToolDef[]> => {
    opts.onStage?.('initialize');
    await ensureInitializedCore(target, session, timeoutMs);
    opts.onStage?.('tools');
    const { response } = await postCore(target, session, buildRpcRequest(session, 'tools/list'), timeoutMs);
    if (response?.error) throw new Error(`tools/list 失敗: ${response.error.message}`);
    const tools = response?.result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((t: any) => ({
        name: t.name,
        title: t.title || t.annotations?.title || '',
        description: t.description || '',
        inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
        outputSchema: t.outputSchema || t.output_schema,
        annotations: t.annotations,
    }));
};

const isRecord = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const resolveLocalSchemaRef = (schema: any, rootSchema: any): any => {
    const ref = typeof schema?.$ref === 'string' ? schema.$ref : '';
    if (!ref.startsWith('#/')) return schema;
    const resolved = ref.slice(2).split('/').reduce((current: any, part: string) => {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        return current?.[key];
    }, rootSchema);
    return resolved || schema;
};

const schemaAccepts = (schema: any, kind: 'object' | 'array'): boolean => {
    const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
    if (types.includes(kind)) return true;
    if (kind === 'object' && schema?.properties) return true;
    if (kind === 'array' && schema?.items) return true;
    return [...(schema?.oneOf || []), ...(schema?.anyOf || [])].some((item: any) => schemaAccepts(item, kind));
};

/**
 * 部分 OpenAI 兼容中轉會把 schema 中的 object / array 再編碼成 JSON 字符串。
 * 只在 schema 明確要求結構類型時還原，避免把 URL、文本等合法 string 誤解析。
 */
const normalizeMcpValueBySchema = (value: any, rawSchema: any, rootSchema: any, depth: number): any => {
    if (!rawSchema || depth > 20) return value;
    const schema = resolveLocalSchemaRef(rawSchema, rootSchema);
    const acceptsObject = schemaAccepts(schema, 'object');
    const acceptsArray = schemaAccepts(schema, 'array');
    let normalized = value;

    if (typeof normalized === 'string' && (acceptsObject || acceptsArray)) {
        // 最多解三層，兼容整個 arguments 雙重編碼與嵌套字段額外編碼。
        for (let i = 0; i < 3 && typeof normalized === 'string'; i++) {
            const text = normalized.trim();
            if (!text) break;
            try { normalized = JSON.parse(text); }
            catch { break; }
        }
        const decodedMatchesSchema = (acceptsObject && isRecord(normalized)) || (acceptsArray && Array.isArray(normalized));
        if (!decodedMatchesSchema) normalized = value;
    }

    const alternatives = [...(schema?.oneOf || []), ...(schema?.anyOf || [])];
    if (alternatives.length) {
        const matching = alternatives.find((item: any) =>
            (isRecord(normalized) && schemaAccepts(item, 'object'))
            || (Array.isArray(normalized) && schemaAccepts(item, 'array')),
        );
        if (matching) normalized = normalizeMcpValueBySchema(normalized, matching, rootSchema, depth + 1);
    }

    if (isRecord(normalized) && acceptsObject) {
        const result = { ...normalized };
        const properties = schema?.properties || {};
        for (const [key, childSchema] of Object.entries(properties)) {
            if (key in result) result[key] = normalizeMcpValueBySchema(result[key], childSchema, rootSchema, depth + 1);
        }
        if (schema?.additionalProperties && typeof schema.additionalProperties === 'object') {
            for (const key of Object.keys(result)) {
                if (!(key in properties)) {
                    result[key] = normalizeMcpValueBySchema(result[key], schema.additionalProperties, rootSchema, depth + 1);
                }
            }
        }
        for (const item of schema?.allOf || []) {
            const merged = normalizeMcpValueBySchema(result, item, rootSchema, depth + 1);
            if (isRecord(merged)) Object.assign(result, merged);
        }
        return result;
    }

    if (Array.isArray(normalized) && acceptsArray && schema?.items) {
        return normalized.map(item => normalizeMcpValueBySchema(item, schema.items, rootSchema, depth + 1));
    }
    return normalized;
};

export const normalizeMcpToolArguments = (args: any, inputSchema: any): any =>
    normalizeMcpValueBySchema(args, inputSchema, inputSchema, 0);

/** 日誌裡只留主機名：夠定位是哪台服務器，又不至於把完整地址打出來。 */
const targetHost = (url: string): string => {
    try { return new URL(url).host; } catch { return ''; }
};

/**
 * 調一個工具（會自動補握手；HTTP 400/404 視為 session 失效，就地重置會話再試一次）。
 * 重置是原地改傳進來的那個 session 對象，持有者手裡的引用會跟著更新。
 */
export const callMcpToolCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    toolName: string,
    args: Record<string, any> = {},
    opts: {
        timeoutMs?: number;
        inputSchema?: any;
        /** 日誌裡顯示的服務器名，缺省用目標 URL 的主機名 */
        serverLabel?: string;
    } = {},
): Promise<McpToolResult> => {
    const timeoutMs = opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    const normalizedArgs = normalizeMcpToolArguments(args, opts.inputSchema);
    const finish = (result: McpToolResult): McpToolResult => {
        let resultPreview = '';
        if (result.success) {
            try { resultPreview = JSON.stringify(result.data).slice(0, 800); }
            catch { resultPreview = String(result.data).slice(0, 800); }
        }
        // 不記錄 URL / Token，只證明真實 tools/call 的目標、參數與服務端返回。
        console.info('🔌 [MCP] tools/call 完成', {
            server: opts.serverLabel ?? targetHost(target.url),
            tool: toolName,
            args: normalizedArgs,
            success: result.success,
            ...(result.success ? { result: resultPreview } : { error: result.error }),
        });
        return result;
    };
    try {
        await ensureInitializedCore(target, session, timeoutMs);
        const body = buildRpcRequest(session, 'tools/call', { name: toolName, arguments: normalizedArgs });
        let response: McpJsonRpcResponse | null;
        try {
            ({ response } = await postCore(target, session, body, timeoutMs));
        } catch (e: any) {
            // 404/400 常見於服務器重啟後 session 失效，重握手再試一次
            if (/HTTP (400|404)/.test(e?.message || '')) {
                Object.assign(session, createMcpSessionState());
                await ensureInitializedCore(target, session, timeoutMs);
                ({ response } = await postCore(
                    target, session,
                    buildRpcRequest(session, 'tools/call', { name: toolName, arguments: normalizedArgs }),
                    timeoutMs,
                ));
            } else {
                throw e;
            }
        }
        if (!response) return finish({ success: false, error: '空響應' });
        if (response.error) return finish({ success: false, error: `MCP 錯誤 [${response.error.code}]: ${response.error.message}` });

        const result = response.result;
        if (result?.resultType === 'input_required') {
            return finish({
                success: false,
                error: '這個工具需要在執行途中補充確認或輸入；SullyOS 當前不會替你自動回答，請回到聊天中明確要求後重試。',
                data: result,
            });
        }
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return finish({ success: false, error: fullText || 'MCP 工具執行失敗', rawText: fullText });
            try {
                return finish({ success: true, data: JSON.parse(fullText), rawText: fullText });
            } catch {
                return finish({ success: true, data: fullText, rawText: fullText });
            }
        }
        return finish({ success: true, data: result });
    } catch (e: any) {
        return finish({ success: false, error: e?.message || String(e) });
    }
};

/** worker 直連的請求頭（瀏覽器側那套代理頭邏輯留在 mcpClient.buildMcpRequestHeaders）。 */
export const buildMcpDirectHeaders = (
    server: McpFireServer,
    sessionId: string | null,
    protocolVersion: string | null = null,
): Record<string, string> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    for (const item of server.customHeaders || []) {
        const name = String(item?.name || '').trim();
        const value = String(item?.value || '').trim();
        if (name && value) headers[name] = value;
    }
    if (server.token) headers['Authorization'] = `Bearer ${server.token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    return headers;
};

// ========== 後台 fire 專用 ==========
//
// amsg2 的 worker 到點自己調 LLM，這一段就是那時候要用的三塊料：
// 挑出這個角色能看見的服務器 → 拼 tools 數組 → 拼提示詞塊。

/**
 * fire 時按角色過濾可見服務器（charIds 語義與 getEnabledMcpServers 一致）。
 * 只管 url / tools / charIds 三項：服務器有沒有啟用由上雲側的
 * collectMcpFireServers 把關，傳到這裡的清單已經只剩啟用的。
 */
export const filterMcpServersForChar = <S extends McpFireServer>(
    servers: S[] | undefined,
    charId: string,
): S[] =>
    (servers || []).filter((s) =>
        !!s.url && (s.tools?.length || 0) > 0 &&
        (!s.charIds?.length || s.charIds.includes(charId)),
    );

export interface McpFireOpenAITool {
    type: 'function';
    function: { name: string; description: string; parameters: any };
}

/**
 * fire 請求的 tools 數組（native 模式）。暴露名直接帶 MCP_FIRE_NAME_PREFIX——模型按
 * 這個名字調回來，executeToolCalls 零歧義分流，不會撞內置工具（recall/search/…）的名字。
 * resolve 必須是用 { maxNameLen: MCP_FIRE_NAME_BUDGET } 建的（預算 + 前綴正好是
 * OpenAI 工具名的 64 上限）。
 */
export const buildMcpFireTools = <S extends McpFireServer>(
    resolve: Map<string, McpResolvedToolCore<S>>,
): McpFireOpenAITool[] => {
    // 只有跨服務器時才標來源（同一台服務器的多個工具之間不需要區分來源），
    // 與前台 buildMcpOpenAITools 的 servers.length > 1 同判據。按 server.id 去重
    // ——全倉服務器身份以 id 為準（會話 Map / resetMcpSession 同源）。
    const multiServer = new Set([...resolve.values()].map(({ server }) => server.id)).size > 1;
    const tools: McpFireOpenAITool[] = [];
    for (const [exposed, { server, tool }] of resolve) {
        const desc = (tool.description || '').trim();
        tools.push({
            type: 'function',
            function: {
                name: `${MCP_FIRE_NAME_PREFIX}${exposed}`,
                description: multiServer ? `[${server.name}] ${desc}`.trim() : desc,
                parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
        });
    }
    return tools;
};

/**
 * 後台 fire 的 MCP 工具說明塊（worker 到點拼進 user prompt 尾部）。
 *
 * native 模式（默認）：tools 參數已隨請求聲明，這裡只列來源和紀律——與前台
 * buildMcpSystemBlock 的口徑一致，不教正文語法（教了反而勾引模型往正文裡寫）。
 * text 模式（用戶在設置裡關掉「原生 tools」開關 = 中轉拒 tools 時）：請求不帶
 * tools 參數，這裡教正文協議 tool_name({...})，簽名格式與前台
 * buildMcpRejectedToolsFallbackBody 對齊——同一個模型兩端見到的長一個樣。
 */
export const buildMcpFireBlock = <S extends McpFireServer>(
    resolve: Map<string, McpResolvedToolCore<S>>,
    opts: { mode: 'native' | 'text'; userName?: string },
): string => {
    if (!resolve.size) return '';
    const userName = opts.userName || '用戶';
    // 來源標註的判據同 buildMcpFireTools：只有跨服務器時才標（各算各的，不共享狀態）
    const multiServer = new Set([...resolve.values()].map(({ server }) => server.id)).size > 1;
    const lines: string[] = [];
    for (const [exposed, { server, tool }] of resolve) {
        const desc = (tool.description || '').trim();
        if (opts.mode === 'native') {
            lines.push(`- ${exposed}${desc ? `：${desc}` : ''}${multiServer ? `（來源: ${server.name}）` : ''}`);
            continue;
        }
        const schema = tool.inputSchema || {};
        const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
        const args = Object.entries(schema.properties || {}).map(([name, d]: [string, any]) =>
            `${name}${required.has(name) ? '*' : ''}:${d?.type || 'any'}`);
        lines.push(`- ${exposed}(${args.join(', ')})${desc ? `：${desc}` : ''}${multiServer ? `（來源: ${server.name}）` : ''}`);
    }
    const howTo = opts.mode === 'native'
        ? '需要時直接通過系統的工具調用接口發起（系統會自動執行並把結果給你），不要把工具名和參數寫進正文。'
        : '需要工具時，單獨輸出一行 tool_name({"參數":"值"})，系統會代為執行並把結果給你，然後你繼續寫。* 表示必填參數。';
    return [
        '',
        '---',
        `【外部工具 —— ${userName} 在設置裡給你連了 MCP 工具服務器，主動消息裡也可以用】`,
        howTo,
        '紀律：不需要就別硬調；沒收到系統返回前不要聲稱工具成功，也不要編造結果；工具失敗就換個方式或如實帶過；結果只挑相關部分用角色語氣轉述，別復讀 JSON。',
        '多步任務：先做必要檢查，隨後立刻調用能推進目標的動作工具；不要反覆讀取同一份說明或狀態。執行動作後可以再次檢查新狀態，並繼續到目標完成或工具明確失敗。',
        `副作用操作：${userName} 本輪已經明確要求執行的視為已確認；沒有明確要求時才先確認。`,
        '可用工具：',
        ...lines,
        '---',
    ].join('\n');
};
