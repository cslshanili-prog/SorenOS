import { describe, expect, it } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { buildGroupSideMessageNote, buildSideMessagePrompt, extractSideMessages, newSideBudget, resolveDmTarget, resolvePrivateTarget, sideTargets } from './sideMessage';

const profileBase = { name: '小星', avatar: '', bio: '', personas: [{ id: 'pB', name: '身份B', avatar: '', bio: '', createdAt: 1, updatedAt: 1 }] } as unknown as UserProfile;
const ch = (id: string, patch: Partial<CharacterProfile> = {}) => ({ id, name: id, description: '', systemPrompt: '', avatar: '', memories: [], ...patch }) as CharacterProfile;
const A = ch('阿澈', { groupId: 'w1', primaryPersonaKey: '__real__', knownPersonaKeys: ['__real__', 'pB'], relationships: [{ id: 'r', targetId: '老陳', description: '' }] });
const chars = [A, ch('小雨', { groupId: 'w1' }), ch('老陳', { groupId: 'w2' }), ch('路人', { groupId: 'w2' }), ch('夜航', { groupId: 'w1', altOf: '阿澈' }), ch('下戲', { groupId: 'w1', castRole: 'supporting', benchedAt: 1 })];

describe('能找誰', () => {
    it('認識的卡都算（不用在場）；角色是同世界＋關係清單，不含小號、下戲的', () => {
        const t = sideTargets(A, { characters: chars, profileBase, multiPersona: true });
        expect(t.personas.map(p => p.name)).toEqual(['小星', '身份B']);
        expect(t.chars.map(c => c.name)).toEqual(['老陳', '小雨']);
    });
    it('關係線關著：只有主線那張、不能私訊角色', () => {
        const t = sideTargets(A, { characters: chars, profileBase, multiPersona: false });
        expect(t.personas.map(p => p.name)).toEqual(['小星']);
        expect(t.chars).toEqual([]);
    });
    it('小號沒加你好友：不認識你', () => {
        expect(sideTargets(ch('夜航', { altOf: '阿澈', knownPersonaKeys: ['__real__'] }), { characters: chars, profileBase, multiPersona: true }).personas).toEqual([]);
    });
});

describe('落在哪', () => {
    const t = sideTargets(A, { characters: chars, profileBase, multiPersona: true });
    it('照名字；沒名字用在場那張，再沒有就只認識一張時那張', () => {
        expect(resolvePrivateTarget(A, { name: '身份B', targets: t })).toBe('pB');
        expect(resolvePrivateTarget(A, { name: '陌生人', targets: t })).toBeNull();
        expect(resolvePrivateTarget(A, { targets: t, fallbackKey: 'pB' })).toBe('pB');
        expect(resolvePrivateTarget(A, { targets: t })).toBeNull();
        expect(resolvePrivateTarget(A, { targets: { personas: [t.personas[0]], chars: [] } })).toBe('__real__');
    });
    it('拉黑中那條不落', () => {
        const blocked = { ...A, lines: { pB: { chatBlock: { by: 'user', since: 1 } } } } as unknown as CharacterProfile;
        expect(resolvePrivateTarget(blocked, { name: '身份B', targets: t })).toBeNull();
        const mainBlocked = { ...A, chatBlock: { by: 'char', since: 1 } } as unknown as CharacterProfile;
        expect(resolvePrivateTarget(mainBlocked, { name: '小星', targets: t })).toBeNull();
    });
    it('DM 照名單', () => {
        expect(resolveDmTarget(t, '「老陳」')).toBe('老陳');
        expect(resolveDmTarget(t, '路人')).toBeNull();
    });
    it('一輪各 1', () => {
        expect(newSideBudget()).toEqual({ private: 1, dm: 1 });
    });
});

describe('解析與提示詞', () => {
    it('兩種都剝掉', () => {
        const r = extractSideMessages('好啊\n[[PRIVATE|身份B: 你要出國？]]\n[[DM|老陳: 她生病了嗎]]\n[[PRIVATE: 晚點說]]');
        expect(r.cleanedText).toBe('好啊');
        expect(r.privates).toEqual([{ name: '身份B', content: '你要出國？' }, { content: '晚點說' }]);
        expect(r.dms).toEqual([{ to: '老陳', content: '她生病了嗎' }]);
        expect(extractSideMessages('沒事')).toEqual({ cleanedText: '沒事', privates: [], dms: [] });
    });
    it('私聊那段：排除現在說話的那張、對面那位；開關關著不教', () => {
        const t = sideTargets(A, { characters: chars, profileBase, multiPersona: true });
        const p = buildSideMessagePrompt({ targets: t, allowPrivate: true, allowDm: true, excludePersonaKey: '__real__', excludeCharId: '小雨' });
        expect(p).toContain('「身份B」');
        expect(p).not.toContain('「小星」');
        expect(p).toContain('「老陳」');
        expect(p).not.toContain('「小雨」');
        expect(buildSideMessagePrompt({ targets: t, allowPrivate: false, allowDm: false })).toBe('');
    });
    it('群聊那段：每位成員各一行', () => {
        const t = sideTargets(A, { characters: chars, profileBase, multiPersona: true });
        const n = buildGroupSideMessageNote({ members: [{ name: '阿澈', targets: t }, { name: '空', targets: { personas: [], chars: [] } }], allowPrivate: true, allowDm: true });
        expect(n).toContain('· 阿澈：私聊 「小星」、「身份B」；私訊 「老陳」、「小雨」');
        expect(n).not.toContain('· 空');
        expect(buildGroupSideMessageNote({ members: [{ name: '阿澈', targets: t }], allowPrivate: false, allowDm: false })).toBe('');
    });
});
