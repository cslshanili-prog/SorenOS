/**
 * 見面線下故事的時間（plans/offline-date-redesign.md 第 5 項）。跟著故事走（DateStory.time）；
 * 還沒開始故事時設的存在角色上（dateNextStoryTime），開新故事時帶進去，跟劇情大綱一樣。
 *
 * |        | 流動 | 靜止 |
 * |--------|------|------|
 * | 真實   | 現狀：跟著角色時區的現實時間 | 定格在設定那一刻（開新故事時就是故事開始那一刻） |
 * | 自定義 | 從填的時間起，跟著現實經過的時間往前走（Liora 定的 A） | 停在填的時間 |
 *
 * 填的時間是角色那邊的牆上時間（docs/character-timezone.md：給角色看的時間一律按角色時區）。
 * 「真實＋流動」就是原本的樣子，什麼都不改；其餘三種在提示詞裡換掉「現在幾點」，
 * 這場故事的訊息時間也照同一個鐘換算，不然模型看到的記錄時間跟「現在」對不上。
 */

import type { CharacterProfile, DateStory, DateStoryTime, Message } from '../types';
import { nowInTimeZone, resolveCharTimeZone, wallClockToTimestamp } from './timezone';

export const isDefaultStoryTime = (time: DateStoryTime | undefined | null): boolean =>
    !time || (time.source !== 'custom' && time.flow !== 'frozen');

/** 這場故事的時鐘：把現實時刻換成故事裡的時刻 */
export interface DateClock {
    /** 故事裡的「現在」（絕對時間戳，照角色時區格式化） */
    now: number;
    /** 時間停著不走 */
    frozen: boolean;
    /** 自定義的時間（不是現實） */
    custom: boolean;
    /** 這場故事的 id：只有這場的訊息時間要換 */
    storyId?: string;
    /** 現實時刻 → 故事時刻 */
    map: (realMs: number) => number;
}

/** 生效的時間設定：進行中的故事用自己的，還沒開始就用角色身上那份 */
export const effectiveStoryTime = (char: CharacterProfile, story: DateStory | null | undefined): DateStoryTime | undefined =>
    story ? story.time : char.dateNextStoryTime;

/** 預設（真實＋流動）回 null：呼叫端照原本的路走 */
export const makeDateClock = (
    char: CharacterProfile,
    story: DateStory | null | undefined,
    realNow = Date.now(),
): DateClock | null => {
    const time = effectiveStoryTime(char, story);
    if (isDefaultStoryTime(time)) return null;
    const anchor = time!.anchorAt ?? realNow;
    const frozen = time!.flow === 'frozen';
    let base = anchor;
    if (time!.source === 'custom') {
        const custom = time!.customStart ? wallClockToTimestamp(time!.customStart, resolveCharTimeZone(char)) : NaN;
        // 自定義沒填或填壞了：當成真實
        if (!Number.isFinite(custom)) {
            if (!frozen) return null;
        } else {
            base = custom;
        }
    }
    const map = (realMs: number) => (frozen ? base : base + (realMs - anchor));
    return { now: map(realNow), frozen, custom: time!.source === 'custom', storyId: story?.id, map };
};

/** 這場故事的訊息換成故事時間（別場、聊天的不動）；也關掉「距離上次多久」，兩把尺混在一起算出來是亂的 */
export const applyClockToHistory = (messages: Message[], char: CharacterProfile, clock: DateClock | null): { messages: Message[]; char: CharacterProfile } => {
    if (!clock) return { messages, char };
    return {
        messages: messages.map(message => (clock.storyId && message.metadata?.dateStoryId === clock.storyId && typeof message.timestamp === 'number'
            ? { ...message, timestamp: clock.map(message.timestamp) }
            : message)),
        char: { ...char, timeAwarenessEnabled: false },
    };
};

/** 給模型看的一句：故事裡現在幾點 */
export const describeClockNote = (clock: DateClock): string =>
    [clock.custom ? '這是故事裡的時間，跟現實不同；聊天記錄（[聊天]）上的時間是現實的。' : '',
        clock.frozen ? '時間停在這一刻，不會往前走。' : ''].filter(Boolean).join('');

/** 新故事的時間設定：帶進故事、從故事開始那一刻起算 */
export const startStoryTime = (draft: DateStoryTime | undefined, startAt: number): DateStoryTime | undefined =>
    isDefaultStoryTime(draft) ? undefined : { ...draft!, anchorAt: startAt };

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const pad = (n: number) => String(n).padStart(2, '0');
/** 故事裡的「現在」照角色時區寫成「2026-11-07 21:30 週六」（給設定頁預覽和自訂預設用） */
export const formatStoryClock = (clock: Pick<DateClock, 'now'>, tz?: string): string => {
    const d = nowInTimeZone(tz, new Date(clock.now));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${WEEKDAYS[d.getDay()]}`;
};
