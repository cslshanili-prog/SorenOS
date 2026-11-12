/**
 * 角色的小號（關係線第 7 批，plans/persona-line-batch7.md）。純邏輯。
 *
 * - 小號是一張角色卡（altOf 指回本人），私聊、主動消息、朋友圈這些照角色在跑的功能直接能用。
 * - 人設、記憶照本人的：組角色檔案時把本人的人設、印象、長期記憶拿來用（altPersonaView），
 *   只有對外的名字、頭像、簡介是小號自己的，再加一段「你現在用的小號」。
 * - 兩邊互通：本人知道小號最近跟你聊了什麼，小號也知道本人最近跟你聊了什麼（formatAltBridge）。
 */
import type { CharacterProfile, Message } from '../types';

export const ALT_SELF_LIMIT_DEFAULT = 3;
export const ALT_SELF_LIMIT_MAX = 5;

/** 組角色檔案時已經換成本人人設的視圖（避免再換一次） */
export const ALT_RESOLVED = Symbol('altResolved');

export const isAltChar = (c: Pick<CharacterProfile, 'altOf'> | null | undefined): boolean => !!c?.altOf;

export function altsOf<T extends Pick<CharacterProfile, 'altOf'>>(ownerId: string, chars: T[]): T[] {
    return chars.filter(c => c.altOf === ownerId);
}

/** 它自己還能開幾個（你幫它開的不算） */
export function altSelfRoom(owner: Pick<CharacterProfile, 'id' | 'altSelfLimit'>, chars: Array<Pick<CharacterProfile, 'altOf' | 'altCreatedBy'>>): number {
    const limit = owner.altSelfLimit ?? ALT_SELF_LIMIT_DEFAULT;
    const used = chars.filter(c => c.altOf === owner.id && c.altCreatedBy === 'char').length;
    return Math.max(0, limit - used);
}

/**
 * 小號的角色檔案用的視圖：本人的人設、世界、世界書、記憶、印象；id、名字、頭像、簡介是小號的，
 * 記憶宮殿這一輪的召回結果也是小號身上的（injectMemoryPalace 用本人的 id 召回後寫回小號）。
 */
export function altPersonaView(alt: CharacterProfile, owner: CharacterProfile): CharacterProfile {
    const view = {
        ...owner,
        id: alt.id,
        name: alt.name,
        avatar: alt.avatar,
        description: alt.description,
        altOf: alt.altOf,
        altPurpose: alt.altPurpose,
        memoryPalaceInjection: alt.memoryPalaceInjection,
        roomPlatesInjection: alt.roomPlatesInjection,
        // 線上的關係狀態（跟你的印象、月度總結）用本人主線的：記憶只有一份
        lines: owner.lines,
    } as CharacterProfile & { [ALT_RESOLVED]?: true };
    view[ALT_RESOLVED] = true;
    return view;
}

export const isAltResolved = (c: unknown): boolean => !!(c && typeof c === 'object' && (c as any)[ALT_RESOLVED]);

/** 「你的身份」那段換成：你是本人，現在用小號在說話 */
export function altIdentityBlock(alt: Pick<CharacterProfile, 'name' | 'description' | 'altPurpose'>, owner: Pick<CharacterProfile, 'name' | 'systemPrompt'>): string {
    return `### 你的身份 (Character)
- 你是「${owner.name}」。
- 核心性格/指令:
${owner.systemPrompt || '你是一個溫柔、擬人化的AI伴侶。'}

${altMaskBlock(alt, owner)}`;
}

/** 「你現在用的小號」那一段（朋友圈等只用角色設定的地方也帶） */
export function altMaskBlock(alt: Pick<CharacterProfile, 'name' | 'description' | 'altPurpose'>, owner: Pick<CharacterProfile, 'name'>): string {
    return `### 你現在用的小號
- 你現在用小號「${alt.name}」在說話：對方看到的是「${alt.name}」${alt.description ? `（簡介：${alt.description}）` : ''}，不是「${owner.name}」。
${alt.altPurpose ? `- 你開這個小號的理由：${alt.altPurpose}\n` : ''}- 對方不知道「${alt.name}」就是你。要不要說、什麼時候說，由你決定；說話方式可以刻意跟平常不一樣（換個口吻、少用你的口頭禪），但你還是你，知道的事、在意的人都一樣。
- 你用本名「${owner.name}」跟對方說過的話、你們之間的一切，你都記得；用小號時別不小心說出只有「${owner.name}」才會知道的事——除非你就是想讓對方發現。

`;
}

