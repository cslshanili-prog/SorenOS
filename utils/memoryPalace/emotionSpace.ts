/**
 * Memory Palace — 情感空間 (Russell Circumplex of Affect)
 *
 * 把情緒從離散字符串（'happy' / 'sad'）升級成二維連續座標：
 *   - valence（效價）: -1 極痛苦 → +1 極愉悅
 *   - arousal（喚醒度）: -1 極平靜 → +1 極激烈
 *
 * 下游代碼（priming / links / digestion）統一通過 getEmotionVA() 取值，
 * 無需關心節點是新的（帶 (v,a) 字段）還是老的（只有 mood 字符串）。
 *
 * 設計原則：
 * 1. **零遷移**：老數據通過 MOOD_TO_VA 查表兜底，不需要回填。
 * 2. **精度漸進**：新記憶由 LLM 直接給 (v,a)，精度高；老記憶走查表，精度中；
 *    封盒/消化時若走 LLM，順便補上 (v,a)。
 * 3. **兼容 LLM 拼錯**：查不到的 mood 字符串 fallback 到 neutral (0, 0)，
 *    不會拋錯。
 */

import type { MemoryNode } from './types';

/** 情感座標：效價 × 喚醒度 */
export interface EmotionVA {
    /** -1 極痛苦 → +1 極愉悅 */
    v: number;
    /** -1 極平靜 → +1 極激烈 */
    a: number;
}

/**
 * 常見情緒標籤 → (valence, arousal) 映射
 *
 * 覆蓋：
 * - extraction.ts prompt 裡列出的 12 種 mood
 * - digestion.ts / anticipation.ts 硬編碼產出的 mood
 * - 常見中文標籤（兼容 LLM 吐中文的情況）
 *
 * 沒覆蓋的字符串在 getEmotionVA() 裡會 fallback 到 neutral (0, 0)。
 */
export const MOOD_TO_VA: Record<string, EmotionVA> = {
    // ─── extraction.ts 裡定義的 12 種核心 mood ────────
    happy:      { v:  0.7, a:  0.5 },
    sad:        { v: -0.7, a: -0.5 },
    angry:      { v: -0.7, a:  0.8 },
    anxious:    { v: -0.6, a:  0.7 },
    tender:     { v:  0.6, a: -0.2 },
    excited:    { v:  0.8, a:  0.8 },
    peaceful:   { v:  0.5, a: -0.6 },
    confused:   { v: -0.2, a:  0.2 },
    hurt:       { v: -0.7, a:  0.3 },
    grateful:   { v:  0.6, a:  0.3 },
    nostalgic:  { v:  0.2, a: -0.3 },
    neutral:    { v:  0.0, a:  0.0 },

    // ─── 擴展英文標籤（LLM 可能會用） ─────────────
    ecstatic:      { v:  0.9, a:  0.9 },
    joyful:        { v:  0.8, a:  0.6 },
    content:       { v:  0.4, a: -0.4 },
    melancholic:   { v: -0.5, a: -0.4 },
    afraid:        { v: -0.8, a:  0.9 },
    fearful:       { v: -0.8, a:  0.9 },
    disappointed:  { v: -0.6, a: -0.2 },
    lonely:        { v: -0.6, a: -0.3 },
    proud:         { v:  0.7, a:  0.4 },
    curious:       { v:  0.3, a:  0.4 },
    bored:         { v: -0.2, a: -0.7 },
    surprised:     { v:  0.2, a:  0.8 },
    embarrassed:   { v: -0.3, a:  0.5 },
    guilty:        { v: -0.6, a:  0.2 },
    relieved:      { v:  0.5, a: -0.3 },

    // ─── 常見中文標籤（防 LLM 吐中文） ───────────
    開心: { v:  0.7, a:  0.5 },
    難過: { v: -0.7, a: -0.5 },
    悲傷: { v: -0.7, a: -0.5 },
    憤怒: { v: -0.7, a:  0.8 },
    焦慮: { v: -0.6, a:  0.7 },
    溫柔: { v:  0.6, a: -0.2 },
    興奮: { v:  0.8, a:  0.8 },
    平靜: { v:  0.5, a: -0.6 },
    困惑: { v: -0.2, a:  0.2 },
    受傷: { v: -0.7, a:  0.3 },
    感激: { v:  0.6, a:  0.3 },
    懷念: { v:  0.2, a: -0.3 },
    失落: { v: -0.5, a: -0.4 },
    孤獨: { v: -0.6, a: -0.3 },
    中性: { v:  0.0, a:  0.0 },
};

/**
 * 統一讀取接口：先讀節點的 (v, a) 字段，沒有就走查表兜底。
 *
 * 所有下游邏輯（priming / links / digestion）都應通過此函數拿情感座標，
 * 不要自己判斷 node.valence 是否 undefined。
 */
export function getEmotionVA(node: Pick<MemoryNode, 'valence' | 'arousal' | 'mood'>): EmotionVA {
    if (typeof node.valence === 'number' && typeof node.arousal === 'number') {
        return { v: node.valence, a: node.arousal };
    }
    const mood = (node.mood || '').trim();
    if (!mood) return { v: 0, a: 0 };
    return MOOD_TO_VA[mood] ?? MOOD_TO_VA[mood.toLowerCase()] ?? { v: 0, a: 0 };
}

/**
 * 情緒字符串 → (v, a)，用於把運行時的 currentMood 字符串轉為座標。
 * 查不到返回 neutral。
 */
export function moodToVA(mood: string | undefined | null): EmotionVA {
    if (!mood) return { v: 0, a: 0 };
    const key = mood.trim();
    if (!key) return { v: 0, a: 0 };
    return MOOD_TO_VA[key] ?? MOOD_TO_VA[key.toLowerCase()] ?? { v: 0, a: 0 };
}

/**
 * 二維歐氏距離，用於情感相似度判斷。
 * 範圍大致 0 ~ 2.83（兩個極端象限之間），常用閾值 0.3-0.5。
 */
export function emotionDistance(a: EmotionVA, b: EmotionVA): number {
    const dv = a.v - b.v;
    const da = a.a - b.a;
    return Math.hypot(dv, da);
}
