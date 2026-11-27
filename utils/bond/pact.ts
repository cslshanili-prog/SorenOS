/**
 * 約定分頁的資料（plans/bond-batch4.md 第 1 節，紀要 3.5、3.9、6.2）：願望、共同約定（含任務）、默契、里程碑。
 * 純邏輯，有測試；都存在 bond_entries，`text` 是內容。
 *
 * - **願望**：看見不等於答應。對方可以「支持」，但不會因此變成共同約定；談妥了才連到一個約定（state 'agreed'）。
 *   你的願望先存草稿，發布了對方才知道（跟紙條一樣）。
 * - **共同約定**：雙方都說好才成立。提的人建立時就算說好；另一方答應了才 `active`。
 * - **默契**：雙方都確認才算；單方期待不能直接登記成默契。
 * - **里程碑**：已經發生的關係大事，日期在 eventDate。
 */
import type { BondEntry, BondEventDate, BondHabit, BondLink, BondPromise, BondPromiseRepeat, BondRoute, BondTaskCheck, BondWish } from '../../types';
import { newBondEntryId } from './ids';

export type PactSide = 'user' | 'char';
export const sideOf = (author: string): PactSide => (author === 'user' ? 'user' : 'char');

const base = (input: { bondId: string; author: string; text: string; now: number }, kind: BondEntry['kind'], status: BondEntry['status']): BondEntry => ({
    id: newBondEntryId(),
    bondId: input.bondId,
    kind,
    author: input.author,
    text: input.text.trim(),
    eventDate: { precision: 'unknown' },
    writtenAt: input.now,
    sources: [],
    links: [],
    status,
    createdBy: input.author === 'user' ? 'user' : 'ai',
    updatedAt: input.now,
});

// ─── 願望 ─────────────────────────────────────────

export const WISH_STATE_LABEL: Record<BondWish['state'], string> = { want: '想做', agreed: '已約好', done: '完成了', shelved: '暫時擱著' };

/** 誰的願望（給人看）：我的／TA 的／我們的 */
export const wishOwnerLabel = (owner: string, charName: string): string => (owner === 'both' ? '我們的' : owner === 'user' ? '我的' : `${charName}的`);
export type WishBucket = 'mine' | 'theirs' | 'ours';
export const wishBucket = (e: BondEntry): WishBucket => (e.wish?.owner === 'both' ? 'ours' : e.wish?.owner === 'user' ? 'mine' : 'theirs');

export function newWish(input: { bondId: string; author: string; owner: string; text: string; now?: number }): BondEntry {
    const now = input.now ?? Date.now();
    return { ...base({ ...input, now }, 'wish', 'draft'), wish: { owner: input.owner, state: 'want' } };
}

/** 發布（發布的才是雙方知道的） */
export function publishWish(e: BondEntry, now = Date.now()): BondEntry {
    if (e.kind !== 'wish' || e.status === 'published') return e;
    return { ...e, status: 'published', writtenAt: now, updatedAt: now };
}

/** 對方表示支持（不等於答應一起做） */
export function supportWish(e: BondEntry, by: string, words?: string, together = false, now = Date.now()): BondEntry {
    return { ...e, wish: { ...e.wish!, support: { by, at: now, ...(words?.trim() ? { words: words.trim() } : {}), ...(together ? { together: true } : {}) } }, updatedAt: now };
}

export function setWishState(e: BondEntry, state: BondWish['state'], now = Date.now()): BondEntry {
    const wish: BondWish = { ...e.wish!, state };
    if (state !== 'done') { delete wish.doneAt; delete wish.doneLinks; }
    return { ...e, wish, updatedAt: now };
}

/** 談成了約定：連上、狀態變「已約好」 */
export function linkWishToPromise(e: BondEntry, promiseId: string, now = Date.now()): BondEntry {
    return { ...e, wish: { ...e.wish!, promiseId, state: e.wish!.state === 'done' ? 'done' : 'agreed' }, updatedAt: now };
}

/** 完成：連到實際的拾光（片刻、記憶），連結也寫進 links（撤回時找得到誰依賴誰） */
export function completeWish(e: BondEntry, doneLinks: BondLink[], now = Date.now()): BondEntry {
    return { ...e, wish: { ...e.wish!, state: 'done', doneAt: now, doneLinks }, links: doneLinks, updatedAt: now };
}

// ─── 共同約定 ─────────────────────────────────────

export const PROMISE_STATE_LABEL: Record<BondPromise['state'], string> = {
    proposed: '還在商量', active: '進行中', paused: '暫停', done: '完成了', dropped: '不做了',
};

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export function repeatLabel(r: BondPromiseRepeat): string {
    switch (r.kind) {
        case 'once': return '一次';
        case 'daily': return '每天';
        case 'weekly': return r.days?.length ? `每週${r.days.map(d => WEEKDAY[d]).join('、')}` : '每週';
        case 'monthly': return '每月';
        case 'everyNDays': return `每 ${r.n} 天`;
        case 'yearly': return `每年 ${Number(r.date.slice(0, 2))} 月 ${Number(r.date.slice(3, 5))} 日`;
    }
}

