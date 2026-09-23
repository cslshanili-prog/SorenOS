/**
 * 聊天設定 · Scenario ·「自動線下邀請」的純邏輯：標籤解析、歷史記錄形態、提示詞。
 *
 * 角色覺得時機到了，在回覆最後寫 [[ACTION:DATE_INVITE|地點|想做什麼]]；後處理剝掉標籤，
 * 在這一輪正文之後落一張邀請卡（type 'date_invite'，metadata.dateInvite）。用戶在卡上按
 * 「赴約」直接進見面，按「婉拒」留一行旁白。接線：
 * - utils/chatPrompts.ts：開關開著才教這個標籤（穩定段）；
 * - utils/applyAssistantPostProcessing.ts、context/OSContext.tsx 的背景回覆：剝標籤、落卡；
 * - components/chat/MessageItem.tsx 的 DateInviteCard、apps/Chat.tsx 的 handleResolveDateInvite。
 *
 * 歷史裡的邀請卡渲染成 [[記錄:DATE_INVITE|...]]（跟轉帳同一套記錄形態，見 transferFormat.ts
 * 頭注）：模型照抄記錄只會被 sanitize 剝掉，不會憑空再落一張卡。
 */

export type DateInviteStatus = 'pending' | 'accepted' | 'declined';

export interface DateInviteMeta {
    place: string;
    plan: string;
    status: DateInviteStatus;
    respondedAt?: number;
}

export const DATE_INVITE_FIELD_MAX = 40;

/** [[ACTION:DATE_INVITE|地點|想做什麼]]，也認中文別名（約見面／見面邀約）和全形標點；第二欄可省。 */
const DATE_INVITE_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(?:DATE_INVITE|INVITE_DATE|約見面|约见面|見面邀約|见面邀约)\s*(?:[|｜]\s*([^\]\n|｜]*?)\s*)?(?:[|｜]\s*([^\]\n]*?)\s*)?\]\]/gi;

const cleanField = (v: string | undefined): string =>
    (v || '').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim().slice(0, DATE_INVITE_FIELD_MAX);

/** 剝掉所有邀約標籤；有多個時以第一個為準（一輪只約一次）。沒有地點也沒有事由的當作沒寫。 */
export function extractDateInvite(text: string): { cleanedText: string; invite: { place: string; plan: string } | null } {
    let invite: { place: string; plan: string } | null = null;
    let matched = false;
    const stripped = text.replace(DATE_INVITE_TAG_RE, (_m, place?: string, plan?: string) => {
        matched = true;
        const p = cleanField(place);
        const q = cleanField(plan);
        if (!invite && (p || q)) invite = { place: p, plan: q };
        return '';
    });
    if (!matched) return { cleanedText: text, invite: null };
    return { cleanedText: stripped.replace(/[ \t]+\n/g, '\n').trim(), invite };
}

const STATUS_WORD: Record<DateInviteStatus, string> = {
    pending: '等對方回應',
    accepted: '對方已赴約',
    declined: '對方婉拒了',
};

/** 歷史／歸檔裡一張邀請卡的樣子（chatPrompts.buildMessageHistory 與 messageFormat 共用）。 */
export function formatDateInviteRecord(meta: Partial<DateInviteMeta> | undefined): string {
    const status = meta?.status === 'accepted' || meta?.status === 'declined' ? meta.status : 'pending';
    const parts = ['from=char'];
    if (meta?.place) parts.push(`place=${meta.place}`);
    if (meta?.plan) parts.push(`plan=${meta.plan}`);
    parts.push(`status=${STATUS_WORD[status]}`);
    return `[[記錄:DATE_INVITE|${parts.join('|')}]]`;
}

/** 邀請卡上一行字的摘要（通知、聊天列表預覽用）。 */
export function describeDateInvite(meta: Partial<DateInviteMeta> | undefined): string {
    const bits = [meta?.place, meta?.plan].filter(Boolean).join('・');
    return bits ? `[見面邀約] ${bits}` : '[見面邀約]';
}

/** 用戶回應之後落的一行旁白。 */
export function buildDateInviteResponseNote(accepted: boolean, userName: string, charName: string): string {
    return accepted
        ? `[系統: ${userName}答應了${charName}的見面邀約，出發去見面了]`
        : `[系統: ${userName}婉拒了${charName}這次的見面邀約]`;
}

/** 開關開著時放進穩定段的教學。 */
export function buildDateInvitePrompt(userName: string): string {
    return `\n### 約${userName}見面\n如果聊到想見面、或你真心覺得是時候約${userName}出來了，可以在回覆最後另起一行寫 [[ACTION:DATE_INVITE|地點|想一起做什麼]]（每欄 ${DATE_INVITE_FIELD_MAX} 字以內，例如 [[ACTION:DATE_INVITE|河堤公園|傍晚散步]]），${userName}會收到一張邀請卡，可以選擇赴約或婉拒。平常聊天不要寫；上一張邀請還沒回應、或剛見過面，也不要再約。歷史裡的 [[記錄:DATE_INVITE|...]] 是已經發過的邀請，不要照抄。\n`;
}
