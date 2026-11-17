/**
 * API 備援鏈（plans/api-center-failover.md 第 2 批）——純判斷＋一點模組級狀態（冷卻、換家記號），零依賴。
 *
 * 接在 OSContext 的全局 fetch 攔截器上：一條 /chat/completions 請求失敗（網路錯、逾時、408／429／5xx）
 * 就認出它是哪個槽的（主 API／記憶／情緒日程／主動消息），換鏈裡下一個健康的預設再發一次（URL、Key、model 一起換）。
 * 401／403 和其他 4xx 不算掛（Key 錯或請求體有問題，換家一樣錯）。掛掉的記冷卻，這段時間直接跳過。
 *
 * 換過家之後，雲端那幾行憑據要跟著指到活著的那家：amsgLlmCredentials 的建行函數經 applyFailoverOverride 問一聲。
 */

export type FailoverSlot = 'chat' | 'memory' | 'meter' | 'amsg';
export const FAILOVER_SLOTS: FailoverSlot[] = ['chat', 'memory', 'meter', 'amsg'];
export const FAILOVER_SLOT_LABEL: Record<FailoverSlot, string> = { chat: '主 API', memory: '記憶副 API', meter: '情緒／日程 API', amsg: '主動消息單獨 API' };

export interface SlotApi { baseUrl: string; apiKey: string; model: string }
export interface ChainEntry extends SlotApi { presetId: string; name: string }

/** 掛掉的 API 冷卻多久（這段時間內鏈裡直接跳過它） */
export const FAILOVER_COOLDOWN_MS = 5 * 60_000;

export const normalizeBase = (url: string): string => (url || '').trim().replace(/\/+$/, '').toLowerCase();
export const apiKeyOf = (api: Pick<SlotApi, 'baseUrl' | 'apiKey'>): string => `${normalizeBase(api.baseUrl)}|${(api.apiKey || '').trim()}`;
export const sameApi = (a: Pick<SlotApi, 'baseUrl' | 'apiKey'> | null | undefined, b: Pick<SlotApi, 'baseUrl' | 'apiKey'> | null | undefined): boolean =>
    !!a && !!b && apiKeyOf(a) === apiKeyOf(b);

/** 這種失敗值得換家嗎：網路錯／逾時、408、429、5xx 算；4xx 其他（含 401／403）不算 */
export const isFailoverWorthy = (status: number | undefined, networkError = false): boolean => {
    if (networkError) return true;
    if (!status) return false;
    return status === 408 || status === 429 || status >= 500;
};

