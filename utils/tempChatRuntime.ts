import type { APIConfig, CharacterProfile, Message } from '../types';
import { DB } from './db';
import { ContextBuilder } from './context';
import { resolveCharacterChatApi } from './characterApi';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { normalizeMessageContent } from './messageFormat';
import { getLocalDateKey } from './localDate';
import { nowInTimeZone, resolveCharTimeZone } from './timezone';
import {
    buildTempChatPrompt, charCount, isTempChatMessage, normalizeTempChatLimits, parseTempChatReply, tempChatRemaining,
    tempChatThread, type TempChatMeta,
} from './tempChat';

/**
 * 臨時會話的執行層：用戶送一句、角色回一句（或被拉黑的角色自己傳話）。純邏輯在 utils/tempChat.ts。
 * 角色這邊用它自己的對話模型；今天次數用完就不打 API。
 */

/** 角色那邊的「今天」。 */
export const charDayKey = (char: Pick<CharacterProfile, 'customTimezoneEnabled' | 'customTimezone'>, now: number = Date.now()): string =>
    getLocalDateKey(nowInTimeZone(resolveCharTimeZone(char), new Date(now)));

const visible = (m: Message) => !m.metadata?.hidden && !m.metadata?.proactiveHint;

const lineOf = (m: Message, charName: string, userName: string) => {
    const who = m.role === 'user' ? userName : m.role === 'assistant' ? charName : '系統';
    return `${who}: ${normalizeMessageContent(m, charName, userName).replace(/\s+/g, ' ').slice(0, 120)}`;
};

export async function loadTempChatState(char: CharacterProfile, now: number = Date.now()) {
    const limits = normalizeTempChatLimits(char.tempChatLimits);
    const recent = (await DB.getRecentMessagesByCharId(char.id, 200)).filter(visible);
    const since = char.chatBlock?.since ?? now;
    const dayKey = charDayKey(char, now);
    return {
        limits,
        dayKey,
        recent,
        thread: tempChatThread(recent, since),
        userRemaining: tempChatRemaining(recent, 'user', dayKey, limits),
        charRemaining: tempChatRemaining(recent, 'char', dayKey, limits),
    };
}

/** 用戶在臨時會話送一句。超過次數或字數就不存，回傳原因。 */
export async function sendUserTempMessage(char: CharacterProfile, text: string, now: number = Date.now()): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!char.chatBlock) return { ok: false, reason: '現在沒有在拉黑中' };
    const content = text.trim();
    if (!content) return { ok: false, reason: '先寫點什麼' };
    const state = await loadTempChatState(char, now);
    if (state.userRemaining <= 0) return { ok: false, reason: '今天的次數用完了，明天再說吧' };
    if (charCount(content) > state.limits.maxChars) return { ok: false, reason: `最多 ${state.limits.maxChars} 個字` };
    const meta: TempChatMeta = { from: 'user', dayKey: state.dayKey };
    await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content, metadata: { tempChat: meta } });
    return { ok: true };
}

/**
 * 角色在臨時會話開口：回對方剛傳的那句（replying），或被拉黑的角色自己想傳話。
 * 今天次數用完 → null（沒打 API）。說了話就存進去；unblock 只在角色是拉黑的那方時有意義，交給調用方處理。
 */
export async function generateCharTempMessage(params: {
    char: CharacterProfile;
    apiConfig: APIConfig;
    userName: string;
    replying: boolean;
    now?: number;
}): Promise<{ message: string; unblock: boolean } | null> {
    const { char, apiConfig, userName, replying, now = Date.now() } = params;
    const block = char.chatBlock;
    if (!block) return null;
    const state = await loadTempChatState(char, now);
    if (state.charRemaining <= 0) return null;
    const api = resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('沒有可用的 API');

    const before = state.recent.filter(m => m.timestamp < block.since && !isTempChatMessage(m)).slice(-8)
        .map(m => lineOf(m, char.name, userName)).join('\n');
    const thread = state.thread.slice(-12).map(m => lineOf(m, char.name, userName)).join('\n');
    const rejected = block.by === 'char'
        ? state.recent.filter(m => m.timestamp >= block.since && m.role === 'user' && !isTempChatMessage(m)).slice(-10)
            .map(m => lineOf(m, char.name, userName)).join('\n')
        : undefined;
    const prompt = buildTempChatPrompt({
        char, userName, before, thread, rejected, remaining: state.charRemaining, maxChars: state.limits.maxChars, replying,
    });
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'system', content: ContextBuilder.buildRoleSettingsContext(char) }, { role: 'user', content: prompt }],
            temperature: 0.9,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const rawText = extractContent(await safeResponseJson(response)) || '';
    const result = parseTempChatReply(extractJson(rawText, { silent: true }), rawText, state.limits.maxChars);
    if (result.message) {
        const meta: TempChatMeta = { from: 'char', dayKey: state.dayKey };
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: result.message, metadata: { tempChat: meta } });
    }
    return { message: result.message, unblock: block.by === 'char' && result.unblock };
}
