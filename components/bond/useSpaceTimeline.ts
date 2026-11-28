/**
 * 一段關係的拾光時間線（plans/bond-batch2.md 第 4 節、plans/bond-moments-v2.md）：片段、片刻、里程碑，跟著登記表即時更新。
 */
import { useEffect, useMemo, useState } from 'react';
import type { BondEntry, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { bondEntriesOf, onBondEntryRegistryChange } from '../../utils/bond/entryRegistry';
import { bondOrBlank } from '../../utils/bond/store';
import { onBondRegistryChange } from '../../utils/bond/registry';
import { buildTimeline, type TimelineItem } from '../../utils/bond/timeline';

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
    // 拾光不再讀記憶（plans/bond-moments-v2.md）：片段、片刻、里程碑都在卡上
    const items = useMemo(() => buildTimeline({ bond, entries }), [bond, entries]);

    return { items, entries, char: space.kind === 'persona' ? char : undefined };
}
