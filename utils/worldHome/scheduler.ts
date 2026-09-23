/**
 * 「家園」離線 tick 調度器。
 *
 * 與 VRScheduler 的"固定間隔"不同，家園按**每日時段**觸發：
 * 凌晨（02:00 後）/ 早（09:00 後）/ 午（14:00 後）/ 晚（21:00 後），每個時段當天最多一輪。
 * 錯過時段後回到前台會補火（和 VRScheduler 一樣的 visibilitychange / focus /
 * 主線程輪詢三重兜底），所以"早上沒開 App，中午打開"會把早上那輪補上——
 * 這正是"我不看的時候世界慢慢走，我一看就加速"的體驗。
 *
 * 時段判定按**每個世界自己的時區**（WorldProfile.timezone，不設=本機）：不然「東京家園的早上」
 * 會在本機凌晨觸發，和世界鍾（realNowSeg）對不上。日曆日也一樣按世界時區算，否則跨日的
 * fired 記錄會在錯誤的時刻清零、當天配額被多燒一輪。
 *
 * 存儲（localStorage，獨立鍵，不與 vr_schedules / proactive 擠佔）：
 *   - world_tick_slots: { [worldId]: { slots: slot[]; tz?: string } }（舊格式 slot[] 讀時自動兼容）
 *   - world_tick_fired: { [worldId]: { date: 'YYYY-MM-DD', fired: slot[] } }
 */

import type { WorldProfile } from '../../types';
import { nowInTimeZone } from '../timezone';

export type WorldTickSlot = 'latenight' | 'morning' | 'noon' | 'evening';

const SLOTS_KEY = 'world_tick_slots';
const FIRED_KEY = 'world_tick_fired';
const MAIN_THREAD_CHECK_INTERVAL = 60_000;

/** 各時段的起火時刻（小時，世界當地時間）。latenight 按當天日曆日的凌晨 2 點計。 */
const SLOT_HOUR: Record<WorldTickSlot, number> = { latenight: 2, morning: 9, noon: 14, evening: 21 };

/** 一個世界的調度項。tz 空 = 跟隨本機。 */
type SlotEntry = { slots: WorldTickSlot[]; tz?: string };
/** 舊格式（值直接是 slot 數組）也要讀得動——老用戶的 localStorage 裡就是它。 */
type SlotsMap = Record<string, SlotEntry | WorldTickSlot[]>;
type FiredMap = Record<string, { date: string; fired: WorldTickSlot[] }>;

/** 兼容讀取：舊格式 slot[] → { slots }。 */
const normalizeEntry = (v: SlotEntry | WorldTickSlot[] | undefined): SlotEntry =>
    Array.isArray(v) ? { slots: v } : { slots: v?.slots || [], tz: v?.tz };

const sameSlots = (a: WorldTickSlot[], b: WorldTickSlot[]): boolean =>
    a.length === b.length && a.every(slot => b.includes(slot));

/**
 * 世界列表 → reconcile 的入參（三處調用點共用一份口徑，避免漏傳時區）。
 * 只收開了離線 tick 的世界；sim（虛擬時間）世界不跟世界時區，按本機時刻觸發。
 */
export const toTickEntries = (worlds: WorldProfile[]): { worldId: string; slots: WorldTickSlot[]; tz?: string }[] =>
    worlds
        .filter(w => (w.offlineTickSlots?.length || 0) > 0)
        .map(w => ({
            worldId: w.id,
            slots: w.offlineTickSlots!,
            tz: (w.timeMode ?? 'real') === 'sim' ? undefined : w.timezone,
        }));

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

/** 某世界當地的「今天」與「現在幾點」。tz 空 = 本機。 */
const localNow = (tz?: string) => {
    const d = nowInTimeZone(tz);
    return {
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        hour: d.getHours(),
    };
};

let triggerCallback: ((worldId: string, trigger: 'observe' | 'tick') => void | Promise<void>) | null = null;
let visibilityListener: (() => void) | null = null;
let focusListener: (() => void) | null = null;
let mainThreadTimer: ReturnType<typeof setInterval> | null = null;

