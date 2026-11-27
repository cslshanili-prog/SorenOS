/**
 * 約定的完成判定與積點（plans/bond-batch4.md 第 5 節、1.2b、2.6）。純判斷在 utils/bond/ledger.ts、taskCheck.ts；
 * 這裡負責撈訊息、記帳、叫副 API（AI 判讀、回顧里程碑）、補算過去。
 *
 * - 什麼時候判：OSContext 的 5 分鐘 tick（頁面開著才判）。從上次判到的那天往後判到今天；今天每次都再看一次。
 *   App 關著時不判，開 App 補判（一期的紀錄都還在，不會漏）。
 * - 判到哪天記在 localStorage（`soren_bond_pact_scan_v1`），不寫進 bonds：自動開的空間不用為了這個存一筆。
 *   丟了（換裝置、還原備份）就從今天重新判，帳本照 id 去重，不會重複加分。
 * - 背景系統一律過 isOnStage；小號不算（跟羈絆不單獨開小號的空間一致）。
 */
import { syncGiftPlans } from './giftRun';
import { unlockEventCards } from './eventCardRun';
import type { APIConfig, BondEntry, BondLedgerRow, BondPromiseRepeat, CharacterProfile, Message, UserProfile } from '../../types';
import { DB } from '../../utils/db';
import { withLineFields, lineFor } from '../../utils/chatLine';
import { isOnStage } from '../../utils/castRole';
import { allRegisteredBonds } from '../../utils/bond/registry';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { bondLedgerOf } from '../../utils/bond/ledgerRegistry';
import { diariesOfBondSync } from '../../utils/bond/diaryRegistry';
import { listPersonaSpaces } from '../../utils/bond/spaces';
import { saveBondLedgerRows } from '../../utils/bond/ledgerStore';
import { saveBondEntries } from '../../utils/bond/entries';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { checkNeglect } from './feelingRun';
import { parseBondId } from '../../utils/bond/model';
import { pagePublished } from '../../utils/bond/diary';
import { dayFacts, type DayFacts } from '../../utils/bond/taskCheck';
import {
    FACT_LABEL, factDaysOf, isCounted, ledgerKeyOf, ledgerRowId, planAchievementRows, planBackfillTemplateRows, planDayRows, promiseStartDay, totalPoints,
    type AchievementGroup, type AchievementStats,
} from '../../utils/bond/ledger';
import { addDays, dayKeyOf, dayStartTs, periodKeyOf, periodLastDay } from '../../utils/bond/period';
import { levelInfo } from '../../utils/bond/level';
import { setPromiseState, setWishState, PROMISE_TEMPLATES } from '../../utils/bond/pact';
import { buildTaskJudgePrompt, parseTaskJudge } from '../../utils/bond/pactPrompt';
import { numberedTranscript } from '../../utils/bond/collect';
import { charParticipant, loadCalendarEvents, personaParticipant } from '../../utils/calendarEvents';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { trackEvent } from '../../utils/analytics';
import type { ResolvedSpace } from './space';

const HEADER = '🤝 [BondPact]';
const SCAN_KEY = 'soren_bond_pact_scan_v1';
const LEVEL_KEY = 'soren_bond_level_seen_v1';
/** 太久沒開 App 時最多往回補判幾天 */
const MAX_CATCHUP_DAYS = 30;
/** 一次 tick 最多叫幾次 AI 判讀 */
const AI_JUDGES_PER_TICK = 2;
let running = false;

const readMap = (key: string): Record<string, string | number> => {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
};
const writeMap = (key: string, map: Record<string, string | number>) => {
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* 存不了下次從今天重判，帳本照 id 去重 */ }
};

export const RECORD_ANALYTICS: Record<string, string> = { chat: '聊几句', deepChat: '深聊', goodnight: '晚安', photo: '照片', call: '通话', date: '见面', music: '听歌', gift: '礼物' };
const CHECK_ANALYTICS = { record: '记录', keyword: '关键字', ai: 'AI', manual: '手动' } as const;

export interface PactGain {
    bondId: string;
    charId: string;
    charName: string;
    rows: BondLedgerRow[];
    /** 升到幾級（比你上次看過的高才有） */
    levelUp?: number;
}

