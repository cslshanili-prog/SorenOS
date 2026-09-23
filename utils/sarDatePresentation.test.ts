import { describe, expect, it } from 'vitest';
import { resolveSARDateSpeech } from './sarDatePresentation';

const lines = (...texts: string[]) => texts.map(text => ({ text }));
const message = { id: 12, moduleTitle: '模塊', surface: lines('哼。', '哼。', '才不是。'), canonical: lines('你好。', '再見。', '是的。') };
describe('SAR 見面雙層台詞定位', () => {
    it('重複的汙染短句按整批進度匹配，不會總配第一句原文', () => {
        expect(resolveSARDateSpeech([message], message.surface, 1, '哼。')?.canonical).toBe('再見。');
    });
    it('舊續接快照的引擎存著原台詞時仍能找到汙染台詞', () => {
        expect(resolveSARDateSpeech([message], message.canonical, 0, '是的。')?.surface).toBe('才不是。');
    });
    it('普通的新回覆恰好同樣一句話，不繼承舊模塊顯示', () => {
        expect(resolveSARDateSpeech([message], lines('哼。'), 0, '哼。')).toBeNull();
    });
    it('舊快照缺整批時只接受唯一命中，不猜重複句', () => {
        expect(resolveSARDateSpeech([message], [], 0, '哼。')).toBeNull();
        expect(resolveSARDateSpeech([message], [], 0, '是的。')?.surface).toBe('才不是。');
    });
    it('格式異常使行數不等時保留完整原文和外顯的尾句', () => {
        const uneven = { ...message, canonical: lines('第一句。', '第二句。', '第三句。', '尾句。') };
        expect(resolveSARDateSpeech([uneven], uneven.surface, 0, '才不是。')).toMatchObject({
            canonical: '第一句。\n第二句。\n第三句。\n尾句。', surface: '哼。\n哼。\n才不是。',
        });
    });
    it('切批瞬間當前行還沒更新時不閃現另一段台詞', () => {
        expect(resolveSARDateSpeech([message], message.surface, 0, '哼。')).toBeNull();
    });
});
