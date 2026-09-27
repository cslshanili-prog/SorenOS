import type { APIConfig, CharacterProfile, Message, UserProfile } from '../types';
import { DB } from './db';
import { resolveCharacterChatApi } from './characterApi';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { normalizeMessageContent } from './messageFormat';
import { stripLeakedReasoning } from './reasoningLeak';
import { characterVoice } from './momentsVoice';

/**
 * 「AI 幫我回覆」（聊天設定 · Scenario）：「+」面板按一下，替用戶想三個回覆草稿，掛在輸入欄上方；
 * 點一個就落進輸入框，用戶自己改完再發。草稿不存、不進聊天記錄，角色看不到。
 *
 * - 輸入框裡已經打了半句：當成「我想說的方向」，三個草稿都圍著它寫。
 * - 「草稿帶動作旁白」開著：句首可以帶一個全形括號的動作，格式跟角色那邊的「線上模式動作描寫」一樣。
 * - API 優先用副 API（記憶宮殿那組 lightLLM），沒設才用這個角色平常聊天的那組。
 * - 角色這邊只帶精簡人設（沒填就從完整人設挑講個性的句子），省 token，也夠抓對氣氛。
 */

export const REPLY_DRAFT_COUNT = 3;
export const REPLY_DRAFT_MAX = 150;
const HISTORY_LIMIT = 24;
const LINE_MAX = 160;

type Api = { baseUrl: string; apiKey: string; model: string };

/** 副 API 有設就用它，不然用這個角色平常聊天的那組。 */
export function resolveReplyDraftApi(lightLLM: Partial<Api> | undefined, char: CharacterProfile, apiConfig: APIConfig): Api {
    if (lightLLM?.baseUrl?.trim() && lightLLM.model?.trim()) {
        return { baseUrl: lightLLM.baseUrl, apiKey: lightLLM.apiKey || '', model: lightLLM.model };
    }
    return resolveCharacterChatApi(char, apiConfig);
}

type DraftUser = Pick<UserProfile, 'name' | 'bio' | 'customSetting'>;
type DraftChar = Pick<CharacterProfile, 'name' | 'description' | 'systemPrompt' | 'briefPersona'
    | 'chatNickname' | 'userNickname' | 'userViewRelationship' | 'charViewRelationship'>;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const visible = (m: Message) => !m.metadata?.hidden && !m.metadata?.proactiveHint;

export function draftHistoryLines(messages: Message[], charName: string, userName: string): string[] {
    return messages.filter(visible).slice(-HISTORY_LIMIT).map(m => {
        const who = m.role === 'user' ? userName : m.role === 'assistant' ? charName : '系統';
        return `${who}: ${clip(squash(normalizeMessageContent(m, charName, userName)), LINE_MAX)}`;
    }).filter(line => !line.endsWith(': '));
}

