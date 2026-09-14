import { describe, it, expect } from 'vitest';
import { applyActivePersona } from './userPersona';
import type { UserProfile } from '../types';

const baseProfile: UserProfile = {
    name: '小柔',
    avatar: 'avatar-real.png',
    bio: '真实身份的简介',
    personas: [
        { id: 'p1', name: '林特工', avatar: 'avatar-p1.png', bio: '卧底特工人设', createdAt: 0, updatedAt: 0 },
        { id: 'p2', name: '阿凯', avatar: 'avatar-p2.png', bio: '街头少年人设', createdAt: 0, updatedAt: 0 },
    ],
};

describe('applyActivePersona', () => {
    it('没有 activePersonaId 时原样返回真实身份', () => {
        expect(applyActivePersona(baseProfile)).toEqual(baseProfile);
    });

    it('activePersonaId 命中时，name/avatar/bio 换成身份卡的，其余字段不变', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p1', vrState: { enabled: true } };
        const result = applyActivePersona(profile);
        expect(result.name).toBe('林特工');
        expect(result.avatar).toBe('avatar-p1.png');
        expect(result.bio).toBe('卧底特工人设');
        // 其余字段原样保留，包括 personas 本身和 activePersonaId
        expect(result.personas).toBe(profile.personas);
        expect(result.activePersonaId).toBe('p1');
        expect(result.vrState).toEqual({ enabled: true });
    });

    it('activePersonaId 指向已被删除的身份卡时，原样返回（不崩溃）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'deleted-id' };
        expect(applyActivePersona(profile)).toEqual(profile);
    });

    it('personas 为空数组时，activePersonaId 命中不了任何东西，原样返回', () => {
        const profile: UserProfile = { ...baseProfile, personas: [], activePersonaId: 'p1' };
        expect(applyActivePersona(profile)).toEqual(profile);
    });
});
