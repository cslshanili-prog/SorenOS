import { describe, expect, it } from 'vitest';
import type { MomentActor, MomentPost, NPCProfile, PhoneContact, TrajectoryMomentPost } from '../types';
import {
    actorDisplayName, actorFor, addCommentTo, buildFriendGraph, canViewMoment, displayLikeCount, migratedMomentId,
    migrateTrajectoryMoment, momentFeedFor, pendingMigrations, toggleLikeOn, visibleComments, visibleLikes,
} from './momentsPool';

const contact = (patch: Partial<PhoneContact>): PhoneContact => ({ id: `ct-${Math.random()}`, name: 'x', kind: 'real', status: 'friend', ...patch } as PhoneContact);
const char = (id: string, contacts: PhoneContact[] = []) => ({ id, name: id, phoneState: { contacts } });
const npc = (id: string, targets: string[]): NPCProfile => ({
    id, name: id, avatar: '', description: '', createdAt: 0, updatedAt: 0,
    relationships: targets.map((t, i) => ({ id: `r${i}`, targetId: t, description: '' })),
});
const actor = (id: string, kind: MomentActor['kind'] = 'character'): MomentActor => ({ kind, id, name: id });
const post = (authorId: string, patch: Partial<MomentPost> = {}): MomentPost => ({
    id: `p-${authorId}`, author: actor(authorId, authorId === 'user' ? 'user' : authorId.startsWith('n') ? 'npc' : 'character'),
    content: 'hi', images: [], visibility: { mode: 'friends' }, likes: [], comments: [], createdAt: 1, source: 'manual', ...patch,
});

describe('朋友關係', () => {
    const graph = buildFriendGraph(
        [
            char('a', [contact({ linkedCharId: 'b', status: 'friend' })]),
            char('b'),
            char('c', [contact({ linkedCharId: 'a', status: 'blocked' })]),
            char('d', [contact({ kind: 'npc', linkedNpcId: 'n2', status: 'friend' })]),
        ],
        [npc('n1', ['user', 'a']), npc('n2', [])],
    );

    it('用戶跟所有角色都是朋友；跟 NPC 看 NPC 的關係清單', () => {
        expect(graph.areFriends('user', 'b')).toBe(true);
        expect(graph.areFriends('n1', 'user')).toBe(true);
        expect(graph.areFriends('user', 'n2')).toBe(false);
    });

    it('角色之間單向就算；拉黑優先', () => {
        expect(graph.areFriends('a', 'b')).toBe(true);
        expect(graph.areFriends('b', 'a')).toBe(true);
        expect(graph.areFriends('b', 'd')).toBe(false);
        expect(graph.areFriends('a', 'c')).toBe(false);
    });

    it('角色和 NPC：NPC 的關係清單，或角色通訊錄綁了這個 NPC', () => {
        expect(graph.areFriends('a', 'n1')).toBe(true);
        expect(graph.areFriends('n2', 'd')).toBe(true);
        expect(graph.areFriends('b', 'n1')).toBe(false);
        expect(graph.areFriends('n1', 'n2')).toBe(false);
        expect(graph.kindOf('n1')).toBe('npc');
        expect(graph.kindOf('a')).toBe('character');
    });
});

describe('誰看得到貼文', () => {
    const graph = buildFriendGraph([char('a', [contact({ linkedCharId: 'b' })]), char('b'), char('c')], [npc('n1', ['a'])]);

    it('朋友可見、公開、指定', () => {
        expect(canViewMoment('b', post('a'), graph)).toBe(true);
        expect(canViewMoment('c', post('a'), graph)).toBe(false);
        expect(canViewMoment('a', post('a'), graph)).toBe(true);
        expect(canViewMoment('c', post('a', { visibility: { mode: 'public' } }), graph)).toBe(true);
        const custom = post('a', { visibility: { mode: 'custom', allow: ['c'] } });
        expect(canViewMoment('c', custom, graph)).toBe(true);
        expect(canViewMoment('b', custom, graph)).toBe(false);
        expect(canViewMoment('user', post('n1'), graph)).toBe(false);
    });

    it('時間線：只留看得到的，新的在前', () => {
        const feed = momentFeedFor('user', [post('a', { id: '1', createdAt: 1 }), post('n1', { id: '2', createdAt: 3 }), post('b', { id: '3', createdAt: 2 })], graph);
        expect(feed.map(p => p.id)).toEqual(['3', '1']);
    });
});

