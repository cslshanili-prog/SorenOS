/**
 * 完成紀錄與積點（plans/bond-batch4.md 1.2、1.2b、1.3）。純函式：帳本怎麼記、怎麼算分、連續天數、成就。
 * 讀寫資料庫在 ledgerStore.ts；什麼時候判在 components/bond/pactRun.ts。
 */
import type { BondEntry, BondLedgerRow, BondPromiseRepeat } from '../../types';
import { addDays, countsOnDay, dayKeyOf, dayNumber, periodKeyOf, previousPeriodKey } from './period';
import { checkDay, type DayFacts, type FactKind } from './taskCheck';
import { PROMISE_TEMPLATES } from './pact';

export const ledgerRowId = (bondId: string, key: string, periodKey: string): string => `${bondId}|${key}|${periodKey}`;

/** 約定記帳用的鍵：模板做的用模板（刪掉重建也接得上、補算的接得上），自訂的用約定 id */
export const ledgerKeyOf = (promise: Pick<BondEntry, 'id' | 'promise'>): string =>
    promise.promise?.templateId ? `tpl:${promise.promise.templateId}` : promise.id;

/** 算分的那幾筆：沒撤銷、不是 AI 判沒做到 */
export const isCounted = (r: BondLedgerRow): boolean => !r.revokedAt && !r.miss;

export function totalPoints(rows: BondLedgerRow[]): number {
    return rows.reduce((s, r) => s + (isCounted(r) ? r.points || 0 : 0), 0);
}

/** 約定開始算的那天：雙方都說好的那一刻 */
export function promiseStartDay(e: BondEntry): string | null {
    const a = e.promise?.agreedBy;
    if (!a?.user || !a?.char) return null;
    return dayKeyOf(Math.max(a.user, a.char));
}

/** 這個約定記過的帳（算分的） */
export function rowsOfPromise(rows: BondLedgerRow[], promise: BondEntry): BondLedgerRow[] {
    const key = ledgerKeyOf(promise);
    return rows.filter(r => r.key === key);
}

/** 這期做了沒 */
export function donePeriod(rows: BondLedgerRow[], key: string, periodKey: string): BondLedgerRow | undefined {
    return rows.find(r => r.key === key && r.periodKey === periodKey && isCounted(r));
}

export interface Streak { current: number; best: number }

/**
 * 連續幾期：從現在這期往回數，這期還沒做不算斷（今天還沒過完）。best 是有史以來最長的一段。
 */
export function streakOf(rows: BondLedgerRow[], key: string, repeat: BondPromiseRepeat, today: string, anchor?: string): Streak {
    if (repeat.kind === 'once') return { current: 0, best: 0 };
    const done = new Set(rows.filter(r => r.key === key && isCounted(r)).map(r => r.periodKey));
    if (!done.size) return { current: 0, best: 0 };
    // best：把做過的期排好，看相鄰的是不是前後期
    const keys = [...done].sort();
    let best = 1; let run = 1;
    for (let i = 1; i < keys.length; i++) {
        run = previousPeriodKey(repeat, keys[i]) === keys[i - 1] ? run + 1 : 1;
        if (run > best) best = run;
    }
    let cur = periodKeyOf(repeat, today, anchor);
    if (!done.has(cur)) cur = previousPeriodKey(repeat, cur) || '';
    let current = 0;
    while (cur && done.has(cur)) {
        current++;
        cur = previousPeriodKey(repeat, cur) || '';
    }
    return { current, best: Math.max(best, current) };
}

// ─── 一天的事實 → 帳 ──────────────────────────────

export const factKey = (k: FactKind): string => `fact:${k}`;

export interface DayRowsInput {
    bondId: string;
    day: string;
    facts: DayFacts;
    messages: Parameters<typeof checkDay>[2];
    /** 成立中的約定（state active） */
    promises: BondEntry[];
    /** 已經有的帳（去重、看一次性的做過沒） */
    existing: Map<string, BondLedgerRow>;
    how: 'auto' | 'backfill';
    now: number;
}

/**
 * 一天的紀錄要記哪些帳：當天成立的事實（0 分）＋做到的約定（照紀錄、關鍵字判；手動和 AI 判讀不在這）。
 * 已經有的同一筆不重記（包括你撤銷掉的：撤銷就是你說不算，不要自動又加回來）。
 */
