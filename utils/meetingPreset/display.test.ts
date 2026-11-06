import { describe, expect, it } from 'vitest';
import { cleanDisplayText, splitDisplaySegments } from './display';

describe('splitDisplaySegments', () => {
    it('```html 區塊和直接寫的區塊元素都切成 HTML 段，其餘是文字', () => {
        const text = '開頭\n```html\n<!DOCTYPE html><html><body>標題</body></html>\n```\n正文一\n<details><summary>摘要</summary><div><div>內</div></div></details>\n結尾';
        expect(splitDisplaySegments(text)).toEqual([
            { type: 'text', text: '開頭\n' },
            { type: 'html', html: '<!DOCTYPE html><html><body>標題</body></html>\n' },
            { type: 'text', text: '\n正文一\n' },
            { type: 'html', html: '<details><summary>摘要</summary><div><div>內</div></div></details>' },
            { type: 'text', text: '\n結尾' },
        ]);
    });

    it('只隔著空白的 HTML 段併成一段（樣式和內容放同一個 iframe）', () => {
        const segments = splitDisplaySegments('<style>.a{}</style>\n\n<div class="a">卡</div>');
        expect(segments).toEqual([{ type: 'html', html: '<style>.a{}</style>\n<div class="a">卡</div>' }]);
    });

    it('內容不是 HTML 的程式碼區塊當文字；沒有結束標籤就到結尾', () => {
        expect(splitDisplaySegments('```\n純文字\n```')).toEqual([{ type: 'text', text: '純文字\n' }]);
        expect(splitDisplaySegments('前<div>沒關')).toEqual([{ type: 'text', text: '前' }, { type: 'html', html: '<div>沒關' }]);
    });

    it('自訂標籤不算區塊元素', () => {
        expect(splitDisplaySegments('<meow_FM>摘要</meow_FM>')).toEqual([{ type: 'text', text: '<meow_FM>摘要</meow_FM>' }]);
    });
});

describe('cleanDisplayText', () => {
    it('拿掉註解和標籤，留下文字', () => {
        expect(cleanDisplayText('<!-- 檢查 -->他笑了。<br><meow_FM>摘要</meow_FM><角色手机>x</角色手机> a < b')).toBe('他笑了。\n摘要x a < b');
    });
});
