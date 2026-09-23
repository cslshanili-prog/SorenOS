/**
 * Memory Palace — 向量化 + 存儲 + 去重
 *
 * 將提取出的 MemoryNode 批量向量化，
 * 與已有向量做去重（餘弦 > 0.9 跳過），
 * 然後存入 memory_nodes 和 memory_vectors。
 */

import type { EmbeddingConfig, MemoryNode, MemoryVector, RemoteVectorConfig } from './types';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { getEmbeddings, cosineSimilarity } from './embedding';
import { upsertVector as remoteUpsert } from './supabaseVector';

const DEDUP_THRESHOLD = 0.9;

/**
 * 向量化並存儲記憶節點
 *
 * 流程：
 * 1. 批量向量化 nodes 的 content
 * 2. 與已有向量做去重（cosine > 0.9 的跳過）
 * 3. 保存 MemoryNode (embedded=true) + MemoryVector
 *
 * skipDedup 保留給那些"入口就保證不會重"的路徑用（比如 EventBox 壓縮後寫回
 * summary 節點 —— summary 是 LLM 新合成的唯一結果，不會和已有記憶撞）。
 * 遷移路徑**不要**傳 skipDedup —— 語義去重能擋掉 sub-batch 之間對同一件事的
 * 重複提取（比如"7-12 號某天回憶起 3 號那件事"）。
 */
export async function vectorizeAndStore(
    nodes: MemoryNode[],
    embeddingConfig: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
    options: { skipDedup?: boolean } = {},
): Promise<{ stored: number; skipped: number }> {
    if (nodes.length === 0) return { stored: 0, skipped: 0 };

    // 1. 批量向量化
    const texts = nodes.map(n => n.content);
    const vectors = await getEmbeddings(texts, embeddingConfig);
    if (vectors.length !== nodes.length || vectors.some(vector => !vector.length || !Array.from(vector).every(Number.isFinite))) {
        throw new Error('Embedding 返回的向量不完整或無效，本次沒有寫入記憶');
    }

    // 2. 加載已有向量用於去重（EventBox summary / 遷移等場景跳過）
    const charId = nodes[0].charId;
    const existingVectors = options.skipDedup ? [] : await MemoryVectorDB.getAllByCharId(charId);

    let stored = 0;
    let skipped = 0;
    const entries: { node: MemoryNode; vector: MemoryVector }[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const vector = vectors[i];

        // 去重檢查 — ensureFloat32 兼容三種存儲形態（number[] / Float32Array
        // / Uint8Array），同時保護 cosineSimilarity 不被 Uint8Array 誤讀字節當數。
        const queryF32 = ensureFloat32(vector);
        const isDuplicate = !options.skipDedup && existingVectors.some(
            ev => cosineSimilarity(queryF32, ensureFloat32(ev.vector)) > DEDUP_THRESHOLD
        );

        if (isDuplicate) {
            console.log(`♻️ [VectorStore] Skipping duplicate memory: "${node.content.slice(0, 30)}..."`);
            skipped++;
            continue;
        }

        // 3. 保存
        const memoryVector: MemoryVector = {
            memoryId: node.id,
            charId: node.charId,
            vector,
            dimensions: embeddingConfig.dimensions,
            model: embeddingConfig.model,
        };
        entries.push({ node: { ...node, embedded: true }, vector: memoryVector });

        // 將新向量也加入已有列表，後續去重時可以檢測同批次內的重複
        existingVectors.push(memoryVector);

        stored++;
    }

    await MemoryNodeDB.saveVectorizedMany(entries);
    const committedIds = new Set(entries.map(entry => entry.node.id));
    for (const node of nodes) if (committedIds.has(node.id)) node.embedded = true;
    // Only publish remote state after the local batch committed successfully.
    if (remoteVectorConfig?.enabled && remoteVectorConfig.initialized) {
        for (const { node, vector } of entries) {
            remoteUpsert(remoteVectorConfig, node.id, node.charId, ensureFloat32(vector.vector), node, embeddingConfig.dimensions, embeddingConfig.model).catch(() => {});
        }
    }

    console.log(`✅ [VectorStore] Stored ${stored}, skipped ${skipped} duplicates`);
    return { stored, skipped };
}

export interface UpdateStoredMemoryNodeResult {
    node: MemoryNode;
    /** 只有正文發生變化時才會為 true。 */
    reembedded: boolean;
}

/**
 * 統一的記憶節點編輯保存入口。
 *
 * - 正文未變化：只保存 room/tags/importance/mood 等 metadata，不調用 Embedding API。
 * - 正文發生變化：沿用原 memoryId 重新生成並覆蓋向量，避免“新文字 + 舊向量”。
 */
