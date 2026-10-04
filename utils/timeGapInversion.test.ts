import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ChatPrompts } from './chatPrompts';

// 2026-10-05 回報：好幾個角色在思考鏈裡說「系統提示我們 72 天沒聯絡了」。
// 歷史照自增 id 排、時間差照時間戳算；雲端補收的舊訊息帶著兩個多月前的 sentAt、id 卻是最新，
// 排在聊天最後面。以前時間差拿「排在前面那一則」算，就算出 72 天。

const DAY = 86_400_000;
const now = Date.now();
const char = { id: 'c1', name: 'V' } as any;
const user = { name: 'Lorna' } as any;
const msg = (id: number, role: 'user' | 'assistant', timestamp: number, extra: any = {}) =>
    ({ id, charId: 'c1', role, type: 'text', content: `第${id}則`, timestamp, ...extra }) as any;
const lastText = (apiMessages: any[]) => {
    const c = apiMessages[apiMessages.length - 1].content;
    return typeof c === 'string' ? c : c.map((p: any) => p.text || '').join('');
};

describe('私聊時間差：上一則取時間戳最晚的，不取排在前面的', () => {
    it('最後面夾了一則兩個多月前時間戳的補收訊息 → 不再提示 72 天', () => {
        const history = [
            msg(1, 'user', now - 20 * 60_000),
            msg(2, 'assistant', now - 15 * 60_000),
            msg(3, 'assistant', now - 72 * DAY),   // 補收的舊訊息：id 最新、時間戳很舊
            msg(4, 'user', now),
        ];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, char, user, []);
        const text = lastText(apiMessages);
        expect(text).not.toContain('72 天');
        expect(text).toContain('距離上一條消息: 15 分鐘');
    });

    it('真的很久沒聊還是照樣提示', () => {
        const history = [msg(1, 'user', now - 3 * DAY), msg(2, 'user', now)];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, char, user, []);
        expect(lastText(apiMessages)).toContain('距離上一條消息: 3 天');
    });

    it('主動訊息的隱藏提示和緊跟著的主動回覆照舊不算', () => {
        const history = [
            msg(1, 'user', now - 2 * DAY),
            msg(2, 'user', now - 60_000, { metadata: { proactiveHint: true, hidden: true } }),
            msg(3, 'assistant', now - 50_000),
            msg(4, 'user', now),
        ];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, char, user, []);
        expect(lastText(apiMessages)).toContain('距離上一條消息: 2 天');
    });
});

describe('接線', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

    it('雲端補收：「本機最晚一則」要連記憶宮殿處理過的一起看', () => {
        expect(read('utils/activeMsgRuntime.ts')).toContain('DB.getRecentMessagesByCharId(message.charId, 200, true)');
    });

    it('見面感知：上次互動取時間戳最晚的那則', () => {
        const src = read('utils/datePrompts.ts');
        expect(src).not.toContain('const lastMsg = allMsgs[allMsgs.length - 1];');
        expect(src).toContain('const gapHint = getTimeGapHint(lastTs, charTz);');
    });
});
