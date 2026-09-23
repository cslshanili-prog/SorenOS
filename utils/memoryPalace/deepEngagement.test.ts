import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import { injectMemoryPalace } from './pipeline';
import { analyzeDeepEngagement, renderDeepEngagementGuidance } from './deepEngagement';

let nextId = 1;
const message = (role: Message['role'], content: string): Message => ({
    id: nextId++,
    charId: 'char-depth',
    role,
    type: 'text',
    content,
    timestamp: nextId * 1000,
});

describe('M3 Deep Engagement', () => {
    beforeEach(() => {
        nextId = 1;
        localStorage.clear();
    });

    it('recognizes an explicit invitation to examine a fictional contradiction', () => {
        const source = '我想認真分析一下：虛構小鎮把廣場全部改成預約制，明明說是提高效率，為什麼居民反而更少交流？你怎麼看？';
        const analysis = analyzeDeepEngagement([message('user', source)]);

        expect(['exploratory', 'analytical']).toContain(analysis.mode);
        expect(analysis.shouldGuide).toBe(true);
        expect(analysis.state.analyticalDepth).toBeGreaterThan(0.5);
        expect(analysis.state.perspectiveBreadth).toBeGreaterThan(0.45);

        const guidance = renderDeepEngagementGuidance(analysis);
        expect(guidance).toContain('### 此刻的交流深度');
        expect(guidance).toContain('不只是複述或站隊');
        expect(guidance).toContain('不是在提交分析報告');
        expect(guidance).not.toContain(source);
        expect(guidance).not.toContain('虛構小鎮');
    });

    it('does not confuse a long emotional message with an invitation to analyze', () => {
        const analysis = analyzeDeepEngagement([
            message('user', '我現在真的很難受，腦子也很亂，先別分析這些事情了，陪陪我，讓我慢慢緩過來。'),
        ]);

        expect(analysis.mode).toBe('supportive');
        expect(analysis.state.analyticalDepth).toBeLessThan(0.25);
        expect(analysis.state.emotionalHolding).toBeGreaterThan(0.7);
        expect(analysis.state.challengeTolerance).toBeLessThan(0.2);
        expect(renderDeepEngagementGuidance(analysis)).toContain('先被聽見和接住');
    });

    it('does not turn length alone into deep talk', () => {
        const analysis = analyzeDeepEngagement([
            message('user', '今天早上先整理了書架，下午又去買了日用品，回來以後做飯、洗衣服、收拾桌面，然後看了一會兒窗外，最後準備早點休息。'),
        ]);

        expect(analysis.mode).toBe('reactive');
        expect(analysis.shouldGuide).toBe(false);
        expect(renderDeepEngagementGuidance(analysis)).toBe('');
    });

    it('keeps a multi-turn deep discussion alive through a short continuation', () => {
        const messages: Message[] = [];
        for (let turn = 0; turn < 5; turn += 1) {
            messages.push(message('user', `我想繼續分析虛構社區的規則：一方面強調開放，另一方面又不斷增加限制，這種矛盾背後的邏輯是什麼？`));
            messages.push(message('assistant', '我也在想。'));
        }
        messages.push(message('user', '對，這裡的邏輯我還沒想明白。'));

        const analysis = analyzeDeepEngagement(messages);

        expect(analysis.trendDepth).toBeGreaterThan(0.5);
        expect(['exploratory', 'analytical']).toContain(analysis.mode);
        expect(analysis.state.exploratoryDrive).toBeGreaterThan(0.4);
    });

    it('allows challenge only when analysis is invited and emotional room remains', () => {
        const openDebate = analyzeDeepEngagement([
            message('user', '我有一個判斷但不確定，你可以反駁我：虛構協會一邊要求統一，一邊鼓勵創新，這套邏輯是不是矛盾？'),
        ]);
        const overwhelmed = analyzeDeepEngagement([
            message('user', '我真的撐不住了！！！先別分析，也不要反駁我，現在只想有人陪著。'),
        ]);

        expect(openDebate.state.challengeTolerance).toBeGreaterThan(0.35);
        expect(overwhelmed.state.challengeTolerance).toBeLessThan(0.1);
    });

    it('stores only numeric evidence and never copies the source sentence into Trace', async () => {
        const privateSource = '這是僅用於測試隱私邊界的虛構密語，不得進入追蹤記錄；請和我一起分析它的邏輯。';
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));

        const trace = await injectMemoryPalace(
            { id: 'char-depth', name: '測試角色', memoryPalaceEnabled: false },
            [message('user', privateSource)],
            undefined,
            '測試用戶',
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.status).toBe('observed');
        expect(trace.deepEngagement?.engine).toBe('conversation_v2');
        expect(trace.stages.some(stage => stage.name === 'deep_engagement')).toBe(true);
        expect(JSON.stringify(trace)).not.toContain(privateSource);
        expect(JSON.stringify(trace)).not.toContain('虛構密語');
    });

    it('keeps M3 out of non-ChatApp entry points', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-depth', memoryPalaceEnabled: false },
            [message('user', '請認真分析這個虛構問題背後的邏輯。')],
            undefined,
            undefined,
            { entryPoint: 'world_home' },
        );

        expect(trace.deepEngagement?.status).toBe('out_of_scope');
        expect(trace.stages.some(stage => stage.name === 'deep_engagement')).toBe(false);
    });
});
