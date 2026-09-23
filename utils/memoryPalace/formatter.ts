/**
 * Memory Palace — 召回結果格式化（EventBox 感知）
 *
 * 輸入：hybridSearch + spreadActivation 後排序好的 ScoredMemory[]
 * 輸出：注入 system prompt 的 markdown 文本
 *
 * 關鍵規則：
 *  - 命中盒內任一活節點 → 整盒（summary + 所有活節點）作為 1 個名額
 *  - 命中獨立記憶（無 eventBoxId）→ 1 個名額
 *  - 同一 box 多次命中只算 1 次（按 box id 去重）
 *  - 總名額上限 MAX_OUTPUT_ITEMS（默認 15）
 *  - 便利貼置頂不佔名額
 */

import type { Anticipation, EventBox, MemoryNode, ScoredMemory } from './types';
import { ROOM_CONFIGS, getRoomLabel } from './types';
import { MemoryNodeDB, EventBoxDB } from './db';
import { recordRecallReceipt } from './recallReceipts';
import { formatMemoryDateWithDistance } from './memoryDate';
import { memoryContentWithDates } from './relativeTime';

const DEFAULT_MAX_OUTPUT_ITEMS = 15;
const MAX_LIVE_NODES_PER_BOX = 8; // 單盒最多展開多少條活節點（防止超大盒汙染）

interface RenderItem {
    /** 精確信號命中項在普通 score 排序前保底進入。 */
    guaranteed: boolean;
    /** 用於排序：取該 item 內最高的 finalScore */
    score: number;
    /** 用於按房間分組的代表房間 */
    room: string;
    /** 渲染好的內容文本塊（不含 room 頭） */
    body: string;
    /** 創建時間（用於次級排序） */
    createdAt: number;
    /** 重要性（用於次級排序） */
    importance: number;
    /** 調試日誌用 */
    debugLabel: string;
    /** 實際落到 prompt 裡的 memoryId 列表（事件盒會展開成 summary + 活節點） */
    sourceIds: string[];
}

/**
 * 話題盒展開 + 格式化為 Markdown
 *
 * 1. 加載便利貼置頂（不佔 15 條名額）
 * 2. 把 ScoredMemory 按 eventBoxId 去重分組：
 *    - 命中帶 eventBoxId 的記憶 → 整盒展開（summary + 活節點）
 *    - 獨立記憶 → 單條展開
 * 3. 佔用 MAX_OUTPUT_ITEMS 個名額，按 score 排序後按房間渲染
 */
