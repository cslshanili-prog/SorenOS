import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { isPairLineId, messagesFromPhoneRecord, newPairMessages, pairLineId, pairOtherId, pairSpeakerOf, pairTranscript, parsePairLineId } from './pairLine';
import { nextOpener } from './pairChatRun';

const msg = (id: number, speaker: string, content: string) =>
    ({ id, charId: pairLineId('c1', 'c2'), role: 'assistant', type: 'text', content, timestamp: id, metadata: { pairSpeakerId: speaker } } as Message);

describe('線 id', () => {
    it('不分順序、只存一份', () => {
        expect(pairLineId('c2', 'c1')).toBe(pairLineId('c1', 'c2'));
        expect(pairLineId('c1', 'c2')).toBe('pair~c1~c2');
        expect(isPairLineId('pair~c1~c2')).toBe(true);
        expect(isPairLineId('c1')).toBe(false);
    });
    it('拆回兩個角色、另一頭是誰', () => {
        expect(parsePairLineId('pair~c1~c2')).toEqual(['c1', 'c2']);
        expect(parsePairLineId('c1')).toBeNull();
        expect(pairOtherId('pair~c1~c2', 'c2')).toBe('c1');
        expect(pairOtherId('pair~c1~c2', 'c9')).toBeNull();
    });
});

describe('腳本', () => {
    const msgs = [msg(1, 'c1', '在嗎'), msg(2, 'c2', '在'), msg(3, 'c2', '怎麼了')];
    it('照看的人分「我／對方」', () => {
        expect(pairTranscript(msgs, 'c1')).toBe('我: 在嗎\n對方: 在\n對方: 怎麼了');
        expect(pairTranscript(msgs, 'c2')).toBe('對方: 在嗎\n我: 在\n我: 怎麼了');
        expect(pairSpeakerOf(msgs[0])).toBe('c1');
    });
    it('引擎回來的完整腳本只取這一輪新說的', () => {
        const out = newPairMessages({ pairId: 'pair~c1~c2', aId: 'c1', bId: 'c2', aDetail: '我: 在嗎\n對方: 在\n我: 晚上吃飯？\n對方: 好', existingLines: 2, now: 100 });
        expect(out.map(m => [m.metadata?.pairSpeakerId, m.content, m.timestamp])).toEqual([['c1', '晚上吃飯？', 100], ['c2', '好', 101]]);
        expect(out[0].charId).toBe('pair~c1~c2');
    });
    it('舊的查手機紀錄拆成訊息，時間往前排開', () => {
        const out = messagesFromPhoneRecord({ pairId: 'pair~c1~c2', ownerId: 'c2', partnerId: 'c1', detail: '我: 嗨\n對方: 你好', recordTimestamp: 600_000 });
        expect(out.map(m => [m.metadata?.pairSpeakerId, m.content, m.timestamp])).toEqual([['c2', '嗨', 540_000], ['c1', '你好', 600_000]]);
    });
    it('這一輪誰先開口：最後說話的換另一個', () => {
        expect(nextOpener([], 'c1', 'c2')).toEqual(['c1', 'c2']);
        expect(nextOpener([msg(1, 'c1', 'x')], 'c1', 'c2')).toEqual(['c2', 'c1']);
        expect(nextOpener([msg(1, 'c2', 'x')], 'c1', 'c2')).toEqual(['c1', 'c2']);
    });
});
