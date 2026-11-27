/**
 * 信件（plans/bond-batch5.md 1.2、第 3 節）：寫、存草稿、寄出（馬上到或慢慢寄）、送達、已讀、回信串。純函式，有測試。
 *
 * - 草稿＝status 'draft'、沒有 sentAt；寄出＝published＋sentAt。
 * - 對方收到＝arrivedAt：馬上到的寄出就到；慢寄的到 deliverAt 由 tick 投遞（components/bond/letterRun.ts 的 deliverDueLetters）。
 * - 還沒到的信不算收件人知道：不在收件人的清單上、不進收件人的提示詞（硬規則第 5 條）。寄件人自己看得到「寄出中」。
 * - 角色收的信，到了就算讀了；你收的信，打開才記 readAt（角色看得到你讀了沒）。
 */
import type { BondEntry, BondLetter } from '../../types';
import { newBondEntryId } from './ids';

const DAY = 86400_000;

/** 信紙（跟交換日記同一組 id）；信封顏色跟著信紙配 */
export const LETTER_PAPERS = [
    { id: 'plain', name: '白紙', bg: '#fbf8f3', ink: '#463f3a', line: '', size: '', envelope: '#ece2d2', flap: '#e4d7c3', pocket: '#e7dccb' },
    { id: 'lined', name: '橫線', bg: '#fdf9ea', ink: '#463f3a', line: 'repeating-linear-gradient(transparent, transparent 31px, rgba(140,74,82,.12) 31px, rgba(140,74,82,.12) 32px)', size: '', envelope: '#eadfcd', flap: '#e0d2bc', pocket: '#e5d8c4' },
    { id: 'grid', name: '方格', bg: '#fbfaf6', ink: '#463f3a', line: 'linear-gradient(rgba(140,74,82,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(140,74,82,.08) 1px, transparent 1px)', size: '18px 18px', envelope: '#e4e1d6', flap: '#dad6c9', pocket: '#dfdbcf' },
    { id: 'dot', name: '點陣', bg: '#fffdf5', ink: '#463f3a', line: 'radial-gradient(rgba(70,63,58,.18) 1px, transparent 1px)', size: '18px 18px', envelope: '#e6dccf', flap: '#dccfbf', pocket: '#e1d5c7' },
    { id: 'pink', name: '粉霧', bg: '#fbf0ef', ink: '#4a3335', line: 'radial-gradient(rgba(214,150,160,.35) 2px, transparent 2px)', size: '28px 28px', envelope: '#ecd5d0', flap: '#e2c5bf', pocket: '#e7cdc7' },
    { id: 'dark', name: '夜空', bg: '#2f2a2b', ink: '#ece5dc', line: 'radial-gradient(rgba(255,255,255,.16) 1px, transparent 1px)', size: '22px 22px', envelope: '#3d3536', flap: '#352e2f', pocket: '#393132' },
] as const;
export type LetterPaperId = typeof LETTER_PAPERS[number]['id'];
export const letterPaper = (id: string | undefined) => LETTER_PAPERS.find(p => p.id === id) || LETTER_PAPERS[0];

/** 蠟封五色（c＝蠟、d＝壓痕） */
export const WAX_COLORS = {
    wine: { name: '酒紅', c: '#8c4a52', d: '#6e3740' },
    moss: { name: '墨綠', c: '#55654f', d: '#3f4d3a' },
    indigo: { name: '靛藍', c: '#46506b', d: '#333b52' },
    amber: { name: '琥珀', c: '#a87a3f', d: '#86602f' },
    ink: { name: '墨黑', c: '#3a3331', d: '#252020' },
} as const;
export type WaxColor = keyof typeof WAX_COLORS;
const WAX_KEYS = Object.keys(WAX_COLORS) as WaxColor[];

