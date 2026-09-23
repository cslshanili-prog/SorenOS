import { describe, expect, it } from 'vitest';

import type { Message } from '../types';
import { buildChatRequestPayload } from './chatRequestPayload';
import { detectChatModeTransition } from './chatPrompts';

const message = (
    id: number,
    role: Message['role'],
    source?: string,
    metadata: Record<string, unknown> = {},
): Message => ({
    id,
    charId: 'char-return',
    role,
    type: role === 'system' ? 'system' : 'text',
    content: `message-${id}`,
    timestamp: id,
    metadata: source ? { source, ...metadata } : metadata,
} as Message);

describe('detectChatModeTransition', () => {
    it.each([
        ['call', message(2, 'assistant', 'call'), 'call'],
        ['video', message(2, 'assistant', 'call', { callMode: 'video' }), 'video'],
        ['date', message(2, 'assistant', 'date'), 'date'],
        ['story', message(2, 'assistant', 'story_theater_memory'), 'story'],
    ] as const)('識別從 %s 回到 ChatApp 的第一輪', (_label, modeMessage, expected) => {
        expect(detectChatModeTransition([
            message(1, 'assistant'),
            modeMessage,
            message(3, 'user'),
        ])).toBe(expected);
    });

    it('用戶連續發送多個氣泡時仍能越過它們找到剛結束的模式', () => {
        expect(detectChatModeTransition([
            message(1, 'assistant'),
            message(2, 'assistant', 'date'),
            message(3, 'system'),
            message(4, 'user'),
            message(5, 'user'),
        ])).toBe('date');
    });

    it('已經產生普通 ChatApp assistant 回覆後不再重複提醒', () => {
        expect(detectChatModeTransition([
            message(1, 'assistant', 'story_theater_memory'),
            message(2, 'user'),
            message(3, 'assistant'),
            message(4, 'user'),
        ])).toBeNull();
    });

    it('特殊模式之後還沒有新的 ChatApp 用戶輸入時不誤報', () => {
        expect(detectChatModeTransition([
            message(1, 'assistant'),
            message(2, 'assistant', 'call'),
            message(3, 'system', 'call-end-popup'),
        ])).toBeNull();
    });
});

describe('buildChatRequestPayload 模式切換接線', () => {
    it('即使 recentMsgsHint 已過濾通話記錄，也按完整 API 歷史注入視頻轉文字提醒', async () => {
        const historyMsgs = [
            message(1, 'assistant'),
            message(2, 'assistant', 'call', { callMode: 'video' }),
            message(3, 'system', 'call-end-popup', { callMode: 'video' }),
            message(4, 'user'),
        ];
        const payload = await buildChatRequestPayload({
            char: {
                id: 'char-return',
                name: '阿一',
                timeAwarenessEnabled: false,
                scheduleFeatureEnabled: false,
            } as any,
            userProfile: { name: '小明' } as any,
            groups: [],
            emojis: [],
            categories: [],
            historyMsgs,
            // 模擬 Chat.tsx 的可見消息：call / call-end-popup 均不在這份 React state 中。
            recentMsgsHint: [message(1, 'assistant'), message(4, 'user')],
            contextLimit: 20,
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });

        const joined = payload.fullMessages.map(item => String(item.content || '')).join('\n');
        expect(joined).toContain('系統提示｜模式切換（最高優先級）');
        expect(joined).toContain('剛剛結束了視頻通話');
        expect(joined).toContain('現在已經回到 ChatApp 的文字聊天界面');
        expect(joined).toContain('如果 ChatApp 當前開啟了語音消息，仍可遵守它自己的語音消息格式');
    });
});
