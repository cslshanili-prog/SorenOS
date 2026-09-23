/**
 * 外部記憶搬家
 *
 * 給「神經鏈接 -> 傳統記憶」和「記憶宮殿 -> 向量記憶」共用：
 * - 單次最多 5 萬字；
 * - 按自然段分批調用 LLM，避免長輸入時模型只處理開頭；
 * - 只整理時間與結構，不做摘要、不刪除細節；
 * - 輸出可直接轉成 MemoryNode，供後續 embedding / 建鏈。
 */

import type { MemoryNode, MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';

export const EXTERNAL_MEMORY_MAX_CHARS = 50_000;
export const EXTERNAL_MEMORY_CHUNK_CHARS = 10_000;
export const EXTERNAL_MEMORY_MIN_CONTENT_RATIO = 0.72;

export interface ExternalMemoryLengthInfo {
    /** Unicode 字符數（emoji 等代理對按 1 個字符計算），完全在本地統計。 */
    count: number;
    limit: number;
    overLimit: boolean;
    overBy: number;
    /** 超限時建議拆成幾次導入；未超限為 1。 */
    suggestedBatches: number;
}

export function getExternalMemoryLengthInfo(rawText: string): ExternalMemoryLengthInfo {
    const count = Array.from(rawText).length;
    return {
        count,
        limit: EXTERNAL_MEMORY_MAX_CHARS,
        overLimit: count > EXTERNAL_MEMORY_MAX_CHARS,
        overBy: Math.max(0, count - EXTERNAL_MEMORY_MAX_CHARS),
        suggestedBatches: Math.max(1, Math.ceil(count / EXTERNAL_MEMORY_MAX_CHARS)),
    };
}

export function getExternalMemoryOverLimitMessage(rawText: string): string {
    const info = getExternalMemoryLengthInfo(rawText);
    if (!info.overLimit) return '';
    return `當前 ${info.count.toLocaleString()} 字，超過單次上限 ${info.limit.toLocaleString()} 字。`
        + `建議按原文順序拆成 ${info.suggestedBatches} 批，每批不超過 5 萬字，優先在日期或完整事件段落之間切開。`
        + '當前內容不會上傳，也不會調用 API。';
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];
const VALID_MOODS = new Set([
    'happy', 'sad', 'angry', 'anxious', 'tender', 'excited',
    'peaceful', 'confused', 'hurt', 'grateful', 'nostalgic', 'neutral',
]);

export interface ExternalMemoryBatchResult {
    index: number;
    total: number;
    extracted: number;
    ok: boolean;
    error?: string;
}

export interface ExternalMemoryExtractionResult {
    memories: MemoryNode[];
    batches: ExternalMemoryBatchResult[];
}

/** 保留原文順序，優先在換行處分批；不對內容做摘要或字符截斷。 */
export function splitExternalMemoryText(
    rawText: string,
    chunkChars: number = EXTERNAL_MEMORY_CHUNK_CHARS,
): string[] {
    const text = rawText.replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    const lengthInfo = getExternalMemoryLengthInfo(text);
    if (lengthInfo.overLimit) {
        throw new Error(getExternalMemoryOverLimitMessage(text));
    }
    if (chunkChars < 1) throw new Error('分批長度必須大於 0');

    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        let end = Math.min(cursor + chunkChars, text.length);
        if (end < text.length) {
            // 至少走過本批 60% 後才回找自然邊界，避免遇到很早的換行就切出碎片。
            const minNaturalBreak = cursor + Math.floor(chunkChars * 0.6);
            const newline = text.lastIndexOf('\n', end);
            if (newline >= minNaturalBreak) end = newline + 1;
        }
        const chunk = text.slice(cursor, end).trim();
        if (chunk) chunks.push(chunk);
        cursor = end;
    }
    return chunks;
}

