import { describe, expect, it } from 'vitest';
import { formatPairContext } from './pairContext';
import { memberVisibleGroupMessages } from './groupChat/presence';
import { buildSideMessagePrompt } from './sideMessage';

const m = (ts: number, speaker: string, content: string) => ({ timestamp: ts, content, charId: 'pair~c1~c3', metadata: { pairSpeakerId: speaker } });

describe('你私下跟別人聊的', () => {
    it('照時間排、標跟誰、自己的寫「你」', () => {
        const text = formatPairContext({
            selfId: 'c1', selfName: '阿澈', formatDate: ts => `T${ts}`,
            sources: [
                { otherName: '林小姐', msgs: [m(1, 'c3', '明天家宴別遲到'), m(3, 'c1', '知道了')] },
                { otherName: '小雨', msgs: [m(2, 'c2', '哥你在哪')] },
            ],
        });
        expect(text).toContain('用戶不在場');
        const lines = text.trim().split('\n').filter(l => l.startsWith('[T'));
        expect(lines).toEqual([
            '[T1] [跟林小姐私聊] 林小姐: 明天家宴別遲到',
            '[T2] [跟小雨私聊] 小雨: 哥你在哪',
            '[T3] [跟林小姐私聊] 你（阿澈）: 知道了',
        ]);
    });
    it('沒有就是空字串', () => {
        expect(formatPairContext({ selfId: 'c1', selfName: '阿澈', formatDate: String, sources: [] })).toBe('');
    });
});

describe('群裡只給你看的那行', () => {
    it('角色看不到「某某私訊了某某」', () => {
        const msgs = [{ role: 'system', metadata: { userOnly: true } }, { role: 'assistant', metadata: {} }] as any[];
        expect(memberVisibleGroupMessages(msgs, false)).toHaveLength(1);
    });
    it('私訊的規則只在開著時教', () => {
        const targets = { personas: [], chars: [{ id: 'b', name: '小雨' }] };
        expect(buildSideMessagePrompt({ targets, allowPrivate: true, allowDm: false })).toBe('');
        expect(buildSideMessagePrompt({ targets, allowPrivate: true, allowDm: true })).toContain('[[DM|名字: 內容]]');
    });
});
