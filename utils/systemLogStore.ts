import type { SystemLog } from '../types';

/**
 * 系統錯誤記錄（2026-10-14）：頂端紅膠囊那份日誌以前只在記憶體裡，清空、重整就沒了。
 *
 * - 存在本機 localStorage（不上傳）。故意不放 IndexedDB：最需要回頭看的錯誤之一就是
 *   「瀏覽器存儲打不開」，那時 IndexedDB 本身就寫不進去。
 * - 最近 7 天、最多 200 筆；單筆的 message / detail 截短，免得一次大報錯把配額吃滿。
 * - 同一個錯誤（類型 + 來源 + 訊息相同）10 分鐘內再發生，合併成一筆、記次數。
 * - 網址參數裡的 key / token 存之前遮掉。
 * - read：紅膠囊只看還沒讀過的；「標為已讀」不刪記錄。上一次打開 App 留下的一律當已讀，
 *   不會一開機就跳紅膠囊——要回頭看到設置裡的「錯誤記錄」翻。
 */

export const SYSTEM_LOG_STORAGE_KEY = 'soren-system-logs-v1';
export const SYSTEM_LOG_MAX = 200;
export const SYSTEM_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SYSTEM_LOG_MERGE_WINDOW_MS = 10 * 60 * 1000;
const MESSAGE_MAX = 500;
const DETAIL_MAX = 2000;

const clip = (text: string | undefined, max: number): string | undefined => {
    if (text === undefined) return undefined;
    return text.length > max ? `${text.slice(0, max)}…（已截斷）` : text;
};

// 有的供應商把 Key 放在網址參數裡（?key=…）；記錄要存 7 天，存之前先遮掉
const SECRET_PARAM_RE = /([?&](?:key|api_key|apikey|api-key|token|access_token|auth)=)[^&\s"']+/gi;
const redact = (text: string | undefined): string | undefined => text?.replace(SECRET_PARAM_RE, '$1***');

const sameError = (a: SystemLog, b: SystemLog) => a.type === b.type && a.source === b.source && a.message === b.message;

/** 新日誌放最前面；跟最近一筆一樣且在合併窗口內就併進去（換成新 id，後續按 id 補寫詳情才找得到）。 */
export function appendSystemLog(prev: SystemLog[], incoming: SystemLog, now: number = incoming.timestamp): SystemLog[] {
    const log: SystemLog = { ...incoming, message: clip(redact(incoming.message), MESSAGE_MAX) || '', detail: clip(redact(incoming.detail), DETAIL_MAX) };
    const fresh = prev.filter(l => now - l.timestamp <= SYSTEM_LOG_TTL_MS);
    const dupIndex = fresh.findIndex(l => sameError(l, log) && log.timestamp - l.timestamp <= SYSTEM_LOG_MERGE_WINDOW_MS);
    if (dupIndex >= 0) {
        const old = fresh[dupIndex];
        const merged: SystemLog = {
            ...log,
            count: (old.count || 1) + 1,
            firstAt: old.firstAt ?? old.timestamp,
            read: false,
        };
        return [merged, ...fresh.filter((_, i) => i !== dupIndex)].slice(0, SYSTEM_LOG_MAX);
    }
    return [{ ...log, read: false }, ...fresh].slice(0, SYSTEM_LOG_MAX);
}

export function loadSystemLogs(now: number = Date.now(), storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): SystemLog[] {
    try {
        const raw = storage?.getItem(SYSTEM_LOG_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((l: any) => l && typeof l.id === 'string' && typeof l.timestamp === 'number' && typeof l.message === 'string')
            .filter((l: SystemLog) => now - l.timestamp <= SYSTEM_LOG_TTL_MS)
            .slice(0, SYSTEM_LOG_MAX)
            // 上一次留下的都當已讀：開機不跳紅膠囊
            .map((l: SystemLog) => ({ ...l, read: true }));
    } catch {
        return [];
    }
}

export function saveSystemLogs(logs: SystemLog[], storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeStorage()): void {
    if (!storage) return;
    if (logs.length === 0) {
        try { storage.removeItem(SYSTEM_LOG_STORAGE_KEY); } catch { /* ignore */ }
        return;
    }
    // 配額不夠就砍半再試，最多試幾次；寫不進去也不能讓錯誤記錄本身再報錯
    let batch = logs;
    for (let attempt = 0; attempt < 4 && batch.length > 0; attempt++) {
        try {
            storage.setItem(SYSTEM_LOG_STORAGE_KEY, JSON.stringify(batch));
            return;
        } catch {
            batch = batch.slice(0, Math.floor(batch.length / 2));
        }
    }
}

export const markAllSystemLogsRead = (logs: SystemLog[]): SystemLog[] =>
    logs.some(l => !l.read) ? logs.map(l => (l.read ? l : { ...l, read: true })) : logs;

export const unreadSystemLogs = (logs: SystemLog[]): SystemLog[] => logs.filter(l => !l.read);

function safeStorage(): Storage | undefined {
    try { return typeof localStorage !== 'undefined' ? localStorage : undefined; } catch { return undefined; }
}
