import { beforeEach, describe, expect, it } from 'vitest';
import {
    cancelDelayedReply, computeReplyDelayMs, getPendingDelayedReply, normalizeDelayedReply,
    scheduleDelayedReply, takeDueDelayedReplies,
} from './delayedReply';

const settings = { enabled: true, minMinutes: 1, maxMinutes: 61 };

describe('normalizeDelayedReply', () => {
    it('補預設、最短不大於最長', () => {
        expect(normalizeDelayedReply(undefined)).toEqual({ enabled: false, minMinutes: 1, maxMinutes: 60 });
        expect(normalizeDelayedReply({ enabled: true, minMinutes: 30, maxMinutes: 5 })).toEqual({ enabled: true, minMinutes: 30, maxMinutes: 30 });
        expect(normalizeDelayedReply({ minMinutes: -3, maxMinutes: 99999 }).maxMinutes).toBe(1440);
    });
});

describe('computeReplyDelayMs', () => {
    const minutes = (ms: number) => ms / 60_000;

    it('睡覺落在範圍最後兩成，在忙落在後半', () => {
        expect(minutes(computeReplyDelayMs(settings, { slotKind: 'sleep', recentlyActive: false }, 0))).toBe(49);
        expect(minutes(computeReplyDelayMs(settings, { slotKind: 'busy', recentlyActive: true }, 0))).toBe(31);
        expect(minutes(computeReplyDelayMs(settings, { slotKind: 'busy', recentlyActive: false }, 1))).toBe(61);
    });

    it('空閒時偏前段，正聊得起勁更快', () => {
        expect(minutes(computeReplyDelayMs(settings, { slotKind: null, recentlyActive: false }, 1))).toBe(37);
        expect(minutes(computeReplyDelayMs(settings, { slotKind: null, recentlyActive: true }, 1))).toBe(16);
    });

    it('至少等 10 秒', () => {
        expect(computeReplyDelayMs({ enabled: true, minMinutes: 0, maxMinutes: 0 }, { slotKind: null, recentlyActive: true }, 0)).toBe(10_000);
    });
});

describe('待回清單', () => {
    beforeEach(() => localStorage.clear());

    it('已經排著的不會被後面的訊息往後推', () => {
        scheduleDelayedReply('a', 60_000, 1000);
        scheduleDelayedReply('a', 999_000, 5000);
        expect(getPendingDelayedReply('a')).toEqual({ dueAt: 61_000, scheduledAt: 1000 });
    });

    it('到點的取出後移除，沒到點的留著', () => {
        scheduleDelayedReply('a', 1000, 0);
        scheduleDelayedReply('b', 10_000, 0);
        expect(takeDueDelayedReplies(5000)).toEqual(['a']);
        expect(getPendingDelayedReply('a')).toBeNull();
        expect(getPendingDelayedReply('b')).not.toBeNull();
        expect(takeDueDelayedReplies(5000)).toEqual([]);
    });

    it('取消', () => {
        scheduleDelayedReply('a', 1000, 0);
        cancelDelayedReply('a');
        expect(getPendingDelayedReply('a')).toBeNull();
    });

    it('壞掉的存檔當作空的', () => {
        localStorage.setItem('soren_delayed_replies', '{not json');
        expect(takeDueDelayedReplies()).toEqual([]);
    });
});
