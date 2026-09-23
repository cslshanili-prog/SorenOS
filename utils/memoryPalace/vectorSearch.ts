/**
 * Memory Palace — 向量搜索（Web Worker 加速版）
 *
 * 查詢文本 → 向量化 → 與該角色的 memory_vectors 做餘弦相似度 → 閾值過濾
 *
 * 優化：
 * 1. 使用 charId 索引直查，不再全表掃描
 * 2. Float32Array 減少內存佔用
 * 3. Web Worker 執行 cosine similarity，不阻塞主線程
 * 4. 回退：Worker 不可用時在主線程計算
 */

import type { MemoryNode, MemoryVector, RemoteVectorConfig } from './types';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { cosineSimilarity } from './embedding';
import { searchVectors as remoteSearch } from './supabaseVector';

export interface VectorSearchResult {
    node: MemoryNode;
    similarity: number;
}

// Worker 單例（懶初始化）
let worker: Worker | null = null;
let workerFailed = false;

// 遠程向量搜索會話級熔斷：一旦 Supabase RPC 拋網絡錯誤（CORS / fetch TypeError / 500
// 無 CORS 頭）就關閉整個會話的遠程路徑，避免後續每條查詢都踩一遍 CORS 然後回退本地，
// 15 次冗餘加載全量向量庫把 V8 typed-array arena 撕碎。
let remoteSearchBroken = false;

/** 把 worker 標記為壞掉並終止，確保不再被 getWorker() 拿到。 */
function markWorkerBroken(reason: string): void {
    if (workerFailed) return;
    console.warn(`[vectorSearch] disabling worker for this session: ${reason}`);
    workerFailed = true;
    if (worker) {
        try { worker.terminate(); } catch { /* ignore */ }
        worker = null;
    }
    // 同時清空等待中的 worker 請求，免得 Promise 掛死
    for (const resolve of workerPending.values()) resolve([]);
    workerPending.clear();
}

/** 供 relatedMemories 等上層快速判斷本會話是否該跳過遠程路徑。 */
export function isRemoteSearchBroken(): boolean {
    return remoteSearchBroken;
}

function markRemoteBroken(reason: string): void {
    if (remoteSearchBroken) return;
    console.warn(`[vectorSearch] disabling remote search for this session: ${reason}`);
    remoteSearchBroken = true;
}

// Worker 多路複用：以 requestId 分發響應，避免併發時後一個 onmessage
// 覆蓋前一個 handler、導致前面的 Promise 永掛。
const workerPending = new Map<number, (results: { memoryId: string; similarity: number }[]) => void>();
let nextWorkerRequestId = 1;

function attachWorkerHandlers(w: Worker): void {
    w.onmessage = (e: MessageEvent) => {
        const { requestId, results } = e.data || {};
        if (typeof requestId !== 'number') return;
        const resolve = workerPending.get(requestId);
        if (resolve) {
            workerPending.delete(requestId);
            resolve(results || []);
        }
    };
    w.onerror = () => markWorkerBroken('worker.onerror fired');
}

function getWorker(): Worker | null {
    if (workerFailed) return null;
    if (worker) return worker;
    try {
        worker = new Worker(
            new URL('./vectorSearchWorker.ts', import.meta.url),
            { type: 'module' }
        );
        attachWorkerHandlers(worker);
        return worker;
    } catch {
        workerFailed = true;
        return null;
    }
}

/**
 * 向量搜索：在指定角色的所有已向量化記憶中搜索
 *
 * @param queryVector 查詢向量（已向量化）
 * @param charId 角色 ID
 * @param threshold 相似度閾值，默認 0.3
 * @param topK 返回最多 topK 條，默認 20
 * @param remoteConfig 遠程向量存儲配置（可選，有配置時優先走遠程）
 */
