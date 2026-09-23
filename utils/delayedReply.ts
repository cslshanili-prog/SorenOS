import type { DelayedReplySettings } from '../types';

/**
 * 聊天設定 · Scenario ·「延遲自動回覆」的純邏輯與待回清單。
 *
 * 用戶發完訊息後排一個「到點該回」的時刻，存在 localStorage：
 * - 聊天頁開著、正看著這個角色 → 到點時聊天頁自己觸發回覆（走完整的聊天管線）；
 * - 離開了聊天 → OSContext 用背景生成（主動消息 1.0 同一條路，回覆模式）；
 * - App 被整個關掉 → 下次打開時把過了點的補回。
 * 開了主動消息 2.0 的角色，排好之後會再交一條一次性任務給雲端（見 utils/delayedReplyCloud.ts），
 * 時間比 dueAt 晚一分鐘：頁面開著時本地先接手並取消雲端那條，頁面關著時就由雲端生成、推播過來。
 * 手動按回覆（⚡）會直接回，同時取消排好的這一筆。接線見 apps/Chat.tsx、context/OSContext.tsx。
 */

export const DEFAULT_DELAYED_REPLY: DelayedReplySettings = { enabled: false, minMinutes: 1, maxMinutes: 60 };
export const DELAYED_REPLY_MAX_MINUTES = 24 * 60;

/** 讀存檔：補預設、夾範圍、保證最短 ≤ 最長。 */
export function normalizeDelayedReply(raw: Partial<DelayedReplySettings> | undefined | null): DelayedReplySettings {
    const clamp = (v: unknown, fallback: number) => {
        const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
        return Math.min(DELAYED_REPLY_MAX_MINUTES, Math.max(0, n));
    };
    const min = clamp(raw?.minMinutes, DEFAULT_DELAYED_REPLY.minMinutes);
    const max = Math.max(min, clamp(raw?.maxMinutes, DEFAULT_DELAYED_REPLY.maxMinutes));
    return { enabled: raw?.enabled === true, minMinutes: min, maxMinutes: max };
}

/** 這次要等多久（毫秒）。用戶設的是範圍，落在範圍裡哪一段看角色此刻的狀態。 */
export function computeReplyDelayMs(
    settings: DelayedReplySettings,
    context: { slotKind: 'sleep' | 'busy' | null; recentlyActive: boolean },
    rand: number = Math.random(),
): number {
    const { minMinutes, maxMinutes } = normalizeDelayedReply(settings);
    // 範圍內的哪一段：睡覺 → 最後兩成；在忙 → 後半；空閒 → 前六成；正聊得起勁又空閒 → 前兩成五
    const [lo, hi] = context.slotKind === 'sleep' ? [0.8, 1]
        : context.slotKind === 'busy' ? [0.5, 1]
        : context.recentlyActive ? [0, 0.25]
        : [0, 0.6];
    const r = Math.min(1, Math.max(0, rand));
    const minutes = minMinutes + (maxMinutes - minMinutes) * (lo + (hi - lo) * r);
    return Math.max(10_000, Math.round(minutes * 60_000));
}

// ── 待回清單（localStorage，每個角色最多一筆）────────────────────────────────

export interface PendingDelayedReply {
    dueAt: number;
    scheduledAt: number;
    /** 已經交給主動消息 2.0 雲端的那條一次性任務（沒交就沒有這個字段）。 */
    cloud?: { uuid: string; sendAt: number };
}

/** 雲端那條排在 dueAt 之後多久：留一分鐘給本地先接手（頁面開著時本地回、取消雲端）。 */
export const CLOUD_HANDOFF_DELAY_MS = 60_000;
/** 離雲端那條不到這麼久就不再由本地搶：取消請求來不及趕在雲端撿走之前，會回兩次。 */
export const CLOUD_LOCAL_MARGIN_MS = 20_000;
/** 雲端那條過了點這麼久還沒收到回覆，才去問雲端它怎麼了。 */
export const CLOUD_CHECK_AFTER_MS = 3 * 60_000;

const STORAGE_KEY = 'soren_delayed_replies';
export const DELAYED_REPLY_CHANGED_EVENT = 'delayed-reply-changed';
/** 到點了、而且用戶正看著這個角色的聊天頁：由聊天頁自己觸發回覆。 */
export const DELAYED_REPLY_DUE_EVENT = 'delayed-reply-due';

function read(): Record<string, PendingDelayedReply> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function write(all: Record<string, PendingDelayedReply>): void {
    try {
        if (Object.keys(all).length === 0) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch { /* 存不進去就只在這次開著的期間有效 */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DELAYED_REPLY_CHANGED_EVENT));
}

