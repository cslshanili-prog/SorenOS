import type { APIConfig, CharacterProfile } from '../types';
import { safeResponseJson, extractContent } from './safeApi';
import { stripLeakedReasoning } from './reasoningLeak';

/**
 * 精簡人設（神經鏈接 · 角色編輯頁最下面一格）：一段 100～200 字、寫給「別人眼中的 TA」看的簡介。
 * 角色自己的私聊照舊用完整人設；需要「別人來演 TA、或別人要知道 TA 是怎樣的人」的地方用它：
 * 朋友圈批次留言、查手機的真實角色名單、家園生成 NPC 時的成員介紹。
 *
 * 重點是「怎麼說話」而不是生平：口吻、話量、口頭禪、對熟人和生人的差別——高冷的人在朋友圈
 * 不該笑場，就是靠這一段。沒填的角色退回從完整人設裡挑句子（utils/momentsVoice.ts）。
 */

export const BRIEF_PERSONA_MAX = 300;

type PersonaSource = Pick<CharacterProfile, 'description' | 'systemPrompt' | 'worldview'>;

/** 人設的指紋：生成時記下來，之後人設改過就提示重新生成。 */
export function personaFingerprint(char: PersonaSource): string {
    const text = [char.systemPrompt || '', char.worldview || '', char.description || ''].join('\u0001');
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    return `${text.length.toString(36)}-${hash.toString(36)}`;
}

/** 精簡人設是照舊版人設生成的（之後人設改過）。手寫的（沒有指紋）不算過期。 */
export const isBriefPersonaStale = (char: PersonaSource & Pick<CharacterProfile, 'briefPersona' | 'briefPersonaSource'>): boolean =>
    !!char.briefPersona?.trim() && !!char.briefPersonaSource && char.briefPersonaSource !== personaFingerprint(char);

export const resolveBriefPersona = (char: Pick<CharacterProfile, 'briefPersona'>): string => char.briefPersona?.trim() || '';

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function buildBriefPersonaPrompt(char: PersonaSource & Pick<CharacterProfile, 'name'>): string {
    const parts = [
        char.description?.trim() ? `【簡介】\n${clip(char.description.trim(), 1500)}` : '',
        char.systemPrompt?.trim() ? `【完整人設】\n${clip(char.systemPrompt.trim(), 6000)}` : '',
        char.worldview?.trim() ? `【世界觀】\n${clip(char.worldview.trim(), 1500)}` : '',
    ].filter(Boolean).join('\n\n');
    return `下面是角色「${char.name}」的設定。請把它壓縮成一段「精簡人設」，給其他角色參考：當別人提到 ${char.name}、或需要替 ${char.name} 在朋友圈留一句言時，靠這段就能抓準 TA 是怎樣的人、會怎麼說話。

${parts || '（沒有設定）'}

要求：
- 繁體中文，第三人稱，一段話，100～200 字。
- 依序寫到：一句話的身份；性格；說話方式（語氣、句子長短、口頭禪或用詞習慣）；話量（話多還是話少、會不會秒回、懶不懶得理人）；對熟人和不熟的人差在哪。
- 寫「別人看得到的樣子」：不要寫跟用戶之間的私密關係、劇情經過、祕密或只有 TA 自己知道的內心戲。
- 不要照抄原文、不要條列、不要加標題。只輸出這段正文。`;
}

/** 模型輸出收尾：剝思考外洩、引號、「精簡人設：」前綴，壓成一段。 */
export function cleanBriefPersona(raw: string): string {
    let text = stripLeakedReasoning(String(raw ?? '')).content;
    text = text.replace(/^```[a-z]*\n?|```$/gi, '').trim();
    text = text.replace(/^(?:\*\*)?(?:精簡人設|簡量人設|减量人设|精简人设)(?:\*\*)?\s*[：:]\s*/, '');
    text = text.replace(/^[「『"“]|[」』"”]$/g, '').trim();
    text = text.split(/\n+/).map(s => s.trim()).filter(Boolean).join('');
    return clip(text, BRIEF_PERSONA_MAX);
}

/** 打全局 API 生成一段精簡人設；回傳正文與這次用的指紋。 */
export async function generateBriefPersona(char: CharacterProfile, apiConfig: APIConfig): Promise<{ text: string; source: string }> {
    if (!apiConfig.baseUrl || !apiConfig.apiKey) throw new Error('請先在設定裡配置 API');
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [{ role: 'user', content: buildBriefPersonaPrompt(char) }],
            temperature: 0.4,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const text = cleanBriefPersona(extractContent(await safeResponseJson(response)) || '');
    if (!text) throw new Error('這次沒生成出內容，再試一次');
    return { text, source: personaFingerprint(char) };
}
