import { describe, it, expect } from 'vitest';
import { applyActivePersona, REAL_IDENTITY_PERSONA_ID, resolveUserProfileForChar, resolveUserProfileForGroup } from './userPersona';
import type { UserProfile } from '../types';

const baseProfile: UserProfile = {
    name: '小柔',
    avatar: 'avatar-real.png',
    bio: '真實身份的簡介',
    personas: [
        { id: 'p1', name: '林特工', avatar: 'avatar-p1.png', bio: '臥底特工人設', createdAt: 0, updatedAt: 0 },
        { id: 'p2', name: '阿凱', avatar: 'avatar-p2.png', bio: '街頭少年人設', createdAt: 0, updatedAt: 0 },
    ],
};

describe('applyActivePersona', () => {
    it('沒有 activePersonaId 時原樣返回真實身份', () => {
        expect(applyActivePersona(baseProfile)).toEqual(baseProfile);
    });

    it('activePersonaId 命中時，name/avatar/bio 換成身份卡的，其餘字段不變', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p1', vrState: { enabled: true } };
        const result = applyActivePersona(profile);
        expect(result.name).toBe('林特工');
        expect(result.avatar).toBe('avatar-p1.png');
        expect(result.bio).toBe('臥底特工人設');
        // 其餘字段原樣保留，包括 personas 本身和 activePersonaId
        expect(result.personas).toBe(profile.personas);
        expect(result.activePersonaId).toBe('p1');
        expect(result.vrState).toEqual({ enabled: true });
    });

    it('activePersonaId 指向已被刪除的身份卡時，原樣返回（不崩潰）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'deleted-id' };
        expect(applyActivePersona(profile)).toEqual(profile);
    });

    it('personas 為空數組時，activePersonaId 命中不了任何東西，原樣返回', () => {
        const profile: UserProfile = { ...baseProfile, personas: [], activePersonaId: 'p1' };
        expect(applyActivePersona(profile)).toEqual(profile);
    });
});

describe('resolveUserProfileForChar', () => {
    it('沒有任何指定時，回落全域默認（真實身份）', () => {
        const result = resolveUserProfileForChar(baseProfile, 'char-1');
        expect(result.name).toBe('小柔');
        expect(result.avatar).toBe('avatar-real.png');
    });

    it('沒有分角色指定時，回落全域默認身份卡（activePersonaId）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2' };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('阿凱');
        expect(result.avatar).toBe('avatar-p2.png');
    });

    it('分角色指定了某張身份卡時，不管全域默認是什麼，這個角色都用指定的那張', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perCharPersonaIds: { 'char-1': 'p1' } };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('林特工');
        expect(result.avatar).toBe('avatar-p1.png');
        expect(result.bio).toBe('臥底特工人設');
        // 沒被指定的其他角色仍然吃全域默認，互不影響
        expect(resolveUserProfileForChar(profile, 'char-2').name).toBe('阿凱');
    });

    it('分角色指定 REAL_IDENTITY_PERSONA_ID 時，強制真實身份，不管全域默認是哪張卡', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perCharPersonaIds: { 'char-1': REAL_IDENTITY_PERSONA_ID } };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('小柔');
        expect(result.avatar).toBe('avatar-real.png');
    });

    it('分角色指定的身份卡已被刪除時，回落全域默認（不崩潰）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perCharPersonaIds: { 'char-1': 'deleted-id' } };
        const result = resolveUserProfileForChar(profile, 'char-1');
        expect(result.name).toBe('阿凱');
    });

    it('指定了具體身份卡時不疊加 perCharAvatars——一個身份只對應一個頭像', () => {
        const profile: UserProfile = {
            ...baseProfile,
            perCharAvatars: { 'char-1': 'avatar-override.png' },
            perCharPersonaIds: { 'char-1': 'p1' },
        };
        expect(resolveUserProfileForChar(profile, 'char-1').avatar).toBe('avatar-p1.png');
    });

    it('強制真實身份或走全域默認時，仍然疊加 perCharAvatars（先於身份卡存在的機制）', () => {
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
    it('沒有任何指定時，回落全域默認（真實身份）', () => {
        expect(resolveUserProfileForGroup(baseProfile, 'group-1').name).toBe('小柔');
    });

    it('沒有群聊指定時，回落全域默認身份卡（activePersonaId）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2' };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('阿凱');
    });

    it('群聊指定了某張身份卡時，不管全域默認是什麼，這個群都用指定的那張；其他群不受影響', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perGroupPersonaIds: { 'group-1': 'p1' } };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('林特工');
        expect(resolveUserProfileForGroup(profile, 'group-2').name).toBe('阿凱');
    });

    it('群聊指定 REAL_IDENTITY_PERSONA_ID 時，強制真實身份，不管全域默認是哪張卡', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perGroupPersonaIds: { 'group-1': REAL_IDENTITY_PERSONA_ID } };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('小柔');
    });

    it('群聊指定的身份卡已被刪除時，回落全域默認（不崩潰）', () => {
        const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perGroupPersonaIds: { 'group-1': 'deleted-id' } };
        expect(resolveUserProfileForGroup(profile, 'group-1').name).toBe('阿凱');
    });

    it('不受 perCharAvatars 影響——群聊沒有那一層', () => {
        const profile: UserProfile = { ...baseProfile, perCharAvatars: { 'group-1': 'avatar-override.png' } };
        expect(resolveUserProfileForGroup(profile, 'group-1').avatar).toBe('avatar-real.png');
    });

    it('perCharPersonaIds 和 perGroupPersonaIds 是兩個獨立的 map，同一個 id 不會互相干擾', () => {
        const profile: UserProfile = {
            ...baseProfile,
            perCharPersonaIds: { 'same-id': 'p1' },
            perGroupPersonaIds: { 'same-id': 'p2' },
        };
        expect(resolveUserProfileForChar(profile, 'same-id').name).toBe('林特工');
        expect(resolveUserProfileForGroup(profile, 'same-id').name).toBe('阿凱');
    });
});