/** 從請求的 URL 和 Authorization 認出它是打給哪組 API */
export const requestApiIdentity = (url: string, headers: HeadersInit | undefined): Pick<SlotApi, 'baseUrl' | 'apiKey'> | null => {
    const m = /^(.*?)\/chat\/completions(?:[?#].*)?$/i.exec(url || '');
    if (!m) return null;
    let auth = '';
    if (headers) {
        if (typeof Headers !== 'undefined' && headers instanceof Headers) auth = headers.get('authorization') || '';
        else if (Array.isArray(headers)) auth = (headers.find(([k]) => k.toLowerCase() === 'authorization') || [])[1] || '';
        else auth = (headers as Record<string, string>)['Authorization'] || (headers as Record<string, string>)['authorization'] || '';
    }
    const apiKey = auth.replace(/^Bearer\s+/i, '').trim();
    return { baseUrl: m[1], apiKey };
};

/** 認槽：請求打的那組 API 是哪個槽的主用、或在哪條鏈裡；對不到回 null（別處硬寫的，不管） */
export const identifySlot = (
    api: Pick<SlotApi, 'baseUrl' | 'apiKey'>,
    slots: Partial<Record<FailoverSlot, SlotApi | null>>,
    chains: Partial<Record<FailoverSlot, ChainEntry[]>>,
): FailoverSlot | null => {
    for (const slot of FAILOVER_SLOTS) {
        if (sameApi(slots[slot], api)) return slot;
    }
    for (const slot of FAILOVER_SLOTS) {
        if ((chains[slot] || []).some(e => sameApi(e, api))) return slot;
    }
    return null;
};

// ── 冷卻與換家記號（記憶體，重開頁面歸零） ──

const downUntil = new Map<string, number>();
const overrides = new Map<FailoverSlot, { from: SlotApi; to: SlotApi; until: number }>();
const toasted = new Map<FailoverSlot, string>();

export const markApiDown = (api: Pick<SlotApi, 'baseUrl' | 'apiKey'>, now = Date.now(), cooldownMs = FAILOVER_COOLDOWN_MS): void => { downUntil.set(apiKeyOf(api), now + cooldownMs); };
export const markApiUp = (api: Pick<SlotApi, 'baseUrl' | 'apiKey'>): void => { downUntil.delete(apiKeyOf(api)); };
export const isApiDown = (api: Pick<SlotApi, 'baseUrl' | 'apiKey'>, now = Date.now()): boolean => (downUntil.get(apiKeyOf(api)) || 0) > now;
/** 還要冷卻幾分鐘（給介面看；0＝活著） */
export const apiCooldownMinutes = (api: Pick<SlotApi, 'baseUrl' | 'apiKey'>, now = Date.now()): number => Math.max(0, Math.ceil(((downUntil.get(apiKeyOf(api)) || 0) - now) / 60_000));

/** 鏈裡還能試的（跳過剛失敗的那家和冷卻中的），照順序 */
export const nextCandidates = (chain: ChainEntry[], failed: Pick<SlotApi, 'baseUrl' | 'apiKey'>, now = Date.now()): ChainEntry[] =>
    chain.filter(e => e.baseUrl.trim() && e.apiKey.trim() && e.model.trim() && !sameApi(e, failed) && !isApiDown(e, now));

/** 換家成功後記一筆：這個槽從 from 換到 to，冷卻期內別處（憑據行）也照 to */
export const setFailoverOverride = (slot: FailoverSlot, from: SlotApi, to: SlotApi, now = Date.now(), cooldownMs = FAILOVER_COOLDOWN_MS): void => {
    overrides.set(slot, { from, to, until: now + cooldownMs });
};
export const getFailoverOverride = (slot: FailoverSlot, now = Date.now()): { from: SlotApi; to: SlotApi } | null => {
    const o = overrides.get(slot);
    if (!o) return null;
    if (o.until <= now) { overrides.delete(slot); return null; }
    return { from: o.from, to: o.to };
};
/** 建憑據行、挑 API 時問一聲：這組要是剛掛了而且換過家，就給換到的那家 */
export const applyFailoverOverride = <T extends SlotApi>(slot: FailoverSlot, api: T, now = Date.now()): T | SlotApi => {
    const o = getFailoverOverride(slot, now);
    return o && sameApi(o.from, api) ? o.to : api;
};

/** 同一個槽同一天只 toast 一次 */
export const shouldToastSwitch = (slot: FailoverSlot, dayKey: string): boolean => {
    if (toasted.get(slot) === dayKey) return false;
    toasted.set(slot, dayKey);
    return true;
};

/** 只給測試：清掉所有記憶體狀態 */
export const __resetFailoverState = (): void => { downUntil.clear(); overrides.clear(); toasted.clear(); };

// ── 改寫請求 ──

/** 把一條請求從 from 換到 to：URL 前綴、Authorization、body.model */
export const rewriteRequestForApi = (
    url: string,
    init: RequestInit | undefined,
    from: Pick<SlotApi, 'baseUrl'>,
    to: SlotApi,
): [string, RequestInit] => {
    const m = /^(.*?)(\/chat\/completions(?:[?#].*)?)$/i.exec(url);
    const nextUrl = m ? `${to.baseUrl.replace(/\/+$/, '')}${m[2]}` : url;
    const headers = new Headers(init?.headers || {});
    headers.set('Authorization', `Bearer ${to.apiKey}`);
    let body = init?.body;
    if (typeof body === 'string') {
        try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string') { parsed.model = to.model; body = JSON.stringify(parsed); }
        } catch { /* 非 JSON 就原樣 */ }
    }
    void from;
    return [nextUrl, { ...(init || {}), headers, body }];
};

/** 給調用記錄和日誌看的一句 */
export const describeSwitch = (slot: FailoverSlot, from: Pick<SlotApi, 'baseUrl'> & { name?: string }, to: ChainEntry): string =>
    `${FAILOVER_SLOT_LABEL[slot]}：${from.name || normalizeBase(from.baseUrl)} → ${to.name}`;
