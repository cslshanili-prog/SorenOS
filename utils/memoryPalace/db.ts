/**
 * Memory Palace — IndexedDB CRUD 操作
 *
 * 封裝 6 張表的增刪改查，複用主 db.ts 的 openDB()。
 */

import { openDB } from '../db';
import type {
    MemoryNode, MemoryVector, MemoryLink, MemoryBatch,
    TopicBox, Anticipation, MemoryRoom, BoxStatus, AnticipationStatus,
    EventBox, RoomPlate, PlateRoom, DigestReport,
} from './types';
import { DIGEST_REPORT_KEEP } from './types';
import { bm25Index } from './bm25Index';
import { notifyMemoryNodesChanged } from './nodeChanges';
import type { VectorIndexEntry as VectorBackupIndexEntry } from '../backupFormat';

// ─── Store 名稱常量 ────────────────────────────────────

const STORE_MEMORY_NODES   = 'memory_nodes';
const STORE_MEMORY_VECTORS = 'memory_vectors';
const STORE_MEMORY_LINKS   = 'memory_links';
const STORE_MEMORY_BATCHES = 'memory_batches';
const STORE_TOPIC_BOXES    = 'topic_boxes';
const STORE_ANTICIPATIONS  = 'anticipations';
const STORE_EVENT_BOXES    = 'event_boxes';
const STORE_ROOM_PLATES    = 'room_plates';
const STORE_DIGEST_REPORTS = 'digest_reports';

// ─── 通用輔助 ──────────────────────────────────────────

/** 通用 getAll by index */
async function getAllByIndex<T>(
    storeName: string, indexName: string, value: IDBValidKey
): Promise<T[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const req = index.getAll(IDBKeyRange.only(value));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/** 通用 put */
async function put<T>(storeName: string, data: T): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(data);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 通用 get by key */
async function getByKey<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** 通用 delete by key */
async function deleteByKey(storeName: string, key: IDBValidKey): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 通用 getAll (全表) */
async function getAll<T>(storeName: string): Promise<T[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

// ─── MemoryNode CRUD ──────────────────────────────────

/** 讀取遠程向量配置（輕量，僅 localStorage 讀取） */
function getRemoteVectorConfig(): { enabled: boolean; supabaseUrl: string; supabaseAnonKey: string; initialized: boolean } | null {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return null;
        const c = JSON.parse(raw);
        return (c.enabled && c.initialized) ? c : null;
    } catch { return null; }
}

/** save 後自動同步已向量化節點的 metadata 到遠程 */
function syncNodeMetadataToRemote(node: MemoryNode): void {
    if (!node.embedded) return;
    const rc = getRemoteVectorConfig();
    if (!rc) return;
    // 懶加載 + fire-and-forget
    import('./supabaseVector').then(({ upsertVector }) => {
        // 只更新 metadata（room/importance/tags/mood/content），需要拿到向量
        getByKey<MemoryVector>(STORE_MEMORY_VECTORS, node.id).then(vec => {
            if (!vec) return;
            // ensureFloat32 兼容舊 number[] / 新 Uint8Array / 內存中的 Float32Array
            // 三種形態，都解碼成 Float32Array 餵給 supabase。
            const vector = ensureFloat32(vec.vector);
            upsertVector(rc, node.id, node.charId, vector, node, vec.dimensions, vec.model).catch(() => {});
        });
    }).catch(() => {});
}

export const MemoryNodeDB = {
    /** A vectorized batch is all-or-nothing: never expose new text with missing/old vectors. */
    saveVectorizedMany: async (entries: { node: MemoryNode; vector: MemoryVector }[]): Promise<void> => {
        if (!entries.length) return;
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction([STORE_MEMORY_NODES, STORE_MEMORY_VECTORS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('記憶和向量保存已回滾'));
            try {
                for (const { node, vector } of entries) {
                    tx.objectStore(STORE_MEMORY_NODES).put(node);
                    tx.objectStore(STORE_MEMORY_VECTORS).put({ ...vector, vector: vecForStorage(vector.vector) });
                }
            } catch (error) { tx.abort(); reject(error); }
        });
        bm25Index.onNodesSaved(entries.map(entry => entry.node));
        for (const charId of new Set(entries.map(entry => entry.node.charId))) notifyMemoryNodesChanged(charId);
    },
    save: async (node: MemoryNode) => {
        await put<MemoryNode>(STORE_MEMORY_NODES, node);
        // 寫入驗證：確認數據真的持久化了
        const verify = await getByKey<MemoryNode>(STORE_MEMORY_NODES, node.id);
        if (!verify) {
            console.error(`❌ [MemoryNodeDB] WRITE VERIFICATION FAILED for ${node.id}`);
            throw new Error(`Memory node write failed: ${node.id}`);
        }
        // BM25 倒排索引：內部按 contentSig 判斷是否需要重新 tokenize，
        // touchAccess 之類只改 metadata 的寫入會被自動跳過。
        bm25Index.onNodeSaved(node);
        syncNodeMetadataToRemote(node);
        notifyMemoryNodesChanged(node.charId);
    },

    getById: (id: string) => getByKey<MemoryNode>(STORE_MEMORY_NODES, id),

    delete: async (id: string) => {
        await deleteByKey(STORE_MEMORY_NODES, id);
        bm25Index.onNodeDeleted(id);
        notifyMemoryNodesChanged();
    },

    getByCharId: (charId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId),

    getByRoom: (charId: string, room: MemoryRoom): Promise<MemoryNode[]> =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId)
            .then(nodes => nodes.filter(n => n.room === room)),

    getUnembedded: (charId: string): Promise<MemoryNode[]> =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId)
            .then(nodes => nodes.filter(n => !n.embedded)),

    /** @deprecated 舊話題盒 ID 查詢，保留以兼容殘留數據；新代碼請用 getByEventBoxId */
    getByBoxId: (boxId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'boxId', boxId),

    /** 按 EventBox ID 查詢所屬記憶節點（含 live + archived + summary） */
    getByEventBoxId: (eventBoxId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'eventBoxId', eventBoxId),

    /** 批量保存 */
    saveMany: async (nodes: MemoryNode[]): Promise<void> => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_NODES, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_NODES);
            for (const node of nodes) {
                store.put(node);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        bm25Index.onNodesSaved(nodes);
        for (const charId of new Set(nodes.map(node => node.charId))) notifyMemoryNodesChanged(charId);
    },

    /** 更新訪問記錄（檢索後調用） */
    touchAccess: async (id: string): Promise<void> => {
        const node = await getByKey<MemoryNode>(STORE_MEMORY_NODES, id);
        if (!node) return;
        node.lastAccessedAt = Date.now();
        node.accessCount += 1;
        await put<MemoryNode>(STORE_MEMORY_NODES, node);
        syncNodeMetadataToRemote(node);
    },
};

