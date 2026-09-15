import { UserProfile } from '../types';

/**
 * 把「目前身份」套用到用户档案上，返回一份新对象；没有生效的身份卡（或指向的卡已被删除）时原样返回。
 * 只覆盖 name/avatar/bio 这三个"外显装扮"字段，其余字段（vrState/perCharAvatars/personas 本身……）不变。
 * 这是全站唯一的口径——所有读 userProfile.name/avatar/bio 的地方读到的都已经是这份套用结果，
 * 好感度/记忆/关系仍然认的是同一个人，不因为换了身份卡而分开算。
 */
export function applyActivePersona(profile: UserProfile): UserProfile {
    const persona = profile.activePersonaId
        ? profile.personas?.find(p => p.id === profile.activePersonaId)
        : undefined;
    if (!persona) return profile;
    return { ...profile, name: persona.name, avatar: persona.avatar, bio: persona.bio };
}

/**
 * perCharPersonaIds 里表示「这个角色强制用真实身份」的哨兵值——跟真实的身份卡 id（由
 * addUserPersona 现场生成）不会撞：真实 id 都带时间戳，这个是固定字面量。
 */
export const REAL_IDENTITY_PERSONA_ID = '__real__';

/**
 * resolveUserProfileForChar / resolveUserProfileForGroup 共用的身份卡挑选逻辑：
 * overrideId 指向一张还在的身份卡 → 用那张卡（matchedPersona=true）；指向
 * REAL_IDENTITY_PERSONA_ID 或身份卡已被删除 → 真实身份；都没设置（undefined）→
 * 全域默认（activePersonaId）。matchedPersona 供 resolveUserProfileForChar 判断
 * 要不要再叠 perCharAvatars——具体指定了身份卡的那支分支不叠。
 */
function applyPersonaOverride(
    profileBase: UserProfile,
    overrideId: string | undefined,
): { profile: UserProfile; matchedPersona: boolean } {
    if (overrideId && overrideId !== REAL_IDENTITY_PERSONA_ID) {
        const persona = profileBase.personas?.find(p => p.id === overrideId);
        if (persona) return { profile: { ...profileBase, name: persona.name, avatar: persona.avatar, bio: persona.bio }, matchedPersona: true };
        // 指向的身份卡已被删除：跟"没设置"一样回落到全域默认，不崩溃、不留死引用的痕迹。
    }
    return { profile: overrideId === REAL_IDENTITY_PERSONA_ID ? profileBase : applyActivePersona(profileBase), matchedPersona: false };
}

/**
 * 分角色身份指定的全站唯一解析口径：私聊（Chat.tsx）、查手机（CheckPhone.tsx）、记忆宫殿
 * 手动重新归档这三处目前接了这个函数，其余画面仍读全域默认（applyActivePersona），是刻意
 * 分批留下的范围边界，不是遗漏——全部画面接完是明显更大的一次改动。
 *
 * 优先级（从高到低）：
 *   1. perCharPersonaIds[charId] 指向一张还在的身份卡 → 用这张卡的 name/avatar/bio，不叠
 *      perCharAvatars——身份卡本来就带着自己的头像，一个身份只对应一个头像，叠加只会
 *      让人搞不清当前到底顶着哪张脸；
 *   2. perCharPersonaIds[charId] === REAL_IDENTITY_PERSONA_ID → 强制真实身份，不看全域默认，
 *      但仍然吃 perCharAvatars（这是先于身份卡存在的机制，语义是"这个聊天单独换个头像"，
 *      跟"要不要用身份卡"是两件事，不能因为强制真实身份就把它盖掉）；
 *   3. 都没设置 → 走全域默认（activePersonaId），同样再叠一层 perCharAvatars。
 */
export function resolveUserProfileForChar(profileBase: UserProfile, charId: string): UserProfile {
    const { profile: resolved, matchedPersona } = applyPersonaOverride(profileBase, profileBase.perCharPersonaIds?.[charId]);
    if (matchedPersona) return resolved;
    const avatarOverride = profileBase.perCharAvatars?.[charId];
    return avatarOverride ? { ...resolved, avatar: avatarOverride } : resolved;
}

/**
 * 群聊版的分角色身份指定，键是 groupId（perGroupPersonaIds），逻辑跟
 * resolveUserProfileForChar 一样，只是没有 perCharAvatars 那层——群聊头像一直用整体
 * 默认，不受这个字段影响（perCharAvatars 自己的文档也写明"群聊仍用整体头像"）。
 */
export function resolveUserProfileForGroup(profileBase: UserProfile, groupId: string): UserProfile {
    return applyPersonaOverride(profileBase, profileBase.perGroupPersonaIds?.[groupId]).profile;
}