export function planDayRows(input: DayRowsInput): BondLedgerRow[] {
    const { bondId, day, facts, messages, promises, existing, how, now } = input;
    const out: BondLedgerRow[] = [];
    const add = (row: Omit<BondLedgerRow, 'id' | 'bondId' | 'at' | 'how'>) => {
        const id = ledgerRowId(bondId, row.key, row.periodKey);
        if (existing.has(id) || out.some(r => r.id === id)) return;
        out.push({ ...row, id, bondId, at: now, how });
    };
    for (const [k, ids] of Object.entries(facts.hits) as Array<[FactKind, number[]]>) {
        add({ key: factKey(k), periodKey: day, points: 0, label: FACT_LABEL[k], evidence: { messageIds: ids } });
    }
    for (const p of promises) {
        const pr = p.promise;
        if (!pr || pr.state !== 'active') continue;
        if (pr.check.kind !== 'record' && pr.check.kind !== 'keyword') continue;
        const start = promiseStartDay(p);
        if (!start || day < start) continue;
        if (!countsOnDay(pr.repeat, day)) continue;
        const res = checkDay(pr.check, facts, messages);
        if (!res.done) continue;
        const periodKey = periodKeyOf(pr.repeat, day, start);
        add({ key: ledgerKeyOf(p), promiseId: p.id, periodKey, points: pr.points || 0, label: p.text.trim().slice(0, 40), evidence: { messageIds: res.messageIds } });
    }
    return out;
}

export const FACT_LABEL: Record<FactKind, string> = {
    chat: '聊了幾句', deepChat: '好好聊了一陣', goodnight: '互道晚安', photo: '分享了照片', call: '通了電話',
    date: '見了面', music: '一起聽了歌', giftIn: '收到禮物', giftOut: '送出禮物', letterOut: '寄了一封信',
};

/**
 * 補算過去（2.6）：照模板的預設分數，把某一天的事實記成模板的帳（`tpl:<id>`），標「補算」。
 * 只補你勾的模板；今天以後的不補（那是自動判的事）。
 */
export function planBackfillTemplateRows(bondId: string, day: string, facts: DayFacts, templateIds: string[], existing: Map<string, BondLedgerRow>, route: string | undefined, now: number): BondLedgerRow[] {
    const out: BondLedgerRow[] = [];
    for (const t of PROMISE_TEMPLATES) {
        if (!templateIds.includes(t.id) || t.check.kind !== 'record') continue;
        const rec = t.check.record;
        const hit = rec === 'gift' ? (facts.hits.giftIn || facts.hits.giftOut) : rec === 'letter' ? facts.hits.letterOut : facts.hits[rec];
        if (!hit) continue;
        const id = ledgerRowId(bondId, `tpl:${t.id}`, day);
        if (existing.has(id)) continue;
        const title = t.title[(route || 'none') as keyof typeof t.title] || t.title.default;
        out.push({ id, bondId, key: `tpl:${t.id}`, periodKey: day, at: now, points: t.points, how: 'backfill', label: title, evidence: { messageIds: hit } });
    }
    return out;
}

// ─── 成就（1.2b）───────────────────────────────────

export type AchievementGroup = '第一次通话' | '第一次见面' | '第一次听歌' | '礼物' | '旅行' | '连续聊天' | '问答' | '日记' | '纸条' | '纪念日' | '里程碑' | '愿望' | '默契' | '信';

export interface AchievementDef {
    /** 帳本的鍵 `ach:<key>` */
    key: string;
    periodKey: string;
    label: string;
    points: number;
    group: AchievementGroup;
}

export interface AchievementStats {
    /** 有這件事實的天數（取自帳本的 fact:*） */
    factDays: Partial<Record<FactKind, string[]>>;
    /** 一起旅行（同行有這個角色），照出發日 */
    trips: Array<{ id: string; from: string; destination: string }>;
    questionsRevealed: number;
    diariesBoth: number;
    slipsDelivered: number;
    anniversaries: number;
    milestones: number;
    wishesDone: number;
    habits: number;
    /** 珍藏（第 5 批）：送到了的禮物件數（購物中心＋手記）、一件記了三筆以上後續的件數 */
    giftsGiven?: number;
    giftsReceived?: number;
    giftsWellUsed?: number;
    /** 信：雙方寄到的封數 */
    lettersExchanged?: number;
}

const ach = (key: string, periodKey: string, label: string, points: number, group: AchievementGroup): AchievementDef => ({ key: `ach:${key}`, periodKey, label, points, group });

