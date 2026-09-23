/**
 * backupReminder.ts
 * 「該備份啦」提醒的純邏輯 + localStorage 持久化。
 *
 * 背景：糯米機（SullyOS）是 local-first，全部數據只在用戶自己的瀏覽器 IndexedDB 裡，
 * 清緩存 / 換設備 / 崩潰就全沒了。所以隔一段時間沒導出就溫柔提醒一次。
 *
 * 設計：自包含模塊（不進 OSContext 那坨大 interface）。
 *  - 頻率用戶可在「設置 → 備份」裡改，1~30 天，默認 7 天。
 *  - markBackupDone(): 任何一次成功導出/雲備份後調用，推進 lastBackupAt 並清掉提醒態。
 *  - shouldShowBackupReminder(): PhoneShell 用它決定彈不彈。
 *  - 純函數都接受可注入的 now，方便 vitest 直測。
 */

const KEY = 'sullyos_backup_reminder';
const DAY_MS = 24 * 60 * 60 * 1000;

export const BACKUP_REMINDER_MIN_DAYS = 1;
export const BACKUP_REMINDER_MAX_DAYS = 30;
export const BACKUP_REMINDER_DEFAULT_DAYS = 7;

export interface BackupReminderState {
    /** 提醒間隔（天），1~30 */
    intervalDays: number;
    /** 上次成功備份的時間戳（ms）；0 = 從未備份 */
    lastBackupAt: number;
    /** 上次彈過提醒的時間戳（ms）；0 = 從未提醒（提醒後進入一個間隔的冷卻，避免天天彈） */
    lastRemindedAt: number;
    /** 首次見到此設備的時間戳（ms）；從未備份時用它當"多久沒備份"的起算點，避免新用戶一裝就被唸叨 */
    firstSeenAt: number;
}

export const clampReminderDays = (n: number): number => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return BACKUP_REMINDER_DEFAULT_DAYS;
    return Math.min(BACKUP_REMINDER_MAX_DAYS, Math.max(BACKUP_REMINDER_MIN_DAYS, v));
};

const persist = (s: BackupReminderState): void => {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隱私模式等：存不了就算了 */ }
};

/**
 * 讀當前狀態；缺字段用默認補齊。首次讀取（firstSeenAt 為 0）時把它錨到 now 並回寫，
 * 這樣"從未備份"的用戶也有個合理的起算點，不會一進 App 就被提醒。
 */
export function getBackupReminderState(now: number = Date.now()): BackupReminderState {
    let raw: Partial<BackupReminderState> = {};
    try {
        const s = localStorage.getItem(KEY);
        if (s) raw = JSON.parse(s) as Partial<BackupReminderState>;
    } catch { /* 壞 JSON 當空處理 */ }

    const state: BackupReminderState = {
        intervalDays: clampReminderDays(raw.intervalDays ?? BACKUP_REMINDER_DEFAULT_DAYS),
        lastBackupAt: Number(raw.lastBackupAt) || 0,
        lastRemindedAt: Number(raw.lastRemindedAt) || 0,
        firstSeenAt: Number(raw.firstSeenAt) || 0,
    };
    if (state.firstSeenAt === 0) {
        state.firstSeenAt = now;
        persist(state);
    }
    return state;
}

/** 設置提醒頻率（天），返回落庫後的新狀態。 */
export function setBackupReminderIntervalDays(days: number, now: number = Date.now()): BackupReminderState {
    const next = { ...getBackupReminderState(now), intervalDays: clampReminderDays(days) };
    persist(next);
    return next;
}

/** 一次成功備份後調用：推進 lastBackupAt，並清掉提醒冷卻（下次到點重新算）。 */
export function markBackupDone(now: number = Date.now()): void {
    persist({ ...getBackupReminderState(now), lastBackupAt: now, lastRemindedAt: 0 });
}

/** 彈過提醒後調用：記下時間，進入一個間隔的冷卻，避免反覆彈。 */
export function markBackupReminderShown(now: number = Date.now()): void {
    persist({ ...getBackupReminderState(now), lastRemindedAt: now });
}

/**
 * 是否該彈提醒：
 *  - 距上次備份（從未備份則距首見）已超過 intervalDays，且
 *  - 距上次提醒也已超過 intervalDays（提醒冷卻；備份成功會把它清 0，於是自然不再彈）。
 */
export function shouldShowBackupReminder(now: number = Date.now()): boolean {
    const st = getBackupReminderState(now);
    const intervalMs = st.intervalDays * DAY_MS;
    const backupAnchor = st.lastBackupAt > 0 ? st.lastBackupAt : st.firstSeenAt;
    if (now - backupAnchor < intervalMs) return false;
    if (now - st.lastRemindedAt < intervalMs) return false;
    return true;
}

/** 距上次備份過了幾天（向下取整）；從未備份返回 null。給彈窗文案用。 */
export function daysSinceLastBackup(now: number = Date.now()): number | null {
    const st = getBackupReminderState(now);
    if (st.lastBackupAt <= 0) return null;
    return Math.max(0, Math.floor((now - st.lastBackupAt) / DAY_MS));
}
