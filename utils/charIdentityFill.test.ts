import { describe, expect, it } from 'vitest';
import { applyIdentityFill, batchFillCandidates, buildIdentityFillPrompt, defaultBatchPicks, draftFromFill, hasIdentityFillSource, needsIdentityFill, parseIdentityFill, patchFromDraft, runLimited } from './charIdentityFill';

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

describe('批次補填', () => {
    const c = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, description: '', systemPrompt: '有人設', ...extra });
    it('預設勾：兩格都空、有人設可讀的；小號不列', () => {
        const chars = [c('空的'), c('有別名', { aliases: ['A'] }), c('有身份', { roleTitle: '醫生' }), c('沒人設', { systemPrompt: '' }), c('小號', { altOf: '空的' })];
        expect(batchFillCandidates(chars).map(x => x.id)).toEqual(['空的', '有別名', '有身份', '沒人設']);
        expect(defaultBatchPicks(chars)).toEqual(['空的']);
        expect(needsIdentityFill(c('x', { aliases: ['x'], roleTitle: '  ' }))).toBe(true);
    });
    it('結果變成草稿：空的填上、有字的留著並帶建議', () => {
        const fill = { aliases: ['Vivian'], roleTitle: '攝影師', brief: '嘴甜心硬' };
        expect(draftFromFill({ name: '陸薇寧', description: '' }, fill)).toEqual({ aliasText: 'Vivian', roleTitle: '攝影師', description: '嘴甜心硬' });
        expect(draftFromFill({ name: '陸薇寧', description: '我寫的', roleTitle: '我寫的身份', aliases: ['陸姐'] }, fill))
            .toEqual({ aliasText: '陸姐、Vivian', roleTitle: '我寫的身份', description: '我寫的', suggestRole: '攝影師', suggestBrief: '嘴甜心硬' });
    });
    it('草稿 → 要寫的：只寫有變的；清空就是拿掉；沒變回 null', () => {
        const char = { name: '陸薇寧', description: '舊簡介', roleTitle: '舊身份', aliases: ['陸姐'] };
        expect(patchFromDraft(char, { aliasText: '陸姐', roleTitle: '舊身份', description: '舊簡介' })).toBeNull();
        expect(patchFromDraft(char, { aliasText: '陸姐, Vivian，陸薇寧', roleTitle: ' 攝影師 ', description: '舊簡介' })).toEqual({ aliases: ['陸姐', 'Vivian'], roleTitle: '攝影師' });
        expect(patchFromDraft(char, { aliasText: '', roleTitle: '', description: '' })).toEqual({ aliases: undefined, roleTitle: undefined, description: '' });
    });
    it('同時最多幾個；按停就不再開新的', async () => {
        let running = 0, peak = 0;
        const done: number[] = [];
        await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async n => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 5)); running--; done.push(n); });
        expect(peak).toBe(3);
        expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
        const controller = new AbortController();
        const started: number[] = [];
        await runLimited([1, 2, 3, 4, 5, 6], 2, async n => { started.push(n); if (n === 2) controller.abort(); await new Promise(r => setTimeout(r, 5)); }, controller.signal);
        expect(started).toEqual([1, 2]);
    });
});
