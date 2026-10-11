import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 引擎的上下文來源都換成假的：只驗「誰說了什麼、跑了幾次 LLM、記憶有沒有接上」
const injectMemoryPalace = vi.fn(async () => {});
vi.mock('./memoryPalace/pipeline', () => ({ injectMemoryPalace: (...a: unknown[]) => injectMemoryPalace(...(a as [])) }));
vi.mock('./context', () => ({ ContextBuilder: { buildCoreContext: () => '[CORE]' } }));
vi.mock('./chatContextRange', () => ({
    loadCharacterContextMessages: async () => [{ role: 'user', type: 'text', content: '晚點一起吃飯嗎' }],
}));
vi.mock('./db', () => ({ DB: { getRecentMessagesByCharId: async () => [] } }));

import { runNpcConversation, runRealConversation } from './relationshipChat';

const api = { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' };
const char = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, ...extra }) as any;
const user = { name: '小星' } as any;

let prompts: string[] = [];
const replyWith = (texts: string[]) => {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
        prompts.push(JSON.parse(init.body).messages[0].content);
        const content = texts[Math.min(i++, texts.length - 1)];
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));
};

beforeEach(() => { prompts = []; injectMemoryPalace.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('runRealConversation · 以對方身份回 TA（aReplyTo）', () => {
    it('先記成 B 說的，只跑 A 回這一句（1 次 LLM），B 不出聲', async () => {
        replyWith(['好啊，那七點樓下見\n[[Δ:+3]]']);
        const r = await runRealConversation({
            a: char('a', '阿澤'), b: char('b', 'Sully'), user, api,
            affinityA: 10, affinityB: 5,
            existingDetail: '我: 在嗎\n對方: 在',
            aReplyTo: '晚上要不要一起去看電影？',
        });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('Sully: 晚上要不要一起去看電影？');
        expect(prompts[0]).toContain('回覆「Sully」剛說的話');
        expect(r.aDetail.split('\n')).toEqual([
            '我: 在嗎', '對方: 在', '對方: 晚上要不要一起去看電影？', '我: 好啊，那七點樓下見',
        ]);
        expect(r.bDetail.split('\n').slice(-2)).toEqual(['我: 晚上要不要一起去看電影？', '對方: 好啊，那七點樓下見']);
        expect(r.aDelta).toBe(3);
        expect(r.bDelta).toBe(0);
    });

    it('沒有 aReplyTo 時照舊：A 主動發、B 回，一輪兩次', async () => {
        replyWith(['最近在忙什麼？\n[[Δ:0]]', '在趕報告\n[[Δ:0]]']);
        const r = await runRealConversation({ a: char('a', '阿澤'), b: char('b', 'Sully'), user, api, affinityA: 0, affinityB: 0 });
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain('這條消息是**你主動發的**');
        expect(r.aDetail).toBe('我: 最近在忙什麼？\n對方: 在趕報告');
    });
});

describe('runNpcConversation', () => {
    it('預設一次一輪，並且跟真角色一樣讀記憶宮殿（query＝NPC 名字）和最近私聊', async () => {
        replyWith(['我: 你那邊下雨了嗎\n對方: 剛停']);
        const r = await runNpcConversation({ host: char('h', '阿澤', { memoryPalaceEnabled: true }), user, api, npcName: '房東阿姨' });
        expect(prompts[0]).toContain('接下來 1 個來回');
        expect(prompts[0]).toContain('小星: 晚點一起吃飯嗎');
        expect(injectMemoryPalace).toHaveBeenCalledWith(expect.objectContaining({ id: 'h' }), expect.anything(), '房東阿姨', '小星');
        expect(r.detail).toBe('我: 你那邊下雨了嗎\n對方: 剛停');
    });

    it('以對方身份回 TA（hostReplyTo）：只收機主的回覆，模型替 NPC 多編的丟掉', async () => {
        replyWith(['我: 下個月的房租我會準時轉\n我: 別擔心\n對方: 好那就這樣']);
        const r = await runNpcConversation({
            host: char('h', '阿澤'), user, api, npcName: '房東阿姨',
            existingDetail: '我: 阿姨好',
            hostReplyTo: '這個月房租還沒收到喔',
        });
        expect(prompts[0]).toContain('對方: 這個月房租還沒收到喔');
        expect(prompts[0]).toContain('只寫**你（阿澤）對這段的回覆**');
        expect(r.detail.split('\n')).toEqual([
            '我: 阿姨好', '對方: 這個月房租還沒收到喔', '我: 下個月的房租我會準時轉', '我: 別擔心',
        ]);
    });
});
