// ===== 捕獲類別（分類日誌的"單一真理源"）=====
// 加新類只動這裡：
//   1. 在 DevDebugCaptureCategory 加一個字面量
//   2. 在 DEV_DEBUG_CAPTURE_CATEGORIES 加一行（面板會自動多出一個開關）
//   3. 需要的話寫一個語義化的 appendDevDebugXxxLog 薄封裝（見文件末尾 appendDevDebugApiLog），或直接用 makeDebugLogger
// 其餘存儲 / 脫敏 / 限容 / 導出邏輯全部通用，不用改。
// 分類按「來源通道」切：api = 普通聊天直發模型；amsg = 主動消息 2.0 的收發鏈路（推送落庫、雲端回合 trace）；
// lifecycle = 頁面前後台/網絡狀態變化（排查「請求等著等著就 NetworkError」時跟 api 類對時間線）。
export type DevDebugCaptureCategory = 'api' | 'amsg' | 'lifecycle' | 'memory-palace';

export interface DevDebugCaptureCategoryMeta {
    key: DevDebugCaptureCategory;
    /** 面板 checkbox 上顯示的短標籤（如 'API' / '主動消息'）。 */
    title: string;
    /** 這一類抓什麼的說明；面板不再渲染（看不懂就別用），僅作源碼內文檔。 */
    detail: string;
}

export const DEV_DEBUG_CAPTURE_CATEGORIES: DevDebugCaptureCategoryMeta[] = [
    {
        key: 'api',
        title: 'API',
        detail: '普通聊天直發模型的 chat completions 請求與響應。',
    },
    {
        key: 'amsg',
        title: '主動消息',
        detail: '主動消息 2.0 的收發鏈路：收件箱沖刷、推送落庫、即時對話回合的 trace。',
    },
    {
        key: 'lifecycle',
        title: '前後台',
        detail: '頁面前後台 / 焦點 / 網絡狀態變化（visibilitychange、focus/blur、pagehide/pageshow、online/offline、freeze/resume），用來跟 api 類對時間線，判斷請求失敗是不是切後台導致的。',
    },
    {
        key: 'memory-palace',
        title: '記憶',
        detail: '記憶召回管線 Trace：入口、版本、開關快照、耗時與結果；不記錄聊天原文和 API Key。',
    },
];

const CAPTURE_CATEGORY_KEYS: DevDebugCaptureCategory[] = DEV_DEBUG_CAPTURE_CATEGORIES.map((c) => c.key);

export interface DevDebugFlags {
    /** Local authored SAR replay / expression editor; never grants real progress. */
    sarExpressionReview: boolean;
    skipPromptBuild: boolean;
    skipEmotionEval: boolean;
    /**
     * 把聊天請求裡的多條 role:system 合併成開頭一條再發送（utils/systemMessageMerge.ts）。
     * 排查逆向中轉對「歷史後 system」重複拼接導致 prompt_tokens 膨脹的兼容問題；
     * 會削弱易變尾段的 recency 注入並破壞前綴緩存，僅作臨時 A/B 對照用。
     */
    mergeSystemMessages: boolean;
    /**
     * 日誌總開關：關掉時無論勾了哪些類別都不抓，默認關。
     * 跟 captureLogs 配合——是否抓 = captureEnabled && captureLogs.includes(category)。
     */
    captureEnabled: boolean;
    /** 勾選了哪些捕獲類別（純選擇）。取消勾選只影響此後抓取，不清已有日誌。 */
    captureLogs: DevDebugCaptureCategory[];
    /**
     * 導出（複製 / 下載）時是否輸出完整內容。
     * 默認 false：長文本摺疊成「前 N 字 + ...」，省隱私 / 省體積。
     * 只影響導出那一層，不改變實際抓取 / 存儲的數據。
     */
    exposeLogDetail: boolean;
    /**
     * amsg2 任務觀察窗（components/Amsg2DebugPanel.tsx）開著沒有。
     * 純觀察不改行為，所以不計進浮球的「生效開關數」紅點——它自己就有個可見的角標。
     */
    amsg2Panel: boolean;
}

