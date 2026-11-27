/**
 * 羈絆主動產出上雲的契約（plans/bond-batch3.md 1.6、第 3d 批；環境無關葉子模塊）
 *
 * 跟「每天到點生成日程」同一條路（utils/amsgScheduleJob.ts）：客戶端替每段關係（身份卡 × 角色）在 amsg:job 放一份
 * standing job `bond-output:<bondId>`（系統提示詞、路線鎖、四種各自的到期時間與提示詞），每一種開著的類型排一條
 * 每天到點的後台任務（時間落在那一種的投遞時段裡）。worker 到點照這份判斷該不該寫、拼提示詞、叫 LLM，把原文
 * 送回來；解析和落庫在客戶端（日記在 diaries、其他在 bond_entries，都在 IndexedDB 裡），跟本機寫的走同一套。
 *
 * 對帳（本機和雲端不寫重複）：
 * - 本機寫完會立刻重傳 standing job，到期時間往後推，雲端到點看到還沒到期就跳過；
 * - 結果回來時，這一種在 job 快照之後本機已經寫過（`outputLast` 比 `jobRefreshedAt` 新）就丟掉；
 * - 頁面關著好幾天：雲端自己記寫過的（`bond-output-log`），同一種至少隔區間下限才再寫一份；
 *   job 在 amsg:job 只活 3 天（客戶端沒上線刷新就自然停）。
 *
 * 往這裡加代碼前先確認：不 import 任何帶瀏覽器依賴的模塊。`pnpm build:workers` 會把這份打進 amsg worker bundle。
 */
import type { BondOutputKind, BondOutputSetting } from '../../types';
import { buildDiaryPrompt, parseCharAsk, parseCharWish, parseDiary, parseNotice, parseSlip, type OutputContext } from './outputPromptCore';

export const BOND_OUTPUT_KIND = 'bond-output';
export const BOND_OUTPUT_RESULT_KIND = 'bond-output';
/** worker 在 config-check 報這個，才認得「願望」這一種（第 4 批；舊 bundle 只認四種） */
export const BOND_OUTPUT_WISH_CAPABILITY = 'bond-output:wish';
/** 同上，「信」這一種（第 5 批） */
export const BOND_OUTPUT_LETTER_CAPABILITY = 'bond-output:letter';

/** standing job 的 key（一段關係一份，四種共用） */
export const bondOutputJobKey = (bondId: string): string => `bond-output:${bondId}`;
/** 任務 metadata 上的 job 編號：哪段關係的哪一種 */
export const bondOutputJobId = (bondId: string, kind: BondOutputKind): string => `bond-output|${kind}|${bondId}`;
export const parseBondOutputJobId = (raw: unknown): { bondId: string; kind: BondOutputKind } | null => {
    if (typeof raw !== 'string') return null;
    const m = /^bond-output\|(diary|question|note|essay|wish|letter)\|(.+)$/.exec(raw);
    return m ? { kind: m[1] as BondOutputKind, bondId: m[2] } : null;
};
/** 雲端自己記的寫過哪些（全部關係共用一行，跟 job 放同一個命名空間） */
export const BOND_OUTPUT_LOG_KEY = 'bond-output-log';

/** 本機和雲端同一組（askChar 是 0.85）；輸出上限照篇幅算（outputPromptCore 的 outputMaxTokens），排任務時帶上 */
export const BOND_OUTPUT_TEMPERATURE = 0.85;
export const BOND_OUTPUT_LLM_TIMEOUT_MS = 150_000;

const DAY = 86400_000;

export interface BondOutputJobDiary {
    /** 提示詞除了日期和你那頁以外的部分 */
    base: OutputContext & { recentDiaries?: string; chars: [number, number]; style?: string; withNotice?: boolean };
    /** 角色那邊「今天」怎麼算：時區＋聊天時鐘的偏移（自訂時間的線） */
    dateTz: string;
    dateOffsetMs: number;
    /** 刷新時那邊的今天、你那頁（發布了才有）、TA 那頁寫了沒 */
    today: string;
    userPageToday?: string;
    writtenToday: boolean;
}

