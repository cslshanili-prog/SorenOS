/**
 * 旅行（plans/calendar.md 第 4 批）：角色和身份卡都能排，期間時區換成目的地（旅行 > 世界 > 角色；
 * 身份卡是旅行 > 卡上的所在地）、生成那幾天的日程帶「出行中」、天氣跟目的地。
 * 登記表在 utils/charNameRegistry.ts（零依賴，時區解析查它）；這裡是純邏輯＋讀寫。
 */

import type { Participant, Trip } from '../types';
import { DB } from './db';
import { setTripRegistry } from './charNameRegistry';

const same = (a: Participant, b: Participant) => a.kind === b.kind && a.id === b.id;

export const TRIP_KINDS: Array<{ id: Trip['kind']; label: string; emoji: string }> = [
    { id: 'travel', label: '旅行', emoji: '✈️' },
    { id: 'business', label: '出差', emoji: '💼' },
    { id: 'other', label: '其他', emoji: '🧳' },
];
export const tripKindLabel = (kind: Trip['kind']): string => TRIP_KINDS.find(k => k.id === kind)?.label || '出行';
export const tripEmoji = (kind: Trip['kind']): string => TRIP_KINDS.find(k => k.id === kind)?.emoji || '🧳';

export const makeTripId = (): string => `trip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const newTrip = (fields: Omit<Trip, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Trip, 'id'>>): Trip => {
    const now = Date.now();
    return { ...fields, id: fields.id || makeTripId(), createdAt: now, updatedAt: now };
};

/** 這天在這趟裡嗎（含頭尾） */
export const tripOnDay = (t: Trip, dayKey: string): boolean => t.from <= dayKey && dayKey <= t.to;

/** 這個人名下的旅行，照出發日排 */
export const tripsOf = (trips: Trip[], who: Participant): Trip[] => trips.filter(t => same(t.owner, who)).sort((a, b) => a.from.localeCompare(b.from));

/** 這個人這天的旅行（重疊取最晚建的） */
export const tripOn = (trips: Trip[], who: Participant, dayKey: string): Trip | undefined =>
    tripsOf(trips, who).filter(t => tripOnDay(t, dayKey)).sort((a, b) => a.createdAt - b.createdAt).pop();

const dayNumber = (key: string): number => {
    const [y, m, d] = key.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};
/** 第幾天／共幾天（從 1 起） */
export const tripDayNo = (t: Trip, dayKey: string): { day: number; total: number } => ({ day: dayNumber(dayKey) - dayNumber(t.from) + 1, total: dayNumber(t.to) - dayNumber(t.from) + 1 });

/** 給介面和提示詞的一句：「✈️ 旅行 · 杭州 · 第 2／5 天」 */
export const tripLabel = (t: Trip, dayKey: string): string => {
    const { day, total } = tripDayNo(t, dayKey);
    return `${tripEmoji(t.kind)} ${tripKindLabel(t.kind)} · ${t.destination} · 第 ${day}／${total} 天`;
};

/** 月格子打點用：這天有誰在旅行 */
export const tripsOnDay = (trips: Trip[], dayKey: string): Trip[] => trips.filter(t => tripOnDay(t, dayKey));

/** 讀全部並更新登記表（行事曆開頁、存改刪之後都叫） */
export const refreshTripRegistry = async (): Promise<Trip[]> => {
    const trips = await DB.getAllTrips().catch(() => [] as Trip[]);
    setTripRegistry(trips);
    return trips;
};
