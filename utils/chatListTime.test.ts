import { describe, it, expect } from 'vitest';
import { formatChatListTimestamp } from './chatListTime';

// 固定"现在" = 2026-09-14（周一）14:30:00 本地时间，逐一验证各档位。
const NOW = new Date(2026, 8, 14, 14, 30, 0).getTime();

describe('formatChatListTimestamp', () => {
    it('今天的消息显示 HH:MM', () => {
        const t = new Date(2026, 8, 14, 9, 5, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('09:05');
    });

    it('昨天显示"昨天"，跟今天差几个小时无关，只看日期', () => {
        const t = new Date(2026, 8, 13, 23, 59, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('昨天');
    });

    it('一周内（不含今天昨天）显示星期几', () => {
        const t = new Date(2026, 8, 10, 8, 0, 0).getTime(); // 周四
        expect(formatChatListTimestamp(t, NOW)).toBe('星期四');
    });

    it('超过一周、同年显示 M/D', () => {
        const t = new Date(2026, 7, 20, 8, 0, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('8/20');
    });

    it('跨年显示 YYYY/M/D', () => {
        const t = new Date(2025, 11, 25, 8, 0, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('2025/12/25');
    });

    it('未来时间戳（时钟漂移等）当作今天处理，不报负数天数', () => {
        const t = new Date(2026, 8, 14, 23, 0, 0).getTime();
        expect(formatChatListTimestamp(t, NOW)).toBe('23:00');
    });
});
