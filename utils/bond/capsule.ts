/**
 * 留給以後（plans/bond-batch5.md 1.3、第 4 節）：封存、四種打開條件、到期、拆開、提前拆、一起打開。純函式，有測試。
 *
 * - 封好之後連寫的人（你）自己也看不到內容，只看得到封面那句和條件；要改只能拆掉重封（不提供，照第 10 節第 6 題）。
 * - 條件達成（tick 判）只記 dueAt、出一張「今天可以打開了」，**不會自動拆**；你按「拆開」才拆。
 * - 收件人可以提前拆：記 openedEarly，寫的那方知道。你寫給 TA 的那封你不是收件人，不能提前拆；一起打開的兩封同時拆。
 * - 拆了之後內容雙方都知道（進提示詞）。
 */
import type { BondCapsule, BondEntry, BondRoute } from '../../types';
import { newBondEntryId } from './ids';
import { stagesOf } from './routes';

const DAY = 86400_000;
/** 每段關係同時封著的 TA 的最多幾封 */
export const CHAR_SEALED_MAX = 5;

export type CapsuleOpenWhen = BondCapsule['openWhen'];

export function newCapsule(input: {
    bondId: string; author: string; to: string; text: string; openWhen: CapsuleOpenWhen;
    cover?: string; paperStyle?: string; signature?: string; photos?: string[]; pairWith?: string;
    origin?: BondCapsule['origin']; now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const capsule: BondCapsule = {
        to: input.to, openWhen: input.openWhen, sealedAt: now, origin: input.origin || 'manual',
        ...(input.cover?.trim() ? { cover: input.cover.trim() } : {}),
        ...(input.paperStyle ? { paperStyle: input.paperStyle } : {}),
        ...(input.signature?.trim() ? { signature: input.signature.trim() } : {}),
        ...(input.photos?.length ? { photos: input.photos } : {}),
        ...(input.pairWith ? { pairWith: input.pairWith } : {}),
    };
    return {
        id: newBondEntryId(), bondId: input.bondId, kind: 'capsule', author: input.author,
        text: input.text, eventDate: { precision: 'unknown' }, writtenAt: now,
        sources: [], links: [], status: 'published', createdBy: input.author === 'user' ? 'user' : 'ai', updatedAt: now,
        capsule,
    };
}

/** 兩封互指（一起打開） */
export function pairCapsules(a: BondEntry, b: BondEntry): [BondEntry, BondEntry] {
    return [
        { ...a, capsule: { ...a.capsule!, to: 'both', pairWith: b.id } },
        { ...b, capsule: { ...b.capsule!, to: 'both', pairWith: a.id, openWhen: a.capsule!.openWhen } },
    ];
}

const isCapsule = (e: BondEntry) => e.kind === 'capsule' && !!e.capsule;
export const capsuleSealed = (e: BondEntry) => isCapsule(e) && !e.capsule!.openedAt;
export const capsuleOpened = (e: BondEntry) => isCapsule(e) && !!e.capsule!.openedAt;

/** 「一年後的今天」 */
export function yearLater(todayKey: string): string {
    const [y, m, d] = todayKey.split('-').map(Number);
    const t = new Date(Date.UTC(y + 1, m - 1, d));
    if (t.getUTCMonth() !== m - 1) t.setUTCDate(0); // 2/29 → 2/28
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export interface CapsuleCtx {
    /** 這條線的今天 'YYYY-MM-DD' */
    today: string;
    level: number;
    stage: string;
    route?: BondRoute;
}

/** 條件到了沒 */
export function conditionMet(when: CapsuleOpenWhen, ctx: CapsuleCtx): boolean {
    if (when.kind === 'date' || when.kind === 'anniversary') return ctx.today >= when.date;
    if (when.kind === 'level') return ctx.level >= when.level;
    if (ctx.stage === when.stage) return true;
    const order = stagesOf(ctx.route).map(s => s.id);
    const at = order.indexOf(ctx.stage);
    const want = order.indexOf(when.stage);
    return at >= 0 && want >= 0 && at > want && ctx.stage !== order[order.length - 1];
}

/** 這次 tick 該標成到期的（封著、還沒標過、條件到了） */
export function capsulesNowDue(entries: BondEntry[], ctx: CapsuleCtx): BondEntry[] {
    return entries.filter(e => capsuleSealed(e) && !e.capsule!.dueAt && conditionMet(e.capsule!.openWhen, ctx));
}

export function markDue(e: BondEntry, now = Date.now()): BondEntry {
    return { ...e, updatedAt: now, capsule: { ...e.capsule!, dueAt: now } };
}

/** 你能不能拆（照常拆＝到期了；提前拆＝你是收件人或一起打開） */
export function canOpen(e: BondEntry): { now: boolean; early: boolean } {
    if (!capsuleSealed(e)) return { now: false, early: false };
    if (e.capsule!.dueAt) return { now: true, early: false };
    const recipient = e.capsule!.to === 'user' || e.capsule!.to === 'both';
    return { now: false, early: recipient };
}

/** 拆開（一起打開的兩封都要傳進來，一起拆） */
export function openCapsules(es: BondEntry[], now = Date.now()): BondEntry[] {
    return es.filter(capsuleSealed).map(e => ({
        ...e, updatedAt: now,
        capsule: { ...e.capsule!, openedAt: now, ...(e.capsule!.dueAt ? {} : { openedEarly: true }) },
    }));
}

/** 一起打開的另一封 */
export const capsulePair = (entries: BondEntry[], e: BondEntry): BondEntry | undefined =>
    e.capsule?.pairWith ? entries.find(x => x.id === e.capsule!.pairWith) : undefined;

/** TA 封著的幾封（上限用） */
export const charSealedCount = (entries: BondEntry[]): number => entries.filter(e => capsuleSealed(e) && e.author !== 'user').length;

/**
 * 清單：一起打開的兩封合成一格（用你那封當代表）；新的在前。
 */
export function capsuleList(entries: BondEntry[]): BondEntry[] {
    const all = entries.filter(isCapsule);
    const hidden = new Set(all.filter(e => e.author !== 'user' && e.capsule!.pairWith && all.some(x => x.id === e.capsule!.pairWith)).map(e => e.id));
    return all.filter(e => !hidden.has(e.id)).sort((a, b) => {
        const ao = capsuleOpened(a) ? 1 : 0;
        const bo = capsuleOpened(b) ? 1 : 0;
        if (ao !== bo) return ao - bo; // 封著的在前
        return (b.capsule!.dueAt || 0) - (a.capsule!.dueAt || 0) || b.capsule!.sealedAt - a.capsule!.sealedAt;
    });
}

/** 還有幾天（日期型；其他型回 null） */
export function daysLeft(when: CapsuleOpenWhen, today: string): number | null {
    if (when.kind !== 'date' && when.kind !== 'anniversary') return null;
    const a = Date.parse(`${today}T00:00:00Z`);
    const b = Date.parse(`${when.date}T00:00:00Z`);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / DAY)) : null;
}

