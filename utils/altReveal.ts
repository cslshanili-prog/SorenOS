/**
 * 認出小號（關係線第 7 批 7d，plans/persona-line-batch7.md 第 5 節）。純邏輯，不碰資料庫。
 *
 * - 你：小號的私聊「＋」裡「我知道你是誰」，選一個你覺得的人、寫根據。一次生成：它看你說得有沒有道理、
 *   照性格決定認不認（猜錯人就照小號的身份回你，也可以乾脆說出真相）。認了＝`altRevealed`，
 *   兩條線各落一則系統提示；沒認就記一筆 `altDenied`，提示詞裡它知道你懷疑過幾次、之後更小心。
 * - 它自己說出來：本人私聊寫 [[ACTION:ALT_REVEAL|小號名]]、小號私聊寫 [[ACTION:ALT_REVEAL]]（標籤在 utils/altFriend.ts）。
 * - 認出來之後小號照舊存在，要不要繼續用由它自己決定。
 */
export const ALT_GUESS_REASON_MAX = 200;
export const ALT_GUESS_REPLY_MAX = 400;

export function buildAltGuessPrompt(args: {
    altName: string;
    ownerName: string;
    userName: string;
    guessName: string;
    reason: string;
    deniedTimes: number;
}): string {
    const { altName, ownerName, userName, guessName, deniedTimes } = args;
    const reason = args.reason.trim().slice(0, ALT_GUESS_REASON_MAX);
    const right = guessName === ownerName;
    return [
        `${userName}剛剛跟你說：「我知道你是誰——你是${guessName}吧？」`,
        reason ? `${userName}的根據：「${reason}」` : `${userName}沒說根據。`,
        right
            ? `${userName}猜對了：「${altName}」就是你（${ownerName}）。看${userName}的根據有沒有說服力、照你的性格和你開這個小號的理由、你現在想不想讓${userName}知道，決定認不認。${deniedTimes ? `${userName}之前已經懷疑過 ${deniedTimes} 次，你都沒認。` : ''}`
            : `${userName}猜錯了：你不是「${guessName}」（你是${ownerName}，但${userName}不知道）。照小號「${altName}」的身份回${userName}；要不要乾脆說出你其實是誰，由你決定。`,
        '',
        `只輸出 JSON，不要別的：{"admit": true 或 false, "reply": "你回${userName}的話"}`,
        `admit 是你有沒有讓${userName}知道「${altName}」就是${ownerName}（承認、或自己說出來都算）。reply 用你現在在這個帳號說話的口吻，${ALT_GUESS_REPLY_MAX} 字以內。`,
    ].join('\n');
}

export function parseAltGuessDecision(raw: unknown): { admitted: boolean; reply: string } | null {
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (!obj || !('admit' in obj)) return null;
    const admitted = obj.admit === true || obj.admit === 'true';
    const reply = typeof obj.reply === 'string' ? obj.reply.trim().slice(0, ALT_GUESS_REPLY_MAX) : '';
    return { admitted, reply };
}

/** 你問的那一句（落在小號那條線，role user） */
export function altGuessUserText(guessName: string, reason: string): string {
    const r = reason.trim().slice(0, ALT_GUESS_REASON_MAX);
    return `我知道你是誰——你是${guessName}吧？${r ? `\n${r}` : ''}`;
}

/** 認出來之後兩條線各落的那一則系統提示 */
export function altRevealNotes(args: { altName: string; ownerName: string; userName: string; how: 'admitted' | 'told' }): { altLine: string; ownerLine: string } {
    const { altName, ownerName, userName, how } = args;
    const what = how === 'admitted' ? `${userName}認出了小號「${altName}」，${ownerName}承認了` : `${ownerName}說出來了：小號「${altName}」就是${ownerName}`;
    return { altLine: `[系統: ${what}]`, ownerLine: `[系統: ${what}]` };
}
