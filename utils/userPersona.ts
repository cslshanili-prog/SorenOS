import type { CharacterProfile, UserProfile } from '../types';

/**
 * 把「目前身份」套用到用戶檔案上，返回一份新對象；沒有生效的身份卡（或指向的卡已被刪除）時原樣返回。
 * 只覆蓋 name/avatar/bio/gender/customSetting/otherDetails 這幾個"外顯裝扮"字段，其餘字段
 * （vrState/perCharAvatars/personas 本身……）不變。這是全站唯一的口徑——所有讀
 * userProfile.name/avatar/bio 等字段的地方讀到的都已經是這份套用結果，好感度/記憶/關係仍然
 * 認的是同一個人，不因為換了身份卡而分開算。
 */
export function applyActivePersona(profile: UserProfile): UserProfile {
    const persona = profile.activePersonaId
        ? profile.personas?.find(p => p.id === profile.activePersonaId)
        : undefined;
    if (!persona) return profile;
    return {
        ...profile,
        name: persona.name,
        avatar: persona.avatar,
        bio: persona.bio,
        gender: persona.gender,
        customSetting: persona.customSetting,
        otherDetails: persona.otherDetails,
    };
}

/**
 * perCharPersonaIds 裡表示「這個角色強制用真實身份」的哨兵值——跟真實的身份卡 id（由
 * addUserPersona 現場生成）不會撞：真實 id 都帶時間戳，這個是固定字面量。
 */
export const REAL_IDENTITY_PERSONA_ID = '__real__';

/**
 * resolveUserProfileForChar / resolveUserProfileForGroup 共用的身份卡挑選邏輯：
 * overrideId 指向一張還在的身份卡 → 用那張卡（matchedPersona=true）；指向
 * REAL_IDENTITY_PERSONA_ID 或身份卡已被刪除 → 真實身份；都沒設置（undefined）→
 * 全域默認（activePersonaId）。matchedPersona 供 resolveUserProfileForChar 判斷
 * 要不要再疊 perCharAvatars——具體指定了身份卡的那支分支不疊。
 */
function applyPersonaOverride(
    profileBase: UserProfile,
    overrideId: string | undefined,
): { profile: UserProfile; matchedPersona: boolean } {
    if (overrideId && overrideId !== REAL_IDENTITY_PERSONA_ID) {
        const persona = profileBase.personas?.find(p => p.id === overrideId);
        if (persona) return {
            profile: {
                ...profileBase,
                name: persona.name,
                avatar: persona.avatar,
                bio: persona.bio,
                gender: persona.gender,
                customSetting: persona.customSetting,
                otherDetails: persona.otherDetails,
            },
            matchedPersona: true,
        };
        // 指向的身份卡已被刪除：跟"沒設置"一樣回落到全域默認，不崩潰、不留死引用的痕跡。
    }
    return { profile: overrideId === REAL_IDENTITY_PERSONA_ID ? profileBase : applyActivePersona(profileBase), matchedPersona: false };
}

/**
 * 分角色／分世界身份指定的全站唯一解析口徑。所有「替某一個角色」生成或顯示的地方都走這裡：
 * 私聊、查手機、見面、通話、日記、小屋、夢境、學習、行程、記帳、手帳外的單角色活動、寫歌、
 * 節日活動、小小窩、神經鏈接，以及 OSContext 背景替角色生成（主動消息、臨時會話、拉黑冷靜期）。
 * 還讀全域默認的是多角色同場的地方（彼方、家園、人生模擬、遊戲、朋友圈……）：不同世界的角色可能
 * 同場，該用哪張身份屬於「同世界多身份隔離」的規則，另外設計（見 plans/soren-roadmap.md）。
 *
 * 要吃到世界預設，得傳角色本身（帶 groupId）；只傳 charId 就只看分角色指定。
 *
 * 優先級（從高到低）：
 *   1. perCharPersonaIds[charId] 指向一張還在的身份卡 → 用這張卡的 name/avatar/bio，不疊
 *      perCharAvatars——身份卡本來就帶著自己的頭像，一個身份只對應一個頭像，疊加只會
 *      讓人搞不清當前到底頂著哪張臉；
 *   2. perCharPersonaIds[charId] === REAL_IDENTITY_PERSONA_ID → 強制真實身份，不看全域默認，
 *      但仍然吃 perCharAvatars（這是先於身份卡存在的機制，語義是"這個聊天單獨換個頭像"，
 *      跟"要不要用身份卡"是兩件事，不能因為強制真實身份就把它蓋掉）；
 *   3. 角色所在的世界（分組）在 perWorldPersonaIds 有指定 → 同 1／2 的規則（身份卡不疊頭像，真實身份疊）；
 *   4. 都沒設置 → 走全域默認（activePersonaId），同樣再疊一層 perCharAvatars。
 */
