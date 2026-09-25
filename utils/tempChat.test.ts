import { describe, expect, it } from 'vitest';
import {
    buildTempChatPrompt, charCount, clipToChars, DEFAULT_TEMP_CHAT_LIMITS, firstTempAttemptAt, nextTempAttemptAt,
    normalizeTempChatLimits, parseTempChatReply, tempChatRemaining, tempChatThread,
} from './tempChat';

const H = 3600_000;
const msg = (from: 'user' | 'char', dayKey: string, timestamp = 0) => ({ timestamp, metadata: { tempChat: { from, dayKey } } });

describe('臨時會話上限', () => {
    it('沒設用預設 3 次 50 字；超出範圍夾回', () => {
        expect(normalizeTempChatLimits(undefined)).toEqual(DEFAULT_TEMP_CHAT_LIMITS);
        expect(normalizeTempChatLimits({ daily: 99, maxChars: 5 })).toEqual({ daily: 10, maxChars: 20 });
    });

    it('各算各的、只算今天', () => {
        const messages = [msg('user', '2026-09-25'), msg('user', '2026-09-25'), msg('char', '2026-09-25'), msg('user', '2026-09-24'), { metadata: {} }];
        const limits = { daily: 3, maxChars: 50 };
        expect(tempChatRemaining(messages, 'user', '2026-09-25', limits)).toBe(1);
        expect(tempChatRemaining(messages, 'char', '2026-09-25', limits)).toBe(2);
        expect(tempChatRemaining(messages, 'user', '2026-09-26', limits)).toBe(3);
        expect(tempChatRemaining([...messages, msg('user', '2026-09-25'), msg('user', '2026-09-25')], 'user', '2026-09-25', limits)).toBe(0);
    });

    it('字數照字算，emoji 算一個', () => {
        expect(charCount('哈囉😀')).toBe(3);
        expect(clipToChars(' 一二三四五 ', 3)).toBe('一二三');
    });

    it('只拿這段拉黑期間的臨時會話，依時間排', () => {
        const thread = tempChatThread([msg('char', 'd', 30), msg('user', 'd', 5), msg('user', 'd', 20), { timestamp: 25, metadata: {} }], 10);
        expect(thread.map(m => m.timestamp)).toEqual([20, 30]);
    });
});

describe('角色傳話的節奏', () => {
    it('第一次 1–4 小時後，之後隔 3–8 小時', () => {
        expect(firstTempAttemptAt(0, () => 0)).toBe(1 * H);
        expect(firstTempAttemptAt(0, () => 1)).toBe(4 * H);
        expect(nextTempAttemptAt(0, () => 0)).toBe(3 * H);
        expect(nextTempAttemptAt(0, () => 1)).toBe(8 * H);
    });
});

describe('提示詞與解析', () => {
    const base = { userName: '小雨', before: '', thread: '小雨: 對不起', remaining: 2, maxChars: 50, replying: true };

    it('角色是拉黑的那方：要決定回不回、解不解除', () => {
        const p = buildTempChatPrompt({ ...base, char: { name: 'Sully', chatBlock: { by: 'char', since: 0, reason: '放鴿子' } } });
        expect(p).toContain('放鴿子');
        expect(p).toContain('"unblock"');
        expect(p).toContain('今天還剩 2 次');
    });

    it('角色是被拉黑的那方：只寫要傳的話', () => {
        const p = buildTempChatPrompt({ ...base, replying: false, char: { name: 'Sully', chatBlock: { by: 'user', since: 0 } } });
        expect(p).toContain('把你（Sully）拉黑了');
        expect(p).not.toContain('"unblock"');
        expect(p).toContain('50 字以內');
    });

    it('JSON 照讀、截到上限；不是 JSON 就把整段當成話', () => {
        expect(parseTempChatReply({ message: '一二三四五', unblock: true }, '', 3)).toEqual({ message: '一二三', unblock: true });
        expect(parseTempChatReply(null, '「想你了」', 50)).toEqual({ message: '想你了', unblock: false });
        expect(parseTempChatReply(null, '{壞掉的', 50)).toEqual({ message: '', unblock: false });
    });
});
