/**
 * 主動產出的設定（plans/bond-batch3.md 1.4）：預設值與解析。排程判斷在第 3c 批加在這裡。
 * 預設照紀要 4.3 的起步建議；整體上限與錯開是常數，設定頁可調。
 */
import type { BondOutputKind, BondOutputSetting, BondRecord } from '../../types';

export const OUTPUT_KINDS: BondOutputKind[] = ['diary', 'question', 'note', 'essay'];

export const OUTPUT_KIND_LABEL: Record<BondOutputKind, string> = { diary: '日記', question: '拾光問答', note: '心靈角落', essay: '隨筆' };

export const DEFAULT_OUTPUT: Record<BondOutputKind, BondOutputSetting> = {
    diary: { enabled: true, everyDays: [1, 3], length: 'medium', syncToChat: true, window: { from: '20:00', to: '23:30' } },
    question: { enabled: true, everyDays: [3, 7], length: 'short', syncToChat: true },
    note: { enabled: true, everyDays: [3, 7], length: 'short', syncToChat: false },
    essay: { enabled: true, everyDays: [5, 10], length: 'medium', syncToChat: false },
};

/** 每段關係一天最多幾份、任兩份至少隔多久；全部關係一天最多幾份 */
export const OUTPUT_LIMITS = { perBondPerDay: 2, minGapMs: 3 * 3600_000, allPerDay: 6 };

/** 篇幅對應的字數（日記用；其他類型照提示詞的口語說法） */
export const DIARY_LENGTH_CHARS: Record<BondOutputSetting['length'], [number, number]> = {
    short: [80, 200], medium: [200, 500], long: [500, 900],
};

export function resolveOutputSetting(bond: Pick<BondRecord, 'output'> | undefined, kind: BondOutputKind): BondOutputSetting {
    const base = DEFAULT_OUTPUT[kind];
    const own = bond?.output?.[kind];
    return own ? { ...base, ...own, everyDays: own.everyDays || base.everyDays } : base;
}

// ─── 排程判斷（plans/bond-batch3.md 1.5）：純函式，有測試 ───

const DAY = 86400_000;
/** 交給雲端多久沒回來就換本機補 */
export const HANDOFF_STALE_MS = DAY;

/** 哪些事件會讓哪一種提早寫 */
export const EVENT_KINDS: Record<BondOutputKind, Array<import('../../types').BondOutputEvent['kind']>> = {
    diary: ['daily_summary', 'date_end'],
    essay: ['moment', 'date_end'],
    note: ['note_received', 'daily_summary'],
    question: ['question_received', 'daily_summary'],
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
 * - 投遞時段外、暫停中、交給雲端還沒回來（一天內）的不排；
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
            const handed = c.bond.outputHandedOff?.[kind];
            if (handed && now - handed < HANDOFF_STALE_MS) continue;
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

/** 寫完一份：這一種的起點換成現在、清掉交給雲端的標記 */
export function markOutputDone(bond: BondRecord, kind: BondOutputKind, at: number): BondRecord {
    const handed = { ...(bond.outputHandedOff || {}) };
    delete handed[kind];
    return { ...bond, outputLast: { ...(bond.outputLast || {}), [kind]: at }, outputHandedOff: handed };
}
