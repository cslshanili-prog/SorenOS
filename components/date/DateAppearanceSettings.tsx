import React, { useEffect, useMemo, useState } from 'react';
import type { CharacterProfile, DateAppearance, DateLineColors } from '../../types';
import TokenImg from '../os/TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';
import {
    buildDateAppearanceCss, DATE_CSS_HOOKS, DATE_CUSTOM_CSS_MAX, DATE_DEFAULT_DIM, DATE_FONT_SIZE,
    DATE_NATIVE_COLORS, resolveDateBackdrop, resolveDateColors, resolveDateFontSize, scopeDateCss,
} from '../../utils/dateAppearance';

// 見面設定的「畫面美化」：底圖＋遮罩、字級、字色（深淺各一套）、裝飾卡片底色、自訂 CSS。
// 上面有一塊小預覽，跟見面畫面用同一套 class，自訂 CSS 也套得上。

interface Props {
    char: CharacterProfile;
    updateCharacter: (id: string, patch: Partial<CharacterProfile>) => void;
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    onPickBackground: () => void;
}

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
    <div className="py-3 first:pt-0">
        <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-500 font-bold">{label}</span>
            {children}
        </div>
        {hint && <p className="text-[10px] text-slate-300 mt-1 leading-relaxed">{hint}</p>}
    </div>
);

const Switch: React.FC<{ on: boolean; label: string; onChange: (next: boolean) => void }> = ({ on, label, onChange }) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
        className={`w-11 h-6 shrink-0 rounded-full transition-colors relative ${on ? 'bg-primary' : 'bg-slate-200'}`}>
        <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
);