export interface DevDebugLogEntry {
    id: string;
    timestamp: string;
    category: DevDebugCaptureCategory;
    /** 列表 / 導出裡用的一行摘要，比如 "POST https://.../chat/completions"。 */
    label?: string;
    /** 抓取時是否摺疊了長文本（即抓的那一刻沒開 exposeLogDetail）。 */
    collapsed?: boolean;
    /** 該類自定義的 payload，寫入前會遞歸脫敏；默認還會摺疊長文本。 */
    data: unknown;
}

export interface DevDebugFloatingPosition {
    x: number;
    y: number;
}

export const DEV_DEBUG_STORAGE_KEY = 'sullyos.devDebug.flags.v1';
export const DEV_DEBUG_EVENT = 'sullyos-dev-debug-change';
export const DEV_DEBUG_LOG_STORAGE_KEY = 'sullyos.devDebug.log.v1';
export const DEV_DEBUG_LOG_EVENT = 'sullyos-dev-debug-log-change';
// 內部事件名，只通過 subscribeDevDebugAvailability 暴露——不 export 出去，免得固化成公共契約。
const DEV_DEBUG_AVAILABILITY_EVENT = 'sullyos-dev-debug-availability';

export const DEFAULT_DEV_DEBUG_FLAGS: DevDebugFlags = {
    sarExpressionReview: false,
    skipPromptBuild: false,
    skipEmotionEval: false,
    mergeSystemMessages: false,
    captureEnabled: false,
    captureLogs: [],
    exposeLogDetail: false,
    amsg2Panel: false,
};

const MAX_LOG_ENTRIES = 100;
const MAX_LOG_STORAGE_CHARS = 1_000_000;
// 只折 messages 這一個 key——別的字段（url、error.reason、response 任意鍵值等）一律原樣保留，
// 免得 reason / outcome / status 這種關鍵短字符串也被截掉。
// messages 數組本身整個換成 ["…共 N 項（已摺疊）"]，一條都不留——首條 system prompt 體積通常很大，
// 留著沒省到多少空間，要看就開「記錄完整內容」。
const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|bearer|token|secret|endpoint|p256dh|auth)$/i;
let memoryLog: DevDebugLogEntry[] | null = null;

function normalizeStorageKeyPart(value: string): string {
    return value.trim().replace(/[^a-z0-9._-]+/gi, '_') || 'unknown';
}

function getBuildBranch(): string {
    return typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : 'unknown';
}

function getScopedStorageKey(baseKey: string): string {
    return `${baseKey}.${normalizeStorageKeyPart(getBuildBranch())}`;
}

function canUseDevDebugStorage(): boolean {
    return isDevDebugAvailable() && typeof window !== 'undefined';
}

function normalizeCaptureLogs(value: unknown): DevDebugCaptureCategory[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<DevDebugCaptureCategory>();
    for (const item of value) {
        // 舊存檔裡的類別名遷到現名，老用戶不丟勾選：'llm' → 'api'，'instant-push' → 'amsg'。
        const migrated = item === 'llm' ? 'api' : item === 'instant-push' ? 'amsg' : item;
        if (CAPTURE_CATEGORY_KEYS.includes(migrated as DevDebugCaptureCategory)) {
            seen.add(migrated as DevDebugCaptureCategory);
        }
    }
    return [...seen];
}

