
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { BankTransaction, LifeRecord, LifeRecordModule, LifeRecordSettings, MedPlan } from '../../types';
import {
    DEFAULT_CYCLE_LENGTH, DEFAULT_PERIOD_LENGTH, computePeriodStatus, getPeriodIntervals,
    isMedPlanDueToday, lifeAddDays, medFreqLabel, weekStartOf,
} from '../../utils/lifeRecords';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { markAmsgStateDirtyForAll } from '../../utils/amsgStateSync';
import { formatMoney, sumMoney } from '../../utils/format';

/**
 * 檔案 App「生活記錄」面板 —— 復古優雅淺色系，但四個模塊各有獨立版式：
 *  - 生理期（CYCLE）  ：柔圓卡 + 狀態徽章 + 可展開小日曆（點日期可補記/清除，含排卵期預測）
 *  - 藥盒（PHARMACY） ：藥籤脊條卡 —— 長期鬧鐘式計劃（每天/隔N天；長期 vs 短期療程），每天只列"今日待服"
 *  - 記帳（LEDGER）   ：帳簿雙欄線 + 右對齊襯線數字（與銀行同一本帳）
 *  - 鍛鍊（TRAINING） ：車票虛線框 —— 每週規劃（目標次數 + 文字計劃，注入給角色監督執行）+ 打卡
 *
 * 長按模塊頁籤 →「是否不需要這個功能？」→ 全局隱藏（前端不顯示 + 斷掉對所有角色的注入與代記）。
 */

const SERIF = "'Noto Serif SC','Source Han Serif SC','Songti SC','SimSun',Georgia,serif";
const INK = '#4a4039';
const FADE = '#8b8378';
const FAINT = '#b3aca1';

interface ModuleTheme {
    cn: string;           // 頁籤中文名（直白命名）
    en: string;
    accent: string;
    deep: string;
    soft: string;
    paper: string;
    icon: React.ReactNode;
}

const iconStroke = (accent: string): React.SVGProps<SVGSVGElement> => ({
    viewBox: '0 0 24 24', fill: 'none', stroke: accent, strokeWidth: 1.6,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    width: 17, height: 17,
});

const THEMES: Record<LifeRecordModule, ModuleTheme> = {
    period: {
        cn: '生理期', en: 'CYCLE', accent: '#a34a5e', deep: '#7d3646', soft: '#e7c3ca',
        paper: 'linear-gradient(160deg,#fdf8f6 0%,#faeef0 100%)',
        icon: <svg {...iconStroke('#a34a5e')}><circle cx="12" cy="12" r="8.2" /><path d="M12 7.5v4.5l3 2" /></svg>,
    },
    med: {
        cn: '藥盒', en: 'PHARMACY', accent: '#3e7c6f', deep: '#2e5f55', soft: '#bfdcd3',
        paper: 'linear-gradient(160deg,#f7fbf8 0%,#eaf4ef 100%)',
        icon: <svg {...iconStroke('#3e7c6f')}><path d="M9.5 3h5M10 3v4.2L5.8 14a4.6 4.6 0 0 0 4 7h4.4a4.6 4.6 0 0 0 4-7L14 7.2V3M7.5 15.5h9" /></svg>,
    },
    expense: {
        cn: '記帳', en: 'LEDGER', accent: '#9a7433', deep: '#775724', soft: '#e2d0a8',
        paper: 'linear-gradient(160deg,#fdfaf2 0%,#f8f1de 100%)',
        icon: <svg {...iconStroke('#9a7433')}><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5v15A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-15ZM9 3v18M12.5 8h3.5M12.5 12h3.5" /></svg>,
    },
    exercise: {
        cn: '鍛鍊', en: 'TRAINING', accent: '#5d7345', deep: '#465936', soft: '#ccd8b6',
        paper: 'linear-gradient(160deg,#f9fbf3 0%,#eef4e2 100%)',
        icon: <svg {...iconStroke('#5d7345')}><path d="M7 8v8M4.5 10v4M17 8v8M19.5 10v4M7 12h10" /></svg>,
    },
};

const MODULE_ORDER: LifeRecordModule[] = ['period', 'med', 'expense', 'exercise'];

const fmtCN = (s: string): string => {
    const p = (s || '').split('-');
    return p.length === 3 ? `${parseInt(p[1], 10)}月${parseInt(p[2], 10)}日` : s;
};
const fmtMD = (s: string): string => {
    const p = (s || '').split('-');
    return p.length === 3 ? `${parseInt(p[1], 10)}/${parseInt(p[2], 10)}` : s;
};

const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

// ─── 裝飾組件：每個模塊一種畫框，拉開版式差異 ───

/** 生理期：柔圓無角飾，頂部一道弧形漸暈 */
const SoftCard: React.FC<{ theme: ModuleTheme; children: React.ReactNode; className?: string }> = ({ theme, children, className }) => (
    <div className={`relative overflow-hidden rounded-[22px] p-[18px] ${className || ''}`}
        style={{ background: theme.paper, border: `1px solid ${theme.soft}`, boxShadow: `0 14px 30px -20px ${theme.accent}66` }}>
        <div aria-hidden className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 w-[130%] h-20 rounded-[100%]"
            style={{ background: `radial-gradient(ellipse at center, ${theme.accent}14 0%, transparent 70%)` }} />
        {children}
    </div>
);

/** 藥盒：左側藥籤脊條 */
const LabelCard: React.FC<{ theme: ModuleTheme; children: React.ReactNode; className?: string }> = ({ theme, children, className }) => (
    <div className={`relative rounded-[6px] p-[18px] pl-[22px] ${className || ''}`}
        style={{ background: theme.paper, border: `1px solid ${theme.soft}`, boxShadow: `0 10px 24px -18px ${theme.accent}66` }}>
        <span aria-hidden className="absolute left-0 top-3 bottom-3 w-[5px] rounded-r"
            style={{ background: `linear-gradient(${theme.accent}, ${theme.soft})`, opacity: 0.75 }} />
        {children}
    </div>
);

/** 記帳：帳簿式上下雙細線 */
const LedgerCard: React.FC<{ theme: ModuleTheme; children: React.ReactNode; className?: string }> = ({ theme, children, className }) => (
    <div className={`relative p-[18px] ${className || ''}`}
        style={{
            background: theme.paper,
            borderTop: `2.5px double ${theme.accent}88`,
            borderBottom: `2.5px double ${theme.accent}88`,
            borderLeft: `1px solid ${theme.soft}`,
            borderRight: `1px solid ${theme.soft}`,
            boxShadow: `0 10px 24px -18px ${theme.accent}66`,
        }}>
        {children}
    </div>
);

/** 鍛鍊：車票虛線框 + 兩側半圓缺口 */
const TicketCard: React.FC<{ theme: ModuleTheme; children: React.ReactNode; className?: string }> = ({ theme, children, className }) => (
    <div className={`relative rounded-[10px] p-[3px] ${className || ''}`} style={{ background: `${theme.soft}55` }}>
        <span aria-hidden className="absolute left-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full" style={{ background: '#f6f3ec' }} />
        <span aria-hidden className="absolute right-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full" style={{ background: '#f6f3ec' }} />
        <div className="rounded-[8px] p-[15px]" style={{ background: theme.paper, border: `1.5px dashed ${theme.accent}66` }}>
            {children}
        </div>
    </div>
);

const SectionHead: React.FC<{ theme: ModuleTheme; cn: string; en?: string }> = ({ theme, cn, en }) => (
    <div className="mb-3.5">
        {en && (
            <div className="text-center text-[8px] font-semibold mb-0.5"
                style={{ color: theme.accent, opacity: 0.55, letterSpacing: '0.4em', textIndent: '0.4em' }}>
                {en}
            </div>
        )}
        <div className="flex items-center gap-3">
            <span className="flex-1 h-px" style={{ background: `linear-gradient(to right, transparent, ${theme.soft})` }} />
            <span className="text-[13px] font-bold" style={{ fontFamily: SERIF, color: INK }}>{cn}</span>
            <span className="flex-1 h-px" style={{ background: `linear-gradient(to left, transparent, ${theme.soft})` }} />
        </div>
    </div>
);

