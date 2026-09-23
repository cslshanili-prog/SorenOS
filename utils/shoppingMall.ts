import type { MallCategory, MallKind, MallProduct } from '../types';

let idSeq = 0;
const makeId = (prefix: string): string => `${prefix}-${Date.now()}-${(idSeq++).toString(36)}`;

/**
 * 首次打開購物中心時給兩套分類各自的默認起點，避免空空如也。用戶可以在「管理」裡
 * 隨時改名/刪除/新增——這些只是種子，不是寫死的固定分類。
 */
export const DEFAULT_MALL_CATEGORIES: Record<MallKind, string[]> = {
    shop: ['可愛小物', '零食飲料', '生活用品', '禮物'],
    food: ['正餐', '甜品飲料', '小吃', '飲品'],
};

/** 種子商品，跟默認分類一一對應，純粹讓首次打開的購物中心不是空的。 */
const SEED_PRODUCTS: Record<MallKind, { category: string; name: string; price: number; emoji: string; detail: string }[]> = {
    shop: [
        { category: '可愛小物', name: '毛絨手機掛件', price: 19.9, emoji: '🧸', detail: '軟乎乎的手機掛件，適合掛在角色手機旁邊。' },
        { category: '零食飲料', name: '聊天能量補給盒', price: 36, emoji: '🍫', detail: '巧克力、餅乾和小飲料的組合，適合深夜聊天。' },
        { category: '生活用品', name: '記憶手帳本', price: 28, emoji: '📔', detail: '可以記錄約定、日程、靈感和聊天裡的小細節。' },
        { category: '禮物', name: '迷你花束', price: 45, emoji: '💐', detail: '一束小小的花，適合當作突然的驚喜。' },
        { category: '生活用品', name: '雲朵眼罩', price: 25, emoji: '☁️', detail: '柔軟遮光，適合提醒TA好好休息。' },
        { category: '禮物', name: '咖啡兌換券', price: 18, emoji: '☕', detail: '給TA換一杯醒神咖啡。' },
    ],
    food: [
        { category: '正餐', name: '簡餐套餐', price: 32, emoji: '🍱', detail: '一葷一素加主食，飽腹不油膩。' },
        { category: '甜品飲料', name: '草莓小蛋糕', price: 23, emoji: '🍰', detail: '當季草莓做的小蛋糕，甜而不膩。' },
        { category: '小吃', name: '炸雞拼盤', price: 29, emoji: '🍗', detail: '外酥裡嫩，配一杯冰飲更好。' },
        { category: '飲品', name: '冰美式', price: 22, emoji: '🧋', detail: '提神必備，夏天冰鎮更爽。' },
    ],
};

/** 按 kind 生成一套默認分類（帶 order），供首次打開、且該 kind 還沒有任何分類時用。 */
export function buildDefaultCategories(kind: MallKind): MallCategory[] {
    return DEFAULT_MALL_CATEGORIES[kind].map((name, index) => ({
        id: makeId('mallcat'),
        kind,
        name,
        order: index,
    }));
}

/** 按 kind + 已生成的默認分類，鋪一批種子商品（分類名對不上的種子跳過，理論上不會發生）。 */
export function buildSeedProducts(kind: MallKind, categories: MallCategory[]): MallProduct[] {
    const byName = new Map(categories.map(c => [c.name, c] as const));
    const now = Date.now();
    return SEED_PRODUCTS[kind]
        .map(seed => {
            const cat = byName.get(seed.category);
            if (!cat) return null;
            const product: MallProduct = {
                id: makeId('mallprod'),
                kind,
                categoryId: cat.id,
                name: seed.name,
                price: seed.price,
                emoji: seed.emoji,
                detail: seed.detail,
                createdAt: now,
            };
            return product;
        })
        .filter((p): p is MallProduct => p !== null);
}

export function createMallCategory(kind: MallKind, name: string, order: number): MallCategory {
    return { id: makeId('mallcat'), kind, name: name.trim() || '未命名分類', order };
}

export function createMallProduct(kind: MallKind, categoryId: string, input: { name: string; price: number; emoji?: string; detail?: string }): MallProduct {
    return {
        id: makeId('mallprod'),
        kind,
        categoryId,
        name: input.name.trim() || '未命名商品',
        price: Number.isFinite(input.price) && input.price >= 0 ? input.price : 0,
        emoji: input.emoji?.trim() || '🛍️',
        detail: input.detail?.trim() || undefined,
        createdAt: Date.now(),
    };
}

