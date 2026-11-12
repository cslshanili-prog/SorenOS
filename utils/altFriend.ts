/**
 * 角色的小號加你好友、角色自己開小號（關係線第 7 批 7c，plans/persona-line-batch7.md）。純邏輯，不碰資料庫。
 *
 * - 小號加你：`altFriendRequest` 存在小號身上，到了 `at` 才出現在訊息列表「新的朋友」；
 *   你通過／拒絕／封鎖。拒絕不冷卻，要不要再來由本人決定（本人私聊裡寫 ALT_ADD）；封鎖了就不會再來。
 * - 角色自己開：本人私聊裡寫 OPEN_ALT，在 `altSelfRoom` 之內才開；招呼有寫就順便排一次加你。
 * - 兩個標籤都只在本人私聊裡教（「你的小號」那段），雲端生成的照樣送回來、由後處理消化。
 */
import type { AltFriendRequest, CharacterProfile } from '../types';
import { altSelfRoom, altsOf } from './charAlt';

export const ALT_FIELD_MAX = 80;

/** 後處理讀到本人寫的小號標籤 → OSContext 去開／排申請 */
export const ALT_ACTION_EVENT = 'soren-alt-action';
export interface AltActionDetail {
    ownerId: string;
    /** 本人這條線的你（小號要加的就是這張卡） */
    personaKey: string;
    openAlt: OpenAltTag | null;
    altAdd: AltAddTag | null;
}
export const ALT_GREETING_MAX = 120;

/** 第一次來加你：10～40 分鐘後；被拒之後再來：5～20 分鐘後 */
const FIRST_DELAY: [number, number] = [10, 40];
const RETRY_DELAY: [number, number] = [5, 20];

const minutes = ([lo, hi]: [number, number], rand: number) => Math.round((lo + (hi - lo) * rand) * 60_000);

const clean = (v: string | undefined, max: number): string =>
    (v || '').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim().slice(0, max);

/**
 * 排一次申請。已經是好友、被封鎖了就不排（回 null）；還在等你回的換成新的招呼、時間不動。
 */
export function planAltRequest(prev: AltFriendRequest | undefined, args: {
    personaKey: string; greeting: string; now: number; rand?: number;
}): AltFriendRequest | null {
    if (prev?.status === 'accepted' || prev?.status === 'blocked') return null;
    const greeting = clean(args.greeting, ALT_GREETING_MAX);
    if (prev?.status === 'pending') return { ...prev, greeting: greeting || prev.greeting };
    const delay = minutes(prev?.status === 'rejected' ? RETRY_DELAY : FIRST_DELAY, args.rand ?? Math.random());
    return {
        personaKey: args.personaKey, greeting, at: args.now + delay, status: 'pending',
        ...(prev?.rejectCount ? { rejectCount: prev.rejectCount } : {}),
        ...(prev?.lastRejectedGreeting ? { lastRejectedGreeting: prev.lastRejectedGreeting } : {}),
    };
}

export type AltRequestAction = 'accept' | 'reject' | 'block';

export function decideAltRequest(req: AltFriendRequest, action: AltRequestAction, now: number): AltFriendRequest {
    if (action === 'accept') return { ...req, status: 'accepted', decidedAt: now };
    if (action === 'block') return { ...req, status: 'blocked', decidedAt: now };
    return { ...req, status: 'rejected', decidedAt: now, rejectCount: (req.rejectCount || 0) + 1, lastRejectedGreeting: req.greeting };
}

/** 封鎖過的也能解除（上帝視角）：變回「拒絕過」，本人之後想再來就能再來 */
export function unblockAltRequest(req: AltFriendRequest): AltFriendRequest {
    return { ...req, status: 'rejected' };
}

/** 到了、還在等你回的申請（新的在前） */
export function dueAltRequests<T extends Pick<CharacterProfile, 'altOf' | 'altFriendRequest'>>(chars: T[], now: number): T[] {
    return chars
        .filter(c => c.altOf && c.altFriendRequest?.status === 'pending' && c.altFriendRequest.at <= now)
        .sort((a, b) => b.altFriendRequest!.at - a.altFriendRequest!.at);
}

/** 上帝視角的狀態（本人編輯頁「小號」那一區） */
export function altRequestStatusText(alt: Pick<CharacterProfile, 'altFriendRequest' | 'altUserFriend'>, now: number): string {
    const r = alt.altFriendRequest;
    if (alt.altUserFriend || r?.status === 'accepted') return '已經是你的好友';
    if (!r) return '還沒來加你';
    if (r.status === 'blocked') return '被你封鎖了';
    const tried = r.rejectCount ? `（你拒絕過 ${r.rejectCount} 次）` : '';
    if (r.status === 'rejected') return `你拒絕了${tried}`;
    if (r.at > now) return `約 ${Math.max(1, Math.ceil((r.at - now) / 60_000))} 分鐘後來加你${tried}`;
    return `等你回覆${tried}`;
}

// ─── 標籤 ───

/** [[ACTION:OPEN_ALT|網名|簡介|理由|招呼]]；簡介、理由、招呼可省 */
const OPEN_ALT_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(?:OPEN_ALT|NEW_ALT|開小號|开小号)\s*((?:[|｜][^\]\n]*)?)\]\]/gi;
/** [[ACTION:ALT_ADD|小號名|招呼]] */
const ALT_ADD_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(?:ALT_ADD|ALT_FRIEND|小號加好友|小号加好友)\s*((?:[|｜][^\]\n]*)?)\]\]/gi;

