import { UserProfile } from '../types';

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
 * 分角色身份指定的全站唯一解析口徑：私聊（Chat.tsx）、查手機（CheckPhone.tsx）、記憶宮殿
 * 手動重新歸檔這三處目前接了這個函數，其餘畫面仍讀全域默認（applyActivePersona），是刻意
 * 分批留下的範圍邊界，不是遺漏——全部畫面接完是明顯更大的一次改動。
 *
 * 優先級（從高到低）：
 *   1. perCharPersonaIds[charId] 指向一張還在的身份卡 → 用這張卡的 name/avatar/bio，不疊
 *      perCharAvatars——身份卡本來就帶著自己的頭像，一個身份只對應一個頭像，疊加只會
 *      讓人搞不清當前到底頂著哪張臉；
 *   2. perCharPersonaIds[charId] === REAL_IDENTITY_PERSONA_ID → 強制真實身份，不看全域默認，
 *      但仍然吃 perCharAvatars（這是先於身份卡存在的機制，語義是"這個聊天單獨換個頭像"，
 *      跟"要不要用身份卡"是兩件事，不能因為強制真實身份就把它蓋掉）；
 *   3. 都沒設置 → 走全域默認（activePersonaId），同樣再疊一層 perCharAvatars。
 */
export function resolveUserProfileForChar(profileBase: UserProfile, charId: string): UserProfile {
    const { profile: resolved, matchedPersona } = applyPersonaOverride(profileBase, profileBase.perCharPersonaIds?.[charId]);
    if (matchedPersona) return resolved;
    const avatarOverride = profileBase.perCharAvatars?.[charId];
    return avatarOverride ? { ...resolved, avatar: avatarOverride } : resolved;
}

/**
 * 群聊版的分角色身份指定，鍵是 groupId（perGroupPersonaIds），邏輯跟
 * resolveUserProfileForChar 一樣，只是沒有 perCharAvatars 那層——群聊頭像一直用整體
 * 默認，不受這個字段影響（perCharAvatars 自己的文檔也寫明"群聊仍用整體頭像"）。
 */
export function resolveUserProfileForGroup(profileBase: UserProfile, groupId: string): UserProfile {
    return applyPersonaOverride(profileBase, profileBase.perGroupPersonaIds?.[groupId]).profile;
}
