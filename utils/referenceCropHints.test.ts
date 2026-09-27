import { describe, expect, it } from 'vitest';
import { referenceCropHints } from './imageGeneration';

describe('鎖臉提示 · referenceCropHints', () => {
    it('獨照近照：臉夠大、不寬', () => {
        expect(referenceCropHints(1024, 1280, { size: 0.5 })).toEqual({ facePx: 512, faceTooSmall: false, tooWide: false });
    });
    it('三視圖：臉太小、圖太寬', () => {
        const hints = referenceCropHints(1536, 1024, { size: 0.2 });
        expect(hints.facePx).toBe(205);
        expect(hints.faceTooSmall).toBe(true);
        expect(hints.tooWide).toBe(true);
    });
    it('直式長圖也算太寬（上下會被切）', () => {
        expect(referenceCropHints(800, 1600, { size: 0.5 }).tooWide).toBe(true);
    });
    it('沒鎖臉：整個方形都送，小圖一樣會提示', () => {
        expect(referenceCropHints(200, 200, { size: 1 }).faceTooSmall).toBe(true);
        expect(referenceCropHints(1000, 1000, { size: 1 }).faceTooSmall).toBe(false);
    });
    it('圖還沒載入（0×0）不亂提示', () => {
        expect(referenceCropHints(0, 0, { size: 0.5 })).toEqual({ facePx: 0, faceTooSmall: false, tooWide: false });
    });
});
