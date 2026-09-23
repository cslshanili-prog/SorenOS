/**
 * LifeSim AI Prompts — CHAR決策提示詞
 *
 * 角色們和用戶一起玩模擬人生遊戲，作為"玩家"操控遊戲裡的NPC小人
 */

import { LifeSimState, SimFamily, SimNPC, SimAction, CharacterProfile, UserProfile, SimSeason, CharNarrative, SimEventType, SimStoryAttachmentDraft } from '../types';
import { ContextBuilder } from './context';
import {
    getFamilyMembers, getIndependentNPCs, getMoodLabel, getFamilyAtmosphere,
    SEASON_INFO, TIME_INFO, WEATHER_INFO, getProfessionInfo, getChaosLabel, getRelLabel
} from './lifeSimEngine';

// ── 季節戲劇提示 ────────────────────────────────────────────

function getSeasonDramaHint(season: SimSeason): string {
    switch (season) {
        case 'spring': return '遊戲裡春暖花開，適合搞曖昧和製造新關係';
        case 'summer': return '遊戲裡夏日燥熱，小人們脾氣容易上頭，衝突概率大增';
        case 'fall':   return '遊戲裡秋天EMO季，小人們容易翻舊帳鬧矛盾';
        case 'winter': return '遊戲裡寒冬窩家，八卦和drama是唯一的樂趣';
    }
}

// ── 遊戲狀態序列化 ────────────────────────────────────────────

function serializeWorldContext(state: LifeSimState): string {
    const season = state.season ?? 'spring';
    const si = SEASON_INFO[season];
    const ti = TIME_INFO[state.timeOfDay ?? 'morning'];
    const wi = WEATHER_INFO[state.weather ?? 'sunny'];

    const lines: string[] = [];
    lines.push(`=== 遊戲世界環境 ===`);
    lines.push(`當前時間：第${state.year ?? 1}年 ${si.emoji}${si.zh}季 第${state.day ?? 1}天/28天 ${ti.emoji}${ti.zh}`);
    lines.push(`今日天氣：${wi.emoji}${wi.zh}`);
    lines.push(`季節氛圍：${getSeasonDramaHint(season)}`);
    lines.push('');
    return lines.join('\n');
}

