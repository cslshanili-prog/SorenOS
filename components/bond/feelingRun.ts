/**
 * 親近與信任要叫模型的兩件事（plans/bond-batch4.md 1.8）：
 * - 起點估算：讀這條線的每日總結和聊天設定的關係，估兩個數字（你可以改）；
 * - 沒開情緒評估的角色：每日總結寫好時讀那天的總結，判那天有沒有會動到親近、信任的事。
 * 另外長期冷落（一週沒說話）由 pact 的 tick 順便看。
 */
import type { APIConfig, CharacterProfile, MemoryFragment } from '../../types';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { memoriesForLine } from '../../utils/bond/timeline';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { personaBondId } from '../../utils/bond/model';
import { buildFeelingEvalSection, buildFeelingStartPrompt, neglectInput, NEGLECT_DAYS, parseFeelingEvents, parseFeelingStart } from '../../utils/bond/feeling';
import { recordFeelingEvents } from '../../utils/bond/feelingStore';
import { parseJsonObject } from '../../utils/bond/outputPromptCore';
import type { ResolvedSpace } from './space';

const apiOf = (apiConfig: APIConfig) => globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);

async function ask(apiConfig: APIConfig, char: CharacterProfile, prompt: string, purpose: string): Promise<string> {
    const api = apiOf(apiConfig);
    if (!api) throw new Error('還沒設定 API');
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 1200 }),
    }, 1, 90_000, { appName: '羈絆', charId: char.id, charName: char.name, purpose });
    return extractContent(data);
}

/** 估起點（不存，回給頁面讓你看過再定） */
export async function estimateFeelingStart(space: ResolvedSpace, apiConfig: APIConfig): Promise<{ closeness: number; trust: number; why: string }> {
    const summaries = memoriesForLine(space.char.memories, space.personaKey, space.char.primaryPersonaKey)
        .sort((a, b) => a.date.localeCompare(b.date)).slice(-60)
        .map(m => `［${m.date}］${(m.summary || '').replace(/\s+/g, ' ').slice(0, 200)}`);
    const relation = space.view?.charViewRelationship || space.view?.userViewRelationship || undefined;
    const raw = await ask(apiConfig, space.char, buildFeelingStartPrompt({ charName: space.char.name, otherName: space.leftName, relation, summaries }), '估親近信任起點');
    const out = parseFeelingStart(parseJsonObject(raw));
    if (!out) throw new Error('這次沒估出來，再試一次或自己填');
    return out;
}

/**
 * 沒開情緒評估的角色：那天的總結寫好時判一次。只有這條線開始記了、而且角色沒開評估才跑
 * （開了評估的已經每輪在算，不重複算）。
 */
export async function settleFeelingFromSummary(char: CharacterProfile, memory: MemoryFragment, userName: string, apiConfig: APIConfig): Promise<number> {
    if (char.emotionConfig?.enabled) return 0;
    const bondId = personaBondId(char.id, memory.personaKey || char.primaryPersonaKey);
    const bond = bondOrBlank(bondId);
    if (!bond.feeling || !(memory.summary || '').trim()) return 0;
    const prompt = `你是${char.name}。下面是你和${userName}在 ${memory.date} 的總結：
${memory.summary.trim()}
${buildFeelingEvalSection(bond.feeling, userName, bond.route).replace('這一輪', '這一天').replace('在上述 JSON 裡額外加', '輸出')}

只輸出 JSON：{"bondFeeling":{"events":[…]}}；那天沒有就輸出 {"bondFeeling":{"events":[]}}。`;
    const raw = await ask(apiConfig, char, prompt, '親近信任結算');
    const inputs = parseFeelingEvents(parseJsonObject(raw), 'summary').map(i => ({ ...i, memoryId: memory.id }));
    return (await recordFeelingEvents(bondId, inputs)).length;
}

/** 長期冷落：一週以上你沒說話，每滿一週記一次（親近 −2） */
export async function checkNeglect(bondId: string, lastUserMessageAt: number, now = Date.now()): Promise<void> {
    const bond = bondOrBlank(bondId);
    const f = bond.feeling;
    if (!f || !lastUserMessageAt) return;
    const days = Math.floor((now - lastUserMessageAt) / 86_400_000);
    if (days < NEGLECT_DAYS) return;
    const lastNeglect = bond.feelingNeglectAt || 0;
    if (now - Math.max(lastNeglect, lastUserMessageAt) < NEGLECT_DAYS * 86_400_000) return;
    await recordFeelingEvents(bondId, [neglectInput(days)]);
    await updateBond(bondId, b => ({ ...b, feelingNeglectAt: now }));
}
