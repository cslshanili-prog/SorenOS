import { describe, expect, it } from 'vitest';
import {
    LEGACY_DEFAULT_WALLPAPER,
    isLegacyDefaultWallpaper,
    shouldPreserveLegacyDefaultWallpaper,
} from './wallpaperCompat';

describe('isLegacyDefaultWallpaper', () => {
    it('識別舊版十六進制粉綠默認漸變', () => {
        expect(isLegacyDefaultWallpaper(LEGACY_DEFAULT_WALLPAPER)).toBe(true);
    });

    it('識別瀏覽器規範化後的 rgb() 版本', () => {
        expect(isLegacyDefaultWallpaper('linear-gradient(135deg, rgb(255, 222, 233) 0%, rgb(181, 255, 252) 100%)')).toBe(true);
    });

    it('不把其它用戶漸變當成舊默認', () => {
        expect(isLegacyDefaultWallpaper('linear-gradient(135deg, #ffdede, #b5fffc)')).toBe(false);
        expect(isLegacyDefaultWallpaper('linear-gradient(180deg, #FFDEE9, #B5FFFC)')).toBe(false);
    });

    it('只為用戶主動選擇的懷舊版保留舊默認壁紙', () => {
        expect(shouldPreserveLegacyDefaultWallpaper(LEGACY_DEFAULT_WALLPAPER, 'nostalgia')).toBe(true);
        expect(shouldPreserveLegacyDefaultWallpaper(LEGACY_DEFAULT_WALLPAPER, 'paper')).toBe(false);
        expect(shouldPreserveLegacyDefaultWallpaper(LEGACY_DEFAULT_WALLPAPER)).toBe(false);
    });
});
