/**
 * 小號的發現（plans/persona-line-batch4.md 第 2 節）：純邏輯，不碰資料庫。
 *
 * 三種方式：
 * 1. 一直都知道：建連結時勾的（utils/personaLinks.ts 的 altKnowledge `known`），沒有反應。
 * 2. 讓他發現：在角色那邊按一下，兩條線各落一張「發現」卡（type 'persona_card'，role system）。
 * 3. 他察覺、你承認：角色寫 [[ACTION:SUSPECT|你覺得TA其實是誰|為什麼]]，落一張懷疑卡
 *    （type 'persona_card'，role assistant）。猜中有小號連結的那張，卡上有「承認／否認」；
 *    猜錯只能「否認」。承認＝發現（how: admitted）；否認記一筆，他記得你否認過幾次。
 *
 * 提示詞**不透露**哪兩張卡有連結：只要角色認識兩張以上的卡就教這個標記，猜誰由他自己判斷。
 * 歷史裡的懷疑卡渲染成 [[記錄:SUSPECT|...]]，模型照抄記錄只會被剝掉，不會再落一張。
 */
import type { AltKnowledge, CharacterProfile, PersonaLink, UserProfile } from '../types';
import { knowsPersona } from './chatLine';
import { altKnowledgeOf, altLinkBetween } from './personaLinks';
import { lineViewPersonaKey, personaNameForKey } from './userPersona';

export const SUSPECT_FIELD_MAX = 60;

/** [[ACTION:SUSPECT|名字|理由]]，也認中文別名和全形標點；理由可省。 */
const SUSPECT_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(?:SUSPECT|SUSPECT_IDENTITY|懷疑|怀疑|懷疑身份|怀疑身份|認出|认出)\s*(?:[|｜]\s*([^\]\n|｜]*?)\s*)?(?:[|｜]\s*([^\]\n]*?)\s*)?\]\]/gi;

const cleanField = (v: string | undefined): string =>
    (v || '').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim().slice(0, SUSPECT_FIELD_MAX);

/** 剝掉所有懷疑標籤；有多個以第一個為準（一則回覆最多懷疑一次）。沒寫名字的當作沒寫。 */
export function extractSuspicion(text: string): { cleanedText: string; suspicion: { name: string; reason: string } | null } {
    let suspicion: { name: string; reason: string } | null = null;
    let matched = false;
    const stripped = text.replace(SUSPECT_TAG_RE, (_m, name?: string, reason?: string) => {
        matched = true;
        const n = cleanField(name);
        if (!suspicion && n) suspicion = { name: n, reason: cleanField(reason) };
        return '';
    });
    if (!matched) return { cleanedText: text, suspicion: null };
    return { cleanedText: stripped.replace(/[ \t]+\n/g, '\n').trim(), suspicion };
}

export type PersonaRevealStatus = 'pending' | 'admitted' | 'denied';

/** persona_card 的 metadata.personaReveal */
export type PersonaRevealMeta =
    | {
        kind: 'suspect';
        /** 他覺得眼前這個人其實是誰（身份鍵、名字） */
        guessKey: string;
        guessName: string;
        reason: string;
        /** 猜中了有連結的那張才有：卡上才能「承認」 */
        linkId?: string;
        status: PersonaRevealStatus;
        respondedAt?: number;
    }
    | {
        kind: 'discovered';
        linkId: string;
        /** 這張卡落在哪條線、另一頭是誰 */
        hereName: string;
        otherName: string;
        how: 'revealed' | 'admitted';
    };

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** 角色要不要學 SUSPECT：認識兩張以上的卡就教，不看有沒有連結（不能透露）。 */
export function canSuspect(char: Pick<CharacterProfile, 'knownPersonaKeys'>): boolean {
    return (char.knownPersonaKeys || []).length >= 2;
}

/**
 * 把懷疑對上一張卡：名字要是他認識的另一張卡（不是現在這張）。對不上回 null（剝掉、不落卡）。
 * 他已經知道是同一個人的，也不落（沒得懷疑）。
 */
