/**
 * 日程生成的「人」（plans/calendar.md 第 3 批）：角色和身份卡用同一個生成器，
 * 這裡把兩種抽成一個形狀。身份卡的日程照樣存 DailySchedule，charId 用 `persona~<key>`，
 * 跟角色的 id 不會撞；讀角色日程的地方（桌面小組件、家園、主動消息）都是拿角色 id 去撈，碰不到它。
 */

import type { CharacterProfile, Participant, UserProfile } from '../types';
import { profileForPersonaKey, personaAvatarForKey, personaNameForKey, REAL_IDENTITY_PERSONA_ID } from './userPersona';
import { resolveCharTimeZone } from './timezone';

export const PERSONA_SCHEDULE_PREFIX = 'persona~';
export const personaScheduleId = (personaKey: string): string => `${PERSONA_SCHEDULE_PREFIX}${personaKey || REAL_IDENTITY_PERSONA_ID}`;
export const isPersonaScheduleId = (charId: string): boolean => charId.startsWith(PERSONA_SCHEDULE_PREFIX);
export const personaKeyOfScheduleId = (charId: string): string | null => (isPersonaScheduleId(charId) ? charId.slice(PERSONA_SCHEDULE_PREFIX.length) : null);

export interface SchedulePerson {
    kind: 'char' | 'persona';
    /** DailySchedule.charId */
    scheduleId: string;
    participant: Participant;
    name: string;
    avatar: string;
    groupId?: string;
    /** 這個人那邊的時區（世界 > 角色；身份卡是所在地）；沒有＝設備 */
    timezone?: string;
    schedulePrompt?: string;
    style: 'lifestyle' | 'mindful';
    /** 角色才有 */
    char?: CharacterProfile;
    /** 身份卡才有：那張卡的資料（名字、簡介、補充設定） */
    personaProfile?: UserProfile;
}

export const charSchedulePerson = (char: CharacterProfile): SchedulePerson => ({
    kind: 'char',
    scheduleId: char.id,
    participant: { kind: 'char', id: char.id },
    name: char.name,
    avatar: char.avatar,
    groupId: char.groupId,
    timezone: resolveCharTimeZone(char),
    schedulePrompt: char.schedulePrompt,
    style: char.scheduleStyle || 'lifestyle',
    char,
});

export const personaSchedulePerson = (profileBase: UserProfile, personaKey: string): SchedulePerson => {
    const key = personaKey || REAL_IDENTITY_PERSONA_ID;
    const profile = profileForPersonaKey(profileBase, key);
    const persona = key === REAL_IDENTITY_PERSONA_ID ? undefined : profileBase.personas?.find(p => p.id === key);
    return {
        kind: 'persona',
        scheduleId: personaScheduleId(key),
        participant: { kind: 'persona', id: key },
        name: personaNameForKey(profileBase, key),
        avatar: personaAvatarForKey(profileBase, key),
        timezone: profile.timezone,
        schedulePrompt: persona ? persona.schedulePrompt : profileBase.schedulePrompt,
        style: 'lifestyle',
        personaProfile: profile,
    };
};
