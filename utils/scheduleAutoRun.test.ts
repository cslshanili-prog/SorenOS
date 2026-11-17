import { describe, expect, it } from 'vitest';
import { decideAutoTarget, AHEAD_FROM_HOUR } from './scheduleAutoRun';
import type { SchedulePerson } from './schedulePerson';

// 本機自動生成的判斷（plans/calendar.md 第 5 批）

const person = (tz?: string): SchedulePerson => ({ kind: 'char', scheduleId: 'c1', participant: { kind: 'char', id: 'c1' }, name: 'A', avatar: '', timezone: tz, style: 'lifestyle' });
// 2026-11-17 13:00Z = 台北 21:00、倫敦 13:00
const now = new Date('2026-11-17T13:00:00Z');

describe('decideAutoTarget', () => {
    it('沒開就不排；當天模式排今天', () => {
        expect(decideAutoTarget(person(), undefined, now, false)).toBeNull();
        expect(decideAutoTarget(person(), { enabled: false, every: 'day', ahead: 1 }, now, false)).toBeNull();
        expect(decideAutoTarget(person('Asia/Taipei'), { enabled: true, every: 'day', ahead: 0 }, now, false)).toEqual({ dateKey: '2026-11-17', mode: 'day' });
    });

    it(`提早一天：那邊 ${AHEAD_FROM_HOUR}:00 之後才排明天，之前補今天`, () => {
        expect(decideAutoTarget(person('Asia/Taipei'), { enabled: true, every: 'day', ahead: 1 }, now, false)).toEqual({ dateKey: '2026-11-18', mode: 'day' });
        expect(decideAutoTarget(person('Europe/London'), { enabled: true, every: 'day', ahead: 1 }, now, false)).toEqual({ dateKey: '2026-11-17', mode: 'day' });
    });

    it('每週：本機排這週；排了雲端的角色本機只補今天', () => {
        expect(decideAutoTarget(person('Asia/Taipei'), { enabled: true, every: 'week', ahead: 1 }, now, false)).toEqual({ dateKey: '2026-11-17', mode: 'week' });
        expect(decideAutoTarget(person('Asia/Taipei'), { enabled: true, every: 'day', ahead: 1 }, now, true)).toEqual({ dateKey: '2026-11-17', mode: 'day' });
        expect(decideAutoTarget(person('Asia/Taipei'), { enabled: true, every: 'week', ahead: 1 }, now, true)).toEqual({ dateKey: '2026-11-17', mode: 'day' });
    });
});
