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

// 回归用例：用户实测「角色主动转账，查手机确认已扣款，但聊天窗口里没有出现转账卡」——
// 用 [API Response Debug] 面板拿到的真实 raw_content 端到端跑一遍
// applyAssistantPostProcessing（含真实 DB，不 mock chatParser），确认：
// 1) 不抛异常；2) onCharTransferSend 收到正确金额（对应查手机上真实观察到的扣款）；
// 3) 转账卡确实落库为 pending 状态；4) 落库后最后一次 hooks.setMessages 调用里
//    已经带着这张转账卡——也就是说数据链路本身是通的，前端拿到的 setMessages 参数
//    并不缺这张卡。真机上卡片没出现，大概率是这之后（真实 setMessages 到渲染之间）
//    的前端状态问题，不是这条数据管线的锅。
describe('repro: 用户实测的角色主动转账 raw_content 复现', () => {
    it('带 [聊天] 时间戳前缀噪音的整段回复：不抛异常，且落一张 pending 转账卡，并进了最后一次 setMessages', async () => {
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
