import { describe, it, expect } from 'vitest';
import { applyActivePersona, globalPersonaKey, personaKeyForChar, personaKeyForGroup, personaNameForKey, personaOverrideSource, REAL_IDENTITY_PERSONA_ID, resolveUserProfileForChar, resolveUserProfileForGroup } from './userPersona';
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

describe('resolveUserProfileForChar · 世界預設身份（角色分組）', () => {
    const char = { id: 'char-1', groupId: 'world-a' };
    const profile: UserProfile = { ...baseProfile, activePersonaId: 'p2', perWorldPersonaIds: { 'world-a': 'p1' } };

    it('分組有預設身份：蓋過全域默認', () => {
        expect(resolveUserProfileForChar(profile, char).name).toBe('林特工');
        expect(personaOverrideSource(profile, char)).toBe('world');
    });
    it('角色自己的指定蓋過世界預設', () => {
        const p: UserProfile = { ...profile, perCharPersonaIds: { 'char-1': 'p2' } };
        expect(resolveUserProfileForChar(p, char).name).toBe('阿凱');
        expect(personaOverrideSource(p, char)).toBe('char');
    });
    it('世界預設是真實身份：不管全域默認，並疊 perCharAvatars', () => {
        const p: UserProfile = { ...profile, perWorldPersonaIds: { 'world-a': REAL_IDENTITY_PERSONA_ID }, perCharAvatars: { 'char-1': 'chat-avatar.png' } };
        const result = resolveUserProfileForChar(p, char);
        expect(result.name).toBe('小柔');
        expect(result.avatar).toBe('chat-avatar.png');
    });
    it('別的分組、未分組的角色、只傳 charId 的舊調用：跟全域默認', () => {
        expect(resolveUserProfileForChar(profile, { id: 'char-2', groupId: 'world-b' }).name).toBe('阿凱');
        expect(resolveUserProfileForChar(profile, { id: 'char-3' }).name).toBe('阿凱');
        expect(resolveUserProfileForChar(profile, 'char-1').name).toBe('阿凱');
        expect(personaOverrideSource(profile, { id: 'char-3' })).toBe('global');
    });
    it('世界預設指向已刪的身份卡：回落全域默認', () => {
        const p: UserProfile = { ...profile, perWorldPersonaIds: { 'world-a': 'deleted' } };
        expect(resolveUserProfileForChar(p, char).name).toBe('阿凱');
    });
});

describe('身份鍵', () => {
    const profile: UserProfile = {
        ...baseProfile, activePersonaId: 'p2',
        perWorldPersonaIds: { 'world-a': 'p1' },
        perCharPersonaIds: { 'char-real': REAL_IDENTITY_PERSONA_ID, 'char-gone': 'deleted' },
        perGroupPersonaIds: { 'g1': 'p1', 'g2': REAL_IDENTITY_PERSONA_ID },
    };
    it('全域默認：目前身份卡，被刪了或沒設就是真實身份', () => {
        expect(globalPersonaKey(profile)).toBe('p2');
        expect(globalPersonaKey(baseProfile)).toBe(REAL_IDENTITY_PERSONA_ID);
        expect(globalPersonaKey({ ...baseProfile, activePersonaId: 'deleted' })).toBe(REAL_IDENTITY_PERSONA_ID);
    });
    it('角色：自己指定 > 世界 > 全域，刪掉的卡回落全域', () => {
        expect(personaKeyForChar(profile, { id: 'char-real', groupId: 'world-a' })).toBe(REAL_IDENTITY_PERSONA_ID);
        expect(personaKeyForChar(profile, { id: 'char-x', groupId: 'world-a' })).toBe('p1');
        expect(personaKeyForChar(profile, { id: 'char-x' })).toBe('p2');
        expect(personaKeyForChar(profile, { id: 'char-gone', groupId: 'world-a' })).toBe('p2');
    });
    it('群：群指定 > 全域', () => {
        expect(personaKeyForGroup(profile, 'g1')).toBe('p1');
        expect(personaKeyForGroup(profile, 'g2')).toBe(REAL_IDENTITY_PERSONA_ID);
        expect(personaKeyForGroup(profile, 'g3')).toBe('p2');
    });
    it('名字', () => {
        expect(personaNameForKey(profile, 'p1')).toBe('林特工');
        expect(personaNameForKey(profile, REAL_IDENTITY_PERSONA_ID)).toBe('小柔');
        expect(personaNameForKey(profile, 'deleted')).toBe('小柔');
    });
});