// ─── Float32Array 工具 ───────────────────────────────
//
// 歷史包袱：早期版本把 Float32Array 用 Array.from() 轉成普通 number[] 存進
// IndexedDB，結果每個 number 是 V8 的 boxed double（約 50 字節），1024 維
// 向量在磁盤上膨脹到 ~50 KB / 條，10k 向量就 500 MB+。
//
// 現在改成存 Uint8Array（直接拿 Float32 的底層字節）：4 字節 / 維度無損，
// ~12-13× 縮盤，讀取時一行 new Float32Array(buf) 零拷貝轉回去，餘弦相似度
// 算出來字節級一致 — 召回效果與舊格式完全等同。
//
// 舊 number[] 數據讀取時會被透明地轉為 Float32Array，下次 saveMany 寫回會
// 自動持久化為 Uint8Array；getAllByCharId 還會順手做批量遷移。

/** 解碼任一儲存形態為 Float32Array（零拷貝走 Uint8Array.buffer 路徑） */
export function ensureFloat32(vec: number[] | Float32Array | Uint8Array): Float32Array {
    if (vec instanceof Float32Array) return vec;
    if (vec instanceof Uint8Array) {
        // IndexedDB 結構化克隆給的是新 ArrayBuffer，可以直接 view 不用複製。
        return new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength >>> 2);
    }
    // 舊 number[] 路徑
    return new Float32Array(vec);
}

/**
 * 把 memory_vectors 的原始記錄歸一化成「Float32 原始字節拼成的一根 bin + 索引」，供 v2 備份的
 * 向量二進制旁路使用（見 utils/backupFormat.ts）。vector 可能是 Uint8Array（已遷移）/ Float32Array /
 * 遺留 number[]，必須先過 ensureFloat32 統一——遺留 number[] 不歸一化直接當字節讀會寫出無效數據（R4·F4）。
 * dimensions 用實際 f32 長度，釘死 byteLength === dimensions*4 不變量（導入端據此校驗）。
 */
