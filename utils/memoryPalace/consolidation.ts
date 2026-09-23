/**
 * Memory Palace — 鞏固 (Consolidation)
 *
 * 模擬短期記憶 → 長期記憶的過程：
 * - 客廳 → 臥室晉升
 * - 艾賓浩斯遺忘曲線
 * - 客廳容量管理
 */

import type { MemoryNode, MemoryRoom, RemoteVectorConfig } from './types';
import { ROOM_CONFIGS } from './types';
import { MemoryNodeDB } from './db';
import { bulkSetRoom } from './supabaseVector';

// ─── 艾賓浩斯衰減 ────────────────────────────────────

/**
 * effective importance 衰減下限（相對於原始 importance 的比例），按房間分級。
 *
 * 人的記憶裡"重大人生事件"（imp=8+）即使過了很久也不會退化成瑣事。
 * 但 0.9995/小時 的連續衰減在 140 天后會把 imp=10 壓到 ~2，讓高重要性
 * 的舊記憶在排序時輸給低重要性的近期記憶——這違反了 imp 字段本身的
 * 語義（imp=10 就該永遠比 imp=3 更重要）。
 *
 * 加一個 floor：無論衰減多久，effective importance 不會低於
 * importance × FLOOR_RATIO。
 *
 * 按房間分級的原因：
 *   - living_room 是"熱緩存"，為日常瑣事保留；0.8 floor 允許更多衰減，
 *     讓舊瑣事真正沉下去。
 *   - bedroom / study / user_room 是 consolidation 晉升後的"長期庫"，
 *     進得來本來就是因為重要（imp≥8 立即晉升 / imp≥6 且 >24h 晉升 /
 *     accessCount≥3 晉升），沒理由讓它們衰減 20%。用 0.9 floor，
 *     對 attic 的"永不衰減"（decayRate=null）保留 10% 差異做區分。
 *   - self_room / attic / windowsill decayRate=null 不經過這裡，等效 1.0。
 */
const EFFECTIVE_IMPORTANCE_FLOOR_RATIOS: Record<MemoryRoom, number> = {
    living_room: 0.80,
    bedroom:     0.90,
    study:       0.90,
    user_room:   0.90,
    self_room:   1.00, // 實際因 decayRate=null 不走 floor，僅作完整性
    attic:       1.00,
    windowsill:  1.00,
};

/**
 * 計算有效重要性（考慮時間衰減 + floor）
 *
 * effective = max(importance × decayRate ^ hours, importance × floor_ratio[room])
 * 默認客廳 decayRate = 0.9972 → 1天后 ~93.5%, 7天后 ~62%, 30天后 ~12.7%
 * 不會低於 importance × floor_ratio[room]（0.8 或 0.9）
 */
export function calculateEffectiveImportance(node: MemoryNode, now: number = Date.now()): number {
    const room = node.room;
    const config = ROOM_CONFIGS[room];

    // 永不遺忘的房間（self_room / attic / windowsill）
    if (config.decayRate === null) return node.importance;

    const hours = (now - node.createdAt) / (1000 * 60 * 60);
    if (hours <= 0) return node.importance;

    const decayed = node.importance * Math.pow(config.decayRate, hours);
    const floor = node.importance * EFFECTIVE_IMPORTANCE_FLOOR_RATIOS[room];
    return Math.max(decayed, floor);
}

// ─── 晉升條件 ─────────────────────────────────────────

/**
 * 判斷客廳中的記憶是否應晉升到臥室
 *
 * 條件（滿足任一即可）：
 * 1. importance ≥ 8 → 立即晉升
 * 2. importance ≥ 6 且 age > 24h → 時間沉澱
 * 3. accessCount ≥ 3 → 頻繁訪問
 */
export function shouldPromote(node: MemoryNode, now: number = Date.now()): boolean {
    if (node.room !== 'living_room') return false;

    // 條件 1: 高重要性立即晉升
    if (node.importance >= 8) return true;

    // 條件 2: 中等重要性 + 時間沉澱
    const ageHours = (now - node.createdAt) / (1000 * 60 * 60);
    if (node.importance >= 6 && ageHours >= 24) return true;

    // 條件 3: 頻繁訪問
    if (node.accessCount >= 3) return true;

    return false;
}

