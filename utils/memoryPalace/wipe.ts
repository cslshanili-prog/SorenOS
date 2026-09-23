/**
 * Memory Palace — 一鍵清空
 *
 * 把本地所有記憶宮殿數據清零；可選同步清空用戶自己的 Supabase memory_vectors。
 *
 * 使用場景：
 *  - 用戶想"重來"（比如改了 embedding 模型、或希望應用新版 boxId 體系）
 *  - 開發/測試重置
 */

import { openDB } from '../db';
import type { RemoteVectorConfig } from './types';
import { bm25Index } from './bm25Index';

const MP_STORES = [
    'memory_nodes',
    'memory_vectors',
    'memory_links',
    'memory_batches',
    'topic_boxes',
    'anticipations',
    'event_boxes',
    'room_plates',
    'digest_reports',
];

/** 清空 localStorage 中所有 mp_lastMsgId_<charId> 高水位標記 */
function clearHighWatermarks(): number {
    let n = 0;
    try {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('mp_lastMsgId_')) toRemove.push(key);
        }
        for (const key of toRemove) {
            localStorage.removeItem(key);
            n++;
        }
    } catch { /* ignore */ }
    return n;
}

/** 清空本地 IndexedDB 的所有記憶宮殿表 */
async function clearLocalStores(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const db = await openDB();

    // 只對實際存在的 store 操作（兼容舊版本未建 event_boxes 的情況）
    const presentStores = MP_STORES.filter(name => db.objectStoreNames.contains(name));
    if (presentStores.length === 0) return counts;

    return await new Promise<Record<string, number>>((resolve, reject) => {
        const tx = db.transaction(presentStores, 'readwrite');

        // 先異步收集每張表的行數，再清空；用嵌套 onsuccess 串起來
        let pending = presentStores.length;
        const checkDone = () => {
            if (pending === 0) {
                // 所有 count 回調完成，這裡發起 clear
                for (const name of presentStores) {
                    try { tx.objectStore(name).clear(); } catch { /* ignore */ }
                }
            }
        };

        for (const name of presentStores) {
            const req = tx.objectStore(name).count();
            req.onsuccess = () => {
                counts[name] = req.result || 0;
                pending--;
                checkDone();
            };
            req.onerror = () => {
                counts[name] = 0;
                pending--;
                checkDone();
            };
        }

        tx.oncomplete = () => resolve(counts);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** 清空遠程 Supabase 向量表（全表刪除，跨所有角色） */
async function clearRemoteVectors(config: RemoteVectorConfig): Promise<number> {
    if (!config.enabled || !config.initialized) return 0;
    try {
        const headers = {
            'apikey': config.supabaseAnonKey,
            'Authorization': `Bearer ${config.supabaseAnonKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'count=exact,return=minimal',
        };
        const base = `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/memory_vectors`;

        // 先查總數（用 HEAD + count=exact）
        let total = 0;
        try {
            const head = await fetch(`${base}?select=memory_id`, {
                method: 'HEAD',
                headers: { ...headers, 'Prefer': 'count=exact' },
            });
            const range = head.headers.get('content-range');
            if (range) {
                const m = range.match(/\/(\d+)/);
                if (m) total = parseInt(m[1], 10);
            }
        } catch { /* ignore */ }

        // PostgREST 要求 DELETE 必須帶過濾條件；用 "memory_id=not.is.null" 匹配全部行
        const delRes = await fetch(`${base}?memory_id=not.is.null`, {
            method: 'DELETE',
            headers,
        });
        if (!delRes.ok) {
            console.warn(`🗑️ [Wipe] 遠程刪除返回 ${delRes.status}: ${await delRes.text().catch(() => '')}`);
            return 0;
        }
        return total;
    } catch (e: any) {
        console.warn(`🗑️ [Wipe] 遠程刪除異常: ${e?.message || e}`);
        return 0;
    }
}

export interface WipeResult {
    local: Record<string, number>;
    localRowsTotal: number;
    highWatermarks: number;
    remote: number;
    remoteAttempted: boolean;
}

/**
 * 一鍵清空記憶宮殿數據。
 *
 * @param options.remoteConfig 若提供，會同時清空遠程 Supabase memory_vectors（全表）
 * @param options.skipRemote  即使有 remoteConfig 也跳過遠程（僅清本地）
 */
export async function wipeAllMemoryPalace(options: {
    remoteConfig?: RemoteVectorConfig;
    skipRemote?: boolean;
} = {}): Promise<WipeResult> {
    console.log(`🗑️ [Wipe] 開始一鍵清空記憶宮殿...`);

    const local = await clearLocalStores();
    const localRowsTotal = Object.values(local).reduce((s, v) => s + v, 0);
    const hwm = clearHighWatermarks();

    // 同步清空內存中的 BM25 倒排索引（否則下次查詢會拿到孤兒 nodeId）
    bm25Index.dropAll();

    let remote = 0;
    let remoteAttempted = false;
    if (options.remoteConfig && !options.skipRemote) {
        remoteAttempted = true;
        remote = await clearRemoteVectors(options.remoteConfig);
    }

    console.log(`🗑️ [Wipe] 完成：本地 ${localRowsTotal} 行、高水位 ${hwm} 條、遠程 ${remoteAttempted ? remote : '跳過'}`);
    return { local, localRowsTotal, highWatermarks: hwm, remote, remoteAttempted };
}
