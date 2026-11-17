import React, { useState } from 'react';
import { ArrowClockwise, CaretLeft, CheckCircle, Sparkle, XCircle } from '@phosphor-icons/react';
import ExpandableTextarea from '../common/ExpandableTextarea';
import TokenImg from '../os/TokenImg';
import type { UserProfile } from '../../types';
import type { SchedulePerson } from '../../utils/schedulePerson';
import { DB } from '../../utils/db';
import { generateScheduleFor, generateWeekFor, personTodayKey } from '../../utils/scheduleGenerator';

/**
 * 行事曆的「生成」全螢幕頁（plans/calendar.md 第 3 批）：行程提示詞、生成今天／這週、所有人今天。
 * 角色和身份卡同一頁；批量只有角色那邊有。
 */

interface ApiConfig { baseUrl: string; apiKey: string; model: string }

export interface GeneratePageProps {
    person: SchedulePerson;
    userProfile: UserProfile;
    api: ApiConfig;
    /** 這個人今天有沒有日程了 */
    hasToday: boolean;
    /** 批量：其他開了日程的角色（含自己也行）；身份卡頁不給 */
    batch?: Array<{ person: SchedulePerson; userProfile: UserProfile; api: ApiConfig }>;
    onSavePrompt: (text: string) => void;
    /** 某個人生成完叫一次（打髒雲端、刷畫面） */
    onGenerated: (person: SchedulePerson) => void;
    onClose: () => void;
}

type Row = { label: string; state: 'running' | 'ok' | 'fail' | 'skip' };

