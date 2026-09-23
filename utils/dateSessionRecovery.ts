/**
 * 見面(DateApp)「恢復上次進度」崩潰自愈 — 打破 iOS WebKit 反覆閃退死循環
 *
 * 觸發場景 (用戶報障: iOS Edge 見面時突然閃退, 之後刷新重進反覆灰屏/白屏):
 *  - 見面會話每 30s / 切後台 / 關頁面時會把當前 DateState 直接落庫 (savedDateState);
 *  - 若這份快照本身很重 (大圖立繪/背景 + 大量歷史消息 + 閱讀模式全量渲染),
 *    在內存吃緊的 iOS WebKit 上「繼續上次」會把整個內容進程撐爆 (OOM) 或觸發
 *    看門狗超時 —— 瀏覽器直接殺進程, 表現為「此網頁反覆出現問題」而非 JS 異常。
 *
 * 關鍵: 這類進程級崩潰 **不是** 能被 React ErrorBoundary 捕獲的 JS 異常, 而且崩潰前
 * 那份 savedDateState 已經落庫 —— 重進見面點「繼續上次」會原樣重放同一份重快照,
 * 於是每次都崩, 用戶被永久鎖死在這個功能裡 (只能清站點數據才能自救)。
 *
 * 自愈思路 (兩段式, 參考 chunkLoadRecovery 的 sessionStorage 護欄):
 *  1) 恢復「嘗試」開始時 (點「繼續上次」) → armDateResumeAttempt(charId) 寫哨兵;
 *  2) 會話成功掛載並穩定渲染一小段時間後 → clearDateResumeAttempt() 撤哨兵 (證明這份快照能安全加載)。
 * 若進程在 1) 與 2) 之間被殺, 哨兵不會被清除 (進程崩潰不會跑 React 卸載邏輯),
 * 於是下次進見面時 takeCrashedDateResume() 讀到殘留哨兵 = 上次恢復崩了 →
 * 調用方丟棄這份有毒的 savedDateState (僅清恢復快照, 不動消息歷史), 讓用戶重新開始。
 *
 * 為什麼用 sessionStorage: 整頁 reload (刷新 / WebKit 崩潰後重載) 仍在同一 tab 會話內,
 * 哨兵得以留存被檢出; 正常關標籤頁後自然清空, 不會誤傷下次全新打開。
 */

const RESUME_SENTINEL_KEY = 'sullyos_date_resume_attempt';

/** 恢復嘗試開始: 記下正在恢復哪個角色的見面會話 */
export const armDateResumeAttempt = (charId: string): void => {
    try {
        sessionStorage.setItem(RESUME_SENTINEL_KEY, JSON.stringify({ charId, at: Date.now() }));
    } catch {
        // sessionStorage 不可用: 沒法防死循環, 但也不影響正常功能 —— 靜默降級
    }
};

/** 恢復成功 / 乾淨退出: 撤銷哨兵, 表示這份快照已被證明能安全加載 */
export const clearDateResumeAttempt = (): void => {
    try {
        sessionStorage.removeItem(RESUME_SENTINEL_KEY);
    } catch {
        // ignore
    }
};

/**
 * 進見面時調用: 若上一次恢復嘗試的哨兵還殘留 (說明進程在恢復途中被殺 = 崩潰了),
 * 返回崩潰時正在恢復的 charId, 並順手清掉哨兵 (只讀一次)。沒有殘留則返回 null。
 */
export const takeCrashedDateResume = (): string | null => {
    let raw: string | null = null;
    try {
        raw = sessionStorage.getItem(RESUME_SENTINEL_KEY);
        if (raw) sessionStorage.removeItem(RESUME_SENTINEL_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed?.charId === 'string' && parsed.charId ? parsed.charId : null;
    } catch {
        return null;
    }
};