function normalizeFlags(value: unknown): DevDebugFlags {
    const source = (value && typeof value === 'object') ? value as Partial<DevDebugFlags> : {};
    const captureLogs = normalizeCaptureLogs(source.captureLogs);
    // 平滑遷移：老存檔沒 captureEnabled 字段（舊 schema 只有 captureLogs，勾了就抓），
    // 直接推 false 會讓老用戶升級後類型還勾著、其實靜默停錄。所以「字段缺 + 有勾選」時推 true。
    const legacyHasCapture = !('captureEnabled' in source) && captureLogs.length > 0;
    return {
        skipPromptBuild: source.skipPromptBuild === true,
        sarExpressionReview: source.sarExpressionReview === true,
        skipEmotionEval: source.skipEmotionEval === true,
        mergeSystemMessages: source.mergeSystemMessages === true,
        captureEnabled: source.captureEnabled === true || legacyHasCapture,
        captureLogs,
        exposeLogDetail: source.exposeLogDetail === true,
        amsg2Panel: source.amsg2Panel === true,
    };
}

// 會話級開關（都不落 localStorage → 刷新即重置）：
//   manualUnlock：prod 上連點構建版本 5 下臨時解鎖，刷新即關。
//   forceClosed：面板「關閉」按鈕，任意分支強制關掉；刷新後失效 → 非 prod 自動回來。
let devDebugManualUnlock = false;
let devDebugForceClosed = false;

export function isDevDebugAvailable(): boolean {
    if (devDebugForceClosed) return false;
    const badgeVisible = typeof __BUILD_BADGE_VISIBLE__ !== 'undefined' && __BUILD_BADGE_VISIBLE__;
    // 非 prod（badge 可見）默認一直開；prod 默認關，靠 manualUnlock 臨時調出。
    return badgeVisible || devDebugManualUnlock;
}

function emitDevDebugAvailability(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<boolean>(DEV_DEBUG_AVAILABILITY_EVENT, { detail: isDevDebugAvailable() }));
}

/** 連點構建版本 5 下：會話級解鎖面板（刷新即關），並解除強制關閉。 */
export function unlockDevDebug(): void {
    devDebugManualUnlock = true;
    devDebugForceClosed = false;
    // 失效內存緩存：prod 初始 mount 時 canUseDevDebugStorage()=false 會把 memoryLog 鎖成 []，
    // 解鎖後如果不重讀，上一會話存在 localStorage 裡的日誌會被遮蔽，下一次 append 還會覆蓋掉。
    memoryLog = null;
    emitDevDebugAvailability();
}

/** 面板「關閉」按鈕：任意分支強制關掉（會話級；刷新後非 prod 會自動恢復）。 */
export function closeDevDebug(): void {
    devDebugForceClosed = true;
    devDebugManualUnlock = false;
    emitDevDebugAvailability();
}

/** 訂閱「面板是否可用」變化（解鎖 / 關閉）。會話級，無跨標籤頁同步。 */
export function subscribeDevDebugAvailability(listener: (available: boolean) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<boolean>).detail;
        listener(typeof detail === 'boolean' ? detail : isDevDebugAvailable());
    };
    window.addEventListener(DEV_DEBUG_AVAILABILITY_EVENT, onChange);
    return () => window.removeEventListener(DEV_DEBUG_AVAILABILITY_EVENT, onChange);
}

export function readDevDebugFlags(): DevDebugFlags {
    if (!canUseDevDebugStorage()) return DEFAULT_DEV_DEBUG_FLAGS;

    try {
        const raw = window.localStorage.getItem(getScopedStorageKey(DEV_DEBUG_STORAGE_KEY));
        if (!raw) return DEFAULT_DEV_DEBUG_FLAGS;
        return normalizeFlags(JSON.parse(raw));
    } catch {
        return DEFAULT_DEV_DEBUG_FLAGS;
    }
}

