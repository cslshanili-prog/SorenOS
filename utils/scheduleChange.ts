import type { CharacterProfile, DailySchedule, ScheduleSlot } from '../types';
import { DB } from './db';
import { getDailyScheduleForChar } from './dailySchedule';
import { getCurrentScheduleSlotIndex, getScheduleWallClock } from './scheduleTime';
import { getLocalDateKey } from './localDate';
import { extractScheduleChangeDirectives } from './scheduleChangeParse';
import type { ExtractedScheduleChanges, ScheduleChangeDirective } from './scheduleChangeParse';

export const SCHEDULE_CHANGE_EVENT = 'schedule-change-applied';

// 解析層住在 utils/scheduleChangeParse.ts —— 那是零依賴葉子，worker 側的業務標籤
// classifier 也要用它（見那份文件頂部的說明）。這裡轉發一道，現有調用點不用改 import。
export type { ExtractedScheduleChanges, ScheduleChangeDirective } from './scheduleChangeParse';
export { extractScheduleChangeDirectives } from './scheduleChangeParse';

export interface AppliedScheduleChange {
    startTime: string;
    before: string;
    after: string;
}

export interface ScheduleChangeEventDetail {
    charId: string;
    date: string;
    changes: AppliedScheduleChange[];
    schedule: DailySchedule;
    eventId: string;
}

export interface AppliedScheduleChangeResult extends ExtractedScheduleChanges {
    schedule: DailySchedule | null;
    changes: AppliedScheduleChange[];
    rejectedCount: number;
    /**
     * rejectedCount > 0 時說明是哪一種拒絕，給調用方拼準確的提示語用。
     * `cross-day` 是這句話不是今天說的、整批作廢；`no-slot` 是今天的表裡沒有能落的時段。
     */
    rejectedReason?: 'cross-day' | 'no-slot';
}

