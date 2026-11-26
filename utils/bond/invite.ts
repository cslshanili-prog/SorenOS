/**
 * 角色邀請建立羈絆空間（plans/bond-batch1.md 3.5）：`[[ACTION:BOND_INVITE|一句話]]`。
 * 只在「這條線還沒有空間紀錄」時教；你按了「好」或「先不要」都會寫一筆紀錄，之後就不再教。
 * 雲端那兩條路由 worker 原樣直通（SOREN_PASSTHROUGH_TAG_RE），客戶端照這裡解析。
 */
import type { CharacterProfile } from '../../types';
import { bondForChar } from './registry';

const BOND_INVITE_RE = /\[\[\s*ACTION\s*[:：]\s*(?:BOND_INVITE|羈絆邀請|羁绊邀请)\s*(?:[|｜]([^\]\n]*))?\]\]/g;

/** 剝掉標籤；有就回邀請那句（沒寫話就是空字串） */
export function extractBondInvite(text: string): { cleanedText: string; invite: string | null } {
    let invite: string | null = null;
    const cleanedText = text.replace(BOND_INVITE_RE, (_m, line: string | undefined) => {
        if (invite === null) invite = (line || '').trim();
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { cleanedText: invite === null ? text : cleanedText, invite };
}

/** 這條線能不能教／收這個標籤：還沒有空間紀錄（按過好或先不要都會有一筆）、不是小號 */
export function canInviteBond(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey' | 'altOf'>): boolean {
    return !char.altOf && !bondForChar(char);
}

/** 私聊教角色的那段（互動類） */
export function buildBondInvitePrompt(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey' | 'altOf'>, userName: string): string {
    if (!canInviteBond(char)) return '';
    return `\n### 想跟${userName}有一個你們兩人的空間時\n「羈絆」是你和${userName}專屬的空間，會留下你們的回憶、日記、約定和收藏。如果你真心想跟${userName}建一個（例如覺得你們之間的事值得好好收著），可以在回覆最後另起一行寫 [[ACTION:BOND_INVITE|你想對TA說的一句話]]。這只是邀請，不代表任何告白或承諾；${userName}可以答應也可以先不要。不用急，也不要每次都提，真的想要時用一次就好。\n`;
}

/** 邀請卡在聊天記錄、記憶裡的樣子（角色看得到你回了沒） */
export function formatBondInviteRecord(meta: { text?: string; status?: string } | undefined): string {
    const said = meta?.text?.trim() ? `：「${meta.text.trim()}」` : '';
    const state = meta?.status === 'accepted' ? '（對方答應了，空間已經建好）'
        : meta?.status === 'declined' ? '（對方說先不要）'
        : '（對方還沒回）';
    return `[你邀請對方建一個你們的羈絆空間${said}]${state}`;
}