/** 「認出要有證據」（借上游）：碰到不認識的帳號時給其他角色的規則 */
export const ALT_RECOGNITION_RULE = '有些帳號是你不認識的人。就算覺得某個帳號像你認識的誰，也要有具體的根據（說話習慣、提到只有那個人才會知道的事、時間對得上……）才會這樣想；沒有根據就把 TA 當陌生人，不要亂猜。真的有根據、而且你在意，可以半開玩笑地問一句，對方認不認由 TA。';

const LINE_MAX = 120;

/** 兩邊互通的那一段：本人看小號的、小號看本人的。沒有訊息回空字串。 */
export function formatAltBridge(args: {
    /** 現在說話的是小號（看本人那邊）還是本人（看小號那邊） */
    selfIsAlt: boolean;
    /** 另一邊的名字（本人的名字，或小號的名字） */
    otherName: string;
    ownerName: string;
    userName: string;
    msgs: Array<Pick<Message, 'role' | 'content' | 'timestamp'>>;
    formatDate: (ts: number) => string;
}): string {
    const rows = args.msgs.filter(m => typeof m.content === 'string' && m.content.trim() && (m.role === 'user' || m.role === 'assistant'));
    if (!rows.length) return '';
    const lines = rows.map(m => {
        const who = m.role === 'user' ? args.userName : '你';
        const text = String(m.content).trim().replace(/\n+/g, ' ');
        return `[${args.formatDate(m.timestamp)}] ${who}: ${text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text}`;
    });
    const head = args.selfIsAlt
        ? `### 【你用本名「${args.ownerName}」跟「${args.userName}」最近聊的】\n（這是你自己用本名說的，「${args.userName}」不知道你現在用的小號就是你。）`
        : `### 【你用小號「${args.otherName}」跟「${args.userName}」最近聊的】\n（「${args.userName}」不知道「${args.otherName}」就是你。這些是你自己說過的，你都記得；要不要讓 TA 發現由你決定。）`;
    return `\n${head}\n${lines.join('\n')}\n`;
}

/**
 * 讀互通那段要的訊息：小號 → 本人那條線（同一張卡）最近幾則；本人 → 每個小號那條線最近幾則。
 * personaKey 是現在這條線的你；沒有就是主線。
 */
export async function loadAltBridgeText(args: {
    char: CharacterProfile;
    personaKey: string | undefined;
    userName: string;
    formatDate: (ts: number) => string;
    limit?: number;
}): Promise<string> {
    const [{ DB }, { getRegisteredCharacter, getRegisteredCharacters }, { lineFor }] = await Promise.all([
        import('./db'), import('./charNameRegistry'), import('./chatLine'),
    ]);
    const limit = args.limit ?? 12;
    const readLine = async (c: CharacterProfile) => {
        const line = lineFor(c, args.personaKey);
        return DB.getRecentMessagesByCharId(line.personaKey ? line : line.charId, limit, true);
    };
    if (args.char.altOf) {
        const owner = getRegisteredCharacter<CharacterProfile>(args.char.altOf);
        if (!owner) return '';
        return formatAltBridge({ selfIsAlt: true, otherName: owner.name, ownerName: owner.name, userName: args.userName, msgs: await readLine(owner), formatDate: args.formatDate });
    }
    const alts = getRegisteredCharacters<CharacterProfile>().filter(c => c.altOf === args.char.id);
    let out = '';
    for (const alt of alts) {
        out += formatAltBridge({ selfIsAlt: false, otherName: alt.name, ownerName: args.char.name, userName: args.userName, msgs: await readLine(alt), formatDate: args.formatDate });
    }
    return out;
}
