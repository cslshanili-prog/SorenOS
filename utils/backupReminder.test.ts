import { describe, it, expect, beforeEach } from 'vitest';
import {
    getBackupReminderState,
    setBackupReminderIntervalDays,
    markBackupDone,
    markBackupReminderShown,
    shouldShowBackupReminder,
    daysSinceLastBackup,
    clampReminderDays,
    BACKUP_REMINDER_DEFAULT_DAYS,
} from './backupReminder';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // 固定基準時間，避開 Date.now()

beforeEach(() => {
    localStorage.clear();
});

describe('clampReminderDays', () => {
    it('夾在 1~30，取整，非法值回默認', () => {
        expect(clampReminderDays(0)).toBe(1);
        expect(clampReminderDays(999)).toBe(30);
        expect(clampReminderDays(7.6)).toBe(8);
        expect(clampReminderDays(NaN)).toBe(BACKUP_REMINDER_DEFAULT_DAYS);
    });
});

describe('getBackupReminderState', () => {
    it('首次讀取錨定 firstSeenAt 並回寫，默認間隔 7 天', () => {
        const st = getBackupReminderState(T0);
        expect(st.intervalDays).toBe(BACKUP_REMINDER_DEFAULT_DAYS);
        expect(st.firstSeenAt).toBe(T0);
        expect(st.lastBackupAt).toBe(0);
        // 回寫後再讀，firstSeenAt 不再隨 now 變
        expect(getBackupReminderState(T0 + 5 * DAY).firstSeenAt).toBe(T0);
    });
});

describe('shouldShowBackupReminder', () => {
    it('新用戶剛進來（未到間隔）不彈', () => {
        getBackupReminderState(T0); // 錨 firstSeenAt = T0
        expect(shouldShowBackupReminder(T0 + 3 * DAY)).toBe(false);
    });

    it('從未備份且超過間隔 → 彈', () => {
        getBackupReminderState(T0);
        expect(shouldShowBackupReminder(T0 + 8 * DAY)).toBe(true);
    });

    it('彈過之後進入一個間隔的冷卻，不再連彈', () => {
        getBackupReminderState(T0);
        expect(shouldShowBackupReminder(T0 + 8 * DAY)).toBe(true);
        markBackupReminderShown(T0 + 8 * DAY);
        expect(shouldShowBackupReminder(T0 + 9 * DAY)).toBe(false); // 冷卻中
        expect(shouldShowBackupReminder(T0 + 16 * DAY)).toBe(true);  // 又過了一個間隔
    });

    it('備份成功後不再彈，且清掉提醒冷卻', () => {
        getBackupReminderState(T0);
        markBackupReminderShown(T0 + 8 * DAY);
        markBackupDone(T0 + 9 * DAY);
        expect(getBackupReminderState().lastRemindedAt).toBe(0);
        expect(shouldShowBackupReminder(T0 + 10 * DAY)).toBe(false);
        // 距上次備份再次超過間隔才會重新彈
        expect(shouldShowBackupReminder(T0 + 17 * DAY)).toBe(true);
    });

    it('間隔可調：設成 1 天后隔天就彈', () => {
        getBackupReminderState(T0);
        setBackupReminderIntervalDays(1, T0);
        expect(shouldShowBackupReminder(T0 + 12 * 60 * 60 * 1000)).toBe(false); // 半天
        expect(shouldShowBackupReminder(T0 + 1.5 * DAY)).toBe(true);
    });
});

describe('daysSinceLastBackup', () => {
    it('從未備份返回 null', () => {
        getBackupReminderState(T0);
        expect(daysSinceLastBackup(T0 + 3 * DAY)).toBeNull();
    });
    it('備份後按天數向下取整', () => {
        markBackupDone(T0);
        expect(daysSinceLastBackup(T0 + 3.9 * DAY)).toBe(3);
    });
});
