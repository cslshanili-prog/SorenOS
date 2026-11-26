/**
 * 主動產出的設定（plans/bond-batch3.md 1.4）：預設值與解析。排程判斷在第 3c 批加在這裡。
 * 預設照紀要 4.3 的起步建議；整體上限與錯開是常數，設定頁可調。
 */
import type { BondOutputKind, BondOutputSetting, BondRecord } from '../../types';

export const OUTPUT_KINDS: BondOutputKind[] = ['diary', 'question', 'note', 'essay', 'wish'];

export const OUTPUT_KIND_LABEL: Record<BondOutputKind, string> = { diary: '日記', question: '拾光問答', note: '心靈角落', essay: '隨筆', wish: '願望' };

export const DEFAULT_OUTPUT: Record<BondOutputKind, BondOutputSetting> = {
    diary: { enabled: true, everyDays: [1, 3], length: 'medium', syncToChat: true, window: { from: '20:00', to: '23:30' } },
    question: { enabled: true, everyDays: [3, 7], length: 'short', syncToChat: true },
    note: { enabled: true, everyDays: [3, 7], length: 'short', syncToChat: false },
    essay: { enabled: true, everyDays: [5, 10], length: 'medium', syncToChat: false },
    // 第 4 批：角色寫一個自己的願望（plans/bond-batch4.md 1.7）
    wish: { enabled: true, everyDays: [7, 14], length: 'short', syncToChat: true },
};

/** 每段關係一天最多幾份、任兩份至少隔多久；全部關係一天最多幾份 */
export const OUTPUT_LIMITS = { perBondPerDay: 2, minGapMs: 3 * 3600_000, allPerDay: 6 };

/** 沒自己填字數時，舊的三檔篇幅換成幾字到幾字（每種不一樣：紙條本來就比日記短） */
export const OUTPUT_CHARS: Record<BondOutputKind, Record<BondOutputSetting['length'], [number, number]>> = {
    diary: { short: [80, 200], medium: [200, 500], long: [500, 900] },
    question: { short: [20, 100], medium: [100, 250], long: [250, 500] },
    note: { short: [20, 120], medium: [120, 300], long: [300, 600] },
    essay: { short: [150, 300], medium: [300, 700], long: [700, 1200] },
    wish: { short: [8, 40], medium: [20, 80], long: [40, 160] },
};
export const DIARY_LENGTH_CHARS = OUTPUT_CHARS.diary;
/** 字數格子能填的範圍 */
export const OUTPUT_CHARS_LIMIT: [number, number] = [10, 5000];

/** 這一種的篇幅（幾字到幾字）：自己填的優先，沒填照三檔換；小的在前 */
export function resolveOutputChars(bond: Pick<BondRecord, 'output'> | undefined, kind: BondOutputKind): [number, number] {
    const s = resolveOutputSetting(bond, kind);
    const raw = s.chars && s.chars.length === 2 ? s.chars : OUTPUT_CHARS[kind][s.length] || OUTPUT_CHARS[kind].medium;
    const clamp = (n: number) => Math.max(OUTPUT_CHARS_LIMIT[0], Math.min(OUTPUT_CHARS_LIMIT[1], Math.round(Number(n) || OUTPUT_CHARS_LIMIT[0])));
    const a = clamp(raw[0]);
    const b = clamp(raw[1]);
    return a <= b ? [a, b] : [b, a];
}

export function resolveOutputSetting(bond: Pick<BondRecord, 'output'> | undefined, kind: BondOutputKind): BondOutputSetting {
    const base = DEFAULT_OUTPUT[kind];
    const own = bond?.output?.[kind];
    return own ? { ...base, ...own, everyDays: own.everyDays || base.everyDays } : base;
}

// ─── 排程判斷（plans/bond-batch3.md 1.5）：純函式，有測試 ───

const DAY = 86400_000;

