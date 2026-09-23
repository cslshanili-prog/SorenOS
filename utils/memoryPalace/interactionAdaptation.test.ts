import { beforeEach, describe, expect, it } from 'vitest';

import type { CharacterAccommodationPolicy, Message } from '../../types';
import { injectMemoryPalace } from './pipeline';
import {
    analyzeUserInteraction,
    DEFAULT_CHARACTER_ACCOMMODATION,
    INTERACTION_TREND_TURN_LIMIT,
    renderInteractionAdaptationGuidance,
    resolveAccommodationPolicy,
} from './interactionAdaptation';

let nextId = 1;
const message = (role: Message['role'], content: string, timestamp?: number): Message => ({
    id: nextId++,
    charId: 'char-interaction',
    role,
    type: 'text',
    content,
    timestamp: timestamp ?? nextId * 1000,
});

const fullPolicy: CharacterAccommodationPolicy = {
    length: 1,
    rhythm: 1,
    energy: 1,
    punctuation: 1,
    emoji: 1,
};

describe('M2 ChatApp interaction adaptation', () => {
    beforeEach(() => {
        nextId = 1;
        localStorage.clear();
    });

    it('separates a sudden current impulse from the slower user trend', () => {
        const analysis = analyzeUserInteraction([
            message('user', '我前幾輪都在比較完整地說明背景、經過和自己的判斷，希望慢慢把整件事聊清楚。'),
            message('assistant', '知道了。'),
            message('user', '這裡還有一些補充背景，我依然想把細節講完整以後再一起判斷。'),
            message('assistant', '你繼續。'),
            message('user', '啊啊啊我過啦！！！🎉🎉'),
        ], fullPolicy);

        expect(analysis.analyzable).toBe(true);
        expect(analysis.hasTrend).toBe(true);
        expect(analysis.impulse.length).toBeLessThan(analysis.trend.length);
        expect(analysis.impulse.energy).toBeGreaterThan(analysis.trend.energy);

        const guidance = renderInteractionAdaptationGuidance(analysis);
        expect(guidance).toContain('這一輪的步伐');
        expect(guidance).toContain('稍短');
        expect(guidance).toContain('更高的興致');
        expect(guidance).toContain('語言氣質');
        expect(guidance).not.toContain('啊啊啊我過啦');
    });

    it('learns the trend only from user messages, never from character replies', () => {
        const calmReplies = analyzeUserInteraction([
            message('user', '前面我說得比較完整，也沒有很著急。'),
            message('assistant', '嗯。'),
            message('user', '現在繼續說一下'),
        ], fullPolicy);
        const loudReplies = analyzeUserInteraction([
            message('user', '前面我說得比較完整，也沒有很著急。'),
            message('assistant', '啊啊啊！！！🎉🎉🎉'),
            message('user', '現在繼續說一下'),
        ], fullPolicy);

        expect(loudReplies.trend).toEqual(calmReplies.trend);
        expect(loudReplies.target).toEqual(calmReplies.target);
    });

    it('treats many consecutive bubbles as one turn instead of letting them erase the slow trend', () => {
        const messages: Message[] = [];
        for (let turn = 0; turn < 12; turn += 1) {
            messages.push(message(
                'user',
                `這是第${turn + 1}輪比較完整的說明，我會把背景、過程、自己的感受和判斷都慢慢講清楚。`,
            ));
            messages.push(message('assistant', '我在聽。'));
        }
        // 同一輪連發很多短氣泡；它應當只佔一個趨勢樣本。
        for (let bubble = 0; bubble < 10; bubble += 1) {
            messages.push(message('user', `補充${bubble + 1}`));
        }
        messages.push(message('assistant', '知道了。'));
        messages.push(message('user', '繼續'));

        const analysis = analyzeUserInteraction(messages, fullPolicy);

        expect(INTERACTION_TREND_TURN_LIMIT).toBe(20);
        expect(analysis.hasTrend).toBe(true);
        expect(analysis.trend.length).toBeGreaterThan(0.3);
    });

    it('honors a character policy that disables every adaptation dimension', () => {
        const analysis = analyzeUserInteraction([
            message('user', '之前我一直在很平靜地慢慢講這件事。'),
            message('assistant', '嗯。'),
            message('user', '啊啊啊成啦！！！🎉'),
        ], { length: 0, rhythm: 0, energy: 0, punctuation: 0, emoji: 0 });

        expect(Object.values(analysis.shifts).every(value => value === 0)).toBe(true);
        expect(renderInteractionAdaptationGuidance(analysis)).toBe('');
    });

    it('uses conservative defaults and clamps invalid custom values', () => {
        expect(resolveAccommodationPolicy()).toEqual(DEFAULT_CHARACTER_ACCOMMODATION);
        expect(resolveAccommodationPolicy({ length: 2, energy: -1 })).toMatchObject({
            length: 1,
            energy: 0,
            rhythm: DEFAULT_CHARACTER_ACCOMMODATION.rhythm,
        });
    });

    it('does not mistake ordinary punctuation-free text for a strong low-energy signal', () => {
        const analysis = analyzeUserInteraction([
            message('user', '我知道了'),
        ]);

        expect(Math.abs(analysis.shifts.energy)).toBeLessThan(0.04);
        expect(renderInteractionAdaptationGuidance(analysis)).not.toContain('能量偏低');
    });

    it('records M2 for ChatApp even when memory palace recall itself is disabled', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { interactionAdaptation: true },
        }));
        const char = {
            id: 'char-interaction',
            name: '測試角色',
            memoryPalaceEnabled: false,
        };

        const trace = await injectMemoryPalace(
            char,
            [message('user', '我過啦！！！')],
            undefined,
            '測試用戶',
            { entryPoint: 'chat_app' },
        );

        expect(trace.outcome).toBe('skipped_palace_disabled');
        expect(trace.interactionAdaptation?.status).toBe('observed');
        expect(trace.stages.some(stage => stage.name === 'interaction_adaptation')).toBe(true);
    });

    it('keeps non-ChatApp entry points out of M2', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { interactionAdaptation: true },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-interaction', memoryPalaceEnabled: false },
            [message('user', '我過啦！！！')],
            undefined,
            undefined,
            { entryPoint: 'world_home' },
        );

        expect(trace.interactionAdaptation?.status).toBe('out_of_scope');
        expect(trace.stages.some(stage => stage.name === 'interaction_adaptation')).toBe(false);
    });
});
