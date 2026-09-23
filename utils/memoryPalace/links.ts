/**
 * Memory Palace — 關聯網絡 (Memory Links)
 *
 * 記憶之間的五種連接：temporal, emotional, causal, person, metaphor。
 * - temporal / emotional: 自動規則建立
 * - causal / person / metaphor: LLM 判斷（每次封盒時對新記憶 vs Top-5 相似舊記憶做一次批量判斷）
 */

import type { MemoryNode, MemoryLink, LinkType } from './types';
import type { LightLLMConfig } from './pipeline';
import { MemoryLinkDB } from './db';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import { getEmotionVA, emotionDistance } from './emotionSpace';

const TEMPORAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 小時
const CO_ACTIVATION_INCREMENT = 0.05;
const MAX_STRENGTH = 1.0;

// ─── Emotional link 閾值（Russell 情感空間） ─────────
/** 情感距離 < 此值才建 emotional 邊 */
const EMOTIONAL_LINK_DIST = 0.35;
/** 雙方 (v,a) 模長都 < 此值 視為"情緒太弱"，不建邊（避免一堆 neutral 節點互鏈） */
const EMOTIONAL_MIN_MAGNITUDE = 0.2;

/** 判斷一條新-舊節點對是否應建 emotional 邊，以及該給多大 strength */
function emotionalLinkStrength(a: MemoryNode, b: MemoryNode): number {
    const va = getEmotionVA(a);
    const vb = getEmotionVA(b);
    const magA = Math.hypot(va.v, va.a);
    const magB = Math.hypot(vb.v, vb.a);
    if (magA < EMOTIONAL_MIN_MAGNITUDE || magB < EMOTIONAL_MIN_MAGNITUDE) return 0;
    const dist = emotionDistance(va, vb);
    if (dist >= EMOTIONAL_LINK_DIST) return 0;
    // 距離 0 → 0.55；距離 = 閾值 → 0.25。線性。
    return 0.25 + (0.55 - 0.25) * (1 - dist / EMOTIONAL_LINK_DIST);
}

function generateId(): string {
    return `ml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── LLM 關聯判斷 ────────────────────────────────────

/**
 * 一次 LLM 調用，批量判斷所有新記憶和候選舊記憶之間的深層關聯
 */
async function batchClassifyDeepLinks(
    newNodes: MemoryNode[],
    candidates: MemoryNode[],
    llmConfig: LightLLMConfig,
): Promise<{ sourceId: string; targetId: string; type: LinkType; strength: number }[]> {
    if (newNodes.length === 0 || candidates.length === 0) return [];

    const newList = newNodes
        .map((n, i) => `[N${i}] (${n.room}, ${n.mood}): ${n.content.slice(0, 80)}`)
        .join('\n');

    const oldList = candidates
        .map((c, i) => `[O${i}] (${c.room}, ${c.mood}): ${c.content.slice(0, 80)}`)
        .join('\n');

    const prompt = `你是一個記憶關聯分析器。給你一組新記憶 [N*] 和一組舊記憶 [O*]，找出它們之間的深層關聯。

三種關聯類型：
- causal: 因果關係（一件事導致了另一件事）
- person: 提到了同一個人
- metaphor: 隱喻/類比（不同事件但有相似的情感模式）

只輸出存在關聯的配對。嚴格 JSON 數組格式：
[{"from": "N0", "to": "O2", "type": "person", "strength": 0.6}]

strength 範圍 0.3-0.8。沒有關聯返回 []。只輸出 JSON。`;

    const userMsg = `新記憶：\n${newList}\n\n舊記憶：\n${oldList}`;

    try {
        const data = await safeFetchJson(
            `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: llmConfig.model,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: userMsg },
                    ],
                    temperature: 0.2,
                    max_tokens: 800,
                    stream: false,
                }),
            },
            2, 90_000, { appName: '記憶宮殿', purpose: '記憶關聯' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);
        const validTypes: LinkType[] = ['causal', 'person', 'metaphor'];

        return parsed
            .filter(item => {
                const fromIdx = parseInt(item.from?.replace('N', '') || '-1', 10);
                const toIdx = parseInt(item.to?.replace('O', '') || '-1', 10);
                return fromIdx >= 0 && fromIdx < newNodes.length &&
                       toIdx >= 0 && toIdx < candidates.length &&
                       validTypes.includes(item.type as LinkType);
            })
            .map(item => ({
                sourceId: newNodes[parseInt(item.from.replace('N', ''), 10)].id,
                targetId: candidates[parseInt(item.to.replace('O', ''), 10)].id,
                type: item.type as LinkType,
                strength: Math.max(0.3, Math.min(0.8, item.strength || 0.5)),
            }));

    } catch (err: any) {
        console.warn('⚡ [Links] Batch deep link classification failed:', err.message);
        return [];
    }
}

// ─── 主函數 ──────────────────────────────────────────

