/**
 * 帶去聊聊（plans/bond-batch2.md 6.2）：把拾光裡的一件事（片刻、記憶、隨筆）帶進私聊，跟你打的那句一起送出。
 *
 * - 訊息照舊是 `type: 'text'`，內容就是你說的話；`metadata.bondRef` 記帶過來的那張卡（標題和摘要是當下的快照）。
 * - 角色看到的歷史（本機、即時對話、主動消息，都從同一份歷史來）和記憶、歸檔一律寫成
 *   `[從羈絆帶來：〈片刻〉標題——摘要] 你說的話`，角色看得懂你在說哪件事，怎麼接隨角色。
 * - 氣泡上方顯示那張小卡，點了回到羈絆的那件事（BOND_REF_OPEN_EVENT，由私聊頁接手開 App）。
 */
import type { BondEntry, DiaryEntry, Message } from '../../types';
import { milestoneLabel, PROMISE_STATE_LABEL, repeatLabel, WISH_STATE_LABEL, HABIT_STATE_LABEL, wishOwnerLabel } from './pact';
import { lastRound, visibleAnswer } from './question';
import type { TimelineItem } from './timeline';

export type BondRefKind = 'moment' | 'memory' | 'essay' | 'diary' | 'question' | 'note' | 'wish' | 'promise' | 'habit' | 'milestone';
/** 約定分頁的四種（第 4 批） */
export type BondPactRefKind = Extract<BondRefKind, 'wish' | 'promise' | 'habit' | 'milestone'>;

export interface BondRefMeta {
    bondId: string;
    kind: BondRefKind;
    /** 時間線上那件事的 key（片刻、記憶）；點回去用 */
    itemKey?: string;
    /** 隨筆 id */
    essayId?: string;
    /** 日記那天（第 3 批） */
    diaryDate?: string;
    /** 問答那一題 */
    questionId?: string;
    /** 紙條那一張（一串最上面那張） */
    slipId?: string;
    /** 願望、約定、默契、里程碑那張卡（第 4 批） */
    pactId?: string;
    title?: string;
    excerpt: string;
    /** 隨筆、日記那頁、紙條是誰寫的 */
    authorName?: string;
}

export const BOND_REF_OPEN_EVENT = 'soren-open-bond-ref';

export const BOND_REF_KIND_LABEL: Record<BondRefKind, string> = {
    moment: '片刻', memory: '記憶', essay: '隨筆', diary: '日記', question: '問答', note: '紙條',
    wish: '願望', promise: '約定', habit: '默契', milestone: '里程碑',
};

const EXCERPT_MAX = 80;

const oneLine = (s: string | undefined) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const bondRefOf = (m: Pick<Message, 'role' | 'type' | 'metadata'> | null | undefined): BondRefMeta | null => {
    const ref = m?.role === 'user' && m.type === 'text' ? m.metadata?.bondRef : null;
    return ref && typeof ref === 'object' && typeof ref.excerpt === 'string' && BOND_REF_KIND_LABEL[ref.kind as BondRefKind] ? ref as BondRefMeta : null;
};

/** `[從羈絆帶來：〈片刻〉標題——摘要]` */
export function bondRefPrefix(ref: BondRefMeta): string {
    const label = BOND_REF_KIND_LABEL[ref.kind];
    const who = (ref.kind === 'essay' || ref.kind === 'diary' || ref.kind === 'note') && ref.authorName ? `（${ref.authorName}${ref.kind === 'note' ? '丟的' : '寫的'}）` : '';
    const title = oneLine(ref.title);
    const excerpt = oneLine(ref.excerpt);
    const body = title && excerpt && title !== excerpt ? `${title}——${excerpt}` : (title || excerpt);
    return `[從羈絆帶來：〈${label}〉${who}${body}]`;
}

/** 歷史、記憶裡這則怎麼寫；沒有帶卡就原樣 */
export function formatBondRefContent(content: string, ref: BondRefMeta | null): string {
    if (!ref) return content;
    const text = String(content || '').trim();
    return text ? `${bondRefPrefix(ref)} ${text}` : bondRefPrefix(ref);
}

export function bondRefFromItem(bondId: string, item: TimelineItem): BondRefMeta {
    const title = oneLine(item.title) || undefined;
    return {
        bondId,
        kind: item.kind === 'moment' ? 'moment' : 'memory',
        itemKey: item.key,
        ...(title ? { title } : {}),
        excerpt: clip(oneLine(item.text), EXCERPT_MAX),
    };
}

