/**
 * 全螢幕「切換聊天」（plans/chat-switcher.md）：取代私聊頂端點名字跳出的半窗。
 * 最近聊過一排、搜尋、篩選，下面照世界 → 分組收起來；選了就切過去。
 * 這頁只管挑人，做成共用的：別處要「選一個角色」也能直接用（onPick 給什麼都行）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CaretDown, CaretLeft, CaretRight, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { CharacterGroup, CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import { sortCharacterGroups } from '../character/CharacterGroupFilter';
import { groupForSwitcher, matchesSearch, recentChars, sectionOf, type SwitcherWorld } from '../../utils/worldSections';
import TokenImg from '../os/TokenImg';

type Filter = 'all' | 'lead' | 'supporting' | 'unread';
const FILTERS: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: '全部' }, { id: 'lead', label: '主角' }, { id: 'supporting', label: '配角' }, { id: 'unread', label: '有未讀' },
];

const OPEN_KEY = 'soren_chat_switcher_open_v1';
const readOpen = (): string[] | null => {
    try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null'); return Array.isArray(v) ? v : null; } catch { return null; }
};
const saveOpen = (ids: string[]) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(ids)); } catch { /* 存不了就只記這次 */ } };

const worldKey = (w: SwitcherWorld) => `w:${w.world?.id || 'none'}`;
const sectionKey = (w: SwitcherWorld, sectionId?: string) => `s:${w.world?.id || 'none'}:${sectionId || 'rest'}`;

export interface ChatSwitcherPageProps {
    characters: CharacterProfile[];
    worlds: CharacterGroup[];
    activeId?: string;
    unread?: Record<string, number>;
    onPick: (id: string) => void;
    onClose: () => void;
    title?: string;
    /** 頁首額外的一行（例如「這個聊天的氣泡」） */
    header?: React.ReactNode;
}

