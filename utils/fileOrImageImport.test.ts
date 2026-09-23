import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileOrImageImport } from '../components/share/FileOrImageImport';

describe('文件與圖片入口分離', () => {
    it('文件入口不含圖片類型限制，PNG 仍可經通用文件選擇器傳給同一個解析器', () => {
        const html = renderToStaticMarkup(createElement(FileOrImageImport, { onChange: () => {} }));
        expect(html).toContain('accept="*/*"');
        expect(html).toContain('accept="image/png"');
        expect(html).not.toContain('image/png,text');
        expect(html).toContain('從文件導入');
        expect(html).toContain('從圖片導入');
    });
});