export function encodeVectorsForBackup(
    rawVectors: Array<{ memoryId?: string; charId?: string; dimensions?: number; model?: string; vector?: unknown }>,
): { bin: Uint8Array; index: VectorBackupIndexEntry[] } {
    const index: VectorBackupIndexEntry[] = [];
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (const v of rawVectors) {
        if (!v || !v.vector || !v.memoryId) continue;
        const f32 = ensureFloat32(v.vector as number[] | Float32Array | Uint8Array);
        const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
        parts.push(bytes);
        index.push({
            memoryId: v.memoryId,
            charId: (v.charId ?? '') as string,
            dimensions: f32.length,
            model: v.model,
            byteOffset: offset,
            byteLength: bytes.byteLength,
        });
        offset += bytes.byteLength;
    }
    const bin = new Uint8Array(offset);
    let p = 0;
    for (const part of parts) { bin.set(part, p); p += part.byteLength; }
    return { bin, index };
}

type RawBackupVector = {
    memoryId?: string;
    charId?: string;
    dimensions?: number;
    model?: string;
    vector?: unknown;
};

/**
 * 低內存向量備份編碼：調用方提供一個可重複執行的分批掃描器，本函數第一遍只統計總字節數
 * 和索引，第二遍才把每批字節拷進最終 bin。這樣 4500+ 條舊 number[] 向量不會與最終 bin
 * 同時整表駐留；峰值約為「最終緊湊 bin + 一個小批次」，備份格式仍與舊版完全一致。
 *
 * 兩遍之間若數據發生變化會中止並給出明確錯誤，避免生成索引與 bin 錯位的損壞備份。
 */
export async function encodeVectorsForBackupChunked(
    scanBatches: (onBatch: (batch: RawBackupVector[]) => void) => Promise<void>,
): Promise<{ bin: Uint8Array; index: VectorBackupIndexEntry[] }> {
    const index: VectorBackupIndexEntry[] = [];
    let totalBytes = 0;

    await scanBatches((batch) => {
        const encoded = encodeVectorsForBackup(batch);
        for (const entry of encoded.index) {
            index.push({ ...entry, byteOffset: entry.byteOffset + totalBytes });
        }
        totalBytes += encoded.bin.byteLength;
    });

    const bin = new Uint8Array(totalBytes);
    let byteCursor = 0;
    let indexCursor = 0;

    await scanBatches((batch) => {
        const encoded = encodeVectorsForBackup(batch);
        if (byteCursor + encoded.bin.byteLength > bin.byteLength) {
            throw new Error('備份期間記憶向量發生變化，請等待記憶宮殿處理完成後重試。');
        }
        for (const entry of encoded.index) {
            const expected = index[indexCursor++];
            if (!expected
                || expected.memoryId !== entry.memoryId
                || expected.charId !== entry.charId
                || expected.dimensions !== entry.dimensions
                || expected.model !== entry.model
                || expected.byteOffset !== byteCursor + entry.byteOffset
                || expected.byteLength !== entry.byteLength) {
                throw new Error('備份期間記憶向量發生變化，請等待記憶宮殿處理完成後重試。');
            }
        }
        bin.set(encoded.bin, byteCursor);
        byteCursor += encoded.bin.byteLength;
    });

    if (byteCursor !== totalBytes || indexCursor !== index.length) {
        throw new Error('備份期間記憶向量發生變化，請等待記憶宮殿處理完成後重試。');
    }
    return { bin, index };
}

