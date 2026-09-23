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
        hooks: {
            setMessages: vi.fn(),
            addToast: vi.fn(),
        },
        ...overrides,
    };
};

// 迴歸用例：用戶實測「角色主動轉帳，查手機確認已扣款，但聊天窗口裡沒有出現轉帳卡」——
// 用 [API Response Debug] 面板拿到的真實 raw_content 端到端跑一遍
// applyAssistantPostProcessing（含真實 DB，不 mock chatParser），確認：
// 1) 不拋異常；2) onCharTransferSend 收到正確金額（對應查手機上真實觀察到的扣款）；
// 3) 轉帳卡確實落庫為 pending 狀態；4) 落庫後最後一次 hooks.setMessages 調用裡
//    已經帶著這張轉帳卡——也就是說數據鏈路本身是通的，前端拿到的 setMessages 參數
//    並不缺這張卡。真機上卡片沒出現，大概率是這之後（真實 setMessages 到渲染之間）
//    的前端狀態問題，不是這條數據管線的鍋。
describe('repro: 用戶實測的角色主動轉帳 raw_content 復現', () => {
    it('帶 [聊天] 時間戳前綴噪音的整段回覆：不拋異常，且落一張 pending 轉帳卡，並進了最後一次 setMessages', async () => {
        const charId = `c-transfer-repro-${Date.now()}`;
        const raw = `[2026-09-16 22:10] [聊天] 啊？沒到嗎

[2026-09-16 22:10] [聊天] 我這邊顯示發出去了啊……系統在哈我？

[2026-09-16 22:10] [聊天] 等下我再發一次

[[ACTION:TRANSFER|to=user|amount=10]]

[2026-09-16 22:10] [聊天] 這次看看有沒有`;

        const onCharTransferSend = vi.fn().mockResolvedValue(true);
        const setMessages = vi.fn();

        await expect(applyAssistantPostProcessing(raw, makeCtx(charId, {
            onCharTransferSend,
            hooks: { setMessages, addToast: vi.fn() },
        }))).resolves.not.toThrow();

        expect(onCharTransferSend).toHaveBeenCalledWith(10);

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const transferMsgs = msgs.filter(m => m.type === 'transfer');
        expect(transferMsgs.length).toBe(1);
        expect(transferMsgs[0].metadata?.status).toBe('pending');

        const lastCallArgs = setMessages.mock.calls[setMessages.mock.calls.length - 1]?.[0];
        expect(lastCallArgs?.some((m: any) => m.type === 'transfer')).toBe(true);
    }, 20000);
});
