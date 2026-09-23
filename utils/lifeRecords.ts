
import { DB } from './db';
import {
    BankTransaction, CharacterProfile, LifeRecord, LifeRecordModule,
    LifeRecordSettings, MedPlan, Message,
} from '../types';
import { addLocalDays, getLocalDateKey } from './localDate';
import { formatMoney, sumMoney } from './format';

/**
 * 生活記錄（檔案 App：生理期 / 藥盒 / 記帳 / 鍛鍊）
 *
 * 三條鏈路都收在這個文件裡：
 *  1. 注入（讀路徑）：buildLifeRecordInjection —— 按角色開關把今日摘要 + 潛意識約束 +
 *     [[LIFE:...]] 指令說明 + 否決反饋拼成 system prompt section（chatPrompts 調用）。
 *  2. 代記（寫路徑）：executeLifeDirectives —— 解析角色輸出裡的 [[LIFE:...]] 指令，
 *     去重後落庫並插入可交互的 life_card 消息（chatParser 調用，本地 / 雲端回覆共用）。
 *  3. 裁決：resolveLifeRecordCard —— 用戶點卡片「確認 / 否決」，否決時回滾（含銀行流水）
 *     並給代記角色掛一條一次性反饋（Chat.tsx 調用）。
 *
 * 記帳不獨立存儲：角色代記的支出直接寫 BankApp 的 bank_transactions（BankApp 每次打開
 * 會從流水重算 todaySpent，所以這裡只動流水即可），另落一條帶 bankTxId 的 LifeRecord
 * 支撐卡片確認 / 否決回滾；注入摘要也直接讀當日銀行流水。
 */

// ─── 開關 ───
// 總開關 opt-in（默認關）；小開關默認開、受總開關統轄（開了總開關不用再逐個點四下）。
export const isLifeRecordOn = (char: CharacterProfile): boolean => char.lifeRecordEnabled === true;

export const isLifeModuleOn = (char: CharacterProfile, module: LifeRecordModule): boolean => {
    if (!isLifeRecordOn(char)) return false;
    switch (module) {
        case 'period': return char.lifeRecordPeriodEnabled !== false;
        case 'med': return char.lifeRecordMedEnabled !== false;
        case 'expense': return char.lifeRecordExpenseEnabled !== false;
        case 'exercise': return char.lifeRecordExerciseEnabled !== false;
    }
};

/** 全局隱藏的模塊集合（長按頁籤隱藏；優先級高於角色小開關，注入與代記一律跳過） */
export const getHiddenLifeModules = (settings: LifeRecordSettings | null | undefined): Set<LifeRecordModule> =>
    new Set(settings?.hiddenModules || []);

// ─── 日期工具（與 BankApp 同口徑：toISOString 取日期段） ───
export const lifeToday = (): string => getLocalDateKey();

const parseDate = (s: string): number => new Date(`${s}T00:00:00Z`).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
/** b - a 的整天數（a、b 均為 YYYY-MM-DD） */
const diffDays = (a: string, b: string): number => Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
const addDays = (s: string, n: number): string => addLocalDays(s, n);
/** 面板日曆等 UI 側複用的日期工具 */
export const lifeDiffDays = diffDays;
export const lifeAddDays = addDays;
const fmtCN = (s: string): string => {
    const [, m, d] = s.split('-');
    return `${parseInt(m, 10)}月${parseInt(d, 10)}日`;
};

/** 有效記錄 = 未被用戶否決的記錄（active / confirmed 都算數） */
const effective = (records: LifeRecord[]): LifeRecord[] => records.filter(r => r.reviewStatus !== 'rejected');

// ─── 生理期狀態機 ───
export const DEFAULT_CYCLE_LENGTH = 28;
export const DEFAULT_PERIOD_LENGTH = 5;
/** 只有 start 沒有 end 時，超過這個天數就不再視為"仍在經期"（忘記記結束的兜底） */
const PERIOD_AUTO_CLOSE_DAYS = 10;

export interface PeriodStatus {
    inPeriod: boolean;
    /** 經期第幾天（1-based，僅 inPeriod 時有意義） */
    dayN?: number;
    lastStart?: string;
    lastEnd?: string;
    /** 預測的下次經期開始日（有歷史 start 才有） */
    nextPredicted?: string;
    /** 距預測日還有幾天（可為負 = 已推遲） */
    daysUntilNext?: number;
    /**
     * 排卵期預測（標準日曆法：排卵日 ≈ 下次經期開始日 − 14 天；
     * 排卵期窗口 = 排卵日前 5 天 ~ 排卵日後 1 天）。
     * 僅作為身體週期信息呈現（狀態感知用），措辭不做任何生育導向；估算僅供參考。
     */
    ovulationDate?: string;
    ovulationStart?: string;
    ovulationEnd?: string;
}

