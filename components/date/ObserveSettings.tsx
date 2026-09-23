import React, { useState, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, DateObservation, DateObserveConfig, DateObserveStyleId } from '../../types';
import { OBSERVE_DIMENSIONS } from '../../utils/datePrompts';
import ObserveHUD, { OBSERVE_STYLES } from './ObserveHUD';

/**
 * 見面設置裡的「觀測協議 OBSERVE」配置塊（默認摺疊）：
 *   - 總開關
 *   - HUD 樣式選擇（全息 / 水墨 / 霓虹 / 水晶 / 終端），帶實時預覽
 *   - 四個默認維度（時間/地點/狀態/細節）：啟用開關、HUD 顯示標籤、生成提示
 *   - 追加自定義維度（最多 6 個）：標籤 + 生成提示 + 啟用 + 刪除
 *   - 一鍵重置（樣式 + 全部字段自定義 + 自定義維度回默認）
 *
 * 所有改動即時寫回 char.dateObserve，下一條回覆 / 下次渲染生效。
 */

interface ObserveSettingsProps {
    char: CharacterProfile;
}

// 預覽用的示例觀測（不發請求，純展示樣式）
const SAMPLE: DateObservation = {
    time: '傍晚六點過，天剛擦黑',
    place: '便利店門口的塑料凳上',
    state: '有點疲憊，但見到你眼神亮了一下',
    detail: '指尖無意識地敲著關東煮的紙杯',
};

const MAX_CUSTOM = 6;
const genId = () => 'obs_' + Math.random().toString(36).slice(2, 9);

type FieldDraft = Record<string, { label: string; hint: string }>;

const buildFieldDraft = (char: CharacterProfile): FieldDraft => {
    const f = char.dateObserve?.fields || {};
    const d: FieldDraft = {};
    for (const dim of OBSERVE_DIMENSIONS) d[dim.key] = { label: f[dim.key]?.label || '', hint: f[dim.key]?.hint || '' };
    return d;
};
const buildCustomDraft = (char: CharacterProfile): FieldDraft => {
    const d: FieldDraft = {};
    for (const c of char.dateObserve?.custom || []) d[c.id] = { label: c.label || '', hint: c.hint || '' };
    return d;
};

