import { describe, it, expect } from 'vitest';
import {
    buildDefaultCategories, buildSeedProducts, createMallCategory, createMallProduct,
    resolveCartLines, cartTotal, addToCart, removeFromCart, clearCartLine,
    DEFAULT_MALL_CATEGORIES, buildMallAntiRepeatNote, buildMallRestockPrompt, parseMallRestockItems,
} from './shoppingMall';

describe('buildDefaultCategories', () => {
    it('购物/外卖各自生成对应 kind 的分类，order 按数组顺序递增', () => {
        const shop = buildDefaultCategories('shop');
        expect(shop.map(c => c.name)).toEqual(DEFAULT_MALL_CATEGORIES.shop);
        expect(shop.every(c => c.kind === 'shop')).toBe(true);
        expect(shop.map(c => c.order)).toEqual(shop.map((_, i) => i));

        const food = buildDefaultCategories('food');
        expect(food.map(c => c.name)).toEqual(DEFAULT_MALL_CATEGORIES.food);
        expect(food.every(c => c.kind === 'food')).toBe(true);
    });

    it('两次调用生成的分类 id 不同', () => {
        const a = buildDefaultCategories('shop');
        const b = buildDefaultCategories('shop');
        expect(a[0].id).not.toBe(b[0].id);
    });
});

describe('buildSeedProducts', () => {
    it('种子商品的 categoryId 都能在传入的分类里找到，且 kind 一致', () => {
        const categories = buildDefaultCategories('shop');
        const products = buildSeedProducts('shop', categories);
        expect(products.length).toBeGreaterThan(0);
        const catIds = new Set(categories.map(c => c.id));
        for (const p of products) {
            expect(catIds.has(p.categoryId)).toBe(true);
            expect(p.kind).toBe('shop');
        }
    });

    it('分类对不上时该条种子被跳过（不会崩，也不会产生悬空 categoryId）', () => {
        const products = buildSeedProducts('food', []);
        expect(products).toEqual([]);
    });
});

describe('createMallCategory / createMallProduct', () => {
    it('分类名去空白，空名兜底成"未命名分类"', () => {
        expect(createMallCategory('shop', '  新分类  ', 5).name).toBe('新分类');
        expect(createMallCategory('shop', '   ', 5).name).toBe('未命名分类');
    });

    it('商品价格非法（负数/NaN）时兜底成 0，emoji 缺省兜底', () => {
        const p1 = createMallProduct('food', 'cat-1', { name: '测试商品', price: -5 });
        expect(p1.price).toBe(0);
        expect(p1.emoji).toBe('🛍️');

        const p2 = createMallProduct('food', 'cat-1', { name: '测试商品', price: NaN });
        expect(p2.price).toBe(0);

        const p3 = createMallProduct('food', 'cat-1', { name: '测试商品', price: 18, emoji: '🍜', detail: '  ' });
        expect(p3.price).toBe(18);
        expect(p3.emoji).toBe('🍜');
        expect(p3.detail).toBeUndefined();
    });
});

describe('购物车纯函数', () => {
    const products = [
        { id: 'p1', kind: 'shop' as const, categoryId: 'c1', name: 'A', price: 10, emoji: '🧸', createdAt: 0 },
        { id: 'p2', kind: 'shop' as const, categoryId: 'c1', name: 'B', price: 20, emoji: '🍫', createdAt: 0 },
    ];

    it('addToCart 首次加入 qty=1，再次加入同一商品 qty+1', () => {
        let cart = addToCart([], 'p1');
        expect(cart).toEqual([{ productId: 'p1', qty: 1 }]);
        cart = addToCart(cart, 'p1');
        expect(cart).toEqual([{ productId: 'p1', qty: 2 }]);
    });

    it('removeFromCart 减到 0 时整行消失，不留 qty=0 的行', () => {
        let cart = addToCart([], 'p1');
        cart = removeFromCart(cart, 'p1');
        expect(cart).toEqual([]);
    });

    it('clearCartLine 直接整行清掉，不管数量', () => {
        let cart = addToCart([], 'p1');
        cart = addToCart(cart, 'p1');
        cart = clearCartLine(cart, 'p1');
        expect(cart).toEqual([]);
    });

    it('resolveCartLines 过滤掉已被删除的商品，不崩', () => {
        const cart = [{ productId: 'p1', qty: 2 }, { productId: 'missing', qty: 1 }];
        const lines = resolveCartLines(cart, products);
        expect(lines).toHaveLength(1);
        expect(lines[0].product.name).toBe('A');
    });

    it('cartTotal 按单价 * 数量求和', () => {
        const cart = [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }];
        expect(cartTotal(cart, products)).toBe(10 * 2 + 20 * 1);
    });

    it('cartTotal 空购物车为 0', () => {
        expect(cartTotal([], products)).toBe(0);
    });
});

describe('AI 补货：防重复提示 / prompt / 结果解析', () => {
    const existing: any[] = [
        { id: 'p1', kind: 'shop', categoryId: 'c1', name: '草莓小蛋糕', price: 23, emoji: '🍰', createdAt: 0 },
    ];

    it('buildMallAntiRepeatNote 没有已有商品时返回空串', () => {
        expect(buildMallAntiRepeatNote([])).toBe('');
    });

    it('buildMallAntiRepeatNote 把已有商品名拼进提示', () => {
        expect(buildMallAntiRepeatNote(existing)).toContain('草莓小蛋糕');
    });

    it('buildMallRestockPrompt 带上分类名、kind 对应的用途词、防重复提示和字段约束', () => {
        const prompt = buildMallRestockPrompt('food', '甜品饮料', existing, 3);
        expect(prompt).toContain('甜品饮料');
        expect(prompt).toContain('外卖');
        expect(prompt).toContain('草莓小蛋糕');
        expect(prompt).toContain('"price"');
    });

    it('parseMallRestockItems 过滤掉没有 name 的条目，price 非数字时兜底成 0', () => {
        const items = parseMallRestockItems('shop', 'cat-1', [
            { name: '手写卡片', price: 12, emoji: '💌', detail: '一张手写的小卡片' },
            { name: '', price: 10 }, // 没 name，跳过
            { name: '无价商品', price: 'abc' }, // price 解析不出来，兜底 0
            null, // 非对象，跳过
        ]);
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ name: '手写卡片', price: 12, emoji: '💌', categoryId: 'cat-1', kind: 'shop' });
        expect(items[1]).toMatchObject({ name: '无价商品', price: 0 });
    });

    it('parseMallRestockItems 非数组输入返回空数组，不崩', () => {
        expect(parseMallRestockItems('shop', 'cat-1', null)).toEqual([]);
        expect(parseMallRestockItems('shop', 'cat-1', { foo: 'bar' })).toEqual([]);
    });
});
