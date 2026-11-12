/**
 * 認出小號寫資料庫的那一層（關係線第 7 批 7d）：你按「我知道你是誰」的那次生成、兩條線的系統提示。
 * 純邏輯在 utils/altReveal.ts。
 */
import type { APIConfig, CharacterProfile } from '../types';
import { DB } from './db';
import { ContextBuilder } from './context';
import { resolveCharacterChatApi } from './characterApi';
import { extractContent, extractJson, safeResponseJson } from './safeApi';
import { lineFor } from './chatLine';
import { altGuessUserText, altRevealNotes, buildAltGuessPrompt, parseAltGuessDecision } from './altReveal';

const fieldsOf = (line: { charId: string; personaKey?: string }) => (line.personaKey ? { charId: line.charId, personaKey: line.personaKey } : { charId: line.charId });

/** 認出來了：小號那條線和本人那條（同一個你）各落一則系統提示 */
export async function writeAltRevealNotes(args: { alt: CharacterProfile; owner: CharacterProfile; how: 'admitted' | 'told'; userName: string; now?: number }): Promise<void> {
    const { alt, owner, how, userName } = args;
    const now = args.now ?? Date.now();
    const notes = altRevealNotes({ altName: alt.name, ownerName: owner.name, userName, how });
    await DB.saveMessage({ charId: alt.id, role: 'system', type: 'text', content: notes.altLine, timestamp: now, metadata: { altReveal: how } });
    await DB.saveMessage({ ...fieldsOf(lineFor(owner, alt.primaryPersonaKey)), role: 'system', type: 'text', content: notes.ownerLine, timestamp: now, metadata: { altReveal: how } });
}

/**
 * 「我知道你是誰」：落你問的那句 → 它的回覆 →（認了）兩條線的系統提示。回傳要寫回小號的欄位。
 * 失敗丟錯（調用方提示可再試，你問的那句不留）。
 */
export async function runAltGuess(args: {
    alt: CharacterProfile;
    owner: CharacterProfile;
    guessName: string;
    reason: string;
    userName: string;
    apiConfig: APIConfig;
}): Promise<{ admitted: boolean; patch: Partial<CharacterProfile> }> {
    const { alt, owner, guessName, reason, userName, apiConfig } = args;
    const api = resolveCharacterChatApi(alt, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('沒有可用的 API');
    const recent = await DB.getRecentMessagesByCharId(alt.id, 20, true);
    const history = recent
        .filter(m => typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
        .map(m => `${m.role === 'user' ? userName : '你'}: ${String(m.content).replace(/\n+/g, ' ').slice(0, 160)}`)
        .join('\n');
    const prompt = `${history ? `你們最近在這個帳號上聊的：\n${history}\n\n` : ''}${buildAltGuessPrompt({ altName: alt.name, ownerName: owner.name, userName, guessName, reason, deniedTimes: alt.altDenied?.times || 0 })}`;
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            // 小號的角色設定：本人的人設，加「你現在用的小號」（ContextBuilder 認得小號）
            messages: [{ role: 'system', content: ContextBuilder.buildRoleSettingsContext(alt) }, { role: 'user', content: prompt }],
            temperature: 0.9,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const decision = parseAltGuessDecision(extractJson(extractContent(await safeResponseJson(response))));
    if (!decision) throw new Error('它的回覆沒看懂，再問一次試試');
    const now = Date.now();
    await DB.saveMessage({ charId: alt.id, role: 'user', type: 'text', content: altGuessUserText(guessName, reason), timestamp: now, metadata: { altGuess: guessName } });
    if (decision.reply) await DB.saveMessage({ charId: alt.id, role: 'assistant', type: 'text', content: decision.reply, timestamp: now + 1 });
    if (decision.admitted) {
        await writeAltRevealNotes({ alt, owner, how: 'admitted', userName, now: now + 2 });
        return { admitted: true, patch: { altRevealed: { at: now, how: 'admitted' } } };
    }
    // 猜錯人不算懷疑過本人
    if (guessName !== owner.name) return { admitted: false, patch: {} };
    return { admitted: false, patch: { altDenied: { times: (alt.altDenied?.times || 0) + 1, lastAt: now } } };
}
