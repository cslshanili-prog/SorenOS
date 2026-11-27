/**
 * 刪改一章故事的撤回（plans/bond-batch6.md 第 7 節）：照 utils/bond/derivation.ts 的計劃刪卡或拆關聯，
 * 話題盒（兩邊聯繫人上帶 storyId 的那條）與記憶宮殿節點跟著處理，還沒按的承認卡收掉。
 * 承認卡已經改過的階段不回退（畫面上提醒你可以去路線頁改）。
 */
import type { BondEntry, CharacterProfile } from '../../types';
import type { RemoteVectorConfig } from '../../utils/memoryPalace/types';
import type { ResolvedSpace } from './space';
import { deleteBondEntries, saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { bondEntriesOf, bondEntryById } from '../../utils/bond/entryRegistry';
import { updateBond } from '../../utils/bond/store';
import { planDerivedRemoval, planStoryRetract, storyDerivatives } from '../../utils/bond/derivation';

type Updater = (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;

/** 從某個角色所有聯繫人的話題盒拿掉（或留著但拆掉 storyId）這幾條 */
function patchTopics(updateCharacter: Updater, refs: Array<{ charId: string; topicId: string }>, mode: 'remove' | 'detach') {
    const byChar = new Map<string, Set<string>>();
    refs.forEach(r => { if (!byChar.has(r.charId)) byChar.set(r.charId, new Set()); byChar.get(r.charId)!.add(r.topicId); });
    for (const [charId, ids] of byChar) {
        updateCharacter(charId, cur => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                contacts: (cur.phoneState?.contacts || []).map(c => (!c.topicBox?.some(t => ids.has(t.id)) ? c : {
                    ...c,
                    topicBox: mode === 'remove'
                        ? c.topicBox!.filter(t => !ids.has(t.id))
                        : c.topicBox!.map(t => (ids.has(t.id) ? (({ storyId: _drop, ...rest }) => rest)(t) : t)),
                })),
            },
        }));
    }
}

/** 刪記憶宮殿節點（關聯、向量、遠端向量、節點）；失敗只記日誌 */
async function deletePalaceNodes(refs: Array<{ charId: string; nodeId: string }>, remote?: RemoteVectorConfig): Promise<void> {
    if (!refs.length) return;
    try {
        const { MemoryLinkDB, MemoryNodeDB, MemoryVectorDB, removeMemoryFromBox } = await import('../../utils/memoryPalace');
        for (const { nodeId } of refs) {
            try { await removeMemoryFromBox(nodeId); } catch { /* 不在盒子裡 */ }
            for (const link of await MemoryLinkDB.getByNodeId(nodeId)) await MemoryLinkDB.delete(link.id);
            await MemoryVectorDB.delete(nodeId);
            if (remote?.enabled && remote.initialized) {
                void import('../../utils/memoryPalace/supabaseVector').then(m => m.deleteVector(remote, nodeId)).catch(() => undefined);
            }
            await MemoryNodeDB.delete(nodeId);
        }
    } catch (e) {
        console.warn('[他們的故事] 記憶宮殿節點沒刪成', e);
    }
}

const dropProposals = (bondId: string, storyId: string) =>
    updateBond(bondId, b => ({ ...b, syncPending: (b.syncPending || []).filter(p => p.evidence.storyId !== storyId) }));

/** 刪一章：一起刪（卡、話題盒、記憶宮殿）或留著（拆關聯，記憶留著當一般的私下記憶） */
export async function retractStory(args: {
    space: ResolvedSpace; story: BondEntry; mode: 'cascade' | 'detach'; updateCharacter: Updater; remoteVectorConfig?: RemoteVectorConfig;
}): Promise<void> {
    const { space, story, mode } = args;
    const entries = bondEntriesOf(space.id);
    const d = storyDerivatives(entries, story);
    const plan = planStoryRetract(entries, story, mode);
    if (plan.updates.length) await saveBondEntries(plan.updates);
    await deleteBondEntries(plan.deleteIds);
    patchTopics(args.updateCharacter, d.topics, mode === 'cascade' ? 'remove' : 'detach');
    if (mode === 'cascade') await deletePalaceNodes(d.palace, args.remoteVectorConfig);
    await dropProposals(space.id, story.id);
}

/**
 * 重新整理回寫前：刪掉你勾的卡（連同建在上面的），要的話連兩人的記憶一起撤；這一章記成還沒整理，
 * 之後照新內文再抽一次清單。
 */
export async function clearForRewrite(args: {
    space: ResolvedSpace; story: BondEntry; entryIds: string[]; memories: boolean; updateCharacter: Updater; remoteVectorConfig?: RemoteVectorConfig;
}): Promise<void> {
    const { space, story } = args;
    const entries = bondEntriesOf(space.id);
    const plan = planDerivedRemoval(entries, story, args.entryIds);
    if (plan.updates.length) await saveBondEntries(plan.updates);
    if (plan.deleteIds.length) await deleteBondEntries(plan.deleteIds);
    const d = storyDerivatives(entries, story);
    if (args.memories) {
        patchTopics(args.updateCharacter, d.topics, 'remove');
        await deletePalaceNodes(d.palace, args.remoteVectorConfig);
    }
    await dropProposals(space.id, story.id);
    const cur = bondEntryById(story.id) || story;
    const { extractedAt: _x, derived, ...rest } = cur.story!;
    await saveBondEntry({ ...cur, updatedAt: Date.now(), story: { ...rest, ...(args.memories || !derived ? {} : { derived }) } });
}
