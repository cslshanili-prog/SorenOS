/**
 * Memory Palace — EventBox 創建/合併/管理
 *
 * EventBox 把"同一件事"的多條記憶綁在一起。
 * 創建源：
 *  ① extraction LLM 輸出 relatedTo + eventName/eventTags 時（自動）
 *  ② 用戶在 UI 裡"+ 添加關聯"（手動）
 *
 * 召回時一旦命中盒內任一活節點，整盒（summary + 所有活節點）作為 1 個名額輸出。
 * 見 ./formatter.ts 的 expandAndFormat。
 *
 * 壓縮邏輯獨立在 ./eventBoxCompression.ts。
 */

import type { EventBox, MemoryNode } from './types';
import { EVENT_BOX_LIVE_HARD_CAP } from './types';
import type { EventBoxHint } from './extraction';
import { EventBoxDB, MemoryNodeDB } from './db';

// ─── ID 生成 ───────────────────────────────────────────

function generateBoxId(): string {
    return `eb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 內部 helpers ──────────────────────────────────────

function newEventBox(charId: string, name: string, tags: string[]): EventBox {
    const now = Date.now();
    return {
        id: generateBoxId(),
        charId,
        name: name || '未命名事件',
        tags: tags.slice(0, 20),
        summaryNodeId: null,
        liveMemoryIds: [],
        archivedMemoryIds: [],
        compressionCount: 0,
        createdAt: now,
        updatedAt: now,
        lastCompressedAt: null,
    };
}

/**
 * 把一組 memoryId 加入 box。會更新對應 MemoryNode.eventBoxId 並保存。
 * 已在 box 內（live 或 archived）的 ID 自動跳過。
 * 返回真實新增的 memoryId 列表。
 */
async function addMemoriesToBox(box: EventBox, memoryIds: string[]): Promise<string[]> {
    const inBox = new Set([...box.liveMemoryIds, ...box.archivedMemoryIds]);
    if (box.summaryNodeId) inBox.add(box.summaryNodeId);

    const newIds = memoryIds.filter(id => !inBox.has(id));
    if (newIds.length === 0) return [];

    for (const id of newIds) {
        const node = await MemoryNodeDB.getById(id);
        if (!node) continue;
        // 跳過已被其他 box 佔用的（理論上調用方應已處理跨 box）
        if (node.eventBoxId && node.eventBoxId !== box.id) continue;
        node.eventBoxId = box.id;
        // 加入活池前確保不是 archived/summary 狀態
        if (!node.isBoxSummary && !node.archived) {
            box.liveMemoryIds.push(id);
        } else if (node.archived) {
            box.archivedMemoryIds.push(id);
        }
        // summary 節點不加任何池（summaryNodeId 單獨管理）
        await MemoryNodeDB.save(node);
    }

    box.updatedAt = Date.now();
    await EventBoxDB.save(box);
    return newIds;
}

/**
 * 合併多個 box → 一個主 box。
 * 主 box 選取：compressionCount 多者優先，同則 createdAt 早者。
 * 其他 box 的 summaryNode（如有）會被降級為主 box 的活節點（去掉 isBoxSummary 標記）。
 * 返回主 box。
 */
async function mergeBoxes(boxes: EventBox[]): Promise<EventBox> {
    if (boxes.length === 0) throw new Error('mergeBoxes: empty input');
    if (boxes.length === 1) return boxes[0];

    const sorted = [...boxes].sort((a, b) => {
        if (b.compressionCount !== a.compressionCount) return b.compressionCount - a.compressionCount;
        return a.createdAt - b.createdAt;
    });
    const primary = sorted[0];
    const others = sorted.slice(1);

    for (const other of others) {
        // 1. summary 節點：降級為主 box 的活節點
        if (other.summaryNodeId) {
            const sumNode = await MemoryNodeDB.getById(other.summaryNodeId);
            if (sumNode) {
                sumNode.isBoxSummary = false;
                sumNode.archived = false;
                sumNode.eventBoxId = primary.id;
                await MemoryNodeDB.save(sumNode);
                if (!primary.liveMemoryIds.includes(sumNode.id)) {
                    primary.liveMemoryIds.push(sumNode.id);
                }
            }
        }
        // 2. archived 節點
        for (const aId of other.archivedMemoryIds) {
            const n = await MemoryNodeDB.getById(aId);
            if (n) {
                n.eventBoxId = primary.id;
                await MemoryNodeDB.save(n);
            }
            if (!primary.archivedMemoryIds.includes(aId)) {
                primary.archivedMemoryIds.push(aId);
            }
        }
        // 3. live 節點
        for (const lId of other.liveMemoryIds) {
            const n = await MemoryNodeDB.getById(lId);
            if (n) {
                n.eventBoxId = primary.id;
                await MemoryNodeDB.save(n);
            }
            if (!primary.liveMemoryIds.includes(lId)) {
                primary.liveMemoryIds.push(lId);
            }
        }
        // 4. 刪除 secondary
        await EventBoxDB.delete(other.id);
        console.log(`🔀 [EventBox] 合併 ${other.id} → ${primary.id}`);
    }

    // 主 box 保留原 name/tags（不被合併方覆蓋；下次 compression 時 LLM 可重命名）
    primary.updatedAt = Date.now();
    await EventBoxDB.save(primary);
    return primary;
}

// ─── 公共 API ──────────────────────────────────────────

/**
 * 把一批 (newMemory, existingMemory) 關聯整理成 EventBox。
 *
 * 處理規則（按 newMemoryId 分組逐個處理）：
 *  - 收集 newMemory 自身和所有 existingMemory 當前所屬的 box（去重）
 *  - 0 個 box → 用 hint 創建新 box，把 newMemory + 所有 existing 都加進去
 *  - 1 個 box → 加入該 box（缺的成員補齊）
 *  - 2+ 個 box → 合併為 1 個，再加齊成員
 *
 * @returns 被觸達（創建/加入/合併）的 box ID 集合（用於後續壓縮判斷）
 */
export async function bindMemoriesIntoEventBox(
    charId: string,
    links: { newMemoryId: string; existingMemoryId: string }[],
    hints: EventBoxHint[],
): Promise<Set<string>> {
    const touched = new Set<string>();
    if (links.length === 0) return touched;

    // 按 newMemoryId 分組
    const grouped = new Map<string, string[]>();
    for (const { newMemoryId, existingMemoryId } of links) {
        const arr = grouped.get(newMemoryId) || [];
        if (!arr.includes(existingMemoryId)) arr.push(existingMemoryId);
        grouped.set(newMemoryId, arr);
    }

    // 索引 hints
    const hintByNew = new Map<string, EventBoxHint>();
    for (const h of hints) hintByNew.set(h.newMemoryId, h);

    for (const [newId, existingIds] of grouped) {
        const newNode = await MemoryNodeDB.getById(newId);
        if (!newNode) continue;

        // 收集所有相關 box ID（含 newNode 自己的）
        const boxIds = new Set<string>();
        if (newNode.eventBoxId) boxIds.add(newNode.eventBoxId);
        const existingNodes: MemoryNode[] = [];
        for (const eId of existingIds) {
            const n = await MemoryNodeDB.getById(eId);
            if (n) {
                existingNodes.push(n);
                if (n.eventBoxId) boxIds.add(n.eventBoxId);
            }
        }

        // 加載候選 box，區分"可寫（未封盒且未滿活節點硬上限）"和"已封盒/滿員"
        // 活節點硬上限：LLM 壓縮連續失敗會讓盒子無限膨脹到 40+ 條，後果是再也壓不動
        //（token 爆、LLM 卡、UI 凍）。到硬上限就當成封盒處理，後續記憶開新盒。
        const openBoxes: EventBox[] = [];
        const sealedBoxes: EventBox[] = [];
        const overflowBoxes: EventBox[] = [];
        for (const id of boxIds) {
            const b = await EventBoxDB.getById(id);
            if (!b) continue;
            if (b.sealed) sealedBoxes.push(b);
            else if (b.liveMemoryIds.length >= EVENT_BOX_LIVE_HARD_CAP) overflowBoxes.push(b);
            else openBoxes.push(b);
        }

        let target: EventBox;
        if (openBoxes.length === 0) {
            // 全部相關 box 都已封盒/滿員（或本來就沒盒）→ 新建一個盒
            // predecessorBoxId 優先取 sealed，其次 overflow（兩者都算"前任"）
            const hint = hintByNew.get(newId);
            const prevPool = [...sealedBoxes, ...overflowBoxes];
            const predecessor = prevPool.length > 0
                ? prevPool.sort((a, b) => (b.lastCompressedAt || b.updatedAt) - (a.lastCompressedAt || a.updatedAt))[0]
                : null;
            target = newEventBox(
                charId,
                hint?.eventName || (predecessor?.name || ''),
                hint?.eventTags || (predecessor?.tags || []),
            );
            if (predecessor) {
                target.predecessorBoxId = predecessor.id;
                const reason = predecessor.sealed ? '已封盒' : `活節點達硬上限 ${EVENT_BOX_LIVE_HARD_CAP}`;
                console.log(`📦 [EventBox] 前任 ${predecessor.id} ${reason}，${target.id} 作為延續新建`);
            }
            await EventBoxDB.save(target);
            console.log(`📦 [EventBox] 新建 ${target.id} "${target.name}"（${existingNodes.length + 1} 條初始成員）`);
        } else if (openBoxes.length === 1) {
            target = openBoxes[0];
        } else {
            target = await mergeBoxes(openBoxes);
        }

        // 把 newNode + existing 全部加入（existing 裡已在 sealed box 的那些跳過）
        const allIds = [newId, ...existingNodes
            .filter(n => !n.eventBoxId || !sealedBoxes.some(b => b.id === n.eventBoxId))
            .map(n => n.id)];
        await addMemoriesToBox(target, allIds);
        touched.add(target.id);
    }

    return touched;
}

/**
 * 用戶手動把兩條記憶綁成同一個 EventBox（替代舊的 causal MemoryLink 創建）。
 * 一條已在 box → 加入；兩條都沒 box → 建新盒；兩條在不同 box → 合併。
 */
export async function manuallyBindMemories(
    charId: string,
    idA: string,
    idB: string,
    name?: string,
    tags?: string[],
): Promise<EventBox | null> {
    const touched = await bindMemoriesIntoEventBox(
        charId,
        [{ newMemoryId: idA, existingMemoryId: idB }],
        name ? [{ newMemoryId: idA, eventName: name, eventTags: tags || [] }] : [],
    );
    const [boxId] = touched;
    if (!boxId) return null;
    return (await EventBoxDB.getById(boxId)) || null;
}

/**
 * 把一條記憶從某 EventBox 中移出（恢復為獨立記憶）。
 * 用於 UI 的"解除關聯"或"復活歸檔項"場景。
 */
export async function removeMemoryFromBox(memoryId: string): Promise<void> {
    const node = await MemoryNodeDB.getById(memoryId);
    if (!node || !node.eventBoxId) return;
    const box = await EventBoxDB.getById(node.eventBoxId);
    if (!box) {
        node.eventBoxId = null;
        await MemoryNodeDB.save(node);
        return;
    }
    box.liveMemoryIds = box.liveMemoryIds.filter(id => id !== memoryId);
    box.archivedMemoryIds = box.archivedMemoryIds.filter(id => id !== memoryId);
    box.updatedAt = Date.now();
    if (box.summaryNodeId === memoryId) box.summaryNodeId = null;
    node.eventBoxId = null;
    node.archived = false;
    node.isBoxSummary = false;
    await MemoryNodeDB.save(node);

    // 空盒清理
    const empty = box.liveMemoryIds.length === 0
        && box.archivedMemoryIds.length === 0
        && !box.summaryNodeId;
    if (empty) {
        await EventBoxDB.delete(box.id);
    } else {
        await EventBoxDB.save(box);
    }
}

/**
 * 一鍵把某 box 的**所有活節點**移出，變成獨立記憶（archived/summary 不動）。
 * 應急出口：LLM 壓縮連續失敗導致活節點堆到幾十條時，用戶可以一鍵清空活池，
 * 讓那些記憶回到"地上"各自獨立參與召回。
 *
 * 不刪記憶本身。summary / archived 保持不動（它們已經是這段事件的歷史印記）。
 * 如果清完後盒裡啥也沒剩（summary 也沒有），會把空盒刪掉。
 *
 * @returns 被移出的 memoryId 列表
 */
export async function unbindAllLiveMemories(boxId: string): Promise<string[]> {
    const box = await EventBoxDB.getById(boxId);
    if (!box) return [];
    const liveIds = box.liveMemoryIds.slice();
    if (liveIds.length === 0) return [];

    for (const id of liveIds) {
        const node = await MemoryNodeDB.getById(id);
        if (node) {
            node.eventBoxId = null;
            // archived 標記保持不動——活節點理應未歸檔，但保守處理
            await MemoryNodeDB.save(node);
        }
    }

    box.liveMemoryIds = [];
    box.updatedAt = Date.now();

    // 空盒清理：summary 也沒有 && archived 為空 → 刪除
    const empty = !box.summaryNodeId && box.archivedMemoryIds.length === 0;
    if (empty) {
        await EventBoxDB.delete(box.id);
        console.log(`🧹 [EventBox] ${box.id} 活池清空後整盒為空，已刪除`);
    } else {
        await EventBoxDB.save(box);
        console.log(`🧹 [EventBox] ${box.id} 清空活池：移出 ${liveIds.length} 條活節點`);
    }

    return liveIds;
}

/**
 * 復活一條 archived 記憶（重新參與召回）。
 * 不會自動重壓縮，下次 4 條閾值時會再次觸發。
 */
export async function reviveArchivedMemory(memoryId: string): Promise<void> {
    const node = await MemoryNodeDB.getById(memoryId);
    if (!node || !node.archived) return;
    node.archived = false;
    await MemoryNodeDB.save(node);
    if (node.eventBoxId) {
        const box = await EventBoxDB.getById(node.eventBoxId);
        if (box) {
            box.archivedMemoryIds = box.archivedMemoryIds.filter(id => id !== memoryId);
            if (!box.liveMemoryIds.includes(memoryId)) {
                box.liveMemoryIds.push(memoryId);
            }
            box.updatedAt = Date.now();
            await EventBoxDB.save(box);
        }
    }
}
