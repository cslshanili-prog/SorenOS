/**
 * Memory Palace — 擴散激活 (Spreading Activation)
 *
 * 檢索命中的記憶沿關聯網絡"聯想"到相關記憶。
 * 人格風格影響不同關聯類型的權重。
 */

import type { MemoryNode, PersonalityStyle, ScoredMemory } from './types';
import { PERSONALITY_WEIGHTS } from './types';
import { MemoryNodeDB, MemoryLinkDB } from './db';

// 注意：EventBox 接管了"同一事件"的強綁定職責後，MemoryLink 退化為"背景聯想"。
// 這裡把 decay 從 0.5 → 0.3，maxExpand 默認從 5 → 3，讓弱關聯活著但不主導召回。
const ACTIVATION_DECAY = 0.3;

/**
 * 沿關聯網絡擴散激活
 *
 * 對每個種子記憶，沿 memory_links 找到鄰居，
 * 計算激活值 = seed_score × link_strength × type_weight × decay
 *
 * @param seeds 初始檢索命中的記憶（帶分數）
 * @param charId 角色 ID
 * @param style 人格風格（影響關聯類型權重）
 * @param maxExpand 最多額外擴展的記憶數量
 */
export async function spreadActivation(
    seeds: ScoredMemory[],
    charId: string,
    style: PersonalityStyle = 'emotional',
    maxExpand: number = 3,
): Promise<ScoredMemory[]> {
    const weights = PERSONALITY_WEIGHTS[style];
    const seedIds = new Set(seeds.map(s => s.node.id));
    const activated = new Map<string, number>(); // nodeId → activation score

    // 對每個種子，找到它的鄰居並計算激活值
    for (const seed of seeds) {
        const links = await MemoryLinkDB.getByNodeId(seed.node.id);

        for (const link of links) {
            // 確定鄰居 ID
            const neighborId = link.sourceId === seed.node.id ? link.targetId : link.sourceId;

            // 跳過已經是種子的
            if (seedIds.has(neighborId)) continue;

            // 計算激活值
            const typeWeight = weights[link.type] || 0.2;
            const activationScore = seed.finalScore * link.strength * typeWeight * ACTIVATION_DECAY;

            // 取最高激活值
            const existing = activated.get(neighborId) || 0;
            if (activationScore > existing) {
                activated.set(neighborId, activationScore);
            }
        }
    }

    // 按激活值排序，取 topN
    const sortedActivations = [...activated.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxExpand);

    // 加載被激活的 MemoryNode（跳過 archived —— 它們已被壓入 box summary）
    const expandedResults: ScoredMemory[] = [];
    for (const [nodeId, score] of sortedActivations) {
        const node = await MemoryNodeDB.getById(nodeId);
        if (node && !node.archived) {
            expandedResults.push({
                node,
                finalScore: score,
                similarity: 0,
                bm25Score: 0,
                roomScore: score,
            });
        }
    }

    // 合併：seeds + 擴展結果
    return [...seeds, ...expandedResults];
}
