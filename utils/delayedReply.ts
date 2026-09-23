import type { DelayedReplySettings } from '../types';

/**
 * 聊天設定 · Scenario ·「延遲自動回覆」的純邏輯與待回清單。
 *
 * 用戶發完訊息後排一個「到點該回」的時刻，存在 localStorage：
 * - 聊天頁開著、正看著這個角色 → 到點時聊天頁自己觸發回覆（走完整的聊天管線）；
 * - 離開了聊天 → OSContext 用背景生成（主動消息 1.0 同一條路，回覆模式）；
 * - App 被整個關掉 → 下次打開時把過了點的補回。
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
}

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

export function cancelDelayedReply(charId: string): void {
    const all = read();
    if (!all[charId]) return;
    delete all[charId];
    write(all);
}

/** 取出並移除所有已到點的角色 id。 */
export function takeDueDelayedReplies(now: number = Date.now()): string[] {
    const all = read();
    const due = Object.entries(all).filter(([, v]) => !(v?.dueAt > now)).map(([id]) => id);
    if (due.length === 0) return [];
    for (const id of due) delete all[id];
    write(all);
    return due;
}
