/**
 * 禮物圖鑑（plans/bond-batch5.md 第 1.1、2 節）。純邏輯，有測試。
 *
 * - **購物紀錄不另存一份**：這條線的送禮單（你買給 TA、TA 買給你）每張是一件，狀態照配送進度現算；
 *   你在那件上補了照片、場合、後續才寫一張 `gift` 卡，用 `orderId` 疊上去。
 * - 手記的（購物中心以外的禮物）、打算送的、TA 偷偷準備的，是卡片本身。
 * - **知情**：你打算送的不給 TA 看；TA 偷偷準備、還沒送出的不給你看（`forViewer`）。
 */
import type { BondEntry, BondGift, BondGiftFollowup, BondGiftFollowupPending, BondRecord, MallOrder } from '../../types';
import { mallOrderProgress } from '../mallOrders';
import { newBondEntryId } from './ids';

export type GiftDir = BondGift['dir'];
export type GiftState = BondGift['state'];

/** 一件禮物（圖鑑上的一格） */
export interface GiftView {
    /** 'o:<orderId>'（購物中心的單）或 'e:<entryId>'（只有卡片） */
    key: string;
    dir: GiftDir;
    state: GiftState;
    title: string;
    items: NonNullable<BondGift['items']>;
    /** 排序與顯示的日期：送出／收到 > 買 > 寫下 */
    at: number;
    order?: MallOrder;
    entry?: BondEntry;
    /** 配送進度那一行（購物中心的單） */
    progress?: string;
    occasion?: string;
    photos: string[];
    followups: BondGiftFollowup[];
    /** TA 偷偷準備的：準備了幾天（揭曉後才有） */
    preparedDays?: number;
    /** 還沒揭曉的 TA 的打算（只有 forViewer 'char' 看得到） */
    secret?: boolean;
}

const DAY = 86400_000;
export const SECRET_EXPIRE_MS = 60 * DAY;
export const SECRET_MAX_OPEN = 3;

/** 這張訂單是不是這段關係的禮物；是的話往哪個方向 */
export function orderGiftDir(o: Pick<MallOrder, 'buyer' | 'recipient' | 'payer'>): GiftDir | null {
    if (o.buyer === 'user' && o.recipient === 'char') return 'out';
    if (o.buyer === 'char' && o.recipient === 'user') return 'in';
    return null; // 給自己的、代付（你請 TA 付錢買給你自己）都不是禮物
}

/** 這條線的送禮單：角色對、線對、是禮物 */
export function giftOrdersFor(orders: MallOrder[], charId: string, lineKey: string): MallOrder[] {
    return orders.filter(o => o.charId === charId && (o.lineKey || charId) === lineKey && !!orderGiftDir(o));
}

const titleOf = (items: BondGift['items'] | undefined, fallback: string): string => {
    const list = (items || []).filter(i => i.name?.trim());
    if (!list.length) return fallback.trim() || '一份禮物';
    const first = list[0].name.trim();
    return list.length > 1 ? `${first} 等 ${list.length} 樣` : first;
};

/**
 * 圖鑑：訂單＋卡片合起來，新的在前。
 * forViewer 'user'：不列 TA 還沒揭曉的打算；'char'：不列你打算送的（驚喜），列 TA 自己的打算。
 */
