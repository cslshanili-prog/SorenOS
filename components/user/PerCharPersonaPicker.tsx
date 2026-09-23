import React, { useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { REAL_IDENTITY_PERSONA_ID, resolveUserProfileForChar } from '../../utils/userPersona';
import TokenImg from '../os/TokenImg';
import { trackEvent } from '../../utils/analytics';

/**
 * 檔案 App「分角色身份指定」：給每個角色單獨指定一張身份卡（或強制真實身份），
 * 不影響其他角色。不設置 = 跟全域默認（身份卡面板裡的「目前身份」）走。
 *
 * 數據存 userProfile.perCharPersonaIds（charId → personaId / REAL_IDENTITY_PERSONA_ID），
 * 解析統一走 utils/userPersona.ts 的 resolveUserProfileForChar()——目前只有私聊
 * （Chat.tsx）、查手機（CheckPhone.tsx）、記憶宮殿幾處生成記憶用的地方接了這份解析，
 * 其餘畫面仍讀全域默認，是刻意分批留下的範圍邊界。
 *
 * 結構跟「分角色聊天頭像」(PerCharAvatarPicker) 同款：搜索過濾 + 每頁 8 個的翻頁網格。
 */

const PAGE_SIZE = 8;

const PerCharPersonaPicker: React.FC = () => {
    const { characters, userProfileBase, updateUserProfile } = useOS();
    const personas = userProfileBase.personas || [];
    const overrides = userProfileBase.perCharPersonaIds || {};

    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const [slideDir, setSlideDir] = useState<'l' | 'r'>('l');
    const swipeStartX = useRef<number | null>(null);

    const [editingId, setEditingId] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? characters.filter(c => c.name.toLowerCase().includes(q)) : characters;
    }, [characters, query]);

    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageChars = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

    const goPage = (next: number) => {
        const clamped = Math.max(0, Math.min(pageCount - 1, next));
        if (clamped === safePage) return;
        setSlideDir(clamped > safePage ? 'l' : 'r');
        setPage(clamped);
    };

    const setOverride = (charId: string, personaId: string | undefined) => {
        const next = { ...overrides };
        if (personaId) next[charId] = personaId; else delete next[charId];
        updateUserProfile({ perCharPersonaIds: next });
    };

    const editingChar = editingId ? characters.find(c => c.id === editingId) : null;

    if (characters.length === 0) return null;

    return (
        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5">
            {/* 翻頁滑入動效（組件私有，不進全局 tailwind 配置） */}
            <style>{`
                @keyframes pcpSlideL { from { opacity: .35; transform: translateX(26px); } to { opacity: 1; transform: none; } }
                @keyframes pcpSlideR { from { opacity: .35; transform: translateX(-26px); } to { opacity: 1; transform: none; } }
                .pcp-slide-l { animation: pcpSlideL .28s cubic-bezier(0.25, 1, 0.5, 1); }
                .pcp-slide-r { animation: pcpSlideR .28s cubic-bezier(0.25, 1, 0.5, 1); }
            `}</style>

            <div className="flex items-center gap-2 mb-1">
                <span className="w-7 h-7 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.072M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
                    </svg>
                </span>
                <h2 className="text-sm font-bold text-slate-700">分角色身份指定</h2>
            </div>
            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                給某個角色單獨指定一張身份卡，不影響其他角色——不設置的角色跟上面「身份卡」的目前身份走。
            </p>

            {characters.length > PAGE_SIZE && (
                <input
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                    placeholder="搜索角色…"
                    className="w-full mb-3 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-2xl px-4 py-2 text-xs text-slate-700 outline-none transition-all placeholder:text-slate-300"
                />
            )}

            {filtered.length === 0 ? (
                <div className="py-8 text-center text-[11px] text-slate-300">沒有叫這個名字的角色</div>
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
                    <div key={`${safePage}-${query}`} className={`grid grid-cols-4 gap-3 ${slideDir === 'l' ? 'pcp-slide-l' : 'pcp-slide-r'}`}>
                        {pageChars.map(c => {
                            const resolved = resolveUserProfileForChar(userProfileBase, c.id);
                            const hasOverride = !!overrides[c.id];
                            return (
                                <button key={c.id} onClick={() => setEditingId(c.id)} className="flex flex-col items-center gap-1.5 group active:scale-95 transition-transform">
                                    <div className="relative">
                                        <TokenImg value={c.avatar} alt="" className="w-14 h-14 rounded-full object-cover bg-slate-100 border border-slate-100 group-hover:border-primary/30 transition-colors" />
                                        {/* 右下小圓 = 這個角色此刻實際生效的身份（覆蓋或全域默認）；指定過 → 主題色描邊 */}
                                        <TokenImg
                                            value={resolved.avatar}
                                            alt=""
                                            className={`absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-full object-cover bg-white shadow-sm ${hasOverride ? 'ring-2 ring-primary' : 'ring-2 ring-white opacity-60'}`}
                                        />
                                    </div>
                                    <span className="w-full text-[10px] text-slate-500 truncate text-center">{c.name}</span>
                                </button>
                            );
                        })}
                        {pageCount > 1 && pageChars.length < PAGE_SIZE && Array.from({ length: PAGE_SIZE - pageChars.length }, (_, i) => (
                            <div key={`pad-${i}`} className="flex flex-col items-center gap-1.5 invisible" aria-hidden="true">
                                <div className="w-14 h-14 rounded-full" />
                                <span className="text-[10px]">&nbsp;</span>
                            </div>
                        ))}
                    </div>

                    {pageCount > 1 && (
                        <div className="mt-3 flex items-center justify-center gap-3">
                            <button onClick={() => goPage(safePage - 1)} disabled={safePage === 0}
                                className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500 transition-all active:scale-90 disabled:opacity-30" aria-label="上一頁">‹</button>
                            <div className="flex items-center gap-1.5">
                                {Array.from({ length: pageCount }, (_, i) => (
                                    <button key={i} onClick={() => goPage(i)} aria-label={`第 ${i + 1} 頁`}
                                        className={`rounded-full transition-all ${i === safePage ? 'w-4 h-1.5 bg-primary' : 'w-1.5 h-1.5 bg-slate-200 hover:bg-slate-300'}`} />
                                ))}
                            </div>
                            <button onClick={() => goPage(safePage + 1)} disabled={safePage === pageCount - 1}
                                className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500 transition-all active:scale-90 disabled:opacity-30" aria-label="下一頁">›</button>
                        </div>
                    )}
                </div>
            )}

            {/* 選擇彈層：跟隨全域默認 / 強制真實身份 / 某張身份卡 */}
            {editingChar && (
                <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setEditingId(null)}>
                    <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 animate-slide-up sm:animate-pop-in"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="text-sm font-bold text-slate-800">{editingChar.name} 單獨用哪張身份</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">只影響這個角色；其他角色不變。</div>
                            </div>
                            <button onClick={() => setEditingId(null)} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">×</button>
                        </div>

                        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                            <button
                                onClick={() => { setOverride(editingChar.id, undefined); setEditingId(null); trackEvent('分角色身份指定', { choice: 'default' }); }}
                                className={`w-full flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] ${!overrides[editingChar.id] ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                            >
                                <span className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0">∅</span>
                                <div className="min-w-0">
                                    <div className="text-[11px] font-bold text-slate-700">跟隨全域默認</div>
                                    <div className="text-[9px] text-slate-400">身份卡面板裡的「目前身份」切換時，這個角色一起跟著變</div>
                                </div>
                            </button>

                            <button
                                onClick={() => { setOverride(editingChar.id, REAL_IDENTITY_PERSONA_ID); setEditingId(null); trackEvent('分角色身份指定', { choice: 'real' }); }}
                                className={`w-full flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] ${overrides[editingChar.id] === REAL_IDENTITY_PERSONA_ID ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                            >
                                <TokenImg value={userProfileBase.avatar} className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                <div className="min-w-0">
                                    <div className="text-[11px] font-bold text-slate-700 truncate">{userProfileBase.name || '真實身份'}</div>
                                    <div className="text-[9px] text-slate-400">強制真實身份，不管全域默認切成哪張卡</div>
                                </div>
                            </button>

                            {personas.map(p => {
                                const active = overrides[editingChar.id] === p.id;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => { setOverride(editingChar.id, p.id); setEditingId(null); trackEvent('分角色身份指定', { choice: 'persona' }); }}
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
                                <p className="pt-1 text-[10px] text-slate-400 text-center">還沒有身份卡，去上面「身份卡」新增一張</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PerCharPersonaPicker;
