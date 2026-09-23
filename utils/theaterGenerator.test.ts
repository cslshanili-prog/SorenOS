import { describe, it, expect } from 'vitest';
import { parseTheaterLines } from './theaterGenerator';

describe('parseTheaterLines', () => {
    it('解析標準「[氛圍] 文本」行，emotion 與 text 分離', () => {
        const raw = `[🚪] 她推開玻璃門，冷氣撲面。
[🎧] 耳機裡隨機到那首歌。
[😮‍💨] 「……算了。」她抹了把汗。`;
        const lines = parseTheaterLines(raw);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toEqual({ emotion: '🚪', text: '她推開玻璃門，冷氣撲面。' });
        expect(lines[2].emotion).toBe('😮‍💨');
        expect(lines[2].text).toBe('「……算了。」她抹了把汗。');
    });

    it('容忍全角方括號【】', () => {
        const lines = parseTheaterLines('【🙂】 她笑了一下。');
        expect(lines).toEqual([{ emotion: '🙂', text: '她笑了一下。' }]);
    });

    it('剝掉代碼圍欄並跳過空行 / 純分隔行', () => {
        const raw = '```\n[😌] 第一拍。\n\n---\n[🥱] 第二拍。\n```';
        const lines = parseTheaterLines(raw);
        expect(lines).toEqual([
            { emotion: '😌', text: '第一拍。' },
            { emotion: '🥱', text: '第二拍。' },
        ]);
    });

    it('沒帶氛圍標籤的行也保留為純文本（不丟內容）', () => {
        const lines = parseTheaterLines('她站在窗邊發呆。');
        expect(lines).toEqual([{ text: '她站在窗邊發呆。' }]);
    });

    it('空輸入返回空數組', () => {
        expect(parseTheaterLines('')).toEqual([]);
        expect(parseTheaterLines('   \n  \n')).toEqual([]);
    });
});
