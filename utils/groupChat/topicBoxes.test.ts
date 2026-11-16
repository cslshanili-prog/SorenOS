import { describe, expect, it } from 'vitest';
import type { GroupProfile, Message } from '../../types';
import {
    buildGroupTopicPrompt,
    buildGroupTopicContext,
    groupTopicPendingCount,
    groupTopicSettings,
    makeGroupTopicBox,
    planGroupTopicBatch,
    privateGroupContextWindow,
} from './topicBoxes';

const messages = (count: number): Message[] => Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    charId: i % 2 ? 'a' : 'user',
    groupId: 'g1',
    role: i % 2 ? 'assistant' : 'user',
    type: 'text',
    content: `消息${i + 1}`,
    timestamp: 1_700_000_000_000 + i,
}));

const group: GroupProfile = { id: 'g1', name: '測試群', members: ['a', 'b'], createdAt: 1 };

describe('群公共話題盒批處理', () => {
    it('照群設定的熱區與成盒條數：熱區以前滿門檻後處理前 85%', () => {
        const all = messages(300);
        const plan = planGroupTopicBatch(all, 0, false, { hotZone: 200, threshold: 100 });
        expect(plan?.pendingCount).toBe(100);
        expect(plan?.messages).toHaveLength(85);
        expect(plan?.messages[0].id).toBe(1);
        expect(plan?.messages.at(-1)?.id).toBe(85);
        // 門檻調小就更早成盒
        expect(planGroupTopicBatch(messages(110), 0, false, { hotZone: 80, threshold: 20 })?.pendingCount).toBe(30);
        expect(planGroupTopicBatch(messages(95), 0, false, { hotZone: 80, threshold: 20 })).toBeNull();
    });

    it('公共遊標推進後不會重複處理已經成盒的消息', () => {
        const all = messages(400);
        const s = { hotZone: 200, threshold: 100 };
        expect(groupTopicPendingCount(all, 120, 200)).toBe(80);
        expect(planGroupTopicBatch(all, 120, false, s)).toBeNull();
        expect(planGroupTopicBatch(all, 120, true, s)?.messages[0].id).toBe(121);
    });

    it('群設定沒設照預設（留原文 80、50 條成盒），超出範圍夾回來', () => {
        expect(groupTopicSettings(undefined)).toEqual({ hotZone: 80, threshold: 50 });
        expect(groupTopicSettings({ privateContextCap: 5, topicArchiveThreshold: 999 })).toEqual({ hotZone: 20, threshold: 200 });
        expect(groupTopicSettings({ privateContextCap: 120, topicArchiveThreshold: 15 })).toEqual({ hotZone: 120, threshold: 15 });
    });

    it('私聊看得到所有還沒成盒的：熱區＋成盒條數，自動整理下不會有看不到的空檔', () => {
        const g = { privateContextCap: 80, topicArchiveThreshold: 30 };
        const window = privateGroupContextWindow(g);
        expect(window).toBe(110);
        // 自動整理剛好卡在門檻前一條時，還沒成盒的全部落在私聊的窗口裡
        const all = messages(80 + 29);
        expect(planGroupTopicBatch(all, 0, false, groupTopicSettings(g))).toBeNull();
        expect(all.length).toBeLessThanOrEqual(window);
    });

    it('話題盒上下文只包含共享總結，不展開舊原文', () => {
        const batch = messages(3);
        const box = makeGroupTopicBox(group, batch, '一起聊旅行', 'A和B商量了週末出行。');
        const text = buildGroupTopicContext({ ...group, topicBoxes: [box] });
        expect(text).toContain('公共話題盒');
        expect(text).toContain('一起聊旅行');
        expect(text).toContain('A和B商量了週末出行');
        expect(text).not.toContain('消息1');
    });

    it('內置總結提示詞包含全體成員語義資料，不依賴私聊歸檔風格', () => {
        const chars: any[] = [
            { id: 'a', name: 'A', description: '冷靜', systemPrompt: '說話簡潔', worldview: '現代', writerPersona: '克制', refinedMemories: { core: '認識B' } },
            { id: 'b', name: 'B', description: '活潑', systemPrompt: '愛開玩笑', memories: [] },
        ];
        const prompt = buildGroupTopicPrompt(group, messages(2), chars, '用戶');
        expect(prompt).toContain('全體成員資料');
        expect(prompt).toContain('說話簡潔');
        expect(prompt).toContain('愛開玩笑');
        expect(prompt).toContain('客觀視角');
    });
});
