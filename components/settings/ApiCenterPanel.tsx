import React, { useEffect, useState } from 'react';
import type { ApiPreset, SecondaryApi } from '../../types';
import { useOS } from '../../context/OSContext';
import ApiConnectionTest from '../chat/ApiConnectionTest';
import { isUsableSecondaryApi } from '../../utils/apiCenter';
import FailoverChainPage from './FailoverChainPage';
import { apiCooldownMinutes, type FailoverSlot } from '../../utils/apiFailover';
import { CaretDown, CaretUp } from '@phosphor-icons/react';

/**
 * 系統設置 → API 中心（plans/api-center-failover.md）：四個全局副槽各自從「我的預設」選或手填。
 * 記憶那格就是 memoryPalaceConfig.lightLLM（搬 UI 不搬資料）；情緒／日程、主動消息、朋友圈存 apiConfig.meterApi／amsgApi／momentsApi。
 * 情緒／日程、主動消息：角色自己的 > 這裡 > 主 API。朋友圈反過來：這裡設了就蓋過角色自己的對話模型。
 */

type SlotKey = 'memory' | 'meter' | 'amsg' | 'moments';

const SLOTS: Array<{ key: SlotKey; title: string; who: string; fallback: string; accent: string }> = [
    { key: 'memory', title: '記憶副 API', who: '記憶整理、月度總結、門牌整理、Sore 預設用它、回覆草稿。便宜一點的模型就夠。', fallback: '沒設就不跑這些背景活兒（不會拿主 API 去跑）。', accent: 'emerald' },
    { key: 'meter', title: '情緒／日程 API', who: '情緒評估、意識流、日程生成（含行事曆的一週、批量、自動）、已讀不回判定。想細膩點就填好一點的模型。', fallback: '角色自己設了的照角色的；都沒設就用主 API。', accent: 'pink' },
    { key: 'amsg', title: '主動消息單獨 API', who: '主動消息到點生成（1.0 和 2.0 都是）。', fallback: '角色自己開了「使用副 API」的照角色的；都沒設就用角色的對話模型，再沒有用主 API。', accent: 'violet' },
    { key: 'moments', title: '朋友圈 API', who: '朋友圈的一切：自動發文、↻ 重整發文、查手機軌跡裡生成的貼文、大家來留言、角色回你的留言。', fallback: '設了就全部用它，連角色自己設了對話模型的也一樣；沒設就照舊用角色的對話模型（配角用自己的 API），再沒有用主 API。', accent: 'sky' },
];

const empty: SecondaryApi = { baseUrl: '', apiKey: '', model: '' };

const ChainButton: React.FC<{ count: number; cooling: boolean; onClick: () => void }> = ({ count, cooling, onClick }) => (
    <button type="button" onClick={onClick} className={`w-full flex items-center justify-between rounded-xl border px-3 py-2 text-[11px] font-bold ${count ? 'bg-white border-slate-200 text-slate-600' : 'bg-white/60 border-dashed border-slate-200 text-slate-400'}`}>
        <span>備援鏈{count ? `：${count} 個` : '：還沒排'}{cooling && <span className="ml-1.5 text-rose-500">· 現在用的剛掛過</span>}</span><span>▸</span>
    </button>
);