export function bondRefFromEssay(bondId: string, essay: BondEntry, authorName?: string): BondRefMeta {
    const title = oneLine(essay.title) || undefined;
    return {
        bondId,
        kind: 'essay',
        essayId: essay.id,
        ...(title ? { title } : {}),
        excerpt: clip(oneLine(essay.text), EXCERPT_MAX),
        ...(authorName ? { authorName } : {}),
    };
}

/** 日記的一頁（發布了的才能帶） */
export function bondRefFromDiary(bondId: string, d: DiaryEntry, side: 'user' | 'char', authorName: string): BondRefMeta | null {
    const page = side === 'user' ? d.userPage : d.charPage;
    const text = oneLine(page?.text);
    if (!text) return null;
    const md = `${Number(d.date.slice(5, 7))} 月 ${Number(d.date.slice(8, 10))} 日`;
    return { bondId, kind: 'diary', diaryDate: d.date, title: md, excerpt: clip(text, EXCERPT_MAX), authorName };
}

/** 一題問答（最近一次揭曉的那輪；還沒揭曉的不能帶，帶了等於偷看） */
export function bondRefFromQuestion(bondId: string, e: BondEntry, names: { user: string; char: string }): BondRefMeta | null {
    const r = lastRound(e.question);
    const rounds = (e.question?.rounds || []).filter(x => x.revealedAt);
    const shown = r?.revealedAt ? r : rounds[rounds.length - 1];
    if (!e.question || !shown) return null;
    const mine = visibleAnswer(shown, 'user', 'user');
    const theirs = visibleAnswer(shown, 'char', 'user');
    const ans = (a: typeof mine) => (!a || a.state === 'skipped' ? '（跳過）' : `「${clip(oneLine(a.text), 40)}」`);
    return { bondId, kind: 'question', questionId: e.id, title: `「${clip(oneLine(e.question.prompt), 40)}」`, excerpt: `${names.user}答${ans(mine)}；${names.char}答${ans(theirs)}` };
}

/** 一張紙條（投遞了的） */
export function bondRefFromSlip(bondId: string, e: BondEntry, rootId: string, authorName: string): BondRefMeta | null {
    if (e.kind !== 'note' || e.status !== 'published' || !oneLine(e.text)) return null;
    const tags = (e.slip?.tags || []).slice(0, 2).join('、');
    return { bondId, kind: 'note', slipId: rootId, ...(tags ? { title: tags } : {}), excerpt: clip(oneLine(e.text), EXCERPT_MAX), authorName };
}

/**
 * 約定分頁的一張卡（第 4 批）：願望（發布了的）、約定、默契、里程碑。
 * 摘要寫成角色看得懂的一句：誰的願望、什麼頻率、現在什麼狀態。
 */
export function bondRefFromPact(bondId: string, e: BondEntry, names: { user: string; char: string }): BondRefMeta | null {
    const text = oneLine(e.text);
    if (e.kind === 'wish') {
        if (e.status !== 'published' || !text || !e.wish) return null;
        const owner = e.wish.owner === 'both' ? '我們的' : e.wish.owner === 'user' ? `${names.user}的` : wishOwnerLabel(e.wish.owner, names.char);
        return { bondId, kind: 'wish', pactId: e.id, title: owner, excerpt: `${clip(text, EXCERPT_MAX)}（${WISH_STATE_LABEL[e.wish.state]}）` };
    }
    if (e.kind === 'promise' && e.promise && text) {
        return { bondId, kind: 'promise', pactId: e.id, title: repeatLabel(e.promise.repeat), excerpt: `${clip(text, EXCERPT_MAX)}（${PROMISE_STATE_LABEL[e.promise.state]}）` };
    }
    if (e.kind === 'habit' && e.habit && text) {
        return { bondId, kind: 'habit', pactId: e.id, excerpt: `${clip(text, EXCERPT_MAX)}（${HABIT_STATE_LABEL[e.habit.state]}）` };
    }
    if (e.kind === 'milestone' && e.milestone) {
        const label = milestoneLabel(e.milestone.what, e.title);
        const d = e.eventDate?.precision === 'day' && e.eventDate.date ? `${Number(e.eventDate.date.slice(5, 7))} 月 ${Number(e.eventDate.date.slice(8, 10))} 日` : '';
        return { bondId, kind: 'milestone', pactId: e.id, title: label, excerpt: clip([d, text].filter(Boolean).join('，') || label, EXCERPT_MAX) };
    }
    return null;
}
