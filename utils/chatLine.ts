/**
 * 關係線：一個角色 × 一張身份卡（plans/persona-line-batch1-2.md）。
 *
 * - 主線＝角色升級前那條線（CharacterProfile.primaryPersonaKey）。主線的訊息不寫 personaKey，
 *   關係欄位用角色卡頂層的；所以舊資料不用搬，沒標身份的一律算主線。
 * - 其他線的關係欄位存在 CharacterProfile.lines[personaKey]。
 * - 跟著線走的欄位分兩類（types.ts 的 LineStateField / LineSettingField，清單只在這裡列一次）：
 *   關係狀態新線從空白開始；聊天設定這條線沒設就照主線。
 */
import type {
    CharacterProfile, CharLineFields, ChatLine, LineField, LineSettingField, LineStateField, UserProfile,
} from '../types';
import { LINE_VIEW_PERSONA, lineViewPersonaKey, personaKeyForChar } from './userPersona';

export const LINE_STATE_FIELDS = [
    'impression', 'chatNickname', 'userNickname', 'userViewRelationship', 'charViewRelationship',
    'acquaintanceStartDate', 'savedDateState', 'activeDateStoryId', 'dateNextStoryTime', 'dateScenario',
    'dateOfflinePause', 'chatBlock', 'chatBlockLog', 'charBlockCooldown', 'specialMomentRecords',
    'affinities', 'contextUserStartMessageId', 'hideBeforeMessageId', 'refinedMemories', 'activeMemoryMonths',
    'memoryPalaceInjection', 'roomPlatesInjection',
] as const satisfies readonly LineStateField[];

export const LINE_SETTING_FIELDS = [
    'chatBackground', 'chatAppearance', 'chatDecorationCssIsolated', 'bubbleStyle', 'chatFineTune',
    'chromeCustomCss', 'chatSound', 'chatSoundBound', 'dateBackground', 'dateAppearance', 'dateOfflineMode',
    'contextLimit', 'contextRangeMode', 'contextFollowsMemoryPalaceHwm', 'contextRangePolicyVersion', 'hideSystemLogs',
    'readNoReply', 'delayedReply', 'dateInvite', 'onlineActions', 'charCall', 'allowCharBlockUser',
    'allowCharChangeRelationship', 'tempChatLimits', 'replyDrafts',
    'chatVoiceEnabled', 'chatVoiceAutoPlay', 'chatVoiceLang', 'dateVoiceEnabled', 'dateVoiceLang', 'callVoiceLang',
    'showThinkingChain', 'thinkingChainStyle', 'thinkingChainCustomColors', 'thinkingChainCustomPrompt', 'thinkingChainCustomCss',
    'htmlModeEnabled', 'htmlModeCustomPrompt', 'chatCollaborationEnabled',
] as const satisfies readonly LineSettingField[];

// 兩份清單要剛好蓋滿 types.ts 的聯合型別：少列一個，這兩行就編譯不過。
const stateFieldsComplete: Exclude<LineStateField, typeof LINE_STATE_FIELDS[number]> extends never ? true : never = true;
const settingFieldsComplete: Exclude<LineSettingField, typeof LINE_SETTING_FIELDS[number]> extends never ? true : never = true;
void stateFieldsComplete; void settingFieldsComplete;

const STATE_SET: ReadonlySet<string> = new Set(LINE_STATE_FIELDS);
const SETTING_SET: ReadonlySet<string> = new Set(LINE_SETTING_FIELDS);

export function isLineField(key: string): key is LineField {
    return STATE_SET.has(key) || SETTING_SET.has(key);
}

/** 角色的主線。 */
export function primaryLine(charId: string): ChatLine {
    return { charId };
}

export function isPrimaryLine(line: ChatLine): boolean {
    return !line.personaKey;
}

/** 角色跟某張身份卡的那條線；是主線就回主線（不帶 personaKey），寫訊息、查訊息都靠這個一致。 */
export function lineFor(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>, personaKey: string | undefined): ChatLine {
    if (!personaKey || personaKey === char.primaryPersonaKey) return { charId: char.id };
    return { charId: char.id, personaKey };
}

/** 一條線的字串鍵（未讀數、快取之類的 Record 鍵）。主線就是 charId，跟舊資料一樣。 */
export function lineKey(line: ChatLine): string {
    return line.personaKey ? `${line.charId}::${line.personaKey}` : line.charId;
}

/** 這條線上的你是哪張身份卡。主線用角色的 primaryPersonaKey（還沒補的舊角色回 undefined）。 */
export function linePersonaKey(char: Pick<CharacterProfile, 'primaryPersonaKey'>, line: ChatLine): string | undefined {
    return line.personaKey || char.primaryPersonaKey;
}

