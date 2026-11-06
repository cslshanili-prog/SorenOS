import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { saveMeetingPresetDoc } from '../../utils/meetingPreset/store';
import type { MeetingPresetDoc, MeetingPresetPrompt, MeetingPresetRecord, MeetingPresetSlot } from '../../utils/meetingPreset/types';

// 見面自訂預設的管理頁：條目開關（照預設自帶的分組）、條目內容、{{getglobalvar}} 變數、
// 正則開關、生成參數。改了 600ms 後存一次，存了就發事件讓開著的見面畫面重讀。

const SLOT_LABELS: Record<MeetingPresetSlot, string> = {
    worldInfoBefore: '世界書（前）',
    worldInfoAfter: '世界書（後）',
    charDescription: '角色描述',
    charPersonality: '角色設定',
    scenario: '場景',
    personaDescription: '用戶描述',
    dialogueExamples: '對話示例',
    chatHistory: '聊天記錄',
    memory: 'Soren · 記憶',
    recap: 'Soren · 前情提要',
    time: 'Soren · 時間',
    emotion: 'Soren · 情緒',
    voice: 'Soren · 語氣標籤',
    length: 'Soren · 回應字數',
    soren: 'Soren · 其它',
};

type Tab = 'prompts' | 'vars' | 'regex' | 'params';

const Switch: React.FC<{ on: boolean; onToggle: () => void; label: string }> = ({ on, onToggle, label }) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle}
        className={`w-10 h-6 shrink-0 rounded-full transition-colors relative ${on ? 'bg-primary' : 'bg-slate-200'}`}>
        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
);

