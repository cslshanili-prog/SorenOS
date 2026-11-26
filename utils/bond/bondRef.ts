/**
 * 帶去聊聊（plans/bond-batch2.md 6.2）：把拾光裡的一件事（片刻、記憶、隨筆）帶進私聊，跟你打的那句一起送出。
 *
 * - 訊息照舊是 `type: 'text'`，內容就是你說的話；`metadata.bondRef` 記帶過來的那張卡（標題和摘要是當下的快照）。
 * - 角色看到的歷史（本機、即時對話、主動消息，都從同一份歷史來）和記憶、歸檔一律寫成
 *   `[從羈絆帶來：〈片刻〉標題——摘要] 你說的話`，角色看得懂你在說哪件事，怎麼接隨角色。
 * - 氣泡上方顯示那張小卡，點了回到羈絆的那件事（BOND_REF_OPEN_EVENT，由私聊頁接手開 App）。
 */
import type { BondEntry, Message } from '../../types';
import type { TimelineItem } from './timeline';

export type BondRefKind = 'moment' | 'memory' | 'essay';

export interface BondRefMeta {
    bondId: string;
    kind: BondRefKind;
    /** 時間線上那件事的 key（片刻、記憶）；點回去用 */
    itemKey?: string;
    /** 隨筆 id */
    essayId?: string;
    title?: string;
    excerpt: string;
    /** 隨筆是誰寫的 */
    authorName?: string;
}

export const BOND_REF_OPEN_EVENT = 'soren-open-bond-ref';

export const BOND_REF_KIND_LABEL: Record<BondRefKind, string> = { moment: '片刻', memory: '記憶', essay: '隨筆' };

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
    const who = ref.kind === 'essay' && ref.authorName ? `（${ref.authorName}寫的）` : '';
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
