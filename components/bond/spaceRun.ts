/**
 * 收起、再開、刪除一個羈絆空間（plans/bond-open-spaces.md）。
 * - 收起：資料留著、背景停掉、名單上移到「收起的」；再開就回來。
 * - 刪除：這段關係的卡（片刻、日記、約定、禮物、信、故事…）、完成紀錄、親近信任的事件帳、空間本身都刪；
 *   故事回寫進兩人話題盒、記憶宮殿的那幾條照故事的撤回一起撤。聊天紀錄、交換日記、行事曆的紀念日、記憶（每日總結）不動。
 */
import type { CharacterProfile } from '../../types';
import type { RemoteVectorConfig } from '../../utils/memoryPalace/types';
import type { ResolvedSpace } from './space';
import { closeSpace, deleteBondRecord, ensureSpaceOpen } from '../../utils/bond/store';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { deleteBondEntries } from '../../utils/bond/entries';
import { bondLedgerOf } from '../../utils/bond/ledgerRegistry';
import { deleteBondLedgerRows } from '../../utils/bond/ledgerStore';
import { deleteFeelingLogWhere } from '../../utils/bond/feelingStore';
import { retractStory } from './storyRetract';
import { trackEvent } from '../../utils/analytics';

type Updater = (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;

const kindLabel = (space: Pick<ResolvedSpace, 'kind'>) => (space.kind === 'pair' ? '角色之间' : '我和角色');

export async function closeBondSpace(space: ResolvedSpace): Promise<void> {
    await closeSpace(space.id);
    trackEvent('羁绊空间开关', { 动作: '收起', 类型: kindLabel(space), 方式: '手动' });
}

export async function reopenBondSpace(space: ResolvedSpace): Promise<void> {
    await ensureSpaceOpen(space.id, 'reopen');
    trackEvent('羁绊空间开关', { 动作: '再开', 类型: kindLabel(space), 方式: '手动' });
}

export async function deleteBondSpace(space: ResolvedSpace, opts: { updateCharacter: Updater; remoteVectorConfig?: RemoteVectorConfig }): Promise<void> {
    // 先撤故事寫到卡片以外的（話題盒、記憶宮殿），再把卡全部刪掉
    for (const story of bondEntriesOf(space.id).filter(e => e.kind === 'story' && e.story)) {
        await retractStory({ space, story, mode: 'cascade', updateCharacter: opts.updateCharacter, remoteVectorConfig: opts.remoteVectorConfig });
    }
    const ids = bondEntriesOf(space.id).map(e => e.id);
    if (ids.length) await deleteBondEntries(ids);
    const ledger = bondLedgerOf(space.id).map(r => r.id);
    if (ledger.length) await deleteBondLedgerRows(ledger);
    await deleteFeelingLogWhere(id => id === space.id);
    await deleteBondRecord(space.id);
    trackEvent('羁绊空间开关', { 动作: '删除', 类型: kindLabel(space), 方式: '手动' });
}
