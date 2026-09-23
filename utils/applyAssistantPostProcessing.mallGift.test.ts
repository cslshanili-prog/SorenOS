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

describe('端到端：角色主動送禮 + 禮物已讀確認', () => {
    it('角色發 GIFT：onCharGiftSend 收到正確金額，落一張 sent 狀態的禮物卡', async () => {
        const charId = `c-gift-${Date.now()}`;
        const onCharGiftSend = vi.fn().mockResolvedValue(true);

        await applyAssistantPostProcessing(
            '路過甜品店給你帶了個~[[ACTION:GIFT|item=草莓蛋糕|price=23|note=還熱乎]]',
            makeCtx(charId, { onCharGiftSend }),
        );

        expect(onCharGiftSend).toHaveBeenCalledWith(23);
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const order = msgs.find(m => m.type === 'mall_order');
        expect(order?.role).toBe('assistant');
        expect(order?.metadata).toMatchObject({ mode: 'gift', total: 23, status: 'sent', note: '還熱乎' });
    });

    it('用戶送的禮物在角色下一輪回復後自動標記已讀（acknowledged）', async () => {
        const charId = `c-gift-ack-${Date.now()}`;
        await DB.saveMessage({
            charId, role: 'user', type: 'mall_order',
            content: '[購物中心卡片]',
            metadata: { mallKind: 'shop', mode: 'gift', items: [{ name: '毛絨手機掛件', price: 19.9, qty: 1 }], total: 19.9, status: 'sent' },
        });

        await applyAssistantPostProcessing('……摸起來還挺軟的', makeCtx(charId));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const gift = msgs.find(m => m.type === 'mall_order' && m.role === 'user');
        expect(gift?.metadata?.acknowledged).toBe(true);
    });
});