/** 編碼為 IndexedDB 存儲形態（Uint8Array of Float32 raw bytes） */
function vecForStorage(vec: number[] | Float32Array | Uint8Array): Uint8Array {
    if (vec instanceof Uint8Array) return vec;
    const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
    return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** 該向量是否還是舊 number[] 形態（用於判斷是否需要遷移寫回） */
function isLegacyVec(vec: unknown): boolean {
    return Array.isArray(vec);
}

// ─── MemoryVector CRUD ────────────────────────────────

export const MemoryVectorDB = {
    save: async (vec: MemoryVector) => {
        const stored = { ...vec, vector: vecForStorage(vec.vector) };
        await put<MemoryVector>(STORE_MEMORY_VECTORS, stored);
        // 寫入驗證
        const verify = await getByKey<MemoryVector>(STORE_MEMORY_VECTORS, vec.memoryId);
        if (!verify) {
            console.error(`❌ [MemoryVectorDB] WRITE VERIFICATION FAILED for ${vec.memoryId}`);
            throw new Error(`Memory vector write failed: ${vec.memoryId}`);
        }
    },

    getByMemoryId: async (memoryId: string): Promise<MemoryVector | undefined> => {
        const v = await getByKey<MemoryVector>(STORE_MEMORY_VECTORS, memoryId);
        if (!v) return undefined;
        return { ...v, vector: ensureFloat32(v.vector) };
    },

    delete: (memoryId: string) => deleteByKey(STORE_MEMORY_VECTORS, memoryId),

    /**
     * 獲取角色的全部向量 — 優先使用 charId 索引直查，避免全表掃描。
     * 向量出 DB 層一律是 Float32Array。讀到舊 number[] 形態會順手在背景
     * 重寫為 Uint8Array，以漸進釋放磁盤空間（首次訪問後省 ~12×）。
     *
     * 遷移用的是 IDB cursor.update() 而不是先快照再 put — 後者會跟用戶
     * 併發的 vec.save() 撞車（快照裡是舊向量、save 寫入新向量、遷移後再
     * 用舊向量覆蓋 = 靜默數據丟失）。cursor 在同一個 readwrite tx 裡讀改
     * 寫，IDB 自動順序化，無論誰先到都能保留最新數據。
     *
     * 兼容舊數據（無 charId 字段）：回退到 memory_nodes 聯合查詢。
     */
    getAllByCharId: async (charId: string): Promise<MemoryVector[]> => {
        // 後台游標遷移 — 按 charId 索引掃這個角色的向量記錄，發現還是
        // number[] 形態的就 cursor.update() 寫回 Uint8Array。
        const migrateLegacyByCharId = (charId: string): void => {
            (async () => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    const idx = store.index('charId');
                    const req = idx.openCursor(IDBKeyRange.only(charId));
                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) return;
                        const v = cursor.value;
                        // 此時 cursor.value 是 IDB 當前最新值，如果用戶剛 save
                        // 過，這裡讀到的已是 Uint8Array，會被下面的檢查跳過。
                        if (isLegacyVec(v.vector)) {
                            cursor.update({ ...v, vector: vecForStorage(v.vector) });
                        }
                        cursor.continue();
                    };
                } catch (e) {
                    console.warn('[MemoryVectorDB] cursor migration failed', e);
                }
            })();
        };

        // 嘗試通過 charId 索引直查（新數據路徑）
        try {
            const indexed = await getAllByIndex<MemoryVector>(STORE_MEMORY_VECTORS, 'charId', charId);
            if (indexed.length > 0) {
                if (indexed.some(v => isLegacyVec(v.vector))) {
                    migrateLegacyByCharId(charId);
                }
                return indexed.map(v => ({ ...v, vector: ensureFloat32(v.vector) }));
            }
        } catch {
            // 索引不存在（舊版本 DB），走兼容路徑
        }

        // 兼容舊數據回退：通過 memory_nodes 聯合查詢
        const nodes = await getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId);
        const embeddedIds = new Set(nodes.filter(n => n.embedded).map(n => n.id));
        if (embeddedIds.size === 0) return [];

        const allVectors = await getAll<MemoryVector>(STORE_MEMORY_VECTORS);
        const matched = allVectors.filter(v => embeddedIds.has(v.memoryId));

        // 回填 charId + 順手把舊 number[] 升級到 Uint8Array — 這裡也走
        // cursor.update 避免覆蓋併發 save。primaryKey 直查每條記錄的 cursor。
        if (matched.length > 0) {
            (async () => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    for (const m of matched) {
                        const req = store.openCursor(IDBKeyRange.only(m.memoryId));
                        req.onsuccess = () => {
                            const cursor = req.result;
                            if (!cursor) return;
                            const cur = cursor.value;
                            const needsCharId = !cur.charId;
                            const needsMigration = isLegacyVec(cur.vector);
                            if (needsCharId || needsMigration) {
                                cursor.update({
                                    ...cur,
                                    charId: cur.charId || charId,
                                    vector: vecForStorage(cur.vector),
                                });
                            }
                        };
                    }
                } catch (e) {
                    console.warn('[MemoryVectorDB] charId backfill failed', e);
                }
            })();
        }

        return matched.map(v => ({ ...v, charId, vector: ensureFloat32(v.vector) }));
    },

    /** 批量保存 */
    saveMany: async (vectors: MemoryVector[]): Promise<void> => {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_VECTORS);
            for (const vec of vectors) {
                store.put({ ...vec, vector: vecForStorage(vec.vector) });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    /**
     * 一次性掃描整個向量表，把還停留在 number[] 老格式的記錄全部升級為
     * Uint8Array 緊湊存儲。OSContext 啟動時調用一次；用戶首次進 App 後
     * 12× 釋放磁盤。已經是新格式的記錄會被跳過，重複調用冪等無副作用。
     *
     * 用 cursor.update() 而不是先快照再 put 避免併發 save 數據丟失。
     *
     * 分批 tx：每批 500 條用一個獨立 readwrite tx，批間 setTimeout(50)
     * 讓其他向量搜索/save tx 有機會插隊，避免 10k 向量的重度用戶感受到
     * 長達 10s 的全局停頓。
     *
     * @param onProgress 收到 (migrated, scanned) 的回調，用於上層 UI 顯示進度
     * @returns 實際被升級的記錄數
     */
    scanAndMigrateLegacy: async (
        onProgress?: (migrated: number, scanned: number) => void,
    ): Promise<number> => {
        const BATCH_SIZE = 500;
        let migrated = 0;
        let scanned = 0;
        let lastKey: IDBValidKey | null = null;
        let done = false;

        while (!done) {
            const batch = await new Promise<{
                migrated: number; scanned: number; lastKey: IDBValidKey | null; done: boolean;
            }>(async (resolve, reject) => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    const range = lastKey !== null
                        ? IDBKeyRange.lowerBound(lastKey, true)  // exclusive 跳過已掃的
                        : undefined;
                    const req = store.openCursor(range);
                    let bMig = 0, bScan = 0;
                    let bLast: IDBValidKey | null = lastKey;
                    let bDone = false;

                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) { bDone = true; return; }
                        if (bScan >= BATCH_SIZE) return; // 不再 continue，等 tx 自己關
                        const v = cursor.value;
                        bScan++;
                        bLast = cursor.primaryKey;
                        if (isLegacyVec(v.vector)) {
                            cursor.update({ ...v, vector: vecForStorage(v.vector) });
                            bMig++;
                        }
                        cursor.continue();
                    };
                    req.onerror = () => reject(req.error);
                    tx.oncomplete = () => resolve({
                        migrated: bMig, scanned: bScan, lastKey: bLast, done: bDone,
                    });
                    tx.onerror = () => reject(tx.error);
                } catch (e) { reject(e); }
            });

            migrated += batch.migrated;
            scanned += batch.scanned;
            lastKey = batch.lastKey;
            done = batch.done;

            if (onProgress) onProgress(migrated, scanned);

            // 讓其他 IDB tx 有機會插隊
            if (!done) await new Promise(r => setTimeout(r, 50));
        }
        return migrated;
    },
};

