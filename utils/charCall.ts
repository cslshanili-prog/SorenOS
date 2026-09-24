/**
 * 聊天設定 · Scenario ·「允許角色主動打電話／視訊」的純邏輯：標籤解析、冷卻、該不該響、
 * 歷史記錄形態、提示詞。
 *
 * 角色想打給用戶時，在回覆最後寫 [[ACTION:CALL|voice或video|打來的原因]]；後處理剝掉標籤，
 * 在這一輪話的後面落一張來電卡（type 'char_call'，metadata.charCall）。
 * - 用戶此刻開著 App、這輪回覆又是剛生成的 → 卡片狀態 ringing，全域來電畫面響起
 *   （components/IncomingCallOverlay.tsx）：接聽直接進通話（角色先開口、知道自己為什麼打來），
 *   拒接落旁白，30 秒沒接記成未接；
 * - 否則（背景生成、雲端推播、補收的舊回覆）直接記成未接來電，卡上可以回撥。
 * 打過一次之後（不管接沒接）一小時內不再打：標籤照剝，但不落卡。
 *
 * 歷史裡的來電卡渲染成 [[記錄:CALL|...]]（跟轉帳同一套記錄形態）：模型照抄只會被 sanitize 剝掉。
 */

export type CharCallMode = 'voice' | 'video';
export type CharCallStatus = 'ringing' | 'accepted' | 'declined' | 'missed';

export interface CharCallMeta {
    mode: CharCallMode;
    reason: string;
    status: CharCallStatus;
    /** 落卡（開始響）的時刻 */
    at: number;
    respondedAt?: number;
}

export const CHAR_CALL_REASON_MAX = 40;
/** 響多久沒接算未接 */
export const CHAR_CALL_RING_MS = 30_000;
/** 回覆生成超過這麼久才落地（補收、背景排隊）就不響了，直接記未接 */
export const CHAR_CALL_LIVE_MAX_AGE_MS = 2 * 60_000;
/** 打過一次之後多久內不再打 */
export const CHAR_CALL_COOLDOWN_MS = 60 * 60_000;

/** 全域來電畫面聽這個事件；detail 是 IncomingCharCallDetail。 */
export const INCOMING_CHAR_CALL_EVENT = 'incoming-char-call';
export interface IncomingCharCallDetail {
    charId: string;
    messageId: number;
    mode: CharCallMode;
    reason: string;
}

const VIDEO_WORDS = ['video', '視訊', '视讯', '視頻', '视频', '視頻通話', '视频通话', '視訊通話'];
const VOICE_WORDS = ['voice', '語音', '语音', '電話', '电话', '語音通話', '语音通话'];

/**
 * [[ACTION:CALL|voice|原因]]、[[ACTION:CALL|video|原因]]；也認 VIDEO_CALL / VOICE_CALL / 打電話 /
 * 視訊通話 這類把模式寫進名字的寫法（這時第一欄就是原因），以及全形標點。
 */
const CHAR_CALL_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(CALL|PHONE_CALL|VOICE_CALL|VIDEO_CALL|打電話|打电话|視訊通話|视讯通话|視頻通話|视频通话|語音通話|语音通话)\s*((?:[|｜][^\]\n]*)?)\]\]/gi;

const cleanReason = (v: string | undefined): string =>
    (v || '').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim().slice(0, CHAR_CALL_REASON_MAX);

const modeOf = (word: string): CharCallMode | null => {
    const w = word.trim().toLowerCase();
    if (VIDEO_WORDS.includes(w)) return 'video';
    if (VOICE_WORDS.includes(w)) return 'voice';
    return null;
};

/** 剝掉所有來電標籤；有多個時以第一個為準（一輪只打一通）。 */
export function extractCharCall(text: string): { cleanedText: string; call: { mode: CharCallMode; reason: string } | null } {
    let call: { mode: CharCallMode; reason: string } | null = null;
    let matched = false;
    const stripped = text.replace(CHAR_CALL_TAG_RE, (_m, name: string, rest: string) => {
        matched = true;
        if (call) return '';
        const fields = (rest || '').split(/[|｜]/).slice(1).map(s => s.trim());
        const upper = name.toUpperCase();
        const named: CharCallMode | null = upper === 'VIDEO_CALL' || /視訊|视讯|視頻|视频/.test(name) ? 'video'
            : upper === 'VOICE_CALL' || /電話|电话|語音|语音/.test(name) ? 'voice'
            : null;
        if (named) {
            call = { mode: named, reason: cleanReason(fields.join(' ')) };
        } else {
            const fromField = fields.length ? modeOf(fields[0]) : null;
            call = fromField
                ? { mode: fromField, reason: cleanReason(fields.slice(1).join(' ')) }
                : { mode: 'voice', reason: cleanReason(fields.join(' ')) };
        }
        return '';
    });
    if (!matched) return { cleanedText: text, call: null };
    return { cleanedText: stripped.replace(/[ \t]+\n/g, '\n').trim(), call };
}

/** 卡片上的「響著」只在這一次開著的 App 裡算數：響到一半重新整理，回來就是未接。 */
export function effectiveCallStatus(meta: Partial<CharCallMeta> | undefined, now: number = Date.now()): CharCallStatus {
    const status = meta?.status;
    if (status === 'accepted' || status === 'declined' || status === 'missed') return status;
    const at = typeof meta?.at === 'number' ? meta.at : 0;
    return now - at > CHAR_CALL_RING_MS + 5_000 ? 'missed' : 'ringing';
}

