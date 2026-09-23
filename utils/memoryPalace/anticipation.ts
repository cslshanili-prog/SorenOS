/**
 * Memory Palace — 期盼生命週期 (Anticipation Lifecycle)
 *
 * 窗台上的期盼經歷以下狀態流轉：
 * - active → 7 天后變成 anchor（人生錨點）
 * - fulfilled → 轉化為臥室的溫暖記憶
 * - disappointed → 沉入閣樓成為未解心結
 */

import type { Anticipation, MemoryNode } from './types';
import { AnticipationDB, MemoryNodeDB } from './db';

const ANCHOR_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 處理期盼生命週期
 *
 * 定期調用（建議每次聊天后或每小時調用一次）
 * - active 且 age > 7 天 → 變為 anchor
 */
export async function processAnticipationLifecycle(charId: string): Promise<void> {
    const now = Date.now();
    const activeAnts = await AnticipationDB.getByStatus(charId, 'active');

    for (const ant of activeAnts) {
        if (now - ant.createdAt >= ANCHOR_THRESHOLD_MS) {
            ant.status = 'anchor';
            ant.anchoredAt = now;
            await AnticipationDB.save(ant);
            console.log(`🔒 [Anticipation] Anchored: "${ant.content.slice(0, 30)}..."`);
        }
    }
}

/**
 * 標記期盼為已實現 → 轉化為臥室溫暖記憶
 */
export async function fulfillAnticipation(id: string): Promise<void> {
    const ant = await AnticipationDB.getById(id);
    if (!ant) return;

    ant.status = 'fulfilled';
    ant.resolvedAt = Date.now();
    await AnticipationDB.save(ant);

    // 創建一條溫暖的臥室記憶
    const warmMemory: MemoryNode = {
        id: generateId(),
        charId: ant.charId,
        content: `我曾經期盼的事情實現了：${ant.content}`,
        room: 'bedroom',
        tags: ['期盼實現', '溫暖'],
        importance: 7,
        mood: 'grateful',
        embedded: false, // 等後續向量化
        boxId: '',
        boxTopic: '期盼實現',
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
    };

    await MemoryNodeDB.save(warmMemory);
    console.log(`✨ [Anticipation] Fulfilled → bedroom: "${ant.content.slice(0, 30)}..."`);
}

/**
 * 標記期盼為落空 → 沉入閣樓
 */
export async function disappointAnticipation(id: string): Promise<void> {
    const ant = await AnticipationDB.getById(id);
    if (!ant) return;

    ant.status = 'disappointed';
    ant.resolvedAt = Date.now();
    await AnticipationDB.save(ant);

    // 創建一條閣樓記憶（未解心結）
    const heartknot: MemoryNode = {
        id: generateId(),
        charId: ant.charId,
        content: `我曾經期盼但最終落空了：${ant.content}`,
        room: 'attic',
        tags: ['期盼落空', '遺憾'],
        importance: 6,
        mood: 'sad',
        embedded: false,
        boxId: '',
        boxTopic: '期盼落空',
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
    };

    await MemoryNodeDB.save(heartknot);
    console.log(`💔 [Anticipation] Disappointed → attic: "${ant.content.slice(0, 30)}..."`);
}

/**
 * 創建新期盼
 */
export async function createAnticipation(charId: string, content: string): Promise<Anticipation> {
    const ant: Anticipation = {
        id: `ant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        charId,
        content,
        status: 'active',
        createdAt: Date.now(),
        anchoredAt: null,
        resolvedAt: null,
    };

    await AnticipationDB.save(ant);
    console.log(`🌟 [Anticipation] Created: "${content.slice(0, 30)}..."`);
    return ant;
}
