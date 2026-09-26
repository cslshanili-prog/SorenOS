import { describe, expect, it } from 'vitest';
import { characterVoice, relationToAuthor, voiceSnippet } from './momentsVoice';
import { isMomentSkip } from './momentsReply';
import { buildBatchCommentPrompt } from './momentsAuto';

describe('朋友圈留言的人設片段', () => {
    it('優先挑講個性和說話方式的句子，不再只截開頭的世界觀', () => {
        const systemPrompt = '這是一個賽博龐克城市，霓虹燈下的雨永遠不停。財團控制一切。你是其中一名駭客。性格冷淡、話少，懶得回別人訊息。說話簡短，常常只回一個字。喜歡黑咖啡。';
        const voice = characterVoice({ description: '', systemPrompt });
        expect(voice).toContain('話少');
        expect(voice).toContain('說話簡短');
        expect(voice).not.toContain('霓虹燈');
    });

    it('一句都沒講到個性就退回開頭', () => {
        expect(voiceSnippet(['只是一段普通介紹。'])).toBe('只是一段普通介紹。');
        expect(voiceSnippet([undefined, ''])).toBe('');
    });
});

describe('跟發文的人什麼關係', () => {
    const characters = [
        { id: 'a', charViewRelationship: '戀人', phoneState: { contacts: [{ id: 'c1', name: 'B', kind: 'real' as const, status: 'friend' as const, linkedCharId: 'b', identity: '大學室友', note: '常借錢' }] } },
    ];
    const npcs = [{ id: 'n', relationships: [{ id: 'r', targetId: 'user', description: '樓下的房東' }] }];
    it('用戶的貼文看角色認為的關係、角色的貼文看通訊錄、NPC 看自己的關係清單', () => {
        expect(relationToAuthor({ commenterId: 'a', authorId: 'user', characters, npcs } as any)).toBe('戀人');
        expect(relationToAuthor({ commenterId: 'a', authorId: 'b', characters, npcs } as any)).toBe('大學室友，常借錢');
        expect(relationToAuthor({ commenterId: 'n', authorId: 'user', characters, npcs } as any)).toBe('樓下的房東');
        expect(relationToAuthor({ commenterId: 'n', authorId: 'b', characters, npcs } as any)).toBe('');
    });
});

describe('提示詞', () => {
    it('批次留言：帶關係、允許不留、話量守則', () => {
        const p = buildBatchCommentPrompt({
            authorName: '我', userName: '我', post: { content: '今天好累', images: [] }, thread: '',
            commenters: [{ id: 'a', name: 'Sully', brief: '話少', relation: '戀人' }],
        });
        expect(p).toContain('跟我的關係：戀人');
        expect(p).toContain('不要寫進陣列');
        expect(p).toContain('哈哈哈');
    });

    it('作者回覆可以選擇不回', () => {
        expect(isMomentSkip('[[SKIP]]')).toBe(true);
        expect(isMomentSkip(' [[ skip ]] ')).toBe(true);
        expect(isMomentSkip('嗯')).toBe(false);
    });
});
