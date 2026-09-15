import React, { useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { REAL_IDENTITY_PERSONA_ID, resolveUserProfileForGroup } from '../../utils/userPersona';
import TokenImg from '../os/TokenImg';
import { trackEvent } from '../../utils/analytics';

/**
 * 档案 App「群聊身份指定」：给每个群单独指定一张身份卡（或强制真实身份），不影响其他群
 * 或任何私聊。不设置 = 跟全域默认（身份卡面板里的「目前身份」）走。
 *
 * 数据存 userProfile.perGroupPersonaIds（groupId → personaId / REAL_IDENTITY_PERSONA_ID），
 * 解析统一走 utils/userPersona.ts 的 resolveUserProfileForGroup()——群聊没有
 * 「分角色聊天头像」那层叠加（群聊头像一直用整体默认），跟私聊那边的分角色指定是
 * 两个独立的 map，互不影响。目前只有 GroupChat.tsx 接了这份解析。
 *
 * 结构跟「分角色身份指定」(PerCharPersonaPicker) 同款：搜索过滤 + 每页 8 个的翻页网格。
 */

const PAGE_SIZE = 8;

const PerGroupPersonaPicker: React.FC = () => {
    const { groups, userProfileBase, updateUserProfile } = useOS();
    const personas = userProfileBase.personas || [];
    const overrides = userProfileBase.perGroupPersonaIds || {};

    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const [slideDir, setSlideDir] = useState<'l' | 'r'>('l');
    const swipeStartX = useRef<number | null>(null);

    const [editingId, setEditingId] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups;
    }, [groups, query]);

    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageGroups = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

    const goPage = (next: number) => {
        const clamped = Math.max(0, Math.min(pageCount - 1, next));
        if (clamped === safePage) return;
        setSlideDir(clamped > safePage ? 'l' : 'r');
        setPage(clamped);
    };

    const setOverride = (groupId: string, personaId: string | undefined) => {
        const next = { ...overrides };
        if (personaId) next[groupId] = personaId; else delete next[groupId];
        updateUserProfile({ perGroupPersonaIds: next });
    };

    const editingGroup = editingId ? groups.find(g => g.id === editingId) : null;

    if (groups.length === 0) return null;

    return (
        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5">
            {/* 翻页滑入动效（组件私有，不进全局 tailwind 配置） */}
            <style>{`
                @keyframes pgpSlideL { from { opacity: .35; transform: translateX(26px); } to { opacity: 1; transform: none; } }
                @keyframes pgpSlideR { from { opacity: .35; transform: translateX(-26px); } to { opacity: 1; transform: none; } }
                .pgp-slide-l { animation: pgpSlideL .28s cubic-bezier(0.25, 1, 0.5, 1); }
                .pgp-slide-r { animation: pgpSlideR .28s cubic-bezier(0.25, 1, 0.5, 1); }
            `}</style>

            <div className="flex items-center gap-2 mb-1">
                <span className="w-7 h-7 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                    </svg>
                </span>
                <h2 className="text-sm font-bold text-slate-700">群聊身份指定</h2>
            </div>
            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                给某个群单独指定一张身份卡，不影响其他群或私聊——不设置的群跟上面「身份卡」的目前身份走。群聊没有单独的头像叠加，指定身份卡时头像也会跟着换。
            </p>

            {groups.length > PAGE_SIZE && (
                <input
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                    placeholder="搜索群聊…"
                    className="w-full mb-3 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-2xl px-4 py-2 text-xs text-slate-700 outline-none transition-all placeholder:text-slate-300"
                />
            )}

            {filtered.length === 0 ? (
                <div className="py-8 text-center text-[11px] text-slate-300">没有叫这个名字的群</div>
            ) : (
                <div
                    onTouchStart={(e) => { swipeStartX.current = e.touches[0]?.clientX ?? null; }}
                    onTouchEnd={(e) => {
                        const startX = swipeStartX.current;
                        swipeStartX.current = null;
                        const endX = e.changedTouches[0]?.clientX;
                        if (startX == null || endX == null) return;
                        const dx = endX - startX;
                        if (Math.abs(dx) > 48) goPage(safePage + (dx < 0 ? 1 : -1));
                    }}
                >
                    <div key={`${safePage}-${query}`} className={`grid grid-cols-4 gap-3 ${slideDir === 'l' ? 'pgp-slide-l' : 'pgp-slide-r'}`}>
                        {pageGroups.map(g => {
                            const resolved = resolveUserProfileForGroup(userProfileBase, g.id);
                            const hasOverride = !!overrides[g.id];
                            return (
                                <button key={g.id} onClick={() => setEditingId(g.id)} className="flex flex-col items-center gap-1.5 group active:scale-95 transition-transform">
                                    <div className="relative">
                                        <TokenImg value={g.avatar} alt="" className="w-14 h-14 rounded-full object-cover bg-slate-100 border border-slate-100 group-hover:border-primary/30 transition-colors" />
                                        {/* 右下小圆 = 这个群此刻实际生效的身份（覆盖或全域默认）；指定过 → 主题色描边 */}
                                        <TokenImg
                                            value={resolved.avatar}
                                            alt=""
                                            className={`absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-full object-cover bg-white shadow-sm ${hasOverride ? 'ring-2 ring-primary' : 'ring-2 ring-white opacity-60'}`}
                                        />
                                    </div>
                                    <span className="w-full text-[10px] text-slate-500 truncate text-center">{g.name}</span>
                                </button>
                            );
                        })}
                        {pageCount > 1 && pageGroups.length < PAGE_SIZE && Array.from({ length: PAGE_SIZE - pageGroups.length }, (_, i) => (
                            <div key={`pad-${i}`} className="flex flex-col items-center gap-1.5 invisible" aria-hidden="true">
                                <div className="w-14 h-14 rounded-full" />
                                <span className="text-[10px]">&nbsp;</span>
                            </div>
                        ))}
                    </div>

                    {pageCount > 1 && (
                        <div className="mt-3 flex items-center justify-center gap-3">
                            <button onClick={() => goPage(safePage - 1)} disabled={safePage === 0}
                                className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500 transition-all active:scale-90 disabled:opacity-30" aria-label="上一页">‹</button>
                            <div className="flex items-center gap-1.5">
                                {Array.from({ length: pageCount }, (_, i) => (
                                    <button key={i} onClick={() => goPage(i)} aria-label={`第 ${i + 1} 页`}
                                        className={`rounded-full transition-all ${i === safePage ? 'w-4 h-1.5 bg-primary' : 'w-1.5 h-1.5 bg-slate-200 hover:bg-slate-300'}`} />
                                ))}
                            </div>
                            <button onClick={() => goPage(safePage + 1)} disabled={safePage === pageCount - 1}
                                className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500 transition-all active:scale-90 disabled:opacity-30" aria-label="下一页">›</button>
                        </div>
                    )}
                </div>
            )}

            {/* 选择弹层：跟随全域默认 / 强制真实身份 / 某张身份卡 */}
            {editingGroup && (
                <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setEditingId(null)}>
                    <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 animate-slide-up sm:animate-pop-in"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="text-sm font-bold text-slate-800">「{editingGroup.name}」单独用哪张身份</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">只影响这个群；其他群和私聊不变。</div>
                            </div>
                            <button onClick={() => setEditingId(null)} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">×</button>
                        </div>

                        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                            <button
                                onClick={() => { setOverride(editingGroup.id, undefined); setEditingId(null); trackEvent('群聊身份指定', { choice: 'default' }); }}
                                className={`w-full flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] ${!overrides[editingGroup.id] ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                            >
                                <span className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0">∅</span>
                                <div className="min-w-0">
                                    <div className="text-[11px] font-bold text-slate-700">跟随全域默认</div>
                                    <div className="text-[9px] text-slate-400">身份卡面板里的「目前身份」切换时，这个群一起跟着变</div>
                                </div>
                            </button>

                            <button
                                onClick={() => { setOverride(editingGroup.id, REAL_IDENTITY_PERSONA_ID); setEditingId(null); trackEvent('群聊身份指定', { choice: 'real' }); }}
                                className={`w-full flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] ${overrides[editingGroup.id] === REAL_IDENTITY_PERSONA_ID ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                            >
                                <TokenImg value={userProfileBase.avatar} className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                <div className="min-w-0">
                                    <div className="text-[11px] font-bold text-slate-700 truncate">{userProfileBase.name || '真实身份'}</div>
                                    <div className="text-[9px] text-slate-400">强制真实身份，不管全域默认切成哪张卡</div>
                                </div>
                            </button>

                            {personas.map(p => {
                                const active = overrides[editingGroup.id] === p.id;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => { setOverride(editingGroup.id, p.id); setEditingId(null); trackEvent('群聊身份指定', { choice: 'persona' }); }}
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
                                <p className="pt-1 text-[10px] text-slate-400 text-center">还没有身份卡，去上面「身份卡」新增一张</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PerGroupPersonaPicker;
