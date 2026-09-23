/**
 * 「彼方」獨立 API 配置 + 調用記錄。存於 IndexedDB（vr_settings store），
 * 隨數據導出/備份一起走，不再依賴 localStorage。
 *
 * 彼方的角色會自主、頻繁地登入觸發 LLM 調用，比較費 API，所以允許用戶單獨
 * 指定一份 API（與聊天 App 共用同一批已保存的預設 os_api_presets，但選擇獨立）。
 * 不設則回退聊天默認 apiConfig。同時記錄每次調用，方便對帳。
 */
import type { APIConfig } from '../../types';
import { DB } from '../db';

export interface VRApiCall {
    ts: number;
    charName?: string;
    room?: string;
    model?: string;
    baseUrl?: string;
    ok: boolean;
    ms: number;
    error?: string;
    /** 角色 id。角色被刪掉後名字就沒了，靠它還能認出是誰的調度在動。 */
    charId?: string;
    /**
     * 這條記的是什麼。省略 = 一次真實的模型調用。
     *   - `skipped`：調度到點了，但這一輪沒走到模型（角色沒接入、角色已刪）
     *   - `throttled`：來得太密，被最小間隔閘攔下。出現這一行就說明有東西在催調度
     *   - `tripped`：連續失敗攢夠，自主登入被停掉
     */
    kind?: 'skipped' | 'throttled' | 'tripped';
    /** kind 非空時的一句話說明，直接顯示給用戶。 */
    note?: string;
    /**
     * 發起這次調用的**那一刻**讀到的接入狀態。
     *
     * 「界面上明明全關了，調用記錄還在漲」這類反饋，光看請求本身分不清是誰的鍋：
     * 是這一輪繞過了接入判斷，還是界面和實際跑的是兩份數據。把當時讀到的值一起記下來，
     * 一眼就能分開。
     */
    charEnabled?: boolean;
}

// 舊版本曾把數據放在 localStorage，這裡做一次性遷移到 IndexedDB。
const OLD_API_KEY = 'vr_world_api';
const OLD_LOG_KEY = 'vr_world_api_log';
let migrated = false;
async function migrateOnce(): Promise<void> {
    if (migrated) return;
    migrated = true;
    try {
        const oldApi = localStorage.getItem(OLD_API_KEY);
        if (oldApi) { await DB.saveVRApiConfig(JSON.parse(oldApi)); localStorage.removeItem(OLD_API_KEY); }
        const oldLog = localStorage.getItem(OLD_LOG_KEY);
        if (oldLog) { await DB.setVRApiLog(JSON.parse(oldLog)); localStorage.removeItem(OLD_LOG_KEY); }
    } catch { /* ignore */ }
}

/** 彼方獨立 API；null = 跟隨聊天默認。 */
export async function getVRApi(): Promise<APIConfig | null> {
    await migrateOnce();
    return (await DB.getVRApiConfig()) as APIConfig | null;
}

export async function setVRApi(cfg: APIConfig | null): Promise<void> {
    await DB.saveVRApiConfig(cfg ?? null);
    try { window.dispatchEvent(new CustomEvent('vr-api-changed')); } catch { /* ignore */ }
}

export async function getVRApiLog(): Promise<VRApiCall[]> {
    await migrateOnce();
    return (await DB.getVRApiLog()) as VRApiCall[];
}

export async function logVRApiCall(entry: VRApiCall): Promise<void> {
    try {
        await DB.appendVRApiLog(entry);
        window.dispatchEvent(new CustomEvent('vr-api-log'));
    } catch { /* ignore */ }
}

export async function clearVRApiLog(): Promise<void> {
    await DB.clearVRApiLog();
    try { window.dispatchEvent(new CustomEvent('vr-api-log')); } catch { /* ignore */ }
}
