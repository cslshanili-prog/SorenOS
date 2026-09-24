import type { Message, NPCProfile } from '../types';
import { messageLogText } from './groupChat/format';
import { safeResponseJson, extractContent } from './safeApi';

/**
 * 路線圖第 5 項 B：NPC 的輕量記憶。
 *
 * NPC 不接記憶宮殿，只有一段自己的記憶（`NPCProfile.memory`，NPC 的第一人稱、條列），
 * 從它參與過的群聊、查手機裡跟角色的私聊自動摘要，也可以在 NPC 編輯頁手動改。
 * 輪到它說話（群聊、客串、查手機對話、見面劇情）時帶進 prompt。
 *
 * 摘要是「舊記憶 + 這段新經歷 → 新記憶」整段重寫，長度有上限，舊的不重要的會被擠掉。
 * 群聊按水位（`memoryGroupMarks[groupId]` = 已經整理到的最後一條群消息 id）攢到一定條數才整理一次。
 */

export const NPC_MEMORY_MAX_CHARS = 800;
/** 群裡攢了這麼多條新消息才整理一次（一輪群聊通常 3～8 條） */
export const NPC_MEMORY_GROUP_THRESHOLD = 30;
/** 一次整理最多看這麼多條（太久以前的就算漏掉，也比一次塞爆好） */
export const NPC_MEMORY_GROUP_WINDOW = 80;

/** 放進 NPC 檔案塊的一段；沒有記憶就是空字串。 */
export function buildNpcMemoryBlock(npc: Pick<NPCProfile, 'name' | 'memory'>): string {
    const memory = npc.memory?.trim();
    if (!memory) return '';
    return `- ${npc.name} 記得的事（TA 自己的記憶，說話時自然延續，不要逐條複述）：\n${memory}`;
}

/**
 * 某個群裡這個 NPC 還沒整理進記憶的那一段。沒到門檻回 null；
 * `force` 時只要有新消息就整理（NPC 編輯頁的「現在整理」）。
 */
export function pendingGroupMemorySlice(
    msgs: Message[],
    mark: number | undefined,
    opts: { force?: boolean; threshold?: number } = {},
): { messages: Message[]; endId: number } | null {
    const fresh = msgs.filter(m => typeof m.id === 'number' && m.id > (mark || 0) && m.role !== 'system');
    const threshold = opts.threshold ?? NPC_MEMORY_GROUP_THRESHOLD;
    if (fresh.length === 0 || (!opts.force && fresh.length < threshold)) return null;
    return { messages: fresh.slice(-NPC_MEMORY_GROUP_WINDOW), endId: fresh[fresh.length - 1].id };
}

/** 群聊記錄轉成「名字: 內容」逐行，NPC 自己說的標「我」。 */
export function formatGroupTranscriptForNpc(
    msgs: Message[],
    npcId: string,
    nameOf: (id: string) => string,
    userName: string,
): string {
    return msgs.map(m => {
        const speaker = m.role === 'user' ? userName : m.charId === npcId ? '我' : nameOf(m.charId);
        return `${speaker}: ${messageLogText(m).slice(0, 200)}`;
    }).join('\n');
}

export function buildNpcMemoryUpdatePrompt(params: {
    npc: Pick<NPCProfile, 'name' | 'description' | 'memory'>;
    /** 「群聊『週末打球群』」「查手機：跟小雨的私聊」這類說明 */
    sourceLabel: string;
    transcript: string;
    userName: string;
}): string {
    const { npc, sourceLabel, transcript, userName } = params;
    return `你在幫「${npc.name}」整理 TA 自己的記憶。${npc.name}是故事裡的一個配角。
【${npc.name}的設定】
${npc.description?.trim() || '（沒有更多設定）'}
【${npc.name}原本記得的事】
${npc.memory?.trim() || '（還沒有）'}
【剛經歷的：${sourceLabel}】
${transcript}

請把剛經歷的事併進原本的記憶，輸出更新後的完整記憶：
- 用${npc.name}的第一人稱，條列，每條一句（「- 」開頭）。
- 只記之後還用得上的：認識了誰、和誰關係怎麼變了、答應了什麼、發生過的重要事件、別人的重要近況。閒聊和客套不用記。
- 用戶叫「${userName}」，提到時直接寫名字。
- 原本的記憶沒被推翻就保留；被推翻的改成新的；太瑣碎的可以刪。
- 全部加起來不超過 ${NPC_MEMORY_MAX_CHARS} 字。
只輸出記憶條列本身，不要標題、不要解釋。`;
}

/** 模型輸出收尾：去掉程式碼框和多餘的標題行，超長截斷。 */
export function cleanNpcMemoryOutput(raw: string): string {
    let text = raw.replace(/```[a-z]*\n?/gi, '').trim();
    text = text.replace(/^(?:#+\s*)?(?:更新後的)?(?:完整)?記憶[:：]?\s*\n/, '').trim();
    const limit = Math.round(NPC_MEMORY_MAX_CHARS * 1.25);
    if (text.length > limit) {
        const cut = text.slice(0, limit);
        const lastBreak = cut.lastIndexOf('\n');
        text = (lastBreak > limit / 2 ? cut.slice(0, lastBreak) : cut).trim();
    }
    return text;
}

/** 調一次模型，回傳新的整段記憶；失敗丟錯（調用方決定要不要提示）。 */
export async function summarizeNpcMemory(
    api: { baseUrl: string; apiKey: string; model: string },
    prompt: string,
): Promise<string> {
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1500 }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const data = await safeResponseJson(response);
    const memory = cleanNpcMemoryOutput(extractContent(data) || '');
    if (!memory) throw new Error('記憶整理沒有輸出');
    return memory;
}

/** NPC 用自己配的 API，沒配就用給定的後備。 */
export function resolveNpcApi<T extends { baseUrl: string; apiKey: string; model: string }>(
    npc: Pick<NPCProfile, 'chatApi'>,
    fallback: T,
): { baseUrl: string; apiKey: string; model: string } {
    return npc.chatApi?.baseUrl && npc.chatApi.apiKey ? npc.chatApi : fallback;
}
