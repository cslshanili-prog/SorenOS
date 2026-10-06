import type { MallCategory, MallKind, MallProduct } from '../types';
import type { MallOrderAiEvent } from './mallOrderFormat';
import { mallOrderProgress } from './mallOrders';
import { buildMallPicks, getMallPicksRound, isMallWishlistShared, localDateKey } from './shoppingMall';
import { formatMoney } from './realBalance';
import { nowInTimeZone } from './timezone';

/**
 * 角色那一側的購物中心（2026-10 第二批，見 plans/mall-redesign.md）：
 * - 角色寫的 `[[ACTION:GIFT…]]` 對上目錄、合成一張單（resolveGiftOrders）
 * - 歷史記錄行裡的預計送達時間，按角色時區寫（mallRecordEta）
 * - 私聊易變段的「今天的推薦」，跟購物中心 Home 的「推薦」同一批（buildMallPicksBlock）
 */

export interface CharGiftLine {
    name: string;
    price: number;
    qty: number;
    emoji: string;
    shop?: string;
}

export interface CharGiftOrder {
    kind: MallKind;
    items: CharGiftLine[];
    total: number;
    note?: string;
}

const norm = (s: string) => s.replace(/[\s　·・\-_]/g, '').toLowerCase();

/** 角色寫的品名對目錄：完全相同 → 去空白相同 → 互相包含（至少兩個字，免得「茶」對上一堆）。 */
export function matchCatalogProduct(name: string, catalog: MallProduct[], kind?: MallKind): MallProduct | null {
    const pool = kind ? catalog.filter(p => p.kind === kind) : catalog;
    const raw = name.trim();
    if (!raw) return null;
    const exact = pool.find(p => p.name === raw);
    if (exact) return exact;
    const n = norm(raw);
    const same = pool.find(p => norm(p.name) === n);
    if (same) return same;
    if (n.length < 2) return null;
    return pool.find(p => {
        const pn = norm(p.name);
        return pn.length >= 2 && (pn.includes(n) || n.includes(pn));
    }) ?? null;
}

/**
 * 一則回覆裡的 GIFT 事件 → 每個 kind 一張單。對得上目錄的照目錄的價格、emoji、店鋪；
 * 對不上又沒寫價格的丟掉（不知道要扣多少）。沒寫 kind 又對不上目錄的算購物。
 */
