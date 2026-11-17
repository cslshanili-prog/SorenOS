/**
 * 見面線下故事的時間（plans/offline-date-redesign.md 第 5 項）。跟著故事走（DateStory.time）；
 * 還沒開始故事時設的存在角色上（dateNextStoryTime），開新故事時帶進去，跟劇情大綱一樣。
 *
 * 時間來源還有第三種「關閉」（2026-11-17 併掉舊的「線下時間感知」開關）：提示詞不帶時間、記錄不標時間戳，純架空。
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
    !time || (time.source === 'real' && time.flow !== 'frozen');

/** 見面的時間關著（純架空）：時間來源選了「關閉」，或舊的 dateTimeAwarenessEnabled 還是 false */
export const isStoryTimeOff = (char: Pick<CharacterProfile, 'dateTimeAwarenessEnabled' | 'dateNextStoryTime'>, story: Pick<DateStory, 'time'> | null | undefined): boolean =>
    (story ? story.time : char.dateNextStoryTime)?.source === 'off' || char.dateTimeAwarenessEnabled === false;

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
    /** 時間關著（來源「關閉」，取代舊的線下時間感知開關）：提示詞不帶時間、記錄不標時間戳。此時 now 就是現實、map 是原樣 */
    off?: boolean;
}

/** 有在走的故事時鐘（關著的不算）：提示詞裡「故事裡的時間」那幾句用這個判斷 */
export const storyClock = (clock: DateClock | null | undefined): DateClock | null => (clock && !clock.off ? clock : null);
/** 見面要不要帶時間：時鐘關著就不帶（舊的 dateTimeAwarenessEnabled === false 在 makeDateClock 裡已經算成關著） */
export const isDateTimeOn = (clock: DateClock | null | undefined): boolean => !clock?.off;

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
    if (isStoryTimeOff(char, story)) {
        return { now: realNow, frozen: false, custom: false, storyId: story?.id, map: (realMs: number) => realMs, off: true };
    }
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

/**
 * 這場故事的訊息換成故事時間（別場、聊天的不動）。
 * 「距離上次多久」和「哪些訊息標時間」交給 buildMessageHistory 的選項（見 historyTimeOptions），
 * 不再借角色的 timeAwarenessEnabled 開關：那個開關現在一關就連時間戳都不給，借了會把故事時間一起拿掉。
 */
export const applyClockToHistory = (messages: Message[], char: CharacterProfile, clock: DateClock | null): { messages: Message[]; char: CharacterProfile } => {
    if (!clock || clock.off) return { messages, char };
    return {
        messages: messages.map(message => (clock.storyId && message.metadata?.dateStoryId === clock.storyId && typeof message.timestamp === 'number'
            ? { ...message, timestamp: clock.map(message.timestamp) }
            : message)),
        char,
    };
};

/**
 * 見面歷史給 buildMessageHistory 的時間選項：
 * - 線下時間感知關掉：一則都不標、不算距離上次多久（純架空，以前戳還在，模型照樣對得出日期）
 * - 自定義時鐘：只有這場故事的訊息標（已換成故事時間）；聊天記錄、上一場的是另一把尺，不標
 *   （2026-11-17 Liora 實測：設了凌晨三點，模型照著幾十個真實時間戳寫成上個月傍晚）
 * - 真實時鐘（流動或靜止）：照舊都標，只是不算距離上次多久
 */
export const historyTimeOptions = (char: CharacterProfile, clock: DateClock | null): { showTimestamps: boolean | ((m: Message) => boolean); skipTimeGapHint: boolean } => {
    if (clock?.off || char.dateTimeAwarenessEnabled === false) return { showTimestamps: false, skipTimeGapHint: true };
    if (!clock) return { showTimestamps: true, skipTimeGapHint: false };
    return {
        showTimestamps: clock.custom ? (m: Message) => !!clock.storyId && m.metadata?.dateStoryId === clock.storyId : true,
        skipTimeGapHint: true,
    };
};

/** 給模型看的一句：故事裡現在幾點 */
export const describeClockNote = (clock: DateClock): string =>
    [clock.custom ? '這是故事裡的時間，跟現實不同；記錄裡標了時間的都是故事裡的時間。' : '',
        clock.frozen ? '時間停在這一刻，不會往前走。' : ''].filter(Boolean).join('');

/** 每輪貼在用戶那句後面的一小句：故事裡現在幾點（放在最末尾，離生成最近，模型才不會跟著記錄裡的舊時間走） */
export const clockTurnNote = (clock: DateClock, tz?: string): string => `故事裡現在是 ${formatStoryClock(clock, tz)}。`;

/**
 * 一場故事完結後，它的時間設定留給下一場（2026-11-17 Liora 實測：故事進行中設了自定義時間，
 * 按「開始新的故事」新的一場又變回真實——設定存在那場故事身上，完結就跟著走了）。
 * 角色身上另外設了下一場的就用角色的；舊故事是真實＋流動就沒什麼好留的。起算點不帶，開新故事時重算。
 */
export const nextStoryTimeAfter = (char: Pick<CharacterProfile, 'dateNextStoryTime'>, finished: Pick<DateStory, 'time'>): DateStoryTime | undefined => {
    if (!isDefaultStoryTime(char.dateNextStoryTime)) return char.dateNextStoryTime;
    if (isDefaultStoryTime(finished.time)) return undefined;
    const { anchorAt: _anchor, ...rest } = finished.time!;
    return rest;
};

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
