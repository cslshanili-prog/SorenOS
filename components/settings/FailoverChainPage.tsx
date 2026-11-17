import React, { useState } from 'react';
import { ArrowDown, ArrowUp, CaretLeft, Check } from '@phosphor-icons/react';
import type { ApiPreset } from '../../types';
import { FAILOVER_SLOT_LABEL, apiCooldownMinutes, getFailoverOverride, sameApi, type FailoverSlot } from '../../utils/apiFailover';

/**
 * 備援鏈的全螢幕頁（plans/api-center-failover.md 第 2 批；不要半窗）：勾預設、排順序，旁邊標活著／冷卻中。
 */
const FailoverChainPage: React.FC<{
    slot: FailoverSlot;
    /** 這個槽目前主用的那組（標出來、排在鏈外） */
    current: { baseUrl: string; apiKey: string } | null;
    value: string[];
    presets: ApiPreset[];
    onSave: (ids: string[]) => void;
    onClose: () => void;
}> = ({ slot, current, value, presets, onSave, onClose }) => {
    const [ids, setIds] = useState<string[]>(value.filter(id => presets.some(p => p.id === id)));
    const picked = ids.map(id => presets.find(p => p.id === id)!).filter(Boolean);
    const rest = presets.filter(p => !ids.includes(p.id));
    const move = (i: number, d: -1 | 1) => setIds(prev => { const n = [...prev]; const j = i + d; if (j < 0 || j >= n.length) return prev; [n[i], n[j]] = [n[j], n[i]]; return n; });
    const override = getFailoverOverride(slot);
    const status = (p: ApiPreset) => {
        const m = apiCooldownMinutes(p.config);
        if (m > 0) return <span className="text-[10px] font-bold text-rose-500">冷卻中 {m} 分</span>;
        if (override && sameApi(override.to, p.config)) return <span className="text-[10px] font-bold text-emerald-600">目前頂著用</span>;
        return <span className="text-[10px] text-emerald-500">活著</span>;
    };
    const row = (p: ApiPreset, i: number, inChain: boolean) => (
        <div key={p.id} className={`flex items-center gap-2 rounded-2xl border px-3 py-2.5 ${inChain ? 'bg-white border-slate-200' : 'bg-white/60 border-dashed border-slate-200'}`}>
            <button type="button" aria-label={inChain ? `拿掉 ${p.name}` : `加入 ${p.name}`} onClick={() => setIds(prev => inChain ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                className={`h-6 w-6 shrink-0 rounded-full border grid place-items-center ${inChain ? 'bg-slate-800 border-slate-800 text-white' : 'border-slate-300 text-transparent'}`}><Check size={14} weight="bold" /></button>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                    {inChain && <span className="text-[10px] font-bold text-slate-400 tabular-nums">{i + 1}.</span>}
                    <span className="truncate text-[13px] font-bold text-slate-700">{p.name}</span>
                    {current && sameApi(current, p.config) && <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[9px] font-bold text-slate-500">主用</span>}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-400"><span className="truncate">{p.config.model || '沒填模型'}</span>{status(p)}</div>
            </div>
            {inChain && (
                <div className="flex flex-col gap-0.5 shrink-0">
                    <button type="button" aria-label="往上" onClick={() => move(i, -1)} disabled={i === 0} className="text-slate-400 disabled:opacity-30"><ArrowUp size={14} /></button>
                    <button type="button" aria-label="往下" onClick={() => move(i, 1)} disabled={i === picked.length - 1} className="text-slate-400 disabled:opacity-30"><ArrowDown size={14} /></button>
                </div>
            )}
        </div>
    );
    return (
        <div className="fixed inset-0 z-[100] flex flex-col bg-slate-50 animate-fade-in" role="dialog" aria-label="備援鏈">
            <div className="shrink-0 bg-white/90 backdrop-blur-md border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center justify-between px-3 py-3">
                    <button type="button" onClick={onClose} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold text-slate-800">{FAILOVER_SLOT_LABEL[slot]}的備援鏈</h1>
                    <button type="button" onClick={() => { onSave(ids); onClose(); }} className="rounded-full bg-slate-800 px-3 py-1.5 text-[12px] font-bold text-white">存</button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 space-y-4" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 24px)' }}>
                <p className="text-[11px] text-slate-500 leading-relaxed">主用的那組掛了（網路錯、逾時、429、5xx）就照這個順序換下一家再發一次，掛掉的冷卻 5 分鐘。Key 錯（401／403）不算掛，不換。換了家會在 API 調用記錄的用途後面標出來。</p>
                <section className="space-y-2">
                    <h2 className="px-1 text-[12px] font-bold text-slate-500">備援順序 <span className="font-normal text-slate-400">{picked.length ? `${picked.length} 個` : '還沒排'}</span></h2>
                    {picked.length === 0 && <div className="rounded-2xl border border-dashed border-slate-200 px-3 py-4 text-center text-[12px] text-slate-400">從下面勾幾個預設進來。</div>}
                    {picked.map((p, i) => row(p, i, true))}
                </section>
                <section className="space-y-2">
                    <h2 className="px-1 text-[12px] font-bold text-slate-500">我的預設</h2>
                    {rest.length === 0 && presets.length === 0 && <div className="text-[12px] text-slate-400 px-1">還沒有預設；先在系統設置 → API 配置存幾個。</div>}
                    {rest.map((p, i) => row(p, i, false))}
                </section>
                <p className="rounded-2xl bg-amber-50 border border-amber-100 px-3 py-2.5 text-[11px] text-amber-700 leading-relaxed">雲端（主動消息 2.0 到點、即時對話、後台任務）用的是本機目前活著的這家，到點掛了不會自己換下一家；本機一換家，雲端那行憑據會跟著更新。</p>
            </div>
        </div>
    );
};

export default FailoverChainPage;