export function writeDevDebugFlags(flags: DevDebugFlags): DevDebugFlags {
    const next = normalizeFlags(flags);
    if (!canUseDevDebugStorage()) return next;
    const prev = readDevDebugFlags();

    try {
        window.localStorage.setItem(getScopedStorageKey(DEV_DEBUG_STORAGE_KEY), JSON.stringify(next));
    } catch {
        // localStorage can be blocked in private / embedded contexts; the UI still keeps local state.
    }

    // 取消勾選某類別「不」清它的日誌——勾選是純選擇，只影響此後抓取。
    // 要清日誌走「重置」（面板 resetFlags → clearDevDebugLog）。
    // 例外：總開關 captureEnabled 由 true → false 時清空日誌——一次「錄製週期」結束。
    // 放在數據層而不是 UI handler 裡，是為了讓任何路徑改 captureEnabled 都享受同一行為，
    // 不會因為換個調用點（測試 helper、未來設置鏡像）漏掉。
    if (prev.captureEnabled && !next.captureEnabled) {
        clearDevDebugLog();
    }

    window.dispatchEvent(new CustomEvent<DevDebugFlags>(DEV_DEBUG_EVENT, { detail: next }));
    return next;
}

export function updateDevDebugFlags(updater: (flags: DevDebugFlags) => DevDebugFlags): DevDebugFlags {
    return writeDevDebugFlags(updater(readDevDebugFlags()));
}

export function subscribeDevDebugFlags(listener: (flags: DevDebugFlags) => void): () => void {
    if (typeof window === 'undefined') return () => {};

    const storageKey = getScopedStorageKey(DEV_DEBUG_STORAGE_KEY);
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<DevDebugFlags>).detail;
        listener(detail ? normalizeFlags(detail) : readDevDebugFlags());
    };
    const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey) listener(readDevDebugFlags());
    };

    window.addEventListener(DEV_DEBUG_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(DEV_DEBUG_EVENT, onChange);
        window.removeEventListener('storage', onStorage);
    };
}

export function isPromptBuildSkipped(): boolean {
    return readDevDebugFlags().skipPromptBuild;
}

export function isEmotionEvalSkipped(): boolean {
    return readDevDebugFlags().skipEmotionEval;
}

export function isSystemMessageMergeEnabled(): boolean {
    return readDevDebugFlags().mergeSystemMessages;
}

export function isCaptureEnabled(category: DevDebugCaptureCategory): boolean {
    // 跟可用性綁定：面板看不見就別錄。覆蓋三種「隱身但 flag 還在 localStorage 裡」的場景：
    //   1. 關閉按鈕（devDebugForceClosed=true）
    //   2. prod 刷新後（manualUnlock 重置為 false，但 captureEnabled 還在存檔裡）
    //   3. master 構建（__BUILD_BADGE_VISIBLE__=false，未解鎖）
    // 不擋的話用戶看不到面板還在偷偷寫帶 url/status 的日誌條目——隱私債。
    if (!isDevDebugAvailable()) return false;
    const flags = readDevDebugFlags();
    // 總開關關掉時一律不抓，哪怕該類別勾著。
    return flags.captureEnabled && flags.captureLogs.includes(category);
}

export function redactDevDebugSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactDevDebugSecrets);
    // Multimodal requests may contain a one-frame camera data URL. Debug logs
    // keep its size signal via requestChars, never the actual private pixels.
    if (typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
        return `<image data omitted · ${value.length} chars>`;
    }
    if (!value || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key)) {
            out[key] = '<redacted>';
        } else {
            out[key] = redactDevDebugSecrets(item);
        }
    }
    return out;
}

function safeJsonValue(value: unknown): unknown {
    if (value === undefined) return undefined;
    try {
        return redactDevDebugSecrets(JSON.parse(JSON.stringify(value)));
    } catch {
        return String(value);
    }
}

function parseRequestBody(body: unknown): unknown {
    if (body === undefined || body === null) return undefined;
    if (typeof body !== 'string') return body;
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

// 摺疊 messages（聊天歷史）數組：整組替換成單句 metadata，一條都不留。
function collapseMessagesArray(arr: unknown[]): unknown[] {
    if (arr.length === 0) return arr;
    return [`…共 ${arr.length} 項（已摺疊）`];
}

// 遞歸遍歷對象 / 數組，**只對** key === 'messages' 且值為數組的字段摺疊。
// 其它字段（字符串、數字、布爾、其它數組、其它對象）一律原樣保留——
// 折太多反而看不到 error.reason / response.outcome 這類關鍵字段。
function collapseMessagesInData(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(collapseMessagesInData);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = (key === 'messages' && Array.isArray(item))
                ? collapseMessagesArray(item)
                : collapseMessagesInData(item);
        }
        return out;
    }
    return value;
}

