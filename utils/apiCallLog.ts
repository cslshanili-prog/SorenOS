/**
 * 全局 API 調用記錄（給 設置 → API 調用記錄 頁面用）。
 *
 * 設計：項目裡 LLM 調用分兩類——走 `utils/safeApi.ts` 的 `safeFetchJson` 的，和
 * 各 App 自己寫的裸 `fetch`（TRPG / 自習室 / 群聊 / 日記…）。為了一個都不漏，記錄點
 * 放在 `OSContext` 裡那個全局 `fetch` monkey-patch 上：所有 `/chat/completions`
 * （含 safeFetchJson 內部 fetch）都經過它，統一調 `recordApiCall`，不重複計。
 *
 * 「時間 / 哪個 API / 哪個模型 / token」從請求體 + 響應裡自動解析；「哪個 App / 哪個
 * 角色 / 具體用途」靠兩條來源：
 *   1. 顯式 meta —— safeFetchJson 調用點通過第 5 個參數傳，掛到 RequestInit 的
 *      `__sullyMeta` 上由攔截器讀取（精確，含 purpose）。
 *   2. 環境兜底 ambientMeta —— OSContext 在切 App / 角色時寫入「當前在哪個 App、
 *      當前角色」，裸 fetch 沒有顯式 meta 時用它兜底標 App / 角色。
 *
 * 只保留近 5 天，超期在 DB 層寫入時丟棄。recordApiCall 是 best-effort：任何異常都
 * 吞掉，絕不影響主請求鏈路。
 */

/** 調用方可補充的語義信息（哪個 App / 角色 / 用途）。能填多少填多少。 */
export interface ApiCallMeta {
    /** AppID 字符串，如 'chat' / 'lifesim'，可空 */
    appId?: string;
    /** App 顯示名，如 '消息' / '記憶宮殿'，列表裡直接展示這個 */
    appName?: string;
    /** 角色 id，可空 */
    charId?: string;
    /** 角色名，可空 */
    charName?: string;
    /** 具體用途，如 '聊天回覆' / '情緒評估' / '記憶提取'，可空 */
    purpose?: string;
}

/**
 * 這一次請求是誰發出去的。
 *
 * 不填 = 瀏覽器自己直連模型（絕大多數記錄，不佔存儲）。帶值的這幾種都是主動消息 2.0
 * 交給雲端跑的：本地只把活兒交上去，真正那條 `/chat/completions` 由用戶自己的
 * Cloudflare Worker 在雲端發出。
 *   - `cloud-instant-chat`：即時對話（用戶此刻正等著的那一輪）
 *   - `cloud-plate-consolidate`：門牌整理（記憶宮殿的後台活兒，用的是副 API）
 */
export type ApiCallRoute = 'cloud-instant-chat' | 'cloud-plate-consolidate';

/** 落庫的一條記錄。 */
export interface ApiCallLogEntry extends ApiCallMeta {
    id: string;
    /** 調用發起（實際是響應回來）時間戳 ms */
    timestamp: number;
    /** 見 ApiCallRoute。空 = 瀏覽器直連。 */
    route?: ApiCallRoute;
    /**
     * 雲端收下了這一輪，結果還沒回來。回覆落庫（或雲端點名說這輪沒成）時回填掉。
     * 本地直連的記錄沒有這一檔：那邊是響應回來才記，天生就是終態。
     */
    pending?: boolean;
    /**
     * 這一輪被下一條消息頂掉了（還沒等到回覆就又發了一條，雲端把兩句合成一次回）。
     * 不算失敗，但也等不到屬於它自己的回覆——不單獨收尾的話，這筆會一直寫著
     * 「雲端生成中」，直到 5 天后被裁掉。
     */
    superseded?: boolean;
    /**
     * Token 數只覆蓋這一輪裡的**最後一次**模型調用，不是全部。
     *
     * 雲端帶工具時一輪對話會連著調好幾次模型（查完東西再接著說），而回傳的用量只有
     * 最後那次——不標出來的話，用戶拿這個數去對供應商帳單會一直對不上，還以為是被
     * 多扣了。只在確實跑過工具時才置位。
     */
    tokensPartial?: boolean;
    /** 命中的預設名；匹配不到時回退成 baseUrl 的 host */
    presetName: string;
    baseUrl: string;
    model: string;
    /**
     * 響應側自報的模型（response.model）——實際服務這次請求的後端身份。
     * 中轉的渠道名（如 `[千島-自營]xxx`）只鎖"店面"，上游內部降級/輪詢時對外模型名
     * 不變，但後端會在響應裡自報真身（如 `[逆-V]xxx-c`）。請求名 ≠ 自報名時，
     * 這個字段就是"被換後端了"的直接證據。拿不到（響應無 model 字段）則空。
     */
    backendModel?: string;
    /** HTTP 狀態碼（成功 / 失敗均記，失敗時可能是最後一次的狀態） */
    status?: number;
    /** 請求是否成功拿到 JSON */
    ok: boolean;
    /** 輸入 token（prompt_tokens），來自響應 usage，拿不到則空 */
    promptTokens?: number;
    /** 輸出 token（completion_tokens） */
    completionTokens?: number;
    /** 總 token（total_tokens） */
    totalTokens?: number;
    /** 請求從發起到響應 / 報錯的耗時 ms（NetworkError 類失敗時 = 等了多久才斷） */
    durationMs?: number;
    /**
     * 輸入構成統計（每塊的名字 + 字符數），回答「prompt_tokens 為什麼這麼大」。
     * 只存統計不存原文（原文一條就幾十 KB，5 天日誌會撐爆存儲）；在響應回來後的
     * fire-and-forget 記錄路徑裡掃一遍請求體算出，不佔請求主鏈路。
     */
    promptBreakdown?: PromptBlockStat[];
}

/** 輸入構成裡的一塊：system prompt 的一個 ### 段落，或聚合後的聊天歷史。 */
export interface PromptBlockStat {
    /** 塊名：### 標題 / [System: …] 行 / 無標題時取首行摘要；歷史消息聚合成「聊天歷史·×N」 */
    label: string;
    /** 該塊字符數（含標題行與換行） */
    chars: number;
}

