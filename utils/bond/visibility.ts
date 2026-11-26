/**
 * 心意的知情範圍（plans/bond-batch3.md 第 2 節，紀要 4.1）：**生成和顯示用同一套判斷**。
 * 這裡挑出「這位角色現在知道的」日記、問答、紙條；提示詞照這份組（prompt.ts），畫面用同一批判斷
 * （utils/bond/diary.ts 的 pagePublished、question.ts 的 visibleAnswer、slip.ts 的 slipDelivered）。
 *
 * - 日記：只有發布的頁（你的草稿不算）。
 * - 問答：揭曉的輪雙方都知道；自己封存還沒揭曉的只有自己知道；對方封存還沒揭曉的答案誰也不能先看；
 *   對方出了題、你還沒答的，你只知道題目。
 * - 紙條：只有投遞的。
 */
import type { BondEntry, DiaryEntry } from '../../types';
import { pagePublished } from './diary';
import { lastRound, revealedRounds, sideOfAuthor, visibleAnswer, waitingOn } from './question';
import { slipDelivered } from './slip';
import { eventSortKey } from './eventDate';

export const PROMPT_DIARY_LIMIT = 2;
export const PROMPT_QUESTION_REVEALED_LIMIT = 3;
export const PROMPT_SLIP_LIMIT = 5;

export interface KnownDiary {
    date: string;
    /** 你那頁（發布了才有） */
    user?: string;
    /** 角色那頁（發布了才有） */
    char?: string;
}

/** 最近幾本有發布內容的日記（新到舊） */
export function knownDiaries(diaries: DiaryEntry[], limit = PROMPT_DIARY_LIMIT): KnownDiary[] {
    return [...diaries]
        .sort((a, b) => (a.date === b.date ? b.timestamp - a.timestamp : b.date.localeCompare(a.date)))
        .map(d => ({
            date: d.date,
            ...(pagePublished(d.userPage) ? { user: d.userPage.text.trim() } : {}),
            ...(pagePublished(d.charPage) ? { char: d.charPage!.text.trim() } : {}),
        }))
        .filter(d => d.user || d.char)
        .slice(0, limit);
}

export interface KnownQuestions {
    /** 揭曉過的題（最後一次揭曉那輪；舊的輪數另外給） */
    revealed: Array<{ prompt: string; mine?: string; theirs?: string; earlier: number; at: number }>;
    /** 角色自己封存、對方還沒答的 */
    mineSealed: Array<{ prompt: string; mine: string }>;
    /** 對方出了題、角色還沒答的（只有題目） */
    askedMe: Array<{ prompt: string }>;
}

