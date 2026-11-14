import React, { useEffect, useMemo, useRef, useState } from 'react';
import ExpandableTextarea from '../common/ExpandableTextarea';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { saveMeetingPresetDoc } from '../../utils/meetingPreset/store';
import { addPrompt, canDeletePrompt, movePrompt, moveRegexScript, removePrompt, sectionPromptIds, UNGROUPED_SECTION_ID } from '../../utils/meetingPreset/edit';
import MeetingRegexEditor, { newMeetingRegexScript } from './MeetingRegexEditor';
import type { MeetingPresetDoc, MeetingPresetPrompt, MeetingPresetRecord, MeetingPresetSlot } from '../../utils/meetingPreset/types';
import { CHAT_FEATURE_OFF_WARNING, CHAT_SLOT_LABELS } from '../../utils/chatPresetSession';
import { CALL_FEATURE_OFF_WARNING, CALL_SLOT_LABELS } from '../../utils/callPresetSession';

// 見面自訂預設的管理頁：條目開關（照預設自帶的分組）、條目內容、{{getglobalvar}} 變數、
// 正則開關、生成參數。條目能新增、刪除（資料佔位只能關）、排序；正則能排序。
// 改了 600ms 後存一次，存了就發事件讓開著的見面畫面重讀。

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
    ...CHAT_SLOT_LABELS,
    ...CALL_SLOT_LABELS,
};

/** Soren 功能條目（私聊、電話）：內容由程式產生，關掉要講後果 */
const FEATURE_OFF_WARNING: Partial<Record<MeetingPresetSlot, string>> = { ...CHAT_FEATURE_OFF_WARNING, ...CALL_FEATURE_OFF_WARNING };
const isFeatureSlot = (slot: MeetingPresetSlot | undefined): slot is MeetingPresetSlot => !!slot && slot in FEATURE_OFF_WARNING;

type Tab = 'prompts' | 'vars' | 'regex' | 'params';

