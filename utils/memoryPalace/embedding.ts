/**
 * Memory Palace — Embedding 服務
 *
 * 調用 OpenAI 兼容的 Embedding API，將文本轉為向量。
 * 支持硅基流動 / 阿里雲 / 字節等端點。
 */

import type { EmbeddingConfig } from './types';

// ─── 核心 API 調用 ────────────────────────────────────

/**
 * 單條文本向量化 — 返回 Float32Array 節省內存
 */
export async function getEmbedding(text: string, config: EmbeddingConfig): Promise<Float32Array> {
    const results = await getEmbeddings([text], config);
    return results[0];
}

/**
 * 批量文本向量化（一次最多 10 條，超出自動分批）
 * 返回 Float32Array[] — 比 number[][] 節省約 50% 內存
 */
export async function getEmbeddings(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // DashScope（Qwen 官端）的 text-embedding-v3/v4、Qwen3-Embedding 單次 batch
    // 硬上限是 10 條，超過直接 400 InvalidParameter。取 10 作為通用安全值：
    // 硅基流動等 bge 系列用 10 也照常工作，純按 token 計費不受影響。
    const BATCH_SIZE = 10;
    // 單條防線：bge-m3 等模型單條輸入上限 8192 token，服務端不截斷、超出
    // 直接 400（硅基流動 code 20015 "The parameter is invalid"）。中文最壞
    // ≈ 1 token/字，4000 字符留足餘量。正常聊天/記憶內容遠短於此，只有
    // base64 / 超長文檔這類異常輸入會被截。
    const MAX_ITEM_CHARS = 4000;
    // 批量防線：部分服務商按「整個請求的 token 總量」校驗——每條都合法、
    // 合批後加起來超限照樣 400（單條「測試連接」正常而檢索批量報錯的來源
    // 之一）。按批內字符預算切批兜住最壞情況；正常聊天 query 都很短，
    // 一般仍是 1~2 批，行為不變。
    const BATCH_CHAR_BUDGET = 6000;
    // 多批並行發送，避免拆批後變成串行多往返拖慢檢索（尤其硅基用戶本來一次
    // 就發完）。但限制併發數，防止「重建全部記憶」(上百批) 一次性轟出去觸發
    // 服務商限流 / 429。檢索通常就 1~2 批 → 全並行 ≈ 1 個往返。
    const MAX_CONCURRENCY = 5;

    const truncatedNotes: string[] = [];
    const safeTexts = texts.map((t, i) => {
        if (t.length <= MAX_ITEM_CHARS) return t;
        truncatedNotes.push(`第${i + 1}條(${t.length}字, 開頭"${t.slice(0, 30).replace(/\n/g, ' ')}")`);
        return t.slice(0, MAX_ITEM_CHARS);
    });
    // 正常聊天 query（≤2000 字）和記憶內容（LLM 總結, 幾百字）都夠不著這條線，
    // 觸發說明有異常超長輸入混了進來。走 console.error——設置裡的日誌面板只
    // 捕獲 error 通道，保證用戶能看到"發生了截斷、截的是哪條"。
    if (truncatedNotes.length > 0) {
        console.error(
            `⚠️ [Embedding] ${truncatedNotes.length} 條輸入超 ${MAX_ITEM_CHARS} 字上限，已截斷出向量（內容本體不受影響，僅按前 ${MAX_ITEM_CHARS} 字建索引）：${truncatedNotes.join('；')}`,
        );
    }

    // 先按順序切塊：條數 ≤ BATCH_SIZE 且批內字符總量 ≤ BATCH_CHAR_BUDGET
    // （順序很重要：調用方按下標取向量）。單條超預算時獨佔一批。
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentChars = 0;
    for (const t of safeTexts) {
        if (currentChunk.length > 0
            && (currentChunk.length >= BATCH_SIZE || currentChars + t.length > BATCH_CHAR_BUDGET)) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChars = 0;
        }
        currentChunk.push(t);
        currentChars += t.length;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const results: Float32Array[] = [];
    // 每次並行跑 MAX_CONCURRENCY 個塊；塊間順序、塊內順序都嚴格保持
    for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
        const window = chunks.slice(i, i + MAX_CONCURRENCY);
        const windowResults = await Promise.all(
            window.map(chunk => callEmbeddingAPI(chunk, config)),
        );
        // Promise.all 保序：windowResults[j] 對應 window[j]，按序展開
        for (const batchResult of windowResults) {
            results.push(...batchResult.map(v => new Float32Array(v)));
        }
    }

    return results;
}

/**
 * 該模型是否支持自定義 `dimensions` 參數。
 *
 * 硅基流動文檔明確：`dimensions` 僅 Qwen/Qwen3-Embedding 系列支持。
 * bge 系列（bge-m3、bge-large 等）輸出維度固定，傳入 `dimensions` 會被
 * 服務端拒絕（2026-06 起返回 500）。這裡只給支持的模型帶上該參數。
 */
function modelSupportsDimensions(model: string): boolean {
    return /qwen3?-?embedding/i.test(model);
}

/**
 * 實際調用 Embedding API
 */