export interface BondOutputJobKind {
    /** 最早什麼時候該寫（utils/bond/output.ts 的 nextDueAt）；null＝還沒有起點 */
    dueAt: number | null;
    everyDays: [number, number];
    window?: BondOutputSetting['window'];
    pausedUntil?: number;
    withNotice: boolean;
    /** 現在認的那條任務（舊的、孤兒任務到點看到對不上就跳過） */
    taskUuid?: string;
    /** 問答、紙條、隨筆、願望：整段提示詞（本機那條路組的同一份） */
    prompt?: string;
    diary?: BondOutputJobDiary;
    /** 紙條：回哪一張（沒有＝自己丟一張）；新丟的那張能用哪些標籤 */
    replyTo?: string;
    tags?: string[];
    /** 隨筆：「挑一件」的候選（時間線的 key，照編號） */
    candidateKeys?: string[];
}

export interface BondOutputJob {
    v: 1;
    bondId: string;
    charId: string;
    charName: string;
    /** 你的裝置時區：投遞時段、一天幾份都照它 */
    tzId: string;
    refreshedAt: number;
    /** 角色的核心上下文（含羈絆段） */
    system: string;
    /** 路線鎖（沒有就空字串） */
    lock: string;
    limits: { perBondPerDay: number; minGapMs: number; allPerDay: number };
    kinds: Partial<Record<BondOutputKind, BondOutputJobKind>>;
}

export function buildBondOutputJob(args: Omit<BondOutputJob, 'v'>): BondOutputJob {
    return { v: 1, ...args };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function parseBondOutputJob(raw: unknown): BondOutputJob | null {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch { return null; }
    }
    if (!isObj(obj) || obj.v !== 1) return null;
    if (typeof obj.bondId !== 'string' || !obj.bondId || typeof obj.charId !== 'string' || !obj.charId) return null;
    if (typeof obj.system !== 'string' || typeof obj.tzId !== 'string' || !obj.tzId) return null;
    if (!isObj(obj.kinds) || !isObj(obj.limits)) return null;
    return obj as unknown as BondOutputJob;
}

// ─── 時間 ──────────────────────────────────────────

/** 某時區裡的日期與一天裡第幾分鐘 */
export function zonedParts(tzId: string, ms: number): { dateKey: string; minutes: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    return { dateKey: `${map.year}-${map.month}-${map.day}`, minutes: Number(map.hour) * 60 + Number(map.minute) };
}

const minutesOf = (hm: string): number => {
    const [h, m] = hm.split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/** 跟 utils/bond/output.ts 的 inWindow 同一個判斷（這份要零依賴，抄一份） */
export function inOutputWindow(window: BondOutputSetting['window'], nowMinutes: number): boolean {
    if (!window) return true;
    const from = minutesOf(window.from);
    const to = minutesOf(window.to);
    if (from === to) return true;
    return from < to ? nowMinutes >= from && nowMinutes <= to : nowMinutes >= from || nowMinutes <= to;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 這一種每天幾點到點：落在投遞時段裡（尾巴留 20 分鐘），沒設時段就在 10:00～22:00 之間；
 * 用 bondId＋類型挑，同一段關係的四種會錯開，每次算都一樣。
 */
export function bondOutputFireTime(bondId: string, kind: BondOutputKind, window: BondOutputSetting['window']): string {
    let from = 10 * 60;
    let span = 12 * 60;
    if (window && window.from !== window.to) {
        from = minutesOf(window.from);
        const to = minutesOf(window.to);
        span = ((to - from + 1440) % 1440) - 20;
        if (span < 1) span = 1;
    }
    let h = 2166136261;
    for (const ch of `${bondId}|${kind}|fire`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const at = (from + ((h >>> 0) % span)) % 1440;
    return `${pad(Math.floor(at / 60))}:${pad(at % 60)}`;
}

/** 下一次到點的牆鐘時刻（那個時區的 'YYYY-MM-DDTHH:MM:00'）：今天的還沒過就今天，不然明天 */
export function nextFireLocal(tzId: string, hm: string, nowMs: number): string {
    const { dateKey, minutes } = zonedParts(tzId, nowMs);
    const target = minutesOf(hm);
    let day = dateKey;
    if (target <= minutes + 2) {
        const [y, m, d] = dateKey.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d + 1));
        day = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    }
    return `${day}T${hm}:00`;
}

// ─── 雲端自己的帳 ──────────────────────────────────

export interface BondOutputLog {
    /** 這本帳記的是哪一天（裝置時區） */
    day: string;
    total: number;
    bonds: Record<string, { n: number; last: number }>;
    /** `<bondId>|<kind>` → 雲端上一次寫的時間（跨天保留，14 天前的丟掉） */
    kinds: Record<string, number>;
}

export function parseBondOutputLog(raw: string | null | undefined): BondOutputLog | null {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        if (!isObj(o) || typeof o.day !== 'string') return null;
        return {
            day: o.day,
            total: typeof o.total === 'number' ? o.total : 0,
            bonds: isObj(o.bonds) ? o.bonds as BondOutputLog['bonds'] : {},
            kinds: isObj(o.kinds) ? o.kinds as BondOutputLog['kinds'] : {},
        };
    } catch { return null; }
}

