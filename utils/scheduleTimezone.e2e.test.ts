// 端到端釘住「用戶在中國 + 角色在紐約」時，日程全鏈路按角色那邊的時間走。
//
// 迴歸守衛：同一時刻（北京 21:00 == 紐約 09:00），若哪天有人把某個環節改回讀設備時間，
// 當前時段就會從「晨間畫草稿」跳到「睡前刷畫集」，下面的斷言會掛。
// 這正是用戶反饋的現象：角色那邊明明是早上 9 點，卡片卻把晚上 21 點標成進行中。
import { afterAll, describe, expect, it } from 'vitest';
import { ContextBuilder } from '../utils/context';
import { getFlowNarrativeKey } from '../utils/scheduleInjection';
import { getCurrentScheduleSlotIndex, getScheduleDateKey, getScheduleWallClock } from '../utils/scheduleTime';
import type { CharacterProfile, DailySchedule, ScheduleSlot } from '../types';

const originalTimeZone = process.env.TZ;
afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});

/** 北京時間 2026-07-26 21:00 == 紐約同日 09:00（EDT, UTC-4）。 */
const INSTANT = new Date('2026-07-26T13:00:00Z');

const nyChar = {
    id: 'char-ny',
    customTimezoneEnabled: true,
    customTimezone: 'America/New_York',
} as unknown as CharacterProfile;

const slots: ScheduleSlot[] = [
    { startTime: '09:00', activity: '晨間畫草稿', description: '開著窗畫線稿' },
    { startTime: '13:00', activity: '午後遛狗' },
    { startTime: '21:00', activity: '睡前刷畫集' },
];

const schedule = {
    id: 'char-ny_2026-07-26',
    charId: 'char-ny',
    date: '2026-07-26',
    slots,
    generatedAt: INSTANT.getTime(),
    flowNarrative: {
        morning: '剛醒，咖啡還沒喝完就想先把線稿開個頭。',
        afternoon: '下午有點曬，遛完狗人是懶的。',
        evening: '今天畫完了，躺著刷畫集。',
    },
} as unknown as DailySchedule;

describe('日程跟隨角色時區（用戶在中國 / 角色在紐約）', () => {
    it('當前時段按紐約 09:00 判定，而不是設備的 21:00', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(getCurrentScheduleSlotIndex(slots, nyChar, INSTANT)).toBe(0);
    });

    it('同一時刻若退回設備時間會落到晚上那條——守衛這個差異', () => {
        process.env.TZ = 'Asia/Shanghai';
        const withCharClock = getCurrentScheduleSlotIndex(slots, nyChar, INSTANT);
        const withDeviceClock = getCurrentScheduleSlotIndex(slots, null, INSTANT);

        expect(slots[withCharClock].activity).toBe('晨間畫草稿');
        expect(slots[withDeviceClock].activity).toBe('睡前刷畫集');
        expect(withCharClock).not.toBe(withDeviceClock);
    });

    it('日期 key 用紐約的日曆日', () => {
        process.env.TZ = 'Asia/Shanghai';
        expect(getScheduleDateKey(nyChar, INSTANT)).toBe('2026-07-26');
    });

    it('餵給模型的日程注入說的是「晨間畫草稿」，不是「睡前刷畫集」', () => {
        process.env.TZ = 'Asia/Shanghai';
        const charNow = getScheduleWallClock(nyChar, INSTANT);
        const injected = ContextBuilder.buildScheduleInjection(schedule, undefined, charNow);

        expect(injected).toContain('晨間畫草稿');
        expect(injected).not.toContain('睡前刷畫集');
    });

    it('意識流選 morning 段，不是 evening 段', () => {
        process.env.TZ = 'Asia/Shanghai';
        const charNow = getScheduleWallClock(nyChar, INSTANT);

        expect(getFlowNarrativeKey(charNow.getHours())).toBe('morning');
        expect(ContextBuilder.buildScheduleInjection(schedule, undefined, charNow)).toContain('咖啡還沒喝完');
    });

    it('沒開自定義時區的角色仍跟隨設備時間', () => {
        process.env.TZ = 'Asia/Shanghai';
        const plain = { ...nyChar, customTimezoneEnabled: false } as CharacterProfile;

        expect(getScheduleWallClock(plain, INSTANT).getHours()).toBe(INSTANT.getHours());
        expect(getCurrentScheduleSlotIndex(slots, plain, INSTANT)).toBe(2);
    });
});
