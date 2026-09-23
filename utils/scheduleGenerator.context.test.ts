import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { formatChatHistoryForSchedule } from './scheduleGenerator';

const char = {
    id: 'char-1',
    name: '阿澄',
    timeAwarenessEnabled: false,
} as CharacterProfile;

const user = { name: '小魚' } as UserProfile;
const timestamp = new Date('2026-07-30T08:00:00Z').getTime();

const msg = (input: Partial<Message> & Pick<Message, 'id' | 'role' | 'type' | 'content'>): Message => ({
    charId: char.id,
    timestamp,
    ...input,
} as Message);

describe('日程歷史與私聊消息格式對齊', () => {
    it('雙語消息只保留原文側，避免歷史體積近乎翻倍', () => {
        const block = formatChatHistoryForSchedule([
            msg({
                id: 1,
                role: 'assistant',
                type: 'text',
                content: 'Bonjour, tu vas bien ?\n%%BILINGUAL%%\n你好，最近好嗎？',
            }),
        ], char, user);

        expect(block).toContain('Bonjour, tu vas bien ?');
        expect(block).not.toContain('%%BILINGUAL%%');
        expect(block).not.toContain('你好，最近好嗎？');
    });

    it('交換日記保留雙方正文，並去掉原始 JSON 載荷', () => {
        const card = {
            type: 'diary_card',
            date: '2026-07-30',
            userName: user.name,
            userText: '今天路過舊書店，買到了找很久的畫冊。',
            charText: '下次記得把那本畫冊拍給我看，我想看看封面。',
        };
        const block = formatChatHistoryForSchedule([
            msg({
                id: 2,
                role: 'system',
                type: 'score_card',
                content: JSON.stringify(card),
                metadata: { scoreCard: card },
            }),
        ], char, user);

        expect(block).toContain('交換日記');
        expect(block).toContain(card.userText);
        expect(block).toContain(card.charText);
        expect(block).not.toContain('"userText"');
        expect(block).not.toContain('"charText"');
    });

    it('家園正文完整保留，且補上與私聊相同的共同世界框定', () => {
        const worldBody = '「家園 · 海邊小屋」下午\n阿澄在露台澆花\n把曬蔫的薄荷搬到了陰影裡。';
        const block = formatChatHistoryForSchedule([
            msg({
                id: 3,
                role: 'assistant',
                type: 'world_card',
                content: worldBody,
                metadata: { worldName: '海邊小屋', mode: 'normal' },
            }),
        ], char, user);

        expect(block).toContain(worldBody);
        expect(block).toContain('共同世界「家園」');
    });

    it('HTML 卡片只保留可見文字摘要，不把完整 HTML/CSS 塞進日程', () => {
        const rawHtml = `[HTML卡片] <style>${'.card{color:red}'.repeat(1000)}</style><div>隱藏載荷</div>`;
        const block = formatChatHistoryForSchedule([
            msg({
                id: 4,
                role: 'assistant',
                type: 'html_card',
                content: rawHtml,
                metadata: { htmlTextPreview: '今天完成了一張旅行計劃卡。' },
            }),
        ], char, user);

        expect(block).toContain('今天完成了一張旅行計劃卡。');
        expect(block).not.toContain('.card{color:red}');
        expect(block.length).toBeLessThan(1000);
    });

    it('圖片只保留文字佔位，不攜帶 base64', () => {
        const block = formatChatHistoryForSchedule([
            msg({
                id: 5,
                role: 'user',
                type: 'image',
                content: `data:image/png;base64,${'A'.repeat(20_000)}`,
            }),
        ], char, user);

        expect(block).toContain('[User sent an image]');
        expect(block).not.toContain('data:image/png;base64');
        expect(block.length).toBeLessThan(1000);
    });
});