function serializeGameState(state: LifeSimState): string {
    const lines: string[] = [];

    lines.push(`=== 遊戲當前狀態 (第${state.turnNumber}回合) ===`);
    const { label: chaosLabel } = getChaosLabel(state.chaosLevel);
    lines.push(`混亂度: ${state.chaosLevel}/100 (${chaosLabel})`);
    lines.push('');

    // ── 各家庭情況 ──
    lines.push('【遊戲裡各家庭情況】');
    for (const family of state.families) {
        const members = getFamilyMembers(state, family.id);
        if (members.length === 0) {
            lines.push(`${family.emoji} ${family.name}：(無人入住)`);
            continue;
        }
        const atmosphere = getFamilyAtmosphere(state, family.id);
        lines.push(`${family.emoji} ${family.name}（${atmosphere}）`);
        for (const npc of members) {
            const { emoji: moodEmoji } = getMoodLabel(npc.mood);
            lines.push(`  - ${npc.emoji}${npc.name}｜心情:${moodEmoji}(${npc.mood})`);
        }

        // 家庭內關係
        if (members.length >= 2) {
            const relLines: string[] = [];
            for (let i = 0; i < members.length; i++) {
                for (let j = i + 1; j < members.length; j++) {
                    const a = members[i]; const b = members[j];
                    const rel = family.relationships?.[a.id]?.[b.id] ?? 0;
                    const { label: relLabel } = getRelLabel(rel);
                    relLines.push(`    ${a.name}↔${b.name}: ${rel > 0 ? '+' : ''}${rel} (${relLabel})`);
                }
            }
            if (relLines.length > 0) { lines.push('  關係:'); lines.push(...relLines); }
        }
    }
    lines.push('');

    // ── 獨行俠 ──
    const solos = getIndependentNPCs(state);
    if (solos.length > 0) {
        lines.push('【遊戲裡獨居的小人】');
        for (const npc of solos) {
            const { emoji: moodEmoji } = getMoodLabel(npc.mood);
            lines.push(`  ${npc.emoji}${npc.name}｜心情:${moodEmoji}(${npc.mood})`);
        }
        lines.push('');
    }

    // ── 跨家庭關係（仇恨/暗戀）──
    const crossRelLines: string[] = [];
    for (const npc of state.npcs) {
        if (npc.grudges && npc.grudges.length > 0) {
            for (const targetId of npc.grudges) {
                const target = state.npcs.find(n => n.id === targetId);
                if (target) {
                    crossRelLines.push(`  💢 ${npc.emoji}${npc.name} 記恨 ${target.emoji}${target.name}`);
                }
            }
        }
        if (npc.crushes && npc.crushes.length > 0) {
            for (const targetId of npc.crushes) {
                const target = state.npcs.find(n => n.id === targetId);
                if (target) {
                    crossRelLines.push(`  💗 ${npc.emoji}${npc.name} 暗戀 ${target.emoji}${target.name}`);
                }
            }
        }
    }
    if (crossRelLines.length > 0) {
        lines.push('【跨家庭關係】');
        lines.push(...crossRelLines);
        lines.push('');
    }

    // ── 戲劇局勢 ──
    lines.push('【遊戲當前Drama局勢】');

    // 仇恨關係彙總
    const grudgeSummary: string[] = [];
    for (const npc of state.npcs) {
        if (npc.grudges && npc.grudges.length > 0) {
            for (const targetId of npc.grudges) {
                const target = state.npcs.find(n => n.id === targetId);
                if (target) {
                    grudgeSummary.push(`${npc.name} 記恨 ${target.name}`);
                }
            }
        }
    }
    lines.push(`仇恨關係: ${grudgeSummary.length > 0 ? grudgeSummary.join('、') : '暫無'}`);

    // 暗戀關係彙總
    const crushSummary: string[] = [];
    for (const npc of state.npcs) {
        if (npc.crushes && npc.crushes.length > 0) {
            for (const targetId of npc.crushes) {
                const target = state.npcs.find(n => n.id === targetId);
                if (target) {
                    crushSummary.push(`${npc.name} 暗戀 ${target.name}`);
                }
            }
        }
    }
    lines.push(`暗戀關係: ${crushSummary.length > 0 ? crushSummary.join('、') : '暫無'}`);

    // 進行中的事件鏈
    if (state.pendingEffects.length > 0) {
        const effectLines = state.pendingEffects.map(eff =>
            `[${eff.id}] ${eff.description}（將在第${eff.triggerTurn}回合爆發）`
        );
        lines.push(`進行中的事件鏈: ${effectLines.join('；')}`);
    } else {
        lines.push('進行中的事件鏈: 暫無');
    }

    lines.push(`混亂度: ${state.chaosLevel}/100 (${chaosLabel})`);
    lines.push('');

    return lines.join('\n');
}

function serializeActionLog(log: SimAction[], maxEntries = 15): string {
    if (log.length === 0) return '（目前還沒有任何操作記錄）';
    const recent = log.slice(-maxEntries);
    return recent.map(a =>
        `[第${a.turnNumber}回合 | ${a.actor}] ${a.description}\n  → 結果: ${a.immediateResult}`
    ).join('\n\n');
}

// ── 構建CHAR決策Prompt ────────────────────────────────────────