const minutesOf = (time: string): number | null => {
    const matched = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
    if (!matched) return null;
    const hour = Number(matched[1]);
    const minute = Number(matched[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
};

/**
 * 純數據層：只允許命中已有的時段，且只能是當前正在進行的這一條或它之後的；
 * 無法確定目標時寧可不改。
 *
 * 「當前這一條也能改」是有意為之：夜裡最後一條日程通常是睡覺，人卻還在聊天，
 * 角色說「今晚不睡了陪你」時得有地方落，否則它讀到的當前時段永遠停在睡覺上，
 * 每一輪都被這條硬事實推著去道晚安。已經過去的時段仍然改不了——那是既成事實。
 */
export const applyScheduleChanges = (
    schedule: DailySchedule,
    directives: ScheduleChangeDirective[],
    char?: Pick<CharacterProfile, 'customTimezoneEnabled' | 'customTimezone'> | null,
    at: Date = new Date(),
): { schedule: DailySchedule; changes: AppliedScheduleChange[]; rejectedCount: number } => {
    const wallNow = getScheduleWallClock(char, at);
    const currentMinutes = wallNow.getHours() * 60 + wallNow.getMinutes();
    const slots: ScheduleSlot[] = schedule.slots.map((slot) => ({ ...slot }));
    // 「當前是第幾條」跟日程卡 / 首頁小組件 / 日程注入用同一個函數。兩邊說的必須是同一條，
    // 否則界面高亮成「此刻」的那條，在這裡會被判成不可改。
    const currentIndex = getCurrentScheduleSlotIndex(slots, char, at);
    const changeByTime = new Map<string, AppliedScheduleChange>();
    let rejectedCount = 0;

    for (const directive of directives) {
        const targetMinutes = minutesOf(directive.startTime);
        // 未來的時段一律可改；已經開始的只放行當前這一條，更早的屬於既成事實。
        // 落點先在「當前時段及之後」這一段裡找：同一個 startTime 萬一出現兩次，
        // 要改的是還沒過去的那條，而不是數組裡排在前面的那條。
        const editableFrom = currentIndex < 0 ? 0 : currentIndex;
        let slotIndex = slots.findIndex(
            (slot, i) => i >= editableFrom && slot.startTime === directive.startTime,
        );
        // 日程表理應按時間排好；萬一亂序，位置靠前但時刻確實在未來的時段也該能改。
        if (slotIndex < 0 && targetMinutes != null && targetMinutes > currentMinutes) {
            slotIndex = slots.findIndex((slot) => slot.startTime === directive.startTime);
        }
        if (slotIndex < 0) {
            rejectedCount += 1;
            continue;
        }

        const slot = slots[slotIndex];
        if (slot.activity.trim() === directive.activity.trim()) continue;
        const originalBefore = changeByTime.get(directive.startTime)?.before ?? slot.activity;
        slots[slotIndex] = {
            startTime: slot.startTime,
            activity: directive.activity.trim(),
            // 原描述、地點、獨白和小劇場都圍繞舊活動生成，保留會立即穿幫。
            ...(slot.emoji ? { emoji: slot.emoji } : {}),
        };
        changeByTime.set(directive.startTime, {
            startTime: directive.startTime,
            before: originalBefore,
            after: directive.activity.trim(),
        });
    }

    const changes = [...changeByTime.values()];
    if (changes.length === 0) return { schedule, changes, rejectedCount };
    return {
        schedule: {
            ...schedule,
            slots,
            // 整日意識流同樣基於舊計劃生成；清掉後回落到當前 slot 的獨白，避免安排都改了、念頭仍舊。
            flowNarrative: undefined,
        },
        changes,
        rejectedCount,
    };
};

/**
 * 解析模型回覆、落庫成功的日程改動，並返回供聊天 UI 展示的差異。
 *
 * `at` 是**這句話說出口的時刻**，不是處理它的時刻。本地聊天兩者只差幾秒，主動消息
 * 差得可以很遠：昨晚 22:05 發出的「22:00 改成陪你聊天」，用戶今早九點才打開 App。
 * 按處理時刻判的話，那條會落到**今天**的 22:00 上——角色昨晚的一句話，改了今天的安排。
 * 所以調用方要把 push 的 sentAt 傳進來，隔天的整批直接丟棄（見下面的日曆日門檻）。
 */
export const applyAssistantScheduleChanges = async (
    text: string,
    char: Pick<CharacterProfile, 'id' | 'customTimezoneEnabled' | 'customTimezone'>,
    at: Date = new Date(),
): Promise<AppliedScheduleChangeResult> => {
    const extracted = extractScheduleChangeDirectives(text);
    if (extracted.directives.length === 0) {
        return { ...extracted, schedule: null, changes: [], rejectedCount: 0 };
    }
    const applied = await applyScheduleChangeDirectives(extracted.directives, char, at);
    return { ...extracted, ...applied };
};

/**
 * 落庫那半邊：已經拿到 directives 之後的取表 → 改 → 存。
 *
 * 單獨開一個口子，是因為改動不只從聊天正文來。角色在後台改自己的日程時，那一輪可能
 * 一個字都沒說，指令是隨雲端結果（`schedule-change`，見 utils/amsgScheduleResult.ts）
 * 回來的，沒有正文可解析。兩條路都走這裡，「哪條時段能改」「隔天怎麼算」只有一套說法。
 *
 * `at` 同樣是**說出口**的時刻，不是處理它的時刻。
 */
export const applyScheduleChangeDirectives = async (
    directives: ScheduleChangeDirective[],
    char: Pick<CharacterProfile, 'id' | 'customTimezoneEnabled' | 'customTimezone'>,
    at: Date = new Date(),
): Promise<Omit<AppliedScheduleChangeResult, keyof ExtractedScheduleChanges>> => {
    if (directives.length === 0) {
        return { schedule: null, changes: [], rejectedCount: 0 };
    }

    // 日曆日門檻：說出口那天不是角色當地的今天，這批改動就已經沒有落點了
    // ——今天的日程是另一張表，昨天的意思不該蓋到它頭上。整批算作拒絕，
    // 調用方照常收到 rejectedCount，但一個字都不落庫。
    const sameDay = getLocalDateKey(getScheduleWallClock(char, at))
        === getLocalDateKey(getScheduleWallClock(char, new Date()));
    if (!sameDay) {
        return { schedule: null, changes: [], rejectedCount: directives.length, rejectedReason: 'cross-day' };
    }

    // 上面的日曆日門檻已經保證「說出口那天」就是角色當地的今天，所以這裡要的就是今天
    // 那張表，用「現在」去取。傳 at 會讓表內的 legacy key 兜底按**設備**時區折算日期，
    // 跨時區角色可能因此探到另一天的舊鍵。
    const schedule = await getDailyScheduleForChar(char);
    if (!schedule) {
        return { schedule: null, changes: [], rejectedCount: directives.length, rejectedReason: 'no-slot' };
    }

    const applied = applyScheduleChanges(schedule, directives, char, at);
    if (applied.changes.length > 0) await DB.saveDailySchedule(applied.schedule);
    return {
        ...applied,
        // 只在一條都沒落地時才給原因。部分成功的批次（兩條指令落了一條）掛上 'no-slot'
        // 是在說謊——這個字段是給調用方拼「為什麼沒改成」用的，而那種情況已經改成了。
        ...(applied.changes.length === 0 && applied.rejectedCount > 0
            ? { rejectedReason: 'no-slot' as const }
            : {}),
    };
};

export const announceScheduleChanges = (
    charId: string,
    schedule: DailySchedule,
    changes: AppliedScheduleChange[],
): void => {
    if (changes.length === 0 || typeof window === 'undefined') return;
    const detail: ScheduleChangeEventDetail = {
        charId,
        date: schedule.date,
        changes,
        schedule,
        eventId: `${charId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
    window.dispatchEvent(new CustomEvent<ScheduleChangeEventDetail>(SCHEDULE_CHANGE_EVENT, { detail }));
};
