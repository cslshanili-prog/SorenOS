/**
 * 角色之間的故事存下後「回寫各區」（plans/bond-batch6.md 2.3、2.4）。純邏輯，有測試。
 *
 * 流程：副 API 讀這一章，抽出「故事裡真的發生的事」→ 列成清單（你勾了才寫、預設全勾，每項能改字）→
 * 勾了的照種類寫成卡：片刻、里程碑、願望、約定、默契、禮物、信、日記，加上兩人各一條第一人稱記憶。
 *
 * - 卡片的來源一律記這一章（`{ type: 'story', entryId }`），刪改這一章時照它找（第 7 節）。
 * - 會改階段的里程碑（`SYNC_KINDS`）不直接寫，變成承認卡（`syncPending`，來源 'story'），你按「對」才改階段、記里程碑。
 *   路線不允許的轉折（友情線抽到「在一起」）直接丟掉；已經是那個階段的當一般里程碑（同一種已經記過就不重複）。
 * - 願望、約定、默契在故事裡已經說好了：狀態直接是成立（願望發布、約定 active、默契兩邊都認）。
 * - 禮物：'out'＝bond.charId 那位（A）送另一位（B），'in'＝B 送 A。
 * - 信：故事裡只說「他留了一封信」，全文由寄信的那位另外寫（不從故事裡剪），寄出就到、沒有慢寄。
 */
import type { BondEntry, BondEventDate, BondPromiseRepeat, BondRoute, BondSyncProposal } from '../../types';
import { newBondEntryId } from './ids';
import { parseJsonObject } from './outputPromptCore';
import { MILESTONE_KINDS, milestoneKindsFor, newHabit, newMilestone, newPromise, newWish, publishWish } from './pact';
import { SYNC_KINDS, syncProposalFor } from './eventCards';
import { newGift } from './gift';
import { newLetter, sendLetter } from './letter';

/** A＝bond.charId 那位，B＝另一位 */
export type StorySide = 'a' | 'b';

export const STORY_EXTRACT_LIMITS = { moment: 3, milestone: 3, wish: 3, promise: 3, habit: 3, gift: 3, letter: 2 } as const;

export interface StoryExtract {
    moments: Array<{ title: string; text: string }>;
    milestones: Array<{ what: string; label?: string; text: string }>;
    wishes: Array<{ owner: StorySide | 'both'; text: string }>;
    promises: Array<{ text: string; repeat: BondPromiseRepeat }>;
    habits: Array<{ text: string }>;
    gifts: Array<{ from: StorySide; title: string; occasion?: string; text: string }>;
    letters: Array<{ from: StorySide; about: string }>;
}

export interface StoryExtractPromptInput {
    aName: string;
    bName: string;
    title: string;
    text: string;
    route?: BondRoute;
    relationLine?: string;
    /** 已經記過的（避免重複抽）：里程碑名稱、願望、約定、默契、禮物 */
    known?: { milestones?: string[]; wishes?: string[]; promises?: string[]; habits?: string[]; gifts?: string[] };
}

const REPEATS: Record<string, BondPromiseRepeat> = {
    once: { kind: 'once' }, daily: { kind: 'daily' }, weekly: { kind: 'weekly' }, monthly: { kind: 'monthly' },
};

