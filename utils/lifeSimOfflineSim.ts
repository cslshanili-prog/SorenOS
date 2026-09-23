/**
 * LifeSim Offline Simulation Engine — 離線模擬引擎
 *
 * When users close the app and come back later, this engine simulates what
 * happened while they were away using NPC autonomous behavior (no LLM calls).
 *
 * Performance target: 48 slots in < 100ms (pure math, no async).
 */

import {
    LifeSimState, SimAction, OfflineRecapEvent, SimEventType, SimEffectCode,
    SimPendingEffect
} from '../types';

import {
    advanceTimeOfDay, settlePendingEffects, advanceTurn, deepClone,
    getNPC, getChaosLabel, getMoodLabel, SEASON_INFO, TIME_INFO
} from './lifeSimEngine';

import { runAutonomousTurn } from './lifeSimAutonomous';
import { evaluateEventChains } from './lifeSimEventChains';
import { includesAnyScript } from './scriptKey';

// ── Narrative template imports (with inline fallbacks) ────────────

let generateEventHeadline: (eventType: SimEventType | SimEffectCode, involvedNames: string[]) => string;
let getNarrativeQuote: (npcName: string, npcEmoji: string, eventType: SimEventType | SimEffectCode) => string;

try {
    const templates = require('./lifeSimNarrativeTemplates');
    generateEventHeadline = templates.generateEventHeadline;
    getNarrativeQuote = templates.getNarrativeQuote;
} catch {
    // Fallback if narrative templates module doesn't exist yet
    generateEventHeadline = (eventType: SimEventType | SimEffectCode, involvedNames: string[]) => {
        const typeLabels: Record<string, string> = {
            fight: '大打出手！',
            party: '歡聚一堂！',
            gossip: '八卦傳開了……',
            romance: '曖昧的氣息……',
            rivalry: '針鋒相對！',
            alliance: '結成同盟！',
            fight_break: '矛盾爆發！',
            mood_drop: '情緒低落',
            relationship_change: '關係變動',
            revenge_plot: '復仇暗湧……',
            love_triangle: '三角戀糾葛！',
            jealousy_spiral: '嫉妒蔓延……',
            family_feud: '家族恩怨！',
            betrayal: '背叛！',
            romantic_confession: '浪漫告白！',
            gossip_wildfire: '流言蜚語如野火！',
            npc_runaway: '有人離家出走了！',
            mood_breakdown: '情緒崩潰！',
            secret_alliance: '暗中結盟……',
            power_shift: '權力更迭！',
            reconciliation: '冰釋前嫌',
        };
        const label = typeLabels[eventType] ?? '發生了一些事...';
        const names = involvedNames.length > 0 ? involvedNames.join('、') : '居民們';
        return `${names}：${label}`;
    };

    getNarrativeQuote = (npcName: string, _npcEmoji: string, eventType: SimEventType | SimEffectCode) => {
        const quotes: Record<string, string> = {
            fight: '哼，別以為這樣就完了！',
            party: '今天玩得真開心~',
            gossip: '你聽說了嗎……',
            romance: '心跳好快……',
            rivalry: '我不會輸給你的！',
            alliance: '以後我們就是一夥的了。',
            revenge_plot: '你等著……',
            love_triangle: '為什麼事情會變成這樣……',
            reconciliation: '算了，握手言和吧。',
            npc_runaway: '我受夠了，我要走！',
        };
        return quotes[eventType] ?? '……';
    };
}

// ── Seeded PRNG for deterministic-ish simulation ──────────────────

function createSeededRng(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) & 0x7fffffff;
        return state / 0x7fffffff;
    };
}

