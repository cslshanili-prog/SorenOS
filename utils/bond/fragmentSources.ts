/**
 * 拾光片段的「多角度」素材（plans/bond-moments-v2.md 第二輪，Liora 2026-11-28：
 * 「現在一整排看來都是針對對話，比較單調」）。純邏輯，有測試。
 *
 * 私聊、見面之外，一天還可以從這幾個角度挑：
 * - group 群聊：只看這張身份卡在場、角色也在的群；那天你（這張卡）說過話或有人提到你才算
 * - aside TA 跟別人私下提起你：角色跟其他角色的私聊裡提到你名字／別名的那幾句（前後各帶一句）
 * - life TA 的一天：那天的日程（做什麼、在哪、心裡想什麼）和意識流獨白；AI 只挑跟你有關或想分享給你的
 * - moments 朋友圈：TA 發的、你發的 TA 留言的
 * - inner 心聲：每次回覆後的內心獨白（2026-11-28 起照線記在那則回覆的 metadata.innerState）
 *
 * 角色之間照同一套：他們都在的群、各自跟第三人提起對方、各自的一天裡跟對方有關的、朋友圈互動；沒有心聲。
 * 每則素材有編號（G1、A2、L1、M1、I1），AI 挑的時候寫編號；群聊、私下提起有原話能跳回去，其他沒有原話。
 */
import type { BondFragmentFrom, BondSource, DailySchedule, Message, MomentPost } from '../../types';
import { messagePlainText } from './collect';

export type MaterialAngle = Exclude<BondFragmentFrom, 'chat' | 'date'>;

export interface FragmentMaterial {
    /** 'G1'、'A2'… */
    ref: string;
    angle: MaterialAngle;
    /** 真實時間戳（排序、時間線上的位置） */
    at: number;
    /** 'HH:MM'，故事時鐘 */
    time: string;
    /** 群名、「跟小雨私聊」、「TA 的一天」… */
    context?: string;
    /** 這句是誰說的（給 AI 看的名字） */
    speaker?: string;
    /** 原話的 who：'user'＝你、角色 id；群裡沒對上角色的寫名字 */
    speakerId?: string;
    text: string;
    /** 有沒有一句原話可以引（群聊、私下提起有；一天、朋友圈、心聲沒有） */
    quotable: boolean;
    source?: BondSource;
    /** 這則素材是誰的（角色之間：誰的一天、誰跟第三人私聊）；沒寫 who 時就由他寫心裡話 */
    ownerId?: string;
}

export const ANGLE_PREFIX: Record<MaterialAngle, string> = { group: 'G', aside: 'A', life: 'L', moments: 'M', inner: 'I' };

/** 卡上的小來源字（私聊、見面不顯示） */
export const ANGLE_LABEL: Record<BondFragmentFrom, string> = {
    chat: '私聊', date: '見面', group: '群聊', aside: '私下提起', life: 'TA 的一天', moments: '朋友圈', inner: '心聲',
};

const MAX_LINE = 200;
const clip = (s: string, n = MAX_LINE) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** 認人的名字：兩個字以上才比對（一個字的暱稱太容易誤中）；全都是一個字就照用 */
export function mentionNames(names: Array<string | undefined>): string[] {
    const all = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))];
    const long = all.filter(n => n.length >= 2);
    return long.length ? long : all;
}

export const mentionsAny = (text: string, names: string[]): boolean => !!text && names.some(n => n && text.includes(n));

/** 命中的那幾則，前後各帶 radius 則；最多 cap 則（從命中的地方往外留） */
export function pickAround<T>(items: T[], isHit: (t: T, i: number) => boolean, radius = 1, cap = 30): T[] {
    const hits = items.map((t, i) => (isHit(t, i) ? i : -1)).filter(i => i >= 0);
    if (!hits.length) return [];
    const keep = new Set<number>();
    for (const h of hits) {
        for (let i = Math.max(0, h - radius); i <= Math.min(items.length - 1, h + radius); i++) keep.add(i);
        if (keep.size >= cap) break;
    }
    return [...keep].sort((a, b) => a - b).slice(0, cap).map(i => items[i]);
}

// ─── 群聊、私下提起（有原話的） ─────────────────────────────────────────