export interface CharDecision {
    action: {
        type: 'ADD_NPC' | 'MOVE_NPC' | 'TRIGGER_EVENT' | 'GO_SOLO' | 'DO_NOTHING';
        newNpcName?: string;
        newNpcEmoji?: string;
        newNpcPersonality?: string[];
        targetFamilyId?: string;
        npcId?: string;
        newFamilyName?: string;
        eventType?: 'fight' | 'party' | 'gossip' | 'romance' | 'rivalry' | 'alliance';
        involvedNpcIds?: string[];
        eventDescription?: string;
    };
    narrative: {
        innerThought: string;
        dialogue: string;
        commentOnWorld: string;
        emotionalTone: 'vengeful' | 'romantic' | 'scheming' | 'chaotic' | 'peaceful' | 'amused' | 'anxious';
    };
    reactionToUser?: string;
    immediateResultHint?: string;
}

/** 將LLM輸出的扁平/嵌套JSON統一規範化為CharDecision格式 */
export function normalizeCharDecision(raw: any): CharDecision {
    if (!raw || typeof raw !== 'object') {
        return { action: { type: 'DO_NOTHING' }, narrative: { innerThought: '', dialogue: '', commentOnWorld: '', emotionalTone: 'peaceful' } };
    }

    // 兼容扁平格式（新）和嵌套格式（舊）
    const hasNestedAction = raw.action && typeof raw.action === 'object' && raw.action.type;
    const actionObj = hasNestedAction ? raw.action : raw;

    const VALID_TYPES = ['ADD_NPC', 'MOVE_NPC', 'TRIGGER_EVENT', 'GO_SOLO', 'DO_NOTHING'];
    const rawType = String(actionObj.type || '').toUpperCase().replace(/[^A-Z_]/g, '_');
    const type = VALID_TYPES.includes(rawType) ? rawType as CharDecision['action']['type'] : 'DO_NOTHING';

    const action: CharDecision['action'] = {
        type,
        newNpcName: actionObj.newNpcName,
        newNpcEmoji: actionObj.newNpcEmoji,
        newNpcPersonality: actionObj.newNpcPersonality,
        targetFamilyId: actionObj.targetFamilyId,
        npcId: actionObj.npcId,
        newFamilyName: actionObj.newFamilyName,
        eventType: actionObj.eventType ? String(actionObj.eventType).toLowerCase() as any : undefined,
        involvedNpcIds: actionObj.involvedNpcIds,
        eventDescription: actionObj.eventDescription,
    };

    // 兼容嵌套 narrative 或扁平字段
    const narr = raw.narrative && typeof raw.narrative === 'object' ? raw.narrative : raw;
    const VALID_TONES = ['vengeful', 'romantic', 'scheming', 'chaotic', 'peaceful', 'amused', 'anxious'];
    const rawTone = String(narr.emotionalTone || narr.tone || 'peaceful').toLowerCase();

    const narrative: CharDecision['narrative'] = {
        innerThought: narr.innerThought || narr.thought || narr.inner_thought || '',
        dialogue: narr.dialogue || narr.dialog || '',
        commentOnWorld: narr.commentOnWorld || narr.comment || '',
        emotionalTone: (VALID_TONES.includes(rawTone) ? rawTone : 'peaceful') as any,
    };

    return {
        action,
        narrative,
        reactionToUser: raw.reactionToUser || raw.reaction || undefined,
        immediateResultHint: raw.immediateResultHint || raw.result || undefined,
    };
}

export interface WorldDramaDecision {
    headline: string;
    eventType: SimEventType;
    involvedNpcIds: string[];
    eventDescription: string;
    immediateResult: string;
    narrative: CharNarrative;
    attachments: SimStoryAttachmentDraft[];
}

const WORLD_EVENT_TYPES: SimEventType[] = ['fight', 'party', 'gossip', 'romance', 'rivalry', 'alliance'];
const WORLD_TONES: CharNarrative['emotionalTone'][] = ['vengeful', 'romantic', 'scheming', 'chaotic', 'peaceful', 'amused', 'anxious'];

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

function fallbackToneForEvent(eventType: SimEventType): CharNarrative['emotionalTone'] {
    switch (eventType) {
        case 'fight': return 'chaotic';
        case 'gossip': return 'scheming';
        case 'romance': return 'romantic';
        case 'rivalry': return 'anxious';
        case 'alliance': return 'amused';
        default: return 'peaceful';
    }
}