// ─── MemoryLink CRUD ──────────────────────────────────

export const MemoryLinkDB = {
    save: (link: MemoryLink) => put<MemoryLink>(STORE_MEMORY_LINKS, link),

    delete: (id: string) => deleteByKey(STORE_MEMORY_LINKS, id),

    getBySourceId: (sourceId: string) =>
        getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'sourceId', sourceId),

    getByTargetId: (targetId: string) =>
        getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'targetId', targetId),

    /** 獲取與某節點相關的所有鏈接（source 或 target） */
    getByNodeId: async (nodeId: string): Promise<MemoryLink[]> => {
        const [asSource, asTarget] = await Promise.all([
            getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'sourceId', nodeId),
            getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'targetId', nodeId),
        ]);
        // 去重（同一條 link 不會同時出現在兩個結果中，因為 sourceId ≠ targetId）
        const seen = new Set<string>();
        const result: MemoryLink[] = [];
        for (const link of [...asSource, ...asTarget]) {
            if (!seen.has(link.id)) {
                seen.add(link.id);
                result.push(link);
            }
        }
        return result;
    },

    /** 批量保存 */
    saveMany: async (links: MemoryLink[]): Promise<void> => {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_LINKS, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_LINKS);
            for (const link of links) {
                store.put(link);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
};

