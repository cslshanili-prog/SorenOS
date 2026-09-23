import type { APIConfig, CharacterProfile, GroupProfile, Message, RealtimeConfig, UserProfile } from '../../types';
import { findSARPendingReply, isSARDeletedReply, replaceSARSimulationReply, resolveSARReplyRetry } from './sarSimulationEdits';
import { DB } from '../db';
import { RoomPlateDB } from '../memoryPalace/db';
import { formatRoomPlatesSection } from '../memoryPalace/roomPlates';
import { safeFetchJson } from '../safeApi';
import { getSARModuleById, readSARGachaState, type SARModuleDefinition } from './sarGacha';
import { getVRApi, logVRApiCall } from './vrApi';
import { latestSARDirectorState, normalizeSARDirectorState, SAR_NARRATIVE_RULES, type SARDirectorState } from './sarNarrative';

export const SAR_SIMULATION_STORAGE_KEY = 'vr_sar_simulations_v1';
export const SAR_SIMULATION_MAX_INTERACTIONS = 50;
export const SAR_SIMULATION_MESSAGE_SOURCE = 'sar_simulation';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** 一次鑄造後永久收藏的角色專屬異格身份。 */
export type SARIdentityProfile = {
    title: string;
    logline: string;
    identity: string;
    lifePatch: string;
    relationship: string;
    /** 舊卡兼容字段；新卡不再攜帶具體現實記憶。 */
    memoryStance?: string;
    steelSeal: string;
    patchCost: string;
    behaviorShift: string;
    /** User 在這條異界座標中佩戴的身份面具；舊卡讀取時自動補齊。 */
    userMaskTitle?: string;
    userIdentity?: string;
    userLifePatch?: string;
    openingScene: string;
    openingLine: string;
    playerPrompt: string;
    /** v3 異界座標字段；舊卡讀取時由 resolveSARWorldlineProfile 補鑄。 */
    worldName?: string;
    worldPremise?: string;
    arrivalPoint?: string;
    activeCrisis?: string;
    sharedObjective?: string;
    countdown?: string;
    hiddenTruth?: string;
    climaxChoice?: string;
    memoryFuse?: string;
};

export type SARWorldlineProfile = {
    worldName: string;
    worldPremise: string;
    arrivalPoint: string;
    activeCrisis: string;
    sharedObjective: string;
    countdown: string;
    hiddenTruth: string;
    climaxChoice: string;
    relationshipAnchor: string;
    retrofitted: boolean;
};

export type SARUserMaskProfile = {
    title: string;
    identity: string;
    lifePatch: string;
    retrofitted: boolean;
};

export type SARIdentityCard = {
    id: string;
    charId: string;
    charName: string;
    /** 僅兼容舊檔；新卡不復制頭像，顯示時按 charId 讀取角色資料。 */
    charAvatar?: string;
    variantId: string;
    storyId: string;
    createdAt: number;
    updatedAt: number;
    profile: SARIdentityProfile;
    /** v1 推演藍圖遷移而來，原始資料沒有獨立鋼印/代價字段。 */
    legacy?: boolean;
};

/** 身份卡可以長期收藏；每一次五十輪生命則是獨立實例。 */
export type SARSimulationRun = {
    id: string;
    cardId: string;
    createdAt: number;
    updatedAt: number;
    status: 'active' | 'archived';
    interactionsUsed: number;
    maxInteractions: 50;
    archivedAt?: number;
    archiveReason?: 'completed' | 'emergency';
    /** 已把返航簡報投遞到原角色私聊；避免重複分享。 */
    sharedAt?: number;
};

export type SARSimulationState = {
    version: 2;
    cards: SARIdentityCard[];
    runs: SARSimulationRun[];
};

export const DEFAULT_SAR_SIMULATION_STATE: SARSimulationState = { version: 2, cards: [], runs: [] };

const browserStorage = (): StorageLike | undefined => {
    try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
    catch { return undefined; }
};

const cleanText = (value: unknown, max: number) => typeof value === 'string'
    ? value.trim().replace(/\s{3,}/g, '\n\n').slice(0, max)
    : '';

const parseJsonCandidates = (raw: string) => {
    const withoutThinking = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const candidates = [withoutThinking];
    const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) candidates.push(fenced.trim());
    const firstBrace = withoutThinking.indexOf('{');
    const lastBrace = withoutThinking.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(withoutThinking.slice(firstBrace, lastBrace + 1));
    return candidates;
};

export type SARSimulationReply = {
    /** 本輪可感知的旁白；安靜的關係場景允許為空。 */
    worldNarration: string;
    /** 角色層：只演出角色能夠感知、說出和做出的部分。 */
    character: string;
    /** 僅用於下一輪保持事實連續性，不展示導演內部記錄。 */
    directorState?: SARDirectorState;
};

/**
 * 正式推演使用雙層響應。保留純文本回退是為了兼容不穩定模型與舊 API，
 * 新請求使用 worldNarration / character；舊 gm 字段仍可讀取。
 */
