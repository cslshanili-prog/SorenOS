import { NPCProfile, CharacterProfile } from '../types';
import { safeResponseJson, extractContent } from './safeApi';

export interface NpcGroupGuestLineOptions {
    npc: NPCProfile;
    groupName: string;
    /** 當前在場的真實角色成員，用於關係過濾 + 稱呼；不是"全部群成員"就夠，客串本來就輕量 */
    members: CharacterProfile[];
    userName: string;
    /** 已經格式化好的最近幾條群聊記錄（"名字: 內容"逐行），供客串接話 */
    recentTranscript: string;
    hint?: string;
    api: { baseUrl: string; apiKey: string; model: string };
}

/**
 * 群聊裡的 NPC 客串：單次生成一句話插進群聊，不是正式成員，不進輪詢/記憶宮殿/記憶時間線。
 * 依據只有 NPC 檔案自身（描述 + 世界觀 + 跟在場成員/用戶的關係），比真角色的完整人設輕得多。
 */
export async function generateNpcGroupGuestLine(opts: NpcGroupGuestLineOptions): Promise<string> {
    const { npc, groupName, members, userName, recentTranscript, hint, api } = opts;

    const relationshipNote = npc.relationships
        .filter(r => r.targetId === 'user' || members.some(m => m.id === r.targetId))
        .map(r => {
            if (r.targetId === 'user') return `對用戶「${userName}」：${r.description}`;
            const m = members.find(mm => mm.id === r.targetId);
            return `對「${m?.name || '群裡的人'}」：${r.description}`;
        })
        .join('\n');
    const grounding = [npc.description?.trim(), npc.worldview?.trim(), relationshipNote]
        .filter(Boolean).join('\n');

    const prompt = `你在幫群聊「${groupName}」接一句客串台詞，說話的是「${npc.name}」——TA 不是這個群的常駐成員，只是剛好路過插一句嘴。
【TA 的設定】
${grounding || '（沒有更多設定，按名字和常識自然發揮）'}
【最近的群聊記錄】
${recentTranscript || '（還沒人說話）'}
${hint ? `【這次客串的方向提示，供參考】\n${hint}\n` : ''}
只輸出「${npc.name}」說的這一句話本身，不要帶名字前綴、不要加引號包裹，1-2 句話，符合群聊口語節奏。`;

    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9 }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const data = await safeResponseJson(response);
    return extractContent(data).trim();
}
