/**
 * 小號好友申請的「你回覆」那一步（關係線第 7 批 7c）：通過就把那張卡設成小號的主線、落兩則訊息。
 * 純狀態轉換在 utils/altFriend.ts。
 */
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { decideAltRequest, type AltRequestAction } from './altFriend';

/** 回傳要寫回小號的欄位；通過時順便在新的那條線落「它的招呼 → 你通過了」。 */
export async function answerAltRequest(alt: CharacterProfile, action: AltRequestAction, now = Date.now()): Promise<Partial<CharacterProfile> | null> {
    const req = alt.altFriendRequest;
    if (!req || req.status !== 'pending') return null;
    const decided = decideAltRequest(req, action, now);
    if (action !== 'accept') return { altFriendRequest: decided };
    // 小號之前沒跟你說過話：加的那張卡就是它的主線
    if (req.greeting) await DB.saveMessage({ charId: alt.id, role: 'assistant', type: 'text', content: req.greeting, timestamp: Math.min(req.at, now - 1), metadata: { friendRequest: true } });
    await DB.saveMessage({ charId: alt.id, role: 'system', type: 'text', content: `[系統: 你通過了「${alt.name}」的好友申請，可以開始聊天了]`, timestamp: now });
    return {
        altFriendRequest: decided,
        altUserFriend: true,
        primaryPersonaKey: req.personaKey,
        knownPersonaKeys: [req.personaKey],
    };
}
