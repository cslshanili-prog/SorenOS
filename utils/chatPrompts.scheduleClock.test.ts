import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 角色關掉「時間感知強化」後，日程塊曾經照舊寫著「當前時段：22:00 你正在睡覺」——
// 精確鐘點從這條縫裡漏了出去，而擋住它正是那個開關存在的意義。
// 天氣塊早就按 includeTime 處理過同一件事（天氣照給、只抽掉時間行），日程這條補齊。
// 日程本身不受這個開關影響：它有自己的總開關。

vi.mock('./dailySchedule', () => ({
    getDailyScheduleForChar: vi.fn(async () => ({
        id: 'char-clock_2026-08-19',
        charId: 'char-clock',
        date: '2026-08-19',
        generatedAt: Date.now(),
        slots: [
            { startTime: '00:00', activity: '睡覺', location: '家' },
            { startTime: '23:30', activity: '看劇' },
        ],
    })),
}));

import { ChatPrompts } from './chatPrompts';

const userProfile = { name: '小明' } as any;

const buildVolatile = async (timeAwarenessEnabled: boolean | undefined) => {
    const char = {
        id: 'char-clock',
        name: '阿一',
        scheduleFeatureEnabled: true,
        ...(timeAwarenessEnabled === undefined ? {} : { timeAwarenessEnabled }),
    } as any;
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], [],
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined,
    );
    return parts.volatileState;
};

// 「當前時段」是照真實的現在挑的：不把時間釘住，23:30 之後跑這個檔，當前時段就換成「看劇」，
// 下面寫死「睡覺」的斷言跟著變紅。
// 用本地時間的建構子釘——測試角色沒開自定義時區、跟著設備走，所以不管跑測試的機器在哪個時區，
// 角色那邊都是 2026-08-19（對上 mock 日程的日期）的正午，穩穩落在「睡覺」那段裡。
const FIXED_NOW = new Date(2026, 7, 19, 12, 0, 0);

describe('日程塊的鐘點跟著「時間感知」開關走', () => {
    beforeEach(() => {
        // 只假 Date：buildSystemPromptParts 裡有真的 setTimeout（等節假日的逾時），計時器一起假會卡住
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('開著（默認）時照常報時段', async () => {
        const volatile = await buildVolatile(undefined);
        expect(volatile).toContain('當前時段：00:00 你正在睡覺');
        expect(volatile).toContain('- 23:30 看劇');
    });

    it('關掉後活動還在，但鐘點整個消失', async () => {
        const volatile = await buildVolatile(false);
        expect(volatile).toContain('你正在睡覺');
        expect(volatile).toContain('看劇');
        expect(volatile).not.toContain('00:00');
        expect(volatile).not.toContain('23:30');
    });

    it('關掉後也不教改日程——那條指令拿時段當定位符', async () => {
        const volatile = await buildVolatile(false);
        expect(volatile).not.toContain('CHANGE_SCHEDULE');
    });
});
