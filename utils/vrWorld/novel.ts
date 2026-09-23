/**
 * 「彼方」小說工具 —— 切塊、閱讀窗口、書籤推進、批註組織。
 */

import { VRWorldNovel, VRNovelSegment, VRNovelAnnotation } from '../../types';
import { VR_SEGMENT_TARGET_CHARS, VR_NOVEL_FEED_CHARS } from './constants';

const genId = (prefix: string) =>
    `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * 把整本小說原文切成閱讀單元。按段落（空行/換行）聚合到 ~目標字數，
 * 儘量不切斷自然段；超長自然段按字數硬切。
 */
export function chunkNovelText(raw: string, target = VR_SEGMENT_TARGET_CHARS): VRNovelSegment[] {
    const normalized = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) return [];

    // 先按自然段拆
    const paragraphs = normalized
        .split(/\n\s*\n|\n/)
        .map(p => p.trim())
        .filter(Boolean);

    const segments: VRNovelSegment[] = [];
    let buffer = '';

    const flush = () => {
        const text = buffer.trim();
        if (text) {
            segments.push({ idx: segments.length, text, chars: text.length });
        }
        buffer = '';
    };

    for (const para of paragraphs) {
        // 超長自然段：硬切
        if (para.length > target * 2) {
            flush();
            for (let i = 0; i < para.length; i += target) {
                const piece = para.slice(i, i + target);
                segments.push({ idx: segments.length, text: piece, chars: piece.length });
            }
            continue;
        }
        if ((buffer.length + para.length) > target && buffer.length > 0) {
            flush();
        }
        buffer = buffer ? `${buffer}\n${para}` : para;
    }
    flush();

    return segments;
}

/** 從原文新建一本小說。 */
export function buildNovel(title: string, raw: string, opts?: { author?: string; summary?: string }): VRWorldNovel {
    const segments = chunkNovelText(raw);
    const totalChars = segments.reduce((s, seg) => s + seg.chars, 0);
    const now = Date.now();
    return {
        id: genId('vrnovel'),
        title: title.trim() || '無題',
        author: opts?.author?.trim() || undefined,
        summary: opts?.summary?.trim() || undefined,
        segments,
        totalChars,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * 異步切塊：大文件（數 MB 小說）專用。分批讓出主線程，避免一次性同步切塊凍 UI。
 * onProgress 回調 0~1 進度。
 */
export async function chunkNovelTextAsync(
    raw: string,
    target = VR_SEGMENT_TARGET_CHARS,
    onProgress?: (ratio: number) => void,
): Promise<VRNovelSegment[]> {
    const normalized = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) return [];
    const paragraphs = normalized.split(/\n\s*\n|\n/);
    const total = paragraphs.length;

    const segments: VRNovelSegment[] = [];
    let buffer = '';
    const flush = () => {
        const text = buffer.trim();
        if (text) segments.push({ idx: segments.length, text, chars: text.length });
        buffer = '';
    };

    for (let i = 0; i < total; i++) {
        const para = paragraphs[i].trim();
        if (para) {
            if (para.length > target * 2) {
                flush();
                for (let j = 0; j < para.length; j += target) {
                    const piece = para.slice(j, j + target);
                    segments.push({ idx: segments.length, text: piece, chars: piece.length });
                }
            } else {
                if ((buffer.length + para.length) > target && buffer.length > 0) flush();
                buffer = buffer ? `${buffer}\n${para}` : para;
            }
        }
        // 每 4000 段讓出一次主線程並上報進度
        if (i % 4000 === 0) {
            onProgress?.(i / total);
            await new Promise<void>(r => setTimeout(r));
        }
    }
    flush();
    onProgress?.(1);
    return segments;
}

/** 異步版 buildNovel —— 大文件用，避免主線程卡頓。 */
export async function buildNovelAsync(
    title: string,
    raw: string,
    opts?: { author?: string; summary?: string; onProgress?: (ratio: number) => void },
): Promise<VRWorldNovel> {
    const segments = await chunkNovelTextAsync(raw, VR_SEGMENT_TARGET_CHARS, opts?.onProgress);
    const totalChars = segments.reduce((s, seg) => s + seg.chars, 0);
    const now = Date.now();
    return {
        id: genId('vrnovel'),
        title: title.trim() || '無題',
        author: opts?.author?.trim() || undefined,
        summary: opts?.summary?.trim() || undefined,
        segments,
        totalChars,
        createdAt: now,
        updatedAt: now,
    };
}

export interface ReadingWindow {
    /** 起始 segment 索引（含） */
    from: number;
    /** 結束 segment 索引（不含） */
    to: number;
    segments: VRNovelSegment[];
    /** 是否已讀到全書末尾 */
    reachedEnd: boolean;
}

/**
 * 從書籤處取一個閱讀窗口：累計原文字數直到接近預算（含已有批註的開銷由調用方另算）。
 * 至少給一個 segment，避免預算太小卡死。
 */
export function getReadingWindow(
    novel: VRWorldNovel,
    bookmark: number,
    budgetChars = VR_NOVEL_FEED_CHARS,
): ReadingWindow {
    const from = Math.max(0, Math.min(bookmark, novel.segments.length));
    let used = 0;
    let to = from;
    while (to < novel.segments.length) {
        const seg = novel.segments[to];
        if (to > from && used + seg.chars > budgetChars) break;
        used += seg.chars;
        to += 1;
    }
    return {
        from,
        to,
        segments: novel.segments.slice(from, to),
        reachedEnd: to >= novel.segments.length,
    };
}

/** 新建一條批註。 */
export function buildAnnotation(input: {
    novelId: string;
    segIdx: number;
    authorId: string;
    authorName: string;
    content: string;
    targetAnnotationId?: string;
}): VRNovelAnnotation {
    return {
        id: genId('vrann'),
        novelId: input.novelId,
        segIdx: input.segIdx,
        authorId: input.authorId,
        authorName: input.authorName,
        content: input.content.trim(),
        targetAnnotationId: input.targetAnnotationId,
        createdAt: Date.now(),
    };
}

/** 把批註按段落索引歸組，便於渲染與喂 prompt。 */
export function groupAnnotationsBySeg(annotations: VRNovelAnnotation[]): Map<number, VRNovelAnnotation[]> {
    const map = new Map<number, VRNovelAnnotation[]>();
    for (const a of annotations) {
        const arr = map.get(a.segIdx) || [];
        arr.push(a);
        map.set(a.segIdx, arr);
    }
    for (const arr of map.values()) arr.sort((x, y) => x.createdAt - y.createdAt);
    return map;
}

/** 讀取某角色對某本書的書籤（默認 0）。 */
export function getBookmark(bookmarks: Record<string, number> | undefined, novelId: string): number {
    return bookmarks?.[novelId] ?? 0;
}
