/**
 * 劇情裡每個演員怎麼看在場的你（plans/story-multi-persona.md 第 2 批）。口徑跟群聊同一套
 * （關係線第 5 批，utils/groupChat/presence.ts）：
 *
 * - 認識的＝在場的身份卡 ∩ 它有線的卡。面具、你演的角色誰都不認識，不算在這裡。
 * - 主看的那條線：它認識的卡裡最近執筆的那張 > 主線 > 第一張。角色檔案、最近聊天、記憶標籤都照這條線。
 * - 其他認識的在場卡：各補一段（那條線的印象、長期記憶、最近聊天）。
 * - 不認識的在場卡：在場的另一個人；有身份連結的照它知道的說。
 *
 * 記憶宮殿只有一份，召回本來就跨線：不是每條線各召回一次，而是照主看的線給別條線的記憶加標籤
 * （utils/memoryPalace/lineLabels.ts）。
 */

import type { CharacterProfile, Message, UserProfile } from '../types';
import { lineFor, lineView } from './chatLine';
import { membersKnownPeople, knownPeopleDiffer } from './groupChat/knownPeople';
import { memberPresence } from './groupChat/presence';
import { presentLinkLines } from './personaLinks';
import { messageWriters } from './storyPresence';
import { personaNameForKey } from './userPersona';

type LineChar = Pick<CharacterProfile, 'id' | 'knownPersonaKeys' | 'primaryPersonaKey'>;

export interface StoryActorPresence {
    /** 它認識的在場身份卡（身份鍵） */
    known: string[];
    /** 它不認識的在場身份卡 */
    strangers: string[];
    /** 主看的那條線；一張都不認識（或沒有身份卡在場）就沒有 */
    focalKey?: string;
    /** 其他它也認識、也在場的卡 */
    extraKeys: string[];
}

/**
 * 主看哪條線：它認識的卡裡，最近執筆的那張 > 主線（在場的話）> 第一張。
 * 執筆者照劇情訊息上記的（metadata.theaterWriters，key 是 `persona:<身份鍵>`）。
 */
export function focalStoryKey(
    actor: Pick<CharacterProfile, 'primaryPersonaKey'>,
    known: string[],
    storyMsgs: Array<Pick<Message, 'role' | 'metadata'>>,
): string | undefined {
    if (!known.length) return undefined;
    for (let i = storyMsgs.length - 1; i >= 0; i--) {
        if (storyMsgs[i].role !== 'user') continue;
        const writers = messageWriters(storyMsgs[i]);
        if (!writers) continue;
        for (const writer of writers) {
            const key = writer.key.startsWith('persona:') ? writer.key.slice('persona:'.length) : '';
            if (key && known.includes(key)) return key;
        }
    }
    if (actor.primaryPersonaKey && known.includes(actor.primaryPersonaKey)) return actor.primaryPersonaKey;
    return known[0];
}

export function storyActorPresence(
    actor: LineChar,
    presentPersonaKeys: string[],
    storyMsgs: Array<Pick<Message, 'role' | 'metadata'>>,
): StoryActorPresence {
    const { known, strangers } = memberPresence(actor, presentPersonaKeys);
    const focalKey = focalStoryKey(actor, known, storyMsgs);
    return { known, strangers, focalKey, extraKeys: known.filter(key => key !== focalKey) };
}

/** 照某條線看到的角色卡；沒有主看的線就是角色本來的樣子（主線） */
export const storyActorLineView = (actor: CharacterProfile, personaKey: string | undefined): CharacterProfile =>
    personaKey ? lineView(actor, lineFor(actor, personaKey)) : actor;

