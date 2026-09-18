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

describe('购物中心「外卖代付请求」AI 收发', () => {
    beforeEach(() => {
        getMessagesByCharId.mockReset();
        updateMessageMetadata.mockClear();
        saveMessage.mockClear();
    });

    it('[[ACTION:DAIFU_ACCEPT]]：找到待处理请求，调用 onCharDaifuAccept 并把状态改成 accepted', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 5, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 32, status: 'pending' } },
        ]);
        const onCharDaifuAccept = vi.fn().mockResolvedValue(true);

        await ChatParser.parseAndExecuteActions(
            '行，这顿我请了。[[ACTION:DAIFU_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        );

        expect(onCharDaifuAccept).toHaveBeenCalledWith(32);
        expect(updateMessageMetadata).toHaveBeenCalledWith(5, expect.any(Function));
        const updater = updateMessageMetadata.mock.calls[0][1];
        expect(updater({ status: 'pending' })).toMatchObject({ status: 'accepted' });
    });

    it('[[ACTION:DAIFU_DECLINE|reason=...]]：状态改成 declined 并带上原因，不调用 onCharDaifuAccept', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 6, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 23, status: 'pending' } },
        ]);
        const onCharDaifuAccept = vi.fn();

        await ChatParser.parseAndExecuteActions(
            '不行。[[ACTION:DAIFU_DECLINE|reason=说好的减肥呢]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        );

        expect(onCharDaifuAccept).not.toHaveBeenCalled();
        const updater = updateMessageMetadata.mock.calls[0][1];
        expect(updater({ status: 'pending' })).toMatchObject({ status: 'declined', declineReason: '说好的减肥呢' });
    });

    it('onCharDaifuAccept 返回 false（角色余额不足）：自动改判 declined 并带系统原因', async () => {
        getMessagesByCharId.mockResolvedValue([
            { id: 7, type: 'mall_order', role: 'user', timestamp: 1000, metadata: { mode: 'daifu', total: 9999, status: 'pending' } },
        ]);
        const onCharDaifuAccept = vi.fn().mockResolvedValue(false);

        await ChatParser.parseAndExecuteActions(
            '这顿我请了！[[ACTION:DAIFU_ACCEPT]]',
            'char-1', '小夏', noopToast,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            onCharDaifuAccept,
        );

        expect(onCharDaifuAccept).toHaveBeenCalledWith(9999);
        const updater = updateMessageMetadata.mock.calls[0][1];
        expect(updater({ status: 'pending' })).toMatchObject({ status: 'declined', declineReason: '余额不够，付不出这笔钱' });
    });

    it('没有待处理的代付请求时静默忽略，不落库不报错', async () => {
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

    it('已经被处理过（非 pending）的请求不会被重复结算', async () => {
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

    it('没传 onCharDaifuAccept 时（旧调用方）不报错，只是不结算余额，但仍标记状态', async () => {
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