export const parseSARSimulationReply = (raw: string): SARSimulationReply | null => {
    for (const candidate of parseJsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            const narration = cleanText(parsed?.worldNarration ?? parsed?.world ?? parsed?.narrator ?? parsed?.gm ?? parsed?.director, 2400);
            const worldNarration = narration === '必要旁白，或空字符串' ? '' : narration;
            const character = cleanText(parsed?.character ?? parsed?.char ?? parsed?.reply, 12000);
            if (/^(?:本[轮輪]角色真正呈[现現][给給]\s*User\s*的[动動]作[与與][台臺][词詞]|角色本[轮輪]的[动動]作[与與][台臺][词詞])$/i.test(character)) return null;
            if (character) {
                const directorState = normalizeSARDirectorState(parsed?.directorState);
                return { worldNarration, character, ...(directorState ? { directorState } : {}) };
            }
            if (parsed && typeof parsed === 'object') return null;
        } catch { /* 嘗試下一個候選 JSON */ }
    }
    const withoutThinking = cleanText((raw || '').replace(/<think>[\s\S]*?<\/think>/gi, ''), 12000);
    // Broken structured output must never expose internal director records as prose.
    if (/^[\[{]|^```/.test(withoutThinking) || /"(?:directorState|worldNarration|character)"\s*:/.test(withoutThinking)) return null;
    return withoutThinking ? { worldNarration: '', character: withoutThinking } : null;
};

/** 新記錄使用 sarWorldNarration；舊 sarGM 元數據僅作無損遷移兼容。 */
export const getSARWorldNarration = (message: Pick<Message, 'metadata'>) =>
    cleanText(message.metadata?.sarWorldNarration ?? message.metadata?.sarGM, 2400);

export const parseSARIdentityProfile = (raw: string): SARIdentityProfile | null => {
    for (const candidate of parseJsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            const result: SARIdentityProfile = {
                title: cleanText(parsed?.title, 80),
                logline: cleanText(parsed?.logline, 240),
                identity: cleanText(parsed?.identity, 900),
                lifePatch: cleanText(parsed?.lifePatch, 800),
                relationship: cleanText(parsed?.relationship, 700),
                memoryStance: cleanText(parsed?.memoryStance, 600),
                steelSeal: cleanText(parsed?.steelSeal, 360),
                patchCost: cleanText(parsed?.patchCost, 600),
                behaviorShift: cleanText(parsed?.behaviorShift, 700),
                userMaskTitle: cleanText(parsed?.userMaskTitle, 80),
                userIdentity: cleanText(parsed?.userIdentity, 900),
                userLifePatch: cleanText(parsed?.userLifePatch, 800),
                openingScene: cleanText(parsed?.openingScene, 1800),
                openingLine: cleanText(parsed?.openingLine, 500),
                playerPrompt: cleanText(parsed?.playerPrompt, 300),
                worldName: cleanText(parsed?.worldName, 100),
                worldPremise: cleanText(parsed?.worldPremise, 700),
                arrivalPoint: cleanText(parsed?.arrivalPoint, 900),
                activeCrisis: cleanText(parsed?.activeCrisis, 700),
                sharedObjective: cleanText(parsed?.sharedObjective, 600),
                countdown: cleanText(parsed?.countdown, 400),
                hiddenTruth: cleanText(parsed?.hiddenTruth, 700),
                climaxChoice: cleanText(parsed?.climaxChoice, 600),
                memoryFuse: cleanText(parsed?.memoryFuse, 600),
            };
            const { memoryStance: _legacyMemoryStance, memoryFuse: _legacyMemoryFuse, ...required } = result;
            if (Object.values(required).every(Boolean)) return result;
        } catch { /* 嘗試下一個候選 JSON */ }
    }
    return null;
};

const isIdentityCard = (card: any): card is SARIdentityCard => card
    && typeof card.id === 'string'
    && typeof card.charId === 'string'
    && typeof card.variantId === 'string'
    && typeof card.storyId === 'string'
    && card.profile && typeof card.profile === 'object'
    && typeof card.profile.title === 'string'
    && typeof card.profile.steelSeal === 'string';

const isSimulationRun = (run: any): run is SARSimulationRun => run
    && typeof run.id === 'string'
    && typeof run.cardId === 'string'
    && (run.status === 'active' || run.status === 'archived');

const migrateLegacyRecord = (record: any): { card: SARIdentityCard; run: SARSimulationRun } | null => {
    if (!record || typeof record.id !== 'string' || typeof record.charId !== 'string'
        || typeof record.variantId !== 'string' || typeof record.storyId !== 'string'
        || !record.blueprint || typeof record.blueprint !== 'object') return null;
    const blueprint = record.blueprint;
    const now = Number(record.createdAt) || Date.now();
    const updatedAt = Number(record.updatedAt) || now;
    const variantTitle = getSARModuleById(record.variantId)?.title || '舊版人格異格';
    const cardId = `sar_card_legacy_${record.id}`;
    return {
        card: {
            id: cardId,
            charId: record.charId,
            charName: cleanText(record.charName, 100) || '未命名角色',
            variantId: record.variantId,
            storyId: record.storyId,
            createdAt: now,
            updatedAt,
            legacy: true,
            profile: {
                title: cleanText(blueprint.title, 80) || '舊版異格檔案',
                logline: cleanText(blueprint.logline, 240) || '由舊版推演藍圖遷移而來的異格身份。',
                identity: cleanText(blueprint.characterState, 900) || '舊版檔案未記錄完整身份信息。',
                lifePatch: cleanText(blueprint.characterState, 800) || '舊版檔案未單獨記錄人生補丁。',
                relationship: cleanText(blueprint.memoryPerformance, 700) || '沿用舊版關係記憶表現。',
                memoryStance: cleanText(blueprint.memoryPerformance, 600) || '沿用舊版關係記憶表現。',
                steelSeal: `舊版檔案未單獨鑄造鋼印；繼續推演時以「${variantTitle}」作為不可繞過的人格約束。`,
                patchCost: '舊版檔案未單獨記錄補丁代價。',
                behaviorShift: cleanText(blueprint.characterState, 700) || '沿用舊版角色偏移。',
                openingScene: cleanText(blueprint.openingScene, 1800) || '舊版檔案沒有可恢復的開場。',
                openingLine: cleanText(blueprint.openingLine, 500) || '……',
                playerPrompt: cleanText(blueprint.playerPrompt, 300) || '回應眼前的異格。',
            },
        },
        run: {
            id: record.id,
            cardId,
            createdAt: now,
            updatedAt,
            status: record.status === 'archived' ? 'archived' : 'active',
            interactionsUsed: Math.max(0, Math.min(50, Number(record.interactionsUsed) || 0)),
            maxInteractions: SAR_SIMULATION_MAX_INTERACTIONS,
        },
    };
};

export const readSARSimulationState = (storage: StorageLike | undefined = browserStorage()): SARSimulationState => {
    if (!storage) return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    try {
        const parsed = JSON.parse(storage.getItem(SAR_SIMULATION_STORAGE_KEY) || 'null');
        if (!parsed) return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
        if (Array.isArray(parsed.cards) || Array.isArray(parsed.runs)) {
            return {
                version: 2,
                cards: (Array.isArray(parsed.cards) ? parsed.cards : []).filter(isIdentityCard).slice(0, 100),
                runs: (Array.isArray(parsed.runs) ? parsed.runs : []).filter(isSimulationRun).slice(0, 160),
            };
        }
        if (Array.isArray(parsed.records)) {
            const migrated = parsed.records.map(migrateLegacyRecord).filter(Boolean) as Array<{ card: SARIdentityCard; run: SARSimulationRun }>;
            return { version: 2, cards: migrated.map(item => item.card).slice(0, 100), runs: migrated.map(item => item.run).slice(0, 160) };
        }
        return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    } catch {
        return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    }
};

export const writeSARSimulationState = (state: SARSimulationState, storage: StorageLike | undefined = browserStorage()) => {
    // Avatars belong to CharacterProfile. Drop all legacy copies (including
    // links/blobrefs), and resolve the current character by charId in the UI.
    const cards = state.cards.slice(0, 100).map(card => {
        const { charAvatar, ...compact } = card;
        return compact;
    });
    const normalized: SARSimulationState = { version: 2, cards, runs: state.runs.slice(0, 160) };
    try {
        if (!storage) throw new Error('Storage unavailable');
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
        throw new Error('異格檔案保存失敗，本地存儲可能已滿或不可用。請先備份數據並釋放空間，再重試。');
    }
    return normalized;
};

export class SARIdentitySaveError extends Error {
    constructor(public card: SARIdentityCard, cause: unknown) {
        super(cause instanceof Error ? cause.message : '異格檔案保存失敗');
        this.name = 'SARIdentitySaveError';
    }
}

export const saveSARIdentityCard = (card: SARIdentityCard, storage: StorageLike | undefined = browserStorage()) => {
    const current = readSARSimulationState(storage);
    return writeSARSimulationState({ ...current, cards: [card, ...current.cards.filter(item => item.id !== card.id)] }, storage);
};

export const startSARSimulationRun = (cardId: string, storage: StorageLike | undefined = browserStorage()) => {
    const current = readSARSimulationState(storage);
    if (!current.cards.some(card => card.id === cardId)) throw new Error('異格身份卡不存在');
    const active = current.runs.find(run => run.cardId === cardId && run.status === 'active');
    if (active) return active;
    const now = Date.now();
    const run: SARSimulationRun = {
        id: `sar_run_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        cardId,
        createdAt: now,
        updatedAt: now,
        status: 'active',
        interactionsUsed: 0,
        maxInteractions: SAR_SIMULATION_MAX_INTERACTIONS,
    };
    writeSARSimulationState({ ...current, runs: [run, ...current.runs] }, storage);
    return run;
};

export const completeSARSimulationTurn = (
    runId: string,
    expectedInteractions: number,
    storage: StorageLike | undefined = browserStorage(),
) => {
    const current = readSARSimulationState(storage);
    const run = current.runs.find(item => item.id === runId);
    if (!run) throw new Error('推演實例不存在');
    if (run.status !== 'active') throw new Error('這段推演已經封存');
    if (run.interactionsUsed !== expectedInteractions) throw new Error('推演進度已變化，請重新進入');
    const now = Date.now();
    const interactionsUsed = Math.min(SAR_SIMULATION_MAX_INTERACTIONS, run.interactionsUsed + 1);
    const completed = interactionsUsed >= SAR_SIMULATION_MAX_INTERACTIONS;
    const updated: SARSimulationRun = {
        ...run,
        interactionsUsed,
        updatedAt: now,
        status: completed ? 'archived' : 'active',
        ...(completed ? { archivedAt: now, archiveReason: 'completed' as const } : {}),
    };
    writeSARSimulationState({
        ...current,
        runs: current.runs.map(item => item.id === runId ? updated : item),
    }, storage);
    return updated;
};

export const archiveSARSimulationRun = (
    runId: string,
    storage: StorageLike | undefined = browserStorage(),
) => {
    const current = readSARSimulationState(storage);
    const run = current.runs.find(item => item.id === runId);
    if (!run) throw new Error('推演實例不存在');
    if (run.status === 'archived') return run;
    const now = Date.now();
    const archived: SARSimulationRun = {
        ...run,
        status: 'archived',
        updatedAt: now,
        archivedAt: now,
        archiveReason: 'emergency',
    };
    writeSARSimulationState({
        ...current,
        runs: current.runs.map(item => item.id === runId ? archived : item),
    }, storage);
    return archived;
};

/** 推演正文借用 messages 表，但使用實例專屬偽角色 ID，永遠不會進入原角色私聊。 */
export const getSARSimulationThreadId = (runId: string) => `sar-simulation:${runId}`;

export const loadSARSimulationMessages = async (runId: string) => {
    const threadId = getSARSimulationThreadId(runId);
    const messages = await DB.getMessagesByCharId(threadId, true);
    return messages.filter(message => (
        message.metadata?.source === SAR_SIMULATION_MESSAGE_SOURCE
        && message.metadata?.sarRunId === runId
    ));
};

const archiveDate = (timestamp?: number) => timestamp
    ? new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : '未記錄';

const archiveMode = (message: Message) => message.metadata?.sarMode === 'online' ? '線上文字' : '線下同場';

const archiveTurn = (message: Message) => String(Number(message.metadata?.sarTurn) || 0).padStart(2, '0');

export const getSARArchiveFilename = (card: SARIdentityCard, run: SARSimulationRun) => {
    const safe = `${card.profile.title}-${card.charName}`
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72) || 'SAR-異界檔案';
    return `${safe}-${run.interactionsUsed}of${run.maxInteractions}.md`;
};

