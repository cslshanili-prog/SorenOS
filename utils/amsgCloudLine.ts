/**
 * 關係線 × 主動消息 2.0／即時對話（plans/persona-line-batch3.md 的 3b）。
 *
 * 雲端只認一個 charId 字串：任務、fire_pack、limits、每日計數、chat_outbox 全按它分。
 * 非主線就當成雲端的另一個角色，id 用 lineScheduleId（`c1~line~pB`），主線還是 charId，
 * 所以舊資料、舊任務一個都不用搬，Worker 也不用改。
 *
 * - 上傳（排任務、fire_pack、即時對話、延遲回覆）：雲端 id 一律寫 cloudCharId(char)，
 *   char 是那條線的視圖。本地讀訊息照舊用 lineArgOf(char)。
 * - 收件（收件箱、chat_outbox、推播、狀態檢查）：拿到的 charId 用 findCloudChar 找回
 *   那條線的視圖；要改角色卡就走 cloudCharPatch（非主線寫進 lines[pk]）。
 * - DB 讀寫私聊也認得這種 id（db.ts 的 asLine / saveMessage），漏接的地方至少不會寫錯線。
 */
import type { CharacterProfile, ChatLine } from '../types';
import {
    knowsPersona, lineOf, linePatchForChar, lineScheduleId, lineView, parseLineScheduleId,
} from './chatLine';

/** 這份角色卡（可能是線視圖）在雲端的 id。 */
export const cloudCharId = (char: Pick<CharacterProfile, 'id'>): string => lineScheduleId(lineOf(char));

/** 雲端 id → 線。主線的 id 就是 charId。 */
export const cloudLine = (cloudId: string): ChatLine => parseLineScheduleId(cloudId);

/** 雲端 id 對應的本地角色 id（未讀之外，大多數本地表還是按角色存）。 */
export const cloudLocalCharId = (cloudId: string): string => parseLineScheduleId(cloudId).charId;

export const isLineCloudId = (cloudId: string): boolean => !!parseLineScheduleId(cloudId).personaKey;

/**
 * 從雲端 id 找回那條線看到的角色卡。角色不在了回 undefined；角色在、但已經不認識那張卡
 * 的話照樣回那條線的視圖——訊息還是那條線的，丟掉就真的沒了。
 */
export const findCloudChar = (
    characters: CharacterProfile[],
    cloudId: string,
): CharacterProfile | undefined => {
    const line = parseLineScheduleId(cloudId);
    const raw = characters.find((c) => c.id === line.charId);
    if (!raw) return undefined;
    return lineView(raw, line);
};

/**
 * 雲端那頭對某條線的改動，換算成存回原角色卡的 patch（主線原樣回傳）。
 * raw 必須是原角色卡，不是視圖（DB.saveCharacter 不收視圖）。
 */
export const cloudCharPatch = (
    raw: CharacterProfile,
    cloudId: string,
    patch: Partial<CharacterProfile>,
): Partial<CharacterProfile> => linePatchForChar(raw, parseLineScheduleId(cloudId), patch);

/** 角色名下非主線的那幾條（認識的卡裡除了主線以外的）。 */
export const nonPrimaryLinesOf = (
    char: Pick<CharacterProfile, 'id' | 'knownPersonaKeys' | 'primaryPersonaKey'>,
): ChatLine[] =>
    (char.knownPersonaKeys || [])
        .filter((pk) => pk && pk !== char.primaryPersonaKey)
        .map((personaKey) => ({ charId: char.id, personaKey }));

/** 角色名下所有可能在雲端有東西的 id：主線 + 每條非主線（刪角色、清雲端時用）。 */
export const allCloudIdsOf = (
    char: Pick<CharacterProfile, 'id' | 'knownPersonaKeys' | 'primaryPersonaKey' | 'lines'>,
): string[] => {
    const keys = new Set<string>([
        ...(char.knownPersonaKeys || []),
        ...Object.keys(char.lines || {}),
    ]);
    keys.delete(char.primaryPersonaKey || '');
    return [char.id, ...[...keys].filter(Boolean).map((personaKey) => lineScheduleId({ charId: char.id, personaKey }))];
};

/**
 * 角色名下要跟雲端打交道的每一條線的視圖：主線永遠在；非主線只算存過自己那份
 * 主動消息 2.0 設定的（沒存過＝沒開過、雲端不會有它的任務）。批量同步、對帳、
 * 憑據刷新這類「把所有角色過一遍」的路徑用它展開。
 */
export const cloudLineViewsOf = (char: CharacterProfile): CharacterProfile[] => {
    const views = [char];
    for (const line of nonPrimaryLinesOf(char)) {
        if (!knowsPersona(char, line.personaKey!)) continue;
        if (char.lines?.[line.personaKey!]?.activeMsg2Config === undefined) continue;
        views.push(lineView(char, line));
    }
    return views;
};

/** 把一批角色展開成每條要上雲的線。 */
export const expandCloudLineViews = (characters: CharacterProfile[]): CharacterProfile[] =>
    characters.flatMap(cloudLineViewsOf);

// ─── MCP 服務器「只給哪些角色用」的雲端 id 展開 ───
// tool_config 裡每台 MCP 服務器的 charIds 是用戶在設定裡勾的角色。Worker 到點拿任務的
// charId 去比，非主線的雲端 id（c1~line~pB）比不上，那條線就用不了 MCP。不改 Worker 的做法：
// 上傳 tool_config 時把勾了的角色展開成它名下每條線的雲端 id。這份名冊由 OSContext 在
// 角色變動時更新（純記憶體，跟 characters 同步）。

const lineCloudIdRegistry = new Map<string, string[]>();

export const setCloudLineRegistry = (characters: CharacterProfile[]): void => {
    lineCloudIdRegistry.clear();
    for (const char of characters) {
        const ids = allCloudIdsOf(char).slice(1);
        if (ids.length) lineCloudIdRegistry.set(char.id, ids);
    }
};

/** charIds（本地角色 id）→ 加上每個角色名下非主線的雲端 id。 */
export const expandCharIdsWithLines = (charIds: string[]): string[] => {
    const out = new Set(charIds);
    for (const id of charIds) for (const lineId of lineCloudIdRegistry.get(id) || []) out.add(lineId);
    return [...out];
};
