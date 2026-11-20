/**
 * Sore 看圖（plans/ai-assistant.md 第 9 節）。兩條路，跟私聊同一個口徑：
 * - 設置裡的「識圖 API」開著：圖先交給識圖模型轉成文字，Sore 讀的是轉述（主模型看不了圖的人靠這條）
 * - 沒開：圖直接放進請求，Sore 用的那組模型自己看
 * 轉述跟著訊息存（imageNotes，跟 images 一張對一格），同一張圖只識別一次。
 */
import type { AssistantMessage, VisionApiConfig } from '../../types';
import { describeImageWithVisionApi, isVisionApiReady, type VisionDescribeOptions } from '../visionApi';

/** 給識圖模型的問法：Sore 收到的多半是手機畫面截圖或想照著做的參考圖，要的是版面、顏色、畫面上的字 */
export const SORE_VISION_PROMPT = `這張圖是用戶傳給手機助手的：多半是手機畫面的截圖（聊天介面、設定頁、桌面、小組件、報錯畫面），也可能是想照著做的參考圖。請替一個看不到圖的助手把它寫清楚，分段寫：
【畫面】這是什麼畫面，整體風格與氣氛。
【版面】由上到下有哪些區塊，各自的位置、對齊、大小比例、間距、圓角、陰影、邊框。
【顏色】背景、文字、按鈕、氣泡各是什麼顏色，盡量給接近的色碼（#RRGGBB）。
【文字】畫面上看得到的字原樣抄下來（標題、按鈕、報錯、聊天內容都要），看不清楚的寫「看不清」。
【問題】看起來壞掉或不對勁的地方：跑版、重疊、被裁掉、多出來的陰影或色塊、空白、對比太低；沒有就寫「沒看到」。
只寫看得到的，不要猜畫面外的事，不要寒暄，只輸出描述。`;

type Describe = (imageUrl: string, config: VisionApiConfig, options?: VisionDescribeOptions) => Promise<string>;

/** 這則的每張圖都有轉述了嗎 */
export const hasImageNotes = (m: Pick<AssistantMessage, 'images' | 'imageNotes'>): boolean =>
    !!m.images?.length && m.imageNotes?.length === m.images.length && m.imageNotes.every(n => !!n?.trim());

/** 轉述 → 接在訊息後面的那段字 */
export const formatImageNotes = (notes: string[]): string => [
    `（這則附了 ${notes.length} 張圖。你這邊看不到原圖，下面是識圖模型替你看的轉述，顏色和位置是估的）`,
    ...notes.map((note, i) => `【附圖 ${i + 1}】\n${note}\n【附圖 ${i + 1} 結束】`),
].join('\n');

/**
 * 識圖 API 開著時，把還沒轉述的圖補上（只補會送出去的那幾則：最近 limit 則帶圖的）。
 * 沒開就原樣回去。識圖失敗直接丟錯：開著識圖的人主模型多半看不了圖，退回直接送圖只會靜靜地看不到。
 */
export const describeSoreImages = async (
    history: AssistantMessage[],
    config: VisionApiConfig | null | undefined,
    opts: { limit: number; signal?: AbortSignal; describe?: Describe },
): Promise<{ messages: AssistantMessage[]; changed: boolean }> => {
    if (config?.enabled !== true) return { messages: history, changed: false };
    const targets = history.filter(m => m.role === 'user' && m.images?.length).slice(-opts.limit).filter(m => !hasImageNotes(m));
    if (!targets.length) return { messages: history, changed: false };
    if (!isVisionApiReady(config)) throw new Error('識圖 API 開著，但網址、Key 或模型沒填完整（設置 → API 設定 → 識圖 API）');
    const describe = opts.describe || describeImageWithVisionApi;
    const done = new Map<string, string[]>();
    for (const m of targets) {
        const notes: string[] = [];
        for (const url of m.images || []) {
            if (opts.signal?.aborted) { const err = new Error('已停下'); err.name = 'AbortError'; throw err; }
            try {
                notes.push(await describe(url, config, {
                    prompt: SORE_VISION_PROMPT, maxTokens: 2000, keepLines: true, signal: opts.signal,
                    meta: { appId: 'assistant', appName: '助手', purpose: 'Sore 識圖' },
                }));
            } catch (error: any) {
                if (error?.name === 'AbortError') throw error;
                throw new Error(`識圖沒成功：${error?.message || String(error)}`);
            }
        }
        done.set(m.id, notes);
    }
    return { messages: history.map(m => (done.has(m.id) ? { ...m, imageNotes: done.get(m.id) } : m)), changed: true };
};
