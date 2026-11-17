import { afterEach, describe, expect, it } from 'vitest';
import {
    __resetFailoverState, apiCooldownMinutes, applyFailoverOverride, describeSwitch, identifySlot, isApiDown, isFailoverWorthy, markApiDown, nextCandidates,
    requestApiIdentity, rewriteRequestForApi, sameApi, setFailoverOverride, shouldToastSwitch, type ChainEntry,
} from './apiFailover';
import { buildCharChatCredRow, buildCharEmotionCredRow, buildCharMemoryCredRow } from './amsgLlmCredentials';

// API 備援鏈（plans/api-center-failover.md 第 2 批）

const A: ChainEntry = { presetId: 'a', name: '甲家', baseUrl: 'https://a.example/v1', apiKey: 'k-a', model: 'm-a' };
const B: ChainEntry = { presetId: 'b', name: '乙家', baseUrl: 'https://b.example/v1/', apiKey: 'k-b', model: 'm-b' };
const C: ChainEntry = { presetId: 'c', name: '丙家', baseUrl: 'https://c.example/v1', apiKey: 'k-c', model: 'm-c' };
const MAIN = { baseUrl: 'https://main.example/v1', apiKey: 'k-main', model: 'm-main' };

afterEach(() => __resetFailoverState());

describe('什麼算掛', () => {
    it('網路錯、408、429、5xx 換；4xx 其他（含 401／403）不換', () => {
        expect(isFailoverWorthy(undefined, true)).toBe(true);
        expect(isFailoverWorthy(408)).toBe(true);
        expect(isFailoverWorthy(429)).toBe(true);
        expect(isFailoverWorthy(502)).toBe(true);
        expect(isFailoverWorthy(401)).toBe(false);
        expect(isFailoverWorthy(403)).toBe(false);
        expect(isFailoverWorthy(400)).toBe(false);
        expect(isFailoverWorthy(200)).toBe(false);
        expect(isFailoverWorthy(undefined)).toBe(false);
    });
});

describe('認請求、認槽', () => {
    it('從 URL 和 Authorization 認出打給哪組；尾斜線、大小寫不計較', () => {
        expect(requestApiIdentity('https://a.example/v1/chat/completions', { Authorization: 'Bearer k-a' })).toEqual({ baseUrl: 'https://a.example/v1', apiKey: 'k-a' });
        expect(requestApiIdentity('https://a.example/v1/chat/completions?x=1', new Headers({ authorization: 'Bearer k-a' }))).toEqual({ baseUrl: 'https://a.example/v1', apiKey: 'k-a' });
        expect(requestApiIdentity('https://a.example/v1/models', {})).toBeNull();
        expect(sameApi({ baseUrl: 'https://B.example/v1/', apiKey: 'k-b' }, B)).toBe(true);
        expect(sameApi(A, B)).toBe(false);
    });
    it('主用的先認、鏈裡的也認；都對不上回 null', () => {
        const slots = { chat: MAIN, meter: A, memory: null, amsg: null };
        const chains = { chat: [B, C], meter: [C] };
        expect(identifySlot(MAIN, slots, chains)).toBe('chat');
        expect(identifySlot(A, slots, chains)).toBe('meter');
        expect(identifySlot(B, slots, chains)).toBe('chat');
        expect(identifySlot({ baseUrl: 'https://x.example/v1', apiKey: 'k' }, slots, chains)).toBeNull();
    });
});

describe('冷卻與候選', () => {
    it('掛掉的跳過、剛失敗的跳過、沒填齊的跳過；冷卻到了又回來', () => {
        markApiDown(B, 1000);
        expect(isApiDown(B, 1000 + 60_000)).toBe(true);
        expect(apiCooldownMinutes(B, 1000 + 60_000)).toBe(4);
        expect(nextCandidates([A, B, C, { ...C, presetId: 'd', name: '空', apiKey: '' }], A, 1000 + 60_000).map(e => e.presetId)).toEqual(['c']);
        expect(nextCandidates([A, B, C], A, 1000 + 6 * 60_000).map(e => e.presetId)).toEqual(['b', 'c']);
    });
    it('換家記號：冷卻期內問到同一組就給換到的那家，別組不動；同槽同天只 toast 一次', () => {
        setFailoverOverride('meter', A, B, 1000);
        expect(applyFailoverOverride('meter', A, 2000)).toEqual(B);
        expect(applyFailoverOverride('meter', C, 2000)).toEqual(C);
        expect(applyFailoverOverride('chat', A, 2000)).toEqual(A);
        expect(applyFailoverOverride('meter', A, 1000 + 6 * 60_000)).toEqual(A);
        expect(shouldToastSwitch('meter', '2026-11-18')).toBe(true);
        expect(shouldToastSwitch('meter', '2026-11-18')).toBe(false);
        expect(shouldToastSwitch('meter', '2026-11-19')).toBe(true);
    });
});

describe('改寫請求', () => {
    it('URL 前綴、Authorization、body.model 一起換；別的頭和欄位不動', () => {
        const [url, init] = rewriteRequestForApi('https://a.example/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k-a' }, body: JSON.stringify({ model: 'm-a', messages: [{ role: 'user', content: 'hi' }], stream: true }) }, A, B);
        expect(url).toBe('https://b.example/v1/chat/completions');
        expect((init.headers as Headers).get('Authorization')).toBe('Bearer k-b');
        expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
        expect(JSON.parse(init.body as string)).toEqual({ model: 'm-b', messages: [{ role: 'user', content: 'hi' }], stream: true });
        expect(describeSwitch('chat', { baseUrl: A.baseUrl, name: '甲家' }, B)).toBe('主 API：甲家 → 乙家');
    });
});

describe('雲端憑據行跟著換', () => {
    it('主 API 換過家：chat 行指到換到的那家；記憶、情緒同理', () => {
        const now = Date.now();
        setFailoverOverride('chat', MAIN, B, now);
        expect(buildCharChatCredRow({ id: 'c1' }, { enabled: true } as any, MAIN)?.value.primaryModel).toBe('m-b');
        setFailoverOverride('memory', A, C, now);
        expect(buildCharMemoryCredRow('c1', A)?.value.primaryModel).toBe('m-c');
        setFailoverOverride('meter', A, B, now);
        expect(buildCharEmotionCredRow('c1', undefined, { ...MAIN, meterApi: A })?.value.primaryModel).toBe('m-b');
        // 角色自己設的情緒 API 不是全局槽，照角色的
        expect(buildCharEmotionCredRow('c1', C, { ...MAIN, meterApi: A })?.value.primaryModel).toBe('m-c');
    });
});