const splitFields = (raw: string | undefined): string[] => (raw || '').split(/[|｜]/).slice(1);

export interface OpenAltTag { name: string; brief: string; purpose: string; greeting: string }
export interface AltAddTag { name: string; greeting: string }

/** 兩種標籤一律剝掉；各以第一個為準（一則回覆最多開一個、加一次）。沒寫名字的當作沒寫。 */
export function extractAltTags(text: string): { cleanedText: string; openAlt: OpenAltTag | null; altAdd: AltAddTag | null } {
    let openAlt: OpenAltTag | null = null;
    let altAdd: AltAddTag | null = null;
    let matched = false;
    let out = text.replace(OPEN_ALT_TAG_RE, (_m, raw?: string) => {
        matched = true;
        const [name, brief, purpose, greeting] = splitFields(raw);
        const n = clean(name, 20);
        if (!openAlt && n) openAlt = { name: n, brief: clean(brief, ALT_FIELD_MAX), purpose: clean(purpose, 200), greeting: clean(greeting, ALT_GREETING_MAX) };
        return '';
    });
    out = out.replace(ALT_ADD_TAG_RE, (_m, raw?: string) => {
        matched = true;
        const [name, greeting] = splitFields(raw);
        const n = clean(name, 20);
        if (!altAdd && n) altAdd = { name: n, greeting: clean(greeting, ALT_GREETING_MAX) };
        return '';
    });
    if (!matched) return { cleanedText: text, openAlt: null, altAdd: null };
    return { cleanedText: out.replace(/[ \t]+\n/g, '\n').trim(), openAlt, altAdd };
}

/** 本人寫的 OPEN_ALT 能不能開：還有名額、名字沒跟本人和現有小號撞 */
export function canOpenAlt(owner: Pick<CharacterProfile, 'id' | 'name' | 'altSelfLimit'>, chars: Array<Pick<CharacterProfile, 'altOf' | 'altCreatedBy' | 'name'>>, name: string): boolean {
    if (!name.trim() || altSelfRoom(owner, chars) <= 0) return false;
    return name !== owner.name && !altsOf(owner.id, chars).some(a => a.name === name);
}

/** 本人寫的 ALT_ADD 對到哪個小號（名字對得上、沒被封鎖、還不是好友） */
export function resolveAltAdd<T extends Pick<CharacterProfile, 'id' | 'altOf' | 'name' | 'altFriendRequest' | 'altUserFriend'>>(ownerId: string, chars: T[], name: string): T | null {
    const alt = altsOf(ownerId, chars).find(a => a.name === name);
    if (!alt || alt.altUserFriend || alt.altFriendRequest?.status === 'blocked' || alt.altFriendRequest?.status === 'accepted') return null;
    return alt;
}

/** 本人私聊的「你的小號」那段：列出小號跟你的好友狀態，教 ALT_ADD；還有名額就教 OPEN_ALT。沒東西可說回空字串。 */
export function buildOwnerAltPrompt(owner: Pick<CharacterProfile, 'id' | 'name' | 'altSelfLimit'>, chars: Array<Pick<CharacterProfile, 'id' | 'altOf' | 'altCreatedBy' | 'name' | 'description' | 'altPurpose' | 'altFriendRequest' | 'altUserFriend'>>, userName: string): string {
    const alts = altsOf(owner.id, chars);
    const room = altSelfRoom(owner, chars);
    if (!alts.length && room <= 0) return '';
    const status = (a: typeof alts[number]): string => {
        const r = a.altFriendRequest;
        if (a.altUserFriend || r?.status === 'accepted') return `已經是${userName}的好友`;
        if (!r) return `還沒加${userName}好友`;
        if (r.status === 'blocked') return `被${userName}封鎖了，加不了`;
        const tried = r.rejectCount ? `，${userName}拒絕過 ${r.rejectCount} 次${r.lastRejectedGreeting ? `（上次你說「${r.lastRejectedGreeting}」）` : ''}` : '';
        if (r.status === 'rejected') return `加${userName}好友被拒絕了${tried}`;
        return `已經送出好友申請，等${userName}回覆${tried}`;
    };
    const lines = [`\n### 你的小號（只有你自己知道）`];
    if (alts.length) {
        lines.push(`${userName}不知道這些帳號是你。`);
        for (const a of alts) lines.push(`- 「${a.name}」${a.description ? `（簡介：${a.description}）` : ''}${a.altPurpose ? `；你開它是因為：${a.altPurpose}` : ''}；${status(a)}`);
        lines.push(`想用小號（再）加${userName}好友：在回覆最後另起一行寫 [[ACTION:ALT_ADD|小號名|加好友時的招呼]]，過一陣子${userName}會收到申請；要不要再來、隔多久，照你的性格。`);
    }
    if (room > 0) {
        lines.push(`你也可以自己開一個新的小號（還能開 ${room} 個）：在回覆最後另起一行寫 [[ACTION:OPEN_ALT|網名|帳號簡介|為什麼開|加${userName}好友的招呼]]。這很少用：只有你真的有理由（想用別人的身份接近誰、說不敢用本名說的話……）才開；開了${userName}不會知道是你。招呼留空就先不加${userName}。不要在對話裡提到你開了小號。`);
    }
    return `${lines.join('\n')}\n`;
}
