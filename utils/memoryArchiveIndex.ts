import type { MemoryFragment } from '../types';

export type MemoryArchiveTree = Record<string, Record<string, MemoryFragment[]>>;

function ensureArchiveMonth(tree: MemoryArchiveTree, monthKey: string): void {
    const match = monthKey.match(/^(\d{4})[-/年](\d{1,2})(?:月)?$/);
    if (!match) return;
    const year = match[1];
    const month = match[2].padStart(2, '0');
    if (!tree[year]) tree[year] = {};
    if (!tree[year][month]) tree[year][month] = [];
}

/**
 * 月份目錄必須同時覆蓋日度記錄、月度核心摘要和已激活月份。
 * 否則刪掉某月最後一條日度記錄後，仍會進入 Memory Bank 的月度摘要會從 UI 消失。
 */
export function buildMemoryArchiveIndex(
    memories: MemoryFragment[] | undefined,
    refinedMemories: Record<string, string> | undefined,
    activeMemoryMonths: string[] | undefined,
): { tree: MemoryArchiveTree; stats: { totalChars: number; count: number } } {
    const tree: MemoryArchiveTree = {};
    let totalChars = 0;
    const safeMemories = Array.isArray(memories) ? memories : [];

    safeMemories.forEach(m => {
        totalChars += m.summary.length;
        let year = '未知年份', month = '未知';
        const dateMatch = m.date.match(/(\d{4})[-/年](\d{1,2})/);
        if (dateMatch) {
            year = dateMatch[1];
            month = dateMatch[2].padStart(2, '0');
        } else if (m.date.includes('unknown')) year = '未歸檔';
        if (!tree[year]) tree[year] = {};
        if (!tree[year][month]) tree[year][month] = [];
        tree[year][month].push(m);
    });

    Object.keys(refinedMemories || {}).forEach(monthKey => ensureArchiveMonth(tree, monthKey));
    (activeMemoryMonths || []).forEach(monthKey => ensureArchiveMonth(tree, monthKey));

    const sortedTree: MemoryArchiveTree = {};
    Object.keys(tree).sort((a, b) => b.localeCompare(a)).forEach(year => {
        sortedTree[year] = {};
        Object.keys(tree[year]).sort((a, b) => b.localeCompare(a)).forEach(month => {
            sortedTree[year][month] = [...tree[year][month]].sort((a, b) => b.date.localeCompare(a.date));
        });
    });

    return { tree: sortedTree, stats: { totalChars, count: safeMemories.length } };
}
