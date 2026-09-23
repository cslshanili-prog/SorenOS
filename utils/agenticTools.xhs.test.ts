import { afterEach, describe, expect, it, vi } from 'vitest';
import { runXhsDetail, type XhsCaches } from './agenticTools';
import { XhsMcpClient } from './xhsMcpClient';
import { buildToolResultMessage } from './agenticToolFeedback';

describe('runXhsDetail', () => {
    afterEach(() => vi.restoreAllMocks());

    it('exposes Lite interactions/comments to the role and enriches the share card with one request', async () => {
        const getDetail = vi.spyOn(XhsMcpClient, 'getNoteDetail').mockResolvedValue({
            success: true,
            data: {
                data: {
                    note: {
                        note_id: 'note-1',
                        title: '完整標題',
                        desc: '完整正文',
                        user: { user_id: 'author-1', nickname: '樓主' },
                        interact_info: {
                            liked_count: '1.2萬',
                            collected_count: '345',
                            comment_count: '2',
                            share_count: '8',
                        },
                    },
                    comments: {
                        list: [{
                            comment_id: 'comment-1',
                            content: '一級評論',
                            user: { user_id: 'user-1', nickname: '甲' },
                            sub_comments: [{
                                comment_id: 'comment-2',
                                content: '回覆內容',
                                user_info: { user_id: 'user-2', nickname: '乙' },
                            }],
                        }],
                    },
                },
            },
        });
        const caches: XhsCaches = {
            xsecTokenCache: new Map([['note-1', 'token-1']]),
            noteTitleCache: new Map([['note-1', '搜索標題']]),
            commentUserIdCache: new Map(),
            commentAuthorNameCache: new Map(),
            commentParentIdCache: new Map(),
        };
        const lastXhsNotesRef = {
            current: [{
                noteId: 'note-1',
                title: '搜索標題',
                desc: '搜索摘要',
                likes: 1,
                author: '樓主',
                authorId: 'author-1',
                xsecToken: 'token-1',
            }],
        };

        const result = await runXhsDetail(
            { noteId: 'note-1' },
            {
                char: { xhsEnabled: true } as any,
                userProfile: {} as any,
                realtimeConfig: {
                    xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs' },
                } as any,
                xhsCaches: caches,
                lastXhsNotesRef,
            },
        );

        expect(getDetail).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && result.detailText).toContain('12000贊 345收藏 2評論 8分享');
        expect(result.ok && result.detailText).toContain('甲: 一級評論');
        expect(result.ok && result.detailText).toContain('乙: 回覆內容');
        expect(caches.commentUserIdCache.get('comment-1')).toBe('user-1');
        expect(caches.commentUserIdCache.get('comment-2')).toBe('user-2');
        expect(caches.commentParentIdCache.get('comment-2')).toBe('comment-1');
        expect(lastXhsNotesRef.current[0]).toMatchObject({
            noteId: 'note-1',
            title: '完整標題',
            desc: '完整正文',
            likes: 12_000,
            commentCount: 2,
            comments: [
                { author: '甲', content: '一級評論' },
                { author: '乙', content: '回覆內容' },
            ],
        });
    });

    // 迴歸守衛：詳情一個字都沒拿回來時，以前回的是 ok:true 外加一段「[加載失敗: …]」的正文。
    // 護欄（NEVER_RAN_REASONS）只認 ok:false，這條失敗於是被當成正常結果餵給模型——輕則
    // 把報錯原文抄進消息裡，重則直接說「我點開看了這條筆記」。
    it('詳情拿不回來時算這次沒跑成，不再包成"成功但正文是一句報錯"', async () => {
        vi.spyOn(XhsMcpClient, 'getNoteDetail').mockResolvedValue({
            success: false,
            error: 'connect ECONNREFUSED 127.0.0.1:18060',
        } as any);

        const result = await runXhsDetail(
            { noteId: 'note-404' },
            {
                char: { xhsEnabled: true } as any,
                userProfile: {} as any,
                realtimeConfig: {
                    xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs' },
                } as any,
            },
        );

        expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
        const feedback = buildToolResultMessage({
            name: 'xhs_detail',
            result,
            history: [{ name: 'xhs_detail', fingerprint: 'a' }],
        });
        expect(feedback).toContain('這件事**沒有發生**');
    });

    // 同上：服務器回了 200、正文卻是一句報錯，也是"這次沒讀到筆記"。
    // 以前這條包成 ok:true 外加一個 failed 標誌，護欄只認 ok:false，照樣漏過去。
    it('回了 200 但正文是一句報錯 → 同樣算沒跑成', async () => {
        vi.spyOn(XhsMcpClient, 'getNoteDetail').mockResolvedValue({
            success: true,
            data: '獲取筆記詳情失敗: 需要先搜索',
        } as any);

        const result = await runXhsDetail(
            { noteId: 'note-500' },
            {
                char: { xhsEnabled: true } as any,
                userProfile: {} as any,
                realtimeConfig: {
                    xhsMcpConfig: { enabled: true, serverUrl: 'https://example.test/xhs' },
                } as any,
            },
        );

        expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
        expect(!result.ok && result.message).toContain('獲取筆記詳情失敗');
        const feedback = buildToolResultMessage({
            name: 'xhs_detail',
            result,
            history: [{ name: 'xhs_detail', fingerprint: 'a' }],
        });
        expect(feedback).toContain('這件事**沒有發生**');
    });
});
