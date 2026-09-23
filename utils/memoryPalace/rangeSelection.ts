import type { Message } from '../../types';

export interface RangeSearchEntry {
    message: Message;
    searchText: string;
}

/**
 * 日期搜索允許用戶按視覺習慣省略前導零：
 * `6/22` 可以命中界面顯示的 `2026/06/22`。
 */
export function normalizeRangeSearchText(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/(^|[./-])0+(?=\d)/g, '$1')
        .replace(/\s+/g, ' ');
}

/** 預先生成小寫內容和日期索引，避免用戶每輸入一個字符都重新格式化全部時間戳。 */
export function buildRangeSearchEntries(
    messages: Message[],
    formatTimestamp: (timestamp: number) => string,
): RangeSearchEntry[] {
    return messages.map(message => ({
        message,
        searchText: normalizeRangeSearchText(
            `${typeof message.content === 'string' ? message.content : ''} ${formatTimestamp(message.timestamp)}`,
        ),
    }));
}

export function filterRangeSearchEntries(entries: RangeSearchEntry[], query: string): Message[] {
    const normalizedQuery = normalizeRangeSearchText(query);
    if (!normalizedQuery) return entries.map(entry => entry.message);
    return entries
        .filter(entry => entry.searchText.includes(normalizedQuery))
        .map(entry => entry.message);
}

/** 標籤忠實反映用戶點擊的端點角色，不按消息先後擅自互換“起點/終點”。 */
export function getRangeEndpointLabel(
    messageId: number,
    startId: number | null,
    endId: number | null,
): '' | '起點' | '終點' | '起點 / 終點' {
    const isStart = messageId === startId;
    const isEnd = messageId === endId;
    if (isStart && isEnd) return '起點 / 終點';
    if (isStart) return '起點';
    if (isEnd) return '終點';
    return '';
}

export function getRangeSelectionHint(startId: number | null, endId: number | null, selectedCount: number): string {
    if (startId != null && endId != null) return `已選 ${selectedCount} 條`;
    if (startId != null) return '已選起點，請再點終點';
    if (endId != null) return '已選終點，請再點起點';
    return '未選擇';
}