export type ApiRequestCaptureSectionKind =
    | 'request'
    | 'tools'
    | 'system'
    | 'memory'
    | 'worldbook'
    | 'group'
    | 'history'
    | 'context'
    | 'user'
    | 'assistant'
    | 'tool';

/** 一次性完整抓包的分區索引。正文只在 payload 中保存一份，避免大上下文重複佔空間。 */
export interface ApiRequestCaptureSection {
    id: string;
    label: string;
    kind: ApiRequestCaptureSectionKind;
    chars: number;
    /** 面向用戶的來源解釋，例如「記憶系統召回並注入的內容」。 */
    source?: string;
    /** 在原始請求裡的位置，例如 messages[0].content。 */
    path?: string;
    role?: string;
    messageIndex?: number;
    /** 字符串消息被按標題拆塊時，對應 content 的起止位置。 */
    start?: number;
    end?: number;
}

/**
 * 用戶主動開啟後，僅保存下一次 chat/completions 的完整請求體。
 * 普通 5 天日誌仍然只存統計；這條記錄永遠覆蓋上一條，避免原文長期堆積。
 */
export interface ApiRequestCapture {
    version: 1;
    id: string;
    capturedAt: number;
    baseUrl: string;
    presetName: string;
    model: string;
    meta: ApiCallMeta;
    payload: unknown;
    totalChars: number;
    /** 模型/中轉響應 usage 中自報的真實輸入 Token；對方不返回時為空。 */
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    usageStatus?: 'pending' | 'reported' | 'not-reported' | 'failed';
    messageCount: number;
    binaryPlaceholders: number;
    sections: ApiRequestCaptureSection[];
}

export const API_REQUEST_CAPTURE_EVENT = 'sully-api-request-capture-change';
const API_REQUEST_CAPTURE_ARMED_KEY = 'sully_api_request_capture_armed_v1';

const PRESETS_STORAGE_KEY = 'os_api_presets';

/**
 * 環境上下文（兜底用）：很多 App 走的是裸 fetch，調用點無法/來不及傳 meta。
 * OSContext 會在切換 App / 角色時把「當前在哪個 App、當前角色是誰」寫到這裡，
 * 全局 fetch 攔截器記錄裸 fetch 調用時拿它當兜底標籤。
 * 注意：safeFetchJson 傳了顯式 meta 的調用以顯式 meta 為準，不用兜底（避免後台
 * 任務被誤標成用戶當前所在的 App）。
 */
let ambientMeta: ApiCallMeta = {};

export function setApiCallAmbientContext(meta: ApiCallMeta): void {
    ambientMeta = meta || {};
}

/** Snapshot the current fallback context when a request starts. */
export function getApiCallAmbientContext(): ApiCallMeta {
    return { ...ambientMeta };
}

function hasMeta(meta?: ApiCallMeta): boolean {
    return !!meta && Object.values(meta).some((v) => v != null && v !== '');
}

function stripTrailingSlash(s: string): string {
    return s.replace(/\/+$/, '');
}

