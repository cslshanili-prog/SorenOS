import { describe, it, expect } from 'vitest';
import {
    buildDefaultCategories, buildSeedProducts, createMallCategory, createMallProduct,
    resolveCartLines, cartTotal, addToCart, removeFromCart, clearCartLine,
    DEFAULT_MALL_CATEGORIES, planMallCatalogUpgrade, searchMallProducts, pickDailyRecommendations, pickMallRecommendations, buildMallPicks, MALL_MIN_ROTATING, getMallPicksRound, isMallWishlistShared, setMallWishlistShared, bumpMallPicksRound, cartCount, productBlurb,
} from './shoppingMall';
import type { MallCategory, MallProduct } from '../types';

describe('buildDefaultCategories', () => {
    it('購物/外賣各自生成對應 kind 的分類，order 按數組順序遞增', () => {
        const shop = buildDefaultCategories('shop');
        expect(shop.map(c => c.name)).toEqual(DEFAULT_MALL_CATEGORIES.shop);
        expect(shop.every(c => c.kind === 'shop')).toBe(true);
        expect(shop.map(c => c.order)).toEqual(shop.map((_, i) => i));

        const food = buildDefaultCategories('food');
        expect(food.map(c => c.name)).toEqual(DEFAULT_MALL_CATEGORIES.food);
        expect(food.every(c => c.kind === 'food')).toBe(true);
    });

    it('兩次調用生成的分類 id 不同', () => {
        const a = buildDefaultCategories('shop');
        const b = buildDefaultCategories('shop');
        expect(a[0].id).not.toBe(b[0].id);
    });
});

describe('buildSeedProducts', () => {
    it('種子商品的 categoryId 都能在傳入的分類裡找到，且 kind 一致', () => {
        const categories = buildDefaultCategories('shop');
        const products = buildSeedProducts('shop', categories);
        expect(products.length).toBeGreaterThan(0);
        const catIds = new Set(categories.map(c => c.id));
        for (const p of products) {
            expect(catIds.has(p.categoryId)).toBe(true);
            expect(p.kind).toBe('shop');
        }
    });

    it('分類對不上時該條種子被跳過（不會崩，也不會產生懸空 categoryId）', () => {
        const products = buildSeedProducts('food', []);
        expect(products).toEqual([]);
    });
});

describe('createMallCategory / createMallProduct', () => {
    it('分類名去空白，空名兜底成"未命名分類"', () => {
        expect(createMallCategory('shop', '  新分類  ', 5).name).toBe('新分類');
        expect(createMallCategory('shop', '   ', 5).name).toBe('未命名分類');
    });

    it('商品價格非法（負數/NaN）時兜底成 0，emoji 缺省兜底', () => {
        const p1 = createMallProduct('food', 'cat-1', { name: '測試商品', price: -5 });
        expect(p1.price).toBe(0);
        expect(p1.emoji).toBe('🛍️');

        const p2 = createMallProduct('food', 'cat-1', { name: '測試商品', price: NaN });
        expect(p2.price).toBe(0);

        const p3 = createMallProduct('food', 'cat-1', { name: '測試商品', price: 18, emoji: '🍜', detail: '  ' });
        expect(p3.price).toBe(18);
        expect(p3.emoji).toBe('🍜');
        expect(p3.detail).toBeUndefined();
    });
});

describe('購物車純函數', () => {
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

    it('removeFromCart 減到 0 時整行消失，不留 qty=0 的行', () => {
        let cart = addToCart([], 'p1');
        cart = removeFromCart(cart, 'p1');
        expect(cart).toEqual([]);
    });

    it('clearCartLine 直接整行清掉，不管數量', () => {
        let cart = addToCart([], 'p1');
        cart = addToCart(cart, 'p1');
        cart = clearCartLine(cart, 'p1');
        expect(cart).toEqual([]);
    });

    it('resolveCartLines 過濾掉已被刪除的商品，不崩', () => {
        const cart = [{ productId: 'p1', qty: 2 }, { productId: 'missing', qty: 1 }];
        const lines = resolveCartLines(cart, products);
        expect(lines).toHaveLength(1);
        expect(lines[0].product.name).toBe('A');
    });

    it('cartTotal 按單價 * 數量求和', () => {
        const cart = [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }];
        expect(cartTotal(cart, products)).toBe(10 * 2 + 20 * 1);
    });

    it('cartTotal 空購物車為 0', () => {
        expect(cartTotal([], products)).toBe(0);
    });
});