export const computePeriodStatus = (
    records: LifeRecord[],
    settings: LifeRecordSettings | null,
    today: string = lifeToday(),
): PeriodStatus => {
    const cycle = settings?.cycleLength || DEFAULT_CYCLE_LENGTH;
    const evts = effective(records)
        .filter(r => r.module === 'period' && r.date <= today)
        .sort((a, b) => a.date === b.date ? a.timestamp - b.timestamp : (a.date < b.date ? -1 : 1));
    const lastStartRec = [...evts].reverse().find(r => r.kind === 'start');
    if (!lastStartRec) return { inPeriod: false };
    const lastStart = lastStartRec.date;
    const endAfter = [...evts].reverse().find(r => r.kind === 'end' && r.date >= lastStart
        && !(r.date === lastStart && r.timestamp < lastStartRec.timestamp));
    const sinceStart = diffDays(lastStart, today);
    const inPeriod = !endAfter && sinceStart >= 0 && sinceStart < PERIOD_AUTO_CLOSE_DAYS;
    const nextPredicted = addDays(lastStart, cycle);
    const ovulationDate = addDays(nextPredicted, -14);
    return {
        inPeriod,
        dayN: inPeriod ? sinceStart + 1 : undefined,
        lastStart,
        lastEnd: endAfter?.date,
        nextPredicted,
        daysUntilNext: diffDays(today, nextPredicted),
        ovulationDate,
        ovulationStart: addDays(ovulationDate, -5),
        ovulationEnd: addDays(ovulationDate, 1),
    };
};

/** 經期區間（供日曆渲染）：start/end 事件配對；未閉合的區間以"今天或自動收口日"為界 */
export interface PeriodInterval { start: string; end: string; open?: boolean }

export const getPeriodIntervals = (records: LifeRecord[], today: string = lifeToday()): PeriodInterval[] => {
    const evts = effective(records)
        .filter(r => r.module === 'period' && r.date <= today)
        .sort((a, b) => a.date === b.date ? a.timestamp - b.timestamp : (a.date < b.date ? -1 : 1));
    const intervals: PeriodInterval[] = [];
    const minDate = (a: string, b: string) => (a < b ? a : b);
    const maxDate = (a: string, b: string) => (a > b ? a : b);
    let open: string | null = null;
    for (const e of evts) {
        if (e.kind === 'start') {
            if (open) {
                // 上一段沒記結束就又開始了：上一段收口在「自動收口日」和「新開始前一天」的較早者
                const cap = minDate(addDays(open, PERIOD_AUTO_CLOSE_DAYS - 1), addDays(e.date, -1));
                intervals.push({ start: open, end: maxDate(open, cap) });
            }
            open = e.date;
        } else if (e.kind === 'end' && open) {
            intervals.push({ start: open, end: maxDate(open, e.date) });
            open = null;
        }
    }
    if (open) {
        const cap = addDays(open, PERIOD_AUTO_CLOSE_DAYS - 1);
        intervals.push({ start: open, end: today < cap ? today : cap, open: true });
    }
    return intervals;
};

/**
 * 該計劃今天是否該吃：enabled + （療程則在 startDate~endDate 內）+ 頻率命中
 * （錨點日 = startDate，無則創建當天；按天數差對 intervalDays 取模）。
 */
export const isMedPlanDueToday = (plan: MedPlan, today: string = lifeToday()): boolean => {
    if (!plan.enabled) return false;
    if (plan.planKind === 'course') {
        if (plan.startDate && today < plan.startDate) return false;
        if (plan.endDate && today > plan.endDate) return false;
    }
    const interval = Math.max(1, plan.intervalDays || 1);
    const anchor = plan.startDate || getLocalDateKey(new Date(plan.createdAt));
    const diff = diffDays(anchor, today);
    if (diff < 0) return false;
    if (interval === 1) return true;
    return diff % interval === 0;
};

/** 頻率的展示文案 */
export const medFreqLabel = (plan: MedPlan): string => {
    const n = Math.max(1, plan.intervalDays || 1);
    return n === 1 ? '每天' : n === 2 ? '隔天' : `每${n}天`;
};

// ─── 摘要文案（卡片 & 注入共用） ───
export const summarizeLifeRecord = (module: LifeRecordModule, kind: string, payload: Record<string, any>): string => {
    switch (module) {
        case 'period': return kind === 'start' ? '生理期開始' : '生理期結束';
        case 'med': return `吃藥 · ${payload.name || '藥'}`;
        case 'expense': return `支出 ${formatMoney(payload.amount)}${payload.note ? `（${payload.note}）` : ''}`;
        case 'exercise': return `鍛鍊 · ${payload.activity || '運動'}${payload.duration ? ` ${payload.duration}` : ''}`;
    }
};

export const LIFE_MODULE_LABELS: Record<LifeRecordModule, string> = {
    period: '生理期', med: '藥盒', expense: '記帳', exercise: '鍛鍊',
};

// ═══════════════════════════════════════════════════════════
// 1. 注入（讀路徑）
// ═══════════════════════════════════════════════════════════

