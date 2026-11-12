import type { CharacterProfile, GroupProfile, Message, NPCProfile, UserProfile } from '../types';
import { DB } from './db';
import { memberVisibleGroupMessages, presentPersonaKeys, userMessageKey } from './groupChat/presence';
import { personaNameForKey } from './userPersona';
import {
    buildNpcMemoryUpdatePrompt, formatGroupTranscriptForNpc, pendingGroupMemorySlice, summarizeNpcMemory,
} from './npcMemory';

/**
 * 把 NPC 參與的群聊整理進它的記憶（路線圖第 5 項 B）。
 * - 群聊每輪生成完調一次（force=false）：只整理攢到門檻的群；
 * - NPC 編輯頁「現在整理」（force=true）：有新消息就整理。
 * 多個群依序整理，後一個群接著前一個群整理出的記憶往下寫。
 * 旁觀的群裡用戶說的話 AI 本來就看不到，整理時也跳過。
 * 回傳整理了幾個群；失敗的群跳過、水位不動，下次再試。
 */
export async function refreshNpcMemoryFromGroups(params: {
    npc: NPCProfile;
    groups: GroupProfile[];
    nameOf: (id: string) => string;
    userName: string;
    /**
     * 有給就照在場的身份判斷旁觀、你那一行照訊息上的卡寫名字（關係線第 5 批）；
     * 不給照舊看群的隱身圍觀開關、一律 userName。
     */
    profileBase?: UserProfile;
    characters?: Array<Pick<CharacterProfile, 'id' | 'groupId'>>;
    api: { baseUrl: string; apiKey: string; model: string };
    force?: boolean;
    save: (patch: Pick<NPCProfile, 'memory' | 'memoryUpdatedAt' | 'memoryGroupMarks'>) => void;
}): Promise<number> {
    const { npc, groups, nameOf, userName, api, force, save, profileBase, characters } = params;
    if (!api.apiKey) return 0;
    let memory = npc.memory;
    let marks = { ...(npc.memoryGroupMarks || {}) };
    let updated = 0;
    for (const group of groups) {
        if (!(group.npcMemberIds || []).includes(npc.id)) continue;
        const all = await DB.getGroupMessages(group.id);
        // 旁觀的群裡你說的話 AI 本來就看不到；旁觀時打的（offstage）在場時也看不到
        const present = profileBase ? presentPersonaKeys(profileBase, group, characters || []) : undefined;
        const visible = present
            ? memberVisibleGroupMessages(all, present.length === 0)
            : (group.userLurkMode ? all.filter(m => m.role !== 'user') : all);
        const slice = pendingGroupMemorySlice(visible, marks[group.id], { force });
        if (!slice) continue;
        try {
            const speakerName = profileBase && present?.length
                ? (m: Message) => personaNameForKey(profileBase, userMessageKey(m, present[0]))
                : userName;
            const transcript = formatGroupTranscriptForNpc(slice.messages, npc.id, nameOf, speakerName);
            memory = await summarizeNpcMemory(api, buildNpcMemoryUpdatePrompt({
                npc: { ...npc, memory }, sourceLabel: `群聊「${group.name}」`, transcript, userName,
            }));
            marks = { ...marks, [group.id]: slice.endId };
            save({ memory, memoryUpdatedAt: Date.now(), memoryGroupMarks: marks });
            updated += 1;
        } catch (e) {
            console.warn(`[NPC 記憶] ${npc.name} 整理群聊「${group.name}」失敗，下次再試`, e);
        }
    }
    return updated;
}

/** 查手機裡角色跟這個 NPC 聊完一段後，把這段併進 NPC 的記憶。失敗只記日誌。 */
export async function rememberNpcPhoneChat(params: {
    npc: NPCProfile;
    hostName: string;
    /** 「我: …／對方: …」格式的新對話（這裡的「我」是機主、「對方」是 NPC） */
    transcript: string;
    userName: string;
    api: { baseUrl: string; apiKey: string; model: string };
    save: (patch: Pick<NPCProfile, 'memory' | 'memoryUpdatedAt'>) => void;
}): Promise<void> {
    const { npc, hostName, transcript, userName, api, save } = params;
    if (!api.apiKey || !transcript.trim()) return;
    // 轉成 NPC 視角：對方（NPC）→ 我，我（機主）→ 機主的名字
    const npcView = transcript.split('\n').map(line => line
        .replace(/^\s*我\s*[:：]/, `${hostName}:`)
        .replace(/^\s*對方\s*[:：]/, '我:')).join('\n');
    try {
        const memory = await summarizeNpcMemory(api, buildNpcMemoryUpdatePrompt({
            npc, sourceLabel: `跟${hostName}的手機私聊`, transcript: npcView, userName,
        }));
        save({ memory, memoryUpdatedAt: Date.now() });
    } catch (e) {
        console.warn(`[NPC 記憶] ${npc.name} 整理跟${hostName}的私聊失敗`, e);
    }
}