function readPersistedLog(): DevDebugLogEntry[] {
    if (memoryLog) return memoryLog;
    if (!canUseDevDebugStorage()) {
        memoryLog = [];
        return memoryLog;
    }
    try {
        const raw = window.localStorage.getItem(getScopedStorageKey(DEV_DEBUG_LOG_STORAGE_KEY));
        const parsed = raw ? JSON.parse(raw) : [];
        memoryLog = Array.isArray(parsed) ? parsed : [];
    } catch {
        memoryLog = [];
    }
    return memoryLog;
}

function emitLogChange(entries: DevDebugLogEntry[]): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<DevDebugLogEntry[]>(DEV_DEBUG_LOG_EVENT, { detail: entries }));
}

function persistLog(entries: DevDebugLogEntry[]): void {
    memoryLog = entries;
    if (canUseDevDebugStorage()) {
        try {
            window.localStorage.setItem(getScopedStorageKey(DEV_DEBUG_LOG_STORAGE_KEY), JSON.stringify(entries));
        } catch {
            // Keep the in-memory log even when localStorage is full or blocked.
        }
    }
    emitLogChange(entries);
}

/** 讀取捕獲日誌；傳 category 只取該類，不傳取全部。 */
export function readDevDebugLog(category?: DevDebugCaptureCategory): DevDebugLogEntry[] {
    const all = [...readPersistedLog()];
    return category ? all.filter((entry) => entry.category === category) : all;
}

/** 清空日誌；傳 categories 只清這幾類，不傳清全部。 */
export function clearDevDebugLog(categories?: DevDebugCaptureCategory[]): void {
    if (!categories || categories.length === 0) {
        memoryLog = [];
        if (canUseDevDebugStorage()) {
            try {
                window.localStorage.removeItem(getScopedStorageKey(DEV_DEBUG_LOG_STORAGE_KEY));
            } catch {
                // ignore
            }
        }
        emitLogChange([]);
        return;
    }

    const remaining = readPersistedLog().filter((entry) => !categories.includes(entry.category));
    persistLog(remaining);
}

/**
 * 通用捕獲入口：所有分類日誌都走這裡。
 * 自帶門禁（該類沒勾就空操作）、脫敏、摺疊、限容、雙寫（內存 + localStorage）、廣播，調用方不用操心。
 * 默認只折 messages 數組（聊天歷史幾十條會刷屏，留首條 + 計數提示）；其它字段（reason / outcome /
 * url / status / 任意 response 值）原樣保留。開了 exposeLogDetail 後連 messages 也整段存。
 */
export function appendDevDebugLog(category: DevDebugCaptureCategory, input: { label?: string; data: unknown }): void {
    try {
        if (!isCaptureEnabled(category)) return;

        const exposed = readDevDebugFlags().exposeLogDetail;
        const safeData = safeJsonValue(input.data);
        const entry: DevDebugLogEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            category,
            label: input.label,
            collapsed: !exposed,
            data: exposed ? safeData : collapseMessagesInData(safeData),
        };

        const next = [...readPersistedLog(), entry].slice(-MAX_LOG_ENTRIES);
        while (next.length > 1 && JSON.stringify(next).length > MAX_LOG_STORAGE_CHARS) {
            next.shift();
        }
        persistLog(next);
    } catch (e) {
        console.error('Failed to append dev debug log', e);
    }
}

