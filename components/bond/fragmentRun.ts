/**
 * 拾光片段的 App 那半（plans/bond-moments-v2.md）：讀這條線的對話、分天、請角色寫、落庫；
 * 一鍵補全是模組層級的工作（離開頁面也繼續、能訂閱進度、能停）；每日總結寫好時自動寫那一天。
 * 純邏輯在 utils/bond/fragment.ts。
 */
import type { APIConfig, BondEntry, BondSource, CharacterProfile, GroupProfile, MemoryFragment, Message, MomentPost, UserProfile } from '../../types';
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
import { pairLineId, pairSpeakerOf } from '../../utils/pairLine';
import {
    dialogueMaterials, innerMaterials, lifeMaterials, materialsBlock, mentionNames, mentionsAny, momentMaterials, numberMaterials,
    type FragmentMaterial,
} from '../../utils/bond/fragmentSources';
import { memberVisibleGroupMessages, userMessageKey } from '../../utils/groupChat/presence';
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
    /** 私聊、見面（角色之間：他們的私聊）；只有其他角度的日子是空的 */
    parts: FragmentPart[];
    /** 其他角度的素材（群聊、私下提起、朋友圈、心聲；TA 的一天寫的時候才讀） */
    materials: Omit<FragmentMaterial, 'ref'>[];
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

type Mat = Omit<FragmentMaterial, 'ref'>;

const charNames = (c: Pick<CharacterProfile, 'name' | 'aliases'>) => mentionNames([c.name, ...(c.aliases || [])]);