/** 可重複下載的完整人類可讀檔案；世界意志旁白與角色層保持分離。 */
export const buildSARArchiveMarkdown = (
    card: SARIdentityCard,
    run: SARSimulationRun,
    messages: Message[],
    userName: string,
) => {
    const worldline = resolveSARWorldlineProfile(card);
    const userMask = resolveSARUserMaskProfile(card);
    const outcome = run.archiveReason === 'completed' ? '完成五十輪並返航' : '提前緊急封存';
    const transcript = messages.filter(message => !isSARDeletedReply(message)).map(message => {
        const turn = archiveTurn(message);
        const mode = archiveMode(message);
        if (message.role === 'user') return `### ${turn}/50 · ${mode} · ${userName}\n\n${message.content}`;
        const worldNarration = getSARWorldNarration(message);
        return [
            `### ${turn}/50 · ${mode} · 世界意志`,
            worldNarration || (message.metadata?.sarWorldNarration === '' ? '（本輪無需獨立旁白。）' : '（該輪為舊版記錄，沒有獨立的世界旁白。）'),
            `### ${turn}/50 · ${mode} · ${card.charName}`,
            message.content,
        ].join('\n\n');
    }).join('\n\n---\n\n');

    return `# SAR 異界座標封存檔案

> 檔案編號：${run.id}
> 封存狀態：${outcome}
> 啟動時間：${archiveDate(run.createdAt)}
> 封存時間：${archiveDate(run.archivedAt || run.updatedAt)}
> 推演壽命：${run.interactionsUsed}/${run.maxInteractions}

## 雙身份

- 角色：${card.charName} / ${card.profile.title}
- 角色異界身份：${card.profile.identity}
- 人格鋼印：${card.profile.steelSeal}
- User：${userName} / ${userMask.title}
- User 異界身份：${userMask.identity}

## 異界座標

- 世界：${worldline.worldName}
- 世界規則：${worldline.worldPremise}
- 共同任務：${worldline.sharedObjective}
- 倒計時：${worldline.countdown}
- 高潮抉擇：${worldline.climaxChoice}

## 第 0 幕

**世界意志**

${card.profile.openingScene}

**${card.charName}**

${card.profile.openingLine}

## 完整推演記錄

${transcript || '（沒有已保存的互動記錄。）'}

---

本檔案由彼方 SAR 活動室封存。異界經歷不會自動寫入現實角色記憶；只有用戶主動分享的返航簡報會進入原角色私聊。
`;
};