describe('預設商品', () => {
    it('每個預設分類都有 3 件，價格是正數、有店鋪和說明', () => {
        for (const kind of ['food', 'shop'] as const) {
            const cats = buildDefaultCategories(kind);
            const prods = buildSeedProducts(kind, cats);
            for (const c of cats) {
                expect(prods.filter(p => p.categoryId === c.id)).toHaveLength(3);
            }
            for (const p of prods) {
                expect(p.price).toBeGreaterThan(0);
                expect(p.shop).toBeTruthy();
                expect(p.summary).toBeTruthy();
            }
        }
    });
});

describe('planMallCatalogUpgrade', () => {
    const cat = (id: string, kind: 'shop' | 'food', name: string, order = 0): MallCategory => ({ id, kind, name, order });
    const prod = (id: string, kind: 'shop' | 'food', categoryId: string, name: string): MallProduct =>
        ({ id, kind, categoryId, name, price: 1, emoji: '🛍️', createdAt: 0 });

    it('全新用戶：直接種一套新的', () => {
        const plan = planMallCatalogUpgrade([], []);
        expect(plan.deleteProductIds).toEqual([]);
        expect(plan.addCategories.filter(c => c.kind === 'food').map(c => c.name)).toEqual(DEFAULT_MALL_CATEGORIES.food);
        expect(plan.addCategories.filter(c => c.kind === 'shop').map(c => c.name)).toEqual(DEFAULT_MALL_CATEGORIES.shop);
        expect(plan.addProducts).toHaveLength((DEFAULT_MALL_CATEGORIES.food.length + DEFAULT_MALL_CATEGORIES.shop.length) * 3);
    });

    it('舊種子刪掉；舊分類裡還有用戶自己的東西就留著；空了才刪', () => {
        const cats = [cat('c1', 'food', '正餐'), cat('c2', 'food', '小吃', 1), cat('c3', 'shop', '我的收藏', 0)];
        const prods = [
            prod('p1', 'food', 'c1', '簡餐套餐'),       // 舊種子 → 刪
            prod('p2', 'food', 'c1', '我加的牛肉麵'),   // 用戶的 → 留，c1 也留
            prod('p3', 'food', 'c2', '炸雞拼盤'),       // 舊種子 → 刪，c2 空了 → 刪
            prod('p4', 'shop', 'c3', '毛絨手機掛件'),   // 名字一樣但分類不是舊的 → 不動
        ];
        const plan = planMallCatalogUpgrade(cats, prods);
        expect(plan.deleteProductIds.sort()).toEqual(['p1', 'p3']);
        expect(plan.deleteCategoryIds).toEqual(['c2']);
        // 新分類排在留下的分類後面
        const newFood = plan.addCategories.filter(c => c.kind === 'food');
        expect(Math.min(...newFood.map(c => c.order))).toBe(1);
    });

    it('已經有同名的新分類／商品就不重複種', () => {
        const cats = [cat('c1', 'food', '咖啡')];
        const prods = [prod('p1', 'food', 'c1', '燕麥拿鐵')];
        const plan = planMallCatalogUpgrade(cats, prods);
        expect(plan.addCategories.some(c => c.name === '咖啡')).toBe(false);
        expect(plan.addProducts.some(p => p.name === '燕麥拿鐵')).toBe(false);
        // 剩下兩件咖啡種子掛在既有的 c1 上
        expect(plan.addProducts.filter(p => p.categoryId === 'c1')).toHaveLength(2);
    });

    it('套用一次之後再跑，不會再刪或再加', () => {
        const first = planMallCatalogUpgrade([], []);
        const again = planMallCatalogUpgrade(first.addCategories, first.addProducts);
        expect(again).toEqual({ deleteProductIds: [], deleteCategoryIds: [], addCategories: [], addProducts: [] });
    });
});