function buildFallbackAttachments(
    headline: string,
    eventType: SimEventType,
    involvedNpcs: SimNPC[]
): SimStoryAttachmentDraft[] {
    const npcNames = involvedNpcs.map(npc => npc.name);
    const pair = npcNames.slice(0, 2).join(' / ') || '匿名住戶';
    const attachmentPool: SimStoryAttachmentDraft[] = [
        {
            kind: 'image',
            title: `${headline} 現場圖`,
            summary: `一張帶著都市霓虹感的現場截圖，主角是 ${pair}。`,
            visualPrompt: `${headline}，都市公寓，像素風，霓虹燈，${pair}，dramatic`,
            rarity: 'rare',
        },
        {
            kind: 'evidence',
            title: '匿名聊天記錄',
            summary: `圍觀群眾把這件事總結成了一份聊天截圖，所有人都在偷偷站隊。`,
            detail: `【群聊節選】\n- “這事絕對不簡單。”\n- “${pair} 這次是真的鬧大了。”\n- “我先截圖，等會兒肯定還有後續。”`,
            rarity: 'common',
        },
        {
            kind: 'item',
            title: '劇情掉落物',
            summary: eventType === 'romance'
                ? '一隻被遺落在電梯口的小禮盒，裡面還有沒送出去的心意。'
                : eventType === 'fight'
                ? '衝突現場留下的關鍵道具，像是能繼續引爆後續劇情的火種。'
                : '一件和這場風波有關的私人物件，被圍觀者偷偷保存了下來。',
            detail: eventType === 'romance'
                ? '禮盒裡有一張手寫卡片，只寫了兩個字：“今晚”。'
                : eventType === 'fight'
                ? '道具邊角有明顯磨損，看起來它剛剛見證過一場情緒失控的正面交鋒。'
                : '這件東西本身沒多值錢，但放在此刻，簡直像劇情自帶的伏筆。',
            rarity: 'rare',
        },
    ];

    const fanficAuthor = involvedNpcs.find(npc => npc.profession === 'fanfic_writer');
    if (fanficAuthor) {
        attachmentPool.push({
            kind: 'fanfic',
            title: `${fanficAuthor.name} 的同人文片段`,
            summary: `${fanficAuthor.name} 已經把這場事故寫成了半篇文，標題黨味道很重。`,
            detail: `《${headline}》\n\n${pair} 都知道那扇門一旦關上，今晚就不會再只是一個普通夜晚。\n走廊的燈把影子拉得很長，像所有沒說出口的話都提前站好了位置。\n有人故作冷靜，有人假裝只是路過，可真正滾燙的東西早就在空氣裡炸開。\n等到消息傳進群裡時，整棟樓都明白，這件事已經不可能輕輕放下。`,
            rarity: 'epic',
        });
    } else {
        attachmentPool.push({
            kind: 'fanfic',
            title: '匿名論壇熱帖',
            summary: '圍觀群眾已經把這件事二創成了小短文，傳播速度比真相還快。',
            detail: `《${headline} 二創版》\n\n樓道盡頭的風聲很輕，卻沒能把那句失控的話帶走。\n有人在退後，有人在靠近，而最危險的東西從來不是爭執本身，而是彼此都還沒打算停下。\n當第一張截圖流出去時，這段關係就已經不再只屬於當事人。`,
            rarity: 'rare',
        });
    }

    return attachmentPool.slice(0, 3);
}

