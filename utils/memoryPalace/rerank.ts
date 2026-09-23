/**
 * Memory Palace — Rerank（cross-encoder 二次排序）
 *
 * 通用 /rerank 協議，兼容 SiliconFlow / Jina / Cohere / Voyage：
 *   POST {baseUrl}/rerank
 *   {
 *     "model": "BAAI/bge-reranker-v2-m3",
 *     "query": "...",
 *     "documents": ["text1", "text2", ...],
 *     "top_n": 5,
 *     "return_documents": false
 *   }
 *   → { "results": [{ "index": 3, "relevance_score": 0.95 }, ...] }
 *
 * 用途：主召回給 LLM 的是"embedding 找的最像 + 啟發式加權"的 top 15，
 *      rerank 用 cross-encoder 直接理解 (query, doc) 對的語義相關性，
 *      把 LLM 回合裡用戶真正在問的焦點記憶額外推上來幾條。
 *
 * 主召回和 rerank 的候選池不共享：pipeline 用 joined userIntent 單獨
 * 再跑一次 hybridSearch 作為 rerank 輸入池（這一輪 user 發言對應的語義空間）。
 */

import { safeFetchJson } from '../safeApi';

export interface RerankApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface RerankResult {
    /** 對應輸入 documents[] 的下標 */
    index: number;
    /** 模型給出的相關性分數，通常 0-1，但不同模型 scale 不同，只用於排序 */
    relevance_score: number;
}

/**
 * 調用 rerank API，返回 top N 的 (index, score) 列表。
 *
 * 失敗會 throw，讓調用方決定是否 warn 或降級。一般失敗原因：
 *   - API key 無效 / 餘額不足
 *   - baseUrl 寫錯或網絡不通（和 embedding 共用服務商時往往一起掛）
 *   - 模型名錯（SiliconFlow 大小寫敏感，"BAAI/bge-reranker-v2-m3"）
 */
export async function rerankDocuments(
    config: RerankApiConfig,
    query: string,
    documents: string[],
    topN: number,
): Promise<RerankResult[]> {
    if (documents.length === 0 || !query.trim()) return [];

    const url = `${config.baseUrl.replace(/\/+$/, '')}/rerank`;
    const body = {
        model: config.model,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
        return_documents: false,
    };

    const data = await safeFetchJson(
        url,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
        },
        1,      // 失敗只多試 1 次，rerank 卡住就降級
        30_000, // 30s 硬超時
    );

    // 兼容兩種返回形態：
    //   - Cohere/SiliconFlow/Jina 新版: { results: [{index, relevance_score}] }
    //   - 少數舊版可能寫成 { data: [...] }
    const rows: any[] = Array.isArray(data?.results) ? data.results
                     : Array.isArray(data?.data)    ? data.data
                     : [];

    return rows
        .filter(r => typeof r?.index === 'number')
        .map(r => ({
            index: r.index,
            relevance_score: typeof r.relevance_score === 'number' ? r.relevance_score
                          : typeof r.score === 'number'            ? r.score
                          : 0,
        }));
}