/**
 * absolute = 只寫「哪天發生了什麼」，不寫「今天 / 第 N 天 / 還有幾天」。
 *
 * 主動消息的提示詞是提前打包好上雲的，到點才渲染——中間隔了幾小時甚至幾天。相對說法
 * 在打包那一刻算出來就凍住了，角色到點會照著念（用戶五天沒聊天，五天的主動消息都在說
 * 「你現在生理期第二天」）。絕對日期永不過期，離現在多久由角色對著當前時間自己判斷。
 */
const buildPeriodSummary = (
    records: LifeRecord[], settings: LifeRecordSettings | null, today: string, absolute = false,
): string => {
    const st = computePeriodStatus(records, settings, today);
    if (!st.lastStart) return '- 生理期：暫無記錄。';
    if (st.inPeriod) {
        return absolute
            ? `- 生理期：本輪於 ${fmtCN(st.lastStart)} 開始，尚未記錄結束。`
            : `- 生理期：**第 ${st.dayN} 天**（${fmtCN(st.lastStart)}開始）。`;
    }
    let s = `- 生理期：當前不在經期（上次 ${fmtCN(st.lastStart)}${st.lastEnd ? ` ~ ${fmtCN(st.lastEnd)}` : ''}）`;
    if (st.nextPredicted && st.daysUntilNext !== undefined) {
        if (absolute) s += `；按週期預測下次約在 ${fmtCN(st.nextPredicted)}`;
        else s += st.daysUntilNext >= 0
            ? `；預測下次約在 ${fmtCN(st.nextPredicted)}（還有約 ${st.daysUntilNext} 天）`
            : `；按週期預測已推遲約 ${-st.daysUntilNext} 天`;
        // 排卵期只在預測窗口還有意義時給（日曆法估算，註明僅供參考）
        if (st.ovulationDate && st.ovulationEnd && st.ovulationEnd >= today) {
            s += `；估算排卵期約 ${fmtCN(st.ovulationStart!)}~${fmtCN(st.ovulationEnd)}（這只是 TA 身體週期的背景信息，通常伴隨激素波動，可能影響狀態與情緒）`;
        }
        s += '。以上為日曆法估算，僅供參考。';
    } else s += '。';
    return s;
};

/** 按日期倒序分組取最近幾天，用於 absolute 模式下的「最近 X」列表。 */
const groupRecentByDate = <T>(
    items: T[], dateOf: (item: T) => string, today: string, days: number,
): Array<{ date: string; items: T[] }> => {
    const byDate = new Map<string, T[]>();
    for (const item of items) {
        const d = dateOf(item);
        if (!d || d > today) continue;   // 未來日期不算「最近發生過」
        const arr = byDate.get(d) ?? [];
        arr.push(item);
        byDate.set(d, arr);
    }
    return [...byDate.keys()].sort().reverse().slice(0, days)
        .map(date => ({ date, items: byDate.get(date)! }));
};

/** absolute 見 buildPeriodSummary 的說明：不判「今天該不該服」，只給計劃表和已發生的記錄。 */
const buildMedSummary = (
    plans: MedPlan[], records: LifeRecord[], today: string, absolute = false,
): string => {
    if (absolute) {
        const enabled = plans.filter(p => p.enabled).sort((a, b) => a.time.localeCompare(b.time));
        const taken = groupRecentByDate(
            effective(records).filter(r => r.module === 'med'), r => r.date, today, 3,
        );
        if (enabled.length === 0 && taken.length === 0) return '- 用藥：暫無長期用藥計劃與記錄。';
        const lines: string[] = [];
        if (enabled.length > 0) {
            const items = enabled.map(p => {
                const course = p.planKind === 'course' && p.endDate ? `，療程至${fmtCN(p.endDate)}` : '';
                return `${p.time} ${p.name}${p.dosage ? `(${p.dosage})` : ''}（${medFreqLabel(p)}${course}）`;
            });
            lines.push(`- 用藥計劃：${items.join('；')}。對著當前時間看：某個點早就過了、當天卻沒有對應的服用記錄，可以視語境順口提醒一句，別反覆催。`);
        }
        lines.push(taken.length > 0
            ? `- 最近服藥記錄：${taken.map(g => `${fmtCN(g.date)} ${g.items.map(r => r.payload.name).join('、')}`).join('；')}。`
            : '- 最近服藥記錄：暫無。');
        return lines.join('\n');
    }
    const duePlans = plans.filter(p => isMedPlanDueToday(p, today)).sort((a, b) => a.time.localeCompare(b.time));
    const todayMeds = effective(records).filter(r => r.module === 'med' && r.date === today);
    if (plans.filter(p => p.enabled).length === 0 && todayMeds.length === 0) return '- 用藥：暫無長期用藥計劃與記錄。';
    const lines: string[] = [];
    if (duePlans.length > 0) {
        const items = duePlans.map(p => {
            const taken = todayMeds.some(r => (r.payload.planId && r.payload.planId === p.id) || r.payload.name === p.name);
            const course = p.planKind === 'course' && p.endDate ? `，療程至${fmtCN(p.endDate)}` : '';
            return `${p.time} ${p.name}${p.dosage ? `(${p.dosage})` : ''}（${medFreqLabel(p)}${course}）${taken ? '✓已服' : '✗未服'}`;
        });
        lines.push(`- 今日待服：${items.join('；')}。到點沒服的，你可以視語境順口提醒一句，別反覆催。`);
    } else {
        lines.push('- 今日待服：無（按頻率今天輪空或計劃都停用）。');
    }
    const offPlan = todayMeds.filter(r => !r.payload.planId && !plans.some(p => p.name === r.payload.name));
    if (offPlan.length > 0) {
        lines.push(`- 計劃外用藥：${offPlan.map(r => r.payload.name).join('、')}。`);
    }
    return lines.join('\n');
};

