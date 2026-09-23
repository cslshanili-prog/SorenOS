import { describe, it, expect } from 'vitest';
import { interactionGapNote, tzAwarenessNote, resolveCharTimeZone, tzShortLabel } from './timezone';
import type { CharacterProfile } from '../types';

const NOW = 1_700_000_000_000; // 固定 now，避免依賴系統時鐘
const min = (n: number) => NOW - n * 60_000;
const hr = (n: number) => NOW - n * 3_600_000;
const day = (n: number) => NOW - n * 86_400_000;

describe('interactionGapNote', () => {
    it('lastTs 為空 → 空串（不注入）', () => {
        expect(interactionGapNote(undefined, NOW)).toBe('');
    });

    it('5 分鐘內 → 「剛剛還在聯繫」', () => {
        expect(interactionGapNote(min(2), NOW)).toContain('剛剛還在聯繫');
    });

    it('分鐘級 → X 分鐘', () => {
        expect(interactionGapNote(min(30), NOW)).toContain('30 分鐘');
    });

    it('小時級 → X 小時', () => {
        expect(interactionGapNote(hr(5), NOW)).toContain('5 小時');
    });

    it('天級 → X 天 + 久未聯繫體感', () => {
        const note = interactionGapNote(day(3), NOW);
        expect(note).toContain('3 天');
        expect(note).toContain('已經有一陣子沒聯繫了');
    });

    it('未來時間戳（時鐘漂移）→ 空串，不產生負數', () => {
        expect(interactionGapNote(NOW + 60_000, NOW)).toBe('');
    });
});

describe('tzAwarenessNote', () => {
    it('無時區 → 空串', () => {
        expect(tzAwarenessNote(undefined)).toBe('');
    });
    it('有時區 → 含時差提示與時區標籤', () => {
        const note = tzAwarenessNote('America/New_York');
        expect(note).toContain('時區');
        expect(note).toContain('紐約');
    });
});

describe('resolveCharTimeZone', () => {
    const base = { customTimezone: 'Asia/Tokyo' } as Partial<CharacterProfile>;
    it('未開啟 → undefined（跟隨本機）', () => {
        expect(resolveCharTimeZone({ ...base, customTimezoneEnabled: false } as CharacterProfile)).toBeUndefined();
    });
    it('開啟且有值 → 返回時區 id', () => {
        expect(resolveCharTimeZone({ ...base, customTimezoneEnabled: true } as CharacterProfile)).toBe('Asia/Tokyo');
    });
    it('開啟但無值 → undefined', () => {
        expect(resolveCharTimeZone({ customTimezoneEnabled: true } as CharacterProfile)).toBeUndefined();
    });
});

describe('tzShortLabel', () => {
    it('取清單標籤裡的第一個地名，去掉並列項和 UTC 偏移', () => {
        expect(tzShortLabel('America/New_York')).toBe('紐約');
        expect(tzShortLabel('Asia/Shanghai')).toBe('北京');
        expect(tzShortLabel('Asia/Tokyo')).toBe('東京');
    });
    it('單地名的條目原樣取到', () => {
        expect(tzShortLabel('Europe/London')).toBe('倫敦');
        expect(tzShortLabel('Australia/Sydney')).toBe('悉尼');
    });
    it('不在清單裡的時區退回 IANA id 末段', () => {
        expect(tzShortLabel('America/Argentina/Ushuaia')).toBe('Ushuaia');
        expect(tzShortLabel('Africa/Porto-Novo')).toBe('Porto-Novo');
    });
    it('結果夠短，放得進卡片角標', () => {
        for (const id of ['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/Paris']) {
            expect(tzShortLabel(id).length).toBeLessThanOrEqual(6);
        }
    });
});
