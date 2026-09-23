// 角色寫下的時間文本要按 ta 自己的時區還原成真實時刻。
//
// 迴歸守衛：定時消息 [schedule_message | YYYY-MM-DD HH:MM:SS | ...] 原本直接 new Date(文本)，
// 按設備時區解釋。角色在紐約看著自己的上午 09:00 說「今晚 21:00 找你」，
// 設備在中國就會把它當成北京 21:00（= 紐約當天 09:00），消息當場就到期了。
import { afterAll, describe, expect, it } from 'vitest';
import { nowInTimeZone, wallClockToTimestamp } from './timezone';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});

describe('wallClockToTimestamp', () => {
    it('角色在紐約寫的 21:00 還原成紐約的 21:00，不是設備的 21:00', () => {
        process.env.TZ = 'Asia/Shanghai';
        const ts = wallClockToTimestamp('2026-07-26 21:00:00', 'America/New_York');

        // 紐約 2026-07-26 21:00 (EDT, UTC-4) == UTC 2026-07-27 01:00
        expect(new Date(ts).toISOString()).toBe('2026-07-27T01:00:00.000Z');
    });

    it('和 nowInTimeZone 互為逆運算', () => {
        process.env.TZ = 'Asia/Shanghai';
        const tz = 'America/New_York';
        const wall = nowInTimeZone(tz, new Date('2026-07-26T13:00:00Z'));
        const text = `${wall.getFullYear()}-${String(wall.getMonth() + 1).padStart(2, '0')}-${String(wall.getDate()).padStart(2, '0')} `
            + `${String(wall.getHours()).padStart(2, '0')}:${String(wall.getMinutes()).padStart(2, '0')}:00`;

        expect(wallClockToTimestamp(text, tz)).toBe(new Date('2026-07-26T13:00:00Z').getTime());
    });

    it('不傳時區時與 new Date(文本) 行為一致', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(wallClockToTimestamp('2026-07-26 21:00:00'))
            .toBe(new Date('2026-07-26T21:00:00').getTime());
    });

    it('角色在東京、設備在紐約（反向時差）也成立', () => {
        process.env.TZ = 'America/New_York';
        const ts = wallClockToTimestamp('2026-07-26 08:00:00', 'Asia/Tokyo');

        // 東京 2026-07-26 08:00 (UTC+9) == UTC 2026-07-25 23:00
        expect(new Date(ts).toISOString()).toBe('2026-07-25T23:00:00.000Z');
    });

    it('非法文本返回 NaN，交給調用方判', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(Number.isNaN(wallClockToTimestamp('不是時間', 'America/New_York'))).toBe(true);
    });
});
