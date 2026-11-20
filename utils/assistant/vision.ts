/**
 * Sore 看圖（plans/ai-assistant.md 第 13 節）。兩條路，跟私聊同一個口徑：
 * - 設置裡的「識圖 API」開著：圖先交給識圖模型轉成文字，Sore 讀的是轉述（主模型看不了圖的人靠這條）
 * - 沒開：圖直接放進請求，Sore 用的那組模型自己看
 * 轉述跟著訊息存（imageNotes，跟 images 一張對一格），同一張圖只識別一次。
 *
 * 識圖沒成功不擋住對話：原因記在 imageNoteErrors，那一輪照樣讓 Sore 回答（它會知道哪張沒看到），
 * 之後也不會每輪自動再試（以前失敗就整輪停下、下一句又從識圖開始，卡成迴圈）；要再試由用戶按「重試」。
 */
import type { AssistantMessage, VisionApiConfig } from '../../types';
import { describeImageWithVisionApi, isVisionApiReady, type VisionDescribeOptions } from '../visionApi';
import { scrubSecret } from './client';

/** 給識圖模型的問法：Sore 收到的多半是手機畫面截圖或想照著做的參考圖，要的是版面、顏色、畫面上的字 */
export const SORE_VISION_PROMPT = `這張圖是用戶傳給手機助手的：多半是手機畫面的截圖（聊天介面、設定頁、桌面、小組件、報錯畫面），也可能是想照著做的參考圖。請替一個看不到圖的助手把它寫清楚，分段寫：
【畫面】這是什麼畫面，整體風格與氣氛。
【版面】由上到下有哪些區塊，各自的位置、對齊、大小比例、間距、圓角、陰影、邊框。
【顏色】背景、文字、按鈕、氣泡各是什麼顏色，盡量給接近的色碼（#RRGGBB）。
【文字】畫面上看得到的字原樣抄下來（標題、按鈕、報錯、聊天內容都要），看不清楚的寫「看不清」。
【問題】看起來壞掉或不對勁的地方：跑版、重疊、被裁掉、多出來的陰影或色塊、空白、對比太低；沒有就寫「沒看到」。
只寫看得到的，不要猜畫面外的事，不要寒暄，只輸出描述。`;

/** 問法細、回得長，比聊天裡的識圖慢：等久一點再算逾時 */
export const SORE_VISION_TIMEOUT_MS = 120_000;

type Describe = (imageUrl: string, config: VisionApiConfig, options?: VisionDescribeOptions) => Promise<string>;
type ImageFields = Pick<AssistantMessage, 'images' | 'imageNotes' | 'imageNoteErrors'>;

const noteAt = (m: ImageFields, i: number) => (m.imageNotes?.[i] || '').trim();
const errorAt = (m: ImageFields, i: number) => (m.imageNoteErrors?.[i] || '').trim();

/** 這則的圖都過了識圖（每張不是有轉述、就是記了沒成功的原因）：之後送文字，不送原圖，也不自動再試 */
export const imagesHandled = (m: ImageFields): boolean =>
    !!m.images?.length && m.images.every((_, i) => !!noteAt(m, i) || !!errorAt(m, i));

/** 有幾張識圖沒成功 */
export const failedImageCount = (m: ImageFields): number =>
    (m.images || []).filter((_, i) => !noteAt(m, i) && !!errorAt(m, i)).length;

/** 有沒有哪張有轉述 */
export const hasAnyImageNote = (m: ImageFields): boolean => (m.images || []).some((_, i) => !!noteAt(m, i));

/** 接在訊息後面給 Sore 的那段：有轉述的給轉述，沒成功的寫明沒看到和原因 */
export const formatImageNotes = (m: ImageFields): string => {
    const count = m.images?.length || 0;
    const failed = failedImageCount(m);
    const head = failed === count
        ? `（這則附了 ${count} 張圖，但識圖這次沒成功，圖你都沒看到。能答的先照文字答，並跟用戶說圖沒看到、可以按圖下面的「重試」）`
        : `（這則附了 ${count} 張圖。你這邊看不到原圖，下面是識圖模型替你看的轉述，顏色和位置是估的${failed ? `；其中 ${failed} 張識圖沒成功，你沒看到` : ''}）`;
    return [
        head,
        ...Array.from({ length: count }, (_, i) => (noteAt(m, i)
            ? `【附圖 ${i + 1}】\n${noteAt(m, i)}\n【附圖 ${i + 1} 結束】`
            : `【附圖 ${i + 1}】識圖沒成功（${errorAt(m, i)}），這張你沒看到。`)),
    ].join('\n');
};

