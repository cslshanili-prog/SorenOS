/**
 * Memory Palace — BM25 搜索
 *
 * 關鍵詞精確匹配，補償向量搜索對專有名詞的弱點。
 * 中文 2-gram 分詞 + 英文空格分詞 + TF-IDF 評分。
 * 純前端計算，無需外部服務。
 */

import type { MemoryNode } from './types';
import { bm25Index } from './bm25Index';

// BM25 參數
export const K1 = 1.2;
export const B = 0.75;

// ─── 分詞 ──────────────────────────────────────────────

/**
 * 中文 2-gram + 英文按空格分詞
 *
 * 示例：
 * "小明去了北京" → ["小明", "明去", "去了", "了北", "北京"]
 * "hello world" → ["hello", "world"]
 * "小明說hello" → ["小明", "明說", "hello"]
 */
export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    // 先按非中文字符分割，提取英文 token
    const parts = text.split(/([a-zA-Z0-9]+)/);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        if (/^[a-zA-Z0-9]+$/.test(trimmed)) {
            // 英文/數字：整詞
            tokens.push(trimmed.toLowerCase());
        } else {
            // 中文：2-gram
            const cleaned = trimmed.replace(/[\s\p{P}]/gu, ''); // 去掉標點和空白
            for (let i = 0; i < cleaned.length - 1; i++) {
                tokens.push(cleaned.slice(i, i + 2));
            }
            // 如果只有 1 個字，也加入
            if (cleaned.length === 1) {
                tokens.push(cleaned);
            }
        }
    }

    return tokens;
}

// ─── BM25 搜索引擎 ────────────────────────────────────

interface BM25Result {
    node: MemoryNode;
    score: number;
}

/**
 * BM25 搜索
 *
 * @param query 搜索查詢文本
 * @param nodes 候選記憶節點
 * @param topK 返回最多 topK 條
 */
