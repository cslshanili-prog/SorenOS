import { CharacterProfile, DailySchedule } from '../types';
import { DB } from './db';
import { getLocalDateKey } from './localDate';
import { nowInTimeZone, resolveCharTimeZone } from './timezone';

/**
 * Load a schedule for the requested calendar timezone (device time by default).
 *
 * Older builds keyed schedules by UTC date or by the phone's date. If the target
 * key is absent, a legacy record is reused only when its generatedAt belongs to
 * today in the requested timezone. Historical records are deliberately untouched.
 */
export async function getLocalDailySchedule(
    charId: string,
    at: Date = new Date(),
    timeZone?: string,
): Promise<DailySchedule | null> {
    const localKey = getLocalDateKey(nowInTimeZone(timeZone, at));
    /** 這份日程是不是「今天」在角色當地生成的。 */
    const belongsToToday = (record: DailySchedule): boolean =>
        Number.isFinite(record.generatedAt)
        && getLocalDateKey(nowInTimeZone(timeZone, new Date(record.generatedAt))) === localKey;

    const current = await DB.getDailySchedule(charId, localKey);
    // 命中也要驗 generatedAt：開啟自定義時區之前按手機日寫下的記錄，
    // 其 key 可能正好等於今天的角色當地日，但內容是角色那邊前一天的。
    // 不驗就會把昨天的日程當成今天的接著用，而且當天不會再重新生成。
    if (current && belongsToToday(current)) return current;

    // 兼容兩類舊 key：
    // 1) 更早版本按 UTC 日寫入；
    // 2) 角色時區支持接入前按手機日寫入。
    // 只有 generatedAt 在角色當地確實屬於“今天”時才遷移，歷史日程絕不挪動。
    const legacyKeys = [
        getLocalDateKey(at),
        at.toISOString().slice(0, 10),
    ].filter((key, index, all) => key !== localKey && all.indexOf(key) === index);

    for (const legacyKey of legacyKeys) {
        const legacy = await DB.getDailySchedule(charId, legacyKey);
        if (!legacy || !belongsToToday(legacy)) continue;

        const migrated: DailySchedule = {
            ...legacy,
            id: `${charId}_${localKey}`,
            charId,
            date: localKey,
        };
        await DB.saveDailySchedule(migrated);
        // 搬走而不是複製：留著舊 key 的話，等角色當地日曆翻到那個日期時會被
        // 上面的命中分支再取一次，同一份日程就被當成兩天用了。
        await DB.deleteDailySchedule(charId, legacyKey);
        return migrated;
    }
    return null;
}

/** 按角色自己的日曆日讀取日程；未開啟自定義時區時保持原本的手機時間行為。 */
export function getDailyScheduleForChar(
    char: Pick<CharacterProfile, 'id' | 'customTimezoneEnabled' | 'customTimezone'>,
    at: Date = new Date(),
): Promise<DailySchedule | null> {
    return getLocalDailySchedule(char.id, at, resolveCharTimeZone(char));
}
