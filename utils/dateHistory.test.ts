import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import {
    buildDateHistoryGroups,
    formatDateHistoryExport,
    groupDateMessagesByDate,
    makeDateHistoryFileName,
    splitDateEncounters,
} from './dateHistory';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 7, day, hour, minute).getTime();

const message = (
    id: number,
    timestamp: number,
    options: { opening?: boolean; role?: Message['role']; content?: string; type?: Message['type'] } = {},
): Message => ({
    id,
    charId: 'char-1',
    role: options.role || 'assistant',
    type: options.type || 'text',
    content: options.content || `消息${id}`,
    timestamp,
    metadata: { source: 'date', ...(options.opening ? { isOpening: true } : {}) },
});

describe('splitDateEncounters', () => {
    it('有開場錨點時不會再因長時間間隔或跨日誤拆同一次見面', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 22), { opening: true }),
            message(2, at(9, 23)),
            message(3, at(10, 8)),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0].messages.map(item => item.id)).toEqual([1, 2, 3]);
        expect(groups[0].hasOpeningAnchor).toBe(true);
    });

    it('只在下一條開場記錄出現時開啟新的一次見面', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 10), { opening: true }),
            message(2, at(9, 12)),
            message(3, at(9, 18), { opening: true }),
            message(4, at(9, 19)),
        ]);

        expect(groups.map(group => group.messages.map(item => item.id))).toEqual([[1, 2], [3, 4]]);
    });

    it('沒有開場標記的舊記錄按自然日期兼容分組', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 9)),
            message(2, at(9, 20)),
            message(3, at(10, 8)),
        ]);

        expect(groups.map(group => group.messages.map(item => item.id))).toEqual([[1, 2], [3]]);
        expect(groups.every(group => !group.hasOpeningAnchor)).toBe(true);
    });
});

describe('date history views', () => {
    it('按日期會合並同一天的多次見面並統計開場數', () => {
        const groups = groupDateMessagesByDate([
            message(1, at(9, 9), { opening: true }),
            message(2, at(9, 10)),
            message(3, at(9, 18), { opening: true }),
            message(4, at(10, 8), { opening: true }),
        ]);

        expect(groups).toHaveLength(2);
        expect(groups[0].encounterCount).toBe(2);
        expect(groups[0].messages.map(item => item.id)).toEqual([1, 2, 3]);
    });

    it('組間支持由新到舊和由舊到新排序，組內始終按時間正序', () => {
        const messages = [
            message(3, at(10, 8), { opening: true }),
            message(1, at(9, 9), { opening: true }),
            message(2, at(9, 10)),
        ];

        expect(buildDateHistoryGroups(messages, 'encounter', 'newest').map(group => group.messages[0].id)).toEqual([3, 1]);
        expect(buildDateHistoryGroups(messages, 'encounter', 'oldest').map(group => group.messages[0].id)).toEqual([1, 3]);
        expect(buildDateHistoryGroups(messages, 'encounter', 'newest')[1].messages.map(item => item.id)).toEqual([1, 2]);
    });
});

describe('date history export', () => {
    it('導出文本保留原始舞台動作和說話人', () => {
        const groups = buildDateHistoryGroups([
            message(1, at(9, 9), { opening: true, content: '[走近你]早上好' }),
            message(2, at(9, 9, 5), { role: 'user', content: '早呀' }),
        ], 'encounter', 'oldest');
        const output = formatDateHistoryExport('Sully', groups, 'encounter');

        expect(output).toContain('Sully：[走近你]早上好');
        expect(output).toContain('我：早呀');
        expect(output).toContain('整理方式：按次');
    });

    it('文件名會替換系統不允許的字符', () => {
        expect(makeDateHistoryFileName('A/B:角色', '全部')).toMatch(/^A_B_角色_[见見]面[记記][录錄]_全部_/);
    });
});