/** 同一封永遠同一色 */
export function waxFor(id: string): WaxColor {
    let h = 2166136261;
    for (const ch of `${id}|wax`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return WAX_KEYS[(h >>> 0) % WAX_KEYS.length];
}

/** 慢慢寄能選幾天 */
export const SLOW_DAYS: [number, number] = [1, 7];
/** TA 主動寫的信有多少機率慢寄（3.3）、慢寄幾天 */
export const OUTPUT_SLOW_CHANCE = 0.3;

const hashFrac = (s: string): number => {
    let h = 2166136261;
    for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
};

/** TA 主動寫的這封要不要慢寄、慢幾天（照信的 id 算，同一封每次算都一樣） */
export function outputSlowDays(id: string): number {
    if (hashFrac(`${id}|slow`) >= OUTPUT_SLOW_CHANCE) return 0;
    return 1 + Math.floor(hashFrac(`${id}|days`) * 3); // 1～3 天，不讓你等太久
}

export function newLetter(input: {
    bondId: string; author: string; to: string; text: string; paperStyle?: string; signature?: string;
    replyTo?: string; origin?: BondLetter['origin']; now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const letter: BondLetter = {
        to: input.to, origin: input.origin || (input.replyTo ? 'reply' : 'manual'),
        ...(input.paperStyle ? { paperStyle: input.paperStyle } : {}),
        ...(input.signature?.trim() ? { signature: input.signature.trim() } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    };
    return {
        id: newBondEntryId(), bondId: input.bondId, kind: 'letter', author: input.author,
        text: input.text, eventDate: { precision: 'unknown' }, writtenAt: now,
        sources: [], links: [], status: 'draft', createdBy: input.author === 'user' ? 'user' : 'ai', updatedAt: now,
        letter,
    };
}

/** 改草稿（寄出了就不能改） */
export function editLetter(e: BondEntry, patch: { text?: string; paperStyle?: string; signature?: string }, now = Date.now()): BondEntry {
    if (!e.letter || e.letter.sentAt) return e;
    return {
        ...e, ...(patch.text !== undefined ? { text: patch.text } : {}), updatedAt: now,
        letter: {
            ...e.letter,
            ...(patch.paperStyle !== undefined ? { paperStyle: patch.paperStyle } : {}),
            ...(patch.signature !== undefined ? { signature: patch.signature.trim() || undefined } : {}),
        },
    };
}

/**
 * 寄出：slowDays＝0 馬上到（角色收的信到了就算讀了），1～7 天就是慢寄、到 deliverAt 才投遞。
 */
export function sendLetter(e: BondEntry, slowDays = 0, now = Date.now()): BondEntry {
    if (!e.letter || e.letter.sentAt) return e;
    const days = Math.max(0, Math.min(SLOW_DAYS[1], Math.round(slowDays)));
    const base: BondEntry = { ...e, status: 'published', writtenAt: now, updatedAt: now, letter: { ...e.letter, sentAt: now } };
    if (days > 0) return { ...base, letter: { ...base.letter!, deliverAt: now + days * DAY } };
    return arriveLetter(base, now);
}

/** 投遞到對方手上（角色收的到了就算讀了） */
export function arriveLetter(e: BondEntry, now = Date.now()): BondEntry {
    if (!e.letter || e.letter.arrivedAt) return e;
    return { ...e, updatedAt: now, letter: { ...e.letter, arrivedAt: now, ...(e.letter.to !== 'user' ? { readAt: now } : {}) } };
}

/** 你讀了 TA 寫的信 */
export function markLetterRead(e: BondEntry, now = Date.now()): BondEntry {
    if (!e.letter || e.letter.readAt || !e.letter.arrivedAt) return e;
    return { ...e, updatedAt: now, letter: { ...e.letter, readAt: now } };
}

const isLetter = (e: BondEntry) => e.kind === 'letter' && !!e.letter;
export const letterSent = (e: BondEntry) => isLetter(e) && e.status === 'published' && !!e.letter!.sentAt;
export const letterArrived = (e: BondEntry) => letterSent(e) && !!e.letter!.arrivedAt;
export const letterInTransit = (e: BondEntry) => letterSent(e) && !e.letter!.arrivedAt;

/** 寄出了、時間到了、還沒投遞的（tick 用） */
export function dueLetters(entries: BondEntry[], now = Date.now()): BondEntry[] {
    return entries.filter(e => letterInTransit(e) && (e.letter!.deliverAt ?? 0) <= now);
}

/**
 * 你看得到的信：你寫的（草稿、寄出中、寄到了）、TA 寫的寄到了的。新的在前（草稿照寫的時間）。
 */
export function lettersForUser(entries: BondEntry[]): BondEntry[] {
    return entries
        .filter(isLetter)
        .filter(e => (e.author === 'user' ? true : letterArrived(e)))
        .sort((a, b) => letterTime(b) - letterTime(a));
}

/** 清單上排序、顯示用的時間：到了照到的時間，寄出中照寄出，草稿照寫的時間 */
export const letterTime = (e: BondEntry): number => e.letter?.arrivedAt || e.letter?.sentAt || e.updatedAt || e.writtenAt;

/** 一串信的第一封 */
export function letterRoot(entries: BondEntry[], id: string): string {
    const byId = new Map(entries.filter(isLetter).map(e => [e.id, e]));
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur?.letter?.replyTo && byId.has(cur.letter.replyTo) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.letter.replyTo);
    }
    return cur?.id || id;
}

/** 這一串（照時間）；forViewer 'user' 不列 TA 還沒寄到的、'char' 不列你的草稿和還沒寄到的 */
export function letterThread(entries: BondEntry[], id: string, forViewer: 'user' | 'char' = 'user'): BondEntry[] {
    const root = letterRoot(entries, id);
    const all = entries.filter(isLetter).filter(e => letterRoot(entries, e.id) === root);
    const visible = all.filter(e => (forViewer === 'user' ? (e.author === 'user' || letterArrived(e)) : (e.author !== 'user' ? letterSent(e) : letterArrived(e))));
    return visible.sort((a, b) => (a.letter!.sentAt || a.writtenAt) - (b.letter!.sentAt || b.writtenAt));
}

/** 這一封寄到了、還沒有人回（回信串裡它之後沒有對方寄出的信） */
export function awaitingReply(entries: BondEntry[], e: BondEntry): boolean {
    if (!letterArrived(e)) return false;
    return !entries.some(x => isLetter(x) && x.letter!.replyTo === e.id && x.author !== e.author && letterSent(x));
}

/** 你寄給 TA、寄到了、TA 還沒回的（舊的先回） */
export function lettersAwaitingCharReply(entries: BondEntry[]): BondEntry[] {
    return entries.filter(e => isLetter(e) && e.author === 'user' && awaitingReply(entries, e))
        .sort((a, b) => (a.letter!.arrivedAt || 0) - (b.letter!.arrivedAt || 0));
}

/** 你收到、還沒讀的 */
export const unreadForUser = (entries: BondEntry[]): BondEntry[] => entries.filter(e => isLetter(e) && e.letter!.to === 'user' && letterArrived(e) && !e.letter!.readAt);

/** 交換了幾封（雙方寄到的都算） */
export const lettersExchanged = (entries: BondEntry[]): number => entries.filter(letterArrived).length;

/** 開頭一句（小卡、清單、歷史用） */
export function letterExcerpt(text: string, n = 24): string {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n)}…` : one;
}

// ─── 聊天裡的信封小卡（type 'bond_invite'＋metadata.bondLetter，跟約定小卡同一招） ───

export interface BondLetterMeta {
    bondId: string;
    entryId: string;
    /** 'sent'＝寄出（慢寄時落一張「寄出中」）；'arrived'＝信到了 */
    event: 'sent' | 'arrived';
    /** 誰寫的：'user' 或角色 id */
    from: string;
    excerpt: string;
    deliverAt?: number;
    /** 這封是慢寄的（「信到了」那張不算寄出那天） */
    slow?: boolean;
}

export function letterMeta(e: BondEntry, event: BondLetterMeta['event']): BondLetterMeta {
    return {
        bondId: e.bondId, entryId: e.id, event, from: e.author, excerpt: letterExcerpt(e.text, 30),
        ...(event === 'sent' && e.letter?.deliverAt ? { deliverAt: e.letter.deliverAt } : {}),
        ...(e.letter?.deliverAt ? { slow: true } : {}),
    };
}

export const bondLetterOf = (m: { type?: string; metadata?: any } | null | undefined): BondLetterMeta | null => {
    const x = m?.type === 'bond_invite' ? m.metadata?.bondLetter : null;
    return x && typeof x === 'object' && typeof x.entryId === 'string' && typeof x.excerpt === 'string' ? x as BondLetterMeta : null;
};

const dayText = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };

/** 小卡在聊天記錄、記憶裡的樣子（寫給角色看：「你」＝角色） */
export function formatBondLetterRecord(meta: Partial<BondLetterMeta> | undefined): string {
    const fromUser = meta?.from === 'user';
    const ex = meta?.excerpt ? `：「${meta.excerpt}」` : '';
    if (meta?.event === 'sent') {
        return fromUser
            ? `[對方寄了一封信給你，慢慢寄，${meta.deliverAt ? `預計${dayText(meta.deliverAt)}` : '過幾天'}才會到；你還沒收到，不知道內容]`
            : `[你寄了一封信給對方，慢慢寄，還在路上${ex}]`;
    }
    return fromUser ? `[對方寫給你的信到了${ex}]` : `[你寫給對方的信到了${ex}]`;
}

/** 給你看的那句（聊天小卡上） */
export function letterCardLine(meta: BondLetterMeta, charName: string): string {
    const fromUser = meta.from === 'user';
    if (meta.event === 'sent') return fromUser ? `你寄了一封信給${charName}，慢慢寄${meta.deliverAt ? `，預計 ${dayText(meta.deliverAt)} 到` : ''}` : `${charName}寄了一封信給你`;
    return fromUser ? `你寄了一封信給${charName}` : `${charName}的信到了`;
}