/** absolute 見 buildPeriodSummary 的說明：寫「哪天花了多少」而不是「今日支出」。 */
const buildExpenseSummary = (txs: BankTransaction[], today: string, absolute = false): string => {
    if (absolute) {
        const recent = groupRecentByDate(txs, t => t.dateStr, today, 3);
        if (recent.length === 0) return '- 記帳：近期暫無支出記錄。';
        const parts = recent.map(({ date, items }) => {
            const total = formatMoney(sumMoney(items.map(t => t.amount)));
            const detail = items.slice(0, 5).map(t => `${t.note || '未備註'} ${formatMoney(t.amount)}`).join('、');
            const more = items.length > 5 ? ` 等 ${items.length} 筆` : '';
            return `${fmtCN(date)} 共 ${items.length} 筆、合計 ${total}（${detail}${more}）`;
        });
        return `- 最近支出：${parts.join('；')}。`;
    }
    const todayTx = txs.filter(t => t.dateStr === today);
    if (todayTx.length === 0) return '- 記帳：今日暫無支出記錄。';
    const total = formatMoney(sumMoney(todayTx.map(t => t.amount)));
    const items = todayTx.slice(0, 8).map(t => `${t.note || '未備註'} ${formatMoney(t.amount)}`).join('、');
    const more = todayTx.length > 8 ? ` 等 ${todayTx.length} 筆` : '';
    return `- 今日支出：共 ${todayTx.length} 筆、合計 ${total}（${items}${more}）。`;
};

/** 本週（週一起算）的起始日 */
export const weekStartOf = (today: string): string => {
    const d = new Date(`${today}T00:00:00Z`);
    const dow = d.getUTCDay(); // 0=週日
    return addDays(today, -((dow + 6) % 7));
};

/** absolute 見 buildPeriodSummary 的說明：列最近幾次鍛鍊的日期，不寫「今日 / 本週」。 */
const buildExerciseSummary = (
    records: LifeRecord[], settings: LifeRecordSettings | null, today: string, absolute = false,
): string => {
    const ex = effective(records).filter(r => r.module === 'exercise');
    const goalNum = settings?.exerciseWeeklyGoal;
    const planNote = (settings?.exercisePlanNote || '').trim();
    if (absolute) {
        const recent = groupRecentByDate(ex, r => r.date, today, 5);
        const detail = recent
            .map(g => `${fmtCN(g.date)} ${g.items.map(r => `${r.payload.activity}${r.payload.duration ? ` ${r.payload.duration}` : ''}`).join('、')}`)
            .join('；');
        let s = recent.length > 0 ? `- 最近鍛鍊：${detail}` : '- 最近鍛鍊：近期沒有記錄';
        if (goalNum) s += `（周目標 ${goalNum} 次）`;
        s += '。';
        if (planNote) s += `TA 的每週鍛鍊規劃：「${planNote}」。`;
        if (goalNum || planNote) {
            s += `這份計劃 TA 希望你幫忙盯著執行：對著上面的日期和當前時間估一下進度，落後時按你的方式自然地督促、約練或鼓勵（有溫度地推一把，不是教練查崗）；跟上了就替 TA 高興。`;
        }
        return s;
    }
    const todayEx = ex.filter(r => r.date === today);
    const ws = weekStartOf(today);
    const weekSessions = ex.filter(r => r.date >= ws && r.date <= today).length;
    const todayPart = todayEx.length > 0
        ? `今日已練：${todayEx.map(r => `${r.payload.activity}${r.payload.duration ? ` ${r.payload.duration}` : ''}`).join('、')}`
        : '今日還沒練';
    let s = `- 鍛鍊：${todayPart}；本週已練 ${weekSessions} 次`;
    const goal = settings?.exerciseWeeklyGoal;
    const plan = (settings?.exercisePlanNote || '').trim();
    if (goal || plan) {
        if (goal) s += `（周目標 ${goal} 次${weekSessions >= goal ? '，已達標' : `，還差 ${goal - weekSessions} 次`}）`;
        s += '。';
        if (plan) s += `TA 的每週鍛鍊規劃：「${plan}」。`;
        s += `這份計劃 TA 希望你幫忙盯著執行：進度落後時按你的方式自然地督促、約練或鼓勵（有溫度地推一把，不是教練查崗）；達標了就替 TA 高興。`;
    } else {
        s += '。';
    }
    return s;
};