export function dialogueMaterials(args: {
    angle: 'group' | 'aside';
    context: string;
    /** 那一天的訊息（已經濾掉角色看不到的、系統訊息），照 id 排 */
    msgs: Message[];
    isHit: (m: Message) => boolean;
    nameOf: (m: Message) => string;
    speakerIdOf: (m: Message) => string;
    timeOf: (ts: number) => string;
    sourceOf: (m: Message, snippet: string) => BondSource;
    radius?: number;
    cap?: number;
}): Omit<FragmentMaterial, 'ref'>[] {
    const said = args.msgs.filter(m => m.type !== 'system' && messagePlainText(m).trim());
    return pickAround(said, m => args.isHit(m), args.radius ?? 1, args.cap ?? 24).map(m => {
        const text = clip(messagePlainText(m));
        return {
            angle: args.angle, at: m.timestamp, time: args.timeOf(m.timestamp), context: args.context,
            speaker: args.nameOf(m), speakerId: args.speakerIdOf(m), text, quotable: true,
            source: args.sourceOf(m, messagePlainText(m).slice(0, 300)),
        };
    });
}

// ─── TA 的一天 ─────────────────────────────────────────

/**
 * 日程的每一段＋最後一段意識流。onlyIf 給了就只留命中的（角色之間：只留跟對方有關的）。
 * atOf：'HH:MM' → 那天那個時間的時間戳（排序用）。
 */
export function lifeMaterials(args: {
    schedule: Pick<DailySchedule, 'slots' | 'flowNarrative'> | null | undefined;
    context: string;
    atOf: (hhmm: string) => number;
    onlyIf?: (text: string, slot?: DailySchedule['slots'][number]) => boolean;
}): Omit<FragmentMaterial, 'ref'>[] {
    const s = args.schedule;
    if (!s) return [];
    const out: Omit<FragmentMaterial, 'ref'>[] = [];
    for (const slot of s.slots || []) {
        const parts = [
            `${slot.activity || ''}${slot.location ? `（${slot.location}）` : ''}`,
            slot.with ? `跟${slot.with}` : '',
            slot.description || '',
            slot.innerThought ? `心裡想：${slot.innerThought}` : '',
        ].filter(Boolean);
        const text = clip(parts.join('；'), 260);
        if (!text || (args.onlyIf && !args.onlyIf(text, slot))) continue;
        out.push({ angle: 'life', at: args.atOf(slot.startTime), time: slot.startTime, context: args.context, text, quotable: false });
    }
    const flow = s.flowNarrative || {};
    const lastKey = Object.keys(flow).sort().pop();
    if (lastKey && flow[lastKey]?.trim()) {
        const text = clip(flow[lastKey], 500);
        if (!args.onlyIf || args.onlyIf(text)) out.push({ angle: 'life', at: args.atOf(lastKey), time: lastKey, context: `${args.context}・獨白`, text, quotable: false });
    }
    return out;
}

// ─── 朋友圈 ─────────────────────────────────────────

/**
 * 那天的朋友圈：
 * - 作者是 TA（角色之間：其中一位）而且那天發的
 * - 作者是對方、TA 那天在底下留言的
 * isSelf／isOther：判斷 actor 是不是 TA、是不是對方（身份卡要照卡分）
 */
