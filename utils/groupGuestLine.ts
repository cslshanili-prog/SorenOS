import { charOneLiner } from './charIdentity';
import type { CharacterProfile } from '../types';
import { safeResponseJson, extractContent } from './safeApi';
import { userRelationLabel } from './personaSpeaker';
import { isOnStage, isSupporting } from './castRole';

export interface GroupGuestLineOptions {
    /** 客串的配角 */
    guest: Pick<CharacterProfile, 'id' | 'name' | 'systemPrompt' | 'description' | 'aliases' | 'roleTitle' | 'worldview' | 'relationships' | 'refinedMemories'>;
    groupName: string;
    /** 當前在場的群成員，用於關係過濾 + 稱呼；客串本來就輕量，不用全部角色 */
    members: Array<Pick<CharacterProfile, 'id' | 'name'>>;
    userName: string;
    /** 配角認識的那個你的名字（多身份：可能不是群裡的你）；不給就當是同一個人 */
    knownUserName?: string;
    /** 已經格式化好的最近幾條群聊記錄（"名字: 內容"逐行），供客串接話 */
    recentTranscript: string;
    hint?: string;
    api: { baseUrl: string; apiKey: string; model: string };
}

/** 客串只帶最近一段整理好的記憶，太長截掉 */
const GUEST_MEMORY_MAX_CHARS = 1200;

/** 最近一個月整理好的記憶（refinedMemories 以年月為鍵）。 */
export function latestRefinedMemory(char: Pick<CharacterProfile, 'refinedMemories'>): string {
    const refined = Object.entries(char.refinedMemories || {}).sort(([a], [b]) => a.localeCompare(b));
    const latest = refined.length ? refined[refined.length - 1][1] : '';
    return (latest || '').trim().slice(0, GUEST_MEMORY_MAX_CHARS);
}

/**
 * 客串的輕量檔案：人設＋世界觀＋跟在場的人／你的關係＋最近一段記憶。
 * 比正式成員的完整人設輕得多，劇情的輕量演員也用這一份。
 */
export function buildGuestGrounding(
    guest: GroupGuestLineOptions['guest'],
    members: Array<Pick<CharacterProfile, 'id' | 'name'>>,
    userName: string,
    knownUserName?: string,
): string {
    const relationshipNote = (guest.relationships || [])
        .filter(r => r.targetId === 'user' || members.some(m => m.id === r.targetId))
        .map(r => {
            if (r.targetId === 'user') {
                const known = knownUserName || userName;
                return known === userName ? `對用戶「${userName}」：${r.description}` : `對${userRelationLabel(known, userName)}：${r.description}`;
            }
            const m = members.find(mm => mm.id === r.targetId);
            return `對「${m?.name || '群裡的人'}」：${r.description}`;
        })
        .join('\n');
    const memory = latestRefinedMemory(guest);
    const memoryBlock = memory ? `- ${guest.name} 記得的事（TA 自己的記憶，說話時自然延續，不要逐條複述）：\n${memory}` : '';
    const persona = (guest.systemPrompt || charOneLiner(guest) || '').trim();
    return [persona, guest.worldview?.trim(), relationshipNote, memoryBlock].filter(Boolean).join('\n');
}

/**
 * 群聊裡的配角客串：單次生成一句話插進群聊，不是正式成員，不進輪詢／記憶宮殿／記憶時間線。
 */
export async function generateGroupGuestLine(opts: GroupGuestLineOptions): Promise<string> {
    const { guest, groupName, members, userName, recentTranscript, hint, api } = opts;
    const grounding = buildGuestGrounding(guest, members, userName, opts.knownUserName);

    const prompt = `你在幫群聊「${groupName}」接一句客串台詞，說話的是「${guest.name}」——TA 不是這個群的常駐成員，只是剛好路過插一句嘴。
【TA 的設定】
${grounding || '（沒有更多設定，按名字和常識自然發揮）'}
【最近的群聊記錄】
${recentTranscript || '（還沒人說話）'}
${hint ? `【這次客串的方向提示，供參考】\n${hint}\n` : ''}
只輸出「${guest.name}」說的這一句話本身，不要帶名字前綴、不要加引號包裹，1-2 句話，符合群聊口語節奏。`;

    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9 }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const data = await safeResponseJson(response);
    return extractContent(data).trim();
}

/** 群聊客串的人選：配角（在戲上、不是小號、還不在這個群裡）。 */
export function groupGuestCandidates(
    characters: CharacterProfile[],
    group: { members: string[] } | null | undefined,
): CharacterProfile[] {
    const inGroup = new Set(group?.members || []);
    return characters.filter(c => isSupporting(c) && isOnStage(c) && !c.altOf && !inGroup.has(c.id));
}
