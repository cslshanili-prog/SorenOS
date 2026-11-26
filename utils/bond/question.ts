/**
 * 拾光問答（plans/bond-batch3.md 1.2，紀要 3.7）。純邏輯，有測試。
 *
 * - 一張卡一題（bond_entries 的 question），一輪一輪的回答；重答＝開新的一輪，舊的整輪留著。
 * - 發起的人先答並封存，題目才送到對方那邊；雙方都交出（封存或跳過）那刻揭曉。
 * - **盲答是真的盲**：誰看得到哪個答案只有 `visibleAnswer` 一個判斷，畫面和提示詞都用它。
 */
import type { BondAnswer, BondEntry, BondQuestion, BondQuestionRound, BondQuestionTopic } from '../../types';
import { newBondEntryId } from './ids';

export type QSide = 'user' | 'char';

export const QUESTION_TOPIC_LABEL: Record<BondQuestionTopic, string> = {
    habit: '習慣', memory: '回憶', choice: '選擇', relationship: '關係', daily: '日常', custom: '自訂',
};

export const sideOfAuthor = (author: string): QSide => (author === 'user' ? 'user' : 'char');

export const lastRound = (q: BondQuestion | undefined): BondQuestionRound | undefined => q?.rounds[q.rounds.length - 1];

const done = (a: BondAnswer | undefined) => !!a && (a.state === 'sealed' || a.state === 'skipped');

export const roundRevealed = (r: BondQuestionRound | undefined): boolean => !!r?.revealedAt;

/** 新的一題：發起的人先寫答案（可以先暫存）；封存之前整張卡是草稿，對方不知道有這題 */
export function newQuestion(input: {
    bondId: string;
    openedBy: 'user' | string;
    prompt: string;
    origin: BondQuestion['origin'];
    topic?: BondQuestionTopic;
    now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const prompt = input.prompt.trim();
    return {
        id: newBondEntryId(),
        bondId: input.bondId,
        kind: 'question',
        author: input.openedBy,
        text: prompt,
        eventDate: { precision: 'unknown' },
        writtenAt: now,
        sources: [],
        links: [],
        status: 'draft',
        createdBy: input.openedBy === 'user' ? 'user' : 'ai',
        question: { prompt, origin: input.origin, ...(input.topic ? { topic: input.topic } : {}), rounds: [{ startedAt: now, openedBy: input.openedBy }] },
        updatedAt: now,
    };
}

/**
 * 寫一方的答案（暫存、封存或跳過）。發起的人封存或跳過那刻，題目送出（status 變 published）；
 * 雙方都交出那刻揭曉。已經交出的答案不能再改（要改就等揭曉後再答一輪）。
 */
export function answerQuestion(entry: BondEntry, side: QSide, answer: { text: string; state: BondAnswer['state'] }, now = Date.now()): BondEntry {
    const q = entry.question;
    const r = lastRound(q);
    if (!q || !r || r.revealedAt) return entry;
    if (done(r[side])) return entry;
    const nextRound: BondQuestionRound = { ...r, [side]: { text: answer.state === 'skipped' ? '' : answer.text.trim(), state: answer.state, at: now } };
    const other: QSide = side === 'user' ? 'char' : 'user';
    if (done(nextRound[side]) && done(nextRound[other])) nextRound.revealedAt = now;
    const opener = sideOfAuthor(r.openedBy);
    const sent = entry.status === 'published' || (side === opener && done(nextRound[side]));
    return {
        ...entry,
        status: sent ? 'published' : 'draft',
        question: { ...q, rounds: [...q.rounds.slice(0, -1), nextRound] },
        updatedAt: now,
    };
}

/** 揭曉之後再答一次：開新的一輪（誰按誰先答），舊答案留著 */
export function startNewRound(entry: BondEntry, openedBy: 'user' | string, now = Date.now()): BondEntry {
    const q = entry.question;
    if (!q || !roundRevealed(lastRound(q))) return entry;
    return { ...entry, question: { ...q, rounds: [...q.rounds, { startedAt: now, openedBy }] }, updatedAt: now };
}

/**
 * viewer 看得到 side 的哪個答案：自己的永遠看得到（含暫存）；對方的只有揭曉後才看得到，
 * 而且只看交出的（暫存永遠只有作者知道）。回 null＝看不到（畫面顯示「封存中」或「還沒答」）。
 */
export function visibleAnswer(round: BondQuestionRound, side: QSide, viewer: QSide): BondAnswer | null {
    const a = round[side];
    if (!a) return null;
    if (side === viewer) return a;
    if (!round.revealedAt || !done(a)) return null;
    return a;
}

/** 現在輪到誰答（題目送出、這一輪還沒揭曉、這一方還沒交出） */
export function waitingOn(entry: BondEntry): QSide[] {
    const r = lastRound(entry.question);
    if (!r || r.revealedAt) return [];
    const opener = sideOfAuthor(r.openedBy);
    const out: QSide[] = [];
    if (!done(r[opener])) return [opener];
    const other: QSide = opener === 'user' ? 'char' : 'user';
    if (!done(r[other])) out.push(other);
    return out;
}

/** 等你回答（首頁「最近值得留意」、清單置頂用） */
export const waitingOnUser = (e: BondEntry): boolean => e.kind === 'question' && e.status === 'published' && waitingOn(e).includes('user');

/** 清單分組：等你、等 TA、已揭曉（最後一輪） */
export function questionBucket(e: BondEntry): 'mine' | 'theirs' | 'revealed' | 'draft' {
    if (e.status === 'draft') return 'draft';
    const w = waitingOn(e);
    if (w.includes('user')) return 'mine';
    if (w.includes('char')) return 'theirs';
    return 'revealed';
}

/** 揭曉過的輪（給提示詞、對照用） */
export const revealedRounds = (q: BondQuestion | undefined): BondQuestionRound[] => (q?.rounds || []).filter(r => !!r.revealedAt);

/** 解析 AI 推薦題目：[{ question, topic }] */
export function parseQuestionSuggestions(raw: string): Array<{ prompt: string; topic: BondQuestionTopic }> {
    const s = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
        const arr = JSON.parse(s.slice(start, end + 1));
        if (!Array.isArray(arr)) return [];
        const topics = Object.keys(QUESTION_TOPIC_LABEL) as BondQuestionTopic[];
        return arr
            .map((x: any) => ({ prompt: String(x?.question ?? x?.prompt ?? '').trim(), topic: topics.includes(x?.topic) ? x.topic : 'custom' as BondQuestionTopic }))
            .filter(x => x.prompt)
            .slice(0, 8);
    } catch {
        return [];
    }
}
