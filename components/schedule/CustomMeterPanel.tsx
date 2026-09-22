
import React, { useState, useRef, useEffect } from 'react';
import { ArrowsClockwise, PencilSimple, Trash } from '@phosphor-icons/react';
import { CharacterCustomMeter } from '../../types';

interface CustomMeterPanelProps {
    /** 'text' = 心声（一段正文）；'number' = 好感度（0-100 数值条） */
    kind: 'text' | 'number';
    heading: string;
    icon: string;
    description: string;
    entries: CharacterCustomMeter[];
    onChange: (entries: CharacterCustomMeter[]) => void;
    onGenerate: (entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>) => Promise<Partial<Pick<CharacterCustomMeter, 'content' | 'value' | 'statusNote'>> | null>;
    emptyHint: string;
}

function randomPastelHex(): string {
    const h = Math.floor(Math.random() * 360);
    return hslToHex(h, 62, 82);
}

function hslToHex(h: number, s: number, l: number): string {
    const sNorm = s / 100, lNorm = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sNorm * Math.min(lNorm, 1 - lNorm);
    const f = (n: number) => lNorm - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x: number) => Math.round(255 * x).toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

const genId = () => `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

type AutoMode = 'manual' | 'hours' | 'turns';

/** entry.autoUpdate ↔ 表单里的 (mode, interval 字符串) 互转，manual 就是没有 autoUpdate。 */
function autoUpdateToForm(au?: CharacterCustomMeter['autoUpdate']): { mode: AutoMode; interval: string } {
    if (!au) return { mode: 'manual', interval: '24' };
    return { mode: au.mode, interval: String(au.interval) };
}

function formToAutoUpdate(mode: AutoMode, interval: string): CharacterCustomMeter['autoUpdate'] {
    if (mode === 'manual') return undefined;
    const n = Math.max(1, parseInt(interval, 10) || (mode === 'hours' ? 24 : 5));
    return { mode, interval: n };
}

const CustomMeterPanel: React.FC<CustomMeterPanelProps> = ({
    kind, heading, icon, description, entries, onChange, onGenerate, emptyHint
}) => {
    const [adding, setAdding] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newPrompt, setNewPrompt] = useState('');
    const [newAutoMode, setNewAutoMode] = useState<AutoMode>('manual');
    const [newAutoInterval, setNewAutoInterval] = useState('24');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editPrompt, setEditPrompt] = useState('');
    const [editAutoMode, setEditAutoMode] = useState<AutoMode>('manual');
    const [editAutoInterval, setEditAutoInterval] = useState('24');

    const entriesRef = useRef(entries);
    useEffect(() => { entriesRef.current = entries; }, [entries]);

    const regenerate = async (entry: CharacterCustomMeter) => {
        setBusyId(entry.id);
        try {
            const patch = await onGenerate({ title: entry.title, prompt: entry.prompt });
            if (patch === null) return;
            onChange(entriesRef.current.map(e => e.id === entry.id ? { ...e, ...patch, updatedAt: Date.now() } : e));
        } finally {
            setBusyId(null);
        }
    };

    const handleAdd = async () => {
        const title = newTitle.trim();
        const prompt = newPrompt.trim();
        if (!title || !prompt) return;
        const autoUpdate = formToAutoUpdate(newAutoMode, newAutoInterval);
        const entry: CharacterCustomMeter = { id: genId(), title, prompt, color: randomPastelHex(), autoUpdate };
        setAdding(false);
        setNewTitle('');
        setNewPrompt('');
        setNewAutoMode('manual');
        setNewAutoInterval('24');
        onChange([...entriesRef.current, entry]);
        await regenerate(entry);
    };

    const handleDelete = (id: string) => {
        onChange(entriesRef.current.filter(e => e.id !== id));
    };

    const startEdit = (entry: CharacterCustomMeter) => {
        setEditingId(entry.id);
        setEditTitle(entry.title);
        setEditPrompt(entry.prompt);
        const form = autoUpdateToForm(entry.autoUpdate);
        setEditAutoMode(form.mode);
        setEditAutoInterval(form.interval);
    };

    const saveEdit = () => {
        const title = editTitle.trim();
        const prompt = editPrompt.trim();
        if (!title || !prompt || !editingId) { setEditingId(null); return; }
        const autoUpdate = formToAutoUpdate(editAutoMode, editAutoInterval);
        onChange(entriesRef.current.map(e => e.id === editingId
            ? { ...e, title, prompt, autoUpdate, ...(autoUpdate?.mode === 'turns' ? {} : { turnsSinceAutoUpdate: undefined }) }
            : e));
        setEditingId(null);
    };

    /** 自动更新节奏的三段选择 + 数字输入，加号表单和编辑表单共用。 */
    const renderAutoUpdateControl = (mode: AutoMode, setMode: (m: AutoMode) => void, intervalValue: string, setIntervalValue: (v: string) => void) => (
        <div>
            <div className="text-[10px] font-bold text-slate-400 mb-1">自动更新</div>
            <div className="flex gap-1.5">
                {([
                    ['manual', '不自动'],
                    ['hours', '按小时'],
                    ['turns', '按对话轮数'],
                ] as [AutoMode, string][]).map(([m, label]) => (
                    <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-colors ${mode === m ? 'bg-pink-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {mode !== 'manual' && (
                <div className="flex items-center gap-1.5 mt-1.5">
                    <span className="text-[11px] text-slate-500">每</span>
                    <input
                        type="number"
                        min={1}
                        value={intervalValue}
                        onChange={e => setIntervalValue(e.target.value)}
                        className="w-14 bg-white/70 border border-slate-200/60 rounded-lg px-2 py-1 text-xs text-center"
                    />
                    <span className="text-[11px] text-slate-500">{mode === 'hours' ? '小时自动重新生成一次（填 24 即一天一更）' : '轮对话（角色回复计数）自动重新生成一次'}</span>
                </div>
            )}
        </div>
    );

    return (
        <div className="space-y-3">
            <div>
                <div className="text-xs font-bold text-slate-700 mb-1">{icon} {heading}</div>
                <p className="text-[11px] text-slate-500 leading-relaxed">{description}</p>
            </div>

            {entries.length === 0 && !adding && (
                <div className="text-[11px] text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    {emptyHint}
                </div>
            )}

            <div className="space-y-2">
                {entries.map(entry => (
                    <div
                        key={entry.id}
                        className="rounded-2xl border px-3.5 py-3"
                        style={{ backgroundColor: entry.color + '1a', borderColor: entry.color + '55' }}
                    >
                        {editingId === entry.id ? (
                            <div className="space-y-2">
                                <input
                                    type="text"
                                    value={editTitle}
                                    onChange={e => setEditTitle(e.target.value)}
                                    placeholder="标题"
                                    className="w-full bg-white/70 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-bold focus:bg-white transition-all"
                                />
                                <textarea
                                    value={editPrompt}
                                    onChange={e => setEditPrompt(e.target.value)}
                                    placeholder="生成用的提示词"
                                    rows={2}
                                    className="w-full bg-white/70 border border-slate-200/60 rounded-xl px-3 py-2 text-xs resize-none focus:bg-white transition-all"
                                />
                                {renderAutoUpdateControl(editAutoMode, setEditAutoMode, editAutoInterval, setEditAutoInterval)}
                                <div className="flex gap-2">
                                    <button onClick={saveEdit} className="flex-1 py-1.5 bg-pink-500 text-white text-[11px] font-bold rounded-lg active:scale-95 transition-transform">保存</button>
                                    <button onClick={() => setEditingId(null)} className="flex-1 py-1.5 bg-slate-100 text-slate-500 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">取消</button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                    <span className="text-xs font-bold" style={{ color: entry.color }}>{entry.title}</span>
                                    <div className="flex items-center gap-1 shrink-0 text-slate-400">
                                        <button
                                            onClick={() => regenerate(entry)}
                                            disabled={busyId === entry.id}
                                            aria-label="重新生成"
                                            title="重新生成"
                                            className="w-6 h-6 grid place-items-center rounded-full hover:text-pink-500 hover:bg-pink-500/10 transition-colors disabled:opacity-50"
                                        >
                                            <ArrowsClockwise size={13} weight="bold" className={busyId === entry.id ? 'animate-spin' : ''} />
                                        </button>
                                        <button onClick={() => startEdit(entry)} aria-label="编辑" title="编辑" className="w-6 h-6 grid place-items-center rounded-full hover:text-pink-500 hover:bg-pink-500/10 transition-colors">
                                            <PencilSimple size={13} weight="bold" />
                                        </button>
                                        <button onClick={() => handleDelete(entry.id)} aria-label="删除" title="删除" className="w-6 h-6 grid place-items-center rounded-full hover:text-red-400 hover:bg-red-400/10 transition-colors">
                                            <Trash size={13} weight="bold" />
                                        </button>
                                    </div>
                                </div>
                                {kind === 'text' ? (
                                    <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap">
                                        {entry.content || (busyId === entry.id ? '生成中…' : '尚未生成，点「重新生成」试试')}
                                    </p>
                                ) : (
                                    <div>
                                        {(entry.statusNote || busyId === entry.id) && (
                                            <div className="text-[9px] text-slate-500 truncate mb-1">
                                                {busyId === entry.id ? '生成中…' : entry.statusNote}
                                            </div>
                                        )}
                                        <div className="h-2 w-full rounded-full bg-white/70 overflow-hidden">
                                            <div
                                                className="h-full rounded-full transition-all"
                                                style={{ width: `${Math.max(0, Math.min(100, entry.value ?? 0))}%`, backgroundColor: entry.color }}
                                            />
                                        </div>
                                        <div className="text-[10px] text-slate-500 mt-1 text-right">
                                            {entry.value ?? (busyId === entry.id ? '生成中…' : '未评估')}{typeof entry.value === 'number' ? ' / 100' : ''}
                                        </div>
                                    </div>
                                )}
                                {entry.autoUpdate && (
                                    <div className="text-[9px] font-bold mt-1.5" style={{ color: entry.color }}>
                                        {entry.autoUpdate.mode === 'hours'
                                            ? `⏱ 每 ${entry.autoUpdate.interval} 小时自动更新`
                                            : `💬 每 ${entry.autoUpdate.interval} 轮对话自动更新${typeof entry.turnsSinceAutoUpdate === 'number' ? `（还差 ${Math.max(0, entry.autoUpdate.interval - entry.turnsSinceAutoUpdate)} 轮）` : ''}`}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                ))}
            </div>

            {adding ? (
                <div className="rounded-2xl border border-dashed border-slate-300 px-3.5 py-3 space-y-2">
                    <input
                        type="text"
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        placeholder="标题，如「今日心事」"
                        className="w-full bg-white/70 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-bold focus:bg-white transition-all"
                        autoFocus
                    />
                    <textarea
                        value={newPrompt}
                        onChange={e => setNewPrompt(e.target.value)}
                        placeholder="针对这个标题的提示词，会拼进生成请求里"
                        rows={2}
                        className="w-full bg-white/70 border border-slate-200/60 rounded-xl px-3 py-2 text-xs resize-none focus:bg-white transition-all"
                    />
                    {renderAutoUpdateControl(newAutoMode, setNewAutoMode, newAutoInterval, setNewAutoInterval)}
                    <div className="flex gap-2">
                        <button onClick={handleAdd} disabled={!newTitle.trim() || !newPrompt.trim()} className="flex-1 py-1.5 bg-pink-500 text-white text-[11px] font-bold rounded-lg active:scale-95 transition-transform disabled:opacity-40">
                            生成
                        </button>
                        <button onClick={() => { setAdding(false); setNewTitle(''); setNewPrompt(''); setNewAutoMode('manual'); setNewAutoInterval('24'); }} className="flex-1 py-1.5 bg-slate-100 text-slate-500 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">
                            取消
                        </button>
                    </div>
                </div>
            ) : (
                <button
                    onClick={() => setAdding(true)}
                    className="w-full py-2 rounded-xl border border-dashed border-slate-300 text-slate-400 text-xs font-bold hover:bg-slate-50 transition-colors"
                >
                    + 新增{heading}
                </button>
            )}
        </div>
    );
};

export default React.memo(CustomMeterPanel);
