import { describe, expect, it } from 'vitest';
import { parseSoreSpans, parseSoreText } from './richText';

describe('Sore 回覆的顯示', () => {
    it('粗體、行內程式碼', () => {
        // 粗體裡包著行內程式碼（用戶截圖裡那句）
        expect(parseSoreSpans('居然**完全漏了 `<giggle>` 的美化**！')).toEqual([
            { type: 'plain', text: '居然' },
            { type: 'bold', text: '完全漏了 ' },
            { type: 'code', text: '<giggle>', bold: true },
            { type: 'bold', text: ' 的美化' },
            { type: 'plain', text: '！' },
        ]);
        // 行內程式碼裡的星號不算粗體
        expect(parseSoreSpans('用 `**` 包起來，像 `a ** b`')).toEqual([
            { type: 'plain', text: '用 ' },
            { type: 'code', text: '**' },
            { type: 'plain', text: ' 包起來，像 ' },
            { type: 'code', text: 'a ** b' },
        ]);
        expect(parseSoreSpans('變成**心聲小卡片**，跟 `a*b` 分開')).toEqual([
            { type: 'plain', text: '變成' },
            { type: 'bold', text: '心聲小卡片' },
            { type: 'plain', text: '，跟 ' },
            { type: 'code', text: 'a*b' },
            { type: 'plain', text: ' 分開' },
        ]);
    });

    it('沒成對的星號、反引號照原樣', () => {
        expect(parseSoreSpans('2 * 3 ** 4，還有一個 ` 落單')).toEqual([{ type: 'plain', text: '2 * 3 ** 4，還有一個 ` 落單' }]);
    });

    it('程式碼塊拆出來，帶語言；前後的字各一段', () => {
        const blocks = parseSoreText('先給你這段：\n\n```css\n.a { color: red; }\n.b{}\n```\n\n套用看看 **喜不喜歡**');
        expect(blocks).toEqual([
            { type: 'text', spans: [{ type: 'plain', text: '先給你這段：' }] },
            { type: 'code', lang: 'css', code: '.a { color: red; }\n.b{}' },
            { type: 'text', spans: [{ type: 'plain', text: '套用看看 ' }, { type: 'bold', text: '喜不喜歡' }] },
        ]);
    });

    it('程式碼塊裡的星號、反引號不動', () => {
        const blocks = parseSoreText('```\n**不是粗體** `也不是`\n```');
        expect(blocks).toEqual([{ type: 'code', lang: '', code: '**不是粗體** `也不是`' }]);
    });

    it('寫到一半被截斷、沒收尾：後面整段當程式碼', () => {
        expect(parseSoreText('看：\n```json\n{"a": 1')).toEqual([
            { type: 'text', spans: [{ type: 'plain', text: '看：' }] },
            { type: 'code', lang: 'json', code: '{"a": 1' },
        ]);
    });

    it('兩塊連著、純文字、空字串', () => {
        expect(parseSoreText('```\na\n```\n```js\nb\n```').map(b => b.type)).toEqual(['code', 'code']);
        expect(parseSoreText('就一句')).toEqual([{ type: 'text', spans: [{ type: 'plain', text: '就一句' }] }]);
        expect(parseSoreText('')).toEqual([]);
    });
});
