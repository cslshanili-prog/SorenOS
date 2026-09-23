import { describe, expect, it } from 'vitest';
import {
    buildRangeSearchEntries,
    filterRangeSearchEntries,
    getRangeEndpointLabel,
    getRangeSelectionHint,
    normalizeRangeSearchText,
} from './rangeSelection';

describe('手動總結區間選擇', () => {
    it('先選終點時保持顯示“終點”，不會誤標為起點', () => {
        expect(getRangeEndpointLabel(22, null, 22)).toBe('終點');
        expect(getRangeSelectionHint(null, 22, 1)).toBe('已選終點，請再點起點');
    });

    it('起終點反向選擇時仍忠實顯示用戶指定的角色', () => {
        expect(getRangeEndpointLabel(80, 80, 20)).toBe('起點');
        expect(getRangeEndpointLabel(20, 80, 20)).toBe('終點');
    });

    it('同一條消息可同時作為起點和終點', () => {
        expect(getRangeEndpointLabel(30, 30, 30)).toBe('起點 / 終點');
        expect(getRangeSelectionHint(30, 30, 1)).toBe('已選 1 條');
    });

    it('日期搜索忽略分隔符後的前導零，並複用預計算索引', () => {
        const messages = [
            { id: 1, content: '六月的約定', timestamp: 1 },
            { id: 2, content: '七月見', timestamp: 2 },
        ] as any;
        const entries = buildRangeSearchEntries(messages, timestamp =>
            timestamp === 1 ? '2026/06/22 01:04' : '2026/07/03 09:30',
        );

        expect(normalizeRangeSearchText(' 6/22 ')).toBe('6/22');
        expect(filterRangeSearchEntries(entries, '6/22').map(message => message.id)).toEqual([1]);
        expect(filterRangeSearchEntries(entries, '七月').map(message => message.id)).toEqual([2]);
    });
});