/** 條件寫成一句話（「2027 年 11 月 27 日」「下一次〈相識紀念日〉」「到 Lv.5」「走到『交往』」） */
export function conditionText(when: CapsuleOpenWhen): string {
    const day = (k: string) => `${Number(k.slice(0, 4))} 年 ${Number(k.slice(5, 7))} 月 ${Number(k.slice(8, 10))} 日`;
    if (when.kind === 'date') return day(when.date);
    if (when.kind === 'anniversary') return `${when.title ? `〈${when.title}〉` : '紀念日'}那天（${day(when.date)}）`;
    if (when.kind === 'level') return `羈絆到 Lv.${when.level}`;
    return `關係走到「${when.label || when.stage}」`;
}

// ─── 聊天裡「今天可以打開了」那張小卡（type 'bond_invite'＋metadata.bondCapsule） ───

export interface BondCapsuleMeta { bondId: string; entryId: string; event: 'due'; cover?: string; when: string }

export const bondCapsuleOf = (m: { type?: string; metadata?: any } | null | undefined): BondCapsuleMeta | null => {
    const x = m?.type === 'bond_invite' ? m.metadata?.bondCapsule : null;
    return x && typeof x === 'object' && typeof x.entryId === 'string' ? x as BondCapsuleMeta : null;
};

/** 小卡在聊天記錄裡的樣子（寫給角色看） */
export function formatBondCapsuleRecord(meta: Partial<BondCapsuleMeta> | undefined): string {
    return `[今天是你們約好打開那封「留給以後」的日子${meta?.cover ? `（信封上寫著「${meta.cover}」）` : ''}；拆開了沒，照【你們的珍藏】那段]`;
}
