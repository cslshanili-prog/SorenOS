/**
 * 小號的發現：會寫資料庫的那一半（純邏輯在 utils/personaReveal.ts）。
 * 聊天裡懷疑卡的「承認／否認」、聊天設定「認識的你」的「讓他發現」都走這裡。
 */
import type { CharacterProfile, Message, PersonaLink, UserProfile } from '../types';
import { DB } from './db';
import { lineFor } from './chatLine';
import { buildDiscoveredMeta, describeDiscovered, nextAltKnowledge, type PersonaRevealMeta } from './personaReveal';

type UpdateCharacter = (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;

/** 讓聊天頁重讀訊息（OSContext 把這個事件當成「有新訊息落庫了」） */
const refreshChat = () => {
    try { window.dispatchEvent(new CustomEvent('active-msg-progress')); } catch { /* SSR */ }
};

/**
 * 他發現了：狀態改成 discovered，兩條線各落一張發現卡（他下一輪會對這件事有反應）。
 * raw 是原角色卡（不是線視圖）。
 */
export async function revealAltToChar(args: {
    raw: CharacterProfile;
    link: PersonaLink;
    profileBase: UserProfile;
    how: 'revealed' | 'admitted';
    updateCharacter: UpdateCharacter;
}): Promise<void> {
    const { raw, link, profileBase, how, updateCharacter } = args;
    const at = Date.now();
    updateCharacter(raw.id, prev => ({
        altKnowledge: { ...(prev.altKnowledge || {}), [link.id]: { state: 'discovered', at, how } },
    }));
    for (const key of [link.a, link.b]) {
        const line = lineFor(raw, key);
        const meta = buildDiscoveredMeta(profileBase, link, key, how);
        await DB.saveMessage({
            charId: raw.id, ...(line.personaKey ? { personaKey: line.personaKey } : {}),
            role: 'system', type: 'persona_card',
            content: describeDiscovered(meta as Extract<PersonaRevealMeta, { kind: 'discovered' }>),
            metadata: { personaReveal: meta },
        });
    }
    refreshChat();
}

/** 懷疑卡上按了「承認／否認」。猜錯的（沒有連結）只能否認，只改卡片狀態。 */
export async function resolveSuspicionCard(args: {
    msg: Message;
    raw: CharacterProfile;
    profileBase: UserProfile;
    action: 'admitted' | 'denied';
    updateCharacter: UpdateCharacter;
}): Promise<void> {
    const { msg, raw, profileBase, action, updateCharacter } = args;
    const meta = msg.metadata?.personaReveal as PersonaRevealMeta | undefined;
    if (meta?.kind !== 'suspect' || meta.status !== 'pending') return;
    const link = meta.linkId ? (profileBase.personaLinks || []).find(l => l.id === meta.linkId) : undefined;
    if (action === 'admitted' && !link) return;
    await DB.updateMessageMetadata(msg.id, prev => ({
        ...(prev || {}),
        personaReveal: { ...(prev?.personaReveal || {}), status: action, respondedAt: Date.now() },
    }));
    if (link) {
        if (action === 'admitted') {
            await revealAltToChar({ raw, link, profileBase, how: 'admitted', updateCharacter });
            return;
        }
        updateCharacter(raw.id, prev => ({
            altKnowledge: { ...(prev.altKnowledge || {}), [link.id]: nextAltKnowledge(prev.altKnowledge?.[link.id], 'denied') },
        }));
    }
    refreshChat();
}
