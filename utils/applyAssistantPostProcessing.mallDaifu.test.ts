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

describe('端到端：購物中心外賣代付請求的 AI 支付/拒絕', () => {
    it('角色支付：onCharDaifuAccept 收到正確金額，待處理卡改判為 accepted', async () => {
        const charId = `c-daifu-${Date.now()}`;
        await DB.saveMessage({
            charId, role: 'user', type: 'mall_order',
            content: '[購物中心卡片]',
            metadata: { mallKind: 'food', mode: 'daifu', items: [{ name: '簡餐套餐', price: 32, qty: 1 }], total: 32, status: 'pending' },
        });

        const onCharDaifuAccept = vi.fn().mockResolvedValue(true);
        await applyAssistantPostProcessing('行，這頓我請了。[[ACTION:DAIFU_ACCEPT]]', makeCtx(charId, { onCharDaifuAccept }));

        expect(onCharDaifuAccept).toHaveBeenCalledWith(32);
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const order = msgs.find(m => m.type === 'mall_order');
        expect(order?.metadata?.status).toBe('accepted');
    });

    it('角色拒絕並帶原因：待處理卡改判為 declined + declineReason，不調用 onCharDaifuAccept', async () => {
        const charId = `c-daifu-decline-${Date.now()}`;
        await DB.saveMessage({
            charId, role: 'user', type: 'mall_order',
            content: '[購物中心卡片]',
            metadata: { mallKind: 'food', mode: 'daifu', items: [{ name: '草莓小蛋糕', price: 23, qty: 1 }], total: 23, status: 'pending' },
        });

        const onCharDaifuAccept = vi.fn();
        await applyAssistantPostProcessing('不行。[[ACTION:DAIFU_DECLINE|reason=說好的減肥呢]]', makeCtx(charId, { onCharDaifuAccept }));

        expect(onCharDaifuAccept).not.toHaveBeenCalled();
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const order = msgs.find(m => m.type === 'mall_order');
        expect(order?.metadata?.status).toBe('declined');
        expect(order?.metadata?.declineReason).toBe('說好的減肥呢');
    });
});