const MeetingPresetManager: React.FC<{ presetId: string; onClose: () => void }> = ({ presetId, onClose }) => {
    const { addToast, registerBackHandler } = useOS();
    const [record, setRecord] = useState<MeetingPresetRecord | null>(null);
    const [doc, setDoc] = useState<MeetingPresetDoc | null>(null);
    const [tab, setTab] = useState<Tab>('prompts');
    const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
    const [editing, setEditing] = useState<MeetingPresetPrompt | null>(null);
    const [query, setQuery] = useState('');
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = useRef<{ record: MeetingPresetRecord | null; doc: MeetingPresetDoc | null }>({ record: null, doc: null });
    latest.current = { record, doc };

    useEffect(() => {
        DB.getMeetingPreset(presetId).then(found => {
            if (!found) { addToast('找不到這份預設', 'error'); onClose(); return; }
            setRecord(found);
            setDoc(found.doc);
        });
    }, [presetId]);

    const flush = async () => {
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        const { record: r, doc: d } = latest.current;
        if (r && d && r.doc !== d) setRecord(await saveMeetingPresetDoc(r, d));
    };
    useEffect(() => () => { void flush(); }, []);

    const close = () => { void flush(); onClose(); };
    useEffect(() => registerBackHandler(() => {
        if (editing) { setEditing(null); return true; }
        close();
        return true;
    }), [registerBackHandler, editing]);

    const update = (next: MeetingPresetDoc) => {
        setDoc(next);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => { void flush(); }, 600);
    };
    const patchPrompt = (id: string, patch: Partial<MeetingPresetPrompt>) => {
        if (!doc) return;
        update({ ...doc, prompts: doc.prompts.map(p => (p.id === id ? { ...p, ...patch } : p)) });
    };

    // 分組：照預設自帶的分組；沒分到組的照順序歸到「未分組」
    const sections = useMemo(() => {
        if (!doc) return [];
        const byId = new Map(doc.prompts.map(p => [p.id, p]));
        const grouped = new Set<string>();
        const out = doc.groups.map(g => {
            const prompts = g.promptIds.map(id => byId.get(id)).filter((p): p is MeetingPresetPrompt => !!p);
            prompts.forEach(p => grouped.add(p.id));
            return { id: g.id, name: g.name, prompts };
        });
        const rest = doc.prompts.filter(p => !grouped.has(p.id));
        if (rest.length) out.push({ id: '__rest__', name: doc.groups.length ? '未分組' : '全部條目', prompts: rest });
        const q = query.trim().toLowerCase();
        return q ? out.map(s => ({ ...s, prompts: s.prompts.filter(p => p.name.toLowerCase().includes(q)) })).filter(s => s.prompts.length) : out;
    }, [doc, query]);

    if (!doc || !record) {
        return <div className="fixed inset-0 z-[300] bg-slate-50 flex items-center justify-center text-sm text-slate-400">讀取中…</div>;
    }

    const tabButton = (id: Tab, label: string) => (
        <button key={id} onClick={() => setTab(id)} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${tab === id ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400'}`}>{label}</button>
    );
    const enabledCount = doc.prompts.filter(p => p.enabled).length;
    const genField = (key: keyof MeetingPresetDoc['generation'], label: string, step: string) => (
        <label key={key} className="flex items-center justify-between gap-4 py-3 border-b border-slate-100 last:border-0">
            <span className="text-sm text-slate-600">{label}</span>
            <input type="number" step={step} value={doc.generation[key] ?? ''} placeholder="不送"
                onChange={e => update({ ...doc, generation: { ...doc.generation, [key]: e.target.value === '' ? undefined : Number(e.target.value) } })}
                className="w-28 px-3 py-2 bg-slate-100 rounded-lg text-sm text-right outline-none focus:ring-1 focus:ring-primary/30" />
        </label>
    );

    return (
        <div className="fixed inset-0 z-[300] bg-slate-50 flex flex-col">
            <div className="shrink-0 bg-white border-b border-slate-200 px-4 pb-3" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
                <div className="flex items-center gap-2">
                    <button onClick={close} aria-label="返回" className="p-2 -ml-2 text-slate-600 active:scale-95">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <input value={doc.name} onChange={e => update({ ...doc, name: e.target.value })} aria-label="預設名稱"
                        className="flex-1 min-w-0 font-bold text-slate-700 bg-transparent outline-none" />
                    <span className="text-[11px] text-slate-400 shrink-0">開 {enabledCount} / {doc.prompts.length}</span>
                </div>
                <div className="mt-3 flex gap-1 p-1 bg-slate-100 rounded-xl">
                    {tabButton('prompts', '條目')}
                    {tabButton('vars', `變數${Object.keys(doc.globalVars).length ? ` ${Object.keys(doc.globalVars).length}` : ''}`)}
                    {tabButton('regex', `正則 ${doc.regexScripts.length}`)}
                    {tabButton('params', '參數')}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ paddingBottom: 'calc(var(--safe-bottom) + 2rem)' }}>
                {tab === 'prompts' && (
                    <>
                        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋條目名稱"
                            className="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-1 focus:ring-primary/30" />
                        {sections.map(section => {
                            const open = openGroups.has(section.id) || !!query.trim() || sections.length === 1;
                            const on = section.prompts.filter(p => p.enabled).length;
                            return (
                                <div key={section.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                                    <button onClick={() => setOpenGroups(prev => { const n = new Set(prev); if (n.has(section.id)) n.delete(section.id); else n.add(section.id); return n; })}
                                        className="w-full flex items-center justify-between px-4 py-3 text-left active:bg-slate-50">
                                        <span className="text-sm font-bold text-slate-700 truncate">{section.name}</span>
                                        <span className="text-[11px] text-slate-400 shrink-0 ml-2">{on} / {section.prompts.length}</span>
                                    </button>
                                    {open && (
                                        <div className="border-t border-slate-100 divide-y divide-slate-50">
                                            {section.prompts.map(p => (
                                                <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                                                    <button onClick={() => setEditing(p)} className="flex-1 min-w-0 text-left">
                                                        <div className={`text-[13px] truncate ${p.enabled ? 'text-slate-700' : 'text-slate-400'}`}>{p.name}</div>
                                                        <div className="text-[10px] text-slate-300 truncate">
                                                            {p.slot ? `資料佔位 · ${SLOT_LABELS[p.slot]}` : `${p.role}${p.inChat ? ` · 插在倒數第 ${p.inChat.depth} 則` : ''}${p.content.trim() ? '' : ' · 空白'}`}
                                                        </div>
                                                    </button>
                                                    <Switch on={p.enabled} onToggle={() => patchPrompt(p.id, { enabled: !p.enabled })} label={`切換 ${p.name}`} />
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        <p className="text-[11px] text-slate-400 leading-relaxed px-1">條目照預設的順序送出。Soren 的記憶、情緒、時間、語氣標籤這些，預設裡沒放的會補在聊天記錄前面。</p>
                    </>
                )}

                {tab === 'vars' && (
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3">
                        <p className="text-[11px] text-slate-400 leading-relaxed">預設裡用 {'{{getglobalvar::名字}}'} 讀的值。在 SillyTavern 裡通常由「預設助手」之類的腳本填，這裡直接寫。</p>
                        {Object.keys(doc.globalVars).length === 0 && <p className="text-sm text-slate-400">這份預設沒有用到。</p>}
                        {Object.entries(doc.globalVars).map(([name, value]) => (
                            <label key={name} className="block">
                                <span className="text-[11px] font-bold text-slate-500">{name}</span>
                                <textarea value={value} rows={value.length > 40 ? 3 : 1}
                                    onChange={e => update({ ...doc, globalVars: { ...doc.globalVars, [name]: e.target.value } })}
                                    className="mt-1 w-full px-3 py-2 bg-slate-100 rounded-lg text-sm outline-none resize-y focus:ring-1 focus:ring-primary/30" />
                            </label>
                        ))}
                    </div>
                )}

                {tab === 'regex' && (
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-50">
                        {doc.regexScripts.length === 0 && <p className="p-4 text-sm text-slate-400">這份預設沒有內嵌正則。</p>}
                        {doc.regexScripts.map(script => (
                            <div key={script.id} className="flex items-center gap-3 px-4 py-2.5">
                                <div className="flex-1 min-w-0">
                                    <div className={`text-[13px] truncate ${script.disabled ? 'text-slate-400' : 'text-slate-700'}`}>{script.scriptName}</div>
                                    <div className="text-[10px] text-slate-300">
                                        {[script.placement.includes(1) ? '用戶輸入' : '', script.placement.includes(2) ? 'AI 輸出' : ''].filter(Boolean).join('、') || '其它'}
                                        {' · '}{script.markdownOnly && script.promptOnly ? '只改顯示和送出' : script.markdownOnly ? '只改顯示' : script.promptOnly ? '只改送出' : '改存下的原文'}
                                    </div>
                                </div>
                                <Switch on={!script.disabled} label={`切換 ${script.scriptName}`}
                                    onToggle={() => update({ ...doc, regexScripts: doc.regexScripts.map(r => (r.id === script.id ? { ...r, disabled: !r.disabled } : r)) })} />
                            </div>
                        ))}
                    </div>
                )}

                {tab === 'params' && (
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4">
                        {genField('temperature', '溫度', '0.05')}
                        {genField('topP', 'Top P', '0.01')}
                        {genField('frequencyPenalty', '頻率懲罰', '0.01')}
                        {genField('presencePenalty', '存在懲罰', '0.01')}
                        {genField('maxTokens', '最大回應長度（token）', '100')}
                        <label className="block py-3">
                            <span className="text-sm text-slate-600">助手預填（prefill）</span>
                            <textarea value={doc.assistantPrefill || ''} rows={2} placeholder="留空不送"
                                onChange={e => update({ ...doc, assistantPrefill: e.target.value || undefined })}
                                className="mt-2 w-full px-3 py-2 bg-slate-100 rounded-lg text-sm outline-none resize-y focus:ring-1 focus:ring-primary/30" />
                            <span className="text-[10px] text-slate-400">只有部分模型／中轉接受最後一則是助手訊息，不確定就留空。</span>
                        </label>
                    </div>
                )}
            </div>

            {editing && (
                <div className="fixed inset-0 z-[310] bg-black/40 flex items-end sm:items-center justify-center" onClick={() => setEditing(null)}>
                    <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="p-4 border-b border-slate-100 flex items-center gap-2">
                            <input value={editing.name} onChange={e => { setEditing({ ...editing, name: e.target.value }); patchPrompt(editing.id, { name: e.target.value }); }}
                                className="flex-1 min-w-0 font-bold text-slate-700 outline-none" aria-label="條目名稱" />
                            <button onClick={() => setEditing(null)} className="text-sm text-primary font-bold px-2">完成</button>
                        </div>
                        <div className="p-4 space-y-3 overflow-y-auto">
                            {editing.slot ? (
                                <p className="text-sm text-slate-500 leading-relaxed">這是資料佔位：{SLOT_LABELS[editing.slot]}。內容由 Soren 填，這裡只決定它放在哪個位置、要不要送。</p>
                            ) : (
                                <>
                                    <div className="flex gap-2">
                                        {(['system', 'user', 'assistant'] as const).map(role => (
                                            <button key={role} onClick={() => { setEditing({ ...editing, role }); patchPrompt(editing.id, { role }); }}
                                                className={`px-3 py-1.5 rounded-full text-xs font-bold ${editing.role === role ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'}`}>{role}</button>
                                        ))}
                                    </div>
                                    <textarea value={editing.content} rows={14}
                                        onChange={e => { setEditing({ ...editing, content: e.target.value }); patchPrompt(editing.id, { content: e.target.value }); }}
                                        className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[13px] font-mono leading-relaxed outline-none resize-y select-text" />
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MeetingPresetManager;