/** 群聊、TA 私下跟別人提起、朋友圈：這段關係每一天的素材（plans/bond-moments-v2.md「多角度」） */
async function collectMaterials(space: ResolvedSpace, clock: { dayOf: (ts: number) => string; timeOf: (ts: number) => string }): Promise<Map<string, Mat[]>> {
    const byDay = new Map<string, Mat[]>();
    const push = (day: string, list: Mat[]) => { if (!list.length) return; const cur = byDay.get(day); if (cur) cur.push(...list); else byDay.set(day, [...list]); };
    const isPair = space.kind === 'pair';
    const a = space.char;
    const b = space.other;
    const [characters, groups, posts] = await Promise.all([
        DB.getAllCharacters().catch(() => [] as CharacterProfile[]),
        DB.getGroups().catch(() => [] as GroupProfile[]),
        DB.getAllMomentPosts().catch(() => [] as MomentPost[]),
    ]);
    const nameOfId = (id: string | undefined) => characters.find(c => c.id === id)?.name;
    const key = space.personaKey;
    // 沒有身份卡鍵（舊資料）就當主線；舊訊息、舊貼文沒記卡的算主線那張
    const isPrimary = !key || key === a.primaryPersonaKey;
    const youNames = isPair ? [] : mentionNames([space.leftName, ...((space.user as UserProfile | undefined)?.aliases || [])]);
    const aNames = charNames(a);
    const bNames = b ? charNames(b) : [];
    const byDayOf = (msgs: Message[]) => {
        const map = new Map<string, Message[]>();
        for (const m of [...msgs].sort((x, y) => x.id - y.id)) { const k = clock.dayOf(m.timestamp); const l = map.get(k); if (l) l.push(m); else map.set(k, [m]); }
        return map;
    };

    // 群聊：身份卡 × 角色＝角色在群裡、你（這張卡）那天說過話或有人提到你；角色之間＝兩人都在的群
    for (const g of groups) {
        const members = g.members || [];
        if (!members.includes(a.id) || (isPair && (!b || !members.includes(b.id)))) continue;
        const msgs = memberVisibleGroupMessages((await DB.getGroupMessages(g.id).catch(() => [] as Message[])).filter(said), false);
        if (!msgs.length) continue;
        const isYou = (m: Message) => !isPair && m.role === 'user' && (!key || userMessageKey(m, isPrimary ? key : '\u0000') === key);
        const nameOf = (m: Message) => m.role === 'user' ? (isYou(m) ? space.leftName : '群友') : (nameOfId(m.charId) || String(m.metadata?.senderName || '某人'));
        const speakerIdOf = (m: Message) => isYou(m) ? 'user' : (m.charId === a.id || (b && m.charId === b.id)) ? m.charId! : nameOf(m);
        for (const [day, list] of byDayOf(msgs)) {
            let isHit: (m: Message) => boolean;
            if (isPair) {
                const aSpoke = list.some(m => m.charId === a.id);
                const bSpoke = list.some(m => m.charId === b!.id);
                isHit = m => (m.charId === a.id && mentionsAny(messagePlainText(m), bNames)) || (m.charId === b!.id && mentionsAny(messagePlainText(m), aNames))
                    || (aSpoke && bSpoke && (m.charId === a.id || m.charId === b!.id));
            } else {
                isHit = m => isYou(m) || (m.role !== 'user' && mentionsAny(messagePlainText(m), youNames));
            }
            push(day, dialogueMaterials({
                angle: 'group', context: `群「${g.name}」`, msgs: list, isHit, nameOf, speakerIdOf, timeOf: clock.timeOf, radius: isPair ? 0 : 1,
                sourceOf: (m, snippet) => ({ type: 'group', groupId: g.id, messageIds: [m.id], snippet, at: m.timestamp }),
            }));
        }
    }

    // TA 私下跟別人提起你（角色之間：各自跟第三人提起對方）
    const asideOf = async (self: CharacterProfile, about: string[], exclude: string[]) => {
        if (!about.length) return;
        for (const x of characters) {
            if (x.id === self.id || exclude.includes(x.id)) continue;
            const lineId = pairLineId(self.id, x.id);
            const msgs = (await DB.getMessagesByCharId(lineId, true).catch(() => [] as Message[])).filter(said);
            if (!msgs.length) continue;
            const nameOf = (m: Message) => (pairSpeakerOf(m) === self.id ? self.name : x.name);
            for (const [day, list] of byDayOf(msgs)) {
                push(day, dialogueMaterials({
                    angle: 'aside', context: `跟${x.name}私聊`, msgs: list, nameOf, timeOf: clock.timeOf,
                    isHit: m => mentionsAny(messagePlainText(m), about),
                    speakerIdOf: m => (pairSpeakerOf(m) === self.id ? self.id : x.name),
                    sourceOf: (m, snippet) => ({ type: 'message', lineId, messageIds: [m.id], snippet, at: m.timestamp }),
                }).map(mat => ({ ...mat, ownerId: self.id })));
            }
        }
    };
    if (isPair) {
        await asideOf(a, bNames, [b!.id]);
        await asideOf(b!, aNames, [a.id]);
    } else {
        await asideOf(a, youNames, []);
    }

    // 朋友圈
    const isA = (x: MomentPost['author']) => x.kind === 'character' && x.id === a.id;
    const isB = isPair
        ? (x: MomentPost['author']) => x.kind === 'character' && x.id === b!.id
        : (x: MomentPost['author']) => x.kind === 'user' && (x.personaKey && key ? x.personaKey === key : isPrimary);
    const relevant = posts.filter(p => isA(p.author) || isB(p.author));
    const days = new Set<string>();
    for (const p of relevant) { days.add(clock.dayOf(p.createdAt)); for (const c of p.comments || []) days.add(clock.dayOf(c.at)); }
    for (const day of days) {
        push(day, momentMaterials({
            posts: relevant, dayKey: day, dayOf: clock.dayOf, timeOf: clock.timeOf, isSelf: isA, isOther: isB,
            selfName: a.name, otherName: isPair ? b!.name : space.leftName, needOther: isPair,
        }));
    }
    return byDay;
}