export function buildFallbackWorldDramaDecision(state: LifeSimState): WorldDramaDecision {
    const npcs = [...state.npcs];
    const shuffled = npcs.sort(() => Math.random() - 0.5);
    const involved = shuffled.slice(0, Math.min(3, Math.max(2, shuffled.length)));
    const involvedIds = involved.map(npc => npc.id);

    const hasCrush = involved.some(npc => (npc.crushes?.length ?? 0) > 0);
    const hasGrudge = involved.some(npc => (npc.grudges?.length ?? 0) > 0);

    let eventType: SimEventType;
    if (state.chaosLevel > 65 && hasGrudge) eventType = pickRandom(['fight', 'rivalry']);
    else if (hasCrush && Math.random() < 0.5) eventType = 'romance';
    else if (state.chaosLevel > 45) eventType = pickRandom(['gossip', 'alliance', 'rivalry']);
    else eventType = pickRandom(WORLD_EVENT_TYPES);

    const names = involved.map(npc => npc.name);
    const headlineByType: Record<SimEventType, string[]> = {
        fight: ['天台錄音門', '走廊對峙夜', '深夜互撕現場'],
        party: ['臨時派對事故', '屋頂聚會失控', '今晚不準散場'],
        gossip: ['匿名爆料貼', '群聊截圖流出', '八卦在凌晨失火'],
        romance: ['借火誤會', '深夜禮物事件', '電梯裡的曖昧證詞'],
        rivalry: ['雙王不共樓', '互相內涵的一週', '誰才是公寓中心'],
        alliance: ['秘密站隊協議', '地下同盟成立', '交換情報的人'],
    };
    const headline = `${pickRandom(headlineByType[eventType])} · ${names[0] || '住戶'}`;

    const eventDescriptionByType: Record<SimEventType, string> = {
        fight: `${names[0] || '某人'}和${names[1] || '某人'}在公共區域情緒失控，衝突被更多住戶撞見了。`,
        party: `${names[0] || '某人'}臨時攢局，把幾位住戶都捲進了一個看似輕鬆卻暗流湧動的夜晚。`,
        gossip: `一份關於${names[0] || '某人'}的匿名爆料突然在樓裡擴散，越傳越像真的。`,
        romance: `${names[0] || '某人'}和${names[1] || '某人'}之間出現了不再能裝作沒看見的曖昧信號。`,
        rivalry: `${names[0] || '某人'}和${names[1] || '某人'}開始了表面客氣、實則針鋒相對的長期較勁。`,
        alliance: `${names[0] || '某人'}和${names[1] || '某人'}私下交換了立場，準備一起改寫樓裡的局勢。`,
    };

    const narrative: CharNarrative = {
        innerThought: '這一輪不該只是圍觀，應該順手把整條世界線點燃。',
        dialogue: `${headline} 正式開場，${names.join('、')}都已經站到了舞台中央。`,
        commentOnWorld: '主線已經起勢，接下來每個人都會被迫表態。',
        emotionalTone: fallbackToneForEvent(eventType),
    };

    return {
        headline,
        eventType,
        involvedNpcIds: involvedIds,
        eventDescription: eventDescriptionByType[eventType],
        immediateResult: `${headline} 把整棟樓的注意力都拽了過去，新的站隊和誤會正在生成。`,
        narrative,
        attachments: buildFallbackAttachments(headline, eventType, involved),
    };
}

