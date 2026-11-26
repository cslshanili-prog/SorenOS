/**
 * 角色隨筆的生成（plans/bond-batch2.md 5.1）：把這段關係的時間線、那件事、之後發生的事組好，叫角色寫。
 * 新寫、讓 TA 挑、後記、重寫草稿都走這裡；寫出來怎麼存由頁面決定（草稿，收下才進提示詞）。
 */
import type { APIConfig, BondEntry, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { storyDateKeyMaker } from './BondCollectPage';
import {
    afterLines, buildAfterwordPrompt, buildEssayChoosePrompt, buildEssayPrompt, essayCandidates, essayRoot, essayTargetOf,
    essayThread, parseEssay, requestEssay, visibleToWriter, type EssayMode, type ParsedEssay,
} from '../../utils/bond/essay';
import { essayTargetKey, type TimelineItem } from '../../utils/bond/timeline';
import { formatEventDate } from '../../utils/bond/eventDate';

/** 寫隨筆的人：身份卡 × 角色是那位角色（照這條線看到的卡）；角色之間是左右其中一位 */
export function essayWriterOf(space: ResolvedSpace, writerId: string): CharacterProfile {
    if (space.kind === 'pair') return writerId === space.other?.id ? space.other : space.char;
    return space.view || space.char;
}

/** 隨筆的對象叫什麼 */
export function essayOtherName(space: ResolvedSpace, writerId: string): string {
    if (space.kind === 'pair') return writerId === space.char.id ? space.rightName : space.leftName;
    return space.leftName;
}

/** 寫下時間 → 這段關係的故事日期 */
export function writtenDayText(space: ResolvedSpace, ts: number): string {
    return formatEventDate({ precision: 'day', date: storyDateKeyMaker(space, space.kind === 'pair' ? 'pair' : 'chat')(ts) });
}

export interface EssayRunInput {
    space: ResolvedSpace;
    characters: CharacterProfile[];
    items: TimelineItem[];
    entries: BondEntry[];
    apiConfig: APIConfig;
    writerId: string;
    mode: EssayMode;
    /** event：寫哪件事 */
    item?: TimelineItem;
    /** afterword：接在哪篇後面 */
    base?: BondEntry;
    hint?: string;
    signal?: AbortSignal;
}

export async function runEssay(input: EssayRunInput): Promise<{ parsed: ParsedEssay; item?: TimelineItem }> {
    const { space, characters, entries, apiConfig, writerId, mode, hint } = input;
    const writer = essayWriterOf(space, writerId);
    const otherName = essayOtherName(space, writerId);
    const isPair = space.kind === 'pair';
    const items = isPair ? visibleToWriter(input.items, writerId) : input.items;
    const nameOf = (id: string) => characters.find(c => c.id === id)?.name;
    const targetOf = (item: TimelineItem) => essayTargetOf(item, {
        includeUserNote: !isPair,
        topicOwnerName: item.ref.type === 'topic' ? nameOf(item.ref.ownerId) : undefined,
    });
    const pairOther = isPair ? (writerId === space.char.id ? space.other : space.char) : undefined;
    const ask = async (prompt: string) => requestEssay({ writer, user: space.user, pairOther, bond: space.bond, apiConfig, prompt, signal: input.signal });

    if (mode === 'choose') {
        const cands = essayCandidates(items, writerId);
        if (!cands.length) throw new Error('沒有還沒寫過的事可以挑了');
        const raw = await ask(buildEssayChoosePrompt({
            selfName: writer.name, otherName, hint,
            candidates: cands.map(c => { const t = targetOf(c); return { dateText: t.dateText, label: c.kind === 'moment' ? '片刻' : '記憶', text: t.title ? `${t.title}：${t.text}` : t.text }; }),
        }));
        const parsed = parseEssay(raw, 'choose');
        const item = parsed?.pick ? cands[parsed.pick - 1] : undefined;
        if (!parsed || !item) throw new Error('這次沒挑出來，再試一次');
        return { parsed, item };
    }

    if (mode === 'afterword') {
        const base = input.base;
        if (!base) throw new Error('找不到原本那篇');
        const root = essayRoot(entries, base.id) || base;
        const byId = new Map(entries.map(e => [e.id, e]));
        const targetKey = essayTargetKey(root, byId);
        const item = targetKey ? items.find(i => i.key === targetKey) : undefined;
        const thread = essayThread(entries, root.id).filter(e => e.status === 'published' && e.writtenAt <= base.writtenAt);
        const raw = await ask(buildAfterwordPrompt({
            selfName: writer.name, otherName, hint,
            target: item ? targetOf(item) : undefined,
            previous: (thread.length ? thread : [base]).map(e => ({ dateText: writtenDayText(space, e.writtenAt), text: e.text })),
            after: item ? afterLines(items, item) : '',
        }));
        const parsed = parseEssay(raw, 'afterword');
        if (!parsed) throw new Error('這次沒寫出東西，再試一次');
        return { parsed, item };
    }

    const item = input.item;
    if (!item) throw new Error('找不到那件事');
    const raw = await ask(buildEssayPrompt({
        selfName: writer.name, otherName, hint,
        target: targetOf(item),
        after: afterLines(items, item),
        earlier: item.essays.filter(e => e.author === writerId && e.status === 'published' && !e.afterwordOf)
            .map(e => ({ dateText: writtenDayText(space, e.writtenAt), text: e.text })),
    }));
    const parsed = parseEssay(raw, 'event');
    if (!parsed) throw new Error('這次沒寫出東西，再試一次');
    return { parsed, item };
}
