/**
 * 劇情裡在場的「你」（plans/story-multi-persona.md 第 1 批）：純邏輯，不碰資料庫。
 *
 * - 在場可以是好幾個（身份卡、面具、你演的角色混著選），也可以一個都沒有（旁觀：你只當作者）。
 * - 舊劇情沒有 presence，讀 mask 當成一個；舊的 { type: 'user' } 是全域當前那張卡。
 * - 每段訊息記當時在場的人和執筆的人（metadata.theaterPresent／theaterWriters），之後標名字、歸線都照訊息上記的。
 * - 劇情其他地方要知道「你是誰」一律從這裡拿，別再直接讀 entry.mask。
 */

import { charAliases, charOneLiner } from './charIdentity';
import type { CharacterProfile, Message, StoryTheaterEntry, StoryTheaterMask, StoryTheaterMaskSelection, UserProfile } from '../types';
import { personaExtraSetting } from './personaSetting';
import { REAL_IDENTITY_PERSONA_ID, globalPersonaKey, personaAliasesForKey, profileForPersonaKey } from './userPersona';

export interface StoryPresent {
    /** 'persona:<身份鍵>'／'char:<角色 id>'／'mask:<面具 id>'：訊息上記的就是這個 */
    key: string;
    kind: 'persona' | 'character' | 'custom';
    selection: StoryTheaterMaskSelection;
    /** 身份卡才有 */
    personaKey?: string;
    /** 你演的角色才有 */
    characterId?: string;
    name: string;
    /** 別名（身份卡的、你演的角色的；面具沒有）：有才帶 */
    aliases?: string[];
    avatar?: string;
    /** 簡介（身份卡）／設定（角色、面具） */
    description: string;
    /** 身份卡的補充設定 */
    extra?: string;
    coreInstruction?: string;
    worldview?: string;
}

/** 訊息上記的在場快照：名字一起存，之後卡改名或刪了還標得出來 */
export interface StoryPresentStamp { key: string; name: string }

const personaExists = (profileBase: UserProfile, key: string): boolean =>
    key === REAL_IDENTITY_PERSONA_ID || !!profileBase.personas?.some(p => p.id === key);

const isSelection = (value: any): value is StoryTheaterMaskSelection => {
    if (!value || typeof value !== 'object') return false;
    if (value.type === 'user') return true;
    if (value.type === 'persona') return typeof value.key === 'string' && !!value.key;
    if (value.type === 'character' || value.type === 'custom') return typeof value.id === 'string' && !!value.id;
    return false;
};

const rawKey = (selection: StoryTheaterMaskSelection): string =>
    selection.type === 'user' ? 'user'
        : selection.type === 'persona' ? `persona:${selection.key}`
            : selection.type === 'character' ? `char:${selection.id}` : `mask:${selection.id}`;

/** 手改 JSON、舊資料的溫和補全：只留看得懂的、去掉重複的。回 undefined ＝ 沒設過（照舊讀 mask）。 */
export const normalizePresenceSelections = (value: unknown): StoryTheaterMaskSelection[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const out: StoryTheaterMaskSelection[] = [];
    for (const item of value) {
        if (!isSelection(item)) continue;
        const key = rawKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item.type === 'user' ? { type: 'user' }
            : item.type === 'persona' ? { type: 'persona', key: item.key }
                : { type: item.type, id: item.id });
    }
    return out;
};

/** 這條劇情設定的在場名單（還沒濾已刪的）：有 presence 照它，沒有就是舊的那一個 mask。 */
export const storyPresenceSelections = (entry: Pick<StoryTheaterEntry, 'presence' | 'mask'>): StoryTheaterMaskSelection[] =>
    entry.presence ? entry.presence : [entry.mask || { type: 'user' }];

const fromPersona = (profileBase: UserProfile, key: string, selection: StoryTheaterMaskSelection): StoryPresent => {
    const profile = profileForPersonaKey(profileBase, key);
    const extra = personaExtraSetting(profile);
    return {
        key: `persona:${key}`,
        kind: 'persona',
        selection,
        personaKey: key,
        name: profile.name || '你',
        ...(personaAliasesForKey(profileBase, key).length ? { aliases: personaAliasesForKey(profileBase, key) } : {}),
        avatar: profile.avatar,
        description: profile.bio || '',
        ...(extra ? { extra } : {}),
    };
};

