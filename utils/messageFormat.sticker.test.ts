import { describe, it, expect } from 'vitest';
import { stickerNameFromUrl } from './messageFormat';
import { ChatPrompts } from './chatPrompts';
import type { Emoji } from '../types';

// 鎖住「表情包在上下文裡看得見名字」的修復。
//
// 表情包消息的 content 只存圖床 URL，本身不帶名字。非識圖模型看不到圖，只能靠
// 反查表情名（關鍵字）才知道對方發了什麼表情。私聊主歷史一直查名字，但群聊主歷史
// (GroupChat.triggerDirector) 漏查，只給死佔位 [表情包]，導致群裡角色"看不見"用戶
// 發的表情。修復把查名收口到 stickerNameFromUrl，私聊 / 群聊共用同一個點。
//
// 群聊那段序列化內聯在 React 組件閉包裡、未導出，無法單測；這裡改為釘住共用的收口
// helper 本身 + 私聊集成路徑——helper 正確，兩條調用路徑就都正確。

const DOGE_URL = 'https://img.example/doge.png';
const emojis: Emoji[] = [{ name: '柴犬貼貼', url: DOGE_URL }];

describe('stickerNameFromUrl 表情名反查', () => {
    it('URL 命中時返回當初設的表情名', () => {
        expect(stickerNameFromUrl(emojis, DOGE_URL)).toBe('柴犬貼貼');
    });

    it('URL 查不到時兜底為 未知表情, 不拋錯', () => {
        expect(stickerNameFromUrl(emojis, 'https://img.example/none.png')).toBe('未知表情');
        expect(stickerNameFromUrl([], DOGE_URL)).toBe('未知表情');
    });
});

describe('buildMessageHistory 私聊表情包帶名字', () => {
    const char = { id: 'c1', name: '小角色' } as any;
    const userProfile = { name: '我' } as any;
    const t0 = Date.now() - 60_000;

    it('用戶發表情包時上下文帶出表情名, 不是光禿禿的佔位 (退化即掛)', () => {
        const history = [
            { id: 1, charId: 'c1', role: 'user', type: 'emoji', content: DOGE_URL, timestamp: t0 },
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, emojis);
        const userMsg = apiMessages.find((m: any) => m.role === 'user');
        const content = userMsg!.content as string;
        expect(content).toContain('柴犬貼貼');
        expect(content).toContain('發送了表情包');
    });
});