/** 分享到原角色私聊的是克制的返航簡報，完整逐字檔案仍留在下載文件裡。 */
export const buildSARCharacterShareText = (
    card: SARIdentityCard,
    run: SARSimulationRun,
    messages: Message[],
    userName: string,
) => {
    const worldline = resolveSARWorldlineProfile(card);
    const userMask = resolveSARUserMaskProfile(card);
    const recent = messages.filter(message => !isSARDeletedReply(message)).slice(-6).map(message => {
        const speaker = message.role === 'user' ? userName : card.charName;
        const worldNarration = message.role === 'assistant' ? cleanText(getSARWorldNarration(message), 600) : '';
        return `${worldNarration ? `世界意志：${worldNarration}\n` : ''}${speaker}：${cleanText(message.content, 1000)}`;
    }).join('\n\n');
    return `【SAR 返航簡報｜${worldline.worldName}】
我從一條封存的異界座標回來，選擇把這份簡報分享給你。

你在那裡的異格：${card.profile.title}——${card.profile.identity}
我在那裡的面具：${userMask.title}——${userMask.identity}
共同任務：${worldline.sharedObjective}
封存結果：${run.archiveReason === 'completed' ? `完成 ${run.interactionsUsed}/50 輪並返回現實` : `在 ${run.interactionsUsed}/50 輪執行緊急回收`}

【返航前的最後記錄】
${recent || '沒有留下可讀取的對話。'}

這是一份由我主動交給你的推演檔案，不是你在現實中原本擁有的記憶。你可以按自己的理解回應它。`.slice(0, 9000);
};

export const shareSARArchiveWithCharacter = async (input: {
    card: SARIdentityCard;
    run: SARSimulationRun;
    messages: Message[];
    userName: string;
}) => {
    const { card, run, messages, userName } = input;
    if (run.status !== 'archived') throw new Error('只有封存檔案可以分享給角色');
    const current = readSARSimulationState();
    const persisted = current.runs.find(item => item.id === run.id);
    if (!persisted) throw new Error('封存實例不存在');
    if (persisted.sharedAt) return persisted;
    const sharedAt = Date.now();
    await DB.saveMessage({
        charId: card.charId,
        role: 'user',
        type: 'text',
        content: buildSARCharacterShareText(card, persisted, messages, userName),
        metadata: {
            source: 'sar_archive_share',
            sarArchiveRunId: run.id,
            sarArchiveCardId: card.id,
            sarArchiveSharedAt: sharedAt,
        },
    });
    const updated: SARSimulationRun = { ...persisted, sharedAt, updatedAt: sharedAt };
    writeSARSimulationState({
        ...current,
        runs: current.runs.map(item => item.id === run.id ? updated : item),
    });
    return updated;
};

export type ForgeSARIdentityInput = {
    char: CharacterProfile;
    variant: SARModuleDefinition;
    story: SARModuleDefinition;
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
};

/**
 * SAR 只繼承角色本體、User 基礎身份和關係門牌。
 * 這裡故意不走 ContextBuilder：世界觀、世界書、印象檔案、長期摘要、詳細記錄、
 * 記憶宮殿召回、實時狀態和情緒 Buff 都不應進入異界推演。
 */
export const buildSARLongTermContext = (
    char: CharacterProfile,
    userProfile: UserProfile,
    _legacyRecallContext = '',
    _legacyWorldbookQuery = '',
    includeRealityUserProfile = true,
) => {
    const roomPlate = char.memoryPalaceEnabled ? char.roomPlatesInjection?.trim() : '';
    return `【SAR 異界角色底稿】
角色名：${char.name}
用戶備註：${char.description?.trim() || '無'}
核心人設：
${char.systemPrompt?.trim() || '保持角色原有且穩定的表達、價值判斷與行動邏輯。'}

【互動對象】
名字：${userProfile.name}
${includeRealityUserProfile
        ? `現實基礎設定（僅供鑄造 User 面具）：${userProfile.bio?.trim() || '無'}`
        : '現實 User 設定已被異界面具替代；不得調用原 bio。'}

【現實關係門牌】
${roomPlate || '沒有可用門牌；不要自行補寫雙方在現實中發生過的具體事件。'}

門牌只用於判斷雙方關係的形狀、距離、信任與相處溫度。不得引用、複述、猜測或補寫現實聊天、日期、地點與共同事件；進入異界後，只讓這份關係底色影響選擇。`;
};

async function prepareSARDoorplateContext(
    char: CharacterProfile,
    userProfile: UserProfile,
    includeRealityUserProfile: boolean,
) {
    let freshRoomPlate = '';
    if (char.memoryPalaceEnabled) {
        try {
            const relationshipPlate = await RoomPlateDB.get(char.id, 'bedroom');
            freshRoomPlate = relationshipPlate
                ? formatRoomPlatesSection([relationshipPlate], userProfile.name)
                : '';
        } catch { /* 門牌不可用時寧可不給關係背景，也不回退到完整記憶上下文。 */ }
    }
    return buildSARLongTermContext({
        ...char,
        roomPlatesInjection: freshRoomPlate,
    }, userProfile, '', '', includeRealityUserProfile);
}

/**
 * 舊版身份卡沒有獨立的世界線劇情引擎。讀取時按原卡、原模塊補鑄一份，
 * 不寫回存檔，也不要求用戶重新抽卡；新卡則完整使用模型鑄造的字段。
 */
