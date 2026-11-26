/**
 * 角色隨筆（plans/bond-batch2.md 第 5 節）：角色就拾光裡的一件事寫「我怎麼理解這件事」。
 * 三種寫法：指定一件事、讓 TA 自己挑一件、就一篇舊隨筆寫後記。純邏輯（提示詞、解析、卡片形狀）有測試；
 * 生成本身（generateEssay）照「此刻的我們」那條路：角色的系統設定＋羈絆段，最後補路線鎖。
 *
 * - 隨筆是感想，不是事實：推測寫成推測，不新增沒發生過的事（紀要 4.2）。
 * - 生成完是草稿（status 'draft'），收下才進提示詞（只有作者自己的、已收下的隨筆進提示詞，見 prompt.ts）。
 * - 只讀這段關係自己的東西：那件事、它的原文快照、之後同一條線發生的事。
 */
import type { APIConfig, BondEntry, BondLink, CharacterProfile, UserProfile } from '../../types';
import type { BondRecord } from '../../types';
import { ContextBuilder } from '../context';
import { resolveCharacterChatApi } from '../characterApi';
import { extractContent, safeFetchJson } from '../safeApi';
import { bondFinalLock, bondPromptBlock } from './prompt';
import { bondEntriesOf } from './entryRegistry';
import { formatEventDate } from './eventDate';
import { newBondEntryId } from './entries';
import type { TimelineItem } from './timeline';

export type EssayMode = 'event' | 'choose' | 'afterword';

/** 給模型看的「那件事」 */
export interface EssayTarget {
    /** 片刻／記憶／他們私下聊的整理 */
    label: string;
    dateText: string;
    title?: string;
    text: string;
    /** 片刻上你補的那句（角色之間的空間不帶，那是旁觀者的話） */
    note?: string;
    /** 收存時的原文快照 */
    snippet?: string;
}

