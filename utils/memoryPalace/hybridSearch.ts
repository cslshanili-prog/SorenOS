/**
 * Memory Palace — 混合搜索 + 房間評分
 *
 * 85% 向量 + 15% BM25 融合，然後按房間特性調整評分。
 */

import type { EmbeddingConfig, MemoryNode, MemoryRoom, MemoryVector, ScoredMemory, RemoteVectorConfig } from './types';
import { MemoryNodeDB } from './db';
import { getEmbedding } from './embedding';
import { vectorSearch } from './vectorSearch';
import { bm25Search, bm25SearchIndexed, bm25SearchDualRun } from './bm25';
import { bm25Index } from './bm25Index';
import { calculateEffectiveImportance } from './consolidation';

// ─── BM25 灰度開關 ────────────────────────────────────
//
// localStorage 'bm25_mode'：
//   未設置 / 'naive'  → 樸素全量掃描（默認，行為與改造前一致）
//   'indexed'         → 倒排索引版（O(Q×postings)，需 ensureBuilt）
//   'dual'            → 雙跑校驗：跑兩版對比 top K，返回樸素版結果
//
// 灰度路徑：默認 naive → 開發/灰度 dual → 驗證無 mismatch 切 indexed →
// 一兩個版本週期後刪除樸素版。
type BM25Mode = 'naive' | 'indexed' | 'dual';
function getBM25Mode(): BM25Mode {
    try {
        const v = localStorage.getItem('bm25_mode');
        if (v === 'indexed' || v === 'dual') return v;
    } catch { /* SSR / 隱私模式 */ }
    return 'naive';
}

// ─── 房間評分權重 ─────────────────────────────────────

interface RoomWeights {
    similarity: number;
    recency: number;
    importance: number;
}

const ROOM_WEIGHTS: Record<MemoryRoom, RoomWeights> = {
    living_room: { similarity: 0.50, recency: 0.30, importance: 0.20 },
    bedroom:     { similarity: 0.60, recency: 0.10, importance: 0.30 },
    study:       { similarity: 0.55, recency: 0.15, importance: 0.30 },
    user_room:   { similarity: 0.55, recency: 0.15, importance: 0.30 },
    self_room:   { similarity: 0.55, recency: 0.15, importance: 0.30 },
    attic:       { similarity: 0.70, recency: 0.00, importance: 0.30 },
    windowsill:  { similarity: 0.55, recency: 0.15, importance: 0.30 },
};

const VECTOR_WEIGHT = 0.85;
const BM25_WEIGHT = 0.15;
const RECENCY_DECAY = 0.999; // per hour

// ─── 熟悉度加成（accessCount）──────────────────────
//
// 設計原則：AI 不該像人一樣自然遺忘（遺忘在產品裡是 bug），
// 所以 accessCount 不用來"保護記憶不衰減"，而是用來給常被想起的
// 話題一個輕度浮現加成——越熟的話題越容易被想起來。
//
// 公式：familiarity = min(1, (max(0, accessCount - 1))^0.3 / 4)
//   - count=0/1 (從未被檢索到) → 0
//   - count=3  →  0.31
//   - count=10 →  0.48
//   - count=100 → 1.0（封頂）
//
// 最終加成：finalScore += FAMILIARITY_WEIGHT * familiarity
// 權重 0.05 —— 足夠讓熟悉話題冒頭，不會壓過 similarity / importance。
const FAMILIARITY_WEIGHT = 0.05;

function familiarityBonus(accessCount: number): number {
    const n = Math.max(0, (accessCount || 0) - 1);
    if (n === 0) return 0;
    return Math.min(1, Math.pow(n, 0.3) / 4);
}

// ─── 混合搜索 ─────────────────────────────────────────

/**
 * 同次 retrieve 內 K 路 hybridSearch 共享的預取數據。
 * 由 pipeline 在發起並行搜索前一次性取好，避免 K 倍的
 * Embedding API 調用和 K 倍的全量 IDB 掃表。
 */
export interface HybridSearchPrefetch {
    /** 已經向量化好的 query — 跳過本路的 getEmbedding 調用 */
    queryVector?: Float32Array;
    /** 角色全量 MemoryNode（含 archived / 未 embedded，由 hybridSearch 內部過濾） */
    allNodes?: MemoryNode[];
    /** 角色全量 MemoryVector；僅用於本地向量路徑，遠程路徑不消費 */
    allVectors?: MemoryVector[];
}

/**
 * 混合搜索：向量 + BM25 + 房間評分
 *
 * @param query 查詢文本（通常為最近 3 條消息拼接）
 * @param charId 角色 ID
 * @param embeddingConfig Embedding 配置
 * @param topK 最終返回數量
 */
