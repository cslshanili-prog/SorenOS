/**
 * 一段關係的拾光時間線（plans/bond-batch2.md 第 4 節）：記憶骨幹＋卡，跟著登記表即時更新。
 * 身份卡 × 角色的記憶有宮殿關聯的，讀宮殿最新正文（跟神經鏈接同一份）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { BondEntry, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { bondEntriesOf, onBondEntryRegistryChange } from '../../utils/bond/entryRegistry';
import { bondOrBlank } from '../../utils/bond/store';
import { onBondRegistryChange } from '../../utils/bond/registry';
import { buildTimeline, contactFor, memoriesForLine, type TimelineItem } from '../../utils/bond/timeline';
import { useLinkedArchives } from '../../utils/memoryPalace/linkedArchive';

export function useBondEntries(bondId: string): BondEntry[] {
    const [entries, setEntries] = useState<BondEntry[]>(() => bondEntriesOf(bondId));
    useEffect(() => {
        setEntries(bondEntriesOf(bondId));
        return onBondEntryRegistryChange(() => setEntries(bondEntriesOf(bondId)));
    }, [bondId]);
    return entries;
}

export function useSpaceTimeline(space: ResolvedSpace, characters: CharacterProfile[]): {
    items: TimelineItem[];
    entries: BondEntry[];
    /** persona：那位角色最新的卡（記憶從這裡讀） */
    char?: CharacterProfile;
} {
    const entries = useBondEntries(space.id);
    const [bondVersion, setBondVersion] = useState(0);
    useEffect(() => onBondRegistryChange(() => setBondVersion(v => v + 1)), []);
    const bond = useMemo(() => bondOrBlank(space.id),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [space.id, bondVersion]);

    const char = characters.find(c => c.id === space.char.id) || space.char;
    const other = space.other ? (characters.find(c => c.id === space.other!.id) || space.other) : undefined;
    const lineMemories = useMemo(() => (space.kind === 'persona' ? memoriesForLine(char.memories, space.personaKey, char.primaryPersonaKey) : []),
        [space.kind, char.memories, space.personaKey, char.primaryPersonaKey]);
    const resolved = useLinkedArchives(char.id, lineMemories, !!char.memoryPalaceEnabled);

    const items = useMemo(() => {
        if (space.kind === 'pair' && other) {
            return buildTimeline({
                bond, entries,
                topics: [
                    { ownerId: char.id, partnerId: other.id, list: contactFor(char, other)?.topicBox || [] },
                    { ownerId: other.id, partnerId: char.id, list: contactFor(other, char)?.topicBox || [] },
                ],
            });
        }
        return buildTimeline({ bond, entries, memories: { charId: char.id, list: resolved } });
    }, [space.kind, bond, entries, char, other, resolved]);

    return { items, entries, char: space.kind === 'persona' ? char : undefined };
}
