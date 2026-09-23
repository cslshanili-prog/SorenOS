import { describe, expect, it } from 'vitest';
import { formatRelativeAge } from './relativeTime';

describe('formatRelativeAge', () => {
    const now = Date.UTC(2026, 6, 29, 12, 0, 0);

    it('給近消息標註分鐘和小時', () => {
        expect(formatRelativeAge(now - 45_000, now)).toBe('剛剛');
        expect(formatRelativeAge(now - 12 * 60_000, now)).toBe('約 12 分鐘前');
        expect(formatRelativeAge(now - 5 * 3_600_000, now)).toBe('約 5 小時前');
    });

    it('給跨天舊消息明確標註約幾天前', () => {
        expect(formatRelativeAge(now - 2 * 86_400_000, now)).toBe('約 2 天前');
    });

    it('支持更久的消息並保護異常或未來時間', () => {
        expect(formatRelativeAge(now - 65 * 86_400_000, now)).toBe('約 2 個月前');
        expect(formatRelativeAge(now - 800 * 86_400_000, now)).toBe('約 2 年前');
        expect(formatRelativeAge(now + 60_000, now)).toBe('剛剛');
        expect(formatRelativeAge(Number.NaN, now)).toBe('時間未知');
    });
});