async function callEmbeddingAPI(
    input: string[], config: EmbeddingConfig, retryCount: number = 0
): Promise<number[][]> {
    // 自動修正常見 URL 錯誤
    let baseUrl = config.baseUrl.replace(/\/+$/, '');
    baseUrl = baseUrl.replace('ai.siliconflow.cn', 'api.siliconflow.cn');
    const url = `${baseUrl}/embeddings`;

    const body: Record<string, unknown> = {
        model: config.model,
        input,
        encoding_format: 'float',
    };
    // 僅在模型支持時才發送 dimensions，否則 bge 等固定維度模型會報 500
    if (modelSupportsDimensions(config.model) && config.dimensions) {
        body.dimensions = config.dimensions;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            // 完整響應 + 請求形狀落日誌（設置裡的日誌面板抓 console.error）——
            // 400 類排查全靠這條：能看出是哪一批、每條多長
            console.error(
                `❌ [Embedding] API ${response.status} (model=${config.model}, batch=${input.length} 條, 各條字符數=[${input.map(s => s.length).join(', ')}])`,
                errorText,
            );
            const err = new Error(`Embedding API error ${response.status}: ${errorText}`) as Error & { status?: number };
            err.status = response.status;
            throw err;
        }

        const data = await response.json();

        if (!data.data || !Array.isArray(data.data)) {
            throw new Error(`Embedding API returned unexpected format: ${JSON.stringify(data).slice(0, 200)}`);
        }

        // OpenAI 格式: data[].embedding[]
        // 按 index 排序確保順序正確
        const sorted = [...data.data].sort((a: any, b: any) => a.index - b.index);
        return sorted.map((item: any) => item.embedding as number[]);

    } catch (err: any) {
        const status: number | undefined = err?.status;
        // 參數類 4xx 重試同樣的請求不會變好；網絡錯誤 / 5xx / 429 才值得重試一次
        const retryable = status === undefined || status >= 500 || status === 429;
        if (retryable && retryCount < 1) {
            console.warn(`⚡ [Embedding] Retry after error: ${err.message}`);
            await new Promise(r => setTimeout(r, 1000));
            return callEmbeddingAPI(input, config, retryCount + 1);
        }
        // 批量被 400 拒 → 自動降級為逐條向量化：一來繞開「批內 token 總量
        // 超限」類校驗（每條單獨發就合法），二來能精確定位壞輸入是哪條。
        if (status === 400 && input.length > 1) {
            console.warn(`⚡ [Embedding] 批量 ${input.length} 條被 400 拒，自動降級為逐條向量化`);
            const results: number[][] = [];
            for (let i = 0; i < input.length; i++) {
                try {
                    // retryCount=1：單條失敗不再重試/再降級，直接進 catch 定位
                    const single = await callEmbeddingAPI([input[i]], config, 1);
                    results.push(single[0]);
                } catch (itemErr: any) {
                    const preview = input[i].slice(0, 80).replace(/\n/g, ' ');
                    throw new Error(
                        `Embedding 逐條降級後第 ${i + 1}/${input.length} 條仍失敗（${input[i].length} 字，開頭："${preview}"）: ${itemErr.message}`,
                    );
                }
            }
            // 降級成功也走 error 通道昭告一聲：日誌面板裡緊挨著上面那條 400，
            // 用戶才知道"報了 400 但已自動恢復、結果完整"，不然只看到 400 會
            // 以為這輪記憶丟了。頻繁出現則說明有異常輸入或服務商校驗變嚴。
            console.error(
                `⚠️ [Embedding] 上面的批量 400 已自動降級為逐條向量化並全部成功，本次結果完整無缺。若頻繁出現，請把日誌裡 400 那條的完整響應反饋給開發者`,
            );
            return results;
        }
        throw err;
    }
}

// ─── 數學工具 ──────────────────────────────────────────

/**
 * 餘弦相似度（Float32Array 優化版）
 *
 * 支持 number[] 和 Float32Array 混合輸入。
 * 使用 Float32Array 時內存訪問連續，V8 可以利用 SIMD 加速，
 * 在 1024 維向量上比普通 number[] 快 3-5x。
 *
 * 返回值範圍 [-1, 1]，越接近 1 越相似
 */
export function cosineSimilarity(
    a: number[] | Float32Array,
    b: number[] | Float32Array,
): number {
    const len = a.length;
    if (len !== b.length) {
        throw new Error(`Vector dimension mismatch: ${len} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // 4x 循環展開 — 減少分支預測開銷，配合連續內存佈局顯著提速
    const limit = len - (len % 4);
    let i = 0;
    for (; i < limit; i += 4) {
        const a0 = a[i], a1 = a[i+1], a2 = a[i+2], a3 = a[i+3];
        const b0 = b[i], b1 = b[i+1], b2 = b[i+2], b3 = b[i+3];
        dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3;
        normA += a0*a0 + a1*a1 + a2*a2 + a3*a3;
        normB += b0*b0 + b1*b1 + b2*b2 + b3*b3;
    }
    // 處理餘數
    for (; i < len; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
}
