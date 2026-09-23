/** 舊版系統默認的粉綠漸變；不再是系統默認，僅供存量遷移和用戶主動選擇「懷舊版」。 */
export const LEGACY_DEFAULT_WALLPAPER = 'linear-gradient(135deg, #FFDEE9 0%, #B5FFFC 100%)';

/**
 * 瀏覽器或歷史版本可能把十六進制顏色規範化為 rgb()，因此不能只做原字符串相等判斷。
 * 同時要求角度和兩端系統色都匹配，避免誤傷普通用戶自定義漸變。
 */
export function isLegacyDefaultWallpaper(wallpaper?: string): boolean {
    if (!wallpaper) return false;
    const compact = wallpaper.toLowerCase().replace(/\s+/g, '');
    const hasPink = compact.includes('#ffdee9') || compact.includes('rgb(255,222,233)');
    const hasMint = compact.includes('#b5fffc') || compact.includes('rgb(181,255,252)');
    return compact.startsWith('linear-gradient(135deg,') && hasPink && hasMint;
}

/** 只有明確標記為懷舊版時才保留舊默認壁紙，避免普通老數據重新蓋過紙感默認。 */
export function shouldPreserveLegacyDefaultWallpaper(
    wallpaper?: string,
    desktopVariant?: string,
): boolean {
    return desktopVariant === 'nostalgia' && isLegacyDefaultWallpaper(wallpaper);
}
