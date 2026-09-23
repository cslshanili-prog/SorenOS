import { describe, it, expect } from 'vitest';
import { ContextBuilder } from './context';

// 時間塊貼在生成點前、注意力最強的位置，人設卻躺在幾千字之外的開頭。只報一句
// 「現在是深夜 23:47」的話，模型每輪都會把話題收到「快睡吧」上，聊到哪都一樣，
// 而用戶往人設/世界書裡怎麼寫都蓋不過它。這句框定跟著時間一起注入，釘住它別丟。
//
// 措辭刻意全正向（只說時間該起什麼作用，不點名任何要避開的話術）——把禁語寫進
// 提示詞反而會激活它，同 context.ts 裡「表達底線」的設計。

const charAt = (timeAwarenessEnabled?: boolean) => ({
    id: 'char-time',
    name: '阿一',
    ...(timeAwarenessEnabled === undefined ? {} : { timeAwarenessEnabled }),
}) as any;

describe('時間塊的分寸框定', () => {
    it('對話場合報時的同時說明時間該起什麼作用', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { conversational: true });
        expect(block).toContain('現在是');
        expect(block).toContain('時間是你此刻所處的背景');
        expect(block).toContain('跟著你們正在說的事情走');
    });

    // 這個函數同樣服務日程生成、歌單、攻略、手冊、小劇場，以及角色跟角色之間的對話。
    // 那些場合沒有「對方」在這個點跟你說話，末句會變成擺在注意力最強位置上的一句假話
    // ——日程生成器會以為用戶正在聊天，角色間對話裡的「對方」其實是另一個角色。
    it('沒人在對話時只報時，不帶那句語境框定', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined));
        expect(block).toContain('現在是');
        expect(block).not.toContain('時間是你此刻所處的背景');
        expect(block).not.toContain('還在跟你說話');
    });

    it('全正向：不靠列舉要避開的話術來防守', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { conversational: true });
        expect(block).not.toContain('不要說');
        expect(block).not.toContain('禁止');
        expect(block).not.toContain('晚安');
    });

    it('時間感知關掉時整段都不出現，這句自然也不該單獨漏出來', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(false));
        expect(block).toBe('');
    });

    it('見面純架空（skipTimeAwareness）同樣整段不出現', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { skipTimeAwareness: true, conversational: true });
        expect(block).toBe('');
    });
});
