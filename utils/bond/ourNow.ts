/**
 * 「此刻的我們」：角色用自己的口吻寫一小段近期相處的變化（plans/bond-batch1.md 3.3，紀要 6.1）。
 * 寫的是願意讓對方看到的理解，不寫還沒說出口的心事；路線（含友情、親情的底線）照角色卡上的羈絆段走。
 */
import type { APIConfig, CharacterProfile, UserProfile } from '../../types';
import { ContextBuilder } from '../context';
import { resolveCharacterChatApi } from '../characterApi';
import { extractContent, safeFetchJson } from '../safeApi';
import { bondFinalLock, bondPromptBlock } from './prompt';
import { bondEntriesOf } from './entryRegistry';
import type { BondRecord } from '../../types';

/** 最近幾天的日總結（照線篩），給模型看「最近發生了什麼」 */
export function recentDailyLines(char: Pick<CharacterProfile, 'memories' | 'primaryPersonaKey'>, personaKey: string | undefined, limit = 10): string {
    const mine = (char.memories || []).filter(m => !m.personaKey || m.personaKey === personaKey || (!personaKey && !m.personaKey));
    return mine.slice(-limit).map(m => `- ${m.date}：${m.summary.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
}

export function buildOurNowPrompt(input: { selfName: string; otherName: string; recent: string; previous?: string }): string {
    const { selfName, otherName, recent, previous } = input;
    return `現在請你以「${selfName}」的身份，替你和${otherName}這段關係寫一小段「此刻的我們」。

【最近發生的事】
${recent || '（最近沒有特別記下的事，照你們平常相處的樣子寫）'}
${previous ? `\n【你上一次寫的】\n${previous}\n（這次寫現在的樣子；有變化就寫出變化，沒有就換個角度，別重複上一段）\n` : ''}
要求：
- 第一人稱，直接對${otherName}說或寫給${otherName}看，2～4 句，口吻照你的個性（寡言就短，嘴硬就嘴硬）。
- 寫最近相處的變化、你注意到的小習慣、還記著沒談完的事。是你願意讓${otherName}看到的理解，不要寫還沒打算說出口的心事。
- 只寫真的發生過、或你真的這樣覺得的；不要編造沒有發生過的共同經歷。
- 只輸出那一段話本身，不要標題、引號、解釋。`;
}

export async function generateOurNow(input: {
    char: CharacterProfile;
    /** 這條線上的你 */
    user: UserProfile;
    personaKey: string | undefined;
    bond: BondRecord;
    apiConfig: APIConfig;
    /** 角色 × 角色：對方是誰、他們最近私下聊的（已經整理成文字） */
    pair?: { other: Pick<CharacterProfile, 'id' | 'name'>; recent: string };
    signal?: AbortSignal;
}): Promise<string> {
    const { char, user, personaKey, bond, apiConfig, pair } = input;
    const api = resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('還沒設定 API');
    const otherName = pair ? pair.other.name : user.name;
    const selfIsCharId = bond.charId === char.id;
    const system = pair
        ? `${ContextBuilder.buildRoleSettingsContext(char)}\n${bondPromptBlock({ bond, selfName: char.name, otherName, selfIsCharId, entries: bondEntriesOf(bond.id), selfId: char.id, includeUserNotes: false, pair: { selfId: char.id, otherId: pair.other.id, isA: selfIsCharId } })}`
        : ContextBuilder.buildCoreContext(char, user, true);
    const lock = bondFinalLock(bond, otherName);
    const prompt = buildOurNowPrompt({
        selfName: char.name,
        otherName,
        recent: pair ? pair.recent : recentDailyLines(char, personaKey),
        previous: pair ? (selfIsCharId ? bond.ourNow?.char?.text : bond.ourNow?.other?.text) : bond.ourNow?.char?.text,
    });
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: lock ? `${prompt}\n\n${lock}` : prompt },
            ],
            temperature: 0.85,
            max_tokens: 1200,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
    }, 1, 90_000, { appName: '羈絆', charId: char.id, charName: char.name, purpose: '此刻的我們' });
    const text = extractContent(data).trim().replace(/^["「『]|["」』]$/g, '').trim();
    if (!text) throw new Error('這次沒寫出東西，再試一次');
    return text;
}