/** 這段關係裡的角色現在知道的問答（身份卡 × 角色：答題的一方就是 'char'） */
export function knownQuestions(entries: BondEntry[], limit = PROMPT_QUESTION_REVEALED_LIMIT): KnownQuestions {
    const qs = entries.filter(e => e.kind === 'question' && e.status === 'published' && e.question);
    const revealed = qs
        .map(e => {
            const rs = revealedRounds(e.question);
            const r = rs[rs.length - 1];
            if (!r) return null;
            const mine = visibleAnswer(r, 'char', 'char');
            const theirs = visibleAnswer(r, 'user', 'char');
            return {
                prompt: e.question!.prompt,
                ...(mine && mine.state !== 'skipped' ? { mine: mine.text } : {}),
                ...(theirs && theirs.state !== 'skipped' ? { theirs: theirs.text } : {}),
                earlier: rs.length - 1,
                at: r.revealedAt!,
            };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    const mineSealed: KnownQuestions['mineSealed'] = [];
    const askedMe: KnownQuestions['askedMe'] = [];
    for (const e of qs) {
        const r = lastRound(e.question);
        if (!r || r.revealedAt) continue;
        const mine = r.char;
        if (mine?.state === 'sealed') mineSealed.push({ prompt: e.question!.prompt, mine: mine.text });
        else if (waitingOn(e).includes('char') && sideOfAuthor(r.openedBy) === 'user') askedMe.push({ prompt: e.question!.prompt });
    }
    return { revealed, mineSealed, askedMe };
}

export interface KnownSlip {
    fromUser: boolean;
    tags: string[];
    text: string;
    state?: NonNullable<BondEntry['slip']>['state'];
    isReply: boolean;
    at: number;
}

/** 最近投遞的紙條（新到舊） */
export function knownSlips(entries: BondEntry[], limit = PROMPT_SLIP_LIMIT): KnownSlip[] {
    return entries
        .filter(slipDelivered)
        .map(e => ({
            fromUser: e.author === 'user',
            tags: e.slip?.tags || [],
            text: e.text,
            ...(e.slip?.state ? { state: e.slip.state } : {}),
            isReply: !!e.slip?.replyTo,
            at: e.slip?.deliveredAt || e.writtenAt,
        }))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
}

// ─── 約定（plans/bond-batch4.md 第 3 節） ─────────────

export const PROMPT_WISH_LIMIT = 6;
export const PROMPT_MILESTONE_LIMIT = 3;

export interface KnownWish {
    /** 'user'＝對方的、'char'＝你自己的、'both'＝你們一起的 */
    owner: 'user' | 'char' | 'both';
    text: string;
    state: NonNullable<BondEntry['wish']>['state'];
    /** 對方支持了（支持的那一方） */
    supportedBy?: 'user' | 'char';
    at: number;
}

/** 發布的願望（草稿只有寫的人知道），最近幾個 */
export function knownWishes(entries: BondEntry[], limit = PROMPT_WISH_LIMIT): KnownWish[] {
    return entries
        .filter(e => e.kind === 'wish' && e.status === 'published' && e.wish && e.text.trim())
        .map(e => ({
            owner: e.wish!.owner === 'both' ? 'both' as const : e.wish!.owner === 'user' ? 'user' as const : 'char' as const,
            text: e.text.trim(),
            state: e.wish!.state,
            ...(e.wish!.support ? { supportedBy: e.wish!.support.by === 'user' ? 'user' as const : 'char' as const } : {}),
            at: e.updatedAt,
        }))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
}

export interface KnownPromises {
    /** 成立、進行中的（全部） */
    active: Array<{ text: string; repeat: NonNullable<BondEntry['promise']>['repeat'] }>;
    /** 還在商量的：等誰說好 */
    proposed: Array<{ text: string; waitingOn: 'user' | 'char' }>;
}

export function knownPromises(entries: BondEntry[]): KnownPromises {
    const ps = entries.filter(e => e.kind === 'promise' && e.promise && e.text.trim()).sort((a, b) => a.writtenAt - b.writtenAt);
    return {
        active: ps.filter(e => e.promise!.state === 'active').map(e => ({ text: e.text.trim(), repeat: e.promise!.repeat })),
        proposed: ps.filter(e => e.promise!.state === 'proposed').map(e => ({ text: e.text.trim(), waitingOn: !e.promise!.agreedBy.char ? 'char' as const : 'user' as const })),
    };
}

/** 雙方確認的默契（提議中、不再這樣的不算） */
export function knownHabits(entries: BondEntry[]): string[] {
    return entries
        .filter(e => e.kind === 'habit' && e.habit?.state === 'active' && e.text.trim())
        .sort((a, b) => a.writtenAt - b.writtenAt)
        .map(e => e.text.trim());
}

/** 最近的里程碑（照事件日期，新到舊） */
export function knownMilestones(entries: BondEntry[], limit = PROMPT_MILESTONE_LIMIT): BondEntry[] {
    return entries
        .filter(e => e.kind === 'milestone' && e.status === 'published' && e.milestone)
        .sort((a, b) => (eventSortKey(b.eventDate) || '').localeCompare(eventSortKey(a.eventDate) || '') || b.writtenAt - a.writtenAt)
        .slice(0, limit);
}
