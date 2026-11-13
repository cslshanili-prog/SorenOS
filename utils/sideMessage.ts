/**
 * 聊天中私下找人（plans/side-messages.md）。純邏輯，不碰資料庫。
 *
 * - `[[PRIVATE|身份名: 內容]]`：給你的某張身份卡（說話的人認識的，不用在場）。
 * - `[[DM|角色名: 內容]]`：給另一個角色（同一個世界的，或關係清單上的），對方會回一句。
 * - 認識才找得到；一輪 PRIVATE、DM 各最多 1 條；拉黑中不落；被私訊後回的那句不再觸發（深度 1）。
 * 群聊、角色私聊、你的私聊共用這一份：名單、提示詞、解析、上限。
 */
import type { CharacterProfile, UserProfile } from '../types';
import { isOnStage } from './castRole';
import { isChatBlocked } from './chatBlock';
import { lineFor, lineView } from './chatLine';
import { personaNameForKey } from './userPersona';

/** 落你私聊之後發的事件（utils/sideMessageRun.ts 發，OSContext 加未讀、提示） */
export const SIDE_MESSAGE_EVENT = 'soren-side-message';
export interface SideMessageDetail {
    charId: string;
    personaKey?: string;
    charName: string;
    /** 收到的那張卡的名字 */
    toName: string;
    content: string;
}

export const SIDE_PRIVATE_PER_ROUND = 1;
export const SIDE_DM_PER_ROUND = 1;
/** 提示詞裡各列幾個 */
const LIST_MAX = 8;

export interface SideTargets {
    personas: Array<{ key: string; name: string }>;
    chars: Array<{ id: string; name: string }>;
}

const knownKeysOf = (c: Pick<CharacterProfile, 'knownPersonaKeys' | 'primaryPersonaKey'>): string[] =>
    c.knownPersonaKeys?.length ? c.knownPersonaKeys : (c.primaryPersonaKey ? [c.primaryPersonaKey] : []);

const norm = (v: string) => v.normalize('NFKC').replace(/\s+/g, '').replace(/^[「『"“]|[」』"”]$/g, '').toLowerCase();

/**
 * 它可以私下找誰。personas：它認識的卡；chars：同一個世界的、關係清單上的（不含自己、小號、下戲中的、拉黑中的那條不擋——
 * 拉黑只擋落你的私聊）。關係清單上的排前面。
 */
export function sideTargets(speaker: CharacterProfile, args: {
    characters: CharacterProfile[];
    profileBase: UserProfile;
    /** 關係線開關：關著只認主線那張、不能私訊角色（沒有角色私聊線） */
    multiPersona: boolean;
}): SideTargets {
    // 小號還沒加你好友：它不認識你
    const all = speaker.altOf && !speaker.altUserFriend ? [] : knownKeysOf(speaker);
    const keys = args.multiPersona ? all : all.slice(0, 1).map(() => speaker.primaryPersonaKey || all[0]);
    const personas = keys.map(key => ({ key, name: personaNameForKey(args.profileBase, key) })).filter(p => p.name);
    const related = new Set((speaker.relationships || []).map(r => r.targetId));
    const ownerId = speaker.altOf || speaker.id;
    const chars = !args.multiPersona ? [] : args.characters
        .filter(c => c.id !== speaker.id && c.id !== ownerId && !c.altOf && isOnStage(c))
        .filter(c => related.has(c.id) || (!!speaker.groupId && c.groupId === speaker.groupId) || (!speaker.groupId && !c.groupId))
        .sort((a, b) => Number(related.has(b.id)) - Number(related.has(a.id)))
        .map(c => ({ id: c.id, name: c.name }));
    return { personas, chars };
}

/** 給一個人的那一段（私聊、角色私聊用）。名單空、或兩種都不准就回空字串。 */
export function buildSideMessagePrompt(args: {
    targets: SideTargets;
    allowPrivate: boolean;
    allowDm: boolean;
    /** 私聊裡現在跟你說話的那張卡：不列（就在跟它說話） */
    excludePersonaKey?: string;
    /** 角色私聊裡對面那位：不列 */
    excludeCharId?: string;
}): string {
    const personas = args.allowPrivate ? args.targets.personas.filter(p => p.key !== args.excludePersonaKey).slice(0, LIST_MAX) : [];
    const chars = args.allowDm ? args.targets.chars.filter(c => c.id !== args.excludeCharId).slice(0, LIST_MAX) : [];
    if (!personas.length && !chars.length) return '';
    const lines = ['', '### 私下找人（罕見，真的有事才用）'];
    lines.push('聊到某件事，你覺得該私下問某個人、跟某個人確認、或只想對某個人說，可以在回覆裡單獨寫一行：');
    if (personas.length) lines.push(`- 私聊真人：\`[[PRIVATE|名字: 內容]]\`，只能給你認識的：${personas.map(p => `「${p.name}」`).join('、')}。這句只進你們的私聊。`);
    if (chars.length) lines.push(`- 私訊別的角色：\`[[DM|名字: 內容]]\`，可以找：${chars.map(c => `「${c.name}」`).join('、')}。對方會回你。`);
    lines.push(`一次最多各一條；不要每次都用，也不要拿來吐槽別人。沒有要找誰就不寫。`);
    return `${lines.join('\n')}\n`;
}

