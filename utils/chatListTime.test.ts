import { describe, it, expect } from 'vitest';
import { formatChatListTimestamp } from './chatListTime';

// 固定"現在" = 2026-09-14（週一）14:30:00 本地時間，逐一驗證各檔位。
const NOW = new Date(2026, 8, 14, 14, 30, 0).getTime();

describe('formatChatListTimestamp', () => {
    it('今天的消息顯示 HH:MM', () => {
        const t = new Date(2026, 8, 14, 9, 5, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('09:05');
    });

    it('昨天顯示"昨天"，跟今天差幾個小時無關，只看日期', () => {
        const t = new Date(2026, 8, 13, 23, 59, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('昨天');
    });

    it('一週內（不含今天昨天）顯示星期幾', () => {
        const t = new Date(2026, 8, 10, 8, 0, 0).getTime(); // 週四
        expect(formatChatListTimestamp(t, NOW)).toBe('星期四');
    });

    it('超過一週、同年顯示 M/D', () => {
        const t = new Date(2026, 7, 20, 8, 0, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('8/20');
    });

    it('跨年顯示 YYYY/M/D', () => {
        const t = new Date(2025, 11, 25, 8, 0, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('2025/12/25');
    });

    it('未來時間戳（時鐘漂移等）當作今天處理，不報負數天數', () => {
        const t = new Date(2026, 8, 14, 23, 0, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('23:00');
    });
});