/** 一個選項對到的人；卡、角色、面具刪了就回 null。 */
export const resolveStoryPresent = (
    selection: StoryTheaterMaskSelection,
    profileBase: UserProfile,
    characters: CharacterProfile[],
    masks: StoryTheaterMask[],
): StoryPresent | null => {
    if (selection.type === 'user') return fromPersona(profileBase, globalPersonaKey(profileBase), selection);
    if (selection.type === 'persona') return personaExists(profileBase, selection.key) ? fromPersona(profileBase, selection.key, selection) : null;
    if (selection.type === 'character') {
        const char = characters.find(item => item.id === selection.id);
        return char ? {
            key: `char:${char.id}`,
            kind: 'character',
            selection,
            characterId: char.id,
            name: char.name,
            ...(charAliases(char).length ? { aliases: charAliases(char) } : {}),
            avatar: char.avatar,
            description: charOneLiner(char),
            coreInstruction: char.systemPrompt || '',
            worldview: char.worldview || '',
        } : null;
    }
    const mask = masks.find(item => item.id === selection.id);
    return mask ? {
        key: `mask:${mask.id}`,
        kind: 'custom',
        selection,
        name: mask.name,
        avatar: mask.avatar,
        description: mask.description,
        coreInstruction: mask.coreInstruction,
        worldview: mask.worldview,
    } : null;
};

/**
 * 這條劇情現在在場的你。
 * - 濾掉已刪的卡、角色、面具；同一個人只算一次（舊的「本人」和點名同一張卡是同一個）。
 * - 原本有選、濾完全沒了：當作沒設，回到全域當前那張卡（跟群聊「卡都刪了」同一個做法）。
 * - 本來就是空的：旁觀，回 []。
 */
export const resolveStoryPresence = (
    entry: Pick<StoryTheaterEntry, 'presence' | 'mask'>,
    profileBase: UserProfile,
    characters: CharacterProfile[],
    masks: StoryTheaterMask[],
): StoryPresent[] => {
    const selections = storyPresenceSelections(entry);
    if (selections.length === 0) return [];
    const seen = new Set<string>();
    const out: StoryPresent[] = [];
    for (const selection of selections) {
        const present = resolveStoryPresent(selection, profileBase, characters, masks);
        if (!present || seen.has(present.key)) continue;
        seen.add(present.key);
        out.push(present);
    }
    if (out.length === 0) {
        const fallback = resolveStoryPresent({ type: 'user' }, profileBase, characters, masks);
        return fallback ? [fallback] : [];
    }
    return out;
};

/** 這個選項在不在名單裡（舊的「本人」和點名全域那張卡算同一個）。 */
export const selectionKey = (selection: StoryTheaterMaskSelection, profileBase: UserProfile): string =>
    selection.type === 'user' ? `persona:${globalPersonaKey(profileBase)}` : rawKey(selection);

/** 多選頁點一下：有就拿掉、沒有就加上。寫回去的一律是點名的卡，不再寫舊的 { type: 'user' }。 */
export const togglePresenceSelection = (
    current: StoryTheaterMaskSelection[],
    selection: StoryTheaterMaskSelection,
    profileBase: UserProfile,
): StoryTheaterMaskSelection[] => {
    const pin = (item: StoryTheaterMaskSelection): StoryTheaterMaskSelection =>
        item.type === 'user' ? { type: 'persona', key: globalPersonaKey(profileBase) } : item;
    const target = selectionKey(selection, profileBase);
    const pinned = current.map(pin);
    return pinned.some(item => selectionKey(item, profileBase) === target)
        ? pinned.filter(item => selectionKey(item, profileBase) !== target)
        : [...pinned, pin(selection)];
};

/** 名字用頓號接：「妹妹、姊姊」 */
export const joinPresentNames = (names: string[]): string => names.map(n => n.trim()).filter(Boolean).join('、');

/**
 * 提示詞裡「用戶側」叫什麼（{{user}} 也是它）：
 * 一個人照舊（沒名字或就叫「你」時寫「當前用戶側角色」）；好幾個用頓號接；旁觀是「作者」。
 */
export const storyPromptIdentityName = (present: Pick<StoryPresent, 'name'>[]): string => {
    if (present.length === 0) return '作者';
    if (present.length === 1) {
        const name = present[0].name.trim();
        return name && name !== '你' ? name : '當前用戶側角色';
    }
    return joinPresentNames(present.map(p => p.name)) || '當前用戶側角色';
};

/** 畫面上「你」那格寫什麼：旁觀／你／你（名字）／你（妹妹、姊姊） */
export const storyYouLabel = (present: Pick<StoryPresent, 'name' | 'selection'>[]): string => {
    if (present.length === 0) return '旁觀';
    if (present.length === 1) return present[0].selection.type === 'user' ? '你' : `你（${present[0].name}）`;
    return `你（${joinPresentNames(present.map(p => p.name))}）`;
};

export const presentStamps = (present: StoryPresent[]): StoryPresentStamp[] => present.map(p => ({ key: p.key, name: p.name }));

const stampsOf = (value: unknown): StoryPresentStamp[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is StoryPresentStamp => !!item && typeof item.key === 'string' && typeof item.name === 'string');
};

