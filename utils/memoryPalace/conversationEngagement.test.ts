import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import {
    advanceConversationEngagement,
    analyzeConversationEngagement,
    clearConversationEngagementState,
    CONVERSATION_ENGAGEMENT_ENGINE_KEY,
    CONVERSATION_ENGAGEMENT_STORAGE_PREFIX,
    loadConversationEngagementState,
    renderConversationEngagementGuidance,
} from './conversationEngagement';
import { injectMemoryPalace } from './pipeline';

let nextId = 1;
const history: Message[] = [];
const push = (role: Message['role'], content: string): Message => {
    const item: Message = {
        id: nextId++,
        charId: 'char-engagement',
        role,
        type: 'text',
        content,
        timestamp: nextId * 1000,
    };
    history.push(item);
    return item;
};

describe('M3 v2 Conversation Engagement', () => {
    beforeEach(() => {
        nextId = 1;
        history.length = 0;
        localStorage.clear();
    });

    it('treats an understated personal load as an unfinished disclosure, not a closed comfort request', () => {
        push('user', '我很累，事情很多。');
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('open_disclosure');
        expect(result.analysis.engagementState).toBe('opening');
        expect(result.analysis.interactionMode).toBe('supportive');
        expect(result.analysis.responsePlan).toMatchObject({
            primary: 'acknowledge',
            secondary: 'invite',
        });
        expect(result.analysis.subject.active).toBe(true);
        expect(result.analysis.reasons).toContain('personal_load');

        const guidance = renderConversationEngagementGuidance(result.analysis);
        expect(guidance).toContain('### 談話參與原則');
        expect(guidance).toContain('對方出現負面情緒，不代表當前談話的目標是消除這種情緒');
        expect(guidance).toContain('情緒是談話的一部分，不應覆蓋談話本身');
        expect(guidance).toContain('不要根據關鍵詞、記憶或既有印象補全事件並提前站隊');
        expect(guidance).not.toContain('User');
        expect(guidance).toContain('先聽見，再瞭解，再形成看法');
        expect(guidance).toContain('### 當前談話參與策略');
        expect(guidance).toContain('持續關注對方正在經歷什麼');
        expect(guidance).toContain('不要用“別想了”“回來就好”“一切都會過去”');
        expect(guidance).toContain('不必固定變成“發生什麼了”“然後呢”');
        expect(guidance).toContain('你不只需要留意');
        expect(guidance).not.toContain('角色');
        expect(guidance).not.toContain('我很累');
    });

    it.each([
        '桌面上的三個窗口還都停在那裡。',
        '這陣子像一直在逆著風走。',
        '剛才那段到現在還懸在半空。',
    ])('opens a meaningful unclosed statement without requiring topic keywords: %s', (content) => {
        push('user', content);
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('open_disclosure');
        expect(result.analysis.engagementState).toBe('opening');
        expect(result.analysis.interactionMode).toBe('exploratory');
        expect(result.analysis.reasons).toContain('open_ended_statement');
        expect(result.analysis.responsePlan).toMatchObject({
            primary: 'acknowledge',
            secondary: 'invite',
        });
        expect(renderConversationEngagementGuidance(result.analysis)).toContain('事情本身發生了什麼');
    });

    it.each([
        '幫我把下面這段內容翻譯成英文。',
        '這個函數返回什麼？',
        '下午好呀。',
    ])('does not turn a direct request, question, or greeting into a disclosure: %s', (content) => {
        push('user', content);
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.engagementState).toBe('idle');
        expect(result.analysis.shouldGuide).toBe(false);
        expect(result.analysis.stance.confidence).toBe(0);
    });

    it('distinguishes a tired status update with an explicit closure from an opening', () => {
        push('user', '今天上班好累，準備睡覺啦。');
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('close');
        expect(result.analysis.engagementState).toBe('idle');
        expect(result.analysis.shouldGuide).toBe(false);
        expect(result.state.activeSubject).toBeUndefined();
        const guidance = renderConversationEngagementGuidance(result.analysis);
        expect(guidance).toContain('### 談話參與原則');
        expect(guidance).not.toContain('### 當前談話參與策略');
    });

    it('keeps the same subject through elaboration and a low-information continuation', () => {
        push('user', '我很累，事情很多。');
        const opened = advanceConversationEngagement('char-engagement', history);
        const subjectId = opened.state.activeSubject?.id;

        push('assistant', '我在聽。');
        push('user', '主要是今天單位那個事情。');
        const engaged = advanceConversationEngagement('char-engagement', history, opened.state);
        expect(engaged.analysis.engagementState).toBe('engaged');
        expect(engaged.state.activeSubject?.id).toBe(subjectId);
        expect(engaged.analysis.responsePlan.primary).toBe('follow');

        push('assistant', '嗯。');
        push('user', '就是……');
        const continued = advanceConversationEngagement('char-engagement', history, engaged.state);
        expect(continued.analysis.engagementState).toBe('engaged');
        expect(continued.state.activeSubject?.id).toBe(subjectId);
        expect(continued.analysis.responsePlan.explicitQuestionBudget).toBe(0);
        expect(continued.analysis.reasons).toContain('repeated_low_information_turn');
    });

    it('reflects a new development against the active subject instead of restarting the conversation', () => {
        push('user', '之前那些事又有後續了。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '繼續。');
        push('user', '今天主任突然又叫了另一個人過去，明明之前說讓我負責。');
        const updated = advanceConversationEngagement('char-engagement', history, opened.state);

        expect(updated.analysis.conversationAct).toBe('update');
        expect(updated.analysis.engagementState).toBe('engaged');
        expect(updated.analysis.responsePlan).toMatchObject({ primary: 'reflect', secondary: 'follow' });
        expect(updated.analysis.subject.unresolvedHookKinds).toContain('changed_arrangement');
        expect(updated.analysis.stance.confidence).toBeGreaterThan(opened.analysis.stance.confidence);
    });

    it('moves into resolving and forms only a progressive stance when the user asks for a view', () => {
        push('user', '之前主任說這件事讓我負責，今天卻突然換了另一個人。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '這裡確實出現了變化。');
        push('user', '所以你覺得他是不是根本沒打算讓我負責？');
        const resolving = advanceConversationEngagement('char-engagement', history, opened.state);

        expect(resolving.analysis.conversationAct).toBe('ask_stance');
        expect(resolving.analysis.engagementState).toBe('resolving');
        expect(['reflect', 'evaluate']).toContain(resolving.analysis.responsePlan.primary);
        expect(resolving.analysis.responsePlan.explicitQuestionBudget).toBe(0);
        expect(renderConversationEngagementGuidance(resolving.analysis)).toContain('先保留你正在形成的印象');
    });

    it('closes the old subject and opens a new one when the user shifts topics', () => {
        push('user', '單位那件事還有後續。');
        const work = advanceConversationEngagement('char-engagement', history);
        const workId = work.state.activeSubject?.id;
        push('assistant', '你說。');
        push('user', '算了不想這個了，給你看我剛畫的東西！');
        const shifted = advanceConversationEngagement('char-engagement', history, work.state);

        expect(shifted.analysis.conversationAct).toBe('shift');
        expect(shifted.analysis.engagementState).toBe('opening');
        expect(shifted.analysis.responsePlan).toMatchObject({ primary: 'close', secondary: 'shift' });
        expect(shifted.state.activeSubject?.id).not.toBe(workId);
        expect(shifted.analysis.subject.changed).toBe(true);
    });

    it('enters a new topic directly when there is no old subject to close', () => {
        push('user', '給你看我剛畫的東西！');
        const shifted = advanceConversationEngagement('char-engagement', history);

        expect(shifted.analysis.conversationAct).toBe('shift');
        expect(shifted.analysis.responsePlan).toMatchObject({ primary: 'shift' });
        expect(shifted.analysis.responsePlan.secondary).toBeUndefined();
    });

    it('does not revive a closed subject on the next ordinary greeting', () => {
        push('user', '單位那件事還有後續。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '我聽著。');
        push('user', '算了，先不說了。');
        const closed = advanceConversationEngagement('char-engagement', history, opened.state);
        expect(closed.analysis.engagementState).toBe('closing');

        push('assistant', '好。');
        push('user', '早上好。');
        const greeting = advanceConversationEngagement('char-engagement', history, closed.state);
        expect(greeting.analysis.engagementState).toBe('idle');
        expect(greeting.state.activeSubject).toBeUndefined();
        expect(greeting.analysis.shouldGuide).toBe(false);
    });

    it('persists per-character state locally and makes duplicate payload builds idempotent', () => {
        push('user', '今天公司來了個特別奇怪的人。');
        const first = analyzeConversationEngagement('char-engagement', history);
        const stored = loadConversationEngagementState('char-engagement');
        const duplicate = analyzeConversationEngagement('char-engagement', history);

        expect(first.engagementState).toBe('opening');
        expect(stored?.activeSubject).toBeDefined();
        expect(duplicate).toEqual(first);
        expect(loadConversationEngagementState('char-engagement')?.activeSubject?.knownFacts).toHaveLength(1);

        clearConversationEngagementState('char-engagement');
        expect(loadConversationEngagementState('char-engagement')).toBeUndefined();
    });

    it('does not carry a subject into a replaced chat history for the same character', () => {
        push('user', '之前那些事又有後續了。');
        const opened = advanceConversationEngagement('char-engagement', history);
        const replacementHistory: Message[] = [{
            id: 999,
            charId: 'char-engagement',
            role: 'user',
            type: 'text',
            content: '早上好。',
            timestamp: Date.now(),
        }];
        const replacement = advanceConversationEngagement(
            'char-engagement',
            replacementHistory,
            opened.state,
        );

        expect(replacement.analysis.engagementState).toBe('idle');
        expect(replacement.state.activeSubject).toBeUndefined();
        expect(replacement.analysis.shouldGuide).toBe(false);
    });

    it('keeps the legacy depth engine available as a runtime fallback', async () => {
        localStorage.setItem(CONVERSATION_ENGAGEMENT_ENGINE_KEY, 'legacy');
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-engagement', memoryPalaceEnabled: false },
            [push('user', '請認真分析這個規則背後的邏輯。')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.engine).toBe('legacy_depth');
        expect(trace.deepEngagement?.status).toBe('observed');
    });

    it('clears corrupt v2 state after a one-turn automatic legacy fallback', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        localStorage.setItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}char-engagement`, JSON.stringify({
            version: 2,
            charId: 'char-engagement',
            engagementState: 'engaged',
            interactionMode: 'exploratory',
            activeSubject: { id: 'broken' },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-engagement', memoryPalaceEnabled: false },
            [push('user', '然後呢。')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.engine).toBe('legacy_depth');
        expect(localStorage.getItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}char-engagement`)).toBeNull();
    });
});