/** 醫療 / 生理期話題的分寸引導（生理期或藥盒任一開啟時注入） */
const MEDICAL_TONE_GUIDE = `**關於健康話題的分寸**：
- 你對生理期 / 用藥 / 健康話題的瞭解程度和表達方式，以你自己的人設為準——懂得多的可以直接說，懂得少的可以現查現學（搜一下、問 AI、問學醫的朋友）再回來說，知識程度不設上限，只要你的人設解釋得通。
- **核心原則：你的反應強度必須如實匹配你對嚴重程度的真實判斷——既不誇大也不淡化。你是對方重要的判斷依據之一，這個責任不能規避。**
  - 小事（熬夜、累了、常見的小難受）：就當小事。可以吐槽兩句、順口關心一下，但別反覆唸叨、別說教式催早睡。
  - 常見情況：按常見情況如實對待，不渲染成急症、不嚇人——除非你真的判斷它不尋常。
  - 你判斷真的不對勁：不許打馬虎眼糊弄過去。鎮定地、包容地、用符合你人設的口吻明確提醒對方重視或就醫。語氣可以有人設，判斷不能有水分。
- 若你本身是 AI / 機器人設定，無需裝作不懂，按你的設定自然發揮。`;

/**
 * 構建「生活記錄」system prompt section。
 * 總開關關閉返回 ''（連指令說明都不給角色看）。
 * 會順帶取走該角色名下的否決反饋（注入一次後清除 pendingFeedback）。
 */
export const buildLifeRecordInjection = async (
    char: CharacterProfile,
    userName: string,
    // forFirePack = 這份注入是給主動消息打包的（模板提前打好、到點才渲染）。摘要數據照給，
    // 但兩塊跟「用戶此刻在說話」綁定的內容要拿掉：
    //  - 代記工具說明：後台沒有用戶新說的話，那時候輸出的指令只會把舊事再記一遍；
    //  - 否決反饋：這段是注入即消費的（讀完就把 pendingFeedback 清掉）。打包時讀一次，
    //    用戶下次真正聊天時就看不到了——那句「我理解錯了」永遠沒人說出口。
    opts: { forFirePack: boolean },
): Promise<string> => {
    const forFirePack = opts.forFirePack;
    if (!isLifeRecordOn(char)) return '';
    const today = lifeToday();

    // 全局隱藏優先級高於角色小開關：隱藏的模塊數據、指令說明、醫療引導一律不注入
    const settings = await DB.getLifeRecordSettings().catch(() => null);
    const hidden = getHiddenLifeModules(settings);
    const moduleActive = (m: LifeRecordModule) => isLifeModuleOn(char, m) && !hidden.has(m);
    if (!(['period', 'med', 'expense', 'exercise'] as LifeRecordModule[]).some(moduleActive)) return '';

    const [records, plans, txs] = await Promise.all([
        DB.getAllLifeRecords().catch(() => [] as LifeRecord[]),
        moduleActive('med') ? DB.getAllMedPlans().catch(() => [] as MedPlan[]) : Promise.resolve([] as MedPlan[]),
        moduleActive('expense') ? DB.getAllTransactions().catch(() => [] as BankTransaction[]) : Promise.resolve([] as BankTransaction[]),
    ]);

    let s = `\n### ${userName} 的生活記錄（潛意識背景）\n`;
    s += `以下是 ${userName} 的近期生活狀態。這些信息沉澱在你的潛意識裡，是你理解 TA 的身體、情緒與狀態的背景依據——**不要主動點破、不要逐條複述、不要表現得像在看報表**。只在自然的時機讓關心自然流露（例如 TA 說累了，而你"隱約記得"TA 正處在生理期第 2 天）。\n\n`;

    // fire_pack 裡一律寫絕對日期：這份摘要是打包那一刻存下來的，到點渲染時可能已經隔了
    // 幾小時甚至幾天，「今日待服」「第 N 天」那種說法會被角色照著念成過時的事實。
    const dataLines: string[] = [];
    if (moduleActive('period')) dataLines.push(buildPeriodSummary(records, settings, today, forFirePack));
    if (moduleActive('med')) dataLines.push(buildMedSummary(plans, records, today, forFirePack));
    if (moduleActive('expense')) dataLines.push(buildExpenseSummary(txs, today, forFirePack));
    if (moduleActive('exercise')) dataLines.push(buildExerciseSummary(records, settings, today, forFirePack));
    s += `${dataLines.join('\n')}\n`;
    if (forFirePack) {
        s += `\n（以上記錄截至 ${fmtCN(today)}。請對照當前時間自行判斷這些事離現在有多久，不要默認它們就發生在今天。）\n`;
    }
    s += '\n';

    if (moduleActive('period') || moduleActive('med')) {
        s += `${MEDICAL_TONE_GUIDE}\n\n`;
    }

    // 代記指令說明（按小開關裁剪；關掉的模塊連用法都不教）
    const tools: string[] = [];
    if (moduleActive('period')) {
        tools.push(`- TA 明確說生理期來了 → \`[[LIFE:PERIOD_START]]\`；明確說結束了 → \`[[LIFE:PERIOD_END]]\``);
    }
    if (moduleActive('med')) tools.push(`- TA 明確說吃了什麼藥 → \`[[LIFE:MED|藥名]]\``);
    if (moduleActive('expense')) tools.push(`- TA 明確說花了多少錢買什麼 → \`[[LIFE:EXPENSE|金額|用途]]\`（金額是純數字）`);
    if (moduleActive('exercise')) tools.push(`- TA 明確說做了什麼運動 → \`[[LIFE:EXERCISE|運動|時長]]\`（時長可省略）`);
    if (tools.length > 0 && !forFirePack) {
        s += `**代記工具**：只有當 ${userName} 在對話中**明確說出**以下事實時，才單獨起一行輸出對應指令、幫 TA 順手記一筆（一次一條）：\n${tools.join('\n')}\n`;
        s += `TA 只是暗示、開玩笑、或在說過去 / 別人的事時，一律不要記錄。記錄成功後系統會插入一張卡片，TA 可以確認或否決；被否決說明你理解錯了。平時不要把這些指令掛在嘴邊，也不要替 TA 補記你只是猜測的事。\n`;
        s += `**一件事只記一次**：上面摘要裡已經出現的狀態（如「生理期第 N 天」「今日已練」「✓已服」、已列出的支出）都說明這件事**已經記過了**——不要再輸出指令重複記，也不要因為翻到 TA 之前提過這件事就補記。聊天記錄裡出現過的 [生活記錄：…] 卡片就是你之前記的。只有 TA 明確說**又**發生了新的一次（比如「晚上又跑了一次」），才再記一條。\n`;
    }

    // 否決反饋（一次性）：上次代記被用戶否決 → 告訴角色它弄錯了，注入後即清除
    const pendingFb = forFirePack
        ? []
        : records.filter(r => r.recordedBy === char.id && r.reviewStatus === 'rejected' && r.pendingFeedback);
    if (pendingFb.length > 0) {
        s += `\n**【記錄反饋】**你之前幫 ${userName} 記的這些被 TA **否決**了——你理解錯了，這些事並沒有發生（記錄已撤銷）：\n`;
        pendingFb.forEach(r => { s += `- ${summarizeLifeRecord(r.module, r.kind, r.payload)}（${fmtCN(r.date)}）\n`; });
        s += `修正你的認知，接下來視語境自然地認個錯或帶過即可，不要長篇道歉。\n`;
        // 注入即消費：失敗也不重試（下輪還會再取到就重複唸叨，寧可丟）
        pendingFb.forEach(r => { DB.saveLifeRecord({ ...r, pendingFeedback: false }).catch(() => {}); });
    }

    return s;
};