export async function expandAndFormat(
    results: ScoredMemory[],
    charId: string,
    anticipations: Anticipation[] = [],
    userName?: string,
    /** 注入上限。rerank 啟用時傳 15 + topN，讓 rerank 額外召回的不被切。 */
    maxOutputItems: number = DEFAULT_MAX_OUTPUT_ITEMS,
): Promise<string> {
    const MAX_OUTPUT_ITEMS = maxOutputItems;
    // 0. 加載便利貼置頂記憶（pinnedUntil > now，不佔 15 條名額）
    const now = Date.now();
    const allCharNodes = await MemoryNodeDB.getByCharId(charId);
    const pinnedNodes = allCharNodes.filter(n => n.pinnedUntil && n.pinnedUntil > now && !n.archived);
    const pinnedIds = new Set(pinnedNodes.map(n => n.id));

    if (results.length === 0 && anticipations.length === 0 && pinnedNodes.length === 0) return '';

    // 1. 按 eventBoxId 去重分組（同一 box 多次命中合併；保留命中裡最高分作 box 分）
    //    boxItem: { boxId, topScore, hitNodeIds[] }
    const boxHits = new Map<string, { topScore: number; hitNodeIds: Set<string>; sample: ScoredMemory; guaranteed: boolean }>();
    const standaloneItems: ScoredMemory[] = [];

    for (const r of results) {
        if (pinnedIds.has(r.node.id)) continue; // 已置頂不再下沉到列表裡
        if (r.node.archived) continue;          // 防禦：理論上 archived 不會到這裡

        const ebId = r.node.eventBoxId;
        if (ebId) {
            const cur = boxHits.get(ebId);
            if (!cur) {
                boxHits.set(ebId, {
                    topScore: r.finalScore,
                    hitNodeIds: new Set([r.node.id]),
                    sample: r,
                    guaranteed: r.recallGuarantee === 'explicit_entity',
                });
            } else {
                if (r.finalScore > cur.topScore) cur.topScore = r.finalScore;
                cur.hitNodeIds.add(r.node.id);
                if (r.recallGuarantee === 'explicit_entity') cur.guaranteed = true;
            }
        } else {
            standaloneItems.push(r);
        }
    }

    // 2. 加載所有 box 的完整內容
    const renderItems: RenderItem[] = [];
    const localNodeMap = new Map(allCharNodes.map(n => [n.id, n]));

    for (const [boxId, hit] of boxHits) {
        const box = await EventBoxDB.getById(boxId);
        if (!box) {
            // box 丟失 → 退化為單條命中
            renderItems.push(buildStandaloneItem(hit.sample, now));
            continue;
        }
        const item = await buildBoxItem(box, hit.topScore, localNodeMap, now, hit.guaranteed);
        if (item) renderItems.push(item);
    }

    for (const r of standaloneItems) {
        renderItems.push(buildStandaloneItem(r, now));
    }

    // 3. 排序（finalScore 降序，同分時較新者優先）+ 截斷到 MAX_OUTPUT_ITEMS
    renderItems.sort((a, b) => {
        if (a.guaranteed !== b.guaranteed) return a.guaranteed ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return b.createdAt - a.createdAt;
    });
    const finalItems = renderItems.slice(0, MAX_OUTPUT_ITEMS);
    const cutItems = renderItems.slice(MAX_OUTPUT_ITEMS);

    // ── 召回回執：把這次實際注入 prompt 的 memoryId 落到 localStorage ──
    // 用途見 ./recallReceipts.ts。便利貼也算注入（用戶對某條便利貼可能糾正）。
    // 截斷/過期記憶不計入（cut 部分沒進 prompt，pinnedIds 已經過 archived 過濾）。
    try {
        const injectedIds: string[] = [];
        for (const it of finalItems) injectedIds.push(...it.sourceIds);
        for (const id of pinnedIds) injectedIds.push(id);
        recordRecallReceipt(charId, injectedIds);
    } catch (e) {
        // 回執只是 extraction 階段的輔助，寫失敗不影響本次召回輸出
        console.warn('🏰 [MemoryPalace] recordRecallReceipt failed:', e);
    }

    // ─── 調試：打印最終注入 prompt 的完整列表 ─────────────
    //
    // 打開控制台展開這個 group，能看到：
    //  - 每條的 rank / score / 所屬房間 / 完整文字 / 字數
    //  - 是獨立記憶還是事件盒（盒子會打印 summary + 所有活節點完整內容，
    //    驗證盒內成員有沒有真的一起出來）
    //  - 被截斷的 item 也會列出來（標 ✂️），方便判斷是不是應該注入的事件盒被擠掉了
    const finalTotalChars = finalItems.reduce((s, it) => s + it.body.length, 0);
    const pinnedTotalChars = pinnedNodes.reduce((s, n) => s + n.content.length, 0);
    console.groupCollapsed(
        `🏰 [MemoryPalace] 最終注入 prompt：${finalItems.length} 條 · ${finalTotalChars} 字`
        + `（便利貼 ${pinnedNodes.length}/${pinnedTotalChars}字 | 盒子 ${boxHits.size} | 獨立 ${standaloneItems.length}`
        + `${cutItems.length > 0 ? ` | ✂️ cut ${cutItems.length}` : ''}）`
    );
    if (pinnedNodes.length > 0) {
        console.groupCollapsed(`📌 便利貼置頂（不佔 ${MAX_OUTPUT_ITEMS} 條名額）${pinnedNodes.length} 條 · ${pinnedTotalChars} 字`);
        for (const p of pinnedNodes) {
            const daysLeft = Math.ceil((p.pinnedUntil! - now) / (24 * 60 * 60 * 1000));
            console.log(
                `📌 [${p.room}] 剩餘 ${daysLeft} 天 · ${p.content.length} 字\n${p.content}`
            );
        }
        console.groupEnd();
    }
    finalItems.forEach((it, i) => {
        const isBox = it.debugLabel.startsWith('box ');
        const scoreStr = it.score.toFixed(3);
        const chars = it.body.length;
        if (isBox) {
            // 從 boxHits 裡找到具體是哪個盒子 + 命中了幾條
            const boxId = it.debugLabel.slice(4).split(' ')[0];
            const hit = boxHits.get(boxId);
            const hitCount = hit?.hitNodeIds.size ?? 0;
            const meta = it.debugLabel.slice(4 + boxId.length + 1); // "(N live + summary)"
            console.log(
                `#${i + 1} [${it.room}] score=${scoreStr}`
                + ` 📦 ${boxId} ${meta} · 命中 ${hitCount} 條 · ${chars} 字\n${it.body}`
            );
        } else {
            const nodeId = it.debugLabel.slice(4); // "mem xxx" → "xxx"
            console.log(
                `#${i + 1} [${it.room}] score=${scoreStr}`
                + ` 🔹 獨立 ${nodeId} · ${chars} 字\n${it.body}`
            );
        }
    });
    if (cutItems.length > 0) {
        console.groupCollapsed(`✂️ 被截斷的 ${cutItems.length} 條（排在 15 名之外，不注入）`);
        cutItems.forEach((it, i) => {
            console.log(
                `#${MAX_OUTPUT_ITEMS + i + 1} [${it.room}] score=${it.score.toFixed(3)}`
                + ` ${it.debugLabel.startsWith('box ') ? '📦' : '🔹'} ${it.debugLabel} · ${it.body.length} 字`
            );
        });
        console.groupEnd();
    }
    console.groupEnd();

    // 4. 按房間分組渲染
    let output = `### 記憶宮殿 (Memory Palace)\n`;
    output += `以下是你腦海中浮現的相關記憶片段，它們可能影響你此刻的感受和反應：\n\n`;

    // 4a. 便利貼置頂記憶
    if (pinnedNodes.length > 0) {
        output += `📌 **便利貼（近期重要事項）**\n`;
        // 便利貼不佔名額、每輪全量注入，置頂最長 30 天。沒有這句分寸，「記著一件事」
        // 會退化成每段結尾都追問一遍進展、催對方快去辦。同倉庫裡 Notion 筆記塊
        // （chatPrompts 的「不要每次都提」）和用藥提醒（lifeRecords 的「別反覆催」）
        // 早就配了同類措辭，這裡補齊。
        output += `（這些是你這幾天一直記著的事。記著不等於要一直說——話趕到那兒了順口提一句就夠了，沒趕到就讓它待在心裡；同一件事不必每次聊天都追問進展，也不必替 ta 安排什麼時候去做。）\n`;
        for (const node of pinnedNodes) {
            const daysLeft = Math.ceil((node.pinnedUntil! - now) / (24 * 60 * 60 * 1000));
            output += `- [${formatMemoryDateWithDistance(node.createdAt, now)}] ${memoryContentWithDates(node)}（剩餘 ${daysLeft} 天）\n`;
        }
        output += `\n`;
        console.log(`📌 [MemoryPalace] 便利貼置頂 ${pinnedNodes.length} 條`);
    }

    // 按房間分組（保持房間顯示順序：臥室 > 客廳 > 書房 > 用戶房間 > 自我房間 > 閣樓 > 窗台）
    const byRoom = new Map<string, RenderItem[]>();
    for (const it of finalItems) {
        const arr = byRoom.get(it.room) || [];
        arr.push(it);
        byRoom.set(it.room, arr);
    }
    const roomOrder = ['bedroom', 'living_room', 'study', 'user_room', 'self_room', 'attic', 'windowsill'];
    for (const room of roomOrder) {
        const items = byRoom.get(room);
        if (!items || items.length === 0) continue;
        const roomLabel = getRoomLabel(room as any, userName);
        const roomDesc = ROOM_CONFIGS[room as keyof typeof ROOM_CONFIGS]?.description || '';
        for (const it of items) {
            output += `**[${roomLabel} · ${roomDesc}]** ${it.body}\n\n`;
        }
    }

    // 5. 窗台期盼
    const activeAnticipations = anticipations.filter(a => a.status === 'active' || a.status === 'anchor');
    if (activeAnticipations.length > 0) {
        output += `> **窗台期盼**:\n`;
        // 同便利貼：active/anchor 的期盼每輪全量注入，anchor 更是長期掛著。
        output += `> （這是你心裡盼著的事，不是待辦清單。它影響你的心情多過你的話頭，不必每次都提起來。）\n`;
        for (const ant of activeAnticipations) {
            const label = ant.status === 'anchor' ? '🔒 錨點' : '✨ 期盼';
            output += `> - ${label}: ${ant.content}\n`;
        }
        output += `\n`;
    }

    const trimmed = output.trim();
    console.log(`🏰 [MemoryPalace] 本次召回 ${finalItems.length} 條 (${boxHits.size} 個 box + ${standaloneItems.length} 條獨立)，${trimmed.length} 字`);
    return trimmed;
}

