// 群聊裡的 NPC 正式成員（路線圖第 5 項 A）。
//
// NPC 不進 group.members：那份名單有十幾處背景邏輯在讀（話題盒卡片發進成員私聊、主動消息打髒、
// 私聊 prompt 的「近期群活動」、記憶宮殿…），全都假設成員是 CharacterProfile。NPC 放在
// group.npcMemberIds，只在群聊生成這條路上被讀：導演／輪詢把它當一位成員、帶一份輕量檔案塊。
import type { GroupProfile, NPCProfile } from '../../types';
import { formatWorldbookSection, resolveWorldbookEntries, type WorldbookScanMessage } from '../worldbook';
import { buildNpcMemoryBlock } from '../npcMemory';

export interface Speaker { id: string; name: string }

/** 群裡在場（沒被禁言）的 NPC，按加入順序。已刪掉的 NPC 自動略過。 */
export function activeGroupNpcs(group: Pick<GroupProfile, 'npcMemberIds' | 'mutedMemberIds'>, npcs: NPCProfile[]): NPCProfile[] {
    const muted = new Set(group.mutedMemberIds || []);
    return (group.npcMemberIds || [])
        .filter(id => !muted.has(id))
        .map(id => npcs.find(n => n.id === id))
        .filter((n): n is NPCProfile => !!n);
}

/** 群裡的全部 NPC（含禁言），給成員管理和頭像用。 */
export function groupNpcs(group: Pick<GroupProfile, 'npcMemberIds'>, npcs: NPCProfile[]): NPCProfile[] {
    return (group.npcMemberIds || [])
        .map(id => npcs.find(n => n.id === id))
        .filter((n): n is NPCProfile => !!n);
}

/** 名字查詢表：角色 + NPC（群歷史、時間線、引用都靠它把 charId 變成名字）。 */
export function buildSpeakerDirectory(characters: Speaker[], npcs: Speaker[]): Speaker[] {
    return [...characters, ...npcs];
}

/**
 * NPC 在群聊裡的檔案塊：設定、世界觀、跟用戶／在場成員的關係、掛載的世界書、它自己的記憶。
 * 比角色塊輕得多：沒有記憶宮殿、沒有私聊時間線（NPC 不跟用戶一對一私聊）。
 */
export function buildNpcMemberBlock(params: {
    npc: NPCProfile;
    userName: string;
    /** 在場的其他成員（角色 + NPC），用來過濾關係、給關係對象配名字 */
    others: Speaker[];
    /** 世界書關鍵字掃描用的最近消息 */
    scanMessages?: WorldbookScanMessage[];
    /** 旁觀模式：用戶不在場，但 NPC 跟用戶的關係照樣成立 */
    userLurking?: boolean;
}): string {
    const { npc, userName, others, scanMessages = [], userLurking } = params;
    const relationships = npc.relationships
        .filter(r => r.description?.trim() && (r.targetId === 'user' || others.some(o => o.id === r.targetId)))
        .map(r => r.targetId === 'user'
            ? `  · 對「${userName}」${userLurking ? '（此刻不在群裡）' : ''}：${r.description.trim()}`
            : `  · 對「${others.find(o => o.id === r.targetId)?.name}」：${r.description.trim()}`);
    const worldbook = formatWorldbookSection(
        resolveWorldbookEntries(npc.mountedWorldbooks || [], scanMessages, npc.name, userName),
        `${npc.name} 的擴展設定`,
    ).trim();
    const memory = buildNpcMemoryBlock(npc);
    const lines = [
        `<<< NPC 成員檔案 START: ${npc.name} (ID: ${npc.id}) >>>`,
        `[${npc.name} 是這個群裡的 NPC 配角：推動劇情用，戲份比主角輕，但一樣是有自己想法的人。TA 沒有和用戶的一對一私聊。]`,
        npc.description?.trim() ? `- 設定：\n${npc.description.trim()}` : `- 設定：（沒有更多設定，按名字和常識自然發揮）`,
        npc.worldview?.trim() ? `- 世界觀：\n${npc.worldview.trim()}` : '',
        relationships.length ? `- 關係：\n${relationships.join('\n')}` : `- 關係：跟在場的人沒有特別設定的關係，當普通群友相處。`,
        worldbook,
        memory,
        `<<< NPC 成員檔案 END >>>`,
    ];
    return `\n${lines.filter(Boolean).join('\n')}\n`;
}

/** 導演指令後面追加的一段：哪些是 NPC、怎麼演、不能做什麼。 */
export function buildNpcDirectorNote(npcNames: string[]): string {
    if (npcNames.length === 0) return '';
    return `

#### NPC 成員
- ${npcNames.join('、')} 是群裡的 NPC 配角，照各自的 NPC 成員檔案說話，一樣用檔案上的 ID 當 charId 輸出。
- NPC 可以推劇情、帶話題、跟主角們互動，但不要搶走主角們的戲；不是每輪都要讓 NPC 開口。
- NPC 沒有和用戶的私聊：**NPC 不能用 PRIVATE**，也不能用退群語法。`;
}
