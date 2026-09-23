/**
 * Memory Palace — BM25 倒排索引
 *
 * 內存常駐、按 charId 隔離、懶構建、增量維護。
 * 不持久化到 IndexedDB —— 啟動時按需重建（10k 節點約 1-3s 一次性成本），
 * 換取零持久化漂移風險。
 *
 * 架構要點：
 *   - 索引構建：第一次查詢某 charId 時全量 tokenize
 *   - 增量更新：MemoryNodeDB.save/delete/saveMany 內部鉤子觸發
 *   - 候選過濾：在查詢時按調用方傳入的 allowedIds 過濾（自動處理
 *     archived/embedded 等節點狀態變化，不需要在 archive 翻轉時重建）
 *   - 跨 char 查找：維護 nodeId → charId 反查表，支持 delete(id) 不帶 charId
 *
 * 與 bm25Search() 的等價性：
 *   - 同一 tokenizer
 *   - 同一公式（K1, B 來自 bm25.ts）
 *   - 同一統計口徑：search() 內的 docCount / avgDl / df 全部按 allowedIds
 *     候選集計算（與樸素版傳入 nodes 的口徑一致）→ top K 與分數完全等價，
 *     可被 bm25SearchDualRun 驗證
 *
 * 已知未掛鉤的寫入路徑（v1 接受的風險）：
 *   - 備份恢復：utils/db.ts 的 clearAndAdd('memory_nodes', ...) 直接寫 IDB，
 *     不經 MemoryNodeDB → 索引會變髒。緩解：恢復後通常會刷頁面，新會話自動
 *     重建；若用戶報告異常召回，在恢復成功後顯式調 bm25Index.dropAll()
 */

import type { MemoryNode } from './types';
import { tokenize, K1, B } from './bm25';

interface DocMeta {
    length: number;
    charId: string;
    /** 內容指紋（length + 簡單 hash），用於 save 時判斷是否需要重新 tokenize */
    contentSig: number;
}

interface CharIndex {
    /** token → (nodeId → tf) 倒排表 */
    postings: Map<string, Map<string, number>>;
    /** nodeId → 文檔元信息 */
    docMeta: Map<string, DocMeta>;
    /** 總 token 數（用於 avgDl 計算） */
    totalTokens: number;
}

export interface BM25IndexedResult {
    nodeId: string;
    score: number;
}

// ─── 內容指紋 ──────────────────────────────────────────

/**
 * 廉價的字符串指紋，用於檢測 content 是否變更。
 * 不需要密碼學強度——只要變了就大概率不同就行。
 */
function contentSig(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return h ^ s.length;
}

// ─── 索引管理器（singleton） ───────────────────────────

class BM25IndexManager {
    /** charId → 該角色的倒排索引 */
    private indices = new Map<string, CharIndex>();
    /** nodeId → charId（用於 delete 時反查） */
    private nodeToChar = new Map<string, string>();

    /** 是否已為某 charId 構建索引 */
    has(charId: string): boolean {
        return this.indices.has(charId);
    }

    /**
     * 確保索引已構建。已存在則跳過；未存在則用傳入的 nodes 全量構建。
     * 調用方應傳入該 charId 的"全量節點"（含 archived / 未 embedded），
     * 不要預過濾——查詢時按候選集過濾即可。這樣 archive 翻轉無需重建。
     */
    ensureBuilt(charId: string, allNodes: MemoryNode[]): void {
        if (this.indices.has(charId)) return;
        const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
        const index: CharIndex = {
            postings: new Map(),
            docMeta: new Map(),
            totalTokens: 0,
        };
        for (const node of allNodes) {
            this.addToIndex(index, node);
            this.nodeToChar.set(node.id, charId);
        }
        this.indices.set(charId, index);
        if (t0) {
            const dt = performance.now() - t0;
            console.log(`[bm25Index] built ${charId} (${allNodes.length} nodes, ${index.postings.size} postings, ${(index.totalTokens / 1000).toFixed(1)}k tokens) in ${dt.toFixed(0)}ms`);
        }
    }

