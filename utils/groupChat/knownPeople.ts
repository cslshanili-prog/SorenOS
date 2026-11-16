/**
 * 群裡每位成員私下認識的是哪個「你」（關係線：一個角色可以認識不同的身份卡）。
 *
 * 成員各自認識不同的人時，群聊裡大家都說「他／她」，別人（和導演、總結）就分不清在說誰。
 * 這裡列出「誰私下認識的是誰」，並要求提到自己私下認識的人時讓人聽得出是誰。
 * 只列名字，不透露哪兩張卡之間有連結（plans/persona-line-batch4.md）。
 */
import type { CharacterProfile, UserProfile } from '../../types';
import { personaKeyForChar, personaNameForKey } from '../userPersona';

export interface KnownPerson {
    memberId: string;
    memberName: string;
    key: string;
    knownName: string;
}

/** 每位成員的主線（私下最主要認識的那張卡）。 */
export function membersKnownPeople(
    members: Array<Pick<CharacterProfile, 'id' | 'name' | 'primaryPersonaKey' | 'groupId'>>,
    profileBase: UserProfile,
): KnownPerson[] {
    return members.map(m => {
        const key = m.primaryPersonaKey || personaKeyForChar(profileBase, m as CharacterProfile);
        return { memberId: m.id, memberName: m.name, key, knownName: personaNameForKey(profileBase, key) };
    });
}

/** 成員私下認識的人不只一位（名字不同）時才需要提醒。 */
export const knownPeopleDiffer = (people: KnownPerson[]): boolean =>
    new Set(people.map(p => p.knownName)).size >= 2;

/**
 * 群聊生成（導演／輪流都用）：幕後須知。成員認識的都是同一個人就回空字串。
 */
export function buildKnownPeopleNote(people: KnownPerson[]): string {
    if (!knownPeopleDiffer(people)) return '';
    const lines = people.map(p => `${p.memberName} 私下認識的是「${p.knownName}」`).join('；');
    return `
### 【各自私下認識的人（幕後須知）】
- ${lines}。
- 名字不同就是不同的人。誰提到自己私下認識的那個人，台詞要讓人聽得出是誰：說名字、暱稱或「我家那位」之類都行，同一段對話裡別只用「他／她」讓人分不清。
- 別人嘴裡的「他／她」不是你認識的那個人，除非說的是同一個名字；不要接成自己那位的事，也不要把兩個人的事混在一起。
- 這是幕後資訊：角色彼此不一定知道對方私下認識誰，群裡沒聊過的就別裝作知道。
`;
}

/** 群聊總結：成員嘴裡的「他／她」指自己私下認識的人時，寫出是誰。 */
export function buildKnownPeopleSummaryNote(people: KnownPerson[]): string {
    if (!knownPeopleDiffer(people)) return '';
    const lines = people.map(p => `${p.memberName}→「${p.knownName}」`).join('、');
    return `\n【成員各自私下認識的人】${lines}。這些是不同的人。記錄裡成員說的「他／她」如果指的是自己私下認識的那個人，總結時寫出名字（例如「${people[0].memberName}提到「${people[0].knownName}」…」），不要寫成含糊的「他」，也不要把不同人的事混在一起。\n`;
}

/**
 * 私聊裡的群聊背景：其他群友說的「他／她」常常是他們自己私下認識的人，不是你認識的那位。
 * selfKnownName 是這個角色私下認識的人；others 是同群其他成員。只列名字不同的。
 */
export function buildGroupOthersKnownNote(selfKnownName: string, others: KnownPerson[]): string {
    const differing = others.filter(p => p.knownName !== selfKnownName);
    if (!differing.length) return '';
    const lines = differing.map(p => `${p.memberName}的「${p.knownName}」`).join('、');
    return `（群友說的「他／她」常常是他們自己私下認識的人（${lines}），不是你認識的「${selfKnownName}」；名字不同就是不同的人，別把他們的事算到「${selfKnownName}」頭上。）`;
}