const clip = (s: string, n: number) => {
    const t = String(s || '').replace(/\s+\n/g, '\n').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 時間線上一件事 → 給模型看的樣子 */
export function essayTargetOf(item: TimelineItem, opts: { includeUserNote: boolean; topicOwnerName?: string }): EssayTarget {
    const dateText = formatEventDate(item.eventDate);
    if (item.ref.type === 'entry') {
        const e = item.ref.entry;
        const snippet = e.sources.flatMap(s => ('snippet' in s && s.snippet ? [s.snippet] : [])).join('\n');
        return {
            label: '片刻（你們收存下來、實際發生過的事）', dateText,
            title: e.title?.trim() || undefined, text: e.text,
            note: opts.includeUserNote ? e.note?.trim() || undefined : undefined,
            snippet: snippet ? clip(snippet, 1200) : undefined,
        };
    }
    if (item.ref.type === 'topic') {
        return { label: `私下聊天的整理${opts.topicOwnerName ? `（${opts.topicOwnerName}整理的）` : ''}`, dateText, text: item.text };
    }
    const mood = item.ref.memory.mood ? `（那天的心情：${item.ref.memory.mood}）` : '';
    return { label: '記憶（那天的總結）', dateText, text: `${item.text}${mood}` };
}

/** 寫隨筆的人看得到的時間線：角色之間的空間，對方整理的話題盒不算（那是對方的筆記） */
export function visibleToWriter(items: TimelineItem[], writerId: string): TimelineItem[] {
    return items.filter(it => it.ref.type !== 'topic' || it.ref.ownerId === writerId);
}

/** 這件事之後到現在發生過什麼（同一條線的記憶），舊到新，最多 limit 則 */
export function afterLines(items: TimelineItem[], target: Pick<TimelineItem, 'key' | 'sortKey'>, limit = 10): string {
    if (!target.sortKey) return '';
    const later = items
        .filter(it => it.key !== target.key && !it.hidden && it.kind === 'memory' && it.sortKey > target.sortKey)
        .sort((a, b) => (a.sortKey === b.sortKey ? a.tieBreak - b.tieBreak : a.sortKey < b.sortKey ? -1 : 1));
    return later.slice(-limit).map(it => `- ${formatEventDate(it.eventDate)}：${clip(it.text.replace(/\s+/g, ' '), 200)}`).join('\n');
}

/** 「讓 TA 挑」的候選：沒收起、這位作者還沒寫過的片刻和記憶，新的在前 */
export function essayCandidates(items: TimelineItem[], writerId: string, limit = 12): TimelineItem[] {
    return items
        .filter(it => !it.hidden && it.kind !== 'essay' && !it.essays.some(e => e.author === writerId))
        .slice(0, limit);
}

function targetBlock(t: EssayTarget): string {
    return [
        `類型：${t.label}`,
        `日期：${t.dateText}`,
        t.title ? `標題：${t.title}` : '',
        `內容：${t.text}`,
        t.note ? `對方想留著它的原因：${t.note}` : '',
        t.snippet ? `當時的原文：\n${t.snippet}` : '',
    ].filter(Boolean).join('\n');
}

const RULES = (selfName: string, otherName: string) => `寫法：
- 第一人稱，以${selfName}的身份寫「我怎麼理解這件事」——當時的感受、現在回頭看的想法、沒說出口的在意都可以。
- 這是感想，不是紀錄：推測要寫成推測（例如「我猜${otherName}那天有點失望」），不能把感想寫成事實；不要新增沒發生過的情節、對話或細節。
- 長度、語氣照你的個性來（話少就短，嘴硬就嘴硬），不用湊字數，也不用寫成漂亮的作文。
- 這篇${otherName}看得到。`;

const OUTPUT = `只輸出 JSON，不要其他文字：{"title":"幾個字的標題，可以留空","text":"隨筆正文"}`;

export function buildEssayPrompt(input: {
    selfName: string;
    otherName: string;
    target: EssayTarget;
    after?: string;
    /** 你之前就這件事寫過的（已收下的），避免重複 */
    earlier?: Array<{ dateText: string; text: string }>;
    /** 你想請 TA 寫的方向 */
    hint?: string;
}): string {
    const { selfName, otherName, target, after, earlier, hint } = input;
    return `請你以「${selfName}」的身份，就你和${otherName}之間的一件事寫一篇隨筆。

【那件事】
${targetBlock(target)}
${after ? `\n【這件事之後到現在發生的事】\n${after}\n` : ''}${earlier?.length ? `\n【你之前就這件事寫過的】\n${earlier.map(e => `（${e.dateText}）${clip(e.text, 400)}`).join('\n')}\n（這次換個角度，不要重複）\n` : ''}${hint?.trim() ? `\n【${otherName}想請你寫的方向】\n${hint.trim()}\n` : ''}
${RULES(selfName, otherName)}

${OUTPUT}`;
}

export function buildEssayChoosePrompt(input: {
    selfName: string;
    otherName: string;
    candidates: Array<{ dateText: string; label: string; text: string }>;
    hint?: string;
}): string {
    const { selfName, otherName, candidates, hint } = input;
    const list = candidates.map((c, i) => `#${i + 1}（${c.dateText}・${c.label}）${clip(c.text.replace(/\s+/g, ' '), 160)}`).join('\n');
    return `請你以「${selfName}」的身份，從下面你和${otherName}之間的事裡，挑一件你現在最想寫點什麼的，寫一篇隨筆。

【可以挑的事】
${list}
${hint?.trim() ? `\n【${otherName}想請你寫的方向】\n${hint.trim()}\n` : ''}
${RULES(selfName, otherName)}

只輸出 JSON，不要其他文字：{"pick":挑的編號,"title":"幾個字的標題，可以留空","text":"隨筆正文"}`;
}

export function buildAfterwordPrompt(input: {
    selfName: string;
    otherName: string;
    target?: EssayTarget;
    /** 原隨筆和之前的後記，舊到新 */
    previous: Array<{ dateText: string; text: string }>;
    after?: string;
    hint?: string;
}): string {
    const { selfName, otherName, target, previous, after, hint } = input;
    return `你以前就你和${otherName}之間的一件事寫過隨筆。現在回頭看，請以「${selfName}」的身份寫一段後記：原文不改，寫你現在的想法——可以補充、修正當時的理解，也可以說看法沒變、但多懂了什麼。

${target ? `【那件事】\n${targetBlock(target)}\n\n` : ''}【你之前寫的】
${previous.map(p => `（寫於 ${p.dateText}）${clip(p.text, 900)}`).join('\n\n')}
${after ? `\n【之後到現在發生的事】\n${after}\n` : ''}${hint?.trim() ? `\n【${otherName}想請你寫的方向】\n${hint.trim()}\n` : ''}
${RULES(selfName, otherName)}

${OUTPUT}`;
}

export interface ParsedEssay {
    title?: string;
    text: string;
    /** choose 模式：挑的編號（從 1 起） */
    pick?: number;
}

/** 解析回覆：先找 JSON；找不到就把整段當正文（choose 模式沒有編號就算失敗） */
export function parseEssay(raw: string, mode: EssayMode): ParsedEssay | null {
    const s = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const obj = JSON.parse(s.slice(start, end + 1));
            const text = typeof obj.text === 'string' ? obj.text.trim() : '';
            if (text) {
                const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 30) : undefined;
                const pick = Number(obj.pick);
                if (mode === 'choose' && !(Number.isInteger(pick) && pick > 0)) return null;
                return { text, title, ...(mode === 'choose' ? { pick } : {}) };
            }
        } catch { /* 往下當純文字 */ }
    }
    if (mode === 'choose') return null;
    const text = s.replace(/^["「『]|["」』]$/g, '').trim();
    return text ? { text } : null;
}