const DateAppearanceSettings: React.FC<Props> = ({ char, updateCharacter, addToast, onPickBackground }) => {
    const appearance = char.dateAppearance || {};
    const light = !!char.dateLightReading;
    const theme: 'light' | 'dark' = light ? 'light' : 'dark';
    const patch = (next: Partial<DateAppearance>) => {
        const merged: DateAppearance = { ...(char.dateAppearance || {}), ...next };
        (Object.keys(merged) as (keyof DateAppearance)[]).forEach(key => { if (merged[key] === undefined) delete merged[key]; });
        updateCharacter(char.id, { dateAppearance: Object.keys(merged).length ? merged : undefined });
    };

    const [cssDraft, setCssDraft] = useState(appearance.customCss || '');
    const [showHooks, setShowHooks] = useState(false);
    useEffect(() => { setCssDraft(char.dateAppearance?.customCss || ''); }, [char.id]);
    const saveCss = () => {
        const next = cssDraft.trim();
        if (next === (char.dateAppearance?.customCss || '')) return;
        if (next.length > DATE_CUSTOM_CSS_MAX) { addToast(`CSS 太長了（上限 ${DATE_CUSTOM_CSS_MAX.toLocaleString()} 字）`, 'error'); return; }
        patch({ customCss: next || undefined });
        addToast(next ? '自訂 CSS 已套用' : '自訂 CSS 已清空', 'success');
    };

    const dim = appearance.backgroundDim;
    const dimShown = dim ?? DATE_DEFAULT_DIM[theme];
    const fontSize = resolveDateFontSize(appearance) ?? DATE_FONT_SIZE.default;
    const colors = resolveDateColors(appearance, light);
    const setColor = (key: keyof DateLineColors, value: string | undefined) => {
        const current = { ...(char.dateAppearance?.colors?.[theme] || {}), [key]: value };
        if (!current.dialogue) delete current.dialogue;
        if (!current.narration) delete current.narration;
        const all = { ...(char.dateAppearance?.colors || {}), [theme]: Object.keys(current).length ? current : undefined };
        if (!all.light) delete all.light;
        if (!all.dark) delete all.dark;
        patch({ colors: Object.keys(all).length ? all : undefined });
    };

    // 預覽：草稿裡的 CSS 也套上，不用先存
    const previewAppearance = useMemo(() => ({ ...appearance, customCss: cssDraft }), [appearance, cssDraft]);
    const previewCss = useMemo(
        () => [buildDateAppearanceCss(previewAppearance, light), scopeDateCss(previewAppearance.customCss)].filter(Boolean).join('\n'),
        [previewAppearance, light],
    );
    const backdrop = resolveDateBackdrop(appearance, light);
    const bgUrl = useBlobRefUrl(char.dateBackground || '');

    return (
        <div>
            {/* 預覽 */}
            {previewCss && <style>{previewCss}</style>}
            <div className={`date-root ${light ? 'date-theme-light' : 'date-theme-dark'} relative overflow-hidden rounded-xl mb-4 ${light ? 'bg-[#faf8f5]' : 'bg-black'}`} aria-label="畫面預覽" data-date-appearance-preview>
                <div className={`date-background absolute inset-0 bg-cover bg-center ${backdrop.backgroundBlur ? 'blur-md' : ''}`} style={{ backgroundImage: bgUrl ? `url(${bgUrl})` : 'none', opacity: backdrop.backgroundOpacity }} />
                <div className={`date-reading relative px-5 py-5 ${backdrop.overlayColor ? '' : light ? 'bg-[#faf8f5]/90' : 'bg-black/80'}`} style={backdrop.overlayColor ? { backgroundColor: backdrop.overlayColor } : undefined}>
                    <div className="date-message date-message-ai">
                        <p className={`date-line date-line-narration whitespace-pre-wrap font-serif text-[18px] leading-loose tracking-wide pl-4 border-l-2 mb-2 ${light ? 'border-stone-200 text-stone-500' : 'border-white/10 text-slate-400'}`}>{char.name}把傘收起來，雨水順著傘骨滴到腳邊。</p>
                        <p className={`date-line date-line-dialogue whitespace-pre-wrap font-serif text-[18px] leading-loose tracking-wide pl-4 border-l-2 ${light ? 'border-stone-200 text-stone-800' : 'border-white/10 text-slate-100'}`}>「你又遲到了。」</p>
                    </div>
                    <div className="date-message date-message-user mt-3">
                        <p className={`date-line-user whitespace-pre-wrap font-serif text-[16px] text-right leading-loose tracking-wide italic pr-4 border-r-2 ${light ? 'text-stone-400 border-stone-300/50' : 'text-slate-400 border-slate-600/50'}`}>「路上塞車嘛。」</p>
                    </div>
                </div>
            </div>
            <p className="text-[10px] text-slate-300 -mt-2 mb-3">現在是{light ? '淺色' : '深色'}閱讀模式（在上面切換）；字色兩套各記各的。</p>

            <div className="divide-y divide-slate-100">
                <Row label="底圖">
                    <div className="flex items-center gap-2">
                        {char.dateBackground && (
                            <button onClick={() => updateCharacter(char.id, { dateBackground: undefined })} className="text-[11px] text-slate-400 hover:text-red-400">移除</button>
                        )}
                        <button onClick={onPickBackground} className="flex items-center gap-2 px-2 py-1 rounded-lg border border-slate-200 bg-slate-50 active:scale-95">
                            {char.dateBackground
                                ? <TokenImg value={char.dateBackground} className="w-10 h-6 rounded object-cover" />
                                : null}
                            <span className="text-xs font-bold text-slate-600">{char.dateBackground ? '更換' : '+ 上傳'}</span>
                        </button>
                    </div>
                </Row>

                <Row label="遮罩濃度" hint={dim === undefined ? '目前是原本的樣子：底圖淡淡糊在後面。拉一下就改成清楚的底圖＋這層遮罩。' : '越高底圖越暗（淺色模式是越白），字越好讀。'}>
                    <div className="flex items-center gap-2">
                        <input type="range" min={0} max={100} step={5} value={dimShown} aria-label="遮罩濃度"
                            onChange={e => patch({ backgroundDim: Number(e.target.value) })} className="w-28 accent-primary" />
                        <span className="w-9 text-right text-xs text-slate-500 tabular-nums">{dimShown}%</span>
                        {dim !== undefined && <button onClick={() => patch({ backgroundDim: undefined, backgroundBlur: undefined })} className="text-[11px] text-slate-400">還原</button>}
                    </div>
                </Row>

                {dim !== undefined && (
                    <Row label="底圖模糊">
                        <Switch on={appearance.backgroundBlur !== false} label="底圖模糊" onChange={on => patch({ backgroundBlur: on ? undefined : false })} />
                    </Row>
                )}

                <Row label="字級">
                    <div className="flex items-center gap-2">
                        <input type="range" min={DATE_FONT_SIZE.min} max={DATE_FONT_SIZE.max} step={1} value={fontSize} aria-label="字級"
                            onChange={e => { const v = Number(e.target.value); patch({ fontSize: v === DATE_FONT_SIZE.default ? undefined : v }); }} className="w-28 accent-primary" />
                        <span className="w-9 text-right text-xs text-slate-500 tabular-nums">{fontSize}px</span>
                    </div>
                </Row>

                {(['dialogue', 'narration'] as const).map(key => (
                    <Row key={key} label={key === 'dialogue' ? `台詞字色（${light ? '淺色' : '深色'}）` : `旁白字色（${light ? '淺色' : '深色'}）`}>
                        <div className="flex items-center gap-2">
                            {colors[key] && <button onClick={() => setColor(key, undefined)} className="text-[11px] text-slate-400">還原</button>}
                            <input type="color" value={colors[key] || DATE_NATIVE_COLORS[theme][key]} aria-label={key === 'dialogue' ? '台詞字色' : '旁白字色'}
                                onChange={e => setColor(key, e.target.value)} className="w-9 h-7 rounded border border-slate-200 bg-white p-0.5 cursor-pointer" />
                        </div>
                    </Row>
                ))}

                {light && (
                    <Row label="裝飾卡片墊深色底" hint="預設裡的標題、摘要卡片多半照 ST 深色主題做，淺底上字會變淡；開了就在卡片後面墊一塊深色。">
                        <Switch on={appearance.decorationDarkCard === true} label="裝飾卡片墊深色底" onChange={on => patch({ decorationDarkCard: on || undefined })} />
                    </Row>
                )}

                <div className="pt-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] text-slate-500 font-bold">自訂 CSS</span>
                        <button onClick={() => setShowHooks(v => !v)} className="text-[11px] text-primary font-bold">{showHooks ? '收起可用 class' : '可用 class'}</button>
                    </div>
                    {showHooks && (
                        <ul className="mb-2 rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 space-y-1">
                            {DATE_CSS_HOOKS.map(hook => (
                                <li key={hook.selector} className="text-[11px] leading-relaxed"><code className="text-slate-600">{hook.selector}</code><span className="text-slate-400"> — {hook.label}</span></li>
                            ))}
                        </ul>
                    )}
                    <textarea value={cssDraft} onChange={e => setCssDraft(e.target.value)} onBlur={saveCss} rows={6} spellCheck={false}
                        placeholder={'.date-line-dialogue { color: #c2410c; }\n.date-reading { background: rgba(20, 10, 30, .7) !important; }'}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-xs text-slate-700 leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y" />
                    <p className="text-[10px] text-slate-300 mt-1 leading-relaxed">只管見面畫面，每條規則會自動加上 .date-root，寫 body、:root 也只作用在見面裡。點別處就套用；要蓋原本的底色、遮罩加 !important。裝飾卡片裡面是獨立頁面，這裡管不到。</p>
                </div>
            </div>
        </div>
    );
};

export default DateAppearanceSettings;
