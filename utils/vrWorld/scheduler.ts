/**
 * 「彼方」自主登入調度器。
 *
 * 複用 proactiveChat.ts 經過驗證的穩態定時模式：
 *   - 前台：單個精確 setTimeout 命中下一個到期時刻（前台計時器準）
 *   - visibilitychange / focus：回到前台時立刻補火 + 重排（後台節流會延遲）
 *   - 主線程 20s 輪詢：最後兜底，防止精確計時器被後台節流卡死
 *
 * 但用**獨立的存儲鍵**（vr_schedules / vr_last_fire），和主動發消息
 * (proactive_schedules) 各自獨立、互不擠佔觸發。
 *
 * 說明：v1 不接 Service Worker / Cloudflare 雲端喚醒（那套 channel 與
 * proactive 強綁定）。前台精確計時 + 可見性補火已能覆蓋"用戶打開 App 時
 * 角色按時登入"的核心訴求；雲端加速可後續疊加。
 */

import type { VRSARActivity } from '../../types';

export interface VRSchedule {
    charId: string;
    intervalMs: number;
}

type ScheduleMap = Record<string, VRSchedule>;
type LastFireMap = Record<string, number>;
type FailStreakMap = Record<string, number>;

/** 一輪活動的結局。`skipped` = 壓根沒調模型（沒書沒歌、房間被佔、角色沒接入），不算帳。 */
export type VRSessionOutcome = 'ok' | 'failed' | 'skipped';

const STORAGE_KEY = 'vr_schedules';
const LAST_FIRE_KEY = 'vr_last_fire';
const FAIL_STREAK_KEY = 'vr_fail_streak';

/**
 * 連著失敗這麼多次，就掐掉這個角色的自主登入。
 *
 * 彼方整個跑在後台：令牌被停用、餘額耗盡這類「再試也不會好」的故障，用戶在界面上
 * 一點都看不見，只會在幾小時後翻調用記錄時發現全是紅的。攢夠這個數就停調度、把角色
 * 落回未接入，讓它自己收手，而不是通宵一輪輪撞下去。
 */
export const VR_FAIL_LIMIT = 3;

function load<T>(key: string): T {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object' ? parsed : {}) as T;
    } catch {
        return {} as T;
    }
}

