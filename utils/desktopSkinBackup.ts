// 桌面皮膚本機偏好的備份/恢復（隨 設置→導出 一起走）。
// 涉及：電子寵物(tamagotchi) / 手遊風(mobilegame) 的界面配色方案 + 看板 banner。
// 這些偏好存在 localStorage，不掛在角色上，早期導出清單裡沒有——補齊後才能跨設備遷移。
//
// 看板圖（tama_board_img）可能是 blobref 令牌（指向本機 blob_assets）。整包備份（v3）
// 令牌原樣進包：本模塊的輸出落在 metadata.json，令牌由導出管線統一收集、二進制隨
// blobs/* 旁路走、導入端按原 id 寫回（見 utils/backupBlobs.ts）。這裡只負責一件事：
// 圖已丟的死令牌不帶，恢復端拿到的鍵要麼可解析、要麼乾脆沒有。

import { isBlobRef, getBlobForRef, migrateDataUrlToRef } from './blobRef';

// 純字符串偏好鍵（原樣帶走）
const PLAIN_KEYS = [
    'companion_frame_style_v1', // 陪伴桌面：框架風格（科技 / 手遊 / 卡面 / 畫報）
    'companion_layout_v1', // 陪伴桌面：真實佈局（舞台 / 陪伴 / 輕巧）
    'tama_style_v2',   // 電子寵物：界面風格方案 {hue,dark,gold,mute}
    'mg_style_v1',     // 手遊風：界面配色方案
    'tama_board_fg',   // 看板文字色（空=自動）
    'tama_accent_hue', // 舊版單色相偏好（遷移用，帶上無害）
];
const BOARD_IMG_KEY = 'tama_board_img'; // 看板 banner 圖（blobref 令牌 / data: / http）

/**
 * 導出：讀齊本機偏好。
 * @param includeImage 是否帶看板圖（false=純文本備份，跳過大圖，只帶配色偏好）。
 *   blobref 令牌原樣帶走（二進制由導出管線的 blobs/* 旁路隨包）；圖床 http / 舊 data: 原樣帶。
 * 無內容返回 undefined。
 */
export async function exportDesktopSkinLocal(includeImage = true): Promise<Record<string, string> | undefined> {
    const rec: Record<string, string> = {};
    try {
        for (const k of PLAIN_KEYS) {
            const v = localStorage.getItem(k);
            if (v != null) rec[k] = v;
        }
        const img = includeImage ? localStorage.getItem(BOARD_IMG_KEY) : null;
        if (img) {
            if (isBlobRef(img)) {
                // 解析得到才帶令牌；圖已丟就不帶，避免導出一個恢復端解不開的死鍵
                if (await getBlobForRef(img)) rec[BOARD_IMG_KEY] = img;
            } else {
                rec[BOARD_IMG_KEY] = img; // 舊 data: / 圖床 http，原樣可移植
            }
        }
    } catch { /* 私密模式等讀盤失敗：能帶多少帶多少 */ }
    return Object.keys(rec).length > 0 ? rec : undefined;
}

/** 導入：寫回本機偏好；看板圖若是 data URL 則落成本機 blob，字段換成新令牌。 */
export async function importDesktopSkinLocal(rec?: Record<string, string> | null): Promise<void> {
    if (!rec) return;
    try {
        for (const k of PLAIN_KEYS) {
            if (typeof rec[k] === 'string') localStorage.setItem(k, rec[k]);
        }
        const img = rec[BOARD_IMG_KEY];
        if (typeof img === 'string' && img) {
            // data URL → 本機 blob（換設備後令牌重建）；http/已是令牌則原樣寫
            const stored = img.startsWith('data:') ? await migrateDataUrlToRef(img) : img;
            localStorage.setItem(BOARD_IMG_KEY, stored);
        }
    } catch { /* 寫盤失敗無妨，用默認皮膚 */ }
}
