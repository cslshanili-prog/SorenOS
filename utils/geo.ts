import { Capacitor } from '@capacitor/core';

/**
 * 跨端取定位: 原生 (Capacitor) 優先用 @capacitor/geolocation 插件 (會彈原生權限申請),
 * 插件取座標失敗時回退到 WebView 的 navigator.geolocation; 瀏覽器直接走 navigator。
 *
 * 為什麼這麼繞:
 * - 插件的 requestPermissions 走的是標準 Android 運行時權限 (不依賴 GMS), 用它彈權限框最穩。
 * - 但官方 @capacitor/geolocation 取座標底層用 Google Play Services 的 Fused Location Provider,
 *   設備沒有 GMS (國產 ROM / 純淨系統 / 去谷歌機型) 會拋 "Google Play services unavailable"。
 *   這種情況回退到 navigator.geolocation —— 它在 Capacitor WebView 裡走系統 LocationManager,
 *   不碰 GMS, 正是沒谷歌的機器一直能用的那條路。
 * - 另外: 原生還需在 AndroidManifest 裡聲明 ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION,
 *   iOS 需在 Info.plist 加 NSLocationWhenInUseUsageDescription。
 */
export interface GeoResult { longitude: number; latitude: number; accuracy: number; }

const getPositionViaNavigator = (): Promise<GeoResult> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
        throw new Error('當前環境不支持定位, 請選城市或手輸座標');
    }
    return new Promise<GeoResult>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ longitude: pos.coords.longitude, latitude: pos.coords.latitude, accuracy: pos.coords.accuracy ?? 99999 }),
            (err) => reject(new Error(err.message || '定位失敗')),
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    });
};

export const getCurrentPositionSmart = async (): Promise<GeoResult> => {
    // 原生: 先用插件彈權限, 取座標失敗再回退 navigator
    if (Capacitor.isNativePlatform()) {
        const { Geolocation } = await import('@capacitor/geolocation');
        try {
            const perm = await Geolocation.checkPermissions();
            if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
                const req = await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] as any });
                if (req.location !== 'granted' && (req as any).coarseLocation !== 'granted') {
                    throw new Error('定位權限被拒絕。請到 系統設置 → 應用 → 權限 裡允許定位, 或直接選城市。');
                }
            }
        } catch (e: any) {
            // checkPermissions/requestPermissions 在個別機型會拋, 不阻塞, 直接嘗試取位置
            console.warn('[geo] 權限檢查異常, 繼續嘗試取位置:', e?.message || e);
        }
        try {
            const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
            return { longitude: pos.coords.longitude, latitude: pos.coords.latitude, accuracy: pos.coords.accuracy ?? 99999 };
        } catch (e: any) {
            // 沒 GMS 的機器插件取座標會拋 "Google Play services unavailable" —— 回退 WebView 定位 (走系統 LocationManager)
            console.warn('[geo] Capacitor 插件取位置失敗, 回退 navigator.geolocation:', e?.message || e);
            return getPositionViaNavigator();
        }
    }

    // 瀏覽器: navigator.geolocation
    return getPositionViaNavigator();
};
