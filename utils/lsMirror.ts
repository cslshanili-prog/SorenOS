/**
 * 關鍵 localStorage 鍵的 IndexedDB 鏡像（防瀏覽器"清 localStorage 但留 IndexedDB"式驅逐）。
 *
 * 背景：有用戶遇到「主題回初始 + 夢境盲盒收藏冊清空 + 小窩『更新這一天』點了沒反應」
 * 三連——三個症狀對應的持久化恰好全在 localStorage（os_theme / os_dream_collection /
 * os_api_config），而角色、聊天記錄（IndexedDB）完好。部分移動端瀏覽器/系統清理工具
 * 會只清 WebView 的 localStorage 而留下 IndexedDB，重新導入雲備份後一切恢復也與此吻合。
 *
 * 方案：把「備份體系裡也會帶走的那批小體積配置鍵」定期快照進 IndexedDB assets 表；
 * 啟動時若發現某鍵在 localStorage 裡缺失而鏡像裡有，就回填。真值仍是 localStorage，
 * 鏡像只在"丟了"的時候兜底——localStorage 裡已有的值永遠優先，不會被鏡像覆蓋。
 *
 * 注意 removeItem 語義：個別鍵（如 study_api_config）以"刪除 = 恢復默認"為語義，
 * 所以鏡像必須靠頻繁快照（啟動後 / 頁面隱藏 / pagehide / 定時）及時把刪除同步進去，
 * 避免啟動回填把用戶已刪除的配置復活。實際的復活窗口 ≈ "刪完立刻殺進程且沒觸發過
 * 一次 pagehide"，可以接受。
 */

import { DB } from './db';

/**
 * 參與鏡像的鍵。收錄標準：用戶手動配置或長期積累、丟了沒法憑空再生、體積是小段
 * JSON/字符串（嚴禁 data URI 等大體積——那些本來就該走 assets/blob 存儲）。
 * 這份名單與「設置 → 導出備份」帶走的 localStorage 鍵保持同一批（見 OSContext
 * exportFullData / importFullData），新增備份鍵時記得兩邊同步。
 */
export const MIRRORED_KEYS: readonly string[] = [
    'os_theme',                          // 外觀主題（丟了 = 回初始主題）
    'os_api_config',                     // 全局 API（丟了 = 一切生成靜默失效）
    'os_api_presets',
    'os_realtime_config',
    'os_memory_palace_config',
    'os_remote_vector_config',
    'os_cloud_backup_config',            // 丟了連"從雲端恢復"都要重新配
    'os_dream_collection',               // 夢境盲盒收藏冊（帳號級圖鑑，純積累不可再生）
    'world_home_api',                    // 家園全局 API 覆蓋
    'study_api_config',
    'study_tutor_presets',
    'push_vapid_v1',                     // VAPID 密鑰對，須與瀏覽器既有推送訂閱匹配
    'chat_archive_prompts',
    'chat_active_archive_prompt_id',
    'character_refine_prompts',
    'character_active_refine_prompt_id',
    'os_last_active_char_id',
];

const MIRROR_ASSET_ID = 'ls_mirror_v1';
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

type MirrorPayload = { savedAt: number; data: Record<string, string> };

/**
 * 啟動回填：鏡像裡有、localStorage 裡沒有的鍵寫回 localStorage。
 * 返回被回填的鍵名（空數組 = localStorage 完好或沒有鏡像）。
 * 必須在任何讀 localStorage 的初始化邏輯（OSContext.loadSettings 等）之前 await。
 */
export async function healLocalStorageMirror(): Promise<string[]> {
    let payload: MirrorPayload | null = null;
    try {
        payload = await DB.getAssetRaw(MIRROR_ASSET_ID);
    } catch {
        return [];
    }
    const data = payload?.data;
    if (!data || typeof data !== 'object') return [];

    const restored: string[] = [];
    for (const key of MIRRORED_KEYS) {
        const v = data[key];
        if (typeof v !== 'string') continue;
        try {
            if (localStorage.getItem(key) === null) {
                localStorage.setItem(key, v);
                restored.push(key);
            }
        } catch {
            // quota 滿 / 私有模式寫不進：兜底失敗就算了，不能讓啟動流程掛掉
        }
    }
    return restored;
}

/** 把當前 localStorage 裡的鏡像鍵快照進 IndexedDB。全部缺失時不寫（避免拿空快照覆蓋有效鏡像）。 */
export async function snapshotLocalStorageMirror(): Promise<void> {
    const data: Record<string, string> = {};
    for (const key of MIRRORED_KEYS) {
        try {
            const v = localStorage.getItem(key);
            if (v !== null) data[key] = v;
        } catch { /* ignore */ }
    }
    if (Object.keys(data).length === 0) return;
    try {
        await DB.saveAssetRaw(MIRROR_ASSET_ID, { savedAt: Date.now(), data } satisfies MirrorPayload);
    } catch { /* 鏡像寫失敗不影響主流程 */ }
}

let listenersAttached = false;

/**
 * 應用啟動時調一次：先回填、再拍一張新快照，並掛上"頁面隱藏 / 關閉 / 定時"的快照鉤子。
 * 返回回填的鍵名，調用方可據此提示用戶"本地設置曾丟失，已自動恢復"。
 */
export async function initLocalStorageMirror(): Promise<string[]> {
    const restored = await healLocalStorageMirror();
    await snapshotLocalStorageMirror();

    if (!listenersAttached && typeof window !== 'undefined' && typeof document !== 'undefined') {
        listenersAttached = true;
        const snap = () => { void snapshotLocalStorageMirror(); };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') snap();
        });
        window.addEventListener('pagehide', snap);
        setInterval(snap, SNAPSHOT_INTERVAL_MS);
    }
    return restored;
}