// ─── MemoryBatch CRUD ─────────────────────────────────

export const MemoryBatchDB = {
    save: (batch: MemoryBatch) => put<MemoryBatch>(STORE_MEMORY_BATCHES, batch),

    getByCharId: (charId: string) =>
        getAllByIndex<MemoryBatch>(STORE_MEMORY_BATCHES, 'charId', charId),
};

// ─── TopicBox CRUD ────────────────────────────────────

export const TopicBoxDB = {
    save: (box: TopicBox) => put<TopicBox>(STORE_TOPIC_BOXES, box),

    getById: (id: string) => getByKey<TopicBox>(STORE_TOPIC_BOXES, id),

    getByCharId: (charId: string) =>
        getAllByIndex<TopicBox>(STORE_TOPIC_BOXES, 'charId', charId),

    /** 獲取角色當前 open 的盒子（最多一個） */
    getOpenBox: async (charId: string): Promise<TopicBox | undefined> => {
        const boxes = await getAllByIndex<TopicBox>(STORE_TOPIC_BOXES, 'charId', charId);
        return boxes.find(b => b.status === 'open');
    },

    /** 按狀態過濾 */
    getByStatus: (charId: string, status: BoxStatus): Promise<TopicBox[]> =>
        getAllByIndex<TopicBox>(STORE_TOPIC_BOXES, 'charId', charId)
            .then(boxes => boxes.filter(b => b.status === status)),
};

// ─── EventBox CRUD ────────────────────────────────────

export const EventBoxDB = {
    save: (box: EventBox) => put<EventBox>(STORE_EVENT_BOXES, box),

    getById: (id: string) => getByKey<EventBox>(STORE_EVENT_BOXES, id),

    delete: (id: string) => deleteByKey(STORE_EVENT_BOXES, id),

    getByCharId: (charId: string) =>
        getAllByIndex<EventBox>(STORE_EVENT_BOXES, 'charId', charId),

    /** 批量保存（merge/compression 場景用） */
    saveMany: async (boxes: EventBox[]): Promise<void> => {
        if (boxes.length === 0) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_EVENT_BOXES, 'readwrite');
            const store = tx.objectStore(STORE_EVENT_BOXES);
            for (const box of boxes) store.put(box);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
};

// ─── RoomPlate CRUD（房間門牌） ───────────────────────

/** 門牌主鍵：一角色一房間一塊 */
export function plateId(charId: string, room: PlateRoom): string {
    return `${charId}:${room}`;
}

export const RoomPlateDB = {
    save: (plate: RoomPlate) => put<RoomPlate>(STORE_ROOM_PLATES, plate),

    get: (charId: string, room: PlateRoom) =>
        getByKey<RoomPlate>(STORE_ROOM_PLATES, plateId(charId, room)),

    getByCharId: (charId: string) =>
        getAllByIndex<RoomPlate>(STORE_ROOM_PLATES, 'charId', charId),

    delete: (charId: string, room: PlateRoom) =>
        deleteByKey(STORE_ROOM_PLATES, plateId(charId, room)),
};

/**
 * 「門牌被後台改寫過了」的窗口事件（`detail: { charId, rooms }`）。
 *
 * 給雲端整理用的：結果晚幾分鐘才回來，那時用戶多半正開著記憶宮殿。門牌已經寫進
 * IndexedDB，界面卻還掛著提交前那份——不派這個事件的話得關掉再打開才看得見，看上去
 * 就像整理壓根沒跑。名字放在門牌讀寫這一層，派發方和監聽方都別手抄字符串。
 */
export const ROOM_PLATES_UPDATED_EVENT = 'room-plates-updated';

/**
 * 讀一塊門牌，沒有就現造一塊空的（不落庫，由調用方決定要不要存）。
 *
 * 住在這兒是因為兩條整理路徑（本地的 roomPlates、上雲的 roomPlateCloud）都要它，
 * 而新門牌的初始形態——尤其是 `version: 0` 這個樂觀鎖起點——兩邊必須一模一樣。
 */
export async function loadOrCreatePlate(charId: string, room: PlateRoom): Promise<RoomPlate> {
    const existing = await RoomPlateDB.get(charId, room);
    if (existing) return existing;
    return {
        id: plateId(charId, room),
        charId,
        room,
        entries: [],
        updatedAt: Date.now(),
        version: 0,
    };
}

