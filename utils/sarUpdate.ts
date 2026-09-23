export const SAR_UPDATE_KEY = 'sullyos_update_2026_09_11_sar_seen';
export const SAR_CHANGELOG = 'changelog-2026-09-11';

// 公告跳轉只在當前標籤頁內消費一次，不改變默認的彼方首頁。
let openSAR = false;
export const sarLaunch = {
    request: () => { openSAR = true; },
    peek: () => openSAR,
    consume: () => { const pending = openSAR; openSAR = false; return pending; },
};