/**
 * 為新記憶節點建立關聯
 *
 * 三層：
 * 1. temporal — 24h 內 / 同 box 自動建鏈
 * 2. emotional — 相同 mood 自動建鏈
 * 3. causal / person / metaphor — LLM 判斷（如果提供了 llmConfig）
 *
 * @param llmConfig 可選。傳入則啟用 LLM 深層關聯判斷。
 */
export async function buildLinks(
    newNodes: MemoryNode[],
    existingNodes: MemoryNode[],
    llmConfig?: LightLLMConfig | null,
): Promise<MemoryLink[]> {
    const links: MemoryLink[] = [];
    const linkSet = new Set<string>();

    for (const newNode of newNodes) {
        // ─── 自動規則關聯 ─────────────────────────

        for (const existing of existingNodes) {
            if (newNode.id === existing.id) continue;

            // 1. Temporal: 24h 內創建
            if (Math.abs(newNode.createdAt - existing.createdAt) < TEMPORAL_WINDOW_MS) {
                const key = makeKey(newNode.id, existing.id, 'temporal');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, existing.id, 'temporal', 0.3));
                    linkSet.add(key);
                }
            }

            // 2. Emotional: Russell 情感空間距離 < 0.35，strength 隨距離線性縮放
            const emoStrength = emotionalLinkStrength(newNode, existing);
            if (emoStrength > 0) {
                const key = makeKey(newNode.id, existing.id, 'emotional');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, existing.id, 'emotional', emoStrength));
                    linkSet.add(key);
                }
            }
        }

        // 同批次內的節點
        for (const other of newNodes) {
            if (newNode.id === other.id) continue;

            if (newNode.boxId === other.boxId) {
                const key = makeKey(newNode.id, other.id, 'temporal');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, other.id, 'temporal', 0.5));
                    linkSet.add(key);
                }
            }

            const emoStrength = emotionalLinkStrength(newNode, other);
            if (emoStrength > 0) {
                const key = makeKey(newNode.id, other.id, 'emotional');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, other.id, 'emotional', emoStrength));
                    linkSet.add(key);
                }
            }
        }

    }

    // ─── LLM 深層關聯（causal / person / metaphor）── 一次調用處理所有新節點

    if (llmConfig && existingNodes.length > 0 && newNodes.length > 0) {
        const candidates = existingNodes
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 8); // 最近 8 條舊記憶作為候選

        if (candidates.length > 0) {
            const deepLinks = await batchClassifyDeepLinks(newNodes, candidates, llmConfig);

            for (const dl of deepLinks) {
                const key = makeKey(dl.sourceId, dl.targetId, dl.type);
                if (!linkSet.has(key)) {
                    links.push(createLink(dl.sourceId, dl.targetId, dl.type, dl.strength));
                    linkSet.add(key);
                }
            }
        }
    }

    // 批量保存
    if (links.length > 0) {
        await MemoryLinkDB.saveMany(links);
        console.log(`🔗 [Links] Created ${links.length} links (temporal/emotional: auto, causal/person/metaphor: ${llmConfig ? 'LLM' : 'skipped'})`);
    }

    return links;
}

/**
 * 共同激活：當多條記憶同時被檢索命中時，加強它們之間的關聯
 */
export async function strengthenCoActivated(nodeIds: string[]): Promise<void> {
    if (nodeIds.length < 2) return;

    for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
            const links = await MemoryLinkDB.getBySourceId(nodeIds[i]);
            const existingLink = links.find(l => l.targetId === nodeIds[j]);

            if (existingLink) {
                existingLink.strength = Math.min(
                    MAX_STRENGTH,
                    existingLink.strength + CO_ACTIVATION_INCREMENT
                );
                await MemoryLinkDB.save(existingLink);
            }
            else {
                const reverseLinks = await MemoryLinkDB.getBySourceId(nodeIds[j]);
                const reverseLink = reverseLinks.find(l => l.targetId === nodeIds[i]);
                if (reverseLink) {
                    reverseLink.strength = Math.min(
                        MAX_STRENGTH,
                        reverseLink.strength + CO_ACTIVATION_INCREMENT
                    );
                    await MemoryLinkDB.save(reverseLink);
                }
                else {
                    const link = createLink(nodeIds[i], nodeIds[j], 'temporal', CO_ACTIVATION_INCREMENT);
                    await MemoryLinkDB.save(link);
                }
            }
        }
    }
}

// ─── 工具函數 ──────────────────────────────────────────

function createLink(sourceId: string, targetId: string, type: LinkType, strength: number): MemoryLink {
    return {
        id: generateId(),
        sourceId,
        targetId,
        type,
        strength,
    };
}

/** 生成去重 key（確保 A-B 和 B-A 視為同一對） */
function makeKey(id1: string, id2: string, type: string): string {
    const [a, b] = id1 < id2 ? [id1, id2] : [id2, id1];
    return `${a}-${b}-${type}`;
}
