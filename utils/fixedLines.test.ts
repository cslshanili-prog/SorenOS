import { describe, expect, it } from 'vitest';
import type { FixedLine } from '../types';
import {
    buildTriggeredLinesPrompt, fixedLineKey, formatSignatureLinesBlock, latestUserText, normalizeFixedLines,
    signatureLines, triggeredFixedLines,
} from './fixedLines';

const lines: FixedLine[] = [
    { id: 'a', trigger: '你會一直在嗎', reply: '只要你回頭，我就在。' },
    { id: 'b', reply: '{{user}}，別怕。' },
    { id: 'c', trigger: 'Good night', reply: '晚安，{{user}}。' },
];

describe('固定台詞 · 比對', () => {
    it('簡繁、標點、空白、大小寫都不計', () => {
        expect(fixedLineKey('你會一直在嗎？')).toBe(fixedLineKey('你会 一直在吗'));
        expect(triggeredFixedLines(lines, '欸……你会一直在吗？')).toEqual([lines[0]]);
        expect(triggeredFixedLines(lines, 'GOOD NIGHT!')).toEqual([lines[2]]);
    });
    it('句子要大致一樣才觸發', () => {
        expect(triggeredFixedLines(lines, '你以後還會在吧')).toEqual([]);
    });
    it('沒填「對方說」的不會被觸發', () => {
        expect(triggeredFixedLines(lines, '別怕')).toEqual([]);
    });
    it('空訊息不觸發', () => {
        expect(triggeredFixedLines(lines, '')).toEqual([]);
        expect(triggeredFixedLines(lines, '？？？')).toEqual([]);
    });
});

describe('固定台詞 · 區塊', () => {
    it('觸發：寫明一字不改、換掉 {{user}}', () => {
        const block = buildTriggeredLinesPrompt({ name: '周以衡', fixedLines: lines }, 'good night~', '小星');
        expect(block).toContain('一字不改');
        expect(block).toContain('小星 剛才說了「Good night」');
        expect(block).toContain('「晚安，小星。」');
        expect(buildTriggeredLinesPrompt({ name: '周以衡', fixedLines: lines }, '嗯', '小星')).toBe('');
    });
    it('招牌台詞：只列沒填「對方說」的', () => {
        expect(signatureLines(lines).map(l => l.id)).toEqual(['b']);
        const block = formatSignatureLinesBlock(lines, '周以衡', '小星');
        expect(block).toContain('招牌台詞');
        expect(block).toContain('「小星，別怕。」');
        expect(block).not.toContain('只要你回頭');
        expect(formatSignatureLinesBlock([lines[0]], '周以衡', '小星')).toBe('');
    });
});

describe('固定台詞 · 整理與取最新一句', () => {
    it('去空白、丟掉沒台詞的、空清單回 undefined', () => {
        expect(normalizeFixedLines([{ id: 'x', trigger: '  ', reply: ' 嗯 ' }, { id: 'y', reply: '  ' }]))
            .toEqual([{ id: 'x', trigger: undefined, reply: '嗯' }]);
        expect(normalizeFixedLines([])).toBeUndefined();
    });
    it('對方最新一句（跳過角色和非文字）', () => {
        expect(latestUserText([
            { role: 'user', content: '你會一直在嗎' },
            { role: 'user', content: 'data:image', type: 'image' },
            { role: 'assistant', content: '嗯' },
        ])).toBe('你會一直在嗎');
        expect(latestUserText([])).toBe('');
    });
});