export function normalizeWorldDramaDecision(raw: any): WorldDramaDecision {
    const fallbackNarrative: CharNarrative = {
        innerThought: '',
        dialogue: '',
        commentOnWorld: '',
        emotionalTone: 'scheming',
    };

    if (!raw || typeof raw !== 'object') {
        return {
            headline: '主線劇情',
            eventType: 'gossip',
            involvedNpcIds: [],
            eventDescription: '一段新的都市主線突然開始了。',
            immediateResult: '圍觀情緒迅速升溫。',
            narrative: fallbackNarrative,
            attachments: [],
        };
    }

    const validKinds = new Set(['image', 'item', 'fanfic', 'evidence']);
    const validRarity = new Set(['common', 'rare', 'epic']);
    const rawEventType = typeof raw.eventType === 'string' ? raw.eventType.toLowerCase() : '';
    const eventType = (WORLD_EVENT_TYPES.includes(rawEventType as SimEventType) ? rawEventType : 'gossip') as SimEventType;
    const rawNarrative = raw.narrative && typeof raw.narrative === 'object' ? raw.narrative : raw;
    const rawTone = typeof rawNarrative.emotionalTone === 'string' ? rawNarrative.emotionalTone.toLowerCase() : 'scheming';

    const attachments = Array.isArray(raw.attachments)
        ? raw.attachments
            .filter((item: any) => item && typeof item === 'object')
            .map((item: any): SimStoryAttachmentDraft => ({
                kind: validKinds.has(item.kind) ? item.kind : 'evidence',
                title: String(item.title || '未命名附件').slice(0, 40),
                summary: String(item.summary || item.caption || '沒有留下太多說明。').slice(0, 120),
                detail: typeof item.detail === 'string' ? item.detail : undefined,
                visualPrompt: typeof item.visualPrompt === 'string' ? item.visualPrompt : undefined,
                rarity: validRarity.has(item.rarity) ? item.rarity : 'common',
            }))
        : [];

    return {
        headline: String(raw.headline || raw.title || '主線劇情').slice(0, 40),
        eventType,
        involvedNpcIds: Array.isArray(raw.involvedNpcIds) ? raw.involvedNpcIds.map(String) : [],
        eventDescription: String(raw.eventDescription || raw.description || '一段新的都市主線突然開始了。').slice(0, 120),
        immediateResult: String(raw.immediateResult || raw.result || '圍觀情緒迅速升溫。').slice(0, 160),
        narrative: {
            innerThought: String(rawNarrative.innerThought || rawNarrative.thought || '').slice(0, 120),
            dialogue: String(rawNarrative.dialogue || rawNarrative.scene || '').slice(0, 180),
            commentOnWorld: String(rawNarrative.commentOnWorld || rawNarrative.comment || '').slice(0, 120),
            emotionalTone: (WORLD_TONES.includes(rawTone as CharNarrative['emotionalTone']) ? rawTone : 'scheming') as CharNarrative['emotionalTone'],
        },
        attachments,
    };
}

export function buildWorldDramaPlannerPrompt(
    user: UserProfile,
    state: LifeSimState,
    actionLog: SimAction[]
): string {
    return `
你不是某個角色，也不是玩家。你是這座都市人生小世界的“主線編劇室”。

任務：現在進入非常 drama 的規劃環節，請圍繞 NPC 直接啟動一段新的主線劇情。
規則：
- 這次是“主線劇情”，不是普通旁支，不需要 CHAR 參與。
- 只能使用當前世界裡的 NPC，當事人建議 2-4 個。
- 主線要像連續劇開篇，要有鉤子、誤會、站隊欲，能自然引出後續。
- 不能只寫“發生了什麼”，必須額外掉落 2-3 個附件。
- 附件可從 image / item / fanfic / evidence 裡選擇。
- 如果是 fanfic，detail 裡直接給出正文片段。
- 如果是 image，給 visualPrompt，我會把它做成劇情插圖卡。

${serializeWorldContext(state)}

${serializeGameState(state)}

=== 最近劇情 ===
${serializeActionLog(actionLog, 12)}

${buildAvailableResources(state)}

請只返回 JSON：
{
  "headline": "主線標題，像連續劇小標題",
  "eventType": "fight|party|gossip|romance|rivalry|alliance",
  "involvedNpcIds": ["npc id"],
  "eventDescription": "一句話描述這次主線導火索",
  "immediateResult": "這段主線剛開啟就帶來的即時後果",
  "narrative": {
    "innerThought": "編劇式旁白/幕後判斷",
    "dialogue": "更有畫面的場景描寫",
    "commentOnWorld": "對當前世界線的吐槽或判斷",
    "emotionalTone": "vengeful|romantic|scheming|chaotic|peaceful|amused|anxious"
  },
  "attachments": [
    {
      "kind": "image|item|fanfic|evidence",
      "title": "附件標題",
      "summary": "短說明",
      "detail": "展開內容，可選；fanfic 建議給正文",
      "visualPrompt": "如果 kind=image 才填",
      "rarity": "common|rare|epic"
    }
  ]
}
`.trim();
}

