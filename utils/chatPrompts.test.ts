import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { buildGroupHistoryBlock } from './groupChat/prompts';
import type { CharacterProfile, Message } from '../types';

// 釘住「圖片值不許當正文進 prompt」這條線。
//
// 背景：圖片二進制存在 IndexedDB，字段裡只留 `blobref:<id>` 短令牌（~28 字）。發請求時
// utils/apiBlobRefs.ts 會在網絡出口把請求體裡的令牌還原成完整 data URL——所以令牌一旦混進
// prompt 文本，出門就是幾 MB 的 base64，且每輪對話重發一次。長度截斷攔不住它（令牌比截斷
// 閾值還短），只能在拼 prompt 時就認出來換成佔位符。
//
// 下面兩類漏點都是真實線上問題：引用回覆的摘要，以及沒被認領的卡片走 JSON 原文兜底。

const char = { id: 'c1', name: '小角色' } as any;
const userProfile = { name: '我' } as any;

const BLOB_TOKEN = 'blobref:b_abcdef0123456789';
const DATA_URL = 'data:image/jpeg;base64,' + 'A'.repeat(600);

const t0 = Date.now() - 60_000;

/** 用戶引用了一條圖片消息，然後回了一句話。 */
const replyToMediaMessage = (mediaValue: string): Message[] => ([
    {
        id: 2, charId: 'c1', role: 'user', type: 'text',
        content: '這張圖好可愛',
        timestamp: t0 + 1000,
        replyTo: { id: 1, content: mediaValue, name: '小角色' },
    },
] as any[]);

describe('私聊引用回覆：被引用的是圖片消息', () => {
    it('引用 blobref 令牌圖片時，令牌不進 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage(BLOB_TOKEN), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('blobref:');
        // 用戶真正說的那句話必須還在
        expect(payload).toContain('這張圖好可愛');
    });

    it('引用 data URL 圖片時，base64 不進 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage(DATA_URL), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('data:image');
        expect(payload).not.toContain('AAAA');
        expect(payload).toContain('這張圖好可愛');
    });

    it('引用 http 外鏈圖片時，鏈接不進 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage('https://example.com/pic/very-long-name.png'), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('example.com');
    });

    it('引用普通文字消息時仍按原樣摘要（不誤傷正文）', () => {
        const longText = '這是一段很長的普通文字'.repeat(20);
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage(longText), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).toContain('這是一段很長的普通文字');
        expect(payload).toContain('…');
    });
});

describe('群聊引用回覆：被引用的是圖片消息', () => {
    const chars: CharacterProfile[] = [{ id: 'c1', name: '小夏' } as CharacterProfile];

    const groupReply = (mediaValue: string): Message[] => ([
        {
            id: 2, role: 'user', type: 'text', charId: '',
            content: '哈哈哈這張',
            timestamp: t0 + 1000,
            replyTo: { id: 1, content: mediaValue, name: '小夏' },
        },
    ] as any[]);

    it('引用 blobref 令牌圖片時，令牌不進群歷史', () => {
        const { text } = buildGroupHistoryBlock(groupReply(BLOB_TOKEN), chars, [], '用戶');
        expect(text).not.toContain('blobref:');
        expect(text).toContain('哈哈哈這張');
    });

    it('引用 data URL 圖片時，base64 不進群歷史', () => {
        const { text } = buildGroupHistoryBlock(groupReply(DATA_URL), chars, [], '用戶');
        expect(text).not.toContain('data:image');
        expect(text).not.toContain('AAAA');
        expect(text).toContain('哈哈哈這張');
    });
});

describe('score_card 兜底：沒被認領的卡片', () => {
    // 認不出類型的活動卡（比如 520 活動卡）會掉進 [系統卡片] 兜底分支。
    // 它的 JSON 裡 charAvatar 就在最前面，值是令牌。
    const unknownCard = {
        type: 'anniv520_card',
        version: 1,
        charAvatar: BLOB_TOKEN,
        userAvatar: 'blobref:b_9876543210fedcba',
        title: '520 心動瞬間',
        score: 88,
    };

    const cardMessage = (overrides: Record<string, any> = {}): Message[] => ([
        {
            id: 1, charId: 'c1', role: 'assistant', type: 'score_card',
            content: JSON.stringify(unknownCard),
            timestamp: t0,
            metadata: { scoreCard: unknownCard },
            ...overrides,
        },
    ] as any[]);

    it('metadata.scoreCard 裡的圖片令牌不進 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(cardMessage(), 10, char, userProfile, []);
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('blobref:');
        expect(payload).toContain('[系統卡片]');
        // 卡片裡的正常字段還要留著，兜底不能退化成一句空佔位
        expect(payload).toContain('520 心動瞬間');
    });

    it('只有 content JSON（沒有 metadata.scoreCard）時同樣不漏令牌', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            cardMessage({ metadata: {} }), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('blobref:');
        expect(payload).toContain('[系統卡片]');
    });

    it('卡片裡帶 data URL 頭像時也剝掉', () => {
        const dataCard = { ...unknownCard, charAvatar: DATA_URL };
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            cardMessage({ content: JSON.stringify(dataCard), metadata: { scoreCard: dataCard } }),
            10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('data:image');
        expect(payload).not.toContain('AAAA');
    });
});
