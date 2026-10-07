import { describe, expect, it } from 'vitest';
import {
    buildManualNudgeHint, followChatDeferral, formatGapZh, formatProactiveRange,
    normalizeProactiveRange, resolveManualTriggerMode, rollProactiveDelayMs,
} from './proactiveTiming';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('normalizeProactiveRange', () => {
    it('最短收斂到 30 分鐘倍數，最長不小於最短', () => {
        expect(normalizeProactiveRange(10)).toEqual({ minMinutes: 30, maxMinutes: 30 });
        expect(normalizeProactiveRange(70, 50)).toEqual({ minMinutes: 60, maxMinutes: 60 });
        expect(normalizeProactiveRange(60, 180)).toEqual({ minMinutes: 60, maxMinutes: 180 });
    });
});

describe('rollProactiveDelayMs', () => {
    it('固定間隔就是最短', () => {
        expect(rollProactiveDelayMs(HOUR, undefined, () => 0.9)).toBe(HOUR);
        expect(rollProactiveDelayMs(HOUR, HOUR, () => 0.9)).toBe(HOUR);
    });
    it('範圍內抽，兩端都抽得到，取整到分鐘', () => {
        expect(rollProactiveDelayMs(HOUR, 3 * HOUR, () => 0)).toBe(HOUR);
        expect(rollProactiveDelayMs(HOUR, 3 * HOUR, () => 0.999999)).toBe(3 * HOUR);
        const mid = rollProactiveDelayMs(HOUR, 3 * HOUR, () => 0.5);
        expect(mid % MIN).toBe(0);
        expect(mid).toBeGreaterThan(HOUR);
        expect(mid).toBeLessThan(3 * HOUR);
    });
});

describe('followChatDeferral', () => {
    const now = 10 * HOUR;
    it('最近才聊過就延到最後一則＋重新抽的間隔', () => {
        expect(followChatDeferral(now - 20 * MIN, now, HOUR, undefined)).toBe(now - 20 * MIN + HOUR);
        const at = followChatDeferral(now - 20 * MIN, now, HOUR, 3 * HOUR, () => 0.999999);
        expect(at).toBe(now - 20 * MIN + 3 * HOUR);
    });
    it('夠久了、沒聊過、時間戳在未來都照常發', () => {
        expect(followChatDeferral(now - HOUR, now, HOUR)).toBeNull();
        expect(followChatDeferral(undefined, now, HOUR)).toBeNull();
        expect(followChatDeferral(now + MIN, now, HOUR)).toBeNull();
    });
});

describe('formatProactiveRange / formatGapZh', () => {
    it('範圍文案', () => {
        expect(formatProactiveRange(30)).toBe('30 分鐘');
        expect(formatProactiveRange(120, 120)).toBe('2 小時');
        expect(formatProactiveRange(60, 180)).toBe('1～3 小時');
        expect(formatProactiveRange(30, 120)).toBe('30 分鐘～2 小時');
        expect(formatProactiveRange(90, 240)).toBe('1.5～4 小時');
    });
    it('間隔文案', () => {
        expect(formatGapZh(12 * MIN)).toBe('12分鐘');
        expect(formatGapZh(3 * HOUR + 5 * MIN)).toBe('3小時5分鐘');
        expect(formatGapZh(52 * HOUR)).toBe('2天4小時');
    });
});

describe('resolveManualTriggerMode', () => {
    const msg = (role: string, timestamp: number, metadata?: any) => ({ role, timestamp, metadata });
    it('最後一則是用戶就照常回覆', () => {
        expect(resolveManualTriggerMode([msg('assistant', 1), msg('user', 2)]).mode).toBe('reply');
    });
    it('最後一則是角色、或沒聊過就是 nudge；系統卡片與隱藏提示不算', () => {
        const r = resolveManualTriggerMode([
            msg('user', 1), msg('assistant', 2), msg('system', 3),
            msg('user', 4, { proactiveHint: true, hidden: true }),
        ]);
        expect(r).toEqual({ mode: 'nudge', lastCharMessageAt: 2, lastUserMessageAt: 1 });
        expect(resolveManualTriggerMode([]).mode).toBe('nudge');
    });
});

describe('buildManualNudgeHint', () => {
    const base = { userName: '小莉', timeStr: '2026-10-08 10:00', now: 10 * HOUR };
    it('剛說完：追一句，提到對方還沒回、不要重複', () => {
        const hint = buildManualNudgeHint({ ...base, lastCharMessageAt: 10 * HOUR - 5 * MIN, lastUserMessageAt: 9 * HOUR });
        expect(hint).toContain('5分鐘前傳的，小莉還沒回');
        expect(hint).toContain('不要重複');
        expect(hint.startsWith('[系統提示（非小莉發言）')).toBe(true);
    });
    it('隔很久：主動找對方，帶上用戶多久沒說話', () => {
        const hint = buildManualNudgeHint({ ...base, lastCharMessageAt: 5 * HOUR, lastUserMessageAt: 4 * HOUR });
        expect(hint).toContain('小莉已經 6小時沒有找你說話了');
        expect(hint).toContain('你想主動找小莉');
    });
    it('完全沒聊過：開個頭', () => {
        expect(buildManualNudgeHint(base)).toContain('自然地開個頭');
    });
});
