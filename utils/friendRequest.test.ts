import { describe, expect, it } from 'vitest';
import { buildFriendRequestPrompt, faceForPersona, parseFriendDecision } from './friendRequest';
import type { UserProfile } from '../types';

describe('加好友', () => {
    it('提示詞只給對外的樣子和招呼；被拒過的，他看得到次數和上次說了什麼', () => {
        const p = buildFriendRequestPrompt({
            charName: '阿澈', face: { name: '老婆', bio: '喜歡貓' }, greeting: '你好呀',
            history: [{ at: 1, greeting: '在嗎', accepted: false, reply: '不認識' }, { at: 2, greeting: '再加一次', accepted: false }],
        });
        expect(p).toContain('對方的名字：老婆');
        expect(p).toContain('喜歡貓');
        expect(p).toContain('「你好呀」');
        expect(p).toContain('加過你 2 次');
        expect(p).toContain('上一次的招呼是「再加一次」');
        expect(buildFriendRequestPrompt({ charName: '阿澈', face: { name: 'X' }, greeting: '', history: [] })).toContain('對方沒有附任何招呼');
    });
    it('解析決定：認得字串 true；格式不對回 null', () => {
        expect(parseFriendDecision({ accept: 'true', reply: ' 嗨 ' })).toEqual({ accepted: true, reply: '嗨' });
        expect(parseFriendDecision({ accept: false })).toEqual({ accepted: false, reply: '' });
        expect(parseFriendDecision({ reply: '嗨' })).toBeNull();
        expect(parseFriendDecision(null)).toBeNull();
    });
    it('對外的樣子：身份卡用卡的，真實身份用自己的', () => {
        const base = { name: '妹妹', avatar: '', bio: '真實', personas: [{ id: 'pB', name: '老婆', avatar: '', bio: '卡的', createdAt: 0, updatedAt: 0 }] } as unknown as UserProfile;
        expect(faceForPersona(base, 'pB', '__real__')).toMatchObject({ name: '老婆', bio: '卡的' });
        expect(faceForPersona(base, '__real__', '__real__')).toMatchObject({ name: '妹妹', bio: '真實' });
    });
});

describe('不認識你的角色：先加好友還是直接聊', () => {
    const base = { personas: [{ id: 'pB', name: 'B' }], activePersonaId: 'pB' } as unknown as UserProfile;
    it('認識就直接開；不認識看開關（沒設＝開）', async () => {
        const { strangerAction, knowPersonaDirectly } = await import('./friendRequest');
        expect(strangerAction({ knownPersonaKeys: ['pB'], primaryPersonaKey: 'pB' }, base)).toBe('open');
        expect(strangerAction({ knownPersonaKeys: ['__real__'], primaryPersonaKey: '__real__' }, base)).toBe('befriend');
        expect(strangerAction({ knownPersonaKeys: ['__real__'] }, { ...base, friendRequestRequired: false })).toBe('direct');
        // 小號走自己的好友流程，不擋
        expect(strangerAction({ knownPersonaKeys: [], altOf: 'x' }, base)).toBe('open');
        expect(knowPersonaDirectly({ knownPersonaKeys: ['a'] }, 'pB')).toEqual({ knownPersonaKeys: ['a', 'pB'] });
        expect(knowPersonaDirectly({ knownPersonaKeys: ['pB'] }, 'pB')).toEqual({ knownPersonaKeys: ['pB'] });
    });
});