/**
 * 舊角色沒有 knownPersonaKeys / primaryPersonaKey：用它現在認識的那張卡（personaKeyForChar）補上。
 * 已經有就原樣回傳（同一個物件），呼叫端可以拿 === 判斷要不要存回去。
 */
export function withLineFields(profileBase: UserProfile, char: CharacterProfile): CharacterProfile {
    if (char.primaryPersonaKey && char.knownPersonaKeys?.includes(char.primaryPersonaKey)) return char;
    const primary = char.primaryPersonaKey || personaKeyForChar(profileBase, char);
    const known = char.knownPersonaKeys?.length ? char.knownPersonaKeys : [primary];
    return {
        ...char,
        primaryPersonaKey: primary,
        knownPersonaKeys: known.includes(primary) ? known : [primary, ...known],
    };
}

export { LINE_VIEW_PERSONA, lineViewPersonaKey };
type LineView = CharacterProfile & { [LINE_VIEW_PERSONA]?: string };

/**
 * 合成某條線看到的角色卡：關係狀態換成那條線的（沒有就是空），聊天設定那條線有設才換。
 * 主線直接回原物件。現有讀 char.impression 這類欄位的程式拿到視圖就讀對了。
 */
export function lineView(char: CharacterProfile, line: ChatLine): CharacterProfile {
    if (isPrimaryLine(line)) return char;
    const own: CharLineFields = char.lines?.[line.personaKey!] || {};
    const view: Record<string, unknown> = { ...char };
    for (const f of LINE_STATE_FIELDS) {
        if (own[f] === undefined) delete view[f];
        else view[f] = own[f];
    }
    for (const f of LINE_SETTING_FIELDS) {
        if (own[f] !== undefined) view[f] = own[f];
    }
    (view as unknown as LineView)[LINE_VIEW_PERSONA] = line.personaKey;
    return view as unknown as CharacterProfile;
}

/** 把一份改動拆成「角色自己的」和「跟著線走的」。 */
export function splitLinePatch(patch: Partial<CharacterProfile>): { charPatch: Partial<CharacterProfile>; linePatch: CharLineFields } {
    const charPatch: Record<string, unknown> = {};
    const linePatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (isLineField(k)) linePatch[k] = v;
        else charPatch[k] = v;
    }
    return { charPatch: charPatch as Partial<CharacterProfile>, linePatch: linePatch as CharLineFields };
}

/**
 * 某條線上的改動，換算成要存到角色卡上的 patch。主線原樣回傳；其他線的關係欄位寫進
 * lines[personaKey]（設成 undefined ＝ 這條線不再自己設，聊天設定回到照主線）。
 */
export function linePatchForChar(char: CharacterProfile, line: ChatLine, patch: Partial<CharacterProfile>): Partial<CharacterProfile> {
    if (isPrimaryLine(line)) return patch;
    const { charPatch, linePatch } = splitLinePatch(patch);
    if (Object.keys(linePatch).length === 0) return charPatch;
    const pk = line.personaKey!;
    const merged: Record<string, unknown> = { ...(char.lines?.[pk] || {}), ...linePatch };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    return { ...charPatch, lines: { ...(char.lines || {}), [pk]: merged as CharLineFields } };
}

/**
 * 從角色卡（可能是線視圖）拿「讀私聊用的線」：主線回 charId 字串（跟舊呼叫一模一樣），
 * 非主線回 ChatLine。私聊、通話、見面拿到的 char 是線視圖，所以讀訊息一律寫
 * `DB.getRecentMessagesByCharId(lineArgOf(char), …)`，不要寫 char.id。
 */
export function lineArgOf(char: Pick<CharacterProfile, 'id'>): string | ChatLine {
    const personaKey = lineViewPersonaKey(char);
    return personaKey ? { charId: char.id, personaKey } : char.id;
}

/** 這份角色卡（可能是線視圖）是哪條線。 */
export function lineOf(char: Pick<CharacterProfile, 'id'>): ChatLine {
    const personaKey = lineViewPersonaKey(char);
    return personaKey ? { charId: char.id, personaKey } : { charId: char.id };
}

/**
 * 寫私聊訊息時的歸屬欄位：`DB.saveMessage({ ...lineMsgFields(char), role, … })`。
 * 主線只有 charId（不寫 personaKey），非主線多帶 personaKey。
 */
export function lineMsgFields(char: Pick<CharacterProfile, 'id'>): { charId: string; personaKey?: string } {
    const personaKey = lineViewPersonaKey(char);
    return personaKey ? { charId: char.id, personaKey } : { charId: char.id };
}