/** 哪些事件會讓哪一種提早寫 */
export const EVENT_KINDS: Record<BondOutputKind, Array<import('../../types').BondOutputEvent['kind']>> = {
    diary: ['daily_summary', 'date_end'],
    essay: ['moment', 'date_end'],
    note: ['note_received', 'daily_summary'],
    question: ['question_received', 'daily_summary'],
    wish: ['moment', 'date_end'],
};

/** 'HH:MM' → 一天裡的第幾分鐘 */
const minutesOf = (hm: string): number => {
    const [h, m] = hm.split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/** 現在（你的裝置時間，一天裡的第幾分鐘）在不在投遞時段裡；跨午夜的時段也算 */
export function inWindow(window: BondOutputSetting['window'], nowMinutes: number): boolean {
    if (!window) return true;
    const from = minutesOf(window.from);
    const to = minutesOf(window.to);
    if (from === to) return true;
    return from < to ? nowMinutes >= from && nowMinutes <= to : nowMinutes >= from || nowMinutes <= to;
}

/** 區間裡挑哪一天：用 bondId＋類型＋上次的時間算，同一輪每次算都一樣（不會每次 tick 擲一次骰子） */
export function pickIntervalDays(bondId: string, kind: BondOutputKind, last: number, everyDays: [number, number]): number {
    const [min, max] = everyDays[0] <= everyDays[1] ? everyDays : [everyDays[1], everyDays[0]];
    let h = 2166136261;
    for (const ch of `${bondId}|${kind}|${last}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const frac = ((h >>> 0) % 10000) / 10000;
    return min + frac * (max - min);
}

/** 下一次保底的時間（沒有起點回 null） */
export function intervalDueAt(bond: Pick<BondRecord, 'id' | 'output' | 'outputLast'>, kind: BondOutputKind): number | null {
    const last = bond.outputLast?.[kind];
    if (!last) return null;
    return last + pickIntervalDays(bond.id, kind, last, resolveOutputSetting(bond, kind).everyDays) * DAY;
}

export interface OutputCandidate {
    bondId: string;
    bond: BondRecord;
    /**
     * 這段關係能不能主動產出：角色在戲上、沒拉黑、不是小號（呼叫端判斷）。
     * 沒有自己設過開關的類型，還要最近 14 天有聊過（recentlyActive）才算預設開。
     */
    eligible: boolean;
    recentlyActive: boolean;
}

export interface OutputPlanItem { bondId: string; kind: BondOutputKind; reason: 'event' | 'interval' }

export interface OutputDecision {
    /** 該寫的，照「最久沒寫」排；跑的人一次拿第一個 */
    due: OutputPlanItem[];
    /** 第一次看到的類型：記下起點（第一份大約在區間下限的一半之後） */
    seeds: Array<{ bondId: string; kind: BondOutputKind; at: number }>;
}

/**
 * 該不該寫、寫哪個（plans/bond-batch3.md 1.4、1.5）：
 * - 有對應的事件、而且離上一次已過區間下限的一半 → 提早；沒事件就到區間裡挑的那天才寫；
 * - 投遞時段外、暫停中的不排；
 * - 每段關係一天最多 2 份、兩份隔 3 小時；全部一天最多 6 份。
 * nowMinutes＝你裝置上現在是一天裡第幾分鐘；dayStart＝你裝置上今天 0 點。
 */
export function decideBondOutputs(cands: OutputCandidate[], now: number, nowMinutes: number, dayStart: number, limits = OUTPUT_LIMITS): OutputDecision {
    const seeds: OutputDecision['seeds'] = [];
    const pool: Array<OutputPlanItem & { last: number }> = [];
    let todayAll = 0;
    const todayOf = new Map<string, number>();
    const latestOf = new Map<string, number>();
    for (const c of cands) {
        const lasts = Object.values(c.bond.outputLast || {}).filter((x): x is number => typeof x === 'number');
        const today = lasts.filter(t => t >= dayStart).length;
        todayOf.set(c.bondId, today);
        todayAll += today;
        latestOf.set(c.bondId, lasts.length ? Math.max(...lasts) : 0);
        if (!c.eligible) continue;
        for (const kind of OUTPUT_KINDS) {
            const own = c.bond.output?.[kind];
            const setting = resolveOutputSetting(c.bond, kind);
            const on = own && typeof own.enabled === 'boolean' ? own.enabled : setting.enabled && c.recentlyActive;
            if (!on) continue;
            if (setting.pausedUntil && setting.pausedUntil > now) continue;
            const last = c.bond.outputLast?.[kind];
            if (!last) {
                seeds.push({ bondId: c.bondId, kind, at: now - Math.floor((setting.everyDays[0] * DAY) / 2) });
                continue;
            }
            if (!inWindow(setting.window, nowMinutes)) continue;
            const halfMin = last + (setting.everyDays[0] * DAY) / 2;
            const hasEvent = (c.bond.outputEvents || []).some(e => e.at > last && EVENT_KINDS[kind].includes(e.kind));
            if (hasEvent && now >= halfMin) { pool.push({ bondId: c.bondId, kind, reason: 'event', last }); continue; }
            const dueAt = intervalDueAt(c.bond, kind);
            if (dueAt !== null && now >= dueAt) pool.push({ bondId: c.bondId, kind, reason: 'interval', last });
        }
    }
    pool.sort((a, b) => a.last - b.last);
    const due: OutputPlanItem[] = [];
    const planned = new Set<string>();
    for (const p of pool) {
        if (todayAll + due.length >= limits.allPerDay) break;
        if (planned.has(p.bondId)) continue; // 同一段一輪只排一份（錯開）
        if ((todayOf.get(p.bondId) || 0) >= limits.perBondPerDay) continue;
        if (now - (latestOf.get(p.bondId) || 0) < limits.minGapMs) continue;
        planned.add(p.bondId);
        due.push({ bondId: p.bondId, kind: p.kind, reason: p.reason });
    }
    return { due, seeds };
}

/** 記一筆事件（同類型 14 天以前的丟掉，避免越堆越多） */
export function withOutputEvent(bond: BondRecord, ev: import('../../types').BondOutputEvent): BondRecord {
    const keep = (bond.outputEvents || []).filter(e => ev.at - e.at < 14 * DAY);
    return { ...bond, outputEvents: [...keep, ev].slice(-30) };
}

/** 寫完一份：這一種的起點換成現在 */
export function markOutputDone(bond: BondRecord, kind: BondOutputKind, at: number): BondRecord {
    return { ...bond, outputLast: { ...(bond.outputLast || {}), [kind]: at } };
}

/**
 * 這一種下一次最早什麼時候該寫（給雲端的 standing job；第 3d 批）：跟 decideBondOutputs 同一套——
 * 有對應的事件就是「事件之後、而且過了區間下限的一半」，沒有就是區間裡挑的那天；還沒有起點回 null。
 * 投遞時段、暫停、上限不在這裡算（雲端到點時自己看）。
 */
export function nextDueAt(bond: Pick<BondRecord, 'id' | 'output' | 'outputLast' | 'outputEvents'>, kind: BondOutputKind): number | null {
    const last = bond.outputLast?.[kind];
    if (!last) return null;
    const setting = resolveOutputSetting(bond, kind);
    const halfMin = last + (setting.everyDays[0] * DAY) / 2;
    const events = (bond.outputEvents || []).filter(e => e.at > last && EVENT_KINDS[kind].includes(e.kind)).map(e => e.at);
    const byEvent = events.length ? Math.max(halfMin, Math.min(...events)) : null;
    const byInterval = intervalDueAt(bond, kind);
    if (byEvent === null) return byInterval;
    return byInterval === null ? byEvent : Math.min(byEvent, byInterval);
}
