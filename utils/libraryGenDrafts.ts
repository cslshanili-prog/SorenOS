/**
 * 資料庫生圖的暫存（plans/library-generate-redesign.md 第 4 節 3）：生了沒存的圖留在裝置上，
 * 只有自己刪（單張或「全部刪除」）才清。圖本身存成 blobRef（IndexedDB），清單放 localStorage（只有 id 和幾個字串）。
 * 存進資料庫的那張標 savedImageId；在暫存刪掉它不動資料庫那份（deleteBlobRefIfUnreferenced 會看還有沒有人用）。
 */
import type { LibraryGenKind } from '../types';

export interface LibraryGenDraft {
    id: string;
    /** blobRef */
    ref: string;
    kind: LibraryGenKind;
    /** 你寫的那句（AI 寫之前） */
    userPrompt: string;
    /** 送進 buildLibraryImagePrompt 的描述（開了 AI 寫就是 AI 寫的那段） */
    scenePrompt: string;
    /** 真的送出去的整段（套了畫風） */
    sentPrompt?: string;
    sentNegativePrompt?: string;
    subjects: string[];
    locked: number;
    wanted: number;
    peopleCount: number;
    lockError?: string;
    createdAt: number;
    savedImageId?: string;
}

const KEY = 'soren-library-gen-drafts-v1';
/** 太多了就先不收新的（避免 localStorage、IndexedDB 一直長）；超過時最舊的、已存過的先讓位 */
export const LIBRARY_GEN_DRAFTS_MAX = 40;

export function loadLibraryGenDrafts(): LibraryGenDraft[] {
    try {
        const raw = localStorage.getItem(KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter(d => d && d.id && d.ref) : [];
    } catch {
        return [];
    }
}

export function saveLibraryGenDrafts(list: LibraryGenDraft[]): void {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 存不進去就只在這次開著的時候有 */ }
}

/** 新的放最前面；超過上限時丟掉最舊的（回傳被丟掉的，呼叫端清 blob） */
export function addLibraryGenDrafts(list: LibraryGenDraft[], fresh: LibraryGenDraft[]): { next: LibraryGenDraft[]; dropped: LibraryGenDraft[] } {
    const all = [...fresh, ...list];
    if (all.length <= LIBRARY_GEN_DRAFTS_MAX) return { next: all, dropped: [] };
    // 先丟已存過的舊圖，再丟沒存的舊圖
    const keep = [...all];
    const dropped: LibraryGenDraft[] = [];
    for (let i = keep.length - 1; i >= 0 && keep.length > LIBRARY_GEN_DRAFTS_MAX; i--) {
        if (keep[i].savedImageId) dropped.push(...keep.splice(i, 1));
    }
    while (keep.length > LIBRARY_GEN_DRAFTS_MAX) dropped.push(keep.pop()!);
    return { next: keep, dropped };
}

export const newLibraryGenDraftId = () => `lgd-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