export function buildExternalMemoryPrompt(charName: string, userName: string): string {
    const userLabel = userName || '用戶';
    return `你是“外部記憶搬家整理器”。這些文字來自別的應用、設備或記憶系統，要遷入 ${charName} 的記憶。

你必須同時完成兩個硬目標，缺一不可：
A. 輸出能被程序直接解析、字段符合下方定義的完整 JSON 數組。
B. 對原文做無損搬運：只整理時間和結構，不壓縮內容；不刪除、不更改、不壓縮內容。

1. 不得總結、概括、潤色、改寫、合併同類項或去重；不得用一句結論代替一段經歷，也不得輸出“略”“其餘同上”等省略表達。
2. 原文裡的每個具體事實、人物、稱呼、地點、數字、對話、動作、因果、先後順序、情緒和細微反應都必須保留。寧可多拆幾條，也不能省略。
3. 先鎖定人物身份，再做必要的視角轉換；嚴禁把所有“我/你/他/她”機械歸給同一個人。
   - 目標記憶主人固定是“${charName}”；與其對話和相處的用戶固定是“${userLabel}”。
   - 身份判斷優先級：原文明示的姓名或角色標籤 > 說話人標籤與上下文 > 代詞。明確證據優先，不能反過來靠猜測覆蓋姓名。
   - 原文標明由 ${charName} 敘述時，敘述中的“我”可轉成記憶第一人稱“我”；原文標明由 ${userLabel}/用戶敘述時，“我”必須寫成“${userLabel}”，絕不能寫成 ${charName} 的“我”。
   - 第三方保持原姓名或原稱呼，不得擅自改成 ${charName} 或 ${userLabel}。
   - 引號內的第一人稱屬於原說話人，對話必須原樣保留，不能把引號裡的“我”替換成記憶主人。
   - 如果片段缺少說話人、代詞指向無法可靠判斷，保留原稱呼/代詞並忠實搬運，不猜、不補人物關係。
   例：來源標註“${userLabel}：我帶了娃娃出門”時，應寫“${userLabel}帶了娃娃出門”，不能寫“我帶了娃娃出門”；來源標註“${charName}：我沒敢問”時，才可寫“我沒敢問”。
4. 1500 字只是單條 content 的拆分提示，不是壓縮目標。原事件太長時，按自然段連續拆成多條並完整承接；禁止為了滿足字數而刪改、縮寫或截斷。
5. date 填事件實際日期，格式 YYYY-MM-DD。原文只有月份可填 YYYY-MM；只有年份可填 YYYY；完全不確定填 null。嚴禁猜日期。
6. room 先按記憶主體與用途分類，不要看到負面內容就塞進閣樓：
   - living_room：純日常瑣事
   - bedroom：${userLabel}和我的共同經歷、親密情感與深層羈絆（即使其中有難過或爭執）
   - study：工作、學習、技能、職業
   - user_room：${userLabel}的個人信息、經歷、家人、朋友、同事與人際事件（即使事件是負面的）
   - self_room：我自身的成長、認同變化與個人經歷
   - attic：僅限“當前仍明確未解決，而且核心就是矛盾、持續困惑或尚在影響的傷害/創傷”的記憶
   - windowsill：期盼、目標、未來願望
   房間判定以事件主體為先；悲傷、憤怒、爭吵、受傷或低 valence 本身都不等於閣樓。若原文沒有明確寫出“仍未解決/持續困擾”，優先放入對應的 bedroom、user_room、self_room、study 或 living_room。
7. importance 為 1-10；mood 從 happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral 中選；tags 保留具體人物/地點/事件關鍵詞。
8. 這一批可能是整份材料的中間片段。只處理本批實際出現的內容，不補寫上下文，不寫“後續未知”等佔位話。

輸出格式同樣是硬要求：
- 只輸出一個完整 JSON 數組；數組前後不得有解釋、標題、markdown 代碼圍欄或其它字符。
- 必須使用雙引號；字符串裡的雙引號、反斜槓和換行必須按 JSON 規則轉義。
- 不得有註釋、尾隨逗號或未閉合對象；不得只返回前半批內容。
- 每個記憶對象都必須含 date、content、room、importance、mood、valence、arousal、tags。

格式：
[
  {
    "date": "YYYY-MM-DD",
    "content": "完整保留細節的第一人稱記憶",
    "room": "user_room",
    "importance": 7,
    "mood": "nostalgic",
    "valence": 0.2,
    "arousal": -0.1,
    "tags": ["具體人物", "具體事件"]
  }
]

若原文沒有任何有效內容，返回 []。`;
}