/** 把 `https://host/v1/chat/completions` 還原成 `https://host/v1`（預設裡存的 baseUrl 形態）。 */
function deriveBaseUrl(url: string): string {
    return stripTrailingSlash(url.replace(/\/chat\/completions\/?$/i, ''));
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * 模型名的"核心名"：剝掉渠道標籤（[方括號]、(半角圓括號)、（全角圓括號））、
 * 去空白、統一小寫。用於判斷「請求名 vs 後端自報名」是不是同一個模型——
 * `(按次)gemini-3.1-pro-preview` 和 `gemini-3.1-pro-preview` 是同一個（只是渠道標籤），
 * `gemini-3.1-pro-preview` 和 `gemini-3.1-pro-preview-c` 才是真的換了後端。
 */
/**
 * 已知模型家族開頭（gemini-…/gpt-…/claude-…）。渠道前綴的花樣窮舉不完，
 * 但家族名是個短且穩定的清單——把它當錨點：名字開頭若不是家族名、且剝掉
 * 一段裸前綴（`gcli-` / `vertex-ai/`）後就是，則認定那段是渠道標籤。
 * 這樣「兩頭貼了不同裸前綴」（gcli-X vs vertex-X）也能對上核心名。
 */
const MODEL_FAMILY_RE = /^(gemini|gemma|gpt|chatgpt|o\d|claude|deepseek|qwen|qwq|glm|llama|grok|kimi|moonshot|mistral|mixtral|doubao|hunyuan|minimax|ernie|command|nova|phi)[-_.\d]/i;

function stripBareChannelPrefixes(s: string): string {
    let cur = s;
    // 最多剝 3 層（渠道套渠道），每刀都必須讓剩餘部分以已知家族名開頭才算數
    for (let i = 0; i < 3; i++) {
        if (MODEL_FAMILY_RE.test(cur)) return cur;
        // 非貪婪取最短首段：'chatgpt-4o' 不會被誤劈成 'chatgpt-4o' + …
        const m = cur.match(/^[a-z0-9_.]{1,24}?[-/](.+)$/i);
        if (!m || !MODEL_FAMILY_RE.test(m[1])) return cur;
        cur = m[1];
    }
    return cur;
}

export function coreModelName(m: string): string {
    const stripped = (m || '')
        .replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    return stripBareChannelPrefixes(stripped);
}

/**
 * 「請求的模型」和「後端自報的模型」是否應視為同一個（＝不該報琥珀 ⚠️）。
 *
 * 販子的渠道標籤格式窮舉不完（[方括號]、(按次)、gcli- 裸前綴…），所以不枚舉格式，
 * 改用方向性判定——核心名歸一後：
 *   - 完全相等 → 同一個
 *   - 一方是另一方**去掉開頭一截**的結果（endsWith）→ 同一個。
 *     覆蓋兩個方向：請求帶渠道前綴（gcli-X ↔ X）、後端帶路徑/前綴（X ↔ models/X）。
 *     「開頭多一截」只是運營商貼標籤，不改變模型本體。
 *   - 其餘（尤其**尾巴多一截**：X ↔ X-c / X-lite）→ 不同。縮水變體都長在尾巴上，
 *     這正是要抓的降級信號，絕不放行。
 * 短名（<8 字符）不做 endsWith 寬容，防止病態短串誤匹配。
 */
export function isSameCoreModel(requested: string, backend: string): boolean {
    const a = coreModelName(requested);
    const b = coreModelName(backend);
    if (!a || !b) return true;   // 有一方空：無從比較，不報警
    if (a === b) return true;
    const shorter = a.length < b.length ? a : b;
    if (shorter.length < 8) return false;
    return a.endsWith(b) || b.endsWith(a);
}

/** 從請求體裡摳出 model 字段（body 可能是 JSON 字符串或對象）。 */
function extractModel(body: unknown): string {
    if (!body) return '';
    let parsed: any = body;
    if (typeof body === 'string') {
        try { parsed = JSON.parse(body); } catch { return ''; }
    }
    return typeof parsed?.model === 'string' ? parsed.model : '';
}

/**
 * 用 baseUrl + model 在用戶保存的預設裡反查預設名（截圖裡的「奇異果 / 鈴蘭 / 千島2」那些）。
 * 預設結構見 types.ts ApiPreset：{ id, name, config: { baseUrl, apiKey, model } }。
 * 匹配不到（比如用的是沒存成預設的臨時配置）就回退成 host。
 */
function resolvePresetName(baseUrl: string, model: string): string {
    try {
        if (typeof localStorage === 'undefined') return hostOf(baseUrl);
        const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
        if (!raw) return hostOf(baseUrl);
        const presets = JSON.parse(raw);
        if (!Array.isArray(presets)) return hostOf(baseUrl);
        const normBase = stripTrailingSlash(baseUrl);
        // 優先 baseUrl + model 都對上；退而求其次只對 baseUrl
        const exact = presets.find((p: any) =>
            stripTrailingSlash(p?.config?.baseUrl || '') === normBase &&
            (p?.config?.model || '') === model);
        if (exact?.name) return exact.name;
        const byBase = presets.find((p: any) =>
            stripTrailingSlash(p?.config?.baseUrl || '') === normBase);
        if (byBase?.name) return byBase.name;
        return hostOf(baseUrl);
    } catch {
        return hostOf(baseUrl);
    }
}

/**
 * 記錄一次 API 調用。fire-and-forget，絕不 throw / 阻塞主鏈路。
 * 在 safeFetchJson 裡對 `/chat/completions` 的成功與失敗都會調用。
 */
/** 從 OpenAI 兼容響應裡摳 usage（各家代理大多遵循這個字段）。 */
export function extractApiTokenUsage(response: unknown): { prompt?: number; completion?: number; total?: number } {
    const root = response as any;
    const usage = root?.usage || root?.usage_metadata || root?.usageMetadata;
    if (!usage || typeof usage !== 'object') return {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return {
        prompt: num(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount),
        completion: num(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount),
        total: num(usage.total_tokens ?? usage.totalTokenCount),
    };
}

/**
 * SSE 流式響應文本的兜底解析：掃 `data: {...}` 行，摳後端自報 model（首個非空）
 * 和 usage（取最後一個非空，OpenAI 約定 usage 在末尾 chunk）。
 * 攔截器 clone 出的流式響應 JSON.parse 必然失敗，之前流式調用在記錄裡
 * 既沒有 token 數也沒有後端身份——這裡補上。
 */
export function scanSseForLog(text: string): { model?: string; usage?: unknown } {
    let model: string | undefined;
    let usage: unknown;
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (!model && typeof chunk?.model === 'string' && chunk.model) model = chunk.model;
        if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage;
    }
    return { model, usage };
}

// ── 輸入構成統計（promptBreakdown） ──────────────────────────────────────

/** 多模態 content 攤平成可計數文本（圖片按佔位符計，與 emotion eval 的展平口徑一致）。 */
function contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part: any) => {
            if (part?.type === 'text') return part.text || '';
            if (part?.type === 'image_url') return '[圖片]';
            return '';
        }).filter(Boolean).join(' ');
    }
    if (content == null) return '';
    try { return JSON.stringify(content) ?? ''; } catch { return String(content); }
}

const BLOCK_LABEL_MAX = 40;