const GeneratePage: React.FC<GeneratePageProps> = ({ person, userProfile, api, hasToday, batch, onSavePrompt, onGenerated, onClose }) => {
    const [prompt, setPrompt] = useState(person.schedulePrompt || '');
    const [busy, setBusy] = useState<string | null>(null);
    const [rows, setRows] = useState<Row[]>([]);
    const dirty = prompt !== (person.schedulePrompt || '');
    const withPrompt = (): SchedulePerson => ({ ...person, schedulePrompt: prompt.trim() || undefined });

    const savePrompt = () => { onSavePrompt(prompt.trim()); };

    const runToday = async (force: boolean) => {
        if (busy) return;
        setBusy('today');
        setRows([{ label: `${person.name} · 今天`, state: 'running' }]);
        if (dirty) savePrompt();
        try {
            const s = await generateScheduleFor(withPrompt(), userProfile, api, { force });
            setRows([{ label: `${person.name} · 今天`, state: s ? 'ok' : 'fail' }]);
            if (s) onGenerated(person);
        } finally { setBusy(null); }
    };

    const runWeek = async (force: boolean) => {
        if (busy) return;
        setBusy('week');
        if (dirty) savePrompt();
        setRows([{ label: '一週大綱', state: 'running' }]);
        try {
            const p = withPrompt();
            const start = personTodayKey(p);
            await generateWeekFor(p, userProfile, api, {
                force,
                onProgress: (done, _total, dateKey, ok) => setRows(prev => {
                    const next = [...prev];
                    if (done === 0) next[0] = { label: '一週大綱', state: ok ? 'ok' : 'fail' };
                    else next.push({ label: `${dateKey === start ? '今天' : dateKey}`, state: ok ? 'ok' : 'fail' });
                    return next;
                }),
            });
            onGenerated(person);
        } finally { setBusy(null); }
    };

    const runBatch = async () => {
        if (busy || !batch?.length) return;
        setBusy('batch');
        setRows(batch.map(b => ({ label: b.person.name, state: 'running' })));
        try {
            for (let i = 0; i < batch.length; i++) {
                const b = batch[i];
                const had = !!(await DB.getDailySchedule(b.person.scheduleId, personTodayKey(b.person)).catch(() => null));
                let state: Row['state'] = 'skip';
                if (!had) {
                    const s = await generateScheduleFor(b.person, b.userProfile, b.api, { force: false }).catch(() => null);
                    state = s ? 'ok' : 'fail';
                    if (s) onGenerated(b.person);
                }
                setRows(prev => prev.map((r, j) => (j === i ? { ...r, state } : r)));
            }
        } finally { setBusy(null); }
    };

    const btn = 'w-full rounded-2xl py-3 text-[13px] font-bold shadow-sm disabled:opacity-40';
    const icon = (s: Row['state']) => s === 'running' ? <ArrowClockwise size={16} className="animate-spin text-pink-400" /> : s === 'ok' ? <CheckCircle size={16} weight="fill" className="text-emerald-400" /> : s === 'fail' ? <XCircle size={16} weight="fill" className="text-rose-400" /> : <span className="text-[10px] text-slate-400">已有</span>;

    return (
        <div className="absolute inset-0 z-30 flex flex-col bg-gradient-to-b from-pink-50 via-rose-50 to-sky-50 text-slate-800 animate-fade-in" role="dialog" aria-label="生成日程">
            <div className="shrink-0 px-4 pb-2 flex items-center justify-between" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
                <button onClick={onClose} aria-label="返回" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-600 shadow-sm"><CaretLeft size={18} /></button>
                <div className="text-[16px] font-black">生成日程</div>
                <div className="h-9 w-9" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-10 space-y-4">
                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 flex items-center gap-3 shadow-sm">
                    <TokenImg value={person.avatar} alt="" className="h-12 w-12 rounded-full object-cover shrink-0" />
                    <div className="min-w-0">
                        <div className="text-[16px] font-black truncate">{person.name}</div>
                        <div className="text-[11px] text-slate-400">{person.kind === 'persona' ? '身份卡：AI 照這張卡的人設排你的一天' : person.style === 'mindful' ? '意識系：思緒時間線' : '生活系：真實的一天'}</div>
                    </div>
                </section>

                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-2 shadow-sm">
                    <div className="text-[12px] font-bold text-slate-600">行程提示詞 <span className="font-normal text-slate-400">· 固定的作息、習慣，每次生成都帶</span></div>
                    <ExpandableTextarea value={prompt} onChange={setPrompt} title="行程提示詞" rows={4} maxLength={1500}
                        placeholder={person.kind === 'persona' ? '例如：平日 9 點上班、18 點下班；週末睡到自然醒；每週三晚上健身。' : '例如：週一到週五在實驗室；每週五晚上固定跟朋友打球；不吃早餐。'}
                        className="w-full rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 text-[13px] outline-none focus:border-pink-200" />
                    {dirty && <button onClick={savePrompt} className="rounded-xl bg-pink-400 px-3 py-1.5 text-[12px] font-bold text-white">存起來</button>}
                </section>

                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-2 shadow-sm">
                    <div className="text-[12px] font-bold text-slate-600">{person.name} 的</div>
                    <button onClick={() => void runToday(hasToday)} disabled={!!busy} className={`${btn} bg-pink-400 text-white`}>
                        <Sparkle size={14} weight="fill" className="inline mr-1 -mt-0.5" />{hasToday ? '重新生成今天' : '生成今天'}
                    </button>
                    <button onClick={() => void runWeek(false)} disabled={!!busy} className={`${btn} bg-white text-pink-500 border border-pink-100`}>生成這週（今天起 7 天，已有的不動）</button>
                    <button onClick={() => void runWeek(true)} disabled={!!busy} className={`${btn} bg-white text-slate-500 border border-slate-100`}>這週全部重生</button>
                    <div className="text-[11px] text-slate-400 leading-relaxed">一週是先出 7 天大綱、再每天分開補時段，會叫 8 次 API。約好的事和沒做完的待辦會一起餵進去；模型說做完的待辦會自動勾掉（標「AI 勾的」，你能取消）。</div>
                </section>

                {batch && batch.length > 0 && (
                    <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-2 shadow-sm">
                        <div className="text-[12px] font-bold text-slate-600">所有開了日程的角色 <span className="font-normal text-slate-400">· {batch.length} 人</span></div>
                        <button onClick={() => void runBatch()} disabled={!!busy} className={`${btn} bg-white text-pink-500 border border-pink-100`}>今天還沒排的都生成</button>
                    </section>
                )}

                {rows.length > 0 && (
                    <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-1.5 shadow-sm">
                        {rows.map((r, i) => (
                            <div key={i} className="flex items-center justify-between text-[13px] text-slate-700"><span>{r.label}</span>{icon(r.state)}</div>
                        ))}
                    </section>
                )}
            </div>
        </div>
    );
};

export default GeneratePage;