function checkDue() {
    if (!triggerCallback) return;
    const slotsMap = load<SlotsMap>(SLOTS_KEY);
    const firedMap = load<FiredMap>(FIRED_KEY);
    let changed = false;

    for (const [worldId, raw] of Object.entries(slotsMap)) {
        const { slots, tz } = normalizeEntry(raw);
        if (slots.length === 0) continue;
        // 時段/日曆日按這個世界自己的時區判定
        const { date, hour } = localNow(tz);
        let rec = firedMap[worldId];
        if (!rec || rec.date !== date) {
            rec = { date, fired: [] };
            firedMap[worldId] = rec;
            changed = true;
        }
        for (const slot of slots) {
            if (rec.fired.includes(slot)) continue;
            if (hour < SLOT_HOUR[slot]) continue;
            rec.fired.push(slot);
            changed = true;
            void triggerCallback(worldId, 'tick');
            // 一次 check 每個世界最多補一輪：鏈式 N 角色調用很貴，
            // 錯過的多個時段隔分鐘級輪詢逐個補，不在同一瞬間疊加觸發。
            break;
        }
    }
    if (changed) save(FIRED_KEY, firedMap);
}

function handleVisibility() {
    if (document.visibilityState !== 'visible') return;
    checkDue();
}

function attachListeners() {
    detachListeners();
    visibilityListener = handleVisibility;
    document.addEventListener('visibilitychange', visibilityListener);
    focusListener = checkDue;
    window.addEventListener('focus', focusListener);
    if (!mainThreadTimer) mainThreadTimer = setInterval(checkDue, MAIN_THREAD_CHECK_INTERVAL);
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
}

export const WorldScheduler = {
    /** 註冊觸發回調（應用啟動時調一次）。 */
    onTrigger(callback: (worldId: string, trigger: 'observe' | 'tick') => void | Promise<void>) {
        triggerCallback = callback;
        if (Object.keys(load<SlotsMap>(SLOTS_KEY)).length > 0) {
            attachListeners();
            checkDue();
        }
    },

    /**
     * 以世界配置為準重建調度表。
     * 調度表存 localStorage 不隨備份遷移，世界配置（offlineTickSlots）存 IndexedDB
     * 隨備份走——和 VRScheduler.reconcile 同樣的對帳邏輯。
     * 注意：新加入調度的世界，"今天已經過去的時段"視為已耗盡，不補火——
     * 避免用戶剛配置完就瞬間連燒幾輪 LLM 調用。
     */
    reconcile(active: { worldId: string; slots: WorldTickSlot[]; tz?: string }[]) {
        const previousSlotsMap = load<SlotsMap>(SLOTS_KEY);
        const slotsMap: SlotsMap = {};
        const firedMap = load<FiredMap>(FIRED_KEY);
        let firedChanged = false;

        for (const a of active) {
            if (a.slots.length === 0) continue;
            slotsMap[a.worldId] = { slots: a.slots, tz: a.tz };
            // "今天已經過去的時段"按該世界當地時間算——換了時區的世界跟著一起挪
            const { date, hour } = localNow(a.tz);
            const previousRaw = previousSlotsMap[a.worldId];
            const previous = normalizeEntry(previousRaw);
            const configChanged = previousRaw === undefined
                || previous.tz !== a.tz
                || !sameSlots(previous.slots, a.slots);
            // 同一日內換時區也必須重算：例如東京 21 點切到洛杉磯 5 點，東京已經
            // fired 的 evening 在洛杉磯仍是未來，不能繼續佔著配額；反向切換則要
            // 把新時區已經過去的時段標為耗盡，避免配置一保存就補火。
            if (!firedMap[a.worldId] || firedMap[a.worldId].date !== date || configChanged) {
                firedMap[a.worldId] = { date, fired: a.slots.filter(s => hour >= SLOT_HOUR[s]) };
                firedChanged = true;
            }
        }
        for (const id of Object.keys(firedMap)) {
            if (!slotsMap[id]) {
                delete firedMap[id];
                firedChanged = true;
            }
        }

        save(SLOTS_KEY, slotsMap);
        if (firedChanged) save(FIRED_KEY, firedMap);
        if (Object.keys(slotsMap).length > 0) attachListeners();
        else detachListeners();
    },

    /** 立刻觸發一輪"觀測"（UI 推進按鈕用），不佔用當日 tick 配額。 */
    triggerNow(worldId: string) {
        if (triggerCallback) void triggerCallback(worldId, 'observe');
    },
};
