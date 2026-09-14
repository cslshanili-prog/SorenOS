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
