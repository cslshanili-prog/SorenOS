import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import MessageItem from '../components/chat/MessageItem';

const activeTheme = {
    id: 'test-theme',
    name: 'Test',
    user: {},
    ai: {},
} as any;

const renderMessage = (
    msg: Message,
    moduleAlign: 'anchor' | 'center' = 'center',
    avatarMode: 'grouped' | 'every_message' = 'every_message',
) => renderToStaticMarkup(React.createElement(MessageItem, {
    msg,
    isFirstInGroup: true,
    isLastInGroup: true,
    activeTheme,
    charAvatar: 'https://example.com/char.png',
    charName: '角色',
    userAvatar: 'https://example.com/user.png',
    onLongPress: vi.fn(),
    onReply: vi.fn(),
    selectionMode: false,
    isSelected: false,
    onToggleSelect: vi.fn(),
    avatarMode,
    moduleAlign,
}));

const htmlCard = (): Message => ({
    id: 1,
    charId: 'char-1',
    role: 'assistant',
    type: 'html_card',
    content: '[HTML卡片]',
    timestamp: 1,
    metadata: { htmlSource: '<div>hello</div>' },
});

const musicCard = (): Message => ({
    id: 2,
    charId: 'char-1',
    role: 'assistant',
    type: 'music_card',
    content: '[音樂卡片]',
    timestamp: 2,
    metadata: {
        intent: 'join',
        song: { songId: 7, name: 'Song', artists: 'Artist', albumPic: '' },
    },
});

describe('MessageItem module layout', () => {
    const moduleModes = [
        ['center', 'grouped'],
        ['center', 'every_message'],
        ['anchor', 'grouped'],
        ['anchor', 'every_message'],
    ] as const;

    it.each(moduleModes)('HTML 卡片在 %s / %s 模式都不渲染消息外側頭像', (align, avatarMode) => {
        const markup = renderMessage(htmlCard(), align, avatarMode);
        expect(markup).not.toContain('alt="avatar"');
        expect(markup).toContain('sully-html-wrap');
        expect(markup).toContain(align === 'center' ? 'sully-chat-message-ai justify-center' : 'sully-chat-message-ai justify-start');
        expect(markup).toContain(align === 'center' ? 'w-fit max-w-full mx-auto sully-html-wrap' : 'max-w-[72%] ml-12 sully-html-wrap');
        expect(markup).toContain('w-[280px] max-w-full');
        expect(markup).toContain('block w-full min-h-[120px]');
        expect(markup).toContain('sully-html-source-bar');
        expect(markup).toContain('sully-html-source-toggle');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('aria-label="展開 HTML 源碼操作"');
        expect(markup).toContain('aria-label="複製完整 HTML 源碼"');
        expect(markup).toContain('完整源碼');
        expect(markup).toContain('複製源碼');
    });

    it.each(moduleModes)('一起聽卡片在 %s / %s 模式跟隨模塊位置且沒有消息外側頭像', (align, avatarMode) => {
        const markup = renderMessage(musicCard(), align, avatarMode);
        expect(markup).not.toContain('alt="avatar"');
        expect(markup).toContain(align === 'center' ? 'sully-chat-message-ai justify-center' : 'sully-chat-message-ai justify-start');
        expect(markup).toContain(align === 'center' ? 'w-fit max-w-full mx-auto sully-html-wrap' : 'max-w-[72%] ml-12 sully-html-wrap');
        // 卡片內部的“一起聽”雙頭像仍保留；只移除消息外殼頭像。
        expect(markup).toContain('https://example.com/user.png');
        expect(markup).toContain('https://example.com/char.png');
    });

    it('普通角色消息繼續顯示外側頭像', () => {
        const markup = renderMessage({
            id: 3,
            charId: 'char-1',
            role: 'assistant',
            type: 'text',
            content: '普通消息',
            timestamp: 3,
        });
        expect(markup).toContain('alt="avatar"');
        expect(markup).toContain('https://example.com/char.png');
    });

    it('心象卡片提供長按複製提示與獨立交互入口', () => {
        const markup = renderMessage({
            id: 4,
            charId: 'char-1',
            role: 'assistant',
            type: 'text',
            content: '回覆正文',
            timestamp: 4,
            metadata: { thinkingChain: '這是可以一鍵複製的完整心象。' },
        });

        expect(markup).toContain('aria-label="心象：點擊展開，長按複製全文"');
        expect(markup).toContain('title="長按複製心象全文"');
        expect(markup).toContain('這是可以一鍵複製的完整心象');
        expect(markup).toContain('user-select:text');
        expect(markup).toContain('-webkit-touch-callout:default');
    });
});
