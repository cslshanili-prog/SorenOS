import { describe, expect, it } from 'vitest';
import {
    buildBlockUserPrompt, CHAT_BLOCK_LOG_MAX, charBlockPeriods, endChatBlock, extractBlockUser, firstReconsiderAt,
    isCharBlockingUser, isReconsiderDue, isRejectedByBlock, isUserBlockingChar, parseReconsider, postponeReconsider,
    startChatBlock, blockNotes, CHAR_BLOCK_RETRY_MS,
} from './chatBlock';

const H = 3600_000;

describe('拉黑狀態', () => {
    it('用戶拉黑角色：沒有冷靜期；已在拉黑中不重來', () => {
        const patch = startChatBlock({}, 'user', 1000)!;
        expect(patch.chatBlock).toEqual({ by: 'user', since: 1000 });
        expect(isUserBlockingChar(patch)).toBe(true);
        expect(isCharBlockingUser(patch)).toBe(false);
        expect(startChatBlock(patch, 'char', 2000)).toBeNull();
    });

    it('角色拉黑用戶：記原因、冷靜期照所選那檔', () => {
        const patch = startChatBlock({ charBlockCooldown: 'short' }, 'char', 0, { reason: ' 你又放我鴿子 ', random: () => 0 })!;
        expect(patch.chatBlock).toMatchObject({ by: 'char', since: 0, reason: '你又放我鴿子', reconsiderAt: 3 * H });
        expect(firstReconsiderAt(0, undefined, () => 1)).toBe(48 * H);
        expect(firstReconsiderAt(0, 'long', () => 0)).toBe(48 * H);
    });

    it('到點判斷、沒解除就 24 小時後再想', () => {
        const state = { by: 'char' as const, since: 0, reconsiderAt: 10 };
        expect(isReconsiderDue({ chatBlock: state }, 9)).toBe(false);
        expect(isReconsiderDue({ chatBlock: state }, 10)).toBe(true);
        expect(postponeReconsider(state, 100).reconsiderAt).toBe(100 + CHAR_BLOCK_RETRY_MS);
        expect(isReconsiderDue({ chatBlock: { by: 'user', since: 0 } }, 1e12)).toBe(false);
    });

    it('解除收進記錄，記錄有上限', () => {
        const log = Array.from({ length: CHAT_BLOCK_LOG_MAX }, (_, i) => ({ by: 'user' as const, since: i, until: i + 1 }));
        const patch = endChatBlock({ chatBlock: { by: 'char', since: 100, reason: '氣' }, chatBlockLog: log }, 200)!;
        expect(patch.chatBlock).toBeUndefined();
        expect(patch.chatBlockLog).toHaveLength(CHAT_BLOCK_LOG_MAX);
        expect(patch.chatBlockLog!.at(-1)).toEqual({ by: 'char', since: 100, until: 200, reason: '氣' });
        expect(endChatBlock({}, 1)).toBeNull();
    });
});

describe('被拒收的訊息', () => {
    const char = { chatBlock: { by: 'char' as const, since: 500 }, chatBlockLog: [{ by: 'char' as const, since: 100, until: 200 }, { by: 'user' as const, since: 300, until: 400 }] };
    const periods = charBlockPeriods(char);

    it('只算角色拉黑用戶的時段（含進行中）', () => {
        expect(periods).toEqual([{ since: 100, until: 200 }, { since: 500, until: Infinity }]);
    });

    it('只有用戶自己發的、時間在時段內的才算；隱藏提示不算', () => {
        expect(isRejectedByBlock({ role: 'user', timestamp: 150 }, periods)).toBe(true);
        expect(isRejectedByBlock({ role: 'user', timestamp: 200 }, periods)).toBe(false);
        expect(isRejectedByBlock({ role: 'user', timestamp: 350 }, periods)).toBe(false);
        expect(isRejectedByBlock({ role: 'user', timestamp: 9999 }, periods)).toBe(true);
        expect(isRejectedByBlock({ role: 'assistant', timestamp: 150 }, periods)).toBe(false);
        expect(isRejectedByBlock({ role: 'user', timestamp: 150, metadata: { proactiveHint: true } }, periods)).toBe(false);
    });
});

describe('拉黑標籤', () => {
    it('剝掉標籤、取原因；別名與全形標點也認', () => {
        expect(extractBlockUser('我不想再說了\n[[ACTION:BLOCK_USER|你太過分了]]')).toEqual({ cleanedText: '我不想再說了', block: { reason: '你太過分了' } });
        expect(extractBlockUser('夠了 [[ACTION：拉黑｜「騙我」]]').block).toEqual({ reason: '騙我' });
        expect(extractBlockUser('[[ACTION:BLOCK]]').block).toEqual({ reason: '' });
        expect(extractBlockUser('沒事啦')).toEqual({ cleanedText: '沒事啦', block: null });
    });

    it('提示詞寫清楚是重的決定', () => {
        expect(buildBlockUserPrompt('小雨')).toContain('[[ACTION:BLOCK_USER|原因]]');
        expect(buildBlockUserPrompt('小雨')).toContain('不要');
    });
});

describe('解除判斷與文字', () => {
    it('看得懂的 JSON 才算解除；不解除時不帶話', () => {
        expect(parseReconsider({ unblock: true, message: ' 算了，原諒你 ' })).toEqual({ unblock: true, message: '算了，原諒你' });
        expect(parseReconsider({ unblock: false, message: '哼' })).toEqual({ unblock: false, message: '' });
        expect(parseReconsider(null)).toEqual({ unblock: false, message: '' });
    });

    it('系統提示帶拉黑多久', () => {
        expect(blockNotes.charUnblocked('Sully', '我', 0, 3 * 24 * H)).toContain('3 天');
        expect(blockNotes.userUnblocked('我', 'Sully', 0, 5 * H)).toContain('5 小時');
    });
});
