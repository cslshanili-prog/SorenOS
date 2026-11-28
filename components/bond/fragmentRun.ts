/**
 * 拾光片段的 App 那半（plans/bond-moments-v2.md）：讀這條線的對話、分天、請角色寫、落庫；
 * 一鍵補全是模組層級的工作（離開頁面也繼續、能訂閱進度、能停）；每日總結寫好時自動寫那一天。
 * 純邏輯在 utils/bond/fragment.ts。
 */
import type { APIConfig, BondEntry, BondSource, CharacterProfile, MemoryFragment, Message, UserProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { resolveSpace } from './space';
import { DB } from '../../utils/db';
import { ContextBuilder } from '../../utils/context';
import { resolveCharacterChatApi } from '../../utils/characterApi';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { bondFinalLock } from '../../utils/bond/prompt';
import { requestEssay } from '../../utils/bond/essay';
import { messagePlainText } from '../../utils/bond/collect';
import {
    buildFragmentPrompt, dayWorthWriting, fragmentsOfDay, fragmentTagsFor, fragmentTranscript, groupByDay, newFragmentEntry,
    parseFragmentPick, pendingDays, splitParts,
} from '../../utils/bond/fragment';
import { formatEventDate } from '../../utils/bond/eventDate';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntries } from '../../utils/bond/entries';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { isBondOpen } from '../../utils/bond/openState';
import { bondIdForChar, pairBondId } from '../../utils/bond/model';
import { lineFor, lineKey, lineView, withLineFields } from '../../utils/chatLine';
import { pairSpeakerOf } from '../../utils/pairLine';
import { makeChatClock, makeDateClock } from '../../utils/dateStoryTime';
import { getLocalDateKey } from '../../utils/localDate';
import { nowInTimeZone, resolveCharTimeZone } from '../../utils/timezone';
import { isOnStage } from '../../utils/castRole';
import { trackEvent } from '../../utils/analytics';

// ─── 讀對話、分天 ─────────────────────────────────────────

export interface FragmentPart {
    from: 'chat' | 'date';
    /** 私聊／角色私聊是那條線的 key；見面是那場的 id */
    lineId: string;
    storyId?: string;
    messages: Message[];
    timeOf: (ts: number) => string;
}

