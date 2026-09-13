
import React, { useEffect, useRef, useState } from 'react';
import { CharacterProfile, NPCProfile, NPCRelationship } from '../../types';
import TokenImg from '../os/TokenImg';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';

interface NPCManagerViewProps {
    npcs: NPCProfile[];
    characters: CharacterProfile[];
    addNPC: () => Promise<NPCProfile>;
    updateNPC: (id: string, updates: Partial<NPCProfile> | ((prev: NPCProfile) => Partial<NPCProfile>)) => void;
    deleteNPC: (id: string) => Promise<void>;
    onSwitchTab: (tab: 'characters' | 'npcs') => void;
    closeApp: () => void;
}

const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const NPCManagerView: React.FC<NPCManagerViewProps> = ({ npcs, characters, addNPC, updateNPC, deleteNPC, onSwitchTab, closeApp }) => {
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
    onChange: (updates: Partial<NPCProfile>) => void;
    onBack: () => void;
    onDelete: () => void;
}

const NPCDetailView: React.FC<NPCDetailViewProps> = ({ npc, characters, onChange, onBack, onDelete }) => {
    const fileRef = useRef<HTMLInputElement>(null);
    const [name, setName] = useState(npc.name);
    const [description, setDescription] = useState(npc.description);

    // 切换编辑对象时把本地草稿同步回来，避免残留上一个 NPC 的文字。
    useEffect(() => {
        setName(npc.name);
        setDescription(npc.description);
    }, [npc.id]);

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
            </div>
        </div>
    );
};

export default React.memo(NPCManagerView);