/** 這次判哪些關係：身份卡 × 角色，角色在戲上、不是小號 */
function pactSpaces(characters: CharacterProfile[], profileBase: UserProfile): Array<{ bondId: string; char: CharacterProfile; personaKey: string }> {
    const chars = characters.filter(c => !c.altOf && isOnStage(c)).map(c => withLineFields(profileBase, c));
    return listPersonaSpaces(chars, allRegisteredBonds())
        .map(sp => ({ bondId: sp.id, char: chars.find(c => c.id === sp.charId)!, personaKey: sp.personaKey }))
        .filter(x => !!x.char);
}

const lineArgOf = (char: CharacterProfile, personaKey: string | undefined) => {
    const line = lineFor(char, personaKey);
    return (line.personaKey ? { charId: char.id, personaKey: line.personaKey } : char.id) as Parameters<typeof DB.getLineMessagesSince>[0];
};

function groupByDay(msgs: Message[]): Map<string, Message[]> {
    const out = new Map<string, Message[]>();
    for (const m of msgs) {
        if (typeof m.timestamp !== 'number') continue;
        const d = dayKeyOf(m.timestamp);
        const list = out.get(d);
        if (list) list.push(m); else out.set(d, [m]);
    }
    for (const list of out.values()) list.sort((a, b) => a.id - b.id);
    return out;
}

/** 成就要看的統計（帳本裡的事實＋各處的紀錄） */
async function achievementStats(bondId: string, char: CharacterProfile, personaKey: string | undefined, rows: BondLedgerRow[], ctx: { trips: Awaited<ReturnType<typeof DB.getAllTrips>>; events: Awaited<ReturnType<typeof loadCalendarEvents>> }): Promise<AchievementStats> {
    const entries = bondEntriesOf(bondId);
    const me = personaParticipant(personaKey);
    const isMe = (p?: { kind: string; id: string }) => !!p && p.kind === me.kind && p.id === me.id;
    const isChar = (p?: { kind: string; id: string }) => !!p && p.kind === 'char' && p.id === char.id;
    const trips = ctx.trips.filter(t => (isMe(t.owner) && (t.companions || []).some(isChar)) || (isChar(t.owner) && (t.companions || []).some(isMe)));
    const anniversaries = ctx.events.filter(e => e.kind === 'anniversary' && isMe(e.owner) && (e.participants || []).some(isChar)).length;
    return {
        factDays: factDaysOf(rows),
        trips: trips.map(t => ({ id: t.id, from: t.from, destination: t.destination })),
        questionsRevealed: entries.filter(e => e.kind === 'question').reduce((n, e) => n + (e.question?.rounds || []).filter(r => r.revealedAt).length, 0),
        diariesBoth: diariesOfBondSync(bondId).filter(d => pagePublished(d.userPage) && pagePublished(d.charPage)).length,
        slipsDelivered: entries.filter(e => e.kind === 'note' && e.status === 'published' && e.slip?.deliveredAt).length,
        anniversaries,
        milestones: entries.filter(e => e.kind === 'milestone' && e.status === 'published').length,
        wishesDone: entries.filter(e => e.kind === 'wish' && e.wish?.state === 'done').length,
        habits: entries.filter(e => e.kind === 'habit' && e.habit?.state === 'active').length,
    };
}

/** 一次性的約定做到了：約定標完成，從願望談來的願望也完成 */
async function closeOncePromises(rows: BondLedgerRow[]): Promise<void> {
    const changed: BondEntry[] = [];
    for (const r of rows) {
        if (r.periodKey !== 'once' || !r.promiseId || !isCounted(r)) continue;
        const p = bondEntryById(r.promiseId);
        if (!p?.promise || p.promise.repeat.kind !== 'once' || p.promise.state !== 'active') continue;
        changed.push(setPromiseState(p, 'done'));
        const wish = p.promise.fromWishId ? bondEntryById(p.promise.fromWishId) : undefined;
        if (wish?.wish && wish.wish.state !== 'done') changed.push(setWishState(wish, 'done'));
    }
    if (changed.length) await saveBondEntries(changed);
}