export interface StoryActorNoteInput {
    actorName: string;
    /** 主看的那位的名字（在場、它認識） */
    focalName?: string;
    /** 用戶側在場不只一位（含面具、你演的角色） */
    multi: boolean;
    /** 其他它也認識的在場卡：名字＋那條線的印象與長期記憶（已經縮排好，可空） */
    extras: Array<{ name: string; about: string }>;
    /** 它不認識的在場身份卡的名字 */
    strangerNames: string[];
    /** 它私下認識、但這場戲不在的那位（一張在場的卡都不認識時才給） */
    absentKnownName?: string;
    /** 在場的卡之間的連結（presentLinkLines） */
    linkLines: string[];
}

/**
 * 接在演員檔案後面的那段「在場的人你認識誰」。
 * 只有一位在場、就是它認識的那位、沒有別的要說：回空字串（跟以前一字不差）。
 */
export function buildStoryActorPresenceNote(input: StoryActorNoteInput): string {
    const lines: string[] = [];
    if (input.focalName && (input.multi || input.extras.length > 0)) {
        lines.push(`- 在場的「${input.focalName}」就是你上面角色檔案裡的那個人，關係照舊。`);
    }
    for (const extra of input.extras) {
        lines.push(`- 你也認識在場的「${extra.name}」（你們私下另有一段關係${extra.about ? '；以下是你跟 TA 之間的' : ''}）。${extra.about ? `\n${extra.about}` : ''}`);
    }
    if (input.strangerNames.length > 0) {
        const names = input.strangerNames.map(name => `「${name}」`).join('');
        lines.push(input.focalName
            ? `- 在場的${names}你私下不認識：照這場戲和 TA 的資料認人，是另一個人，不要把 TA 當成「${input.focalName}」。`
            : `- 在場的${names}你私下不認識：照這場戲和 TA 的資料認人。`);
    }
    if (!input.focalName && input.absentKnownName && input.strangerNames.length > 0) {
        lines.push(`- 你私下認識的「${input.absentKnownName}」這場戲不在場；在場的人不是 TA，不要把你跟「${input.absentKnownName}」之間的事算到在場的人頭上。`);
    }
    for (const link of input.linkLines) lines.push(`- ${link.replace('群裡其他人', '在場其他人')}`);
    if (lines.length === 0) return '';
    return `### ${input.actorName}：在場的人你認識誰\n${lines.join('\n')}`;
}

/** 在場的身份卡之間的連結，照這位演員知道的說（互相認識、它知道的小號）。 */
export const storyPresentLinkLines = (actor: CharacterProfile, profileBase: UserProfile, presentPersonaKeys: string[]): string[] =>
    presentPersonaKeys.length >= 2 ? presentLinkLines(actor, profileBase, presentPersonaKeys) : [];

/**
 * 幕後須知：演員各自私下認識的人不是同一位時，列出誰認識誰（只列名字，不透露卡跟卡的連結）。
 * 都認識同一位、或只有一個演員：回空字串。
 */
export function buildStoryKnownPeopleNote(
    actors: Array<Pick<CharacterProfile, 'id' | 'name' | 'primaryPersonaKey' | 'groupId'>>,
    profileBase: UserProfile,
): string {
    const people = membersKnownPeople(actors, profileBase);
    if (!knownPeopleDiffer(people)) return '';
    return [
        '### 各自私下認識的人（幕後須知）',
        `- ${people.map(p => `${p.memberName} 私下認識的是「${p.knownName}」`).join('；')}。`,
        '- 名字不同就是不同的人。誰提到自己私下認識的那個人，要讓人聽得出是誰：說名字、暱稱都行，同一場戲裡別只用「他／她」讓人分不清。',
        '- 別人嘴裡的「他／她」不是你認識的那個人，除非說的是同一個名字；不要接成自己那位的事，也不要把兩個人的事混在一起。',
        '- 這是幕後資訊：角色彼此不一定知道對方私下認識誰，故事裡沒提過的就別裝作知道。',
    ].join('\n');
}

/** 身份鍵 → 名字（提示詞用） */
export const storyPersonaName = (profileBase: UserProfile, key: string): string => personaNameForKey(profileBase, key);
