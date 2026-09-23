import * as bundledPdfJs from 'pdfjs-dist';
import bundledPdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url';

type PdfTextItemLike = {
    str?: unknown;
    hasEOL?: boolean;
    transform?: number[];
    height?: number;
};

type PdfTextLine = {
    text: string;
    x?: number;
    y?: number;
    height?: number;
    blank?: boolean;
};

type PdfPageLike = {
    getTextContent: () => Promise<{ items?: PdfTextItemLike[] }>;
    cleanup?: () => void;
};

export type PdfDocumentLike = {
    numPages: number;
    getPage: (pageNumber: number) => Promise<PdfPageLike>;
    destroy?: () => Promise<void> | void;
};

type PdfJsLike = {
    getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<PdfDocumentLike> };
    GlobalWorkerOptions?: { workerSrc?: string };
};

export interface PdfExtractionProgress {
    page: number;
    totalPages: number;
}

export interface PdfTextResult {
    text: string;
    pageCount: number;
    extractedPages: number;
}

export interface ExtractPdfTextOptions {
    maxPages?: number;
    onProgress?: (progress: PdfExtractionProgress) => void;
}

let pdfjsPromise: Promise<PdfJsLike> | null = null;

/**
 * PDF.js 與 worker 都隨站點/APK 構建，不再從第三方 CDN 動態加載。
 * Android WebView 因而不會再被跨域 Worker、CDN 可達性或離線狀態卡住。
 */
const loadPdfJs = async (): Promise<PdfJsLike> => {
    if (!pdfjsPromise) {
        pdfjsPromise = Promise.resolve().then(() => {
            const pdfjs = bundledPdfJs as unknown as PdfJsLike;
            if (!pdfjs?.getDocument) throw new Error('PDF.js 加載失敗');
            if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = bundledPdfWorkerSrc;
            return pdfjs;
        }).catch(error => {
            pdfjsPromise = null;
            throw error;
        });
    }
    return pdfjsPromise;
};