    /** 刪除某 charId 的索引（用於 wipe / 角色切換等場景） */
    drop(charId: string): void {
        const idx = this.indices.get(charId);
        if (!idx) return;
        for (const id of idx.docMeta.keys()) {
            this.nodeToChar.delete(id);
        }
        this.indices.delete(charId);
    }

    /** 清空所有索引（wipe 全量數據時用） */
    dropAll(): void {
        this.indices.clear();
        this.nodeToChar.clear();
    }

    // ─── 增量維護鉤子 ──────────────────────────────────

    /**
     * 節點寫入鉤子。
     *
     * 決策：
     *   - 索引未構建 → 直接跳過（懶構建會在首次查詢時全量掃一次，
     *     這裡不搶跑，避免 save 路徑承擔 1-3s 的代價）
     *   - 節點已存在且 contentSig 未變 → 跳過（touchAccess 等僅更新
     *     metadata 的寫入不需要重新 tokenize）
     *   - 節點已存在且 contentSig 變了 → 舊 tf 全刪，新 tf 插入
     *   - 節點不存在 → 直接插入
     */
    onNodeSaved(node: MemoryNode): void {
        const index = this.indices.get(node.charId);
        if (!index) return;

        const sig = contentSig(node.content);
        const existing = index.docMeta.get(node.id);
        if (existing && existing.contentSig === sig) return;

        if (existing) {
            this.removeFromIndex(index, node.id);
        }
        this.addToIndex(index, node);
        this.nodeToChar.set(node.id, node.charId);
    }

    /** 節點刪除鉤子（不需要 charId，內部反查） */
    onNodeDeleted(nodeId: string): void {
        const charId = this.nodeToChar.get(nodeId);
        if (!charId) return;
        const index = this.indices.get(charId);
        if (!index) return;
        this.removeFromIndex(index, nodeId);
        this.nodeToChar.delete(nodeId);
    }

    /** 批量寫入鉤子（按 charId 分組後逐一更新對應索引） */
    onNodesSaved(nodes: MemoryNode[]): void {
        for (const node of nodes) this.onNodeSaved(node);
    }

    // ─── 內部：索引讀寫 ────────────────────────────────

    private addToIndex(index: CharIndex, node: MemoryNode): void {
        const tokens = tokenize(node.content);
        const length = tokens.length;
        if (length === 0) {
            // 仍然記錄 docMeta，避免反覆嘗試 tokenize 空內容；不進 postings
            index.docMeta.set(node.id, {
                length: 0,
                charId: node.charId,
                contentSig: contentSig(node.content),
            });
            return;
        }

        // 累計 tf
        const tfMap = new Map<string, number>();
        for (const t of tokens) {
            tfMap.set(t, (tfMap.get(t) || 0) + 1);
        }

        for (const [token, tf] of tfMap) {
            let bucket = index.postings.get(token);
            if (!bucket) {
                bucket = new Map();
                index.postings.set(token, bucket);
            }
            bucket.set(node.id, tf);
        }

        index.docMeta.set(node.id, {
            length,
            charId: node.charId,
            contentSig: contentSig(node.content),
        });
        index.totalTokens += length;
    }

    private removeFromIndex(index: CharIndex, nodeId: string): void {
        const meta = index.docMeta.get(nodeId);
        if (!meta) return;

        // 掃一遍 postings 把含 nodeId 的桶裡抹掉。
        // 這裡沒有 doc→tokens 的反向表（避免雙倍內存），所以是 O(unique tokens)
        // 而非 O(doc length)；對中文 2-gram，差距不大。
        // 優化：只遍歷該文檔實際包含的 token —— 但需要重新 tokenize 一次內容。
        // 取捨：假設內容已被外部修改過，重新 tokenize 不一定還原原始 token 集。
        // 因此保險走全 postings 掃描。後續若成為瓶頸，再加 doc→tokens 反向表。
        for (const [token, bucket] of index.postings) {
            if (bucket.delete(nodeId) && bucket.size === 0) {
                index.postings.delete(token);
            }
        }

        index.totalTokens -= meta.length;
        index.docMeta.delete(nodeId);
    }

