import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { getDailyScheduleForChar } from './dailySchedule';
import { getScheduleWallClock } from './scheduleTime';
import { getCurrentSlot } from './charMusicSchedule';
import { classifyScheduleSlot } from './readNoReply';
import { computeReplyDelayMs, getPendingDelayedReply, normalizeDelayedReply, replyDelayBand, scheduleDelayedReply, type PendingDelayedReply } from './delayedReply';
import { makeDebugLogger } from './devDebug';

const log = makeDebugLogger('delayed-reply', '延遲自動回覆');

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
    const slot = getCurrentSlot(schedule, getScheduleWallClock(char));
    const slotKind = classifyScheduleSlot(slot);
    const recent = recentMessages ?? await DB.getRecentMessagesByCharId(char.id, 30, true).catch(() => [] as Message[]);
    const lastAssistant = [...recent].reverse().find(m => m.role === 'assistant');
    const recentlyActive = !!lastAssistant && Date.now() - lastAssistant.timestamp < RECENTLY_ACTIVE_MS;
    const delayMs = computeReplyDelayMs(char.delayedReply, { slotKind, recentlyActive });
    const entry = scheduleDelayedReply(char.id, delayMs);
    // 開發面板「延遲回覆」：之後有「怎麼又壓線」的反饋，一看就知道是判斷的問題還是剛好抽到尾巴
    const { minMinutes, maxMinutes } = normalizeDelayedReply(char.delayedReply);
    const [lo, hi] = replyDelayBand({ slotKind, recentlyActive });
    log.info('排好回覆時間', {
        char: char.name,
        slot: slot ? `${slot.startTime || ''} ${slot.activity || ''}${slot.emoji ? ` ${slot.emoji}` : ''}`.trim() : '（沒有日程）',
        state: slotKind === 'sleep' ? '睡覺' : slotKind === 'busy' ? '在忙' : recentlyActive ? '空閒・正聊著' : '空閒',
        range: `${minMinutes}–${maxMinutes} 分`,
        band: `${Math.round(lo * 100)}%–${Math.round(hi * 100)}%`,
        afterMinutes: Math.round(delayMs / 6000) / 10,
    });
    return entry;
}