export interface FragmentDayUnit {
    dayKey: string;
    parts: FragmentPart[];
    /** 這天總共幾則（給清單顯示） */
    count: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 時間戳 → 故事時鐘的日期 key 與 'HH:MM'（私聊照私聊時鐘、見面照那場的時鐘、角色私聊照真實） */
function clockOf(space: ResolvedSpace, kind: 'chat' | 'date' | 'pair', story?: Parameters<typeof makeDateClock>[1]): { dayOf: (ts: number) => string; timeOf: (ts: number) => string } {
    const at = (ts: number): Date => {
        if (kind === 'pair' || !space.view) return new Date(ts);
        const view = space.view;
        const clock = kind === 'date' ? makeDateClock(view, story) : makeChatClock(view);
        return nowInTimeZone(resolveCharTimeZone(view), new Date(clock && !clock.off ? clock.map(ts) : ts));
    };
    return {
        dayOf: ts => getLocalDateKey(at(ts)),
        timeOf: ts => { const d = at(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; },
    };
}

const said = (m: Message) => m.type !== 'system' && !!messagePlainText(m).trim();

/** 這段關係所有值得寫的日子（舊到新），每天可能有私聊和好幾場見面 */
export async function listFragmentDays(space: ResolvedSpace): Promise<FragmentDayUnit[]> {
    const byDay = new Map<string, FragmentPart[]>();
    const add = (dayKey: string, part: FragmentPart) => {
        const list = byDay.get(dayKey);
        if (list) list.push(part); else byDay.set(dayKey, [part]);
    };
    if (space.kind === 'pair') {
        const msgs = (await DB.getMessagesByCharId(space.id, true)).filter(said);
        const { dayOf, timeOf } = clockOf(space, 'pair');
        for (const d of groupByDay(msgs, dayOf)) {
            if (dayWorthWriting(d.messages, true)) add(d.dayKey, { from: 'chat', lineId: space.id, messages: d.messages, timeOf });
        }
    } else {
        const line = lineFor(space.char, space.personaKey);
        const lineId = lineKey(line);
        const all = (await DB.getMessagesByCharId(line, true)).filter(said);
        const chat = all.filter(m => !m.metadata?.dateStoryId);
        const chatClock = clockOf(space, 'chat');
        for (const d of groupByDay(chat, chatClock.dayOf)) {
            if (dayWorthWriting(d.messages)) add(d.dayKey, { from: 'chat', lineId, messages: d.messages, timeOf: chatClock.timeOf });
        }
        const storyIds = [...new Set(all.map(m => m.metadata?.dateStoryId).filter((x): x is string => typeof x === 'string' && !!x))];
        for (const storyId of storyIds) {
            const story = await DB.getDateStory(storyId).catch(() => undefined);
            const c = clockOf(space, 'date', story);
            for (const d of groupByDay(all.filter(m => m.metadata?.dateStoryId === storyId), c.dayOf)) {
                if (dayWorthWriting(d.messages)) add(d.dayKey, { from: 'date', lineId, storyId, messages: d.messages, timeOf: c.timeOf });
            }
        }
    }
    return [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([dayKey, parts]) => ({ dayKey, parts, count: parts.reduce((s, p) => s + p.messages.length, 0) }));
}

// ─── 寫一天 ─────────────────────────────────────────

/** 一段最多挑幾則：聊得越多可以多挑一點 */
const maxFor = (n: number) => Math.max(1, Math.min(4, Math.ceil(n / 25)));

async function askPair(space: ResolvedSpace, prompt: string, apiConfig: APIConfig, signal?: AbortSignal): Promise<string> {
    const a = space.char; const b = space.other!;
    const api = resolveCharacterChatApi(a, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('還沒設定 API');
    const system = `${ContextBuilder.buildRoleSettingsContext(a, { skipMemories: true })}\n\n${ContextBuilder.buildRoleSettingsContext(b, { skipMemories: true })}`;
    const lock = bondFinalLock(space.bond, b.name);
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: lock ? `${prompt}\n\n${lock}` : prompt }],
            temperature: 0.8,
            max_tokens: 1500,
        }),
        ...(signal ? { signal } : {}),
    }, 1, 120_000, { appName: '羈絆', charId: a.id, charName: a.name, purpose: '拾光片段' });
    return extractContent(data);
}

export interface WriteDayOptions {
    apiConfig: APIConfig;
    /** 重寫：先刪掉這天 AI 寫的 */
    replace?: boolean;
    signal?: AbortSignal;
    how: '某一天' | '补全' | '自动';
}

