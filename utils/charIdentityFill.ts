/**
 * 「AI 幫我填」：讀角色的人設，出別名、身份、一句話簡介（plans/character-identity-fields.md 3.6）。
 * 只管出建議；要不要填、蓋不蓋掉原本的字，由角色頁決定（空的格子直接填，有字的格子給建議）。
 */
import type { APIConfig, CharacterProfile } from '../types';
import { extractContent, safeFetchJson } from './safeApi';
import { stripLeakedReasoning } from './reasoningLeak';
import { normalizeAliases, ROLE_TITLE_MAX_LENGTH } from './charIdentity';

export interface IdentityFill {
    aliases: string[];
    roleTitle: string;
    brief: string;
}

export const IDENTITY_BRIEF_MAX = 80;

type FillSource = Pick<CharacterProfile, 'name' | 'description' | 'systemPrompt'> & Partial<Pick<CharacterProfile, 'worldview' | 'aliases' | 'roleTitle'>>;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 有沒有東西可以讀（人設、世界觀、簡介都空就不用打請求） */
export const hasIdentityFillSource = (char: FillSource): boolean =>
    !!(char.systemPrompt?.trim() || char.worldview?.trim() || char.description?.trim());

export function buildIdentityFillPrompt(char: FillSource): string {
    const parts = [
        char.systemPrompt?.trim() ? `【人設】\n${clip(char.systemPrompt.trim(), 6000)}` : '',
        char.worldview?.trim() ? `【世界觀】\n${clip(char.worldview.trim(), 1500)}` : '',
        char.description?.trim() ? `【現在的簡介】\n${clip(char.description.trim(), 300)}` : '',
    ].filter(Boolean).join('\n\n');
    return `下面是角色「${char.name}」的設定。請從裡面讀出三樣東西，給通訊錄用。

${parts || '（沒有設定）'}

要求：
- aliases：設定裡明確寫到的其他名字：本名、英文名、綽號、藝名、圈名、大家對 TA 的固定叫法。設定裡沒寫就給空陣列，不要自己編。不要放「${char.name}」本身，不要放「寶貝」「老公」這種只有戀人才叫的稱呼。最多 8 個。
- roleTitle：一行的身份或職位，15 字以內，例如「攝影師」「段家長子」「大三學生」。寫別人看得到的身份，不要寫 TA 跟用戶是什麼關係。讀不出來就給空字串。
- brief：一句話簡介，30 字以內，別人眼中的 TA。不要寫跟用戶之間的事。
- 繁體中文（名字原本是外文就照原文）。
- 只輸出 JSON，不要解釋：{"aliases":["…"],"roleTitle":"…","brief":"…"}`;
}

