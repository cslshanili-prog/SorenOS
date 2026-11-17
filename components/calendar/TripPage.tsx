import React, { useState } from 'react';
import { CaretLeft, Check, Trash } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import ExpandableTextarea from '../common/ExpandableTextarea';
import type { Participant, Trip } from '../../types';
import { sameParticipant } from '../../utils/calendarEvents';
import { COMMON_TIMEZONES } from '../../utils/timezone';
import { newTrip, TRIP_KINDS } from '../../utils/trips';
import type { ParticipantView } from './AddEventPage';

/**
 * 旅行／出差的全螢幕頁（plans/calendar.md 第 4 批；不要半窗）：誰的、類型、目的地、時區（清單選，可不換）、起訖日、備註。
 */
const TripPage: React.FC<{
    initial?: Trip;
    defaultOwner: Participant;
    defaultFrom: string;
    owners: ParticipantView[];
    onSave: (t: Trip) => Promise<void> | void;
    onDelete?: () => Promise<void> | void;
    onClose: () => void;
}> = ({ initial, defaultOwner, defaultFrom, owners, onSave, onDelete, onClose }) => {
    const [owner, setOwner] = useState<Participant>(initial?.owner || defaultOwner);
    const [kind, setKind] = useState<Trip['kind']>(initial?.kind || 'travel');
    const [destination, setDestination] = useState(initial?.destination || '');
    const [timezone, setTimezone] = useState(initial?.timezone || '');
    const [from, setFrom] = useState(initial?.from || defaultFrom);
    const [to, setTo] = useState(initial?.to || defaultFrom);
    const [note, setNote] = useState(initial?.note || '');
    const [saving, setSaving] = useState(false);
    const okDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const canSave = destination.trim().length > 0 && okDate(from) && okDate(to) && from <= to && !saving;

    const save = async () => {
        if (!canSave) return;
        setSaving(true);
        try {
            const fields = { owner, kind, destination: destination.trim(), timezone: timezone || undefined, from, to, note: note.trim() || undefined };
            await onSave(initial ? { ...initial, ...fields, updatedAt: Date.now() } : newTrip(fields));
        } finally { setSaving(false); }
    };

    const field = 'w-full rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 text-[14px] outline-none focus:border-pink-200';
    const label = 'block text-[11px] font-bold text-slate-500 mb-1';

    return (
        <div className="absolute inset-0 z-30 flex flex-col bg-gradient-to-b from-pink-50 via-rose-50 to-sky-50 text-slate-800 animate-fade-in" role="dialog" aria-label={initial ? '編輯旅行' : '加一趟旅行'}>
            <div className="shrink-0 px-4 pb-2 flex items-center justify-between" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
                <button onClick={onClose} aria-label="返回" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-600 shadow-sm"><CaretLeft size={18} /></button>
                <div className="text-[16px] font-black">{initial ? '編輯旅行' : '加一趟'}</div>
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
                                    <button key={`${o.participant.kind}_${o.participant.id}`} role="radio" aria-checked={on} onClick={() => setOwner(o.participant)} aria-label={o.name}
                                        className={`flex items-center gap-1.5 rounded-full pl-1 pr-3 py-1 text-[12px] font-bold shrink-0 border ${on ? 'bg-pink-400 text-white border-pink-400' : 'bg-white text-slate-600 border-slate-100'}`}>
                                        <TokenImg value={o.avatar} alt="" className="h-[22px] w-[22px] rounded-full object-cover shrink-0" />{o.name}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div>
                        <span className={label}>類型</span>
                        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="類型">
                            {TRIP_KINDS.map(k => (
                                <button key={k.id} role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)}
                                    className={`rounded-xl px-2 py-2 text-[13px] font-bold border ${kind === k.id ? 'bg-pink-50 border-pink-300 text-slate-700' : 'bg-white border-slate-100 text-slate-500'}`}>{k.emoji} {k.label}</button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className={label} htmlFor="trip-dest">目的地 <span className="font-normal">（城市；天氣照它查）</span></label>
                        <input id="trip-dest" value={destination} onChange={e => setDestination(e.target.value)} maxLength={40} className={field} placeholder="例如：杭州、Tokyo" autoFocus />
                    </div>
                    <div>
                        <label className={label} htmlFor="trip-tz">時區 <span className="font-normal">（期間換成這個；不換就跟原本的）</span></label>
                        <select id="trip-tz" value={timezone} onChange={e => setTimezone(e.target.value)} className={field}>
                            <option value="">不換時區</option>
                            {COMMON_TIMEZONES.map(z => <option key={z.id} value={z.id}>{z.label}</option>)}
                        </select>
                    </div>
                </section>
                <section className="rounded-[1.5rem] bg-white/85 border border-white p-4 space-y-3 shadow-sm">
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className={label} htmlFor="trip-from">出發</label>
                            <input id="trip-from" type="date" value={from} onChange={e => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} className={field} />
                        </div>
                        <div>
                            <label className={label} htmlFor="trip-to">回來</label>
                            <input id="trip-to" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className={field} />
                        </div>
                    </div>
                    {okDate(from) && okDate(to) && from > to && <div className="text-[11px] text-rose-400">回來的日子不能早於出發。</div>}
                    <div>
                        <span className={label}>備註 <span className="font-normal">（可不填；生成那幾天的日程會看）</span></span>
                        <ExpandableTextarea value={note} onChange={setNote} title="旅行備註" rows={3} maxLength={300} className={field} placeholder="住哪、要去哪、跟誰" />
                    </div>
                </section>
                {initial && onDelete && (
                    <button onClick={() => void onDelete()} className="w-full flex items-center justify-center gap-1 rounded-2xl bg-white/70 border border-rose-100 py-3 text-[13px] font-bold text-rose-400"><Trash size={16} />刪掉這趟</button>
                )}
            </div>
        </div>
    );
};

export default TripPage;
