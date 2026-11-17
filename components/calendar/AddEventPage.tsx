import React, { useEffect, useState } from 'react';
import { CaretLeft, Check, Trash } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import ExpandableTextarea from '../common/ExpandableTextarea';
import type { CalendarEvent, Participant } from '../../types';
import { newEvent, sameParticipant } from '../../utils/calendarEvents';

/**
 * 行事曆的「加一條」全螢幕頁（plans/calendar.md 第 6 節第 2 批；不要半窗）。
 * 新增和編輯共用：選誰的、種類（事件／待辦／紀念日）、標題、日期／時段或全天、地點、參與者、備註。
 */

export interface ParticipantView {
    participant: Participant;
    name: string;
    avatar: string;
}

const KINDS: Array<{ id: CalendarEvent['kind']; label: string; hint: string }> = [
    { id: 'event', label: '📌 事件', hint: '約好的事、行程' },
    { id: 'todo', label: '☐ 待辦', hint: '只有截止日' },
    { id: 'anniversary', label: '🎂 紀念日', hint: '每年都會到' },
];

const Avatar: React.FC<{ src: string; size?: number }> = ({ src, size = 32 }) => (
    <TokenImg value={src} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
);

const pkey = (p: Participant) => `${p.kind}_${p.id}`;

const AddEventPage: React.FC<{
    initial?: CalendarEvent;
    defaultOwner: Participant;
    defaultKind: CalendarEvent['kind'];
    defaultDay: string;
    /** 能當 owner 的（身份卡、角色） */
    owners: ParticipantView[];
    /** 能被拉進來的（含配角） */
    participants: ParticipantView[];
    onSave: (e: CalendarEvent) => Promise<void> | void;
    onDelete?: () => Promise<void> | void;
    onClose: () => void;
}> = ({ initial, defaultOwner, defaultKind, defaultDay, owners, participants, onSave, onDelete, onClose }) => {
    const [owner, setOwner] = useState<Participant>(initial?.owner || defaultOwner);
    const [kind, setKind] = useState<CalendarEvent['kind']>(initial?.kind || defaultKind);
    const [title, setTitle] = useState(initial?.title || '');
    const [day, setDay] = useState((initial?.start || defaultDay).slice(0, 10));
    const [allDay, setAllDay] = useState(initial ? !!initial.allDay : false);
    const [startTime, setStartTime] = useState(initial?.start && initial.start.length >= 16 ? initial.start.slice(11, 16) : '19:00');
    const [endTime, setEndTime] = useState(initial?.end && initial.end.length >= 16 ? initial.end.slice(11, 16) : '');
    const [location, setLocation] = useState(initial?.location || '');
    const [note, setNote] = useState(initial?.note || '');
    const [repeatYearly, setRepeatYearly] = useState(initial ? initial.repeat === 'yearly' : true);
    const [charRemembers, setCharRemembers] = useState(initial ? initial.charRemembers !== false : true);
    const [picked, setPicked] = useState<Participant[]>(initial?.participants || []);
    const [saving, setSaving] = useState(false);

    // 待辦和紀念日沒有時段
    const timed = kind === 'event' && !allDay;
    useEffect(() => { if (kind !== 'event') setAllDay(true); }, [kind]);

    const togglePick = (p: Participant) => setPicked(prev => prev.some(x => sameParticipant(x, p)) ? prev.filter(x => !sameParticipant(x, p)) : [...prev, p]);
    const canSave = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day) && !saving;

    const save = async () => {
        if (!canSave) return;
        setSaving(true);
        try {
            const start = timed ? `${day}T${startTime || '00:00'}` : day;
            const end = timed && endTime ? `${day}T${endTime}` : undefined;
            const fields: Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'> = {
                owner, kind, title: title.trim(), start, end,
                allDay: timed ? undefined : true,
                location: location.trim() || undefined,
                participants: picked.filter(p => !sameParticipant(p, owner)),
                note: note.trim() || undefined,
                repeat: kind === 'anniversary' && repeatYearly ? 'yearly' : undefined,
                charRemembers: kind === 'anniversary' ? charRemembers : undefined,
                done: kind === 'todo' ? initial?.done : undefined,
                completedAt: kind === 'todo' ? initial?.completedAt : undefined,
                doneBy: kind === 'todo' ? initial?.doneBy : undefined,
                source: initial?.source || 'user',
            };
            const event: CalendarEvent = initial
                ? { ...initial, ...fields, updatedAt: Date.now() }
                : newEvent(fields);
            await onSave(event);
        } finally {
            setSaving(false);
        }
    };

    const field = 'w-full rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 text-[14px] outline-none focus:border-pink-200';
    const label = 'block text-[11px] font-bold text-slate-500 mb-1';
    const ownerView = owners.find(o => sameParticipant(o.participant, owner));

    return (
        <div className="absolute inset-0 z-30 flex flex-col bg-gradient-to-b from-pink-50 via-rose-50 to-sky-50 text-slate-800 animate-fade-in" role="dialog" aria-label={initial ? '編輯這條' : '加一條'}>
            <div className="shrink-0 px-4 pb-2 flex items-center justify-between" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
                <button onClick={onClose} aria-label="返回" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-600 shadow-sm"><CaretLeft size={18} /></button>
                <div className="text-[16px] font-black">{initial ? '編輯' : '加一條'}</div>
                <button onClick={() => void save()} disabled={!canSave} aria-label="存檔" className="h-9 w-9 rounded-full bg-pink-400 grid place-items-center text-white shadow-sm disabled:opacity-40"><Check size={18} weight="bold" /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar px-4 pb-10 space-y-4">
                <section className="rounded-[1.5rem] bg-white/85 border border-white p-4 space-y-3 shadow-sm">
                    <div>
                        <span className={label}>誰的</span>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar py-1" role="radiogroup" aria-label="誰的">
                            {owners.map(o => {
                                const on = sameParticipant(o.participant, owner);
                                return (
                                    <button key={pkey(o.participant)} role="radio" aria-checked={on} onClick={() => setOwner(o.participant)} aria-label={o.name}
                                        className={`flex items-center gap-1.5 rounded-full pl-1 pr-3 py-1 text-[12px] font-bold shrink-0 border ${on ? 'bg-pink-400 text-white border-pink-400' : 'bg-white text-slate-600 border-slate-100'}`}>
                                        <Avatar src={o.avatar} size={22} />{o.name}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div>
                        <span className={label}>種類</span>
                        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="種類">
                            {KINDS.map(k => (
                                <button key={k.id} role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)}
                                    className={`rounded-xl px-2 py-2 text-left border ${kind === k.id ? 'bg-pink-50 border-pink-300' : 'bg-white border-slate-100'}`}>
                                    <div className="text-[13px] font-bold text-slate-700">{k.label}</div>
                                    <div className="text-[10px] text-slate-400">{k.hint}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className={label} htmlFor="cal-title">標題</label>
                        <input id="cal-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} className={field} autoFocus
                            placeholder={kind === 'todo' ? '要做什麼' : kind === 'anniversary' ? '紀念什麼' : '做什麼、跟誰'} />
                    </div>
                </section>

                <section className="rounded-[1.5rem] bg-white/85 border border-white p-4 space-y-3 shadow-sm">
                    <div>
                        <label className={label} htmlFor="cal-day">{kind === 'todo' ? '截止日' : kind === 'anniversary' ? '那一天' : '日期'}</label>
                        <input id="cal-day" type="date" value={day} onChange={e => setDay(e.target.value)} className={field} />
                    </div>
                    {kind === 'event' && (
                        <label className="flex items-center justify-between text-[13px] text-slate-700">
                            <span>全天</span>
                            <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} className="h-5 w-5 accent-pink-400" />
                        </label>
                    )}
                    {timed && (
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className={label} htmlFor="cal-start">開始</label>
                                <input id="cal-start" type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className={field} />
                            </div>
                            <div>
                                <label className={label} htmlFor="cal-end">結束 <span className="font-normal">（可不填）</span></label>
                                <input id="cal-end" type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className={field} />
                            </div>
                        </div>
                    )}
                    {kind === 'anniversary' && (
                        <>
                            <label className="flex items-center justify-between text-[13px] text-slate-700">
                                <span>每年重複</span>
                                <input type="checkbox" checked={repeatYearly} onChange={e => setRepeatYearly(e.target.checked)} className="h-5 w-5 accent-pink-400" />
                            </label>
                            <label className="flex items-center justify-between text-[13px] text-slate-700">
                                <span>讓 TA 記住這一天<span className="block text-[10px] text-slate-400">有份的角色快到時會想起來</span></span>
                                <input type="checkbox" checked={charRemembers} onChange={e => setCharRemembers(e.target.checked)} className="h-5 w-5 accent-pink-400" />
                            </label>
                        </>
                    )}
                    {kind !== 'todo' && (
                        <div>
                            <label className={label} htmlFor="cal-location">地點 <span className="font-normal">（可不填）</span></label>
                            <input id="cal-location" value={location} onChange={e => setLocation(e.target.value)} maxLength={60} className={field} placeholder="在哪" />
                        </div>
                    )}
                </section>

                {kind !== 'todo' && (
                    <section className="rounded-[1.5rem] bg-white/85 border border-white p-4 space-y-2 shadow-sm">
                        <span className={label}>跟誰 <span className="font-normal">（可多選；{ownerView?.name || '這個人'}自己不用選）</span></span>
                        <div className="flex flex-wrap gap-2">
                            {participants.filter(p => !sameParticipant(p.participant, owner)).map(p => {
                                const on = picked.some(x => sameParticipant(x, p.participant));
                                return (
                                    <button key={pkey(p.participant)} onClick={() => togglePick(p.participant)} aria-pressed={on} aria-label={p.name}
                                        className={`flex items-center gap-1.5 rounded-full pl-1 pr-3 py-1 text-[12px] font-bold border ${on ? 'bg-sky-100 text-sky-700 border-sky-300' : 'bg-white text-slate-500 border-slate-100'}`}>
                                        <Avatar src={p.avatar} size={22} />{p.name}
                                    </button>
                                );
                            })}
                            {participants.length <= 1 && <div className="text-[12px] text-slate-400">還沒有別人可以選。</div>}
                        </div>
                    </section>
                )}

                <section className="rounded-[1.5rem] bg-white/85 border border-white p-4 shadow-sm">
                    <span className={label}>備註 <span className="font-normal">（可不填）</span></span>
                    <ExpandableTextarea value={note} onChange={setNote} title="備註" rows={3} maxLength={500} className={field} placeholder="想補充的" />
                </section>

                {initial && onDelete && (
                    <button onClick={() => void onDelete()} className="w-full flex items-center justify-center gap-1 rounded-2xl bg-white/70 border border-rose-100 py-3 text-[13px] font-bold text-rose-400"><Trash size={16} />刪掉這條</button>
                )}
            </div>
        </div>
    );
};

export default AddEventPage;
