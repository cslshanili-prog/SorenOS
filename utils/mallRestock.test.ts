import { describe, it, expect } from 'vitest';
import { buildMallRestockPrompt, parseMallRestockBlocks, parsePrice, matchCategory } from './mallRestock';
import type { MallCategory, MallProduct } from '../types';

const cats: MallCategory[] = [
    { id: 'c1', kind: 'food', name: '咖啡', order: 0 },
    { id: 'c2', kind: 'food', name: '甜點', order: 1 },
    { id: 'c3', kind: 'shop', name: '電腦電器', order: 0 },
];

describe('buildMallRestockPrompt', () => {
    it('帶上分類名、範圍說明、已有商品和格式', () => {
        const prompt = buildMallRestockPrompt('food', [
            { category: cats[0], existingNames: ['燕麥拿鐵'] },
            { category: cats[1], existingNames: [] },
        ]);
        expect(prompt).toContain('外賣');
        expect(prompt).toContain('  - 咖啡：拿鐵');
        expect(prompt).toContain('2 個分類');
        expect(prompt).toContain('燕麥拿鐵');
        expect(prompt).toContain('[圖標]');
        expect(prompt).toContain('美元');
        expect(prompt).toContain('3 到 6');
    });

    it('分類多的時候每類少一點', () => {
        const many = Array.from({ length: 6 }, (_, i) => ({ category: { id: `x${i}`, kind: 'shop' as const, name: `分類${i}`, order: i }, existingNames: [] }));
        expect(buildMallRestockPrompt('shop', many)).toContain('3 到 4');
    });
});

describe('parseMallRestockBlocks', () => {
    const text = `\`\`\`
#推薦1
[分類]咖啡
[名稱]西西里檸檬冰咖啡
[店鋪]Blue Bottle Coffee
[價格]$7.25
[說明]檸檬汁加濃縮
[詳情]冰塊、濃縮和西西里檸檬汁，12oz。
[圖標]🍋

#推荐2
[分类]甜点
[名称]肉桂捲
[店铺]Cinnabon
[价格]5.49 美元
[说明]現烤
[详情]糖霜肉桂捲。
[图标]🥐
[分類]甜點
[名稱]沒有價格的蛋糕
[價格]問店員
[分類]不存在的分類
[名稱]孤兒
[價格]3
[分類]咖啡
[名稱]燕麥拿鐵
[價格]6
\`\`\``;

    it('塊格式簡繁都收、對分類、去重、丟掉壞條目', () => {
        const existing: MallProduct[] = [{ id: 'p', kind: 'food', categoryId: 'c1', name: '燕麥拿鐵', price: 6, emoji: '☕', createdAt: 0 }];
        const out = parseMallRestockBlocks(text, 'food', cats, existing);
        expect(out.map(p => p.name)).toEqual(['西西里檸檬冰咖啡', '肉桂捲']);
        expect(out[0]).toMatchObject({ categoryId: 'c1', price: 7.25, shop: 'Blue Bottle Coffee', summary: '檸檬汁加濃縮', emoji: '🍋', kind: 'food' });
        expect(out[1]).toMatchObject({ categoryId: 'c2', price: 5.49, shop: 'Cinnabon' });
    });

    it('別的 kind 的分類不算', () => {
        expect(parseMallRestockBlocks('[分類]電腦電器\n[名稱]鍵盤\n[價格]99', 'food', cats)).toEqual([]);
    });

    it('空輸入不崩', () => {
        expect(parseMallRestockBlocks('', 'food', cats)).toEqual([]);
    });
});

describe('小工具', () => {
    it('parsePrice', () => {
        expect(parsePrice('$1,299.00')).toBe(1299);
        expect(parsePrice('US$8')).toBe(8);
        expect(Number.isNaN(parsePrice('免費'))).toBe(true);
    });

    it('matchCategory：完全相同 → 去空白 → 互相包含', () => {
        expect(matchCategory('咖啡', cats)?.id).toBe('c1');
        expect(matchCategory(' 甜 點 ', cats)?.id).toBe('c2');
        expect(matchCategory('電腦電器類', cats)?.id).toBe('c3');
        expect(matchCategory('', cats)).toBeNull();
    });
});
