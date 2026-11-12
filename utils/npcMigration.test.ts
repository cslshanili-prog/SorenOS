import { describe, expect, it } from 'vitest';
import type { GroupProfile, MomentPost, NPCProfile, PhoneContact, StoryTheaterEntry, UserProfile } from '../types';
import { migrateContacts, migrateGroup, migrateMomentPost, migrateTheater, npcToCharacter, pendingNpcs } from './npcMigration';
import { castRelationLines, formatCastRelationsBlock } from './castRelations';

const base = { name: '我', avatar: '', bio: '', personas: [{ id: 'pA', name: '小星', avatar: '', bio: '', createdAt: 0, updatedAt: 0 }] } as unknown as UserProfile;
const npc = (extra: Partial<NPCProfile> = {}): NPCProfile => ({
    id: 'n1', name: '林小姐', avatar: 'av', description: '阿澈的聯姻對象。冷靜、守規矩。', relationships: [{ id: 'r1', targetId: 'c1', description: '聯姻對象' }],
    createdAt: 1, updatedAt: 2, ...extra,
});
const moved = new Set(['n1']);

describe('NPC → 配角', () => {
    it('欄位照搬，人設進核心指令、第一句當簡介，主動消息不開', () => {
        const c = npcToCharacter(npc({ groupId: 'w1', worldview: '民國', knownPersonaId: 'pA', chatApi: { baseUrl: 'u', apiKey: 'k', model: 'm' } }), base, []);
        expect(c).toMatchObject({ id: 'n1', name: '林小姐', avatar: 'av', castRole: 'supporting', groupId: 'w1', worldview: '民國', primaryPersonaKey: 'pA', knownPersonaKeys: ['pA'] });
        expect(c.systemPrompt).toBe('阿澈的聯姻對象。冷靜、守規矩。');
        expect(c.description).toBe('阿澈的聯姻對象。');
        expect(c.relationships).toEqual([{ id: 'r1', targetId: 'c1', description: '聯姻對象' }]);
        expect(c.chatApi?.model).toBe('m');
        expect(c.activeMsg2Config).toBeUndefined();
    });
    it('輕量記憶變成一筆長期記憶', () => {
        const c = npcToCharacter(npc({ memory: '- 跟阿澈吃過一次飯', memoryUpdatedAt: new Date(2026, 9, 3).getTime() }), base, []);
        expect(Object.entries(c.refinedMemories || {})).toEqual([['2026-10（搬家前的記憶）', '- 跟阿澈吃過一次飯']]);
    });
    it('搬過的不再列出來', () => {
        expect(pendingNpcs([npc(), npc({ id: 'n2', migratedToCharAt: 5 })]).map(n => n.id)).toEqual(['n1']);
    });
});

describe('引用改寫', () => {
    it('群：NPC 成員併進成員', () => {
        const g = { id: 'g', name: 'g', members: ['c1'], npcMemberIds: ['n1', 'n9'], createdAt: 0 } as GroupProfile;
        expect(migrateGroup(g, moved)).toMatchObject({ members: ['c1', 'n1'], npcMemberIds: ['n9'] });
        expect(migrateGroup({ ...g, npcMemberIds: ['n9'] }, moved)).toBeNull();
        const all = migrateGroup({ ...g, npcMemberIds: ['n1'] }, moved)!;
        expect('npcMemberIds' in all).toBe(false);
    });
    it('查手機：綁了 NPC 的聯繫人改成真角色', () => {
        const contacts = [
            { id: 'x', name: '林小姐', kind: 'npc', linkedNpcId: 'n1', affinity: 10, status: 'friend', createdAt: 0 },
            { id: 'y', name: '路人', kind: 'npc', affinity: 0, status: 'friend', createdAt: 0 },
        ] as PhoneContact[];
        const out = migrateContacts(contacts, moved)!;
        expect(out[0]).toMatchObject({ kind: 'real', linkedCharId: 'n1', affinity: 10 });
        expect('linkedNpcId' in out[0]).toBe(false);
        expect(out[1]).toBe(contacts[1]);
        expect(migrateContacts([contacts[1]], moved)).toBeNull();
    });
    it('朋友圈：NPC 作者、按讚、留言改成角色', () => {
        const post = {
            id: 'p', author: { kind: 'npc', id: 'n1', name: '林小姐' }, content: '', createdAt: 0,
            likes: [{ actor: { kind: 'npc', id: 'n1', name: '林小姐' }, at: 0 }],
            comments: [{ id: 'k', actor: { kind: 'character', id: 'c1', name: '阿澈' }, content: '嗯', at: 0 }],
        } as unknown as MomentPost;
        const out = migrateMomentPost(post, moved)!;
        expect(out.author.kind).toBe('character');
        expect(out.likes[0].actor.kind).toBe('character');
        expect(out.comments[0].actor.kind).toBe('character');
        expect(migrateMomentPost({ ...post, author: { kind: 'user', name: '我' }, likes: [] } as unknown as MomentPost, moved)).toBeNull();
    });
    it('劇情劇場：客串併進演員', () => {
        const t = { id: 't', characterIds: ['c1'], npcIds: ['n1'] } as unknown as StoryTheaterEntry;
        expect(migrateTheater(t, moved)).toMatchObject({ characterIds: ['c1', 'n1'], npcIds: [] });
    });
});

describe('你身邊的人', () => {
    const names: Record<string, string> = { c1: '阿澈', n1: '林小姐' };
    const nameOf = (id: string) => names[id];
    it('自己的關係清單、別人記到你的都列', () => {
        const others = [{ id: 'n1', name: '林小姐', relationships: [{ targetId: 'c1', description: '聯姻對象' }] }];
        expect(castRelationLines({ char: { id: 'c1' }, others, nameOf, userName: '小星' })).toEqual(['「林小姐」跟你：聯姻對象']);
        expect(castRelationLines({ char: { id: 'n1', relationships: [{ id: 'r', targetId: 'c1', description: '聯姻對象' }, { id: 'u', targetId: 'user', description: '只見過一面' }] }, others, nameOf, userName: '小星' }))
            .toEqual(['跟「阿澈」：聯姻對象', '跟「小星」：只見過一面']);
    });
    it('兩邊都記了：對方那邊的加括號', () => {
        const others = [{ id: 'n1', name: '林小姐', relationships: [{ targetId: 'c1', description: '聯姻對象' }] }];
        expect(castRelationLines({ char: { id: 'c1', relationships: [{ id: 'r', targetId: 'n1', description: '不想娶的人' }] }, others, nameOf, userName: '小星' }))
            .toEqual(['跟「林小姐」：不想娶的人', '（「林小姐」那邊記的是：聯姻對象）']);
    });
    it('刪掉的角色不列；沒有就是空字串', () => {
        expect(formatCastRelationsBlock({ char: { id: 'c1', relationships: [{ id: 'r', targetId: 'gone', description: 'x' }] }, others: [], nameOf, userName: '小星' })).toBe('');
    });
});
