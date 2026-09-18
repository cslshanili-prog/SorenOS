import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMessagesByCharId = vi.fn();
const updateMessageMetadata = vi.fn(async () => {});
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

describe('[[ACTION:TRANSFER_RETURN]] 退款回调', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('角色退回用户待处理的转账：调用 onUserTransferReturned 退款正确金额', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferReturned = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '这次不能收，退给你。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            onUserTransferReturned,
        );

        expect(onUserTransferReturned).toHaveBeenCalledTimes(1);
        expect(onUserTransferReturned).toHaveBeenCalledWith(500);
    });

    it('角色收下（accepted）不触发退款回调', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferReturned = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '谢谢你！我收下啦。[[ACTION:TRANSFER_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            onUserTransferReturned,
        );

        expect(onUserTransferReturned).not.toHaveBeenCalled();
    });

    it('没有待处理转账时不触发回调（静默忽略，不落假回执）', async () => {
        getMessagesByCharId.mockResolvedValue([]);
        const onUserTransferReturned = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '退给你啦。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            onUserTransferReturned,
        );

        expect(onUserTransferReturned).not.toHaveBeenCalled();
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('没传 onUserTransferReturned 时（旧调用方）不报错，只是不退款', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 200, status: 'pending' } },
        ]);

        await expect(ChatParser.parseAndExecuteActions(
            '退给你。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
        )).resolves.not.toThrow();
    });
});

describe('[[ACTION:TRANSFER_ACCEPT]] 入账回调', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('角色收下用户待处理的转账：调用 onUserTransferAccepted 入账正确金额', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferAccepted = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '谢谢你！我收下啦。[[ACTION:TRANSFER_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, onUserTransferAccepted,
        );

        expect(onUserTransferAccepted).toHaveBeenCalledTimes(1);
        expect(onUserTransferAccepted).toHaveBeenCalledWith(500);
    });

    it('角色退回（returned）不触发入账回调', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferAccepted = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '这次不能收，退给你。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, onUserTransferAccepted,
        );

        expect(onUserTransferAccepted).not.toHaveBeenCalled();
    });

    it('没传 onUserTransferAccepted 时（旧调用方）不报错，只是不入账', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 200, status: 'pending' } },
        ]);

        await expect(ChatParser.parseAndExecuteActions(
            '收下啦。[[ACTION:TRANSFER_ACCEPT]]',
            'char-1', '小夏', noopToast,
        )).resolves.not.toThrow();
    });
});

describe('[[ACTION:TRANSFER:N]] 角色主动转账 · 发送前扣款检查', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('onCharTransferSend 返回 true：正常落待处理转账卡', async () => {
        const onCharTransferSend = vi.fn().mockResolvedValue(true);

        await ChatParser.parseAndExecuteActions(
            '给你转一点。[[ACTION:TRANSFER:520]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, onCharTransferSend,
        );

        expect(onCharTransferSend).toHaveBeenCalledTimes(1);
        expect(onCharTransferSend).toHaveBeenCalledWith(520);
        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'transfer',
            metadata: expect.objectContaining({ amount: '520', status: 'pending' }),
        }));
    });

    it('onCharTransferSend 返回 false（角色余额不足）：跳过这笔转账，不落卡', async () => {
        const onCharTransferSend = vi.fn().mockResolvedValue(false);

        await ChatParser.parseAndExecuteActions(
            '给你转一点。[[ACTION:TRANSFER:99999]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, onCharTransferSend,
        );

        expect(onCharTransferSend).toHaveBeenCalledTimes(1);
        expect(onCharTransferSend).toHaveBeenCalledWith(99999);
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('没传 onCharTransferSend 时（旧调用方）维持老行为，直接落卡', async () => {
        await ChatParser.parseAndExecuteActions(
            '给你转一点。[[ACTION:TRANSFER:520]]',
            'char-1', '小夏', noopToast,
        );

        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'transfer',
            metadata: expect.objectContaining({ amount: '520', status: 'pending' }),
        }));
    });
});