export function getPendingDelayedReply(charId: string): PendingDelayedReply | null {
    return read()[charId] ?? null;
}

/**
 * 排一筆待回。已經有排著的就不動——真人也是看到第一則訊息才決定什麼時候回，
 * 後面連發幾則不會讓回覆時間一直往後推。
 */
export function scheduleDelayedReply(charId: string, delayMs: number, now: number = Date.now()): PendingDelayedReply {
    const all = read();
    if (all[charId]) return all[charId];
    const entry = { dueAt: now + delayMs, scheduledAt: now };
    write({ ...all, [charId]: entry });
    return entry;
}

/** 移除這個角色排著的那筆，回傳被移除的（雲端那條要由調用方去取消）。 */
export function takeDelayedReply(charId: string): PendingDelayedReply | null {
    const all = read();
    const entry = all[charId];
    if (!entry) return null;
    delete all[charId];
    write(all);
    return entry;
}

export function cancelDelayedReply(charId: string): void {
    takeDelayedReply(charId);
}

/**
 * 記下交給雲端的那條任務。只在「還是同一筆」時記（dueAt 沒變）：交雲端要好幾秒，
 * 這期間用戶可能已經按了回覆、或這筆已經被本地回掉又排了新的。記不上回傳 false，
 * 調用方要把剛建的雲端任務取消掉。
 */
export function attachCloudToDelayedReply(charId: string, dueAt: number, cloud: { uuid: string; sendAt: number }): boolean {
    const all = read();
    const entry = all[charId];
    if (!entry || entry.dueAt !== dueAt || entry.cloud) return false;
    write({ ...all, [charId]: { ...entry, cloud } });
    return true;
}

/** 這個角色有一筆交給了雲端、還沒回的待回嗎（雲端 fire_pack 得跟著最新的聊天走）。 */
export function hasCloudDelayedReply(charId: string): boolean {
    return !!read()[charId]?.cloud;
}

/** 雲端那條的回覆落進聊天了：這筆就算回過了（只認同一條任務）。 */
export function settleCloudDelayedReply(charId: string, taskUuid: string | null | undefined): boolean {
    if (!taskUuid) return false;
    const entry = read()[charId];
    if (!entry?.cloud || entry.cloud.uuid !== taskUuid) return false;
    takeDelayedReply(charId);
    return true;
}

/**
 * 取出並移除該由本地回的那些。
 * 沒交雲端的：到點就是本地的。交了雲端的：只有頁面看得見、而且離雲端那條還夠遠時本地才搶
 * （調用方負責取消雲端那條）；頁面在背景就留給雲端，推播過來。
 */
export function takeDueDelayedReplies(
    now: number = Date.now(),
    opts: { visible?: boolean } = {},
): Array<{ charId: string; entry: PendingDelayedReply }> {
    const visible = opts.visible !== false;
    const all = read();
    const due = Object.entries(all).filter(([, v]) => {
        if (!v || v.dueAt > now) return false;
        if (!v.cloud) return true;
        return visible && now < v.cloud.sendAt - CLOUD_LOCAL_MARGIN_MS;
    });
    if (due.length === 0) return [];
    for (const [id] of due) delete all[id];
    write(all);
    return due.map(([charId, entry]) => ({ charId, entry }));
}

/** 交了雲端、過點好一陣子還沒收到回覆的（不移除，由調用方問過雲端再決定）。 */
export function listOverdueCloudDelayedReplies(now: number = Date.now()): Array<{ charId: string; entry: PendingDelayedReply }> {
    return Object.entries(read())
        .filter(([, v]) => !!v?.cloud && now > v.cloud.sendAt + CLOUD_CHECK_AFTER_MS)
        .map(([charId, entry]) => ({ charId, entry }));
}

/**
 * 雲端那條任務的「本次任務」指令。fire_pack 的模板是寫給主動消息的（上面還有一段
 * 「1.0 風格主動消息提示」），這裡要明說這次不是主動找對方，是在回對方的訊息。
 * 當前時間、對方多久前說的話，模板本身在到點時會填上。
 */
export function buildCloudDelayedReplyInstruction(userName: string): string {
    const name = userName.trim() || '對方';
    return [
        `這一次不是你主動找${name}：上面那段「主動消息提示」這次不適用。`,
        `${name}之前傳了訊息給你（就是最近對話上下文最後那幾則），你現在才拿起手機看到。`,
        `像平常聊天一樣回覆${name}剛才的訊息就好；要不要提自己晚回、為什麼晚回，看你的性格和當下的狀況。`,
        `如果最近對話裡你其實已經回過${name}這幾則訊息了，就什麼都不要輸出。`,
    ].join('\n');
}