function save(key: string, value: object) {
    if (Object.keys(value).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
}

const loadSchedules = () => load<ScheduleMap>(STORAGE_KEY);
const saveSchedules = (s: ScheduleMap) => save(STORAGE_KEY, s);
const loadLastFire = () => load<LastFireMap>(LAST_FIRE_KEY);
const saveLastFire = (m: LastFireMap) => save(LAST_FIRE_KEY, m);
const loadFailStreak = () => load<FailStreakMap>(FAIL_STREAK_KEY);
const saveFailStreak = (m: FailStreakMap) => save(FAIL_STREAK_KEY, m);

function removeFailStreak(charId: string) {
    const m = loadFailStreak();
    if (m[charId] === undefined) return;
    delete m[charId];
    saveFailStreak(m);
}

function getLastFire(charId: string): number {
    return loadLastFire()[charId] || 0;
}
function setLastFire(charId: string, ts: number) {
    const m = loadLastFire();
    m[charId] = ts;
    saveLastFire(m);
}
function removeLastFire(charId: string) {
    const m = loadLastFire();
    delete m[charId];
    saveLastFire(m);
}

let triggerCallback: ((charId: string, room?: string, letterId?: string, manual?: boolean, sarActivity?: VRSARActivity) => void | Promise<void>) | null = null;
let visibilityListener: (() => void) | null = null;
let focusListener: (() => void) | null = null;
let mainThreadTimer: ReturnType<typeof setInterval> | null = null;
let preciseTimer: ReturnType<typeof setTimeout> | null = null;

const MAIN_THREAD_CHECK_INTERVAL = 20_000;

function checkOverdue() {
    if (!triggerCallback) return;
    const schedules = Object.values(loadSchedules());
    const now = Date.now();
    for (const s of schedules) {
        const lastFire = getLastFire(s.charId);
        if (lastFire > 0 && now - lastFire >= s.intervalMs) {
            setLastFire(s.charId, now);
            void triggerCallback(s.charId);
        }
    }
    schedulePreciseTimer();
}

function schedulePreciseTimer() {
    if (preciseTimer) {
        clearTimeout(preciseTimer);
        preciseTimer = null;
    }
    if (!triggerCallback) return;
    const schedules = Object.values(loadSchedules());
    if (schedules.length === 0) return;

    const now = Date.now();
    let nextDue = Infinity;
    for (const s of schedules) {
        const lastFire = getLastFire(s.charId);
        const base = lastFire > 0 ? lastFire : now;
        const due = base + s.intervalMs;
        if (due < nextDue) nextDue = due;
    }
    if (!Number.isFinite(nextDue)) return;

    const delay = Math.min(Math.max(nextDue - now, 500), 2_147_000_000);
    preciseTimer = setTimeout(() => {
        preciseTimer = null;
        checkOverdue();
    }, delay);
}

/** 撤掉一個角色的自主登入，連帶清掉它的首火時刻和失敗計數。 */
function stopSchedule(charId: string) {
    const schedules = loadSchedules();
    delete schedules[charId];
    saveSchedules(schedules);
    removeLastFire(charId);
    removeFailStreak(charId);
    if (Object.keys(schedules).length === 0) detachListeners();
    else schedulePreciseTimer();
}

function handleVisibility() {
    if (document.visibilityState !== 'visible') return;
    checkOverdue();
}

function attachListeners() {
    detachListeners();
    visibilityListener = handleVisibility;
    document.addEventListener('visibilitychange', visibilityListener);
    focusListener = checkOverdue;
    window.addEventListener('focus', focusListener);
    if (!mainThreadTimer) mainThreadTimer = setInterval(checkOverdue, MAIN_THREAD_CHECK_INTERVAL);
    schedulePreciseTimer();
}

function detachListeners() {
    if (visibilityListener) {
        document.removeEventListener('visibilitychange', visibilityListener);
        visibilityListener = null;
    }
    if (focusListener) {
        window.removeEventListener('focus', focusListener);
        focusListener = null;
    }
    if (mainThreadTimer) {
        clearInterval(mainThreadTimer);
        mainThreadTimer = null;
    }
    if (preciseTimer) {
        clearTimeout(preciseTimer);
        preciseTimer = null;
    }
}

export const VRScheduler = {
    /** 註冊觸發回調（應用啟動時調一次）。 */
    onTrigger(callback: (charId: string, room?: string, letterId?: string, manual?: boolean, sarActivity?: VRSARActivity) => void | Promise<void>) {
        triggerCallback = callback;
        attachListeners();
        checkOverdue();
    },

    /** 啟動/更新某角色的自主登入（intervalMinutes 會按 30min 對齊，最小 30）。 */
    start(charId: string, intervalMinutes: number) {
        const clamped = Math.max(30, Math.round(intervalMinutes / 30) * 30);
        const intervalMs = clamped * 60 * 1000;
        const schedules = loadSchedules();
        schedules[charId] = { charId, intervalMs };
        saveSchedules(schedules);
        setLastFire(charId, Date.now());
        // 重新啟用 = 用戶已經去處理過（換了 API / 充了值），舊的失敗帳一筆勾銷，
        // 否則熔斷過一次的角色剛開回來就會被上一輪的餘額一腳踢停。
        removeFailStreak(charId);
        attachListeners();
        console.log(`[VRScheduler] Started: ${charId}, every ${clamped}min`);
    },

    /** 停止某角色。 */
    stop(charId: string) {
        stopSchedule(charId);
        console.log(`[VRScheduler] Stopped: ${charId}`);
    },

    /**
     * 回報一輪活動的結局，用來判斷要不要熔斷。
     *
     * `failed` 累計到 {@link VR_FAIL_LIMIT} 就把調度掐掉並返回 `tripped: true`；
     * 中間只要成功一次，計數就歸零。調用方拿到 `tripped` 後負責把角色落回未接入、
     * 並告訴用戶——調度器只管自己這張表，不碰角色數據。
     */
    report(charId: string, outcome: VRSessionOutcome): { tripped: boolean; streak: number } {
        if (outcome === 'skipped') return { tripped: false, streak: loadFailStreak()[charId] || 0 };
        if (outcome === 'ok') {
            removeFailStreak(charId);
            return { tripped: false, streak: 0 };
        }
        const m = loadFailStreak();
        const streak = (m[charId] || 0) + 1;
        m[charId] = streak;
        saveFailStreak(m);
        if (streak < VR_FAIL_LIMIT) return { tripped: false, streak };
        stopSchedule(charId);
        console.warn(`[VRScheduler] 連續 ${streak} 次失敗，已停掉自主登入: ${charId}`);
        return { tripped: true, streak };
    },

    /** 當前累計的連續失敗次數（面板展示用）。 */
    getFailStreak(charId: string): number {
        return loadFailStreak()[charId] || 0;
    },

    /** 重載後恢復所有計劃。 */
    resume() {
        const schedules = Object.values(loadSchedules());
        if (schedules.length === 0) return;
        attachListeners();
        handleVisibility();
    },

    /**
     * 以角色 vrState 為準重建調度。
     *
     * 調度表（vr_schedules / vr_last_fire）存 localStorage，**不隨備份導出/導入遷移**，
     * 而啟用狀態（vrState.enabled / intervalMinutes）存在角色對象裡隨 IndexedDB 備份走。
     * 導入到新設備 / 新瀏覽器檔案後，角色明明是 enabled 但調度表為空，resume() 直接
     * 早退 → 角色永遠不會自主登入。數據加載完成後調用本方法對帳即可修復。
     *
     * - 啟用但缺調度 → 補建（首火從現在起算，避免導入瞬間爆觸發一堆 LLM 調用）
     * - 間隔被改過 → 跟隨最新設定
     * - 已刪除 / 已關閉的角色 → 清掉殘留調度
     */
    reconcile(active: { charId: string; intervalMinutes: number }[]) {
        const schedules = loadSchedules();
        const activeIds = new Set(active.map(a => a.charId));
        let changed = false;

        for (const a of active) {
            const clamped = Math.max(30, Math.round(a.intervalMinutes / 30) * 30);
            const intervalMs = clamped * 60 * 1000;
            const existing = schedules[a.charId];
            if (!existing) {
                schedules[a.charId] = { charId: a.charId, intervalMs };
                if (getLastFire(a.charId) === 0) setLastFire(a.charId, Date.now());
                changed = true;
            } else if (existing.intervalMs !== intervalMs) {
                existing.intervalMs = intervalMs;
                changed = true;
            }
        }

        for (const id of Object.keys(schedules)) {
            if (!activeIds.has(id)) {
                delete schedules[id];
                removeLastFire(id);
                removeFailStreak(id);
                changed = true;
            }
        }

        if (changed) saveSchedules(schedules);
        if (Object.keys(schedules).length > 0) attachListeners();
        else detachListeners();
    },

    isActiveFor(charId: string): boolean {
        return !!loadSchedules()[charId];
    },

    getIntervalMinutes(charId: string): number | null {
        const s = loadSchedules()[charId];
        return s ? s.intervalMs / 60000 : null;
    },

    /** 立刻觸發一次（UI 上"現在去逛逛"按鈕用），不影響計劃。room 可指定房間，省略則隨機；letterId 可指定要回復的來信。 */
    triggerNow(charId: string, room?: string, letterId?: string, sarActivity?: VRSARActivity) {
        setLastFire(charId, Date.now());
        schedulePreciseTimer();
        if (triggerCallback) {
            if (sarActivity) void triggerCallback(charId, room, letterId, true, sarActivity);
            else void triggerCallback(charId, room, letterId, true);
        }
    },
};