function hashSeed(stateId: string, turnNumber: number): number {
    let hash = 0;
    const str = `${stateId}-${turnNumber}`;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

// ── Chaos threshold tracker ──────────────────────────────────────

const CHAOS_THRESHOLDS = [20, 40, 60, 80];

function getChaosThresholdBand(chaos: number): number {
    for (let i = CHAOS_THRESHOLDS.length - 1; i >= 0; i--) {
        if (chaos >= CHAOS_THRESHOLDS[i]) return CHAOS_THRESHOLDS[i];
    }
    return 0;
}

// ── Helper: convert action to recap event ────────────────────────

function actionToRecap(
    state: LifeSimState,
    action: SimAction,
    prevChaos: number
): OfflineRecapEvent | null {
    // Only include TRIGGER_EVENT and GO_SOLO actions
    if (action.type !== 'TRIGGER_EVENT' && action.type !== 'GO_SOLO') return null;

    // Determine event type from action description heuristics
    let eventType: SimEventType | SimEffectCode = 'fight';
    const desc = action.description;
    if (includesAnyScript(desc, '報復') || includesAnyScript(desc, '仇')) eventType = 'fight';
    else if (includesAnyScript(desc, '曖昧') || includesAnyScript(desc, '浪漫') || includesAnyScript(desc, '告白')) eventType = 'romance';
    else if (includesAnyScript(desc, '流言') || includesAnyScript(desc, '八卦') || includesAnyScript(desc, '散佈')) eventType = 'gossip';
    else if (includesAnyScript(desc, '聚會') || includesAnyScript(desc, '聚') || includesAnyScript(desc, '消遣')) eventType = 'party';
    else if (includesAnyScript(desc, '宣戰') || includesAnyScript(desc, '競爭')) eventType = 'rivalry';
    else if (includesAnyScript(desc, '結盟') || includesAnyScript(desc, '同盟')) eventType = 'alliance';
    else if (includesAnyScript(desc, '離家出走') || includesAnyScript(desc, '離開')) eventType = 'npc_runaway';

    // Find involved NPCs from the action
    const involvedNpcs: { name: string; emoji: string }[] = [];
    for (const npc of state.npcs) {
        if (desc.includes(npc.name) || action.actor === npc.name) {
            involvedNpcs.push({ name: npc.name, emoji: npc.emoji });
        }
    }

    // Primary NPC is the actor
    const primaryNpc = state.npcs.find(n => n.name === action.actor);
    const headline = generateEventHeadline(
        eventType,
        involvedNpcs.map(n => `${n.emoji}${n.name}`)
    );
    const narrativeQuote = primaryNpc
        ? getNarrativeQuote(primaryNpc.name, primaryNpc.emoji, eventType)
        : undefined;

    const chaosChange = state.chaosLevel - prevChaos;

    return {
        day: state.day ?? 1,
        season: state.season ?? 'spring',
        timeOfDay: state.timeOfDay ?? 'morning',
        headline,
        description: action.description + (action.immediateResult ? ` ${action.immediateResult}` : ''),
        involvedNpcs,
        eventType,
        chaosChange: chaosChange !== 0 ? chaosChange : undefined,
        narrativeQuote,
    };
}

// ── Helper: convert settled effect to recap event ────────────────

function effectToRecap(
    state: LifeSimState,
    effect: SimPendingEffect,
    prevChaos: number
): OfflineRecapEvent | null {
    const involvedNpcs: { name: string; emoji: string }[] = [];
    const involvedIds = effect.involvedNpcIds ?? [];
    if (effect.npcId && !involvedIds.includes(effect.npcId)) {
        involvedIds.unshift(effect.npcId);
    }

    for (const id of involvedIds) {
        const npc = getNPC(state, id);
        if (npc) {
            involvedNpcs.push({ name: npc.name, emoji: npc.emoji });
        }
    }

    const primaryNpc = involvedIds.length > 0 ? getNPC(state, involvedIds[0]) : undefined;
    const headline = generateEventHeadline(
        effect.effectCode,
        involvedNpcs.map(n => `${n.emoji}${n.name}`)
    );
    const narrativeQuote = primaryNpc
        ? getNarrativeQuote(primaryNpc.name, primaryNpc.emoji, effect.effectCode)
        : undefined;

    const chaosChange = state.chaosLevel - prevChaos;

    return {
        day: state.day ?? 1,
        season: state.season ?? 'spring',
        timeOfDay: state.timeOfDay ?? 'morning',
        headline,
        description: effect.description,
        involvedNpcs,
        eventType: effect.effectCode,
        chaosChange: chaosChange !== 0 ? chaosChange : undefined,
        narrativeQuote,
    };
}

// ── Helper: festival recap event ─────────────────────────────────

function festivalToRecap(
    state: LifeSimState,
    festivalName: string,
    festivalEmoji: string,
    festivalDesc: string
): OfflineRecapEvent {
    return {
        day: state.day ?? 1,
        season: state.season ?? 'spring',
        timeOfDay: state.timeOfDay ?? 'morning',
        headline: `${festivalEmoji} ${festivalName}`,
        description: festivalDesc,
        involvedNpcs: [],
        eventType: 'party', // festivals are party-like
    };
}

// ── Helper: season change recap event ────────────────────────────

function seasonChangeToRecap(state: LifeSimState): OfflineRecapEvent {
    const season = state.season ?? 'spring';
    const si = SEASON_INFO[season];
    return {
        day: state.day ?? 1,
        season,
        timeOfDay: state.timeOfDay ?? 'morning',
        headline: `${si.emoji} 季節交替——${si.zh}季到來`,
        description: `世界迎來了${si.zh}季，萬物煥然一新。`,
        involvedNpcs: [],
        eventType: 'party',
    };
}

// ── Main export: simulate offline turns ──────────────────────────

export function simulateOfflineTurns(
    state: LifeSimState,
    elapsedMs: number
): { newState: LifeSimState; recap: OfflineRecapEvent[] } {
    let s = deepClone(state);
    const recap: OfflineRecapEvent[] = [];

    // 1. Calculate number of time slots
    const rawSlots = Math.floor(elapsedMs / (30 * 60 * 1000)); // 1 slot per 30 min
    let slots = Math.min(rawSlots, 48); // cap at 48 (24h)
    if (slots === 0 && elapsedMs > 5 * 60 * 1000) {
        slots = 1; // minimum 1 slot if > 5 minutes
    }
    if (slots === 0) {
        return { newState: s, recap };
    }

    // Seed the PRNG from state id + turn number for deterministic-ish results
    const rng = createSeededRng(hashSeed(s.id, s.turnNumber));

    // Override Math.random temporarily for deterministic simulation
    const originalRandom = Math.random;
    Math.random = rng;

    try {
        // Track starting chaos for threshold crossing detection
        let prevChaosBand = getChaosThresholdBand(s.chaosLevel);

        for (let slot = 0; slot < slots; slot++) {
            // Bail early if no NPCs remain
            if (s.npcs.length === 0) {
                break;
            }

            // Bail early if game is over
            if (s.gameOver) {
                break;
            }

            const prevChaos = s.chaosLevel;

            // (a) Advance time of day
            const timeResult = advanceTimeOfDay(s);
            s = timeResult.newState;

            // Check for festival
            if (timeResult.festival) {
                recap.push(festivalToRecap(
                    s,
                    timeResult.festival.name,
                    timeResult.festival.emoji,
                    timeResult.festival.description
                ));
            }

            // Check for season change
            if (timeResult.newSeason) {
                recap.push(seasonChangeToRecap(s));
            }

            // (b) Run autonomous NPC turn
            const autoResult = runAutonomousTurn(s);
            s = autoResult.newState;

            // Collect pending effects before this slot's effects
            const pendingBefore = new Set(s.pendingEffects.map(e => e.id));

            // (c) For TRIGGER_EVENT actions, evaluate event chains
            for (const action of autoResult.events) {
                if (action.type === 'TRIGGER_EVENT') {
                    // Infer event type from description for chain evaluation
                    let evtType: SimEventType = 'fight';
                    const d = action.description;
                    if (includesAnyScript(d, '曖昧') || includesAnyScript(d, '浪漫')) evtType = 'romance';
                    else if (includesAnyScript(d, '八卦') || includesAnyScript(d, '流言')) evtType = 'gossip';
                    else if (includesAnyScript(d, '聚會') || includesAnyScript(d, '消遣')) evtType = 'party';
                    else if (includesAnyScript(d, '宣戰') || includesAnyScript(d, '競爭')) evtType = 'rivalry';
                    else if (includesAnyScript(d, '結盟')) evtType = 'alliance';
                    else if (includesAnyScript(d, '報復') || includesAnyScript(d, '打') || includesAnyScript(d, '吵')) evtType = 'fight';

                    // Find involved NPC IDs from the description
                    const involvedIds: string[] = [];
                    for (const npc of s.npcs) {
                        if (d.includes(npc.name)) {
                            involvedIds.push(npc.id);
                        }
                    }

                    const chainEffects = evaluateEventChains(s, evtType, involvedIds);
                    for (const eff of chainEffects) {
                        s.pendingEffects.push(eff);
                    }
                }

                // Convert significant actions to recap
                const recapEvent = actionToRecap(s, action, prevChaos);
                if (recapEvent) {
                    recap.push(recapEvent);
                }
            }

            // (d) Settle pending effects
            const settledEffectsBefore = [...s.pendingEffects];
            const settleResult = settlePendingEffects(s);
            s = settleResult.newState;

            // Identify which effects were resolved (no longer in pending list)
            const pendingAfter = new Set(s.pendingEffects.map(e => e.id));
            for (const eff of settledEffectsBefore) {
                if (!pendingAfter.has(eff.id) && !pendingBefore.has(eff.id)) {
                    // This was a newly added effect that resolved immediately — skip
                    continue;
                }
                if (!pendingAfter.has(eff.id) && pendingBefore.has(eff.id)) {
                    // This effect was resolved
                    const recapEvent = effectToRecap(s, eff, prevChaos);
                    if (recapEvent) {
                        recap.push(recapEvent);
                    }
                }
            }

            // (e) Advance turn counter
            s = advanceTurn(s);

            // (f) Check chaos threshold crossing
            const currentChaosBand = getChaosThresholdBand(s.chaosLevel);
            if (currentChaosBand !== prevChaosBand) {
                const chaosInfo = getChaosLabel(s.chaosLevel);
                recap.push({
                    day: s.day ?? 1,
                    season: s.season ?? 'spring',
                    timeOfDay: s.timeOfDay ?? 'morning',
                    headline: `混亂度升級：${chaosInfo.label}`,
                    description: `城市的Drama指數已經達到${s.chaosLevel}——${chaosInfo.label}！`,
                    involvedNpcs: [],
                    eventType: 'fight', // chaos escalation is conflict-like
                    chaosChange: s.chaosLevel - prevChaos,
                });
                prevChaosBand = currentChaosBand;
            }

            // Check for NPC runaways (NPCs that lost their familyId)
            // This is already captured through GO_SOLO actions in autoResult.events

            // Update last active timestamp for this slot
            s.lastActiveTimestamp = Date.now();
        }
    } finally {
        // Restore original Math.random
        Math.random = originalRandom;
    }

    return { newState: s, recap };
}

// ── Utility: should we run offline simulation? ───────────────────

export function shouldSimulateOffline(state: LifeSimState): boolean {
    if (!state.lastActiveTimestamp) return false;
    const elapsed = Date.now() - state.lastActiveTimestamp;
    return elapsed > 5 * 60 * 1000; // > 5 minutes
}

// ── Utility: human-readable elapsed time description ─────────────

export function getElapsedDescription(elapsedMs: number): string {
    const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
    const minutes = Math.floor((elapsedMs % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}小時${minutes > 0 ? minutes + '分鐘' : ''}`;
    return `${minutes}分鐘`;
}
