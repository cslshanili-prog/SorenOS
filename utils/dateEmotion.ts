/**
 * 見面「線下情緒獨立」（plans/offline-date-redesign.md「情緒」）。
 *
 * 關著（預設）：見面讀私聊那份情緒（角色身上的 activeBuffs／buffInjection），見面自己不評估。
 * 開著：情緒跟著這場故事走，存在 DateStory.emotion：
 * - 故事還沒有自己那份（剛開、剛打開開關）就從私聊此刻那份接過來；見面第一則回覆評估完，就各走各的
 * - 每則見面回覆落庫後跑一次情緒評估（同一套提示詞、同一個情緒 API、同一套褪色），結果只寫進故事，
 *   不動私聊那份、不出小屋動態、不寫內心獨白緩存
 * - 見面畫面的情緒小字、面板、送出去的提示詞都讀故事那份；面板裡刪條、改總結、重置也只動故事那份
 * - 開新故事就重新從私聊接一次；關掉開關，故事那份留著不用
 */

import type { CharacterProfile, DateStory, UserProfile } from '../types';
import type { ApiMessage } from './datePrompts';
import { announceEmotionFailed, parseEmotionEvalOutput, settleEmotionEval, type EmotionState } from './emotionApply';
import { isScheduleFeatureOn } from './scheduleFeature';
import { isEmotionEvalSkipped } from './devDebug';
import { patchDateStory } from './dateStory';

export const isDateEmotionIndependent = (char: Pick<CharacterProfile, 'dateEmotionIndependent'>): boolean =>
    char.dateEmotionIndependent === true;

export const chatEmotionState = (char: Pick<CharacterProfile, 'activeBuffs' | 'buffInjection' | 'buffInjectionAt'>): EmotionState => ({
    activeBuffs: char.activeBuffs || [],
    buffInjection: char.buffInjection || '',
    buffInjectionAt: char.buffInjectionAt,
});

/** 見面這一刻用的情緒；沒開獨立（或沒有故事）回 null＝照私聊那份 */
export const dateEmotionState = (char: CharacterProfile, story: DateStory | null | undefined): EmotionState | null =>
    isDateEmotionIndependent(char) && story ? (story.emotion ?? chatEmotionState(char)) : null;

/** 角色換上見面那份情緒（送提示詞、評估、畫面都用這個） */
export const withStoryEmotion = (char: CharacterProfile, story: DateStory | null | undefined): CharacterProfile => {
    const state = dateEmotionState(char, story);
    return state ? { ...char, ...state } : char;
};

/** 見面跑不跑情緒評估：開了獨立，而且情緒系統本身開著（跟私聊同一道閘） */
export const shouldEvaluateDateEmotion = (char: CharacterProfile): boolean =>
    isDateEmotionIndependent(char) && !!char.emotionConfig?.enabled && isScheduleFeatureOn(char);

const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((part: any) => part?.type === 'text').map((part: any) => part.text || '').join('\n');
    return '';
};

/**
 * 這輪送出去的 messages 拆成評估要的兩段：開頭連續的 system（系統提示）＋其餘（對話，後面接上這則回覆）。
 * 預設的 assistant 預填不算對話，拿掉。
 */
export const splitForEmotionEval = (messages: ApiMessage[], reply: string): { systemPrompt: string; history: ApiMessage[] } => {
    let head = 0;
    while (head < messages.length && messages[head].role === 'system') head++;
    const rest = messages.slice(head);
    if (rest.length && rest[rest.length - 1].role === 'assistant') rest.pop();
    return {
        systemPrompt: messages.slice(0, head).map(m => textOf(m.content)).filter(t => t.trim()).join('\n\n'),
        history: [...rest, ...(reply.trim() ? [{ role: 'assistant', content: reply }] : [])],
    };
};

/** 評估結果落進故事；故事還沒有自己那份就以 seed（私聊當時那份）為底 */
export const applyDateEmotionRaw = async (raw: string, char: CharacterProfile, storyId: string): Promise<null> => {
    const result = parseEmotionEvalOutput(raw);
    if (!result) {
        announceEmotionFailed(char, '見面的情緒評估輸出不是可解析的 JSON（模型掉格式，可換個評估模型試試）');
        return null;
    }
    const seed = chatEmotionState(char);
    await patchDateStory(storyId, prev => {
        const next = settleEmotionEval(result, prev.emotion ?? seed);
        return next ? { emotion: next } : {};
    });
    return null;
};

/** 改故事那份情緒（面板刪條、改總結、重置） */
export const patchDateEmotion = (char: CharacterProfile, storyId: string, patch: Partial<EmotionState>) =>
    patchDateStory(storyId, prev => ({ emotion: { ...(prev.emotion ?? chatEmotionState(char)), ...patch } }));

/** 見面回覆落庫後呼叫；不 await 也行，失敗走情緒評估共用的提示 */
export const runDateEmotionEval = async (input: {
    char: CharacterProfile;
    story: DateStory | null | undefined;
    userProfile: UserProfile;
    messages: ApiMessage[];
    reply: string;
    apiConfig: { baseUrl: string; apiKey: string; model: string; stream?: boolean };
}): Promise<void> => {
    const { char, story, apiConfig } = input;
    if (!story || !shouldEvaluateDateEmotion(char) || isEmotionEvalSkipped()) return;
    // 情緒 API 跟私聊一樣：角色自己配了就用它，沒配用主 API；串流跟著開關
    const configured = char.emotionConfig?.api;
    const api = configured?.baseUrl
        ? { ...configured, stream: (configured as any).stream ?? !!apiConfig.stream }
        : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model, stream: !!apiConfig.stream };
    const { systemPrompt, history } = splitForEmotionEval(input.messages, input.reply);
    const { evaluateEmotionBackground } = await import('../hooks/useChatAI');
    await evaluateEmotionBackground(withStoryEmotion(char, story), input.userProfile, systemPrompt, history, api, {
        appName: '見面',
        ambient: false,
        applyRaw: raw => applyDateEmotionRaw(raw, char, story.id),
    });
};