/** 叫副 API 抽清單 */
export function buildStoryExtractPrompt(input: StoryExtractPromptInput): string {
    const { aName: A, bName: B } = input;
    const kinds = milestoneKindsFor(input.route).map(k => `${k.id}＝${k.label}`).join('、');
    const known = input.known || {};
    const knownLines = [
        known.milestones?.length ? `里程碑：${known.milestones.join('、')}` : '',
        known.wishes?.length ? `願望：${known.wishes.join('／')}` : '',
        known.promises?.length ? `約定：${known.promises.join('／')}` : '',
        known.habits?.length ? `默契：${known.habits.join('／')}` : '',
        known.gifts?.length ? `禮物：${known.gifts.join('、')}` : '',
    ].filter(Boolean);
    return [
        `下面是 ${A} 和 ${B} 之間的一章故事〈${input.title || '無題'}〉。${input.relationLine ? `他們現在的關係：${input.relationLine}。` : ''}`,
        '請只抽出**故事裡真的發生了**的事（不是想像、夢、假設、開玩笑、被拒絕的），沒有就給空陣列，不要為了填滿而編。',
        '',
        '要抽的：',
        `- moments：值得記住的片刻，1～${STORY_EXTRACT_LIMITS.moment} 件。title 幾個字；text 第三人稱、用名字，一兩句只寫事實。`,
        `- milestones：關係大事，what 只能是下面其中一個 id，都不是就寫 custom 並給 label（幾個字）：${kinds}。text 一句話說怎麼發生的。`,
        '- wishes：某個人說出口的、想跟對方一起做的事（還沒做）；owner 是 A、B 或 both（兩人都想）。',
        '- promises：兩人說好要做的事；repeat 是 once（一次）、daily、weekly、monthly 其中一個。',
        '- habits：兩人之間已經有的默契或小習慣（故事裡看得出來、兩人都認的）。',
        '- gifts：誰送了誰什麼；from 是 A 或 B（送的人），title 是東西的名字，occasion 是場合（可以空），text 一句話。',
        '- letters：故事裡有人寫了、留了、寄了一封信；from 是寫信的人，about 一句話說信大概寫什麼（全文另外寫）。',
        '',
        `A＝${A}，B＝${B}。`,
        ...(knownLines.length ? ['', '【已經記過的，不要重複抽】', ...knownLines] : []),
        '',
        '只輸出 JSON：',
        '{"moments":[{"title":"","text":""}],"milestones":[{"what":"","label":"","text":""}],"wishes":[{"owner":"A","text":""}],"promises":[{"text":"","repeat":"once"}],"habits":[{"text":""}],"gifts":[{"from":"A","title":"","occasion":"","text":""}],"letters":[{"from":"A","about":""}]}',
        '',
        '【故事】',
        input.text,
    ].join('\n');
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') as Array<Record<string, unknown>> : []);

/** 'A'／'B'／名字 → a／b；認不出來回 undefined */
function sideOf(v: unknown, aName: string, bName: string): StorySide | undefined {
    const s = str(v).toLowerCase();
    if (!s) return undefined;
    if (s === 'a' || s === aName.trim().toLowerCase()) return 'a';
    if (s === 'b' || s === bName.trim().toLowerCase()) return 'b';
    return undefined;
}

const dedupe = <T>(list: T[], keyOf: (x: T) => string): T[] => {
    const seen = new Set<string>();
    return list.filter(x => {
        const k = keyOf(x).replace(/\s+/g, '');
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
};

/** 解析抽出來的清單；整個讀不懂回 null（壞的單項丟掉、不整份作廢） */
export function parseStoryExtract(raw: string, aName: string, bName: string): StoryExtract | null {
    const o = parseJsonObject(raw);
    if (!o) return null;
    const L = STORY_EXTRACT_LIMITS;
    const validWhat = new Set([...MILESTONE_KINDS.map(k => k.id), 'custom']);
    return {
        moments: dedupe(arr(o.moments).map(m => ({ title: str(m.title, 30), text: str(m.text) })).filter(m => m.text), m => m.text).slice(0, L.moment),
        milestones: dedupe(arr(o.milestones).map(m => {
            const what = str(m.what, 40);
            const label = str(m.label, 20);
            return validWhat.has(what) ? { what, ...(what === 'custom' && label ? { label } : {}), text: str(m.text) }
                : label || what ? { what: 'custom', label: label || what, text: str(m.text) } : null;
        }).filter((m): m is { what: string; label?: string; text: string } => !!m && !(m.what === 'custom' && !m.label)), m => `${m.what}|${m.label || ''}`).slice(0, L.milestone),
        wishes: dedupe(arr(o.wishes).map(w => {
            const owner = str(w.owner).toLowerCase() === 'both' ? 'both' as const : sideOf(w.owner, aName, bName);
            return owner ? { owner, text: str(w.text, 200) } : null;
        }).filter((w): w is { owner: StorySide | 'both'; text: string } => !!w && !!w.text), w => w.text).slice(0, L.wish),
        promises: dedupe(arr(o.promises).map(p => ({ text: str(p.text, 200), repeat: REPEATS[str(p.repeat).toLowerCase()] || { kind: 'once' as const } }))
            .filter(p => p.text), p => p.text).slice(0, L.promise),
        habits: dedupe(arr(o.habits).map(h => ({ text: str(h.text, 200) })).filter(h => h.text), h => h.text).slice(0, L.habit),
        gifts: dedupe(arr(o.gifts).map(g => {
            const from = sideOf(g.from, aName, bName);
            const title = str(g.title, 40);
            return from && title ? { from, title, ...(str(g.occasion, 40) ? { occasion: str(g.occasion, 40) } : {}), text: str(g.text, 200) || title } : null;
        }).filter((g): g is { from: StorySide; title: string; occasion?: string; text: string } => !!g), g => `${g.from}|${g.title}`).slice(0, L.gift),
        letters: dedupe(arr(o.letters).map(l => {
            const from = sideOf(l.from, aName, bName);
            return from ? { from, about: str(l.about, 200) } : null;
        }).filter((l): l is { from: StorySide; about: string } => !!l), l => `${l.from}|${l.about}`).slice(0, L.letter),
    };
}

// ─── 清單（你勾、能改字） ───────────────────────────

export type StoryWriteItem =
    | { key: string; kind: 'moment'; title: string; text: string }
    /** sync 有值＝會改階段，寫成承認卡、不直接記里程碑 */
    | { key: string; kind: 'milestone'; what: string; label?: string; text: string; sync?: { stageTo?: string; routeTo?: BondRoute } }
    | { key: string; kind: 'wish'; owner: StorySide | 'both'; text: string }
    | { key: string; kind: 'promise'; text: string; repeat: BondPromiseRepeat }
    | { key: string; kind: 'habit'; text: string }
    | { key: string; kind: 'gift'; from: StorySide; title: string; occasion?: string; text: string }
    /** text 是寄信的那位另外寫的全文（還沒寫好是空的，空的不寫） */
    | { key: string; kind: 'letter'; from: StorySide; about: string; text: string }
    | { key: string; kind: 'diary'; side: StorySide; text: string }
    | { key: string; kind: 'memory'; side: StorySide; text: string };

export type StoryWriteKind = StoryWriteItem['kind'];

export const STORY_WRITE_LABEL: Record<StoryWriteKind, string> = {
    moment: '片刻', milestone: '里程碑', wish: '願望', promise: '約定', habit: '默契', gift: '禮物', letter: '信', diary: '日記', memory: '記憶',
};

/** 清單的順序：片刻 → 里程碑 → 願望約定默契 → 禮物 → 信 → 日記 → 記憶 */
export const STORY_WRITE_ORDER: StoryWriteKind[] = ['moment', 'milestone', 'wish', 'promise', 'habit', 'gift', 'letter', 'diary', 'memory'];

/**
 * 抽出來的 → 清單。里程碑照路線篩：路線不允許的丟掉；會改階段的帶 sync；已經是那個階段、
 * 或同一種已經記過的（knownWhats）不重複。
 */
export function storyCandidates(ex: StoryExtract, ctx: { route?: BondRoute; stage: string; knownWhats?: string[] }): StoryWriteItem[] {
    const out: StoryWriteItem[] = [];
    let n = 0;
    const k = (kind: string) => `${kind}:${n++}`;
    ex.moments.forEach(m => out.push({ key: k('moment'), kind: 'moment', title: m.title, text: m.text }));
    const allowed = new Set(milestoneKindsFor(ctx.route).map(x => x.id));
    const known = new Set(ctx.knownWhats || []);
    for (const m of ex.milestones) {
        if (m.what !== 'custom' && !allowed.has(m.what)) continue;
        const sk = SYNC_KINDS[m.what];
        if (sk) {
            if (sk.route !== 'any' && ctx.route && ctx.route !== sk.route) continue;
            const plan = syncProposalFor(m.what, ctx.route, ctx.stage);
            if (plan && (plan.stageTo || plan.routeTo || sk.route === 'any')) {
                out.push({ key: k('milestone'), kind: 'milestone', what: m.what, text: m.text, sync: plan });
                continue;
            }
        }
        if (m.what !== 'custom' && known.has(m.what)) continue;
        out.push({ key: k('milestone'), kind: 'milestone', what: m.what, ...(m.label ? { label: m.label } : {}), text: m.text });
    }
    ex.wishes.forEach(w => out.push({ key: k('wish'), kind: 'wish', owner: w.owner, text: w.text }));
    ex.promises.forEach(p => out.push({ key: k('promise'), kind: 'promise', text: p.text, repeat: p.repeat }));
    ex.habits.forEach(h => out.push({ key: k('habit'), kind: 'habit', text: h.text }));
    ex.gifts.forEach(g => out.push({ key: k('gift'), kind: 'gift', from: g.from, title: g.title, ...(g.occasion ? { occasion: g.occasion } : {}), text: g.text }));
    ex.letters.forEach(l => out.push({ key: k('letter'), kind: 'letter', from: l.from, about: l.about, text: '' }));
    return out;
}

/** 預設勾哪些：全勾；日記照「私下聊滿一大段各留一篇日記」那個開關（關掉時預設不勾） */
export function defaultChecked(items: StoryWriteItem[], autoDiary: boolean): Set<string> {
    return new Set(items.filter(i => i.kind !== 'diary' || autoDiary).map(i => i.key));
}

// ─── 各自的那一份（日記、記憶、信） ─────────────────

/** 兩人各一次：用自己的口吻寫這一章的日記與一條記憶（主 API，帶自己的人設） */
export function buildStoryPersonalPrompt(args: { selfName: string; otherName: string; title: string; text: string; diary: boolean; povNote?: string }): string {
    return [
        `下面是你（${args.selfName}）和 ${args.otherName} 之間發生的一段事〈${args.title || '無題'}〉，寫成了故事。${args.povNote || ''}`,
        '用你自己的口吻、第一人稱，照你的性格寫：',
        `- memory：你記住了這件事的什麼（60～150 字，「我」就是你；寫事實和你在意的點，像你日後回想起來的樣子）。`,
        args.diary ? `- diary：當天晚上你寫的一篇日記（200～500 字，主觀、寫你自己怎麼看這件事、怎麼看 ${args.otherName}；不寫成故事複述）。` : '',
        '用戶（手機的主人）不在場，不要提到用戶。',
        `只輸出 JSON：{"memory":""${args.diary ? ',"diary":""' : ''}}`,
        '',
        '【故事】',
        args.text,
    ].filter(Boolean).join('\n');
}

export function parseStoryPersonal(raw: string): { memory: string; diary: string } | null {
    const o = parseJsonObject(raw);
    if (!o) return null;
    const memory = str(o.memory, 400);
    const diary = typeof o.diary === 'string' ? o.diary.trim().slice(0, 3000) : '';
    return memory || diary ? { memory, diary } : null;
}

/** 寄信的那位寫信的全文（主 API，帶自己的人設） */
export function buildStoryLetterPrompt(args: { fromName: string; toName: string; about: string; title: string; summary: string }): string {
    return [
        `你（${args.fromName}）在〈${args.title || '無題'}〉那件事裡寫了一封信給 ${args.toName}。`,
        `那件事：${args.summary}`,
        args.about ? `信大概寫的是：${args.about}` : '',
        `請寫出這封信的全文：用你自己的口吻，寫給 ${args.toName}，150～500 字，開頭可以有稱呼、結尾可以署名。`,
        '用戶（手機的主人）不在場，不要提到用戶。只輸出信的內容，不要加說明。',
    ].filter(Boolean).join('\n');
}

export function cleanStoryLetter(raw: string): string {
    return String(raw || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim().slice(0, 4000);
}

// ─── 寫成卡 ───────────────────────────────────────

export interface StoryWritebackPlan {
    entries: BondEntry[];
    proposals: Array<Omit<BondSyncProposal, 'id' | 'at'>>;
    /** 兩人各自的記憶（寫進話題盒、記憶宮殿；由 App 那半去寫） */
    memories: Array<{ side: StorySide; text: string }>;
}

/** 勾了的清單 → 卡、承認卡、記憶。每張卡的來源都是這一章 */
export function planStoryWriteback(items: StoryWriteItem[], ctx: {
    bondId: string; storyId: string; aId: string; bId: string; eventDate: BondEventDate; now?: number;
}): StoryWritebackPlan {
    const now = ctx.now ?? Date.now();
    const idOf = (s: StorySide) => (s === 'a' ? ctx.aId : ctx.bId);
    const src = [{ type: 'story' as const, entryId: ctx.storyId }];
    const stamp = (e: BondEntry): BondEntry => ({ ...e, sources: src, eventDate: ctx.eventDate });
    const day = ctx.eventDate.precision === 'day' ? ctx.eventDate.date : undefined;
    const out: StoryWritebackPlan = { entries: [], proposals: [], memories: [] };
    for (const it of items) {
        switch (it.kind) {
            case 'moment':
                if (!it.text.trim()) break;
                out.entries.push(stamp({
                    id: newBondEntryId(), bondId: ctx.bondId, kind: 'moment', author: 'user',
                    ...(it.title.trim() ? { title: it.title.trim() } : {}), text: it.text.trim(),
                    eventDate: ctx.eventDate, writtenAt: now, sources: [], links: [], status: 'published', createdBy: 'ai', updatedAt: now,
                }));
                break;
            case 'milestone':
                if (it.sync) {
                    out.proposals.push({
                        what: it.what, ...it.sync, ...(day ? { date: day } : {}), text: it.text.trim() || SYNC_KINDS[it.what]?.label || it.what,
                        source: 'story', evidence: { storyId: ctx.storyId }, key: `story:${ctx.storyId}:${it.what}`,
                    });
                } else {
                    out.entries.push(stamp(newMilestone({
                        bondId: ctx.bondId, author: ctx.aId, what: it.what, ...(it.label ? { title: it.label } : {}), text: it.text,
                        eventDate: ctx.eventDate, via: 'story', now,
                    })));
                }
                break;
            case 'wish': {
                if (!it.text.trim()) break;
                const owner = it.owner === 'both' ? 'both' : idOf(it.owner);
                const w = publishWish(newWish({ bondId: ctx.bondId, author: it.owner === 'b' ? ctx.bId : ctx.aId, owner, text: it.text, now }), now);
                out.entries.push(stamp(w));
                break;
            }
            case 'promise': {
                if (!it.text.trim()) break;
                const p = newPromise({ bondId: ctx.bondId, author: ctx.aId, text: it.text, repeat: it.repeat, check: { kind: 'manual' }, participants: [ctx.aId, ctx.bId], now });
                out.entries.push(stamp({ ...p, promise: { ...p.promise!, agreedBy: { user: now, char: now }, state: 'active' } }));
                break;
            }
            case 'habit': {
                if (!it.text.trim()) break;
                const h = newHabit({ bondId: ctx.bondId, author: ctx.aId, text: it.text, origin: 'agreed', now });
                out.entries.push(stamp({ ...h, habit: { ...h.habit!, confirmedBy: { user: now, char: now }, state: 'active' } }));
                break;
            }
            case 'gift':
                if (!it.title.trim()) break;
                out.entries.push(stamp(newGift({
                    bondId: ctx.bondId, dir: it.from === 'a' ? 'out' : 'in', state: 'given', title: it.title, text: it.text || it.title,
                    ...(it.occasion ? { occasion: it.occasion } : {}), author: idOf(it.from), now,
                })));
                break;
            case 'letter': {
                if (!it.text.trim()) break;
                const to = it.from === 'a' ? ctx.bId : ctx.aId;
                const l = sendLetter(newLetter({ bondId: ctx.bondId, author: idOf(it.from), to, text: it.text.trim(), origin: 'story', now }), 0, now);
                out.entries.push(stamp(l));
                break;
            }
            case 'diary':
                if (!it.text.trim()) break;
                out.entries.push(stamp(newPairDiary({ bondId: ctx.bondId, author: idOf(it.side), text: it.text, date: day, now })));
                break;
            case 'memory':
                if (it.text.trim()) out.memories.push({ side: it.side, text: it.text.trim() });
                break;
        }
    }
    return out;
}

/** 角色之間的一篇日記（作者是角色 id；第 6c 批的小按鈕、自動日記也用它） */
export function newPairDiary(input: { bondId: string; author: string; text: string; date?: string; title?: string; now?: number }): BondEntry {
    const now = input.now ?? Date.now();
    const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined;
    return {
        id: newBondEntryId(), bondId: input.bondId, kind: 'diary', author: input.author,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        text: input.text.trim(), eventDate: date ? { precision: 'day', date } : { precision: 'unknown' },
        writtenAt: now, sources: [], links: [], status: 'published', createdBy: 'ai', updatedAt: now,
        diary: { date: date || '' },
    };
}

/** 故事寫進記憶宮殿的那一條（標「用戶不在場」，跟角色私聊同一個寫法） */
export function storyPalaceContent(partnerName: string, text: string): string {
    return `〔這是你跟「${partnerName}」之間發生的事，用戶不在場〕${text.trim()}`;
}

/** 回寫埋點的分檔（0／1／2+） */
export function countBucket(n: number): '0' | '1' | '2+' {
    return n <= 0 ? '0' : n === 1 ? '1' : '2+';
}
