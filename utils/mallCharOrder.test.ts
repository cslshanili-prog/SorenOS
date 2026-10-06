import { describe, it, expect } from 'vitest';
import { buildMallPicksBlock, formatMallEta, mallRecordEta, matchCatalogProduct, resolveGiftOrders } from './mallCharOrder';
import type { MallCategory, MallProduct } from '../types';

const prod = (id: string, kind: 'food' | 'shop', name: string, price: number, extra: Partial<MallProduct> = {}): MallProduct =>
    ({ id, kind, categoryId: kind === 'food' ? 'cf' : 'cs', name, price, emoji: '☕', createdAt: 0, ...extra });
const catalog = [
    prod('a', 'food', '燕麥拿鐵', 6.5, { shop: 'Blue Bottle Coffee' }),
    prod('b', 'food', '冷萃咖啡', 5.25),
    prod('c', 'shop', 'AirPods Pro 2', 249, { emoji: '🎧' }),
];
const cats: MallCategory[] = [{ id: 'cf', kind: 'food', name: '咖啡', order: 0 }, { id: 'cs', kind: 'shop', name: '電腦電器', order: 0 }];

describe('matchCatalogProduct', () => {
    it('完全相同 → 去空白／大小寫 → 互相包含；太短不亂對', () => {
        expect(matchCatalogProduct('燕麥拿鐵', catalog)?.id).toBe('a');
        expect(matchCatalogProduct('airpods pro2', catalog)?.id).toBe('c');
        expect(matchCatalogProduct('一杯冷萃咖啡', catalog)?.id).toBe('b');
        expect(matchCatalogProduct('茶', catalog)).toBeNull();
        expect(matchCatalogProduct('燕麥拿鐵', catalog, 'shop')).toBeNull();
    });
});

describe('resolveGiftOrders', () => {
    it('按 kind 合單、同品項疊數量、留言去重拼接、沒價格又對不上的丟掉', () => {
        const orders = resolveGiftOrders([
            { kind: 'send', item: '燕麥拿鐵', note: '熱的' },
            { kind: 'send', item: '燕麥拿鐵', qty: 2, note: '熱的' },
            { kind: 'send', item: 'AirPods Pro 2', price: '1' },
            { kind: 'send', item: '神秘禮物' },
            { kind: 'send', item: '手寫卡片', mallKind: 'shop', price: '3' },
        ], catalog);
        expect(orders).toHaveLength(2);
        const food = orders.find(o => o.kind === 'food')!;
        expect(food.items).toEqual([{ name: '燕麥拿鐵', price: 6.5, qty: 3, emoji: '☕', shop: 'Blue Bottle Coffee' }]);
        expect(food.total).toBe(19.5);
        expect(food.note).toBe('熱的');
        const shop = orders.find(o => o.kind === 'shop')!;
        expect(shop.items.map(i => [i.name, i.price])).toEqual([['AirPods Pro 2', 249], ['手寫卡片', 3]]);
        expect(shop.items[1].emoji).toBe('🎁');
    });
});

describe('ETA', () => {
    const paid = new Date(2026, 9, 4, 14, 0).getTime();
    it('外賣 40 分鐘、購物隔天 14:00；沒開時區就是設備時間', () => {
        expect(mallRecordEta({ mallKind: 'food', status: 'sent', paidAt: paid }, undefined)).toBe('10/4 14:40');
        expect(mallRecordEta({ mallKind: 'shop', status: 'accepted' }, paid)).toBe('10/5 14:00');
    });
    it('還沒付、被拒的不帶', () => {
        expect(mallRecordEta({ mallKind: 'food', status: 'pending' }, paid)).toBeUndefined();
        expect(mallRecordEta({ mallKind: 'food', status: 'declined' }, paid)).toBeUndefined();
        expect(mallRecordEta(undefined, paid)).toBeUndefined();
    });
    it('按角色時區寫', () => {
        const utcNoon = Date.UTC(2026, 9, 4, 12, 0);
        expect(formatMallEta(utcNoon, 'Asia/Taipei')).toBe('10/4 20:00');
        expect(formatMallEta(utcNoon, 'America/New_York')).toBe('10/4 08:00');
    });
});

describe('buildMallPicksBlock', () => {
    it('外賣、購物各列幾樣，帶店鋪和價格；分類刪掉的不算；空目錄整段不給', () => {
        const block = buildMallPicksBlock(catalog, cats, 6, '2026-10-04');
        expect(block).toContain('### 購物中心 · 今天的推薦');
        expect(block).toContain('燕麥拿鐵（Blue Bottle Coffee）$6.50');
        expect(block).toContain('購物（kind=shop）：AirPods Pro 2$249.00');
        expect(buildMallPicksBlock(catalog, [cats[1]], 6, '2026-10-04')).not.toContain('外賣');
        expect(buildMallPicksBlock([], cats)).toBe('');
    });

    it('願望清單：開著就列出收藏的、關掉不列；只有收藏也會給這一段', () => {
        const withFav = catalog.map(p => (p.id === 'c' ? { ...p, favorite: true } : p));
        const shared = buildMallPicksBlock(withFav, cats, 6, '2026-10-06', true);
        expect(shared).toContain('對方的願望清單');
        expect(shared).toContain('- 購物（kind=shop）：AirPods Pro 2$249.00');
        expect(buildMallPicksBlock(withFav, cats, 6, '2026-10-06', false)).not.toContain('願望清單');
        expect(buildMallPicksBlock(catalog, cats, 6, '2026-10-06', true)).not.toContain('願望清單');
    });

    it('📌 釘選的一定給、排在最前面，就算超出每類件數', () => {
        const many = Array.from({ length: 12 }, (_, i) => prod(`f${i}`, 'food', `外賣${i}`, 10 + i));
        const pinnedLast = { ...many[11], pinned: true };
        const block = buildMallPicksBlock([...many.slice(0, 11), pinnedLast], [cats[0]], 3, '2026-10-06');
        const foodLine = block.split('\n').find(l => l.startsWith('外賣（kind=food）'))!;
        expect(foodLine.startsWith('外賣（kind=food）：外賣11')).toBe(true);
        expect(foodLine.split('、')).toHaveLength(3);
    });
});