export const STREAK_STEPS: Array<[number, number]> = [[3, 20], [7, 50], [30, 150], [100, 300], [365, 600]];
const COUNT_STEPS = {
    questions: [[1, 20], [10, 50], [50, 150]] as Array<[number, number]>,
    diaries: [[1, 20], [10, 50], [50, 150]] as Array<[number, number]>,
    slips: [[10, 30], [50, 100]] as Array<[number, number]>,
    wishes: [[1, 50], [10, 150]] as Array<[number, number]>,
};

/** 連續有這件事的最長天數 */
export function longestDayRun(days: string[]): number {
    const nums = [...new Set(days)].map(dayNumber).sort((a, b) => a - b);
    let best = 0; let run = 0; let prev = NaN;
    for (const n of nums) {
        run = n === prev + 1 ? run + 1 : 1;
        prev = n;
        if (run > best) best = run;
    }
    return best;
}

/** 現在連續幾天（今天還沒有不算斷） */
export function currentDayRun(days: string[], today: string): number {
    const set = new Set(days);
    let d = set.has(today) ? today : addDays(today, -1);
    let n = 0;
    while (set.has(d)) { n++; d = addDays(d, -1); }
    return n;
}

/** 照紀錄已經達成的成就（全部列出；哪些還沒記帳由呼叫端比對） */
export function achievedList(s: AchievementStats): AchievementDef[] {
    const out: AchievementDef[] = [];
    const first = (k: FactKind) => (s.factDays[k]?.length ? [...s.factDays[k]!].sort()[0] : null);
    if (first('call')) out.push(ach('first-call', 'once', '第一次通話', 30, '第一次通话'));
    if (first('date')) out.push(ach('first-date', 'once', '第一次見面', 50, '第一次见面'));
    if (first('music')) out.push(ach('first-music', 'once', '第一次一起聽歌', 20, '第一次听歌'));
    // 手記的禮物（購物中心以外的）也算第一次
    if (first('giftIn') || (s.giftsReceived ?? 0) >= 1) out.push(ach('first-gift-in', 'once', '第一次收到禮物', 30, '礼物'));
    if (first('giftOut') || (s.giftsGiven ?? 0) >= 1) out.push(ach('first-gift-out', 'once', '第一次送出禮物', 30, '礼物'));
    if ((s.giftsGiven ?? 0) >= 10) out.push(ach('gifts-out', 'n:10', '送出十件禮物', 100, '礼物'));
    if ((s.giftsReceived ?? 0) >= 10) out.push(ach('gifts-in', 'n:10', '收到十件禮物', 100, '礼物'));
    if ((s.giftsWellUsed ?? 0) >= 1) out.push(ach('gift-well-used', 'once', '被好好用著（一份禮物記了三筆後續）', 30, '礼物'));
    if ((s.lettersExchanged ?? 0) >= 1) out.push(ach('first-letter', 'once', '第一封信', 30, '信'));
    if ((s.lettersExchanged ?? 0) >= 10) out.push(ach('letters', 'n:10', '交換十封信', 100, '信'));
    const trips = [...s.trips].sort((a, b) => a.from.localeCompare(b.from));
    trips.forEach((t, i) => {
        if (i === 0) out.push(ach('first-trip', 'once', `第一次一起旅行（${t.destination}）`, 80, '旅行'));
        else out.push(ach('trip', t.id, `一起旅行（${t.destination}）`, 40, '旅行'));
    });
    const streak = longestDayRun(s.factDays.chat || []);
    for (const [n, pts] of STREAK_STEPS) if (streak >= n) out.push(ach('streak', `n:${n}`, `連續聊天 ${n} 天`, pts, '连续聊天'));
    for (const [n, pts] of COUNT_STEPS.questions) if (s.questionsRevealed >= n) out.push(ach('questions', `n:${n}`, `拾光問答揭曉 ${n} 題`, pts, '问答'));
    for (const [n, pts] of COUNT_STEPS.diaries) if (s.diariesBoth >= n) out.push(ach('diaries', `n:${n}`, `交換日記 ${n} 本`, pts, '日记'));
    for (const [n, pts] of COUNT_STEPS.slips) if (s.slipsDelivered >= n) out.push(ach('slips', `n:${n}`, `紙條 ${n} 張`, pts, '纸条'));
    if (s.anniversaries >= 1) out.push(ach('first-anniversary', 'once', '第一個紀念日', 30, '纪念日'));
    if (s.milestones >= 1) out.push(ach('first-milestone', 'once', '第一個里程碑', 30, '里程碑'));
    for (const [n, pts] of COUNT_STEPS.wishes) if (s.wishesDone >= n) out.push(ach('wishes', `n:${n}`, n === 1 ? '一起完成第一個願望' : `完成 ${n} 個願望`, pts, '愿望'));
    if (s.habits >= 1) out.push(ach('first-habit', 'once', '第一個默契', 30, '默契'));
    return out;
}

