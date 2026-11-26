/**
 * 羈絆的日記（plans/bond-batch3.md 1.1）：原本的交換日記搬進來，資料還是 `diaries` 表那一份。
 * 純邏輯，有測試。
 *
 * - 照關係線分：`bondId`；舊資料沒有，算在那個角色主線那張卡的空間（不用搬資料）。
 * - 一天一本、雙方各一頁；誰先寫都行。你的頁按「發布」才算說出口，角色寫的頁寫完就發布。
 * - 舊資料（沒有 writtenAt 也沒有 publishedAt）有字就算已發布：以前寫了就是寫了。
 */
import type { DiaryEntry, DiaryPage } from '../../types';

/** 這本日記屬不屬於這段關係；mainBondId＝這個角色主線那張卡的空間 */
export function diaryInBond(d: Pick<DiaryEntry, 'bondId'>, bondId: string, mainBondId: string): boolean {
    return (d.bondId || mainBondId) === bondId;
}

/** 這頁發布了沒 */
export function pagePublished(p: DiaryPage | undefined | null): boolean {
    if (!p || !p.text?.trim()) return false;
    if (p.publishedAt) return true;
    return !p.writtenAt;
}

/** 這頁是不是還空著（沒寫、或只有空白） */
export const pageEmpty = (p: DiaryPage | undefined | null): boolean => !p || !p.text?.trim();

/** 角色那頁有沒有你還沒讀的 */
export function charPageUnread(d: Pick<DiaryEntry, 'charPage'>): boolean {
    const p = d.charPage;
    return !!p && pagePublished(p) && !!p.publishedAt && !p.seenAt;
}

/** 誰寫了：清單上顯示 */
export function diaryWriters(d: Pick<DiaryEntry, 'userPage' | 'charPage'>): 'both' | 'user' | 'char' | 'none' {
    const u = !pageEmpty(d.userPage);
    const c = !pageEmpty(d.charPage);
    return u && c ? 'both' : u ? 'user' : c ? 'char' : 'none';
}

/** 一本新的（空的你那頁；charId、bondId、日期由呼叫端給） */
export function blankDiary(input: { charId: string; bondId: string; date: string; now?: number; paperStyle?: string }): DiaryEntry {
    const now = input.now ?? Date.now();
    return {
        id: `diary-${now}-${Math.random().toString(36).slice(2, 7)}`,
        charId: input.charId,
        bondId: input.bondId,
        date: input.date,
        // 帶 writtenAt＝新的一頁（沒有它會被當舊資料，有字就算已發布）
        userPage: { text: '', paperStyle: input.paperStyle || 'grid', stickers: [], writtenAt: now },
        timestamp: now,
        isArchived: false,
        autoSync: true,
    };
}

/** 你發布自己那頁 */
export function publishUserPage(d: DiaryEntry, now = Date.now()): DiaryEntry {
    return { ...d, userPage: { ...d.userPage, writtenAt: now, publishedAt: d.userPage.publishedAt || now } };
}

/** 你改自己那頁（還沒發布就還是草稿；發布過的改了照樣算發布，只更新寫下時間） */
export function touchUserPage(d: DiaryEntry, now = Date.now()): DiaryEntry {
    return { ...d, userPage: { ...d.userPage, writtenAt: now } };
}

/**
 * 放上角色寫的那頁：寫完就發布。重寫時把上一版留在 originalText（第一次的那版，之後不覆蓋）。
 */
export function putCharPage(d: DiaryEntry, page: Pick<DiaryPage, 'text' | 'paperStyle' | 'stickers'>, createdBy: 'ai' | 'ai_scheduled', now = Date.now()): DiaryEntry {
    const prev = d.charPage;
    const keepOriginal = prev && !pageEmpty(prev) ? (prev.originalText ?? prev.text) : undefined;
    return {
        ...d,
        charPage: {
            ...page,
            writtenAt: now,
            publishedAt: now,
            createdBy,
            ...(keepOriginal !== undefined ? { originalText: keepOriginal, revisedAt: now } : {}),
        },
    };
}

/** 你改角色那頁的字：第一次改留原文 */
export function reviseCharPage(d: DiaryEntry, text: string, now = Date.now()): DiaryEntry {
    const prev = d.charPage;
    if (!prev || prev.text === text) return d;
    return { ...d, charPage: { ...prev, text, originalText: prev.originalText ?? prev.text, revisedAt: now } };
}

/** 讀過角色那頁 */
export function markCharPageSeen(d: DiaryEntry, now = Date.now()): DiaryEntry {
    if (!d.charPage || d.charPage.seenAt) return d;
    return { ...d, charPage: { ...d.charPage, seenAt: now } };
}

/** 這段關係的日記，新到舊 */
export function diariesOfBond(all: DiaryEntry[], bondId: string, mainBondId: string): DiaryEntry[] {
    return all.filter(d => diaryInBond(d, bondId, mainBondId)).sort((a, b) => (a.date === b.date ? b.timestamp - a.timestamp : b.date.localeCompare(a.date)));
}
