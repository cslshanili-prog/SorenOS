/**
 * LifeSim Autonomous Behavior System — 都市版
 * 居民自主行為引擎 — 基於性格/心情/關係生成都市Drama事件，無需LLM調用
 */

import { LifeSimState, SimNPC, SimAction, SimEventType, NPCDesire } from '../types';
import { getNPC, getFamily, getFamilyMembers, getIndependentNPCs, getRelationship, clamp, applyTriggerEvent, deepClone } from './lifeSimEngine';
import { equalsAnyScript } from './scriptKey';
// evaluateEventChains will be imported when that module is created
// import { evaluateEventChains } from './lifeSimEventChains';

const genId = () => Math.random().toString(36).slice(2, 10);

// ── Desire Generation ──────────────────────────────────────────

/**
 * 根據NPC當前狀態更新其內驅力列表
 */
function updateDesires(state: LifeSimState, npc: SimNPC): NPCDesire[] {
    const desires: NPCDesire[] = [];
    const grudges = npc.grudges ?? [];
    const crushes = npc.crushes ?? [];

    // 記仇 + 心情差 → 復仇欲
    if (grudges.length > 0 && npc.mood < 0) {
        for (const targetId of grudges) {
            desires.push({ type: 'revenge', targetNpcId: targetId });
        }
    }

    // 關係好 + 沒暗戀對象 → 可能產生曖昧
    if (crushes.length === 0) {
        for (const fam of state.families) {
            if (!fam.memberIds.includes(npc.id)) continue;
            for (const otherId of fam.memberIds) {
                if (otherId === npc.id) continue;
                const rel = getRelationship(fam, npc.id, otherId);
                if (rel > 60 && Math.random() < 0.30) {
                    desires.push({ type: 'romance', targetNpcId: otherId });
                }
            }
        }
    }

    // 心情極差 + 家庭中有討厭的人 → 想離家
    if (npc.mood < -40 && npc.familyId) {
        const fam = getFamily(state, npc.familyId);
        if (fam) {
            for (const otherId of fam.memberIds) {
                if (otherId === npc.id) continue;
                const rel = getRelationship(fam, npc.id, otherId);
                if (rel < -30) {
                    desires.push({ type: 'leave_family' });
                    break; // 只需要一個 leave_family desire
                }
            }
        }
    }

    // 腹黑/聰明 + 關係差 → 搬弄是非
    const isScheming = npc.personality.some(p => equalsAnyScript(p, '腹黑') || equalsAnyScript(p, '聰明'));
    if (isScheming) {
        for (const fam of state.families) {
            if (!fam.memberIds.includes(npc.id)) continue;
            for (const otherId of fam.memberIds) {
                if (otherId === npc.id) continue;
                const rel = getRelationship(fam, npc.id, otherId);
                if (rel < -20 && Math.random() < 0.20) {
                    desires.push({ type: 'gossip_about', targetNpcId: otherId });
                }
            }
        }
    }

    // 熱情/活潑 → 社交
    const isSocial = npc.personality.some(p => equalsAnyScript(p, '熱情') || equalsAnyScript(p, '活潑'));
    if (isSocial && npc.familyId) {
        const fam = getFamily(state, npc.familyId);
        if (fam && fam.memberIds.length > 1 && Math.random() < 0.15) {
            const candidates = fam.memberIds.filter(id => id !== npc.id);
            const targetId = candidates[Math.floor(Math.random() * candidates.length)];
            desires.push({ type: 'socialize', targetNpcId: targetId });
        }
    }

    // 暴躁/衝動 + 心情不好 + 有仇 → 開戰
    const isAggressive = npc.personality.some(p => equalsAnyScript(p, '暴躁') || equalsAnyScript(p, '衝動'));
    if (isAggressive && npc.mood < -10 && grudges.length > 0 && Math.random() < 0.40) {
        for (const targetId of grudges) {
            desires.push({ type: 'start_rivalry', targetNpcId: targetId });
        }
    }

    return desires;
}

// ── Action Generation ──────────────────────────────────────────

interface WeightedAction {
    weight: number;
    execute: () => { eventType: SimEventType; involvedIds: string[]; description: string } | null;
}

/**
 * 為有慾望的NPC生成加權行動列表
 */