export async function hybridSearch(
    query: string,
    charId: string,
    embeddingConfig: EmbeddingConfig,
    topK: number = 15,
    remoteVectorConfig?: RemoteVectorConfig,
    prefetch?: HybridSearchPrefetch,
): Promise<ScoredMemory[]> {
    // 1. 向量化查詢（優先用 pipeline 預取好的，省掉 K 次 API 調用）
    const queryVector = prefetch?.queryVector ?? await getEmbedding(query, embeddingConfig);

    // 2. 向量搜索（遠程優先，本地兜底）
    //
    // 歷史教訓：曾經把這個候選池從 30 擴到 60 試圖放大同主題召回廣度，
    // 結果反而變差——sim 0.35-0.45 的"泛情感高 imp"記憶被放進來，
    // 在房間評分（sim 權重 55%、imp/recency 合計 45%）裡憑藉 imp 和
    // recency 反超了 sim 更精準但 imp_eff 偏低的話題目標記憶（如"外公"
    // 落在 study 房間，imp 衰減過）。
    // 結論：候選池不應作為召回廣度的旋鈕。精準度靠 per-message 多路搜
    // + imp floor 在 pipeline 層解決，候選池 30 已足夠。
    const vectorResults = await vectorSearch(queryVector, charId, 0.3, 30, remoteVectorConfig, prefetch?.allVectors);

    // 3. BM25 搜索（排除 archived 節點 —— 它們已被壓入 EventBox summary）
    const allNodes = prefetch?.allNodes ?? await MemoryNodeDB.getByCharId(charId);
    const searchableNodes = allNodes.filter(n => n.embedded && !n.archived);

    // 倒排索引按"全量節點"構建（含 archived / 未 embedded），unarchive 後立即可搜，
    // 實際過濾交給 bm25SearchIndexed 用 searchableNodes 的 id 集做白名單。
    // ensureBuilt 已存在則秒返。
    const bm25Mode = getBM25Mode();
    if (bm25Mode !== 'naive') {
        bm25Index.ensureBuilt(charId, allNodes);
    }
    const bm25Results =
        bm25Mode === 'indexed' ? bm25SearchIndexed(query, searchableNodes, 30) :
        bm25Mode === 'dual'    ? bm25SearchDualRun(query, searchableNodes, 30) :
                                 bm25Search(query, searchableNodes, 30);

    // 3b. 本地節點索引：用於將雲端返回的輕量 node 補全為完整 node
    //     （allNodes 已在內存中，零額外開銷）
    const localNodeMap = new Map(allNodes.map(n => [n.id, n]));

    // 4. 融合：構建 nodeId → scores 映射
    const scoreMap = new Map<string, {
        node: MemoryNode;
        vectorSim: number;
        bm25Score: number;
    }>();

    // 歸一化 BM25 分數到 0-1
    const maxBm25 = bm25Results.length > 0 ? bm25Results[0].score : 1;

    for (const vr of vectorResults) {
        // 優先使用本地完整 node（含 eventBoxId / archived 等最新狀態）
        const fullNode = localNodeMap.get(vr.node.id) || vr.node;
        // 二次保險：本地態顯示 archived → 跳過（遠程剛被 archive 但 RPC 未及時反映的情況）
        if (fullNode.archived) continue;
        scoreMap.set(vr.node.id, {
            node: fullNode,
            vectorSim: vr.similarity,
            bm25Score: 0,
        });
    }

    for (const br of bm25Results) {
        const normalized = maxBm25 > 0 ? br.score / maxBm25 : 0;
        const existing = scoreMap.get(br.node.id);
        if (existing) {
            existing.bm25Score = normalized;
        } else {
            scoreMap.set(br.node.id, {
                node: br.node,
                vectorSim: 0,
                bm25Score: normalized,
            });
        }
    }

    // 5. 計算混合分數 + 房間評分
    const now = Date.now();
    const results: ScoredMemory[] = [];

    for (const [, entry] of scoreMap) {
        const { node, vectorSim, bm25Score } = entry;

        // 混合相似度
        const hybridSim = VECTOR_WEIGHT * vectorSim + BM25_WEIGHT * bm25Score;

        // 新近度（指數衰減）
        const hoursAgo = (now - node.lastAccessedAt) / (1000 * 60 * 60);
        const recency = Math.pow(RECENCY_DECAY, hoursAgo);

        // 有效重要性（歸一化到 0-1）
        const effectiveImp = calculateEffectiveImportance(node, now) / 10;

        // 房間權重
        const weights = ROOM_WEIGHTS[node.room];

        // 老記憶 recency 回收（所有有 recency 權重的房間）：
        //   recency = RECENCY_DECAY^hoursAgo，約 100 天后會降到 0.1 以下，再往後
        //   這個信號對排序幾乎無貢獻。但房間權重裡 recency 份額沒歸零（living_room 0.30、
        //   study/user_room/self_room/windowsill 0.15、bedroom 0.10），這部分權重
        //   等於白送——同一條記憶 sim/imp 再高也被少算一截。
        //
        //   規則：任意房間 recency < 0.1 時，把 recency 的權重平均分配給 similarity
        //   和 importance（各 +weights.recency/2），recency 權重歸零。這條規則對 attic
        //   天然無影響（它 recency 權重本來就是 0），對其它房間等於"舊記憶時把白送的
        //   權重還給 sim/imp"，讓舊而精準的記憶不被衰減吃掉。
        let simW = weights.similarity;
        let recW = weights.recency;
        let impW = weights.importance;
        if (weights.recency > 0 && recency < 0.1) {
            const redistribute = weights.recency / 2;
            simW += redistribute;
            impW += redistribute;
            recW = 0;
        }

        const baseScore = simW * hybridSim + recW * recency + impW * effectiveImp;

        // 熟悉度加成（輕權重，防止常聊話題沉底）
        const familiarity = familiarityBonus(node.accessCount);
        const roomScore = baseScore + FAMILIARITY_WEIGHT * familiarity;

        results.push({
            node,
            finalScore: roomScore,
            similarity: vectorSim,
            bm25Score,
            roomScore,
        });
    }

    // 6. 按 finalScore 降序
    results.sort((a, b) => b.finalScore - a.finalScore);

    return results.slice(0, topK);
}
