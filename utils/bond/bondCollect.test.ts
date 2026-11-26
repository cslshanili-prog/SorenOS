import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import {
    buildCollectSnippet, buildMomentPickPrompt, buildMomentSummaryPrompt, cleanSummary, defaultEventDate, extendSelection,
    lineArgFromKey, messagePlainText, numberedTranscript, parseMomentPick, unscannedMessages,
} from './collect';

const msg = (id: number, role: 'user' | 'assistant', content: string, over: Partial<Message> = {}): Message =>
    ({ id, charId: 'c1', role, type: 'text', content, timestamp: 1000 + id, ...over } as Message);
const nameOf = (m: Pick<Message, 'role'>) => (m.role === 'user' ? 'Liora' : 'Sully');

describe('線的鍵拆回讀訊息的參數', () => {
    it('主線是 charId，其他線拆成 ChatLine', () => {
        expect(lineArgFromKey('c1')).toBe('c1');
        expect(lineArgFromKey('c1::p2')).toEqual({ charId: 'c1', personaKey: 'p2' });
    });
});

describe('訊息文字', () => {
    it('雙語只取原文、拿掉標籤', () => {
        expect(messagePlainText(msg(1, 'assistant', '早安[[ACTION:POKE]]\n%%BILINGUAL%%\nGood morning'))).toBe('早安');
    });
    it('非文字寫成標記', () => {
        expect(messagePlainText(msg(1, 'user', 'blob:xx', { type: 'image' }))).toBe('[圖片]');
    });
    it('原文快照：名字＋內容，一則一行，太長截斷', () => {
        const out = buildCollectSnippet([msg(1, 'user', '要不要去看海'), msg(2, 'assistant', '好啊')], nameOf);
        expect(out).toBe('Liora：要不要去看海\nSully：好啊');
        expect(buildCollectSnippet([msg(1, 'user', 'x'.repeat(50)), msg(2, 'user', 'y'.repeat(50))], nameOf, 60)).toContain('…');
    });
});

describe('往前往後多帶', () => {
    const all = [1, 2, 3, 4, 5, 6].map(id => ({ id }));
    it('照整條線的順序延伸', () => {
        expect(extendSelection(all, [3, 4], 1, 2)).toEqual([2, 3, 4, 5, 6]);
        expect(extendSelection(all, [1], 3, 0)).toEqual([1]);
    });
    it('選到的不在線上（被刪了）也保留', () => {
        expect(extendSelection(all, [9], 1, 1)).toEqual([9]);
    });
});

describe('預設日期', () => {
    it('第一則那天；讀不到就不明', () => {
        expect(defaultEventDate(['2026-05-01'])).toEqual({ precision: 'day', date: '2026-05-01' });
        expect(defaultEventDate([])).toEqual({ precision: 'unknown' });
    });
});

describe('AI 摘要與挑選', () => {
    it('摘要只寫事實', () => {
        const p = buildMomentSummaryPrompt({ snippet: 'Liora：去看海', leftName: 'Liora', rightName: 'Sully' });
        expect(p).toContain('不加感想');
        expect(cleanSummary('「摘要：兩人約好去看海。」')).toBe('兩人約好去看海。');
    });
    it('挑選：編號換回訊息 id，對不上的丟掉', () => {
        const msgs = [msg(10, 'user', 'a'), msg(11, 'assistant', 'b'), msg(12, 'user', 'c')];
        const transcript = numberedTranscript(msgs, nameOf);
        expect(transcript).toBe('#1 Liora：a\n#2 Sully：b\n#3 Liora：c');
        expect(buildMomentPickPrompt({ transcript, leftName: 'Liora', rightName: 'Sully' })).toContain('只輸出 JSON 陣列');
        const out = parseMomentPick('好的```json\n[{"title":"約定","text":"說好去看海","refs":[1,2,9]},{"title":"空的","text":""}]\n```', msgs);
        expect(out).toEqual([{ title: '約定', text: '說好去看海', messageIds: [10, 11] }]);
        expect(parseMomentPick('不是 JSON', msgs)).toEqual([]);
    });
    it('只挑上次之後的', () => {
        const msgs = [msg(3, 'user', 'c'), msg(1, 'user', 'a'), msg(2, 'user', 'b')];
        expect(unscannedMessages(msgs, 1).map(m => m.id)).toEqual([2, 3]);
        expect(unscannedMessages(msgs, undefined, 2).map(m => m.id)).toEqual([2, 3]);
    });
});