/**
 * 每塊門牌一條落庫隊列（見 mutatePlate）。
 *
 * 鍵是門牌主鍵，所以上限是「角色數 × 4」，用不著回收；存的也只是一個已 settle 的 Promise。
 */
const plateWriteQueues = new Map<string, Promise<unknown>>();

/**
 * 改一塊門牌：**現讀一份 → 改 → 整塊存回去**，同一塊門牌上的改動排隊走，不併發。
 *
 * 門牌是「整塊對象存回去」的形狀，而動它的路有四條，彼此完全不知道對方存在：
 * 雲端整理結果落地、本地整理落庫、送達保證兜底併入、以及門牌面板上用戶手改。任意兩條
 * 撞在一起就是後寫的把先寫的整塊蓋掉——用戶剛敲的字沒了，或者一整輪整理的成果沒了，
 * 而兩邊日誌都顯示成功。各自在自己那條路里排隊是不夠的（面板原先就是這麼做的），
 * 隊伍必須是**按門牌**的一條，所有路共用。
 *
 * `change` 要是純的——只回答「這份門牌該改成什麼樣」，回 null 表示不用改。要往界面上
 * 說話、要記日誌的，在外面等這個 promise 落定之後再說。
 *
 * @returns 存進去的那一份；`change` 回 null（不用改）時是 null。落庫出錯照常拋。
 */
export async function mutatePlate(
    charId: string,
    room: PlateRoom,
    change: (plate: RoomPlate) => RoomPlate | null,
): Promise<RoomPlate | null> {
    const key = plateId(charId, room);
    const run = async (): Promise<RoomPlate | null> => {
        const fresh = await loadOrCreatePlate(charId, room);
        const next = change(fresh);
        if (!next) return null;
        await RoomPlateDB.save(next);
        return next;
    };
    // 前一次的成敗不影響後一次排上隊（兩個分支都是 run），但隊尾要吞掉異常——
    // 不吞的話一次落庫失敗會變成後面每一次的 unhandled rejection。
    const write = (plateWriteQueues.get(key) ?? Promise.resolve()).then(run, run);
    plateWriteQueues.set(key, write.catch(() => {}));
    return write;
}

// ─── DigestReport CRUD（消化日誌） ────────────────────

export const DigestReportDB = {
    /** 保存並修剪：每角色只留最近 DIGEST_REPORT_KEEP 條 */
    save: async (report: DigestReport): Promise<void> => {
        await put<DigestReport>(STORE_DIGEST_REPORTS, report);
        try {
            const all = await getAllByIndex<DigestReport>(STORE_DIGEST_REPORTS, 'charId', report.charId);
            if (all.length > DIGEST_REPORT_KEEP) {
                const overflow = all
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .slice(DIGEST_REPORT_KEEP);
                for (const old of overflow) {
                    await deleteByKey(STORE_DIGEST_REPORTS, old.id);
                }
            }
        } catch { /* 修剪失敗不影響本條保存 */ }
    },

    /** 按時間倒序（最新在前） */
    getByCharId: (charId: string): Promise<DigestReport[]> =>
        getAllByIndex<DigestReport>(STORE_DIGEST_REPORTS, 'charId', charId)
            .then(list => list.sort((a, b) => b.createdAt - a.createdAt)),

    delete: (id: string) => deleteByKey(STORE_DIGEST_REPORTS, id),
};

// ─── Anticipation CRUD ────────────────────────────────

export const AnticipationDB = {
    save: (ant: Anticipation) => put<Anticipation>(STORE_ANTICIPATIONS, ant),

    getById: (id: string) => getByKey<Anticipation>(STORE_ANTICIPATIONS, id),

    delete: (id: string) => deleteByKey(STORE_ANTICIPATIONS, id),

    getByCharId: (charId: string) =>
        getAllByIndex<Anticipation>(STORE_ANTICIPATIONS, 'charId', charId),

    getByStatus: (charId: string, status: AnticipationStatus): Promise<Anticipation[]> =>
        getAllByIndex<Anticipation>(STORE_ANTICIPATIONS, 'charId', charId)
            .then(ants => ants.filter(a => a.status === status)),

    getActive: (charId: string) =>
        AnticipationDB.getByStatus(charId, 'active'),
};
