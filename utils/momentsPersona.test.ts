import { describe, expect, it } from 'vitest';
import type { MomentPost, UserProfile } from '../types';
import { buildFriendGraph, canViewMoment, actorDisplayName, visibleComments, USER_ID } from './momentsPool';
import { buildPersonaKnowledge, interactionPersonaOptions } from './momentsPersona';
import { REAL_IDENTITY_PERSONA_ID } from './userPersona';

// 霧港世界用小星（p-xing），A 在霧港；B 單獨指定阿澈（p-che）；C 沒指定、沒分組 → 全域默認（真實身份）
const base: UserProfile = {
    name: '小柔', avatar: '', bio: '',
    personas: [
        { id: 'p-xing', name: '小星', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
        { id: 'p-che', name: '阿澈', avatar: '', bio: '', createdAt: 0, updatedAt: 0 },
    ],
    perWorldPersonaIds: { fog: 'p-xing' },
    perCharPersonaIds: { B: 'p-che' },
    perGroupPersonaIds: { g1: 'p-che' },
};
const chars = [{ id: 'A', name: 'A', groupId: 'fog' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }];
// 群 g1：A、B 都在，群身份是阿澈 → A 見過阿澈
const groups = [{ id: 'g1', members: ['A', 'B'] }];
const knowledge = buildPersonaKnowledge(base, chars, groups);
const graph = buildFriendGraph(chars, [], knowledge);

const post = (personaKey: string | undefined, mode: 'friends' | 'public' = 'friends'): MomentPost => ({
    id: 'p', author: { kind: 'user', id: USER_ID, name: 'x', ...(personaKey ? { personaKey } : {}) },
    content: 'hi', images: [], visibility: { mode }, likes: [], comments: [], createdAt: 1, source: 'manual',
});

describe('身份知識', () => {
    it('主身份與見過的身份', () => {
        expect(knowledge.mainKeyOf('A')).toBe('p-xing');
        expect(knowledge.mainKeyOf('B')).toBe('p-che');
        expect(knowledge.mainKeyOf('C')).toBe(REAL_IDENTITY_PERSONA_ID);
        expect([...knowledge.seenKeysOf('A')]).toEqual(['p-che']);
        expect([...knowledge.seenKeysOf('B')]).toEqual([]); // 群身份就是 B 的主身份
        expect(graph.personaRelation!('A', 'p-che')).toBe('seen');
        expect(graph.personaRelation!('C', 'p-che')).toBe('stranger');
    });
});

describe('朋友圈可見範圍', () => {
    it('主身份發的「朋友可見」：看得到；別的身份的：看不到', () => {
        expect(canViewMoment('A', post('p-xing'), graph)).toBe(true);
        expect(canViewMoment('B', post('p-xing'), graph)).toBe(false);
        expect(canViewMoment('A', post('p-che'), graph)).toBe(false); // 見過＝群友，不是好友
        expect(canViewMoment('B', post('p-che'), graph)).toBe(true);
    });
    it('公開的：誰都看得到（陌生人也是）', () => {
        expect(canViewMoment('C', post('p-che', 'public'), graph)).toBe(true);
    });
    it('舊貼文（沒身份鍵）：所有角色都認識', () => {
        expect(canViewMoment('A', post(undefined), graph)).toBe(true);
        expect(canViewMoment('C', post(undefined), graph)).toBe(true);
    });
    it('沒帶身份資料的好友圖：跟以前一樣', () => {
        const plain = buildFriendGraph(chars, []);
        expect(canViewMoment('B', post('p-xing'), plain)).toBe(true);
    });
    it('用別的身份留的言：只有作者看得到', () => {
        const charPost: MomentPost = {
            ...post(undefined), author: { kind: 'character', id: 'B', name: 'B' },
            comments: [{ id: 'c1', actor: { kind: 'user', id: USER_ID, name: '阿澈', personaKey: 'p-che' }, content: '在嗎', at: 2 }],
        };
        expect(visibleComments('B', charPost, graph)).toHaveLength(1); // 作者
        expect(visibleComments('C', charPost, graph)).toHaveLength(0);
    });
    it('名字：有身份鍵用那張卡的名字，舊資料用看的人認識的名字', () => {
        expect(actorDisplayName(post('p-che').author, chars, [], '小星', graph)).toBe('阿澈');
        expect(actorDisplayName(post(undefined).author, chars, [], '小星', graph)).toBe('小星');
    });
});

describe('留言時可選的身份', () => {
    const charPost = (id: string) => ({ author: { kind: 'character' as const, id, name: id } });
    it('主身份在前，再來是見過的', () => {
        expect(interactionPersonaOptions(charPost('A'), knowledge, REAL_IDENTITY_PERSONA_ID)).toEqual(['p-xing', 'p-che']);
        expect(interactionPersonaOptions(charPost('C'), knowledge, REAL_IDENTITY_PERSONA_ID)).toEqual([REAL_IDENTITY_PERSONA_ID]);
    });
    it('自己的貼文：用發文那個身份', () => {
        expect(interactionPersonaOptions(post('p-che'), knowledge, REAL_IDENTITY_PERSONA_ID)).toEqual(['p-che']);
        expect(interactionPersonaOptions(post(undefined), knowledge, 'p-xing')).toEqual(['p-xing']);
    });
});

describe('私聊注入的最近的朋友圈', () => {
    it('公開貼文用別的身份發：用那張卡的名字，並提醒是不同的人；朋友可見的不放', async () => {
        const { buildMomentsContextForChar } = await import('./momentsContext');
        const now = 10_000;
        const posts = [
            { ...post('p-che', 'public'), id: 'x1', createdAt: now - 10 },
            { ...post('p-che'), id: 'x2', content: '朋友可見的', createdAt: now - 20 },
        ];
        const text = buildMomentsContextForChar({ charId: 'A', posts, characters: chars, npcs: [], graph, userName: '小星', now });
        expect(text).toContain('阿澈發的');
        expect(text).not.toContain('朋友可見的');
        expect(text).toContain('跟你私下聊天的「小星」是不同的人');
    });
});
