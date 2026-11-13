/**
 * 私下找人的遞送層（plans/side-messages.md）：寫資料庫、叫對方回一句。純邏輯在 utils/sideMessage.ts。
 * 落你的私聊之後發 SIDE_MESSAGE_EVENT，OSContext 加未讀、提示一聲（哪條線都對）。
 */
import type { APIConfig, CharacterProfile, UserProfile } from '../types';
import { DB } from './db';
import { lineFor } from './chatLine';
import { personaKeyForChar, resolveUserProfileForChar } from './userPersona';
import { commitPairToPhones, runPairRound } from './pairChatRun';
import { SIDE_MESSAGE_EVENT, type SideMessageDetail } from './sideMessage';

/** 落進它跟那張卡的私聊線 */
export async function deliverSidePrivate(args: {
    speaker: CharacterProfile;
    personaKey: string;
    toName: string;
    content: string;
    /** 從哪裡來的（群 id、角色私聊 id…），記在 metadata.sideFrom */
    from?: Record<string, unknown>;
}): Promise<void> {
    const line = lineFor(args.speaker, args.personaKey);
    await DB.saveMessage({
        charId: line.charId,
        ...(line.personaKey ? { personaKey: line.personaKey } : {}),
        role: 'assistant', type: 'text', content: args.content,
        ...(args.from ? { metadata: { sideFrom: args.from } } : {}),
    });
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<SideMessageDetail>(SIDE_MESSAGE_EVENT, {
            detail: { charId: line.charId, ...(line.personaKey ? { personaKey: line.personaKey } : {}), charName: args.speaker.name, toName: args.toName, content: args.content },
        }));
    }
}

/**
 * 私訊別的角色：那句記成它真的說的（不是你冒充的），對方用自己的檔案回一句（深度 1：回的那句不教私下找人）。
 * 回傳對方有沒有回。
 */
export async function deliverSideDm(args: {
    from: CharacterProfile;
    to: CharacterProfile;
    content: string;
    apiConfig: APIConfig;
    profileBase: UserProfile;
    updateCharacter: (id: string, updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
    meta?: Record<string, unknown>;
}): Promise<boolean> {
    const { from, to, profileBase } = args;
    const round = await runPairRound({
        a: to, b: from, api: args.apiConfig as any,
        userA: resolveUserProfileForChar(profileBase, to), userB: resolveUserProfileForChar(profileBase, from),
        samePersona: personaKeyForChar(profileBase, to) === personaKeyForChar(profileBase, from),
        asB: args.content, asBImpersonated: false, ...(args.meta ? { asBMeta: args.meta } : {}),
    });
    commitPairToPhones({ a: to, b: from, round, updateCharacter: args.updateCharacter });
    return round.aReplied;
}
