import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMessagesByCharId = vi.fn();
const updateMessageMetadata = vi.fn(async (_id: number, _updater: (prev: any) => any) => {});
const saveMessage = vi.fn(async () => 1);
const getAllMallProducts = vi.fn(async (): Promise<any[]> => []);
const saveMallOrder = vi.fn(async (_o: any) => {});

vi.mock('./db', () => ({
    DB: {
        getMessagesByCharId: (...args: any[]) => getMessagesByCharId(...args),
        updateMessageMetadata: (...args: any[]) => updateMessageMetadata(...args),
        saveMessage: (...args: any[]) => saveMessage(...args),
        getAllMallProducts: () => getAllMallProducts(),
        saveMallOrder: (...args: any[]) => saveMallOrder(...(args as [any])),
    },
}));

import { ChatParser } from './chatParser';

const noopToast = () => {};

describe('購物中心「角色主動送禮」AI 收發', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        getMessagesByCharId.mockResolvedValue([]);
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
        getAllMallProducts.mockReset();
        getAllMallProducts.mockResolvedValue([]);
        saveMallOrder.mockClear();
    });

    it('[[ACTION:GIFT|...]]：調用 onCharGiftSend 並落一張 sent 狀態的 mall_order 卡', async () => {
        const onCharGiftSend = vi.fn().mockResolvedValue(true);

        await ChatParser.parseAndExecuteActions(
            '給你帶了個小禮物~[[ACTION:GIFT|item=草莓蛋糕|price=23|note=路過甜品店]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined,
            onCharGiftSend,
        );

        expect(onCharGiftSend).toHaveBeenCalledWith(23);
        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'mall_order',
            metadata: expect.objectContaining({
                mallKind: 'shop', mode: 'gift', total: 23, note: '路過甜品店', status: 'sent',
                items: [{ name: '草莓蛋糕', price: 23, qty: 1, emoji: '🎁', shop: undefined }],
            }),
        }));
    });

    it('對得上目錄：照目錄的價格、emoji、店鋪；同一則的外賣合成一張單，並記一筆角色送的訂單', async () => {
        getAllMallProducts.mockResolvedValue([
            { id: 'p1', kind: 'food', categoryId: 'c', name: '燕麥拿鐵', price: 6.5, emoji: '☕', shop: 'Blue Bottle Coffee', createdAt: 0 },
            { id: 'p2', kind: 'food', categoryId: 'c', name: '巧克力核桃大餅乾', price: 5.75, emoji: '🍪', shop: 'Levain Bakery', createdAt: 0 },
        ]);
        const onCharGiftSend = vi.fn().mockResolvedValue(true);
        await ChatParser.parseAndExecuteActions(
            '幫你點了，趁熱喝。\n[[ACTION:GIFT|item=燕麥拿鐵|kind=food|price=99]]\n[[ACTION:GIFT|item=巧克力核桃大餅乾|qty=2|note=加班辛苦]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, 9000, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined,
            onCharGiftSend,
        );
        expect(onCharGiftSend).toHaveBeenCalledTimes(1);
        expect(onCharGiftSend).toHaveBeenCalledWith(18);
        expect(saveMessage).toHaveBeenCalledTimes(1);
        const meta = (saveMessage.mock.calls[0] as any[])[0].metadata;
        expect(meta).toMatchObject({ mallKind: 'food', total: 18, paidAt: 9000, note: '加班辛苦' });
        expect(meta.items).toEqual([
            { name: '燕麥拿鐵', price: 6.5, qty: 1, emoji: '☕', shop: 'Blue Bottle Coffee' },
            { name: '巧克力核桃大餅乾', price: 5.75, qty: 2, emoji: '🍪', shop: 'Levain Bakery' },
        ]);
        expect(saveMallOrder).toHaveBeenCalledWith(expect.objectContaining({
            id: meta.orderId, kind: 'food', buyer: 'char', recipient: 'user', payer: 'char', charId: 'char-1', charName: '小夏', paidAt: 9000, total: 18,
        }));
    });

    it('對不上目錄又沒寫價格：丟掉，不扣錢不落卡', async () => {
        const onCharGiftSend = vi.fn().mockResolvedValue(true);
        await ChatParser.parseAndExecuteActions(
            '[[ACTION:GIFT|item=神秘禮物]]', 'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined,
            onCharGiftSend,
        );
        expect(onCharGiftSend).not.toHaveBeenCalled();
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('背景路徑單獨調 settleMallCommands 也會結算、剝標籤', async () => {
        const onCharGiftSend = vi.fn().mockResolvedValue(true);
        const text = await ChatParser.settleMallCommands('給你叫了花[[ACTION:GIFT|item=向日葵花束|kind=shop|price=39.99]]', 'char-1', { charName: '小夏', onCharGiftSend });
        expect(text).toBe('給你叫了花');
        expect(onCharGiftSend).toHaveBeenCalledWith(39.99);
        expect(saveMessage).toHaveBeenCalledTimes(1);
    });

    it('onCharGiftSend 返回 false（角色餘額不足）：跳過這份禮物，不落卡', async () => {
        const onCharGiftSend = vi.fn().mockResolvedValue(false);

        await ChatParser.parseAndExecuteActions(
            '給你帶了個禮物~[[ACTION:GIFT|item=鑽戒|price=99999]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined,
            onCharGiftSend,
        );

        expect(onCharGiftSend).toHaveBeenCalledWith(99999);
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('沒傳 onCharGiftSend 時（舊調用方）維持老行為，直接落卡', async () => {
        await ChatParser.parseAndExecuteActions(
            '給你帶了個禮物~[[ACTION:GIFT|item=咖啡|price=18]]',
            'char-1', '小夏', noopToast,
        );

        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'mall_order',
            metadata: expect.objectContaining({ mode: 'gift', total: 18, status: 'sent' }),
        }));
    });
});

describe('購物中心「禮物已讀」自動確認（GIFT ACK）', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('角色這輪說話後，把用戶最新一張未讀的 sent 禮物卡標記 acknowledged', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 10, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'gift', status: 'sent' } },
        ]);

        await ChatParser.parseAndExecuteActions('……摸起來還挺軟的', 'char-1', '小夏', noopToast);

        const ackCall = updateMessageMetadata.mock.calls.find(c => c[0] === 10);
        expect(ackCall).toBeTruthy();
        expect(ackCall![1]({ status: 'sent' })).toMatchObject({ acknowledged: true });
    });

    it('已經 acknowledged 過的禮物不會被重複處理', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 11, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'gift', status: 'sent', acknowledged: true } },
        ]);

        await ChatParser.parseAndExecuteActions('嗯', 'char-1', '小夏', noopToast);

        expect(updateMessageMetadata).not.toHaveBeenCalledWith(11, expect.any(Function));
    });

    it('daifu / manual 模式的卡不會被這條 ACK 邏輯誤標', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 12, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', status: 'pending' } },
            { id: 13, type: 'mall_order', role: 'assistant', timestamp: 1000, metadata: { mode: 'manual', status: 'sent' } },
        ]);

        await ChatParser.parseAndExecuteActions('嗯', 'char-1', '小夏', noopToast);

        expect(updateMessageMetadata).not.toHaveBeenCalled();
    });

    it('沒有待確認的禮物時不報錯、不落庫', async () => {
        getMessagesByCharId.mockResolvedValue([]);

        await expect(ChatParser.parseAndExecuteActions('嗯', 'char-1', '小夏', noopToast)).resolves.not.toThrow();
        expect(updateMessageMetadata).not.toHaveBeenCalled();
    });
});
