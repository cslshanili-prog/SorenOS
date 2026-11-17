import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowClockwise, CalendarBlank, CaretLeft, CaretRight, CheckCircle, Circle, Plus, Sparkle, Trash, User as UserIcon, UsersThree } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import TokenImg from '../components/os/TokenImg';
import type { CalendarEvent, CharacterProfile, DailySchedule, Participant } from '../types';
import { DB } from '../utils/db';
import { isAltChar } from '../utils/charAlt';
import { generateDailyScheduleForChar, isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { resolveCharacterMeterApi } from '../utils/characterApi';
import { resolveUserProfileForChar } from '../utils/userPersona';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { resolveCharTimeZone, tzLabel } from '../utils/timezone';
import { resolveCharCalendar } from '../utils/worldCalendar';
import {
    charParticipant, eventOnDay, eventTime, eventsInvolving, eventsOn, loadCalendarEvents, newEvent, openTodos, ownedBy, personaParticipant, sameParticipant, sortByTime,
} from '../utils/calendarEvents';
import { TODO_CHANGED_EVENT } from '../utils/todoTag';
import {
    addDays, addMonths, currentActivity, dayTitle, dualTime, monthGrid, monthKeyOf, monthRange,
    overlapRows, personaOptions, personaTodayKey, rangeState, slotRanges, type DualTime, type PersonaOption,
} from '../utils/calendarView';
import AddEventPage, { type ParticipantView } from '../components/calendar/AddEventPage';

/**
 * 行事曆（plans/calendar.md）：月曆／我的／TA 的三個分頁。
 * 第 1 批：殼。第 2 批：約定層（calendar_events）——手動加的、待辦、紀念日；時光契約退役，資料搬進來。
 * 角色的一天還是 DailySchedule（只讀它顯示、能生成今天）；時間照 plans/time-system.md：那個人那邊＋「你 xx:xx」。
 */

type Tab = 'month' | 'mine' | 'theirs';

const Avatar: React.FC<{ src: string; size?: number; className?: string }> = ({ src, size = 28, className = '' }) => (
    <TokenImg value={src} alt="" className={`rounded-full object-cover shrink-0 ${className}`} style={{ width: size, height: size }} />
);

const TimeCell: React.FC<{ time: DualTime; dim?: boolean }> = ({ time, dim }) => (
    <div className={`w-14 shrink-0 text-right leading-tight ${dim ? 'opacity-50' : ''}`}>
        <div className="text-[13px] font-bold text-pink-500 tabular-nums">{time.local}</div>
        {time.yours && <div className="text-[10px] text-slate-400 tabular-nums">你 {time.yours}{time.yoursDayOffset ? (time.yoursDayOffset > 0 ? '⁺¹' : '⁻¹') : ''}</div>}
    </div>
);

const stateBadge = (state: 'past' | 'now' | 'future') =>
    state === 'now' ? <span className="rounded-full bg-pink-500 px-1.5 py-0.5 text-[9px] font-bold text-white">NOW</span>
    : state === 'future' ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-600">Soon</span>
    : null;

const KIND_EMOJI: Record<CalendarEvent['kind'], string> = { event: '📌', todo: '☐', anniversary: '🎂' };

const CalendarApp: React.FC = () => {
    const { closeApp, characters, npcs, activeCharacterId, userProfileBase, apiConfig, groups, realtimeConfig, addToast } = useOS();
    const [tab, setTab] = useState<Tab>('month');
    const personas = useMemo(() => personaOptions(userProfileBase), [userProfileBase]);
    const [personaKey, setPersonaKey] = useState<string>(() => personas.find(p => p.isMain)?.key || personas[0].key);
    const persona: PersonaOption = personas.find(p => p.key === personaKey) || personas[0];
    const me: Participant = personaParticipant(persona.key);
    const yourTz = persona.timezone;
    const todayKey = personaTodayKey(yourTz);
    const [dayKey, setDayKey] = useState(todayKey);
    const [monthKey, setMonthKey] = useState(monthKeyOf(todayKey));

    // 有日程功能的角色（小號、下戲的配角藏起來）
    const scheduleChars = useMemo(() => characters.filter(c => isScheduleFeatureOn(c) && !isAltChar(c)), [characters]);
    const [charId, setCharId] = useState<string | null>(() => (scheduleChars.some(c => c.id === activeCharacterId) ? activeCharacterId : scheduleChars[0]?.id) || null);
    const selectedChar = scheduleChars.find(c => c.id === charId) || scheduleChars[0] || null;

    // 約定層（時光契約的待辦、紀念日第一次打開就搬進來）
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const reloadEvents = useCallback(() => { loadCalendarEvents().then(setEvents).catch(() => setEvents([])); }, []);
    useEffect(() => {
        reloadEvents();
        window.addEventListener(TODO_CHANGED_EVENT, reloadEvents);
        return () => window.removeEventListener(TODO_CHANGED_EVENT, reloadEvents);
    }, [reloadEvents]);

    // 參與者的名字和頭像（身份卡、角色、配角）
    const viewOf = useCallback((p: Participant): ParticipantView => {
        if (p.kind === 'persona') { const o = personas.find(x => x.key === p.id); return { participant: p, name: o?.name || '你', avatar: o?.avatar || '' }; }
        if (p.kind === 'char') { const c = characters.find(x => x.id === p.id); return { participant: p, name: c?.name || '角色', avatar: c?.avatar || '' }; }
        const n = npcs.find(x => x.id === p.id); return { participant: p, name: n?.name || '配角', avatar: n?.avatar || '' };
    }, [personas, characters, npcs]);
    const participantChoices = useMemo<ParticipantView[]>(() => [
        ...personas.map(p => viewOf(personaParticipant(p.key))),
        ...characters.filter(c => !isAltChar(c)).map(c => viewOf(charParticipant(c.id))),
        ...npcs.map(n => viewOf({ kind: 'npc', id: n.id })),
    ], [personas, characters, npcs, viewOf]);

    // 月份裡每個角色有哪幾天的日程（打點＋今日次元重疊）；key = `${charId}_${date}`
    const [monthSchedules, setMonthSchedules] = useState<Map<string, DailySchedule>>(new Map());
    const [schedulesVersion, setSchedulesVersion] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const { from, to } = monthRange(monthKey);
        Promise.all(scheduleChars.map(c => DB.getDailySchedulesInRange(c.id, from, to).catch(() => [] as DailySchedule[])))
            .then(lists => {
                if (cancelled) return;
                const next = new Map<string, DailySchedule>();
                for (const list of lists) for (const s of list) next.set(`${s.charId}_${s.date}`, s);
                setMonthSchedules(next);
            });
        return () => { cancelled = true; };
    }, [monthKey, scheduleChars, schedulesVersion]);
    useEffect(() => { if (monthKeyOf(dayKey) !== monthKey) setMonthKey(monthKeyOf(dayKey)); }, [dayKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const scheduleOf = (c: CharacterProfile, key: string) => monthSchedules.get(`${c.id}_${key}`) || null;
    const scheduleDays = useMemo(() => new Set([...monthSchedules.keys()].map(k => k.slice(k.lastIndexOf('_') + 1))), [monthSchedules]);

    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick(n => n + 1), 60_000); return () => clearInterval(t); }, []);
    const nowMs = Date.now();

    // ── 約定層的寫 ──
    const saveEvent = async (e: CalendarEvent) => { await DB.saveCalendarEvent(e); reloadEvents(); };
    const deleteEvent = async (id: string) => { await DB.deleteCalendarEvent(id); reloadEvents(); };
    const toggleTodo = async (e: CalendarEvent) => {
        await saveEvent({ ...e, done: !e.done, doneBy: e.done ? undefined : 'user', completedAt: e.done ? undefined : Date.now(), updatedAt: Date.now() });
    };
    const [editing, setEditing] = useState<{ event?: CalendarEvent; owner: Participant; kind: CalendarEvent['kind'] } | null>(null);
    const [quickTodo, setQuickTodo] = useState('');
    const addQuickTodo = async (owner: Participant) => {
        const title = quickTodo.trim();
        if (!title) return;
        await saveEvent(newEvent({ owner, kind: 'todo', title, start: dayKey, allDay: true, source: 'user' }));
        setQuickTodo('');
    };

    const [generating, setGenerating] = useState(false);
    const generateToday = async (c: CharacterProfile, force: boolean) => {
        if (generating) return;
        setGenerating(true);
        try {
            const profile = resolveUserProfileForChar(userProfileBase, c);
            const result = await generateDailyScheduleForChar(c, profile, resolveCharacterMeterApi(c, apiConfig), force);
            if (result) {
                markAmsgStateDirty({ char: c, userProfile: profile, groups, realtimeConfig });
                setSchedulesVersion(v => v + 1);
            } else addToast('這個角色沒開日程功能', 'info');
        } catch (e: any) {
            addToast(`生成失敗：${e?.message || '未知錯誤'}`, 'error');
        } finally {
            setGenerating(false);
        }
    };
    const deleteDay = async (c: CharacterProfile, key: string) => {
        await DB.deleteDailySchedule(c.id, key);
        setSchedulesVersion(v => v + 1);
        addToast('這天的日程刪掉了', 'info');
    };

    // ── 共用：一條約定 ──
    const renderEventRow = (e: CalendarEvent, opts: { showOwner?: boolean; tz?: string } = {}) => {
        const start = eventTime(e, 'start');
        const end = eventTime(e, 'end');
        const time = start ? dualTime(e.start.slice(0, 10), start, opts.tz, yourTz) : undefined;
        const others = (e.participants || []).filter(p => !sameParticipant(p, e.owner)).map(viewOf);
        const ownerView = viewOf(e.owner);
        return (
            <button key={e.id} onClick={() => setEditing({ event: e, owner: e.owner, kind: e.kind })} className={`w-full text-left rounded-2xl bg-white/85 border border-white p-3 shadow-sm flex items-start gap-3 ${e.done ? 'opacity-50' : ''}`}>
                <div className="w-12 shrink-0 text-[11px] font-bold text-pink-500 tabular-nums leading-tight pt-0.5">
                    {time ? <>{time.local}{end ? <div className="text-slate-400 font-normal">{end}</div> : null}{time.yours && <div className="text-slate-400 font-normal">你 {time.yours}</div>}</> : e.kind === 'todo' ? '待辦' : '全天'}
                </div>
                <div className="min-w-0 flex-1">
                    <div className={`text-[14px] font-bold text-slate-800 leading-snug ${e.done ? 'line-through' : ''}`}>{KIND_EMOJI[e.kind]} {e.title}</div>
                    {e.location && <div className="text-[11px] text-slate-500">{e.location}</div>}
                    {(opts.showOwner || others.length > 0) && (
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400">
                            {opts.showOwner && <><Avatar src={ownerView.avatar} size={16} />{ownerView.name}</>}
                            {others.length > 0 && <><span>·</span>{others.map(o => <Avatar key={`${o.participant.kind}_${o.participant.id}`} src={o.avatar} size={16} />)}<span>跟 {others.map(o => o.name).join('、')}</span></>}
                        </div>
                    )}
                    {e.source === 'char' && <div className="text-[10px] text-slate-400">{ownerView.name}自己加的</div>}
                </div>
            </button>
        );
    };

    // ── 共用：待辦清單 ──
    const renderTodos = (owner: Participant, label: string) => {
        const mine = ownedBy(events, owner).filter(e => e.kind === 'todo');
        const open = openTodos(events, owner);
        const sorted = [...mine].sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.start.localeCompare(b.start));
        return (
            <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-2 shadow-sm">
                <h2 className="text-[13px] font-black text-slate-700">📝 {label} <span className="font-normal text-slate-400">{open.length} 條沒做</span></h2>
                <form onSubmit={e => { e.preventDefault(); void addQuickTodo(owner); }} className="flex gap-2">
                    <input value={quickTodo} onChange={e => setQuickTodo(e.target.value)} placeholder={`加一條（截止 ${dayKey === todayKey ? '今天' : dayKey}）`} aria-label="新待辦"
                        className="min-w-0 flex-1 rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-[13px] outline-none focus:border-pink-200" />
                    <button type="submit" disabled={!quickTodo.trim()} className="rounded-xl bg-pink-400 px-3 text-[12px] font-bold text-white disabled:opacity-40">加</button>
                </form>
                {sorted.length === 0 && <div className="text-[12px] text-slate-400">還沒有待辦。</div>}
                {sorted.map(t => (
                    <div key={t.id} className="flex items-start gap-2 py-1">
                        <button onClick={() => void toggleTodo(t)} aria-label={`${t.done ? '取消完成' : '完成'}：${t.title}`} className="shrink-0">
                            {t.done ? <CheckCircle size={20} weight="fill" className="text-pink-400" /> : <Circle size={20} className="text-slate-300" />}
                        </button>
                        <button onClick={() => setEditing({ event: t, owner: t.owner, kind: 'todo' })} className="min-w-0 flex-1 text-left">
                            <span className={`block text-[14px] leading-snug ${t.done ? 'line-through text-slate-300' : 'text-slate-700'}`}>{t.title}</span>
                            <span className={`block text-[11px] ${t.start === todayKey ? 'text-pink-400' : 'text-slate-400'}`}>
                                📅 {t.start === todayKey ? '今天' : t.start.slice(0, 10)}{t.source === 'char' ? ' · 自己記的' : ''}{t.done && t.doneBy === 'ai' ? ' · AI 勾的' : ''}
                            </span>
                        </button>
                        <button onClick={() => void deleteEvent(t.id)} aria-label={`刪掉：${t.title}`} className="shrink-0 text-slate-300"><Trash size={16} /></button>
                    </div>
                ))}
            </section>
        );
    };

    // ── 月曆 ──
    const renderMonth = () => {
        const grid = monthGrid(monthKey);
        const [y, m] = monthKey.split('-').map(Number);
        const rows = overlapRows(dayKey, scheduleChars.map(c => ({ char: c, tz: resolveCharTimeZone(c), slots: scheduleOf(c, dayKey)?.slots || [] })), yourTz, nowMs);
        const myDay = sortByTime(eventsOn(eventsInvolving(events, me), dayKey));
        const charDay = sortByTime(eventsOn(events.filter(e => e.owner.kind !== 'persona' && !sameParticipant(e.owner, me)), dayKey)).filter(e => !myDay.some(x => x.id === e.id));
        const todoDays = new Set(events.filter(e => e.kind === 'todo' && !e.done).map(e => e.start.slice(0, 10)));
        return (
            <div className="px-4 pb-24 space-y-4">
                <div className="flex items-center justify-between">
                    <button onClick={() => setMonthKey(addMonths(monthKey, -1))} aria-label="上個月" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-500 shadow-sm"><CaretLeft size={16} /></button>
                    <div className="text-center">
                        <div className="text-[18px] font-black text-slate-800">{y} 年 {m} 月</div>
                        {monthKey !== monthKeyOf(todayKey) && <button onClick={() => { setDayKey(todayKey); setMonthKey(monthKeyOf(todayKey)); }} className="text-[11px] text-pink-500 font-bold">回到今天</button>}
                    </div>
                    <button onClick={() => setMonthKey(addMonths(monthKey, 1))} aria-label="下個月" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-500 shadow-sm"><CaretRight size={16} /></button>
                </div>
                <div className="grid grid-cols-7 text-center text-[11px] text-slate-400 font-bold">
                    {['日', '一', '二', '三', '四', '五', '六'].map(d => <div key={d}>{d}</div>)}
                </div>
                <div className="space-y-1.5" role="grid" aria-label="月曆">
                    {grid.map((row, i) => (
                        <div key={i} className="grid grid-cols-7 gap-1.5">
                            {row.map(cell => {
                                const marks = { schedule: scheduleDays.has(cell.key), todo: todoDays.has(cell.key), anniversary: events.some(e => e.kind === 'anniversary' && eventOnDay(e, cell.key)), event: events.some(e => e.kind === 'event' && e.start.slice(0, 10) === cell.key) };
                                const selected = cell.key === dayKey;
                                const isToday = cell.key === todayKey;
                                return (
                                    <button key={cell.key} role="gridcell" aria-selected={selected} aria-label={cell.key} onClick={() => setDayKey(cell.key)}
                                        className={`relative aspect-square rounded-full flex flex-col items-center justify-center text-[14px] font-bold transition
                                            ${selected ? 'bg-pink-400 text-white shadow-md shadow-pink-200' : isToday ? 'bg-white text-pink-500 ring-2 ring-pink-300' : cell.inMonth ? 'bg-white/80 text-slate-700' : 'bg-white/30 text-slate-300'}`}>
                                        {cell.day}
                                        <div className="absolute bottom-1 flex gap-0.5">
                                            {marks.schedule && <span className={`h-1 w-1 rounded-full ${selected ? 'bg-white' : 'bg-sky-400'}`} />}
                                            {marks.event && <span className={`h-1 w-1 rounded-full ${selected ? 'bg-white' : 'bg-violet-400'}`} />}
                                            {marks.todo && <span className={`h-1 w-1 rounded-full ${selected ? 'bg-white' : 'bg-amber-400'}`} />}
                                            {marks.anniversary && <span className={`h-1 w-1 rounded-full ${selected ? 'bg-white' : 'bg-rose-400'}`} />}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>

                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-3 shadow-sm">
                    <h2 className="text-[15px] font-black text-slate-800 flex items-center gap-2"><Sparkle size={16} weight="fill" className="text-amber-400" />{dayKey === todayKey ? '今日' : dayTitle(dayKey)}次元重疊</h2>
                    <div className="rounded-2xl bg-sky-50 p-3 space-y-2">
                        <div className="text-[12px] font-bold text-slate-600">📌 我的行程 <span className="font-normal text-slate-400">· {persona.name}</span></div>
                        {myDay.length === 0 ? <div className="text-[12px] text-slate-400">目前空閒中</div> : myDay.map(e => renderEventRow(e))}
                    </div>
                    <div className="rounded-2xl bg-amber-50 p-3 space-y-2">
                        <div className="text-[12px] font-bold text-slate-600">☁️ 角色行程</div>
                        {charDay.map(e => renderEventRow(e, { showOwner: true }))}
                        {scheduleChars.length === 0
                            ? <div className="text-[12px] text-slate-400">還沒有角色開日程功能：神經鏈接 → 角色的「日程／情緒」打開。</div>
                            : rows.length === 0
                            ? <div className="text-[12px] text-slate-400">這天沒有人排日程。{dayKey === todayKey && <button onClick={() => setTab('theirs')} className="text-pink-500 font-bold ml-1">去生成</button>}</div>
                            : <ul className="space-y-1.5">
                                {rows.map((r, i) => (
                                    <li key={`${r.char.id}_${i}`} className={`flex items-start gap-2 text-[12px] ${r.state === 'past' ? 'opacity-50' : ''}`}>
                                        {stateBadge(r.state) || <span className="w-7" />}
                                        <span className="text-slate-700 leading-snug">
                                            <span className="tabular-nums font-bold text-slate-600">{r.time.local}{r.range.end ? ` - ${r.range.end}` : ''}</span>
                                            {r.time.yours && <span className="text-slate-400">（你 {r.time.yours}）</span>}
                                            {' '}{r.range.slot.emoji} {r.range.slot.activity}
                                            <span className="text-slate-400"> ({r.char.name}){r.range.slot.location ? ` @ ${r.range.slot.location}` : ''}</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>}
                    </div>
                </section>
            </div>
        );
    };

    // ── 我的 ──
    const renderMine = () => {
        const day = sortByTime(eventsOn(eventsInvolving(events, me), dayKey)).filter(e => e.kind !== 'todo');
        return (
            <div className="px-4 pb-24 space-y-4">
                <div className="flex gap-2 overflow-x-auto no-scrollbar py-1" role="radiogroup" aria-label="身份卡">
                    {personas.map(p => (
                        <button key={p.key} role="radio" aria-checked={p.key === persona.key} onClick={() => setPersonaKey(p.key)}
                            className={`flex items-center gap-2 rounded-full pl-1 pr-3 py-1 text-[12px] font-bold shrink-0 border ${p.key === persona.key ? 'bg-pink-400 text-white border-pink-400' : 'bg-white/80 text-slate-600 border-white'}`}>
                            <Avatar src={p.avatar} size={24} />{p.name}{p.isMain && <span className={`text-[9px] ${p.key === persona.key ? 'text-pink-100' : 'text-pink-400'}`}>主線</span>}
                        </button>
                    ))}
                </div>
                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 flex items-center gap-3 shadow-sm">
                    <Avatar src={persona.avatar} size={56} />
                    <div className="min-w-0">
                        <div className="text-[18px] font-black text-slate-800 truncate">{persona.name}</div>
                        <div className="text-[11px] text-slate-400">{persona.timezone ? tzLabel(persona.timezone) : '跟設備時間'} · 今天 {dayTitle(todayKey)}</div>
                    </div>
                </section>
                {renderDayNav()}
                <section className="space-y-2">
                    {day.length === 0 && <div className="rounded-[1.75rem] bg-white/70 border border-white p-5 text-center text-[13px] text-slate-400">這天沒有安排。右下角 ＋ 加一條；AI 照人設生成你的日程是下一批。</div>}
                    {day.map(e => renderEventRow(e, { tz: yourTz }))}
                </section>
                {renderTodos(me, '待辦清單')}
            </div>
        );
    };

    // ── TA 的 ──
    const renderTheirs = () => {
        if (!selectedChar) {
            return <div className="px-6 py-16 text-center text-[13px] text-slate-400 leading-relaxed">還沒有角色開日程功能。<br />到神經鏈接 → 角色的「日程／情緒」打開，再回來。</div>;
        }
        const him = charParticipant(selectedChar.id);
        const tz = resolveCharTimeZone(selectedChar);
        const timeline = resolveCharCalendar(selectedChar);
        const schedule = scheduleOf(selectedChar, dayKey);
        const ranges = schedule ? slotRanges(schedule.slots) : [];
        const nowSlot = schedule ? currentActivity(dayKey, schedule.slots, tz, nowMs) : undefined;
        const hisDay = sortByTime(eventsOn(eventsInvolving(events, him), dayKey)).filter(e => e.kind !== 'todo');
        return (
            <div className="px-4 pb-24 space-y-4">
                <div className="flex gap-2 overflow-x-auto no-scrollbar py-1" role="radiogroup" aria-label="角色">
                    {scheduleChars.map(c => (
                        <button key={c.id} role="radio" aria-checked={c.id === selectedChar.id} onClick={() => setCharId(c.id)} aria-label={c.name}
                            className={`rounded-full p-0.5 shrink-0 border-2 ${c.id === selectedChar.id ? 'border-pink-400' : 'border-transparent'}`}>
                            <Avatar src={c.avatar} size={40} />
                        </button>
                    ))}
                </div>
                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 flex items-center gap-3 shadow-sm">
                    <Avatar src={selectedChar.avatar} size={56} />
                    <div className="min-w-0 flex-1">
                        <div className="text-[18px] font-black text-slate-800 truncate">{selectedChar.name}</div>
                        <div className="text-[12px] text-slate-500 truncate">{dayKey === todayKey && nowSlot ? `${nowSlot.emoji || ''} ${nowSlot.activity}` : schedule ? '這天有日程' : '這天還沒排'}</div>
                        <div className="text-[11px] text-slate-400">{timeline ? '架空曆法' : tz ? tzLabel(tz) : '跟設備時間'}</div>
                    </div>
                    <button onClick={() => void generateToday(selectedChar, !!scheduleOf(selectedChar, todayKey))} disabled={generating} aria-label={scheduleOf(selectedChar, todayKey) ? '重新生成今天的日程' : '生成今天的日程'}
                        className="h-11 w-11 rounded-full bg-white grid place-items-center text-pink-500 shadow-md disabled:opacity-50">
                        {generating ? <ArrowClockwise size={20} className="animate-spin" /> : <Sparkle size={20} weight="fill" />}
                    </button>
                </section>
                {renderDayNav(timeline ? dayTitle(dayKey, timeline) : undefined)}
                {hisDay.length > 0 && (
                    <section className="space-y-2">
                        <h2 className="px-1 text-[12px] font-bold text-slate-500">約好的事</h2>
                        {hisDay.map(e => renderEventRow(e, { tz }))}
                    </section>
                )}
                {!schedule ? (
                    <div className="rounded-[1.75rem] bg-white/70 border border-white p-6 text-center text-[13px] text-slate-400 leading-relaxed">
                        這天沒有日程。{dayKey === todayKey ? <>右上角 ✦ 生成今天的。</> : '只能生成今天的；一週一次、提早一天是下一批。'}
                    </div>
                ) : (
                    <div className="relative pl-16">
                        <div className="absolute left-[3.2rem] top-2 bottom-2 w-0.5 bg-pink-200" />
                        <div className="space-y-3">
                            {ranges.map(r => {
                                const state = rangeState(dayKey, r, tz, nowMs);
                                const time = dualTime(dayKey, r.start, tz, yourTz);
                                const endTime = r.end ? dualTime(dayKey, r.end, tz, yourTz) : undefined;
                                return (
                                    <div key={r.index} className="relative">
                                        <div className="absolute -left-16 top-2"><TimeCell time={time} dim={state === 'past'} /></div>
                                        <div className={`absolute -left-[1.05rem] top-3 h-3 w-3 rounded-full border-2 ${state === 'now' ? 'bg-pink-500 border-pink-500' : 'bg-white border-pink-300'}`} />
                                        <div className={`rounded-[1.5rem] bg-white/85 border border-white p-4 shadow-sm ${state === 'past' ? 'opacity-60' : ''}`}>
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="text-[15px] font-black text-slate-800 leading-snug">{r.slot.emoji} {r.slot.activity}</div>
                                                {stateBadge(state)}
                                            </div>
                                            {r.slot.location && <div className="text-[12px] text-slate-500 mt-0.5">{r.slot.location}</div>}
                                            <div className="text-[12px] text-sky-500 font-bold mt-1 tabular-nums">
                                                {r.start}{r.end ? ` - ${r.end}` : ' 起'}
                                                {time.yours && <span className="text-slate-400 font-normal"> · 你 {time.yours}{endTime?.yours ? ` - ${endTime.yours}` : ''}</span>}
                                            </div>
                                            {r.slot.description && <div className="mt-2 border-t border-slate-100 pt-2 text-right text-[11px] italic text-slate-400">{r.slot.description}</div>}
                                        </div>
                                    </div>
                                );
                            })}
                            <div className="flex items-center justify-between pt-1">
                                <div className="text-[12px] text-slate-400">💤 一日結束</div>
                                <button onClick={() => void deleteDay(selectedChar, dayKey)} aria-label="刪掉這天的日程" className="flex items-center gap-1 text-[11px] text-rose-400"><Trash size={14} />刪掉這天</button>
                            </div>
                        </div>
                    </div>
                )}
                {renderTodos(him, `${selectedChar.name} 的待辦`)}
            </div>
        );
    };

    function renderDayNav(title?: string) {
        return (
            <div className="flex items-center justify-between">
                <button onClick={() => setDayKey(addDays(dayKey, -1))} aria-label="前一天" className="h-8 w-8 rounded-full bg-white/80 grid place-items-center text-slate-500"><CaretLeft size={14} /></button>
                <button onClick={() => setDayKey(todayKey)} className="text-[15px] font-black text-slate-800">{title || dayTitle(dayKey)}{dayKey === todayKey && <span className="ml-1 text-[10px] text-pink-400">今天</span>}</button>
                <button onClick={() => setDayKey(addDays(dayKey, 1))} aria-label="後一天" className="h-8 w-8 rounded-full bg-white/80 grid place-items-center text-slate-500"><CaretRight size={14} /></button>
            </div>
        );
    }

    const fabOwner: Participant = tab === 'theirs' && selectedChar ? charParticipant(selectedChar.id) : me;

    return (
        <div className="h-full w-full flex flex-col bg-gradient-to-b from-pink-50 via-rose-50 to-sky-50 text-slate-800 animate-fade-in relative" data-calendar-app>
            <div className="shrink-0 px-4 pb-2 flex items-center justify-between" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
                <button onClick={closeApp} aria-label="關閉" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-600 shadow-sm"><CaretLeft size={18} /></button>
                <div className="text-[16px] font-black">{tab === 'month' ? '行事曆' : tab === 'mine' ? '我的' : 'TA 的'}</div>
                <div className="h-9 w-9" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar">
                {tab === 'month' ? renderMonth() : tab === 'mine' ? renderMine() : renderTheirs()}
            </div>
            <button onClick={() => setEditing({ owner: fabOwner, kind: 'event' })} aria-label="加一條"
                className="absolute right-5 h-14 w-14 rounded-2xl bg-pink-400 text-white shadow-lg shadow-pink-200 grid place-items-center active:scale-95 transition"
                style={{ bottom: 'calc(var(--safe-bottom, 0px) + 4.5rem)' }}>
                <Plus size={26} weight="bold" />
            </button>
            <nav className="shrink-0 bg-white/90 backdrop-blur border-t border-white flex" style={{ paddingBottom: 'var(--safe-bottom, 0px)' }} aria-label="行事曆分頁">
                {([['month', '月曆', CalendarBlank], ['mine', '我的', UserIcon], ['theirs', 'TA 的', UsersThree]] as const).map(([id, label, Icon]) => (
                    <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
                        className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-bold ${tab === id ? 'text-pink-500' : 'text-slate-400'}`}>
                        <Icon size={22} weight={tab === id ? 'fill' : 'regular'} />{label}
                    </button>
                ))}
            </nav>
            {editing && (
                <AddEventPage
                    initial={editing.event}
                    defaultOwner={editing.owner}
                    defaultKind={editing.kind}
                    defaultDay={dayKey}
                    owners={participantChoices.filter(p => p.participant.kind !== 'npc')}
                    participants={participantChoices}
                    onSave={async e => { await saveEvent(e); setEditing(null); }}
                    onDelete={editing.event ? async () => { await deleteEvent(editing.event!.id); setEditing(null); } : undefined}
                    onClose={() => setEditing(null)}
                />
            )}
        </div>
    );
};

export default CalendarApp;
