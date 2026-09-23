import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    fileURLToPath(new URL('../apps/VRWorldApp.tsx', import.meta.url)),
    'utf8',
);

const uploadModalStart = source.indexOf('const UploadModal:');
const uploadModalEnd = source.indexOf('// ============ chibi', uploadModalStart);
const uploadModal = source.slice(uploadModalStart, uploadModalEnd);

describe('彼方書庫 PDF 導入接線', () => {
    it('接受 PDF、提取全部文本並僅為 TXT 顯示編碼切換', () => {
        expect(source).toContain("import { extractPdfText, isPdfFile } from '../utils/pdfText'");
        expect(uploadModal).toContain('accept=".txt,text/plain,.pdf,application/pdf"');
        expect(uploadModal).toContain('await extractPdfText(buf, {');
        expect(uploadModal).toContain("fileInfo.kind === 'text'");
        expect(uploadModal).toContain('/\\.(txt|text|pdf)$/i');
        expect(uploadModal).toContain('請先 OCR 後再導入');
    });
});
