import type { MemoryFragment } from '../../types';
import { DB } from '../db';
import { MemoryNodeDB } from './db';
import type { MemoryNode } from './types';
import {
    buildAutoArchiveFragments,
    getMemoryPalaceHighWaterMark,
    mergePalaceFragmentsIntoMemories,
    processNewMessages,
    type PipelineResult,
} from './pipeline';

/**
 * React 外的記憶後處理完成後，用這個事件把剛落進 IndexedDB 的傳統記憶同步回 OSContext。
 * detail 只帶增量，OSContext 會基於自己那份最新角色狀態再 merge，避免整對象回灌覆蓋其它字段。
 */
export const MEMORY_AUTO_ARCHIVE_SYNC_EVENT = 'memory-auto-archive-synced';

export type AutoArchiveFragment = NonNullable<PipelineResult['autoArchive']>['fragments'][number];

export interface MemoryAutoArchiveSyncDetail {
    charId: string;
    fragments: AutoArchiveFragment[];
    hideBeforeMessageId?: number;
}

const persistChains = new Map<string, Promise<unknown>>();

function enqueuePersist<T>(charId: string, task: () => Promise<T>): Promise<T> {
    const previous = persistChains.get(charId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    persistChains.set(charId, current);
    void current.finally(() => {
        if (persistChains.get(charId) === current) persistChains.delete(charId);
    }).catch(() => undefined);
    return current;
}

function dispatchSync(detail: MemoryAutoArchiveSyncDetail): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<MemoryAutoArchiveSyncDetail>(MEMORY_AUTO_ARCHIVE_SYNC_EVENT, { detail }));
}

function sameMemories(a: MemoryFragment[] | undefined, b: MemoryFragment[]): boolean {
    if (a === b) return true;
    if (!a || a.length !== b.length) return false;
    return a.every((item, index) => (
        item.id === b[index].id
        && item.date === b[index].date
        && item.mood === b[index].mood
        && item.summary === b[index].summary
        && item.palaceMemoryId === b[index].palaceMemoryId
    ));
}

/**
 * 把 processNewMessages 的自動歸檔建議真正寫入角色檔案。
 *
 * 過去這一步散落在 React 調用方：Push、彼方、家園等入口只接了宮殿寫入，忘了接返回值，
 * 於是出現“宮殿有總結、神經鏈接沒副本”。現在所有自動入口統一走本函數。
 */
export function persistAutoArchiveResult(
    charId: string,
    result: PipelineResult | null,
): Promise<{ fragments: number; changed: boolean }> {
    if (!result || result.skipReason === 'lock') {
        return Promise.resolve({ fragments: 0, changed: false });
    }

    return enqueuePersist(charId, async () => {
        const allCharacters = await DB.getAllCharacters();
        const character = allCharacters.find(item => item.id === charId);
        if (!character?.memoryPalaceEnabled || !character.autoArchiveEnabled) {
            return { fragments: 0, changed: false };
        }

        const fragments = result.autoArchive?.fragments || [];
        const currentMemories = character.memories || [];
        const nextMemories = fragments.length > 0
            ? mergePalaceFragmentsIntoMemories(currentMemories, fragments)
            : currentMemories;
        const currentHide = character.hideBeforeMessageId || 0;
        const nextHide = Math.max(
            currentHide,
            result.autoArchive?.hideBeforeMessageId || 0,
            getMemoryPalaceHighWaterMark(charId),
        );
        const memoriesChanged = !sameMemories(currentMemories, nextMemories);
        const hideChanged = nextHide > currentHide;
        if (!memoriesChanged && !hideChanged) {
            return { fragments: 0, changed: false };
        }

        await DB.saveCharacter({
            ...character,
            ...(memoriesChanged ? { memories: nextMemories } : {}),
            ...(hideChanged ? { hideBeforeMessageId: nextHide } : {}),
        });
        dispatchSync({
            charId,
            fragments: memoriesChanged ? fragments : [],
            hideBeforeMessageId: hideChanged ? nextHide : undefined,
        });
        return { fragments: fragments.length, changed: true };
    });
}

/** 自動總結的唯一常規入口：宮殿寫入成功後，緊接著完成神經鏈接雙寫。 */
export async function processNewMessagesWithAutoArchive(
    ...args: Parameters<typeof processNewMessages>
): Promise<PipelineResult | null> {
    const result = await processNewMessages(...args);
    await persistAutoArchiveResult(args[1], result);
    return result;
}

const localDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/**
 * 為舊版本漏寫的數據構造保守回填：
 * - 必須已經有過 palace 傳統記憶，證明該角色原本確實在走雙寫；
 * - 只看聊天提取節點，排除群聊、消化衍生和事件盒總結；
 * - 只補最後一條 palace 記憶之後、且神經鏈接整天完全空白的日期。
 *
 * 這樣可以修復“7 月 21 日後整段斷掉”這類缺口，同時不重複搬運手動導入或舊遷移內容。
 */
export function buildConservativeRepairFragments(
    existing: MemoryFragment[],
    nodes: MemoryNode[],
): AutoArchiveFragment[] {
    const palaceDates = existing
        .filter(memory => memory.mood === 'palace' && /^\d{4}-\d{2}-\d{2}$/.test(memory.date))
        .map(memory => memory.date)
        .sort();
    const lastPalaceDate = palaceDates[palaceDates.length - 1];
    if (!lastPalaceDate) return [];

    const occupiedDates = new Set(existing.map(memory => memory.date));
    const candidates = nodes.filter(node => {
        if (node.origin !== 'extraction' || node.groupId || node.isBoxSummary || node.sourceId) return false;
        if (!node.content?.trim() || !Number.isFinite(node.createdAt)) return false;
        const date = localDate(node.createdAt);
        return date > lastPalaceDate && !occupiedDates.has(date);
    });
    return buildAutoArchiveFragments(candidates, 0)?.fragments || [];
}

/** 啟動時跑一次的舊缺口修復；不調 LLM、不重做向量、不改宮殿水位線。 */
export function repairMissingAutoArchiveMemories(
    charId: string,
): Promise<{ fragments: number; changed: boolean }> {
    return enqueuePersist(charId, async () => {
        const [allCharacters, nodes] = await Promise.all([
            DB.getAllCharacters(),
            MemoryNodeDB.getByCharId(charId),
        ]);
        const character = allCharacters.find(item => item.id === charId);
        if (!character?.memoryPalaceEnabled || !character.autoArchiveEnabled) {
            return { fragments: 0, changed: false };
        }

        const fragments = buildConservativeRepairFragments(character.memories || [], nodes);
        if (fragments.length === 0) return { fragments: 0, changed: false };

        const nextMemories = mergePalaceFragmentsIntoMemories(character.memories || [], fragments);
        await DB.saveCharacter({ ...character, memories: nextMemories });
        dispatchSync({ charId, fragments });
        console.log(`[AutoArchiveRepair] ${character.name}: repaired ${fragments.length} missing day(s)`);
        return { fragments: fragments.length, changed: true };
    });
}
