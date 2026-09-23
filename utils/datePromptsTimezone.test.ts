// 見面（Peek 開場）注入的「當前時間」必須是角色所在地的真實鐘點。
//
// 迴歸守衛：getRealTimeStr 曾把 nowInTimeZone 折算過的 Date 再餵給同樣會折算的
// ChatPrompts.formatDate，導致時間被多減一個時差——角色時區 America/New_York、
// 設備 Asia/Shanghai 時，紐約的 07-26 09:00 會被寫成 07-25 21:00，
// 而星期又取自只折算一次的 Date，於是日期和星期自相矛盾（25 號是週六，卻標週日）。
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DatePrompts } from './datePrompts';
import type { CharacterProfile, UserProfile } from '../types';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});
afterEach(() => vi.useRealTimers());

/** 北京 2026-07-26 21:00（週日）== 紐約同日 09:00（週日, EDT）。 */
const INSTANT = new Date('2026-07-26T13:00:00Z');

const userProfile = { name: '小明' } as UserProfile;

const makeChar = (overrides: Partial<CharacterProfile>): CharacterProfile => ({
    id: 'char-1',
    name: '小畫',
    persona: '畫師',
    ...overrides,
} as CharacterProfile);

const peekText = (char: CharacterProfile): string => {
    const { messages } = DatePrompts.buildPeekPayload({
        char,
        userProfile,
        allMsgs: [],
        emojis: [],
    });
    return messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
};

describe('見面 Peek 注入的當前時間跟隨角色時區', () => {
    it('角色在紐約時寫的是紐約的 09:00，不是被多減一個時差的 07-25 21:00', () => {
        process.env.TZ = 'Asia/Shanghai';
        vi.useFakeTimers();
        vi.setSystemTime(INSTANT);

        const text = peekText(makeChar({
            customTimezoneEnabled: true,
            customTimezone: 'America/New_York',
        }));

        expect(text).toContain('當前時間: 2026-07-26 09:00 週日');
        expect(text).not.toContain('2026-07-25');
    });

    it('日期與星期必須自洽（舊實現裡 07-25 會配上週日）', () => {
        process.env.TZ = 'Asia/Shanghai';
        vi.useFakeTimers();
        vi.setSystemTime(INSTANT);

        const text = peekText(makeChar({
            customTimezoneEnabled: true,
            customTimezone: 'America/New_York',
        }));

        const matched = /[当當]前[时時][间間]: (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} ([周週].)/.exec(text);
        expect(matched).not.toBeNull();

        const [, dateStr, weekday] = matched!;
        const days = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
        const [y, m, d] = dateStr.split('-').map(Number);
        expect(weekday).toBe(days[new Date(y, m - 1, d).getDay()]);
    });

    it('沒開自定義時區的角色仍寫設備時間', () => {
        process.env.TZ = 'Asia/Shanghai';
        vi.useFakeTimers();
        vi.setSystemTime(INSTANT);

        expect(peekText(makeChar({}))).toContain('當前時間: 2026-07-26 21:00 週日');
    });
});