function buildActionCandidates(
    state: LifeSimState,
    npc: SimNPC,
    desires: NPCDesire[]
): WeightedAction[] {
    const candidates: WeightedAction[] = [];

    for (const desire of desires) {
        switch (desire.type) {
            case 'revenge': {
                const target = getNPC(state, desire.targetNpcId);
                if (target) {
                    candidates.push({
                        weight: npc.mood < -20 ? 50 : 25,
                        execute: () => ({
                            eventType: 'fight' as SimEventType,
                            involvedIds: [npc.id, desire.targetNpcId],
                            description: `${npc.emoji}${npc.name}忍無可忍，在公寓群裡@了${target.emoji}${target.name}公開撕逼！`,
                        }),
                    });
                }
                break;
            }
            case 'romance': {
                const target = getNPC(state, desire.targetNpcId);
                if (target) {
                    candidates.push({
                        weight: 30,
                        execute: () => ({
                            eventType: 'romance' as SimEventType,
                            involvedIds: [npc.id, desire.targetNpcId],
                            description: `${npc.emoji}${npc.name}在電梯裡"偶遇"了${target.emoji}${target.name}，曖昧值直線飆升……`,
                        }),
                    });
                }
                break;
            }
            case 'leave_family':
                candidates.push({
                    weight: npc.mood < -40 ? 20 : 8,
                    execute: () => null, // GO_SOLO 特殊處理
                });
                break;
            case 'gossip_about': {
                const target = getNPC(state, desire.targetNpcId);
                if (target) {
                    candidates.push({
                        weight: 25,
                        execute: () => ({
                            eventType: 'gossip' as SimEventType,
                            involvedIds: [desire.targetNpcId],
                            description: `${npc.emoji}${npc.name}在小群裡瘋狂輸出關於${target.emoji}${target.name}的八卦……`,
                        }),
                    });
                }
                break;
            }
            case 'socialize': {
                const target = getNPC(state, desire.targetNpcId);
                if (target) {
                    candidates.push({
                        weight: 20,
                        execute: () => ({
                            eventType: 'party' as SimEventType,
                            involvedIds: [npc.id, desire.targetNpcId],
                            description: `${npc.emoji}${npc.name}約${target.emoji}${target.name}去樓下酒吧小酌一杯！`,
                        }),
                    });
                }
                break;
            }
            case 'start_rivalry': {
                const target = getNPC(state, desire.targetNpcId);
                if (target) {
                    candidates.push({
                        weight: 25,
                        execute: () => ({
                            eventType: 'rivalry' as SimEventType,
                            involvedIds: [npc.id, desire.targetNpcId],
                            description: `${npc.emoji}${npc.name}在朋友圈陰陽怪氣了${target.emoji}${target.name}，公開宣戰！`,
                        }),
                    });
                }
                break;
            }
        }
    }

    return candidates;
}

/**
 * 加權隨機選擇
 */
function weightedRandom<T extends { weight: number }>(items: T[]): T | null {
    if (items.length === 0) return null;
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const item of items) {
        roll -= item.weight;
        if (roll <= 0) return item;
    }
    return items[items.length - 1];
}

/**
 * 當NPC沒有匹配的慾望時，生成默認行為
 */
function generateDefaultAction(
    state: LifeSimState,
    npc: SimNPC
): { eventType: SimEventType; involvedIds: string[]; description: string } | null {
    const roll = Math.random();

    // 50% 什麼都不做
    if (roll < 0.50) return null;

    // 30% 隨機和家庭成員聚會
    if (roll < 0.80 && npc.familyId) {
        const fam = getFamily(state, npc.familyId);
        if (fam && fam.memberIds.length > 1) {
            const others = fam.memberIds.filter(id => id !== npc.id);
            const targetId = others[Math.floor(Math.random() * others.length)];
            const target = getNPC(state, targetId);
            if (target) {
                return {
                    eventType: 'party',
                    involvedIds: [npc.id, targetId],
                    description: `${npc.emoji}${npc.name}叫上${target.emoji}${target.name}一起點外賣追劇~`,
                };
            }
        }
    }

    // 20% 隨機八卦
    const allOtherNpcs = state.npcs.filter(n => n.id !== npc.id);
    if (allOtherNpcs.length > 0) {
        const target = allOtherNpcs[Math.floor(Math.random() * allOtherNpcs.length)];
        return {
            eventType: 'gossip',
            involvedIds: [target.id],
            description: `${npc.emoji}${npc.name}在公寓群裡聊起了${target.emoji}${target.name}的私事……`,
        };
    }

    return null;
}

// ── Grudge & Crush Update ──────────────────────────────────────

/**
 * 根據事件類型更新NPC的仇恨和暗戀關係
 */
