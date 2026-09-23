import { describe, expect, it } from 'vitest';
import {
    DEFAULT_MEMORY_PALACE_WATERLINE,
    makeCustomMemoryPalaceWaterline,
    resolveMemoryPalaceWaterline,
} from './waterline';

describe('角色級記憶水位檔位', () => {
    it('舊角色沒有字段時保持歷史默認 200/100', () => {
        expect(resolveMemoryPalaceWaterline(undefined)).toEqual(DEFAULT_MEMORY_PALACE_WATERLINE);
    });

    it.each([
        ['online', 200, 100],
        ['balanced', 100, 50],
        ['offline', 50, 20],
    ] as const)('%s 檔解析為 %i/%i', (preset, hotZoneSize, bufferThreshold) => {
        expect(resolveMemoryPalaceWaterline({ preset })).toEqual({
            preset,
            hotZoneSize,
            bufferThreshold,
        });
    });

    it('自定義值會取整並限制在安全範圍內', () => {
        expect(resolveMemoryPalaceWaterline({
            preset: 'custom',
            hotZoneSize: 9.8,
            bufferThreshold: 999,
        })).toEqual({
            preset: 'custom',
            hotZoneSize: 20,
            bufferThreshold: 200,
        });
    });

    it('創建自定義配置時保存的是歸一化後的穩定數值', () => {
        expect(makeCustomMemoryPalaceWaterline(88.9, 33.4)).toEqual({
            preset: 'custom',
            hotZoneSize: 88,
            bufferThreshold: 33,
        });
    });
});