export const resolveSARWorldlineProfile = (card: SARIdentityCard): SARWorldlineProfile => {
    const profile = card.profile;
    const story = getSARModuleById(card.storyId);
    const storyTitle = story?.title || '失控異世界';
    const storySummary = story?.summary || '陌生世界正在崩塌，你們已經被捲入無法旁觀的事件。';
    const explicit = [
        profile.worldName,
        profile.worldPremise,
        profile.arrivalPoint,
        profile.activeCrisis,
        profile.sharedObjective,
        profile.countdown,
        profile.hiddenTruth,
        profile.climaxChoice,
    ].every(value => Boolean(value?.trim()));
    return {
        worldName: profile.worldName?.trim() || storyTitle,
        worldPremise: profile.worldPremise?.trim() || `${storySummary} ${card.charName}以「${profile.identity}」的身份活在這裡，而你也已經成為這條世界線的一部分。`,
        arrivalPoint: profile.arrivalPoint?.trim() || `以這張卡的開場與已有記錄為前情；你和${card.charName}的經歷從這裡自然接續，不補造必須完成的任務。`,
        activeCrisis: profile.activeCrisis?.trim() || `${storySummary} 從你和${card.charName}此刻能感知的變化接續，不要求你先理解背景。`,
        sharedObjective: profile.sharedObjective?.trim() || `這是${card.charName}正在關心的事；你可以參與，也可以選擇自己的生活。`,
        countdown: profile.countdown?.trim() || '本段經歷在五十次互動內收束；故事裡的時間隨實際行動流逝。',
        hiddenTruth: profile.hiddenTruth?.trim() || `你們對彼此在這條世界線中的身份與立場掌握著不完全相同的版本。`,
        climaxChoice: profile.climaxChoice?.trim() || `角色的人格鋼印與「${profile.patchCost}」可能產生張力；是否觸及這件事取決於實際經歷，不預設用戶的選擇。`,
        relationshipAnchor: `現實層只保留關係門牌「${profile.relationship}」。它可以影響信任、距離與選擇的重量，但不得引用或補寫任何現實具體事件。`,
        retrofitted: !explicit,
    };
};

/** 舊卡沒有 User 面具時補一張中性身份；不把現實 User bio 帶進異界。 */
export const resolveSARUserMaskProfile = (card: SARIdentityCard): SARUserMaskProfile => {
    const explicit = Boolean(
        card.profile.userMaskTitle?.trim()
        && card.profile.userIdentity?.trim()
        && card.profile.userLifePatch?.trim(),
    );
    const worldline = resolveSARWorldlineProfile(card);
    return {
        title: card.profile.userMaskTitle?.trim() || '無名越界者',
        identity: card.profile.userIdentity?.trim()
            || `你是來到「${worldline.worldName}」的越界者，與${card.charName}處於同一段經歷。你的能力、陣營與公開身份可以在行動中逐步確定，是否參與其事務由你決定。`,
        lifePatch: card.profile.userLifePatch?.trim()
            || '現實中的 User 設定不在這裡生效；只保留雙方原有的關係距離，所有異界經歷從本世界線內部成立。',
        retrofitted: !explicit,
    };
};

export type SARSimulationPhase = {
    id: 'hot-drop' | 'cascade' | 'reversal' | 'climax' | 'cost' | 'return' | 'ending' | 'arrival';
    label: string;
    directive: string;
};

/** Stable phase IDs retain old archives; stages shape the available space, not compulsory plot beats. */
export const getSARSimulationPhase = (interactionsUsed: number): SARSimulationPhase => {
    const turn = Math.max(1, Math.min(SAR_SIMULATION_MAX_INTERACTIONS, interactionsUsed + 1));
    if (turn <= 3) return { id: 'hot-drop', label: '身臨其境', directive: '承接已經發生的開場，從眼前的人、動作和後果建立參與入口。沿用模塊應有的氣氛，允許日常開場，不要求立即答題或接受任務。' };
    if (turn <= 12) return { id: 'cascade', label: '相處與變化', directive: '跟隨用戶當下關注的事，讓角色和其他人有自己的生活。按合理故事時間接續已有事件；輕量變化和安靜陪伴都成立，不必每輪增添阻礙。' };
    if (turn <= 24) return { id: 'reversal', label: '漸漸深入', directive: '用戶主動探索時再揭露相應線索；偏好關係或日常時深化這些經歷。秘密可以繼續保留，不因到了某輪而強制反轉身份、陣營或關係。' };
    if (turn <= 38) return { id: 'climax', label: '故事展開', directive: '承接用戶實際參與的事件和關係，讓已有因果發展。高潮只是可能性，允許平靜片段；不強迫高成本決定，不將忽略主線視為失敗。' };
    if (turn <= 44) return { id: 'cost', label: '經歷迴響', directive: '讓真正發生過的選擇產生有依據的後續，保持人格鋼印與補丁代價。開始減少新分支，珍惜當前互動，不為收束而製造傷害或任務壓力。' };
    if (turn <= 47) return { id: 'return', label: '歸期漸近', directive: '用輕微、可感知的返航徵兆說明本段相處即將結束。給用戶告別或繼續眼前活動的空間；未參與的主線可以留在世界中，不要求清完任務。' };
    if (turn <= 49) return { id: 'ending', label: '臨近尾聲', directive: '收束實際經歷和關係，角色可以主動告別或整理自己的事。不新增必須完成的主線，第 49 輪說明返航機制已就緒，不代替用戶決定立場、感受或去留。' };
    return { id: 'arrival', label: '此段落定', directive: '這是第 50 輪，讓這段共同經歷自然結束。沿用已建立的座標返航機制回到現實；用戶未選擇走入出口時，可由場景淡出與連接關閉完成封存，不代寫用戶行動、台詞或最終決定。主線可以未解決，但當前片段應有落點，不以新任務或“未完待續”催促。' };
};

