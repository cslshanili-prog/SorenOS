/**
 * 見面回覆的原文、思考過程與重新生成說明（plans/offline-date-redesign.md「看得到預設有沒有在跑」）。
 *
 * - 模型回來的整段原文（含預設要的思維鏈標籤、<title> 這類結構標籤）存在 metadata.dateRaw，
 *   渠道另外給的原生思考（reasoning_content）存在 metadata.dateReasoning；content 照舊是跑過
 *   「存檔」正則、拿掉 <think> 的正文，總結、記憶、私聊上下文讀的都是它，不會被思維鏈撐大
 * - 長按編輯改的是原文；存回去時再跑一次「存檔」正則換出新的 content
 * - 重新生成可以附一段說明，插在送出內容的最後（預設有 assistant 預填的話放在它前面）
 */

import type { ApiMessage } from './datePrompts';
import type { MeetingRegexScript } from './meetingPreset/types';
import { applyRegexScripts, REGEX_PLACEMENT } from './meetingPreset/regex';
import type { MacroEnv } from './meetingPreset/macros';
import { extractContent } from './safeApi';

export interface DateReply {
    /** 給 content 用的正文（拿掉 <think> 這類） */
    content: string;
    /** 模型給的整段原文 */
    raw: string;
    /** 渠道另外給的原生思考 */
    reasoning: string;
}

const partsToText = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(partsToText).join('');
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return partsToText(record.text ?? record.content ?? record.value);
    }
    return '';
};

export const readDateReply = (data: any): DateReply => {
    const message = data?.choices?.[0]?.message;
    const raw = partsToText(message?.content).trim();
    const reasoning = partsToText(message?.reasoning_content ?? message?.reasoning ?? message?.thinking).trim();
    return { content: extractContent(data), raw, reasoning };
};

/** 存進 metadata 的那幾欄：原文跟正文一樣就不重存 */
export const dateReplyMeta = (reply: Pick<DateReply, 'raw' | 'reasoning'>, content: string, presetName?: string) => ({
    ...(reply.raw && reply.raw.trim() !== content.trim() ? { dateRaw: reply.raw } : {}),
    ...(reply.reasoning ? { dateReasoning: reply.reasoning } : {}),
    ...(presetName ? { datePresetName: presetName } : {}),
});

const THINK_BLOCK_RE = /<(think|thinking|thought)>[\s\S]*?<\/\1>/gi;
const THINK_OPEN_RE = /<(?:think|thinking|thought)>[\s\S]*$/gi;

/** 原文 → content：跟收到回覆時同一套（拿掉 <think>、跑「存檔」正則） */
export const contentFromDateRaw = (raw: string, regexScripts?: MeetingRegexScript[], env?: MacroEnv): string => {
    const stripped = raw.replace(THINK_BLOCK_RE, '').replace(THINK_OPEN_RE, '').trim();
    return regexScripts?.length
        ? applyRegexScripts(stripped, regexScripts, { placement: REGEX_PLACEMENT.aiOutput, stage: 'store', env }).trim()
        : stripped;
};

/** 字數：不算空白 */
export const countDateChars = (text: string): number => text.replace(/\s+/g, '').length;

export const DATE_REROLL_REASONS = ['角色 OOC', '忘了前文', '搞錯事情', '太短', '太長', '重複前文', '沒照預設的格式'] as const;
export const DATE_REROLL_NOTE_MAX = 500;

/** 重新生成的說明插在最後；尾巴是 assistant 預填的話放在它前面，預填才接得上 */
export const appendDateRerollNote = (messages: ApiMessage[], note: string): ApiMessage[] => {
    const text = note.trim().slice(0, DATE_REROLL_NOTE_MAX);
    if (!text) return messages;
    let at = messages.length;
    while (at > 0 && messages[at - 1].role === 'assistant') at--;
    const instruction: ApiMessage = {
        role: 'system',
        content: `【重新生成】上一版回覆沒有被採用，這次請照下面的要求重寫，其他規則照舊：\n${text}`,
    };
    return [...messages.slice(0, at), instruction, ...messages.slice(at)];
};