/** 搬家不能使用通用 JSON 的“截斷搶救”：只接受完整、獨立、可解析的 JSON 數組。 */
export function parseCompleteExternalMemoryReply(raw: string): any[] {
    const cleaned = raw.trim();
    if (!cleaned.startsWith('[') || !cleaned.endsWith(']')) {
        throw new Error('模型沒有返回完整 JSON 數組');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        throw new Error('模型返回的 JSON 格式無效');
    }
    if (!Array.isArray(parsed)) throw new Error('模型返回結果不是 JSON 數組');
    return parsed;
}

function meaningfulCharCount(text: string): number {
    return Array.from(text).filter(char => !/\s/u.test(char)).length;
}

/**
 * 防止“格式看似正確、內容卻明顯縮水”的硬兜底。
 * 語義是否被細微改寫仍由提示詞約束；這裡拒絕可確定的大幅摘要或漏段。
 */
export function assertExternalMemoryCoverage(source: string, nodes: MemoryNode[]): void {
    const sourceChars = meaningfulCharCount(source);
    if (sourceChars === 0) return;
    const outputChars = nodes.reduce((sum, node) => sum + meaningfulCharCount(node.content), 0);
    const ratio = outputChars / sourceChars;
    if (nodes.length === 0 || ratio < EXTERNAL_MEMORY_MIN_CONTENT_RATIO) {
        throw new Error(
            `模型輸出疑似刪減或壓縮內容（僅保留約 ${Math.round(ratio * 100)}%），已拒絕寫入`,
        );
    }
}

function clampVA(value: unknown): number | undefined {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
    return Math.max(-1, Math.min(1, value));
}

function parseExternalDate(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return null;
    const normalized = raw
        .replace(/[年\/.]/g, '-')
        .replace(/月/g, '-')
        .replace(/日/g, '')
        .replace(/-+/g, '-');
    const match = normalized.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = match[2] ? Number(match[2]) : 1;
    const day = match[3] ? Number(match[3]) : (match[2] ? 15 : 1);
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (
        date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
    ) return null;
    return date.getTime();
}

