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

describe('购物中心「角色主动送礼」AI 收发', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        getMessagesByCharId.mockResolvedValue([]);
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('[[ACTION:GIFT|...]]：调用 onCharGiftSend 并落一张 sent 状态的 mall_order 卡', async () => {
        const onCharGiftSend = vi.fn().mockResolvedValue(true);

        await ChatParser.parseAndExecuteActions(
            '给你带了个小礼物~[[ACTION:GIFT|item=草莓蛋糕|price=23|note=路过甜品店]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined,
            onCharGiftSend,
        );

        expect(onCharGiftSend).toHaveBeenCalledWith(23);
        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'mall_order',
            metadata: expect.objectContaining({
                mode: 'gift', total: 23, note: '路过甜品店', status: 'sent',
                items: [{ name: '草莓蛋糕', price: 23, qty: 1 }],
            }),
        }));
    });

    it('onCharGiftSend 返回 false（角色余额不足）：跳过这份礼物，不落卡', async () => {
        const onCharGiftSend = vi.fn().mockResolvedValue(false);

        await ChatParser.parseAndExecuteActions(
            '给你带了个礼物~[[ACTION:GIFT|item=钻戒|price=99999]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined,
            onCharGiftSend,
        );

        expect(onCharGiftSend).toHaveBeenCalledWith(99999);
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('没传 onCharGiftSend 时（旧调用方）维持老行为，直接落卡', async () => {
        await ChatParser.parseAndExecuteActions(
            '给你带了个礼物~[[ACTION:GIFT|item=咖啡|price=18]]',
            'char-1', '小夏', noopToast,
        );

        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'mall_order',
            metadata: expect.objectContaining({ mode: 'gift', total: 18, status: 'sent' }),
        }));
    });
});

describe('购物中心「礼物已读」自动确认（GIFT ACK）', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('角色这轮说话后，把用户最新一张未读的 sent 礼物卡标记 acknowledged', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 10, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'gift', status: 'sent' } },
        ]);

        await ChatParser.parseAndExecuteActions('……摸起来还挺软的', 'char-1', '小夏', noopToast);

        const ackCall = updateMessageMetadata.mock.calls.find(c => c[0] === 10);
        expect(ackCall).toBeTruthy();
        expect(ackCall![1]({ status: 'sent' })).toMatchObject({ acknowledged: true });
    });

    it('已经 acknowledged 过的礼物不会被重复处理', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 11, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'gift', status: 'sent', acknowledged: true } },
        ]);

        await ChatParser.parseAndExecuteActions('嗯', 'char-1', '小夏', noopToast);

        expect(updateMessageMetadata).not.toHaveBeenCalledWith(11, expect.any(Function));
    });

    it('daifu / manual 模式的卡不会被这条 ACK 逻辑误标', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 12, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', status: 'pending' } },
            { id: 13, type: 'mall_order', role: 'assistant', timestamp: 1000, metadata: { mode: 'manual', status: 'sent' } },
        ]);

        await ChatParser.parseAndExecuteActions('嗯', 'char-1', '小夏', noopToast);

        expect(updateMessageMetadata).not.toHaveBeenCalled();
    });

    it('没有待确认的礼物时不报错、不落库', async () => {
        getMessagesByCharId.mockResolvedValue([]);

        await expect(ChatParser.parseAndExecuteActions('嗯', 'char-1', '小夏', noopToast)).resolves.not.toThrow();
        expect(updateMessageMetadata).not.toHaveBeenCalled();
    });
});
