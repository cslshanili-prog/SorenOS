import { describe, expect, it } from 'vitest';
import type { UserProfile } from '../../types';
import { distinctGroupPersonaSection, groupMessagePersonaKey, groupPersonaMismatches, makeUserLineLabeler } from './memberPersona';

const base: UserProfile = {
    name: '小柔', avatar: '', bio: '',
    personas: [
        { id: 'p-xing', name: '小星', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
        { id: 'p-che', name: '阿澈', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
    ],
};

describe('群訊息的身份', () => {
    it('有記就用記的；舊訊息算目前的群身份', () => {
        expect(groupMessagePersonaKey({ metadata: { personaKey: 'p-xing' } }, 'p-che')).toBe('p-xing');
        expect(groupMessagePersonaKey({}, 'p-che')).toBe('p-che');
    });
    it('成員認識的那個你叫「用戶」；別的身份叫卡名並記下來', () => {
        const others: string[] = [];
        const label = makeUserLineLabeler(base, 'p-che', 'p-xing', others);
        expect(label({ metadata: { personaKey: 'p-xing' } })).toBe('用戶');
        expect(label({})).toBe('阿澈');
        expect(others).toEqual(['阿澈']);
    });
    it('說明段：兩個名字、時間線', () => {
        const text = distinctGroupPersonaSection({ groupUserName: '阿澈', knownName: '小星', timeline: '[群聊] 阿澈: 早' });
        expect(text).toContain('群裡的「阿澈」跟你私下聊天的「小星」是兩個不同的人');
        expect(text).toContain('[群聊] 阿澈: 早');
        expect(distinctGroupPersonaSection({ groupUserName: '阿澈', knownName: '小星', timeline: '' })).toContain('(暫無互動記錄)');
    });
});

describe('群設定的標示', () => {
    const profile: UserProfile = { ...base, perWorldPersonaIds: { fog: 'p-xing' }, perCharPersonaIds: { B: 'p-che' } };
    const chars = [{ id: 'A', name: 'A', groupId: 'fog' }, { id: 'A2', name: 'A2', groupId: 'fog' }, { id: 'B', name: 'B' }];
    it('群身份照成員多數；列出認識別的身份的成員', () => {
        const r = groupPersonaMismatches(profile, { id: 'g', members: ['A', 'A2', 'B', 'npc-1'] }, chars);
        expect(r.groupName).toBe('小星');
        expect(r.members).toEqual([{ id: 'B', name: 'B', knownName: '阿澈' }]);
    });
    it('沒有身份卡：沒有不一致', () => {
        expect(groupPersonaMismatches({ name: '小柔', avatar: '', bio: '' }, { id: 'g', members: ['A', 'B'] }, chars).members).toEqual([]);
    });
});