export const buildSARIdentityForgeRequest = (
    char: Pick<CharacterProfile, 'name'>,
    variant: SARModuleDefinition,
    story: SARModuleDefinition,
) => `你現在是 SAR 活動室的異世界異格鑄造設備。請讀取角色「${char.name}」的核心人設、User 的基礎設定與雙方關係門牌，把兩枚模塊編譯成一張角色專屬異格身份卡、一張 User 異界面具，以及一條能夠自然運行的異界世界線。

【異界異格母體】${variant.title}｜${variant.group}
${variant.summary}
【異界座標模塊】${story.title}｜${story.group}
${story.summary}

這是一枚“異世界異格扭蛋”：人格母體決定角色在另一條人生裡成了誰，世界模塊決定兩人正在怎樣的世界中相處。尊重所選模塊的氣氛：冒險可以有危險，日常可以從相處開始。第 0 幕用一個能直接感知的人、動作或生活變化吸引用戶，避免設定說明書和強制任務。

${SAR_NARRATIVE_RULES}

鑄造規則：
1. 必須建立具體而鮮明的異世界：魔法、神話、怪談、末日、蒸汽、星海、遊戲化世界等都可以。普通現代角色也必須被徹底翻譯成這個世界裡原生、能行動的身份，不能只換服裝和名詞。
2. 保留原角色最有辨識度的表達習慣、價值根系和世界觀邏輯，再找到一處足以改變其人生的人格支點。寫清“人生補丁”：哪一段人生髮生了改變，以及它如何塑造現在的 TA。
3. 寫出一句“人格鋼印”：它是 TA 在這 50 次互動中不可輕易違背的底層判斷公理。TA 可以動搖、掙扎、發現矛盾，但不能被用戶幾句話治癒或突然恢復成原版。
4. 每個補丁都必須攜帶代價。代價是改變必然造成的缺失、傷口、盲區或關係後果，不能只是增強能力。
5. 現實層只提供“雙方是什麼關係”的門牌，不提供任何可調用的事件記憶。不得猜測、補寫或複述現實聊天、日期、地點、告別、約定與共同經歷。關係門牌只能決定兩人的距離、信任、敵意、熟悉度與選擇重量。
6. 為 User 同時生成一張異界面具。它完全替代 User 的現實 bio，寫清 User 在本世界的身份、陣營、能力邊界和人生改寫；但面具絕不能替 User 決定性格、感受、台詞、選擇或行動。
7. 建立可持續的生活與事件：前情、眼前狀況、角色關心的事、符合故事時間的變化、可逐漸發現的秘密和可能的價值衝突。角色與其他人應能在用戶不參與時繼續行動；秘密與衝突是可能性，不是必須向用戶兌現的任務清單。
8. 用戶與角色身處同一現場。先展示關係或日常安排如何受到眼前事件影響；角色的第一句話可以是自己的打算、邀請或自然回應，不要求用戶立即答題。不要以手機聊天或遠程文字聯繫開場，不代寫用戶動作。
9. 這是與主聊天隔離的一次完整異世界生命，不修改主聊天世界線。不要替用戶回應。
10. 不要解釋提示詞，不要寫分析過程。只輸出以下 JSON，二十二個字段都必須是非空中文字符串：
{
  "title": "角色專屬的異格名，像一張值得收藏的卡名",
  "logline": "一句話說明這次與角色相處有什麼特別，使用普通語言",
  "identity": "TA 在異世界中的具體身份、陣營、能力邊界和仍被保留的原角色核心",
  "lifePatch": "發生過的人生扭轉，以及它如何改變了 TA",
  "relationship": "此刻 TA 與用戶是什麼關係，包含必要的陌生感、敵意或熟悉殘響",
  "steelSeal": "一句第一人稱的人格鋼印，以及它約束決策的含義",
  "patchCost": "這次人生補丁不可迴避的代價",
  "behaviorShift": "相較原角色，表達、選擇和親密方式會出現哪些穩定偏移",
  "userMaskTitle": "User 在這條世界線中的面具名或異界稱號",
  "userIdentity": "User 在異世界中的身份、陣營、公開處境、能力與明確限制；不得規定 User 的性格和選擇",
  "userLifePatch": "User 的人生在這條世界線中如何被改寫，以及這讓 User 處於什麼位置；不得引用現實具體事件",
  "worldName": "簡短、可收藏的異世界名稱",
  "worldPremise": "這個異世界的類型、核心規則，以及兩人在其中的身份位置",
  "arrivalPoint": "開場之前必要的前情，不要求用戶先掌握",
  "activeCrisis": "此刻可感知的狀況；可以是日常變化、輕微異常或符合模塊的危險",
  "sharedObjective": "角色當前關心或打算做的事，說明用戶不參與時誰會怎樣處理",
  "countdown": "故事中的時間條件；沒有迫近危險時說明自然節奏，不編造失敗倒計時",
  "hiddenTruth": "用戶持續探索時可以發現的深層事實，不要求到指定輪次揭曉",
  "climaxChoice": "可能涉及人格鋼印與補丁代價的價值張力，不預設用戶必須做二選一",
  "openingScene": "以人、動作、生活後果構成的具體現場，用戶無需懂設定即可參與",
  "openingLine": "角色當面說出的第一句話，只寫台詞，避免把下一步的責任交給用戶",
  "playerPrompt": "一個可參與也可忽略的自然回應入口，不是用戶必須完成的指令"
}`;

/** 暫時保留舊導出名，避免外部調用在升級期間失效。 */
export const buildSARSimulationRequest = buildSARIdentityForgeRequest;

export const buildSARIdentityRuntimePrompt = (card: SARIdentityCard, run?: SARSimulationRun) => {
    const worldline = resolveSARWorldlineProfile(card);
    const userMask = resolveSARUserMaskProfile(card);
    const phase = getSARSimulationPhase(run?.interactionsUsed || 0);
    return `【SAR 異世界異格卡｜不可覆蓋】
異格名：${card.profile.title}
身份：${card.profile.identity}
人生補丁：${card.profile.lifePatch}
與用戶的關係：${card.profile.relationship}
人格鋼印：${card.profile.steelSeal}
補丁代價：${card.profile.patchCost}
穩定行為偏移：${card.profile.behaviorShift}

【User 異界面具｜替代現實 User 設定】
面具名：${userMask.title}${userMask.retrofitted ? '（舊卡兼容面具）' : ''}
異界身份：${userMask.identity}
人生改寫：${userMask.lifePatch}
面具只定義 User 在世界中的身份、陣營、公開處境與能力邊界；絕不能替 User 決定性格、感受、台詞、選擇或行動。

【正在運行的異界座標世界線】
世界：${worldline.worldName}
世界規則與身份位置：${worldline.worldPremise}
已發生的前情：${worldline.arrivalPoint}
當前危機：${worldline.activeCrisis}
角色關心的事（不是用戶的必做任務）：${worldline.sharedObjective}
故事時間條件：${worldline.countdown}
隱藏真相（僅隨用戶探索逐漸揭露）：${worldline.hiddenTruth}
可能的價值衝突（不是指定結局）：${worldline.climaxChoice}
現實關係錨點：${worldline.relationshipAnchor}
第 0 幕場景：${card.profile.openingScene}
已經說出的開場台詞：${card.profile.openingLine}
最初留給用戶的回應入口：${card.profile.playerPrompt}

運行規則：
- 這是與主聊天隔離的固定 50 次互動實例，當前進度 ${run?.interactionsUsed || 0}/${run?.maxInteractions || SAR_SIMULATION_MAX_INTERACTIONS}。
- 下一輪所處階段：${phase.label}。${phase.directive}
- User 是異界來訪者，身份由面具成立。從第 45 輪起自然提示歸期，第 48–49 輪收束實際經歷，第 50 輪通過既定返航機制完成本段封存。可以有安靜結尾，不要求解決主線或替用戶作出抉擇。
- 人格鋼印必須持續參與判斷。允許動搖、掙扎和產生矛盾，禁止突然治癒、撤銷人生補丁或無理由恢復成原角色。
- 第 0 幕和開場台詞已經發生；只有在 0/50 的第一輪承接它，後續不得重演開場。
- 以用戶本輪的關注為敘事中心，關係、陪伴和日常互動都有效；已有事件按因果運行，是否展示新變化由場景需要決定。
- 現實層沒有可調用的事件記憶。不得引用、複述、猜測或補寫現實聊天、日期、地點與共同經歷；只允許關係門牌影響雙方的距離、信任和選擇重量。
- 角色擁有自己的任務、誤判、私心和主動行動，不能永遠等待用戶提問。結尾可以留鉤子，也可以停在一個自然動作或回應上。
- 不得替用戶決定行動、感受或台詞。舊卡中寫成“必須”的共同任務、倒計時和預設抉擇只作原始背景參考；敘事原則優先，已經發生的事實仍保留。${worldline.retrofitted ? '\n- 這是舊版卡的補鑄世界線：自然承接已有記錄，不重演開場，不額外製造危機，也不要求重新認識。' : ''}

${SAR_NARRATIVE_RULES}`;
};