export function momentMaterials(args: {
    posts: MomentPost[];
    dayKey: string;
    dayOf: (ts: number) => string;
    timeOf: (ts: number) => string;
    isSelf: (a: MomentPost['author']) => boolean;
    isOther: (a: MomentPost['author']) => boolean;
    selfName: string;
    otherName: string;
    /** 角色之間：TA 自己發的也要對方有互動才算（不然就只是 TA 的生活） */
    needOther?: boolean;
}): Omit<FragmentMaterial, 'ref'>[] {
    const out: Omit<FragmentMaterial, 'ref'>[] = [];
    for (const p of args.posts) {
        const byOther = args.isOther(p.author);
        const bySelf = args.isSelf(p.author);
        if (!bySelf && !byOther) continue;
        const replies = (p.comments || []).filter(c => (bySelf ? args.isOther(c.actor) : args.isSelf(c.actor)));
        const liked = (p.likes || []).some(l => (bySelf ? args.isOther(l.actor) : args.isSelf(l.actor)));
        const commentLine = (c: MomentPost['comments'][number]) => `${args.isSelf(c.actor) ? args.selfName : args.otherName}留言：${clip(c.content, 80)}`;
        if (bySelf && args.dayOf(p.createdAt) === args.dayKey && (!args.needOther || replies.length || liked)) {
            const extra = [liked ? `${args.otherName}按了讚` : '', ...replies.slice(0, 3).map(commentLine)].filter(Boolean).join('；');
            out.push({
                angle: 'moments', at: p.createdAt, time: args.timeOf(p.createdAt), context: `${args.selfName}的朋友圈`,
                text: clip(`${args.selfName}發：${p.content || '（照片）'}${extra ? `｜${extra}` : ''}`, 260), quotable: false,
                source: { type: 'moment', postId: p.id, snippet: (p.content || '').slice(0, 200), at: p.createdAt },
            });
            continue;
        }
        if (byOther) {
            const todays = replies.filter(c => args.dayOf(c.at) === args.dayKey);
            if (!todays.length) continue;
            const at = todays[0].at;
            out.push({
                angle: 'moments', at, time: args.timeOf(at), context: `${args.otherName}的朋友圈`,
                text: clip(`${args.otherName}發：${p.content || '（照片）'}｜${todays.slice(0, 3).map(commentLine).join('；')}`, 260), quotable: false,
                source: { type: 'moment', postId: p.id, snippet: (p.content || '').slice(0, 200), at },
            });
        }
    }
    return out;
}

// ─── 心聲 ─────────────────────────────────────────

/** 私聊那天 TA 回覆後的心聲（metadata.innerState），最多留最後 6 段 */
export function innerMaterials(msgs: Array<Pick<Message, 'role' | 'timestamp' | 'metadata'>>, timeOf: (ts: number) => string, max = 6): Omit<FragmentMaterial, 'ref'>[] {
    return msgs
        .filter(m => m.role === 'assistant' && typeof m.metadata?.innerState === 'string' && m.metadata.innerState.trim())
        .slice(-max)
        .map(m => ({ angle: 'inner' as const, at: m.timestamp, time: timeOf(m.timestamp), text: clip(String(m.metadata!.innerState), 300), quotable: false }));
}

// ─── 編號、給 AI 看 ─────────────────────────────────────────

/** 照角度、時間排好，編上 G1、A1…（每種各自從 1 數） */
export function numberMaterials(list: Omit<FragmentMaterial, 'ref'>[]): FragmentMaterial[] {
    const count: Record<string, number> = {};
    const order: MaterialAngle[] = ['group', 'aside', 'life', 'moments', 'inner'];
    return [...list]
        .sort((a, b) => order.indexOf(a.angle) - order.indexOf(b.angle) || a.at - b.at)
        .map(m => {
            const p = ANGLE_PREFIX[m.angle];
            count[p] = (count[p] || 0) + 1;
            return { ...m, ref: `${p}${count[p]}` };
        });
}

const HEADING: Record<MaterialAngle, (self: string, other: string, pair: boolean) => string> = {
    group: () => '群聊（有原話可以引）',
    aside: (self, other, pair) => pair ? '私下跟別人聊到對方（有原話可以引）' : `你私下跟別人聊到${other}（有原話可以引）`,
    life: (_s, _o, pair) => pair ? '他們各自的一天（日程、獨白；沒有原話）' : '你這天的日程和獨白（沒有原話）',
    moments: () => '朋友圈（沒有原話）',
    inner: () => '你回完訊息後的心聲（沒有原話）',
};

export function materialsBlock(mats: FragmentMaterial[], selfName: string, otherName: string, pair = false): string {
    if (!mats.length) return '';
    const out: string[] = [];
    let cur: MaterialAngle | null = null;
    for (const m of mats) {
        if (m.angle !== cur) {
            cur = m.angle;
            out.push(`【${HEADING[m.angle](selfName, otherName, pair)}】`);
        }
        const ctx = m.context ? `${m.context} ` : '';
        out.push(`${m.ref} [${m.time}] ${ctx}${m.speaker ? `${m.speaker}：` : ''}${m.text}`);
    }
    return out.join('\n');
}
