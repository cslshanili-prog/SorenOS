import React, { useState } from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { addMonths, monthGrid, monthKeyOf } from '../../utils/calendarView';

/**
 * 行事曆「我的」「TA 的」點日期跳出來的全螢幕選日頁（不是半窗）：點一天就換過去。
 * 有東西的天打一個點（哪種東西由呼叫的人判）。
 */
const DayPickerPage: React.FC<{
    value: string;
    todayKey: string;
    hasMark?: (dayKey: string) => boolean;
    onPick: (dayKey: string) => void;
    onClose: () => void;
}> = ({ value, todayKey, hasMark, onPick, onClose }) => {
    const [monthKey, setMonthKey] = useState(monthKeyOf(value));
    const [y, m] = monthKey.split('-').map(Number);
    const grid = monthGrid(monthKey);
    return (
        <div className="absolute inset-0 z-30 flex flex-col bg-gradient-to-b from-pink-50 via-rose-50 to-sky-50 text-slate-800 animate-fade-in" role="dialog" aria-label="選一天">
            <div className="shrink-0 px-4 pb-2 flex items-center justify-between" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
                <button onClick={onClose} aria-label="返回" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-600 shadow-sm"><CaretLeft size={18} /></button>
                <div className="text-[16px] font-black">選一天</div>
                <div className="h-9 w-9" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-10 space-y-4">
                <div className="flex items-center justify-between">
                    <button onClick={() => setMonthKey(addMonths(monthKey, -1))} aria-label="上個月" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-500 shadow-sm"><CaretLeft size={16} /></button>
                    <div className="text-[18px] font-black text-slate-800">{y} 年 {m} 月</div>
                    <button onClick={() => setMonthKey(addMonths(monthKey, 1))} aria-label="下個月" className="h-9 w-9 rounded-full bg-white/80 grid place-items-center text-slate-500 shadow-sm"><CaretRight size={16} /></button>
                </div>
                <div className="grid grid-cols-7 text-center text-[11px] text-slate-400 font-bold">
                    {['日', '一', '二', '三', '四', '五', '六'].map(d => <div key={d}>{d}</div>)}
                </div>
                <div className="space-y-1.5" role="grid" aria-label="選日的月曆">
                    {grid.map((row, i) => (
                        <div key={i} className="grid grid-cols-7 gap-1.5">
                            {row.map(cell => {
                                const selected = cell.key === value;
                                const isToday = cell.key === todayKey;
                                return (
                                    <button key={cell.key} role="gridcell" aria-selected={selected} aria-label={cell.key} onClick={() => onPick(cell.key)}
                                        className={`relative aspect-square rounded-full flex items-center justify-center text-[14px] font-bold transition
                                            ${selected ? 'bg-pink-400 text-white shadow-md shadow-pink-200' : isToday ? 'bg-white text-pink-500 ring-2 ring-pink-300' : cell.inMonth ? 'bg-white/80 text-slate-700' : 'bg-white/30 text-slate-300'}`}>
                                        {cell.day}
                                        {hasMark?.(cell.key) && <span className={`absolute bottom-1 h-1 w-1 rounded-full ${selected ? 'bg-white' : 'bg-pink-400'}`} />}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
                <button onClick={() => onPick(todayKey)} className="w-full rounded-2xl bg-white/85 border border-white py-3 text-[13px] font-bold text-pink-500 shadow-sm">回到今天</button>
            </div>
        </div>
    );
};

export default DayPickerPage;
