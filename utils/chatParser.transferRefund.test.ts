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
