import { describe, expect, it } from 'vitest';
import { formatMemoryDateWithDistance } from './memoryDate';

describe('記憶日期與距今時間', () => {
    const now = new Date(2026, 6, 28, 9, 0, 0).getTime();

    it('舊記憶標註距今天數', () => {
        const memoryDate = new Date(2026, 6, 1, 23, 30, 0).getTime();
        expect(formatMemoryDateWithDistance(memoryDate, now))
            .toBe('2026年7月1日（距今約27天）');
    });

    it('同一日不受時分影響', () => {
        const memoryDate = new Date(2026, 6, 28, 0, 1, 0).getTime();
        expect(formatMemoryDateWithDistance(memoryDate, now))
            .toBe('2026年7月28日（今天）');
    });

    it('未來日期明確寫成多少天后', () => {
        const memoryDate = new Date(2026, 7, 2, 12, 0, 0).getTime();
        expect(formatMemoryDateWithDistance(memoryDate, now))
            .toBe('2026年8月2日（約5天后）');
    });
});
