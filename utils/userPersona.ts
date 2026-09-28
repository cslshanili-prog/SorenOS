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

/** 這個群裡的你是哪一個（群身份）。跟 resolveUserProfileForGroup 同一套優先級。 */
export function personaKeyForGroup(profileBase: UserProfile, groupId: string): string {
    return keyFromOverride(profileBase, profileBase.perGroupPersonaIds?.[groupId]);
}

/** 身份鍵對應的名字（找不到身份卡就是真實身份的名字）。 */
/** 身份鍵對應的頭像（真實身份或卡已刪除 → 真實身份的頭像）。 */
export function personaAvatarForKey(profileBase: UserProfile, key: string): string {
    if (key !== REAL_IDENTITY_PERSONA_ID) {
        const persona = profileBase.personas?.find(p => p.id === key);
        if (persona) return persona.avatar;
    }
    return profileBase.avatar;
}

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
 * 群聊版的分角色身份指定，鍵是 groupId（perGroupPersonaIds），邏輯跟
 * resolveUserProfileForChar 一樣，只是沒有 perCharAvatars 那層——群聊頭像一直用整體
 * 默認，不受這個字段影響（perCharAvatars 自己的文檔也寫明"群聊仍用整體頭像"）。
 */
export function resolveUserProfileForGroup(profileBase: UserProfile, groupId: string): UserProfile {
    return applyPersonaOverride(profileBase, profileBase.perGroupPersonaIds?.[groupId]).profile;
}
