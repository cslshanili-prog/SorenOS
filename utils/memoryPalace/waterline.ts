import type {
    MemoryPalaceWaterlineConfig,
    MemoryPalaceWaterlinePreset,
} from '../../types';

export interface ResolvedMemoryPalaceWaterline {
    preset: MemoryPalaceWaterlinePreset;
    hotZoneSize: number;
    bufferThreshold: number;
}

export const DEFAULT_MEMORY_PALACE_WATERLINE: ResolvedMemoryPalaceWaterline = {
    preset: 'online',
    hotZoneSize: 200,
    bufferThreshold: 100,
};

export const MEMORY_PALACE_WATERLINE_PRESETS = {
    online: DEFAULT_MEMORY_PALACE_WATERLINE,
    balanced: {
        preset: 'balanced',
        hotZoneSize: 100,
        bufferThreshold: 50,
    },
    offline: {
        preset: 'offline',
        hotZoneSize: 50,
        bufferThreshold: 20,
    },
} as const satisfies Record<Exclude<MemoryPalaceWaterlinePreset, 'custom'>, ResolvedMemoryPalaceWaterline>;

export const MIN_MEMORY_HOT_ZONE_SIZE = 20;
export const MAX_MEMORY_HOT_ZONE_SIZE = 500;
export const MIN_MEMORY_BUFFER_THRESHOLD = 10;
export const MAX_MEMORY_BUFFER_THRESHOLD = 200;

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' && Number.isFinite(value)
        ? Math.floor(value)
        : fallback;
    return Math.max(min, Math.min(max, parsed));
};

/**
 * 將角色上保存的檔位解析成管線可以直接使用的兩個數值。
 *
 * 兼容約定：舊角色沒有 memoryPalaceWaterline 字段時永遠落到當前默認 200/100，
 * 不做批量遷移，也不需要給每個舊角色補寫一份相同配置。
 */
export const resolveMemoryPalaceWaterline = (
    config?: MemoryPalaceWaterlineConfig,
): ResolvedMemoryPalaceWaterline => {
    const preset = config?.preset;
    if (preset === 'balanced' || preset === 'offline' || preset === 'online') {
        return { ...MEMORY_PALACE_WATERLINE_PRESETS[preset] };
    }
    if (preset === 'custom') {
        return {
            preset: 'custom',
            hotZoneSize: clampInteger(
                config?.hotZoneSize,
                DEFAULT_MEMORY_PALACE_WATERLINE.hotZoneSize,
                MIN_MEMORY_HOT_ZONE_SIZE,
                MAX_MEMORY_HOT_ZONE_SIZE,
            ),
            bufferThreshold: clampInteger(
                config?.bufferThreshold,
                DEFAULT_MEMORY_PALACE_WATERLINE.bufferThreshold,
                MIN_MEMORY_BUFFER_THRESHOLD,
                MAX_MEMORY_BUFFER_THRESHOLD,
            ),
        };
    }
    return { ...DEFAULT_MEMORY_PALACE_WATERLINE };
};

export const makeCustomMemoryPalaceWaterline = (
    hotZoneSize: unknown,
    bufferThreshold: unknown,
): MemoryPalaceWaterlineConfig => {
    const resolved = resolveMemoryPalaceWaterline({
        preset: 'custom',
        hotZoneSize: typeof hotZoneSize === 'number' ? hotZoneSize : undefined,
        bufferThreshold: typeof bufferThreshold === 'number' ? bufferThreshold : undefined,
    });
    return {
        preset: 'custom',
        hotZoneSize: resolved.hotZoneSize,
        bufferThreshold: resolved.bufferThreshold,
    };
};
