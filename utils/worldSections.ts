/**
 * 世界底下的分組，和全螢幕「切換聊天」頁的整理（plans/chat-switcher.md）。
 *
 * 一個角色只屬於一個分組（CharacterProfile.worldSectionId），分組定義在世界上（CharacterGroup.sections）。
 * 換了世界、或分組被刪，就當沒分組，不用回頭改角色卡。
 */
import type { CharacterGroup, CharacterProfile, WorldSection } from '../types';
import { includesAnyScript } from './scriptKey';

export const newSectionId = () => `wsec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** 角色現在真正屬於的分組（世界對不上、分組不在了都是 undefined） */
export const sectionOf = (char: Pick<CharacterProfile, 'groupId' | 'worldSectionId'>, worlds: CharacterGroup[]): WorldSection | undefined => {
    if (!char.groupId || !char.worldSectionId) return undefined;
    return worlds.find(w => w.id === char.groupId)?.sections?.find(s => s.id === char.worldSectionId);
};

export interface SwitcherSection {
    /** undefined＝這個世界裡沒分組的人 */
    section?: WorldSection;
    chars: CharacterProfile[];
}

export interface SwitcherWorld {
    /** undefined＝沒有世界的角色 */
    world?: CharacterGroup;
    sections: SwitcherSection[];
    count: number;
}

const leadFirst = (list: CharacterProfile[]) => [
    ...list.filter(c => c.castRole !== 'supporting'),
    ...list.filter(c => c.castRole === 'supporting'),
];

const norm = (s: string | undefined) => (s || '').toLowerCase().replace(/\s+/g, '');

/** 搜尋：名字、暱稱、簡介、世界名、分組名，大小寫、空白、繁簡都不計較 */
export const matchesSearch = (char: CharacterProfile, query: string, worlds: CharacterGroup[]): boolean => {
    const q = norm(query);
    if (!q) return true;
    const world = worlds.find(w => w.id === char.groupId);
    const fields = [char.name, char.chatNickname, char.description, world?.name, sectionOf(char, worlds)?.name];
    return fields.some(f => {
        const v = norm(f);
        return !!v && includesAnyScript(v, q);
    });
};

/**
 * 照世界 → 分組排好。世界照 worlds 的順序（呼叫的人先排好），沒世界的放最後；
 * 分組照世界裡的順序，沒分組的放最後；每組裡主角在前、配角在後。
 */
export function groupForSwitcher(characters: CharacterProfile[], worlds: CharacterGroup[]): SwitcherWorld[] {
    const known = new Set(worlds.map(w => w.id));
    const out: SwitcherWorld[] = [];
    const build = (world: CharacterGroup | undefined, members: CharacterProfile[]): SwitcherWorld | null => {
        if (!members.length) return null;
        const sections: SwitcherSection[] = [];
        for (const section of world?.sections || []) {
            const chars = members.filter(c => c.worldSectionId === section.id);
            if (chars.length) sections.push({ section, chars: leadFirst(chars) });
        }
        const ids = new Set((world?.sections || []).map(s => s.id));
        const rest = members.filter(c => !c.worldSectionId || !ids.has(c.worldSectionId));
        if (rest.length) sections.push({ chars: leadFirst(rest) });
        return { world, sections, count: members.length };
    };
    for (const world of worlds) {
        const w = build(world, characters.filter(c => c.groupId === world.id));
        if (w) out.push(w);
    }
    const none = build(undefined, characters.filter(c => !c.groupId || !known.has(c.groupId)));
    if (none) out.push(none);
    return out;
}

/** 最近聊過：照最後一則訊息時間由新到舊，沒聊過的不列 */
export const recentChars = (characters: CharacterProfile[], lastAt: Record<string, number>, limit = 8): CharacterProfile[] =>
    characters.filter(c => (lastAt[c.id] || 0) > 0).sort((a, b) => (lastAt[b.id] || 0) - (lastAt[a.id] || 0)).slice(0, limit);