/** 行是塊頭？返回塊名（`## / ### 標題` 或 `[System: …]`），否則 null。 */
const matchBlockHeader = (line: string): string | null => {
    const m = line.match(/^\s*#{2,3}\s+(.+?)\s*$/) || line.match(/^\s*(\[System:[^\]]*\])/);
    return m ? m[1].trim() : null;
};

/**
 * 計算哪些行是有效的 ``` 圍欄開合線。圍欄必須**成對**才生效：用戶數據（記憶
 * 摘要等）裡落單的半個 ``` 會把圍欄狀態永久翻轉，後面所有塊頭全被吞進上一塊
 * （實測：62K 的「記憶系統」行吞掉了對話歷史+評估框架）。奇數個時最後一個不算。
 */
function fenceToggleLines(lines: string[]): Set<number> {
    const indices: number[] = [];
    lines.forEach((line, i) => { if (/^\s*```/.test(line)) indices.push(i); });
    if (indices.length % 2 === 1) indices.pop();
    return new Set(indices);
}

/**
 * 把一條 system 消息按塊頭切開。``` 圍欄內的行不算塊頭——行為規範裡的日記
 * 示例（`## 今天的小確幸` 等）都在代碼塊裡，不加圍欄感知會被誤切成獨立塊。
 * 一個塊頭都沒有的短消息（雙語 / MCP 尾部提醒等）整條算一塊，取首行當名字。
 */
function splitSystemBlocks(text: string): PromptBlockStat[] {
    const out: PromptBlockStat[] = [];
    let label = '（開頭·未分塊部分）';
    let chars = 0;
    let sawHeader = false;
    let inFence = false;
    const lines = text.split('\n');
    const fenceAt = fenceToggleLines(lines);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fenceAt.has(i)) inFence = !inFence;
        const header = inFence ? null : matchBlockHeader(line);
        if (header) {
            if (chars > 0) out.push({ label, chars });
            label = header.slice(0, BLOCK_LABEL_MAX);
            chars = line.length + 1;
            sawHeader = true;
        } else {
            chars += line.length + 1;
        }
    }
    if (chars > 0) out.push({ label, chars });
    if (!sawHeader && out.length === 1) {
        const firstLine = text.trimStart().split('\n', 1)[0] || '(空 system)';
        out[0] = { ...out[0], label: firstLine.slice(0, BLOCK_LABEL_MAX) };
    }
    return out;
}

/**
 * 已知的「寫死的固定骨架」塊名前綴（規則/格式/鋼印類，內容不隨用戶數據變化）。
 * 構成面板的展示層把命中的塊合併成一行「固定提示詞」，突出真正能優化的數據塊。
 * 新增固定提示詞塊時記得把塊頭加進來（漏加只是顯示散一點，無功能影響）。
 */
const FIXED_PROMPT_LABEL_PREFIXES = [
    '聊天 App 行為規範',
    '表達底線',
    '🎤 語音消息功能',
    '關於對方的表達',
    '最後，回到你自己',
    '【音樂互動工具】',
    '關於《彼方》',
    '[MCP 工具 ON',
    '[Reminder:',
    // 思考鏈提示詞（thinkingChainPrompt.ts）的章節頭
    '語言鐵律',
    '你不是在演',
    '起點:你本來在幹嘛',
    '同時被激活的多個東西',
    '別急著安慰',
    '別造謠',
    '溫度:腦內比嘴上更吵',
    'Thinking 寫法總則',
];

export const isFixedPromptBlockLabel = (label: string): boolean =>
    FIXED_PROMPT_LABEL_PREFIXES.some(prefix => label.startsWith(prefix));

const MAX_BREAKDOWN_BLOCKS = 48;

/**
 * 從 chat/completions 請求體算輸入構成。解析不了 / 沒有 messages 時返回 undefined。
 * system 逐塊統計，歷史消息按角色聚合（用戶只關心"內置注入哪塊肥"，不關心第幾條歷史）。
 */
export function buildPromptBreakdown(body: unknown): PromptBlockStat[] | undefined {
    try {
        let parsed: any = body;
        if (typeof body === 'string') {
            try { parsed = JSON.parse(body); } catch { return undefined; }
        }
        const messages = parsed?.messages;
        if (!Array.isArray(messages) || messages.length === 0) return undefined;

        const out: PromptBlockStat[] = [];
        let userChars = 0, userCount = 0, asstChars = 0, asstCount = 0, otherChars = 0, otherCount = 0;
        // 情緒評估等路徑把「完整 system prompt + 展平歷史 + 任務說明」整個打包成一條
        // user 消息發送——不拆的話構成面板只會顯示「用戶消息 ×1 · 100%」，看不出內裡。
        // 巨型且含多個塊頭的 user 消息按 system 同款規則拆塊；普通聊天消息不受影響。
        const HUGE_USER_MSG_SPLIT_CHARS = 8000;
        const countBlockHeaders = (text: string): number => {
            let n = 0, inFence = false;
            const lines = text.split('\n');
            const fenceAt = fenceToggleLines(lines);
            for (let i = 0; i < lines.length; i++) {
                if (fenceAt.has(i)) inFence = !inFence;
                if (!inFence && matchBlockHeader(lines[i])) n++;
            }
            return n;
        };
        for (const msg of messages) {
            const text = contentToText(msg?.content);
            if (msg?.role === 'system') {
                out.push(...splitSystemBlocks(text));
            } else if (msg?.role === 'user') {
                if (text.length > HUGE_USER_MSG_SPLIT_CHARS && countBlockHeaders(text) >= 2) {
                    out.push(...splitSystemBlocks(text));
                } else {
                    userChars += text.length; userCount++;
                }
            } else if (msg?.role === 'assistant') {
                asstChars += text.length; asstCount++;
            } else {
                otherChars += text.length; otherCount++;
            }
        }
        if (userCount) {
            // 記憶提取/日程生成/查手機等大量調用點是「單條 user 提示詞」形態——
            // 標成"聊天歷史"純屬誤導，改用首行摘要讓人一眼看出是什麼任務。
            const soloPrompt = messages.length === 1 && userCount === 1;
            const firstLine = soloPrompt
                ? (contentToText(messages[0]?.content).trimStart().split('\n', 1)[0] || '').slice(0, BLOCK_LABEL_MAX)
                : '';
            out.push(soloPrompt
                ? { label: `提示詞整體「${firstLine}」`, chars: userChars }
                : { label: `聊天歷史·用戶消息 ×${userCount}`, chars: userChars });
        }
        if (asstCount) out.push({ label: `聊天歷史·角色消息 ×${asstCount}`, chars: asstChars });
        if (otherCount) out.push({ label: `其他消息（tool 等）×${otherCount}`, chars: otherChars });
        if (out.length === 0) return undefined;

        // 限容：病態多塊時合併尾巴，保證單條記錄體積可控
        if (out.length > MAX_BREAKDOWN_BLOCKS) {
            const head = out.slice(0, MAX_BREAKDOWN_BLOCKS - 1);
            const restChars = out.slice(MAX_BREAKDOWN_BLOCKS - 1).reduce((sum, b) => sum + b.chars, 0);
            head.push({ label: `（其餘 ${out.length - (MAX_BREAKDOWN_BLOCKS - 1)} 塊合計）`, chars: restChars });
            return head;
        }
        return out;
    } catch {
        return undefined;
    }
}

function emitCaptureChange(status: 'armed' | 'idle' | 'saved' | 'error'): void {
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(API_REQUEST_CAPTURE_EVENT, { detail: { status } }));
        }
    } catch { /* 診斷功能不能影響主流程 */ }
}

function readApiRequestCaptureArmed(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(API_REQUEST_CAPTURE_ARMED_KEY) === '1';
    } catch {
        return false;
    }
}

// 關閉時的 LLM 熱路徑只讀這個內存布爾值，不在每次請求上同步訪問 localStorage。
let apiRequestCaptureArmed = readApiRequestCaptureArmed();

// 多標籤頁同步只發生在開關改變時，不給普通 API 調用增加監聽或存儲開銷。
try {
    if (typeof window !== 'undefined') {
        window.addEventListener('storage', (event) => {
            if (event.key !== API_REQUEST_CAPTURE_ARMED_KEY) return;
            apiRequestCaptureArmed = event.newValue === '1';
            emitCaptureChange(apiRequestCaptureArmed ? 'armed' : 'idle');
        });
    }
} catch { /* 非瀏覽器 / 隱私模式兜底 */ }