/** 這段訊息記的在場名單；舊訊息沒記回 undefined。 */
export const messagePresent = (message: Pick<Message, 'metadata'> | undefined): StoryPresentStamp[] | undefined =>
    stampsOf(message?.metadata?.theaterPresent);

/** 這段訊息記的執筆者；舊訊息沒記回 undefined。 */
export const messageWriters = (message: Pick<Message, 'metadata'> | undefined): StoryPresentStamp[] | undefined =>
    stampsOf(message?.metadata?.theaterWriters);

/**
 * 「這段是誰」預設選誰：上一段你寫的那幾位裡還在場的；沒有（第一段、他們都離場了）就是全部在場的人。
 */
export const defaultWriterKeys = (present: StoryPresent[], messages: Array<Pick<Message, 'role' | 'metadata'>>): string[] => {
    const inScene = new Set(present.map(p => p.key));
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'user') continue;
        const writers = messageWriters(messages[i]);
        if (!writers) continue;
        const kept = writers.map(w => w.key).filter(key => inScene.has(key));
        if (kept.length > 0) return kept;
        break;
    }
    return present.map(p => p.key);
};

/** 選好的執筆者照在場的順序排；一個都沒選（或選的都不在場了）就當全部。 */
export const resolveWriters = (present: StoryPresent[], chosenKeys: string[] | undefined): StoryPresent[] => {
    const chosen = new Set(chosenKeys || []);
    const picked = present.filter(p => chosen.has(p.key));
    return picked.length > 0 ? picked : present;
};

/** 要寫進這段訊息的在場與執筆者（旁觀時兩個都是空的，照樣記，才分得出「旁觀」和「舊訊息沒記」）。 */
export const presenceMetadata = (present: StoryPresent[], writers: StoryPresent[]): { theaterPresent: StoryPresentStamp[]; theaterWriters: StoryPresentStamp[] } => ({
    theaterPresent: presentStamps(present),
    theaterWriters: presentStamps(writers),
});

/**
 * 在場換了的那一輪，跟模型說一聲（只說這一次）：誰這一輪起在場、誰不在了。
 * 上一段沒記在場（舊訊息、第一段）就不說。
 */
export const presenceChangeNote = (previous: StoryPresentStamp[] | undefined, present: StoryPresent[]): string => {
    if (!previous) return '';
    const before = new Set(previous.map(p => p.key));
    const now = new Set(present.map(p => p.key));
    const left = previous.filter(p => !now.has(p.key)).map(p => `「${p.name}」`);
    const joined = present.filter(p => !before.has(p.key)).map(p => `「${p.name}」`);
    if (left.length === 0 && joined.length === 0) return '';
    const lines = ['### 用戶側在場的人有變動（只提醒這一次）'];
    if (left.length > 0) lines.push(`- ${left.join('')}這一輪起不在場：不要再寫他們在現場說話或行動；怎麼離開的照用戶這一段寫的，沒寫就自然帶過。`);
    if (joined.length > 0) lines.push(`- ${joined.join('')}這一輪起在場：怎麼到的照用戶這一段寫的，沒寫就自然帶過。`);
    if (present.length === 0) lines.push('- 現在沒有用戶側的人物在場，用戶只當作者。');
    return lines.join('\n');
};

/** 上一段你寫的訊息記的在場名單（找不到回 undefined） */
export const lastRecordedPresent = (messages: Array<Pick<Message, 'role' | 'metadata'>>): StoryPresentStamp[] | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'user') continue;
        return messagePresent(messages[i]);
    }
    return undefined;
};

/** 這條劇情裡你演的角色（他們不當演員，但寫回記憶、帶記憶時要算進去） */
export const presenceCharacterIds = (entry: Pick<StoryTheaterEntry, 'presence' | 'mask'>): string[] =>
    storyPresenceSelections(entry).flatMap(selection => selection.type === 'character' ? [selection.id] : []);

/** 是不是身份卡（含舊的「本人」）。寫進角色記憶的劇情只能選這種：寫進真實記憶的必須是真的你 */
export const isPersonaSelection = (selection: StoryTheaterMaskSelection): boolean =>
    selection.type === 'user' || selection.type === 'persona';

/** 這條劇情在場的身份卡（身份鍵）；面具、你演的角色不算。朋友圈「見過的身份」用 */
export const storyPresentPersonaKeys = (entry: Pick<StoryTheaterEntry, 'presence' | 'mask'>, profileBase: UserProfile): string[] => {
    const keys = storyPresenceSelections(entry).flatMap(selection =>
        selection.type === 'user' ? [globalPersonaKey(profileBase)]
            : selection.type === 'persona' && personaExists(profileBase, selection.key) ? [selection.key] : []);
    return [...new Set(keys)];
};

