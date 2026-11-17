import { afterEach, describe, expect, it } from 'vitest';
import type { CharacterProfile, UserProfile, WorldTimeline } from '../types';
import { setWorldRegistry } from './charNameRegistry';
import { ContextBuilder } from './context';
import { ChatPrompts } from './chatPrompts';
import { resolveCharTimeZone, tzAwarenessNote } from './timezone';
import { applyActivePersona } from './userPersona';
import { calendarDateStamp, calendarStamp, formatCalendarClock, formatCalendarText, formatEpochYear, resolveCharCalendar, timelineDeltaDays, worldWallClockToTimestamp } from './worldCalendar';

// 世界的曆法與時區（plans/time-system.md 第 3 批）

const tl: WorldTimeline = { epochLabel: '第三紀元 {年} 年', anchorReal: '2026-11-17', anchorWorld: '3019-03-25' };
// 設備時區解讀：2026-11-17 14:16 當地
const at = new Date(2026, 10, 17, 14, 16).getTime();

afterEach(() => setWorldRegistry([]));

describe('重映射', () => {
    it('對應點差幾天就平移幾天，月日照公曆、時分不動、年份套寫法', () => {
        expect(timelineDeltaDays(tl)).toBe(Math.round((Date.UTC(3019, 2, 25) - Date.UTC(2026, 10, 17)) / 86_400_000));
        expect(calendarStamp(at, undefined, tl)).toBe('3019-03-25 14:16');
        expect(calendarDateStamp(at + 14 * 86_400_000, undefined, tl)).toBe('3019-04-08');
        expect(formatCalendarText(at, undefined, tl, { timeOfDay: '下午' })).toBe('第三紀元 3019 年 3 月 25 日 下午 14:16');
        expect(formatCalendarText(at, undefined, tl, { time: false })).toBe('第三紀元 3019 年 3 月 25 日');
        // 星期默認不寫，開了才寫；沒有時間線就是現實的寫法
        expect(formatCalendarClock(at, undefined, tl)).toBe('3019-03-25 14:16');
        expect(formatCalendarClock(at, undefined, { ...tl, showWeekday: true })).toMatch(/^3019-03-25 14:16 週/);
        expect(formatCalendarClock(at, undefined, undefined)).toBe('2026-11-17 14:16 週二');
        expect(formatCalendarText(at, undefined, undefined, { timeOfDay: '下午' })).toBe('2026年11月17日 週二 下午 14:16');
    });
    it('年份寫法沒有 {年} 就接在後面；對應點沒填好就不平移', () => {
        expect(formatEpochYear({ epochLabel: '帝國曆' }, 3019)).toBe('帝國曆 3019');
        expect(formatEpochYear({ epochLabel: '' }, 3019)).toBe('第三紀元 3019 年');
        expect(timelineDeltaDays({ anchorReal: '2026-11-17', anchorWorld: '' })).toBe(0);
    });
    it('照世界曆法填的時間換回現實', () => {
        expect(worldWallClockToTimestamp('3019-03-25T14:16', undefined, tl)).toBe(at);
        expect(worldWallClockToTimestamp('3019-04-08T09:00', undefined, tl)).toBe(new Date(2026, 11, 1, 9, 0).getTime());
        expect(worldWallClockToTimestamp('2026-11-17T14:16', undefined, undefined)).toBe(at);
        expect(worldWallClockToTimestamp('亂填', undefined, tl)).toBeNaN();
    });
});

describe('時區先看世界', () => {
    const c = { id: 'c1', name: 'V', groupId: 'w1', customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' } as unknown as CharacterProfile;
    it('架空曆法沒有時區；世界設了時區蓋過角色的；都沒有才看角色', () => {
        setWorldRegistry([{ id: 'w1', timeline: tl }]);
        expect(resolveCharTimeZone(c)).toBeUndefined();
        expect(resolveCharCalendar(c)).toEqual(tl);
        setWorldRegistry([{ id: 'w1', timezone: 'America/New_York' }]);
        expect(resolveCharTimeZone(c)).toBe('America/New_York');
        expect(resolveCharCalendar(c)).toBeUndefined();
        setWorldRegistry([{ id: 'w1' }]);
        expect(resolveCharTimeZone(c)).toBe('Asia/Tokyo');
        expect(resolveCharTimeZone({ ...c, groupId: undefined })).toBe('Asia/Tokyo');
        // 對應點沒填好的時間線不算架空
        setWorldRegistry([{ id: 'w1', timeline: { ...tl, anchorWorld: '' } }]);
        expect(resolveCharCalendar(c)).toBeUndefined();
        expect(resolveCharTimeZone(c)).toBe('Asia/Tokyo');
    });
});

describe('架空曆法進提示詞', () => {
    const c = { id: 'c1', name: 'V', groupId: 'w1' } as unknown as CharacterProfile;
    it('「現在是」照曆法寫、多一句別換算成公元；歷史時間戳也是', () => {
        setWorldRegistry([{ id: 'w1', timeline: tl }]);
        const block = ContextBuilder.buildTimeAwarenessBlock(c, { now: at });
        expect(block).toContain('現在是 第三紀元 3019 年 3 月 25 日 下午 14:16');
        expect(block).toContain('日期一律照它寫，別換算成公元');
        const coarse = ContextBuilder.buildTimeAwarenessBlock({ ...c, timeAwareness: 'coarse' } as any, { now: at });
        expect(coarse).toContain('現在是 第三紀元 3019 年 3 月 25 日 下午。');
        const history = [{ id: 1, charId: 'c1', role: 'user', type: 'text', content: '嗨', timestamp: at }] as any;
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, c, { name: 'L' } as any, []);
        expect(String(apiMessages[0].content)).toMatch(/^\[3019-03-25 14:16\]/);
    });
});

describe('身份卡所在地', () => {
    it('套用身份卡時所在地跟著卡走', () => {
        const base = { name: '我', avatar: '', bio: '', timezone: 'Asia/Taipei', activePersonaId: 'p1', personas: [{ id: 'p1', name: '卡', avatar: '', bio: '', timezone: 'Europe/London', createdAt: 0, updatedAt: 0 }] } as unknown as UserProfile;
        expect(applyActivePersona(base).timezone).toBe('Europe/London');
        expect(applyActivePersona({ ...base, personas: [{ ...base.personas![0], timezone: undefined }] }).timezone).toBeUndefined();
    });
    it('時差那句：知道對方在哪就直說那邊幾點；同一個時區不提；角色沒時區不給', () => {
        const note = tzAwarenessNote('Asia/Tokyo', 'Europe/London', at);
        expect(note).toContain('對方（用戶）在「');
        expect(note).toMatch(/那邊現在是 \d{2}:\d{2}/);
        expect(tzAwarenessNote('Asia/Tokyo', 'Asia/Tokyo', at)).toBe('');
        expect(tzAwarenessNote(undefined, 'Europe/London', at)).toBe('');
        expect(tzAwarenessNote('Asia/Tokyo', undefined, at)).toContain('可能在不同的時區');
    });
});
