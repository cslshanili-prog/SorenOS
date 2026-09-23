// 「今日特殊」節日要按角色所在地的日曆日判，不能跟著用戶的手機過節。
//
// 迴歸守衛：checkSpecialDates 原本無條件讀設備時間，於是同一段注入裡
// 「📅 當前真實時間」是角色時區、「🎉 今日特殊」卻是用戶時區，兩句自相矛盾——
// 角色會在自己的 2/13 晚上被告知今天是情人節，又在真正的 2/14 白天什麼都收不到。
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeContextManager } from './realtimeContext';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});
afterEach(() => vi.useRealTimers());

const freeze = (iso: string) => {
    process.env.TZ = 'Asia/Shanghai';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
};

describe('checkSpecialDates 跟隨角色時區', () => {
    it('用戶已到 2/14、角色那邊還是 2/13 時，角色不該被告知今天是情人節', () => {
        // 北京 2026-02-14 07:00 == 紐約 2026-02-13 18:00
        freeze('2026-02-13T23:00:00Z');

        expect(RealtimeContextManager.checkSpecialDates()).toContain('情人節');
        expect(RealtimeContextManager.checkSpecialDates('America/New_York')).toEqual([]);
    });

    it('用戶已過 2/14、角色那邊正是情人節白天時，角色要收到', () => {
        // 北京 2026-02-15 00:30 == 紐約 2026-02-14 11:30
        freeze('2026-02-14T16:30:00Z');

        expect(RealtimeContextManager.checkSpecialDates()).toEqual([]);
        expect(RealtimeContextManager.checkSpecialDates('America/New_York')).toContain('情人節');
    });

    it('不傳時區時保持原本的設備時間行為', () => {
        freeze('2026-02-13T23:00:00Z');

        expect(RealtimeContextManager.checkSpecialDates(undefined)).toContain('情人節');
    });
});