export function buildGiftViews(input: {
    orders: MallOrder[];
    entries: BondEntry[];
    forViewer: 'user' | 'char';
    now?: number;
}): GiftView[] {
    const now = input.now ?? Date.now();
    const gifts = input.entries.filter(e => e.kind === 'gift' && e.gift);
    const byOrder = new Map<string, BondEntry>();
    for (const e of gifts) if (e.gift!.orderId) byOrder.set(e.gift!.orderId, e);
    const out: GiftView[] = [];

    for (const o of input.orders) {
        const dir = orderGiftDir(o);
        if (!dir) continue;
        const p = mallOrderProgress(o, now);
        if (p.stage === 'cancelled' || p.stage === 'awaiting-payment') continue;
        const entry = byOrder.get(o.id);
        const g = entry?.gift;
        const state: GiftState = p.stage === 'delivered' ? 'given' : 'bought';
        const at = state === 'given' ? (p.deliveredAt || o.paidAt || o.createdAt) : (o.paidAt || o.createdAt);
        out.push({
            key: `o:${o.id}`, dir, state, order: o, entry,
            title: entry?.title?.trim() || titleOf(o.items, entry?.text || ''),
            items: o.items.map(i => ({ ...i })),
            at, progress: p.label,
            occasion: g?.occasion, photos: g?.photos || [], followups: g?.followups || [],
            ...(g?.secret?.revealedAt ? { preparedDays: Math.max(1, Math.round((g.secret.revealedAt - g.secret.plannedAt) / DAY)) } : {}),
        });
    }

    for (const e of gifts) {
        const g = e.gift!;
        if (g.orderId && input.orders.some(o => o.id === g.orderId)) continue; // 已經疊在訂單上
        const secret = !!g.secret && !g.secret.revealedAt;
        if (secret && input.forViewer === 'user') continue;
        if (g.state === 'planned' && g.dir === 'out' && input.forViewer === 'char') continue;
        if (g.state === 'planned' && g.dir === 'in' && !g.secret) continue; // TA 的打算只有 secret 這一種
        out.push({
            key: `e:${e.id}`, dir: g.dir, state: g.state, entry: e,
            title: e.title?.trim() || titleOf(g.items, e.text),
            items: g.items || [],
            at: g.givenAt || g.boughtAt || e.writtenAt,
            occasion: g.occasion, photos: g.photos || [], followups: g.followups || [],
            ...(secret ? { secret: true } : {}),
            ...(g.secret?.revealedAt ? { preparedDays: Math.max(1, Math.round((g.secret.revealedAt - g.secret.plannedAt) / DAY)) } : {}),
        });
    }
    return out.sort((a, b) => b.at - a.at);
}

export type GiftBucket = 'out' | 'in' | 'planned';
export function giftBucket(v: GiftView): GiftBucket {
    if (v.state === 'planned') return 'planned';
    return v.dir;
}

export interface GiftStats { given: number; received: number; first?: GiftView }
export function giftStats(views: GiftView[]): GiftStats {
    const real = views.filter(v => v.state !== 'planned' && !v.secret);
    const given = real.filter(v => v.dir === 'out' && v.state === 'given').length;
    const received = real.filter(v => v.dir === 'in' && v.state === 'given').length;
    const done = real.filter(v => v.state === 'given');
    const first = done.length ? done.reduce((a, b) => (a.at <= b.at ? a : b)) : undefined;
    return { given, received, ...(first ? { first } : {}) };
}

// ─── 建卡與改卡 ─────────────────────────────────────