// ─── AI 補貨：跟 apps/CheckPhone.tsx 的 handleGenerate 同一個骨架（context 由調用方拼，
// 這裡只管純文本的 prompt/防重複提示 + 解析結果落地），調用方負責 fetch + extractContent/
// extractJson，解析完的數組丟進 parseMallRestockItems 轉成可以直接 saveMallProduct 的對象。───

/**
 * 防重複：把這個分類下已有的商品名喂回去，讓 AI 這次刷新換一批新東西，而不是原地重複
 * （比如已經有一款"草莓小蛋糕"，這次別又刷一款換皮的"草莓慕斯"）。沒有歷史時返回空串。
 */
export function buildMallAntiRepeatNote(existingInCategory: MallProduct[]): string {
    if (existingInCategory.length === 0) return '';
    const names = existingInCategory.map(p => p.name).join('、');
    return `\n\n這個分類下已經有這些商品了，這次補貨請換一批新的，別跟它們重複或換皮重名：${names}`;
}

export function buildMallRestockPrompt(kind: MallKind, categoryName: string, existingInCategory: MallProduct[], count = 4): string {
    const noun = kind === 'food' ? '外賣' : '購物';
    return `生成 ${count} 件「${categoryName}」分類下的${noun}商品，適合在情侶/朋友之間當${kind === 'food' ? '點單' : '送禮'}用的日常小商品，價格控制在合理區間（幾元到幾十元）。` +
        `${buildMallAntiRepeatNote(existingInCategory)}\n\n` +
        `**JSON 字段類型硬約束**：只能返回下面這個形狀的 JSON 數組，"name"/"detail"/"emoji" 必須是字符串，"price" 必須是數字，不能是對象或數組：\n` +
        `[{ "name": "商品名", "price": 19.9, "emoji": "一個最能代表這個商品的 emoji", "detail": "一句簡短說明，不超過20字" }, ...]`;
}

/** 把 AI 返回的鬆散 JSON 數組過濾/糾錯成能直接 DB.saveMallProduct 的商品對象。 */
export function parseMallRestockItems(kind: MallKind, categoryId: string, json: unknown): MallProduct[] {
    if (!Array.isArray(json)) return [];
    const out: MallProduct[] = [];
    for (const item of json) {
        if (!item || typeof item !== 'object') continue;
        const name = String((item as any).name ?? '').trim();
        if (!name) continue;
        const rawPrice = (item as any).price;
        const price = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice ?? '')) || 0;
        out.push(createMallProduct(kind, categoryId, {
            name,
            price,
            emoji: typeof (item as any).emoji === 'string' ? (item as any).emoji : undefined,
            detail: typeof (item as any).detail === 'string' ? (item as any).detail : undefined,
        }));
    }
    return out;
}

// ─── 購物車 / 外賣籃（純計算，狀態本身是 mini-app 裡的臨時 UI state，不落庫）───

export interface MallCartLine {
    productId: string;
    qty: number;
}

/** 購物車行 + 商品詳情拼在一起，UI 直接渲染用；商品被刪掉後這行自動被過濾掉。 */
export function resolveCartLines(cart: MallCartLine[], products: MallProduct[]): (MallCartLine & { product: MallProduct })[] {
    const byId = new Map(products.map(p => [p.id, p] as const));
    return cart
        .map(line => {
            const product = byId.get(line.productId);
            return product ? { ...line, product } : null;
        })
        .filter((l): l is MallCartLine & { product: MallProduct } => l !== null);
}

export function cartTotal(cart: MallCartLine[], products: MallProduct[]): number {
    return resolveCartLines(cart, products).reduce((sum, l) => sum + l.product.price * l.qty, 0);
}

export function addToCart(cart: MallCartLine[], productId: string): MallCartLine[] {
    const existing = cart.find(l => l.productId === productId);
    if (existing) return cart.map(l => l.productId === productId ? { ...l, qty: l.qty + 1 } : l);
    return [...cart, { productId, qty: 1 }];
}

export function removeFromCart(cart: MallCartLine[], productId: string): MallCartLine[] {
    return cart
        .map(l => l.productId === productId ? { ...l, qty: l.qty - 1 } : l)
        .filter(l => l.qty > 0);
}

export function clearCartLine(cart: MallCartLine[], productId: string): MallCartLine[] {
    return cart.filter(l => l.productId !== productId);
}
