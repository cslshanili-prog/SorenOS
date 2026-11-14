/**
 * 加好友（plans/persona-line-batch4.md 第 3 節）：用一張他還不認識的身份卡去加他，由他決定通不通過。
 *
 * 他看得到的只有這張卡對外的樣子（名字、性別、簡介）和你送的招呼；記憶只有一份，他可能在別條線
 * 聽過這個名字，那是他自己的事。之前被拒過的，他看得到次數和你上次說了什麼——不設冷卻，連送十次本身就是戲。
 * 這一步在本機生成（一次性、要馬上看到結果），不上雲。
 */
import type { APIConfig, CharacterProfile, FriendRequestRecord, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { knowsPersona } from './chatLine';
import { globalPersonaKey } from './userPersona';
import { resolveCharacterChatApi } from './characterApi';
import { extractContent, extractJson, safeResponseJson } from './safeApi';

export const FRIEND_GREETING_MAX = 120;
export const FRIEND_REPLY_MAX = 300;

/** 對外看得到的這張卡（不給設定細節：他還不認識這個人） */
export interface FriendRequestFace {
    name: string;
    gender?: string;
    bio?: string;
}

export function buildFriendRequestPrompt(args: {
    charName: string;
    face: FriendRequestFace;
    greeting: string;
    history: FriendRequestRecord[];
}): string {
    const { charName, face, greeting, history } = args;
    const rejected = history.filter(h => !h.accepted);
    const last = rejected[rejected.length - 1];
    const lines = [
        `有個你還不認識的人想加你好友。`,
        `對方的名字：${face.name}`,
        face.gender ? `性別：${face.gender}` : '',
        face.bio?.trim() ? `對方個人資料上的簡介：${face.bio.trim().slice(0, 200)}` : '對方沒有寫簡介。',
        greeting.trim() ? `對方附上的招呼：「${greeting.trim()}」` : '對方沒有附任何招呼。',
        rejected.length
            ? `這不是第一次了：對方之前加過你 ${rejected.length} 次，都被你拒絕了${last?.greeting ? `，上一次的招呼是「${last.greeting}」` : ''}${last?.reply ? `，你當時回的是「${last.reply}」` : ''}。`
            : '',
        '',
        `照你（${charName}）自己的個性、處境和你對這個人可能有的印象，決定要不要通過。真實一點：不是每個陌生人都會被加，也不是每個都會被拒。`,
        `只輸出 JSON，不要別的：{"accept": true 或 false, "reply": "你回對方的一句話"}`,
        `通過的話，reply 就是你們成為好友後你說的第一句話；拒絕的話，reply 是你拒絕時附的話（可以是空字串，就是不理）。${FRIEND_REPLY_MAX} 字以內。`,
    ];
    return lines.filter(l => l !== '').join('\n');
}

export function parseFriendDecision(raw: unknown): { accepted: boolean; reply: string } | null {
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (!obj || !('accept' in obj)) return null;
    const accepted = obj.accept === true || obj.accept === 'true';
    const reply = typeof obj.reply === 'string' ? obj.reply.trim().slice(0, FRIEND_REPLY_MAX) : '';
    return { accepted, reply };
}

/** 送出好友申請：一次生成。失敗丟錯（調用方提示可重送，不記一筆被拒）。 */
export async function sendFriendRequest(args: {
    char: CharacterProfile;
    face: FriendRequestFace;
    greeting: string;
    history: FriendRequestRecord[];
    apiConfig: APIConfig;
}): Promise<{ accepted: boolean; reply: string }> {
    const { char, face, greeting, history, apiConfig } = args;
    const api = resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('沒有可用的 API');
    const prompt = buildFriendRequestPrompt({ charName: char.name, face, greeting, history });
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'system', content: ContextBuilder.buildRoleSettingsContext(char) }, { role: 'user', content: prompt }],
            temperature: 0.9,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const decision = parseFriendDecision(extractJson(extractContent(await safeResponseJson(response))));
    if (!decision) throw new Error('他的回覆沒看懂，再送一次試試');
    return decision;
}

/** 這張卡的對外樣子（真實身份或某張身份卡）。 */
export function faceForPersona(profileBase: UserProfile, personaKey: string, realKey: string): FriendRequestFace {
    if (personaKey !== realKey) {
        const p = profileBase.personas?.find(x => x.id === personaKey);
        if (p) return { name: p.name, gender: p.gender, bio: p.bio };
    }
    return { name: profileBase.name, gender: profileBase.gender, bio: profileBase.bio };
}

// ─── 不認識你的角色：先加好友還是直接聊 ───

/** 「先加好友才能對話」：沒設就是開 */
export const friendRequestRequired = (profileBase: Pick<UserProfile, 'friendRequestRequired'>): boolean => profileBase.friendRequestRequired !== false;

/**
 * 點一個角色要聊天時怎麼走：認識現在這張卡（或是小號，小號另有好友流程）→ 直接開；
 * 不認識 → 開關開著先加好友（befriend），關著就直接認識（direct）。
 */
export function strangerAction(
    char: Pick<CharacterProfile, 'knownPersonaKeys' | 'primaryPersonaKey' | 'altOf'>,
    profileBase: UserProfile,
): 'open' | 'befriend' | 'direct' {
    if (char.altOf || knowsPersona(char, globalPersonaKey(profileBase))) return 'open';
    return friendRequestRequired(profileBase) ? 'befriend' : 'direct';
}

/** 直接認識：這張卡加進他認識的卡（不送申請、不寫系統訊息；那條線是空的，開場白會自己送） */
export const knowPersonaDirectly = (prev: Pick<CharacterProfile, 'knownPersonaKeys'>, personaKey: string): Pick<CharacterProfile, 'knownPersonaKeys'> => ({
    knownPersonaKeys: (prev.knownPersonaKeys || []).includes(personaKey) ? prev.knownPersonaKeys : [...(prev.knownPersonaKeys || []), personaKey],
});