/** 這一輪回覆落地時該不該讓來電畫面響。 */
export function shouldRingNow(opts: { spokenAt?: number; now: number; visible: boolean; busy: boolean }): boolean {
    if (!opts.visible || opts.busy) return false;
    const age = typeof opts.spokenAt === 'number' ? opts.now - opts.spokenAt : 0;
    return age <= CHAR_CALL_LIVE_MAX_AGE_MS;
}

// ── 冷卻（localStorage，按角色記最後一次打來的時刻）──────────────────────────

const COOLDOWN_KEY = 'soren_char_call_last';

function readCooldown(): Record<string, number> {
    try {
        const parsed = JSON.parse(localStorage.getItem(COOLDOWN_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function canCharCallNow(charId: string, now: number = Date.now()): boolean {
    const last = readCooldown()[charId];
    return !(typeof last === 'number' && now - last < CHAR_CALL_COOLDOWN_MS);
}

/** 冷卻中時給角色看的一句（易變段）：剛打過、現在打不出去，免得它嘴上說「我打了」卻什麼都沒響。 */
export function buildCharCallCooldownNote(charId: string, userName: string, now: number = Date.now()): string {
    const last = readCooldown()[charId];
    if (typeof last !== 'number' || now - last >= CHAR_CALL_COOLDOWN_MS) return '';
    const minutesAgo = Math.max(1, Math.round((now - last) / 60_000));
    const minutesLeft = Math.max(1, Math.ceil((last + CHAR_CALL_COOLDOWN_MS - now) / 60_000));
    const name = userName.trim() || '對方';
    return `\n（你 ${minutesAgo} 分鐘前才打過電話給${name}，大約 ${minutesLeft} 分鐘內打不出去——這段時間不要寫來電標籤，也不要說「我打給你了」。${name}要你打的話，自然地說晚點再打，或請${name}打給你。）\n`;
}

export function markCharCallAttempt(charId: string, now: number = Date.now()): void {
    try {
        localStorage.setItem(COOLDOWN_KEY, JSON.stringify({ ...readCooldown(), [charId]: now }));
    } catch { /* 存不進去就少一道冷卻，提示詞那邊還是會讓角色克制 */ }
}

// ── 文字 ──────────────────────────────────────────────────────────────────

const MODE_WORD: Record<CharCallMode, string> = { voice: '語音', video: '視訊' };
const STATUS_WORD: Record<CharCallStatus, string> = {
    ringing: '響鈴中',
    accepted: '對方接聽了',
    declined: '對方拒接',
    missed: '對方沒接到',
};

/** 歷史／歸檔裡一張來電卡的樣子（chatPrompts.buildMessageHistory 與 messageFormat 共用）。 */
export function formatCharCallRecord(meta: Partial<CharCallMeta> | undefined, now: number = Date.now()): string {
    const parts = ['from=char', `mode=${MODE_WORD[meta?.mode === 'video' ? 'video' : 'voice']}`];
    if (meta?.reason) parts.push(`reason=${meta.reason}`);
    parts.push(`status=${STATUS_WORD[effectiveCallStatus(meta, now)]}`);
    return `[[記錄:CALL|${parts.join('|')}]]`;
}

/** 卡片摘要（通知、聊天列表預覽用）。 */
export function describeCharCall(meta: Pick<CharCallMeta, 'mode' | 'reason'>): string {
    return `[${MODE_WORD[meta.mode]}來電]${meta.reason ? ` ${meta.reason}` : ''}`;
}

/** 拒接時落的一行旁白（接聽會有通話記錄，未接看卡片狀態就夠）。 */
export function buildCharCallDeclinedNote(userName: string, charName: string, mode: CharCallMode): string {
    return `[系統: ${userName}拒接了${charName}的${MODE_WORD[mode]}來電]`;
}

/** 接聽後讓角色先開口的那一句（CallApp 的開場）。 */
export function buildIncomingCallGreeting(mode: CharCallMode, reason: string): string {
    const kind = mode === 'video' ? '視訊' : '電話';
    return `（這通${kind}是你打給對方的，對方剛接起來。${reason ? `你打來是因為：${reason}。` : ''}你先開口——像真的是你撥過去、等到對方接起來那樣，自然地說第一句話。不要解釋規則。）`;
}

/** 開關開著時放進穩定段的教學。 */
export function buildCharCallPrompt(userName: string): string {
    return `\n### 打電話給${userName}\n如果你真的很想聽${userName}的聲音、有急事要說、或想看看${userName}，可以在回覆最後另起一行寫 [[ACTION:CALL|voice|打來的原因]]（語音）或 [[ACTION:CALL|video|打來的原因]]（視訊），原因 ${CHAR_CALL_REASON_MAX} 字以內。${userName}的手機會響，可能接也可能沒接到。這是偶爾才做的事：平常聊天不要打，剛打過、剛通完話或${userName}正在忙時也不要打；不要在文字裡說「我要打給你了」之類的話，直接打就好。歷史裡的 [[記錄:CALL|...]] 是已經打過的來電，不要照抄。\n`;
}