export function isApiRequestCaptureArmed(): boolean {
    return apiRequestCaptureArmed;
}

export function setApiRequestCaptureArmed(armed: boolean): void {
    apiRequestCaptureArmed = armed;
    try {
        if (typeof localStorage !== 'undefined') {
            if (armed) localStorage.setItem(API_REQUEST_CAPTURE_ARMED_KEY, '1');
            else localStorage.removeItem(API_REQUEST_CAPTURE_ARMED_KEY);
        }
    } catch { /* localStorage 被禁用時靜默失敗 */ }
    emitCaptureChange(armed ? 'armed' : 'idle');
}

/** 同步搶佔開關：同一頁面裡即使同時發出多個請求，也只有第一條能拿到抓包資格。 */
function claimApiRequestCapture(): boolean {
    if (!apiRequestCaptureArmed) return false;
    apiRequestCaptureArmed = false;
    try { localStorage.removeItem(API_REQUEST_CAPTURE_ARMED_KEY); } catch { /* 已在內存中關閉 */ }
    emitCaptureChange('idle');
    return true;
}

const INLINE_DATA_URL_LIMIT = 4096;

/**
 * 文字原樣保存；超長 data URL 只保留類型和原始長度。
 * 這類內容通常是圖片/音頻二進制，並不是要排查的提示詞正文，完整落庫反而很容易觸發配額上限。
 */
function sanitizeCapturePayload(value: unknown, stats: { binaryPlaceholders: number }): unknown {
    if (typeof value === 'string') {
        if (value.length > INLINE_DATA_URL_LIMIT && /^data:[^,]+,/i.test(value)) {
            stats.binaryPlaceholders++;
            const mime = value.slice(5, value.indexOf(';') > 0 ? value.indexOf(';') : value.indexOf(','));
            return `[${mime || 'binary'} data URL 正文未保存；原始 ${value.length.toLocaleString('en-US')} 字符]`;
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(item => sanitizeCapturePayload(item, stats));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            out[key] = sanitizeCapturePayload(child, stats);
        }
        return out;
    }
    return value;
}

interface CaptureTextBlock {
    label: string;
    start: number;
    end: number;
}

/** 與普通統計使用相同標題規則，但額外保留正文位置，正文無需複製第二份。 */
function splitCaptureTextBlocks(text: string): CaptureTextBlock[] {
    const lines = text.split('\n');
    const fenceAt = fenceToggleLines(lines);
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }

    const blocks: CaptureTextBlock[] = [];
    let inFence = false;
    let start = 0;
    let label = '開頭 / 未分區提示詞';
    let sawHeader = false;
    for (let i = 0; i < lines.length; i++) {
        if (fenceAt.has(i)) inFence = !inFence;
        const header = inFence ? null : matchBlockHeader(lines[i]);
        if (!header) continue;
        const headerStart = lineStarts[i];
        if (headerStart > start) blocks.push({ label, start, end: headerStart });
        start = headerStart;
        label = header.slice(0, BLOCK_LABEL_MAX);
        sawHeader = true;
    }
    if (start < text.length || text.length === 0) blocks.push({ label, start, end: text.length });
    if (!sawHeader && blocks.length === 1) {
        const firstLine = text.trimStart().split('\n', 1)[0]?.slice(0, BLOCK_LABEL_MAX);
        blocks[0].label = firstLine || '未命名提示詞';
    }
    return blocks.filter(block => block.end > block.start || text.length === 0);
}

function captureKindForLabel(label: string): ApiRequestCaptureSectionKind {
    if (/[记記][忆憶]|回[忆憶]|召回|[话話][题題]盒|memory|event\s*box|topic\s*box|事件盒/i.test(label)) return 'memory';
    if (/世界[书書]|world\s*book|worldbook|lore/i.test(label)) return 'worldbook';
    if (/群聊|群[组組]聊天|group\s*(?:chat|scene|conversation)/i.test(label)) return 'group';
    if (/完整[对對][话話]|[对對][话話][历歷]史|[历歷]史[对對][话話]|聊天[历歷]史|conversation\s*history|chat\s*history|dialogue\s*history/i.test(label)) return 'history';
    if (/角色|[关關][系係]|[状狀][态態]|上下文|character|relationship|context/i.test(label)) return 'context';
    return 'system';
}

const CAPTURE_SOURCE_DESCRIPTIONS: Record<ApiRequestCaptureSectionKind, string> = {
    request: '請求配置：模型、採樣參數、輸出格式等頂層字段',
    tools: '功能或 MCP 注入給模型的工具定義',
    system: '當前功能的預設、規則或系統提示詞',
    memory: '記憶系統召回後注入本次請求的內容',
    worldbook: '世界書命中後注入本次請求的設定',
    group: '近期群聊、群聊場景或公共聊天背景注入的內容',
    history: '隨請求發送給模型的既往用戶與角色對話內容',
    context: '角色資料、關係狀態或實時環境上下文',
    user: '本輪用戶輸入，或功能發起任務時使用的用戶提示詞',
    assistant: '隨上下文一起發送的歷史角色回覆',
    tool: '上一輪工具執行後返回給模型的結果',
};

export function getApiRequestCaptureSectionSource(section: ApiRequestCaptureSection): string {
    return section.source || CAPTURE_SOURCE_DESCRIPTIONS[section.kind] || '請求中的其他內容';
}