const RecordDateBar: React.FC<{
    theme: ModuleTheme;
    date: string;
    today: string;
    onChange: (date: string) => void;
}> = ({ theme, date, today, onChange }) => {
    const isToday = date === today;
    const isYesterday = date === lifeAddDays(today, -1);
    const label = isToday ? '今天' : isYesterday ? '昨天' : fmtCN(date);
    return (
        <div className="rounded-[10px] px-3.5 py-3"
            style={{ background: theme.paper, border: `1px solid ${theme.soft}`, boxShadow: `0 8px 20px -18px ${theme.accent}66` }}>
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <div className="text-[8px] font-semibold mb-0.5" style={{ color: theme.accent, letterSpacing: '0.28em' }}>記錄日期</div>
                    <div className="text-[12px] font-bold" style={{ color: INK, fontFamily: SERIF }}>
                        {label}{!isToday && <span className="text-[9px] font-normal ml-1.5" style={{ color: theme.accent }}>補記模式</span>}
                    </div>
                </div>
                <button type="button" aria-label="前一天" onClick={() => onChange(lifeAddDays(date, -1))}
                    className="w-7 h-7 rounded-full text-[15px] active:scale-90 transition-transform"
                    style={{ color: theme.accent, border: `1px solid ${theme.soft}`, background: '#ffffff88' }}>‹</button>
                <input
                    type="date"
                    value={date}
                    max={today}
                    onChange={(event) => {
                        const next = event.target.value;
                        if (next) onChange(next > today ? today : next);
                    }}
                    className="min-w-0 w-[118px] bg-white/70 rounded-[6px] px-2 py-1.5 text-[10px] outline-none"
                    style={{ color: INK, border: `1px solid ${theme.soft}`, fontFamily: SERIF }}
                />
                <button type="button" aria-label="後一天" disabled={isToday}
                    onClick={() => onChange(lifeAddDays(date, 1) > today ? today : lifeAddDays(date, 1))}
                    className="w-7 h-7 rounded-full text-[15px] active:scale-90 transition-transform disabled:opacity-25"
                    style={{ color: theme.accent, border: `1px solid ${theme.soft}`, background: '#ffffff88' }}>›</button>
            </div>
            {!isToday && (
                <div className="flex items-center justify-between gap-2 mt-2 pt-2" style={{ borderTop: `1px dashed ${theme.soft}` }}>
                    <span className="text-[9px]" style={{ color: FADE, fontFamily: SERIF }}>新增內容會記到 {fmtCN(date)}</span>
                    <button type="button" onClick={() => onChange(today)}
                        className="text-[9px] font-bold px-2.5 py-1 rounded-full active:scale-95 transition-transform"
                        style={{ color: theme.deep, background: `${theme.accent}12`, border: `1px solid ${theme.accent}44`, fontFamily: SERIF }}>
                        回到今天
                    </button>
                </div>
            )}
        </div>
    );
};

const inkInputCls = 'bg-transparent border-0 outline-none text-xs px-1 py-1.5 transition-colors placeholder:text-slate-300';
const inkInputStyle = (theme: ModuleTheme): React.CSSProperties => ({
    borderBottom: `1px solid ${theme.soft}`, fontFamily: SERIF, color: INK, borderRadius: 0,
});

const useLongPress = (onLongPress: () => void, ms = 600) => {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const origin = useRef({ x: 0, y: 0 });
    const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
    useEffect(() => clear, []);
    return {
        onPointerDown: (e: React.PointerEvent) => {
            origin.current = { x: e.clientX, y: e.clientY };
            clear();
            timer.current = setTimeout(onLongPress, ms);
        },
        onPointerMove: (e: React.PointerEvent) => {
            if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 12) clear();
        },
        onPointerUp: clear,
        onPointerLeave: clear,
        onPointerCancel: clear,
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    };
};

const ModuleTab: React.FC<{
    module: LifeRecordModule;
    active: boolean;
    onSelect: () => void;
    onRequestHide: () => void;
}> = ({ module, active, onSelect, onRequestHide }) => {
    const theme = THEMES[module];
    const longPress = useLongPress(onRequestHide);
    return (
        <button
            {...longPress}
            onClick={onSelect}
            className="flex-1 select-none touch-manipulation flex flex-col items-center gap-1 pt-2.5 pb-2 rounded-[4px] transition-all active:scale-[0.97]"
            style={active ? {
                background: theme.paper,
                border: `1px solid ${theme.soft}`,
                boxShadow: `0 8px 18px -12px ${theme.accent}66, inset 0 0 0 1px #ffffffa0`,
            } : {
                background: 'transparent',
                border: '1px solid transparent',
                opacity: 0.55,
            }}
        >
            {theme.icon}
            <span className="text-[11px] font-bold leading-none" style={{ fontFamily: SERIF, color: active ? theme.accent : FADE }}>
                {theme.cn}
            </span>
            <span className="text-[7px] font-semibold leading-none" style={{ letterSpacing: '0.2em', textIndent: '0.2em', color: active ? theme.accent : FAINT, opacity: 0.7 }}>
                {theme.en}
            </span>
            <span aria-hidden className="h-[2px] w-5 rounded-full mt-0.5"
                style={{ background: active ? theme.accent : 'transparent', opacity: 0.65 }} />
        </button>
    );
};

// ─── 主面板 ───