export function bm25Search(
    query: string,
    nodes: MemoryNode[],
    topK: number = 20,
): BM25Result[] {
    if (nodes.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;

    // 預處理：為每個文檔建立 token 頻率表
    const docTokens: string[][] = nodes.map(n => tokenize(n.content));

    // 計算平均文檔長度
    const avgDl = docTokens.reduce((sum, t) => sum + t.length, 0) / docTokens.length;

    // 構建 IDF（Inverse Document Frequency）
    const docCount = nodes.length;
    const idf: Record<string, number> = {};

    for (const qt of queryTokens) {
        if (idf[qt] !== undefined) continue;
        // 包含該 token 的文檔數
        const df = docTokens.filter(dt => dt.includes(qt)).length;
        // BM25 IDF 公式
        idf[qt] = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    }

    // 計算每個文檔的 BM25 分數
    const results: BM25Result[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const dl = docTokens[i].length;
        if (dl === 0) continue;

        let score = 0;

        // 構建該文檔的 token 頻率表
        const tf: Record<string, number> = {};
        for (const t of docTokens[i]) {
            tf[t] = (tf[t] || 0) + 1;
        }

        for (const qt of queryTokens) {
            const termFreq = tf[qt] || 0;
            if (termFreq === 0) continue;

            const tfNorm = (termFreq * (K1 + 1)) / (termFreq + K1 * (1 - B + B * dl / avgDl));
            score += (idf[qt] || 0) * tfNorm;
        }

        if (score > 0) {
            results.push({ node: nodes[i], score });
        }
    }

    // 按分數降序
    results.sort((a, b) => b.score - a.score);

    if (t0 && nodes.length >= 500) {
        const dt = performance.now() - t0;
        console.log(`[bm25:naive] ${nodes.length} nodes / ${queryTokens.length} qtokens → ${dt.toFixed(1)}ms`);
    }

    return results.slice(0, topK);
}

// ─── 倒排索引版（行為等價，複雜度從 O(Q×N×L) 降到 O(Q×postings)） ──

/**
 * BM25 搜索 —— 倒排索引版
 *
 * 與 bm25Search() 行為等價（同 tokenizer / 公式 / IDF / 候選集），
 * 但避免對全量節點重新分詞。索引由 bm25Index 模塊在 MemoryNodeDB
 * 寫入路徑中增量維護，首次查詢某 charId 時按需全量構建。
 *
 * 候選過濾策略：把傳入的 nodes 當作"白名單"，索引中超出此集合的
 * 節點（如 archived / 未 embedded）被排除。這樣 archive 翻轉無需
 * 觸發索引重建。
 */
export function bm25SearchIndexed(
    query: string,
    nodes: MemoryNode[],
    topK: number = 20,
): BM25Result[] {
    if (nodes.length === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const charId = nodes[0].charId;
    // 索引必須已由調用方通過 bm25Index.ensureBuilt(charId, allNodes) 構建好
    // （allNodes 含 archived/未 embedded 節點，保證 unarchive 後能搜到）。
    // 這裡若未命中只能退化為按候選集構建，會丟 unarchive 節點 —— 打 warn 暴露問題。
    if (!bm25Index.has(charId)) {
        console.warn('[bm25:indexed] index not built for', charId, '— building from filtered candidates (may miss unarchived nodes). Caller should ensureBuilt() with full charId nodes.');
        bm25Index.ensureBuilt(charId, nodes);
    }

    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;

    const allowed = new Set(nodes.map(n => n.id));
    const raw = bm25Index.search(charId, queryTokens, allowed);

    // 重建 (node, score) 並用與樸素版一致的 tie-break：
    // 樸素版結果保留 nodes[i] 輸入順序，sort 是穩定的 → 同分時按 i 升序。
    // 這裡給每個 raw 命中綁上對應 nodes[] 的下標，二級排序鍵。
    const nodeIndexMap = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) nodeIndexMap.set(nodes[i].id, i);

    const enriched = raw.map(r => ({
        node: nodes[nodeIndexMap.get(r.nodeId)!],
        score: r.score,
        idx: nodeIndexMap.get(r.nodeId)!,
    }));
    enriched.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const results: BM25Result[] = enriched.slice(0, topK).map(e => ({ node: e.node, score: e.score }));

    if (t0 && nodes.length >= 500) {
        const dt = performance.now() - t0;
        console.log(`[bm25:indexed] ${nodes.length} candidates / ${queryTokens.length} qtokens → ${dt.toFixed(1)}ms`);
    }

    return results;
}

/**
 * 雙跑校驗：同時調用樸素版與倒排版，對比 top K 是否一致。
 * 不一致時打警告（含差異詳情），返回值始終是樸素版結果（保證灰度期行為不變）。
 */
export function bm25SearchDualRun(
    query: string,
    nodes: MemoryNode[],
    topK: number = 20,
): BM25Result[] {
    const naive = bm25Search(query, nodes, topK);
    const indexed = bm25SearchIndexed(query, nodes, topK);

    // 比較 top K 的 nodeId 序列與分數（容許浮點 1e-6 誤差）
    const len = Math.min(naive.length, indexed.length);
    let mismatch = false;
    if (naive.length !== indexed.length) mismatch = true;
    for (let i = 0; i < len && !mismatch; i++) {
        if (naive[i].node.id !== indexed[i].node.id) { mismatch = true; break; }
        if (Math.abs(naive[i].score - indexed[i].score) > 1e-6) { mismatch = true; break; }
    }

    if (mismatch) {
        console.warn('[bm25:dual-run] mismatch detected', {
            query: query.slice(0, 50),
            nodeCount: nodes.length,
            naiveTop: naive.slice(0, 5).map(r => ({ id: r.node.id, s: r.score.toFixed(4) })),
            indexedTop: indexed.slice(0, 5).map(r => ({ id: r.node.id, s: r.score.toFixed(4) })),
        });
    }

    return naive;
}
