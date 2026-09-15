import { NPCProfile, CharacterProfile } from '../types';
import { safeResponseJson, extractContent } from './safeApi';

export interface NpcGroupGuestLineOptions {
    npc: NPCProfile;
    groupName: string;
    /** 当前在场的真实角色成员，用于关系过滤 + 称呼；不是"全部群成员"就够，客串本来就轻量 */
    members: CharacterProfile[];
    userName: string;
    /** 已经格式化好的最近几条群聊记录（"名字: 内容"逐行），供客串接话 */
    recentTranscript: string;
    hint?: string;
    api: { baseUrl: string; apiKey: string; model: string };
}

/**
 * 群聊里的 NPC 客串：单次生成一句话插进群聊，不是正式成员，不进轮询/记忆宫殿/记忆时间线。
 * 依据只有 NPC 档案自身（描述 + 世界观 + 跟在场成员/用户的关系），比真角色的完整人设轻得多。
 */
export async function generateNpcGroupGuestLine(opts: NpcGroupGuestLineOptions): Promise<string> {
    const { npc, groupName, members, userName, recentTranscript, hint, api } = opts;

    const relationshipNote = npc.relationships
        .filter(r => r.targetId === 'user' || members.some(m => m.id === r.targetId))
        .map(r => {
            if (r.targetId === 'user') return `对用户「${userName}」：${r.description}`;
            const m = members.find(mm => mm.id === r.targetId);
            return `对「${m?.name || '群里的人'}」：${r.description}`;
        })
        .join('\n');
    const grounding = [npc.description?.trim(), npc.worldview?.trim(), relationshipNote]
        .filter(Boolean).join('\n');

    const prompt = `你在帮群聊「${groupName}」接一句客串台词，说话的是「${npc.name}」——TA 不是这个群的常驻成员，只是刚好路过插一句嘴。
【TA 的设定】
${grounding || '（没有更多设定，按名字和常识自然发挥）'}
【最近的群聊记录】
${recentTranscript || '（还没人说话）'}
${hint ? `【这次客串的方向提示，供参考】\n${hint}\n` : ''}
只输出「${npc.name}」说的这一句话本身，不要带名字前缀、不要加引号包裹，1-2 句话，符合群聊口语节奏。`;

    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9 }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const data = await safeResponseJson(response);
    return extractContent(data).trim();
}
