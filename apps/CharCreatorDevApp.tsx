import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { ArrowLeft, UploadSimple, Trash, Wrench, Warning, FileArrowUp, MoonStars } from '@phosphor-icons/react';
import { DB } from '../utils/db';
import { creatorPartToBlobRefs, loadCreatorPartsForRender } from '../utils/creatorPartsBlob';
import { buildBuiltinPartsPackZip, type BuiltinPackItem } from '../utils/builtinPartsPack';
import { trackEvent } from '../utils/analytics';
import type { CustomCreatorPart } from '../types';
import type { ParsedPsdPart } from '../utils/psdCreatorImport';
import { shareOrDownloadBlob } from '../utils/shareExport';

// 與捏人器 character_creator.html 裡 PARTS 的 key 一一對應
const CC_CATEGORIES: { key: string; label: string; multi?: boolean }[] = [
    { key: 'skin', label: '膚色' },
    { key: 'eyes', label: '眼睛' },
    { key: 'mouth', label: '嘴' },
    { key: 'fronthair', label: '前發' },
    { key: 'earhair', label: '耳發' },
    { key: 'back1', label: '後發1' },
    { key: 'back2', label: '後發2' },
    { key: 'outfit', label: '衣服' },
    { key: 'outer', label: '外套' },
    { key: 'facemark', label: '面紋', multi: true },
    { key: 'decor', label: '配飾', multi: true },
];
const labelOf = (key: string) => CC_CATEGORIES.find(c => c.key === key)?.label || key;

