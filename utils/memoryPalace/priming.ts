/**
 * Memory Palace — 啟動效應 (Priming) + 反芻 (Rumination)
 *
 * 啟動效應：當前情緒偏置檢索結果（開心時更容易想起開心的事）
 * 反芻：閣樓裡的記憶有概率"不請自來"地浮現
 */

import type { MemoryNode, ScoredMemory } from './types';
import { MemoryNodeDB } from './db';
import { getEmotionVA, moodToVA, emotionDistance } from './emotionSpace';

/** 距離為 0 時的最大加成；距離 >= PRIMING_RADIUS 時不加成 */
const PRIMING_MAX_BOOST = 1.3;
/** 視作"情感相關"的距離閾值。範圍粗略 0 ~ 2.83，0.5 覆蓋約 1/4 情感平面 */
const PRIMING_RADIUS = 0.5;

/**
 * 啟動效應：當前情緒匹配的記憶提升分數
 *
 * 升級後使用 Russell 情感空間的二維距離，而非字符串精確匹配。
 * 好處：'happy' 角色能喚起 'grateful' / 'excited' 等鄰近情緒的記憶，
 * 不再卡 LLM 剛好用同一個詞。
 *
 * 距離衰減：線性。距離 0 → ×1.3；距離 = RADIUS → ×1.0。
 *
 * @param results 候選記憶
 * @param currentMood 角色當前情緒字符串（通過 moodToVA 轉為座標），
 *                    或直接傳入 { v, a } 座標對象。
 */
export function applyPriming(
    results: ScoredMemory[],
    currentMood: string | { v: number; a: number } | undefined,
): ScoredMemory[] {
    if (!currentMood) return results;

    const cur = typeof currentMood === 'string' ? moodToVA(currentMood) : currentMood;
    // 座標在原點（neutral）就不做加成，避免全局抬分
    if (cur.v === 0 && cur.a === 0) return results;

    return results.map(r => {
        const memVA = getEmotionVA(r.node);
        const dist = emotionDistance(memVA, cur);
        if (dist >= PRIMING_RADIUS) return r;
        // 距離 0 → 滿加成；距離 = RADIUS → 無加成
        const boost = 1 + (PRIMING_MAX_BOOST - 1) * (1 - dist / PRIMING_RADIUS);
        return { ...r, finalScore: r.finalScore * boost };
    });
}

/**
 * 反芻檢查：閣樓記憶有概率隨機浮現
 *
 * 反芻概率 = tendency × 0.2（最高 20%）
 *
 * @param charId 角色 ID
 * @param tendency 反芻傾向 0-1，默認 0.3
 * @returns 一條隨機閣樓記憶，或 null
 */
export async function checkRumination(
    charId: string,
    tendency: number = 0.3,
): Promise<MemoryNode | null> {
    const probability = Math.min(tendency, 1) * 0.2;

    if (Math.random() > probability) return null;

    // 從閣樓隨機取一條
    const atticNodes = await MemoryNodeDB.getByRoom(charId, 'attic');
    if (atticNodes.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * atticNodes.length);
    return atticNodes[randomIndex];
}
