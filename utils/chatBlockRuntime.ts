import type { APIConfig, CharacterProfile, Message } from '../types';
import { DB } from './db';
import { ContextBuilder } from './context';
import { resolveCharacterChatApi } from './characterApi';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { normalizeMessageContent } from './messageFormat';
import { buildReconsiderPrompt, isCharBlockingUser, parseReconsider } from './chatBlock';
import { TEMP_CHAT_HISTORY_PREFIX } from './tempChat';

/**
 * 角色拉黑用戶之後，冷靜期到了讓角色想一次要不要解除（OSContext 每分鐘看一次誰到點了）。
 * 打角色自己的對話模型一次；結果交回 OSContext 寫角色、落訊息。純邏輯在 utils/chatBlock.ts。
 */

export type ReconsiderOutcome =
    | { kind: 'unblock'; message: string }
    | { kind: 'stay' }
    | { kind: 'failed'; error: unknown };

const BEFORE_LINES = 8;
const REJECTED_LINES = 15;

const visible = (m: Message) => !m.metadata?.hidden && !m.metadata?.proactiveHint;

const lineOf = (m: Message, charName: string, userName: string) => {
    const who = m.role === 'user' ? userName : m.role === 'assistant' ? charName : '系統';
    const temp = m.metadata?.tempChat ? TEMP_CHAT_HISTORY_PREFIX : '';
    return `${who}: ${temp}${normalizeMessageContent(m, charName, userName).replace(/\s+/g, ' ').slice(0, 120)}`;
};

let running = false;

export async function runCharBlockReconsider(params: {
    char: CharacterProfile;
    apiConfig: APIConfig;
    userName: string;
    now?: number;
}): Promise<ReconsiderOutcome | null> {
    const { char, apiConfig, userName, now = Date.now() } = params;
    const block = char.chatBlock;
    if (!block || !isCharBlockingUser(char) || running) return null;
    const api = resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) return { kind: 'failed', error: new Error('沒有可用的 API') };
    running = true;
    try {
        const recent = (await DB.getRecentMessagesByCharId(char.id, 80)).filter(visible);
        const before = recent.filter(m => m.timestamp < block.since).slice(-BEFORE_LINES)
            .map(m => lineOf(m, char.name, userName)).join('\n');
        // 拉黑之後對方送出的：私聊裡被拒收的，加上臨時會話雙方說過的話（標了「臨時會話」）
        const rejected = recent.filter(m => m.timestamp >= block.since && (m.role === 'user' || !!m.metadata?.tempChat)).slice(-REJECTED_LINES)
            .map(m => lineOf(m, char.name, userName)).join('\n');
        const prompt = buildReconsiderPrompt({ charName: char.name, userName, reason: block.reason, since: block.since, now, before, rejected });
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
        const decision = parseReconsider(extractJson(extractContent(await safeResponseJson(response))));
        return decision.unblock ? { kind: 'unblock', message: decision.message } : { kind: 'stay' };
    } catch (error) {
        return { kind: 'failed', error };
    } finally {
        running = false;
    }
}
