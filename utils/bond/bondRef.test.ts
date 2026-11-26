import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { bondRefFromEssay, bondRefFromItem, bondRefOf, bondRefPrefix, formatBondRefContent } from './bondRef';
import { buildTimeline } from './timeline';
import { normalizeMessageContent } from '../messageFormat';

const items = buildTimeline({
    bond: undefined,
    entries: [{ id: 'mo1', bondId: 'c1::p1', kind: 'moment', author: 'user', title: '海邊', text: '晚上一起去海邊走走，他帶了外套。', eventDate: { precision: 'day', date: '2026-05-01' }, writtenAt: 1, sources: [], links: [], status: 'published', createdBy: 'user', updatedAt: 1 }],
    memories: { charId: 'c1', list: [{ id: 'm1', date: '2026-05-03', summary: '一起吃了烤魷魚。' }] },
});

describe('帶去聊聊的歷史寫法', () => {
    it('片刻：〈片刻〉標題——摘要，後面接你說的話', () => {
        const ref = bondRefFromItem('c1::p1', items.find(i => i.key === 'e:mo1')!);
        expect(ref).toMatchObject({ kind: 'moment', itemKey: 'e:mo1', title: '海邊' });
        expect(formatBondRefContent('你還記得嗎', ref)).toBe('[從羈絆帶來：〈片刻〉海邊——晚上一起去海邊走走，他帶了外套。] 你還記得嗎');
    });
    it('記憶沒有標題就只寫摘要；隨筆標是誰寫的', () => {
        const mem = bondRefFromItem('c1::p1', items.find(i => i.key === 'm:m1')!);
        expect(bondRefPrefix(mem)).toBe('[從羈絆帶來：〈記憶〉一起吃了烤魷魚。]');
        const essay = bondRefFromEssay('c1::p1', { id: 'es1', title: '', text: 'x'.repeat(100) } as any, 'Sully');
        expect(bondRefPrefix(essay)).toMatch(/^\[從羈絆帶來：〈隨筆〉（Sully寫的）x{80}…\]$/);
    });
    it('沒帶卡原樣；角色的訊息不算', () => {
        expect(formatBondRefContent('嗨', null)).toBe('嗨');
        const ref = bondRefFromItem('c1::p1', items[0]);
        expect(bondRefOf({ role: 'assistant', type: 'text', metadata: { bondRef: ref } } as any)).toBeNull();
    });
    it('記憶、歸檔看到的一樣（normalizeMessageContent）', () => {
        const ref = bondRefFromItem('c1::p1', items.find(i => i.key === 'e:mo1')!);
        const m = { id: 1, charId: 'c1', role: 'user', type: 'text', content: '你還記得嗎', timestamp: 1, metadata: { bondRef: ref } } as Message;
        expect(normalizeMessageContent(m, 'Sully', 'Liora')).toBe(formatBondRefContent('你還記得嗎', ref));
        expect(normalizeMessageContent({ ...m, metadata: { bondRef: ref, userVoice: { via: 'typed' } } }, 'Sully', 'Liora')).toBe(`${bondRefPrefix(ref)} [語音] 你還記得嗎`);
    });
});