/** HTTP 類日誌的統一形狀。 */
export interface DevDebugHttpLogInput {
    url: string;
    method?: string;
    status?: number;
    requestBody?: unknown;
    response?: unknown;
    error?: unknown;
    /** 本次請求從發起到成功 / 報錯的耗時 ms（重試場景 = 最後一次 attempt 的耗時）。 */
    durationMs?: number;
    /** 響應頭到達耗時 ms（≈排隊 + 服務端開始響應）。與 durationMs 差值 = 收響應體耗時。 */
    headersMs?: number;
    /** 第一段正文增量到達耗時 ms（真 TTFT，僅流式響應有）。大頭在這 = prefill/排隊慢；durationMs-firstDeltaMs 大 = 生成慢。 */
    firstDeltaMs?: number;
}

/** 請求體字符數：messages 摺疊後日志裡看不出請求多大，這個數字補上「體積」維度。 */
function measureRequestChars(body: unknown): number | undefined {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string') return body.length;
    try {
        return JSON.stringify(body)?.length;
    } catch {
        return undefined;
    }
}

/** 通用 HTTP 日誌薄封裝；按 category 落到對應類別，請求體 / 錯誤統一整形。 */
function appendDevDebugHttpLog(category: DevDebugCaptureCategory, input: DevDebugHttpLogInput): void {
    // label 前綴加分類——不同類別的請求 url 可能一字不差（都是 baseUrl + /chat/completions），
    // 不帶前綴的話導出 JSON 裡兩類條目肉眼分不清。
    appendDevDebugLog(category, {
        label: `[${category}] ${input.method ?? 'POST'} ${input.url}`,
        data: {
            url: input.url,
            method: input.method,
            status: input.status,
            durationMs: input.durationMs,
            headersMs: input.headersMs,
            firstDeltaMs: input.firstDeltaMs,
            requestChars: measureRequestChars(input.requestBody),
            request: parseRequestBody(input.requestBody),
            response: input.response,
            error: input.error
                ? {
                    name: (input.error as any)?.name,
                    message: (input.error as any)?.message || String(input.error),
                }
                : undefined,
        },
    });
}

/** api 類：普通聊天直發模型的 chat completions（消費點 safeApi）。 */
export function appendDevDebugApiLog(input: DevDebugHttpLogInput): void {
    appendDevDebugHttpLog('api', input);
}

/** 記憶宮殿結構化 Trace；調用方只傳脫敏後的統計與狀態，不傳 query / prompt 原文。 */
export function appendDevDebugMemoryPalaceLog(input: { label?: string; data: unknown }): void {
    appendDevDebugLog('memory-palace', input);
}

// ===== lifecycle 類：頁面前後台 / 焦點 / 網絡狀態變化 =====
// 用途：跟 api 類條目對時間線。比如某條 API 在 NetworkError 前後緊挨著
// 「visibilitychange → hidden」，基本可以斷定是切後台 / 鎖屏把 fetch 凍死的。
// 監聽器常駐（事件本身低頻、回調零成本），抓不抓由 appendDevDebugLog 的
// isCaptureEnabled('lifecycle') 門禁決定——沒勾時回調直接 return。

let lifecycleCaptureInstalled = false;

function appendLifecycleEvent(event: string, extra?: Record<string, unknown>): void {
    appendDevDebugLog('lifecycle', {
        label: `[lifecycle] ${event}`,
        data: {
            event,
            visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
            online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
            ...extra,
        },
    });
}

