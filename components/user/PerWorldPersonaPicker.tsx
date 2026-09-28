import React, { useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';
import TokenImg from '../os/TokenImg';
import { trackEvent } from '../../utils/analytics';

/**
 * 檔案 App「分世界身份指定」：世界 = 神經鏈接的角色分組（CharacterGroup）。給一個分組指定一張身份卡，
 * 分組裡沒單獨指定過的角色都用這張——不同世界觀用不同的你，不用一個一個角色去設。
 *
 * 數據存 userProfile.perWorldPersonaIds（分組 id → personaId / REAL_IDENTITY_PERSONA_ID）。
 * 優先級：分角色指定 > 世界預設 > 全域默認，解析統一走 utils/userPersona.ts 的 resolveUserProfileForChar()。
 */
const PerWorldPersonaPicker: React.FC = () => {
    const { characters, characterGroups, userProfileBase, updateUserProfile } = useOS();
    const personas = userProfileBase.personas || [];
    const overrides = userProfileBase.perWorldPersonaIds || {};
    const [editingId, setEditingId] = useState<string | null>(null);

    const membersOf = useMemo(() => {
        const map = new Map<string, typeof characters>();
        for (const c of characters) {
            if (!c.groupId) continue;
            map.set(c.groupId, [...(map.get(c.groupId) || []), c]);
        }
        return map;
    }, [characters]);

    const setOverride = (groupId: string, personaId: string | undefined) => {
        const next = { ...overrides };
        if (personaId) next[groupId] = personaId; else delete next[groupId];
        updateUserProfile({ perWorldPersonaIds: next });
    };

    const describe = (groupId: string): { avatar?: string; label: string; set: boolean } => {
        const id = overrides[groupId];
        if (!id) return { label: '跟隨全域默認', set: false };
        if (id === REAL_IDENTITY_PERSONA_ID) return { avatar: userProfileBase.avatar, label: userProfileBase.name || '真實身份', set: true };
        const p = personas.find(x => x.id === id);
        return p ? { avatar: p.avatar, label: p.name, set: true } : { label: '跟隨全域默認', set: false };
    };

    const editingGroup = editingId ? characterGroups.find(g => g.id === editingId) : null;

    return (
        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5">
            <div className="flex items-center gap-2 mb-1">
                <span className="w-7 h-7 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                    </svg>
                </span>
                <h2 className="text-sm font-bold text-slate-700">分世界身份指定</h2>
            </div>
            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                世界就是神經鏈接裡的角色分組。給一個世界指定身份卡，分組裡的角色都用這張；個別角色在下面「分角色身份指定」單獨設過的，以角色自己的為準。
            </p>

            {characterGroups.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 px-4 py-4 text-center text-[11px] leading-relaxed text-slate-400">
                    還沒有分組。到神經鏈接用「分組」把同一個世界觀的角色放在一起，就能在這裡一次指定身份。
                </div>
            ) : (
                <div className="space-y-2">
                    {characterGroups.map(g => {
                        const members = membersOf.get(g.id) || [];
                        const d = describe(g.id);
                        return (
                            <button key={g.id} onClick={() => setEditingId(g.id)}
                                className="w-full flex items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-left active:scale-[0.99] transition-transform">
                                <div className="min-w-0 flex-1">
                                    <div className="text-[13px] font-bold text-slate-700 truncate">{g.name}</div>
                                    <div className="mt-1 flex items-center gap-1.5">
                                        <div className="flex -space-x-2">
                                            {members.slice(0, 5).map(c => (
                                                <TokenImg key={c.id} value={c.avatar} alt="" className="w-5 h-5 rounded-full object-cover bg-slate-100 ring-2 ring-white" />
                                            ))}
                                        </div>
                                        <span className="text-[10px] text-slate-400">{members.length} 個角色</span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0 max-w-[45%]">
                                    {d.avatar !== undefined && <TokenImg value={d.avatar} alt="" className="w-7 h-7 rounded-full object-cover bg-slate-100 ring-2 ring-primary" />}
                                    <span className={`text-[11px] truncate ${d.set ? 'font-bold text-slate-700' : 'text-slate-400'}`}>{d.label}</span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            {editingGroup && (
                <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setEditingId(null)}>
                    <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 animate-slide-up sm:animate-pop-in"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="text-sm font-bold text-slate-800">「{editingGroup.name}」用哪張身份</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">這個世界裡的角色都用這張；單獨指定過的角色不受影響。</div>
                            </div>
                            <button onClick={() => setEditingId(null)} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">×</button>
                        </div>

                        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                            <button
                                onClick={() => { setOverride(editingGroup.id, undefined); setEditingId(null); trackEvent('分世界身份指定', { choice: 'default' }); }}
                                className={`w-full flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] ${!overrides[editingGroup.id] ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                            >
                                <span className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0">∅</span>
                                <div className="min-w-0">
                                    <div className="text-[11px] font-bold text-slate-700">跟隨全域默認</div>
                                    <div className="text-[9px] text-slate-400">頁首切換「目前身份」時，這個世界一起跟著變</div>
                                </div>
                            </button>

                            <button
                                onClick={() => { setOverride(editingGroup.id, REAL_IDENTITY_PERSONA_ID); setEditingId(null); trackEvent('分世界身份指定', { choice: 'real' }); }}
                                className={`w-full flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] ${overrides[editingGroup.id] === REAL_IDENTITY_PERSONA_ID ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                            >
                                <TokenImg value={userProfileBase.avatar} className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                <div className="min-w-0">
                                    <div className="text-[11px] font-bold text-slate-700 truncate">{userProfileBase.name || '真實身份'}</div>
                                    <div className="text-[9px] text-slate-400">這個世界固定用真實身份</div>
                                </div>
                            </button>

                            {personas.map(p => {
                                const active = overrides[editingGroup.id] === p.id;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => { setOverride(editingGroup.id, p.id); setEditingId(null); trackEvent('分世界身份指定', { choice: 'persona' }); }}
                                        className={`w-full flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] ${active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                                    >
                                        <TokenImg value={p.avatar} className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[11px] font-bold text-slate-700 truncate">{p.name}</div>
                                        </div>
                                    </button>
                                );
                            })}
                            {personas.length === 0 && (
                                <p className="pt-1 text-[10px] text-slate-400 text-center">還沒有身份卡，先到「身份卡」新增一張</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PerWorldPersonaPicker;
