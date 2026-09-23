import { describe, expect, it } from 'vitest';
import { createQixiChatMessagePair, createQixiEventChatCard, formatQixiEventCardForContext, tryParseQixiEventChatCard } from './qixiChatCard';

const card = createQixiEventChatCard({
    runId: 'run-1',
    charName: 'Sully',
    userName: '條條',
    timestamp: 1,
    openingChat: ['你剛才回我了嗎？', '奇怪，我沒看見。'],
    scenes: [{ id: 'doubleWish', title: '雙面祈願處', sharedObject: '雙面願箋', userActions: ['寫下願望'], userResults: ['把願望留在正面'], charAction: '從背面寫下自己的願望', memoryLine: '一張紙同時朝向兩個地方' }],
    bridgeNodes: [{ name: '草莓牛奶', artifactLabel: '草莓牛奶', memoryLine: '你說只剩最後一盒' }],
    reunionLines: ['終於找到你了。'],
    metaReflection: [],
    companionshipReflection: ['原來我們一直都認得出彼此。'],
    blessing: ['七夕快樂。'],
    promiseInvitation: ['那我們約好了。'],
    promiseComplete: '不許反悔。',
});

describe('qixi chat card', () => {
    it('keeps the structured full journey and parses it back', () => {
        expect(tryParseQixiEventChatCard(card)?.bridgeNodes[0].name).toBe('草莓牛奶');
        expect(card.summary).toContain('上下文夾層');
    });

    it('formats a second-person context that lets Char remember the whole event', () => {
        const context = formatQixiEventCardForContext(card, 'char');
        expect(context).toContain('你經歷了一次奇怪的空間坍縮');
        expect(context).toContain('你和條條');
        expect(context).toContain('雙面祈願處');
        expect(context).toContain('原來我們一直都認得出彼此');
        expect(context).toContain('草莓牛奶');
        expect(context).toContain('喚來一隻鵲');
        expect(context).toContain('共同觸碰的約定');
        expect(context).not.toContain('記憶物件鋪成鵲橋');
    });

    it('puts the activity card immediately before the private-chat line', () => {
        const [activityCard, privateLine] = createQixiChatMessagePair('char-1', card, '回來以後慢慢說。', 100);
        expect(activityCard.type).toBe('score_card');
        expect(privateLine.type).toBe('text');
        expect(activityCard.timestamp).toBe(100);
        expect(privateLine.timestamp).toBe(101);
        expect(activityCard.metadata.qixiRunId).toBe(privateLine.metadata.qixiRunId);
    });
});
