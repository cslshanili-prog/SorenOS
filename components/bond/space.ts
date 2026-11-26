/**
 * 羈絆 App 裡「一段關係」需要的東西一次算好（身份卡 × 角色、角色 × 角色共用），頁面只管顯示。
 */
import type { BondRecord, CharacterProfile, UserProfile } from '../../types';
import { lineFor, lineView, withLineFields } from '../../utils/chatLine';
import { makeChatClock } from '../../utils/dateStoryTime';
import { getLocalDateKey } from '../../utils/localDate';
import { nowInTimeZone, resolveCharTimeZone } from '../../utils/timezone';
import { personaAvatarForKey, personaNameForKey, resolveUserProfileForChar } from '../../utils/userPersona';
import { parseBondId } from '../../utils/bond/model';
import { bondOrBlank } from '../../utils/bond/store';

export interface ResolvedSpace {
    id: string;
    kind: 'persona' | 'pair';
    bond: BondRecord;
    /** 已經存過（不是自動開啟的預設） */
    saved: boolean;
    /** persona：角色；pair：bond.charId 那位 */
    char: CharacterProfile;
    /** pair：另一位 */
    other?: CharacterProfile;
    personaKey?: string;
    /** persona：這條線看到的角色卡（讀寫相識起點、關係文字都照它） */
    view?: CharacterProfile;
    /** persona：這條線上的你 */
    user?: UserProfile;
    leftName: string;
    leftAvatar?: string;
    rightName: string;
    rightAvatar?: string;
    /** 這段關係的「今天」（故事時間） */
    todayKey: string;
}

export function resolveSpace(id: string, characters: CharacterProfile[], profileBase: UserProfile, isSaved: (id: string) => boolean): ResolvedSpace | null {
    const parsed = parseBondId(id);
    if (!parsed) return null;
    const bond = bondOrBlank(id);
    if (parsed.kind === 'pair') {
        const a = characters.find(c => c.id === parsed.charId);
        const b = characters.find(c => c.id === parsed.otherCharId);
        if (!a || !b) return null;
        const todayKey = getLocalDateKey(nowInTimeZone(resolveCharTimeZone(a)));
        return { id, kind: 'pair', bond, saved: isSaved(id), char: a, other: b, leftName: a.name, leftAvatar: a.avatar, rightName: b.name, rightAvatar: b.avatar, todayKey };
    }
    const raw = characters.find(c => c.id === parsed.charId);
    if (!raw) return null;
    const char = withLineFields(profileBase, raw);
    const personaKey = parsed.personaKey || char.primaryPersonaKey;
    const view = lineView(char, lineFor(char, personaKey));
    const user = resolveUserProfileForChar(profileBase, view);
    const clock = makeChatClock(view);
    const todayKey = getLocalDateKey(nowInTimeZone(resolveCharTimeZone(view), new Date(clock ? clock.now : Date.now())));
    return {
        id, kind: 'persona', bond, saved: isSaved(id), char, personaKey, view, user,
        leftName: personaKey ? personaNameForKey(profileBase, personaKey) : user.name,
        leftAvatar: personaKey ? personaAvatarForKey(profileBase, personaKey) : user.avatar,
        rightName: char.name, rightAvatar: char.avatar,
        todayKey,
    };
}
