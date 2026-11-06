/**
 * 見面線下故事的對話總結（plans/offline-date-redesign.md 第 7 項）。
 *
 * - 總結紀錄存在故事上（DateStory.summaries），按順序接起來就是「前情提要」，每輪帶進見面的提示詞：
 *   故事長到超出上下文窗口，角色也記得前面發生過什麼
 * - 自動總結：按角色回覆輪數（預設 10 輪）或每天固定時間；只總結 summarizedThroughId 之後的新訊息
 * - 立即總結：把還沒總結的部分總結掉（跟自動同一套，只是不等條件）；選範圍：任選第幾到第幾則，不動進度
 * - 進記憶宮殿：每次總結都送／只有完結時送（預設）／手動。見面原文照舊走記憶宮殿的一般整理，
 *   分段總結預設不送，免得同一段劇情記兩次
 *
 * 只在見面 App 開著時會跑（自動總結掛在每輪回覆之後、打開見面時檢查每天的時間）。
 */

import type { CharacterProfile, DateStory, DateStorySummary, DateSummaryConfig, Message } from '../types';
import type { ApiMessage } from './datePrompts';
import { parseDateBody } from './dateVoiceTags';
import { cleanDisplayText } from './meetingPreset/display';
import { messageBelongsToStory, patchDateStory } from './dateStory';
import { safeResponseJson, extractContent } from './safeApi';

export const DATE_SUMMARY_DEFAULTS: Required<Omit<DateSummaryConfig, 'prompt'>> = {
    auto: true,
    trigger: 'rounds',
    rounds: 10,
    dailyTime: '23:30',
    palaceMode: 'final',
};
export const DATE_SUMMARY_ROUNDS = { min: 1, max: 100 } as const;
/** 前情提要最多帶多少字；超過就留最近的幾段，說一聲前面省略了 */
export const DATE_RECAP_MAX_CHARS = 6000;

export const DEFAULT_DATE_SUMMARY_PROMPT = `用第三人稱、照時間順序，把這段劇情寫成一段連貫的總結（約 150–300 字）。
要留下：發生了什麼事、在哪裡、關鍵的對話或承諾、兩人關係和情緒的轉折、還沒解決的事。
不要評論、不要加沒發生的事、不要寫成條列。`;

export const resolveDateSummaryConfig = (char: CharacterProfile): Required<Omit<DateSummaryConfig, 'prompt'>> & { prompt?: string } => {
    const config = char.dateSummaryConfig || {};
    const rounds = Math.round(Number(config.rounds));
    return {
        auto: config.auto !== false,
        trigger: config.trigger === 'daily' ? 'daily' : 'rounds',
        rounds: Number.isFinite(rounds) ? Math.min(DATE_SUMMARY_ROUNDS.max, Math.max(DATE_SUMMARY_ROUNDS.min, rounds)) : DATE_SUMMARY_DEFAULTS.rounds,
        dailyTime: /^\d{2}:\d{2}$/.test(config.dailyTime || '') ? config.dailyTime! : DATE_SUMMARY_DEFAULTS.dailyTime,
        palaceMode: config.palaceMode === 'each' || config.palaceMode === 'manual' ? config.palaceMode : 'final',
        ...(config.prompt?.trim() ? { prompt: config.prompt.trim() } : {}),
    };
};

/** 這場故事的訊息（照順序，只留有字的） */
export const storyMessages = (messages: Message[], story: DateStory): Message[] =>
    messages
        .filter(message => messageBelongsToStory(message, story) && (message.role === 'user' || message.role === 'assistant') && (message.content || '').trim())
        .sort((a, b) => a.id - b.id);

export const unsummarizedMessages = (messages: Message[], story: DateStory): Message[] =>
    storyMessages(messages, story).filter(message => message.id > (story.summarizedThroughId ?? 0));

/** 每天那個時間點（今天的），用戶設備的時區 */
const todayAt = (time: string, now: number): number => {
    const [h, m] = time.split(':').map(Number);
    const date = new Date(now);
    date.setHours(h, m, 0, 0);
    return date.getTime();
};

/** 現在該不該自動總結 */
export const shouldAutoSummarize = (
    config: ReturnType<typeof resolveDateSummaryConfig>,
    story: DateStory,
    messages: Message[],
    now = Date.now(),
): boolean => {
    if (!config.auto || story.status !== 'ongoing') return false;
    const pending = unsummarizedMessages(messages, story);
    const replies = pending.filter(message => message.role === 'assistant').length;
    if (config.trigger === 'rounds') return replies >= config.rounds;
    // 每天：過了今天的時間點、今天這個點之後還沒自動總結過、有新的角色回覆
    const threshold = todayAt(config.dailyTime, now);
    if (now < threshold || replies === 0) return false;
    const lastAuto = [...(story.summaries || [])].reverse().find(summary => summary.kind === 'auto');
    return !lastAuto || lastAuto.createdAt < threshold;
};

/** 給總結看的純文字：拿掉語氣標籤、HTML、自訂標籤 */
export const summaryMessageText = (message: Message): string =>
    parseDateBody(cleanDisplayText(message.content || '')).map(line => line.text).join('\n').trim();

export const formatDateTranscript = (messages: Message[], charName: string, userName: string): string =>
    messages
        .map(message => `【${message.role === 'user' ? (userName || '用戶') : charName}】\n${summaryMessageText(message)}`)
        .filter(block => !block.endsWith('】\n'))
        .join('\n\n');

