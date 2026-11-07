import React, { useState } from 'react';
import type { Message } from '../../types';
import {
    addDateRerollPreset,
    countDateChars,
    DATE_REROLL_NOTE_MAX,
    DATE_REROLL_PRESET_NAME_MAX,
    loadDateRerollPresets,
    removeDateRerollPreset,
    type DateRerollPreset,
} from '../../utils/dateReply';

/**
 * 見面回覆看得到「有沒有照預設在跑」（utils/dateReply.ts）：
 * - DateReplyTags：每則回覆上面一行 #第幾則 · 字數 · 時間 · 用的預設，有思考過程／原文就多兩顆可展開的
 * - DateLiveReply：開了串流時，生成中邊到邊顯示思考和正文
 * - DateRerollSheet：重新生成前可以寫一句哪裡不滿意；常用的可以存成「我的預設」
 */

const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const tagClass = (light: boolean) => `rounded-md px-1.5 py-0.5 text-[10px] font-mono ${light ? 'bg-stone-100 text-stone-400' : 'bg-white/5 text-white/40'}`;

export const DateReplyTags: React.FC<{ msg: Message; index: number; light: boolean }> = ({ msg, index, light }) => {
    const [open, setOpen] = useState<'reasoning' | 'raw' | null>(null);
    const reasoning = typeof msg.metadata?.dateReasoning === 'string' ? msg.metadata.dateReasoning : '';
    const raw = typeof msg.metadata?.dateRaw === 'string' ? msg.metadata.dateRaw : '';
    const presetName = typeof msg.metadata?.datePresetName === 'string' ? msg.metadata.datePresetName : '';
    const toggle = (kind: 'reasoning' | 'raw') => setOpen(prev => (prev === kind ? null : kind));
    const pill = (kind: 'reasoning' | 'raw', label: string) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); toggle(kind); }} aria-expanded={open === kind}
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold transition ${open === kind
                ? (light ? 'bg-stone-700 text-white' : 'bg-white/80 text-slate-900')
                : (light ? 'bg-stone-100 text-stone-500' : 'bg-white/10 text-white/60')}`}>
            {label}
        </button>
    );
    return (
        <div className="date-reply-tags mb-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <span className={tagClass(light)}>#{index}</span>
                <span className={tagClass(light)}>{countDateChars(msg.content || '')} 字</span>
                <span className={tagClass(light)}>{formatTime(msg.timestamp)}</span>
                {presetName && <span className={`${tagClass(light)} max-w-[10rem] truncate`} title={presetName}>{presetName}</span>}
                {reasoning && pill('reasoning', '思考過程')}
                {raw && pill('raw', '原文')}
            </div>
            {open && (
                <pre className={`date-reply-trace mt-2 max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl p-3 font-sans text-[12px] leading-relaxed select-text ${light ? 'bg-stone-100 text-stone-500' : 'bg-white/5 text-white/60'}`}>
                    {open === 'reasoning' ? reasoning : raw}
                </pre>
            )}
        </div>
    );
};

export const DateLiveReply: React.FC<{ live: { text: string; reasoning: string }; light: boolean }> = ({ live, light }) => (
    <div className={`date-live-reply mb-10 rounded-2xl p-4 ${light ? 'bg-stone-50 ring-1 ring-stone-200' : 'bg-white/5 ring-1 ring-white/10'}`}>
        <div className={`mb-2 flex items-center gap-2 text-[10px] font-bold tracking-widest ${light ? 'text-stone-400' : 'text-white/40'}`}>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {live.text ? '正在寫' : '正在想'}
            <span className="font-mono font-normal">{countDateChars(live.text)} 字</span>
        </div>
        {live.reasoning && (
            <pre className={`mb-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed ${light ? 'text-stone-400' : 'text-white/40'}`}>{live.reasoning}</pre>
        )}
        {live.text && (
            <pre className={`max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words font-serif text-[14px] leading-relaxed ${light ? 'text-stone-600' : 'text-slate-300'}`}>{live.text}</pre>
        )}
    </div>
);

export const DateRerollSheet: React.FC<{ onCancel: () => void; onReroll: (note?: string) => void }> = ({ onCancel, onReroll }) => {
    const [note, setNote] = useState('');
    const [presets, setPresets] = useState<DateRerollPreset[]>(() => loadDateRerollPresets());
    const [naming, setNaming] = useState<string | null>(null);
    const [managing, setManaging] = useState(false);
    const saveCurrent = () => {
        if (naming === null) return;
        setPresets(prev => addDateRerollPreset(prev, naming, note));
        setNaming(null);
    };
    return (
        <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/40" onClick={onCancel}>
            <div className="w-full max-w-md rounded-t-3xl bg-white p-5 text-slate-700" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                <h3 className="text-base font-bold">重新生成</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-400">可以說一下上一版哪裡不滿意、這次想要怎樣。留空就直接重 Roll。</p>

                {presets.length > 0 && (
                    <div className="mt-4">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-slate-400">我的預設</span>
                            <button type="button" onClick={() => setManaging(prev => !prev)} className="text-[12px] font-bold text-slate-500">{managing ? '完成' : '管理'}</button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {presets.map(preset => (
                                <span key={preset.id} className="inline-flex items-center rounded-full border border-slate-200">
                                    <button type="button" disabled={managing} onClick={() => setNote(preset.text)} title={preset.text}
                                        className="max-w-[12rem] truncate px-3 py-1 text-[12px] text-slate-600 active:bg-slate-50 disabled:opacity-60">{preset.name}</button>
                                    {managing && (
                                        <button type="button" aria-label={`刪除 ${preset.name}`} onClick={() => setPresets(prev => removeDateRerollPreset(prev, preset.id))}
                                            className="pr-2.5 text-[13px] leading-none text-red-400">×</button>
                                    )}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                <textarea value={note} onChange={e => setNote(e.target.value.slice(0, DATE_REROLL_NOTE_MAX))} rows={4}
                    placeholder="例：太短了，也沒照預設輸出標題卡片"
                    className="mt-4 w-full resize-none rounded-2xl border border-slate-200 px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-slate-400" />

                {naming === null ? (
                    <div className="mt-1 flex justify-end">
                        <button type="button" disabled={!note.trim()} onClick={() => setNaming('')}
                            className="text-[12px] font-bold text-slate-500 disabled:opacity-40">+ 存為預設</button>
                    </div>
                ) : (
                    <div className="mt-2 flex items-center gap-2">
                        <input value={naming} autoFocus onChange={e => setNaming(e.target.value.slice(0, DATE_REROLL_PRESET_NAME_MAX))}
                            onKeyDown={e => { if (e.key === 'Enter') saveCurrent(); }}
                            placeholder="取個名字（留空用說明開頭）"
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-1.5 text-[12px] outline-none focus:border-slate-400" />
                        <button type="button" onClick={() => setNaming(null)} className="text-[12px] text-slate-400">取消</button>
                        <button type="button" onClick={saveCurrent} className="rounded-xl bg-slate-800 px-3 py-1.5 text-[12px] font-bold text-white">存</button>
                    </div>
                )}

                <div className="mt-3 grid grid-cols-[auto_1fr_1fr] gap-2">
                    <button type="button" onClick={onCancel} className="rounded-2xl border border-slate-200 px-4 py-2.5 text-[13px] font-bold text-slate-500">取消</button>
                    <button type="button" onClick={() => onReroll()} className="rounded-2xl border border-slate-300 py-2.5 text-[13px] font-bold text-slate-700">直接重 Roll</button>
                    <button type="button" disabled={!note.trim()} onClick={() => onReroll(note)} className="rounded-2xl bg-slate-800 py-2.5 text-[13px] font-bold text-white disabled:opacity-40">附說明重 Roll</button>
                </div>
            </div>
        </div>
    );
};