// ═══════════════════════════════════════════════════════════
// 2. 代記（寫路徑）：解析並執行 [[LIFE:...]] 指令
// ═══════════════════════════════════════════════════════════

const LIFE_TAG_RE = /\[\[LIFE:([A-Z_]+)((?:\|[^\]|]*)*)\]\]/;
const LIFE_TAG_GLOBAL_RE = /\[\[LIFE:[^\]]*\]\]/g;

interface LifeDirective {
    module: LifeRecordModule;
    kind: string;
    payload: Record<string, any>;
}

const parseLifeDirective = (verb: string, args: string[]): LifeDirective | null => {
    switch (verb) {
        case 'PERIOD_START': return { module: 'period', kind: 'start', payload: {} };
        case 'PERIOD_END': return { module: 'period', kind: 'end', payload: {} };
        case 'MED': {
            const name = (args[0] || '').trim();
            return name ? { module: 'med', kind: 'taken', payload: { name } } : null;
        }
        case 'EXPENSE': {
            const amount = parseFloat((args[0] || '').replace(/[^\d.]/g, ''));
            const note = (args[1] || '').trim();
            if (isNaN(amount) || amount <= 0) return null;
            return { module: 'expense', kind: 'expense', payload: { amount, note } };
        }
        case 'EXERCISE': {
            const activity = (args[0] || '').trim();
            const duration = (args[1] || '').trim();
            return activity ? { module: 'exercise', kind: 'session', payload: { activity, ...(duration ? { duration } : {}) } } : null;
        }
        default: return null;
    }
};