/** 寫一天的片段，回傳新寫的卡 */
export async function writeFragmentDay(space: ResolvedSpace, day: FragmentDayUnit, opts: WriteDayOptions): Promise<BondEntry[]> {
    const isPair = space.kind === 'pair';
    const tags = fragmentTagsFor(space.bond.route);
    const dayLabel = formatEventDate({ precision: 'day', date: day.dayKey });
    const nameOf = (m: Pick<Message, 'role' | 'charId' | 'metadata'>): string => {
        if (isPair) { const id = pairSpeakerOf(m); return id === space.other?.id ? space.other!.name : id === space.char.id ? space.char.name : '某人'; }
        return m.role === 'user' ? space.leftName : m.role === 'assistant' ? space.rightName : '旁白';
    };
    if (opts.replace) {
        const old = fragmentsOfDay(bondEntriesOf(space.id), day.dayKey);
        if (old.length) await deleteBondEntries(old.map(e => e.id));
    }
    const written: BondEntry[] = [];
    for (const part of day.parts) {
        for (const chunk of splitParts(part.messages)) {
            if (opts.signal?.aborted) throw new DOMException('stopped', 'AbortError');
            const prompt = buildFragmentPrompt({
                selfName: isPair ? space.char.name : space.rightName,
                otherName: isPair ? space.other!.name : space.leftName,
                pair: isPair, dayLabel, from: part.from, tags, route: space.bond.route, max: maxFor(chunk.length),
                transcript: fragmentTranscript(chunk, nameOf, part.timeOf),
                already: written.map(e => e.text),
            });
            const raw = isPair
                ? await askPair(space, prompt, opts.apiConfig, opts.signal)
                : await requestEssay({ writer: space.view!, user: space.user, bond: space.bond, apiConfig: opts.apiConfig, prompt, signal: opts.signal });
            const picks = parseFragmentPick(raw, chunk, tags, maxFor(chunk.length));
            const now = Date.now();
            const cards = picks.map(p => {
                const msg = p.msg;
                const speaker = isPair ? (pairSpeakerOf(msg) || space.char.id) : msg.role === 'user' ? 'user' : space.char.id;
                const voice = isPair
                    ? (p.who === space.other!.name ? space.other!.id : p.who === space.char.name ? space.char.id : speaker === 'user' ? space.char.id : speaker)
                    : space.char.id;
                const snippet = messagePlainText(msg).slice(0, 300);
                const source: BondSource = part.from === 'date' && part.storyId
                    ? { type: 'date', storyId: part.storyId, charId: space.char.id, messageIds: [msg.id], snippet, at: msg.timestamp }
                    : { type: 'message', lineId: part.lineId, messageIds: [msg.id], snippet, at: msg.timestamp };
                return newFragmentEntry({
                    bondId: space.id, dayKey: day.dayKey, tag: p.tag, note: p.note,
                    quote: { who: speaker, text: p.quote, messageId: msg.id },
                    voice, time: part.timeOf(msg.timestamp), at: msg.timestamp, from: part.from, source, now,
                });
            });
            if (cards.length) written.push(...(await saveBondEntries(cards)));
        }
    }
    await updateBond(space.id, b => ({ ...b, fragmentDays: { ...(b.fragmentDays || {}), [day.dayKey]: Date.now() } }));
    trackEvent('拾光片段', { 方式: opts.how, 类型: isPair ? '角色之间' : '我和角色', 结果: written.length ? '有' : '无' });
    return written;
}

// ─── 一鍵補全（模組層級的工作） ─────────────────────────────────────────

export interface BackfillState {
    spaceId: string;
    running: boolean;
    total: number;
    done: number;
    written: number;
    /** 現在在寫哪一天 */
    current?: string;
    error?: string;
    stopped?: boolean;
    finishedAt?: number;
}

const jobs = new Map<string, BackfillState>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

export const backfillState = (spaceId: string): BackfillState | undefined => jobs.get(spaceId);
export function onBackfillChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** 從最早還沒寫的那天開始一天一天寫；寫過的天跳過。中途出錯就停在那裡（寫好的留著） */
export async function startBackfill(space: ResolvedSpace, apiConfig: APIConfig): Promise<void> {
    if (jobs.get(space.id)?.running) return;
    const ctrl = new AbortController();
    controllers.set(space.id, ctrl);
    const state: BackfillState = { spaceId: space.id, running: true, total: 0, done: 0, written: 0 };
    jobs.set(space.id, state);
    emit();
    try {
        const days = await listFragmentDays(space);
        const todo = pendingDays(days.map(d => d.dayKey), bondOrBlank(space.id).fragmentDays);
        state.total = todo.length;
        emit();
        const byKey = new Map(days.map(d => [d.dayKey, d]));
        for (const key of todo) {
            if (ctrl.signal.aborted) { state.stopped = true; break; }
            state.current = key;
            emit();
            // 每天重新解析空間：路線、階段在補的途中可能被改
            const cur = { ...space, bond: bondOrBlank(space.id) };
            const cards = await writeFragmentDay(cur, byKey.get(key)!, { apiConfig, signal: ctrl.signal, how: '补全' });
            state.done += 1;
            state.written += cards.length;
            emit();
        }
    } catch (e: any) {
        if (e?.name === 'AbortError' && ctrl.signal.aborted) state.stopped = true;
        else state.error = e?.message || '寫到一半出錯了';
    } finally {
        state.running = false;
        state.current = undefined;
        state.finishedAt = Date.now();
        controllers.delete(space.id);
        emit();
    }
}