/** 隨筆指向的那件事（時間線上那一列）→ links */
export function linkForItem(item: TimelineItem): BondLink[] {
    if (item.ref.type === 'entry') return [{ type: 'entry', id: item.ref.entry.id }];
    if (item.ref.type === 'memory') return [{ type: 'memory', charId: item.ref.charId, memoryId: item.ref.memory.id }];
    return [{ type: 'memory', charId: item.ref.ownerId, memoryId: item.ref.topic.id }];
}

/** 新的隨筆草稿 */
export function essayDraft(input: { bondId: string; writerId: string; item?: TimelineItem; afterwordOf?: BondEntry; parsed: ParsedEssay; now?: number }): BondEntry {
    const now = input.now ?? Date.now();
    const base = input.afterwordOf;
    return {
        id: newBondEntryId(),
        bondId: input.bondId,
        kind: 'essay',
        author: input.writerId,
        title: input.parsed.title,
        text: input.parsed.text,
        eventDate: base ? base.eventDate : input.item ? input.item.eventDate : { precision: 'unknown' },
        writtenAt: now,
        sources: [],
        links: base ? [] : input.item ? linkForItem(input.item) : [],
        ...(base ? { afterwordOf: base.id } : {}),
        status: 'draft',
        createdBy: 'ai',
        updatedAt: now,
    };
}

/** 重寫草稿：換掉內容，不留原文（還沒收下，不算編修） */
export function rewriteDraft(draft: BondEntry, parsed: ParsedEssay, now = Date.now()): BondEntry {
    return { ...draft, title: parsed.title, text: parsed.text, writtenAt: now, updatedAt: now, originalText: undefined, revisedAt: undefined };
}

/** 你編修一篇隨筆：第一次改的時候把原文留在 originalText */
export function reviseEssay(entry: BondEntry, next: { title?: string; text: string }, now = Date.now()): BondEntry {
    const changed = next.text !== entry.text || (next.title || undefined) !== (entry.title || undefined);
    if (!changed) return entry;
    return {
        ...entry,
        title: next.title || undefined,
        text: next.text,
        originalText: entry.originalText ?? entry.text,
        revisedAt: now,
        updatedAt: now,
    };
}

/** 一篇隨筆和它所有的後記，舊到新（後記可以接在後記後面） */
export function essayThread(entries: BondEntry[], rootId: string): BondEntry[] {
    const byParent = new Map<string, BondEntry[]>();
    for (const e of entries) {
        if (e.kind !== 'essay' || !e.afterwordOf) continue;
        const list = byParent.get(e.afterwordOf);
        if (list) list.push(e); else byParent.set(e.afterwordOf, [e]);
    }
    const root = entries.find(e => e.id === rootId);
    if (!root) return [];
    const out: BondEntry[] = [root];
    const queue = [root.id];
    const seen = new Set(queue);
    while (queue.length) {
        const id = queue.shift()!;
        for (const child of (byParent.get(id) || []).sort((a, b) => a.writtenAt - b.writtenAt)) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            out.push(child);
            queue.push(child.id);
        }
    }
    return [out[0], ...out.slice(1).sort((a, b) => a.writtenAt - b.writtenAt)];
}

/** 一篇隨筆最上面那篇（後記一路往上找） */
export function essayRoot(entries: BondEntry[], id: string): BondEntry | undefined {
    const byId = new Map(entries.map(e => [e.id, e]));
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur?.afterwordOf && byId.has(cur.afterwordOf) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.afterwordOf);
    }
    return cur;
}

/** 叫模型寫：系統是角色設定（＋羈絆段），最後補路線鎖；回傳原始文字 */
export async function requestEssay(input: {
    writer: CharacterProfile;
    /** 身份卡 × 角色：這條線上的你；角色之間：對方 */
    user?: UserProfile;
    pairOther?: Pick<CharacterProfile, 'id' | 'name'>;
    bond: BondRecord;
    apiConfig: APIConfig;
    prompt: string;
    signal?: AbortSignal;
}): Promise<string> {
    const { writer, user, pairOther, bond, apiConfig, prompt } = input;
    const api = resolveCharacterChatApi(writer, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('還沒設定 API');
    const otherName = pairOther ? pairOther.name : user?.name || '';
    const system = pairOther
        ? `${ContextBuilder.buildRoleSettingsContext(writer)}\n${bondPromptBlock({ bond, selfName: writer.name, otherName, selfIsCharId: bond.charId === writer.id, entries: bondEntriesOf(bond.id), selfId: writer.id, includeUserNotes: false })}`
        : ContextBuilder.buildCoreContext(writer, user!, true);
    const lock = bondFinalLock(bond, otherName);
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: lock ? `${prompt}\n\n${lock}` : prompt },
            ],
            temperature: 0.85,
            max_tokens: 2000,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
    }, 1, 120_000, { appName: '羈絆', charId: writer.id, charName: writer.name, purpose: '角色隨筆' });
    return extractContent(data);
}
