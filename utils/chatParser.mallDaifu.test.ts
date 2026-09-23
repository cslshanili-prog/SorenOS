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

describe('購物中心「外賣代付請求」AI 收發', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('[[ACTION:DAIFU_ACCEPT]]：找到待處理請求，調用 onCharDaifuAccept 並把狀態改成 accepted', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 5, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 32, status: 'pending' } },
        ]);
        const onCharDaifuAccept = vi.fn().mockResolvedValue(true);

        await ChatParser.parseAndExecuteActions(
            '行，這頓我請了。[[ACTION:DAIFU_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        );

        expect(onCharDaifuAccept).toHaveBeenCalledWith(32);
        expect(updateMessageMetadata).toHaveBeenCalledWith(5, expect.any(Function));
        const updater = updateMessageMetadata.mock.calls[0][1];
        expect(updater({ status: 'pending' })).toMatchObject({ status: 'accepted' });
    });

    it('[[ACTION:DAIFU_DECLINE|reason=...]]：狀態改成 declined 並帶上原因，不調用 onCharDaifuAccept', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 6, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 23, status: 'pending' } },
        ]);
        const onCharDaifuAccept = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '不行。[[ACTION:DAIFU_DECLINE|reason=說好的減肥呢]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        );

        expect(onCharDaifuAccept).not.toHaveBeenCalled();
        const updater = updateMessageMetadata.mock.calls[0][1];
        expect(updater({ status: 'pending' })).toMatchObject({ status: 'declined', declineReason: '說好的減肥呢' });
    });

    it('onCharDaifuAccept 返回 false（角色餘額不足）：自動改判 declined 並帶系統原因', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 7, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 9999, status: 'pending' } },
        ]);
        const onCharDaifuAccept = vi.fn().mockResolvedValue(false);

        await ChatParser.parseAndExecuteActions(
            '這頓我請了！[[ACTION:DAIFU_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        );

        expect(onCharDaifuAccept).toHaveBeenCalledWith(9999);
        const updater = updateMessageMetadata.mock.calls[0][1];
        expect(updater({ status: 'pending' })).toMatchObject({ status: 'declined', declineReason: '餘額不夠，付不出這筆錢' });
    });

    it('沒有待處理的代付請求時靜默忽略，不落庫不報錯', async () => {
        getMessagesByCharId.mockResolvedValue([]);
        const onCharDaifuAccept = vi.fn();

        await expect(ChatParser.parseAndExecuteActions(
            '行。[[ACTION:DAIFU_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        )).resolves.not.toThrow();

        expect(onCharDaifuAccept).not.toHaveBeenCalled();
        expect(updateMessageMetadata).not.toHaveBeenCalled();
    });

    it('已經被處理過（非 pending）的請求不會被重複結算', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 8, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 20, status: 'accepted' } },
        ]);
        const onCharDaifuAccept = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '[[ACTION:DAIFU_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        );

        expect(onCharDaifuAccept).not.toHaveBeenCalled();
    });

    it('沒傳 onCharDaifuAccept 時（舊調用方）不報錯，只是不結算餘額，但仍標記狀態', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 9, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 20, status: 'pending' } },
        ]);

        await expect(ChatParser.parseAndExecuteActions(
            '行。[[ACTION:DAIFU_ACCEPT]]',
            'char-1', '小夏', noopToast,
        )).resolves.not.toThrow();

        const updater = updateMessageMetadata.mock.calls[0][1];
        expect(updater({ status: 'pending' })).toMatchObject({ status: 'accepted' });
    });
});
