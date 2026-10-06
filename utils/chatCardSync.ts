import type { Message } from '../types';
import { DB } from './db';

/**
 * 「同步到私聊」可以按第二次（2026-10-06）：以前同步過就鎖死成「已同步到私聊」，
 * 私聊裡那張卡刪掉了也不能再發，原本的內容改過了也帶不過去。現在：
 * - 那張卡還在（同一個角色的私聊）→ 原地換成最新內容，位置和時間不動；
 * - 被刪了、或從沒同步過 → 重新發一張。
 * 查手機記錄、軌跡（Archives／Objective／Checklist／行程／OOTD／Moments）共用。
 */
export type ChatCardInput = Pick<Message, 'role' | 'type' | 'content'> & { metadata?: Message['metadata'] };

export async function upsertChatCard(
    existingId: number | undefined,
    charId: string,
    card: ChatCardInput,
): Promise<{ id: number; updated: boolean }> {
    if (existingId != null) {
        const existing = await DB.getMessageById(existingId).catch(() => undefined);
        if (existing && existing.charId === charId) {
            await DB.replaceMessageFields(existingId, { type: card.type, content: card.content, metadata: card.metadata });
            return { id: existingId, updated: true };
        }
    }
    const id = await DB.saveMessage({ charId, ...card } as Parameters<typeof DB.saveMessage>[0]);
    return { id, updated: false };
}

/** 按鈕文字：沒同步過是「同步…」，同步過是「再同步一次」（卡還在就更新、刪了就重發）。 */
export const syncButtonLabel = (synced: boolean, busy: boolean, first = '同步到私聊'): string =>
    busy ? '同步中…' : synced ? '再同步一次（更新私聊裡那張）' : first;

export const syncToastText = (updated: boolean): string => (updated ? '已更新私聊裡那張卡片' : '已同步到私聊');