    // ─── 查詢 ──────────────────────────────────────────

    /**
     * 在某 charId 的索引上做 BM25 查詢。
     *
     * 統計口徑：docCount / avgDl / df 全部按 allowedIds 候選集計算，
     * 與樸素 bm25Search(query, candidates) 的口徑一致 —— 這樣切到倒排
     * 版後排序與分數完全等價（驗證：bm25SearchDualRun）。
     *
     * @param charId  角色 ID
     * @param queryTokens  已分詞的查詢 token
     * @param allowedIds  候選 ID 集（必須傳，對應樸素版的 nodes 參數）
     * @returns 排序後的 (nodeId, score) 列表（不截斷 topK，由調用方處理）
     */
    search(
        charId: string,
        queryTokens: string[],
        allowedIds: Set<string>,
    ): BM25IndexedResult[] {
        const index = this.indices.get(charId);
        if (!index || queryTokens.length === 0 || allowedIds.size === 0) return [];

        // 候選集統計：docCount = 候選集大小，avgDl = 候選集平均長度
        // 注意：樸素版用 nodes.length 當 docCount，無論 dl 是否為 0；
        // avgDl 也用 reduce 求和 / nodes.length（含 dl=0 節點）。這裡照搬。
        let totalLen = 0;
        const docCount = allowedIds.size;
        for (const id of allowedIds) {
            const meta = index.docMeta.get(id);
            if (meta) totalLen += meta.length;
        }
        const avgDl = totalLen / docCount;
        if (avgDl === 0) return [];

        // 去重 query token，按候選集算 df → IDF
        const uniqueQTokens = Array.from(new Set(queryTokens));
        const idf = new Map<string, number>();
        for (const qt of uniqueQTokens) {
            const bucket = index.postings.get(qt);
            let df = 0;
            if (bucket) {
                // 只數候選集內的命中
                if (bucket.size <= allowedIds.size) {
                    for (const id of bucket.keys()) {
                        if (allowedIds.has(id)) df++;
                    }
                } else {
                    // 候選集小很多時反向迭代更快
                    for (const id of allowedIds) {
                        if (bucket.has(id)) df++;
                    }
                }
            }
            // BM25 IDF：與 bm25.ts 的公式逐字符一致
            idf.set(qt, Math.log((docCount - df + 0.5) / (df + 0.5) + 1));
        }

        // 評分：僅遍歷命中文檔（與原實現的 score>0 過濾等價）
        const scores = new Map<string, number>();
        for (const qt of uniqueQTokens) {
            const bucket = index.postings.get(qt);
            if (!bucket) continue;
            const idfQ = idf.get(qt)!;

            for (const [nodeId, tf] of bucket) {
                if (!allowedIds.has(nodeId)) continue;
                const meta = index.docMeta.get(nodeId);
                if (!meta || meta.length === 0) continue;  // 樸素版 dl===0 時 continue

                const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * meta.length / avgDl));
                const contrib = idfQ * tfNorm;
                scores.set(nodeId, (scores.get(nodeId) || 0) + contrib);
            }
        }

        const results: BM25IndexedResult[] = [];
        for (const [nodeId, score] of scores) {
            if (score > 0) results.push({ nodeId, score });
        }
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    // ─── 調試/校驗 ─────────────────────────────────────

    stats(charId: string): { docCount: number; postings: number; totalTokens: number } | null {
        const idx = this.indices.get(charId);
        if (!idx) return null;
        return {
            docCount: idx.docMeta.size,
            postings: idx.postings.size,
            totalTokens: idx.totalTokens,
        };
    }
}

export const bm25Index = new BM25IndexManager();
