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

describe('[[ACTION:TRANSFER_RETURN]] 退款回調', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('角色退回用戶待處理的轉帳：調用 onUserTransferReturned 退款正確金額', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferReturned = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '這次不能收，退給你。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            onUserTransferReturned,
        );

        expect(onUserTransferReturned).toHaveBeenCalledTimes(1);
        expect(onUserTransferReturned).toHaveBeenCalledWith(500);
    });

    it('角色收下（accepted）不觸發退款回調', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferReturned = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '謝謝你！我收下啦。[[ACTION:TRANSFER_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            onUserTransferReturned,
        );

        expect(onUserTransferReturned).not.toHaveBeenCalled();
    });

    it('沒有待處理轉帳時不觸發回調（靜默忽略，不落假回執）', async () => {
        getMessagesByCharId.mockResolvedValue([]);
        const onUserTransferReturned = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '退給你啦。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            onUserTransferReturned,
        );

        expect(onUserTransferReturned).not.toHaveBeenCalled();
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('沒傳 onUserTransferReturned 時（舊調用方）不報錯，只是不退款', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 200, status: 'pending' } },
        ]);

        await expect(ChatParser.parseAndExecuteActions(
            '退給你。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
        )).resolves.not.toThrow();
    });
});

describe('[[ACTION:TRANSFER_ACCEPT]] 入帳回調', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('角色收下用戶待處理的轉帳：調用 onUserTransferAccepted 入帳正確金額', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferAccepted = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '謝謝你！我收下啦。[[ACTION:TRANSFER_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, onUserTransferAccepted,
        );

        expect(onUserTransferAccepted).toHaveBeenCalledTimes(1);
        expect(onUserTransferAccepted).toHaveBeenCalledWith(500);
    });

    it('角色退回（returned）不觸發入帳回調', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 500, status: 'pending' } },
        ]);
        const onUserTransferAccepted = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '這次不能收，退給你。[[ACTION:TRANSFER_RETURN]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, onUserTransferAccepted,
        );

        expect(onUserTransferAccepted).not.toHaveBeenCalled();
    });

    it('沒傳 onUserTransferAccepted 時（舊調用方）不報錯，只是不入帳', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 1, type: 'transfer', role: 'user', timestamp: 1000, metadata: { amount: 200, status: 'pending' } },
        ]);

        await expect(ChatParser.parseAndExecuteActions(
            '收下啦。[[ACTION:TRANSFER_ACCEPT]]',
            'char-1', '小夏', noopToast,
        )).resolves.not.toThrow();
    });
});

describe('[[ACTION:TRANSFER:N]] 角色主動轉帳 · 發送前扣款檢查', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('onCharTransferSend 返回 true：正常落待處理轉帳卡', async () => {
        const onCharTransferSend = vi.fn().mockResolvedValue(true);

        await ChatParser.parseAndExecuteActions(
            '給你轉一點。[[ACTION:TRANSFER:520]]',
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

    it('onCharTransferSend 返回 false（角色餘額不足）：跳過這筆轉帳，不落卡', async () => {
        const onCharTransferSend = vi.fn().mockResolvedValue(false);

        await ChatParser.parseAndExecuteActions(
            '給你轉一點。[[ACTION:TRANSFER:99999]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, onCharTransferSend,
        );

        expect(onCharTransferSend).toHaveBeenCalledTimes(1);
        expect(onCharTransferSend).toHaveBeenCalledWith(99999);
        expect(saveMessage).not.toHaveBeenCalled();
    });

    it('沒傳 onCharTransferSend 時（舊調用方）維持老行為，直接落卡', async () => {
        await ChatParser.parseAndExecuteActions(
            '給你轉一點。[[ACTION:TRANSFER:520]]',
            'char-1', '小夏', noopToast,
        );

        expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
            charId: 'char-1', role: 'assistant', type: 'transfer',
            metadata: expect.objectContaining({ amount: '520', status: 'pending' }),
        }));
    });
});
