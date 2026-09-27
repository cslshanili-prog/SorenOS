import type { APIConfig, CharacterProfile } from '../types';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { clampManualContextLimit, resolveContextRangeMode } from './chatContextRange';
import { resolveMemoryPalaceWaterline } from './memoryPalace/waterline';
import { expandWorldbookMacros } from './worldbook';

/**
 * 神經鏈接 ·「對話範例」：角色說話風格的示範，從人設裡拆出來單獨一欄。
 *
 * - 送給模型時明確標成「口吻示範，不是發生過的對話」：混在人設裡時，模型常把範例當真事、或照抄原句。
 * - 聊久了就不帶：私聊訊息總數到了門檻（預設 60），聊天記錄裡已經全是角色自己的原話，那才是更好的範例，
 *   再附一份等於重複付錢。用「總數」判斷（只增不減），跨過去只切一次、快取只作廢一次；
 *   不用「這輪送出幾則」，那個數字會跟著記憶宮殿整理忽上忽下，範例跟著進進出出，每次都打斷快取。
 * - 上下文設得太小（每輪帶不到 30 則）就一直附上：模型手上的角色原話太少，撐不住口吻。
 *   這裡看的是設定值（手動拉桿、或自動模式的記憶宮殿熱區），同樣不會忽上忽下。
 * - 沒有私聊則數可參考的地方（見面、通話、各種小 App）照舊附上，跟以前寫在人設裡一樣。
 */

export const DEFAULT_EXAMPLES_CUTOFF = 60;
export const EXAMPLES_CUTOFF_MIN = 20;
export const EXAMPLES_CUTOFF_MAX = 300;
/** 每輪帶的聊天記錄少於這個數，就一直附上範例。 */
export const EXAMPLES_MIN_WINDOW = 30;

type ExampleChar = Pick<CharacterProfile, 'dialogueExamples' | 'dialogueExamplesCutoff' | 'dialogueExamplesAlways'
    | 'contextLimit' | 'contextRangeMode' | 'autoArchiveEnabled' | 'contextFollowsMemoryPalaceHwm' | 'memoryPalaceWaterline'>;

export const clampExamplesCutoff = (value: unknown): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_EXAMPLES_CUTOFF;
    return Math.max(EXAMPLES_CUTOFF_MIN, Math.min(EXAMPLES_CUTOFF_MAX, n));
};

/** 每輪至少會帶幾則聊天記錄（設定值，不是這輪的實際則數）。 */
export function contextWindowFloor(char: ExampleChar): number {
    const limit = clampManualContextLimit(char.contextLimit ?? undefined);
    if (resolveContextRangeMode(char as CharacterProfile) !== 'adaptive') return limit;
    return Math.min(limit, resolveMemoryPalaceWaterline(char.memoryPalaceWaterline).hotZoneSize);
}

/**
 * 這一輪要不要附上範例。totalMessages 不給（不是私聊、或拿不到）就附上。
 */
export function shouldIncludeDialogueExamples(char: ExampleChar, totalMessages?: number): boolean {
    if (!char.dialogueExamples?.trim()) return false;
    if (char.dialogueExamplesAlways) return true;
    if (typeof totalMessages !== 'number' || !Number.isFinite(totalMessages)) return true;
    if (contextWindowFloor(char) < EXAMPLES_MIN_WINDOW) return true;
    return totalMessages < clampExamplesCutoff(char.dialogueExamplesCutoff);
}

export function formatDialogueExamplesBlock(examples: string | undefined, charName: string, userName: string): string {
    const text = expandWorldbookMacros(examples?.trim() || '', charName, userName);
    if (!text) return '';
    return `### 說話風格示範 (Dialogue Examples)
以下只是 ${charName} 說話口吻的示範：學語氣、句子長短、用詞和標點習慣。它們不是你們真的發生過的對話，也不是記憶；不要照抄句子，不要提起裡面的內容。
${text}

`;
}

// ── AI 從核心指令拆出範例 ───────────────────────────────────────────

export function buildExtractExamplesPrompt(systemPrompt: string): string {
    return `下面是一份角色人設。請找出裡面屬於「對話範例／說話示範」的段落：示範角色怎麼說話的台詞、範例對話、例句（包含它們的小標題，例如「對話範例：」「【示例】」）。

不算範例的不要挑：描述說話風格的規則（例如「說話簡短、愛用反問」）、性格、背景、關係、世界觀。

每一段都要**一字不差**從原文複製，不要改寫、不要合併、不要補字。沒有範例就回傳空陣列。
只輸出 JSON：{"examples":["原文段落1","原文段落2"]}

【人設原文】
${systemPrompt}`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 在原文裡找這段（空白、換行不同也認得）；找不到回 null。 */
function locate(source: string, passage: string): { start: number; end: number } | null {
    const exact = source.indexOf(passage);
    if (exact >= 0) return { start: exact, end: exact + passage.length };
    const parts = passage.split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const match = new RegExp(parts.map(escapeRegExp).join('\\s+')).exec(source);
    return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** 範例拿走之後，只剩一個「範例」小標題的空行也順手清掉。 */
const ORPHAN_HEADING_RE = /^[ \t]*(?:#{1,6}[ \t]*)?[【\[「]?[ \t]*(?:對話|对话|說話|说话)?(?:範例|范例|示例|示範|示范|例句|例子|樣例|样例|example[s]?)[ \t]*[】\]」]?[ \t]*[：:]?[ \t]*$/gim;

export interface ExtractedExamples {
    examples: string;
    persona: string;
    found: number;
    missed: number;
}

/**
 * 模型回的段落 → 從人設裡拿掉、接成範例欄。只拿原文裡真的找得到的段落，模型改寫過的一律不動，
 * 所以人設不會被模型「順手潤飾」。
 */
export function applyExtractedExamples(systemPrompt: string, raw: string): ExtractedExamples {
    const json = extractJson(raw, { silent: true });
    const passages: string[] = (Array.isArray(json?.examples) ? json.examples : [])
        .map((p: unknown) => String(p ?? '').trim()).filter((p: string) => p.length >= 4);
    let persona = systemPrompt;
    const taken: string[] = [];
    let missed = 0;
    for (const passage of passages) {
        const at = locate(persona, passage);
        if (!at) { missed++; continue; }
        taken.push(persona.slice(at.start, at.end).trim());
        persona = persona.slice(0, at.start) + persona.slice(at.end);
    }
    if (taken.length) {
        // 有段落沒找到時小標題留著：底下可能還掛著沒拆走的範例
        if (!missed) persona = persona.replace(ORPHAN_HEADING_RE, '');
        persona = persona.replace(/\n{3,}/g, '\n\n').trim();
    }
    return { examples: taken.join('\n\n'), persona: taken.length ? persona : systemPrompt, found: taken.length, missed };
}

export async function extractDialogueExamples(systemPrompt: string, apiConfig: APIConfig): Promise<ExtractedExamples> {
    if (!apiConfig.baseUrl || !apiConfig.apiKey) throw new Error('請先在設定裡配置 API');
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [{ role: 'user', content: buildExtractExamplesPrompt(systemPrompt) }],
            temperature: 0,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    return applyExtractedExamples(systemPrompt, extractContent(await safeResponseJson(response)) || '');
}
