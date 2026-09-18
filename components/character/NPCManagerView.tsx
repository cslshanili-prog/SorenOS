
import React, { useEffect, useRef, useState } from 'react';
import { CharacterProfile, NPCProfile, NPCRelationship, Worldbook, ApiPreset, APIConfig } from '../../types';
import TokenImg from '../os/TokenImg';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';
import { toMountedWorldbook } from '../../utils/worldbook';
import { COMMON_TIMEZONES } from '../../utils/timezone';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import Modal from '../os/Modal';

interface NPCManagerViewProps {
    npcs: NPCProfile[];
    characters: CharacterProfile[];
    worldbooks: Worldbook[];
    apiPresets: ApiPreset[];
    addApiPreset: (name: string, config: APIConfig) => void;
    addNPC: () => Promise<NPCProfile>;
    updateNPC: (id: string, updates: Partial<NPCProfile> | ((prev: NPCProfile) => Partial<NPCProfile>)) => void;
    deleteNPC: (id: string) => Promise<void>;
    onSwitchTab: (tab: 'characters' | 'npcs') => void;
    closeApp: () => void;
}

const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const NPCManagerView: React.FC<NPCManagerViewProps> = ({ npcs, characters, worldbooks, apiPresets, addApiPreset, addNPC, updateNPC, deleteNPC, onSwitchTab, closeApp }) => {
    const [view, setView] = useState<'list' | 'detail'>('list');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

    const editingNpc = npcs.find(n => n.id === editingId) || null;

    const handleAdd = async () => {
        const npc = await addNPC();
        setEditingId(npc.id);
        setView('detail');
    };

    const handleDelete = async (id: string) => {
        await deleteNPC(id);
        setDeleteConfirmId(null);
        if (editingId === id) { setEditingId(null); setView('list'); }
    };

    if (view === 'detail' && editingNpc) {
        return (
            <NPCDetailView
                npc={editingNpc}
                characters={characters}
                worldbooks={worldbooks}
                apiPresets={apiPresets}
                addApiPreset={addApiPreset}
                onChange={(updates) => updateNPC(editingNpc.id, updates)}
                onBack={() => { setView('list'); setEditingId(null); }}
                onDelete={() => setDeleteConfirmId(editingNpc.id)}
            />
        );
    }

    return (
        <div className="flex flex-col h-full animate-fade-in relative"
             style={{ background: 'linear-gradient(180deg, #f5f2fb 0%, #ece6f6 100%)' }}>
            <div className="px-6 pb-4 shrink-0 flex items-start justify-between" style={{ paddingTop: 'max(3.5rem, var(--safe-top))' }}>
                <div>
                    <h1 className="text-[30px] font-serif font-bold tracking-wide leading-tight text-slate-800">神经链接</h1>
                    <p className="text-xs text-violet-400/90 mt-2">已建立 <span className="font-bold text-violet-500">{npcs.length}</span> 个 NPC</p>
                </div>
                <button onClick={closeApp} className="p-2 text-slate-400">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            <div className="px-6 pb-3 shrink-0 flex gap-2">
                <button onClick={() => onSwitchTab('characters')} className="px-4 py-1.5 rounded-full text-xs font-bold bg-white/60 text-violet-500 border border-violet-200">
                    主角
                </button>
                <button onClick={() => onSwitchTab('npcs')} className="px-4 py-1.5 rounded-full text-xs font-bold bg-violet-600 text-white shadow-sm">
                    NPC{npcs.length > 0 ? ` (${npcs.length})` : ''}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-20 no-scrollbar flex flex-col gap-3">
                {npcs.length === 0 && (
                    <div className="text-center py-10 text-violet-300 text-sm">
                        还没有 NPC——点下面「+ 新增 NPC」建一个
                    </div>
                )}
                {npcs.map(npc => (
                    <div
                        key={npc.id}
                        onClick={() => { setEditingId(npc.id); setView('detail'); }}
                        className="flex items-center gap-3 bg-white rounded-2xl p-3 shadow-sm border border-slate-100 cursor-pointer active:scale-[0.99] transition-transform"
                    >
                        <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 bg-slate-100">
                            <TokenImg value={npc.avatar} className="w-full h-full object-cover" alt={npc.name} />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-bold text-slate-700 truncate">{npc.name || '未命名 NPC'}</div>
                            <div className="text-[11px] text-slate-400 truncate">
                                {npc.relationships.length > 0 ? `${npc.relationships.length} 段关系` : '暂无关系设定'}
                            </div>
                        </div>
                        <button
                            onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(npc.id); }}
                            className="shrink-0 p-2 text-slate-300 hover:text-red-400"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                            </svg>
                        </button>
                    </div>
                ))}
                <button onClick={handleAdd} className="w-full py-4 rounded-3xl border border-dashed border-violet-300/70 text-violet-400 text-sm bg-white/50 hover:bg-white transition-colors flex items-center justify-center gap-2 shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    新增 NPC
                </button>
            </div>

            {deleteConfirmId && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setDeleteConfirmId(null)} />
                    <div className="relative w-full max-w-sm bg-white rounded-[2rem] shadow-2xl p-6 text-center">
                        <p className="text-sm text-slate-700 font-bold mb-1">删除这个 NPC？</p>
                        <p className="text-xs text-slate-400 mb-5">删除后，ta 在群聊/查手机联系人/见面剧情里的设定都会一并消失，无法恢复。</p>
                        <div className="flex gap-3">
                            <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">取消</button>
                            <button onClick={() => handleDelete(deleteConfirmId)} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">删除</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