export const buildDateSummaryMessages = (input: {
    charName: string;
    userName: string;
    scenario?: string;
    /** 上一段總結，讓這段接得上 */
    previous?: string;
    messages: Message[];
    prompt?: string;
}): ApiMessage[] => {
    const userName = input.userName || '用戶';
    const system = [
        `你是一場線下故事的記錄者。故事的主角是${input.charName}和${userName}。你的工作是把一段劇情整理成總結，之後會當成「前情提要」給${input.charName}看。`,
        input.scenario?.trim() ? `這場故事的大綱：\n${input.scenario.trim()}` : '',
        input.previous?.trim() ? `上一段的總結（這段要接著它，不要重複它）：\n${input.previous.trim()}` : '',
        `總結要求：\n${input.prompt?.trim() || DEFAULT_DATE_SUMMARY_PROMPT}`,
        '只輸出總結本身，不要標題、不要前言、不要說明你在做什麼。',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `以下是要總結的劇情：\n\n${formatDateTranscript(input.messages, input.charName, userName)}` },
    ];
};

/** 前情提要：這場的總結照順序接起來，太長就留最近的 */
export const buildDateRecap = (story: DateStory | null | undefined, maxChars = DATE_RECAP_MAX_CHARS): string => {
    const summaries = (story?.summaries || []).filter(summary => summary.text.trim());
    if (!summaries.length) return '';
    const picked: string[] = [];
    let total = 0;
    for (let i = summaries.length - 1; i >= 0; i--) {
        const text = summaries[i].text.trim();
        if (picked.length && total + text.length > maxChars) break;
        picked.unshift(text);
        total += text.length;
    }
    const omitted = summaries.length - picked.length;
    return `### 前情提要\n（這場故事到目前為止發生的事，照順序。接著往下寫，別重演、別和它矛盾。）\n${omitted ? `（更早的 ${omitted} 段省略）\n` : ''}${picked.join('\n\n')}\n`;
};

export interface DateSummaryApi { baseUrl: string; apiKey: string; model: string }

export const callDateSummaryLLM = async (api: DateSummaryApi, messages: ApiMessage[], fetchImpl: typeof fetch = fetch): Promise<string> => {
    const response = await fetchImpl(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages, temperature: 0.3, max_tokens: 2000, stream: false }),
    });
    if (!response.ok) throw new Error(`總結失敗（API ${response.status}）`);
    const content = extractContent(await safeResponseJson(response));
    if (!content?.trim()) throw new Error('模型沒有回總結，請重試或換個模型');
    return content.trim();
};

const makeSummaryId = () => `dsum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** 正在總結的故事：同一場同時只跑一次 */
const running = new Set<string>();
export const isDateSummaryRunning = (storyId: string) => running.has(storyId);

/**
 * 做一段總結並存進故事。
 * - kind 'auto' / 'all'：總結還沒總結的部分，推進 summarizedThroughId
 * - kind 'range'：總結 range 指定的那幾則（訊息 id），不動進度
 * 沒東西可總結回 null。
 */
export const runDateSummary = async (input: {
    char: CharacterProfile;
    story: DateStory;
    userName: string;
    api: DateSummaryApi;
    /** 角色的見面訊息（至少要涵蓋這場故事） */
    messages: Message[];
    kind: DateStorySummary['kind'];
    range?: { fromMessageId: number; toMessageId: number };
    fetchImpl?: typeof fetch;
}): Promise<{ summary: DateStorySummary; story: DateStory } | null> => {
    const { story, char } = input;
    if (running.has(story.id)) return null;
    const all = storyMessages(input.messages, story);
    const picked = input.kind === 'range' && input.range
        ? all.filter(message => message.id >= input.range!.fromMessageId && message.id <= input.range!.toMessageId)
        : all.filter(message => message.id > (story.summarizedThroughId ?? 0));
    if (!picked.length) return null;
    running.add(story.id);
    try {
        const config = resolveDateSummaryConfig(char);
        const previous = [...(story.summaries || [])].reverse().find(summary => summary.toMessageId < picked[0].id)?.text;
        const text = await callDateSummaryLLM(input.api, buildDateSummaryMessages({
            charName: char.name,
            userName: input.userName,
            scenario: story.scenario,
            previous,
            messages: picked,
            prompt: config.prompt,
        }), input.fetchImpl);
        const summary: DateStorySummary = {
            id: makeSummaryId(),
            text,
            fromMessageId: picked[0].id,
            toMessageId: picked[picked.length - 1].id,
            messageCount: picked.length,
            createdAt: Date.now(),
            kind: input.kind,
        };
        const saved = await patchDateStory(story.id, prev => ({
            summaries: [...(prev.summaries || []), summary].sort((a, b) => a.fromMessageId - b.fromMessageId || a.createdAt - b.createdAt),
            ...(input.kind === 'range' ? {} : { summarizedThroughId: Math.max(prev.summarizedThroughId ?? 0, summary.toMessageId) }),
        }));
        return { summary, story: saved || story };
    } finally {
        running.delete(story.id);
    }
};

export const updateDateSummary = (storyId: string, summaryId: string, patch: Partial<DateStorySummary>) =>
    patchDateStory(storyId, prev => ({
        summaries: (prev.summaries || []).map(summary => (summary.id === summaryId ? { ...summary, ...patch, id: summary.id } : summary)),
    }));

export const deleteDateSummary = (storyId: string, summaryId: string) =>
    patchDateStory(storyId, prev => ({ summaries: (prev.summaries || []).filter(summary => summary.id !== summaryId) }));
