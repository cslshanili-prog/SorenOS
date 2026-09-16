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

describe('端到端：购物中心外卖代付请求的 AI 支付/拒绝', () => {
    it('角色支付：onCharDaifuAccept 收到正确金额，待处理卡改判为 accepted', async () => {
        const charId = `c-daifu-${Date.now()}`;
        await DB.saveMessage({
            charId, role: 'user', type: 'mall_order',
            content: '[购物中心卡片]',
            metadata: { mallKind: 'food', mode: 'daifu', items: [{ name: '简餐套餐', price: 32, qty: 1 }], total: 32, status: 'pending' },
        });

        const onCharDaifuAccept = vi.fn().mockResolvedValue(true);
        await applyAssistantPostProcessing('行，这顿我请了。[[ACTION:DAIFU_ACCEPT]]', makeCtx(charId, { onCharDaifuAccept }));

        expect(onCharDaifuAccept).toHaveBeenCalledWith(32);
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const order = msgs.find(m => m.type === 'mall_order');
        expect(order?.metadata?.status).toBe('accepted');
    });

    it('角色拒绝并带原因：待处理卡改判为 declined + declineReason，不调用 onCharDaifuAccept', async () => {
        const charId = `c-daifu-decline-${Date.now()}`;
        await DB.saveMessage({
            charId, role: 'user', type: 'mall_order',
            content: '[购物中心卡片]',
            metadata: { mallKind: 'food', mode: 'daifu', items: [{ name: '草莓小蛋糕', price: 23, qty: 1 }], total: 23, status: 'pending' },
        });

        const onCharDaifuAccept = vi.fn();
        await applyAssistantPostProcessing('不行。[[ACTION:DAIFU_DECLINE|reason=说好的减肥呢]]', makeCtx(charId, { onCharDaifuAccept }));

        expect(onCharDaifuAccept).not.toHaveBeenCalled();
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const order = msgs.find(m => m.type === 'mall_order');
        expect(order?.metadata?.status).toBe('declined');
        expect(order?.metadata?.declineReason).toBe('说好的减肥呢');
    });
});