export function buildReplyDraftPrompt(params: {
    char: DraftChar;
    user: DraftUser;
    history: string[];
    partial?: string;
    withActions: boolean;
}): string {
    const { char, user, history, withActions } = params;
    const partial = params.partial?.trim();
    const me = user.name || '我';
    const userPersona = squash([user.bio, user.customSetting].filter(Boolean).join(' '));
    const relation = [
        char.userViewRelationship?.trim() && `${me} 認為兩人的關係：${char.userViewRelationship.trim()}`,
        char.charViewRelationship?.trim() && `${char.name} 認為兩人的關係：${char.charViewRelationship.trim()}`,
        char.chatNickname?.trim() && `${me} 叫 TA「${char.chatNickname.trim()}」`,
        char.userNickname?.trim() && `TA 叫 ${me}「${char.userNickname.trim()}」`,
    ].filter(Boolean).join('；');
    const voice = characterVoice(char);

    return [
        `你在幫「${me}」想下一句要傳給「${char.name}」的訊息。這是一段手機聊天，你寫的是 ${me} 要傳出去的話。`,
        voice && `【${char.name} 是怎樣的人】\n${voice}`,
        userPersona && `【${me}】\n${clip(userPersona, 400)}`,
        relation && `【關係】\n${relation}`,
        `【最近的對話（舊到新）】\n${history.length ? history.join('\n') : '（還沒聊過，這是第一句）'}`,
        partial && `【${me} 已經打了一半】\n「${clip(partial, 200)}」\n三個草稿都順著這個意思寫完或潤色，不要改掉原意。`,
        `要求：
- 站在 ${me} 的立場、用 ${me} 的口吻寫。不要替 ${char.name} 說話，不要解說、不要分析。
- ${REPLY_DRAFT_COUNT} 個草稿方向要明顯不同（例如順著接、逗 TA 或反問、表達情緒或換個話題），不要換湯不換藥。
- 語言和用字跟 ${me} 在這段對話裡平常的一樣；長度像手機訊息，一到三句。
${withActions
    ? '- 每個草稿可以在句首用全形括號帶一個動作或神態，跟台詞寫在同一行，例如「（咬了口糖葫蘆）不去……除非你求我」。一則最多一處，只放句首；不需要就不加。'
    : '- 只寫說出口的話，不要括號動作、不要旁白。'}
- 只輸出 JSON：{"drafts":["…","…","…"]}`,
    ].filter(Boolean).join('\n\n');
}

const LEADING_ACTION_RE = /^\s*[（(][^（）()]{1,40}[）)]\s*/;
const LIST_MARK_RE = /^\s*(?:\d+[.)、．:：]|[-*•・]|草稿\s*\d*\s*[：:])\s*/;
const QUOTES_RE = /^[「『"“]([\s\S]*)[」』"”]$/;

function cleanDraft(raw: unknown, withActions: boolean): string {
    let text = squash(String(raw ?? '')).replace(LIST_MARK_RE, '').replace(/,$/, '').trim();
    const quoted = text.match(QUOTES_RE);
    if (quoted) text = quoted[1].trim();
    if (!withActions) text = text.replace(LEADING_ACTION_RE, '').trim();
    return clip(text, REPLY_DRAFT_MAX);
}

/** 模型輸出 → 最多三個草稿。JSON 解析不了就按行拆（編號、引號剝掉）。 */
export function parseReplyDrafts(raw: string, withActions: boolean): string[] {
    const content = stripLeakedReasoning(String(raw ?? '')).content;
    const json = extractJson(content, { silent: true });
    const list: unknown[] = Array.isArray(json?.drafts) ? json.drafts
        : Array.isArray(json) ? json
        : content.replace(/```[a-z]*\n?|```/gi, '').split('\n').filter(line => !/^\s*[{}[\]]|"drafts"/.test(line));
    const seen = new Set<string>();
    const drafts: string[] = [];
    for (const item of list) {
        const text = cleanDraft(item, withActions);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        drafts.push(text);
        if (drafts.length >= REPLY_DRAFT_COUNT) break;
    }
    return drafts;
}

/** 打一次 API，回傳草稿（沒生成出東西就丟錯）。 */
export async function generateReplyDrafts(params: {
    char: CharacterProfile;
    user: DraftUser;
    apiConfig: APIConfig;
    lightLLM?: Partial<Api>;
    partial?: string;
}): Promise<string[]> {
    const { char, user, apiConfig, lightLLM, partial } = params;
    const api = resolveReplyDraftApi(lightLLM, char, apiConfig);
    if (!api.baseUrl) throw new Error('請先在設定裡配置 API');
    const withActions = !!char.replyDrafts?.withActions;
    const recent = await DB.getRecentMessagesByCharId(char.id, 60);
    const prompt = buildReplyDraftPrompt({
        char, user, withActions, partial,
        history: draftHistoryLines(recent, char.name, user.name || '我'),
    });
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.9,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const drafts = parseReplyDrafts(extractContent(await safeResponseJson(response)) || '', withActions);
    if (!drafts.length) throw new Error('這次沒想出來，再試一次');
    return drafts;
}
