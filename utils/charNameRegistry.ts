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

/**
 * 每個世界（神經鏈接分組）的設定：畫風（plans/image-style-presets.md）、時區與架空時間線（plans/time-system.md）。
 * OSProvider 在分組變化時登記；utils 層照 groupId 讀。
 */
export interface WorldRegistryEntry { id: string; imageStyleId?: string; timezone?: string; timeline?: { epochLabel: string; anchorReal: string; anchorWorld: string; showWeekday?: boolean } }
let __worlds = new Map<string, WorldRegistryEntry>();
export const setWorldRegistry = (groups: Array<WorldRegistryEntry & { name?: string }>): void => {
    __worlds = new Map(groups.filter(g => g?.id).map(g => [g.id, { id: g.id, imageStyleId: g.imageStyleId, timezone: g.timezone, timeline: g.timeline }]));
};
/** 舊名字留著：畫風那邊還在叫 */
export const setWorldStyleRegistry = setWorldRegistry;
export const getWorld = (groupId: string | undefined | null): WorldRegistryEntry | undefined => (groupId ? __worlds.get(groupId) : undefined);
export const getWorldStyleId = (groupId: string | undefined | null): string | undefined => getWorld(groupId)?.imageStyleId;

/**
 * 旅行登記表（plans/calendar.md 第 4 批）：期間時區換成目的地，resolveCharTimeZone／身份卡所在地要查。
 * 零依賴：這裡只存、只比日期；載入和刷新在 utils/trips.ts。
 */
export interface TripRegistryEntry { id: string; owner: { kind: string; id: string }; destination: string; timezone?: string; from: string; to: string; kind?: string }
let __trips: TripRegistryEntry[] = [];
export const setTripRegistry = (trips: TripRegistryEntry[]): void => { __trips = trips.filter(t => t?.id && t.owner && t.from && t.to); };
export const getTripRegistry = (): ReadonlyArray<TripRegistryEntry> => __trips;
/** 這個人這天在旅行嗎（含頭尾；好幾趟重疊取清單最後一筆） */
export const getActiveTrip = (owner: { kind: string; id: string } | null | undefined, dayKey: string): TripRegistryEntry | undefined => {
    if (!owner) return undefined;
    let hit: TripRegistryEntry | undefined;
    for (const t of __trips) if (t.owner.kind === owner.kind && t.owner.id === owner.id && t.from <= dayKey && dayKey <= t.to) hit = t;
    return hit;
};

/** 所有登記的角色卡（只讀快照）。 */
export const getRegisteredCharacters = <T = any>(): T[] => [...__charsById.values()] as T[];