const CharCreatorDevApp: React.FC = () => {
    const { closeApp, addToast } = useOS();
    const [parts, setParts] = useState<CustomCreatorPart[]>([]);
    const [categoryKey, setCategoryKey] = useState('fronthair');
    const [name, setName] = useState('');
    const [tintable, setTintable] = useState(false);
    const [src, setSrc] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    // PSD 整批導入
    const psdRef = useRef<HTMLInputElement>(null);
    const [psdParsing, setPsdParsing] = useState(false);
    const [psdParts, setPsdParts] = useState<ParsedPsdPart[]>([]);
    const [psdWarnings, setPsdWarnings] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true); // PSD 命名規則說明，默認展開給創作者看

    // 加載：解析成 base64 供 <img> 顯示，並把存量 base64 惰性遷移成 Blob 令牌落庫。
    const load = useCallback(async () => setParts(await loadCreatorPartsForRender()), []);
    useEffect(() => { void load(); }, [load]);

    const onFile = (f: File | undefined) => {
        if (!f) return;
        if (!/png|webp|image/.test(f.type)) { addToast?.('建議用透明 PNG', 'info'); }
        const reader = new FileReader();
        reader.onload = () => setSrc(String(reader.result || ''));
        reader.readAsDataURL(f);
    };

    const save = async () => {
        if (!src) { addToast?.('先選一張圖', 'error'); return; }
        const part: CustomCreatorPart = {
            id: `${categoryKey}_cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            categoryKey,
            name: name.trim() || `自定義${labelOf(categoryKey)}`,
            src,
            tintable,
            createdAt: Date.now(),
        };
        // 落庫前把 base64 src 轉成 Blob 令牌（省配額）
        await DB.saveCustomCreatorPart(await creatorPartToBlobRefs(part));
        setName(''); setSrc(''); setTintable(false);
        if (fileRef.current) fileRef.current.value = '';
        await load();
        trackEvent('单张追加部件', { category: categoryKey });
        addToast?.(`已加入「${labelOf(categoryKey)}」`, 'success');
    };

    const remove = async (id: string) => {
        await DB.deleteCustomCreatorPart(id);
        await load();
        addToast?.('已刪除', 'success');
    };

    // 導出「內置素材包」ZIP（parts/*.png 二進制 + parts.json 清單）——供管理員把部件作為
    // 內置素材隨包發給所有用戶，而不是每台設備各存 base64 / 把 base64 塞進 HTML 撐大體積。
    const [exporting, setExporting] = useState(false);
    const downloadPack = async (items: BuiltinPackItem[], hint: string) => {
        if (!items.length) { addToast?.('沒有可導出的部件', 'error'); return; }
        setExporting(true);
        try {
            const { blob, plan } = await buildBuiltinPartsPackZip(items);
            if (!plan.manifest.length) { addToast?.('沒有可導出的部件（都缺類目）', 'error'); return; }
            const result = await shareOrDownloadBlob({
                blob,
                fileName: `creator_builtin_parts_${hint}_${Date.now()}.zip`,
                shareTitle: '捏人器內置素材包',
            });
            if (result === 'cancelled') return;
            addToast?.(plan.skipped
                ? `已導出 ${plan.manifest.length} 個內置部件（跳過 ${plan.skipped} 個缺類目）`
                : `已導出 ${plan.manifest.length} 個內置部件`, 'success');
            trackEvent('导出内置素材包', { source: hint });
        } catch (e) {
            console.error('[CharCreatorDev] 導出內置素材包失敗', e);
            addToast?.('導出失敗：' + String((e as Error)?.message || e), 'error');
        } finally {
            setExporting(false);
        }
    };
    const toPackItem = (p: { categoryKey: string | null; name: string; src: string; shadowSrc?: string; tintable?: boolean }): BuiltinPackItem =>
        ({ categoryKey: p.categoryKey, name: p.name, src: p.src, shadowSrc: p.shadowSrc, tintable: p.tintable });

    const onPsdFile = async (f: File | undefined) => {
        if (!f) return;
        setPsdParsing(true);
        setPsdParts([]); setPsdWarnings([]);
        try {
            const { parseCreatorPsd } = await import('../utils/psdCreatorImport');
            const result = await parseCreatorPsd(await f.arrayBuffer());
            setPsdParts(result.parts);
            setPsdWarnings(result.warnings);
            if (!result.parts.length) addToast?.('沒解析出部件，檢查圖層組結構', 'error');
        } catch (err) {
            console.error('[CharCreatorDev] PSD 解析失敗', err);
            addToast?.('PSD 解析失敗：' + String((err as Error)?.message || err), 'error');
        } finally {
            setPsdParsing(false);
            if (psdRef.current) psdRef.current.value = '';
        }
    };

    const updatePsdPart = (idx: number, patch: Partial<ParsedPsdPart>) => {
        setPsdParts(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
    };

    const savePsdParts = async () => {
        const ready = psdParts.filter(p => p.categoryKey);
        if (ready.length < psdParts.length) { addToast?.('還有部件沒選類目', 'error'); return; }
        for (const p of ready) {
            const part: CustomCreatorPart = {
                id: `${p.categoryKey}_cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                categoryKey: p.categoryKey!,
                name: p.name || `自定義${labelOf(p.categoryKey!)}`,
                src: p.src,
                tintable: p.tintable,
                shadowSrc: p.shadowSrc,
                createdAt: Date.now(),
            };
            // PSD 批量導入：src / shadowSrc 的 base64 落庫前轉成 Blob 令牌
            await DB.saveCustomCreatorPart(await creatorPartToBlobRefs(part));
        }
        setPsdParts([]); setPsdWarnings([]);
        await load();
        trackEvent('批量加入 PSD 部件到捏人器');
        addToast?.(`已批量加入 ${ready.length} 個部件`, 'success');
    };

    const grouped = useMemo(() => {
        const m: Record<string, CustomCreatorPart[]> = {};
        for (const p of parts) (m[p.categoryKey] ||= []).push(p);
        return m;
    }, [parts]);

    return (
        <div className="h-full w-full flex flex-col text-white" style={{ background: 'linear-gradient(180deg,#1a1f2e 0%,#10131c 100%)' }}>
            <div className="flex items-center gap-2 px-4 pb-2 shrink-0" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
                <button onClick={closeApp} className="p-1.5 -ml-1.5 rounded-full active:bg-white/10"><ArrowLeft size={22} weight="bold" /></button>
                <Wrench size={18} weight="fill" className="text-amber-300" />
                <span className="text-lg font-bold">捏臉部件 · 開發</span>
                <span className="ml-auto text-[10px] text-white/40">{parts.length} 個自定義</span>
            </div>

            {/* CharCreatorDev 在 SELF_SAFE_AREA_APPS 名單裡（外殼不兜底），底部自己讓位 home 條 */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                {/* 提示 */}
                <div className="rounded-xl p-3 border border-amber-400/30 bg-amber-400/10 flex gap-2">
                    <Warning size={16} weight="fill" className="text-amber-300 mt-0.5 shrink-0" />
                    <div className="text-[10.5px] text-amber-100/90 leading-relaxed">
                        部件須是<b>透明背景 PNG</b>，且與捏人器畫布<b>同尺寸、同錨點</b>（整幅圖按位置疊層），否則會錯位。
                        新部件會注入到「特別時光」和「彼方」的捏人器裡——<b>下次打開捏人器</b>時生效。
                    </div>
                </div>

                {/* PSD 整批導入 */}
                <div className="rounded-xl p-3 border border-white/10 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="text-[12px] font-bold text-white/90 flex items-center gap-1.5">
                        <FileArrowUp size={14} weight="bold" className="text-amber-300" />
                        PSD 整批導入
                    </div>
                    <button onClick={() => setShowRules(v => !v)}
                        className="text-[10.5px] font-bold text-amber-200/90 flex items-center gap-1 active:opacity-70">
                        {showRules ? '▾' : '▸'} PSD 命名規則（給創作者看）
                    </button>
                    {showRules && (
                        <div className="text-[10px] text-white/55 leading-relaxed space-y-2 rounded-lg bg-black/25 p-2.5 border border-white/10">
                            <div>
                                <b className="text-white/85">① 結構</b>：頂層<b>圖層組 = 一個類目</b>，<b>組內每個圖層 = 一個部件</b>。<br />
                                例：<code>眼睛</code> 組裡放 <code>杏眼</code> / <code>圓眼</code> / <code>狐狸眼</code> 各一層 → 拆成三個眼睛部件。
                            </div>
                            <div>
                                <b className="text-white/85">② 組名 = 類目</b>（下面任一名字都認，中文英文都行）：
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {CC_CATEGORIES.map(c => (
                                        <span key={c.key} className="px-1.5 py-0.5 rounded bg-white/8 text-white/75">
                                            {c.label}<span className="text-white/35"> / {c.key}</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div><b className="text-white/85">③ 圖層名 = 部件顯示名</b>，隨便起（杏眼、雲朵劉海…）。</div>
                            <div><b className="text-white/85">④ 換色</b>：名字加 <code>#色</code> 強制可換色、<code>#原色</code> 強制不可換色；不寫時<b>頭髮四類 + 眼睛默認可換色</b>，其餘默認不可。</div>
                            <div><b className="text-white/85">⑤ 顯示 / 隱藏</b>：要導入的圖層<b>保持顯示</b>（小眼睛打開）；<b>隱藏的圖層會被跳過</b>——正好用來藏草稿/參考層。圖層不透明度記得拉滿 100%。</div>
                            <div><b className="text-white/85">⑥ 畫布</b>：<b>472×472</b> 正方形（過大會自動縮，只要錨點/構圖對齊即可）。</div>
                            <div className="text-white/40">認不出類目也沒關係，導進來後每個部件可在下面手動選類目。</div>
                        </div>
                    )}
                    <input ref={psdRef} type="file" accept=".psd" className="hidden" onChange={e => void onPsdFile(e.target.files?.[0])} />
                    <button onClick={() => { trackEvent('选择 PSD 文件批量导入'); psdRef.current?.click(); }} disabled={psdParsing}
                        className="w-full rounded-lg border border-dashed border-white/30 py-3 text-[11px] text-white/60 active:bg-white/5 disabled:opacity-50">
                        {psdParsing ? '解析中…' : '選擇 .psd 文件'}
                    </button>
                    {psdWarnings.map((w, i) => (
                        <div key={i} className="text-[10px] text-amber-200/80 flex gap-1"><Warning size={12} className="shrink-0 mt-0.5" />{w}</div>
                    ))}
                    {psdParts.length > 0 && (
                        <div className="space-y-2">
                            {psdParts.map((p, idx) => (
                                <div key={idx} className="rounded-lg border border-white/10 p-2 flex gap-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
                                    <div className="w-16 h-16 shrink-0 relative rounded overflow-hidden"
                                        style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 12px 12px' }}>
                                        {p.shadowSrc && <img src={p.shadowSrc} alt="" className="absolute inset-0 w-full h-full object-contain" />}
                                        <img src={p.src} alt={p.name} className="absolute inset-0 w-full h-full object-contain" />
                                    </div>
                                    <div className="flex-1 min-w-0 space-y-1">
                                        <div className="flex gap-1.5">
                                            <select value={p.categoryKey || ''} onChange={e => updatePsdPart(idx, { categoryKey: e.target.value || null })}
                                                className={`text-[10.5px] rounded px-1.5 py-1 bg-white/10 outline-none ${p.categoryKey ? 'text-white' : 'text-red-300 border border-red-400/50'}`}>
                                                <option value="">類目?</option>
                                                {CC_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                                            </select>
                                            <input value={p.name} onChange={e => updatePsdPart(idx, { name: e.target.value })}
                                                className="flex-1 min-w-0 text-[10.5px] rounded px-1.5 py-1 bg-white/10 text-white outline-none" />
                                        </div>
                                        <div className="flex items-center gap-2.5 text-[10px] text-white/70">
                                            <label className="flex items-center gap-1">
                                                <input type="checkbox" checked={p.tintable} onChange={e => updatePsdPart(idx, { tintable: e.target.checked })} className="accent-amber-400 w-3 h-3" />
                                                可換色
                                            </label>
                                            {p.shadowSrc && <span className="flex items-center gap-0.5 text-indigo-300"><MoonStars size={11} weight="fill" />投影</span>}
                                            <button onClick={() => setPsdParts(prev => prev.filter((_, i) => i !== idx))} className="ml-auto text-red-300/80 active:text-red-300">移除</button>
                                        </div>
                                        {p.warnings.map((w, i) => <div key={i} className="text-[9.5px] text-amber-200/70">{w}</div>)}
                                    </div>
                                </div>
                            ))}
                            <button onClick={() => void savePsdParts()}
                                className="w-full rounded-xl py-2.5 text-[13px] font-bold text-black" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                                全部加入捏人器（{psdParts.length}）
                            </button>
                            {/* 管理員：把這批 PSD 部件導出成「內置素材包」（PNG 文件 + 清單），可提交進倉庫當全員內置 */}
                            <button onClick={() => void downloadPack(psdParts.map(toPackItem), 'psd')} disabled={exporting}
                                className="w-full rounded-xl py-2.5 text-[12.5px] font-bold text-white/90 border border-white/20 active:bg-white/5 disabled:opacity-50 flex items-center justify-center gap-1.5">
                                <FileArrowUp size={15} weight="bold" />{exporting ? '打包中…' : '導出為內置素材包（PNG+清單）'}
                            </button>
                        </div>
                    )}
                </div>

                {/* 新增表單 */}
                <div className="rounded-xl p-3 border border-white/10 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="text-[12px] font-bold text-white/90">追加部件</div>
                    {/* 類目 */}
                    <div>
                        <div className="text-[10px] text-white/50 mb-1">類目</div>
                        <div className="flex flex-wrap gap-1.5">
                            {CC_CATEGORIES.map(c => (
                                <button key={c.key} onClick={() => setCategoryKey(c.key)}
                                    className={`text-[11px] rounded-full px-2.5 py-1 font-semibold ${categoryKey === c.key ? 'bg-amber-400 text-black' : 'bg-white/10 text-white/70'}`}>
                                    {c.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    {/* 圖片 */}
                    <input ref={fileRef} type="file" accept="image/png,image/webp,image/*" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
                    <button onClick={() => fileRef.current?.click()}
                        className="w-full rounded-lg border border-dashed border-white/30 py-6 flex flex-col items-center justify-center gap-1 active:bg-white/5">
                        {src ? (
                            <img src={src} alt="" className="max-h-28 object-contain" style={{ background: 'repeating-conic-gradient(#0003 0% 25%, transparent 0% 50%) 50% / 16px 16px' }} />
                        ) : (
                            <><UploadSimple size={20} weight="bold" className="text-white/60" /><span className="text-[11px] text-white/50">選擇部件圖（透明 PNG）</span></>
                        )}
                    </button>
                    {/* 名稱 + tintable */}
                    <input value={name} onChange={e => setName(e.target.value)} placeholder={`名稱（默認「自定義${labelOf(categoryKey)}」）`}
                        className="w-full rounded-lg bg-white/8 px-3 py-2 text-[13px] text-white placeholder-white/40 outline-none" />
                    <label className="flex items-center gap-2 text-[12px] text-white/80">
                        <input type="checkbox" checked={tintable} onChange={e => setTintable(e.target.checked)} className="accent-amber-400 w-4 h-4" />
                        可換色（tintable）—— 僅當這張圖是單色線稿/可著色層時勾選
                    </label>
                    <button onClick={save} disabled={!src}
                        className="w-full rounded-xl py-2.5 text-[13px] font-bold text-black disabled:opacity-40" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                        加入捏人器
                    </button>
                </div>

                {/* 已有列表 */}
                {parts.length > 0 && (
                    <button onClick={() => void downloadPack(parts.map(toPackItem), 'saved')} disabled={exporting}
                        className="w-full mb-2 rounded-xl py-2 text-[12px] font-bold text-white/90 border border-white/20 active:bg-white/5 disabled:opacity-50 flex items-center justify-center gap-1.5">
                        <FileArrowUp size={14} weight="bold" />{exporting ? '打包中…' : `把已有 ${parts.length} 個部件導出為內置素材包`}
                    </button>
                )}
                {parts.length === 0 ? (
                    <p className="text-[11px] text-white/40 py-4 text-center">還沒有自定義部件。</p>
                ) : (
                    <div className="space-y-3">
                        {Object.keys(grouped).map(key => (
                            <div key={key}>
                                <div className="text-[11px] font-bold text-white/60 mb-1.5">{labelOf(key)} · {grouped[key].length}</div>
                                <div className="grid grid-cols-3 gap-2">
                                    {grouped[key].map(p => (
                                        <div key={p.id} className="relative rounded-lg overflow-hidden border border-white/10 aspect-square flex items-center justify-center"
                                            style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 14px 14px' }}>
                                            <img src={p.src} alt={p.name} className="max-h-full max-w-full object-contain" />
                                            <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[8.5px] text-white/90 px-1 py-0.5 truncate">{p.name}{p.tintable ? ' ·色' : ''}{p.shadowSrc ? ' ·影' : ''}</span>
                                            <button onClick={() => remove(p.id)} className="absolute top-1 right-1 bg-red-500/90 rounded-full p-1 active:scale-90"><Trash size={11} weight="bold" /></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CharCreatorDevApp;
