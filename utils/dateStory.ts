/**
 * 見面的線下故事（plans/offline-date-redesign.md「線下故事」）。
 *
 * - 一個角色同時只有一場進行中（CharacterProfile.activeDateStoryId）；「繼續上次」就是繼續這場
 * - 開場那一刻建故事；之後這場的見面訊息都在 metadata.dateStoryId 記著故事 id
 * - 舊版沒有故事：有存檔（savedDateState）的角色第一次進來時，從最後一次開場起轉成一場進行中的故事，
 *   那段的舊訊息補上 dateStoryId（不用「某個 id 之後都算」：完結後再出現的沒標訊息會被它吞掉）
 * - 劇情大綱跟著故事走；角色身上的 dateScenario 是「下一場的大綱」，開新故事時搬進來並清掉
 */

import type { CharacterProfile, DateStory, Message } from '../types';
import { DB } from './db';
import { startStoryTime } from './dateStoryTime';

export const DATE_STORY_UPDATED_EVENT = 'soren-date-story-updated';

const notify = () => {
    try { window.dispatchEvent(new Event(DATE_STORY_UPDATED_EVENT)); } catch { /* 測試環境沒有 window */ }
};

const makeId = () => `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const isDateMessage = (message: Message): boolean => message.metadata?.source === 'date';

/** 這則見面訊息屬不屬於這場故事 */
export const messageBelongsToStory = (message: Message, story: DateStory): boolean =>
    isDateMessage(message) && message.metadata?.dateStoryId === story.id;

/** 新存的見面訊息要帶的 metadata */
export const storyTag = (story: DateStory | null | undefined): { dateStoryId?: string } =>
    story ? { dateStoryId: story.id } : {};

export const saveDateStory = async (story: DateStory): Promise<DateStory> => {
    const next = { ...story, updatedAt: Date.now() };
    await DB.saveDateStory(next);
    notify();
    return next;
};

/** 改故事的部分欄位：先讀庫裡最新的再合併，別拿手上可能過期的那份整個蓋回去 */
export const patchDateStory = async (id: string, patch: Partial<DateStory> | ((prev: DateStory) => Partial<DateStory>)): Promise<DateStory | null> => {
    const current = await DB.getDateStory(id);
    if (!current) return null;
    const changes = typeof patch === 'function' ? patch(current) : patch;
    return saveDateStory({ ...current, ...changes, id: current.id, charId: current.charId });
};

/** 角色進行中的故事；指到的那場不在了或已完結就當沒有 */
export const loadActiveDateStory = async (char: CharacterProfile | null | undefined): Promise<DateStory | null> => {
    if (!char?.activeDateStoryId) return null;
    const story = await DB.getDateStory(char.activeDateStoryId);
    return story && story.status === 'ongoing' && story.charId === char.id ? story : null;
};

export const buildNewDateStory = (char: CharacterProfile, now = Date.now(), extra: Partial<DateStory> = {}): DateStory => ({
    id: makeId(),
    charId: char.id,
    status: 'ongoing',
    ...(char.dateScenario?.trim() ? { scenario: char.dateScenario.trim() } : {}),
    ...(startStoryTime(char.dateNextStoryTime, now) ? { time: startStoryTime(char.dateNextStoryTime, now) } : {}),
    createdAt: now,
    updatedAt: now,
    ...extra,
});

/**
 * 開一場新故事：存進表裡，回傳故事和要寫回角色的欄位（activeDateStoryId、清掉已搬走的 dateScenario）。
 * 角色欄位交給呼叫的人用 updateCharacter 寫，跟其它角色更新走同一條路。
 */
export const startDateStory = async (char: CharacterProfile, extra: Partial<DateStory> = {}): Promise<{ story: DateStory; charPatch: Partial<CharacterProfile> }> => {
    const story = buildNewDateStory(char, Date.now(), extra);
    await DB.saveDateStory(story);
    notify();
    return { story, charPatch: { activeDateStoryId: story.id, dateScenario: undefined, dateNextStoryTime: undefined } };
};

/** 完結：故事標成已完結，回傳要寫回角色的欄位（清掉 activeDateStoryId 和存檔） */
export const completeDateStory = async (story: DateStory): Promise<{ story: DateStory; charPatch: Partial<CharacterProfile> }> => {
    const now = Date.now();
    const latest = (await DB.getDateStory(story.id)) || story;
    const next: DateStory = { ...latest, status: 'completed', completedAt: now, updatedAt: now };
    await DB.saveDateStory(next);
    notify();
    return { story: next, charPatch: { activeDateStoryId: undefined, savedDateState: undefined } };
};

/** 舊版的存檔：從最後一次開場起算一場進行中的故事 */
export const legacyStoryStart = (dateMessages: Message[]): number | undefined => {
    let start: number | undefined;
    for (const message of dateMessages) {
        if (isDateMessage(message) && message.metadata?.isOpening === true && !message.metadata?.dateStoryId && !message.metadata?.valentineEvent) {
            if (start === undefined || message.id > start) start = message.id;
        }
    }
    return start;
};

/** 有舊存檔、還沒有故事的角色：轉一場進行中的故事出來（沒存檔的舊見面不轉，就留在見面記錄裡） */
export const migrateLegacyDateStory = async (
    char: CharacterProfile,
    dateMessages: Message[],
): Promise<{ story: DateStory; charPatch: Partial<CharacterProfile> } | null> => {
    if (!char.savedDateState || char.activeDateStoryId) return null;
    const from = legacyStoryStart(dateMessages);
    if (from === undefined) return null;
    const opening = dateMessages.find(message => message.id === from);
    const started = await startDateStory(char, { legacyFromMessageId: from, ...(opening ? { createdAt: opening.timestamp } : {}) });
    const members = legacyStoryMembers(dateMessages, from);
    for (const message of members) {
        await DB.updateMessageMetadata(message.id, prev => ({ ...(prev || {}), dateStoryId: started.story.id }));
    }
    return started;
};

/** 舊存檔那段：開場起、還沒標故事的見面訊息（情人節活動那種另算） */
export const legacyStoryMembers = (dateMessages: Message[], from: number): Message[] =>
    dateMessages.filter(message => isDateMessage(message) && message.id >= from && !message.metadata?.dateStoryId && !message.metadata?.valentineEvent);

/** 講給人看的名字：用戶取的，或「9月3日開始」 */
export const dateStoryLabel = (story: DateStory): string => {
    if (story.title?.trim()) return story.title.trim();
    const date = new Date(story.createdAt);
    return `${date.getMonth() + 1}月${date.getDate()}日開始的故事`;
};

/** 帶上這場故事的大綱給提示詞用（提示詞那邊讀的是 char.dateScenario） */
export const withStoryScenario = (char: CharacterProfile, story: DateStory | null | undefined): CharacterProfile =>
    story ? { ...char, dateScenario: story.scenario } : char;