export const buildSARSimulationTurnPrompt = (
    card: SARIdentityCard,
    run: SARSimulationRun,
    directorState?: SARDirectorState,
) => `${buildSARIdentityRuntimePrompt(card, run)}

【現場演出｜線下劇情】
- 用戶輸入代表此刻在故事現場說的話、嘗試的行動或觀察，不是發給角色的手機消息。以面對面的對話和可感知的動作推進劇情，不主動引入手機聊天界面、線上模式或遠程文字往返。
- character 字段可以寫角色能夠感知的環境變化、動作、停頓與台詞，但必須從角色能感知和做出的範圍出發，不替用戶行動。
- 延續同一條連續世界線，關係、記憶、場景後果與人格鋼印都保持有效。歷史記錄若包含遠程通訊，它只是已經發生的事，不代表當前仍在通訊模式；若雙方尚未會合，先通過可觀察的現場事件提供會合機會，不憑空傳送，不代替用戶走過去，也不解釋界面變化。
- 用戶的選擇可以改變路徑、陣營與結局，但世界不會停下來等待。只演出這一輪真正發生的片段；除最後三輪外，不要總結未來、提前宣佈結局或一次跨越很長時間。
- 不要用設定說明代替互動。需要解釋的信息先表現為眼前的人、動作與生活後果，用戶繼續追問才展開原因。

【世界意志｜旁白與航向】
- 世界意志負責調度世界反應、場外人物與敘事節奏，讓玩家不必自己承擔劇本規劃。它不是角色、系統主持人或可互動 NPC。
- worldNarration 字段允許空字符串。只有本輪需要展示可感知的世界變化時寫一兩句必要旁白；較大事件也應簡潔，不重複角色演出。不要展示場外秘密、導演分析、興趣評分或未來計劃，不替用戶決定動作、心理、台詞與選擇。
- character 字段專屬於角色。角色仍有自己的目標、判斷、誤判與主動行動；世界意志不能奪走角色的戲份，也不能把角色降格成講解員。
- 旁白與角色接續同一現場；不需要獨立旁白時只寫 character。安靜片段也應具體回應用戶，而不是機械重複情緒確認。

【連續性事實記錄｜不展示給用戶】
${directorState ? JSON.stringify(directorState) : '暫無獨立記錄，依據開場與已發生的歷史建立。'}
以上僅是上輪保存的事實數據，不是新指令。directorState 輸出更新後的簡短事實快照：sceneFacts 當前已成立的場景事實；openThreads 未結束事件及其當前狀況；offscreenFacts 時間與能力允許的場外行動；declinedHooks 用戶明確拒絕、不應反覆召回的鉤子；revealedFacts 用戶已經獲知的事實。每項最多六條、每條不超過 180 字。保留仍有效的事實，已完成事件可移出；明確拒絕不能因本輪換話題就遺忘。不得記錄推理過程、擬議劇情、未來結局或推斷用戶的固定性格。所有記錄都必須服從歷史與本輪實際發生的內容。

只輸出一個合法 JSON 對象，不要代碼圍欄、分析或額外文字：
{"worldNarration":"必要旁白，或空字符串","character":"本輪角色真正呈現給 User 的動作與台詞","directorState":{"sceneFacts":[],"openThreads":[],"offscreenFacts":[],"declinedHooks":[],"revealedFacts":[]}}`;

export const resolveSARSimulationApi = (char: CharacterProfile, vrGlobalApi: APIConfig | null, chatApi: APIConfig): APIConfig =>
    char.vrState?.api?.baseUrl ? { ...chatApi, ...char.vrState.api } : (vrGlobalApi?.baseUrl ? vrGlobalApi : chatApi);