export const RECORD_LABEL: Record<Extract<BondTaskCheck, { kind: 'record' }>['record'], string> = {
    chat: '聊幾句', deepChat: '深聊', goodnight: '互道晚安', photo: '分享照片', call: '通話', date: '見面', music: '一起聽歌', gift: '送禮或收禮', letter: '寄出一封信',
};

export function checkLabel(c: BondTaskCheck): string {
    switch (c.kind) {
        case 'record': return `照紀錄判：${RECORD_LABEL[c.record]}`;
        case 'manual': return '你確認';
        case 'ai': return 'AI 讀聊天判斷';
        case 'keyword': return `聊天裡出現「${c.words.join('／')}」${c.both ? '（雙方都要）' : ''}`;
    }
}

export interface PromiseTemplate {
    id: string;
    /** 三條路線的文案；沒寫的用 default */
    title: Partial<Record<BondRoute | 'none', string>> & { default: string };
    repeat: BondPromiseRepeat;
    check: BondTaskCheck;
    points: number;
}

/** 任務模板（plans/bond-batch4.md 1.2；分數 2026-11-26 定案） */
export const PROMISE_TEMPLATES: PromiseTemplate[] = [
    { id: 'chat', title: { default: '今天聊幾句' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'chat' }, points: 10 },
    { id: 'deepChat', title: { default: '好好聊一聊' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'deepChat' }, points: 20 },
    { id: 'goodnight', title: { default: '互道晚安', friendship: '睡前說一聲', family: '睡前說一聲' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'goodnight' }, points: 10 },
    { id: 'photo', title: { default: '分享一張照片' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'photo' }, points: 10 },
    { id: 'call', title: { default: '通個電話' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'call' }, points: 20 },
    { id: 'date', title: { default: '見個面', romance: '約會' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'date' }, points: 30 },
    { id: 'music', title: { default: '一起聽歌' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'music' }, points: 10 },
    { id: 'gift', title: { default: '送點什麼' }, repeat: { kind: 'daily' }, check: { kind: 'record', record: 'gift' }, points: 10 },
    // 第 5 批：每個月寫一封信（這個月你寄出一封就算）
    { id: 'letter', title: { default: '寫一封信' }, repeat: { kind: 'monthly' }, check: { kind: 'record', record: 'letter' }, points: 10 },
];

export const templateTitle = (t: PromiseTemplate, route: BondRoute | undefined): string => t.title[route || 'none'] || t.title.default;