/** 記一筆（換天就把當天的數字歸零） */
export function recordBondOutput(log: BondOutputLog | null, day: string, bondId: string, kind: BondOutputKind, at: number): BondOutputLog {
    const sameDay = log && log.day === day;
    const kinds: Record<string, number> = {};
    for (const [k, t] of Object.entries(log?.kinds || {})) if (at - t < 14 * DAY) kinds[k] = t;
    kinds[`${bondId}|${kind}`] = at;
    const bonds = sameDay ? { ...log!.bonds } : {};
    const prev = bonds[bondId];
    bonds[bondId] = { n: (prev?.n || 0) + 1, last: at };
    return { day, total: (sameDay ? log!.total : 0) + 1, bonds, kinds };
}

// ─── 到點：該不該寫 ─────────────────────────────────

export type BondOutputFireDecision =
    | { ok: true; day: string; dateKey: string }
    | { ok: false; reason: string };

/**
 * worker 到點的判斷（純函式，有測試）：
 * 開著、沒暫停、不是舊任務、到期了、在時段裡、日記那天還沒寫、雲端自己這輪沒寫過（隔區間下限）、
 * 一段關係一天幾份／兩份隔多久／全部一天幾份（雲端自己的帳；本機寫的在 job 刷新時已經推到期時間）。
 */
export function decideBondOutputFire(job: BondOutputJob, kind: BondOutputKind, taskUuid: string | null | undefined, nowMs: number, log: BondOutputLog | null): BondOutputFireDecision {
    const k = job.kinds[kind];
    if (!k) return { ok: false, reason: 'kind-off' };
    if (k.taskUuid && taskUuid && k.taskUuid !== taskUuid) return { ok: false, reason: 'stale-task' };
    if (k.pausedUntil && k.pausedUntil > nowMs) return { ok: false, reason: 'paused' };
    if (k.dueAt === null || nowMs < k.dueAt) return { ok: false, reason: 'not-due' };
    const { dateKey: day, minutes } = zonedParts(job.tzId, nowMs);
    if (!inOutputWindow(k.window, minutes)) return { ok: false, reason: 'out-of-window' };
    let dateKey = day;
    if (kind === 'diary') {
        if (!k.diary) return { ok: false, reason: 'no-diary-input' };
        dateKey = zonedParts(k.diary.dateTz, nowMs + (k.diary.dateOffsetMs || 0)).dateKey;
        if (k.diary.writtenToday && dateKey === k.diary.today) return { ok: false, reason: 'diary-written' };
    } else if (!k.prompt) {
        return { ok: false, reason: 'no-prompt' };
    }
    const cloudLast = log?.kinds[`${job.bondId}|${kind}`];
    if (cloudLast && cloudLast > job.refreshedAt && nowMs - cloudLast < (k.everyDays[0] || 1) * DAY) return { ok: false, reason: 'cloud-wrote-recently' };
    const today = log && log.day === day ? log : null;
    if (today) {
        if (today.total >= job.limits.allPerDay) return { ok: false, reason: 'all-cap' };
        const b = today.bonds[job.bondId];
        if (b && b.n >= job.limits.perBondPerDay) return { ok: false, reason: 'bond-cap' };
    }
    const lastAny = log?.bonds[job.bondId]?.last;
    if (lastAny && nowMs - lastAny < job.limits.minGapMs) return { ok: false, reason: 'gap' };
    return { ok: true, day, dateKey };
}

