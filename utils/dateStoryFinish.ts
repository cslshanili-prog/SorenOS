/**
 * 完結線下故事（plans/offline-date-redesign.md 第 8 項）：寫整場總結、標成已完結、送進記憶宮殿。
 *
 * 整場總結怎麼來：先把還沒總結的尾巴總結成一段（跟「立即總結」同一套），再把這場所有分段總結
 * 收成一份回顧。只有一段就直接用那段，不多叫一次模型。這樣故事再長，餵給模型的也只是總結，不會爆上下文。
 * 送宮殿：「手動」以外都送（「只有完結時送」本來就是送這份；「每次都送」分段送過了，整場回顧是另一個層次，也送）。
 * 任何一步失敗都不完結，原樣丟錯，讓用戶選要重試還是直接結束。
 */

import type { CharacterProfile, DateStory, Message } from '../types';
import type { ApiMessage } from './datePrompts';
import { DB } from './db';
import { completeDateStory, patchDateStory, dateStoryLabel } from './dateStory';
import { callDateSummaryLLM, resolveDateSummaryConfig, runDateSummary, storyMessages, type DateSummaryApi } from './dateSummary';
import { importDateStorySummary } from './memoryPalace/pipeline';
import type { DatePalaceConfig } from './dateSummaryPalace';

export const DEFAULT_DATE_FINAL_PROMPT = `這場故事已經結束。把下面各段總結整理成整場故事的回顧（約 300–600 字），用第三人稱、照時間順序。
要寫出：故事怎麼開始、經過了哪些重要的事、兩人關係最後走到哪裡、留下了什麼約定或懸念。
不要條列、不要評論、不要加沒發生的事。`;

export const buildDateFinalSummaryMessages = (input: {
    charName: string;
    userName: string;
    scenario?: string;
    summaries: string[];
    /** 用戶的總結要求（當文風參考） */
    style?: string;
}): ApiMessage[] => {
    const userName = input.userName || '用戶';
    const system = [
        `你是一場線下故事的記錄者。故事的主角是${input.charName}和${userName}。`,
        input.scenario?.trim() ? `這場故事的大綱：\n${input.scenario.trim()}` : '',
        DEFAULT_DATE_FINAL_PROMPT,
        input.style?.trim() ? `文風、人稱照用戶的總結要求：\n${input.style.trim()}` : '',
        '只輸出回顧本身，不要標題、不要前言。',
    ].filter(Boolean).join('\n\n');
    const body = input.summaries.map((text, index) => `（第 ${index + 1} 段）\n${text.trim()}`).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `以下是這場故事的分段總結：\n\n${body}` },
    ];
};

/** 寫整場總結存到故事上（不完結、不送宮殿）。這場一句話都沒有就回 null */
export const writeDateFinalSummary = async (input: {
    char: CharacterProfile;
    story: DateStory;
    userName: string;
    api: DateSummaryApi;
    messages: Message[];
    fetchImpl?: typeof fetch;
}): Promise<DateStory | null> => {
    await runDateSummary({ ...input, kind: 'all' });
    const latest = (await DB.getDateStory(input.story.id)) || input.story;
    const texts = (latest.summaries || []).map(summary => summary.text).filter(text => text.trim());
    if (!texts.length) return storyMessages(input.messages, latest).length ? latest : null;
    const text = texts.length === 1
        ? texts[0].trim()
        : await callDateSummaryLLM(input.api, buildDateFinalSummaryMessages({
            charName: input.char.name,
            userName: input.userName,
            scenario: latest.scenario,
            summaries: texts,
            style: resolveDateSummaryConfig(input.char).prompt,
        }), input.fetchImpl);
    return patchDateStory(latest.id, { finalSummary: { text, createdAt: Date.now() } });
};

export type DatePalaceOutcome = 'stored' | 'duplicate' | 'busy' | 'error' | 'skipped';

/** 整場總結送進記憶宮殿（進臥室、比分段重要），成功記下時間 */
export const sendDateFinalToPalace = async (input: {
    char: CharacterProfile;
    story: DateStory;
    config: DatePalaceConfig;
    happenedAt: number;
}): Promise<DatePalaceOutcome> => {
    const text = input.story.finalSummary?.text;
    if (!text?.trim()) return 'skipped';
    const result = await importDateStorySummary({
        charId: input.char.id, content: text, happenedAt: input.happenedAt, final: true, tags: [dateStoryLabel(input.story), '完結'],
    }, input.config.embedding, input.config.llm);
    if (result.error === 'lock') return 'busy';
    if (result.error) return 'error';
    await patchDateStory(input.story.id, prev => ({ finalSummary: prev.finalSummary ? { ...prev.finalSummary, palaceAt: Date.now() } : prev.finalSummary }));
    return result.stored > 0 ? 'stored' : 'duplicate';
};

/** 完結並總結：寫整場總結 → 標成已完結 → 照設定送宮殿。回傳要寫回角色的欄位和宮殿結果 */
export const finishDateStoryWithSummary = async (input: {
    char: CharacterProfile;
    story: DateStory;
    userName: string;
    api: DateSummaryApi;
    messages: Message[];
    palace: DatePalaceConfig | null;
    fetchImpl?: typeof fetch;
}): Promise<{ story: DateStory; charPatch: Partial<CharacterProfile>; palace: DatePalaceOutcome }> => {
    const written = (await writeDateFinalSummary(input)) || input.story;
    const done = await completeDateStory(written);
    const config = resolveDateSummaryConfig(input.char);
    let palace: DatePalaceOutcome = 'skipped';
    if (config.palaceMode !== 'manual' && input.palace && done.story.finalSummary) {
        const last = storyMessages(input.messages, done.story).pop();
        try {
            palace = await sendDateFinalToPalace({ char: input.char, story: done.story, config: input.palace, happenedAt: last?.timestamp ?? Date.now() });
        } catch {
            palace = 'error';
        }
    }
    return { story: (await DB.getDateStory(done.story.id)) || done.story, charPatch: done.charPatch, palace };
};