function trackGains(rows: Array<BondLedgerRow & { group?: AchievementGroup }>, backfill: boolean): void {
    const seen = new Set<string>();
    for (const r of rows) {
        if (r.key.startsWith('ach:')) {
            trackEvent('羁绊成就', { 成就: r.group || '里程碑', 补算: backfill ? '是' : '否' });
            continue;
        }
        if (backfill || !r.points || !r.promiseId) continue;
        const p = bondEntryById(r.promiseId)?.promise;
        if (!p) continue;
        const tpl = p.templateId && p.check.kind === 'record' ? RECORD_ANALYTICS[p.check.record] || '自订' : '自订';
        const sig = `${CHECK_ANALYTICS[p.check.kind]}|${tpl}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        trackEvent('约定完成', { 依据: CHECK_ANALYTICS[p.check.kind], 模板: tpl });
    }
}

/** 等級有沒有變高（比你上次看過的高才算）；第一次算只記下來不跳 */
function levelChange(bondId: string, rows: BondLedgerRow[]): number | undefined {
    const map = readMap(LEVEL_KEY);
    const level = levelInfo(totalPoints(rows)).level;
    const seen = Number(map[bondId] || 0);
    if (level === seen) return undefined;
    map[bondId] = level;
    writeMap(LEVEL_KEY, map);
    if (!seen || level < seen) return undefined;
    trackEvent('羁绊升级', { 等级: level >= 10 ? '10+' : String(level) });
    return level;
}

/** 一期的第一天 */
function periodFirstDay(repeat: BondPromiseRepeat, periodKey: string): string {
    switch (repeat.kind) {
        case 'daily': case 'everyNDays': return periodKey;
        case 'weekly': return addDays(periodLastDay(repeat, periodKey)!, -6);
        case 'monthly': return `${periodKey}-01`;
        case 'yearly': return `${periodKey}-${repeat.date}`;
        case 'once': return periodKey;
    }
}

/** AI 判讀一期（副 API）：判是／否＋理由＋依據；判否也留一筆（miss），不重判，你可以手動補 */
export async function judgePeriodWithAi(args: {
    bondId: string; char: CharacterProfile; personaKey: string | undefined; leftName: string; promise: BondEntry; periodKey: string; apiConfig: APIConfig;
}): Promise<BondLedgerRow | null> {
    const { promise, periodKey, char } = args;
    const pr = promise.promise;
    if (!pr || pr.check.kind !== 'ai') return null;
    const api = globalMeterApi(args.apiConfig) || (args.apiConfig.baseUrl && args.apiConfig.apiKey ? { baseUrl: args.apiConfig.baseUrl, apiKey: args.apiConfig.apiKey, model: args.apiConfig.model } : null);
    if (!api) return null;
    const first = pr.repeat.kind === 'once' ? promiseStartDay(promise) || dayKeyOf(Date.now()) : periodFirstDay(pr.repeat, periodKey);
    const last = pr.repeat.kind === 'once' ? dayKeyOf(Date.now()) : periodLastDay(pr.repeat, periodKey) || first;
    const msgs = (await DB.getLineMessagesSince(lineArgOf(char, args.personaKey), dayStartTs(first)))
        .filter(m => m.role !== 'system' && m.type !== 'system' && dayKeyOf(m.timestamp) <= last)
        .slice(-200);
    const nameOf = (m: Pick<Message, 'role'>) => (m.role === 'user' ? args.leftName : char.name);
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'user', content: buildTaskJudgePrompt({ promise: promise.text, hint: pr.check.hint, period: first === last ? first : `${first} 到 ${last}`, leftName: args.leftName, rightName: char.name, transcript: numberedTranscript(msgs, nameOf) }) }],
            temperature: 0.2,
            max_tokens: 600,
        }),
    }, 1, 60_000, { appName: '羈絆', charId: char.id, charName: char.name, purpose: '判讀約定' });
    const out = parseTaskJudge(extractContent(data), msgs.length);
    if (!out) return null;
    return {
        id: ledgerRowId(args.bondId, ledgerKeyOf(promise), periodKey), bondId: args.bondId, key: ledgerKeyOf(promise), promiseId: promise.id,
        periodKey, at: Date.now(), points: pr.points || 0, how: 'ai', label: promise.text.trim().slice(0, 40),
        evidence: { messageIds: out.picks.map(n => msgs[n - 1].id), reason: out.reason },
        ...(out.done ? {} : { miss: true }),
    };
}

/** 一次 tick：每段關係從上次判到的那天判到今天。回傳有加分的（OSContext 跳提示） */
export async function runPactTick(scope: { characters: CharacterProfile[]; userProfileBase: UserProfile; apiConfig: APIConfig }): Promise<PactGain[]> {
    if (running) return [];
    running = true;
    try {
        const now = Date.now();
        const today = dayKeyOf(now);
        const scan = readMap(SCAN_KEY);
        const ctx = { trips: await DB.getAllTrips().catch(() => []), events: await loadCalendarEvents().catch(() => []) };
        const gains: PactGain[] = [];
        let aiBudget = AI_JUDGES_PER_TICK;
        for (const { bondId, char, personaKey } of pactSpaces(scope.characters, scope.userProfileBase)) {
            const parsed = parseBondId(bondId);
            if (parsed?.kind !== 'persona') continue;
            let from = typeof scan[bondId] === 'string' ? String(scan[bondId]) : today;
            if (from > today) from = today;
            if (from < addDays(today, -MAX_CATCHUP_DAYS)) from = addDays(today, -MAX_CATCHUP_DAYS);
            const msgs = await DB.getLineMessagesSince(lineArgOf(char, personaKey), dayStartTs(from)).catch(() => [] as Message[]);
            const byDay = groupByDay(msgs);
            const before = bondLedgerOf(bondId);
            const existing = new Map(before.map(r => [r.id, r]));
            const promises = bondEntriesOf(bondId).filter(e => e.kind === 'promise' && e.promise?.state === 'active');
            const fresh: Array<BondLedgerRow & { group?: AchievementGroup }> = [];
            for (let d = from; d <= today; d = addDays(d, 1)) {
                const dayMsgs = byDay.get(d) || [];
                if (!dayMsgs.length) continue;
                const rows = planDayRows({ bondId, day: d, facts: dayFacts(dayMsgs), messages: dayMsgs, promises, existing, how: 'auto', now });
                for (const r of rows) { existing.set(r.id, r); fresh.push(r); }
            }
            // AI 判讀：已經結束的期、還沒判過的
            for (const p of promises) {
                const pr = p.promise!;
                if (pr.check.kind !== 'ai' || aiBudget <= 0 || pr.repeat.kind === 'once') continue;
                const start = promiseStartDay(p);
                if (!start) continue;
                const lastPeriod = periodKeyOf(pr.repeat, addDays(today, -1), start);
                const lastDay = periodLastDay(pr.repeat, lastPeriod);
                if (!lastDay || lastDay >= today || lastDay < start || lastDay < from) continue;
                const id = ledgerRowId(bondId, ledgerKeyOf(p), lastPeriod);
                if (existing.has(id)) continue;
                aiBudget--;
                const row = await judgePeriodWithAi({ bondId, char, personaKey, leftName: scope.userProfileBase.name || '你', promise: p, periodKey: lastPeriod, apiConfig: scope.apiConfig })
                    .catch(e => { console.warn(HEADER, 'AI 判讀沒成功', e); return null; });
                if (row) { existing.set(row.id, row); fresh.push(row); }
            }
            const all = [...existing.values()];
            const stats = await achievementStats(bondId, char, personaKey, all, ctx);
            for (const r of planAchievementRows(bondId, stats, existing, 'auto', now)) { existing.set(r.id, r); fresh.push(r); }
            if (fresh.length) {
                await saveBondLedgerRows(fresh.map(({ group: _g, ...r }) => r));
                await closeOncePromises(fresh);
                trackGains(fresh, false);
            }
            // 親近與信任開始記了的：一週以上你沒說話，記一次冷落（components/bond/feelingRun.ts）
            if (bondOrBlank(bondId).feeling) {
                let lastUser = [...msgs].reverse().find(m => m.role === 'user')?.timestamp || 0;
                if (!lastUser) lastUser = (await DB.getRecentMessagesByCharId(lineArgOf(char, personaKey) as any, 60, true).catch(() => [] as Message[])).reverse().find(m => m.role === 'user')?.timestamp || 0;
                await checkNeglect(bondId, lastUser, now).catch(() => {});
            }
            scan[bondId] = today;
            const levelUp = levelChange(bondId, [...existing.values()]);
            // 等級到了的事件卡開出來（plans/bond-batch4.md 2.2）
            await unlockEventCards(bondId, levelInfo(totalPoints([...existing.values()])).level).catch(e => console.warn(HEADER, '事件卡解鎖失敗', e));
            const scored = fresh.filter(r => r.points && isCounted(r));
            if (scored.length || levelUp) gains.push({ bondId, charId: char.id, charName: char.name, rows: scored, ...(levelUp ? { levelUp } : {}) });
        }
        writeMap(SCAN_KEY, scan);
        // 珍藏（plans/bond-batch5.md 2.3、2.4）：買了打算送的、TA 送出了它在準備的，連回訂單；TA 的打算過期作廢
        await syncGiftPlans(pactSpaces(scope.characters, scope.userProfileBase)).catch(e => console.warn(HEADER, '禮物同步失敗', e));
        return gains;
    } finally {
        running = false;
    }
}

/** 加分提示的那句：「＋30（今天聊幾句、互道晚安）」 */
export function gainToastText(g: PactGain): string {
    const pts = g.rows.reduce((s, r) => s + r.points, 0);
    const names = [...new Set(g.rows.map(r => r.label))].slice(0, 3).join('、');
    const head = pts ? `和${g.charName}的羈絆 ＋${pts}${names ? `（${names}）` : ''}` : '';
    const lv = g.levelUp ? `升到 Lv.${g.levelUp}` : '';
    return [head, lv].filter(Boolean).join('，') || `和${g.charName}的羈絆${lv}`;
}

// ─── 手動 ─────────────────────────────────────────

/** 手動記一期（做到了你自己勾，或補記某一天）；已經有的同一期蓋過去（包括 AI 判沒做到、你撤銷的） */
export async function recordManually(space: ResolvedSpace, promise: BondEntry, day: string): Promise<BondLedgerRow | null> {
    const pr = promise.promise;
    if (!pr) return null;
    const start = promiseStartDay(promise) || day;
    const periodKey = periodKeyOf(pr.repeat, day, start);
    const row: BondLedgerRow = {
        id: ledgerRowId(space.id, ledgerKeyOf(promise), periodKey), bondId: space.id, key: ledgerKeyOf(promise), promiseId: promise.id,
        periodKey, at: Date.now(), points: pr.points || 0, how: 'manual', label: promise.text.trim().slice(0, 40),
        evidence: { reason: day === dayKeyOf(Date.now()) ? undefined : `補記 ${day}` },
    };
    await saveBondLedgerRows([row]);
    await closeOncePromises([row]);
    trackEvent('约定完成', { 依据: '手动', 模板: pr.templateId && pr.check.kind === 'record' ? RECORD_ANALYTICS[pr.check.record] || '自订' : '自订' });
    return row;
}

/** 改了東西（禮物、旅行、日記…）之後馬上看一次成就，不等 tick */
export async function refreshAchievements(space: ResolvedSpace): Promise<BondLedgerRow[]> {
    if (space.kind !== 'persona') return [];
    const existing = new Map(bondLedgerOf(space.id).map(r => [r.id, r]));
    const ctx = { trips: await DB.getAllTrips().catch(() => []), events: await loadCalendarEvents().catch(() => []) };
    const stats = await achievementStats(space.id, space.char, space.personaKey, [...existing.values()], ctx);
    const rows = planAchievementRows(space.id, stats, existing, 'auto', Date.now());
    if (rows.length) {
        await saveBondLedgerRows(rows.map(({ group: _g, ...r }) => r));
        trackGains(rows, false);
    }
    return rows;
}

// ─── 回顧與補算（2.6）──────────────────────────────

export interface BackfillPreview {
    days: number;
    firstDay?: string;
    /** 每個模板會補幾天、幾分 */
    byTemplate: Array<{ id: string; days: number; points: number }>;
}

/** 讀這條線全部的私聊，算每天的事實（補算前先看一下會補多少） */
export async function loadLineDays(space: ResolvedSpace): Promise<Map<string, { facts: DayFacts; messages: Message[] }>> {
    const msgs = await DB.getMessagesByCharId(lineArgOf(space.char, space.personaKey) as any, true).catch(() => [] as Message[]);
    const out = new Map<string, { facts: DayFacts; messages: Message[] }>();
    for (const [day, list] of groupByDay(msgs)) out.set(day, { facts: dayFacts(list), messages: list });
    return out;
}

export function previewBackfill(days: Map<string, { facts: DayFacts }>, today: string, recorded: (key: string, day: string) => boolean = () => false): BackfillPreview {
    const past = [...days.entries()].filter(([d]) => d < today);
    return {
        days: past.length,
        firstDay: past.map(([d]) => d).sort()[0],
        byTemplate: PROMISE_TEMPLATES.map(t => {
            const rec = t.check.kind === 'record' ? t.check.record : null;
            const n = past.filter(([d, v]) => rec && !recorded(`tpl:${t.id}`, d) && (rec === 'gift' ? (v.facts.hits.giftIn || v.facts.hits.giftOut) : v.facts.hits[rec])).length;
            return { id: t.id, days: n, points: n * t.points };
        }),
    };
}

/** 補算：今天以前的事實（0 分）＋你勾的模板照預設分數＋成就，都標「補算」 */
export async function runBackfill(space: ResolvedSpace, days: Map<string, { facts: DayFacts }>, templateIds: string[]): Promise<{ rows: number; points: number }> {
    const today = dayKeyOf(Date.now());
    const now = Date.now();
    const existing = new Map(bondLedgerOf(space.id).map(r => [r.id, r]));
    const fresh: Array<BondLedgerRow & { group?: AchievementGroup }> = [];
    for (const [day, { facts }] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (day >= today) continue;
        for (const [k, ids] of Object.entries(facts.hits)) {
            const id = ledgerRowId(space.id, `fact:${k}`, day);
            if (existing.has(id)) continue;
            const row: BondLedgerRow = { id, bondId: space.id, key: `fact:${k}`, periodKey: day, at: now, points: 0, how: 'backfill', label: FACT_LABEL[k as keyof typeof FACT_LABEL] || k, evidence: { messageIds: ids } };
            existing.set(id, row); fresh.push(row);
        }
        for (const r of planBackfillTemplateRows(space.id, day, facts, templateIds, existing, space.bond.route, now)) { existing.set(r.id, r); fresh.push(r); }
    }
    const ctx = { trips: await DB.getAllTrips().catch(() => []), events: await loadCalendarEvents().catch(() => []) };
    const stats = await achievementStats(space.id, space.char, space.personaKey, [...existing.values()], ctx);
    for (const r of planAchievementRows(space.id, stats, existing, 'backfill', now)) { existing.set(r.id, r); fresh.push(r); }
    // 一次寫太多筆會卡：分批
    const plain = fresh.map(({ group: _g, ...r }) => r);
    for (let i = 0; i < plain.length; i += 400) await saveBondLedgerRows(plain.slice(i, i + 400));
    trackGains(fresh, true);
    await updateBond(space.id, b => ({ ...b, pactReview: { ...(b.pactReview || {}), backfilledAt: now, backfilledTo: addDays(today, -1) } }));
    // 判到哪天：補到昨天，今天交給 tick
    const scan = readMap(SCAN_KEY);
    if (!scan[space.id]) { scan[space.id] = today; writeMap(SCAN_KEY, scan); }
    levelChange(space.id, [...existing.values()]);
    return { rows: plain.filter(r => r.points).length, points: plain.reduce((s, r) => s + r.points, 0) };
}

/** 回顧：這條線的身份卡（給提醒卡、行事曆用） */
export const ownerOf = (space: ResolvedSpace) => personaParticipant(space.personaKey);
export const charOf = (space: ResolvedSpace) => charParticipant(space.char.id);
