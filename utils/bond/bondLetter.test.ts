import { describe, expect, it } from 'vitest';
import type { BondRecord } from '../../types';
import {
    arriveLetter, awaitingReply, dueLetters, editLetter, formatBondLetterRecord, letterMeta, letterThread, lettersExchanged, lettersForUser,
    markLetterRead, newLetter, outputSlowDays, sendLetter, unreadForUser,
} from './letter';
import { bondPromptBlock } from './prompt';

const DAY = 86400_000;
const T = 1_800_000_000_000;

describe('信件：寄出、慢寄、送達、已讀', () => {
    it('草稿可以改，寄出就不能改；馬上到的寄出就到，角色收的到了就算讀了', () => {
        const d = newLetter({ bondId: 'b', author: 'user', to: 'c1', text: '第一封', now: T });
        expect(d.status).toBe('draft');
        const d2 = editLetter(d, { text: '改過的第一封', signature: '你的 L' }, T + 1);
        expect(d2.text).toBe('改過的第一封');
        const s = sendLetter(d2, 0, T + 2);
        expect(s.letter).toMatchObject({ sentAt: T + 2, arrivedAt: T + 2, readAt: T + 2, signature: '你的 L' });
        expect(editLetter(s, { text: 'x' }).text).toBe('改過的第一封');
    });
    it('慢寄：到 deliverAt 才投遞；你收的要打開才算讀', () => {
        const s = sendLetter(newLetter({ bondId: 'b', author: 'c1', to: 'user', text: '慢慢寄給你', now: T }), 2, T);
        expect(s.letter!.arrivedAt).toBeUndefined();
        expect(lettersForUser([s])).toEqual([]);
        expect(dueLetters([s], T + DAY)).toEqual([]);
        expect(dueLetters([s], T + 2 * DAY).map(e => e.id)).toEqual([s.id]);
        const a = arriveLetter(s, T + 2 * DAY);
        expect(lettersForUser([a]).map(e => e.id)).toEqual([a.id]);
        expect(unreadForUser([a])).toHaveLength(1);
        expect(unreadForUser([markLetterRead(a, T + 3 * DAY)])).toHaveLength(0);
    });
    it('回信串、等你回、交換了幾封', () => {
        const a = sendLetter(newLetter({ bondId: 'b', author: 'user', to: 'c1', text: '你好嗎', now: T }), 0, T);
        expect(awaitingReply([a], a)).toBe(true);
        const r = sendLetter(newLetter({ bondId: 'b', author: 'c1', to: 'user', text: '很好', replyTo: a.id, now: T + 1 }), 0, T + 1);
        const draft = newLetter({ bondId: 'b', author: 'user', to: 'c1', text: '草稿', replyTo: r.id, now: T + 2 });
        expect(awaitingReply([a, r], a)).toBe(false);
        expect(letterThread([a, r, draft], draft.id, 'user').map(e => e.text)).toEqual(['你好嗎', '很好', '草稿']);
        expect(letterThread([a, r, draft], a.id, 'char').map(e => e.text)).toEqual(['你好嗎', '很好']);
        expect(lettersExchanged([a, r, draft])).toBe(2);
    });
    it('TA 主動寫的信：同一封算出來的慢寄天數永遠一樣', () => {
        expect(outputSlowDays('x1')).toBe(outputSlowDays('x1'));
        expect(outputSlowDays('x1')).toBeLessThanOrEqual(3);
    });
    it('聊天小卡的記錄：你慢寄的信角色知道在路上、不知道內容', () => {
        const s = sendLetter(newLetter({ bondId: 'b', author: 'user', to: 'c1', text: '秘密的內容', now: T }), 3, T);
        const rec = formatBondLetterRecord(letterMeta(s, 'sent'));
        expect(rec).toContain('不知道內容');
        expect(rec).not.toContain('秘密');
    });
});

describe('提示詞【你們的珍藏】信件', () => {
    const bond = { id: 'b', kind: 'persona', charId: 'c1', personaKey: 'p1', stage: 'friend', openedAt: 1, openedBy: 'auto', routeLog: [], days: {} } as unknown as BondRecord;
    it('草稿、你寄的還在路上的：一字不差', () => {
        const base = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' });
        const draft = newLetter({ bondId: 'b', author: 'user', to: 'c1', text: '草稿', now: T });
        const slow = sendLetter(newLetter({ bondId: 'b', author: 'user', to: 'c1', text: '慢', now: T }), 3, T);
        expect(bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [draft, slow], selfId: 'c1' })).toBe(base);
    });
    it('寄到了的帶進去、等你回的標出來；你寄的在路上的你記得', () => {
        const a = sendLetter(newLetter({ bondId: 'b', author: 'user', to: 'c1', text: '想你了', now: T }), 0, T);
        const mineSlow = sendLetter(newLetter({ bondId: 'b', author: 'c1', to: 'user', text: '下雪了', now: T + 1 }), 2, T + 1);
        const out = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [a, mineSlow], selfId: 'c1' });
        expect(out).toContain('Liora寫給你：「想你了」（Liora在等你回信）');
        expect(out).toContain('你寄給Liora的一封信還在路上');
    });
});