export function resolveGiftOrders(events: MallOrderAiEvent[], catalog: MallProduct[]): CharGiftOrder[] {
    const byKind = new Map<MallKind, { items: CharGiftLine[]; notes: string[] }>();
    for (const ev of events) {
        if (ev.kind !== 'send') continue;
        const product = matchCatalogProduct(ev.item, catalog, ev.mallKind) ?? (ev.mallKind ? matchCatalogProduct(ev.item, catalog) : null);
        const kind: MallKind = ev.mallKind ?? product?.kind ?? 'shop';
        const given = ev.price != null ? parseFloat(ev.price) : NaN;
        const price = product ? product.price : given;
        if (!Number.isFinite(price) || price <= 0) {
            console.warn('[Mall] 角色送的東西對不上目錄、也沒寫價格，略過:', ev.item);
            continue;
        }
        const qty = ev.qty ?? 1;
        const bucket = byKind.get(kind) ?? { items: [], notes: [] };
        const name = product?.name ?? ev.item;
        const existing = bucket.items.find(i => i.name === name && i.price === price);
        if (existing) existing.qty += qty;
        else bucket.items.push({ name, price, qty, emoji: product?.emoji || (kind === 'food' ? '🍽️' : '🎁'), shop: product?.shop });
        const note = ev.note?.trim();
        if (note && !bucket.notes.includes(note)) bucket.notes.push(note);
        byKind.set(kind, bucket);
    }
    return [...byKind.entries()].map(([kind, b]) => ({
        kind,
        items: b.items,
        total: Math.round(b.items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100,
        note: b.notes.length ? b.notes.join(' ') : undefined,
    }));
}

/** 「10/4 14:40」，按角色時區（沒開時區就是設備時間）。 */
export function formatMallEta(ts: number, tz?: string): string {
    const d = nowInTimeZone(tz, new Date(ts));
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 歷史記錄行的 eta：從卡片 metadata 算預計送達時間。代付還沒付、被拒的不帶。
 * 給的是絕對時間，不是「配送中」這種狀態——主動消息的模板會先打好、到點才發，狀態到時候早就過期了。
 */
export function mallRecordEta(
    meta: { mallKind?: string; status?: string; paidAt?: number } | undefined,
    messageTimestamp: number | undefined,
    tz?: string,
): string | undefined {
    if (!meta) return undefined;
    if (meta.status === 'pending' || meta.status === 'declined') return undefined;
    const paidAt = meta.paidAt ?? messageTimestamp;
    if (!paidAt) return undefined;
    const p = mallOrderProgress({ kind: meta.mallKind === 'food' ? 'food' : 'shop', paidAt });
    return p.deliveredAt ? formatMallEta(p.deliveredAt, tz) : undefined;
}

const pickLine = (p: MallProduct) => `${p.name}${p.shop ? `（${p.shop}）` : ''}${formatMoney(p.price)}`;

/**
 * 私聊易變段「今天的推薦」：外賣、購物各幾樣，跟購物中心 Home 的「推薦」同一批（同一天同一個結果，按過 ↻ 就跟著換）。
 * 分類被刪掉的商品不算（購物中心裡也看不到）。目錄是空的就整段不給。
 */
const MAX_PINNED_FOR_CHAR = 10;
/** 願望清單每類最多列幾件（照收藏的先後，最新的在前） */
const MAX_WISHLIST_FOR_CHAR = 8;

/**
 * 另外：用戶開著「讓角色看到收藏」時（預設開），多一行「對方的願望清單」——用戶收藏的商品，
 * 角色送禮可以從這裡挑。wishlistShared 只給單測傳，平常讀 localStorage。
 */
export function buildMallPicksBlock(
    products: MallProduct[],
    categories: MallCategory[],
    perKind = 6,
    dateKey: string = localDateKey(),
    wishlistShared: boolean = isMallWishlistShared(),
): string {
    const liveCats = new Set(categories.map(c => c.id));
    const live = products.filter(p => liveCats.has(p.categoryId));
    const picksFor = (kind: MallKind): MallProduct[] => {
        const { pinned, rotating } = buildMallPicks(live.filter(p => p.kind === kind), dateKey, getMallPicksRound(kind, dateKey));
        // 📌 釘選的一定給（最多 MAX_PINNED_FOR_CHAR 件，免得提示詞被撐爆），輪換的補到 perKind 件
        const keep = pinned.slice(0, MAX_PINNED_FOR_CHAR);
        return [...keep, ...rotating.slice(0, Math.max(0, perKind - keep.length))];
    };
    const food = picksFor('food');
    const shop = picksFor('shop');
    const wishFor = (kind: MallKind): MallProduct[] => wishlistShared
        ? live.filter(p => p.kind === kind && p.favorite).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_WISHLIST_FOR_CHAR)
        : [];
    const wishFood = wishFor('food');
    const wishShop = wishFor('shop');
    if (food.length === 0 && shop.length === 0 && wishFood.length === 0 && wishShop.length === 0) return '';
    const lines = ['', '### 購物中心 · 今天的推薦'];
    if (food.length) lines.push(`外賣（kind=food）：${food.map(pickLine).join('、')}`);
    if (shop.length) lines.push(`購物（kind=shop）：${shop.map(pickLine).join('、')}`);
    if (wishFood.length || wishShop.length) {
        lines.push('對方的願望清單（對方在購物中心收藏的，想要但不一定買了；送禮時可以從這裡挑，不用每次都送）：');
        if (wishFood.length) lines.push(`- 外賣（kind=food）：${wishFood.map(pickLine).join('、')}`);
        if (wishShop.length) lines.push(`- 購物（kind=shop）：${wishShop.map(pickLine).join('、')}`);
    }
    lines.push('清單外的也能點，價格照美國日常行情寫。怎麼下單見「可用動作」裡的 GIFT。', '');
    return lines.join('\n');
}