describe('搜尋、推薦、小工具', () => {
    const base = { kind: 'food' as const, emoji: '☕', createdAt: 0, price: 5 };
    const items: MallProduct[] = [
        { ...base, id: 'a', categoryId: 'c1', name: '燕麥拿鐵', shop: 'Blue Bottle Coffee', summary: '雙份濃縮' },
        { ...base, id: 'b', categoryId: 'c1', name: '冷萃咖啡', shop: 'Starbucks' },
        { ...base, id: 'c', categoryId: 'c2', name: '起司蛋糕', detail: '紐約經典' },
        { ...base, id: 'd', categoryId: 'c2', name: '巧克力餅乾' },
        { ...base, id: 'e', categoryId: 'c3', name: '向日葵' },
    ];

    it('搜尋名稱、店鋪、說明、詳情，不分大小寫，多個詞都要中', () => {
        expect(searchMallProducts(items, 'starbucks').map(p => p.id)).toEqual(['b']);
        expect(searchMallProducts(items, '紐約').map(p => p.id)).toEqual(['c']);
        expect(searchMallProducts(items, 'blue 濃縮').map(p => p.id)).toEqual(['a']);
        expect(searchMallProducts(items, '  ')).toHaveLength(5);
    });

    it('推薦：同一天結果固定、分類輪流挑、不超過上限', () => {
        const a = pickDailyRecommendations(items, '2026-10-04', 3);
        const b = pickDailyRecommendations(items, '2026-10-04', 3);
        expect(a.map(p => p.id)).toEqual(b.map(p => p.id));
        expect(new Set(a.map(p => p.categoryId)).size).toBe(3);
        expect(pickDailyRecommendations(items, '2026-10-04', 99)).toHaveLength(5);
    });

    it('換一批：round 0 跟原本一樣、換了盡量全新、角色取前幾件是同一批的前綴', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `p${i}`, categoryId: `c${i % 6}`, name: `品${i}` }));
        const day = '2026-10-05';
        expect(pickMallRecommendations(many, day, 0).map(p => p.id)).toEqual(pickDailyRecommendations(many, day, 10).map(p => p.id));
        const r0 = pickMallRecommendations(many, day, 0);
        const r1 = pickMallRecommendations(many, day, 1);
        expect(r1).toHaveLength(10);
        expect(r1.filter(p => r0.some(q => q.id === p.id))).toHaveLength(0);
        expect(pickMallRecommendations(many, day, 1, 6).map(p => p.id)).toEqual(r1.slice(0, 6).map(p => p.id));
        // 商品不夠一整批新的：先放沒出現過的，再回頭補滿
        const r1few = pickMallRecommendations(many.slice(0, 12), day, 1);
        expect(r1few).toHaveLength(10);
        expect(new Set(r1few.map(p => p.id)).size).toBe(10);
    });

    it('📌 釘選：固定在前、不進輪換；輪換那段少幾件但至少留幾件', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `p${i}`, categoryId: `c${i % 6}`, name: `品${i}`, createdAt: i }));
        const withPins = many.map((p, i) => (i === 7 || i === 3 ? { ...p, pinned: true } : p));
        const day = '2026-10-06';
        const { pinned, rotating } = buildMallPicks(withPins, day, 0);
        expect(pinned.map(p => p.id)).toEqual(['p3', 'p7']);
        expect(rotating).toHaveLength(8);
        expect(rotating.some(p => p.pinned)).toBe(false);
        // 換一批時釘選的還在
        expect(buildMallPicks(withPins, day, 3).pinned.map(p => p.id)).toEqual(['p3', 'p7']);
        // 釘很多件：輪換至少留 MALL_MIN_ROTATING 件
        const lotsPinned = many.map((p, i) => (i < 12 ? { ...p, pinned: true } : p));
        expect(buildMallPicks(lotsPinned, day, 0).rotating).toHaveLength(MALL_MIN_ROTATING);
        // 沒釘就跟原本一樣
        expect(buildMallPicks(many, day, 0).rotating.map(p => p.id)).toEqual(pickMallRecommendations(many, day, 0).map(p => p.id));
    });

    it('願望清單開關：預設開、關掉記得住、再開清掉 key', () => {
        localStorage.removeItem('mall_wishlist_shared');
        expect(isMallWishlistShared()).toBe(true);
        setMallWishlistShared(false);
        expect(isMallWishlistShared()).toBe(false);
        setMallWishlistShared(true);
        expect(localStorage.getItem('mall_wishlist_shared')).toBeNull();
    });

    it('換一批次數：只算今天、購物外賣分開、換天歸零', () => {
        localStorage.removeItem('mall_picks_round');
        expect(getMallPicksRound('food', '2026-10-05')).toBe(0);
        expect(bumpMallPicksRound('food', '2026-10-05')).toBe(1);
        expect(bumpMallPicksRound('food', '2026-10-05')).toBe(2);
        expect(getMallPicksRound('shop', '2026-10-05')).toBe(0);
        expect(getMallPicksRound('food', '2026-10-06')).toBe(0);
        expect(bumpMallPicksRound('shop', '2026-10-06')).toBe(1);
        expect(getMallPicksRound('food', '2026-10-06')).toBe(0);
        localStorage.removeItem('mall_picks_round');
    });

    it('cartCount 加總數量；productBlurb 沒有說明就退回詳情', () => {
        expect(cartCount([{ productId: 'a', qty: 2 }, { productId: 'b', qty: 3 }])).toBe(5);
        expect(productBlurb(items[0])).toBe('雙份濃縮');
        expect(productBlurb(items[2])).toBe('紐約經典');
    });
});