interface NPCDetailViewProps {
    npc: NPCProfile;
    characters: CharacterProfile[];
    worldbooks: Worldbook[];
    apiPresets: ApiPreset[];
    addApiPreset: (name: string, config: APIConfig) => void;
    onChange: (updates: Partial<NPCProfile>) => void;
    onBack: () => void;
    onDelete: () => void;
}

const NPCDetailView: React.FC<NPCDetailViewProps> = ({ npc, characters, worldbooks, apiPresets, addApiPreset, onChange, onBack, onDelete }) => {
    const fileRef = useRef<HTMLInputElement>(null);
    const [name, setName] = useState(npc.name);
    const [description, setDescription] = useState(npc.description);
    const [worldview, setWorldview] = useState(npc.worldview || '');
    const [showWorldbookModal, setShowWorldbookModal] = useState(false);
    const [apiMode, setApiMode] = useState<'shared' | 'custom'>(npc.chatApi?.baseUrl ? 'custom' : 'shared');
    const [apiUrl, setApiUrl] = useState(npc.chatApi?.baseUrl || '');
    const [apiKey, setApiKey] = useState(npc.chatApi?.apiKey || '');
    const [apiModel, setApiModel] = useState(npc.chatApi?.model || '');
    const [showSavePreset, setShowSavePreset] = useState(false);
    const [newPresetName, setNewPresetName] = useState('');
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [showModelModal, setShowModelModal] = useState(false);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const [modelStatusMsg, setModelStatusMsg] = useState('');
    const [testingConnection, setTestingConnection] = useState(false);
    const [testConnectionResult, setTestConnectionResult] = useState<string | null>(null);

    // 切换编辑对象时把本地草稿同步回来，避免残留上一个 NPC 的文字。
    useEffect(() => {
        setName(npc.name);
        setDescription(npc.description);
        setWorldview(npc.worldview || '');
        setApiMode(npc.chatApi?.baseUrl ? 'custom' : 'shared');
        setApiUrl(npc.chatApi?.baseUrl || '');
        setApiKey(npc.chatApi?.apiKey || '');
        setApiModel(npc.chatApi?.model || '');
        setShowSavePreset(false);
        setNewPresetName('');
        setTestConnectionResult(null);
    }, [npc.id]);

    const saveApiConfig = (mode: 'shared' | 'custom', url = apiUrl, key = apiKey, model = apiModel) => {
        onChange({ chatApi: mode === 'custom' && url.trim() ? { baseUrl: url.trim(), apiKey: key.trim(), model: model.trim() } : undefined });
    };

    const loadPreset = (preset: ApiPreset) => {
        setApiUrl(preset.config.baseUrl);
        setApiKey(preset.config.apiKey);
        setApiModel(preset.config.model);
        setApiMode('custom');
        saveApiConfig('custom', preset.config.baseUrl, preset.config.apiKey, preset.config.model);
    };

    const handleSavePreset = () => {
        if (!newPresetName.trim()) return;
        addApiPreset(newPresetName.trim(), { baseUrl: apiUrl, apiKey, model: apiModel });
        setNewPresetName('');
        setShowSavePreset(false);
    };

    const fetchModels = async () => {
        const baseUrl = normalizeApiBaseUrl(apiUrl);
        const key = normalizeApiCredential(apiKey);
        if (!baseUrl) { setModelStatusMsg('请先填写 URL'); return; }
        setIsLoadingModels(true);
        setModelStatusMsg('正在连接...');
        try {
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await safeResponseJson(response);
            const models = extractModelIds(data);
            if (models.length > 0) {
                setAvailableModels(models);
                setModelSearchQuery('');
                setModelStatusMsg(`获取到 ${models.length} 个模型`);
                setShowModelModal(true);
            } else {
                setModelStatusMsg('模型列表为空或格式不兼容');
            }
        } catch (error: any) {
            setModelStatusMsg(`连接失败${error?.message ? `：${error.message}` : ''}`);
        } finally {
            setIsLoadingModels(false);
        }
    };

    const handleTestConnection = async () => {
        const baseUrl = normalizeApiBaseUrl(apiUrl);
        if (!baseUrl) return;
        setTestingConnection(true);
        setTestConnectionResult(null);
        try {
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${normalizeApiCredential(apiKey)}`, 'Content-Type': 'application/json' },
            });
            if (response.ok) {
                setTestConnectionResult('✅ 连接成功');
            } else {
                const text = await response.text().catch(() => '');
                setTestConnectionResult(`❌ HTTP ${response.status}${text ? `：${text.slice(0, 100)}` : ''}`);
            }
        } catch (error: any) {
            setTestConnectionResult(`❌ 连接失败${error?.message ? `：${error.message}` : ''}`);
        } finally {
            setTestingConnection(false);
        }
    };

    const mountWorldbook = (bookId: string) => {
        const book = worldbooks.find(b => b.id === bookId);
        if (!book) return;
        const current = npc.mountedWorldbooks || [];
        if (current.some(b => b.id === bookId)) return;
        onChange({ mountedWorldbooks: [...current, toMountedWorldbook(book)] });
    };

    const unmountWorldbook = (bookId: string) => {
        onChange({ mountedWorldbooks: (npc.mountedWorldbooks || []).filter(b => b.id !== bookId) });
    };

    const handleAvatarUpload = async (file: File) => {
        const blob = await processImageToBlob(file, { skipCompression: true });
        const ref = await putImageBlob(blob);
        onChange({ avatar: ref });
    };

    const addRelationship = () => {
        const rel: NPCRelationship = { id: genId('rel'), targetId: 'user', description: '' };
        onChange({ relationships: [...npc.relationships, rel] });
    };

    const updateRelationship = (id: string, patch: Partial<NPCRelationship>) => {
        onChange({ relationships: npc.relationships.map(r => r.id === id ? { ...r, ...patch } : r) });
    };

    const removeRelationship = (id: string) => {
        onChange({ relationships: npc.relationships.filter(r => r.id !== id) });
    };

    return (
        <div className="flex flex-col h-full animate-fade-in bg-slate-50/30">
            <div className="px-6 pb-4 shrink-0 flex items-center justify-between" style={{ paddingTop: 'max(3.5rem, var(--safe-top))' }}>
                <button onClick={onBack} className="p-2 -ml-2 text-slate-500">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" /></svg>
                </button>
                <h2 className="text-sm font-bold text-slate-700">编辑 NPC</h2>
                <button onClick={onDelete} className="p-2 -mr-2 text-slate-300 hover:text-red-400">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                    </svg>
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 pb-20 no-scrollbar space-y-5">
                <div className="flex justify-center">
                    <div
                        onClick={() => fileRef.current?.click()}
                        className="w-20 h-20 rounded-full overflow-hidden bg-slate-100 border-4 border-white shadow-md cursor-pointer relative"
                    >
                        <TokenImg value={npc.avatar} className="w-full h-full object-cover" alt={name} />
                        <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center text-white text-[10px] opacity-0 hover:opacity-100">
                            更换
                        </div>
                    </div>
                    <input type="file" ref={fileRef} className="hidden" accept="image/*" onChange={e => e.target.files?.[0] && handleAvatarUpload(e.target.files[0])} />
                </div>

                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">名字</label>
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        onBlur={() => onChange({ name })}
                        className="w-full bg-white border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm focus:bg-white transition-all"
                    />
                </div>

                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">性格与背景描述</label>
                    <textarea
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        onBlur={() => onChange({ description })}
                        placeholder="ta 是什么样的人，会怎么出现在群聊/查手机联系人/见面剧情里"
                        rows={4}
                        className="w-full bg-white border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm resize-none focus:bg-white transition-all"
                    />
                </div>

                <div>
                    <div className="flex items-center justify-between mb-2 px-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">关系</label>
                        <button onClick={addRelationship} className="text-[10px] bg-violet-50 text-violet-600 px-2.5 py-1 rounded-full font-bold">
                            + 新增关系
                        </button>
                    </div>
                    {npc.relationships.length === 0 ? (
                        <div className="text-center py-4 bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 text-xs">
                            还没有设定关系——同一个 NPC 可以跟不同角色/用户各自有一段不同的关系
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {npc.relationships.map(rel => (
                                <div key={rel.id} className="bg-white rounded-2xl border border-slate-200 p-3 space-y-2">
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={rel.targetId}
                                            onChange={e => updateRelationship(rel.id, { targetId: e.target.value })}
                                            className="flex-1 bg-slate-50 border border-slate-200/60 rounded-lg px-2.5 py-1.5 text-xs font-bold"
                                        >
                                            <option value="user">用户</option>
                                            {characters.map(c => (
                                                <option key={c.id} value={c.id}>{c.name}</option>
                                            ))}
                                        </select>
                                        <button onClick={() => removeRelationship(rel.id)} className="shrink-0 px-2 text-slate-300 hover:text-red-400">×</button>
                                    </div>
                                    <textarea
                                        defaultValue={rel.description}
                                        onBlur={e => updateRelationship(rel.id, { description: e.target.value })}
                                        placeholder="这段关系的描述，如「妹妹，从小玩到大，愛耍賴」"
                                        rows={2}
                                        className="w-full bg-slate-50 border border-slate-200/60 rounded-lg px-2.5 py-2 text-xs resize-none"
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">世界观 / 设定补充</label>
                    <textarea
                        value={worldview}
                        onChange={e => setWorldview(e.target.value)}
                        onBlur={() => onChange({ worldview })}
                        placeholder="在这个世界里，魔法是存在的..."
                        rows={3}
                        className="w-full bg-white border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm resize-none focus:bg-white transition-all"
                    />
                </div>

                {/* 时间感知 & 时区：字段跟 CharacterProfile 同名，群聊/见面接入 NPC 后可以直接复用同一套时区工具函数 */}
                <div className="bg-white rounded-2xl p-4 border border-slate-200 space-y-3">
                    <div>
                        <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block">时间感知 & 时区</label>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">两个开关相互独立，可任意组合。</p>
                    </div>

                    <div className="border-t border-slate-100 pt-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-700">时间感知强化</p>
                                <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">默认开。出现在群聊/见面里时，会贴近真实时间和作息。</p>
                            </div>
                            <button
                                onClick={() => onChange({ timeAwarenessEnabled: npc.timeAwarenessEnabled === false })}
                                className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${npc.timeAwarenessEnabled !== false ? 'bg-primary' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${npc.timeAwarenessEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                            </button>
                        </div>
                    </div>

                    <div className="border-t border-slate-100 pt-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-700">自定义时区</p>
                                <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">默认关（跟随本机）。适合设定在异国的 NPC。</p>
                            </div>
                            <button
                                onClick={() => onChange({ customTimezoneEnabled: !npc.customTimezoneEnabled })}
                                className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${npc.customTimezoneEnabled ? 'bg-primary' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${npc.customTimezoneEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                            </button>
                        </div>
                        {npc.customTimezoneEnabled && (
                            <select
                                value={npc.customTimezone || ''}
                                onChange={e => onChange({ customTimezone: e.target.value })}
                                className="mt-3 w-full bg-slate-50 rounded-xl px-3 py-2.5 text-xs border border-slate-200 outline-none focus:ring-1 focus:ring-primary/30"
                            >
                                <option value="">请选择 NPC 所在时区…</option>
                                {COMMON_TIMEZONES.map(tz => (
                                    <option key={tz.id} value={tz.id}>{tz.label}</option>
                                ))}
                            </select>
                        )}
                    </div>

                    <div className="border-t border-slate-100 pt-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-700">线下时间感知（见面）</p>
                                <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">默认开。出现在见面剧情里时跟着现实时间走；关掉更适合纯架空。</p>
                            </div>
                            <button
                                onClick={() => onChange({ dateTimeAwarenessEnabled: npc.dateTimeAwarenessEnabled === false ? undefined : false })}
                                className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${npc.dateTimeAwarenessEnabled !== false ? 'bg-primary' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${npc.dateTimeAwarenessEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                            </button>
                        </div>
                    </div>
                </div>

                {/* AI 模型：默认跟随查手机 App 的共用设定（跟真人联系人的关系对话共用同一组），可选自定义单独覆盖 */}
                <div className="bg-white rounded-2xl p-4 border border-slate-200 space-y-3">
                    <div>
                        <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block">AI 模型</label>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">默认跟查手机里其他联系人共用同一组设定；选「自定义」可以单独给这个 NPC 配一个不同的 API / 模型。</p>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => { setApiMode('shared'); saveApiConfig('shared'); }}
                            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                                apiMode === 'shared' ? 'bg-violet-100 border-violet-300 text-violet-700' : 'bg-slate-50 border-slate-200 text-slate-500'
                            }`}
                        >
                            查手机共用设定
                        </button>
                        <button
                            onClick={() => setApiMode('custom')}
                            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                                apiMode === 'custom' ? 'bg-violet-100 border-violet-300 text-violet-700' : 'bg-slate-50 border-slate-200 text-slate-500'
                            }`}
                        >
                            自定义
                        </button>
                    </div>
                    {apiMode === 'custom' && (
                        <div className="space-y-2">
                            {apiPresets.length > 0 && (
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">我的预设</label>
                                    <div className="flex gap-2 flex-wrap">
                                        {apiPresets.map(preset => (
                                            <button
                                                key={preset.id}
                                                onClick={() => loadPreset(preset)}
                                                className="flex items-center bg-white border border-slate-200 rounded-lg px-3 py-1 shadow-sm text-xs font-medium text-slate-600 hover:text-pink-500 hover:border-pink-200 active:scale-95 transition-all"
                                            >
                                                {preset.name}
                                                <span className="ml-1.5 text-slate-300">{preset.config.model}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <input
                                type="text"
                                value={apiUrl}
                                onChange={e => setApiUrl(e.target.value)}
                                onBlur={() => saveApiConfig('custom')}
                                placeholder="URL，如 https://api.example.com/v1"
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-mono"
                            />
                            <input
                                type="password"
                                value={apiKey}
                                onChange={e => setApiKey(e.target.value)}
                                onBlur={() => saveApiConfig('custom')}
                                placeholder="Key"
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-mono"
                            />
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</span>
                                    <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-indigo-500 font-bold">
                                        {isLoadingModels ? '拉取中...' : '刷新模型列表'}
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    value={apiModel}
                                    onChange={e => setApiModel(e.target.value)}
                                    onBlur={() => saveApiConfig('custom')}
                                    placeholder="Model，或点右上角刷新拉取"
                                    className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-mono"
                                />
                                {modelStatusMsg && <p className="text-[10px] text-slate-400 mt-1">{modelStatusMsg}</p>}
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    onClick={handleTestConnection}
                                    disabled={testingConnection || !apiUrl.trim()}
                                    className="flex-1 py-2 bg-slate-100 text-slate-600 text-xs font-bold rounded-xl disabled:opacity-50 active:scale-95 transition-transform"
                                >
                                    {testingConnection ? '测试中...' : '🧪 测试连接'}
                                </button>
                                <button
                                    onClick={() => setShowSavePreset(v => !v)}
                                    className="flex-1 py-2 bg-slate-100 text-slate-600 text-xs font-bold rounded-xl active:scale-95 transition-transform"
                                >
                                    保存为预设
                                </button>
                            </div>
                            {testConnectionResult && <p className="text-[10px] text-slate-500">{testConnectionResult}</p>}
                            {showSavePreset && (
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={newPresetName}
                                        onChange={e => setNewPresetName(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && handleSavePreset()}
                                        placeholder="预设名称..."
                                        className="flex-1 bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs"
                                        autoFocus
                                    />
                                    <button onClick={handleSavePreset} className="px-4 py-2 bg-pink-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform">
                                        保存
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {showModelModal && (() => {
                    const query = modelSearchQuery.trim().toLowerCase();
                    const filteredList = query ? availableModels.filter(m => m.toLowerCase().includes(query)) : availableModels;
                    return (
                        <Modal isOpen title="选择模型" onClose={() => setShowModelModal(false)}>
                            <div className="space-y-2">
                                <input
                                    type="text"
                                    value={modelSearchQuery}
                                    onChange={e => setModelSearchQuery(e.target.value)}
                                    placeholder="搜索模型..."
                                    className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-mono"
                                    autoFocus
                                />
                                <div className="max-h-72 overflow-y-auto space-y-1 no-scrollbar">
                                    {filteredList.length === 0 && (
                                        <p className="text-[11px] text-slate-400 text-center py-4">没有匹配的模型</p>
                                    )}
                                    {filteredList.map(m => (
                                        <button
                                            key={m}
                                            onClick={() => {
                                                setApiModel(m);
                                                saveApiConfig('custom', apiUrl, apiKey, m);
                                                setShowModelModal(false);
                                            }}
                                            className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-all ${
                                                m === apiModel ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                                            }`}
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </Modal>
                    );
                })()}

                <div>
                    <div className="flex justify-between items-center mb-2 px-1">
                        <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest">扩展设定 (Worldbooks)</label>
                        <button onClick={() => setShowWorldbookModal(true)} className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-bold hover:bg-indigo-100">+ 挂载</button>
                    </div>
                    {npc.mountedWorldbooks && npc.mountedWorldbooks.length > 0 ? (
                        <div className="space-y-2">
                            {npc.mountedWorldbooks.map(wb => (
                                <div key={wb.id} className="flex items-center gap-2 bg-white rounded-xl border border-slate-100 px-3 py-2.5">
                                    <span className="min-w-0 flex-1 text-xs text-slate-600 truncate">{wb.title}</span>
                                    <button onClick={() => unmountWorldbook(wb.id)} className="shrink-0 px-2 text-slate-400">×</button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-4 bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 text-xs">
                            暂未挂载任何世界书
                        </div>
                    )}
                </div>
            </div>

            <Modal isOpen={showWorldbookModal} title="挂载世界书" onClose={() => setShowWorldbookModal(false)}>
                <div className="max-h-[50vh] overflow-y-auto no-scrollbar space-y-2 p-1">
                    {worldbooks.length === 0 ? (
                        <div className="text-center text-slate-400 text-xs py-8">
                            还没有世界书，请去桌面【世界书】App 创建。
                        </div>
                    ) : (
                        worldbooks.map(wb => {
                            const isMounted = npc.mountedWorldbooks?.some(m => m.id === wb.id);
                            return (
                                <button
                                    key={wb.id}
                                    onClick={() => !isMounted && mountWorldbook(wb.id)}
                                    disabled={isMounted}
                                    className={`w-full p-3 rounded-xl border text-left transition-all ${isMounted ? 'bg-slate-50 border-slate-200 opacity-50 cursor-not-allowed' : 'bg-white border-indigo-100 hover:border-indigo-300 shadow-sm active:scale-95'}`}
                                >
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="font-bold text-slate-700 text-sm truncate">{wb.title}</span>
                                        {isMounted && <span className="text-[10px] text-slate-400 shrink-0">已挂载</span>}
                                    </div>
                                    <div className="text-[10px] text-slate-400 truncate mt-0.5">{wb.category || '未分类设定 (General)'}</div>
                                </button>
                            );
                        })
                    )}
                </div>
            </Modal>
        </div>
    );
};

export default React.memo(NPCManagerView);
