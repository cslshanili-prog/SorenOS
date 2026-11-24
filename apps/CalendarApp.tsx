import { calendarLaunch } from '../utils/appLaunch';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarBlank, CaretLeft, CaretRight, CheckCircle, Circle, DotsThree, Plus, Sparkle, Trash, User as UserIcon, UsersThree } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import TokenImg from '../components/os/TokenImg';
import type { CalendarEvent, CharacterProfile, DailySchedule, Participant, ScheduleSlot, Trip } from '../types';
import { DB } from '../utils/db';
import { isAltChar } from '../utils/charAlt';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { charSchedulePerson, personaScheduleId, personaSchedulePerson, type SchedulePerson } from '../utils/schedulePerson';
import { REAL_IDENTITY_PERSONA_ID } from '../utils/userPersona';
import { cancelScheduleAutoTask, scheduleAutoCloudGate, submitScheduleAutoTask } from '../utils/scheduleAutoCloud';
import type { ScheduleAutoConfig } from '../types';
import { resolveCharacterMeterApi } from '../utils/characterApi';
import { resolveUserProfileForChar } from '../utils/userPersona';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { resolveCharBaseTimeZone, tzLabel } from '../utils/timezone';
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
import DayPickerPage from '../components/calendar/DayPickerPage';
import PersonPickerPage from '../components/calendar/PersonPickerPage';
import GeneratePage from '../components/calendar/GeneratePage';
import TripPage from '../components/calendar/TripPage';
import { refreshTripRegistry, tripLabel, tripOn, tripsOf, tripsOnDay } from '../utils/trips';
import { AirplaneTilt } from '@phosphor-icons/react';

/**
 * 行事曆（plans/calendar.md）：月曆／我的／TA 的三個分頁。
 * 第 1 批：殼。第 2 批：約定層（calendar_events）——手動加的、待辦、紀念日；時光契約退役，資料搬進來。
 * 角色的一天還是 DailySchedule（只讀它顯示、能生成今天）；時間照 plans/time-system.md：那個人那邊＋「你 xx:xx」。
 */

type Tab = 'month' | 'mine' | 'theirs';