function jsonLength(value: unknown): number {
    try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

/** 純函數，供攔截器和測試共同使用。 */
export function buildApiRequestCapture(input: {
    url: string;
    body?: unknown;
    meta?: ApiCallMeta;
    capturedAt?: number;
}): ApiRequestCapture {
    let parsed: unknown = input.body;
    if (typeof input.body === 'string') {
        try { parsed = JSON.parse(input.body); } catch { parsed = { rawBody: input.body }; }
    }
    const stats = { binaryPlaceholders: 0 };
    const payload = sanitizeCapturePayload(parsed ?? null, stats);
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : { rawBody: payload };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sections: ApiRequestCaptureSection[] = [];
    const requestOptions = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'messages' && key !== 'tools'));
    if (Object.keys(requestOptions).length > 0) {
        sections.push({
            id: 'request-options',
            label: '請求參數',
            kind: 'request',
            chars: jsonLength(requestOptions),
            source: CAPTURE_SOURCE_DESCRIPTIONS.request,
            path: '請求體頂層（messages / tools 除外）',
        });
    }
    if (body.tools !== undefined) {
        sections.push({
            id: 'tool-definitions',
            label: '工具定義（tools）',
            kind: 'tools',
            chars: jsonLength(body.tools),
            source: CAPTURE_SOURCE_DESCRIPTIONS.tools,
            path: 'tools',
        });
    }

    messages.forEach((rawMessage, messageIndex) => {
        const message = rawMessage && typeof rawMessage === 'object' ? rawMessage as Record<string, unknown> : { content: rawMessage };
        const role = typeof message.role === 'string' ? message.role : 'unknown';
        const content = message.content;
        const shouldSplit = typeof content === 'string' && (
            role === 'system' || (content.length > 8000 && splitCaptureTextBlocks(content).length > 1)
        );
        if (shouldSplit) {
            splitCaptureTextBlocks(content as string).forEach((block, blockIndex) => {
                const kind = captureKindForLabel(block.label);
                sections.push({
                    id: `message-${messageIndex}-block-${blockIndex}`,
                    label: block.label,
                    kind,
                    chars: block.end - block.start,
                    source: CAPTURE_SOURCE_DESCRIPTIONS[kind],
                    path: `messages[${messageIndex}].content · 分塊 ${blockIndex + 1}`,
                    role,
                    messageIndex,
                    start: block.start,
                    end: block.end,
                });
            });
            return;
        }
        const roleKind: ApiRequestCaptureSectionKind =
            role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role === 'tool' ? 'tool' : 'system';
        const roleLabel = role === 'user' ? '用戶消息' : role === 'assistant' ? '角色消息' : role === 'tool' ? '工具結果' : `${role} 消息`;
        sections.push({
            id: `message-${messageIndex}`,
            label: `${roleLabel} · 第 ${messageIndex + 1} 條`,
            kind: roleKind,
            chars: typeof content === 'string' ? content.length : jsonLength(content),
            source: CAPTURE_SOURCE_DESCRIPTIONS[roleKind],
            path: `messages[${messageIndex}].content`,
            role,
            messageIndex,
        });
    });

    const baseUrl = deriveBaseUrl(input.url);
    const model = extractModel(body);
    const meta = hasMeta(input.meta) ? { ...input.meta } : { ...ambientMeta };
    const capturedAt = input.capturedAt ?? Date.now();
    return {
        version: 1,
        id: `capture-${capturedAt}-${Math.random().toString(36).slice(2, 8)}`,
        capturedAt,
        baseUrl,
        presetName: resolvePresetName(baseUrl, model),
        model,
        meta,
        payload,
        totalChars: jsonLength(payload),
        usageStatus: 'pending',
        messageCount: messages.length,
        binaryPlaceholders: stats.binaryPlaceholders,
        sections,
    };
}

/** 展示層按索引從唯一 payload 中取正文，避免保存時把大提示詞複製兩份。 */
export function getApiRequestCaptureSectionContent(
    capture: ApiRequestCapture,
    section: ApiRequestCaptureSection,
): string {
    try {
        const body = capture.payload && typeof capture.payload === 'object' && !Array.isArray(capture.payload)
            ? capture.payload as Record<string, unknown>
            : { rawBody: capture.payload };
        if (section.kind === 'request') {
            return JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'messages' && key !== 'tools')), null, 2);
        }
        if (section.kind === 'tools') return JSON.stringify(body.tools, null, 2);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const message = messages[section.messageIndex ?? -1] as any;
        if (!message) return '';
        const content = message?.content;
        if (typeof content === 'string') {
            if (section.start != null && section.end != null) return content.slice(section.start, section.end);
            return content;
        }
        return JSON.stringify(content, null, 2);
    } catch {
        return '';
    }
}

export interface ApiRequestCaptureDuplicateSummary {
    groups: number;
    repeatedSections: number;
    extraChars: number;
    examples: Array<{ label: string; occurrences: number; chars: number }>;
}

/**
 * 檢查客戶端實際請求裡是否有完全相同的長文本被重複塞入。
 * 只比較正文分區，忽略請求參數/tools 和短句，避免把常見短提醒誤報成提示詞重複。
 */
export function summarizeApiRequestCaptureDuplicates(
    capture: ApiRequestCapture,
    minChars = 160,
): ApiRequestCaptureDuplicateSummary {
    const byContent = new Map<string, Array<ApiRequestCaptureSection>>();
    capture.sections.forEach(section => {
        if (section.kind === 'request' || section.kind === 'tools' || section.chars < minChars) return;
        const content = getApiRequestCaptureSectionContent(capture, section)
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+$/gm, '')
            .trim();
        if (content.length < minChars) return;
        const matches = byContent.get(content) || [];
        matches.push(section);
        byContent.set(content, matches);
    });

    const duplicates = [...byContent.entries()]
        .filter(([, sections]) => sections.length > 1)
        .map(([content, sections]) => ({
            label: sections[0].label,
            occurrences: sections.length,
            chars: content.length,
        }))
        .sort((a, b) => (b.chars * (b.occurrences - 1)) - (a.chars * (a.occurrences - 1)));

    return {
        groups: duplicates.length,
        repeatedSections: duplicates.reduce((sum, item) => sum + item.occurrences, 0),
        extraChars: duplicates.reduce((sum, item) => sum + item.chars * (item.occurrences - 1), 0),
        examples: duplicates.slice(0, 3),
    };
}

