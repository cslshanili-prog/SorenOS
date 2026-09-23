import type { CharacterProfile, Message } from '../types';
import { DB } from './db';

export const CONTEXT_RANGE_POLICY_VERSION = 1;
export const DEFAULT_MANUAL_CONTEXT_LIMIT = 500;
export const MIN_MANUAL_CONTEXT_LIMIT = 10;
export const MAX_MANUAL_CONTEXT_LIMIT = 5000;

export type ContextRangeMode = 'adaptive' | 'manual';

export interface ContextRangeSnapshot {
    mode: ContextRangeMode;
    hwm: number;
    maxRangeStartMessageId?: number;
    effectiveStartMessageId?: number;
    userStartMessageId?: number;
    userBreakpointExpired: boolean;
    messages: Message[];
}

export interface CharacterContextRangeMigration {
    character: CharacterProfile;
    migrated: boolean;
    resetAutoContext: boolean;
}

const positiveMessageId = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;

export const clampManualContextLimit = (value: unknown): number => {
    const parsed = typeof value === 'number' && Number.isFinite(value)
        ? Math.floor(value)
        : DEFAULT_MANUAL_CONTEXT_LIMIT;
    return Math.max(MIN_MANUAL_CONTEXT_LIMIT, Math.min(MAX_MANUAL_CONTEXT_LIMIT, parsed));
};

/**
 * adaptive 只在有明確來源時接管範圍：全自動記憶，或用戶主動執行過一鍵存入。
 * 單獨殘留一個 adaptive 舊字段仍按 manual 處理，避免不存在的自動模式限制用戶。
 */
export const resolveContextRangeMode = (char: CharacterProfile): ContextRangeMode =>
    char.contextRangeMode === 'adaptive'
    && (char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm)
        ? 'adaptive'
        : 'manual';

export const getMemoryPalaceHighWaterMarkForContext = (charId: string): number => {
    try {
        const value = parseInt(localStorage.getItem(`mp_lastMsgId_${charId}`) || '0', 10);
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
};

/**
 * 一次性遷移舊角色：
 * - 已開全自動記憶：無論舊拉桿是否為 5000，都回到 adaptive + 默認 500；
 * - 未開全自動：保留舊拉桿，並把舊版手動斷點遷成用戶斷點。
 *
 * hideBeforeMessageId 仍保留給舊歸檔內部使用，但新版 prompt 不再把它當用戶範圍。
 */
export const migrateCharacterContextRange = (
    char: CharacterProfile,
): CharacterContextRangeMigration => {
    if ((char.contextRangePolicyVersion || 0) >= CONTEXT_RANGE_POLICY_VERSION) {
        return { character: char, migrated: false, resetAutoContext: false };
    }

    const resetAutoContext = !!char.autoArchiveEnabled;
    const next: CharacterProfile = {
        ...char,
        contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
        contextRangeMode: resetAutoContext ? 'adaptive' : 'manual',
        contextLimit: resetAutoContext
            ? DEFAULT_MANUAL_CONTEXT_LIMIT
            : clampManualContextLimit(char.contextLimit),
        contextUserStartMessageId: resetAutoContext
            ? undefined
            : positiveMessageId(char.hideBeforeMessageId),
    };

    return { character: next, migrated: true, resetAutoContext };
};

const chronologicalPrivateMessages = (messages: Message[]): Message[] =>
    messages
        .filter(message => !message.groupId)
        .slice()
        .sort((a, b) => a.id - b.id);

/**
 * 純邊界計算。方向不變式（Message.id 越大越新）：
 * - 最大範圍起點越大，可讀範圍越小；
 * - 用戶斷點只能 >= 最大範圍起點；
 * - 最終起點永遠取兩者中更大的 id，絕不會越過最大範圍向舊消息擴張。
 */
export const computeContextRangeSnapshot = (
    sourceMessages: Message[],
    char: CharacterProfile,
    hwm: number,
): ContextRangeSnapshot => {
    const allMessages = chronologicalPrivateMessages(sourceMessages);
    const mode = resolveContextRangeMode(char);
    const maxRangeMessages = mode === 'adaptive'
        ? allMessages.filter(message => message.id > hwm)
        : allMessages.slice(-clampManualContextLimit(char.contextLimit));

    const maxRangeStartMessageId = maxRangeMessages[0]?.id;
    const latestMessageId = maxRangeMessages[maxRangeMessages.length - 1]?.id;
    const requestedUserStart = positiveMessageId(char.contextUserStartMessageId);
    const requestedMessageStillExists = requestedUserStart === undefined
        || maxRangeMessages.some(message => message.id === requestedUserStart);
    const userBreakpointExpired = !!requestedUserStart && (
        maxRangeStartMessageId === undefined
        || latestMessageId === undefined
        || requestedUserStart < maxRangeStartMessageId
        || requestedUserStart > latestMessageId
        || !requestedMessageStillExists
    );
    const userStartMessageId = userBreakpointExpired ? undefined : requestedUserStart;
    const effectiveStartMessageId = maxRangeStartMessageId === undefined
        ? undefined
        : Math.max(maxRangeStartMessageId, userStartMessageId || maxRangeStartMessageId);
    const messages = effectiveStartMessageId === undefined
        ? []
        : maxRangeMessages.filter(message => message.id >= effectiveStartMessageId);

    return {
        mode,
        hwm,
        maxRangeStartMessageId,
        effectiveStartMessageId,
        userStartMessageId,
        userBreakpointExpired,
        messages,
    };
};

/**
 * AI 上下文讀取：
 * - adaptive 讀取水位線後的完整原文（全自動記憶或一鍵存入後的水位跟隨）；
 * - manual 忽略水位線，讀取完整庫最近 N 條；
 * - 隨後再用用戶斷點收窄。
 */
export const loadCharacterContextRange = async (
    char: CharacterProfile,
): Promise<ContextRangeSnapshot> => {
    const hwm = getMemoryPalaceHighWaterMarkForContext(char.id);
    const mode = resolveContextRangeMode(char);
    const sourceMessages = mode === 'adaptive'
        ? (await DB.getMessagesFromId(char.id, hwm + 1)).messages
        : await DB.getRecentMessagesByCharId(
            char.id,
            clampManualContextLimit(char.contextLimit),
            true,
        );
    return computeContextRangeSnapshot(sourceMessages, char, hwm);
};

export const countMessagesFrom = (messages: Message[], messageId: number): number =>
    chronologicalPrivateMessages(messages).filter(message => message.id >= messageId).length;

/** 所有 AI 入口共用的原文範圍。UI 瀏覽、導出、記憶整理仍直接使用 DB。 */
export const loadCharacterContextMessages = async (
    character: CharacterProfile | string,
): Promise<Message[]> => {
    const char = typeof character === 'string' ? await DB.getCharacter(character) : character;
    if (!char) return [];
    return (await loadCharacterContextRange(char)).messages;
};

/** 已有消息快照的入口也遵守同一邊界，不能用殘留的手動條數截斷自適應範圍。 */
export const selectCharacterContextMessages = (messages: Message[], char: CharacterProfile, hwm = getMemoryPalaceHighWaterMarkForContext(char.id)): Message[] =>
    computeContextRangeSnapshot(messages, (char.contextRangePolicyVersion || 0) >= 1 ? char : {
        ...char, contextUserStartMessageId: char.contextUserStartMessageId ?? char.hideBeforeMessageId,
    }, hwm).messages;