/** 這段關係所有值得寫的日子（舊到新）：有私聊／見面，或有其他角度的素材 */
export async function listFragmentDays(space: ResolvedSpace): Promise<FragmentDayUnit[]> {
    const byDay = new Map<string, { parts: FragmentPart[]; materials: Mat[] }>();
    const slot = (dayKey: string) => { let v = byDay.get(dayKey); if (!v) { v = { parts: [], materials: [] }; byDay.set(dayKey, v); } return v; };
    let mainClock: { dayOf: (ts: number) => string; timeOf: (ts: number) => string };
    if (space.kind === 'pair') {
        const msgs = (await DB.getMessagesByCharId(space.id, true)).filter(said);
        mainClock = clockOf(space, 'pair');
        for (const d of groupByDay(msgs, mainClock.dayOf)) {
            if (dayWorthWriting(d.messages, true)) slot(d.dayKey).parts.push({ from: 'chat', lineId: space.id, messages: d.messages, timeOf: mainClock.timeOf });
        }
    } else {
        const line = lineFor(space.char, space.personaKey);
        const lineId = lineKey(line);
        const all = (await DB.getMessagesByCharId(line, true)).filter(said);
        const chat = all.filter(m => !m.metadata?.dateStoryId);
        mainClock = clockOf(space, 'chat');
        for (const d of groupByDay(chat, mainClock.dayOf)) {
            if (dayWorthWriting(d.messages)) slot(d.dayKey).parts.push({ from: 'chat', lineId, messages: d.messages, timeOf: mainClock.timeOf });
            // 心聲跟著私聊那天（回覆上記的 metadata.innerState）
            const inner = innerMaterials(d.messages, mainClock.timeOf);
            if (inner.length) slot(d.dayKey).materials.push(...inner);
        }
        const storyIds = [...new Set(all.map(m => m.metadata?.dateStoryId).filter((x): x is string => typeof x === 'string' && !!x))];
        for (const storyId of storyIds) {
            const story = await DB.getDateStory(storyId).catch(() => undefined);
            const c = clockOf(space, 'date', story);
            for (const d of groupByDay(all.filter(m => m.metadata?.dateStoryId === storyId), c.dayOf)) {
                if (dayWorthWriting(d.messages)) slot(d.dayKey).parts.push({ from: 'date', lineId, storyId, messages: d.messages, timeOf: c.timeOf });
            }
        }
    }
    try {
        for (const [day, mats] of await collectMaterials(space, mainClock)) slot(day).materials.push(...mats);
    } catch (e) {
        console.warn('[拾光] 其他角度的素材沒讀到，只看對話', e);
    }
    return [...byDay.entries()]
        .filter(([, v]) => v.parts.length || v.materials.some(m => m.angle !== 'inner'))
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([dayKey, v]) => ({ dayKey, parts: v.parts, materials: v.materials, count: v.parts.reduce((s, p) => s + p.messages.length, 0) + v.materials.length }));
}