const SlotEditor: React.FC<{
    slot: typeof SLOTS[number];
    value: SecondaryApi | undefined;
    presets: ApiPreset[];
    onSave: (next: SecondaryApi | undefined) => void;
    chainCount: number;
    onChain: () => void;
}> = ({ slot, value, presets, onSave, chainCount, onChain }) => {
    const [draft, setDraft] = useState<SecondaryApi>(value || empty);
    const [dirty, setDirty] = useState(false);
    useEffect(() => { setDraft(value || empty); setDirty(false); }, [value?.baseUrl, value?.apiKey, value?.model]);
    const set = (patch: Partial<SecondaryApi>) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };
    const matched = presets.find(p => p.config.baseUrl === draft.baseUrl && p.config.apiKey === draft.apiKey && p.config.model === draft.model);
    const configured = isUsableSecondaryApi(value);
    const [pickOpen, setPickOpen] = useState(false);
    const [manualOpen, setManualOpen] = useState(false);
    // 手填的（不是任何一個預設）一定攤開，不然看不到自己填了什麼
    const manualShown = manualOpen || (!!draft.baseUrl.trim() && !matched);
    const input = 'w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all';
    const label = 'text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1';
    const tone = slot.accent === 'emerald' ? { chip: 'bg-emerald-100 border-emerald-200 text-emerald-700', text: 'text-emerald-600', bg: 'bg-emerald-50/60 border-emerald-100' }
        : slot.accent === 'pink' ? { chip: 'bg-pink-100 border-pink-200 text-pink-700', text: 'text-pink-600', bg: 'bg-pink-50/60 border-pink-100' }
        : slot.accent === 'sky' ? { chip: 'bg-sky-100 border-sky-200 text-sky-700', text: 'text-sky-600', bg: 'bg-sky-50/60 border-sky-100' }
        : { chip: 'bg-violet-100 border-violet-200 text-violet-700', text: 'text-violet-600', bg: 'bg-violet-50/60 border-violet-100' };
    return (
        <div className={`rounded-2xl border p-3.5 space-y-3 ${tone.bg}`} data-api-slot={slot.key}>
            <div className="flex items-start justify-between gap-2">
                <div>
                    <div className="text-xs font-bold text-slate-700">{slot.title}</div>
                    <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">{slot.who}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{slot.fallback}</p>
                </div>
                <span className={`shrink-0 text-[9px] font-bold px-2 py-1 rounded-full ${configured ? tone.chip : 'bg-slate-100 text-slate-400'}`}>{configured ? (matched ? matched.name : '已設') : '沒設'}</span>
            </div>
            {presets.length > 0 && (
                <div>
                    {/* 預設多的時候整排攤開太長：平常收起來只顯示選了哪個，點開才列（Liora 2026-11-24） */}
                    <button type="button" onClick={() => setPickOpen(o => !o)} aria-expanded={pickOpen}
                        className="w-full flex items-center justify-between gap-2 rounded-xl border border-slate-200/70 bg-white/70 px-3 py-2.5 text-left">
                        <span className="min-w-0">
                            <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">從我的預設選 · {presets.length} 個</span>
                            <span className={`block truncate text-[12px] font-bold ${matched ? tone.text : 'text-slate-400'}`}>
                                {matched ? `${matched.name}${matched.config.model ? ` · ${matched.config.model}` : ''}` : draft.baseUrl.trim() ? '手填的（不是預設）' : '還沒選'}
                            </span>
                        </span>
                        {pickOpen ? <CaretUp size={14} className="shrink-0 text-slate-400" /> : <CaretDown size={14} className="shrink-0 text-slate-400" />}
                    </button>
                    {pickOpen && (
                        <div className="mt-2 flex gap-2 flex-wrap" data-preset-list>
                            {presets.map(p => (
                                <button key={p.id} type="button" onClick={() => { set({ baseUrl: p.config.baseUrl, apiKey: p.config.apiKey, model: p.config.model }); setPickOpen(false); }}
                                    className={`max-w-full px-3 py-1.5 rounded-lg border text-[11px] font-medium truncate transition-colors ${matched?.id === p.id ? tone.chip : 'bg-white border-slate-200 text-slate-500'}`}
                                    title={`${p.name} · ${p.config.model || '未配置模型'}`}>{p.name}<span className="ml-1.5 text-slate-300">{p.config.model}</span></button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {/* 選的是預設時，URL／Key／Model 跟預設一樣，收起來；沒有預設或手填的才攤開 */}
            {presets.length > 0 && !manualShown ? (
                <button type="button" onClick={() => setManualOpen(true)} className="w-full flex items-center justify-between rounded-xl px-1 py-1 text-[11px] font-bold text-slate-400">
                    <span>手動填 URL／Key／Model</span><CaretDown size={12} />
                </button>
            ) : (
                <div className="space-y-2">
                    {presets.length > 0 && (
                        <button type="button" onClick={() => setManualOpen(false)} className="w-full flex items-center justify-between rounded-xl px-1 py-1 text-[11px] font-bold text-slate-400">
                            <span>手動填 URL／Key／Model</span><CaretUp size={12} />
                        </button>
                    )}
                    <div><label className={label}>URL</label><input value={draft.baseUrl} onChange={e => set({ baseUrl: e.target.value })} placeholder="https://.../v1" className={input} /></div>
                    <div><label className={label}>Key</label><input type="password" value={draft.apiKey} onChange={e => set({ apiKey: e.target.value })} placeholder="sk-..." className={input} /></div>
                    <div><label className={label}>Model</label><input value={draft.model} onChange={e => set({ model: e.target.value })} placeholder="模型名" className={input} /></div>
                </div>
            )}
            {draft.baseUrl.trim() && <ApiConnectionTest url={draft.baseUrl} apiKey={draft.apiKey} model={draft.model} />}
            <div className="flex gap-2">
                <button type="button" onClick={() => { onSave(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(), model: draft.model.trim() } : undefined); setDirty(false); }} disabled={!dirty}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${dirty ? 'bg-slate-800 text-white shadow-md active:scale-95' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}>{dirty ? '儲存' : '✓ 已儲存'}</button>
                {configured && <button type="button" onClick={() => { onSave(undefined); setDraft(empty); setDirty(false); }} className="px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-500">清掉</button>}
            </div>
            <ChainButton count={chainCount} cooling={!!value && apiCooldownMinutes(value) > 0} onClick={onChain} />
        </div>
    );
};

const ApiCenterPanel: React.FC = () => {
    const { apiConfig, updateApiConfig, apiPresets, memoryPalaceConfig, updateMemoryPalaceConfig } = useOS();
    const memory = memoryPalaceConfig.lightLLM;
    const values: Record<SlotKey, SecondaryApi | undefined> = {
        memory: memory?.baseUrl ? { baseUrl: memory.baseUrl, apiKey: memory.apiKey || '', model: memory.model || '' } : undefined,
        meter: apiConfig.meterApi,
        amsg: apiConfig.amsgApi,
        moments: apiConfig.momentsApi,
    };
    const [chainOf, setChainOf] = useState<FailoverSlot | null>(null);
    const chains = apiConfig.failoverChains || {};
    const saveChain = (slot: FailoverSlot, ids: string[]) => updateApiConfig({ failoverChains: { ...chains, [slot]: ids } });
    const mainApi = { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey };
    const save = (key: SlotKey, next: SecondaryApi | undefined) => {
        if (key === 'memory') updateMemoryPalaceConfig({ lightLLM: { baseUrl: next?.baseUrl || '', apiKey: next?.apiKey || '', model: next?.model || '' } });
        else if (key === 'meter') updateApiConfig({ meterApi: next });
        else if (key === 'amsg') updateApiConfig({ amsgApi: next });
        else updateApiConfig({ momentsApi: next });
    };
    return (
        <div className="space-y-3">
            <p className="text-[10px] text-slate-400 leading-relaxed px-1">四組「副 API」都在這裡填一次就好。每格可以從上面「API 配置」存的預設裡選，也能手填。角色頁裡自己設的照角色的。每格底下的「備援鏈」：主用的掛了就換下一家再發一次。</p>
            <div className="rounded-2xl border border-slate-200 bg-white/70 p-3.5 space-y-2" data-api-slot="chat">
                <div className="text-xs font-bold text-slate-700">主 API</div>
                <p className="text-[10px] text-slate-500 leading-relaxed">就是上面「API 配置」那組；這裡只排它的備援鏈。</p>
                <ChainButton count={(chains.chat || []).length} cooling={apiCooldownMinutes(mainApi) > 0} onClick={() => setChainOf('chat')} />
            </div>
            {SLOTS.map(slot => <SlotEditor key={slot.key} slot={slot} value={values[slot.key]} presets={apiPresets} onSave={next => save(slot.key, next)} chainCount={(chains[slot.key] || []).length} onChain={() => setChainOf(slot.key)} />)}
            <p className="text-[10px] text-slate-400 leading-relaxed px-1">雲端（主動消息 2.0 到點、即時對話、後台任務）用的是本機現在用的那家，到點掛了不會自己換下一家。</p>
            {chainOf && (
                <FailoverChainPage
                    slot={chainOf}
                    current={chainOf === 'chat' ? mainApi : values[chainOf] || null}
                    value={chains[chainOf] || []}
                    presets={apiPresets}
                    onSave={ids => saveChain(chainOf, ids)}
                    onClose={() => setChainOf(null)}
                />
            )}
        </div>
    );
};

export default ApiCenterPanel;
