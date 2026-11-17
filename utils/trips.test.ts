import { afterEach, describe, expect, it } from 'vitest';
import type { CharacterProfile, Trip, UserProfile } from '../types';
import { getActiveTrip, setTripRegistry, setWorldRegistry } from './charNameRegistry';
import { newTrip, tripDayNo, tripLabel, tripOn, tripsOf, tripsOnDay } from './trips';
import { resolveCharTimeZone } from './timezone';
import { profileForPersonaKey, resolveUserProfileForChar, REAL_IDENTITY_PERSONA_ID } from './userPersona';
import { buildTripBlock } from './scheduleGenParts';

// 旅行（plans/calendar.md 第 4 批）：時區多一層（旅行 > 世界 > 角色）、身份卡所在地同理、生成帶出行

const me = { kind: 'persona' as const, id: REAL_IDENTITY_PERSONA_ID };
const him = { kind: 'char' as const, id: 'c1' };
const trip = (f: Partial<Trip> & Pick<Trip, 'from' | 'to'>): Trip => newTrip({ owner: him, destination: '杭州', kind: 'travel', ...f });

afterEach(() => { setTripRegistry([]); setWorldRegistry([]); });

describe('純邏輯', () => {
    it('tripOn 含頭尾、重疊取最晚建的；tripsOf 照出發日排；第幾天／共幾天', () => {
        const a = trip({ from: '2026-11-20', to: '2026-11-22', createdAt: 1 } as any);
        const b = trip({ from: '2026-11-10', to: '2026-11-12' });
        const c = trip({ from: '2026-11-21', to: '2026-11-25', destination: '東京', createdAt: 2 } as any);
        expect(tripsOf([a, b, c], him).map(t => t.from)).toEqual(['2026-11-10', '2026-11-20', '2026-11-21']);
        expect(tripOn([a, b, c], him, '2026-11-20')?.destination).toBe('杭州');
        expect(tripOn([a, b, c], him, '2026-11-22')?.destination).toBe('東京');
        expect(tripOn([a, b, c], him, '2026-11-23')?.destination).toBe('東京');
        expect(tripOn([a, b, c], him, '2026-11-13')).toBeUndefined();
        expect(tripOn([a, b, c], me, '2026-11-20')).toBeUndefined();
        expect(tripDayNo(a, '2026-11-21')).toEqual({ day: 2, total: 3 });
        expect(tripLabel(a, '2026-11-21')).toBe('✈️ 旅行 · 杭州 · 第 2／3 天');
        expect(tripsOnDay([a, b, c], '2026-11-11').map(t => t.id)).toEqual([b.id]);
    });

    it('buildTripBlock：第一天、中間、最後一天的措辭；出差與旅行不同；沒旅行回空', () => {
        const t = trip({ from: '2026-11-20', to: '2026-11-22', timezone: 'Asia/Tokyo', note: '住新宿' });
        expect(buildTripBlock(undefined, '2026-11-20')).toBe('');
        expect(buildTripBlock(t, '2026-11-20')).toContain('第一天（剛到或在路上）');
        expect(buildTripBlock(t, '2026-11-21')).toContain('第 2 天');
        expect(buildTripBlock(t, '2026-11-22')).toContain('最後一天（要回去了）');
        expect(buildTripBlock(t, '2026-11-21')).toContain('Asia/Tokyo');
        expect(buildTripBlock(t, '2026-11-21')).toContain('住新宿');
        expect(buildTripBlock({ ...t, kind: 'business' }, '2026-11-21')).toContain('工作為主');
    });
});

describe('時區多一層', () => {
    const char = { id: 'c1', name: 'A', customTimezoneEnabled: true, customTimezone: 'America/New_York', groupId: 'w1' } as CharacterProfile;
    const todayKey = new Date().toISOString().slice(0, 10);
    const wide = { from: '2000-01-01', to: '2099-12-31' };

    it('角色：旅行 > 世界 > 角色；旅行沒選時區就不換', () => {
        expect(resolveCharTimeZone(char)).toBe('America/New_York');
        setWorldRegistry([{ id: 'w1', timezone: 'Europe/London' }]);
        expect(resolveCharTimeZone(char)).toBe('Europe/London');
        setTripRegistry([trip({ ...wide, timezone: 'Asia/Tokyo' })]);
        expect(resolveCharTimeZone(char)).toBe('Asia/Tokyo');
        setTripRegistry([trip({ ...wide })]);
        expect(resolveCharTimeZone(char)).toBe('Europe/London');
        setTripRegistry([trip({ from: '2000-01-01', to: '2000-01-02', timezone: 'Asia/Tokyo' })]);
        expect(resolveCharTimeZone(char)).toBe('Europe/London');
        expect(getActiveTrip(him, todayKey)).toBeUndefined();
    });

    it('身份卡：真實身份和卡都看旅行；沒旅行回同一個物件', () => {
        const base = { name: '我', avatar: '', bio: '', timezone: 'Asia/Taipei', personas: [{ id: 'p1', name: '卡', avatar: '', bio: '', timezone: 'Asia/Shanghai', createdAt: 0, updatedAt: 0 }] } as unknown as UserProfile;
        expect(profileForPersonaKey(base, REAL_IDENTITY_PERSONA_ID)).toBe(base);
        expect(profileForPersonaKey(base, 'p1').timezone).toBe('Asia/Shanghai');
        setTripRegistry([newTrip({ owner: me, destination: '東京', kind: 'travel', timezone: 'Asia/Tokyo', ...wide }), newTrip({ owner: { kind: 'persona', id: 'p1' }, destination: '倫敦', kind: 'business', timezone: 'Europe/London', ...wide })]);
        expect(profileForPersonaKey(base, REAL_IDENTITY_PERSONA_ID).timezone).toBe('Asia/Tokyo');
        expect(profileForPersonaKey(base, 'p1').timezone).toBe('Europe/London');
        expect(resolveUserProfileForChar(base, { id: 'c9' } as CharacterProfile).timezone).toBe('Asia/Tokyo');
    });
});
