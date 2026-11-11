import { useSyncExternalStore } from 'react';

/**
 * 見面中途走開：見面掛著，頂端出現「見面中 · TA」，點一下回到原來的畫面。
 * 見 docs/date-quick-leave.md。
 *
 * 只放在記憶體裡（跟「通話中」一樣）：重新整理頁面後這條就沒了，但會話進度本來就寫在
 * 角色的 savedDateState，進見面照樣能「繼續上次」，不會丟。
 */

export interface SuspendedDate {
    charId: string;
    charName: string;
    /** 原本是從私聊「見面」進來的：回來之後點「保存並退出」照樣回私聊 */
    cameFromChat: boolean;
    at: number;
}

let current: SuspendedDate | null = null;
const listeners = new Set<() => void>();
const emit = () => { listeners.forEach(listener => listener()); };

/** 輸入框裡還沒送出的字，按角色存。送出就清掉。 */
const drafts = new Map<string, string>();
/** 還在生成的那一輪（送出／繼續／重新生成）。走開再回來時，畫面要接著等它，不能讓人再送一次。 */
const inflight = new Map<string, Promise<unknown>>();

export const dateSuspend = {
    get(): SuspendedDate | null {
        return current;
    },
    suspend(info: Omit<SuspendedDate, 'at'>): void {
        current = { ...info, at: Date.now() };
        emit();
    },
    /** 給 charId 就只清這個角色的那場（別的角色掛著的不動） */
    clear(charId?: string): void {
        if (!current) return;
        if (charId && current.charId !== charId) return;
        current = null;
        emit();
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
};

export const useSuspendedDate = (): SuspendedDate | null =>
    useSyncExternalStore(dateSuspend.subscribe, dateSuspend.get, dateSuspend.get);

export const dateDrafts = {
    get(charId: string): string {
        return drafts.get(charId) || '';
    },
    set(charId: string, text: string): void {
        if (text) drafts.set(charId, text); else drafts.delete(charId);
    },
};

export const dateInflight = {
    /** 包住一輪生成：跑完（成功或失敗）就自己拿掉，回傳原本那個 promise */
    track<T>(charId: string, run: Promise<T>): Promise<T> {
        inflight.set(charId, run);
        const done = () => { if (inflight.get(charId) === run) inflight.delete(charId); };
        run.then(done, done);
        return run;
    },
    get(charId: string): Promise<unknown> | null {
        return inflight.get(charId) || null;
    },
};

export interface QuickChatCandidate {
    id: string;
    name: string;
    avatar?: string;
    /** 最後一則私聊的時間；沒聊過是 null */
    lastAt: number | null;
    unread: number;
}

/** 見面「去私聊」的小表最多幾個人；其餘的走「所有訊息」 */
export const QUICK_CHAT_LIMIT = 5;

/**
 * 小表要列哪些人：有未讀的排最前面，其餘照最近一則訊息排，沒聊過的不列，最多 limit 個。
 */
export const pickQuickChatTargets = (candidates: QuickChatCandidate[], limit = QUICK_CHAT_LIMIT): QuickChatCandidate[] =>
    candidates
        .filter(c => c.lastAt !== null || c.unread > 0)
        .sort((a, b) => {
            const unreadDiff = Number(b.unread > 0) - Number(a.unread > 0);
            if (unreadDiff) return unreadDiff;
            return (b.lastAt ?? 0) - (a.lastAt ?? 0);
        })
        .slice(0, limit);

/** 見面選單裡的快速離開：回桌面、去某人的私聊、打開訊息列表 */
export type DateQuickLeaveTarget = { kind: 'home' } | { kind: 'chat'; charId: string } | { kind: 'messages' };