/** 提一個約定：提的人建立時就算說好；另一方答應了才成立 */
export function newPromise(input: {
    bondId: string; author: string; text: string;
    repeat: BondPromiseRepeat; check: BondTaskCheck; points?: number;
    participants: string[]; fromWishId?: string; templateId?: string; now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const side = sideOf(input.author);
    const promise: BondPromise = {
        repeat: input.repeat,
        participants: input.participants,
        check: input.check,
        ...(typeof input.points === 'number' && input.points > 0 ? { points: Math.round(input.points) } : {}),
        agreedBy: { [side]: now },
        state: 'proposed',
        ...(input.fromWishId ? { fromWishId: input.fromWishId } : {}),
        ...(input.templateId ? { templateId: input.templateId } : {}),
    };
    return { ...base({ ...input, now }, 'promise', 'published'), promise };
}

/** 某一方說好；兩邊都說好就成立 */
export function agreePromise(e: BondEntry, side: PactSide, now = Date.now()): BondEntry {
    const p = e.promise!;
    const agreedBy = { ...p.agreedBy, [side]: p.agreedBy[side] || now };
    const both = !!agreedBy.user && !!agreedBy.char;
    return { ...e, promise: { ...p, agreedBy, state: p.state === 'proposed' && both ? 'active' : p.state }, updatedAt: now };
}

/** 對方回應（角色照人設：答應、想改一下、先不要）；答應就算說好 */
export function replyPromise(e: BondEntry, by: string, answer: 'yes' | 'tweak' | 'no', words: string, now = Date.now()): BondEntry {
    const withReply: BondEntry = { ...e, promise: { ...e.promise!, reply: { by, at: now, words: words.trim(), answer } }, updatedAt: now };
    return answer === 'yes' ? agreePromise(withReply, sideOf(by), now) : withReply;
}

export function setPromiseState(e: BondEntry, state: BondPromise['state'], now = Date.now()): BondEntry {
    return { ...e, promise: { ...e.promise!, state }, updatedAt: now };
}

/** 改內容（提議中的改了，等於重新提：另一方的「說好」作廢） */
export function editPromise(e: BondEntry, patch: { text?: string; repeat?: BondPromiseRepeat; check?: BondTaskCheck; points?: number | null }, by: PactSide, now = Date.now()): BondEntry {
    const p = e.promise!;
    const next: BondPromise = {
        ...p,
        ...(patch.repeat ? { repeat: patch.repeat } : {}),
        ...(patch.check ? { check: patch.check } : {}),
    };
    if (patch.points === null || patch.points === 0) delete next.points;
    else if (typeof patch.points === 'number') next.points = Math.round(patch.points);
    const contentChanged = (patch.text !== undefined && patch.text.trim() !== e.text) || !!patch.repeat;
    if (contentChanged && p.state === 'proposed') {
        next.agreedBy = { [by]: now };
        delete next.reply;
    }
    return { ...e, text: patch.text !== undefined ? patch.text.trim() : e.text, promise: next, updatedAt: now };
}

export const promiseActive = (e: BondEntry): boolean => e.kind === 'promise' && e.promise?.state === 'active';
/** 等誰說好（提議中才有） */
export const promiseWaitingOn = (e: BondEntry): PactSide | null =>
    e.promise?.state !== 'proposed' ? null : !e.promise.agreedBy.user ? 'user' : !e.promise.agreedBy.char ? 'char' : null;

// ─── 默契 ─────────────────────────────────────────

export const HABIT_STATE_LABEL: Record<BondHabit['state'], string> = { proposed: '等對方確認', active: '我們的默契', retired: '不再這樣了' };

export function newHabit(input: { bondId: string; author: string; text: string; origin?: BondHabit['origin']; examples?: BondLink[]; now?: number }): BondEntry {
    const now = input.now ?? Date.now();
    const habit: BondHabit = {
        confirmedBy: { [sideOf(input.author)]: now },
        origin: input.origin || 'agreed',
        ...(input.examples?.length ? { examples: input.examples } : {}),
        state: 'proposed',
    };
    return { ...base({ ...input, now }, 'habit', 'published'), habit };
}

export function confirmHabit(e: BondEntry, side: PactSide, now = Date.now()): BondEntry {
    const h = e.habit!;
    const confirmedBy = { ...h.confirmedBy, [side]: h.confirmedBy[side] || now };
    const both = !!confirmedBy.user && !!confirmedBy.char;
    return { ...e, habit: { ...h, confirmedBy, state: h.state === 'proposed' && both ? 'active' : h.state }, updatedAt: now };
}

export function replyHabit(e: BondEntry, by: string, answer: 'yes' | 'no', words: string, now = Date.now()): BondEntry {
    const withReply: BondEntry = { ...e, habit: { ...e.habit!, reply: { by, at: now, words: words.trim(), answer } }, updatedAt: now };
    return answer === 'yes' ? confirmHabit(withReply, sideOf(by), now) : withReply;
}

export function retireHabit(e: BondEntry, retired: boolean, now = Date.now()): BondEntry {
    const h = e.habit!;
    const both = !!h.confirmedBy.user && !!h.confirmedBy.char;
    return { ...e, habit: { ...h, state: retired ? 'retired' : both ? 'active' : 'proposed' }, updatedAt: now };
}

export const habitWaitingOn = (e: BondEntry): PactSide | null =>
    e.habit?.state !== 'proposed' ? null : !e.habit.confirmedBy.user ? 'user' : !e.habit.confirmedBy.char ? 'char' : null;

// ─── 里程碑 ───────────────────────────────────────

/** 內建的里程碑種類（給選單；事件卡、同步承認用同一份 id） */
export const MILESTONE_KINDS: Array<{ id: string; label: string; routes?: Array<BondRoute | 'none'> }> = [
    { id: 'firstDate', label: '第一次單獨約會', routes: ['romance'] },
    { id: 'confession', label: '告白', routes: ['romance'] },
    { id: 'together', label: '在一起了', routes: ['romance'] },
    { id: 'livingTogether', label: '開始一起生活', routes: ['romance', 'friendship', 'family'] },
    { id: 'proposal', label: '求婚', routes: ['romance'] },
    { id: 'married', label: '結婚', routes: ['romance'] },
    { id: 'deepTalk', label: '第一次深夜長談' },
    { id: 'entrusted', label: '重要的託付', routes: ['friendship', 'family', 'none'] },
    { id: 'bestFriends', label: '成為摯友', routes: ['friendship'] },
    { id: 'reconciled', label: '和好了' },
    { id: 'tradition', label: '有了我們的傳統' },
    { id: 'firstTrip', label: '第一次一起旅行' },
    { id: 'custom', label: '自訂' },
];

/** 這條路線能記的里程碑：未指定路線什麼都能記（還沒選，不替你擋）；友情、親情線不列戀愛的 */
export const milestoneKindsFor = (route: BondRoute | undefined): typeof MILESTONE_KINDS =>
    !route ? MILESTONE_KINDS : MILESTONE_KINDS.filter(k => !k.routes || k.routes.includes(route));

export const milestoneLabel = (what: string, label?: string): string =>
    what === 'custom' ? (label?.trim() || '自訂') : MILESTONE_KINDS.find(k => k.id === what)?.label || label || what;

export function newMilestone(input: {
    bondId: string; author: string; what: string; title?: string; text: string; eventDate: BondEventDate;
    via: NonNullable<BondEntry['milestone']>['via']; stageTo?: string; sources?: BondEntry['sources']; now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    return {
        ...base({ ...input, now }, 'milestone', 'published'),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        eventDate: input.eventDate,
        sources: input.sources || [],
        milestone: { what: input.what, via: input.via, ...(input.stageTo ? { stageTo: input.stageTo } : {}) },
    };
}
