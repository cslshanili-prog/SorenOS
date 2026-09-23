/**
 * 返回最後一條尚未得到助手回覆的用戶輸入。
 *
 * 見面與通話的消息展示模型字段不同（content / text），但失敗重試的判斷完全相同：
 * 只有時間線最後一條仍是 user 時，才表示上一輪可能在生成回覆前中斷。
 */
export function getPendingReplyText(
    messages: Array<{ role?: string; content?: unknown; text?: unknown }>,
): string {
    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== 'user') return '';
    const raw = latest.content ?? latest.text ?? '';
    return typeof raw === 'string' ? raw.trim() : '';
}
