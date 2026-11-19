/**
 * 劇情（真實時間陪伴）的鏡像訊息落哪幾條線（plans/story-multi-persona.md 第 3 批，4.1）。純邏輯。
 *
 * 每一段正文會鏡像進每個演員的私聊紀錄，之後私聊往上翻看得到、記憶宮殿也從這裡抽。
 * - 演員認識的卡有在場：它認識、而且這一段在場的每條線各一份。主看的那條線那份是主要的，
 *   其餘標 theaterMirrorSecondary（記憶宮殿不抽，免得同一件事記成兩筆）。
 * - 在場的卡它一張都不認識、或沒有用戶側的人物在場：只寫它的主線，標清楚它認識的那位不在場。
 * - 中央那則訊息的 theaterMirrorIds 以「線」為鍵（lineKey：主線就是 charId，跟舊資料一樣）。
 */

import type { CharacterProfile, Message, UserProfile } from '../types';
import { lineFor, lineKey } from './chatLine';
import { memberPresence } from './groupChat/presence';
import { focalStoryKey } from './storyActorView';
import { personaKeyForChar, personaNameForKey } from './userPersona';

export interface StoryMirrorTarget {
    /** theaterMirrorIds 的鍵 */
    key: string;
    charId: string;
    /** 非主線才有，寫進訊息頂層 */
    personaKey?: string;
    /** 不是主看的那份：記憶宮殿不抽 */
    secondary: boolean;
    /** 同場、它也認識的其他卡（身份鍵）：記憶節點的 withPersonaKeys */
    withKeys: string[];
    /** 給提示詞看的一句：同場還有誰、它認識的那位在不在、誰執筆；沒什麼要說就是空的 */
    sceneNote: string;
    /** 你寫的那一段要標成誰寫的；不用另外標（就是這條線的你）時沒有 */
    writerLabel?: string;
}

export interface StoryMirrorInput {
    actor: Pick<CharacterProfile, 'id' | 'name' | 'primaryPersonaKey' | 'knownPersonaKeys' | 'groupId'>;
    profileBase: UserProfile;
    /** 這一段在場的身份卡（身份鍵） */
    presentPersonaKeys: string[];
    /** 劇情線程在這一段之前的訊息，找最近執筆的是誰；這一段自己的執筆者（writerKeys）這裡會算進去 */
    storyMsgs: Array<Pick<Message, 'role' | 'metadata'>>;
    role: 'user' | 'assistant';
    /** 這一段的執筆者（身份鍵）；「繼續」那輪、模型寫的那段是空的 */
    writerKeys: string[];
}

const quote = (names: string[]): string => names.map(name => `「${name}」`).join('');

export function storyMirrorTargets(input: StoryMirrorInput): StoryMirrorTarget[] {
    const { actor, profileBase, presentPersonaKeys } = input;
    const nameOf = (key: string) => personaNameForKey(profileBase, key);
    const { known, strangers } = memberPresence(actor, presentPersonaKeys);
    const writerNames = input.writerKeys.map(nameOf);

    if (known.length === 0) {
        // 它認識的那位不在這場戲裡：只寫主線
        const primaryName = nameOf(actor.primaryPersonaKey || personaKeyForChar(profileBase, actor));
        return [{
            key: actor.id,
            charId: actor.id,
            secondary: false,
            withKeys: [],
            sceneNote: strangers.length === 0
                ? '用戶不在場，是角色們自己的戲'
                : `在場的是${quote(strangers.map(nameOf))}，都不是你私下認識的「${primaryName}」`,
            ...(input.role === 'user' ? { writerLabel: writerNames.length > 0 ? writerNames.join('、') : '作者' } : {}),
        }];
    }

    // 這一段是你寫的：執筆的人就是最近執筆的人
    const storyMsgs: StoryMirrorInput['storyMsgs'] = input.role === 'user' && input.writerKeys.length > 0
        ? [...input.storyMsgs, { role: 'user', metadata: { theaterWriters: input.writerKeys.map(key => ({ key: `persona:${key}`, name: nameOf(key) })) } }]
        : input.storyMsgs;
    const focalKey = focalStoryKey(actor, known, storyMsgs);
    return known.map(key => {
        const line = lineFor(actor, key);
        const withKeys = known.filter(item => item !== key);
        // 這段是不是就是這條線的你自己寫的；不是的話要標出來
        const selfWrote = input.writerKeys.length === 1 && input.writerKeys[0] === key;
        const writerLabel = input.role === 'user' && writerNames.length > 0 && !selfWrote ? writerNames.join('、') : undefined;
        const notes = [
            withKeys.length > 0 ? `同場還有你也認識的${quote(withKeys.map(nameOf))}` : '',
            strangers.length > 0 ? `同場還有${quote(strangers.map(nameOf))}（你私下不認識）` : '',
            writerLabel ? `這段由${quote(writerNames)}執筆` : '',
        ].filter(Boolean);
        return {
            key: lineKey(line),
            charId: actor.id,
            ...(line.personaKey ? { personaKey: line.personaKey } : {}),
            secondary: key !== focalKey,
            withKeys,
            sceneNote: notes.join('；'),
            ...(writerLabel ? { writerLabel } : {}),
        };
    });
}

/** 寫進鏡像訊息 metadata 的那幾個欄位（沒有就不寫，一位在場時跟以前一樣什麼都不多） */
export const storyMirrorMetadata = (target: StoryMirrorTarget): Record<string, unknown> => ({
    ...(target.secondary ? { theaterMirrorSecondary: true } : {}),
    ...(target.withKeys.length > 0 ? { theaterWithKeys: target.withKeys } : {}),
    ...(target.sceneNote ? { theaterSceneNote: target.sceneNote } : {}),
    ...(target.writerLabel ? { theaterWriterLabel: target.writerLabel } : {}),
});

export { isSecondaryStoryMirror, mirrorIdsOf, mirrorKeyCharId, mirrorSceneNote, mirrorWithKeys, mirrorWriterLabel } from './storyMirrorMeta';
