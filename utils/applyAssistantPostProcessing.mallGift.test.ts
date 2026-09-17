import { describe, it, expect, vi } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';

const makeCtx = (charId: string, overrides: Partial<PostProcessCtx> = {}): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char: { id: charId, name: 'Briar', phoneState: { records: [] } } as any,
        userProfile: { name: 'Susu' } as any,
        emojis: [],
        contextMsgs: [],
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
        ...overrides,
    };
};

describe('端到端：角色主动送礼 + 礼物已读确认', () => {
    it('角色发 GIFT：onCharGiftSend 收到正确金额，落一张 sent 状态的礼物卡', async () => {
        const charId = `c-gift-${Date.now()}`;
        const onCharGiftSend = vi.fn().mockResolvedValue(true);

        await applyAssistantPostProcessing(
            '路过甜品店给你带了个~[[ACTION:GIFT|item=草莓蛋糕|price=23|note=还热乎]]',
            makeCtx(charId, { onCharGiftSend }),
        );

        expect(onCharGiftSend).toHaveBeenCalledWith(23);
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const order = msgs.find(m => m.type === 'mall_order');
        expect(order?.role).toBe('assistant');
        expect(order?.metadata).toMatchObject({ mode: 'gift', total: 23, status: 'sent', note: '还热乎' });
    });

    it('用户送的礼物在角色下一轮回复后自动标记已读（acknowledged）', async () => {
        const charId = `c-gift-ack-${Date.now()}`;
        await DB.saveMessage({
            charId, role: 'user', type: 'mall_order',
            content: '[购物中心卡片]',
            metadata: { mallKind: 'shop', mode: 'gift', items: [{ name: '毛绒手机挂件', price: 19.9, qty: 1 }], total: 19.9, status: 'sent' },
        });

        await applyAssistantPostProcessing('……摸起来还挺软的', makeCtx(charId));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const gift = msgs.find(m => m.type === 'mall_order' && m.role === 'user');
        expect(gift?.metadata?.acknowledged).toBe(true);
    });
});
