/**
 * 日程自動生成上雲的契約（plans/calendar.md 第 5 批；環境無關葉子模塊）
 *
 * 跟門牌整理（amsgPlateJob.ts）同一條路，差別在這是一條**每天到點**的循環任務，輸入不是一次性的：
 * 客戶端把「人設上下文＋接下來幾天每天要帶的段（約定、待辦、出行、行程提示詞）」裝成一份
 * standing job 放在 amsg:job 的 `schedule:<charId>`，上線時每天刷一次；worker 到點算出目標日
 * （角色那邊的明天或今天）、從裡面挑那天的段拼提示詞（utils/schedulePromptCore.ts，跟本機同一份）、
 * 調 LLM、把解析出的 JSON 送回客戶端；落庫（名字對回 id、待辦對回、doneTodos 勾掉）留在客戶端，
 * 因為日程表本體在 IndexedDB 裡。
 *
 * 往這裡加代碼前先確認：不 import 任何帶瀏覽器依賴的模塊。`pnpm build:workers` 會把這份打進 amsg worker bundle。
 */

import { buildCharSchedulePrompt } from './schedulePromptCore';
import { weekdayOf } from './scheduleGenParts';

export const SCHEDULE_GENERATE_KIND = 'schedule-generate';
export const SCHEDULE_GENERATE_RESULT_KIND = 'schedule-generate';

/** standing job 在 amsg:job 命名空間裡的 key（一個角色一份，重傳覆蓋） */
export const scheduleJobKey = (charId: string): string => `schedule:${charId}`;

export interface ScheduleJobDay {
    /** 'YYYY-MM-DD' */
    date: string;
    /** 這天要帶的段（行程提示詞、出行、約定、待辦；scheduleGenParts 渲染好的字串） */
    extra: string;
}

export interface ScheduleJobInput {
    v: 1;
    charId: string;
    charName: string;
    userName: string;
    style: 'lifestyle' | 'mindful';
    /** 角色的時間參照系（含旅行）；到點算「明天是哪天」用 */
    tzId: string;
    /** 0＝今天、1＝明天 */
    ahead: 0 | 1;
    /** ContextBuilder.buildCoreContext 的產出 */
    baseContext: string;
    /** 最近聊天記錄那段；上雲不帶也行（空串） */
    chatHistoryBlock: string;
    /** 接下來幾天（含今天）各自要帶的段；目標日不在裡面就跳過這一輪 */
    days: ScheduleJobDay[];
    /** 客戶端刷新這份輸入的時刻（epoch 毫秒） */
    refreshedAt: number;
}

export function buildScheduleJobInput(args: Omit<ScheduleJobInput, 'v'>): ScheduleJobInput {
    return { v: 1, ...args };
}

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 讀回；形狀對不上回 null（worker 據此硬失敗，別拿半份輸入排出一天） */
export function parseScheduleJobInput(raw: unknown): ScheduleJobInput | null {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch { return null; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const o = obj as Record<string, unknown>;
    if (o.v !== 1) return null;
    if (typeof o.charId !== 'string' || !o.charId) return null;
    if (typeof o.charName !== 'string' || typeof o.userName !== 'string') return null;
    if (o.style !== 'lifestyle' && o.style !== 'mindful') return null;
    if (typeof o.tzId !== 'string' || !o.tzId) return null;
    if (o.ahead !== 0 && o.ahead !== 1) return null;
    if (typeof o.baseContext !== 'string' || typeof o.chatHistoryBlock !== 'string') return null;
    if (!Array.isArray(o.days)) return null;
    const days: ScheduleJobDay[] = [];
    for (const d of o.days) {
        if (!d || typeof d !== 'object') return null;
        const row = d as Record<string, unknown>;
        if (!isDay(row.date) || typeof row.extra !== 'string') return null;
        days.push({ date: row.date, extra: row.extra });
    }
    return {
        v: 1, charId: o.charId, charName: o.charName, userName: o.userName, style: o.style, tzId: o.tzId, ahead: o.ahead,
        baseContext: o.baseContext, chatHistoryBlock: o.chatHistoryBlock, days,
        refreshedAt: typeof o.refreshedAt === 'number' ? o.refreshedAt : 0,
    };
}

/** 'YYYY-MM-DD' 加幾天（UTC 日算，不碰時區） */
export const addDaysKey = (key: string, days: number): string => {
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

/** 到點要排哪一天：角色那邊的今天（照 tzId）＋ ahead */
export const scheduleJobTargetDay = (job: Pick<ScheduleJobInput, 'tzId' | 'ahead'>, nowMs: number): string => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: job.tzId, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const today = `${map.year}-${map.month}-${map.day}`;
    return addDaysKey(today, job.ahead);
};

/** 這次 fire 要發給 LLM 的話（提示詞跟本機那條路同一份） */
export function buildScheduleJobMessages(job: ScheduleJobInput, dateKey: string): Array<{ role: 'user'; content: string }> | null {
    const day = job.days.find(d => d.date === dateKey);
    if (!day) return null;
    const content = buildCharSchedulePrompt({
        style: job.style, baseContext: job.baseContext, charName: job.charName, userName: job.userName,
        today: dateKey, dayOfWeek: weekdayOf(dateKey), chatHistoryBlock: job.chatHistoryBlock, extra: day.extra,
    });
    return [{ role: 'user', content }];
}

// ─── 結果（worker 寫、客戶端讀） ──────────────────────

export interface ScheduleGenerateResult {
    resultKind: typeof SCHEDULE_GENERATE_RESULT_KIND;
    v: 1;
    charId: string;
    dateKey: string;
    /** 模型回的 JSON（原樣，客戶端用 scheduleGenParts 對回）：slots、flowNarrative、doneTodos */
    parsed: Record<string, unknown>;
    generatedAt: number;
}

export function buildScheduleGenerateResult(args: { charId: string; dateKey: string; parsed: Record<string, unknown>; generatedAt: number }): ScheduleGenerateResult {
    return { resultKind: SCHEDULE_GENERATE_RESULT_KIND, v: 1, ...args };
}

export function parseScheduleGenerateResult(raw: unknown): ScheduleGenerateResult | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.resultKind !== SCHEDULE_GENERATE_RESULT_KIND || o.v !== 1) return null;
    if (typeof o.charId !== 'string' || !o.charId || !isDay(o.dateKey)) return null;
    if (!o.parsed || typeof o.parsed !== 'object' || Array.isArray(o.parsed)) return null;
    return { resultKind: SCHEDULE_GENERATE_RESULT_KIND, v: 1, charId: o.charId, dateKey: o.dateKey, parsed: o.parsed as Record<string, unknown>, generatedAt: typeof o.generatedAt === 'number' ? o.generatedAt : 0 };
}

/**
 * 從模型輸出裡抽 JSON（零依賴版：去 <think>、去圍欄、取最外層 {…}）。
 * 本機那條路用 safeApi.extractJson（容錯更多、能修截斷）；worker 引不動它，這裡只做夠用的那幾步。
 */
export function extractScheduleJson(text: string): Record<string, unknown> | null {
    if (!text) return null;
    let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const obj = JSON.parse(t.slice(start, end + 1));
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : null;
    } catch {
        // 尾逗號那種小毛病修一下再試一次
        try {
            const obj = JSON.parse(t.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
            return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : null;
        } catch { return null; }
    }
}