function updateGrudgesAndCrushes(
    state: LifeSimState,
    actorId: string,
    eventType: SimEventType,
    involvedIds: string[]
): void {
    const actor = state.npcs.find(n => n.id === actorId);
    if (!actor) return;

    if (!actor.grudges) actor.grudges = [];
    if (!actor.crushes) actor.crushes = [];

    switch (eventType) {
        case 'fight': {
            // 打架目標加入仇恨列表
            for (const id of involvedIds) {
                if (id !== actorId && !actor.grudges.includes(id)) {
                    actor.grudges.push(id);
                }
                // 被打的人也記仇
                const target = state.npcs.find(n => n.id === id);
                if (target && target.id !== actorId) {
                    if (!target.grudges) target.grudges = [];
                    if (!target.grudges.includes(actorId)) {
                        target.grudges.push(actorId);
                    }
                }
            }
            break;
        }
        case 'romance': {
            // 曖昧目標加入暗戀列表
            for (const id of involvedIds) {
                if (id !== actorId && !actor.crushes.includes(id)) {
                    actor.crushes.push(id);
                }
            }
            break;
        }
        case 'party': {
            // 聚會 → 原諒仇恨 (通過party化解矛盾)
            for (const id of involvedIds) {
                if (id !== actorId) {
                    actor.grudges = actor.grudges.filter(g => g !== id);
                    // 對方也原諒
                    const other = state.npcs.find(n => n.id === id);
                    if (other && other.grudges) {
                        other.grudges = other.grudges.filter(g => g !== actorId);
                    }
                }
            }
            break;
        }
    }
}

// ── Main Autonomous Turn ───────────────────────────────────────

/**
 * 執行一回合NPC自主行為
 * 遍歷所有NPC（隨機順序），根據性格/慾望/心情概率性生成事件
 */
export function runAutonomousTurn(state: LifeSimState): {
    newState: LifeSimState;
    events: SimAction[];
} {
    let s = deepClone(state);
    const events: SimAction[] = [];

    // 隨機排列NPC順序
    const shuffledNpcs = [...s.npcs].sort(() => Math.random() - 0.5);

    // 基礎行動概率: 25% + chaos/200 (chaos=100時75%)
    const baseProbability = 0.25 + s.chaosLevel / 200;

    for (const npcRef of shuffledNpcs) {
        // 獲取最新版NPC（因為前面的NPC行動可能修改了狀態）
        const npc = s.npcs.find(n => n.id === npcRef.id);
        if (!npc) continue;

        // Step 1: 更新慾望
        npc.desires = updateDesires(s, npc);

        // Step 2: 擲骰決定是否行動
        if (Math.random() > baseProbability) continue;

        // Step 3: 根據慾望生成行動
        const candidates = buildActionCandidates(s, npc, npc.desires);

        let actionResult: { eventType: SimEventType; involvedIds: string[]; description: string } | null = null;
        let isGoSolo = false;

        if (candidates.length > 0) {
            const chosen = weightedRandom(candidates);
            if (chosen) {
                const result = chosen.execute();
                if (result === null) {
                    // GO_SOLO (leave_family)
                    isGoSolo = true;
                } else {
                    actionResult = result;
                }
            }
        } else {
            // 沒有慾望驅動 → 默認行為
            actionResult = generateDefaultAction(s, npc);
        }

        // Step 4: 執行行動
        if (isGoSolo && npc.familyId) {
            // 離家出走
            const oldFamily = getFamily(s, npc.familyId);
            const oldFamilyName = oldFamily?.name ?? '家庭';

            // 從舊家庭移除
            if (oldFamily) {
                oldFamily.memberIds = oldFamily.memberIds.filter(id => id !== npc.id);
                // 清理關係
                delete oldFamily.relationships[npc.id];
                for (const otherId of Object.keys(oldFamily.relationships)) {
                    if (oldFamily.relationships[otherId]) delete oldFamily.relationships[otherId][npc.id];
                }
            }
            npc.familyId = null;

            const action: SimAction = {
                id: genId(),
                turnNumber: s.turnNumber,
                actor: npc.name,
                actorAvatar: npc.emoji,
                actorId: 'autonomous',
                type: 'GO_SOLO',
                description: `${npc.emoji}${npc.name}受夠了${oldFamilyName}的室友，連夜搬走了！`,
                immediateResult: `${npc.name}現在獨居了。`,
                timestamp: Date.now(),
            };
            s.actionLog.push(action);
            events.push(action);

            s.chaosLevel = clamp(s.chaosLevel + 10, 0, 100);
            npc.mood = clamp(npc.mood + 10); // 離開後稍微舒服一點

        } else if (actionResult) {
            // 正常事件
            const { newState, immediateResult } = applyTriggerEvent(
                s,
                actionResult.eventType,
                actionResult.involvedIds,
                actionResult.description
            );
            s = newState;

            const action: SimAction = {
                id: genId(),
                turnNumber: s.turnNumber,
                actor: npc.name,
                actorAvatar: npc.emoji,
                actorId: 'autonomous',
                type: 'TRIGGER_EVENT',
                description: actionResult.description,
                immediateResult,
                timestamp: Date.now(),
            };
            s.actionLog.push(action);
            events.push(action);

            // Step 5: 更新仇恨/暗戀
            updateGrudgesAndCrushes(s, npc.id, actionResult.eventType, actionResult.involvedIds);
        }
        // else: DO_NOTHING — NPC此回合按兵不動
    }

    return { newState: s, events };
}