export function stopBackfill(spaceId: string): void {
    controllers.get(spaceId)?.abort();
}

// ─── 清空、刪除 ─────────────────────────────────────────

/** 清空 AI 寫的片段，寫過的天一起清掉（之後可以重新補全）；你寫的片刻、里程碑不動 */
export async function clearAiFragments(spaceId: string, ids: string[]): Promise<void> {
    if (ids.length) await deleteBondEntries(ids);
    await updateBond(spaceId, b => ({ ...b, fragmentDays: {} }));
    trackEvent('拾光片段', { 方式: '清空', 类型: spaceId.startsWith('pair~') ? '角色之间' : '我和角色', 结果: ids.length ? '有' : '无' });
}

// ─── 每日總結寫好時自動寫那一天 ─────────────────────────────────────────

const autoRunning = new Set<string>();

/** OSContext 的每日總結 hook 叫：那條線的空間開著、角色在戲上、那天還沒寫過，就寫 */
export async function autoFragmentsAfterSummary(input: {
    char: CharacterProfile;
    memory: MemoryFragment;
    characters: CharacterProfile[];
    profileBase: UserProfile;
    apiConfig: APIConfig;
}): Promise<number> {
    const { char, memory, characters, profileBase, apiConfig } = input;
    if (char.altOf || !isOnStage(char)) return 0;
    const personaKey = memory.personaKey || char.primaryPersonaKey;
    const view = lineView(withLineFields(profileBase, char), lineFor(char, personaKey));
    const id = bondIdForChar(view);
    if (!isBondOpen(bondOrBlank(id)) || autoRunning.has(id)) return 0;
    const chars = characters.filter(c => !c.altOf).map(c => withLineFields(profileBase, c));
    const space = resolveSpace(id, chars, profileBase, () => true);
    if (!space) return 0;
    autoRunning.add(id);
    try {
        const days = await listFragmentDays(space);
        const done = bondOrBlank(id).fragmentDays || {};
        // 總結那天，加上那天之前幾天還沒寫的（總結有時晚一兩天才跑）
        const memDay = String(memory.date || '').slice(0, 10);
        const recent = days.filter(d => !done[d.dayKey] && d.dayKey <= (memDay || '9999')).slice(-3);
        let n = 0;
        for (const d of recent) n += (await writeFragmentDay({ ...space, bond: bondOrBlank(id) }, d, { apiConfig, how: '自动' })).length;
        return n;
    } finally {
        autoRunning.delete(id);
    }
}

/**
 * 角色之間：他們私下聊完一輪就叫（utils/pairChatRun.ts 的 archivePairIfNeeded 開頭）。
 * 只寫「今天以前」還沒寫的日子（今天還在聊，等過了再寫），最多補最近 3 天；空間沒開、有人下戲就不寫。
 */
export async function autoFragmentsForPair(input: { a: CharacterProfile; b: CharacterProfile; apiConfig: APIConfig }): Promise<number> {
    const { a, b, apiConfig } = input;
    if (a.altOf || b.altOf || !isOnStage(a) || !isOnStage(b)) return 0;
    const id = pairBondId(a.id, b.id);
    if (!isBondOpen(bondOrBlank(id)) || autoRunning.has(id)) return 0;
    const space = resolveSpace(id, [a, b], {} as UserProfile, () => true);
    if (!space) return 0;
    const done = bondOrBlank(id).fragmentDays || {};
    autoRunning.add(id);
    try {
        const days = await listFragmentDays(space);
        const recent = days.filter(d => !done[d.dayKey] && d.dayKey < space.todayKey).slice(-3);
        let n = 0;
        for (const d of recent) n += (await writeFragmentDay({ ...space, bond: bondOrBlank(id) }, d, { apiConfig, how: '自动' })).length;
        return n;
    } finally {
        autoRunning.delete(id);
    }
}