const LifeRecordPanel: React.FC = () => {
    const { addToast, characters, userProfileBase, groups, realtimeConfig } = useOS();
    const [tab, setTab] = useState<LifeRecordModule>('period');
    const [records, setRecords] = useState<LifeRecord[]>([]);
    const [plans, setPlans] = useState<MedPlan[]>([]);
    const [settings, setSettings] = useState<LifeRecordSettings | null>(null);
    const [txs, setTxs] = useState<BankTransaction[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [hideCandidate, setHideCandidate] = useState<LifeRecordModule | null>(null);
    const [showRestore, setShowRestore] = useState(false);

    const today = useLocalDateKey();
    const [recordDate, setRecordDate] = useState(today);
    const recordDateLabel = recordDate === today
        ? '今日'
        : recordDate === lifeAddDays(today, -1)
            ? '昨日'
            : fmtCN(recordDate);
    const recordMonthLabel = recordDate.slice(0, 7) === today.slice(0, 7)
        ? '本月累計'
        : `${parseInt(recordDate.slice(0, 4), 10)}年${parseInt(recordDate.slice(5, 7), 10)}月累計`;

    useEffect(() => {
        setRecordDate(current => current > today ? today : current);
    }, [today]);

    /**
     * 重新讀庫刷新面板。面板裡每個寫庫點寫完都調它，所以順帶在這裡給主動消息 2.0 打髒：
     * 生活記錄（生理期 / 藥盒 / 記帳 / 鍛鍊）會注入給所有開了開關的角色，改完不刷雲端的話，
     * 角色到點還照著改之前那份說話（比如藥已經停了還催你吃）。
     * 首次進面板只是讀，不算改動，所以 mutated 傳 false。
     */
    const reload = async (mutated = true) => {
        const [r, p, s, t] = await Promise.all([
            DB.getAllLifeRecords().catch(() => [] as LifeRecord[]),
            DB.getAllMedPlans().catch(() => [] as MedPlan[]),
            DB.getLifeRecordSettings().catch(() => null),
            DB.getAllTransactions().catch(() => [] as BankTransaction[]),
        ]);
        setRecords(r.sort((a, b) => b.timestamp - a.timestamp));
        setPlans(p.sort((a, b) => a.time.localeCompare(b.time)));
        setSettings(s);
        setTxs(t.sort((a, b) => b.timestamp - a.timestamp));
        setLoaded(true);
        if (mutated) markAmsgStateDirtyForAll({ characters, userProfileBase, groups, realtimeConfig });
    };
    useEffect(() => { reload(false); }, []);

    const saveSettings = async (patch: Partial<LifeRecordSettings>) => {
        await DB.saveLifeRecordSettings({ id: 'main', ...(settings || {}), ...patch });
        await reload();
    };

    const hiddenModules = useMemo(() => settings?.hiddenModules || [], [settings]);
    const visibleModules = useMemo(() => MODULE_ORDER.filter(m => !hiddenModules.includes(m)), [hiddenModules]);

    useEffect(() => {
        if (hiddenModules.includes(tab) && visibleModules.length > 0) setTab(visibleModules[0]);
    }, [hiddenModules, tab, visibleModules]);

    const confirmHide = async (m: LifeRecordModule) => {
        const next = Array.from(new Set([...(settings?.hiddenModules || []), m]));
        await saveSettings({ hiddenModules: next });
        setHideCandidate(null);
        addToast('已隱藏，該功能不會再注入給任何角色', 'success');
    };

    const restoreModule = async (m: LifeRecordModule) => {
        await saveSettings({ hiddenModules: (settings?.hiddenModules || []).filter(x => x !== m) });
        addToast(`已恢復「${THEMES[m].cn}」`, 'success');
    };

    const effectiveRecords = useMemo(() => records.filter(r => r.reviewStatus !== 'rejected'), [records]);

    const addUserRecord = async (module: LifeRecordModule, kind: string, payload: Record<string, any>, extra?: Partial<LifeRecord>) => {
        const rec: LifeRecord = {
            id: newId('life'),
            module, kind, date: today, timestamp: Date.now(),
            payload,
            recordedBy: 'user',
            reviewStatus: 'confirmed',
            ...extra,
        };
        await DB.saveLifeRecord(rec);
        await reload();
        return rec;
    };

    const removeRecord = async (rec: LifeRecord) => {
        if (rec.bankTxId) await DB.deleteTransaction(rec.bankTxId).catch(() => {});
        await DB.deleteLifeRecord(rec.id);
        await reload();
        addToast('記錄已刪除', 'success');
    };

    const recordedByLabel = (r: LifeRecord) => r.recordedBy === 'user' ? '' : ` · ${r.recordedByName || '角色'}代記`;

    // ─── 生理期 ───
    const periodStatus = useMemo(() => computePeriodStatus(records, settings, today), [records, settings, today]);
    const periodIntervals = useMemo(() => getPeriodIntervals(records, today), [records, today]);
    const [calOpen, setCalOpen] = useState(false);
    const [calMonth, setCalMonth] = useState(() => today.slice(0, 7)); // 'YYYY-MM'
    const [daySheet, setDaySheet] = useState<string | null>(null);    // 點中的日期

    const periodDaySet = useMemo(() => {
        const set = new Set<string>();
        periodIntervals.forEach(iv => {
            for (let d = iv.start; d <= iv.end; d = lifeAddDays(d, 1)) set.add(d);
        });
        return set;
    }, [periodIntervals]);

    const predictedDaySet = useMemo(() => {
        const set = new Set<string>();
        if (periodStatus.nextPredicted && !periodStatus.inPeriod) {
            const span = settings?.periodLength || DEFAULT_PERIOD_LENGTH;
            for (let i = 0; i < span; i++) set.add(lifeAddDays(periodStatus.nextPredicted, i));
        }
        return set;
    }, [periodStatus, settings]);

    const ovulationDaySet = useMemo(() => {
        const set = new Set<string>();
        if (periodStatus.ovulationStart && periodStatus.ovulationEnd) {
            for (let d = periodStatus.ovulationStart; d <= periodStatus.ovulationEnd; d = lifeAddDays(d, 1)) set.add(d);
        }
        return set;
    }, [periodStatus]);

    const handlePeriodToggle = async () => {
        if (periodStatus.inPeriod) {
            await addUserRecord('period', 'end', {});
            addToast('已記錄：生理期結束', 'success');
        } else {
            await addUserRecord('period', 'start', {});
            addToast('已記錄：生理期開始', 'success');
        }
    };

    /** 日曆補記：把某天記為開始/結束，或清掉該天的生理期記錄 */
    const backfillPeriod = async (date: string, kind: 'start' | 'end') => {
        await addUserRecord('period', kind, {}, { date });
        setDaySheet(null);
        addToast(`已補記：${fmtCN(date)} 生理期${kind === 'start' ? '開始' : '結束'}`, 'success');
    };
    const clearPeriodDay = async (date: string) => {
        const hits = records.filter(r => r.module === 'period' && r.date === date);
        for (const h of hits) await DB.deleteLifeRecord(h.id);
        await reload();
        setDaySheet(null);
        addToast(`已清除 ${fmtCN(date)} 的生理期記錄`, 'success');
    };

    /** 當前展示月份的日曆格（週一起始） */
    const calendarCells = useMemo(() => {
        const [y, m] = calMonth.split('-').map(n => parseInt(n, 10));
        const first = `${calMonth}-01`;
        const firstDow = new Date(`${first}T00:00:00Z`).getUTCDay(); // 0=週日
        const lead = (firstDow + 6) % 7; // 週一起始的前置空格
        const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const cells: (string | null)[] = Array.from({ length: lead }, () => null);
        for (let d = 1; d <= daysInMonth; d++) cells.push(`${calMonth}-${String(d).padStart(2, '0')}`);
        while (cells.length % 7 !== 0) cells.push(null);
        return cells;
    }, [calMonth]);

    const shiftMonth = (delta: number) => {
        const [y, m] = calMonth.split('-').map(n => parseInt(n, 10));
        const d = new Date(Date.UTC(y, m - 1 + delta, 1));
        setCalMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    };

    const handleCycleChange = async (v: string) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 15 || n > 90) return;
        await saveSettings({ cycleLength: n });
    };

    // ─── 藥盒 ───
    const [planName, setPlanName] = useState('');
    const [planTime, setPlanTime] = useState('08:00');
    const [planDosage, setPlanDosage] = useState('');
    const [planKind, setPlanKind] = useState<'longterm' | 'course'>('longterm');
    const [planInterval, setPlanInterval] = useState(1);
    const [planStart, setPlanStart] = useState(today);
    const [planEnd, setPlanEnd] = useState(today);

    const dayMeds = useMemo(
        () => effectiveRecords.filter(r => r.module === 'med' && r.date === recordDate),
        [effectiveRecords, recordDate],
    );
    const duePlans = useMemo(() => plans.filter(p => isMedPlanDueToday(p, recordDate)), [plans, recordDate]);
    const longtermPlans = useMemo(() => plans.filter(p => (p.planKind || 'longterm') === 'longterm'), [plans]);
    const coursePlans = useMemo(() => plans.filter(p => p.planKind === 'course'), [plans]);

    const handleAddPlan = async () => {
        if (!planName.trim()) { addToast('先填藥名哦', 'error'); return; }
        if (planKind === 'course' && planEnd < planStart) { addToast('療程結束日期要晚於開始哦', 'error'); return; }
        await DB.saveMedPlan({
            id: newId('med'), name: planName.trim(), time: planTime,
            dosage: planDosage.trim() || undefined, enabled: true, createdAt: Date.now(),
            planKind, intervalDays: planInterval,
            startDate: planStart,
            ...(planKind === 'course' ? { endDate: planEnd } : {}),
        });
        setPlanName(''); setPlanDosage('');
        await reload();
        addToast('已加入藥盒，之後每天自動出現在待服清單', 'success');
    };

    const planTakenRecord = (p: MedPlan) =>
        dayMeds.find(r => (r.payload.planId && r.payload.planId === p.id) || r.payload.name === p.name);

    const handleTogglePlanTaken = async (p: MedPlan) => {
        const taken = planTakenRecord(p);
        if (taken) {
            await DB.deleteLifeRecord(taken.id);
            await reload();
        } else {
            await addUserRecord('med', 'taken', { name: p.name, planId: p.id, time: p.time }, { date: recordDate });
            addToast(recordDate === today ? `已打卡：${p.name}` : `已補記：${fmtCN(recordDate)} ${p.name}`, 'success');
        }
    };

    const renderPlanRow = (p: MedPlan) => (
        <div key={p.id} className="flex items-center gap-2 text-[11px] py-1.5"
            style={{ fontFamily: SERIF, opacity: p.enabled ? 1 : 0.45, borderBottom: `1px dashed ${THEMES.med.soft}` }}>
            <span className="tabular-nums w-10 shrink-0" style={{ color: THEMES.med.accent }}>{p.time}</span>
            <span className="flex-1 min-w-0 truncate font-medium" style={{ color: INK }}>
                {p.name}{p.dosage ? ` · ${p.dosage}` : ''}
                <span className="text-[9px] ml-1" style={{ color: FAINT }}>
                    {medFreqLabel(p)}{p.planKind === 'course' && p.endDate ? ` · ${fmtMD(p.startDate || '')}~${fmtMD(p.endDate)}` : ''}
                </span>
            </span>
            <button
                onClick={async () => { await DB.saveMedPlan({ ...p, enabled: !p.enabled }); await reload(); }}
                className="text-[9px] px-2 py-0.5 rounded-full shrink-0"
                style={p.enabled
                    ? { color: THEMES.med.accent, border: `1px solid ${THEMES.med.accent}55` }
                    : { color: FAINT, border: '1px solid #e5ddcd' }}
            >
                {p.enabled ? '啟用' : '停用'}
            </button>
            <button onClick={async () => { await DB.deleteMedPlan(p.id); await reload(); }} className="px-1 text-slate-300 hover:text-rose-400 shrink-0">✕</button>
        </div>
    );

    // ─── 記帳（銀行同一本帳） ───
    const [txAmount, setTxAmount] = useState('');
    const [txNote, setTxNote] = useState('');
    const dayTxs = useMemo(() => txs.filter(t => t.dateStr === recordDate), [txs, recordDate]);
    const dayTotal = useMemo(() => sumMoney(dayTxs.map(t => t.amount)), [dayTxs]);
    const monthTotal = useMemo(() => {
        const monthKey = recordDate.slice(0, 7);
        return sumMoney(txs.filter(t => (t.dateStr || '').startsWith(monthKey)).map(t => t.amount));
    }, [txs, recordDate]);

    const handleAddTx = async () => {
        const amount = parseFloat(txAmount);
        if (isNaN(amount) || amount <= 0 || !txNote.trim()) { addToast('請填寫金額和用途哦', 'error'); return; }
        await DB.saveTransaction({
            id: newId('tx-life'), amount, category: 'general',
            note: txNote.trim(), timestamp: Date.now(), dateStr: recordDate,
        });
        setTxAmount(''); setTxNote('');
        await reload();
        addToast(recordDate === today ? '記帳成功' : `已補記到 ${fmtCN(recordDate)}`, 'success');
    };

    // ─── 鍛鍊 ───
    const [exActivity, setExActivity] = useState('');
    const [exDuration, setExDuration] = useState('');
    const exerciseRecords = useMemo(() => effectiveRecords.filter(r => r.module === 'exercise'), [effectiveRecords]);
    const weekStart = useMemo(() => weekStartOf(recordDate), [recordDate]);
    const weekEnd = useMemo(() => lifeAddDays(weekStart, 6), [weekStart]);
    const weekSessions = useMemo(
        () => exerciseRecords.filter(r => r.date >= weekStart && r.date <= weekEnd).length,
        [exerciseRecords, weekStart, weekEnd],
    );
    const weekGoal = settings?.exerciseWeeklyGoal || 0;
    const weekDots = useMemo(() => {
        const names = ['一', '二', '三', '四', '五', '六', '日'];
        const done = new Set(exerciseRecords.map(r => r.date));
        return Array.from({ length: 7 }, (_, i) => {
            const ds = lifeAddDays(weekStart, i);
            return { date: ds, done: done.has(ds), label: names[i], future: ds > today };
        });
    }, [exerciseRecords, weekStart, today]);

    const handleAddExercise = async () => {
        if (!exActivity.trim()) { addToast('先填運動項目哦', 'error'); return; }
        await addUserRecord('exercise', 'session', {
            activity: exActivity.trim(),
            ...(exDuration.trim() ? { duration: exDuration.trim() } : {}),
        }, { date: recordDate });
        setExActivity(''); setExDuration('');
        addToast(recordDate === today ? '已記錄鍛鍊' : `已補記：${fmtCN(recordDate)} 鍛鍊`, 'success');
    };

    if (!loaded) return <div className="py-16 text-center text-xs text-slate-300" style={{ fontFamily: SERIF }}>翻開記事簿…</div>;

    const accentBtn = (t: ModuleTheme): React.CSSProperties => ({
        background: t.accent, color: '#fdfbf7', fontFamily: SERIF,
        boxShadow: `0 8px 16px -8px ${t.accent}99, inset 0 0 0 1px #ffffff30`,
    });

    return (
        <div className="space-y-4">
            {visibleModules.length > 0 && (
                <div className="flex gap-1.5 rounded-[6px] p-1.5"
                    style={{ background: '#f2ede4', border: '1px solid #e5ddcd', boxShadow: 'inset 0 1px 3px #0000000a' }}>
                    {visibleModules.map(m => (
                        <ModuleTab
                            key={m}
                            module={m}
                            active={tab === m}
                            onSelect={() => setTab(m)}
                            onRequestHide={() => setHideCandidate(m)}
                        />
                    ))}
                </div>
            )}

            {tab !== 'period' && visibleModules.includes(tab) && (
                <RecordDateBar
                    theme={THEMES[tab]}
                    date={recordDate}
                    today={today}
                    onChange={setRecordDate}
                />
            )}

            {visibleModules.length === 0 && (
                <LedgerCard theme={THEMES.expense} className="text-center py-10">
                    <div className="text-2xl mb-2" style={{ color: FAINT }}>❧</div>
                    <p className="text-xs" style={{ fontFamily: SERIF, color: FADE }}>所有功能均已隱藏</p>
                </LedgerCard>
            )}

            {/* ═══ 生理期 ═══ */}
            {tab === 'period' && visibleModules.includes('period') && (
                <>
                    <SoftCard theme={THEMES.period}>
                        <SectionHead theme={THEMES.period} cn="生理期" en="CYCLE" />
                        <div className="relative text-center py-1">
                            {periodStatus.inPeriod ? (
                                <>
                                    <div className="text-[10px] mb-1.5" style={{ color: THEMES.period.accent, opacity: 0.75, fontFamily: SERIF }}>
                                        {fmtCN(periodStatus.lastStart!)} 開始
                                    </div>
                                    <div style={{ fontFamily: SERIF, color: THEMES.period.accent }}>
                                        <span className="text-sm align-[0.5em] mr-1">第</span>
                                        <span className="text-[44px] font-bold leading-none tracking-tight">{periodStatus.dayN}</span>
                                        <span className="text-sm align-[0.5em] ml-1">天</span>
                                    </div>
                                    <div className="text-[10px] mt-2" style={{ color: FADE }}>生理期進行中 · 對自己好一點</div>
                                </>
                            ) : periodStatus.lastStart ? (
                                <>
                                    <div className="text-[15px] font-bold" style={{ fontFamily: SERIF, color: INK }}>當前不在生理期</div>
                                    <div className="text-[10px] mt-1" style={{ color: FADE }}>
                                        上次 {fmtCN(periodStatus.lastStart)}{periodStatus.lastEnd ? ` ～ ${fmtCN(periodStatus.lastEnd)}` : ''}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="text-[15px] font-bold" style={{ fontFamily: SERIF, color: INK }}>尚無記錄</div>
                                    <div className="text-[10px] mt-1.5" style={{ color: FADE }}>來了就點下面記一筆；以前的可以在日曆裡補</div>
                                </>
                            )}

                            {/* 預測徽章：下次生理期 / 排卵期（日曆法估算，只作身體週期信息） */}
                            {periodStatus.lastStart && !periodStatus.inPeriod && periodStatus.daysUntilNext !== undefined && (
                                <div className="flex flex-wrap justify-center gap-1.5 mt-3">
                                    {periodStatus.daysUntilNext >= 0 ? (
                                        <span className="text-[9px] px-2.5 py-1 rounded-full" style={{ fontFamily: SERIF, color: THEMES.period.deep, background: `${THEMES.period.accent}14`, border: `1px solid ${THEMES.period.soft}` }}>
                                            下次 {fmtCN(periodStatus.nextPredicted!)} · {periodStatus.daysUntilNext}天后
                                        </span>
                                    ) : (
                                        <span className="text-[9px] px-2.5 py-1 rounded-full" style={{ fontFamily: SERIF, color: THEMES.period.deep, background: `${THEMES.period.accent}14`, border: `1px solid ${THEMES.period.soft}` }}>
                                            比預測晚了 {-periodStatus.daysUntilNext} 天
                                        </span>
                                    )}
                                    {periodStatus.ovulationDate && periodStatus.ovulationEnd! >= today && (
                                        <span className="text-[9px] px-2.5 py-1 rounded-full" style={{ fontFamily: SERIF, color: '#8a6a2f', background: '#f4e9d2aa', border: '1px solid #e2d0a8' }}>
                                            排卵期約 {fmtMD(periodStatus.ovulationStart!)}~{fmtMD(periodStatus.ovulationEnd!)}
                                        </span>
                                    )}
                                </div>
                            )}

                            <button
                                onClick={handlePeriodToggle}
                                className="mt-4 px-9 py-2.5 rounded-full text-[13px] font-bold active:scale-95 transition-transform"
                                style={accentBtn(THEMES.period)}
                            >
                                {periodStatus.inPeriod ? '記錄結束' : '記錄開始'}
                            </button>
                        </div>

                        <div className="relative mt-4 pt-3 flex items-center justify-between"
                            style={{ borderTop: `1px dashed ${THEMES.period.soft}` }}>
                            <span className="text-[10px]" style={{ color: FADE, fontFamily: SERIF }}>平均週期（用於預測）</span>
                            <span className="flex items-baseline gap-1">
                                <input
                                    type="number"
                                    defaultValue={settings?.cycleLength || DEFAULT_CYCLE_LENGTH}
                                    onBlur={(e) => handleCycleChange(e.target.value)}
                                    className="w-12 text-center bg-transparent outline-none text-sm font-bold"
                                    style={{ fontFamily: SERIF, color: THEMES.period.accent, borderBottom: `1px solid ${THEMES.period.soft}` }}
                                />
                                <span className="text-[10px]" style={{ color: FADE }}>天</span>
                            </span>
                        </div>
                    </SoftCard>

                    {/* 可展開小日曆：補記 / 清除 / 看預測 */}
                    <SoftCard theme={THEMES.period}>
                        <button onClick={() => setCalOpen(o => !o)} className="w-full flex items-center justify-between">
                            <span className="text-[12px] font-bold" style={{ fontFamily: SERIF, color: INK }}>週期日曆</span>
                            <span className="text-[10px]" style={{ color: FADE, fontFamily: SERIF }}>
                                {calOpen ? '收起 ▴' : '展開 · 可補記以前的日子 ▾'}
                            </span>
                        </button>
                        {calOpen && (
                            <div className="mt-3">
                                <div className="flex items-center justify-between mb-2">
                                    <button onClick={() => shiftMonth(-1)} className="px-2.5 py-1 text-[12px]" style={{ color: THEMES.period.accent }}>‹</button>
                                    <span className="text-[12px] font-bold tabular-nums" style={{ fontFamily: SERIF, color: INK }}>
                                        {parseInt(calMonth.split('-')[0], 10)}年{parseInt(calMonth.split('-')[1], 10)}月
                                    </span>
                                    <button onClick={() => shiftMonth(1)} className="px-2.5 py-1 text-[12px]" style={{ color: THEMES.period.accent }}>›</button>
                                </div>
                                <div className="grid grid-cols-7 gap-y-1 text-center mb-1">
                                    {['一', '二', '三', '四', '五', '六', '日'].map(w => (
                                        <span key={w} className="text-[8px]" style={{ color: FAINT, fontFamily: SERIF }}>{w}</span>
                                    ))}
                                </div>
                                <div className="grid grid-cols-7 gap-y-1.5 text-center">
                                    {calendarCells.map((d, i) => {
                                        if (!d) return <span key={`e${i}`} />;
                                        const isPeriod = periodDaySet.has(d);
                                        const isPred = predictedDaySet.has(d);
                                        const isOvu = d === periodStatus.ovulationDate;
                                        const isOvuWindow = ovulationDaySet.has(d) && !isPeriod;
                                        const isToday = d === today;
                                        const clickable = d <= today;
                                        return (
                                            <button
                                                key={d}
                                                disabled={!clickable}
                                                onClick={() => setDaySheet(d)}
                                                className="relative mx-auto w-7 h-7 rounded-full flex items-center justify-center text-[10px] tabular-nums transition-transform active:scale-90"
                                                style={{
                                                    fontFamily: SERIF,
                                                    color: isPeriod ? '#fdfbf7' : isOvu ? '#8a6a2f' : clickable ? INK : FAINT,
                                                    background: isPeriod ? THEMES.period.accent : isOvuWindow ? '#f4e9d2aa' : 'transparent',
                                                    border: isPred ? `1.5px dashed ${THEMES.period.accent}88`
                                                        : isOvu ? '1.5px solid #cfa75f'
                                                        : isToday ? `1.5px solid ${THEMES.period.soft}` : '1.5px solid transparent',
                                                    fontWeight: isToday || isPeriod ? 700 : 400,
                                                    opacity: clickable || isPred || isOvu || isOvuWindow ? 1 : 0.45,
                                                }}
                                            >
                                                {parseInt(d.split('-')[2], 10)}
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-3 text-[8px]" style={{ color: FADE, fontFamily: SERIF }}>
                                    <span><span className="inline-block w-2 h-2 rounded-full align-[-1px] mr-1" style={{ background: THEMES.period.accent }} />生理期</span>
                                    <span><span className="inline-block w-2 h-2 rounded-full align-[-1px] mr-1" style={{ border: `1.5px dashed ${THEMES.period.accent}88` }} />預測</span>
                                    <span><span className="inline-block w-2 h-2 rounded-full align-[-1px] mr-1" style={{ border: '1.5px solid #cfa75f' }} />排卵日</span>
                                    <span><span className="inline-block w-2 h-2 rounded-full align-[-1px] mr-1" style={{ background: '#f4e9d2' }} />排卵期</span>
                                    <span>點過去的日期可補記</span>
                                </div>
                                <p className="text-[8px] text-center mt-1.5" style={{ color: FAINT, fontFamily: SERIF }}>預測為日曆法估算，僅供參考</p>
                            </div>
                        )}
                    </SoftCard>
                </>
            )}

            {/* ═══ 藥盒 ═══ */}
            {tab === 'med' && visibleModules.includes('med') && (
                <>
                    <LabelCard theme={THEMES.med}>
                        <SectionHead theme={THEMES.med} cn={`${recordDateLabel}待服`} en={`PHARMACY · ${recordDate === today ? 'TODAY' : recordDate}`} />
                        {duePlans.length === 0 ? (
                            <p className="text-[11px] text-center py-3" style={{ color: FADE, fontFamily: SERIF }}>
                                {plans.filter(p => p.enabled).length === 0 ? '藥盒還是空的——先在下面放一樣進去' : `按頻率，${recordDate === today ? '今天' : '這一天'}不用吃藥 ❧`}
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {duePlans.map(p => {
                                    const taken = !!planTakenRecord(p);
                                    return (
                                        <button
                                            key={p.id}
                                            onClick={() => handleTogglePlanTaken(p)}
                                            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-[4px] text-left transition-all active:scale-[0.99]"
                                            style={{
                                                background: taken ? '#eef6f1' : '#ffffffa8',
                                                border: `1px solid ${taken ? THEMES.med.accent + '55' : THEMES.med.soft}`,
                                            }}
                                        >
                                            <span className="text-[11px] tabular-nums shrink-0 w-10" style={{ fontFamily: SERIF, color: THEMES.med.accent }}>{p.time}</span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-xs font-bold truncate" style={{ fontFamily: SERIF, color: taken ? THEMES.med.accent : INK }}>
                                                    {p.name}{p.dosage ? ` · ${p.dosage}` : ''}
                                                </span>
                                                <span className="text-[9px]" style={{ color: FADE }}>
                                                    {medFreqLabel(p)}{p.planKind === 'course' && p.endDate ? ` · 療程至${fmtCN(p.endDate)}` : ' · 長期'}
                                                </span>
                                            </span>
                                            <span className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[13px] transition-all"
                                                style={taken ? {
                                                    background: THEMES.med.accent, color: '#fdfbf7', transform: 'rotate(-8deg)',
                                                    boxShadow: `inset 0 0 0 2px #ffffff40, 0 3px 8px -3px ${THEMES.med.accent}`,
                                                } : {
                                                    border: `1.5px dashed ${THEMES.med.soft}`, color: '#c9c2b5',
                                                }}>
                                                {taken ? '✓' : ''}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {dayMeds.filter(r => !r.payload.planId).length > 0 && (
                            <div className="mt-3 pt-3" style={{ borderTop: `1px dashed ${THEMES.med.soft}` }}>
                                <div className="text-[9px] mb-1.5" style={{ color: FADE, letterSpacing: '0.2em' }}>計劃之外</div>
                                {dayMeds.filter(r => !r.payload.planId).map(r => (
                                    <div key={r.id} className="flex items-center justify-between text-[11px] py-1" style={{ fontFamily: SERIF }}>
                                        <span style={{ color: INK }}>{r.payload.name}<span className="text-[9px]" style={{ color: FAINT }}>{recordedByLabel(r)}</span></span>
                                        <button onClick={() => removeRecord(r)} className="px-1.5 text-slate-300 hover:text-rose-400">✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </LabelCard>

                    <LabelCard theme={THEMES.med}>
                        <SectionHead theme={THEMES.med} cn="我的藥盒" en="CABINET" />
                        <p className="text-[9px] italic mb-3 -mt-1 text-center" style={{ color: FAINT, fontFamily: SERIF }}>
                            像設鬧鐘一樣只寫一次：長期的每天/隔幾天自動出現在待服清單；短期療程到期自動消失
                        </p>
                        {longtermPlans.length > 0 && (
                            <div className="mb-3">
                                <div className="text-[9px] mb-1" style={{ color: THEMES.med.accent, letterSpacing: '0.25em' }}>長期 · 保健品等</div>
                                {longtermPlans.map(renderPlanRow)}
                            </div>
                        )}
                        {coursePlans.length > 0 && (
                            <div className="mb-3">
                                <div className="text-[9px] mb-1" style={{ color: THEMES.med.accent, letterSpacing: '0.25em' }}>短期療程</div>
                                {coursePlans.map(renderPlanRow)}
                            </div>
                        )}

                        {/* 添加：類型 + 頻率 + 時間 + 名稱/劑量 +（療程）日期段 */}
                        <div className="space-y-2.5 pt-1">
                            <div className="flex gap-2">
                                {([['longterm', '長期'], ['course', '短期療程']] as const).map(([k, label]) => (
                                    <button key={k} onClick={() => setPlanKind(k)}
                                        className="flex-1 py-1.5 rounded-full text-[10px] font-bold transition-colors"
                                        style={planKind === k
                                            ? { background: `${THEMES.med.accent}18`, color: THEMES.med.deep, border: `1px solid ${THEMES.med.accent}66`, fontFamily: SERIF }
                                            : { color: FAINT, border: '1px solid #e5ddcd', fontFamily: SERIF }}>
                                        {label}
                                    </button>
                                ))}
                                <select value={planInterval} onChange={e => setPlanInterval(parseInt(e.target.value, 10))}
                                    className="w-[74px] text-[10px] bg-transparent outline-none text-center"
                                    style={{ ...inkInputStyle(THEMES.med), border: '1px solid #e5ddcd', borderRadius: 999, color: THEMES.med.deep }}>
                                    <option value={1}>每天</option>
                                    <option value={2}>隔天</option>
                                    <option value={3}>每3天</option>
                                    <option value={7}>每週</option>
                                </select>
                            </div>
                            <div className="flex items-end gap-2.5">
                                <input type="time" value={planTime} onChange={e => setPlanTime(e.target.value)}
                                    className={`w-[74px] ${inkInputCls}`} style={inkInputStyle(THEMES.med)} />
                                <input value={planName} onChange={e => setPlanName(e.target.value)} placeholder="藥名 / 保健品"
                                    className={`flex-1 min-w-0 ${inkInputCls}`} style={inkInputStyle(THEMES.med)} />
                                <input value={planDosage} onChange={e => setPlanDosage(e.target.value)} placeholder="劑量"
                                    className={`w-14 ${inkInputCls}`} style={inkInputStyle(THEMES.med)} />
                            </div>
                            {planKind === 'course' && (
                                <div className="flex items-end gap-2.5">
                                    <span className="text-[9px] pb-1.5 shrink-0" style={{ color: FADE, fontFamily: SERIF }}>從</span>
                                    <input type="date" value={planStart} onChange={e => setPlanStart(e.target.value)}
                                        className={`flex-1 min-w-0 ${inkInputCls}`} style={inkInputStyle(THEMES.med)} />
                                    <span className="text-[9px] pb-1.5 shrink-0" style={{ color: FADE, fontFamily: SERIF }}>到</span>
                                    <input type="date" value={planEnd} onChange={e => setPlanEnd(e.target.value)}
                                        className={`flex-1 min-w-0 ${inkInputCls}`} style={inkInputStyle(THEMES.med)} />
                                </div>
                            )}
                            <div className="flex justify-end">
                                <button onClick={handleAddPlan}
                                    className="px-5 py-1.5 rounded-full text-[11px] font-bold active:scale-95 transition-transform"
                                    style={accentBtn(THEMES.med)}>
                                    放進藥盒
                                </button>
                            </div>
                        </div>
                    </LabelCard>
                </>
            )}

            {/* ═══ 記帳 ═══ */}
            {tab === 'expense' && visibleModules.includes('expense') && (
                <>
                    <LedgerCard theme={THEMES.expense}>
                        <SectionHead theme={THEMES.expense} cn="記帳" en="LEDGER" />
                        <div className="flex items-stretch px-1">
                            <div className="flex-1">
                                <div className="text-[9px] mb-0.5" style={{ color: FADE, letterSpacing: '0.25em' }}>{recordDateLabel}支出</div>
                                <div style={{ fontFamily: SERIF, color: THEMES.expense.accent }}>
                                    <span className="text-[34px] font-bold leading-none tabular-nums">{formatMoney(dayTotal)}</span>
                                </div>
                            </div>
                            <span className="w-px mx-3" style={{ background: THEMES.expense.soft }} />
                            <div className="text-right flex flex-col justify-end pb-1">
                                <div className="text-[9px] mb-0.5" style={{ color: FADE, letterSpacing: '0.16em' }}>{recordMonthLabel}</div>
                                <div className="text-sm font-bold tabular-nums" style={{ fontFamily: SERIF, color: INK }}>{formatMoney(monthTotal)}</div>
                            </div>
                        </div>
                        <p className="text-[9px] italic mt-2 px-1" style={{ color: FAINT, fontFamily: SERIF }}>
                            與銀行 App 共用一本帳
                        </p>
                        <div className="flex items-end gap-2.5 mt-3 pt-3" style={{ borderTop: `1px dashed ${THEMES.expense.soft}` }}>
                            <input value={txAmount} onChange={e => setTxAmount(e.target.value)} inputMode="decimal" placeholder="金額"
                                className={`w-16 ${inkInputCls}`} style={inkInputStyle(THEMES.expense)} />
                            <input value={txNote} onChange={e => setTxNote(e.target.value)} placeholder="用途（奶茶 / 午飯…）"
                                className={`flex-1 min-w-0 ${inkInputCls}`} style={inkInputStyle(THEMES.expense)} />
                            <button onClick={handleAddTx}
                                className="shrink-0 px-4 py-1.5 rounded-full text-[11px] font-bold active:scale-95 transition-transform"
                                style={accentBtn(THEMES.expense)}>
                                入帳
                            </button>
                        </div>
                    </LedgerCard>

                    <LedgerCard theme={THEMES.expense}>
                        <SectionHead theme={THEMES.expense} cn={`${recordDateLabel}流水`} en="ENTRIES" />
                        {dayTxs.length === 0 ? (
                            <p className="text-[11px] text-center py-4" style={{ color: FADE, fontFamily: SERIF }}>
                                {recordDate === today ? '今日' : '當日'}帳面清白 ❧
                            </p>
                        ) : (
                            <div>
                                {dayTxs.map(t => (
                                    <div key={t.id} className="flex items-center gap-2 py-2 text-[11px]"
                                        style={{ fontFamily: SERIF, borderBottom: `1px dashed ${THEMES.expense.soft}` }}>
                                        <span className="flex-1 truncate" style={{ color: INK }}>{t.note || '未備註'}</span>
                                        <span className="font-bold tabular-nums" style={{ color: THEMES.expense.accent }}>{formatMoney(t.amount)}</span>
                                        <button
                                            onClick={async () => { await DB.deleteTransaction(t.id); await reload(); addToast('記錄已刪除', 'success'); }}
                                            className="px-1 text-slate-300 hover:text-rose-400"
                                        >✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </LedgerCard>
                </>
            )}

            {/* ═══ 鍛鍊 ═══ */}
            {tab === 'exercise' && visibleModules.includes('exercise') && (
                <>
                    <TicketCard theme={THEMES.exercise}>
                        <SectionHead theme={THEMES.exercise} cn="每週規劃" en="WEEKLY PLAN" />
                        <div className="flex items-center justify-between mb-2.5">
                            <span className="text-[10px]" style={{ color: FADE, fontFamily: SERIF }}>每週目標次數（0 = 不設）</span>
                            <input
                                type="number" min={0} max={21}
                                defaultValue={weekGoal}
                                onBlur={async (e) => {
                                    const n = parseInt(e.target.value, 10);
                                    if (!isNaN(n) && n >= 0 && n <= 21 && n !== weekGoal) await saveSettings({ exerciseWeeklyGoal: n });
                                }}
                                className="w-12 text-center bg-transparent outline-none text-sm font-bold"
                                style={{ fontFamily: SERIF, color: THEMES.exercise.accent, borderBottom: `1px solid ${THEMES.exercise.soft}` }}
                            />
                        </div>
                        <textarea
                            defaultValue={settings?.exercisePlanNote || ''}
                            onBlur={async (e) => {
                                const v = e.target.value.trim();
                                if (v !== (settings?.exercisePlanNote || '')) await saveSettings({ exercisePlanNote: v });
                            }}
                            placeholder="寫下你的每週規劃（如：週一慢跑 30 分鐘 / 週四力量 / 週末爬山）——開啟注入的角色會盯著你執行"
                            className="w-full h-16 text-[11px] leading-relaxed bg-white/60 rounded-[6px] p-2.5 outline-none resize-none placeholder:text-slate-300"
                            style={{ fontFamily: SERIF, color: INK, border: `1px solid ${THEMES.exercise.soft}` }}
                        />
                        {/* 本週進度 */}
                        <div className="mt-3">
                            <div className="flex items-center justify-between text-[10px] mb-1.5" style={{ fontFamily: SERIF }}>
                                <span style={{ color: FADE }}>{recordDate === today ? '本週進度' : `${fmtCN(recordDate)}所在周`}（週一起）</span>
                                <span style={{ color: THEMES.exercise.deep, fontWeight: 700 }}>
                                    {weekSessions}{weekGoal > 0 ? ` / ${weekGoal} 次` : ' 次'}{weekGoal > 0 && weekSessions >= weekGoal ? ' · 已達標 ✓' : ''}
                                </span>
                            </div>
                            {weekGoal > 0 && (
                                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: `${THEMES.exercise.soft}66` }}>
                                    <div className="h-full rounded-full transition-all"
                                        style={{ width: `${Math.min(100, (weekSessions / weekGoal) * 100)}%`, background: THEMES.exercise.accent }} />
                                </div>
                            )}
                            <div className="flex justify-between px-1 mt-2.5">
                                {weekDots.map(d => (
                                    <div key={d.date} className="flex flex-col items-center gap-1">
                                        <span aria-hidden className="w-3 h-3 rotate-45 transition-colors"
                                            style={d.done
                                                ? { background: THEMES.exercise.accent, boxShadow: `0 2px 6px -2px ${THEMES.exercise.accent}` }
                                                : { border: `1px solid ${THEMES.exercise.soft}`, background: d.future ? 'transparent' : '#ffffff90', opacity: d.future ? 0.4 : 1 }} />
                                        <span className="text-[8px]" style={{ color: d.date === recordDate || d.date === today ? THEMES.exercise.accent : FAINT, fontFamily: SERIF }}>
                                            {d.date === recordDate ? (d.date === today ? '今' : '選') : d.date === today ? '今' : d.label}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </TicketCard>

                    <TicketCard theme={THEMES.exercise}>
                        <SectionHead theme={THEMES.exercise} cn={`${recordDateLabel}打卡`} en={`CHECK-IN · ${recordDate === today ? 'TODAY' : recordDate}`} />
                        <div className="flex items-end gap-2.5">
                            <input value={exActivity} onChange={e => setExActivity(e.target.value)} placeholder="項目（跑步 / 瑜伽…）"
                                className={`flex-1 min-w-0 ${inkInputCls}`} style={inkInputStyle(THEMES.exercise)} />
                            <input value={exDuration} onChange={e => setExDuration(e.target.value)} placeholder="時長"
                                className={`w-16 ${inkInputCls}`} style={inkInputStyle(THEMES.exercise)} />
                            <button onClick={handleAddExercise}
                                className="shrink-0 px-4 py-1.5 rounded-full text-[11px] font-bold active:scale-95 transition-transform"
                                style={accentBtn(THEMES.exercise)}>
                                蓋章
                            </button>
                        </div>
                        {exerciseRecords.length > 0 && (
                            <div className="space-y-0.5 mt-3 pt-2" style={{ borderTop: `1px dashed ${THEMES.exercise.soft}` }}>
                                {exerciseRecords.slice(0, 14).map(r => (
                                    <div key={r.id} className="flex items-center gap-2 py-1.5 text-[11px]"
                                        style={{ fontFamily: SERIF, borderBottom: `1px dashed ${THEMES.exercise.soft}55` }}>
                                        <span aria-hidden className="w-2 h-2 rotate-45 shrink-0" style={{ background: THEMES.exercise.accent, opacity: 0.6 }} />
                                        <span className="flex-1 truncate" style={{ color: INK }}>
                                            {fmtCN(r.date)} · {r.payload.activity}{r.payload.duration ? ` ${r.payload.duration}` : ''}
                                            <span className="text-[9px]" style={{ color: FAINT }}>{recordedByLabel(r)}</span>
                                        </span>
                                        <button onClick={() => removeRecord(r)} className="px-1 text-slate-300 hover:text-rose-400">✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </TicketCard>
                </>
            )}

            {/* 頁腳註釋 + 恢復入口 */}
            <div className="text-center space-y-1 pb-1">
                <p className="text-[9px] italic leading-relaxed px-4" style={{ color: FAINT, fontFamily: SERIF }}>
                    想讓某個角色「隱約知道」這些，去神經鏈接裡打開對應角色的「生活記錄注入」；
                    <br />長按上方頁籤，可隱藏你不需要的功能。
                </p>
                {hiddenModules.length > 0 && (
                    <button
                        onClick={() => setShowRestore(true)}
                        className="text-[9px] underline underline-offset-2"
                        style={{ color: FADE, fontFamily: SERIF }}
                    >
                        已隱藏 {hiddenModules.length} 項功能 · 查看與恢復
                    </button>
                )}
            </div>

            {/* 日曆點選：補記 / 清除 */}
            {daySheet && (
                <div className="fixed inset-0 z-[100] bg-black/35 backdrop-blur-sm flex items-center justify-center p-8 animate-fade-in"
                    onClick={() => setDaySheet(null)}>
                    <div onClick={e => e.stopPropagation()}>
                        <SoftCard theme={THEMES.period} className="w-[270px] !p-6 text-center">
                            <h3 className="text-[14px] font-bold mb-1" style={{ fontFamily: SERIF, color: INK }}>{fmtCN(daySheet)}</h3>
                            <p className="text-[10px] mb-4" style={{ color: FADE, fontFamily: SERIF }}>
                                {periodDaySet.has(daySheet) ? '這一天在生理期內' : '為這一天補一筆記錄'}
                            </p>
                            <div className="space-y-2">
                                <button onClick={() => backfillPeriod(daySheet, 'start')}
                                    className="w-full py-2 rounded-full text-[12px] font-bold active:scale-95 transition-transform"
                                    style={accentBtn(THEMES.period)}>
                                    記為生理期開始
                                </button>
                                <button onClick={() => backfillPeriod(daySheet, 'end')}
                                    className="w-full py-2 rounded-full text-[12px] font-bold"
                                    style={{ fontFamily: SERIF, color: THEMES.period.deep, border: `1px solid ${THEMES.period.soft}`, background: '#ffffff90' }}>
                                    記為生理期結束
                                </button>
                                {records.some(r => r.module === 'period' && r.date === daySheet) && (
                                    <button onClick={() => clearPeriodDay(daySheet)}
                                        className="w-full py-2 rounded-full text-[12px] font-bold"
                                        style={{ fontFamily: SERIF, color: FADE, border: '1px solid #e5ddcd', background: '#ffffff90' }}>
                                        清除這一天的記錄
                                    </button>
                                )}
                                <button onClick={() => setDaySheet(null)}
                                    className="w-full py-1.5 text-[11px]" style={{ fontFamily: SERIF, color: FAINT }}>
                                    取消
                                </button>
                            </div>
                        </SoftCard>
                    </div>
                </div>
            )}

            {/* 隱藏確認彈窗 */}
            {hideCandidate && (
                <div className="fixed inset-0 z-[100] bg-black/35 backdrop-blur-sm flex items-center justify-center p-8 animate-fade-in"
                    onClick={() => setHideCandidate(null)}>
                    <div onClick={e => e.stopPropagation()}>
                        <SoftCard theme={THEMES[hideCandidate]} className="w-[280px] !p-6 text-center">
                            <div className="flex justify-center mb-2 opacity-80">{THEMES[hideCandidate].icon}</div>
                            <h3 className="text-[15px] font-bold mb-2" style={{ fontFamily: SERIF, color: INK }}>
                                是否不需要這個功能？
                            </h3>
                            <p className="text-[11px] leading-relaxed mb-5" style={{ color: FADE, fontFamily: SERIF }}>
                                隱藏「{THEMES[hideCandidate].cn}」後，這裡不再顯示它，
                                也不會把相關內容注入給任何角色。
                                <br />之後隨時可以從頁腳恢復。
                            </p>
                            <div className="flex gap-2.5">
                                <button
                                    onClick={() => setHideCandidate(null)}
                                    className="flex-1 py-2 rounded-full text-[12px] font-bold"
                                    style={{ fontFamily: SERIF, color: FADE, border: '1px solid #e5ddcd', background: '#ffffff90' }}
                                >
                                    先留著
                                </button>
                                <button
                                    onClick={() => confirmHide(hideCandidate)}
                                    className="flex-1 py-2 rounded-full text-[12px] font-bold active:scale-95 transition-transform"
                                    style={accentBtn(THEMES[hideCandidate])}
                                >
                                    確定隱藏
                                </button>
                            </div>
                        </SoftCard>
                    </div>
                </div>
            )}

            {/* 恢復彈窗 */}
            {showRestore && (
                <div className="fixed inset-0 z-[100] bg-black/35 backdrop-blur-sm flex items-center justify-center p-8 animate-fade-in"
                    onClick={() => setShowRestore(false)}>
                    <div onClick={e => e.stopPropagation()}>
                        <LedgerCard theme={THEMES.expense} className="w-[280px] !p-6">
                            <h3 className="text-[14px] font-bold mb-4 text-center" style={{ fontFamily: SERIF, color: INK }}>
                                已隱藏的功能
                            </h3>
                            <div className="space-y-2 mb-4">
                                {hiddenModules.map(m => (
                                    <div key={m} className="flex items-center justify-between px-3 py-2 rounded-[4px]"
                                        style={{ background: '#ffffff90', border: '1px solid #e5ddcd' }}>
                                        <span className="flex items-center gap-2 text-[12px] font-bold" style={{ fontFamily: SERIF, color: INK }}>
                                            {THEMES[m].icon}{THEMES[m].cn}
                                        </span>
                                        <button
                                            onClick={() => restoreModule(m)}
                                            className="text-[10px] px-3 py-1 rounded-full font-bold"
                                            style={{ color: THEMES[m].accent, border: `1px solid ${THEMES[m].accent}66` }}
                                        >
                                            恢復
                                        </button>
                                    </div>
                                ))}
                                {hiddenModules.length === 0 && (
                                    <p className="text-[11px] text-center py-2" style={{ color: FADE, fontFamily: SERIF }}>沒有隱藏中的功能</p>
                                )}
                            </div>
                            <button
                                onClick={() => setShowRestore(false)}
                                className="w-full py-2 rounded-full text-[12px] font-bold"
                                style={{ fontFamily: SERIF, color: FADE, border: '1px solid #e5ddcd', background: '#ffffff90' }}
                            >
                                收起
                            </button>
                        </LedgerCard>
                    </div>
                </div>
            )}
        </div>
    );
};

export default LifeRecordPanel;