const ChatSwitcherPage: React.FC<ChatSwitcherPageProps> = ({ characters, worlds, activeId, unread = {}, onPick, onClose, title = '切換聊天', header }) => {
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [lastAt, setLastAt] = useState<Record<string, number>>({});
    const sortedWorlds = useMemo(() => sortCharacterGroups(worlds), [worlds]);
    const active = characters.find(c => c.id === activeId);

    // 展開狀態：記住使用者開過哪些；第一次用時打開目前角色所在的世界和分組
    const [open, setOpen] = useState<Set<string>>(() => {
        const saved = readOpen();
        if (saved) return new Set(saved);
        const w = active?.groupId && worlds.some(x => x.id === active.groupId) ? active.groupId : 'none';
        return new Set([`w:${w}`, `s:${w}:${(active && sectionOf(active, worlds)?.id) || 'rest'}`]);
    });
    const toggle = (key: string) => setOpen(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        saveOpen([...next]);
        return next;
    });

    // 最近聊過：每個角色主線最後一則訊息的時間（跟訊息列表同一個讀法）
    useEffect(() => {
        let alive = true;
        void Promise.all(characters.map(async c => {
            try {
                const [m] = await DB.getRecentMessagesByCharId(c.id, 1, true);
                return [c.id, m?.timestamp || 0] as const;
            } catch { return [c.id, 0] as const; }
        })).then(rows => { if (alive) setLastAt(Object.fromEntries(rows)); });
        return () => { alive = false; };
    }, [characters]);

    const filtered = useMemo(() => characters.filter(c => {
        if (filter === 'lead' && c.castRole === 'supporting') return false;
        if (filter === 'supporting' && c.castRole !== 'supporting') return false;
        if (filter === 'unread' && !(unread[c.id] > 0)) return false;
        return matchesSearch(c, query, worlds);
    }), [characters, filter, query, unread, worlds]);
    const tree = useMemo(() => groupForSwitcher(filtered, sortedWorlds), [filtered, sortedWorlds]);
    const recent = useMemo(() => recentChars(characters, lastAt), [characters, lastAt]);
    const searching = query.trim().length > 0 || filter !== 'all';
    const unreadIn = (list: CharacterProfile[]) => list.reduce((n, c) => n + (c.id !== activeId ? unread[c.id] || 0 : 0), 0);

    const row = (c: CharacterProfile) => {
        const n = c.id !== activeId ? unread[c.id] || 0 : 0;
        return (
            <button key={c.id} type="button" onClick={() => onPick(c.id)} data-switcher-char={c.name}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left ${c.id === activeId ? 'bg-violet-50 ring-1 ring-violet-200' : 'active:bg-slate-100'}`}>
                <span className="relative shrink-0">
                    <TokenImg value={c.avatar} className="w-11 h-11 rounded-2xl object-cover bg-slate-200" />
                    {n > 0 && <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">{n > 99 ? '99+' : n}</span>}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                        <span className="truncate text-[14px] font-bold text-slate-700">{c.name}</span>
                        {c.castRole === 'supporting' && <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-400">配角</span>}
                        {c.id === activeId && <span className="shrink-0 text-[10px] font-bold text-violet-500">目前</span>}
                    </span>
                    {c.description && <span className="block truncate text-[11px] text-slate-400">{c.description}</span>}
                </span>
            </button>
        );
    };

    return (
        <div className="fixed inset-0 z-[100] flex flex-col bg-slate-50 animate-fade-in" data-chat-switcher onClick={e => e.stopPropagation()}>
            <div className="shrink-0 bg-white/90 backdrop-blur-md border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center justify-between px-3 py-3">
                    <button type="button" onClick={onClose} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold text-slate-800">{title}</h1>
                    <span className="w-8" />
                </div>
                <div className="px-4 pb-3 space-y-2.5">
                    <label className="flex items-center gap-2 rounded-2xl bg-slate-100 px-3 py-2">
                        <MagnifyingGlass size={16} className="text-slate-400 shrink-0" />
                        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="找名字、暱稱、世界或分組" aria-label="搜尋角色"
                            className="min-w-0 flex-1 bg-transparent text-[14px] text-slate-700 outline-none placeholder:text-slate-400" />
                        {query && <button type="button" onClick={() => setQuery('')} aria-label="清掉搜尋" className="text-slate-400"><X size={14} /></button>}
                    </label>
                    <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                        {FILTERS.map(f => (
                            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                                className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-bold border ${filter === f.id ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200'}`}>{f.label}</button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 space-y-5" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 24px)' }}>
                {header}

                {!searching && recent.length > 0 && (
                    <section>
                        <h2 className="mb-2 px-1 text-[12px] font-bold text-slate-400">最近聊過</h2>
                        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1" data-switcher-recent>
                            {recent.map(c => (
                                <button key={c.id} type="button" onClick={() => onPick(c.id)} className="shrink-0 w-[60px] flex flex-col items-center gap-1">
                                    <span className="relative">
                                        <TokenImg value={c.avatar} className={`w-12 h-12 rounded-2xl object-cover bg-slate-200 ${c.id === activeId ? 'ring-2 ring-violet-400' : ''}`} />
                                        {c.id !== activeId && unread[c.id] > 0 && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-rose-500 ring-2 ring-white" />}
                                    </span>
                                    <span className="w-full truncate text-center text-[11px] text-slate-600">{c.name}</span>
                                </button>
                            ))}
                        </div>
                    </section>
                )}

                {tree.length === 0 && <p className="py-10 text-center text-[13px] text-slate-400">{searching ? '找不到符合的角色' : '還沒有角色'}</p>}

                {tree.map(w => {
                    const wOpen = searching || open.has(worldKey(w));
                    const hasSections = !!w.world?.sections?.length;
                    const wUnread = unreadIn(w.sections.flatMap(s => s.chars));
                    return (
                        <section key={worldKey(w)} className="rounded-3xl bg-white border border-slate-100 overflow-hidden" data-switcher-world={w.world?.name || '沒有世界'}>
                            <button type="button" onClick={() => toggle(worldKey(w))} disabled={searching} aria-expanded={wOpen}
                                className="w-full flex items-center gap-2 px-4 py-3.5 text-left">
                                {wOpen ? <CaretDown size={14} className="text-violet-400" /> : <CaretRight size={14} className="text-violet-400" />}
                                <span className="truncate text-[15px] font-bold text-slate-700">{w.world?.name || '沒有世界'}</span>
                                <span className="shrink-0 text-[12px] text-slate-400">{w.count} 人{wUnread > 0 ? ` · ${wUnread} 則未讀` : ''}</span>
                            </button>
                            {wOpen && (
                                <div className="px-2 pb-3 space-y-1">
                                    {w.sections.map(part => {
                                        if (!hasSections) return <div key="all" className="space-y-1">{part.chars.map(row)}</div>;
                                        const key = sectionKey(w, part.section?.id);
                                        const sOpen = searching || open.has(key);
                                        const sUnread = unreadIn(part.chars);
                                        return (
                                            <div key={key} data-switcher-section={part.section?.name || '其他'}>
                                                <button type="button" onClick={() => toggle(key)} disabled={searching} aria-expanded={sOpen}
                                                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-2xl text-left active:bg-slate-50">
                                                    {sOpen ? <CaretDown size={12} className="text-slate-400" /> : <CaretRight size={12} className="text-slate-400" />}
                                                    <span className="truncate text-[13px] font-bold text-slate-600">{part.section?.name || '其他'}</span>
                                                    <span className="shrink-0 text-[11px] text-slate-400">{part.chars.length}{sUnread > 0 ? ` · ${sUnread} 則未讀` : ''}</span>
                                                </button>
                                                {sOpen && <div className="space-y-1 pl-3">{part.chars.map(row)}</div>}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
};

export default ChatSwitcherPage;