/** 這次要問 LLM 的話：系統＝角色核心上下文，使用者＝提示詞＋路線鎖（跟 askChar 一樣） */
export function buildBondOutputMessages(job: BondOutputJob, kind: BondOutputKind, dateKey: string): Array<{ role: 'system' | 'user'; content: string }> | null {
    const k = job.kinds[kind];
    if (!k) return null;
    let prompt = k.prompt || '';
    if (kind === 'diary') {
        if (!k.diary) return null;
        prompt = buildDiaryPrompt({ ...k.diary.base, date: dateKey, userPage: dateKey === k.diary.today ? k.diary.userPageToday : undefined });
    }
    if (!prompt) return null;
    return [
        { role: 'system', content: job.system },
        { role: 'user', content: job.lock ? `${prompt}\n\n${job.lock}` : prompt },
    ];
}

/** 回來的東西像不像樣（隨筆的解析在客戶端，這裡只看有沒有字） */
export function bondOutputLooksValid(kind: BondOutputKind, raw: string, tags: string[] = []): boolean {
    if (!raw.trim()) return false;
    if (kind === 'diary') return !!parseDiary(raw);
    if (kind === 'question') return !!parseCharAsk(raw);
    if (kind === 'note') return !!parseSlip(raw, tags);
    if (kind === 'wish') return !!parseCharWish(raw);
    return /"text"\s*:/.test(raw);
}

export { parseNotice as parseBondOutputNotice };

// ─── 結果（worker 寫、客戶端讀） ──────────────────────

export interface BondOutputResult {
    resultKind: typeof BOND_OUTPUT_RESULT_KIND;
    v: 1;
    bondId: string;
    charId: string;
    kind: BondOutputKind;
    /** 日記那天（角色那邊）；其他類型是寫的那天 */
    dateKey: string;
    /** 模型原文（客戶端用本機那套解析） */
    raw: string;
    jobRefreshedAt: number;
    generatedAt: number;
    replyTo?: string;
    tags?: string[];
    candidateKeys?: string[];
}

export function buildBondOutputResult(args: Omit<BondOutputResult, 'resultKind' | 'v'>): BondOutputResult {
    return { resultKind: BOND_OUTPUT_RESULT_KIND, v: 1, ...args };
}

const KINDS = new Set(['diary', 'question', 'note', 'essay', 'wish', 'letter']);

export function parseBondOutputResult(raw: unknown): BondOutputResult | null {
    if (!isObj(raw) || raw.resultKind !== BOND_OUTPUT_RESULT_KIND || raw.v !== 1) return null;
    if (typeof raw.bondId !== 'string' || !raw.bondId || typeof raw.charId !== 'string' || !raw.charId) return null;
    if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind) || typeof raw.raw !== 'string' || typeof raw.dateKey !== 'string') return null;
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : undefined);
    return {
        resultKind: BOND_OUTPUT_RESULT_KIND, v: 1,
        bondId: raw.bondId, charId: raw.charId, kind: raw.kind as BondOutputKind, dateKey: raw.dateKey, raw: raw.raw,
        jobRefreshedAt: typeof raw.jobRefreshedAt === 'number' ? raw.jobRefreshedAt : 0,
        generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : 0,
        ...(typeof raw.replyTo === 'string' ? { replyTo: raw.replyTo } : {}),
        ...(strs(raw.tags) ? { tags: strs(raw.tags) } : {}),
        ...(strs(raw.candidateKeys) ? { candidateKeys: strs(raw.candidateKeys) } : {}),
    };
}