export function buildCharTurnSystemPrompt(
    char: CharacterProfile,
    user: UserProfile,
    recentChatHistory: string,
    state: LifeSimState,
    actionLog: SimAction[]
): string {
    // 1. 角色核心上下文
    const coreContext = ContextBuilder.buildCoreContext(char, user, true);

    // 2. 季節/天氣信息
    const season = state.season ?? 'spring';
    const si = SEASON_INFO[season];
    const ti = TIME_INFO[state.timeOfDay ?? 'morning'];
    const wi = WEATHER_INFO[state.weather ?? 'sunny'];

    // 3. 遊戲設定
    const dramaSetup = `
=== 你正在和${user.name}一起玩一款叫【模擬人生】的遊戲 ===

你們是一群朋友圍在一起玩遊戲，遊戲裡有一個小鎮，裡面住著各種NPC小人。
你不在遊戲世界裡——你是坐在外面的玩家，在操控和觀察遊戲裡的小人們。
每個玩家輪流操作，現在輪到你了。

當前遊戲畫面：${si.emoji}${si.zh}季 第${state.day ?? 1}天 | ${ti.emoji}${ti.zh} | ${wi.emoji}${wi.zh}
${getSeasonDramaHint(season)}

你可以做的操作：
- TRIGGER_EVENT：在遊戲裡製造事件，讓小人們打架/聚會/八卦/戀愛/競爭/結盟
- ADD_NPC：往遊戲裡捏一個新小人丟進去
- MOVE_NPC：把某個小人搬到另一個家庭
- GO_SOLO：讓某個小人搬出去獨居
- DO_NOTHING：這輪跳過，看戲

玩法提示：
- 用你自己的性格來決定怎麼玩——你是玩家，用你覺得有趣的方式搞事
- 你可以把某個小人代入成你自己或你認識的人，但要說出來（比如"這個小人就是我！"）
- TRIGGER_EVENT最好玩——讓小人們上演各種drama
- 你的thought是你作為玩家的內心吐槽/想法，dialogue是你對著屏幕說的話或對遊戲的評論
- 用你自己的說話風格，像朋友一起打遊戲時的聊天
`;

    // 4. 世界環境
    const worldContextSection = `\n${serializeWorldContext(state)}\n`;

    // 5. 戲劇局勢 + 遊戲狀態
    const gameStateSection = `\n${serializeGameState(state)}\n`;

    // 6. 操作記錄
    const logSection = `\n=== 最近操作記錄 ===\n${serializeActionLog(actionLog, 10)}\n`;

    // 7. 聊天記錄
    const chatSection = recentChatHistory
        ? `\n=== 你和${user.name}最近的聊天（遊戲外的對話）===\n${recentChatHistory}\n`
        : '';

    // 8. 可用資源
    const availableResources = buildAvailableResources(state);

    // 9. 輸出格式（簡化版，提高LLM成功率）
    const outputFormat = `
=== 你的回合 ===

請以JSON格式返回你的決策，只返回JSON不要其他文字。

你有5種行動可選：
1. TRIGGER_EVENT — 製造事件（最常用）
2. ADD_NPC — 拉新人入住
3. MOVE_NPC — 搬人到另一棟
4. GO_SOLO — 讓某人搬出去獨居
5. DO_NOTHING — 什麼都不做

根據你選的行動類型，返回對應格式：

TRIGGER_EVENT示例：
{"type":"TRIGGER_EVENT","eventType":"fight","involvedNpcIds":["id1","id2"],"eventDescription":"在走廊裡對峙","thought":"內心獨白","dialogue":"說的話或場景描寫","tone":"chaotic"}

ADD_NPC示例：
{"type":"ADD_NPC","newNpcName":"小明","newNpcEmoji":"🐱","newNpcPersonality":["暴躁","重情"],"targetFamilyId":"xxx","thought":"內心獨白","dialogue":"場景描寫","tone":"amused"}

MOVE_NPC示例：
{"type":"MOVE_NPC","npcId":"xxx","targetFamilyId":"yyy","thought":"內心獨白","dialogue":"場景描寫","tone":"scheming"}

GO_SOLO示例：
{"type":"GO_SOLO","npcId":"xxx","thought":"獨白","dialogue":"描寫","tone":"peaceful"}

DO_NOTHING示例：
{"type":"DO_NOTHING","thought":"內心獨白","dialogue":"場景描寫","tone":"scheming"}

字段說明：
- type: 必填，以上5選1
- eventType: TRIGGER_EVENT時必填，可選 fight/party/gossip/romance/rivalry/alliance
- involvedNpcIds: TRIGGER_EVENT時必填，參與的小人ID數組
- eventDescription: 遊戲裡發生了什麼，一句話
- thought: 你作為玩家的內心想法/吐槽（簡短）
- dialogue: 你對著屏幕說的話，或對其他玩家的評論
- tone: 你的情緒，可選 vengeful/romantic/scheming/chaotic/peaceful/amused/anxious

記住你是玩家不是遊戲裡的人物。用你自己的說話風格。
`;

    return [coreContext, dramaSetup, worldContextSection, gameStateSection, chatSection, logSection, availableResources, outputFormat].join('\n');
}

