/**
 * 劇情鏡像訊息上記的東西怎麼讀（plans/story-multi-persona.md 第 3 批）。只看 metadata、零依賴，
 * 記憶管線、訊息格式化、私聊提示詞這些底層的地方都能用。寫的那頭在 utils/storyMirror.ts。
 */

import type { Message } from '../types';

/** theaterMirrorIds 的鍵是「線」：取回是哪個角色（`charId::身份鍵` → charId；主線本來就是 charId） */
export const mirrorKeyCharId = (key: string): string => key.split('::')[0];

/** 中央那則訊息記的所有鏡像 id */
export const mirrorIdsOf = (message: Pick<Message, 'metadata'> | undefined): number[] =>
    Object.values((message?.metadata?.theaterMirrorIds || {}) as Record<string, number>)
        .map(Number)
        .filter(id => Number.isFinite(id) && id > 0);

/** 記憶宮殿不抽的那幾份鏡像（非主看線的副本） */
export const isSecondaryStoryMirror = (message: Pick<Message, 'metadata'>): boolean =>
    message.metadata?.source === 'story_theater_memory' && message.metadata?.theaterMirrorSecondary === true;

/** 這份鏡像記的「同場、它也認識的其他卡」 */
export const mirrorWithKeys = (message: Pick<Message, 'metadata'>): string[] => {
    const keys = message.metadata?.source === 'story_theater_memory' ? message.metadata?.theaterWithKeys : undefined;
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string' && !!key) : [];
};

/** 給提示詞的那一句（私聊歷史、記憶提取都用它） */
export const mirrorSceneNote = (message: Pick<Message, 'metadata'>): string => {
    const note = message.metadata?.source === 'story_theater_memory' ? message.metadata?.theaterSceneNote : undefined;
    return typeof note === 'string' ? note : '';
};

/** 你寫的那一段要標成誰寫的（不是這條線的你自己寫的時候才有） */
export const mirrorWriterLabel = (message: Pick<Message, 'metadata'>): string => {
    const label = message.metadata?.source === 'story_theater_memory' ? message.metadata?.theaterWriterLabel : undefined;
    return typeof label === 'string' ? label : '';
};
