import { describe, expect, it } from 'vitest';
import type { GroupProfile, Message } from '../../types';
import {
    buildGroupTopicPrompt,
    buildGroupTopicContext,
    GROUP_TOPIC_HOT_ZONE,
    groupTopicPendingCount,
    makeGroupTopicBox,
    planGroupTopicBatch,
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
    it('始終保留最近 200 條，熱區以前滿 100 條後處理前 85%', () => {
        const all = messages(300);
        const plan = planGroupTopicBatch(all, 0, false);
        expect(GROUP_TOPIC_HOT_ZONE).toBe(200);
        expect(plan?.pendingCount).toBe(100);
        expect(plan?.messages).toHaveLength(85);
        expect(plan?.messages[0].id).toBe(1);
        expect(plan?.messages.at(-1)?.id).toBe(85);
    });

    it('公共遊標推進後不會重複處理已經成盒的消息', () => {
        const all = messages(400);
        expect(groupTopicPendingCount(all, 120)).toBe(80);
        expect(planGroupTopicBatch(all, 120, false)).toBeNull();
        expect(planGroupTopicBatch(all, 120, true)?.messages[0].id).toBe(121);
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
