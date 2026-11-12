/**
 * 身份卡之間的連結（plans/persona-line-batch4.md）：同一世界、小號。純邏輯，不碰資料庫。
 *
 * - 連結存在用戶資料上（UserProfile.personaLinks），兩兩設，一張卡可以有好幾條。
 * - 小號是「認不認得出來」：角色對每條小號連結各記一個狀態（CharacterProfile.altKnowledge），
 *   只有角色兩張卡都認識時才有意義。
 * - 提示詞和記憶標籤都是當下現算的，狀態改了不用回頭改任何東西。
 */
import type { AltKnowledge, CharacterProfile, PersonaLink, UserProfile } from '../types';
import { knowsPersona } from './chatLine';
import { lineViewPersonaKey, personaNameForKey } from './userPersona';

type LinkChar = Pick<CharacterProfile, 'knownPersonaKeys' | 'primaryPersonaKey' | 'altKnowledge'>;

/** 這張卡參與的所有連結。 */
export function linksOf(profile: Pick<UserProfile, 'personaLinks'>, key: string): PersonaLink[] {
    return (profile.personaLinks || []).filter(link => link.a === key || link.b === key);
}

/** 連結另一頭是哪張卡。 */
export function otherSide(link: PersonaLink, key: string): string {
    return link.a === key ? link.b : link.a;
}

/** 兩張卡之間的小號連結（不分方向）。 */
export function altLinkBetween(profile: Pick<UserProfile, 'personaLinks'>, k1: string, k2: string): PersonaLink | undefined {
    return (profile.personaLinks || []).find(link => link.kind === 'alt'
        && ((link.a === k1 && link.b === k2) || (link.a === k2 && link.b === k1)));
}

/** 角色對這條小號連結的狀態；角色沒兩張都認識就當作不存在。 */
export function altKnowledgeOf(char: LinkChar, link: PersonaLink): AltKnowledge | undefined {
    if (link.kind !== 'alt' || !knowsPersona(char, link.a) || !knowsPersona(char, link.b)) return undefined;
    return char.altKnowledge?.[link.id];
}

/** 角色知不知道這兩張是同一個人（一直知道或已發現）。 */
export function knowsSameIdentity(char: LinkChar, link: PersonaLink): boolean {
    const k = altKnowledgeOf(char, link);
    return k?.state === 'known' || k?.state === 'discovered';
}

/**
 * 角色知道跟 key 是同一個人的那幾張卡（小號連結會串：A—B、B—C 都知道，A、B、C 就是同一個人）。
 * 不含 key 自己。
 */
export function sameIdentityKeys(char: LinkChar, profile: Pick<UserProfile, 'personaLinks'>, key: string): string[] {
    const seen = new Set<string>([key]);
    const queue = [key];
    while (queue.length) {
        const cur = queue.shift()!;
        for (const link of linksOf(profile, cur)) {
            if (link.kind !== 'alt' || !knowsSameIdentity(char, link)) continue;
            const next = otherSide(link, cur);
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
    }
    seen.delete(key);
    return [...seen];
}

const fmtDate = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

/**
 * 這條線（char 可能是線視圖）上要告訴角色的連結：同一世界的關係、它知道的小號、否認過的懷疑。
 * 沒有要說的回空陣列。
 */
export function personaLinkLines(
    char: LinkChar & Pick<CharacterProfile, 'id'>,
    profileBase: UserProfile,
): string[] {
    const current = lineViewPersonaKey(char) || char.primaryPersonaKey;
    if (!current) return [];
    const name = (key: string) => personaNameForKey(profileBase, key);
    const me = name(current);
    const lines: string[] = [];
    for (const link of linksOf(profileBase, current)) {
        const other = otherSide(link, current);
        const them = name(other);
        if (link.kind === 'sameWorld') {
            const mine = link.a === current ? link.aToB : link.bToA;
            const theirs = link.a === current ? link.bToA : link.aToB;
            const rel = mine
                ? `「${me}」是「${them}」的${mine}${theirs ? `，「${them}」是TA的${theirs}` : ''}。`
                : `「${me}」跟「${them}」是同一個世界的人，互相認識。`;
            lines.push(rel + (knowsPersona(char, other)
                ? `這兩個人你都認識，TA 們是不同的人。`
                : `你只是知道有「${them}」這個人，還沒跟TA來往過。`));
            continue;
        }
        const k = altKnowledgeOf(char, link);
        if (!k) continue;
        if (k.state === 'denied') {
            lines.push(`你曾經懷疑「${me}」跟「${them}」是同一個人，TA否認了（${k.times} 次，最近一次是 ${fmtDate(k.at)}）。`);
            continue;
        }
        const altIsMe = link.b === current;
        const fact = altIsMe
            ? `跟你聊天的「${me}」其實就是你也認識的「${them}」，這是TA的另一個身份。`
            : `你認識的「${them}」其實就是「${me}」本人，是TA的另一個身份。`;
        const how = k.state === 'known'
            ? '你一直都知道這件事。'
            : `你是在 ${fmtDate(k.at)} ${k.how === 'admitted' ? '起疑、TA承認了才確定' : '發現'}的。`;
        lines.push(`${fact}${how}兩個身份跟你說過的話你都記得，聊天時可以照你們之間的默契決定要不要點破。`);
    }
    return lines;
}

/** 給 ContextBuilder 用的整塊；沒有內容回空字串。 */
export function formatPersonaLinksBlock(
    char: LinkChar & Pick<CharacterProfile, 'id'>,
    profileBase: UserProfile,
): string {
    const lines = personaLinkLines(char, profileBase);
    if (!lines.length) return '';
    const current = lineViewPersonaKey(char) || char.primaryPersonaKey || '';
    return `### [關於「${personaNameForKey(profileBase, current)}」的其他身份與關係]\n${lines.map(l => `- ${l}`).join('\n')}\n\n`;
}

/**
 * 群裡好幾張卡同時在場（plans/persona-line-batch5.md）：在場兩張之間的連結，照這位成員知道的說。
 * - 同一世界：它認識其中一張就說兩人的關係（沒填稱呼就說「同一個世界的人、互相認識」）。
 * - 小號：它知道是同一個人才說；不知道就是兩個群友，什麼都不提。
 */
export function presentLinkLines(
    char: LinkChar,
    profileBase: UserProfile,
    present: string[],
): string[] {
    const name = (key: string) => personaNameForKey(profileBase, key);
    const lines: string[] = [];
    for (const link of profileBase.personaLinks || []) {
        if (!present.includes(link.a) || !present.includes(link.b)) continue;
        const a = name(link.a);
        const b = name(link.b);
        if (link.kind === 'sameWorld') {
            if (!knowsPersona(char, link.a) && !knowsPersona(char, link.b)) continue;
            const rel = link.aToB
                ? `在場的「${a}」是「${b}」的${link.aToB}${link.bToA ? `，「${b}」是「${a}」的${link.bToA}` : ''}。`
                : `在場的「${a}」跟「${b}」是同一個世界的人，互相認識。`;
            lines.push(`${rel}TA 們是不同的人。`);
            continue;
        }
        if (knowsSameIdentity(char, link)) {
            lines.push(`在場的「${a}」和「${b}」其實是同一個人的兩個身份，你知道這件事。群裡其他人不一定知道，要不要點破看你們之間的默契。`);
        }
    }
    return lines;
}