/** 安裝 lifecycle 事件捕獲（冪等，App 啟動時掛一次）。 */
export function installDevDebugLifecycleCapture(): void {
    if (lifecycleCaptureInstalled) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    lifecycleCaptureInstalled = true;

    document.addEventListener('visibilitychange', () => {
        appendLifecycleEvent(`visibilitychange → ${document.visibilityState}`);
    });
    window.addEventListener('focus', () => appendLifecycleEvent('window focus'));
    window.addEventListener('blur', () => appendLifecycleEvent('window blur'));
    // pagehide.persisted = true 表示進了 bfcache（頁面被凍結而非銷毀）
    window.addEventListener('pagehide', (e) => appendLifecycleEvent('pagehide', { persisted: (e as PageTransitionEvent).persisted }));
    window.addEventListener('pageshow', (e) => appendLifecycleEvent('pageshow', { persisted: (e as PageTransitionEvent).persisted }));
    window.addEventListener('online', () => appendLifecycleEvent('online'));
    window.addEventListener('offline', () => appendLifecycleEvent('offline'));
    // Page Lifecycle API（Chromium 系才有）：freeze = 後台凍結，resume = 解凍
    document.addEventListener('freeze', () => appendLifecycleEvent('freeze'));
    document.addEventListener('resume', () => appendLifecycleEvent('resume'));
}

export interface DevDebugLogger {
    log(event: string, ...details: unknown[]): void;
    info(event: string, ...details: unknown[]): void;
    debug(event: string, ...details: unknown[]): void;
    warn(event: string, ...details: unknown[]): void;
    error(event: string, ...details: unknown[]): void;
}

/**
 * 模塊級 logger 工廠：把一個模塊跟 (category, tagPrefix) 綁定，業務代碼用 `log.warn(event, ...)`
 * 替代 `console.warn('[Tag] event', ...)`。內部雙寫：
 *   1) `console[level]('[tagPrefix] event', ...details)`——F12 看到的跟以前完全一樣
 *   2) `appendDevDebugLog(category, { label: 'level:Tag event', data: details })`——勾了對應類
 *      就被複制 / 下載導出。
 *
 * gate 由 isCaptureEnabled 自動管，未勾時 step 2 是空操作、零成本。每文件頂部建一次即可，
 * 業務代碼新增日誌只用一行 `log.warn(...)`，自動既上 F12 又進 devDebug——免得每條 console
 * 調用旁邊手抄一行 appendDevDebugLog 容易漏。
 */
export function makeDebugLogger(category: DevDebugCaptureCategory, tagPrefix: string): DevDebugLogger {
    const make = (level: 'log' | 'info' | 'debug' | 'warn' | 'error') =>
        (event: string, ...details: unknown[]): void => {
            try {
                // eslint-disable-next-line no-console -- 故意保留 F12 輸出
                console[level](`[${tagPrefix}] ${event}`, ...details);
            } catch { /* console 不可用就放過 */ }
            appendDevDebugLog(category, {
                label: `${level}:${tagPrefix} ${event}`,
                data: details.length === 0 ? undefined : details.length === 1 ? details[0] : details,
            });
        };
    return {
        log: make('log'),
        info: make('info'),
        debug: make('debug'),
        warn: make('warn'),
        error: make('error'),
    };
}

/**
 * 把捕獲日誌格式化成可複製 / 可下載的 JSON 文本；傳 category 只導該類，無日誌返回空串。
 * 摺疊在寫入層就做完了，這裡直接吐存的內容；帶 `collapsed` 的條目即抓取時沒開 exposeLogDetail。
 */
export function formatDevDebugLog(category?: DevDebugCaptureCategory): string {
    const entries = readDevDebugLog(category);
    if (entries.length === 0) return '';

    const hasCollapsed = entries.some((entry) => entry.collapsed);
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        build: {
            branch: typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : 'unknown',
            commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown',
        },
        ...(hasCollapsed
            ? { note: '部分條目抓取時已摺疊 messages 聊天歷史（整組替換成一句計數）；想要完整內容請先在面板開「記錄完整內容」再復現。' }
            : {}),
        entries,
    }, null, 2);
}

export function subscribeDevDebugLog(listener: (entries: DevDebugLogEntry[]) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<DevDebugLogEntry[]>).detail;
        listener(Array.isArray(detail) ? [...detail] : readDevDebugLog());
    };
    window.addEventListener(DEV_DEBUG_LOG_EVENT, onChange);
    return () => window.removeEventListener(DEV_DEBUG_LOG_EVENT, onChange);
}