/** 生成適合用戶直接發給開發者排查的可讀 TXT；不額外落庫，只在複製/下載時即時拼裝。 */
export function formatApiRequestCaptureTxt(capture: ApiRequestCapture): string {
    const fmt = (value: number) => value.toLocaleString('en-US');
    const time = new Date(capture.capturedAt).toLocaleString('zh-CN', { hour12: false });
    const grouped = new Map<ApiRequestCaptureSectionKind, { chars: number; count: number }>();
    capture.sections.forEach(section => {
        const current = grouped.get(section.kind) || { chars: 0, count: 0 };
        current.chars += section.chars;
        current.count++;
        grouped.set(section.kind, current);
    });
    const classifiedChars = [...grouped.values()].reduce((sum, item) => sum + item.chars, 0) || 1;
    const duplicateSummary = summarizeApiRequestCaptureDuplicates(capture);
    const sourceRows = [...grouped.entries()]
        .sort((a, b) => b[1].chars - a[1].chars)
        .map(([kind, item], index) => {
            const pct = item.chars / classifiedChars * 100;
            return `${index + 1}. ${CAPTURE_SOURCE_DESCRIPTIONS[kind]}\n   ${fmt(item.chars)} 字符 · ${pct < 1 ? '<1' : Math.round(pct)}% · ${item.count} 個分區`;
        });

    const sectionRows = capture.sections.map((section, index) => {
        const content = getApiRequestCaptureSectionContent(capture, section);
        return [
            `===== 分區 ${index + 1}/${capture.sections.length} · ${section.label} =====`,
            `類型：${section.kind}`,
            `來源：${getApiRequestCaptureSectionSource(section)}`,
            `位置：${section.path || (section.messageIndex != null ? `messages[${section.messageIndex}]` : '請求體')}`,
            `大小：${fmt(section.chars)} 字符`,
            '',
            content || '（空內容）',
        ].join('\n');
    });

    return [
        'Soren · LLM 本次發送統計',
        '================================',
        `抓取時間：${time}`,
        `App：${capture.meta.appName || '—'}`,
        `用途：${capture.meta.purpose || '—'}`,
        `角色：${capture.meta.charName || '—'}`,
        `API：${capture.presetName || capture.baseUrl || '—'}`,
        `模型：${capture.model || '—'}`,
        `輸入 Token（模型響應自報）：${capture.promptTokens != null ? fmt(capture.promptTokens) : capture.usageStatus === 'pending' ? '等待響應' : capture.usageStatus === 'failed' ? '請求失敗，無法取得' : '接口未返回 usage'}`,
        `輸出 Token：${capture.completionTokens != null ? fmt(capture.completionTokens) : '—'}`,
        `總 Token：${capture.totalTokens != null ? fmt(capture.totalTokens) : '—'}`,
        `請求體總字符（不是 Token）：${fmt(capture.totalChars)}`,
        `消息數：${capture.messageCount}`,
        `分區數：${capture.sections.length}`,
        capture.binaryPlaceholders > 0
            ? `二進制佔位：${capture.binaryPlaceholders} 個（圖片/音頻正文未保存，已保留原始長度）`
            : '二進制佔位：0',
        '',
        '===== 客戶端發出前重複檢查 =====',
        duplicateSummary.groups === 0
            ? '未發現完全相同的長文本被客戶端重複發送。'
            : `發現 ${duplicateSummary.groups} 組完全相同的長文本；重複部分額外 ${fmt(duplicateSummary.extraChars)} 字符。`,
        '說明：這裡只能證明客戶端實際發出了什麼，無法檢查中轉站收到請求後的二次拼接。',
        '',
        '===== 來源體積排行（按正文字符統計，不是 Token） =====',
        ...sourceRows,
        '',
        '===== 分區正文（按實際發送順序） =====',
        ...sectionRows.flatMap(row => [row, '']),
        '===== 完整原始請求 JSON =====',
        JSON.stringify(capture.payload, null, 2),
        '',
        '提示：內容可能包含聊天、記憶和角色隱私，分享前請檢查。',
    ].join('\n');
}

/** 搶佔並保存下一次請求；成功時返回抓包 ID，未開啟時返回 null。 */
let captureSaveInFlight: { id: string; promise: Promise<void> } | null = null;

export function captureApiRequestOnce(input: { url: string; body?: unknown; meta?: ApiCallMeta }): string | null {
    if (!claimApiRequestCapture()) return null;
    try {
        const capture = buildApiRequestCapture(input);
        const savePromise = import('./db').then(({ DB }) => DB.saveApiRequestCapture(capture));
        captureSaveInFlight = { id: capture.id, promise: savePromise };
        savePromise.then(
            () => emitCaptureChange('saved'),
            () => emitCaptureChange('error'),
        );
        return capture.id;
    } catch {
        emitCaptureChange('error');
        return null;
    }
}

/** 響應完整讀完後，把同一次請求的真實 usage 回填到一次性抓包。 */
export function updateApiRequestCaptureUsage(input: {
    captureId: string | null;
    ok: boolean;
    response?: unknown;
    responseText?: string;
}): void {
    if (!input.captureId) return;
    try {
        let responseForUsage = input.response;
        if (responseForUsage === undefined && typeof input.responseText === 'string') {
            const scanned = scanSseForLog(input.responseText);
            if (scanned.usage) responseForUsage = { usage: scanned.usage };
        }
        const usage = extractApiTokenUsage(responseForUsage);
        const patch: Partial<ApiRequestCapture> = {
            promptTokens: usage.prompt,
            completionTokens: usage.completion,
            totalTokens: usage.total,
            usageStatus: !input.ok ? 'failed' : usage.prompt != null ? 'reported' : 'not-reported',
        };
        const pending = captureSaveInFlight?.id === input.captureId
            ? captureSaveInFlight.promise.catch(() => {})
            : Promise.resolve();
        pending
            .then(() => import('./db'))
            .then(({ DB }) => DB.patchApiRequestCapture(input.captureId!, patch))
            .then(updated => { if (updated) emitCaptureChange('saved'); })
            .catch(() => emitCaptureChange('error'));
    } catch {
        emitCaptureChange('error');
    }
}

