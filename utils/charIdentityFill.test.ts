import { describe, expect, it } from 'vitest';
import { applyIdentityFill, buildIdentityFillPrompt, hasIdentityFillSource, parseIdentityFill } from './charIdentityFill';

describe('AI 幫我填：解析', () => {
    it('正常的 JSON', () => {
        expect(parseIdentityFill('{"aliases":["Vivian","陸姐"],"roleTitle":"Cos 圈的前輩","brief":"嘴甜心硬"}', '陸薇寧'))
            .toEqual({ aliases: ['Vivian', '陸姐'], roleTitle: 'Cos 圈的前輩', brief: '嘴甜心硬' });
    });
    it('前後有字、包在程式碼塊、別名給成一串字也撈得到；名字本身和重複的丟掉', () => {
        const raw = '好的，這是結果：\n```json\n{"aliases":"陸薇寧、Vivian，vivian","role":"「攝影師」","description":"  話少 "}\n```';
        expect(parseIdentityFill(raw, '陸薇寧')).toEqual({ aliases: ['Vivian'], roleTitle: '攝影師', brief: '話少' });
    });
    it('三樣都空、不是 JSON：回 null', () => {
        expect(parseIdentityFill('{"aliases":[],"roleTitle":"","brief":""}')).toBeNull();
        expect(parseIdentityFill('我讀不出來')).toBeNull();
        expect(parseIdentityFill('{壞掉')).toBeNull();
    });
    it('太長的截掉', () => {
        const fill = parseIdentityFill(JSON.stringify({ aliases: [], roleTitle: '長'.repeat(90), brief: '字'.repeat(200) }))!;
        expect(fill.roleTitle).toHaveLength(40);
        expect(fill.brief).toHaveLength(80);
    });
});

describe('AI 幫我填：填進去的規則', () => {
    const fill = { aliases: ['Vivian', '陸姐'], roleTitle: '攝影師', brief: '嘴甜心硬' };
    it('空的格子直接填', () => {
        const out = applyIdentityFill({ name: '陸薇寧', description: '' }, fill);
        expect(out.patch).toEqual({ aliases: ['Vivian', '陸姐'], roleTitle: '攝影師', description: '嘴甜心硬' });
        expect(out.filled).toEqual(['別名', '身份', '簡介']);
        expect(out.suggestions).toEqual({});
    });
    it('有字的身份、簡介不動，改成建議；別名補上原本沒有的', () => {
        const out = applyIdentityFill({ name: '陸薇寧', description: '我寫的簡介', roleTitle: '我寫的身份', aliases: ['薇寧', 'vivian'] }, fill);
        expect(out.patch).toEqual({ aliases: ['薇寧', 'vivian', '陸姐'] });
        expect(out.filled).toEqual(['別名']);
        expect(out.suggestions).toEqual({ roleTitle: '攝影師', brief: '嘴甜心硬' });
    });
    it('跟原本一樣就什麼都不做', () => {
        const out = applyIdentityFill({ name: '陸薇寧', description: '嘴甜心硬', roleTitle: '攝影師', aliases: ['Vivian', '陸姐'] }, fill);
        expect(out).toEqual({ patch: {}, suggestions: {}, filled: [] });
    });
});

describe('AI 幫我填：提示詞', () => {
    it('帶人設、世界觀、現在的簡介；叫它不要編、不要寫跟用戶的關係', () => {
        const prompt = buildIdentityFillPrompt({ name: '陸薇寧', description: '舊簡介', systemPrompt: '她是攝影師，圈內叫她 Vivian', worldview: '現代都市' });
        expect(prompt).toContain('【人設】\n她是攝影師');
        expect(prompt).toContain('【世界觀】\n現代都市');
        expect(prompt).toContain('【現在的簡介】\n舊簡介');
        expect(prompt).toContain('不要自己編');
        expect(prompt).toContain('不要寫 TA 跟用戶是什麼關係');
    });
    it('什麼都沒填就不用打請求', () => {
        expect(hasIdentityFillSource({ name: 'A', description: '', systemPrompt: '' })).toBe(false);
        expect(hasIdentityFillSource({ name: 'A', description: '', systemPrompt: '有' })).toBe(true);
    });
});