/** 群聊導演模式：每位成員各一行（名單不同） */
export function buildGroupSideMessageNote(args: {
    members: Array<{ name: string; targets: SideTargets }>;
    allowPrivate: boolean;
    allowDm: boolean;
}): string {
    const rows = args.members.map(m => {
        const p = args.allowPrivate ? m.targets.personas.slice(0, LIST_MAX).map(x => `「${x.name}」`) : [];
        const c = args.allowDm ? m.targets.chars.slice(0, LIST_MAX).map(x => `「${x.name}」`) : [];
        if (!p.length && !c.length) return '';
        return `  · ${m.name}：${p.length ? `私聊 ${p.join('、')}` : ''}${p.length && c.length ? '；' : ''}${c.length ? `私訊 ${c.join('、')}` : ''}`;
    }).filter(Boolean);
    if (!rows.length) return '';
    const how = [
        args.allowPrivate ? '私聊真人寫 `[[PRIVATE|名字: 內容]]`（對方不用在群裡，只進你們的私聊）' : '',
        args.allowDm ? '私訊別的角色寫 `[[DM|名字: 內容]]`（群裡不顯示，對方會回你）' : '',
    ].filter(Boolean).join('；');
    return `
#### 私下找人（罕見特例，默認 0 條）
- 群裡聊到某件事，某個成員覺得該私下問某個人、跟某個人確認，或只想對某個人說，可以在那位成員的內容裡單獨寫一行：${how}。
- 每位成員只能找自己認識的：
${rows.join('\n')}
- **整輪全員加起來**私聊最多 1 條、私訊最多 1 條；絕大多數輪次都是 0。**嚴禁**拿來吐槽群友。
`;
}

const PRIVATE_RE = /\[\[\s*PRIVATE\s*(?:[|｜]\s*([^:：\]\n]*?)\s*)?[:：]\s*([\s\S]*?)\]\]/g;
const DM_RE = /\[\[\s*(?:DM|私訊|私讯|私信)\s*[|｜]\s*([^:：\]\n]+?)\s*[:：]\s*([\s\S]*?)\]\]/gi;

export interface SideMessages {
    cleanedText: string;
    privates: Array<{ name?: string; content: string }>;
    dms: Array<{ to: string; content: string }>;
}

/** 兩種標記一律剝掉，內容空的不算 */
export function extractSideMessages(text: string): SideMessages {
    const privates: SideMessages['privates'] = [];
    const dms: SideMessages['dms'] = [];
    let out = text.replace(PRIVATE_RE, (_m, name?: string, content?: string) => {
        const c = (content || '').trim();
        if (c) privates.push({ ...(name?.trim() ? { name: name.trim() } : {}), content: c });
        return '';
    });
    out = out.replace(DM_RE, (_m, to?: string, content?: string) => {
        const c = (content || '').trim();
        if (to?.trim() && c) dms.push({ to: to.trim(), content: c });
        return '';
    });
    if (!privates.length && !dms.length && out === text) return { cleanedText: text, privates, dms };
    return { cleanedText: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), privates, dms };
}

/** 一輪的額度：群聊一輪（好幾位成員共用）、角色私聊一輪、你的私聊一則回覆 */
export interface SideBudget { private: number; dm: number }
export const newSideBudget = (): SideBudget => ({ private: SIDE_PRIVATE_PER_ROUND, dm: SIDE_DM_PER_ROUND });

/**
 * PRIVATE 落在哪張卡：寫了名字就照名字（只認它認識的）；沒寫就用 fallbackKey（群裡在場、它認識的那張），
 * 再沒有而它只認識一張就是那張。拉黑中的那條不落。回 null＝丟掉。
 */
export function resolvePrivateTarget(speaker: CharacterProfile, args: {
    name?: string;
    targets: SideTargets;
    fallbackKey?: string;
}): string | null {
    const { targets } = args;
    let key: string | undefined;
    if (args.name) key = targets.personas.find(p => norm(p.name) === norm(args.name!))?.key;
    else key = (args.fallbackKey && targets.personas.some(p => p.key === args.fallbackKey)) ? args.fallbackKey
        : targets.personas.length === 1 ? targets.personas[0].key : undefined;
    if (!key) return null;
    if (isChatBlocked(lineView(speaker, lineFor(speaker, key)))) return null;
    return key;
}

/** DM 給誰：名單上名字對得上的那位 */
export function resolveDmTarget(targets: SideTargets, name: string): string | null {
    return targets.chars.find(c => norm(c.name) === norm(name))?.id || null;
}
