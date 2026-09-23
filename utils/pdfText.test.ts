import { describe, expect, it, vi } from 'vitest';
import {
    extractPdfDocumentText,
    isPdfFile,
    pdfItemsToText,
    type PdfDocumentLike,
} from './pdfText';

describe('PDF 文本提取', () => {
    it('同時識別 MIME 和擴展名', () => {
        expect(isPdfFile({ name: 'novel.bin', type: 'application/pdf' })).toBe(true);
        expect(isPdfFile({ name: 'novel.PDF', type: '' })).toBe(true);
        expect(isPdfFile({ name: 'novel.txt', type: 'text/plain' })).toBe(false);
    });

    it('合併中文 PDF 的視覺折行，不在半句話中留下換行或空格', () => {
        expect(pdfItemsToText([
            { str: '她抬頭看向窗外，夜色正' },
            { str: '', hasEOL: true },
            { str: '一點點漫進房間。', hasEOL: true },
        ])).toBe('她抬頭看向窗外，夜色正一點點漫進房間。');
    });

    it('合併英文軟換行並去掉行末斷詞連字符', () => {
        expect(pdfItemsToText([
            { str: 'The sentence was inter-', hasEOL: true },
            { str: 'rupted by a visual line break.', hasEOL: true },
        ])).toBe('The sentence was interrupted by a visual line break.');
    });

    it('保留顯式空行和明顯的版面段間距', () => {
        expect(pdfItemsToText([
            { str: '第一段。' },
            { str: '', hasEOL: true },
            { str: '', hasEOL: true },
            { str: '第二段。', hasEOL: true },
        ])).toBe('第一段。\n\n第二段。');

        expect(pdfItemsToText([
            { str: '同一段的第一行', hasEOL: true, transform: [12, 0, 0, 12, 40, 700], height: 12 },
            { str: '繼續這一段。', hasEOL: true, transform: [12, 0, 0, 12, 40, 686], height: 12 },
            { str: '新的自然段。', hasEOL: true, transform: [12, 0, 0, 12, 40, 650], height: 12 },
        ])).toBe('同一段的第一行繼續這一段。\n\n新的自然段。');
    });

    it('頁眉或頁碼更靠左時，仍以正文常用左邊界判斷軟折行', () => {
        expect(pdfItemsToText([
            { str: '夏以星×你 sweet talk', hasEOL: true, transform: [10, 0, 0, 10, 8, 790], height: 10 },
            { str: '但今天你心裡想著事情，懶得同他計較，只是抬', hasEOL: true, transform: [12, 0, 0, 12, 42, 720], height: 12 },
            { str: '手拍了拍肩膀上的魅魔大狗狗，', hasEOL: true, transform: [12, 0, 0, 12, 42.2, 706], height: 12 },
            { str: '示意他安分點。', hasEOL: true, transform: [12, 0, 0, 12, 42, 692], height: 12 },
        ])).toBe('夏以星×你 sweet talk\n\n但今天你心裡想著事情，懶得同他計較，只是抬手拍了拍肩膀上的魅魔大狗狗，示意他安分點。');
    });

    it('正文左邊界不受雜項干擾時，仍保留真正的首行縮進', () => {
        expect(pdfItemsToText([
            { str: '上一段的第一行', hasEOL: true, transform: [12, 0, 0, 12, 42, 720], height: 12 },
            { str: '上一段的續行。', hasEOL: true, transform: [12, 0, 0, 12, 42, 706], height: 12 },
            { str: '新段落縮進開頭，', hasEOL: true, transform: [12, 0, 0, 12, 66, 680], height: 12 },
            { str: '然後回到正文左邊界。', hasEOL: true, transform: [12, 0, 0, 12, 42, 666], height: 12 },
        ])).toBe('上一段的第一行上一段的續行。\n\n新段落縮進開頭，然後回到正文左邊界。');
    });

    it('逐頁提取全文、報告進度並釋放頁面資源', async () => {
        const cleanup = vi.fn();
        const progress = vi.fn();
        const pdf: PdfDocumentLike = {
            numPages: 2,
            getPage: vi.fn(async pageNumber => ({
                getTextContent: async () => ({ items: [{ str: `第 ${pageNumber} 頁`, hasEOL: true }] }),
                cleanup,
            })),
        };

        const result = await extractPdfDocumentText(pdf, { onProgress: progress });

        expect(result).toEqual({ text: '第 1 頁\n\n第 2 頁', pageCount: 2, extractedPages: 2 });
        expect(progress).toHaveBeenNthCalledWith(1, { page: 1, totalPages: 2 });
        expect(progress).toHaveBeenNthCalledWith(2, { page: 2, totalPages: 2 });
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('為學習 App 保留可配置的頁數上限', async () => {
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: async () => ({ items: [{ str: `P${pageNumber}` }] }),
        }));
        const result = await extractPdfDocumentText({ numPages: 80, getPage }, { maxPages: 50 });

        expect(result.extractedPages).toBe(50);
        expect(result.pageCount).toBe(80);
        expect(getPage).toHaveBeenCalledTimes(50);
        expect(getPage).toHaveBeenLastCalledWith(50);
    });
});