/** 全部成就的清單（還沒達成的也列，給成就頁看）；旅行每趟那種只列一格說明 */
export function allAchievementSlots(): Array<{ key: string; periodKey: string; label: string; points: number }> {
    const slots: Array<{ key: string; periodKey: string; label: string; points: number }> = [
        { key: 'ach:first-call', periodKey: 'once', label: '第一次通話', points: 30 },
        { key: 'ach:first-date', periodKey: 'once', label: '第一次見面', points: 50 },
        { key: 'ach:first-music', periodKey: 'once', label: '第一次一起聽歌', points: 20 },
        { key: 'ach:first-gift-in', periodKey: 'once', label: '第一次收到禮物', points: 30 },
        { key: 'ach:first-gift-out', periodKey: 'once', label: '第一次送出禮物', points: 30 },
        { key: 'ach:gifts-out', periodKey: 'n:10', label: '送出十件禮物', points: 100 },
        { key: 'ach:gifts-in', periodKey: 'n:10', label: '收到十件禮物', points: 100 },
        { key: 'ach:gift-well-used', periodKey: 'once', label: '被好好用著（一份禮物記了三筆後續）', points: 30 },
        { key: 'ach:first-letter', periodKey: 'once', label: '第一封信', points: 30 },
        { key: 'ach:letters', periodKey: 'n:10', label: '交換十封信', points: 100 },
        { key: 'ach:first-trip', periodKey: 'once', label: '第一次一起旅行', points: 80 },
        { key: 'ach:trip', periodKey: '*', label: '之後每一趟一起旅行', points: 40 },
    ];
    for (const [n, pts] of STREAK_STEPS) slots.push({ key: 'ach:streak', periodKey: `n:${n}`, label: `連續聊天 ${n} 天`, points: pts });
    for (const [n, pts] of COUNT_STEPS.questions) slots.push({ key: 'ach:questions', periodKey: `n:${n}`, label: `拾光問答揭曉 ${n} 題`, points: pts });
    for (const [n, pts] of COUNT_STEPS.diaries) slots.push({ key: 'ach:diaries', periodKey: `n:${n}`, label: `交換日記 ${n} 本`, points: pts });
    for (const [n, pts] of COUNT_STEPS.slips) slots.push({ key: 'ach:slips', periodKey: `n:${n}`, label: `紙條 ${n} 張`, points: pts });
    slots.push({ key: 'ach:first-anniversary', periodKey: 'once', label: '第一個紀念日', points: 30 });
    slots.push({ key: 'ach:first-milestone', periodKey: 'once', label: '第一個里程碑', points: 30 });
    for (const [n, pts] of COUNT_STEPS.wishes) slots.push({ key: 'ach:wishes', periodKey: `n:${n}`, label: n === 1 ? '一起完成第一個願望' : `完成 ${n} 個願望`, points: pts });
    slots.push({ key: 'ach:first-habit', periodKey: 'once', label: '第一個默契', points: 30 });
    return slots;
}

/** 成就達成了、帳本還沒有的那幾筆 */
export function planAchievementRows(bondId: string, s: AchievementStats, existing: Map<string, BondLedgerRow>, how: 'auto' | 'backfill', now: number): Array<BondLedgerRow & { group: AchievementGroup }> {
    return achievedList(s)
        .map(a => ({ ...a, id: ledgerRowId(bondId, a.key, a.periodKey) }))
        .filter(a => !existing.has(a.id))
        .map(a => ({ id: a.id, bondId, key: a.key, periodKey: a.periodKey, at: now, points: a.points, how, label: a.label, group: a.group }));
}

/** 帳本裡的事實天數 */
export function factDaysOf(rows: BondLedgerRow[]): Partial<Record<FactKind, string[]>> {
    const out: Partial<Record<FactKind, string[]>> = {};
    for (const r of rows) {
        if (!r.key.startsWith('fact:') || r.revokedAt) continue;
        const k = r.key.slice(5) as FactKind;
        (out[k] ||= []).push(r.periodKey);
    }
    return out;
}
