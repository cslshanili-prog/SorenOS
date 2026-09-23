import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, SocialPost, UserProfile } from '../types';
import { buildSparkCommentHistory, buildSparkGenerationContext, resolveSparkAuthor, selectSparkParticipants } from './socialGeneration';

const character = (id: string, name: string, systemPrompt: string) => ({
    id, name, systemPrompt, avatar: '', description: '', memories: [], timeAwarenessEnabled: false,
} as CharacterProfile);
const a = character('a-id', '阿青', '我是安靜的園丁，只聊花草');
const b = character('b-id', 'Sully', '我是愛講冷笑話的程序員');
const c = character('c-id', '阿白', '不應傳入的第三人人設');
const chars = [a, b, c];
const handles = { 'a-id': [{ id: 'a', handle: '小花園', note: '主號' }], 'b-id': [{ id: 'b', handle: 'SullyDev', note: '技術號' }] };
const user = { name: '林雨', bio: '用戶是一名畫家', avatar: '' } as UserProfile;
const social = { name: '雨的帳號', bio: '畫畫日記', avatar: '' };
const resolve = (item: any, participants = [a, b]) => resolveSparkAuthor(item, participants, chars, handles, [user.name, social.name]);

describe('Spark persona and conversation context', () => {
    it('includes scoped personas, user identity mapping and only each participant’s recent messages', () => {
        const context = buildSparkGenerationContext([a, b], user, social, handles, {
            'a-id': [{ role: 'user', content: '明天去看花展' } as Message],
            'c-id': [{ role: 'user', content: '第三人的秘密' } as Message],
        });
        for (const text of [a.systemPrompt, b.systemPrompt, user.name, user.bio, social.name, '明天去看花展', 'a-id', 'b-id', '小花園', 'SullyDev']) {
            expect(context).toContain(text);
        }
        expect(context).not.toContain(c.systemPrompt);
        expect(context).not.toContain('第三人的秘密');
        expect(context).not.toContain('[System: Roleplay Configuration]');
        const aBlock = context.slice(context.indexOf('<<< 角色檔案 charId="a-id"'), context.indexOf('<<< 角色檔案結束 charId="a-id"'));
        expect(aBlock).toContain(a.systemPrompt);
        expect(aBlock).not.toContain(b.systemPrompt);
    });

    it('keeps the post author and recent interlocutors ahead of random candidates', () => {
        const post = { authorName: '小花園', authorType: 'character', authorCharId: 'a-id', comments: [
            { authorName: 'SullyDev', authorCharId: 'b-id', authorType: 'character', content: '你指的是週六那次嗎？' },
            { authorName: social.name, authorType: 'user', content: '對，就是那次' },
        ] } as SocialPost;
        expect(selectSparkParticipants(post, [c, b, a], handles).map(ch => ch.id)).toEqual(['a-id', 'b-id']);
        const history = buildSparkCommentHistory(post);
        expect(history).toContain('週六那次');
        expect(history).toContain('對，就是那次');
    });

    it('supports characters without saved Spark handles', () => {
        expect(buildSparkGenerationContext([c], user, social, {}).includes('阿白')).toBe(true);
        expect(resolve({ author: '阿白', charId: 'c-id' }, [c])?.character).toBe(c);
    });
});

describe('Spark author attribution', () => {
    it('rejects an ID that contradicts the handle instead of attaching the wrong avatar/persona', () => {
        expect(resolve({ authorName: '小花園', charId: 'b-id', isCharacter: true })).toBeNull();
        expect(resolve({ author: '小花園', charId: 'invented-id' })).toBeNull();
    });
    it('rejects unselected characters, user impersonation and strangers using character handles', () => {
        expect(resolve({ author: '阿白', charId: 'c-id' })).toBeNull();
        expect(resolve({ author: ' 林雨 ' })).toBeNull();
        expect(resolve({ author: social.name })).toBeNull();
        expect(resolve({ author: '小花園', isCharacter: false })).toBeNull();
    });
    it('accepts unambiguous legacy handle-only output and preserves canonical names', () => {
        expect(resolve({ author: ' sullydev ' })).toEqual({ name: 'SullyDev', character: b });
        expect(resolve({ author: '新來的路人', charId: null })).toEqual({ name: '新來的路人' });
    });
    it('requires the matching ID when two roles share a handle', () => {
        const duplicate = { ...handles, 'b-id': [{ id: 'b', handle: '小花園', note: '' }] };
        expect(resolveSparkAuthor({ author: '小花園' }, [a, b], chars, duplicate, [])).toBeNull();
        expect(resolveSparkAuthor({ author: '小花園', charId: 'b-id' }, [a, b], chars, duplicate, [])?.character).toBe(b);
    });
});