/** 手記一件（購物中心以外的禮物）或打算送 */
export function newGift(input: {
    bondId: string; dir: GiftDir; state: GiftState; text: string; title?: string;
    items?: BondGift['items']; occasion?: string; plannedFor?: string; fromWishId?: string; productName?: string;
    photos?: string[]; reaction?: string; givenAt?: number; author?: string; now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const gift: BondGift = {
        dir: input.dir, state: input.state,
        ...(input.items?.length ? { items: input.items } : {}),
        ...(input.occasion?.trim() ? { occasion: input.occasion.trim() } : {}),
        ...(input.plannedFor ? { plannedFor: input.plannedFor } : {}),
        ...(input.fromWishId ? { fromWishId: input.fromWishId } : {}),
        ...(input.productName?.trim() ? { productName: input.productName.trim() } : {}),
        ...(input.photos?.length ? { photos: input.photos } : {}),
        ...(input.reaction?.trim() ? { reaction: input.reaction.trim() } : {}),
        ...(input.state === 'given' ? { givenAt: input.givenAt ?? now } : {}),
        ...(input.state === 'bought' ? { boughtAt: now } : {}),
    };
    return {
        id: newBondEntryId(), bondId: input.bondId, kind: 'gift', author: input.author || 'user',
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        text: input.text.trim(), eventDate: { precision: 'unknown' }, writtenAt: now,
        sources: [], links: [], status: 'published', createdBy: input.author && input.author !== 'user' ? 'ai' : 'user', updatedAt: now,
        gift,
    };
}

/** 購物中心商品頁的「打算送 TA」：照那件商品記一張打算送（買了照品名連回訂單） */
export function plannedGiftFromProduct(bondId: string, p: { name: string; price?: number; emoji?: string; shop?: string }, now = Date.now()): BondEntry {
    return newGift({
        bondId, dir: 'out', state: 'planned', title: p.name, text: p.name, productName: p.name,
        items: [{ name: p.name, price: p.price ?? 0, qty: 1, ...(p.emoji ? { emoji: p.emoji } : {}), ...(p.shop ? { shop: p.shop } : {}) }], now,
    });
}

/** 在訂單那件上第一次補東西：寫一張疊上去的卡 */
export function overlayForOrder(bondId: string, order: MallOrder, now = Date.now()): BondEntry {
    const dir = orderGiftDir(order) || 'out';
    const e = newGift({ bondId, dir, state: 'bought', text: titleOf(order.items, ''), items: order.items.map(i => ({ ...i })), now });
    return { ...e, gift: { ...e.gift!, orderId: order.id } };
}

export function patchGift(e: BondEntry, patch: Partial<BondGift>, now = Date.now()): BondEntry {
    return { ...e, gift: { ...e.gift!, ...patch }, updatedAt: now };
}

export function addFollowup(e: BondEntry, f: { by: string; text: string; source?: BondGiftFollowup['source'] }, now = Date.now()): BondEntry {
    const item: BondGiftFollowup = { id: `gf-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: now, by: f.by, text: f.text.trim(), ...(f.source ? { source: f.source } : {}) };
    return patchGift(e, { followups: [...(e.gift?.followups || []), item] }, now);
}

export function removeFollowup(e: BondEntry, id: string, now = Date.now()): BondEntry {
    return patchGift(e, { followups: (e.gift?.followups || []).filter(f => f.id !== id) }, now);
}

/** 手記的打算送／已買標成送出了 */
export function markGiven(e: BondEntry, now = Date.now()): BondEntry {
    return patchGift(e, { state: 'given', givenAt: now }, now);
}

// ─── 打算送連回訂單、TA 的打算揭曉 ─────────────────

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
/** 品名對得上：完全相同、去空白相同、或互相包含（跟購物中心對目錄同一個寬鬆度） */
export function nameMatches(a: string, b: string): boolean {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

/** 一張新的送禮單，對到哪一張還沒買的打算（你送的）或 TA 的打算（TA 送的）；回傳要改的卡 */
export function matchOrderToPlan(order: MallOrder, entries: BondEntry[], now = Date.now()): BondEntry | null {
    const dir = orderGiftDir(order);
    if (!dir) return null;
    const names = order.items.map(i => i.name);
    const cands = entries
        .filter(e => e.kind === 'gift' && e.gift && !e.gift.orderId && e.gift.dir === dir)
        .filter(e => (dir === 'out' ? e.gift!.state === 'planned' : !!e.gift!.secret && !e.gift!.secret.revealedAt))
        .filter(e => {
            const want = [e.gift!.productName, e.title, e.text, ...(e.gift!.items || []).map(i => i.name)].filter(Boolean) as string[];
            return want.some(w => names.some(n => nameMatches(w, n)));
        })
        .sort((a, b) => a.writtenAt - b.writtenAt);
    const hit = cands[0];
    if (!hit) return null;
    const g = hit.gift!;
    return patchGift(hit, {
        orderId: order.id, state: 'bought', boughtAt: order.paidAt || now,
        ...(g.secret ? { secret: { ...g.secret, revealedAt: order.paidAt || now } } : {}),
    }, now);
}

/** TA 的打算：記一件（同一時間最多 SECRET_MAX_OPEN 件；同一件不重複） */
export function newSecretPlan(input: { bondId: string; charId: string; what: string; when?: string; entries: BondEntry[]; now?: number }): BondEntry | null {
    const now = input.now ?? Date.now();
    const what = input.what.trim();
    if (!what) return null;
    const open = input.entries.filter(e => e.kind === 'gift' && e.gift?.secret && !e.gift.secret.revealedAt && now - e.gift.secret.plannedAt < SECRET_EXPIRE_MS);
    if (open.length >= SECRET_MAX_OPEN) return null;
    if (open.some(e => nameMatches(e.text, what))) return null;
    const e = newGift({ bondId: input.bondId, dir: 'in', state: 'planned', text: what, author: input.charId, now });
    return { ...e, gift: { ...e.gift!, secret: { plannedAt: now, ...(input.when?.trim() ? { when: input.when.trim() } : {}) } } };
}

/** 60 天沒送出的 TA 的打算：作廢（直接刪掉，你永遠不會知道） */
export function expiredSecretIds(entries: BondEntry[], now = Date.now()): string[] {
    return entries
        .filter(e => e.kind === 'gift' && e.gift?.secret && !e.gift.secret.revealedAt && now - e.gift.secret.plannedAt >= SECRET_EXPIRE_MS)
        .map(e => e.id);
}

/** 打算送：到那天前三天提醒（只提醒還沒買的） */
export function plansDueSoon(entries: BondEntry[], todayKey: string): BondEntry[] {
    const t = Date.parse(`${todayKey}T00:00:00`);
    return entries.filter(e => {
        const g = e.gift;
        if (e.kind !== 'gift' || !g || g.state !== 'planned' || g.dir !== 'out' || !g.plannedFor || g.orderId) return false;
        const d = Date.parse(`${g.plannedFor}T00:00:00`);
        return Number.isFinite(d) && d - t >= 0 && d - t <= 3 * DAY;
    });
}

// ─── 事件卡帶禮物（plans/bond-batch5.md 2.5） ────────────────

const SCENE_OCCASION: Array<{ re: RegExp; occasion: string }> = [
    { re: /生日/, occasion: '生日' },
    { re: /紀念|週年|周年|一週年|一年/, occasion: '紀念日' },
    { re: /道歉|和好|談開|好好談|修復/, occasion: '道歉' },
    { re: /節|聖誕|新年|情人/, occasion: '節日' },
];
const JEWELRY = /戒指|項鍊|項鏈|手鍊|手鏈|耳環|手環|胸針|飾品|首飾/;
const VOW = /求婚|告白|表白|訂婚|結婚|交往/;

/** 開演時預設帶的禮物：場合對得上的先、求婚告白帶飾品、其餘照新舊；最多 limit 件（你可以再勾掉） */
export function giftsForScene(views: GiftView[], card: { title: string; theme: string }, limit = 2): GiftView[] {
    const text = `${card.title} ${card.theme}`;
    const want = SCENE_OCCASION.find(o => o.re.test(text))?.occasion;
    const vow = VOW.test(text);
    return views
        .filter(v => !v.secret && v.state !== 'planned')
        .map(v => {
            const names = [v.title, ...v.items.map(i => i.name)].join(' ');
            const score = (want && v.occasion === want ? 2 : 0) + (vow && JEWELRY.test(names) ? 2 : 0) + (v.followups.length ? 0.5 : 0);
            return { v, score };
        })
        .sort((a, b) => b.score - a.score || b.v.at - a.v.at)
        .slice(0, limit)
        .map(x => x.v);
}

/** 一件禮物寫進情境的那一句（給角色看：「你」＝角色） */
export function giftSceneText(v: Pick<GiftView, 'dir' | 'title' | 'occasion'>, userName: string): string {
    const who = v.dir === 'out' ? `${userName}送你的` : `你送${userName}的`;
    return `${who}${v.title.replace(/\s+/g, ' ').slice(0, 30)}${v.occasion ? `（${v.occasion}）` : ''}`;
}

// ─── 圖樣 ──────────────────────────────────────────

export const GIFT_WRAPS = ['stripe', 'dots', 'kraft', 'check', 'solid'] as const;
export const GIFT_RIBBONS = ['wine', 'cream', 'moss', 'gold'] as const;
export type GiftWrap = typeof GIFT_WRAPS[number];
export type GiftRibbon = typeof GIFT_RIBBONS[number];

/** 每件照自己的 key 固定一款包裝（同一件永遠同一款） */
export function giftWrapFor(key: string): { wrap: GiftWrap; ribbon: GiftRibbon } {
    let h = 2166136261;
    for (const ch of key) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const n = h >>> 0;
    return { wrap: GIFT_WRAPS[n % GIFT_WRAPS.length], ribbon: GIFT_RIBBONS[Math.floor(n / 7) % GIFT_RIBBONS.length] };
}

// ─── 每日總結對禮物後續（第 6 節）─────────────────

/** 一次給 AI 對的圖鑑最多幾件（最近的先） */
export const SUMMARY_GIFT_LIMIT = 20;
/** 記得對過哪幾筆總結：留最近幾筆 */
export const SUMMARY_CHECKED_KEEP = 120;
/** 等你確認的最多留幾筆（舊的先丟） */
export const FOLLOWUP_PENDING_MAX = 12;

/** 能對的：已經送出去的（打算送的、還在路上的、TA 還沒揭曉的都不算） */
export function giftsForSummary(views: GiftView[]): GiftView[] {
    return views.filter(v => v.state === 'given' && !v.secret).slice(0, SUMMARY_GIFT_LIMIT);
}

export function buildGiftSummaryPrompt(args: { summary: string; date: string; gifts: Array<Pick<GiftView, 'title' | 'dir'>>; leftName: string; rightName: string }): string {
    const { leftName: L, rightName: R } = args;
    return [
        `下面是 ${L} 和 ${R} 某一天的總結，還有兩人之間送過的禮物。`,
        '看總結裡有沒有提到清單上哪一件禮物後來怎麼了（戴著、用著、帶去哪、壞了、收起來、又提起它…）。',
        '每件寫一句後來怎麼了（第三人稱、用名字，只寫總結裡有的，不補沒寫的事）。只是剛好說到同類的東西、對不上是哪一件的不要算。',
        '沒有就回空陣列。',
        '只輸出 JSON 陣列：[{"gift":"G1","text":"…"}]',
        '',
        '【禮物】',
        ...args.gifts.map((g, i) => `G${i + 1} ${g.dir === 'out' ? `${L}送給${R}` : `${R}送給${L}`}：${g.title}`),
        '',
        `【${args.date} 的總結】`,
        args.summary.trim(),
    ].join('\n');
}

/** 解析：G 編號換回那件；對不上的、沒寫內容的丟掉；同一件只留第一句 */
export function parseGiftSummary<T extends Pick<GiftView, 'key' | 'title'>>(raw: string, gifts: T[]): Array<{ gift: T; text: string }> {
    const s = String(raw || '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    let arr: unknown;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out: Array<{ gift: T; text: string }> = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const m = /^G?(\d+)$/i.exec(String(o.gift ?? '').trim());
        const gift = m ? gifts[Number(m[1]) - 1] : undefined;
        const text = String(o.text || '').trim().replace(/^["「『]|["」』]$/g, '');
        if (!gift || !text || out.some(x => x.gift.key === gift.key)) continue;
        out.push({ gift, text: text.slice(0, 160) });
    }
    return out;
}

/** 記下這筆總結對過了；有抓到的放進待確認（同一件同一句不重複，最多留幾筆） */
export function withGiftSummaryChecked(
    b: BondRecord, memoryId: string, found: Array<{ giftKey: string; giftTitle: string; text: string }>, date: string | undefined, now = Date.now(),
): BondRecord {
    const checked = Object.entries({ ...(b.giftSummaryChecked || {}), [memoryId]: now })
        .sort((x, y) => y[1] - x[1]).slice(0, SUMMARY_CHECKED_KEEP);
    const pending = [...(b.giftFollowupPending || [])];
    found.forEach((f, i) => {
        if (pending.some(p => p.giftKey === f.giftKey && p.text === f.text)) return;
        const item: BondGiftFollowupPending = {
            id: `gp-${now.toString(36)}-${i}`, giftKey: f.giftKey, giftTitle: f.giftTitle, text: f.text, memoryId, ...(date ? { date } : {}), at: now,
        };
        pending.push(item);
    });
    return { ...b, giftSummaryChecked: Object.fromEntries(checked), giftFollowupPending: pending.slice(-FOLLOWUP_PENDING_MAX), updatedAt: now };
}

export function dropGiftPending(b: BondRecord, id: string, now = Date.now()): BondRecord {
    return { ...b, giftFollowupPending: (b.giftFollowupPending || []).filter(p => p.id !== id), updatedAt: now };
}
