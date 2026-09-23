/**
 * 懶加載 chunk 失敗自愈 — "Importing a module script failed." 一鍵恢復
 *
 * 觸發場景 (iOS Safari standalone PWA 高發):
 *  - PWA 從後台恢復瞬間網絡連接還沒拉起來, 此時點 App 圖標觸發的動態 import 失敗;
 *  - 部署更新後舊 bundle 還駐留在內存裡, 引用的舊 hash chunk 已從服務器消失 (404)。
 *
 * 關鍵: Safari 會把"加載失敗"緩存進模塊表 — 同一 URL 在本頁生命週期內再 import
 * 直接秒失敗、不再發網絡請求。所以"返回桌面再點進"永遠修不好, 只有整頁 reload
 * (用戶側表現為"大退重進") 才能恢復。這裡做的就是把這次 reload 自動化。
 *
 * 防循環: sessionStorage 記錄上次自動刷新時間, 冷卻期內不再自刷 (留給手動按鈕),
 * 避免服務器真把 chunk 弄丟時無限刷新。大退後 sessionStorage 自然清空, 護欄復位。
 */

const RELOAD_MARK_KEY = 'sullyos_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 60_000;

// EOF 本身不能證明是 chunk：JSON / 用戶腳本也會報語法錯誤。
// 只為懶加載 Promise 的拒絕記錄來源，保留原 Error 和堆棧（也兼容 frozen Error）。
const moduleLoadErrors = new WeakSet<object>();
export const markModuleLoadError = (error: unknown): void => {
    if (error !== null && typeof error === 'object') moduleLoadErrors.add(error);
};

const INCOMPLETE_MODULE_RE = /^(?:Unexpected EOF|Unexpected end of (?:input|script))\.?$/i;

/** 各瀏覽器動態 import / chunk 加載失敗的報錯指紋 (Safari / Chrome / Firefox / webpack 風格) */
const CHUNK_ERROR_RE = new RegExp(
    [
        'Importing a module script failed',          // iOS/macOS Safari
        'Failed to fetch dynamically imported module', // Chrome
        'error loading dynamically imported module',   // Firefox
        'Failed to load module script',                 // MIME/網絡層失敗
        'not a valid JavaScript MIME type',             // Safari: 'text/html' is not a valid JavaScript MIME type
        'server responded with a MIME type of ["\']?text/html', // Chromium: SPA fallback returned HTML for a module
        'Unable to preload CSS',                        // Vite __vitePreload CSS 依賴失敗
        'ChunkLoadError',
        'Loading chunk \\S+ failed',
    ].join('|'),
    'i',
);

export const isChunkLoadError = (err: unknown): boolean => {
    const msg = err instanceof Error
        ? `${err.name}: ${err.message}`
        : typeof err === 'string' ? err : '';
    if (CHUNK_ERROR_RE.test(msg)) return true;
    return err instanceof Error
        && moduleLoadErrors.has(err)
        && err.name === 'SyntaxError'
        && INCOMPLETE_MODULE_RE.test(err.message.trim());
};

/**
 * 嘗試自動整頁刷新來恢復 chunk 加載失敗。
 * 返回 true = 已發起刷新 (頁面即將消失); false = 冷卻期內/存儲不可用, 調用方應展示手動刷新按鈕。
 */
export const tryAutoReloadForChunkError = (): boolean => {
    let allowed = false;
    try {
        const last = parseInt(sessionStorage.getItem(RELOAD_MARK_KEY) || '0', 10) || 0;
        allowed = Date.now() - last >= RELOAD_COOLDOWN_MS;
        if (allowed) sessionStorage.setItem(RELOAD_MARK_KEY, String(Date.now()));
    } catch {
        // sessionStorage 不可用時沒法防刷新循環 → 不自動刷, 走手動按鈕兜底
        allowed = false;
    }
    if (!allowed) return false;
    window.location.reload();
    return true;
};