export function resolveUserProfileForChar(profileBase: UserProfile, char: CharRef): UserProfile {
    const charId = typeof char === 'string' ? char : char.id;
    const { profile: resolved, matchedPersona } = applyPersonaOverride(profileBase, effectivePersonaOverride(profileBase, char));
    if (matchedPersona) return resolved;
    const avatarOverride = profileBase.perCharAvatars?.[charId];
    return avatarOverride ? { ...resolved, avatar: avatarOverride } : resolved;
}

/**
 * 傳角色本身（帶 groupId）才吃得到「世界預設身份」；只傳 charId 的舊調用點照舊只看分角色指定。
 * 世界 = 神經鏈接的角色分組（CharacterGroup），一個角色只在一個分組裡。
 */
export type CharRef = string | Pick<CharacterProfile, 'id' | 'groupId'>;

/**
 * 這個角色生效的是哪一層指定：角色自己指定 > 所在世界（分組）的預設 > 全域默認。
 * 設定頁拿它標示「這個角色現在跟著誰走」。
 */
export function personaOverrideSource(profileBase: UserProfile, char: CharRef): 'char' | 'world' | 'global' {
    const charId = typeof char === 'string' ? char : char.id;
    if (profileBase.perCharPersonaIds?.[charId]) return 'char';
    const groupId = typeof char === 'string' ? undefined : char.groupId;
    if (groupId && profileBase.perWorldPersonaIds?.[groupId]) return 'world';
    return 'global';
}

// ── 身份鍵：「這是哪一個你」────────────────────────────────────────────────
// 同一個世界裡不同身份卡是完全不同的人（見 plans/multi-persona-isolation-design.md）。
// 共享的地方（群聊、朋友圈、角色之間提到你）要比對「是不是同一個你」，比的就是身份鍵：
// 身份卡 id，或 REAL_IDENTITY_PERSONA_ID（真實身份）。指定的卡被刪了跟解析一樣回落全域默認。

/** 全域默認是哪一個你：目前身份卡（還在的話），否則真實身份。 */
export function globalPersonaKey(profileBase: UserProfile): string {
    const id = profileBase.activePersonaId;
    return id && profileBase.personas?.some(p => p.id === id) ? id : REAL_IDENTITY_PERSONA_ID;
}

function keyFromOverride(profileBase: UserProfile, overrideId: string | undefined): string {
    if (overrideId === REAL_IDENTITY_PERSONA_ID) return REAL_IDENTITY_PERSONA_ID;
    if (overrideId && profileBase.personas?.some(p => p.id === overrideId)) return overrideId;
    return globalPersonaKey(profileBase);
}

/** 這個角色認識的是哪一個你（它的主身份）。跟 resolveUserProfileForChar 同一套優先級。 */
export function personaKeyForChar(profileBase: UserProfile, char: CharRef): string {
    return keyFromOverride(profileBase, effectivePersonaOverride(profileBase, char));
}

/** 群：id，加上成員（算「成員多數認識的身份」要用）。只給 id 就當沒有成員。 */
export type GroupRef = string | { id: string; members?: string[] };

/** 指定值還有效（真實身份，或還在的身份卡）才算數；卡被刪了等於沒指定。 */
function validOverride(profileBase: UserProfile, overrideId: string | undefined): string | undefined {
    if (overrideId === REAL_IDENTITY_PERSONA_ID) return overrideId;
    return overrideId && profileBase.personas?.some(p => p.id === overrideId) ? overrideId : undefined;
}

/**
 * 群裡沒指定身份時用誰：角色成員各自認識的身份裡最多人的那張（NPC 不算）。
 * 平手時全域默認優先，否則照成員順序先出現的；沒有角色成員就是全域默認。
 */
function majorityMemberKey(
    profileBase: UserProfile,
    members: string[],
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>>,
): string {
    const fallback = globalPersonaKey(profileBase);
    const counts = new Map<string, number>();
    for (const id of members) {
        const char = characters.find(c => c.id === id);
        if (!char) continue;
        const key = personaKeyForChar(profileBase, char);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = fallback;
    let bestCount = counts.get(fallback) || 0;
    for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count; }
    return best;
}

/**
 * 這個群裡的你是哪一個（群身份）：群單獨指定的 > 成員多數認識的 > 全域默認。
 * 要傳群本身（帶 members）和角色清單才算得出「成員多數」；只傳 id 就只看單獨指定。
 */
