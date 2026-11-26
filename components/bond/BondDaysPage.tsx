/**
 * 天數頁（plans/bond-batch1.md 3.3 第 5 點）：「相識」讀寫聊天設定的相識起點（同一份，不另存）；
 * 另外可以加交往、結婚、自訂的起點；選一個當首頁的主要天數。沒填的起點寫「還沒填」，不從聊天猜。
 */
import React, { useState } from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import type { BondDayStart, CharacterProfile } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { dayCounters } from '../../utils/bond/spaces';
import { updateBond } from '../../utils/bond/store';

const newStartId = () => `day-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export const BondDaysPage: React.FC<{
    space: ResolvedSpace;
    onBack: () => void;
    /** 身份卡 × 角色：改聊天設定的相識起點（照這條線寫） */
    updateLine: (view: Pick<CharacterProfile, 'id'>, patch: Partial<CharacterProfile>) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, onBack, updateLine, addToast }) => {
    const [bond, setBond] = useState(space.bond);
    const [metDate, setMetDate] = useState(space.view?.acquaintanceStartDate || '');
    const counters = dayCounters(bond, space.kind === 'persona' ? metDate : bond.days.metDate, space.todayKey);

    const save = async (patch: (b: typeof bond) => typeof bond) => {
        try { setBond(await updateBond(space.id, patch)); }
        catch (e: any) { addToast(`沒存成功：${e?.message || e}`, 'error'); }
    };
    const setStart = (id: string, change: Partial<BondDayStart>) => save(b => ({ ...b, days: { ...b.days, extra: b.days.extra.map(s => (s.id === id ? { ...s, ...change } : s)) } }));
    const addStart = (kind: BondDayStart['kind']) => save(b => ({ ...b, days: { ...b.days, extra: [...b.days.extra, { id: newStartId(), kind, ...(kind === 'custom' ? { label: '' } : {}) }] } }));
    const removeStart = (id: string) => save(b => ({ ...b, days: { primary: b.days.primary === id ? 'met' : b.days.primary, extra: b.days.extra.filter(s => s.id !== id) } }));
    const setPrimary = (id: string) => save(b => ({ ...b, days: { ...b.days, primary: id } }));
    const saveMet = (value: string) => {
        if (space.kind === 'pair') { void save(b => ({ ...b, days: { ...b.days, metDate: value || undefined } })); return; }
        setMetDate(value);
        if (space.view) updateLine(space.view, { acquaintanceStartDate: value || undefined });
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="天數" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                    日期照這段關係的故事時間算，今天是 {space.todayKey}。天數是紀念，不代表親不親近。
                </p>
                <section>
                    <SectionLabel>起 點</SectionLabel>
                    <div className="divide-y bond-hair border-y">
                        {counters.map(c => {
                            const extra = bond.days.extra.find(s => s.id === c.id);
                            const isMet = c.id === 'met';
                            return (
                                <div key={c.id} className="py-3.5">
                                    <div className="flex items-center gap-3">
                                        <button type="button" onClick={() => setPrimary(c.id)} aria-pressed={bond.days.primary === c.id}
                                            aria-label={`把「${c.label}」設成首頁的主要天數`}
                                            className={`h-3.5 w-3.5 shrink-0 rounded-full border ${bond.days.primary === c.id ? 'border-[var(--bond-accent)] bg-[var(--bond-accent)]' : 'border-[var(--bond-rose)]'}`} />
                                        {extra?.kind === 'custom' ? (
                                            <input className="bond-input !py-1.5 flex-1" value={extra.label || ''} placeholder="起點的名字" maxLength={10}
                                                onChange={e => setStart(extra.id, { label: e.target.value })} />
                                        ) : (
                                            <div className="bond-serif flex-1 text-[15px]">{c.label}</div>
                                        )}
                                        <div className="text-[12px] text-[var(--bond-muted)] tabular-nums">{c.days !== null ? `第 ${c.days} 天` : '還沒填'}</div>
                                        {extra && (
                                            <button type="button" aria-label="刪掉這個起點" onClick={() => removeStart(extra.id)} className="h-8 w-8 grid place-items-center text-[var(--bond-muted)]"><Trash size={15} /></button>
                                        )}
                                    </div>
                                    <input type="date" className="bond-input mt-2"
                                        value={isMet ? (space.kind === 'pair' ? bond.days.metDate || '' : metDate) : (extra?.date || '')}
                                        onChange={e => (isMet ? saveMet(e.target.value) : setStart(c.id, { date: e.target.value || undefined }))} />
                                    {isMet && space.kind === 'persona' && (
                                        <div className="mt-1 text-[11px] text-[var(--bond-muted)]">跟聊天設定的「我們已相識」是同一個日期，改這裡那邊也會跟著變。</div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" className="bond-chip" onClick={() => addStart('together')}><Plus size={12} className="mr-1" />交往</button>
                        <button type="button" className="bond-chip" onClick={() => addStart('married')}><Plus size={12} className="mr-1" />結婚</button>
                        <button type="button" className="bond-chip" onClick={() => addStart('custom')}><Plus size={12} className="mr-1" />自訂</button>
                    </div>
                </section>
            </div>
        </div>
    );
};
