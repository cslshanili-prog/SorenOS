import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resolveCharacterMeterApi } from './characterApi';

const global = { baseUrl: 'https://main', apiKey: 'k', model: 'main-model' };

describe('當日日程用「日程/情緒」面板的 API', () => {
    it('情緒/意識流 API 填了就用它，沒填落回全域主 API', () => {
        const emotionApi = { baseUrl: 'https://cheap', apiKey: 'k2', model: 'cheap-model' };
        expect(resolveCharacterMeterApi({ emotionConfig: { api: emotionApi } } as any, global)).toBe(emotionApi);
        expect(resolveCharacterMeterApi({ emotionConfig: { api: { baseUrl: '' } } } as any, global)).toBe(global);
        expect(resolveCharacterMeterApi({} as any, global)).toBe(global);
    });

    it('Chat 呼叫 generateDailyScheduleForChar 的每一處都先過 resolveCharacterMeterApi', () => {
        const src = readFileSync(resolve(__dirname, '../apps/Chat.tsx'), 'utf8');
        const calls = src.match(/generateDailyScheduleForChar\([^\n]*\)/g) || [];
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call).toContain('resolveCharacterMeterApi(');
    });
});