export async function updateStoredMemoryNode(
    nodeId: string,
    updates: Partial<MemoryNode>,
    embeddingConfig?: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<UpdateStoredMemoryNodeResult> {
    const existing = await MemoryNodeDB.getById(nodeId);
    if (!existing) throw new Error('這條記憶已經不存在了');

    const updated: MemoryNode = { ...existing, ...updates, id: existing.id, charId: existing.charId };
    if (!updated.content.trim()) throw new Error('記憶內容不能為空');
    const contentChanged = updated.content !== existing.content;

    if (!contentChanged) {
        await MemoryNodeDB.save(updated);
        return { node: updated, reembedded: false };
    }

    if (!embeddingConfig?.baseUrl || !embeddingConfig.apiKey || !embeddingConfig.model) {
        throw new Error('請先配置 Embedding API，修改正文後需要同步更新向量');
    }

    updated.embedded = false;
    await vectorizeAndStore(
        [updated],
        embeddingConfig,
        remoteVectorConfig,
        { skipDedup: true },
    );
    return { node: { ...updated, embedded: true }, reembedded: true };
}

/**
 * 歸一化模型名，用於「是否同一個底層模型」的比對。
 *
 * 去掉計費檔位前綴 `Pro/`（硅基流動的付費獨佔算力檔，底層權重與免費版
 * 完全相同：`Pro/BAAI/bge-m3` 與 `BAAI/bge-m3` 是同一個 bge-m3）。
 *
 * 這樣硅基 `Pro/BAAI/bge-m3` → 火山 `BAAI/bge-m3` 這類「同一開源模型、
 * 僅換服務商/檔位」的切換不會觸發無謂重建（向量空間一致）。
 */
function normalizeModelName(model: string): string {
    return model
        .replace(/^Pro\//i, '')   // 硅基付費檔前綴
        .trim()
        .toLowerCase();
}

/**
 * 檢測當前 embedding 模型是否與已有向量的模型一致。
 * 如果不一致，說明用戶換了模型，需要重新向量化。
 *
 * 注意：只比對「模型本體」，`Pro/BAAI/bge-m3` 與 `BAAI/bge-m3` 視為同一個模型，
 * 跨服務商切換同一開源模型（如硅基 → 火山的 bge-m3）不會觸發無謂重建。
 *
 * @returns 'match' | 'mismatch' | 'empty' (無已有向量)
 */
export async function checkModelConsistency(
    charId: string,
    currentModel: string,
): Promise<'match' | 'mismatch' | 'empty'> {
    const existing = await MemoryVectorDB.getAllByCharId(charId);
    if (existing.length === 0) return 'empty';

    // 取第一條有 model 字段的向量做比對（舊數據可能沒有 model 字段）
    const sample = existing.find(v => v.model);
    if (!sample) return 'match'; // 舊數據無 model 字段，不觸發重建，兼容過渡

    return normalizeModelName(sample.model!) === normalizeModelName(currentModel)
        ? 'match'
        : 'mismatch';
}

/**
 * 重新向量化：用新模型重新 embedding 所有已有記憶。
 * 保留 MemoryNode 不動，只替換 MemoryVector。
 */
export async function rebuildAllVectors(
    charId: string,
    embeddingConfig: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<{ rebuilt: number }> {
    const nodes = await MemoryNodeDB.getByCharId(charId);
    const embeddedNodes = nodes.filter(n => n.embedded);

    if (embeddedNodes.length === 0) return { rebuilt: 0 };

    console.log(`🔄 [VectorStore] 開始重建 ${embeddedNodes.length} 條向量（${embeddingConfig.model}）...`);

    // 批量 embedding
    const texts = embeddedNodes.map(n => n.content);
    const vectors = await getEmbeddings(texts, embeddingConfig);

    // 逐條替換
    for (let i = 0; i < embeddedNodes.length; i++) {
        const mv: MemoryVector = {
            memoryId: embeddedNodes[i].id,
            charId,
            vector: vectors[i],
            dimensions: embeddingConfig.dimensions,
            model: embeddingConfig.model,
        };
        await MemoryVectorDB.save(mv);

        // 同步到遠程
        if (remoteVectorConfig?.enabled && remoteVectorConfig.initialized) {
            remoteUpsert(remoteVectorConfig, embeddedNodes[i].id, charId, vectors[i], embeddedNodes[i], embeddingConfig.dimensions, embeddingConfig.model).catch(() => {});
        }
    }

    console.log(`✅ [VectorStore] 重建完成：${embeddedNodes.length} 條向量已更新為 ${embeddingConfig.model}`);
    return { rebuilt: embeddedNodes.length };
}
