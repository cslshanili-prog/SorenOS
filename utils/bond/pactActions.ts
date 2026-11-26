/**
 * 聊天裡角色提議的約定／默契小卡按「好／先不要」（plans/bond-batch4.md 1.7，utils/bond/pactTags.ts）。
 * 好：你這邊說好（角色那邊建卡時已經說好），約定成立／默契算數；先不要：那張提議中的卡刪掉。
 * 在羈絆裡已經答應過的，小卡照卡片現在的狀態顯示，這裡不再動。
 */
import type { Message } from '../../types';
import { DB } from '../db';
import { deleteBondEntries, saveBondEntry } from './entries';
import { bondEntryById } from './entryRegistry';
import { agreePromise, confirmHabit } from './pact';
import { proposalStatus, type BondProposalMeta } from './pactTags';

export async function resolveBondProposal(msg: Message, action: 'accepted' | 'declined', now = Date.now()): Promise<BondProposalMeta | null> {
    const meta: BondProposalMeta | undefined = msg.metadata?.bondProposal;
    if (!meta) return null;
    const entry = bondEntryById(meta.entryId);
    if (proposalStatus(meta, entry) !== 'pending') return null;
    if (action === 'accepted' && entry) {
        await saveBondEntry(entry.kind === 'habit' ? confirmHabit(entry, 'user', now) : agreePromise(entry, 'user', now));
    } else if (action === 'declined' && entry) {
        await deleteBondEntries([entry.id]);
    }
    await DB.updateMessageMetadata(msg.id, prev => ({ ...prev, bondProposal: { ...(prev?.bondProposal || meta), status: action, resolvedAt: now } }));
    return meta;
}