/** 模型輸出 → 三樣東西。掉格式（前後有字、包在程式碼塊裡）也盡量撈；撈不到回 null */
export function parseIdentityFill(raw: string, name = ''): IdentityFill | null {
    const text = stripLeakedReasoning(String(raw ?? '')).content.replace(/```[a-z]*\n?|```/gi, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let data: any;
    try { data = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    if (!data || typeof data !== 'object') return null;
    const list = Array.isArray(data.aliases) ? data.aliases : typeof data.aliases === 'string' ? data.aliases.split(/[,，、;；]+/) : [];
    const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim() : '');
    const fill: IdentityFill = {
        aliases: normalizeAliases(list, name),
        roleTitle: str(data.roleTitle ?? data.role ?? data.title).slice(0, ROLE_TITLE_MAX_LENGTH),
        brief: str(data.brief ?? data.description).slice(0, IDENTITY_BRIEF_MAX),
    };
    return fill.aliases.length || fill.roleTitle || fill.brief ? fill : null;
}

export async function generateIdentityFill(char: FillSource, api: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>, signal?: AbortSignal): Promise<IdentityFill> {
    if (!api.baseUrl?.trim() || !api.model?.trim()) throw new Error('請先在設定裡配置 API');
    const data = await safeFetchJson(`${api.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || ''}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: buildIdentityFillPrompt(char) }], temperature: 0.2, max_tokens: 600 }),
        ...(signal ? { signal } : {}),
    }, 0, 90_000, { appName: '神經鏈接', purpose: '補別名與身份' });
    const fill = parseIdentityFill(extractContent(data) || '', char.name);
    if (!fill) throw new Error('這次沒讀出東西，再試一次');
    return fill;
}

/**
 * 建議 → 要寫進角色的 patch：空的格子直接填；別名是補上原本沒有的；有字的身份、簡介不動，回在 suggestions 讓人自己決定。
 */
export function applyIdentityFill(char: Pick<CharacterProfile, 'name' | 'description'> & Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle'>>, fill: IdentityFill): {
    patch: Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle' | 'description'>>;
    suggestions: { roleTitle?: string; brief?: string };
    filled: string[];
} {
    const patch: Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle' | 'description'>> = {};
    const suggestions: { roleTitle?: string; brief?: string } = {};
    const filled: string[] = [];
    const before = normalizeAliases(char.aliases, char.name);
    const merged = normalizeAliases([...before, ...fill.aliases], char.name);
    if (merged.length > before.length) { patch.aliases = merged; filled.push('別名'); }
    const role = (char.roleTitle || '').trim();
    if (fill.roleTitle) {
        if (!role) { patch.roleTitle = fill.roleTitle; filled.push('身份'); }
        else if (role !== fill.roleTitle) suggestions.roleTitle = fill.roleTitle;
    }
    const brief = (char.description || '').trim();
    if (fill.brief) {
        if (!brief) { patch.description = fill.brief; filled.push('簡介'); }
        else if (brief !== fill.brief) suggestions.brief = fill.brief;
    }
    return { patch, suggestions, filled };
}

// ─── 批次補填（plans/character-identity-fields.md 3.6）───

/** 一次同時讀幾個角色 */
export const IDENTITY_BATCH_CONCURRENCY = 3;

type BatchSource = FillSource & Pick<CharacterProfile, 'id'> & Partial<Pick<CharacterProfile, 'altOf'>>;

/** 別名和身份都還沒填 */
export const needsIdentityFill = (char: Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle'>> & Pick<CharacterProfile, 'name'>): boolean =>
    !normalizeAliases(char.aliases, char.name).length && !(char.roleTitle || '').trim();

/** 批次頁列得出來的角色：小號不列（小號卡上的人設是空的，組提示詞時才換成本人的；拿本人的去讀會把本人的別名寫到小號上） */
export const batchFillCandidates = <T extends BatchSource>(chars: ReadonlyArray<T>): T[] => chars.filter(c => !c.altOf);

/** 預設勾誰：兩格都空、而且有人設可以讀 */
export const defaultBatchPicks = (chars: ReadonlyArray<BatchSource>): string[] =>
    batchFillCandidates(chars).filter(c => needsIdentityFill(c) && hasIdentityFillSource(c)).map(c => c.id);

/** 批次結果的一列：三格是可以再改的草稿，suggest* 是「原本有字、AI 另有建議」 */
export interface IdentityBatchDraft {
    aliasText: string;
    roleTitle: string;
    description: string;
    suggestRole?: string;
    suggestBrief?: string;
}

/** AI 的結果套到角色上，變成那一列的草稿（規則跟角色頁那顆「AI 幫我填」一樣） */
export function draftFromFill(char: Pick<CharacterProfile, 'name' | 'description'> & Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle'>>, fill: IdentityFill): IdentityBatchDraft {
    const { patch, suggestions } = applyIdentityFill(char, fill);
    return {
        aliasText: (patch.aliases ?? normalizeAliases(char.aliases, char.name)).join('、'),
        roleTitle: patch.roleTitle ?? (char.roleTitle || ''),
        description: patch.description ?? (char.description || ''),
        ...(suggestions.roleTitle ? { suggestRole: suggestions.roleTitle } : {}),
        ...(suggestions.brief ? { suggestBrief: suggestions.brief } : {}),
    };
}

/** 草稿跟角色現在的差別：要寫進去的 patch；一樣就回 null（不用寫） */
export function patchFromDraft(char: Pick<CharacterProfile, 'name' | 'description'> & Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle'>>, draft: IdentityBatchDraft): Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle' | 'description'>> | null {
    const patch: Partial<Pick<CharacterProfile, 'aliases' | 'roleTitle' | 'description'>> = {};
    const before = normalizeAliases(char.aliases, char.name);
    const after = normalizeAliases(draft.aliasText.split(/[,，、;；\n]+/), char.name);
    if (before.join('\u0001') !== after.join('\u0001')) patch.aliases = after.length ? after : undefined;
    const role = draft.roleTitle.replace(/\s+/g, ' ').trim().slice(0, ROLE_TITLE_MAX_LENGTH);
    if (role !== (char.roleTitle || '').trim()) patch.roleTitle = role || undefined;
    const brief = draft.description.trim();
    if (brief !== (char.description || '').trim()) patch.description = brief;
    return Object.keys(patch).length ? patch : null;
}

/** 限制同時幾個地跑完一串；按了停就不再開新的（已經在跑的讓它跑完或自己中止） */
export async function runLimited<T>(items: ReadonlyArray<T>, limit: number, worker: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
    let next = 0;
    const lane = async () => {
        while (next < items.length && !signal?.aborted) {
            const item = items[next++];
            await worker(item);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}