describe('互動（微信式）', () => {
    const graph = buildFriendGraph([char('a'), char('b')], [npc('n1', ['a'])]);
    const p = post('a', {
        likes: [{ actor: actor('user', 'user'), at: 1 }, { actor: actor('n1', 'npc'), at: 2 }, { actor: actor('b'), at: 3 }],
        comments: [
            { id: 'c1', actor: actor('n1', 'npc'), content: '房東來了', at: 1 },
            { id: 'c2', actor: actor('a'), content: '作者回', at: 2 },
            { id: 'c3', actor: { kind: 'stranger', name: '路人' }, content: '好看', at: 3 },
        ],
        legacyLikeCount: 10,
    });

    it('用戶跟 NPC 不是朋友：看不到 NPC 的讚和留言；作者和路人的看得到', () => {
        expect(visibleLikes('user', p, graph).map(l => l.actor.id)).toEqual(['user', 'b']);
        expect(visibleComments('user', p, graph).map(c => c.id)).toEqual(['c2', 'c3']);
        expect(displayLikeCount('user', p, graph)).toBe(12);
    });

    it('作者自己看得到朋友 NPC 的互動', () => {
        expect(visibleComments('a', p, graph).map(c => c.id)).toEqual(['c1', 'c2', 'c3']);
    });
});

describe('改動', () => {
    it('按讚再按一次取消；留言同 id 不重複', () => {
        const liked = toggleLikeOn(post('a'), actor('user', 'user'), 5);
        expect(liked.likes).toHaveLength(1);
        expect(toggleLikeOn(liked, actor('user', 'user')).likes).toHaveLength(0);
        const comment = { id: 'x', actor: actor('b'), content: '嗨', at: 1 };
        const once = addCommentTo(post('a'), comment);
        expect(addCommentTo(once, comment).comments).toHaveLength(1);
    });

    it('參與者：名字快照與展示名', () => {
        expect(actorFor('user', [], [], '小安')).toEqual({ kind: 'user', id: 'user', name: '小安' });
        expect(actorFor('n1', [], [{ id: 'n1', name: '房東' }], '')).toEqual({ kind: 'npc', id: 'n1', name: '房東' });
        expect(actorFor('ghost', [], [], '')).toBeNull();
        expect(actorDisplayName(actor('a'), [{ id: 'a', name: '改名了' }], [], '')).toBe('改名了');
        expect(actorDisplayName({ kind: 'character', id: 'gone', name: '舊名' }, [], [], '')).toBe('舊名');
    });
});

describe('搬遷', () => {
    const old: TrajectoryMomentPost = {
        id: 't1', timestamp: 100, content: '今天好熱', image: 'blobref:abc', imagePrompt: 'sunny',
        likes: 88, comments: [{ id: 'k1', authorName: '路人甲', content: '真的' }], syncedMessageId: 7,
    };

    it('舊貼文轉成池子裡的：作者、朋友可見、假讚數、路人留言、同步記錄都帶過去', () => {
        const p = migrateTrajectoryMoment({ id: 'a', name: '小雨' }, old);
        expect(p).toMatchObject({
            id: migratedMomentId('t1'), author: { kind: 'character', id: 'a', name: '小雨' },
            images: ['blobref:abc'], imagePrompt: 'sunny', visibility: { mode: 'friends' },
            legacyLikeCount: 88, createdAt: 100, source: 'migrated', syncedMessageId: 7,
        });
        expect(p.comments[0]).toMatchObject({ actor: { kind: 'stranger', name: '路人甲' }, content: '真的', at: 100 });
    });

    it('已經在池子裡的跳過', () => {
        const chars = [{ id: 'a', name: '小雨', phoneState: { records: [], trajectoryMoments: [old, { ...old, id: 't2' }] } }] as any;
        expect(pendingMigrations(chars, new Set(['mig-t1'])).map(p => p.id)).toEqual(['mig-t2']);
        expect(pendingMigrations(chars, new Set(['mig-t1', 'mig-t2']))).toEqual([]);
    });
});