/** 確認模型不只是“能解析”，而是每一項都嚴格符合搬家契約。 */
export function assertExternalMemorySchema(parsed: any[]): void {
    parsed.forEach((item, index) => {
        const label = `第 ${index + 1} 條`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${label}不是 JSON 對象`);
        }
        if (typeof item.content !== 'string' || !item.content.trim()) {
            throw new Error(`${label}缺少有效 content`);
        }
        if (item.date !== null && (typeof item.date !== 'string' || parseExternalDate(item.date) === null)) {
            throw new Error(`${label}的 date 格式無效`);
        }
        if (!VALID_ROOMS.includes(item.room as MemoryRoom)) {
            throw new Error(`${label}的 room 不在允許範圍內`);
        }
        if (typeof item.importance !== 'number' || item.importance < 1 || item.importance > 10) {
            throw new Error(`${label}的 importance 必須是 1-10 的數字`);
        }
        if (typeof item.mood !== 'string' || !VALID_MOODS.has(item.mood)) {
            throw new Error(`${label}的 mood 不在允許範圍內`);
        }
        if (typeof item.valence !== 'number' || item.valence < -1 || item.valence > 1) {
            throw new Error(`${label}的 valence 必須是 -1 到 1 的數字`);
        }
        if (typeof item.arousal !== 'number' || item.arousal < -1 || item.arousal > 1) {
            throw new Error(`${label}的 arousal 必須是 -1 到 1 的數字`);
        }
        if (!Array.isArray(item.tags) || item.tags.some((tag: unknown) => typeof tag !== 'string')) {
            throw new Error(`${label}的 tags 必須是字符串數組`);
        }
    });
}

export function parseExternalMemoryItems(
    parsed: any[],
    charId: string,
    importedAt: number = Date.now(),
    orderOffset: number = 0,
): MemoryNode[] {
    return parsed
        .filter(item => item && typeof item.content === 'string' && item.content.trim())
        .map((item, index): MemoryNode => {
            const content = item.content.trim();
            const parsedDate = parseExternalDate(item.date);
            // 無日期內容仍保持原文順序；每條錯開一分鐘，列表排序穩定。
            const createdAt = parsedDate ?? importedAt + (orderOffset + index) * 60_000;
            const room = VALID_ROOMS.includes(item.room as MemoryRoom)
                ? item.room as MemoryRoom
                : 'living_room';
            return {
                id: `mn_ext_${Date.now()}_${orderOffset + index}_${Math.random().toString(36).slice(2, 8)}`,
                charId,
                content,
                room,
                tags: Array.isArray(item.tags)
                    ? item.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean)
                    : [],
                importance: Math.max(1, Math.min(10, Math.round(Number(item.importance) || 5))),
                mood: typeof item.mood === 'string' && item.mood.trim() ? item.mood.trim() : 'neutral',
                valence: clampVA(item.valence),
                arousal: clampVA(item.arousal),
                embedded: false,
                createdAt,
                lastAccessedAt: createdAt,
                accessCount: 0,
                pinnedUntil: null,
                eventBoxId: null,
                origin: 'extraction',
            };
        });
}

/**
 * 清洗一份外部文本。這裡僅調用對話模型併產出節點，不寫數據庫；
 * 調用方可選擇寫傳統記憶，或繼續走 embedding + 建鏈。
 */
export async function extractExternalMemoryText(
    rawText: string,
    charId: string,
    charName: string,
    userName: string,
    llmConfig: LightLLMConfig,
    onProgress?: (stage: string) => void,
): Promise<ExternalMemoryExtractionResult> {
    const chunks = splitExternalMemoryText(rawText);
    const memories: MemoryNode[] = [];
    const batches: ExternalMemoryBatchResult[] = [];
    const systemPrompt = buildExternalMemoryPrompt(charName, userName);
    const importedAt = Date.now();

    for (let index = 0; index < chunks.length; index++) {
        onProgress?.(`正在清洗第 ${index + 1}/${chunks.length} 批（只整理時間，不壓縮內容）…`);
        let lastError: unknown;
        let completed = false;
        for (let attempt = 0; attempt < 2 && !completed; attempt++) {
            try {
                if (attempt > 0) {
                    onProgress?.(`第 ${index + 1}/${chunks.length} 批格式或完整性未通過，正在無損重試…`);
                }
                const data = await safeFetchJson(
                    `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${llmConfig.apiKey}`,
                        },
                        body: JSON.stringify({
                            model: llmConfig.model,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                {
                                    role: 'user',
                                    content: `${attempt > 0
                                        ? '上一次輸出未通過完整性校驗。請重新處理整批：必須輸出完整 JSON，且原文內容不得刪減、改寫或壓縮。\n\n'
                                        : ''}這是第 ${index + 1}/${chunks.length} 批外部記憶原文：\n\n${chunks[index]}`,
                                },
                            ],
                            temperature: 0.05,
                            max_tokens: 16_000,
                            stream: false,
                        }),
                    },
                    2,
                    180_000,
                    { appName: '記憶搬家', purpose: '外部記憶清洗' },
                );
                if (data.choices?.[0]?.finish_reason === 'length') {
                    throw new Error('模型輸出達到長度上限，內容可能被截斷');
                }
                const reply = data.choices?.[0]?.message?.content || '';
                const parsed = parseCompleteExternalMemoryReply(reply);
                assertExternalMemorySchema(parsed);
                const nodes = parseExternalMemoryItems(parsed, charId, importedAt, memories.length);
                assertExternalMemoryCoverage(chunks[index], nodes);
                memories.push(...nodes);
                batches.push({ index: index + 1, total: chunks.length, extracted: nodes.length, ok: true });
                completed = true;
            } catch (error) {
                lastError = error;
            }
        }
        if (!completed) {
            batches.push({
                index: index + 1,
                total: chunks.length,
                extracted: 0,
                ok: false,
                error: (lastError as any)?.message || String(lastError),
            });
            // 搬家按整次原子處理：一批失敗後不再消耗後續 API，caller 也不會寫入前面批次。
            break;
        }
    }

    return { memories, batches };
}