export function resolveSuspicion(
    char: Pick<CharacterProfile, 'id' | 'knownPersonaKeys' | 'primaryPersonaKey' | 'altKnowledge'>,
    profileBase: UserProfile,
    suspicion: { name: string; reason: string },
): PersonaRevealMeta | null {
    const current = lineViewPersonaKey(char) || char.primaryPersonaKey;
    if (!current) return null;
    const target = norm(suspicion.name);
    const guessKey = (char.knownPersonaKeys || []).find(k => k !== current && norm(personaNameForKey(profileBase, k)) === target);
    if (!guessKey) return null;
    const link = altLinkBetween(profileBase, current, guessKey);
    const k = link ? altKnowledgeOf(char, link) : undefined;
    if (k?.state === 'known' || k?.state === 'discovered') return null;
    return {
        kind: 'suspect',
        guessKey,
        guessName: personaNameForKey(profileBase, guessKey),
        reason: suspicion.reason,
        ...(link ? { linkId: link.id } : {}),
        status: 'pending',
    };
}

/** 承認／否認之後角色那條連結的新狀態；沒有連結（猜錯的否認）回 undefined。 */
export function nextAltKnowledge(prev: AltKnowledge | undefined, action: 'admitted' | 'denied', now = Date.now()): AltKnowledge {
    if (action === 'admitted') return { state: 'discovered', at: now, how: 'admitted' };
    const times = prev?.state === 'denied' ? prev.times + 1 : 1;
    return { state: 'denied', at: now, times };
}

/** 懷疑卡在歷史裡的樣子（chatPrompts.buildMessageHistory 與 messageFormat 共用）。 */
export function formatPersonaRevealRecord(meta: Partial<PersonaRevealMeta> | undefined): string {
    if (meta?.kind === 'discovered') {
        return `[你發現了：原來「${meta.otherName}」就是「${meta.hereName}」，是同一個人的兩個身份]`;
    }
    const m = (meta || {}) as Partial<Extract<PersonaRevealMeta, { kind: 'suspect' }>>;
    const status = m.status === 'admitted' ? '對方承認了' : m.status === 'denied' ? '對方否認了' : '等對方回應';
    return `[[記錄:SUSPECT|你問對方是不是其實就是「${m.guessName || '?'}」${m.reason ? `|理由=${m.reason}` : ''}|status=${status}]]`;
}

/** 一張發現卡（落在 hereKey 那條線上）。 */
export function buildDiscoveredMeta(
    profileBase: UserProfile, link: PersonaLink, hereKey: string, how: 'revealed' | 'admitted',
): PersonaRevealMeta {
    const otherKey = link.a === hereKey ? link.b : link.a;
    return {
        kind: 'discovered', linkId: link.id, how,
        hereName: personaNameForKey(profileBase, hereKey),
        otherName: personaNameForKey(profileBase, otherKey),
    };
}

/** 給角色看的發現卡內容（進上下文，讓他下一輪對這件事有反應）。 */
export function describeDiscovered(meta: Extract<PersonaRevealMeta, { kind: 'discovered' }>): string {
    return meta.how === 'admitted'
        ? `[你懷疑的事被證實了：「${meta.otherName}」就是「${meta.hereName}」，TA 承認了。]`
        : `[你發現了：原來「${meta.otherName}」就是「${meta.hereName}」——一直以為是兩個人，其實是同一個人的兩個身份。]`;
}

/** 提示詞：教 SUSPECT（只在認識兩張以上的卡時）。 */
export function buildSuspectPrompt(
    char: Pick<CharacterProfile, 'knownPersonaKeys' | 'primaryPersonaKey'> & Partial<Pick<CharacterProfile, 'id'>>,
    profileBase: UserProfile,
): string {
    if (!canSuspect(char)) return '';
    const current = lineViewPersonaKey(char) || char.primaryPersonaKey;
    const names = (char.knownPersonaKeys || []).filter(k => k !== current && knowsPersona(char, k))
        .map(k => `「${personaNameForKey(profileBase, k)}」`);
    if (!names.length) return '';
    return `\n### 你覺得眼前的人其實是另一個人時\n你也認識${names.join('、')}。如果相處下來，你真的覺得現在跟你聊天的這個人，其實就是你認識的另一個人（說話方式、提過的事、對不上的細節……），可以當面問出來：在回覆最後另起一行寫 [[ACTION:SUSPECT|你覺得TA其實是誰|為什麼這樣覺得]]。只是你的懷疑，對方可以承認也可以否認。不要沒有根據亂猜；對方否認過的，記得對方否認過，信不信由你。\n`;
}