export function recordApiCall(input: {
    /** 同一條 HTTP 請求在顯式記錄與全局 fetch 兜底間共享的 ID，用於原子去重。 */
    requestId?: string;
    url: string;
    body?: unknown;
    status?: number;
    ok: boolean;
    response?: unknown;
    /** 響應原始文本（JSON.parse 失敗時傳入，供 SSE 兜底解析 model / usage） */
    responseText?: string;
    meta?: ApiCallMeta;
    durationMs?: number;
}): void {
    try {
        const baseUrl = deriveBaseUrl(input.url);
        const model = extractModel(input.body);
        // 顯式 meta 優先（safeFetchJson 各調用點傳的精確信息）；沒有就用環境兜底（裸 fetch）。
        const meta = hasMeta(input.meta) ? input.meta! : ambientMeta;
        // 整包 JSON 直接讀；流式響應（response 為空但有原始文本）走 SSE 兜底掃描
        let responseForExtract: unknown = input.response;
        let backendModel: string | undefined =
            typeof (input.response as any)?.model === 'string' && (input.response as any).model
                ? (input.response as any).model : undefined;
        if (input.response === undefined && typeof input.responseText === 'string' && input.responseText.trimStart().startsWith('data:')) {
            const scanned = scanSseForLog(input.responseText);
            backendModel = scanned.model;
            if (scanned.usage) responseForExtract = { usage: scanned.usage };
        }
        const usage = extractApiTokenUsage(responseForExtract);
        const entry: ApiCallLogEntry = {
            id: input.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            presetName: resolvePresetName(baseUrl, model),
            baseUrl,
            model,
            backendModel,
            status: input.status,
            ok: input.ok,
            promptTokens: usage.prompt,
            completionTokens: usage.completion,
            totalTokens: usage.total,
            durationMs: input.durationMs,
            promptBreakdown: buildPromptBreakdown(input.body),
            appId: meta.appId,
            appName: meta.appName,
            charId: meta.charId,
            charName: meta.charName,
            purpose: meta.purpose,
        };
        // 動態 import 避開 safeApi ↔ db 的潛在加載順序問題；寫庫失敗靜默吞掉。
        import('./db')
            .then(({ DB }) => DB.appendApiCallLog(entry))
            .catch(() => {});
    } catch {
        // best-effort：任何異常都不影響主請求
    }
}

// ── 交給雲端跑的那一輪 ────────────────────────────────────────────────
//
// 這條路上本地只發一個 POST 給用戶自己的 Worker，真正那條 `/chat/completions` 是雲端
// 發的——全局 fetch 攔截器只認 `/chat/completions`，夠不著它。不專門記的話，開了即時
// 對話之後「API 調用記錄」裡聊天這一格就是空的，看著像調用憑空消失了。
//
// 同一條記錄分兩筆寫（DB 層按 id 合併非空字段，見 appendApiCallLog）：
//   1. 雲端受理時先落一筆——那會兒只知道「發給誰、用哪個模型、發過去些什麼」；
//   2. 回覆回來時把 Token 補上（雲端隨最後一條推送捎回來）。
// 中間這段時間記錄是 pending，界面上寫「雲端生成中」。

/** 雲端那一輪在本地日誌裡的記錄 id。兩筆寫入靠它對上號，所以兩邊都從 uuid 現算。 */
export const cloudApiCallLogId = (uuid: string): string => `cloud-${uuid}`;

/** 第一筆：雲端收下了這一輪。 */
export function recordCloudApiCall(input: {
    id: string;
    route: ApiCallRoute;
    /** 預設裡存的那個形態（`https://host/v1`），雲端就用這份憑據去發請求。 */
    baseUrl: string;
    model: string;
    /** 交上去的消息數組，用來算輸入構成。 */
    messages: unknown;
    meta?: ApiCallMeta;
    timestamp?: number;
    /**
     * 這一輪連交都沒交上去（POST 就失敗了）。這種記錄當場就是終態，不等回填——
     * 雲端根本沒收下，不會有回覆也不會有用量。輸入構成照記：上傳超時這類失敗正是
     * 「這次包太大了」的直接線索。
     */
    sendFailed?: boolean;
}): void {
    try {
        const baseUrl = stripTrailingSlash(input.baseUrl || '');
        const meta = hasMeta(input.meta) ? input.meta! : ambientMeta;
        const entry: ApiCallLogEntry = {
            id: input.id,
            timestamp: input.timestamp ?? Date.now(),
            route: input.route,
            pending: !input.sendFailed,
            presetName: resolvePresetName(baseUrl, input.model),
            baseUrl,
            model: input.model,
            // 受理成功本身沒出錯；這一輪的成敗等回填那一筆改寫。
            ok: !input.sendFailed,
            promptBreakdown: buildPromptBreakdown({ messages: input.messages }),
            appId: meta.appId,
            appName: meta.appName,
            charId: meta.charId,
            charName: meta.charName,
            purpose: meta.purpose,
        };
        import('./db')
            .then(({ DB }) => DB.appendApiCallLog(entry))
            .catch(() => {});
    } catch {
        // 同 recordApiCall：記日誌不能反過來影響這一輪對話
    }
}

/**
 * 第二筆：雲端那一輪有結論了。
 *
 * 只寫這次才知道的字段，`timestamp` 一個字都不帶——記錄的時間要停在「發起那一刻」，
 * 不然列表順序會隨著回覆先後跳來跳去。第一筆已經被 5 天裁剪掉時這一筆會落空（合併不
 * 上、又沒有時間戳，寫庫時當場被裁掉），正是想要的收場。
 */
export function settleCloudApiCall(input: {
    id: string;
    ok: boolean;
    promptTokens?: number;
    completionTokens?: number;
    /** 見 ApiCallLogEntry.tokensPartial。 */
    tokensPartial?: boolean;
    /** 見 ApiCallLogEntry.superseded。 */
    superseded?: boolean;
}): void {
    try {
        const { promptTokens, completionTokens } = input;
        const patch: Partial<ApiCallLogEntry> & { id: string } = {
            id: input.id,
            pending: false,
            ok: input.ok,
            superseded: input.superseded || undefined,
            promptTokens,
            completionTokens,
            // 雲端只報入和出兩個數，總數這邊自己加——列表頂上的合計讀的是這個字段。
            totalTokens: promptTokens != null && completionTokens != null
                ? promptTokens + completionTokens
                : undefined,
            tokensPartial: input.tokensPartial || undefined,
        };
        import('./db')
            .then(({ DB }) => DB.appendApiCallLog(patch))
            .catch(() => {});
    } catch {
        // 同上
    }
}