const ObserveSettings: React.FC<ObserveSettingsProps> = ({ char }) => {
    const { updateCharacter, addToast } = useOS();
    const enabled = !!char.dateObserve?.enabled;
    const style = char.dateObserve?.style || 'hologram';
    const fields = char.dateObserve?.fields || {};
    const customs = char.dateObserve?.custom || [];

    const [open, setOpen] = useState(false); // 默認摺疊
    const [draft, setDraft] = useState<FieldDraft>(() => buildFieldDraft(char));
    const [customDraft, setCustomDraft] = useState<FieldDraft>(() => buildCustomDraft(char));
    useEffect(() => { setDraft(buildFieldDraft(char)); setCustomDraft(buildCustomDraft(char)); }, [char.id]);

    const patchObserve = (patch: Partial<DateObserveConfig>) =>
        updateCharacter(char.id, { dateObserve: { ...char.dateObserve, ...patch } });

    // —— 默認維度 ——
    const patchField = (key: keyof DateObservation, partial: Record<string, unknown>) =>
        patchObserve({ fields: { ...fields, [key]: { ...(fields[key] || {}), ...partial } } });
    const commitField = (key: keyof DateObservation, which: 'label' | 'hint') => {
        const v = (draft[key]?.[which] || '').trim();
        if (v === (fields[key]?.[which] || '')) return;
        patchField(key, { [which]: v || undefined });
    };

    // —— 自定義維度 ——
    const addCustom = () => {
        if (customs.length >= MAX_CUSTOM) { addToast(`最多 ${MAX_CUSTOM} 個自定義維度`, 'info'); return; }
        const id = genId();
        patchObserve({ custom: [...customs, { id, label: '', hint: '', enabled: true }] });
        setCustomDraft(d => ({ ...d, [id]: { label: '', hint: '' } }));
    };
    const delCustom = (id: string) => patchObserve({ custom: customs.filter(c => c.id !== id) });
    const toggleCustom = (id: string, on: boolean) => patchObserve({ custom: customs.map(c => c.id === id ? { ...c, enabled: on } : c) });
    const commitCustom = (id: string, which: 'label' | 'hint') => {
        const cur = customs.find(c => c.id === id);
        if (!cur) return;
        const v = (customDraft[id]?.[which] || '').trim();
        if (v === (cur[which] || '')) return;
        patchObserve({ custom: customs.map(c => c.id === id ? { ...c, [which]: which === 'label' ? v : (v || undefined) } : c) });
    };

    const resetAll = () => {
        updateCharacter(char.id, { dateObserve: { enabled: char.dateObserve?.enabled, style: undefined, fields: undefined, custom: undefined } });
        setDraft(buildFieldDraft({ ...char, dateObserve: { enabled } }));
        setCustomDraft({});
        addToast('觀測樣式與提示詞已重置為默認', 'success');
    };

    // 預覽：默認四維用示例文案，自定義維度塞佔位內容，讓樣式預覽也能看到追加的格子
    const previewObs: DateObservation = {
        ...SAMPLE,
        extra: Object.fromEntries(
            customs.filter(c => c.enabled !== false && (c.label || '').trim()).map(c => [c.id, '此處顯示生成的內容']),
        ),
    };

    return (
        <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-3.5">
                <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 min-w-0 text-left active:opacity-70">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3.5 h-3.5 text-slate-300 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" /></svg>
                    <div className="min-w-0">
                        <h3 className="text-xs font-bold text-slate-400 uppercase">觀測協議 · OBSERVE</h3>
                        <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed truncate">每條回覆附上 {char.name} 此刻的狀態，渲染成可獨立查看的觀測面板。{enabled ? '已開啟。' : '已關閉。'}</p>
                    </div>
                </button>
                <button
                    onClick={() => patchObserve({ enabled: !enabled })}
                    className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${enabled ? 'bg-primary' : 'bg-slate-200'}`}
                >
                    <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                </button>
            </div>

            {open && (
                !enabled ? (
                    <p className="px-4 pb-4 -mt-1 text-[11px] text-slate-400">先打開右上角開關，即可選擇面板樣式、自定義每格生成什麼、追加觀察維度。</p>
                ) : (
                <div className="px-4 pb-4 space-y-4">
                    {/* ── 樣式選擇 ── */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <h4 className="text-[11px] font-bold text-slate-500">面板樣式</h4>
                            <button onClick={resetAll} className="text-[10px] font-bold text-primary/80 hover:text-primary px-2 py-0.5 rounded-full bg-primary/5 active:scale-95 transition-transform">一鍵重置</button>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5">
                            {OBSERVE_STYLES.map(s => (
                                <button
                                    key={s.id}
                                    onClick={() => patchObserve({ style: s.id as DateObserveStyleId })}
                                    title={s.desc}
                                    className={`flex flex-col items-center gap-1 py-2 rounded-xl border transition-all active:scale-95 ${style === s.id ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-slate-200 hover:border-slate-300'}`}
                                >
                                    <span className="w-7 h-7 rounded-lg shadow-inner" style={{ background: s.swatch }} />
                                    <span className={`text-[10px] font-bold ${style === s.id ? 'text-primary' : 'text-slate-500'}`}>{s.name}</span>
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">{OBSERVE_STYLES.find(s => s.id === style)?.desc}</p>
                    </div>

                    {/* ── 實時預覽 ── */}
                    <div>
                        <h4 className="text-[11px] font-bold text-slate-500 mb-2">預覽</h4>
                        <div className="rounded-xl p-4 flex justify-center" style={{ background: style === 'ink' ? '#e9e0cd' : 'radial-gradient(circle at 30% 20%, #1e2433, #0a0d16)' }}>
                            <div className="w-full max-w-[260px]">
                                <ObserveHUD observation={previewObs} variant="card" charName={char.name} config={char.dateObserve} />
                            </div>
                        </div>
                    </div>

                    {/* ── 每個維度的提示詞與標籤自定義 ── */}
                    <div>
                        <h4 className="text-[11px] font-bold text-slate-500 mb-1">每個部分生成什麼（自定義提示詞）</h4>
                        <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">「顯示標籤」只改面板上的字樣；「生成提示」決定這一格讓 AI 寫什麼。留空即用默認。關掉的維度不會生成、面板上也不顯示。</p>
                        <div className="space-y-2.5">
                            {OBSERVE_DIMENSIONS.map(dim => {
                                const on = fields[dim.key]?.enabled !== false;
                                const defHint = dim.hint.replace(/\{name\}/g, char.name);
                                return (
                                    <div key={dim.key} className={`rounded-xl border p-2.5 transition-opacity ${on ? 'border-slate-200 bg-slate-50/60' : 'border-slate-100 bg-slate-50/30 opacity-60'}`}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5"><span className="text-slate-400">{dim.glyph}</span>{dim.label}</span>
                                            <button
                                                onClick={() => patchField(dim.key, { enabled: !on })}
                                                className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-primary' : 'bg-slate-300'}`}
                                            >
                                                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}></div>
                                            </button>
                                        </div>
                                        {on && (
                                            <div className="space-y-1.5">
                                                <input
                                                    value={draft[dim.key]?.label || ''}
                                                    onChange={e => setDraft(d => ({ ...d, [dim.key]: { ...d[dim.key], label: e.target.value } }))}
                                                    onBlur={() => commitField(dim.key, 'label')}
                                                    placeholder={`顯示標籤（默認「${dim.label}」）`}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white"
                                                />
                                                <textarea
                                                    value={draft[dim.key]?.hint || ''}
                                                    onChange={e => setDraft(d => ({ ...d, [dim.key]: { ...d[dim.key], hint: e.target.value } }))}
                                                    onBlur={() => commitField(dim.key, 'hint')}
                                                    placeholder={`生成提示（默認：${defHint}）`}
                                                    rows={2}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white leading-relaxed resize-none"
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── 追加自定義維度 ── */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <h4 className="text-[11px] font-bold text-slate-500">追加維度</h4>
                            <button
                                onClick={addCustom}
                                disabled={customs.length >= MAX_CUSTOM}
                                className="text-[10px] font-bold text-primary px-2.5 py-1 rounded-full bg-primary/5 hover:bg-primary/10 disabled:opacity-40 active:scale-95 transition-all"
                            >+ 添加（{customs.length}/{MAX_CUSTOM}）</button>
                        </div>
                        <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">在四個默認維度之外，自己開觀察項（如「穿著」「天氣」「和你的距離」）。標籤同時用於 AI 輸出與面板顯示。</p>
                        {customs.length === 0 ? (
                            <div className="text-[11px] text-slate-300 text-center py-3 border border-dashed border-slate-200 rounded-xl">還沒有自定義維度，點「+ 添加」開一格</div>
                        ) : (
                            <div className="space-y-2.5">
                                {customs.map(c => {
                                    const on = c.enabled !== false;
                                    return (
                                        <div key={c.id} className={`rounded-xl border p-2.5 transition-opacity ${on ? 'border-slate-200 bg-slate-50/60' : 'border-slate-100 bg-slate-50/30 opacity-60'}`}>
                                            <div className="flex items-center gap-2 mb-2">
                                                <input
                                                    value={customDraft[c.id]?.label || ''}
                                                    onChange={e => setCustomDraft(d => ({ ...d, [c.id]: { ...d[c.id], label: e.target.value } }))}
                                                    onBlur={() => commitCustom(c.id, 'label')}
                                                    placeholder="維度名（如 穿著 / 天氣）"
                                                    className="flex-1 min-w-0 text-[12px] font-bold px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white"
                                                />
                                                <button
                                                    onClick={() => toggleCustom(c.id, !on)}
                                                    className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-primary' : 'bg-slate-300'}`}
                                                >
                                                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}></div>
                                                </button>
                                                <button onClick={() => delCustom(c.id)} title="刪除" className="text-slate-300 hover:text-red-400 transition-colors shrink-0 p-0.5">
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                            {on && (
                                                <textarea
                                                    value={customDraft[c.id]?.hint || ''}
                                                    onChange={e => setCustomDraft(d => ({ ...d, [c.id]: { ...d[c.id], hint: e.target.value } }))}
                                                    onBlur={() => commitCustom(c.id, 'hint')}
                                                    placeholder="生成提示：這一格讓 AI 寫什麼（留空給個通用默認）"
                                                    rows={2}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white leading-relaxed resize-none"
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                )
            )}
        </section>
    );
};

export default ObserveSettings;