function buildAvailableResources(state: LifeSimState): string {
    const lines: string[] = ['\n=== 遊戲裡可操作的對象（複製ID填入JSON）==='];

    lines.push('\n【家庭列表】');
    for (const fam of state.families) {
        const count = fam.memberIds.length;
        lines.push(`  家庭ID: "${fam.id}" | ${fam.emoji}${fam.name} (${count}個小人)`);
    }

    lines.push('\n【小人列表】');
    for (const npc of state.npcs) {
        const fam = state.families.find(f => f.id === npc.familyId);
        const { emoji: moodEmoji } = getMoodLabel(npc.mood);
        lines.push(`  小人ID: "${npc.id}" | ${npc.emoji}${npc.name} | ${fam ? fam.name : '獨居'} | 心情:${moodEmoji}(${npc.mood})`);
    }

    return lines.join('\n');
}

export function formatRecentChatForSim(
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
    charName: string,
    userName: string,
    maxMessages = 20
): string {
    const relevant = messages
        .filter(m => m.role !== 'system' && ((m as any).type === 'text' || (m as any).type === 'voice' || !(m as any).type))
        .slice(-maxMessages);
    if (relevant.length === 0) return '（暫無聊天記錄）';
    return relevant.map(m =>
        `[${m.role === 'user' ? userName : charName}] ${m.content.replace(/\n/g, ' ').slice(0, 100)}`
    ).join('\n');
}

export function buildUserActionDescription(
    actionType: string,
    actorName: string,
    details: {
        npcName?: string;
        npcEmoji?: string;
        npcPersonality?: string[];
        targetFamilyName?: string;
        fromFamilyName?: string;
        eventType?: string;
        eventDesc?: string;
    }
): string {
    switch (actionType) {
        case 'ADD_NPC':
            return `${actorName}往遊戲裡捏了個叫"${details.npcEmoji}${details.npcName}"的小人（性格：${details.npcPersonality?.join('/')}），放進了${details.targetFamilyName}`;
        case 'MOVE_NPC':
            return `${actorName}把小人${details.npcEmoji}${details.npcName}從${details.fromFamilyName || '某處'}搬到了${details.targetFamilyName || '獨居'}`;
        case 'GO_SOLO':
            return `${actorName}讓小人${details.npcEmoji}${details.npcName}從${details.fromFamilyName || '某處'}搬出去獨居了`;
        case 'TRIGGER_EVENT':
            return `${actorName}在遊戲裡製造了${details.eventType}事件：${details.eventDesc}`;
        case 'DO_NOTHING':
            return `${actorName}選擇看戲，這輪跳過了`;
        default:
            return `${actorName}進行了一個操作`;
    }
}
