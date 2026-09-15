
import React, { useState, useRef, useEffect } from 'react';
import { CharacterCustomMeter } from '../../types';

interface CustomMeterPanelProps {
    /** 'text' = 心声（一段正文）；'number' = 好感度（0-100 数值条） */
    kind: 'text' | 'number';
    heading: string;
    icon: string;
    description: string;
    entries: CharacterCustomMeter[];
    onChange: (entries: CharacterCustomMeter[]) => void;
    onGenerate: (entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>) => Promise<string | number | null>;
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

const CustomMeterPanel: React.FC<CustomMeterPanelProps> = ({
    kind, heading, icon, description, entries, onChange, onGenerate, emptyHint
}) => {
    const [adding, setAdding] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newPrompt, setNewPrompt] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editPrompt, setEditPrompt] = useState('');

    const entriesRef = useRef(entries);
    useEffect(() => { entriesRef.current = entries; }, [entries]);

    const regenerate = async (entry: CharacterCustomMeter) => {
        setBusyId(entry.id);
        try {
            const result = await onGenerate({ title: entry.title, prompt: entry.prompt });
            if (result === null) return;
            const patch = kind === 'text' ? { content: String(result) } : { value: Number(result) };
            onChange(entriesRef.current.map(e => e.id === entry.id ? { ...e, ...patch, updatedAt: Date.now() } : e));
        } finally {
            setBusyId(null);
        }
    };

    const handleAdd = async () => {
        const title = newTitle.trim();
        const prompt = newPrompt.trim();
        if (!title || !prompt) return;
        const entry: CharacterCustomMeter = { id: genId(), title, prompt, color: randomPastelHex() };
        setAdding(false);
        setNewTitle('');
        setNewPrompt('');
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
    };

    const saveEdit = () => {
        const title = editTitle.trim();
        const prompt = editPrompt.trim();
        if (!title || !prompt || !editingId) { setEditingId(null); return; }
        onChange(entriesRef.current.map(e => e.id === editingId ? { ...e, title, prompt } : e));
        setEditingId(null);
    };

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
                                <div className="flex gap-2">
                                    <button onClick={saveEdit} className="flex-1 py-1.5 bg-pink-500 text-white text-[11px] font-bold rounded-lg active:scale-95 transition-transform">保存</button>
                                    <button onClick={() => setEditingId(null)} className="flex-1 py-1.5 bg-slate-100 text-slate-500 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">取消</button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                    <span className="text-xs font-bold" style={{ color: entry.color }}>{entry.title}</span>
                                    <div className="flex items-center gap-2 shrink-0 text-[10px] font-bold text-slate-400">
                                        <button onClick={() => regenerate(entry)} disabled={busyId === entry.id} className="hover:text-pink-500 transition-colors disabled:opacity-50">
                                            {busyId === entry.id ? '生成中…' : '重新生成'}
                                        </button>
                                        <button onClick={() => startEdit(entry)} className="hover:text-pink-500 transition-colors">编辑</button>
                                        <button onClick={() => handleDelete(entry.id)} className="hover:text-red-400 transition-colors">删除</button>
                                    </div>
                                </div>
                                {kind === 'text' ? (
                                    <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap">
                                        {entry.content || (busyId === entry.id ? '生成中…' : '尚未生成，点「重新生成」试试')}
                                    </p>
                                ) : (
                                    <div>
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
                    <div className="flex gap-2">
                        <button onClick={handleAdd} disabled={!newTitle.trim() || !newPrompt.trim()} className="flex-1 py-1.5 bg-pink-500 text-white text-[11px] font-bold rounded-lg active:scale-95 transition-transform disabled:opacity-40">
                            生成
                        </button>
                        <button onClick={() => { setAdding(false); setNewTitle(''); setNewPrompt(''); }} className="flex-1 py-1.5 bg-slate-100 text-slate-500 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">
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