export async function vectorSearch(
    queryVector: number[] | Float32Array,
    charId: string,
    threshold: number = 0.3,
    topK: number = 20,
    remoteConfig?: RemoteVectorConfig,
    /**
     * 可選：預取好的向量列表（角色全量）。
     * 同次 retrieve 內多路並行檢索時，上游預取一次傳下來避免 K 次 getAllByCharId。
     * 遠程路徑不消費這個字段。
     */
    prefetchedVectors?: MemoryVector[],
): Promise<VectorSearchResult[]> {
    // ─── 遠程路徑：Supabase pgvector ─────────────────
    // 注意：遠程 RPC 已內置 archived=false 過濾
    if (remoteConfig?.enabled && remoteConfig.initialized && !remoteSearchBroken) {
        try {
            const remoteResults = await remoteSearch(remoteConfig, queryVector, charId, threshold, topK);
            if (remoteResults.length > 0) {
                // 遠程結果已包含內容，構建輕量 MemoryNode（帶 EventBox 字段 + Russell 情感 + 置頂 + 衍生來源）
                return remoteResults.map(r => ({
                    node: {
                        id: r.memoryId,
                        charId,
                        content: r.content,
                        room: r.room as any,
                        tags: r.tags,
                        importance: r.importance,
                        mood: r.mood,
                        valence: r.valence ?? undefined,
                        arousal: r.arousal ?? undefined,
                        embedded: true,
                        createdAt: r.createdAt || Date.now(),
                        lastAccessedAt: r.lastAccessedAt || r.createdAt || Date.now(),
                        accessCount: r.accessCount || 0,
                        pinnedUntil: r.pinnedUntil,
                        sourceId: r.sourceId,
                        origin: (r.origin as any) ?? undefined,
                        eventBoxId: r.eventBoxId,
                        archived: r.archived,
                        isBoxSummary: r.isSummary,
                    },
                    similarity: r.similarity,
                }));
            }
            // 遠程正常但這次沒命中：直接返回空，不要再跑一遍本地（避免雙倍耗時）。
            return [];
        } catch (e: any) {
            // 遠程壞了（CORS / 500 無 CORS 頭 / DNS 等網絡錯）：熔斷整個會話的遠程路徑
            const msg = e?.message || String(e);
            markRemoteBroken(msg);
            // 本次查詢回退到本地
        }
    }

    // ─── 本地路徑：IndexedDB + Worker ────────────────
    const vectors = prefetchedVectors ?? await MemoryVectorDB.getAllByCharId(charId);
    if (vectors.length === 0) return [];

    // 嘗試使用 Worker 計算
    let scored: { memoryId: string; similarity: number }[];
    const w = getWorker();

    if (w) {
        // 當 vectors 來自 prefetch 時，同一份數組會被 K 路 vectorSearch 併發
        // 消費；Transfer list 會 neuter 首個調用的 buffer，後續調用讀到全 0
        // 靜默返空。這種情況下禁止把候選向量 buffer 列入 transfer list，
        // 改走 postMessage 的 structured clone（內部 memcpy）。query 向量
        // 是單路獨佔，始終可以 transfer。
        const canTransferCandidates = !prefetchedVectors;
        scored = await runInWorker(w, queryVector, vectors, threshold, topK, canTransferCandidates);
    } else {
        scored = mainThreadSearch(queryVector, vectors, threshold, topK);
    }

    // 加載對應的 MemoryNode（過濾 archived 節點）
    //
    // 性能：原來是 for-await 串行 getById，30 條候選 × 每次一個 IDB 事務
    // ≈ 300–900ms。改成 Promise.all 讓所有 get 併發入隊，瀏覽器可以在
    // 同一個事件循環內把它們調度到 IDB，主線程等待從 O(N) 降到 O(1)。
    // 順序通過 map 的 index 天然保留，過濾 archived 後仍是 similarity 降序。
    const nodes = await Promise.all(scored.map(item => MemoryNodeDB.getById(item.memoryId)));
    const results: VectorSearchResult[] = [];
    for (let i = 0; i < scored.length; i++) {
        const node = nodes[i];
        if (node && !node.archived) {
            results.push({ node, similarity: scored[i].similarity });
        }
    }

    return results;
}

/** Worker 通信 — 支持併發多路複用（用 requestId 區分響應） */
function runInWorker(
    w: Worker,
    queryVector: number[] | Float32Array | Uint8Array,
    vectors: { memoryId: string; vector: number[] | Float32Array | Uint8Array }[],
    threshold: number,
    topK: number,
    canTransferCandidates: boolean = true,
): Promise<{ memoryId: string; similarity: number }[]> {
    return new Promise((resolve) => {
        // 全部歸一到 Float32Array，準備走 transfer list 零拷貝。
        // 注意：transfer 後主線程這些 buffer 會被 neuter，所以 timeout 兜底
        // 不能再用 mainThreadSearch（會讀到全 0 buffer 靜默返空）。
        // 策略：超時時 resolve([]) 讓當次查詢退化成 BM25-only，同時把 worker
        // 標記為壞掉 —— 下一次 vectorSearch 在 getWorker() 處拿到 null，
        // 走主線程正確路徑（無 transfer，無 neuter）。這樣單次 worker 故障
        // 不會變成"永遠靜默少結果"的長期狀態。
        // ensureFloat32 兼容三種存儲形態（number[] / Float32Array / Uint8Array）。
        // 即使上游 DB 改了存儲格式也不會因為 `new Float32Array(uint8)` 把字節
        // 當成 number 誤讀出 4× 長的錯誤向量。
        const qv = ensureFloat32(queryVector);
        const fvs = vectors.map(v => ({
            memoryId: v.memoryId,
            vector: ensureFloat32(v.vector),
        }));

        const requestId = nextWorkerRequestId++;
        const timeout = setTimeout(() => {
            if (!workerPending.has(requestId)) return; // 已完成
            workerPending.delete(requestId);
            markWorkerBroken('timeout 10s — buffers neutered, cannot run mainThreadSearch on this call; subsequent calls will use main thread');
            resolve([]);
        }, 10000);

        workerPending.set(requestId, (results) => {
            clearTimeout(timeout);
            resolve(results);
        });

        // Transfer list：query 向量是本次調用獨佔的一次性 buffer，始終 transfer。
        // 候選向量僅在上游確認它們不會被併發複用時才 transfer——否則 K 路併發
        // vectorSearch 共享同一份 prefetched 向量數組時，首個 transfer 會 neuter
        // buffer 讓後續路徑讀到全 0 靜默返空。
        const transfers: Transferable[] = [qv.buffer];
        if (canTransferCandidates) {
            for (const v of fvs) transfers.push((v.vector as Float32Array).buffer);
        }
        try {
            w.postMessage({ requestId, queryVector: qv, vectors: fvs, threshold, topK }, transfers);
        } catch (e: any) {
            clearTimeout(timeout);
            workerPending.delete(requestId);
            markWorkerBroken(`postMessage failed: ${e?.message || e}`);
            resolve([]);
        }
    });
}

/** 主線程回退計算 */
function mainThreadSearch(
    queryVector: number[] | Float32Array | Uint8Array,
    vectors: { memoryId: string; vector: number[] | Float32Array | Uint8Array }[],
    threshold: number,
    topK: number,
): { memoryId: string; similarity: number }[] {
    const scored: { memoryId: string; similarity: number }[] = [];

    const qv = ensureFloat32(queryVector);
    for (const vec of vectors) {
        const sim = cosineSimilarity(qv, ensureFloat32(vec.vector));
        if (sim >= threshold) {
            scored.push({ memoryId: vec.memoryId, similarity: sim });
        }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}
