import { afterEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import { isChatPreviewMessage, isVisibleChatMessage } from './chatMessageVisibility';
import type { Message } from '../types';

const message = (overrides: Partial<Message> = {}): Message => ({
    id: 1, charId: 'visibility', role: 'assistant', type: 'text', content: '晚安', timestamp: 1,
    ...overrides,
});
let sequence = 0;
const nextCharId = () => `chat-visibility-${++sequence}`;

afterEach(() => localStorage.clear());

describe('私聊與桌面預覽的消息範圍', () => {
    it.each(['date', 'call', 'story_theater_memory'])('%s 正文不出現在私聊和桌面消息卡', source => {
        const row = message({ metadata: { source } });
        expect(isVisibleChatMessage(row)).toBe(false);
        expect(isChatPreviewMessage(row)).toBe(false);
    });

    it('主動消息正文、舊記錄和通話後的私聊回信仍然顯示', () => {
        expect(isVisibleChatMessage(message())).toBe(true);
        expect(isChatPreviewMessage(message())).toBe(true);
        expect(isChatPreviewMessage(message({ metadata: { source: 'call-end-popup' } }))).toBe(true);
        expect(isVisibleChatMessage(message({ role: 'user', metadata: { proactiveHint: true, hidden: true } }))).toBe(false);
        expect(isChatPreviewMessage(message({ groupId: 'group' }))).toBe(false);
    });

    it('桌面隱藏系統消息，聊天的隱藏日誌設置仍保留評分卡', () => {
        const log = message({ role: 'system' });
        expect(isVisibleChatMessage(log)).toBe(true);
        expect(isVisibleChatMessage(log, true)).toBe(false);
        expect(isVisibleChatMessage(message({ role: 'system', type: 'score_card' }), true)).toBe(true);
        expect(isChatPreviewMessage(log)).toBe(false);
    });
});

describe('先按顯示範圍過濾，再計算最近 N 條', () => {
    it('大量見面/通話/隱藏提示不能擠掉已保存的主動消息，桌面和聊天均能找到它', async () => {
        const charId = nextCharId();
        const saved = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: '該出門了' });
        for (let i = 0; i < 60; i++) {
            await DB.saveMessage({
                charId, role: 'user', type: 'text', content: '其他界面或內部提示',
                metadata: i % 3 === 0 ? { proactiveHint: true, hidden: true } : { source: i % 3 === 1 ? 'date' : 'call' },
            });
        }
        const chat = await DB.getRecentMessagesWithCount(charId, 30, isVisibleChatMessage);
        const preview = await DB.getRecentMessagesWithCount(charId, 1, isChatPreviewMessage);
        expect(chat.messages.map(m => m.id)).toEqual([saved]);
        expect(preview.messages.map(m => m.id)).toEqual([saved]);
        // 只改讀取，不刪見面/通話記錄，也不改變模型的上下文讀取。
        expect(await DB.getMessagesByCharId(charId, true)).toHaveLength(61);
    });

    it('分頁仍按消息順序返回完整一頁，並跳過大量系統日誌', async () => {
        const charId = nextCharId();
        const ids: number[] = [];
        for (let i = 0; i < 35; i++) {
            ids.push(await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: `消息 ${i}` }));
            await DB.saveMessage({ charId, role: 'system', type: 'text', content: '日誌' });
        }
        const recent = await DB.getRecentMessagesWithCount(charId, 30, m => isVisibleChatMessage(m, true));
        expect(recent.messages.map(m => m.id)).toEqual(ids.slice(-30));
    });

    it('記憶處理水位不影響桌面預覽和可回看的聊天', async () => {
        const charId = nextCharId();
        const id = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: '舊聊天仍能回看' });
        localStorage.setItem(`mp_lastMsgId_${charId}`, String(id));
        expect(await DB.getMessagesByCharId(charId)).toEqual([]);
        const preview = await DB.getRecentMessagesWithCount(charId, 1, isChatPreviewMessage);
        expect(preview.messages.map(m => m.id)).toEqual([id]);
        expect(localStorage.getItem(`mp_lastMsgId_${charId}`)).toBe(String(id));
    });
});
