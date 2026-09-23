import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { getDailyScheduleForChar } from './dailySchedule';
import { getScheduleWallClock } from './scheduleTime';
import { getCurrentSlot } from './charMusicSchedule';
import { classifyScheduleSlot } from './readNoReply';
import { computeReplyDelayMs, getPendingDelayedReply, scheduleDelayedReply, type PendingDelayedReply } from './delayedReply';

/** 上一則角色訊息在這段時間內 → 算「正聊得起勁」，回得快一點。 */
const RECENTLY_ACTIVE_MS = 10 * 60 * 1000;

/**
 * 用戶發完訊息後，替開了「延遲自動回覆」的角色排好回覆時刻。已經排著的不動。
 * 等多久：用戶設的範圍 × 角色此刻的日程（睡覺／在忙／空閒）× 剛剛是不是正聊著。
 */
export async function scheduleDelayedReplyFor(char: CharacterProfile, recentMessages?: Message[]): Promise<PendingDelayedReply | null> {
    if (!char.delayedReply?.enabled) return null;
    const existing = getPendingDelayedReply(char.id);
    if (existing) return existing;
    const schedule = await getDailyScheduleForChar(char).catch(() => null);
    const slotKind = classifyScheduleSlot(getCurrentSlot(schedule, getScheduleWallClock(char)));
    const recent = recentMessages ?? await DB.getRecentMessagesByCharId(char.id, 30, true).catch(() => [] as Message[]);
    const lastAssistant = [...recent].reverse().find(m => m.role === 'assistant');
    const recentlyActive = !!lastAssistant && Date.now() - lastAssistant.timestamp < RECENTLY_ACTIVE_MS;
    return scheduleDelayedReply(char.id, computeReplyDelayMs(char.delayedReply, { slotKind, recentlyActive }));
}
