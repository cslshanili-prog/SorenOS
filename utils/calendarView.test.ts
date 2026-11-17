import { describe, expect, it } from 'vitest';
import type { Anniversary, ScheduleSlot, Task, UserProfile } from '../types';
import { addDays, addMonths, anniversariesOn, currentActivity, dayMarks, dayTitle, dualTime, monthGrid, monthRange, overlapRows, personaOptions, rangeState, slotRanges, tasksOn, wallToMs } from './calendarView';

// 行事曆的純邏輯（plans/calendar.md 第 1 批）

describe('日期算術與月格子', () => {
    it('加減天、加減月、月格子週日開頭、最後一行全是下個月就不要', () => {
        expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
        expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
        expect(addMonths('2026-11', 1)).toBe('2026-12');
        expect(addMonths('2026-11', 2)).toBe('2027-01');
        expect(addMonths('2026-01', -1)).toBe('2025-12');
        const grid = monthGrid('2026-11'); // 2026-11-01 是週日
        expect(grid[0][0]).toEqual({ key: '2026-11-01', inMonth: true, day: 1 });
        expect(grid.length).toBe(5);
        expect(grid[4][0].key).toBe('2026-11-29');
        expect(grid[4][6]).toEqual({ key: '2026-12-05', inMonth: false, day: 5 });
        expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-12-05' });
        const oct = monthGrid('2026-10'); // 2026-10-01 是週四
        expect(oct[0][0]).toEqual({ key: '2026-09-27', inMonth: false, day: 27 });
        expect(oct[0][4].key).toBe('2026-10-01');
    });
    it('日期標題：現實寫月日星期、架空照曆法', () => {
        expect(dayTitle('2026-11-17')).toBe('11月17日（週二）');
        expect(dayTitle('2026-11-17', { epochLabel: '第三紀元 {年} 年', anchorReal: '2026-11-17', anchorWorld: '3019-03-25' })).toBe('第三紀元 3019 年 3 月 25 日');
    });
});

describe('時段', () => {
    const slots: ScheduleSlot[] = [
        { startTime: '08:00', activity: '晨跑', emoji: '🏃' },
        { startTime: '12:00', activity: '午餐' },
        { startTime: '22:00', activity: '睡前閱讀' },
    ];
    it('結束＝下一段開始；最後一段沒有結束', () => {
        expect(slotRanges(slots).map(r => [r.start, r.end])).toEqual([['08:00', '12:00'], ['12:00', '22:00'], ['22:00', undefined]]);
    });
    it('過了／進行中／還沒到照這個人那邊的現在算；最後一段到當天結束', () => {
        const day = '2026-11-17';
        const at = (hhmm: string) => wallToMs(day, hhmm, undefined);
        const [a, b, c] = slotRanges(slots);
        expect(rangeState(day, a, undefined, at('09:00'))).toBe('now');
        expect(rangeState(day, b, undefined, at('09:00'))).toBe('future');
        expect(rangeState(day, a, undefined, at('13:00'))).toBe('past');
        expect(rangeState(day, c, undefined, at('23:30'))).toBe('now');
        expect(rangeState(day, c, undefined, wallToMs(addDays(day, 1), '00:30', undefined))).toBe('past');
        expect(currentActivity(day, slots, undefined, at('12:30'))?.activity).toBe('午餐');
        expect(currentActivity(day, slots, undefined, at('06:00'))).toBeUndefined();
    });
    it('雙時間：同時區只有 local；跨時區寫你那邊、隔天打標記', () => {
        expect(dualTime('2026-11-17', '08:00', undefined, undefined)).toEqual({ local: '08:00' });
        expect(dualTime('2026-11-17', '08:00', 'Asia/Tokyo', 'Asia/Tokyo')).toEqual({ local: '08:00' });
        // 東京 08:00 ＝ 台北 07:00
        expect(dualTime('2026-11-17', '08:00', 'Asia/Tokyo', 'Asia/Taipei')).toEqual({ local: '08:00', yours: '07:00' });
        // 紐約 22:00 ＝ 台北隔天 11:00（11 月已經是冬令時，差 13 小時）
        expect(dualTime('2026-11-17', '22:00', 'America/New_York', 'Asia/Taipei')).toEqual({ local: '22:00', yours: '11:00', yoursDayOffset: 1 });
    });
    it('次元重疊：幾個角色的時段混排、照你那邊的時刻排', () => {
        const tokyo = { id: 't', name: '東京', avatar: '', customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' };
        const taipei = { id: 'p', name: '台北', avatar: '', customTimezoneEnabled: true, customTimezone: 'Asia/Taipei' };
        const rows = overlapRows('2026-11-17', [
            { char: tokyo, tz: 'Asia/Tokyo', slots: [{ startTime: '09:00', activity: 'A' }] },
            { char: taipei, tz: 'Asia/Taipei', slots: [{ startTime: '08:30', activity: 'B' }] },
        ], 'Asia/Taipei', wallToMs('2026-11-17', '07:00', 'Asia/Taipei'));
        // 東京 09:00 ＝ 台北 08:00，排在台北 08:30 前面
        expect(rows.map(r => `${r.char.name}:${r.time.local}/${r.time.yours || '-'}`)).toEqual(['東京:09:00/08:00', '台北:08:30/-']);
        expect(rows.map(r => r.state)).toEqual(['future', 'future']);
    });
});

describe('身份卡、待辦、紀念日', () => {
    it('身份卡清單：真實身份在前、主線是全域默認那張、所在地跟著卡', () => {
        const base = { name: '我', avatar: 'a', bio: '', timezone: 'Asia/Taipei', activePersonaId: 'p1', personas: [{ id: 'p1', name: '卡一', avatar: 'b', bio: '', timezone: 'Europe/London', createdAt: 0, updatedAt: 0 }] } as unknown as UserProfile;
        const list = personaOptions(base);
        expect(list.map(p => [p.key, p.name, p.timezone, p.isMain])).toEqual([['__real__', '我', 'Asia/Taipei', false], ['p1', '卡一', 'Europe/London', true]]);
        // 全域默認指到已刪的卡 → 主線是真實身份
        expect(personaOptions({ ...base, activePersonaId: 'gone' }).find(p => p.isMain)?.key).toBe('__real__');
    });
    it('待辦照截止日、紀念日照今年那次；月格子打點', () => {
        const tasks = [{ id: '1', title: 'x', deadline: '2026-11-17', isCompleted: false, createdAt: 0 }] as unknown as Task[];
        const annis = [{ id: 'a', title: '認識', date: '2020-11-18', charId: 'c', repeatAnnually: true }, { id: 'b', title: '一次', date: '2026-11-19', charId: 'c' }] as unknown as Anniversary[];
        expect(tasksOn(tasks, '2026-11-17').length).toBe(1);
        expect(anniversariesOn(annis, '2026-11-18').map(a => a.id)).toEqual(['a']);
        expect(anniversariesOn(annis, '2026-11-19').map(a => a.id)).toEqual(['b']);
        expect(dayMarks('2026-11-17', new Set(['2026-11-17']), tasks, annis)).toEqual({ schedule: true, todo: true, anniversary: false });
    });
});