export const isPdfFile = (file: Pick<File, 'name' | 'type'>): boolean =>
    file.type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name);

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const NO_SPACE_BEFORE = /^[,.;:!?%。，、；：！？）》】』”’]/;
const NO_SPACE_AFTER = /[(（《【『“‘，。、；：！？）》】』”’…]$/;
const CHAPTER_HEADING = /^(?:第.{1,12}[章节節回部卷篇]|chapter\b)/i;

const finiteNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const itemMetrics = (item: PdfTextItemLike) => {
    const x = finiteNumber(item.transform?.[4]);
    const y = finiteNumber(item.transform?.[5]);
    const height = (finiteNumber(item.height) ?? Math.abs(finiteNumber(item.transform?.[3]) ?? 0)) || undefined;
    return { x, y, height };
};

const inlineSeparator = (left: string, right: string): string => {
    if (!left || !right || /\s$/.test(left) || /^\s/.test(right)) return '';
    if (NO_SPACE_BEFORE.test(right) || NO_SPACE_AFTER.test(left)) return '';
    if (CJK_CHAR.test(left.slice(-1)) && CJK_CHAR.test(right[0])) return '';
    return ' ';
};

const isNewVisualLine = (line: PdfTextLine, item: PdfTextItemLike): boolean => {
    const next = itemMetrics(item);
    if (line.y == null || next.y == null) return false;
    const height = Math.max(line.height || 0, next.height || 0, 1);
    return Math.abs(line.y - next.y) > height * 0.55;
};

const median = (values: number[]): number | undefined => {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

/**
 * 估算正文的常用左邊界，而不是直接取全頁最小 x。
 *
 * PDF 的頁眉、頁碼、章節裝飾經常比正文更靠左。把它們的 x 當正文左邊界後，
 * 每一行正文都會看起來像“縮進了兩格”，繼而被誤判成新段落。正文續行的 x
 * 通常會在一個很窄的範圍內反覆出現，因此取最密集的 x 簇更可靠。
 */
const estimateBodyLeftEdge = (lines: PdfTextLine[]): number | undefined => {
    const positioned = lines.filter((line): line is PdfTextLine & { x: number } =>
        !!line.text && line.x != null && Number.isFinite(line.x));
    if (positioned.length === 0) return undefined;

    const typicalHeight = median(positioned
        .map(line => line.height)
        .filter((value): value is number => value != null && value > 0)) || 10;
    const tolerance = Math.max(1.5, typicalHeight * 0.35);
    const sorted = [...positioned].sort((a, b) => a.x - b.x);
    const clusters: Array<{ xs: number[]; chars: number }> = [];

    for (const line of sorted) {
        const last = clusters[clusters.length - 1];
        const center = last ? (median(last.xs) ?? line.x) : line.x;
        if (last && Math.abs(line.x - center) <= tolerance) {
            last.xs.push(line.x);
            last.chars += line.text.length;
        } else {
            clusters.push({ xs: [line.x], chars: line.text.length });
        }
    }

    clusters.sort((a, b) =>
        b.xs.length - a.xs.length
        || b.chars - a.chars
        || (median(a.xs) || 0) - (median(b.xs) || 0));
    return median(clusters[0].xs);
};

const shouldKeepParagraphBreak = (previous: PdfTextLine, current: PdfTextLine, leftEdge?: number): boolean => {
    if (previous.blank || current.blank) return true;
    if (CHAPTER_HEADING.test(previous.text.trim()) || CHAPTER_HEADING.test(current.text.trim())) return true;

    const lineHeight = Math.max(previous.height || 0, current.height || 0, 1);
    if (previous.y != null && current.y != null && Math.abs(previous.y - current.y) > lineHeight * 1.65) {
        return true;
    }
    if (leftEdge != null && current.x != null && current.x - leftEdge > lineHeight * 1.4) {
        return true;
    }
    return false;
};

const joinPdfLines = (lines: PdfTextLine[]): string => {
    const contentLines = lines.filter(line => line.text || line.blank);
    const leftEdge = estimateBodyLeftEdge(contentLines);
    let output = '';
    let previous: PdfTextLine | undefined;
    let pendingBlank = false;

    for (const line of contentLines) {
        if (line.blank || !line.text) {
            pendingBlank = !!previous;
            continue;
        }
        if (!previous) {
            output = line.text;
            previous = line;
            continue;
        }

        if (pendingBlank || shouldKeepParagraphBreak(previous, line, leftEdge)) {
            output += `\n\n${line.text}`;
        } else if (/[-‐‑]$/.test(output) && /^[a-z]/i.test(line.text)) {
            output = `${output.slice(0, -1)}${line.text}`;
        } else {
            output += `${inlineSeparator(output, line.text)}${line.text}`;
        }
        previous = line;
        pendingBlank = false;
    }

    return output.trim();
};

export const pdfItemsToText = (items: PdfTextItemLike[]): string => {
    const lines: PdfTextLine[] = [];
    let line: PdfTextLine = { text: '' };

    const flush = (blank = false) => {
        if (line.text.trim() || blank) lines.push({ ...line, text: line.text.trim(), blank });
        line = { text: '' };
    };

    for (const item of items) {
        const value = typeof item.str === 'string' ? item.str.replace(/\u0000/g, '') : '';
        if (value && line.text && isNewVisualLine(line, item)) flush();
        if (value) {
            const metrics = itemMetrics(item);
            line.x ??= metrics.x;
            line.y ??= metrics.y;
            line.height = Math.max(line.height || 0, metrics.height || 0) || undefined;
            line.text += `${inlineSeparator(line.text, value)}${value}`;
        }
        if (item.hasEOL) flush(!value && !line.text);
    }
    flush();
    return joinPdfLines(lines);
};

export const extractPdfDocumentText = async (
    pdf: PdfDocumentLike,
    options: ExtractPdfTextOptions = {},
): Promise<PdfTextResult> => {
    const requestedPages = options.maxPages == null
        ? pdf.numPages
        : Math.max(0, Math.floor(options.maxPages));
    const extractedPages = Math.min(pdf.numPages, requestedPages);
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= extractedPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        try {
            const content = await page.getTextContent();
            pages.push(pdfItemsToText(content.items || []));
        } finally {
            page.cleanup?.();
        }
        options.onProgress?.({ page: pageNumber, totalPages: extractedPages });
    }

    return {
        text: pages.filter(Boolean).join('\n\n').trim(),
        pageCount: pdf.numPages,
        extractedPages,
    };
};

export const extractPdfText = async (
    data: ArrayBuffer,
    options: ExtractPdfTextOptions = {},
): Promise<PdfTextResult> => {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data }).promise;
    try {
        return await extractPdfDocumentText(pdf, options);
    } finally {
        await pdf.destroy?.();
    }
};
