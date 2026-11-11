import React, { useEffect, useRef, useState } from 'react';
import type { OSTheme } from '../../types';
import { DOCK_APPS, INSTALLED_APPS } from '../../constants';
import AppIcon from '../os/AppIcon';
import { useBlobRefUrl, putImageBlob } from '../../utils/blobRef';
import { processImageToBlob } from '../../utils/file';
import { DEFAULT_DOCK_CUSTOM, dockContainerLook, normalizeDockCustom, type DockCustomStyle, type DockStyleKind } from '../../utils/dockStyle';

/**
 * 外觀 → Dock：Liquid Glass（預設）／無膠囊／自訂。上面一直有預覽（用桌面同一個 dockContainerLook 畫）。
 * 自訂的滑桿先改在這裡，停一下才寫回主題，拖滑桿時不會每一格都存一次。
 */

const KINDS: Array<{ value: DockStyleKind; label: string; hint: string }> = [
    { value: 'glass', label: 'Liquid Glass', hint: '原本那條毛玻璃膠囊' },
    { value: 'none', label: '無膠囊', hint: '只有圖示，沒有底' },
    { value: 'custom', label: '自訂', hint: '底色、模糊、圓角、邊框、底圖' },
];

const Slider: React.FC<{ label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }> = ({ label, value, min, max, unit = '', onChange }) => (
    <label className="block">
        <div className="flex justify-between text-[11px] font-bold text-slate-500"><span>{label}</span><span className="tabular-nums text-slate-400">{value}{unit}</span></div>
        <input type="range" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} className="mt-1 w-full accent-primary" />
    </label>
);

const ColorRow: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
    <label className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-bold text-slate-500">{label}</span>
        <span className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-slate-400">{value}</span>
            <input type="color" value={value} onChange={e => onChange(e.target.value)} className="h-8 w-10 rounded border-0 bg-transparent" />
        </span>
    </label>
);

const DockStyleSettings: React.FC<{
    theme: OSTheme;
    updateTheme: (updates: Partial<OSTheme>) => void | Promise<void>;
    wallpaperCss: string;
    notify?: (message: string, type?: 'info' | 'error' | 'success') => void;
}> = ({ theme, updateTheme, wallpaperCss, notify }) => {
    const kind: DockStyleKind = theme.dockStyle || 'glass';
    const [custom, setCustom] = useState<DockCustomStyle>(() => normalizeDockCustom(theme.dockCustom));
    const pending = useRef<DockCustomStyle | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const imageUrl = useBlobRefUrl(custom.image);

    useEffect(() => { if (!pending.current) setCustom(normalizeDockCustom(theme.dockCustom)); }, [theme.dockCustom]);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); if (pending.current) void updateTheme({ dockCustom: pending.current }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const patchCustom = (patch: Partial<DockCustomStyle>, immediate = false) => {
        const next = { ...custom, ...patch };
        setCustom(next);
        pending.current = next;
        if (timer.current) clearTimeout(timer.current);
        const flush = () => { const value = pending.current; pending.current = null; timer.current = null; if (value) void updateTheme({ dockCustom: value }); };
        if (immediate) flush(); else timer.current = setTimeout(flush, 350);
    };

    const pickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const blob = await processImageToBlob(file, { maxWidth: 1200 });
            patchCustom({ image: await putImageBlob(blob) }, true);
        } catch (error: any) {
            notify?.(error?.message || '圖片沒存成', 'error');
        }
    };

    const acnh = theme.skin === 'animalcrossing';
    const look = dockContainerLook(kind, custom, { acnh, imageUrl });
    const dockIds = theme.launcherDockOrder?.length ? theme.launcherDockOrder : DOCK_APPS;
    const previewApps = dockIds.map(id => INSTALLED_APPS.find(app => app.id === id)).filter(Boolean).slice(0, 5) as typeof INSTALLED_APPS;

    return (
        <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">Dock</h2>
            <p className="text-[11px] text-slate-500 leading-relaxed mb-3">桌面最下面那條。裡面放哪些 app，在桌面長按進入整理，跟上面的 app 互相拖就能換（最多 5 個）。</p>

            <div className="relative overflow-hidden rounded-2xl px-3 pb-4 pt-16" style={{ background: wallpaperCss }} aria-label="Dock 預覽">
                <div className="absolute inset-0 bg-black/10" />
                <div className="relative flex justify-center">
                    <div className={`rounded-[1.75rem] px-4 py-3 flex gap-3 items-center ${look.className}`} style={look.style}>
                        {previewApps.map(app => <div key={app.id} className="pointer-events-none"><AppIcon app={app} onClick={() => {}} variant="dock" size="md" /></div>)}
                    </div>
                </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
                {KINDS.map(option => (
                    <button key={option.value} type="button" onClick={() => void updateTheme({ dockStyle: option.value })} aria-pressed={kind === option.value}
                        className={`rounded-2xl border px-2 py-2.5 text-left transition ${kind === option.value ? 'border-primary bg-primary/5' : 'border-slate-200 bg-slate-50'}`}>
                        <div className={`text-[12px] font-bold ${kind === option.value ? 'text-primary' : 'text-slate-700'}`}>{option.label}</div>
                        <div className="mt-0.5 text-[10px] leading-snug text-slate-400">{option.hint}</div>
                    </button>
                ))}
            </div>
            {acnh && kind === 'glass' && <p className="mt-2 text-[10px] text-slate-400">動森皮膚的 Dock 本來就沒有膠囊；選「自訂」就能自己做一條。</p>}

            {kind === 'custom' && (
                <div className="mt-4 space-y-3.5">
                    <ColorRow label="底色" value={custom.color} onChange={color => patchCustom({ color })} />
                    <Slider label="底色不透明度" value={custom.opacity} min={0} max={100} unit="%" onChange={opacity => patchCustom({ opacity })} />
                    <Slider label="背景模糊" value={custom.blur} min={0} max={40} unit="px" onChange={blur => patchCustom({ blur })} />
                    <Slider label="圓角" value={custom.radius} min={0} max={40} unit="px" onChange={radius => patchCustom({ radius })} />
                    <ColorRow label="邊框顏色" value={custom.borderColor} onChange={borderColor => patchCustom({ borderColor })} />
                    <Slider label="邊框粗細" value={custom.borderWidth} min={0} max={3} unit="px" onChange={borderWidth => patchCustom({ borderWidth })} />
                    <label className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-slate-500">陰影</span>
                        <input type="checkbox" checked={custom.shadow} onChange={e => patchCustom({ shadow: e.target.checked }, true)} className="h-5 w-5 accent-primary" />
                    </label>
                    <div className="flex items-center justify-between gap-3">
                        <span>
                            <span className="block text-[11px] font-bold text-slate-500">底圖</span>
                            <span className="block text-[10px] text-slate-400">有底圖時，上面的底色會疊在圖上（調低不透明度圖就更清楚）</span>
                        </span>
                        <span className="flex shrink-0 gap-1.5">
                            <button type="button" onClick={() => fileRef.current?.click()} className="rounded-full bg-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-600">{custom.image ? '換一張' : '選圖片'}</button>
                            {custom.image && <button type="button" onClick={() => patchCustom({ image: undefined }, true)} className="rounded-full px-2 py-1.5 text-[11px] font-bold text-red-400">拿掉</button>}
                        </span>
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickImage} />
                    <button type="button" onClick={() => patchCustom({ ...DEFAULT_DOCK_CUSTOM, image: custom.image }, true)} className="text-[11px] font-bold text-slate-400 underline-offset-2 hover:underline">重設成預設值</button>
                </div>
            )}
        </section>
    );
};

export default DockStyleSettings;