// ─── 子渲染：單條獨立記憶 ──────────────────────────────

function buildStandaloneItem(r: ScoredMemory, now: number): RenderItem {
    const node = r.node;
    const date = formatMemoryDateWithDistance(node.createdAt, now);
    const body = `(${date}, 重要性: ${node.importance})\n${memoryContentWithDates(node)}`;
    return {
        guaranteed: r.recallGuarantee === 'explicit_entity',
        score: r.finalScore,
        room: node.room,
        body,
        createdAt: node.createdAt,
        importance: node.importance,
        debugLabel: `mem ${node.id}`,
        sourceIds: [node.id],
    };
}

// ─── 子渲染：整個 EventBox（summary + 活節點） ──────────

async function buildBoxItem(
    box: EventBox,
    topScore: number,
    localNodeMap: Map<string, MemoryNode>,
    now: number,
    guaranteed: boolean = false,
): Promise<RenderItem | null> {
    // 加載 summary（如有）
    let summary: MemoryNode | null = null;
    if (box.summaryNodeId) {
        const s = localNodeMap.get(box.summaryNodeId) || (await MemoryNodeDB.getById(box.summaryNodeId)) || null;
        if (s) summary = s;
    }
    // 加載活節點（按時間升序）
    const liveNodes: MemoryNode[] = [];
    for (const id of box.liveMemoryIds) {
        const n = localNodeMap.get(id) || (await MemoryNodeDB.getById(id));
        if (n && !n.archived) liveNodes.push(n);
    }
    liveNodes.sort((a, b) => a.createdAt - b.createdAt);

    if (!summary && liveNodes.length === 0) return null; // 空盒，跳過

    // 決定房間：summary 優先；否則用最重要的活節點的房間
    const repNode = summary || liveNodes.reduce((acc, n) => (n.importance > acc.importance ? n : acc), liveNodes[0]);
    const room = repNode.room;
    const importance = repNode.importance;
    const createdAt = summary?.createdAt || liveNodes[liveNodes.length - 1]?.createdAt || box.updatedAt;

    // 渲染：盒子標題 + summary（如有）+ 活節點條目
    const liveToShow = liveNodes.slice(0, MAX_LIVE_NODES_PER_BOX);
    const omitted = liveNodes.length - liveToShow.length;

    let body = `📦 **事件盒：${box.name}**`;
    if (box.tags.length > 0) body += `  〈${box.tags.slice(0, 6).join(' · ')}〉`;
    body += '\n';

    if (summary) {
        const sDate = formatMemoryDateWithDistance(summary.createdAt, now);
        body += `_整合回憶_ (${sDate}, 重要性 ${summary.importance}, 已壓縮 ${box.compressionCount} 次)\n`;
        body += `${summary.content}\n`;
    }

    if (liveToShow.length > 0) {
        body += summary ? `_新增片段_：\n` : '';
        for (const n of liveToShow) {
            const d = formatMemoryDateWithDistance(n.createdAt, now);
            body += `- [${d}] ${memoryContentWithDates(n)}\n`;
        }
        if (omitted > 0) body += `（另有 ${omitted} 條同盒活節點未展示）\n`;
    }

    const sourceIds: string[] = [];
    if (summary) sourceIds.push(summary.id);
    for (const n of liveToShow) sourceIds.push(n.id);

    return {
        guaranteed,
        score: topScore,
        room,
        body: body.trimEnd(),
        createdAt,
        importance,
        debugLabel: `box ${box.id} (${liveNodes.length} live${summary ? ' + summary' : ''})`,
        sourceIds,
    };
}
