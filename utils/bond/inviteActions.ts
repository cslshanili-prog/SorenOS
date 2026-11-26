/**
 * 聊天裡的羈絆邀請卡按「好／先不要」（plans/bond-batch1.md 3.5）。
 * 好：寫一筆 openedBy 'char' 的空間（路線仍是未指定，你自己選）；先不要：寫一筆 inviteDeclinedAt。
 * 兩種都會留下紀錄，這條線之後就不再教角色邀請。
 */
import type { Message } from '../../types';
import { DB } from '../db';
import { bondOrBlank, saveBondRecord } from './store';

export async function resolveBondInvite(msg: Message, action: 'accepted' | 'declined', now = Date.now()): Promise<string | null> {
    const bondId: string | undefined = msg.metadata?.bondInvite?.bondId;
    if (!bondId || msg.metadata?.bondInvite?.status !== 'pending') return null;
    await DB.updateMessageMetadata(msg.id, prev => ({ ...prev, bondInvite: { ...(prev?.bondInvite || {}), status: action, resolvedAt: now } }));
    const cur = bondOrBlank(bondId);
    if (action === 'accepted') {
        await saveBondRecord({ ...cur, openedBy: 'char', openedAt: now, inviteDeclinedAt: undefined });
    } else {
        await saveBondRecord({ ...cur, inviteDeclinedAt: now });
    }
    return bondId;
}