export function personaKeyForGroup(
    profileBase: UserProfile,
    group: GroupRef,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>> = [],
): string {
    const id = typeof group === 'string' ? group : group.id;
    const override = validOverride(profileBase, profileBase.perGroupPersonaIds?.[id]);
    if (override) return override;
    return majorityMemberKey(profileBase, typeof group === 'string' ? [] : group.members || [], characters);
}

/** NPC：id、關係清單（推測它屬於哪個世界用）、手動指定的認識的身份。 */
export type NpcPersonaRef = { id: string; relationships?: Array<{ targetId: string }>; knownPersonaId?: string };

/**
 * 這個 NPC 認識的是哪一個你：手動指定的（還有效的話）> 關係清單裡的角色大多認識的 > 全域默認。
 * NPC 沒有分組，只能從它跟誰有關係推它屬於哪個世界。
 */
export function personaKeyForNpc(
    profileBase: UserProfile,
    npc: NpcPersonaRef,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>> = [],
): string {
    const override = validOverride(profileBase, npc.knownPersonaId);
    if (override) return override;
    const related = [...new Set((npc.relationships || []).map(r => r.targetId).filter(id => id && id !== 'user'))];
    return majorityMemberKey(profileBase, related, characters);
}

/** NPC 認識的身份是怎麼來的（編輯頁標示用）：手動指定、從關係推的、還是全域默認。 */
export function npcPersonaSource(
    profileBase: UserProfile,
    npc: NpcPersonaRef,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>> = [],
): 'npc' | 'inferred' | 'global' {
    if (validOverride(profileBase, npc.knownPersonaId)) return 'npc';
    return personaKeyForNpc(profileBase, npc, characters) === globalPersonaKey(profileBase) ? 'global' : 'inferred';
}

/** 身份鍵對應的完整檔案（外顯欄位換成那張卡的）。群聊、朋友圈這些「不是替某個角色」的地方用。 */
export function profileForPersonaKey(profileBase: UserProfile, key: string): UserProfile {
    if (key === REAL_IDENTITY_PERSONA_ID) return profileBase;
    return applyPersonaOverride(profileBase, key).profile;
}

/** 身份鍵對應的頭像（真實身份或卡已刪除 → 真實身份的頭像）。 */
export function personaAvatarForKey(profileBase: UserProfile, key: string): string {
    if (key !== REAL_IDENTITY_PERSONA_ID) {
        const persona = profileBase.personas?.find(p => p.id === key);
        if (persona) return persona.avatar;
    }
    return profileBase.avatar;
}

/** 身份鍵對應的名字（找不到身份卡就是真實身份的名字）。 */
export function personaNameForKey(profileBase: UserProfile, key: string): string {
    if (key !== REAL_IDENTITY_PERSONA_ID) {
        const persona = profileBase.personas?.find(p => p.id === key);
        if (persona) return persona.name;
    }
    return profileBase.name;
}

function effectivePersonaOverride(profileBase: UserProfile, char: CharRef): string | undefined {
    const charId = typeof char === 'string' ? char : char.id;
    const own = profileBase.perCharPersonaIds?.[charId];
    if (own) return own;
    const groupId = typeof char === 'string' ? undefined : char.groupId;
    return groupId ? profileBase.perWorldPersonaIds?.[groupId] : undefined;
}

/**
 * 群聊版的身份解析，優先級同 personaKeyForGroup：群單獨指定（perGroupPersonaIds）>
 * 成員多數認識的身份 > 全域默認。沒有 perCharAvatars 那層——群聊頭像一直用整體
 * 默認，不受這個字段影響（perCharAvatars 自己的文檔也寫明"群聊仍用整體頭像"）。
 */
export function resolveUserProfileForGroup(
    profileBase: UserProfile,
    group: GroupRef,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>> = [],
): UserProfile {
    return profileForPersonaKey(profileBase, personaKeyForGroup(profileBase, group, characters));
}

/** 群身份是怎麼來的：群單獨指定、成員多數認識的、還是全域默認（群設定頁標示用）。 */
export function groupPersonaSource(
    profileBase: UserProfile,
    group: GroupRef,
    characters: Array<Pick<CharacterProfile, 'id' | 'groupId'>> = [],
): 'group' | 'members' | 'global' {
    const id = typeof group === 'string' ? group : group.id;
    if (validOverride(profileBase, profileBase.perGroupPersonaIds?.[id])) return 'group';
    return personaKeyForGroup(profileBase, group, characters) === globalPersonaKey(profileBase) ? 'global' : 'members';
}