/** TA 的一天（日程＋獨白）：寫那天的時候才讀；角色之間只留跟對方有關的 */
async function lifeOf(space: ResolvedSpace, dayKey: string): Promise<Mat[]> {
    const atOf = (hhmm: string) => { const t = new Date(`${dayKey}T${/^\d{1,2}:\d{2}$/.test(hhmm) ? hhmm.padStart(5, '0') : '12:00'}:00`).getTime(); return Number.isFinite(t) ? t : Date.parse(dayKey); };
    const one = async (self: CharacterProfile, other?: CharacterProfile): Promise<Mat[]> => {
        const schedule = await DB.getDailySchedule(self.id, dayKey).catch(() => null);
        const names = other ? charNames(other) : [];
        return lifeMaterials({
            schedule, context: other ? `${self.name}的一天` : 'TA 的一天', atOf,
            ...(other ? { onlyIf: (text: string, slot?: { participants?: Array<{ id?: string }> }) => mentionsAny(text, names) || !!slot?.participants?.some(p => p.id === other.id) } : {}),
        }).map(m => ({ ...m, ownerId: self.id }));
    };
    if (space.kind === 'pair') return [...await one(space.char, space.other), ...await one(space.other!, space.char)];
    return one(space.char);
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

/** 寫一天的片段，回傳新寫的卡。對話照段寫；其他角度的素材跟第一段一起給（沒有對話就單獨寫一次） */
export async function writeFragmentDay(space: ResolvedSpace, day: FragmentDayUnit, opts: WriteDayOptions): Promise<BondEntry[]> {
    const isPair = space.kind === 'pair';
    const tags = fragmentTagsFor(space.bond.route);
    const dayLabel = formatEventDate({ precision: 'day', date: day.dayKey });
    const selfName = isPair ? space.char.name : space.rightName;
    const otherName = isPair ? space.other!.name : space.leftName;
    const nameOf = (m: Pick<Message, 'role' | 'charId' | 'metadata'>): string => {
        if (isPair) { const id = pairSpeakerOf(m); return id === space.other?.id ? space.other!.name : id === space.char.id ? space.char.name : '某人'; }
        return m.role === 'user' ? space.leftName : m.role === 'assistant' ? space.rightName : '旁白';
    };
    if (opts.replace) {
        const old = fragmentsOfDay(bondEntriesOf(space.id), day.dayKey);
        if (old.length) await deleteBondEntries(old.map(e => e.id));
    }
    // 其他角度：群聊、私下提起、朋友圈、心聲（列日子時讀好的）＋ TA 的一天（現在讀）
    const life = await lifeOf(space, day.dayKey).catch(() => [] as Mat[]);
    const materials = numberMaterials([...(day.materials || []), ...life]);
    const block = materialsBlock(materials, selfName, otherName, isPair);
    const extraMax = materials.length ? Math.min(3, Math.ceil(materials.length / 4)) : 0;

    type Round = { part?: FragmentPart; chunk: Message[]; withMaterials: boolean };
    const rounds: Round[] = [];
    for (const part of day.parts) for (const chunk of splitParts(part.messages)) rounds.push({ part, chunk, withMaterials: false });
    if (materials.length) {
        if (rounds.length) rounds[0].withMaterials = true;
        else rounds.push({ chunk: [], withMaterials: true });
    }

    const voiceFor = (who: string | undefined, fallback: string): string => {
        if (!isPair) return space.char.id;
        if (who === space.other!.name) return space.other!.id;
        if (who === space.char.name) return space.char.id;
        return fallback;
    };
    const written: BondEntry[] = [];
    for (const round of rounds) {
        if (opts.signal?.aborted) throw new DOMException('stopped', 'AbortError');
        const mats = round.withMaterials ? materials : [];
        const max = (round.chunk.length ? maxFor(round.chunk.length) : 0) + (round.withMaterials ? Math.max(1, extraMax) : 0);
        const prompt = buildFragmentPrompt({
            selfName, otherName, pair: isPair, dayLabel, from: round.part?.from || 'chat', tags, route: space.bond.route, max,
            transcript: round.part ? fragmentTranscript(round.chunk, nameOf, round.part.timeOf) : '',
            already: written.map(e => e.text),
            ...(round.withMaterials ? { materials: block } : {}),
        });
        const raw = isPair
            ? await askPair(space, prompt, opts.apiConfig, opts.signal)
            : await requestEssay({ writer: space.view!, user: space.user, bond: space.bond, apiConfig: opts.apiConfig, prompt, signal: opts.signal });
        const picks = parseFragmentPick(raw, round.chunk, tags, max, mats);
        const now = Date.now();
        const cards: BondEntry[] = [];
        for (const p of picks) {
            if (p.material) {
                const mat = p.material;
                const fallback = mat.ownerId || (mat.speakerId && [space.char.id, space.other?.id].includes(mat.speakerId) ? mat.speakerId : space.char.id);
                cards.push(newFragmentEntry({
                    bondId: space.id, dayKey: day.dayKey, tag: p.tag, note: p.note,
                    ...(mat.quotable && p.quote ? { quote: { who: mat.speakerId || mat.speaker || '', text: p.quote, ...(mat.source && 'messageIds' in mat.source ? { messageId: mat.source.messageIds[0] } : {}) } } : {}),
                    voice: voiceFor(p.who, fallback), time: mat.time, at: mat.at, from: mat.angle,
                    ...(mat.context ? { context: mat.context } : {}),
                    ...(mat.source ? { source: mat.source } : {}), now,
                }));
                continue;
            }
            const msg = p.msg!;
            const part = round.part!;
            const speaker = isPair ? (pairSpeakerOf(msg) || space.char.id) : msg.role === 'user' ? 'user' : space.char.id;
            const snippet = messagePlainText(msg).slice(0, 300);
            const source: BondSource = part.from === 'date' && part.storyId
                ? { type: 'date', storyId: part.storyId, charId: space.char.id, messageIds: [msg.id], snippet, at: msg.timestamp }
                : { type: 'message', lineId: part.lineId, messageIds: [msg.id], snippet, at: msg.timestamp };
            cards.push(newFragmentEntry({
                bondId: space.id, dayKey: day.dayKey, tag: p.tag, note: p.note,
                quote: { who: speaker, text: p.quote, messageId: msg.id },
                voice: voiceFor(p.who, speaker === 'user' ? space.char.id : speaker), time: part.timeOf(msg.timestamp), at: msg.timestamp, from: part.from, source, now,
            }));
        }
        if (cards.length) written.push(...(await saveBondEntries(cards)));
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
const pairCheckedAt = new Map<string, number>();

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
    // 每聊完一輪都會叫：半小時內看過就不再讀一次（列日子要讀群聊、朋友圈）
    const last = pairCheckedAt.get(id) || 0;
    if (Date.now() - last < 30 * 60_000) return 0;
    pairCheckedAt.set(id, Date.now());
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