/** 去重結果：null = 無重複；否則給出"已由誰記過"的展示名 */
const findDuplicate = async (
    d: LifeDirective,
    records: LifeRecord[],
    today: string,
): Promise<{ byName: string } | null> => {
    const byName = (r: LifeRecord) => ({ byName: r.recordedBy === 'user' ? '你自己' : (r.recordedByName || '其他角色') });
    const eff = effective(records);
    switch (d.module) {
        case 'period': {
            // 同日同類兜底（先於狀態機）：今天已經有同類事件就絕不再寫一條。
            // 狀態機有判不出重複的盲區——比如 start → 誤記了同日 end → 模型下輪又發
            // start，此時 inPeriod=false、舊邏輯放行 → 真重複入庫（用戶實報）。
            const sameDay = eff.filter(r => r.module === 'period' && r.kind === d.kind && r.date === today).pop();
            if (sameDay) return byName(sameDay);
            const settings = await DB.getLifeRecordSettings().catch(() => null);
            const st = computePeriodStatus(records, settings, today);
            if (d.kind === 'start' && st.inPeriod) {
                const rec = eff.filter(r => r.module === 'period' && r.kind === 'start' && r.date === st.lastStart).pop();
                return rec ? byName(rec) : { byName: '已有記錄' };
            }
            // 不在經期收到 END：也按"無需記錄"處理（卡片提示，不寫庫、不算角色記錯）
            if (d.kind === 'end' && !st.inPeriod) return { byName: '當前並不在經期中' };
            return null;
        }
        case 'med': {
            const rec = eff.filter(r => r.module === 'med' && r.date === today && r.payload.name === d.payload.name).pop();
            return rec ? byName(rec) : null;
        }
        case 'expense': {
            // 去重只防"同一筆的復讀"（重 roll / 指令回顯 / 用戶剛記完角色又記），不防"真的又買了一筆"。
            // 舊版按"同日 金額+備註 一致"判重——兩筆同價奶茶隔幾小時也會被吞掉（用戶實報 bug）。
            // 現在收緊到時間窗：只有 15 分鐘內已存在同金額+同備註的流水才算重複；
            // 超窗一律視為新的一筆（角色本來就能在注入的"今日流水"裡看到舊帳，提示詞層自會克制）。
            const DUP_WINDOW_MS = 15 * 60 * 1000;
            const now = Date.now();
            const txs = await DB.getAllTransactions().catch(() => [] as BankTransaction[]);
            const hit = txs.find(t =>
                t.dateStr === today
                && t.amount === d.payload.amount
                && (t.note || '') === (d.payload.note || '')
                // 老數據缺 timestamp 時保守按"重複"處理（回到舊行為），避免陳年髒數據被翻倍入帳
                && (typeof t.timestamp !== 'number' || now - t.timestamp <= DUP_WINDOW_MS));
            if (!hit) return null;
            const rec = eff.filter(r => r.module === 'expense' && r.bankTxId === hit.id).pop();
            return rec ? byName(rec) : { byName: '你自己' };
        }
        case 'exercise': {
            // 只按「同日 + 同活動」判重，不再要求時長逐字一致——模型下一輪把「30分鐘」
            // 寫成「半小時」或乾脆省略是常態，舊判據一漏就真重複入庫（用戶實報）。
            // 同一活動一天真練兩次的場景走面板手動補記（卡片會說明已有記錄）。
            // 與藥盒同口徑：同日同名即重。
            const rec = eff.filter(r => r.module === 'exercise' && r.date === today
                && r.payload.activity === d.payload.activity).pop();
            return rec ? byName(rec) : null;
        }
    }
};

/**
 * 解析並執行角色輸出裡的 [[LIFE:...]] 指令（chatParser 調用）。
 * - 指令格式非法 → 只剝 tag，靜默丟棄（模型手滑，沒什麼可交代的）。
 * - 生活記錄已關 / 模塊被隱藏 → 不寫庫，落一條系統提示說明這筆沒記成（角色的話已經說出去了）。
 * - 重複 → 不寫庫，落一張"已有記錄，無需重複"的成功態卡片（角色不算記錯）。
 * - 成功 → 寫庫（expense 同時寫銀行流水）+ 落可交互 life_card。
 * 返回剝掉所有 LIFE tag 的文本。
 */
