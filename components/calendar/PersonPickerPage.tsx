import { charSubtitle } from '../../utils/charIdentity';
import React, { useMemo, useState } from 'react';
import { CaretDown, CaretLeft, CaretRight, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { CharacterGroup, CharacterProfile, Participant } from '../../types';
import { sortCharacterGroups } from '../character/CharacterGroupFilter';
import { groupForSwitcher, matchesSearch } from '../../utils/worldSections';
import { isScheduleFeatureOn } from '../../utils/scheduleGenerator';
import TokenImg from '../os/TokenImg';

/**
 * 行事曆「TA 的」選人（plans/calendar.md）：角色和配角都在，大世界幾十個人也找得到——
 * 搜尋、主角／配角篩選、照世界 → 分組收起來（跟切換聊天同一套排法）。全螢幕，不是半窗。
 */

export interface PersonPickerPageProps {
    characters: CharacterProfile[];
    worlds: CharacterGroup[];
    selected?: Participant;
    recent: Participant[];
    onPick: (p: Participant) => void;
    onClose: () => void;
}

type Filter = 'all' | 'lead' | 'supporting';
const FILTERS: Array<{ id: Filter; label: string }> = [{ id: 'all', label: '全部' }, { id: 'lead', label: '主角' }, { id: 'supporting', label: '配角' }];

const same = (a: Participant | undefined, b: Participant) => !!a && a.kind !== 'persona' && b.kind !== 'persona' && a.id === b.id;

const PersonPickerPage: React.FC<PersonPickerPageProps> = ({ characters, worlds, selected, recent, onPick, onClose }) => {
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const sortedWorlds = useMemo(() => sortCharacterGroups(worlds), [worlds]);
    const searching = query.trim().length > 0 || filter !== 'all';

    const [open, setOpen] = useState<Set<string>>(() => {
        const cur = selected && selected.kind !== 'persona' ? characters.find(c => c.id === selected.id) : undefined;
        const w = cur?.groupId && worlds.some(x => x.id === cur.groupId) ? cur.groupId : 'none';
        return new Set([`w:${w}`]);
    });
    const toggle = (key: string) => setOpen(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

    const chars = useMemo(() => characters.filter(c => {
        if (filter === 'lead' && c.castRole === 'supporting') return false;
        if (filter === 'supporting' && c.castRole !== 'supporting') return false;
        return matchesSearch(c, query, worlds);
    }), [characters, filter, query, worlds]);
    const tree = useMemo(() => groupForSwitcher(chars, sortedWorlds), [chars, sortedWorlds]);
    const nameOf = (p: Participant) => p.kind === 'persona' ? undefined : characters.find(c => c.id === p.id);

    const row = (p: Participant, name: string, avatar: string, extra?: React.ReactNode, sub?: string) => (
        <button key={`${p.kind}_${p.id}`} type="button" onClick={() => onPick(p)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left ${same(selected, p) ? 'bg-pink-50 ring-1 ring-pink-200' : 'active:bg-slate-100'}`}>
            <TokenImg value={avatar} className="w-11 h-11 rounded-2xl object-cover bg-slate-200 shrink-0" />
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-bold text-slate-700">{name}</span>
                    {extra}
                    {same(selected, p) && <span className="shrink-0 text-[10px] font-bold text-pink-500">目前</span>}
                </span>
                {sub && <span className="block truncate text-[11px] text-slate-400">{sub}</span>}
            </span>
        </button>
    );
    const charRow = (c: CharacterProfile) => row({ kind: 'char', id: c.id }, c.name, c.avatar, <>
        {c.castRole === 'supporting' && <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-400">配角</span>}
        {!isScheduleFeatureOn(c) && <span className="shrink-0 rounded-full bg-amber-50 px-1.5 text-[10px] text-amber-500">沒開日程</span>}
    </>, charSubtitle(c));

    const worldBlock = (worldId: string | undefined, name: string, charSections: Array<{ sectionName?: string; chars: CharacterProfile[] }>, count: number) => {
        const key = `w:${worldId || 'none'}`;
        const wOpen = searching || open.has(key);
        const hasSections = charSections.some(s => s.sectionName !== undefined);
        return (
            <section key={key} className="rounded-3xl bg-white/85 border border-white overflow-hidden shadow-sm">
                <button type="button" onClick={() => toggle(key)} disabled={searching} aria-expanded={wOpen} className="w-full flex items-center gap-2 px-4 py-3.5 text-left">
                    {wOpen ? <CaretDown size={14} className="text-pink-400" /> : <CaretRight size={14} className="text-pink-400" />}
                    <span className="truncate text-[15px] font-bold text-slate-700">{name}</span>
                    <span className="shrink-0 text-[12px] text-slate-400">{count} 人</span>
                </button>
                {wOpen && (
                    <div className="px-2 pb-3 space-y-1">
                        {charSections.map((part, i) => {
                            if (!hasSections) return <div key={i} className="space-y-1">{part.chars.map(charRow)}</div>;
                            const sKey = `s:${worldId || 'none'}:${part.sectionName || 'rest'}`;
                            const sOpen = searching || open.has(sKey);
                            return (
                                <div key={sKey}>
                                    <button type="button" onClick={() => toggle(sKey)} disabled={searching} aria-expanded={sOpen} className="w-full flex items-center gap-2 px-3 py-2.5 rounded-2xl text-left active:bg-slate-50">
                                        {sOpen ? <CaretDown size={12} className="text-slate-400" /> : <CaretRight size={12} className="text-slate-400" />}
                                        <span className="truncate text-[13px] font-bold text-slate-600">{part.sectionName || '其他'}</span>
                                        <span className="shrink-0 text-[11px] text-slate-400">{part.chars.length}</span>
                                    </button>
                                    {sOpen && <div className="space-y-1 pl-3">{part.chars.map(charRow)}</div>}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        );
    };

    return (
        <div className="absolute inset-0 z-30 flex flex-col bg-gradient-to-b from-pink-50 via-rose-50 to-sky-50 text-slate-800 animate-fade-in" role="dialog" aria-label="選人">
            <div className="shrink-0 px-4 pb-3 space-y-2.5" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
                <div className="flex items-center justify-between">
                    <button onClick={onClose} aria-label="返回" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-600 shadow-sm"><CaretLeft size={18} /></button>
                    <div className="text-[16px] font-black">看誰的</div>
                    <div className="h-9 w-9" />
                </div>
                <label className="flex items-center gap-2 rounded-2xl bg-white/85 border border-white px-3 py-2 shadow-sm">
                    <MagnifyingGlass size={16} className="text-slate-400 shrink-0" />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="找名字、世界或分組" aria-label="搜尋角色或配角"
                        className="min-w-0 flex-1 bg-transparent text-[14px] text-slate-700 outline-none placeholder:text-slate-400" />
                    {query && <button type="button" onClick={() => setQuery('')} aria-label="清掉搜尋" className="text-slate-400"><X size={14} /></button>}
                </label>
                <div className="flex gap-1.5">
                    {FILTERS.map(f => (
                        <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                            className={`rounded-full px-3 py-1 text-[12px] font-bold border ${filter === f.id ? 'bg-pink-400 text-white border-pink-400' : 'bg-white/80 text-slate-500 border-white'}`}>{f.label}</button>
                    ))}
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-10 space-y-4">
                {!searching && recent.length > 0 && (
                    <section>
                        <h2 className="mb-2 px-1 text-[12px] font-bold text-slate-400">最近看過</h2>
                        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1">
                            {recent.map(p => {
                                const who = nameOf(p);
                                if (!who) return null;
                                return (
                                    <button key={`${p.kind}_${p.id}`} type="button" onClick={() => onPick(p)} className="shrink-0 w-[60px] flex flex-col items-center gap-1">
                                        <TokenImg value={who.avatar} className={`w-12 h-12 rounded-2xl object-cover bg-slate-200 ${same(selected, p) ? 'ring-2 ring-pink-400' : ''}`} />
                                        <span className="w-full truncate text-center text-[11px] text-slate-600">{who.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                )}
                {tree.length === 0 && <p className="py-10 text-center text-[13px] text-slate-400">{searching ? '找不到符合的人' : '還沒有角色'}</p>}
                {tree.map(w => worldBlock(w.world?.id, w.world?.name || '沒有世界', w.sections.map(s => ({ sectionName: w.world?.sections?.length ? (s.section?.name || '其他') : undefined, chars: s.chars })), w.count))}
            </div>
        </div>
    );
};

export default PersonPickerPage;
