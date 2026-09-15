import { describe, it, expect } from 'vitest';
import { applyActivePersona, REAL_IDENTITY_PERSONA_ID, resolveUserProfileForChar, resolveUserProfileForGroup } from './userPersona';
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

describe('resolveUserProfileForChar', () => {
    it('没有任何指定时，回落全域默认（真实身份）', () => {
        const result = resolveUserProfileForChar(baseProfile, 'char-1');
        expect(result.name).toBe('小柔');
        expect(result.avatar).toBe('avatar-real.png');
    });

    it('没有分角色指定时，回落全域默认身份卡（activePersonaId）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2' };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('阿凯');
        expect(result.avatar).toBe('avatar-p2.png');
    });

    it('分角色指定了某张身份卡时，不管全域默认是什么，这个角色都用指定的那张', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perCharPersonaIds: { 'char-1': 'p1' } };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('林特工');
        expect(result.avatar).toBe('avatar-p1.png');
        expect(result.bio).toBe('卧底特工人设');
        // 没被指定的其他角色仍然吃全域默认，互不影响
        expect(resolveUserProfileForChar(profile, 'char-2').name).toBe('阿凯');
    });

    it('分角色指定 REAL_IDENTITY_PERSONA_ID 时，强制真实身份，不管全域默认是哪张卡', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perCharPersonaIds: { 'char-1': REAL_IDENTITY_PERSONA_ID } };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('小柔');
        expect(result.avatar).toBe('avatar-real.png');
    });

    it('分角色指定的身份卡已被删除时，回落全域默认（不崩溃）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perCharPersonaIds: { 'char-1': 'deleted-id' } };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('阿凯');
    });

    it('指定了具体身份卡时不叠加 perCharAvatars——一个身份只对应一个头像', () => {
        const profile: UserProfile = {
            ...baseProfile,
            perCharAvatars: { 'char-1': 'avatar-override.png' },
            perCharPersonaIds: { 'char-1': 'p1' },
        };
        expect(resolveUserProfileForChar(profile, 'char-1').avatar).toBe('avatar-p1.png');
    });

    it('强制真实身份或走全域默认时，仍然叠加 perCharAvatars（先于身份卡存在的机制）', () => {
        const forcedReal: UserProfile = {
            ...baseProfile,
            perCharAvatars: { 'char-1': 'avatar-override.png' },
            perCharPersonaIds: { 'char-1': REAL_IDENTITY_PERSONA_ID },
        };
        expect(resolveUserProfileForChar(forcedReal, 'char-1').avatar).toBe('avatar-override.png');

        const noOverride: UserProfile = { ...baseProfile, perCharAvatars: { 'char-1': 'avatar-override.png' } };
        expect(resolveUserProfileForChar(noOverride, 'char-1').avatar).toBe('avatar-override.png');
    });
});

describe('resolveUserProfileForGroup', () => {
    it('没有任何指定时，回落全域默认（真实身份）', () => {
        expect(resolveUserProfileForGroup(baseProfile, 'group-1').name).toBe('小柔');
    });

    it('没有群聊指定时，回落全域默认身份卡（activePersonaId）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2' };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('阿凯');
    });

    it('群聊指定了某张身份卡时，不管全域默认是什么，这个群都用指定的那张；其他群不受影响', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perGroupPersonaIds: { 'group-1': 'p1' } };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('林特工');
        expect(resolveUserProfileForGroup(profile, 'group-2').name).toBe('阿凯');
    });

    it('群聊指定 REAL_IDENTITY_PERSONA_ID 时，强制真实身份，不管全域默认是哪张卡', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perGroupPersonaIds: { 'group-1': REAL_IDENTITY_PERSONA_ID } };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('小柔');
    });

    it('群聊指定的身份卡已被删除时，回落全域默认（不崩溃）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perGroupPersonaIds: { 'group-1': 'deleted-id' } };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('阿凯');
    });

    it('不受 perCharAvatars 影响——群聊没有那一层', () => {
        const profile: UserProfile = { ...baseProfile, perCharAvatars: { 'group-1': 'avatar-override.png' } };
        expect(resolveUserProfileForGroup(profile, 'group-1').avatar).toBe('avatar-real.png');
    });

    it('perCharPersonaIds 和 perGroupPersonaIds 是两个独立的 map，同一个 id 不会互相干扰', () => {
        const profile: UserProfile = {
            ...baseProfile,
            perCharPersonaIds: { 'same-id': 'p1' },
            perGroupPersonaIds: { 'same-id': 'p2' },
        };
        expect(resolveUserProfileForChar(profile, 'same-id').name).toBe('林特工');
        expect(resolveUserProfileForGroup(profile, 'same-id').name).toBe('阿凯');
    });
});
