import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOS } from '../../context/OSContext';
import { CaretLeft, FileArrowUp, Trash, Warning } from '@phosphor-icons/react';
import { DB } from '../../utils/db';
import { CC_CATEGORIES, labelOfCategory } from '../../utils/creatorCategories';
import { creatorPartToBlobRefs, loadCreatorPartsForRender } from '../../utils/creatorPartsBlob';
import type { CustomCreatorPart } from '../../types';
import type { ParsedPsdPart } from '../../utils/psdCreatorImport';

/**
 * 用戶側「自定義素材工坊」——掛在手辦櫃（ChibiStudio）裡，讓正式站用戶也能 PSD 批量導入
 * 自定義部件（dev 面板 CharCreatorDevApp 只在本地測試版可見，用戶夠不著）。
 * 部件存進 cc_custom_parts（Blob 令牌，省配額）；再進捏人器時經 loadCreatorPartsForRender 注入。
 */
const CreatorPartsUploader: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { addToast } = useOS();
    const [parts, setParts] = useState<CustomCreatorPart[]>([]);
    const [showRules, setShowRules] = useState(false);
    const [psdParsing, setPsdParsing] = useState(false);
    const [psdParts, setPsdParts] = useState<ParsedPsdPart[]>([]);
    const [psdWarnings, setPsdWarnings] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const psdRef = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        try { setParts(await loadCreatorPartsForRender()); } catch { /* ignore */ }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const onPsdFile = async (f: File | undefined) => {
        if (!f) return;
        setPsdParsing(true);
        setPsdParts([]); setPsdWarnings([]);
        try {
            const { parseCreatorPsd } = await import('../../utils/psdCreatorImport');
            const result = await parseCreatorPsd(await f.arrayBuffer());
            setPsdParts(result.parts);
            setPsdWarnings(result.warnings);
            if (!result.parts.length) addToast('沒解析出部件，看看「命名規則」裡的結構要求', 'error');
        } catch (err) {
            addToast('PSD 解析失敗：' + String((err as Error)?.message || err), 'error');
        } finally {
            setPsdParsing(false);
            if (psdRef.current) psdRef.current.value = '';
        }
    };

    const updatePsdPart = (idx: number, patch: Partial<ParsedPsdPart>) =>
        setPsdParts(prev => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

    const savePsdParts = async () => {
        const ready = psdParts.filter(p => p.categoryKey);
        if (!ready.length) { addToast('先給每個部件選好類目', 'error'); return; }
        if (ready.length < psdParts.length) { addToast('還有部件沒選類目', 'error'); return; }
        setBusy(true);
        try {
            for (const p of ready) {
                const part: CustomCreatorPart = {
                    id: `${p.categoryKey}_cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                    categoryKey: p.categoryKey!,
                    name: p.name || `自定義${labelOfCategory(p.categoryKey!)}`,
                    src: p.src,
                    tintable: p.tintable,
                    shadowSrc: p.shadowSrc,
                    createdAt: Date.now(),
                };
                await DB.saveCustomCreatorPart(await creatorPartToBlobRefs(part));
            }
            setPsdParts([]); setPsdWarnings([]);
            await load();
            addToast(`已加入 ${ready.length} 個部件，進捏人器就能用啦`, 'success');
        } catch (e) {
            addToast('保存失敗：' + String((e as Error)?.message || e), 'error');
        } finally {
            setBusy(false);
        }
    };

    const removePart = async (id: string) => {
        try { await DB.deleteCustomCreatorPart(id); await load(); addToast('已刪除', 'success'); }
        catch (e) { addToast('刪除失敗：' + String((e as Error)?.message || e), 'error'); }
    };

    // 按類目分組展示已有部件
    const grouped: Record<string, CustomCreatorPart[]> = {};
    parts.forEach(p => { (grouped[p.categoryKey] = grouped[p.categoryKey] || []).push(p); });

    return (
        <div className="fixed inset-0 z-[65] flex flex-col" style={{ background: 'linear-gradient(180deg, #241b3f 0%, #171130 55%, #120d24 100%)' }}>
            {/* 頂欄：全屏浮層統一用 --chrome-top（安全區 + SullyOS 狀態欄；狀態欄隱藏時自動塌回 --safe-top），
                與 ChibiStudio / 彼方 ChibiEditor 同一套約定，避免懟進狀態欄時鐘/電量條 */}
            <div className="shrink-0 px-4 pb-3 flex items-center gap-2 text-white" style={{ paddingTop: 'var(--chrome-top)' }}>
                <button onClick={onClose} className="p-2 -ml-2 rounded-full text-indigo-100 active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                <div>
                    <h2 className="font-serif text-lg font-bold tracking-wide leading-tight">自定義素材工坊</h2>
                    <p className="text-[10px] tracking-[3px] text-indigo-300/60">CUSTOM PARTS</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 space-y-4" style={{ paddingBottom: 'calc(2rem + var(--safe-bottom))' }}>
                {/* PSD 導入卡 */}
                <div className="rounded-2xl p-3.5 border border-white/10 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="text-[13px] font-bold text-white flex items-center gap-1.5">
                        <FileArrowUp size={15} weight="bold" className="text-amber-300" />
                        上傳 PSD，批量加自定義部件
                    </div>

                    <button onClick={() => setShowRules(v => !v)} className="text-[11px] font-bold text-amber-200/90 flex items-center gap-1 active:opacity-70">
                        {showRules ? '▾' : '▸'} PSD 怎麼做（命名規則）
                    </button>
                    {showRules && (
                        <div className="text-[10.5px] text-indigo-100/60 leading-relaxed space-y-2 rounded-xl bg-black/25 p-2.5 border border-white/10">
                            <div><b className="text-white/85">① 結構</b>：頂層<b>圖層組 = 一個類目</b>，<b>組內每個圖層 = 一個部件</b>。例：<code>眼睛</code> 組裡放「杏眼」「圓眼」各一層 → 兩個部件。</div>
                            <div>
                                <b className="text-white/85">② 組名 = 類目</b>（中英文都認）：
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {CC_CATEGORIES.map(c => (
                                        <span key={c.key} className="px-1.5 py-0.5 rounded bg-white/8 text-white/75">{c.label}<span className="text-white/35"> / {c.key}</span></span>
                                    ))}
                                </div>
                            </div>
                            <div><b className="text-white/85">③ 圖層名 = 部件名</b>；換色標記 <code>#色</code> / <code>#原色</code>（頭髮+眼睛默認可換色）。</div>
                            <div><b className="text-white/85">④ 顯示 / 隱藏</b>：要導入的圖層保持<b>顯示</b>，隱藏圖層會跳過；不透明度拉滿。</div>
                            <div><b className="text-white/85">⑤ 畫布</b> 472×472 正方形。識別不出類目也沒關係，下面能手動選。</div>
                        </div>
                    )}

                    <input ref={psdRef} type="file" accept=".psd" className="hidden" onChange={e => void onPsdFile(e.target.files?.[0])} />
                    <button onClick={() => psdRef.current?.click()} disabled={psdParsing || busy}
                        className="w-full rounded-xl border border-dashed border-white/30 py-3 text-[12px] text-indigo-100/70 active:bg-white/5 disabled:opacity-50">
                        {psdParsing ? '解析中…' : '選擇 .psd 文件'}
                    </button>

                    {psdWarnings.map((w, i) => (
                        <div key={i} className="text-[10px] text-amber-200/80 flex gap-1"><Warning size={12} className="shrink-0 mt-0.5" />{w}</div>
                    ))}

                    {psdParts.length > 0 && (
                        <div className="space-y-2">
                            {psdParts.map((p, idx) => (
                                <div key={idx} className="rounded-xl border border-white/10 p-2 flex gap-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
                                    <div className="w-14 h-14 shrink-0 rounded-lg overflow-hidden" style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 12px 12px' }}>
                                        <img src={p.src} alt={p.name} className="w-full h-full object-contain" />
                                    </div>
                                    <div className="flex-1 min-w-0 space-y-1.5">
                                        <div className="flex gap-1.5">
                                            <select value={p.categoryKey || ''} onChange={e => updatePsdPart(idx, { categoryKey: e.target.value || null })}
                                                className={`text-[10.5px] rounded px-1.5 py-1 bg-white/10 outline-none ${p.categoryKey ? 'text-white' : 'text-red-300 border border-red-400/50'}`}>
                                                <option value="">類目?</option>
                                                {CC_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                                            </select>
                                            <input value={p.name} onChange={e => updatePsdPart(idx, { name: e.target.value })}
                                                className="flex-1 min-w-0 text-[10.5px] rounded px-1.5 py-1 bg-white/10 text-white outline-none" />
                                        </div>
                                        <div className="flex items-center gap-2.5 text-[10px] text-indigo-100/70">
                                            <label className="flex items-center gap-1">
                                                <input type="checkbox" checked={p.tintable} onChange={e => updatePsdPart(idx, { tintable: e.target.checked })} className="accent-amber-400 w-3 h-3" />
                                                可換色
                                            </label>
                                            <button onClick={() => setPsdParts(prev => prev.filter((_, i) => i !== idx))} className="ml-auto text-red-300/80 active:text-red-300">移除</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <button onClick={() => void savePsdParts()} disabled={busy}
                                className="w-full rounded-xl py-2.5 text-[13px] font-bold text-black disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                                {busy ? '保存中…' : `全部加入（${psdParts.length}）`}
                            </button>
                        </div>
                    )}
                </div>

                {/* 已有自定義部件 */}
                <div className="space-y-2">
                    <div className="text-[12px] font-bold text-indigo-100/85 px-0.5">我的自定義部件{parts.length > 0 ? ` · ${parts.length}` : ''}</div>
                    {parts.length === 0 ? (
                        <p className="text-[11px] text-indigo-300/45 py-3 text-center">還沒有自定義部件。傳個 PSD 試試～</p>
                    ) : (
                        Object.keys(grouped).map(key => (
                            <div key={key}>
                                <div className="text-[10.5px] font-bold text-indigo-300/70 mb-1.5">{labelOfCategory(key)} · {grouped[key].length}</div>
                                <div className="grid grid-cols-4 gap-2">
                                    {grouped[key].map(p => (
                                        <div key={p.id} className="relative rounded-lg overflow-hidden border border-white/10 aspect-square flex items-center justify-center"
                                            style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 14px 14px' }}>
                                            <img src={p.src} alt={p.name} className="max-h-full max-w-full object-contain" />
                                            <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[8px] text-white/90 px-1 py-0.5 truncate">{p.name}{p.tintable ? ' ·色' : ''}</span>
                                            <button onClick={() => void removePart(p.id)} className="absolute top-1 right-1 bg-red-500/90 rounded-full p-1 active:scale-90 text-white"><Trash size={10} weight="bold" /></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                    <p className="text-[10px] text-indigo-300/45 leading-relaxed px-0.5 pt-1">
                        自定義部件會出現在<b className="text-indigo-200/70">捏人器</b>裡對應類目下（只你自己可見）。加/刪後重新進捏人器即可看到。
                    </p>
                </div>
            </div>
        </div>
    );
};

export default CreatorPartsUploader;
