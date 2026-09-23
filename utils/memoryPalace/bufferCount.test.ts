import { describe, it, expect } from 'vitest';
import {
    countOneShotPendingMessages,
    countUnprocessedBufferMessages,
    getOneShotTargetHighWaterMark,
} from './bufferCount';
import { isMessageSemanticallyRelevant } from '../messageFormat';

/** 造一批 id 連續、內容非空的文本消息 */
const makeMsgs = (n: number, startId = 1) =>
    Array.from({ length: n }, (_, i) => ({ id: startId + i, type: 'text', content: 'x' })) as any;

describe('countUnprocessedBufferMessages（記憶宮殿未同步口徑）', () => {
    it('消息數 <= 熱區時恆為 0（全在熱區，永遠不會被處理）', () => {
        expect(countUnprocessedBufferMessages(makeMsgs(200), 0, 200)).toBe(0);
        // 小熱區同理
        expect(countUnprocessedBufferMessages(makeMsgs(3), 0, 3)).toBe(0);
    });

    it('排除最後 N 條熱區：250 條、hwm=0、熱區200 → 只數前 50 條', () => {
        expect(countUnprocessedBufferMessages(makeMsgs(250), 0, 200)).toBe(50);
    });

    it('再排除已處理(id <= hwm)：250 條、hwm=30、熱區200 → 50 裡去掉前 30 = 20', () => {
        expect(countUnprocessedBufferMessages(makeMsgs(250), 30, 200)).toBe(20);
    });

    it('小熱區精確邊界：5 條、熱區3、hwm=0 → 只有 id 1、2 落在緩衝區 = 2', () => {
        // 排序後 [1,2,3,4,5]，熱區起點 = 倒數第 3 條 = id 3；緩衝區 = id>0 且 id<3 = {1,2}
        expect(countUnprocessedBufferMessages(makeMsgs(5), 0, 3)).toBe(2);
    });

    it('三檔熱區都沿用同一條角色時間線計算', () => {
        const msgs = makeMsgs(300);
        expect(countUnprocessedBufferMessages(msgs, 0, 200)).toBe(100);
        expect(countUnprocessedBufferMessages(msgs, 0, 100)).toBe(200);
        expect(countUnprocessedBufferMessages(msgs, 0, 50)).toBe(250);
    });

    it('亂序輸入也按 id 排序後計算，結果一致', () => {
        const shuffled = [{ id: 5 }, { id: 1 }, { id: 3 }, { id: 2 }, { id: 4 }] as any;
        expect(countUnprocessedBufferMessages(shuffled, 0, 3)).toBe(2);
    });

    it('熱區為 0 時會處理水位線後的全部語義消息', () => {
        expect(countUnprocessedBufferMessages(makeMsgs(5), 2, 0)).toBe(3);
    });

    it('迴歸守衛：絕不能退回 "id > hwm" 裸口徑', () => {
        const msgs = makeMsgs(250); // id 1..250
        const naive = msgs.filter((m: any) => m.id > 0).length; // 裸口徑 = 250
        const correct = countUnprocessedBufferMessages(msgs, 0, 200); // 正確 = 50
        expect(correct).toBe(50);
        expect(correct).not.toBe(naive); // 若有人改回裸過濾，這一行會掛
    });

    it('語音轉寫與 metadata 卡片進入同一水位線統計，純媒體不計數', () => {
        const mixed = [
            { id: 1, type: 'text', content: '文字' },
            { id: 2, type: 'voice', content: '語音配套文字' },
            { id: 3, type: 'xhs_card', content: '', metadata: { xhsNote: { title: '卡片標題' } } },
            { id: 4, type: 'image', content: 'data:image/png;base64,AAAA' },
            { id: 5, type: 'emoji', content: 'blob:emoji' },
            { id: 6, type: 'voice', content: 'blob:voice' },
            { id: 7, type: 'text', content: '熱區一' },
            { id: 8, type: 'text', content: '熱區二' },
        ] as any;
        const semantic = mixed.filter(isMessageSemanticallyRelevant);

        expect(semantic.map((m: any) => m.id)).toEqual([1, 2, 3, 7, 8]);
        expect(countUnprocessedBufferMessages(semantic, 0, 2)).toBe(3);
        expect(countUnprocessedBufferMessages(semantic, 1, 2)).toBe(2);
    });
});

describe('一鍵存入的原文邊界', () => {
    it('默認把水位線推進到當前最後一條', () => {
        const messages = makeMsgs(30);
        expect(getOneShotTargetHighWaterMark(messages, 0)).toBe(30);
        expect(countOneShotPendingMessages(messages, messages, 0, 0)).toBe(30);
    });

    it('保留最近 10 條時，水位線停在倒數第 10 條之前', () => {
        const messages = makeMsgs(30);
        expect(getOneShotTargetHighWaterMark(messages, 10)).toBe(20);
        expect(countOneShotPendingMessages(messages, messages, 0, 10)).toBe(20);
    });

    it('邊界按全部原文計算，但待處理數只統計可提取語義的內容', () => {
        const allMessages = [
            { id: 1, type: 'text', content: '舊文字' },
            { id: 2, type: 'image', content: 'data:image/png;base64,AAAA' },
            { id: 3, type: 'text', content: '保留一' },
            { id: 4, type: 'emoji', content: 'blob:emoji' },
            { id: 5, type: 'text', content: '保留三' },
        ] as any;
        const semantic = allMessages.filter(isMessageSemanticallyRelevant);

        expect(getOneShotTargetHighWaterMark(allMessages, 3)).toBe(2);
        expect(countOneShotPendingMessages(semantic, allMessages, 0, 3)).toBe(1);
    });
});
