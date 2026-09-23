import { describe, it, expect } from 'vitest';
import {
    announceChatGen,
    CHAT_GEN_EVENTS,
    setChatViewSnapshot,
    getChatViewSnapshot,
} from './chatGenEvents';

// node 環境無 window —— 派發函數必須靜默降級（生成閉包/評估函數在測試與
// SSR 環境也會被調用，不能因為廣播而拋錯拖垮主流程）。

describe('chatGenEvents', () => {
    it('無 window 時 announceChatGen 不拋錯', () => {
        expect(() => announceChatGen(CHAT_GEN_EVENTS.replyStart, { charId: 'c1', charName: '小角色' })).not.toThrow();
    });

    it('視圖快照 set/get 往返一致，無 window 也不拋錯', () => {
        expect(() => setChatViewSnapshot(true, 'c1')).not.toThrow();
        expect(getChatViewSnapshot()).toEqual({ chatOpen: true, charId: 'c1' });
        setChatViewSnapshot(false, null);
        expect(getChatViewSnapshot()).toEqual({ chatOpen: false, charId: null });
    });

    it('事件名穩定（ChatBroadcast / OSContext / useChatAI 三方約定）', () => {
        expect(CHAT_GEN_EVENTS.replyStart).toBe('chat-gen-reply-start');
        expect(CHAT_GEN_EVENTS.replyEnd).toBe('chat-gen-reply-end');
        expect(CHAT_GEN_EVENTS.replyArrived).toBe('chat-gen-reply-arrived');
        expect(CHAT_GEN_EVENTS.emotionStart).toBe('chat-gen-emotion-start');
        expect(CHAT_GEN_EVENTS.emotionEnd).toBe('chat-gen-emotion-end');
    });
});