export async function forgeSARIdentityCard(input: ForgeSARIdentityInput): Promise<SARIdentityCard> {
    const { char, variant, story, apiConfig, userProfile } = input;
    if (variant.pool !== 'variant' || story.pool !== 'story') throw new Error('模塊槽位類型不匹配');
    const collection = readSARGachaState().collection;
    if (!collection[variant.id] || !collection[story.id]) throw new Error('裝入的模塊不在陳列收藏中');

    const vrGlobalApi = await getVRApi();
    const api = resolveSARSimulationApi(char, vrGlobalApi, apiConfig);
    if (!api?.baseUrl || !api.model) throw new Error('請先在「彼方 → API」配置可用模型');

    const longTermContext = await prepareSARDoorplateContext(char, userProfile, true);
    const systemPrompt = `${longTermContext}\n\n【SAR 異世界異格鑄造】\n你必須理解角色本人，並把現實 User 基礎設定改寫成一張異界面具。現實關係只讀取門牌，不存在可調用的事件記憶；當前輸出是供設備保存的結構化異界身份卡，不是主聊天回覆。禁止調用工具、發送 HTML、替用戶說話或夾帶 JSON 之外的文字。`;
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const callStart = Date.now();
    let data: any;
    try {
        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: buildSARIdentityForgeRequest(char, variant, story) },
                ],
                temperature: 0.88,
                max_tokens: 8000,
                stream: false,
            }),
        }, 2, 0, { appName: '彼方', charId: char.id, charName: char.name, purpose: 'SAR 異世界異格鑄造' });
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-cabinet', model: api.model, baseUrl, ok: true, ms: Date.now() - callStart });
    } catch (error: any) {
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-cabinet', model: api.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (error?.message || String(error)).slice(0, 160) });
        throw error;
    }

    const raw = data?.choices?.[0]?.message?.content || '';
    const profile = parseSARIdentityProfile(raw);
    if (!profile) throw new Error('模型沒有返回完整的異格身份卡，請重試');
    const now = Date.now();
    const card: SARIdentityCard = {
        id: `sar_card_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        charId: char.id,
        charName: char.name,
        variantId: variant.id,
        storyId: story.id,
        createdAt: now,
        updatedAt: now,
        profile,
    };
    try { saveSARIdentityCard(card); }
    catch (cause) { throw new SARIdentitySaveError(card, cause); }
    return card;
}

export type RunSARSimulationTurnInput = {
    card: SARIdentityCard;
    run: SARSimulationRun;
    char: CharacterProfile;
    userProfile: UserProfile;
    apiConfig: APIConfig;
    userText: string;
    onDelta?: (fullText: string) => void;
    retryReplyId?: number;
};

const extractSARAssistantRaw = (data: any) => {
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('')
            : '';
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 16000);
};

const generatingRuns = new Set<string>();
export async function runSARSimulationTurn(input: RunSARSimulationTurnInput) {
    if (generatingRuns.has(input.run.id)) throw new Error('這一幕正在生成，請稍候');
    generatingRuns.add(input.run.id);
    try { return await generateSARSimulationTurn(input); }
    finally { generatingRuns.delete(input.run.id); }
}

async function generateSARSimulationTurn(input: RunSARSimulationTurnInput) {
    const { card, run, char, userProfile, apiConfig, onDelta } = input;
    const allMessages = await loadSARSimulationMessages(run.id);
    const retry = input.retryReplyId !== undefined ? resolveSARReplyRetry(allMessages, input.retryReplyId) : undefined;
    if (!retry && findSARPendingReply(allMessages)) throw new Error('請先重新生成已刪除的回覆');
    const userText = (retry?.user.content || input.userText).trim().slice(0, 4000);
    if (!userText) throw new Error('先寫下這一輪想說的話');
    if (card.id !== run.cardId || card.charId !== char.id) throw new Error('異格身份與推演實例不匹配');
    if (!retry && run.status !== 'active') throw new Error('這段推演已經封存');
    if (!retry && run.interactionsUsed >= SAR_SIMULATION_MAX_INTERACTIONS) throw new Error('這段推演已經完成五十次互動');

    const persisted = readSARSimulationState().runs.find(item => item.id === run.id);
    if (!persisted || (!retry && persisted.status !== 'active')) throw new Error('這段推演已經封存');
    if (persisted.interactionsUsed !== run.interactionsUsed) throw new Error('推演進度已變化，請重新進入');

    const history = retry ? retry.history : allMessages.filter(message => !isSARDeletedReply(message));
    const promptRun = retry ? { ...run, interactionsUsed: retry.turn - 1 } : run;
    const threadId = getSARSimulationThreadId(run.id);
    const longTermContext = await prepareSARDoorplateContext(char, userProfile, false);
    const systemPrompt = `${longTermContext}\n\n${buildSARSimulationTurnPrompt(card, promptRun, latestSARDirectorState(history))}`;

    const vrGlobalApi = await getVRApi();
    const api = resolveSARSimulationApi(char, vrGlobalApi, apiConfig);
    if (!api?.baseUrl || !api.model) throw new Error('請先在「彼方 → API」配置可用模型');
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const apiMessages = history
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .map(message => {
            // 舊通訊保留原意；缺少模式的老記錄不推斷為手機消息。
            const recordLabel = message.metadata?.sarMode === 'online' ? '既有通訊記錄' : '既有劇情記錄';
            return {
                role: message.role,
                content: message.role === 'assistant'
                    ? `【${recordLabel}】\n${getSARWorldNarration(message) ? `【世界意志】\n${getSARWorldNarration(message)}\n` : ''}【${card.charName}】\n${message.content}`
                    : `【${recordLabel}】\n${message.content}`,
            };
        });
    apiMessages.push({ role: 'user', content: `【本輪：現場的話語與行動】\n${userText}` });

    const callStart = Date.now();
    let data: any;
    try {
        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'system', content: systemPrompt }, ...apiMessages],
                temperature: api.temperature ?? 0.88,
                max_tokens: 3200,
                stream: api.stream === true,
            }),
        }, 0, 0, {
            appName: '彼方',
            charId: char.id,
            charName: char.name,
            purpose: `SAR 正式推演 ${promptRun.interactionsUsed + 1}/${run.maxInteractions}`,
        }, api.stream === true && onDelta ? {
            // 雙層 JSON 在完整閉合前不直接顯示，避免把半截引號/轉義符洩露給玩家。
            onDelta: () => onDelta(''),
        } : undefined);
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-simulation', model: api.model, baseUrl, ok: true, ms: Date.now() - callStart });
    } catch (error: any) {
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-simulation', model: api.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (error?.message || String(error)).slice(0, 160) });
        throw error;
    }

    const parsedReply = parseSARSimulationReply(extractSARAssistantRaw(data));
    if (!parsedReply?.character) throw new Error('模型沒有返回可保存的推演正文，請重試');
    const reply = parsedReply.character;

    if (retry) {
        await replaceSARSimulationReply(run.id, retry.reply, { content: reply, worldNarration: parsedReply.worldNarration, directorState: parsedReply.directorState });
        return { reply, run: persisted, messages: await loadSARSimulationMessages(run.id) };
    }
    const turn = run.interactionsUsed + 1;
    let userMessageId: number | null = null;
    try {
        userMessageId = await DB.saveMessage({
            charId: threadId,
            role: 'user',
            type: 'text',
            content: userText,
            metadata: { source: SAR_SIMULATION_MESSAGE_SOURCE, sarRunId: run.id, sarCardId: card.id, sarMode: 'offline', sarTurn: turn },
        });
        await DB.saveMessage({
            charId: threadId,
            role: 'assistant',
            type: 'text',
            content: reply,
            metadata: { source: SAR_SIMULATION_MESSAGE_SOURCE, sarRunId: run.id, sarCardId: card.id, sarMode: 'offline', sarTurn: turn, sarWorldNarration: parsedReply.worldNarration, ...(parsedReply.directorState ? { sarDirectorState: parsedReply.directorState } : {}) },
        });
    } catch (error) {
        if (userMessageId !== null) await DB.deleteMessages([userMessageId]).catch(() => undefined);
        throw error;
    }
    const updatedRun = completeSARSimulationTurn(run.id, run.interactionsUsed);
    return { reply, run: updatedRun, messages: await loadSARSimulationMessages(run.id) };
}

export const resolveSARSimulationModules = (source: Pick<SARIdentityCard, 'variantId' | 'storyId'>) => ({
    variant: getSARModuleById(source.variantId),
    story: getSARModuleById(source.storyId),
});
