import { afterEach, describe, expect, it, vi } from 'vitest';
import type { XhsOwnedPost } from '../types';
import * as agenticTools from './agenticTools';
import { applyAssistantPostProcessing, type PostProcessCtx, type XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';
import { XhsMcpClient } from './xhsMcpClient';

const xhsConfig = {
    xhsMcpConfig: { enabled: true, serverUrl: 'https://xhs-lite.test' },
} as any;

const makeCtx = (characterId: string, latestUserText = '在嗎'): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char: { id: characterId, name: '測試角色', xhsEnabled: true } as any,
        userProfile: { name: '用戶' } as any,
        emojis: [],
        realtimeConfig: xhsConfig,
        contextMsgs: [],
        fullMessages: [{ role: 'user', content: latestUserText }],
        initialData: {},
        historyMsgCount: 1,
        xhsCaches,
        api: {
            baseUrl: 'https://llm.test/v1',
            headers: {},
            effectiveApi: { baseUrl: 'https://llm.test/v1', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
        instantRender: true,
    };
};

const fakeLLMResponse = (content: string) => ({
    ok: true,
    status: 200,
    headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
});

const ownedPost = (
    characterId: string,
    noteId: string,
    title: string,
    publishedAt: number,
): XhsOwnedPost => ({
    id: `${characterId}:${noteId}`,
    characterId,
    noteId,
    title,
    body: `${title}的正文`,
    publishedAt,
    updatedAt: publishedAt,
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('普通聊天與角色小紅書主頁的閉環', () => {
    it('首輪聊天發帖成功後保存精確 note_id', async () => {
        const suffix = `${Date.now()}-${Math.random()}`;
        const characterId = `chat-post-${suffix}`;
        const noteId = `note-${suffix}`;
        vi.spyOn(XhsMcpClient, 'publishNote').mockResolvedValue({
            success: true,
            data: { note_id: noteId },
        } as any);

        await applyAssistantPostProcessing(
            '我發啦\n[[XHS_POST: 晚安碎碎念 | 今天也辛苦了 | #晚安 #日常]]',
            makeCtx(characterId),
        );

        expect(await DB.getXhsOwnedPosts(characterId)).toEqual([
            expect.objectContaining({
                characterId,
                noteId,
                title: '晚安碎碎念',
                body: '今天也辛苦了',
                tags: ['晚安', '日常'],
            }),
        ]);
    });

    it('隔幾輪說“剛才那個帖子”時，只從當前角色主頁選候選並用精確 ID 查詳情', async () => {
        const suffix = `${Date.now()}-${Math.random()}`;
        const characterId = `chat-profile-${suffix}`;
        const otherCharacterId = `other-profile-${suffix}`;
        await DB.saveXhsOwnedPost(ownedPost(characterId, 'older-note', '海邊散步', 100));
        await DB.saveXhsOwnedPost(ownedPost(characterId, 'newest-note', '晚安碎碎念', 300));
        await DB.saveXhsOwnedPost(ownedPost(otherCharacterId, 'foreign-note', '同一帳號的別人帖子', 400));

        const prompts: string[] = [];
        const llmReplies = [
            '我去看看\n[[XHS_DETAIL: newest-note]]',
            '看到了，評論區有新留言。',
        ];
        vi.spyOn(globalThis, 'fetch' as any).mockImplementation((async (_url: any, init: any) => {
            const body = JSON.parse(String(init?.body || '{}'));
            prompts.push(String(body.messages?.at(-1)?.content || ''));
            return fakeLLMResponse(llmReplies.shift() || '看到了') as any;
        }) as any);
        const profileFallback = vi.spyOn(agenticTools, 'runXhsMyProfile');
        const detail = vi.spyOn(agenticTools, 'runXhsDetail').mockResolvedValue({
            ok: true,
            noteId: 'newest-note',
            detailText: '標題：晚安碎碎念\n評論區：\ncommentId=c-1 用戶：真可愛',
            commentsUnavailable: false,
        } as any);

        await applyAssistantPostProcessing(
            '[[XHS_MY_PROFILE]]',
            makeCtx(characterId, '欸你看看剛才那個帖子評論區'),
        );

        expect(profileFallback).not.toHaveBeenCalled();
        expect(prompts[0]).toContain('[noteId=newest-note]');
        expect(prompts[0].indexOf('[noteId=newest-note]')).toBeLessThan(prompts[0].indexOf('[noteId=older-note]'));
        expect(prompts[0]).not.toContain('foreign-note');
        expect(detail).toHaveBeenCalledWith(
            { noteId: 'newest-note' },
            expect.objectContaining({ char: expect.objectContaining({ id: characterId }) }),
        );
    });

    it('查看主頁後二輪發帖也會寫入角色主頁', async () => {
        const suffix = `${Date.now()}-${Math.random()}`;
        const characterId = `profile-post-${suffix}`;
        const noteId = `second-round-${suffix}`;
        vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue(
            fakeLLMResponse('[[XHS_POST: 新帖子 | 從主頁看完後發的 | #日常]]') as any,
        );
        vi.spyOn(XhsMcpClient, 'publishNote').mockResolvedValue({
            success: true,
            data: { noteId },
        } as any);

        await applyAssistantPostProcessing('[[XHS_MY_PROFILE]]', makeCtx(characterId, '看看我的主頁'));

        expect(await DB.getXhsOwnedPosts(characterId)).toEqual([
            expect.objectContaining({ characterId, noteId, title: '新帖子' }),
        ]);
    });
});
