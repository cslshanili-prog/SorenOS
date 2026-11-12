/**
 * 模塊級 charId → 角色名 註冊表 — 與 MusicContext 的播放快照同一模式。
 *
 * 動機：私聊 prompt 的群聊背景注入（chatPrompts.buildSystemPromptParts）需要把
 * 群消息的發言人標成真實角色名，但它位於 utils 層、拿不到 OSContext 的 characters
 * state，而給 buildChatRequestPayload 的所有調用方（useChatAI / 主動消息 /
 * worldHome / 彼方 …）逐一穿參代價太高。OSProvider 在 characters 變化時把
 * 名字表寫到這裡，utils 層按需讀取。
 */

let __charNames: Record<string, string> = {};
let __charRefs: Array<{ id: string; groupId?: string; vrState?: { enabled?: boolean } }> = [];
/** 每個角色的關係清單（關係線第 6 批）：提示詞「你身邊的人」要知道別人把你記成什麼 */
/** 完整的角色卡（小號要讀本人的人設與記憶，關係線第 7 批） */
let __charsById = new Map<string, any>();
let __charRelations: Array<{ id: string; name: string; relationships: Array<{ targetId: string; description: string }> }> = [];

export const setCharNameRegistry = (chars: Array<{ id: string; name: string; groupId?: string; vrState?: { enabled?: boolean }; relationships?: Array<{ targetId: string; description: string }> }>): void => {
    const next: Record<string, string> = {};
    for (const c of chars) {
        if (c?.id && c?.name) next[c.id] = c.name;
    }
    __charNames = next;
    __charRefs = chars.filter(c => c?.id).map(c => ({ id: c.id, groupId: c.groupId, vrState: c.vrState ? { enabled: c.vrState.enabled } : undefined }));
    __charsById = new Map(chars.filter(c => c?.id).map(c => [c.id, c]));
    __charRelations = chars.filter(c => c?.id && c.relationships?.length).map(c => ({ id: c.id, name: c.name, relationships: c.relationships! }));
};

/** 有關係清單的角色（只讀快照）。 */
export const getCharRelations = (): ReadonlyArray<{ id: string; name: string; relationships: ReadonlyArray<{ targetId: string; description: string }> }> => __charRelations;

/** 角色 id、所在世界（神經鏈接分組）、有沒有接入彼方：算群身份／彼方場景身份的「多數認識的你」要用（utils/userPersona.ts）。 */
export const getCharRefs = (): Array<{ id: string; groupId?: string; vrState?: { enabled?: boolean } }> => __charRefs;

export const getCharNameById = (id: string | undefined | null): string | null =>
    (id && __charNames[id]) || null;

/** 完整的角色卡（OSProvider 登記的那份；找不到回 undefined）。 */
export const getRegisteredCharacter = <T = any>(id: string | undefined | null): T | undefined =>
    (id ? __charsById.get(id) : undefined) as T | undefined;

/** 每個世界（神經鏈接分組）的畫風（plans/image-style-presets.md）：OSProvider 在分組變化時登記 */
let __worldStyles: Record<string, string> = {};
export const setWorldStyleRegistry = (groups: Array<{ id: string; imageStyleId?: string }>): void => {
    const next: Record<string, string> = {};
    for (const g of groups) if (g?.id && g.imageStyleId) next[g.id] = g.imageStyleId;
    __worldStyles = next;
};
export const getWorldStyleId = (groupId: string | undefined | null): string | undefined => (groupId ? __worldStyles[groupId] : undefined);

/** 所有登記的角色卡（只讀快照）。 */
export const getRegisteredCharacters = <T = any>(): T[] => [...__charsById.values()] as T[];
