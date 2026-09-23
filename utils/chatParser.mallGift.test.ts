import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMessagesByCharId = vi.fn();
const updateMessageMetadata = vi.fn(async (_id: number, _updater: (prev: any) => any) => {});
const saveMessage = vi.fn(async () => 1);

vi.mock('./db', () => ({
    DB: {
        getMessagesByCharId: (...args: any[]) => getMessagesByCharId(...args),
        updateMessageMetadata: (...args: any[]) => updateMessageMetadata(...args),
        saveMessage: (...args: any[]) => saveMessage(...args),
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
                mode: 'gift', total: 23, note: '路過甜品店', status: 'sent',
                items: [{ name: '草莓蛋糕', price: 23, qty: 1 }],
            }),
        }));
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
