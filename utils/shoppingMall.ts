import type { MallCategory, MallKind, MallProduct } from '../types';

let idSeq = 0;
const makeId = (prefix: string): string => `${prefix}-${Date.now()}-${(idSeq++).toString(36)}`;

/**
 * 首次打开购物中心时给两套分类各自的默认起点，避免空空如也。用户可以在「管理」里
 * 随时改名/删除/新增——这些只是种子，不是写死的固定分类。
 */
export const DEFAULT_MALL_CATEGORIES: Record<MallKind, string[]> = {
    shop: ['可爱小物', '零食饮料', '生活用品', '礼物'],
    food: ['正餐', '甜品饮料', '小吃', '饮品'],
};

/** 种子商品，跟默认分类一一对应，纯粹让首次打开的购物中心不是空的。 */
const SEED_PRODUCTS: Record<MallKind, { category: string; name: string; price: number; emoji: string; detail: string }[]> = {
    shop: [
        { category: '可爱小物', name: '毛绒手机挂件', price: 19.9, emoji: '🧸', detail: '软乎乎的手机挂件，适合挂在角色手机旁边。' },
        { category: '零食饮料', name: '聊天能量补给盒', price: 36, emoji: '🍫', detail: '巧克力、饼干和小饮料的组合，适合深夜聊天。' },
        { category: '生活用品', name: '记忆手账本', price: 28, emoji: '📔', detail: '可以记录约定、日程、灵感和聊天里的小细节。' },
        { category: '礼物', name: '迷你花束', price: 45, emoji: '💐', detail: '一束小小的花，适合当作突然的惊喜。' },
        { category: '生活用品', name: '云朵眼罩', price: 25, emoji: '☁️', detail: '柔软遮光，适合提醒TA好好休息。' },
        { category: '礼物', name: '咖啡兑换券', price: 18, emoji: '☕', detail: '给TA换一杯醒神咖啡。' },
    ],
    food: [
        { category: '正餐', name: '简餐套餐', price: 32, emoji: '🍱', detail: '一荤一素加主食，饱腹不油腻。' },
        { category: '甜品饮料', name: '草莓小蛋糕', price: 23, emoji: '🍰', detail: '当季草莓做的小蛋糕，甜而不腻。' },
        { category: '小吃', name: '炸鸡拼盘', price: 29, emoji: '🍗', detail: '外酥里嫩，配一杯冰饮更好。' },
        { category: '饮品', name: '冰美式', price: 22, emoji: '🧋', detail: '提神必备，夏天冰镇更爽。' },
    ],
};

/** 按 kind 生成一套默认分类（带 order），供首次打开、且该 kind 还没有任何分类时用。 */
export function buildDefaultCategories(kind: MallKind): MallCategory[] {
    return DEFAULT_MALL_CATEGORIES[kind].map((name, index) => ({
        id: makeId('mallcat'),
        kind,
        name,
        order: index,
    }));
}

/** 按 kind + 已生成的默认分类，铺一批种子商品（分类名对不上的种子跳过，理论上不会发生）。 */
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
    return { id: makeId('mallcat'), kind, name: name.trim() || '未命名分类', order };
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

// ─── AI 补货：跟 apps/CheckPhone.tsx 的 handleGenerate 同一个骨架（context 由调用方拼，
// 这里只管纯文本的 prompt/防重复提示 + 解析结果落地），调用方负责 fetch + extractContent/
// extractJson，解析完的数组丢进 parseMallRestockItems 转成可以直接 saveMallProduct 的对象。───

/**
 * 防重复：把这个分类下已有的商品名喂回去，让 AI 这次刷新换一批新东西，而不是原地重复
 * （比如已经有一款"草莓小蛋糕"，这次别又刷一款换皮的"草莓慕斯"）。没有历史时返回空串。
 */
export function buildMallAntiRepeatNote(existingInCategory: MallProduct[]): string {
    if (existingInCategory.length === 0) return '';
    const names = existingInCategory.map(p => p.name).join('、');
    return `\n\n这个分类下已经有这些商品了，这次补货请换一批新的，别跟它们重复或换皮重名：${names}`;
}

export function buildMallRestockPrompt(kind: MallKind, categoryName: string, existingInCategory: MallProduct[], count = 4): string {
    const noun = kind === 'food' ? '外卖' : '购物';
    return `生成 ${count} 件「${categoryName}」分类下的${noun}商品，适合在情侣/朋友之间当${kind === 'food' ? '点单' : '送礼'}用的日常小商品，价格控制在合理区间（几元到几十元）。` +
        `${buildMallAntiRepeatNote(existingInCategory)}\n\n` +
        `**JSON 字段类型硬约束**：只能返回下面这个形状的 JSON 数组，"name"/"detail"/"emoji" 必须是字符串，"price" 必须是数字，不能是对象或数组：\n` +
        `[{ "name": "商品名", "price": 19.9, "emoji": "一个最能代表这个商品的 emoji", "detail": "一句简短说明，不超过20字" }, ...]`;
}

/** 把 AI 返回的松散 JSON 数组过滤/纠错成能直接 DB.saveMallProduct 的商品对象。 */
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

// ─── 购物车 / 外卖篮（纯计算，状态本身是 mini-app 里的临时 UI state，不落库）───

export interface MallCartLine {
    productId: string;
    qty: number;
}

/** 购物车行 + 商品详情拼在一起，UI 直接渲染用；商品被删掉后这行自动被过滤掉。 */
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
