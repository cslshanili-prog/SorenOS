/**
 * 事件日期的輸入（plans/bond-batch2.md 1.1）：某一天／某個月／某段時間／不知道。
 * 紀要 3.1：保留不確定性，允許之後補填，不逼你挑一個精確日期。
 */
import React from 'react';
import type { BondEventDate } from '../../types';

const PRECISIONS: Array<{ id: BondEventDate['precision']; label: string }> = [
    { id: 'day', label: '某一天' },
    { id: 'month', label: '某個月' },
    { id: 'period', label: '某段時間' },
    { id: 'unknown', label: '不知道' },
];

export const BondDateField: React.FC<{ value: BondEventDate; onChange: (d: BondEventDate) => void; todayKey: string }> = ({ value, onChange, todayKey }) => {
    const pick = (p: BondEventDate['precision']) => {
        if (p === value.precision) return;
        const base = 'date' in value && value.date ? value.date : todayKey;
        if (p === 'day') onChange({ precision: 'day', date: base.length >= 10 ? base.slice(0, 10) : (base.slice(0, 7) === todayKey.slice(0, 7) ? todayKey : `${base.slice(0, 7)}-01`) });
        else if (p === 'month') onChange({ precision: 'month', date: base.slice(0, 7) });
        else if (p === 'period') onChange({ precision: 'period', label: '', date: 'date' in value ? value.date?.slice(0, 7) : undefined });
        else onChange({ precision: 'unknown' });
    };
    return (
        <div>
            <div className="flex flex-wrap gap-2">
                {PRECISIONS.map(p => (
                    <button key={p.id} type="button" className="bond-chip" aria-pressed={value.precision === p.id} onClick={() => pick(p.id)}>{p.label}</button>
                ))}
            </div>
            <div className="mt-2.5">
                {value.precision === 'day' && (
                    <input type="date" className="bond-input" value={value.date} onChange={e => e.target.value && onChange({ precision: 'day', date: e.target.value })} />
                )}
                {value.precision === 'month' && (
                    <input type="month" className="bond-input" value={value.date} onChange={e => e.target.value && onChange({ precision: 'month', date: e.target.value })} />
                )}
                {value.precision === 'period' && (
                    <div className="space-y-2">
                        <input className="bond-input" value={value.label} maxLength={20} placeholder="例如：剛認識那陣子、那年夏天"
                            onChange={e => onChange({ ...value, label: e.target.value })} />
                        <label className="flex items-center gap-2 text-[12px] text-[var(--bond-ink-2)]">
                            <span className="shrink-0">大概在</span>
                            <input type="month" className="bond-input !py-1.5" value={value.date || ''} onChange={e => onChange({ ...value, date: e.target.value || undefined })} />
                        </label>
                        <div className="text-[11px] text-[var(--bond-muted)]">「大概在」可以不填，填了時間線才排得進去。</div>
                    </div>
                )}
                {value.precision === 'unknown' && (
                    <div className="text-[12px] text-[var(--bond-muted)]">先放在「日期不明」，想起來再補。</div>
                )}
            </div>
        </div>
    );
};
