import type { CharacterProfile, Message, UserProfile } from '../../types';
import { personaKeyForChar, personaKeyForGroup, personaNameForKey, type GroupRef } from '../userPersona';

/**
 * 群聊裡「你」跟成員私下認識的是不是同一個人（多身份隔離 2b，見 plans/multi-persona-isolation-design.md）。
 * 群身份＝這個群裡的你；成員的主身份＝它私聊綁的那張卡。兩者不同時，對這個成員來說群裡的你是另一個人：
 * 不合併私聊時間線、角色檔案裡的關係與印象照舊指它認識的那個人，並在檔案塊裡說清楚。
 */

/** 這則群訊息是哪一個你發的：訊息上記的身份鍵，舊訊息沒記就算目前的群身份。 */
export function groupMessagePersonaKey(m: Pick<Message, 'metadata'>, groupKey: string): string {
    const key = m.metadata?.personaKey;
    return typeof key === 'string' && key ? key : groupKey;
}

/**
 * 成員時間線／群歷史裡用戶那一行怎麼稱呼：是成員認識的那個你 → 「用戶」（沿用原本的寫法）；
 * 不是 → 那張身份卡的名字，並記進 others（之後提醒那是不同的人）。
 */
export function makeUserLineLabeler(profileBase: UserProfile, groupKey: string, knownKey: string, others?: string[]) {
    return (m: Pick<Message, 'metadata'>): string => {
        const key = groupMessagePersonaKey(m, groupKey);
        if (key === knownKey) return '用戶';
        const name = personaNameForKey(profileBase, key);
        others?.push(name);
        return name;
    };
}

/** 成員認識的不是群身份時，取代「私聊狀態」那段的說明。 */
export function distinctGroupPersonaSection(params: { groupUserName: string; knownName: string; timeline: string }): string {
    const { groupUserName, knownName, timeline } = params;
    return `[重點：群裡的「${groupUserName}」不是你私下認識的「${knownName}」]:
- 群裡的「${groupUserName}」跟你私下聊天的「${knownName}」是兩個不同的人，你不知道他們之間有任何關係。
- 對你來說「${groupUserName}」就是這個群的群友：用「${groupUserName}」稱呼、照群友的熟度相處；不要用你跟「${knownName}」之間的暱稱、關係設定和默契，也別在群裡提你跟「${knownName}」私下聊過的事。
- 上面角色檔案裡的關係、印象、記憶說的都是「${knownName}」，不是「${groupUserName}」。
- 你在這個群的近期時間線（[群聊]=本群公開記錄；僅作為你內心狀態的底色，不要變成默認反應模板）：
${timeline || '(暫無互動記錄)'}`;
}

/**
 * 群設定、建群時的標示：這個群的你是誰，以及哪些角色成員私下認識的是別的身份（在群裡會把你當別人）。
 * 只標示、不阻止。沒有身份卡的人不會有不一致，回空清單。
 */
export function groupPersonaMismatches(
    profileBase: UserProfile,
    group: Exclude<GroupRef, string>,
    characters: Array<Pick<CharacterProfile, 'id' | 'name' | 'groupId'>>,
): { groupKey: string; groupName: string; members: Array<{ id: string; name: string; knownName: string }> } {
    const groupKey = personaKeyForGroup(profileBase, group, characters);
    const members: Array<{ id: string; name: string; knownName: string }> = [];
    for (const id of group.members || []) {
        const char = characters.find(c => c.id === id);
        if (!char) continue;
        const key = personaKeyForChar(profileBase, char);
        if (key !== groupKey) members.push({ id, name: char.name, knownName: personaNameForKey(profileBase, key) });
    }
    return { groupKey, groupName: personaNameForKey(profileBase, groupKey), members };
}
