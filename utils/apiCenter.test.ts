import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import { describeMeterApiSource, globalAmsgApi, globalMeterApi, isUsableSecondaryApi } from './apiCenter';
import { resolveCharacterMeterApi } from './characterApi';
import { buildCharChatCredRow, buildCharEmotionCredRow } from './amsgLlmCredentials';

// API 中心（plans/api-center-failover.md 第 1 批）：三層回落只在一處寫

const MAIN = { baseUrl: 'https://main/v1', apiKey: 'k-main', model: 'm-main' };
const METER = { baseUrl: 'https://meter/v1', apiKey: 'k-meter', model: 'm-meter' };
const AMSG = { baseUrl: 'https://amsg/v1', apiKey: 'k-amsg', model: 'm-amsg' };
const OWN = { baseUrl: 'https://own/v1', apiKey: 'k-own', model: 'm-own' };

describe('槽的判定', () => {
    it('填齊 URL、Key、Model 才算；沒填齊當沒設', () => {
        expect(isUsableSecondaryApi(METER)).toBe(true);
        expect(isUsableSecondaryApi({ ...METER, apiKey: ' ' })).toBe(false);
        expect(isUsableSecondaryApi(undefined)).toBe(false);
        expect(globalMeterApi({ ...MAIN })).toBeNull();
        expect(globalMeterApi({ ...MAIN, meterApi: METER })).toEqual(METER);
        expect(globalAmsgApi({ ...MAIN, amsgApi: { ...AMSG, model: '' } })).toBeNull();
    });
});

describe('情緒／日程：角色自己的 > 全局槽 > 主 API', () => {
    const bare = { id: 'c1' } as CharacterProfile;
    const own = { id: 'c1', emotionConfig: { enabled: true, api: OWN } } as CharacterProfile;
    it('resolveCharacterMeterApi', () => {
        expect(resolveCharacterMeterApi(bare, MAIN)).toEqual(MAIN);
        expect(resolveCharacterMeterApi(bare, { ...MAIN, meterApi: METER })).toEqual(METER);
        expect(resolveCharacterMeterApi(own, { ...MAIN, meterApi: METER })).toEqual(OWN);
        expect(describeMeterApiSource(undefined, MAIN)).toBe('主 API');
        expect(describeMeterApiSource(undefined, { ...MAIN, meterApi: METER })).toBe('系統設置的副 API');
        expect(describeMeterApiSource(OWN, { ...MAIN, meterApi: METER })).toBe('角色自己的');
    });
    it('雲端情緒憑據行同一個口徑', () => {
        expect(buildCharEmotionCredRow('c1', undefined, { ...MAIN, meterApi: METER })?.value.primaryModel).toBe('m-meter');
        expect(buildCharEmotionCredRow('c1', OWN, { ...MAIN, meterApi: METER })?.value.primaryModel).toBe('m-own');
        expect(buildCharEmotionCredRow('c1', undefined, MAIN)?.value.primaryModel).toBe('m-main');
    });
});

describe('主動消息：角色開的單獨 API > 全局槽 > 主 API', () => {
    it('憑據行', () => {
        expect(buildCharChatCredRow({ id: 'c1' }, { enabled: true } as any, { ...MAIN, amsgApi: AMSG })?.value.primaryModel).toBe('m-amsg');
        expect(buildCharChatCredRow({ id: 'c1' }, { enabled: true, useSecondaryApi: true, secondaryApi: OWN } as any, { ...MAIN, amsgApi: AMSG })?.value.primaryModel).toBe('m-own');
        expect(buildCharChatCredRow({ id: 'c1' }, { enabled: true } as any, MAIN)?.value.primaryModel).toBe('m-main');
    });
});