export const executeLifeDirectives = async (
    aiContent: string,
    char: CharacterProfile,
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void,
    /** 這一輪消息該落的時間戳（離線補收時是原始發送時刻）；不傳按寫庫當刻。 */
    messageTimestamp?: number,
    /** 這一輪消息統一繼承的 metadata（主動消息 2.0 的標記，見 chatParser 的同名參數）。 */
    inheritMeta?: Record<string, any>,
): Promise<string> => {
    /** 生活卡跟同一條消息的正文氣泡共用一個時間戳，別一條消息兩個時間。 */
    const stamp = messageTimestamp != null ? { timestamp: messageTimestamp } : {};
    /** 卡片自己的字段優先，inheritMeta 只補它沒有的鍵。 */
    const withInherited = (meta: Record<string, any>) => (inheritMeta ? { ...inheritMeta, ...meta } : meta);
    let content = aiContent;
    if (!content.includes('[[LIFE:')) return content;

    const today = lifeToday();
    let executed = 0;
    const MAX_PER_MESSAGE = 4; // 防 LLM 發瘋連打十幾條
    // 全局隱藏的模塊：即使角色開關全開也不記（用戶長按隱藏 = 不想看到這類內容），但會留條提示
    const hidden = getHiddenLifeModules(await DB.getLifeRecordSettings().catch(() => null));

    /**
     * 想記但沒記成（開關關了 / 模塊被隱藏）時留一條系統提示。
     *
     * 主動消息是提前幾小時打包的，打包時開著、送達前用戶關掉是常態；角色那句「我幫你記下了」
     * 已經說滿了，動作卻靜默蒸發，用戶只會覺得這功能壞了。寫不進去也不攔著後面的指令。
     */
    const noteSkipped = async (summary: string, reason: string) => {
        try {
            await DB.saveMessage({
                ...stamp,
                charId: char.id, role: 'system', type: 'text',
                content: `[系統: ${char.name}想幫你記「${summary}」，但${reason}，這次沒記成]`,
                metadata: withInherited({ lifeRecordSkipped: true }),
            });
        } catch (e) {
            console.warn('[LifeRecord] 記不成的提示也沒落進去:', e);
        }
    };

    let m: RegExpMatchArray | null;
    while ((m = content.match(LIFE_TAG_RE)) !== null) {
        const [tag, verb, argStr] = m;
        content = content.replace(tag, '').trim();
        if (executed >= MAX_PER_MESSAGE) continue;

        const args = argStr ? argStr.split('|').slice(1).map(s => s.trim()) : [];
        const d = parseLifeDirective(verb, args);
        if (!d) continue;
        // 記不成的也計數：連打十幾條時提示同樣會刷屏
        executed++;

        const skipSummary = summarizeLifeRecord(d.module, d.kind, d.payload);
        if (!isLifeRecordOn(char)) {
            await noteSkipped(skipSummary, '生活記錄功能已關閉');
            continue;
        }
        if (!isLifeModuleOn(char, d.module) || hidden.has(d.module)) {
            await noteSkipped(skipSummary, `「${LIFE_MODULE_LABELS[d.module]}」已關閉`);
            continue;
        }

        try {
            const records = await DB.getAllLifeRecords();
            const dup = await findDuplicate(d, records, today);
            const summary = summarizeLifeRecord(d.module, d.kind, d.payload);

            if (dup) {
                await DB.saveMessage({
                    ...stamp,
                    charId: char.id, role: 'assistant', type: 'life_card',
                    content: `[生活記錄：${summary}（已有記錄，未重複添加）]`,
                    metadata: withInherited({
                        module: d.module, kind: d.kind, summary, dateStr: today,
                        recordedByName: char.name, duplicate: true, duplicateBy: dup.byName,
                    }),
                });
                addToast(`${char.name} 想記「${summary}」，已有記錄`, 'info');
                continue;
            }

            // expense：先落真實銀行流水（BankApp 打開時會從流水重算 todaySpent）
            let bankTxId: string | undefined;
            if (d.module === 'expense') {
                const tx: BankTransaction = {
                    id: `tx-life-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
                    amount: d.payload.amount,
                    category: 'general',
                    note: d.payload.note || `${char.name}代記`,
                    timestamp: Date.now(),
                    dateStr: today,
                };
                await DB.saveTransaction(tx);
                bankTxId = tx.id;
            }

            const record: LifeRecord = {
                id: `life-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
                module: d.module, kind: d.kind, date: today, timestamp: Date.now(),
                payload: d.payload,
                recordedBy: char.id, recordedByName: char.name,
                reviewStatus: 'active',
                ...(bankTxId ? { bankTxId } : {}),
            };
            await DB.saveLifeRecord(record);

            await DB.saveMessage({
                ...stamp,
                charId: char.id, role: 'assistant', type: 'life_card',
                content: `[生活記錄：${summary}]`,
                metadata: withInherited({
                    recordId: record.id, module: d.module, kind: d.kind, summary,
                    dateStr: today, recordedByName: char.name, reviewStatus: 'active',
                }),
            });
            addToast(`${char.name} 幫你記錄了「${summary}」`, 'success');
        } catch (e) {
            console.error('[LifeRecord] directive failed:', verb, e);
        }
    }

    // 同類殘留 tag 全清（包括格式沒匹配上主正則的畸形 tag）
    return content.replace(LIFE_TAG_GLOBAL_RE, '').trim();
};

// ═══════════════════════════════════════════════════════════
// 3. 卡片裁決（Chat.tsx 調用）
// ═══════════════════════════════════════════════════════════

/**
 * 用戶點卡片「確認 / 否決」。
 * 否決：記錄標記 rejected（不再計入注入摘要）+ 欠角色一條一次性反饋；
 *       expense 同時回滾刪除對應銀行流水。
 */
export const resolveLifeRecordCard = async (
    msg: Message,
    action: 'confirmed' | 'rejected',
): Promise<void> => {
    const recordId: string | undefined = msg.metadata?.recordId;
    if (recordId) {
        const record = await DB.getLifeRecordById(recordId);
        if (record && record.reviewStatus !== action) {
            if (action === 'rejected' && record.bankTxId) {
                await DB.deleteTransaction(record.bankTxId).catch(() => {});
            }
            await DB.saveLifeRecord({
                ...record,
                reviewStatus: action,
                pendingFeedback: action === 'rejected' ? true : record.pendingFeedback,
            });
        }
    }
    await DB.updateMessageMetadata(msg.id, (prev: any) => ({
        ...(prev || {}), reviewStatus: action, resolvedAt: Date.now(),
    }));
};
