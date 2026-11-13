/**
 * 私下找人的遞送層（plans/side-messages.md）：寫資料庫、叫對方回一句。純邏輯在 utils/sideMessage.ts。
 * 落你的私聊之後發 SIDE_MESSAGE_EVENT，OSContext 加未讀、提示一聲（哪條線都對）。
 */
import type { APIConfig, CharacterProfile, UserProfile } from '../types';
import { DB } from './db';
import { trackEvent } from './analytics';

/** 埋點的「场合」：從 from 看是群聊、角色私聊還是你的私聊 */
const whereOf = (from: Record<string, unknown> | undefined): '群聊' | '角色私聊' | '私聊' =>
    from?.groupId || from?.fromGroupId ? '群聊' : from?.pairId || (from?.sideFrom as any)?.pairId ? '角色私聊' : '私聊';
import { lineFor } from './chatLine';
import { personaKeyForChar, resolveUserProfileForChar } from './userPersona';
import { commitPairToPhones, runPairRound } from './pairChatRun';
import { resolveDmTarget, resolvePrivateTarget, sideTargets, SIDE_MESSAGE_EVENT, type SideBudget, type SideMessageDetail, type SideMessages } from './sideMessage';

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
    trackEvent('角色私下找人', { 方式: '私聊你', 场合: whereOf(args.from) });
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
    trackEvent('角色私下找人', { 方式: '私讯角色', 场合: whereOf(args.meta) });
    return round.aReplied;
}

/**
 * 一位說話的人這次寫的 PRIVATE／DM 照額度送出去（角色私聊、你的私聊用；群聊在 dispatch 裡逐條處理）。
 * exclude*：私聊裡正在說話的那張卡、角色私聊裡對面那位，不算「私下找」。DM 在背景跑（對方回一句要時間）。
 */
export async function deliverSideBatch(args: {
    speaker: CharacterProfile;
    side: Pick<SideMessages, 'privates' | 'dms'> | undefined;
    budget: SideBudget;
    characters: CharacterProfile[];
    profileBase: UserProfile;
    multiPersona: boolean;
    apiConfig: APIConfig;
    updateCharacter: Parameters<typeof deliverSideDm>[0]['updateCharacter'];
    from: Record<string, unknown>;
    excludePersonaKey?: string;
    excludeCharId?: string;
    onDmReplied?: (to: CharacterProfile) => void;
}): Promise<void> {
    const { speaker, side, budget } = args;
    if (!side || (!side.privates.length && !side.dms.length)) return;
    const all = sideTargets(speaker, { characters: args.characters, profileBase: args.profileBase, multiPersona: args.multiPersona });
    const targets = {
        personas: all.personas.filter(p => p.key !== args.excludePersonaKey),
        chars: all.chars.filter(c => c.id !== args.excludeCharId),
    };
    for (const p of side.privates) {
        if (budget.private <= 0) break;
        const key = resolvePrivateTarget(speaker, { name: p.name, targets });
        if (!key) continue;
        budget.private -= 1;
        await deliverSidePrivate({ speaker, personaKey: key, toName: targets.personas.find(x => x.key === key)?.name || args.profileBase.name, content: p.content, from: args.from });
    }
    for (const d of side.dms) {
        if (budget.dm <= 0) break;
        const toId = resolveDmTarget(targets, d.to);
        const to = toId ? args.characters.find(c => c.id === toId) : undefined;
        if (!to) continue;
        budget.dm -= 1;
        void deliverSideDm({ from: speaker, to, content: d.content, apiConfig: args.apiConfig, profileBase: args.profileBase, updateCharacter: args.updateCharacter, meta: { sideFrom: args.from } })
            .then(replied => { if (replied) args.onDmReplied?.(to); })
            .catch(e => console.warn('[私下找人] 私訊沒送成', e));
    }
}