// ─── 運行鞏固 ─────────────────────────────────────────

export interface ConsolidationResult {
    promoted: string[];   // 晉升的 node IDs
    evicted: string[];    // 因容量淘汰的 node IDs（僅標記，不刪除數據）
}

/**
 * 運行鞏固過程
 *
 * 1. 檢查客廳記憶的晉升條件
 * 2. 滿足條件的 → room 改為 bedroom
 * 3. 客廳超容量 → 按 effective importance 最低的標記為已遺忘（移到 attic 而非刪除）
 *
 * 遠程同步：傳入 remoteConfig 時，把 room 變更 PATCH 到 Supabase memory_vectors.room，
 * 避免換設備/本地重建時讀到 stale living_room。失敗不影響本地鞏固結果。
 */
export async function runConsolidation(
    charId: string,
    remoteConfig?: RemoteVectorConfig,
): Promise<ConsolidationResult> {
    const now = Date.now();
    const result: ConsolidationResult = { promoted: [], evicted: [] };

    // 獲取客廳所有記憶
    const livingRoomNodes = await MemoryNodeDB.getByRoom(charId, 'living_room');

    // 1. 晉升檢查
    for (const node of livingRoomNodes) {
        if (shouldPromote(node, now)) {
            node.room = 'bedroom';
            await MemoryNodeDB.save(node);
            result.promoted.push(node.id);
            console.log(`⬆️ [Consolidation] Promoted to bedroom: "${node.content.slice(0, 30)}..."`);
        }
    }

    // 2. 容量管理（晉升後重新獲取客廳數據）
    const capacity = ROOM_CONFIGS.living_room.capacity;
    if (capacity !== null) {
        const remainingNodes = await MemoryNodeDB.getByRoom(charId, 'living_room');

        if (remainingNodes.length > capacity) {
            // 按 effective importance 排序
            const scored = remainingNodes.map(n => ({
                node: n,
                effective: calculateEffectiveImportance(n, now),
            }));
            scored.sort((a, b) => a.effective - b.effective);

            // 淘汰最低的，直到回到容量內
            const toEvict = scored.slice(0, remainingNodes.length - capacity);
            for (const { node } of toEvict) {
                // 不刪除，移到 attic（作為"被遺忘但仍在潛意識中"的記憶）
                node.room = 'attic';
                await MemoryNodeDB.save(node);
                result.evicted.push(node.id);
                console.log(`📦 [Consolidation] Evicted to attic: "${node.content.slice(0, 30)}..."`);
            }
        }
    }

    // 3. 遠程同步（Supabase memory_vectors.room）
    //    兩類變更 → 兩次 PATCH：promoted 全進 bedroom，evicted 全進 attic。
    //    遠端沒有對應 memory_id 的 PATCH 自動 no-op，不會造成髒數據。
    if (remoteConfig?.enabled && remoteConfig.initialized && (result.promoted.length > 0 || result.evicted.length > 0)) {
        try {
            const tasks: Promise<boolean>[] = [];
            if (result.promoted.length > 0) {
                tasks.push(bulkSetRoom(remoteConfig, result.promoted, 'bedroom'));
            }
            if (result.evicted.length > 0) {
                tasks.push(bulkSetRoom(remoteConfig, result.evicted, 'attic'));
            }
            const oks = await Promise.all(tasks);
            const allOk = oks.every(Boolean);
            if (allOk) {
                console.log(`☁️ [Consolidation] 遠程同步完成：${result.promoted.length} → bedroom，${result.evicted.length} → attic`);
            } else {
                console.warn(`☁️ [Consolidation] 遠程同步部分失敗，本地鞏固已生效但 Supabase room 字段可能滯後`);
            }
        } catch (e: any) {
            console.warn(`☁️ [Consolidation] 遠程同步異常（本地鞏固不受影響）: ${e?.message || e}`);
        }
    }

    if (result.promoted.length > 0 || result.evicted.length > 0) {
        console.log(`✅ [Consolidation] ${result.promoted.length} promoted, ${result.evicted.length} evicted`);
    }

    return result;
}