const abortError = () => { const err = new Error('已停下'); err.name = 'AbortError'; return err; };

/** 錯誤 → 給人看的一句（Key 換掉）；逾時另外講清楚，不然只會看到「Fetch is aborted」 */
const reasonOf = (error: any, config: VisionApiConfig): string => {
    const raw = String(error?.message || error || '');
    if (error?.name === 'AbortError' || /abort|timeout/i.test(raw)) return `等了 ${Math.round(SORE_VISION_TIMEOUT_MS / 1000)} 秒識圖模型沒回`;
    return scrubSecret(raw || '不明原因', config.apiKey).slice(0, 160);
};

/**
 * 識圖 API 開著時，把還沒過識圖的圖補上（只補會送出去的那幾則：最近 limit 則帶圖的）。沒開就原樣回去。
 * 每張各自成敗、一起跑：成功的記轉述，沒成功的記原因，不丟錯（只有用戶按停才丟 AbortError）。
 * retryIds：這幾則裡之前沒成功的圖再試一次（用戶按「重試」）。
 */
export const describeSoreImages = async (
    history: AssistantMessage[],
    config: VisionApiConfig | null | undefined,
    opts: { limit: number; signal?: AbortSignal; describe?: Describe; retryIds?: string[] },
): Promise<{ messages: AssistantMessage[]; changed: boolean; failed: number }> => {
    if (config?.enabled !== true) return { messages: history, changed: false, failed: 0 };
    const retry = new Set(opts.retryIds || []);
    // limit 0＝只管 retryIds 那幾則（注意 slice(-0) 會拿到全部，所以分開寫）
    const recent = new Set(opts.limit > 0 ? history.filter(m => m.role === 'user' && m.images?.length).slice(-opts.limit).map(m => m.id) : []);
    const targets = history.filter(m => m.role === 'user' && m.images?.length
        && ((recent.has(m.id) && !imagesHandled(m)) || (retry.has(m.id) && failedImageCount(m) > 0)));
    if (!targets.length) return { messages: history, changed: false, failed: 0 };
    if (opts.signal?.aborted) throw abortError();

    const ready = isVisionApiReady(config);
    const describe = opts.describe || describeImageWithVisionApi;
    const done = new Map<string, { notes: string[]; errors: string[] }>();
    await Promise.all(targets.map(async m => {
        const images = m.images || [];
        const notes = images.map((_, i) => noteAt(m, i));
        const errors = images.map(() => '');
        await Promise.all(images.map(async (url, i) => {
            if (notes[i]) return;
            if (!ready) { errors[i] = '識圖 API 開著，但網址、Key 或模型沒填完整'; return; }
            try {
                notes[i] = (await describe(url, config, {
                    prompt: SORE_VISION_PROMPT, maxTokens: 2000, keepLines: true, signal: opts.signal, timeoutMs: SORE_VISION_TIMEOUT_MS,
                    meta: { appId: 'assistant', appName: '助手', purpose: 'Sore 識圖' },
                })).trim();
                if (!notes[i]) errors[i] = '識圖模型回了空白';
            } catch (error: any) {
                // 用戶按停才往外丟；逾時也是 AbortError，但那是識圖沒成功，不是用戶不要了
                if (opts.signal?.aborted) return;
                errors[i] = reasonOf(error, config);
            }
        }));
        done.set(m.id, { notes, errors });
    }));
    if (opts.signal?.aborted) throw abortError();

    let failed = 0;
    const messages = history.map(m => {
        const result = done.get(m.id);
        if (!result) return m;
        failed += result.errors.filter(Boolean).length;
        const next: AssistantMessage = { ...m, imageNotes: result.notes };
        if (result.errors.some(Boolean)) next.imageNoteErrors = result.errors; else delete next.imageNoteErrors;
        return next;
    });
    return { messages, changed: true, failed };
};

/**
 * 識圖 API 現在關著時用：整則都沒成功的（一張轉述都沒有），把記下的原因清掉，
 * 讓它回到「沒過識圖」→ 這一輪直接把原圖交給 Sore 用的模型。有轉述的不動。
 */
export const dropFailedNotes = (history: AssistantMessage[]): { messages: AssistantMessage[]; changed: boolean } => {
    let changed = false;
    const messages = history.map(m => {
        if (m.role !== 'user' || !m.images?.length || !m.imageNoteErrors?.length || hasAnyImageNote(m)) return m;
        changed = true;
        const next = { ...m };
        delete next.imageNotes;
        delete next.imageNoteErrors;
        return next;
    });
    return { messages, changed };
};