const Switch: React.FC<{ on: boolean; onToggle: () => void; label: string }> = ({ on, onToggle, label }) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle}
        className={`w-10 h-6 shrink-0 rounded-full transition-colors relative ${on ? 'bg-primary' : 'bg-slate-200'}`}>
        <span className={`absolute left-0 top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
);

const MoveButtons: React.FC<{ label: string; first: boolean; last: boolean; onMove: (direction: -1 | 1) => void }> = ({ label, first, last, onMove }) => (
    <div className="flex shrink-0 gap-1">
        {([[-1, '上移', 'm4.5 15.75 7.5-7.5 7.5 7.5'], [1, '下移', 'm19.5 8.25-7.5 7.5-7.5-7.5']] as const).map(([direction, word, path]) => (
            <button key={word} type="button" aria-label={`${word} ${label}`} disabled={direction === -1 ? first : last} onClick={() => onMove(direction)}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-slate-100 text-slate-500 active:scale-95 disabled:opacity-30">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d={path} /></svg>
            </button>
        ))}
    </div>
);

const MeetingPresetManager: React.FC<{ presetId: string; onClose: () => void }> = ({ presetId, onClose }) => {
    const { addToast, registerBackHandler } = useOS();
    const [record, setRecord] = useState<MeetingPresetRecord | null>(null);
    const [doc, setDoc] = useState<MeetingPresetDoc | null>(null);
    const [tab, setTab] = useState<Tab>('prompts');
    const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
    const [editing, setEditing] = useState<MeetingPresetPrompt | null>(null);
    const [editingRegexId, setEditingRegexId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [sorting, setSorting] = useState(false);
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
        if (editingRegexId) { setEditingRegexId(null); return true; }
        close();
        return true;
    }), [registerBackHandler, editing, editingRegexId]);

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
        if (rest.length || !doc.groups.length) out.push({ id: UNGROUPED_SECTION_ID, name: doc.groups.length ? '未分組' : '全部條目', prompts: rest });
        const q = query.trim().toLowerCase();
        return q ? out.map(s => ({ ...s, prompts: s.prompts.filter(p => p.name.toLowerCase().includes(q)) })).filter(s => s.prompts.length) : out;
    }, [doc, query]);

    if (!doc || !record) {
        return <div className="fixed inset-0 z-[300] bg-slate-50 flex items-center justify-center text-sm text-slate-400">讀取中…</div>;
    }

    const tabButton = (id: Tab, label: string) => (
        <button key={id} onClick={() => { setTab(id); setSorting(false); }} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${tab === id ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400'}`}>{label}</button>
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
                        <div className="flex gap-2">
                            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋條目名稱" disabled={sorting}
                                className="flex-1 min-w-0 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50" />
                            <button type="button" onClick={() => { setSorting(v => !v); setQuery(''); }}
                                className={`shrink-0 px-4 rounded-xl text-sm font-bold border ${sorting ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-slate-200'}`}>{sorting ? '完成' : '排序'}</button>
                        </div>
                        {sections.map(section => {
                            const open = openGroups.has(section.id) || !!query.trim() || sections.length === 1;
                            const order = sorting ? sectionPromptIds(doc, section.id) : [];
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
                                                    <button onClick={() => { if (!sorting) setEditing(p); }} className="flex-1 min-w-0 text-left">
                                                        <div className={`text-[13px] truncate ${p.enabled ? 'text-slate-700' : 'text-slate-400'}`}>{p.name}</div>
                                                        <div className="text-[10px] text-slate-300 truncate">
                                                            {p.slot ? (isFeatureSlot(p.slot) ? '內容由 Soren 照角色設定產生' : `資料佔位 · ${SLOT_LABELS[p.slot]}`) : `${p.role}${p.inChat ? ` · 插在倒數第 ${p.inChat.depth} 則` : ''}${p.content.trim() ? '' : ' · 空白'}`}
                                                        </div>
                                                        {isFeatureSlot(p.slot) && !p.enabled && (
                                                            <div className="text-[10px] text-amber-500 leading-snug whitespace-normal">{FEATURE_OFF_WARNING[p.slot]}</div>
                                                        )}
                                                    </button>
                                                    {sorting
                                                        ? <MoveButtons label={p.name} first={order[0] === p.id} last={order[order.length - 1] === p.id} onMove={direction => update(movePrompt(doc, p.id, direction))} />
                                                        : <Switch on={p.enabled} onToggle={() => patchPrompt(p.id, { enabled: !p.enabled })} label={`切換 ${p.name}`} />}
                                                </div>
                                            ))}
                                            {!sorting && !query.trim() && (
                                                <button type="button" onClick={() => { const added = addPrompt(doc, section.id); update(added.doc); setEditing(added.prompt); }}
                                                    className="w-full px-4 py-2.5 text-left text-[13px] font-bold text-primary active:bg-slate-50">+ 新增條目</button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        <p className="text-[11px] text-slate-400 leading-relaxed px-1">條目照這裡的順序送出，按「排序」可以上下移（分組內移動）。聊天記錄、角色描述這類資料佔位只能關、不能刪。Soren 的記憶、情緒、時間、語氣標籤這些（私聊還有表情包、轉帳這些功能），預設裡沒放的會補上；放了但關掉的就是不要，不補。</p>
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
                        {doc.regexScripts.length > 1 && (
                            <div className="flex justify-end px-3 py-2">
                                <button type="button" onClick={() => setSorting(v => !v)}
                                    className={`px-3 py-1 rounded-lg text-xs font-bold border ${sorting ? 'bg-primary text-white border-primary' : 'bg-white text-slate-500 border-slate-200'}`}>{sorting ? '完成' : '排序'}</button>
                            </div>
                        )}
                        {doc.regexScripts.map((script, index) => (
                            <div key={script.id} className="flex items-center gap-3 px-4 py-2.5">
                                <button type="button" onClick={() => { if (!sorting) setEditingRegexId(script.id); }} className="flex-1 min-w-0 text-left">
                                    <div className={`text-[13px] truncate ${script.disabled ? 'text-slate-400' : 'text-slate-700'}`}>{script.scriptName}</div>
                                    <div className="text-[10px] text-slate-300">
                                        {[script.placement.includes(1) ? '用戶輸入' : '', script.placement.includes(2) ? 'AI 輸出' : ''].filter(Boolean).join('、') || '其它'}
                                        {' · '}{script.markdownOnly && script.promptOnly ? '只改顯示和送出' : script.markdownOnly ? '只改顯示' : script.promptOnly ? '只改送出' : '改存下的原文'}
                                    </div>
                                </button>
                                {sorting
                                    ? <MoveButtons label={script.scriptName} first={index === 0} last={index === doc.regexScripts.length - 1} onMove={direction => update(moveRegexScript(doc, script.id, direction))} />
                                    : <Switch on={!script.disabled} label={`切換 ${script.scriptName}`}
                                        onToggle={() => update({ ...doc, regexScripts: doc.regexScripts.map(r => (r.id === script.id ? { ...r, disabled: !r.disabled } : r)) })} />}
                            </div>
                        ))}
                        {!sorting && <button type="button" onClick={() => { const created = newMeetingRegexScript(); update({ ...doc, regexScripts: [...doc.regexScripts, created] }); setEditingRegexId(created.id); }}
                            className="w-full px-4 py-3 text-left text-sm font-bold text-primary active:bg-slate-50">+ 新增正則</button>}
                    </div>
                )}
                {tab === 'regex' && <p className="text-[11px] text-slate-400 leading-relaxed px-1 mt-3">點一條就能改。正則照這個順序一條接一條跑，按「排序」可以上下移。</p>}

                {tab === 'params' && (
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4">
                        {genField('temperature', '溫度', '0.05')}
                        {genField('topP', 'Top P', '0.01')}
                        {genField('frequencyPenalty', '頻率懲罰', '0.01')}
                        {genField('presencePenalty', '存在懲罰', '0.01')}
                        {genField('maxTokens', '最大回應長度（token）', '100')}
                        <label className="block py-3">
                            <span className="text-sm text-slate-600">助手預填（prefill）</span>
                            <ExpandableTextarea title="正文起筆（預填）" value={doc.assistantPrefill || ''} rows={2} placeholder="留空不送"
                                onChange={v => update({ ...doc, assistantPrefill: v || undefined })}
                                className="mt-2 w-full px-3 py-2 bg-slate-100 rounded-lg text-sm outline-none resize-y focus:ring-1 focus:ring-primary/30" />
                            <span className="text-[10px] text-slate-400">只有部分模型／中轉接受最後一則是助手訊息，不確定就留空。</span>
                        </label>
                    </div>
                )}
            </div>

            {editingRegexId && (() => {
                const script = doc.regexScripts.find(r => r.id === editingRegexId);
                if (!script) return null;
                return (
                    <MeetingRegexEditor
                        script={script}
                        onChange={next => update({ ...doc, regexScripts: doc.regexScripts.map(r => (r.id === next.id ? next : r)) })}
                        onDelete={() => { update({ ...doc, regexScripts: doc.regexScripts.filter(r => r.id !== script.id) }); setEditingRegexId(null); }}
                        onClose={() => setEditingRegexId(null)}
                    />
                );
            })()}

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
                                <p className="text-sm text-slate-500 leading-relaxed">這是{isFeatureSlot(editing.slot) ? ' Soren 功能' : '資料佔位'}：{SLOT_LABELS[editing.slot]}。內容由 Soren 照角色設定和開關產生，這裡只決定它放在哪個位置、要不要送。{isFeatureSlot(editing.slot) ? `關掉的話：${FEATURE_OFF_WARNING[editing.slot]}` : ''}</p>
                            ) : (
                                <>
                                    <div className="flex gap-2">
                                        {(['system', 'user', 'assistant'] as const).map(role => (
                                            <button key={role} onClick={() => { setEditing({ ...editing, role }); patchPrompt(editing.id, { role }); }}
                                                className={`px-3 py-1.5 rounded-full text-xs font-bold ${editing.role === role ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'}`}>{role}</button>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                        <span className="text-slate-400">位置</span>
                                        {([['order', '照順序'], ['chat', '插進聊天記錄']] as const).map(([mode, label]) => {
                                            const active = mode === 'chat' ? !!editing.inChat : !editing.inChat;
                                            return (
                                                <button key={mode} type="button" onClick={() => {
                                                    const inChat = mode === 'chat' ? (editing.inChat || { depth: 4, order: 100 }) : undefined;
                                                    setEditing({ ...editing, inChat }); patchPrompt(editing.id, { inChat });
                                                }} className={`px-3 py-1.5 rounded-full font-bold ${active ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'}`}>{label}</button>
                                            );
                                        })}
                                        {editing.inChat && (
                                            <label className="flex items-center gap-1 text-slate-500">倒數第
                                                <input type="number" min={0} value={editing.inChat.depth} aria-label="插入深度"
                                                    onChange={e => { const inChat = { ...editing.inChat!, depth: Math.max(0, Math.floor(Number(e.target.value) || 0)) }; setEditing({ ...editing, inChat }); patchPrompt(editing.id, { inChat }); }}
                                                    className="w-14 px-2 py-1 bg-slate-100 rounded-lg text-center outline-none" />則
                                            </label>
                                        )}
                                    </div>
                                    <ExpandableTextarea title="預設條目" value={editing.content} rows={14}
                                        onChange={v => { setEditing({ ...editing, content: v }); patchPrompt(editing.id, { content: v }); }}
                                        className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[13px] font-mono leading-relaxed outline-none resize-y select-text" />
                                </>
                            )}
                            {canDeletePrompt(editing) && (
                                <button type="button" onClick={() => {
                                    if (!window.confirm(`刪除條目「${editing.name}」？`)) return;
                                    update(removePrompt(doc, editing.id)); setEditing(null);
                                }} className="w-full py-2.5 rounded-xl bg-red-50 text-red-500 text-sm font-bold active:scale-95">刪除這個條目</button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MeetingPresetManager;
