/**
 * 構建版本相關常量的單一來源。
 *
 * `__BUILD_BRANCH__` / `__BUILD_COMMIT__` / `__BUILD_TIME__`
 * 是 vite.config.ts 注入的全局常量（prod 也有真值），
 * 但「branch@commit」這個 user-facing 標籤字符串原本在 BuildBadge / VersionInfo / DevDebugPanel
 * 三處分別現拼，想加 dirty 標、截短 commit 之類要改三處——抽到這裡集中維護。
 */

/** "branch@shortCommit" 形式的構建標籤；BuildBadge 角標、設置頁 VersionInfo、調試面板都用這一份。 */
export const BUILD_LABEL = `${__BUILD_BRANCH__}@${__BUILD_COMMIT__}`;

/** 構建時間標籤，固定由 Vite 按 UTC+8 注入，避免受用戶本機時區影響。 */
export const BUILD_TIME_LABEL = __BUILD_TIME__;

/**
 * 設置頁底部的產品版本名（手工維護），跟構建 hash 是兩碼事——發版前改這裡。
 *
 * Soren 自己一條線，S 開頭（2026-11-10 起，之前是上游的 v3.10）：大功能才升小版本（S1.1、S1.2…），
 * 一整批大改才升大版本（S2.0 Constellation，2026-11-14：桌面自由排版＋關係線）。不接上游的 v3.x，免得兩邊放一起比對不上。
 */
export const APP_VERSION = 'S2.0 (Constellation)';

/**
 * 版本號那半截（`S1.0`）。統計給每條記錄打的標籤用它，面板裡按版本切分數據時
 * 標籤越短越好篩，代號留給設置頁展示。跟著 APP_VERSION 走，改一處就夠。
 */
export const APP_VERSION_TAG = APP_VERSION.split(' ')[0];
