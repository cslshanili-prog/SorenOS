import { describe, expect, it } from 'vitest';
import type { MomentPost } from '../types';
import { buildFriendGraph } from './momentsPool';
import { buildMomentsContextForChar, MOMENTS_CONTEXT_MAX_POSTS, MOMENTS_CONTEXT_WINDOW_MS } from './momentsContext';

const chars = [{ id: 'a', name: '小雨' }, { id: 'b', name: '阿澤' }];
const npcs = [{ id: 'n1', name: '房東', relationships: [] }];
const graph = buildFriendGraph(chars, npcs);
const post = (id: string, authorId: string, createdAt: number, patch: Partial<MomentPost> = {}): MomentPost => ({
    id, author: { kind: authorId === 'user' ? 'user' : 'character', id: authorId, name: authorId }, content: `內容${id}`,
    images: [], visibility: { mode: 'friends' }, likes: [], comments: [], createdAt, source: 'manual', ...patch,
});
const base = { characters: chars, npcs, graph, userName: '小安' };

describe('私聊裡的最近的朋友圈', () => {
    it('沒有看得到的最近貼文：空字串', () => {
        expect(buildMomentsContextForChar({ ...base, charId: 'a', posts: [], now: 0 })).toBe('');
        const old = post('1', 'user', 0);
        expect(buildMomentsContextForChar({ ...base, charId: 'a', posts: [old], now: MOMENTS_CONTEXT_WINDOW_MS + 1 })).toBe('');
    });

    it('自己發的寫「你發的」，別人的寫名字；帶上看得到的讚和留言', () => {
        const now = 10_000;
        const text = buildMomentsContextForChar({
            ...base, charId: 'a', now,
            posts: [
                post('1', 'user', now - 1000, {
                    images: ['x'],
                    likes: [{ actor: { kind: 'character', id: 'a', name: '小雨' }, at: 1 }],
                    comments: [{ id: 'c', actor: { kind: 'character', id: 'a', name: '小雨' }, content: '好看', at: 1 }],
                }),
                post('2', 'a', now - 2000),
            ],
        });
        expect(text).toContain('【最近的朋友圈】');
        expect(text).toContain('小安發的（1 張照片）：「內容1」（讚：你；留言：你：好看）');
        expect(text).toContain('你發的：「內容2」');
    });

    it('最多幾篇、新的在前；看不到的（別的角色、不是朋友）不帶', () => {
        const now = 100_000;
        const posts = Array.from({ length: 8 }, (_, i) => post(String(i), 'user', now - i * 1000));
        posts.push(post('b1', 'b', now));
        const text = buildMomentsContextForChar({ ...base, charId: 'a', posts, now });
        expect(text.split('\n').filter(l => l.startsWith('- ')).length).toBe(MOMENTS_CONTEXT_MAX_POSTS);
        expect(text).not.toContain('內容b1');
        expect(text.indexOf('內容0')).toBeLessThan(text.indexOf('內容1'));
    });
});
