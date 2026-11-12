/**
 * 幫角色開小號（關係線第 7 批 7a）：AI 照本人的人設想一個小號，以及把填好的小號組成角色卡。
 * 純邏輯在前面，打 API 的 requestAltDraft 在最後。
 */
import type { APIConfig, CharacterProfile } from '../types';
import { extractContent, extractJson, safeResponseJson } from './safeApi';
import { CONTEXT_RANGE_POLICY_VERSION, DEFAULT_MANUAL_CONTEXT_LIMIT } from './chatContextRange';

export interface AltDraft {
    name: string;
    /** 一句話簡介（別人看到的） */
    brief: string;
    /** 為什麼開這個小號 */
    purpose: string;
    /** 外觀，畫頭像用 */
    appearance: string;
}

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.trim() : '').slice(0, max);

export function buildAltGenPrompt(args: {
    owner: Pick<CharacterProfile, 'name' | 'description' | 'systemPrompt' | 'worldview'>;
    existingNames: string[];
    hint?: string;
}): string {
    const { owner } = args;
    return `你是幫角色扮演故事設計細節的編劇。角色「${owner.name}」要開一個網路小號（另一個帳號，別人不知道是 TA）。請照 TA 的人設，想一個 TA 真的會開的小號。

## 「${owner.name}」
- 簡介：${clip(owner.description, 200) || '（沒有）'}
- 人設：
${clip(owner.systemPrompt, 3000) || '（沒有）'}
${owner.worldview?.trim() ? `- 世界觀：\n${clip(owner.worldview, 1200)}\n` : ''}
## 方向
${args.hint?.trim() || '照 TA 的性格和處境，想一個 TA 開小號最可能的理由（想用別人的身份接近某個人、發不敢用本名發的東西、偷偷關注誰、做跟平常形象不符的事……）。'}

## 規則
- 小號的名字是網名，要像這個人會取的，但不能一看就知道是 TA；不要用這些名字：${[owner.name, ...args.existingNames].map(n => `「${n}」`).join('、')}。
- 簡介是別人點進這個帳號會看到的一句話。
- 理由寫 TA 自己心裡的真實想法（一兩句）。

## 輸出
只輸出一個 JSON 物件：{"name":"網名","brief":"帳號簡介","purpose":"開這個小號的真實理由","appearance":"小號頭像要畫什麼（不一定是本人的臉，可以是風景、動物、動漫圖……），一句話"}`;
}

export function parseAltDraft(raw: string): AltDraft | null {
    const obj = extractJson(String(raw ?? '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, ''), { silent: true });
    const o = Array.isArray(obj) ? obj[0] : obj;
    const name = clip(o?.name, 20);
    if (!name) return null;
    return { name, brief: clip(o?.brief, 80), purpose: clip(o?.purpose, 200), appearance: clip(o?.appearance, 200) };
}

/** 填好的小號 → 角色卡：所在世界、戲份、主線都跟本人；人設、記憶在組提示詞時讀本人的（utils/charAlt.ts）。 */
export function buildAltCharacter(args: {
    owner: Pick<CharacterProfile, 'id' | 'groupId' | 'castRole' | 'primaryPersonaKey'>;
    draft: Pick<AltDraft, 'name' | 'brief' | 'purpose'>;
    avatar: string;
    createdBy: 'user' | 'char';
    now?: number;
}): CharacterProfile {
    const now = args.now ?? Date.now();
    const { owner } = args;
    return {
        id: `char-alt-${now}-${Math.random().toString(36).slice(2, 7)}`,
        name: args.draft.name,
        avatar: args.avatar,
        description: args.draft.brief,
        systemPrompt: '',
        memories: [],
        altOf: owner.id,
        altPurpose: args.draft.purpose,
        altCreatedBy: args.createdBy,
        ...(owner.castRole ? { castRole: owner.castRole } : {}),
        ...(owner.groupId ? { groupId: owner.groupId } : {}),
        ...(owner.primaryPersonaKey ? { primaryPersonaKey: owner.primaryPersonaKey, knownPersonaKeys: [owner.primaryPersonaKey] } : {}),
        contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
        contextRangeMode: 'manual',
        contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
        // 日程、情緒是本人的事，小號不另外跑
        emotionConfig: { enabled: false },
    } as CharacterProfile;
}

export async function requestAltDraft(args: Parameters<typeof buildAltGenPrompt>[0] & { apiConfig: APIConfig }): Promise<AltDraft> {
    const { apiConfig, ...promptArgs } = args;
    if (!apiConfig.baseUrl || !apiConfig.apiKey) throw new Error('請先配置 API');
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: buildAltGenPrompt(promptArgs) }], temperature: 0.95 }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const draft = parseAltDraft(extractContent(await safeResponseJson(response)));
    if (!draft) throw new Error('沒看懂生成的內容，再試一次');
    return draft;
}
