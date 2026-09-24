import { beforeEach, describe, expect, it } from 'vitest';
import {
    CHAR_CALL_COOLDOWN_MS, CHAR_CALL_RING_MS, canCharCallNow, describeCharCall, effectiveCallStatus,
    extractCharCall, formatCharCallRecord, markCharCallAttempt, shouldRingNow,
} from './charCall';

describe('extractCharCall', () => {
    it('語音、視訊與原因', () => {
        const r = extractCharCall('等我一下\n[[ACTION:CALL|video|想看看你]]');
        expect(r.cleanedText).toBe('等我一下');
        expect(r.call).toEqual({ mode: 'video', reason: '想看看你' });
        expect(extractCharCall('[[ACTION:CALL|voice|有急事]]').call).toEqual({ mode: 'voice', reason: '有急事' });
    });

    it('模式寫在名字裡、中文別名、全形標點', () => {
        expect(extractCharCall('[[ACTION:VIDEO_CALL|想你了]]').call).toEqual({ mode: 'video', reason: '想你了' });
        expect(extractCharCall('[[ACTION：打電話｜「想聽你聲音」]]').call).toEqual({ mode: 'voice', reason: '想聽你聲音' });
        expect(extractCharCall('[[ACTION:CALL|視訊]]').call).toEqual({ mode: 'video', reason: '' });
    });

    it('沒寫模式預設語音；多個只取第一個', () => {
        expect(extractCharCall('[[ACTION:CALL|想你]]').call).toEqual({ mode: 'voice', reason: '想你' });
        const r = extractCharCall('a[[ACTION:CALL|voice|一]]b[[ACTION:CALL|video|二]]');
        expect(r.cleanedText).toBe('ab');
        expect(r.call).toEqual({ mode: 'voice', reason: '一' });
    });

    it('不認歷史記錄；沒有標籤原樣返回', () => {
        expect(extractCharCall('[[記錄:CALL|from=char|mode=語音|status=對方拒接]]').call).toBeNull();
        expect(extractCharCall('普通訊息')).toEqual({ cleanedText: '普通訊息', call: null });
    });
});

describe('狀態與響不響', () => {
    it('響鈴狀態過了時限就是未接', () => {
        expect(effectiveCallStatus({ status: 'ringing', at: 0 }, CHAR_CALL_RING_MS)).toBe('ringing');
        expect(effectiveCallStatus({ status: 'ringing', at: 0 }, CHAR_CALL_RING_MS + 60_000)).toBe('missed');
        expect(effectiveCallStatus({ status: 'declined', at: 0 }, 10 ** 9)).toBe('declined');
    });

    it('頁面看得見、不在忙、回覆是剛生成的才響', () => {
        expect(shouldRingNow({ now: 1000, visible: true, busy: false })).toBe(true);
        expect(shouldRingNow({ now: 1000, visible: false, busy: false })).toBe(false);
        expect(shouldRingNow({ now: 1000, visible: true, busy: true })).toBe(false);
        expect(shouldRingNow({ spokenAt: 0, now: 10 * 60_000, visible: true, busy: false })).toBe(false);
    });
});

describe('冷卻', () => {
    beforeEach(() => localStorage.clear());

    it('打過一次一小時內不再打', () => {
        expect(canCharCallNow('a', 0)).toBe(true);
        markCharCallAttempt('a', 1000);
        expect(canCharCallNow('a', 1000 + CHAR_CALL_COOLDOWN_MS - 1)).toBe(false);
        expect(canCharCallNow('a', 1000 + CHAR_CALL_COOLDOWN_MS)).toBe(true);
        expect(canCharCallNow('b', 2000)).toBe(true);
    });
});

describe('文字', () => {
    it('記錄與摘要', () => {
        expect(formatCharCallRecord({ mode: 'video', reason: '想看看你', status: 'missed', at: 0 }, 0))
            .toBe('[[記錄:CALL|from=char|mode=視訊|reason=想看看你|status=對方沒接到]]');
        expect(describeCharCall({ mode: 'voice', reason: '' })).toBe('[語音來電]');
    });
});