/** 「TA 的」最近看過誰（角色、配角），頭像列只放這幾個，其他的從「更多」找 */
const RECENT_KEY = 'soren_calendar_recent_people_v1';
const RECENT_LIMIT = 6;
const readRecent = (): Participant[] => {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(v) ? v.filter((p: any) => p && (p.kind === 'char' || p.kind === 'npc') && typeof p.id === 'string') : [];
    } catch { return []; }
};
const pushRecent = (list: Participant[], p: Participant): Participant[] => {
    const next = [p, ...list.filter(x => !sameParticipant(x, p))].slice(0, RECENT_LIMIT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 存不了就只記這次 */ }
    return next;
};

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
    const { closeApp, characters, npcs, activeCharacterId, userProfileBase, apiConfig, groups, realtimeConfig, addToast, updateCharacter, updateUserProfile, updateUserPersona } = useOS();
    // 從角色名片「行事曆」進來：直接看這個角色（utils/appLaunch.ts；看的人照 activeCharacterId）
    const [tab, setTab] = useState<Tab>(() => calendarLaunch.peek()?.tab || 'month');
    useEffect(() => { calendarLaunch.consume(); }, []);
    const personas = useMemo(() => personaOptions(userProfileBase), [userProfileBase]);
    const [personaKey, setPersonaKey] = useState<string>(() => personas.find(p => p.isMain)?.key || personas[0].key);
    const persona: PersonaOption = personas.find(p => p.key === personaKey) || personas[0];
    const me: Participant = personaParticipant(persona.key);
    const yourTz = persona.timezone;
    const todayKey = personaTodayKey(yourTz);
    const [dayKey, setDayKey] = useState(todayKey);
    const [monthKey, setMonthKey] = useState(monthKeyOf(todayKey));

    // 角色（小號藏起來）；有日程功能的那些月曆要撈日程
    const visibleChars = useMemo(() => characters.filter(c => !isAltChar(c)), [characters]);
    const scheduleChars = useMemo(() => visibleChars.filter(c => isScheduleFeatureOn(c)), [visibleChars]);
    // 「TA 的」看誰：角色或配角；最近看過的放頭像列，其他從全螢幕選人頁找
    const [recent, setRecent] = useState<Participant[]>(readRecent);
    const exists = useCallback((p: Participant) => p.kind === 'char' ? visibleChars.some(c => c.id === p.id) : p.kind === 'npc' && npcs.some(n => n.id === p.id), [visibleChars, npcs]);
    const [who, setWhoRaw] = useState<Participant | null>(() => {
        if (activeCharacterId && visibleChars.some(c => c.id === activeCharacterId)) return charParticipant(activeCharacterId);
        const r = readRecent().find(exists);
        return r || (visibleChars[0] ? charParticipant(visibleChars[0].id) : null);
    });
    const setWho = (p: Participant) => { setWhoRaw(p); setRecent(prev => pushRecent(prev, p)); };
    const [picking, setPicking] = useState(false);
    const [pickingDay, setPickingDay] = useState(false);
    const whoChar = who?.kind === 'char' ? visibleChars.find(c => c.id === who.id) || null : null;
    const whoNpc = who?.kind === 'npc' ? npcs.find(n => n.id === who.id) || null : null;

    // 約定層（時光契約的待辦、紀念日第一次打開就搬進來）
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [trips, setTrips] = useState<Trip[]>([]);
    const reloadEvents = useCallback(() => {
        loadCalendarEvents().then(setEvents).catch(() => setEvents([]));
        refreshTripRegistry().then(setTrips).catch(() => setTrips([]));
    }, []);
    const saveTrip = async (t: Trip) => { await DB.saveTrip(t); reloadEvents(); };
    const deleteTrip = async (id: string) => { await DB.deleteTrip(id); reloadEvents(); };
    const [editingTrip, setEditingTrip] = useState<{ trip?: Trip; owner: Participant } | null>(null);
    /** 這個人這天的時區：旅行 > 原本的（世界／角色／身份卡所在地） */
    const tzOn = (who: Participant, base: string | undefined, key: string): string | undefined => tripOn(trips, who, key)?.timezone || base;
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

    // 月份裡每個角色有哪幾天的日程（打點＋今日交會點）；key = `${charId}_${date}`
    const [monthSchedules, setMonthSchedules] = useState<Map<string, DailySchedule>>(new Map());
    const [schedulesVersion, setSchedulesVersion] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const { from, to } = monthRange(monthKey);
        const ids = [...scheduleChars.map(c => c.id), ...personas.map(p => personaScheduleId(p.key))];
        Promise.all(ids.map(id => DB.getDailySchedulesInRange(id, from, to).catch(() => [] as DailySchedule[])))
            .then(lists => {
                if (cancelled) return;
                const next = new Map<string, DailySchedule>();
                for (const list of lists) for (const s of list) next.set(`${s.charId}_${s.date}`, s);
                setMonthSchedules(next);
            });
        return () => { cancelled = true; };
    }, [monthKey, scheduleChars, personas, schedulesVersion]);
    useEffect(() => { if (monthKeyOf(dayKey) !== monthKey) setMonthKey(monthKeyOf(dayKey)); }, [dayKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const scheduleOf = (c: CharacterProfile | { id: string }, key: string) => monthSchedules.get(`${c.id}_${key}`) || null;
    const personaSchedule = (key: string) => monthSchedules.get(`${personaScheduleId(persona.key)}_${key}`) || null;
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

    // 生成頁（全螢幕）：角色或身份卡
    const [generating, setGenerating] = useState<SchedulePerson | null>(null);
    const personaPerson = useMemo(() => personaSchedulePerson(userProfileBase, persona.key), [userProfileBase, persona.key]);
    const savePromptFor = (p: SchedulePerson, text: string) => {
        const schedulePrompt = text || undefined;
        if (p.kind === 'char') updateCharacter(p.scheduleId, { schedulePrompt });
        else if (p.participant.id === REAL_IDENTITY_PERSONA_ID) updateUserProfile({ schedulePrompt });
        else void updateUserPersona(p.participant.id, { schedulePrompt });
    };
    const autoOf = (p: SchedulePerson): ScheduleAutoConfig | undefined => {
        if (p.kind === 'char') return characters.find(c => c.id === p.scheduleId)?.scheduleAuto;
        if (p.participant.id === REAL_IDENTITY_PERSONA_ID) return userProfileBase.scheduleAuto;
        return userProfileBase.personas?.find(x => x.id === p.participant.id)?.scheduleAuto;
    };
    const saveAutoFor = (p: SchedulePerson, scheduleAuto: ScheduleAutoConfig) => {
        if (p.kind === 'char') updateCharacter(p.scheduleId, { scheduleAuto });
        else if (p.participant.id === REAL_IDENTITY_PERSONA_ID) updateUserProfile({ scheduleAuto });
        else void updateUserPersona(p.participant.id, { scheduleAuto });
    };
    /** 雲端那條：開＝探測、排任務、寫回；關＝取消；回錯誤訊息給頁面顯示 */
    const toggleCloudFor = async (p: SchedulePerson, enabled: boolean): Promise<string | null> => {
        const c = p.kind === 'char' ? characters.find(x => x.id === p.scheduleId) : undefined;
        if (!c) return '只有角色能排雲端';
        const scope = { userProfileBase, apiConfig, groups, realtimeConfig };
        try {
            if (!enabled) {
                await cancelScheduleAutoTask(c);
                updateCharacter(c.id, { scheduleAuto: { ...(c.scheduleAuto || { enabled: true, every: 'day', ahead: 1 }), cloud: undefined } });
                return null;
            }
            const gate = await scheduleAutoCloudGate(c, apiConfig);
            if (gate === 'no-worker') return '主動消息 2.0 還沒接（設置 → 主動消息）';
            if (gate === 'unsupported') return '這台 Worker 的代碼還不認識後台任務，去設置頁重新部署一次';
            if (gate === 'no-api') return '日程 API 沒配齊';
            if (gate === 'unknown') return '剛才沒問到 Worker，等一下再試';
            if (c.scheduleAuto?.cloud) await cancelScheduleAutoTask(c);
            const cloud = await submitScheduleAutoTask({ ...c, scheduleAuto: { ...(c.scheduleAuto || { enabled: true, every: 'day', ahead: 1 }), enabled: true } }, scope);
            updateCharacter(c.id, { scheduleAuto: { ...(c.scheduleAuto || { every: 'day', ahead: 1 }), enabled: true, cloud } });
            return null;
        } catch (e: any) {
            return `排不上：${e?.message || '未知錯誤'}`;
        }
    };
    const afterGenerated = (p: SchedulePerson) => {
        if (p.char) markAmsgStateDirty({ char: p.char, userProfile: resolveUserProfileForChar(userProfileBase, p.char), groups, realtimeConfig });
        setSchedulesVersion(v => v + 1);
        reloadEvents();
    };
    const batchFor = () => scheduleChars.map(c => ({ person: charSchedulePerson(c), userProfile: resolveUserProfileForChar(userProfileBase, c), api: resolveCharacterMeterApi(c, apiConfig) }));
    const deleteDay = async (scheduleId: string, key: string) => {
        await DB.deleteDailySchedule(scheduleId, key);
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

    // ── 共用：某天的時間軸（角色或身份卡的 DailySchedule）──
    const slotPeople = (slot: ScheduleSlot) => (slot.participants || []).map(viewOf);
    const todoTitle = (id: string | undefined) => (id ? events.find(e => e.id === id)?.title : undefined);
    const renderTimeline = (schedule: DailySchedule, tz: string | undefined, onDelete: () => void) => {
        const ranges = slotRanges(schedule.slots);
        return (
            <div className="relative pl-16">
                <div className="absolute left-[3.2rem] top-2 bottom-2 w-0.5 bg-pink-200" />
                <div className="space-y-3">
                    {ranges.map(r => {
                        const state = rangeState(dayKey, r, tz, nowMs);
                        const time = dualTime(dayKey, r.start, tz, yourTz);
                        const endTime = r.end ? dualTime(dayKey, r.end, tz, yourTz) : undefined;
                        const people = slotPeople(r.slot);
                        const todo = todoTitle(r.slot.todoId);
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
                                    {(r.slot.with || todo) && (
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                                            {r.slot.with && <span className="flex items-center gap-1">{people.map(p => <Avatar key={`${p.participant.kind}_${p.participant.id}`} src={p.avatar} size={16} />)}跟 {r.slot.with} 一起</span>}
                                            {todo && <span className="rounded-full bg-amber-50 px-1.5 text-amber-600">☐ {todo}</span>}
                                        </div>
                                    )}
                                    {r.slot.description && <div className="mt-2 border-t border-slate-100 pt-2 text-right text-[11px] italic text-slate-400">{r.slot.description}</div>}
                                </div>
                            </div>
                        );
                    })}
                    <div className="flex items-center justify-between pt-1">
                        <div className="text-[12px] text-slate-400">💤 一日結束</div>
                        <button onClick={onDelete} aria-label="刪掉這天的日程" className="flex items-center gap-1 text-[11px] text-rose-400"><Trash size={14} />刪掉這天</button>
                    </div>
                </div>
            </div>
        );
    };

    // ── 共用：旅行清單 ──
    const renderTrips = (who: Participant) => {
        const list = tripsOf(trips, who);
        return (
            <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-2 shadow-sm">
                <div className="flex items-center justify-between">
                    <h2 className="text-[13px] font-black text-slate-700"><AirplaneTilt size={14} weight="fill" className="inline -mt-0.5 mr-1 text-teal-500" />旅行 <span className="font-normal text-slate-400">{list.length ? `${list.length} 趟` : ''}</span></h2>
                    <button onClick={() => setEditingTrip({ owner: who })} className="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-bold text-teal-600">＋ 加一趟</button>
                </div>
                {list.length === 0 && <div className="text-[12px] text-slate-400">沒有排旅行。期間時區換成目的地、日程會寫成在那邊的一天、天氣跟著目的地。</div>}
                {list.map(t => {
                    const past = t.to < todayKey;
                    const now = t.from <= todayKey && todayKey <= t.to;
                    return (
                        <button key={t.id} onClick={() => setEditingTrip({ trip: t, owner: t.owner })} className={`w-full text-left flex items-start gap-2 py-1 ${past ? 'opacity-50' : ''}`}>
                            <span className="text-[16px] leading-6">{t.kind === 'business' ? '💼' : t.kind === 'travel' ? '✈️' : '🧳'}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-[14px] font-bold text-slate-700 leading-snug">{t.destination}{now && <span className="ml-1.5 rounded-full bg-teal-500 px-1.5 text-[9px] font-bold text-white align-middle">出行中</span>}</span>
                                <span className="block text-[11px] text-slate-400">{t.from.slice(5)} ～ {t.to.slice(5)}{t.timezone ? ` · ${tzLabel(t.timezone)}` : ''}{t.note ? ` · ${t.note}` : ''}</span>
                            </span>
                        </button>
                    );
                })}
            </section>
        );
    };

    // ── 月曆 ──
    const renderMonth = () => {
        const grid = monthGrid(monthKey);
        const [y, m] = monthKey.split('-').map(Number);
        const rows = overlapRows(dayKey, scheduleChars.map(c => ({ char: c, tz: tzOn(charParticipant(c.id), resolveCharBaseTimeZone(c), dayKey), slots: scheduleOf(c, dayKey)?.slots || [] })), yourTz, nowMs);
        const myDay = sortByTime(eventsOn(eventsInvolving(events, me), dayKey));
        const myRows = overlapRows(dayKey, [{ char: { id: personaScheduleId(persona.key), name: persona.name, avatar: persona.avatar }, tz: yourTz, slots: personaSchedule(dayKey)?.slots || [] }], yourTz, nowMs);
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
                                const marks = { schedule: scheduleDays.has(cell.key), todo: todoDays.has(cell.key), anniversary: events.some(e => e.kind === 'anniversary' && eventOnDay(e, cell.key)), event: events.some(e => e.kind === 'event' && e.start.slice(0, 10) === cell.key), trip: tripsOnDay(trips, cell.key).length > 0 };
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
                                            {marks.trip && <span className={`h-1 w-1 rounded-full ${selected ? 'bg-white' : 'bg-teal-400'}`} />}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>

                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 space-y-3 shadow-sm">
                    <h2 className="text-[15px] font-black text-slate-800 flex items-center gap-2"><Sparkle size={16} weight="fill" className="text-amber-400" />{dayKey === todayKey ? '今日' : dayTitle(dayKey)}交會點</h2>
                    {tripsOnDay(trips, dayKey).length > 0 && (
                        <div className="rounded-2xl bg-teal-50 p-3 space-y-1">
                            <div className="text-[12px] font-bold text-slate-600">✈️ 出行中</div>
                            {tripsOnDay(trips, dayKey).map(t => { const v = viewOf(t.owner); return <div key={t.id} className="flex items-center gap-1.5 text-[12px] text-slate-700"><Avatar src={v.avatar} size={16} />{v.name} · {tripLabel(t, dayKey)}</div>; })}
                        </div>
                    )}
                    <div className="rounded-2xl bg-sky-50 p-3 space-y-2">
                        <div className="text-[12px] font-bold text-slate-600">📌 我的行程 <span className="font-normal text-slate-400">· {persona.name}</span></div>
                        {myDay.length === 0 && myRows.length === 0 ? <div className="text-[12px] text-slate-400">今天還沒有排程</div> : myDay.map(e => renderEventRow(e))}
                        {myRows.length > 0 && (
                            <ul className="space-y-1.5">
                                {myRows.map((r, i) => (
                                    <li key={i} className={`flex items-start gap-2 text-[12px] ${r.state === 'past' ? 'opacity-50' : ''}`}>
                                        {stateBadge(r.state) || <span className="w-7" />}
                                        <span className="text-slate-700 leading-snug"><span className="tabular-nums font-bold text-slate-600">{r.time.local}{r.range.end ? ` - ${r.range.end}` : ''}</span>{' '}{r.range.slot.emoji} {r.range.slot.activity}{r.range.slot.with ? <span className="text-slate-400">（跟 {r.range.slot.with}）</span> : null}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="rounded-2xl bg-amber-50 p-3 space-y-2">
                        <div className="text-[12px] font-bold text-slate-600">☁️ 角色行程</div>
                        {charDay.map(e => renderEventRow(e, { showOwner: true }))}
                        {scheduleChars.length === 0
                            ? <div className="text-[12px] text-slate-400">還沒有角色開日程功能：神經鏈接 → 角色的「日程／情緒」打開。</div>
                            : rows.length === 0
                            ? <div className="text-[12px] text-slate-400">{dayKey === todayKey ? <>他今天似乎很神秘，還沒寫下行程。<button onClick={() => setTab('theirs')} className="text-pink-500 font-bold ml-1">看看他在忙什麼</button></> : '這天還沒寫下行程。'}</div>
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
        const mySchedule = personaSchedule(dayKey);
        const myTrip = tripOn(trips, me, dayKey);
        const myTz = myTrip?.timezone || yourTz;
        const myNow = mySchedule ? currentActivity(dayKey, mySchedule.slots, myTz, nowMs) : undefined;
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
                    <div className="min-w-0 flex-1">
                        <div className="text-[18px] font-black text-slate-800 truncate">{persona.name}</div>
                        <div className="text-[12px] text-slate-500 truncate">{dayKey === todayKey && myNow ? `${myNow.emoji || ''} ${myNow.activity}` : mySchedule ? '這天有日程' : '這天還沒排'}</div>
                        {myTrip && <div className="text-[11px] font-bold text-teal-600">{tripLabel(myTrip, dayKey)}</div>}
                        <div className="text-[11px] text-slate-400">{myTz ? tzLabel(myTz) : '跟設備時間'} · 今天 {dayTitle(todayKey)}</div>
                    </div>
                    <button onClick={() => setGenerating(personaPerson)} aria-label="生成我的日程" className="h-11 w-11 rounded-full bg-white grid place-items-center text-pink-500 shadow-md"><Sparkle size={20} weight="fill" /></button>
                </section>
                {renderDayNav()}
                {day.length > 0 && (
                    <section className="space-y-2">
                        <h2 className="px-1 text-[12px] font-bold text-slate-500">約好的事</h2>
                        {day.map(e => renderEventRow(e, { tz: yourTz }))}
                    </section>
                )}
                {mySchedule
                    ? renderTimeline(mySchedule, myTz, () => void deleteDay(personaScheduleId(persona.key), dayKey))
                    : <div className="rounded-[1.75rem] bg-white/70 border border-white p-5 text-center text-[13px] text-slate-400 leading-relaxed">{day.length === 0 ? '這天沒有安排。' : ''}右下角 ＋ 加一條；右上角 ✦ 讓 AI 照這張卡的人設排一天或一週。</div>}
                {renderTrips(me)}
                {renderTodos(me, '待辦清單')}
            </div>
        );
    };

    // ── TA 的 ──
    const renderTheirs = () => {
        const person = whoChar || whoNpc;
        if (!who || !person) {
            return <div className="px-6 py-16 text-center text-[13px] text-slate-400 leading-relaxed">還沒有角色。<br />到神經鏈接建一個，再回來。</div>;
        }
        const hasSchedule = !!whoChar && isScheduleFeatureOn(whoChar);
        const tz = tzOn(who, resolveCharBaseTimeZone(whoChar || { groupId: whoNpc?.groupId }), dayKey);
        const trip = tripOn(trips, who, dayKey);
        const timeline = resolveCharCalendar(person);
        const schedule = whoChar && hasSchedule ? scheduleOf(whoChar, dayKey) : null;
        const ranges = schedule ? slotRanges(schedule.slots) : [];
        const nowSlot = schedule ? currentActivity(dayKey, schedule.slots, tz, nowMs) : undefined;
        const hisDay = sortByTime(eventsOn(eventsInvolving(events, who), dayKey)).filter(e => e.kind !== 'todo');
        const rowPeople = [who, ...recent.filter(p => !sameParticipant(p, who))].filter(exists).slice(0, RECENT_LIMIT);
        return (
            <div className="px-4 pb-24 space-y-4">
                <div className="flex gap-2 overflow-x-auto no-scrollbar py-1 items-center" role="radiogroup" aria-label="最近看過">
                    {rowPeople.map(p => {
                        const v = viewOf(p);
                        const on = sameParticipant(p, who);
                        return (
                            <button key={`${p.kind}_${p.id}`} role="radio" aria-checked={on} onClick={() => setWho(p)} aria-label={v.name}
                                className={`rounded-full p-0.5 shrink-0 border-2 ${on ? 'border-pink-400' : 'border-transparent'}`}>
                                <Avatar src={v.avatar} size={40} />
                            </button>
                        );
                    })}
                    <button onClick={() => setPicking(true)} aria-label="找別人" className="shrink-0 h-11 w-11 rounded-full bg-white/80 border-2 border-dashed border-pink-200 grid place-items-center text-pink-400">
                        <DotsThree size={22} weight="bold" />
                    </button>
                    <span className="text-[11px] text-slate-400 shrink-0">{visibleChars.length + npcs.length} 人</span>
                </div>
                <section className="rounded-[1.75rem] bg-white/85 border border-white p-4 flex items-center gap-3 shadow-sm">
                    <button onClick={() => setPicking(true)} aria-label="換一個人看" className="shrink-0"><Avatar src={person.avatar} size={56} /></button>
                    <div className="min-w-0 flex-1">
                        <div className="text-[18px] font-black text-slate-800 truncate">{person.name}{whoNpc && <span className="ml-1.5 align-middle rounded-full bg-violet-50 px-1.5 text-[10px] font-bold text-violet-500">配角</span>}</div>
                        <div className="text-[12px] text-slate-500 truncate">
                            {whoNpc ? '配角沒有日程，只有約好的事和待辦' : !hasSchedule ? '沒開日程功能' : dayKey === todayKey && nowSlot ? `${nowSlot.emoji || ''} ${nowSlot.activity}` : schedule ? '這天有日程' : '這天還沒排'}
                        </div>
                        {trip && <div className="text-[11px] font-bold text-teal-600">{tripLabel(trip, dayKey)}</div>}
                        <div className="text-[11px] text-slate-400">{timeline ? '架空曆法' : tz ? tzLabel(tz) : '跟設備時間'}</div>
                    </div>
                    {whoChar && hasSchedule && (
                        <button onClick={() => setGenerating(charSchedulePerson(whoChar))} aria-label="生成日程"
                            className="h-11 w-11 rounded-full bg-white grid place-items-center text-pink-500 shadow-md">
                            <Sparkle size={20} weight="fill" />
                        </button>
                    )}
                </section>
                {renderDayNav(timeline ? dayTitle(dayKey, timeline) : undefined)}
                {hisDay.length > 0 && (
                    <section className="space-y-2">
                        <h2 className="px-1 text-[12px] font-bold text-slate-500">約好的事</h2>
                        {hisDay.map(e => renderEventRow(e, { tz }))}
                    </section>
                )}
                {whoNpc ? (
                    hisDay.length === 0 && <div className="rounded-[1.75rem] bg-white/70 border border-white p-6 text-center text-[13px] text-slate-400 leading-relaxed">這天沒有約好的事。配角沒有日程表，右下角 ＋ 可以替 TA 加一條。</div>
                ) : !hasSchedule ? (
                    <div className="rounded-[1.75rem] bg-white/70 border border-white p-6 text-center text-[13px] text-slate-400 leading-relaxed">這個角色沒開日程功能：神經鏈接 → 角色的「日程／情緒」打開，就能生成 TA 的一天。</div>
                ) : !schedule ? (
                    <div className="rounded-[1.75rem] bg-white/70 border border-white p-6 text-center text-[13px] text-slate-400 leading-relaxed">
                        這天沒有日程。右上角 ✦ 生成今天或這週的。
                    </div>
                ) : renderTimeline(schedule, tz, () => whoChar && void deleteDay(whoChar.id, dayKey))}
                {renderTrips(who)}
                {renderTodos(who, `${person.name} 的待辦`)}
            </div>
        );
    };

    function renderDayNav(title?: string) {
        const isToday = dayKey === todayKey;
        return (
            <div className="flex items-center justify-between">
                <button onClick={() => setDayKey(addDays(dayKey, -1))} aria-label="前一天" className="h-8 w-8 rounded-full bg-white/80 grid place-items-center text-slate-500"><CaretLeft size={14} /></button>
                <div className="flex flex-col items-center leading-tight">
                    <button onClick={() => setPickingDay(true)} aria-label="選一天" className="text-[15px] font-black text-slate-800">{title || dayTitle(dayKey)}</button>
                    {isToday
                        ? <span className="text-[10px] text-pink-400">今天</span>
                        : <button onClick={() => setDayKey(todayKey)} className="text-[10px] font-bold text-pink-500">回到今天</button>}
                </div>
                <button onClick={() => setDayKey(addDays(dayKey, 1))} aria-label="後一天" className="h-8 w-8 rounded-full bg-white/80 grid place-items-center text-slate-500"><CaretRight size={14} /></button>
            </div>
        );
    }

    const fabOwner: Participant = tab === 'theirs' && who ? who : me;

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
            {picking && (
                <PersonPickerPage
                    characters={visibleChars}
                    npcs={npcs}
                    worlds={groups}
                    selected={who || undefined}
                    recent={recent.filter(exists)}
                    onPick={p => { setWho(p); setPicking(false); }}
                    onClose={() => setPicking(false)}
                />
            )}
            {editingTrip && (
                <TripPage
                    initial={editingTrip.trip}
                    defaultOwner={editingTrip.owner}
                    defaultFrom={dayKey}
                    owners={participantChoices}
                    onSave={async t => { await saveTrip(t); setEditingTrip(null); }}
                    onDelete={editingTrip.trip ? async () => { await deleteTrip(editingTrip.trip!.id); setEditingTrip(null); } : undefined}
                    onClose={() => setEditingTrip(null)}
                />
            )}
            {generating && (
                <GeneratePage
                    person={generating}
                    userProfile={generating.char ? resolveUserProfileForChar(userProfileBase, generating.char) : userProfileBase}
                    api={generating.char ? resolveCharacterMeterApi(generating.char, apiConfig) : apiConfig}
                    hasToday={!!monthSchedules.get(`${generating.scheduleId}_${todayKey}`)}
                    batch={generating.kind === 'char' ? batchFor() : undefined}
                    onSavePrompt={text => savePromptFor(generating, text)}
                    onGenerated={afterGenerated}
                    auto={autoOf(generating)}
                    onSaveAuto={a => saveAutoFor(generating, a)}
                    onCloudToggle={generating.kind === 'char' ? enabled => toggleCloudFor(generating, enabled) : undefined}
                    onClose={() => setGenerating(null)}
                />
            )}
            {pickingDay && (
                <DayPickerPage
                    value={dayKey}
                    todayKey={todayKey}
                    hasMark={key => (tab === 'theirs' && who ? eventsInvolving(events, who) : eventsInvolving(events, me)).some(e => eventOnDay(e, key)) || (tab === 'theirs' && !!whoChar && !!scheduleOf(whoChar, key))}
                    onPick={key => { setDayKey(key); setPickingDay(false); }}
                    onClose={() => setPickingDay(false)}
                />
            )}
            {editing && (
                <AddEventPage
                    initial={editing.event}
                    defaultOwner={editing.owner}
                    defaultKind={editing.kind}
                    defaultDay={dayKey}
                    owners={participantChoices}
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
