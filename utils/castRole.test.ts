import { describe, expect, it } from 'vitest';
import { castOrder, isBenched, isLead, isOnStage, isSupporting, sortByCast } from './castRole';
import { isScheduleFeatureOn } from './scheduleFeature';
import { isOnlinePaused } from './dateOffline';
import { filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import type { CharacterProfile } from '../types';

const c = (id: string, extra: Partial<CharacterProfile> = {}) => ({ id, name: id, ...extra } as CharacterProfile);

describe('主角／配角與下戲', () => {
    it('沒標就是主角', () => {
        expect(isLead(c('a'))).toBe(true);
        expect(isSupporting(c('a'))).toBe(false);
        expect(isSupporting(c('b', { castRole: 'supporting' }))).toBe(true);
    });
    it('下戲中不在戲裡', () => {
        expect(isOnStage(c('a'))).toBe(true);
        expect(isBenched(c('a', { benchedAt: 1 }))).toBe(true);
        expect(isOnStage(c('a', { benchedAt: 1 }))).toBe(false);
    });
    it('排序：主角、配角、下戲的；同層照原順序', () => {
        const list = [c('s1', { castRole: 'supporting' }), c('b1', { benchedAt: 1 }), c('l1'), c('s2', { castRole: 'supporting' }), c('l2')];
        expect(sortByCast(list).map(x => x.id)).toEqual(['l1', 'l2', 's1', 's2', 'b1']);
        expect(castOrder(c('x', { castRole: 'supporting', benchedAt: 1 }))).toBe(2);
    });
    it('選角列表照戲份排', () => {
        const list = [c('s1', { castRole: 'supporting' }), c('l1')];
        expect(filterCharactersByGroup(list, [], GROUP_FILTER_ALL).map(x => x.id)).toEqual(['l1', 's1']);
    });
});

describe('下戲停掉自己跑的東西', () => {
    it('日程與情緒關掉', () => {
        expect(isScheduleFeatureOn(c('a', { scheduleFeatureEnabled: true }))).toBe(true);
        expect(isScheduleFeatureOn(c('a', { scheduleFeatureEnabled: true, benchedAt: 1 }))).toBe(false);
    });
    it('線上功能停著（跟線下故事共用同一套）', () => {
        expect(isOnlinePaused(c('a'))).toBe(false);
        expect(isOnlinePaused(c('a', { benchedAt: 1 }))).toBe(true);
        expect(isOnlinePaused(c('a', { dateOfflineMode: true, activeDateStoryId: 's' }))).toBe(true);
    });
});
