
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useOS, DEFAULT_WALLPAPER, DEFAULT_PAPER_APPEARANCE, NOSTALGIA_APPEARANCE } from '../context/OSContext';
import { AppID, OSTheme, DesktopDecoration, AppearancePreset, Toast } from '../types';
import { INSTALLED_APPS, Icons } from '../constants';
import { processImage, processImageToBlob } from '../utils/file';
import { deleteBlobRef, putImageBlob, useBlobRefUrl } from '../utils/blobRef';
import TokenImg from '../components/os/TokenImg';
import {
    companionAvatarSource,
    companionSkinSetPatchValue,
    hasDatePortraits,
    listCompanionDateOutfits,
    normalizeCompanionSkinSetId,
} from '../utils/companionAvatar';
import { DB } from '../utils/db';
import { resolveStatusBarMode, type StatusBarMode } from '../utils/iosStandalone';
import { confirmExportSafety } from '../utils/exportGuard';
import { trackEvent } from '../utils/analytics';
import { Check, ImageSquare, Sparkle, Trash, UploadSimple } from '@phosphor-icons/react';
import ChatDecorationAnnouncement from '../components/chat/ChatDecorationAnnouncement';
import AppIconEditor from '../components/appearance/AppIconEditor';
import BootAnimationSettings from '../components/appearance/BootAnimationSettings';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { readShareFile } from '../utils/pngShare';

const CustomIconImage: React.FC<{ value: string; alt: string; preserveOutline?: boolean }> = ({ value, alt, preserveOutline = false }) => {
    const url = useBlobRefUrl(value);
    return url ? <img src={url} className={`w-full h-full ${preserveOutline ? 'object-contain' : 'object-cover rounded-2xl'}`} alt={alt} /> : null;
};

const CompanionPortraitPreview: React.FC<{ value?: string; alt: string }> = ({ value, alt }) => {
    const url = useBlobRefUrl(value);
    return url ? <img src={url} className="h-full w-full object-contain" alt={alt} /> : <ImageSquare size={28} className="text-slate-300" />;
};

/**
 * 這個令牌還掛在衣櫃裡嗎？
 *
 * 桌面靜態形象的令牌是「頂層 imageRef 指著現在穿的那套，衣櫃裡同時留著一條同令牌的條目」
 * （utils/companionWardrobe.ts 拿令牌當條目 id 認親，id 與 imageRef 兩個值位同值）。
 * 所以換圖 / 移除時不能無條件刪舊 Blob——衣櫃裡還留著的話，那套舊衣服就再也切不回去了。
 */
const isCompanionOutfitKeptInWardrobe = (
    companionAvatar: { imageWardrobe?: unknown } | undefined,
    ref: string,
): boolean => {
    const wardrobe = companionAvatar?.imageWardrobe;
    if (!Array.isArray(wardrobe)) return false;
    return wardrobe.some((outfit: any) => outfit?.imageRef === ref || outfit?.id === ref);
};

// Touch-friendly long-press wrapper. `onContextMenu` alone misses iOS Safari /
// Capacitor WebView, so we also wire pointer/touch timers to fire after ~550ms.
// When a long-press fires, the subsequent click is suppressed.
const LongPressArea: React.FC<{
    onLongPress: () => void;
    onClick?: () => void;
    delay?: number;
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
}> = ({ onLongPress, onClick, delay = 550, className, style, children }) => {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fired = useRef(false);
    const startPos = useRef<{ x: number; y: number } | null>(null);

    const clear = useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        startPos.current = null;
    }, []);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const start = (x: number, y: number) => {
        fired.current = false;
        startPos.current = { x, y };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            fired.current = true;
            onLongPress();
        }, delay);
    };
    const move = (x: number, y: number) => {
        const sp = startPos.current;
        if (!sp) return;
        if (Math.hypot(x - sp.x, y - sp.y) > 8) clear();
    };

    return (
        <div
            className={className}
            style={style}
            onContextMenu={(e) => { e.preventDefault(); onLongPress(); }}
            onTouchStart={(e) => { const t = e.touches[0]; if (t) start(t.clientX, t.clientY); }}
            onTouchMove={(e) => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY); }}
            onTouchEnd={clear}
            onTouchCancel={clear}
            onPointerDown={(e) => { if (e.pointerType !== 'touch') start(e.clientX, e.clientY); }}
            onPointerMove={(e) => { if (e.pointerType !== 'touch') move(e.clientX, e.clientY); }}
            onPointerUp={clear}
            onPointerLeave={clear}
            onPointerCancel={clear}
            onClick={() => {
                if (fired.current) { fired.current = false; return; }
                onClick?.();
            }}
        >
            {children}
        </div>
    );
};

const TwemojiImg: React.FC<{ code: string; alt?: string; className?: string }> = ({ code, alt, className = 'w-4 h-4 inline-block' }) => (
  <img src={`https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${code}.png`} alt={alt || ''} className={className} draggable={false} />
);

const CATEGORY_LABELS: Record<string, { code: string; label: string }> = {
  'stars': { code: '2728', label: 'Stars' },
  'hearts': { code: '1f496', label: 'Hearts' },
  'flowers': { code: '1f338', label: 'Flowers' },
  'ribbons': { code: '1f380', label: 'Ribbons' },
  'animals': { code: '1f431', label: 'Animals' },
  'shapes': { code: '1f52e', label: 'Shapes' },
  'badges': { code: '1f3f7', label: 'Badges' },
};


// --- 桌面整機風格（皮膚）---
// 動森壁紙：NookPhone 同款奶油底（#F8F4E8），底部極淡草色透氣。純 CSS 漸變，讓彩色圖標平鋪更跳。
const ACNH_WALLPAPER = 'linear-gradient(180deg, #F8F4E8 0%, #F3EFDD 58%, #E6EECE 100%)';
// 手遊主題壁紙：近白底 + 極淡薰衣草/粉光暈（照搬原創參考圖，整體偏白不發紫）。
const MOBILEGAME_WALLPAPER = 'radial-gradient(95% 55% at 85% 0%, #fdeef7 0%, transparent 50%), radial-gradient(85% 55% at 6% 10%, #f6f2fc 0%, transparent 55%), linear-gradient(180deg, #fdfbff 0%, #f9f6fd 55%, #f4f0fa 100%)';
// 電子寵物主題壁紙：薰衣草奶油（照抄參考稿——柔紫底襯奶油卡片與紫描邊）。
const TAMAGOTCHI_WALLPAPER = 'radial-gradient(85% 50% at 80% 0%, #e6dcf8 0%, transparent 55%), radial-gradient(75% 45% at 12% 10%, #f4edfb 0%, transparent 55%), linear-gradient(180deg, #ded4f4 0%, #d6cbf0 55%, #cfc3ec 100%)';
const COMPANION_WALLPAPER = 'radial-gradient(90% 65% at 50% 5%, #6c5a91 0%, transparent 62%), radial-gradient(75% 55% at 100% 50%, #382e5b 0%, transparent 72%), linear-gradient(180deg, #211a36 0%, #100d1c 62%, #080711 100%)';

type DesktopSkinOption = { id: string; name: string; desc: string; swatch: string; config: Partial<OSTheme> };

const DESKTOP_SKINS: DesktopSkinOption[] = [
  {
    id: 'animalcrossing',
    name: '動森風格',
    desc: 'NookPhone 彩色圖標 · 草地天空 · 暖色界面',
    swatch: 'linear-gradient(135deg,#BCE7F5 0%,#BBE38F 55%,#7CBA4C 100%)',
    config: {
      skin: 'animalcrossing',
      desktopVariant: 'paper',
      hue: 95, saturation: 48, lightness: 56,
      contentColor: '#725d42',
      wallpaper: ACNH_WALLPAPER,
      chatAvatarShape: 'rounded', chatAvatarSize: 'medium',
      chatBubbleStyle: 'modern', chatMessageSpacing: 'spacious',
      chatHeaderStyle: 'default', chatInputStyle: 'rounded',
      chatChromeStyle: 'soft', chatBackgroundStyle: 'paper',
      chatShowTimestamp: 'always',
    },
  },
  {
    id: 'mobilegame',
    name: '手遊風格',
    desc: '夢幻粉紫二次元手遊首頁 · 星芒滿屏 · 圓潤可愛',
    swatch: 'linear-gradient(135deg,#f7d9ec 0%,#d9d4f5 55%,#a8b8e8 100%)',
    config: {
      skin: 'mobilegame',
      desktopVariant: 'paper',
      hue: 270, saturation: 45, lightness: 70,
      contentColor: '#6b5b95',
      wallpaper: MOBILEGAME_WALLPAPER,
      chatAvatarShape: 'circle', chatAvatarSize: 'medium',
      chatBubbleStyle: 'modern', chatMessageSpacing: 'default',
      chatHeaderStyle: 'gradient', chatInputStyle: 'rounded',
      chatChromeStyle: 'soft', chatBackgroundStyle: 'paper',
      chatShowTimestamp: 'always',
    },
  },
  {
    id: 'tamagotchi',
    name: '電子寵物 · 小小窩',
    desc: '桌面就是一台養成機 · 角色住在自己的小屋裡 · 薰衣草奶油',
    swatch: 'linear-gradient(135deg,#ded4f4 0%,#fdf9f2 52%,#f2a7bb 100%)',
    config: {
      skin: 'tamagotchi',
      desktopVariant: 'paper',
      hue: 258, saturation: 42, lightness: 66,
      contentColor: '#7a6cb8',
      wallpaper: TAMAGOTCHI_WALLPAPER,
      chatAvatarShape: 'rounded', chatAvatarSize: 'medium',
      chatBubbleStyle: 'modern', chatMessageSpacing: 'default',
      chatHeaderStyle: 'default', chatInputStyle: 'rounded',
      chatChromeStyle: 'soft', chatBackgroundStyle: 'paper',
      chatShowTimestamp: 'always',
    },
  },
  {
    id: 'companion',
    name: '觸感陪伴',
    desc: '角色佔據桌面 · 一次生成反饋包 · 輕觸後本地輪播演出',
    swatch: 'radial-gradient(circle at 50% 25%,#a993d3 0%,#51436f 42%,#171222 100%)',
    config: {
      skin: 'companion',
      hue: 267, saturation: 46, lightness: 64,
      contentColor: '#f6efff',
      wallpaper: COMPANION_WALLPAPER,
    },
  },
  {
    id: 'default',
    name: '默認風格',
    desc: '暖米白紙感桌面 · 低對比柔和配色',
    swatch: DEFAULT_WALLPAPER,
    config: {
      skin: 'default',
      ...DEFAULT_PAPER_APPEARANCE,
      wallpaper: DEFAULT_WALLPAPER,
    },
  },
];

const NOSTALGIA_SKIN: DesktopSkinOption = {
  id: 'nostalgia',
  name: '懷舊版',
  desc: '最初粉綠漸變 · 白色玻璃卡片、圖標底與 Dock · 舊版配色',
  swatch: NOSTALGIA_APPEARANCE.wallpaper,
  config: { ...NOSTALGIA_APPEARANCE },
};

// 動森葉子貼紙：切換動森皮膚時自動撒到桌面。用 acnh-leaf- 前綴標記，便於切回時單獨清掉而不動用戶自己的裝飾。
const ACNH_LEAF_PREFIX = 'acnh-leaf-';
const acnhLeafSvg = (fill: string, vein: string) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
  + `<path d="M50 8 C78 20 88 50 78 82 C74 92 60 96 50 92 C40 96 26 92 22 82 C12 50 22 20 50 8Z" fill="${fill}"/>`
  + `<path d="M50 14 L50 88" stroke="${vein}" stroke-width="3" fill="none" opacity="0.5"/>`
  + `<path d="M50 35 Q66 32 74 42" stroke="${vein}" stroke-width="2" fill="none" opacity="0.4"/>`
  + `<path d="M50 52 Q34 49 26 59" stroke="${vein}" stroke-width="2" fill="none" opacity="0.4"/></svg>`
)}`;
const ACNH_LEAF_VARIANTS = [
  acnhLeafSvg('#7CBA4C', '#4d7a2a'),
  acnhLeafSvg('#9ED25F', '#5c8a30'),
  acnhLeafSvg('#5FAE6E', '#356b3f'),
];
const ACNH_LEAF_LAYOUT: { x: number; y: number; scale: number; rotation: number; opacity: number; flip?: boolean }[] = [
  { x: 12, y: 14, scale: 0.8, rotation: -20, opacity: 0.9 },
  { x: 86, y: 17, scale: 0.7, rotation: 30, opacity: 0.85, flip: true },
  { x: 17, y: 80, scale: 0.9, rotation: 15, opacity: 0.9 },
  { x: 88, y: 78, scale: 0.72, rotation: -25, opacity: 0.85 },
  { x: 50, y: 91, scale: 0.6, rotation: 8, opacity: 0.8 },
  { x: 82, y: 48, scale: 0.55, rotation: -40, opacity: 0.7, flip: true },
];
const buildAcnhLeaves = (): DesktopDecoration[] => ACNH_LEAF_LAYOUT.map((p, i) => ({
  id: `${ACNH_LEAF_PREFIX}${i}`,
  type: 'preset',
  content: ACNH_LEAF_VARIANTS[i % ACNH_LEAF_VARIANTS.length],
  x: p.x, y: p.y, scale: p.scale, rotation: p.rotation, opacity: p.opacity,
  zIndex: 5 + i, flip: p.flip,
}));

/**
 * 預設卡片頂部那條縮略圖（壁紙打底 + 兩個色塊 + 裝飾數量角標）。
 *
 * 預設是直接從 assets 表讀出來的 JSON，沒走 OSContext 那層壁紙解析，所以
 * `theme.wallpaper` 很可能還是個 `blobref:` 令牌，直接拼進 CSS 的 url() 加載不出來。
 * 這裡過一道 useBlobRefUrl 把令牌換成 objectURL —— 它對 data: / http(s) / 漸變這類
 * 非令牌值是渲染期原樣透傳的，所以只有令牌會真的去讀盤。
 * 因為 hook 不能寫在 map 回調裡，這塊預覽單獨抽成組件，一個預設一份解析和回收。
 */
const PresetPreview: React.FC<{ preset: AppearancePreset }> = ({ preset }) => {
    const { hue, saturation, lightness, contentColor, desktopDecorations, wallpaper } = preset.theme;
    const resolvedWallpaper = useBlobRefUrl(wallpaper);

    const themeGradient = `linear-gradient(135deg, hsl(${hue}, ${saturation}%, ${lightness}%), hsl(${hue + 30}, ${saturation}%, ${Math.max(lightness - 15, 10)}%))`;
    const isCssGradient = !!wallpaper
        && (wallpaper.startsWith('linear-gradient') || wallpaper.startsWith('radial-gradient') || wallpaper.startsWith('conic-gradient'));

    // 沒設壁紙 → 主題色兜底；壁紙本身就是 CSS 漸變 → 原樣用；否則當圖片鋪進 url()。
    // 令牌還在讀盤、或者圖已經丟了時 resolvedWallpaper 是 undefined，同樣退回主題色，
    // 免得渲染出一個 url("undefined")。
    let background: string;
    if (!wallpaper) background = themeGradient;
    else if (isCssGradient) background = wallpaper;
    else background = resolvedWallpaper ? `url("${resolvedWallpaper}") center/cover` : themeGradient;

    return (
        <div className="h-14 relative overflow-hidden" style={{ background }}>
            <div className="absolute inset-0 bg-black/10" />
            <div className="absolute bottom-1.5 left-3 flex gap-1">
                <div className="w-4 h-4 rounded-full" style={{ backgroundColor: `hsl(${hue}, ${saturation}%, ${lightness}%)` }} />
                <div className="w-4 h-4 rounded-full" style={{ backgroundColor: contentColor || '#fff' }} />
            </div>
            {desktopDecorations && desktopDecorations.length > 0 && (
                <div className="absolute bottom-1.5 right-3 text-[8px] text-white/80 bg-black/30 px-1.5 py-0.5 rounded-full backdrop-blur-sm">
                    {desktopDecorations.length} 裝飾
                </div>
            )}
        </div>
    );
};

// --- Preset Manager Component ---
interface PresetManagerProps {
    presets: AppearancePreset[];
    onSave: (name: string) => void;
    onApply: (id: string) => void;
    onDelete: (id: string) => void;
    onRename: (id: string, name: string) => void;
    onExport: (id: string) => Promise<Blob>;
    onImport: (file: File) => Promise<void>;
    addToast: (msg: string, type?: Toast['type']) => void;
    currentTheme: OSTheme;
}

const PresetManager: React.FC<PresetManagerProps> = ({ presets, onSave, onApply, onDelete, onRename, onExport, onImport, addToast, currentTheme }) => {
    const [newName, setNewName] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const importRef = useRef<HTMLInputElement>(null);

    const handleSave = () => {
        const name = newName.trim() || `預設 ${new Date().toLocaleDateString('zh-CN')}`;
        onSave(name);
        setNewName('');
    };

    const handleExport = async (id: string) => {
        try {
            const preset = presets.find(p => p.id === id);
            // 導出前明文密鑰體檢 + 二次確認（外觀預設正常不含密鑰 → 提示「安全，可分享」）。
            if (!(await confirmExportSafety(preset))) return;
            const blob = await onExport(id);
            const fileName = `appearance_${preset?.name || 'preset'}.zip`;
            const title = `外觀預設 - ${preset?.name || 'preset'}`;

            const result = await shareOrDownloadBlob({ blob, fileName, shareTitle: title, card: { kind: 'appearance', title: preset?.name || '外觀預設' } });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? '已打開預設分享面板' : '預設已導出', 'success');
        } catch (e: any) {
            addToast(e.message || '導出失敗', 'error');
        }
    };

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            await onImport(await readShareFile(file, 'appearance'));
            trackEvent('导入外观预设文件');
        } catch (err: any) {
            addToast(err.message || '導入失敗', 'error');
        }
        if (importRef.current) importRef.current.value = '';
    };

    const handleRename = (id: string) => {
        if (editName.trim()) {
            onRename(id, editName.trim());
        }
        setEditingId(null);
        setEditName('');
    };

    return (
        <div className="space-y-5">
            {/* Save Current */}
            <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-3">保存當前外觀</h2>
                <p className="text-[10px] text-slate-400 mb-3">將當前的主題色、壁紙、字體、圖標、裝飾等完整外觀保存為預設，方便隨時切換。</p>
                <div className="flex gap-2">
                    <input
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        placeholder="預設名稱（可選）"
                        className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs outline-none focus:border-primary transition-all"
                        onKeyDown={e => e.key === 'Enter' && handleSave()}
                    />
                    <button onClick={handleSave}
                        className="px-5 py-2.5 bg-primary text-white font-bold text-xs rounded-xl shadow-md active:scale-95 transition-transform shrink-0">
                        保存
                    </button>
                </div>
            </section>

            {/* Import */}
            <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-3">導入外觀預設</h2>
                <p className="text-[10px] text-slate-400 mb-3">支持 PNG 分享原圖、ZIP 和舊版 JSON。系統整合備份也會包含當前外觀設置，單獨預設文件更適合分享。</p>
                <input type="file" ref={importRef} className="hidden" accept=".png,.zip,.json,image/png,application/zip,application/json" onChange={handleImport} />
                <button onClick={() => importRef.current?.click()}
                    className="w-full py-2.5 bg-gradient-to-r from-blue-50 to-cyan-50 text-blue-500 font-bold text-xs rounded-xl border border-blue-200 active:scale-95 transition-transform flex items-center justify-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                    選擇文件導入
                </button>
            </section>

            {/* Preset List */}
            <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-3">已保存預設 ({presets.length})</h2>
                {presets.length === 0 ? (
                    <div className="text-center py-8">
                        <div className="text-3xl mb-2 opacity-40">
                            <Sparkle size={48} weight="fill" className="mx-auto text-slate-300" />
                        </div>
                        <p className="text-xs text-slate-400">還沒有外觀預設</p>
                        <p className="text-[10px] text-slate-300 mt-1">保存當前外觀或導入預設文件開始使用</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {presets.map(preset => (
                            <div key={preset.id} className="bg-slate-50 rounded-2xl border border-slate-100 overflow-hidden">
                                {/* Preview bar */}
                                <PresetPreview preset={preset} />

                                {/* Info & actions */}
                                <div className="p-3">
                                    {editingId === preset.id ? (
                                        <div className="flex gap-2 mb-2">
                                            <input
                                                value={editName}
                                                onChange={e => setEditName(e.target.value)}
                                                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-primary"
                                                autoFocus
                                                onKeyDown={e => { if (e.key === 'Enter') handleRename(preset.id); if (e.key === 'Escape') setEditingId(null); }}
                                            />
                                            <button onClick={() => handleRename(preset.id)} className="px-3 py-1.5 bg-primary text-white text-[10px] font-bold rounded-lg">確定</button>
                                            <button onClick={() => setEditingId(null)} className="px-3 py-1.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-lg">取消</button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center justify-between mb-2">
                                            <div>
                                                <div className="text-xs font-bold text-slate-700">{preset.name}</div>
                                                <div className="text-[9px] text-slate-400">{new Date(preset.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex gap-1.5 flex-wrap">
                                        <button onClick={() => { onApply(preset.id); trackEvent('应用已保存外观预设'); }}
                                            className="px-3 py-1.5 bg-primary text-white text-[10px] font-bold rounded-lg active:scale-95 transition-transform shadow-sm">
                                            應用
                                        </button>
                                        <button onClick={() => handleExport(preset.id)}
                                            className="px-3 py-1.5 bg-green-50 text-green-600 text-[10px] font-bold rounded-lg border border-green-200 active:scale-95 transition-transform">
                                            導出
                                        </button>
                                        <button onClick={() => { setEditingId(preset.id); setEditName(preset.name); }}
                                            className="px-3 py-1.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-lg border border-slate-200 active:scale-95 transition-transform">
                                            重命名
                                        </button>
                                        {confirmDeleteId === preset.id ? (
                                            <div className="flex gap-1">
                                                <button onClick={() => { onDelete(preset.id); setConfirmDeleteId(null); }}
                                                    className="px-3 py-1.5 bg-red-500 text-white text-[10px] font-bold rounded-lg active:scale-95 transition-transform">
                                                    確認刪除
                                                </button>
                                                <button onClick={() => setConfirmDeleteId(null)}
                                                    className="px-3 py-1.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-lg active:scale-95 transition-transform">
                                                    取消
                                                </button>
                                            </div>
                                        ) : (
                                            <button onClick={() => setConfirmDeleteId(preset.id)}
                                                className="px-3 py-1.5 bg-red-50 text-red-400 text-[10px] font-bold rounded-lg border border-red-200 active:scale-95 transition-transform">
                                                刪除
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <div className="text-[10px] text-slate-400 text-center px-4 pb-4">
                外觀預設既可以單獨導入/導出，也會隨系統整合備份一起保存。你可以保存多個預設並隨時切換。
            </div>
        </div>
    );
};

const Appearance: React.FC = () => {
  const { theme, updateTheme, closeApp, openApp, setCustomIcon, customIcons, addToast, appearancePresets, saveAppearancePreset, applyAppearancePreset, deleteAppearancePreset, renameAppearancePreset, exportAppearancePreset, importAppearancePreset, characters, activeCharacterId, updateCharacter } = useOS();
  const [activeTab, setActiveTab] = useState<'theme' | 'icons' | 'presets'>('theme');
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const [wallpaperUrl, setWallpaperUrl] = useState('');
  const lockWallpaperInputRef = useRef<HTMLInputElement>(null);
  const [lockWallpaperUrl, setLockWallpaperUrl] = useState('');
  const widgetInputRef = useRef<HTMLInputElement>(null);
  const [activeWidgetSlot, setActiveWidgetSlot] = useState<string | null>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const companionPortraitInputRef = useRef<HTMLInputElement>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  
  // Font State
  const [fontMode, setFontMode] = useState<'local' | 'web'>('local');
  const [webFontUrl, setWebFontUrl] = useState('');

  // Desktop Decoration DIY State
  const decoInputRef = useRef<HTMLInputElement>(null);
  const [editingDecoId, setEditingDecoId] = useState<string | null>(null);
  const [showPresetPicker, setShowPresetPicker] = useState(false);

  const decorations = theme.desktopDecorations || [];
  const editingDeco = editingDecoId ? decorations.find(d => d.id === editingDecoId) : null;
  const appearanceCharacter = characters.find(character => character.id === activeCharacterId) || characters[0];
  const companionSource = companionAvatarSource(appearanceCharacter);
  const companionDateOutfits = listCompanionDateOutfits(appearanceCharacter);
  const selectedCompanionOutfitId = normalizeCompanionSkinSetId(appearanceCharacter?.companionAvatar?.skinSetId);
  const selectedCompanionOutfit = companionDateOutfits.find(outfit => outfit.id === selectedCompanionOutfitId)
      || companionDateOutfits[0];
  const companionPreview = companionSource === 'upload'
      ? appearanceCharacter?.companionAvatar?.imageRef
      : companionSource === 'date' ? selectedCompanionOutfit?.preview : appearanceCharacter?.avatar;

  const chooseCompanionSource = (source: 'model' | 'upload' | 'date') => {
      if (!appearanceCharacter) {
          addToast('請先創建並選擇一個角色', 'error');
          return;
      }
      if (source === 'upload' && !appearanceCharacter.companionAvatar?.imageRef) {
          companionPortraitInputRef.current?.click();
          return;
      }
      if (source === 'date' && !hasDatePortraits(appearanceCharacter)) {
          addToast('這個角色還沒有見面立繪，請先去見面模式添加', 'info');
          openApp(AppID.Date);
          return;
      }
      updateCharacter(appearanceCharacter.id, {
          companionAvatar: {
              version: 1,
              ...appearanceCharacter.companionAvatar,
              source,
          },
      });
      trackEvent('切换桌面陪伴形象来源', {
          来源: source === 'model' ? '动态模型' : source === 'upload' ? '静态图片' : '见面立绘',
      });
      addToast(source === 'model' ? '桌面已使用動態模型' : source === 'date' ? '已沿用見面模式立繪' : '已使用導入圖片', 'success');
  };

  const handleCompanionPortraitUpload = async (file: File) => {
      if (!appearanceCharacter) return;
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!['png', 'gif'].includes(extension || '') || !['image/png', 'image/gif'].includes(file.type)) {
          addToast('圖片上傳僅支持 PNG / GIF', 'error');
          return;
      }
      if (file.size > 20 * 1024 * 1024) {
          addToast('圖片超過 20 MB，請壓縮後再導入', 'error');
          return;
      }
      try {
          const previousRef = appearanceCharacter.companionAvatar?.imageRef;
          const imageRef = await putImageBlob(file);
          updateCharacter(appearanceCharacter.id, {
              companionAvatar: {
                  version: 1,
                  ...appearanceCharacter.companionAvatar,
                  source: 'upload',
                  imageRef,
                  fileName: file.name,
                  mimeType: file.type,
                  importedAt: Date.now(),
              },
          });
          if (previousRef && previousRef !== imageRef
              && !isCompanionOutfitKeptInWardrobe(appearanceCharacter.companionAvatar, previousRef)) {
              await deleteBlobRef(previousRef);
          }
          trackEvent('导入桌面静态形象', { 格式: file.type === 'image/gif' ? 'GIF' : 'PNG' });
          addToast(file.type === 'image/gif' ? 'GIF 已原樣導入，動畫會保留' : 'PNG 形象已導入', 'success');
      } catch (error: any) {
          addToast(error?.message || '圖片形象導入失敗', 'error');
      }
  };

  const chooseCompanionOutfit = (outfitId: string) => {
      if (!appearanceCharacter) return;
      updateCharacter(appearanceCharacter.id, {
          companionAvatar: {
              version: 1,
              ...appearanceCharacter.companionAvatar,
              source: 'date',
              skinSetId: companionSkinSetPatchValue(outfitId),
          },
      });
      trackEvent('切换桌面见面立绘衣服');
      addToast('桌面衣服已切換，見面模式的選擇不會被改動', 'success');
  };

  const removeCompanionUpload = async () => {
      if (!appearanceCharacter?.companionAvatar?.imageRef) return;
      const previousRef = appearanceCharacter.companionAvatar.imageRef;
      updateCharacter(appearanceCharacter.id, {
          companionAvatar: {
              ...appearanceCharacter.companionAvatar,
              source: hasDatePortraits(appearanceCharacter) ? 'date' : 'model',
              imageRef: undefined,
              fileName: undefined,
              mimeType: undefined,
              importedAt: undefined,
          },
      });
      if (!isCompanionOutfitKeptInWardrobe(appearanceCharacter.companionAvatar, previousRef)) {
          await deleteBlobRef(previousRef);
      }
      trackEvent('移除桌面静态形象');
      addToast('已移除導入圖片', 'success');
  };

  // Preset decoration SVGs (cute decorative elements)
  const PRESET_DECOS: { name: string; content: string; category: string }[] = [
    // Stars & Sparkles
    { name: '閃光', category: 'stars', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 5 L58 38 L95 50 L58 62 L50 95 L42 62 L5 50 L42 38Z" fill="#FFD700" opacity="0.9"/><path d="M50 20 L54 42 L78 50 L54 58 L50 80 L46 58 L22 50 L46 42Z" fill="#FFF8DC"/></svg>')}` },
    { name: '星星', category: 'stars', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,5 63,35 95,40 72,62 78,95 50,78 22,95 28,62 5,40 37,35" fill="#FF69B4"/><polygon points="50,20 58,38 78,42 64,55 67,78 50,68 33,78 36,55 22,42 42,38" fill="#FFB6C1" opacity="0.7"/></svg>')}` },
    { name: '小星', category: 'stars', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,10 61,40 95,40 68,60 78,90 50,72 22,90 32,60 5,40 39,40" fill="#B19CD9" opacity="0.85"/></svg>')}` },
    // Hearts
    { name: '愛心', category: 'hearts', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 88 C25 65 5 50 5 30 C5 15 17 5 30 5 C38 5 46 10 50 18 C54 10 62 5 70 5 C83 5 95 15 95 30 C95 50 75 65 50 88Z" fill="#FF6B9D"/><path d="M50 78 C30 60 15 48 15 33 C15 22 23 15 33 15 C39 15 45 18 50 25 C55 18 61 15 67 15 C77 15 85 22 85 33 C85 48 70 60 50 78Z" fill="#FF8FB1" opacity="0.6"/></svg>')}` },
    { name: '雙心', category: 'hearts', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M35 70 C18 52 3 42 3 27 C3 16 12 8 22 8 C28 8 33 11 35 16 C37 11 42 8 48 8 C58 8 67 16 67 27 C67 42 52 52 35 70Z" fill="#FF69B4" opacity="0.8"/><path d="M65 80 C48 62 33 52 33 37 C33 26 42 18 52 18 C58 18 63 21 65 26 C67 21 72 18 78 18 C88 18 97 26 97 37 C97 52 82 62 65 80Z" fill="#FF1493" opacity="0.7"/></svg>')}` },
    // Flowers & Nature
    { name: '花朵', category: 'flowers', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="30" r="18" fill="#FFB7D5" opacity="0.8"/><circle cx="30" cy="50" r="18" fill="#FFB7D5" opacity="0.8"/><circle cx="70" cy="50" r="18" fill="#FFB7D5" opacity="0.8"/><circle cx="38" cy="70" r="18" fill="#FFB7D5" opacity="0.8"/><circle cx="62" cy="70" r="18" fill="#FFB7D5" opacity="0.8"/><circle cx="50" cy="50" r="12" fill="#FFE4B5"/></svg>')}` },
    { name: '櫻花', category: 'flowers', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(50,50)"><g fill="#FFB7C5" opacity="0.85"><ellipse rx="12" ry="22" transform="rotate(0) translate(0,-20)"/><ellipse rx="12" ry="22" transform="rotate(72) translate(0,-20)"/><ellipse rx="12" ry="22" transform="rotate(144) translate(0,-20)"/><ellipse rx="12" ry="22" transform="rotate(216) translate(0,-20)"/><ellipse rx="12" ry="22" transform="rotate(288) translate(0,-20)"/></g><circle r="8" fill="#FF69B4"/></g></svg>')}` },
    { name: '葉子', category: 'flowers', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 10 Q80 30 85 60 Q85 90 50 95 Q15 90 15 60 Q20 30 50 10Z" fill="#90EE90" opacity="0.8"/><path d="M50 20 L50 85" stroke="#228B22" stroke-width="2" fill="none" opacity="0.5"/><path d="M50 40 Q65 35 70 45" stroke="#228B22" stroke-width="1.5" fill="none" opacity="0.4"/><path d="M50 55 Q35 50 30 60" stroke="#228B22" stroke-width="1.5" fill="none" opacity="0.4"/></svg>')}` },
    // Ribbons & Bows
    { name: '蝴蝶結', category: 'ribbons', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 45 Q20 20 10 35 Q5 50 25 55 Q35 57 50 50Z" fill="#FF69B4"/><path d="M50 45 Q80 20 90 35 Q95 50 75 55 Q65 57 50 50Z" fill="#FF69B4"/><circle cx="50" cy="48" r="6" fill="#FF1493"/><path d="M45 54 Q42 75 38 90" stroke="#FF69B4" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M55 54 Q58 75 62 90" stroke="#FF69B4" stroke-width="4" fill="none" stroke-linecap="round"/></svg>')}` },
    { name: '絲帶', category: 'ribbons', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 30 Q30 20 50 30 Q70 40 90 30 L90 50 Q70 40 50 50 Q30 60 10 50Z" fill="#DDA0DD" opacity="0.85"/><path d="M10 50 Q30 40 50 50 Q70 60 90 50 L90 70 Q70 60 50 70 Q30 80 10 70Z" fill="#BA55D3" opacity="0.7"/></svg>')}` },
    // Cute Animals
    { name: '貓耳', category: 'animals', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M15 65 L5 15 L40 45Z" fill="#333" opacity="0.9"/><path d="M85 65 L95 15 L60 45Z" fill="#333" opacity="0.9"/><path d="M18 60 L12 22 L38 46Z" fill="#FFB6C1" opacity="0.6"/><path d="M82 60 L88 22 L62 46Z" fill="#FFB6C1" opacity="0.6"/></svg>')}` },
    { name: '貓爪', category: 'animals', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><ellipse cx="50" cy="62" rx="22" ry="20" fill="#FFB6C1" opacity="0.85"/><circle cx="35" cy="38" r="10" fill="#FFB6C1" opacity="0.85"/><circle cx="65" cy="38" r="10" fill="#FFB6C1" opacity="0.85"/><circle cx="22" cy="50" r="9" fill="#FFB6C1" opacity="0.85"/><circle cx="78" cy="50" r="9" fill="#FFB6C1" opacity="0.85"/></svg>')}` },
    // Geometric / Shapes
    { name: '月亮', category: 'shapes', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M60 10 A40 40 0 1 0 60 90 A30 30 0 1 1 60 10Z" fill="#FFD700" opacity="0.8"/></svg>')}` },
    { name: '鑽石', category: 'shapes', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,5 85,35 50,95 15,35" fill="#87CEEB" opacity="0.8"/><polygon points="50,5 65,35 50,95" fill="#ADD8E6" opacity="0.5"/><polygon points="15,35 85,35 50,5" fill="#B0E0E6" opacity="0.6"/></svg>')}` },
    { name: '泡泡', category: 'shapes', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="35" fill="none" stroke="#87CEEB" stroke-width="2" opacity="0.6"/><circle cx="50" cy="50" r="35" fill="#E0F0FF" opacity="0.2"/><ellipse cx="38" cy="38" rx="12" ry="8" fill="white" opacity="0.5" transform="rotate(-30 38 38)"/></svg>')}` },
    // Text Badges
    { name: 'LOVE', category: 'badges', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 50"><rect x="2" y="2" width="116" height="46" rx="23" fill="#FF69B4" opacity="0.85"/><text x="60" y="33" text-anchor="middle" fill="white" font-size="22" font-weight="bold" font-family="sans-serif">LOVE</text></svg>')}` },
    { name: 'CUTE', category: 'badges', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 50"><rect x="2" y="2" width="116" height="46" rx="23" fill="#DDA0DD" opacity="0.85"/><text x="60" y="33" text-anchor="middle" fill="white" font-size="22" font-weight="bold" font-family="sans-serif">CUTE</text></svg>')}` },
    { name: 'MY♡', category: 'badges', content: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 50"><rect x="2" y="2" width="116" height="46" rx="10" fill="none" stroke="#FF69B4" stroke-width="3" opacity="0.8"/><text x="60" y="34" text-anchor="middle" fill="#FF69B4" font-size="20" font-weight="bold" font-family="sans-serif">MY♡</text></svg>')}` },
  ];

  const addDecoration = useCallback((content: string, type: 'image' | 'preset') => {
    const newDeco: DesktopDecoration = {
      id: `deco-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      content,
      x: 20 + Math.random() * 60,
      y: 20 + Math.random() * 60,
      scale: 1,
      rotation: 0,
      opacity: 1,
      zIndex: decorations.length + 1,
    };
    const next = [...decorations, newDeco];
    updateTheme({ desktopDecorations: next });
    setEditingDecoId(newDeco.id);
    setShowPresetPicker(false);
  }, [decorations, updateTheme]);

  const updateDecoration = useCallback((id: string, updates: Partial<DesktopDecoration>) => {
    const next = decorations.map(d => d.id === id ? { ...d, ...updates } : d);
    updateTheme({ desktopDecorations: next });
  }, [decorations, updateTheme]);

  const removeDecoration = useCallback((id: string) => {
    const next = decorations.filter(d => d.id !== id);
    updateTheme({ desktopDecorations: next });
    if (editingDecoId === id) setEditingDecoId(null);
  }, [decorations, updateTheme, editingDecoId]);

  const handleDecoUpload = async (file: File) => {
    try {
      const dataUrl = await processImage(file, { maxWidth: 400, quality: 0.85 });
      addDecoration(dataUrl, 'image');
      addToast('裝飾已添加', 'success');
    } catch (e: any) {
      addToast(e.message, 'error');
    }
  };

  const THEME_PRESETS: { name: string, config: Partial<OSTheme>, color: string }[] = [
      { name: 'Indigo', config: { hue: 245, saturation: 25, lightness: 65, contentColor: '#ffffff' }, color: 'hsl(245, 25%, 65%)' },
      { name: 'Sakura', config: { hue: 350, saturation: 70, lightness: 80, contentColor: '#334155' }, color: 'hsl(350, 70%, 80%)' },
      { name: 'Cyber', config: { hue: 170, saturation: 100, lightness: 45, contentColor: '#ffffff' }, color: 'hsl(170, 100%, 45%)' },
      { name: 'Noir', config: { hue: 0, saturation: 0, lightness: 20, contentColor: '#ffffff' }, color: 'hsl(0, 0%, 20%)' },
      { name: 'Sunset', config: { hue: 20, saturation: 90, lightness: 60, contentColor: '#ffffff' }, color: 'hsl(20, 90%, 60%)' },
  ];

  const handleWallpaperUpload = async (file: File) => {
      try {
          addToast('正在處理壁紙 (原畫質)...', 'info');
          // 改存 Blob：原畫質不重繪，二進制進 blob_assets，字段只存 blobref 令牌（省 ~33% 空間、不佔 JS 堆）。
          const blob = await processImageToBlob(file, { skipCompression: true });
          const ref = await putImageBlob(blob);
          await updateTheme({ wallpaper: ref });
          addToast('壁紙更新成功', 'success');
      } catch (e: any) {
          addToast(e.message, 'error');
      }
  };

  const applyWallpaperUrl = async () => {
      const url = wallpaperUrl.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          addToast('請填寫以 http(s):// 開頭的圖片地址', 'error');
          return;
      }
      await updateTheme({ wallpaper: url });
      setWallpaperUrl('');
      addToast('壁紙已應用', 'success');
  };

  const handleLockWallpaperUpload = async (file: File) => {
      try {
          addToast('正在處理鎖屏壁紙 (原畫質)...', 'info');
          const blob = await processImageToBlob(file, { skipCompression: true });
          const ref = await putImageBlob(blob);
          await updateTheme({ lockWallpaper: ref });
          addToast('鎖屏壁紙更新成功', 'success');
      } catch (e: any) {
          addToast(e.message, 'error');
      }
  };

  const applyLockWallpaperUrl = async () => {
      const url = lockWallpaperUrl.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          addToast('請填寫以 http(s):// 開頭的圖片地址', 'error');
          return;
      }
      await updateTheme({ lockWallpaper: url });
      setLockWallpaperUrl('');
      addToast('鎖屏壁紙已應用', 'success');
  };

  const handleWidgetUpload = async (file: File) => {
      if (!activeWidgetSlot) return;
      try {
          const maxW = activeWidgetSlot === 'wide' ? 800 : activeWidgetSlot === 'dsq' ? 600 : 500;
          const blob = await processImageToBlob(file, { maxWidth: maxW, quality: 0.9 });
          const ref = await putImageBlob(blob);
          const current = theme.launcherWidgets || {};
          updateTheme({ launcherWidgets: { ...current, [activeWidgetSlot]: ref } });
          addToast('小組件已更新', 'success');
      } catch (e: any) {
          addToast(e.message, 'error');
      }
  };

  const removeWidget = (slot: string) => {
      const current = { ...(theme.launcherWidgets || {}) };
      delete current[slot];
      updateTheme({ launcherWidgets: Object.keys(current).length > 0 ? current : undefined });
  };

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      
      const allowedExts = ['.ttf', '.otf', '.woff', '.woff2'];
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      
      if (!allowedExts.includes(ext)) {
          addToast('僅支持 ttf/otf/woff/woff2 格式', 'error');
          return;
      }

      addToast('正在處理字體文件...', 'info');
      
      const reader = new FileReader();
      reader.onload = async (ev) => {
          try {
              const dataUrl = ev.target?.result as string;
              updateTheme({ customFont: dataUrl });
              addToast('系統字體已更新', 'success');
          } catch(err) {
              addToast('字體加載失敗', 'error');
          }
      };
      reader.onerror = () => addToast('讀取失敗', 'error');
      reader.readAsDataURL(file);
      
      // Clear input
      if (fontInputRef.current) fontInputRef.current.value = '';
  };

  const applyWebFont = () => {
      if (!webFontUrl.trim()) return;
      updateTheme({ customFont: webFontUrl.trim() });
      setWebFontUrl('');
      addToast('網絡字體已應用', 'success');
  };

  // 切換桌面整機風格：動森模式自動撒葉子貼紙（保留用戶已有裝飾），切回默認時只清掉 acnh 葉子。
  // 壁紙處理：進入動森前備份用戶原壁紙（data URI 存 IndexedDB，漸變/URL 存 localStorage），
  // 切回默認時還原，避免覆蓋用戶自己設的桌面壁紙。
  const ACNH_WP_BACKUP_KEY = 'acnh_wallpaper_backup';
  const currentDesktopSkinId = theme.skin && theme.skin !== 'default'
      ? theme.skin
      : theme.desktopVariant === 'nostalgia' ? 'nostalgia' : 'default';
  const applyDesktopSkin = async (skin: DesktopSkinOption) => {
      const goingDefault = skin.id === 'default';
      const currentlyThemed = currentDesktopSkinId !== 'default';

      let wallpaper: string;
      if (!goingDefault) {
          // 非默認皮膚（動森 / 手遊 …）使用各自預設的壁紙
          wallpaper = (skin.config.wallpaper as string) || DEFAULT_WALLPAPER;
          // 僅從「默認 → 某皮膚」時備份一次用戶原壁紙；皮膚之間互切不再覆蓋備份，保住最初的用戶壁紙
          if (!currentlyThemed) {
              const dbWp = await DB.getAsset('wallpaper'); // 用戶若用 data URI 壁紙，真值在這
              const cur = dbWp || theme.wallpaper || '';
              if (cur && cur.startsWith('data:')) {
                  await DB.saveAsset('wallpaper_user_backup', cur);
                  localStorage.setItem(ACNH_WP_BACKUP_KEY, '__asset__');
              } else {
                  localStorage.setItem(ACNH_WP_BACKUP_KEY, cur);
                  await DB.deleteAsset('wallpaper_user_backup');
              }
          }
      } else {
          // 切回默認：還原備份的用戶壁紙
          const marker = localStorage.getItem(ACNH_WP_BACKUP_KEY);
          if (marker === '__asset__') {
              wallpaper = (await DB.getAsset('wallpaper_user_backup')) || DEFAULT_WALLPAPER;
          } else if (marker !== null) {
              wallpaper = marker || DEFAULT_WALLPAPER; // 空字符串=用戶原本就是默認
          } else {
              wallpaper = DEFAULT_WALLPAPER; // 沒有備份記錄（老用戶首次切回）
          }
      }

      const existing = (theme.desktopDecorations || []).filter(d => !d.id.startsWith(ACNH_LEAF_PREFIX));
      const desktopDecorations = skin.id === 'animalcrossing' ? [...existing, ...buildAcnhLeaves()] : existing;
      // skin.config 裡寫死的 wallpaper 不用，改用上面算出的（備份/還原後的）值
      const { wallpaper: _ignored, ...restConfig } = skin.config;
      await updateTheme({ ...restConfig, wallpaper, desktopDecorations });
      addToast(`已切換到「${skin.name}」`, 'success');
      trackEvent('切换桌面整机风格', { skin: skin.id });
  };

  const handleIconUpload = async (file: File) => {
      if (!selectedAppId) return;
      try {
          const blob = await processImageToBlob(file, { maxWidth: 512, quality: 0.92 });
          const ref = await putImageBlob(blob);
          await setCustomIcon(selectedAppId, ref);
          addToast('應用圖標已更新', 'success');
      } catch (e: any) {
          addToast(e.message, 'error');
      }
  };

  return (
    <div className="h-full w-full bg-slate-50 flex flex-col font-light">
      <ChatDecorationAnnouncement surface="appearance"/>
      <div className="bg-white/70 backdrop-blur-md border-b border-white/40 shrink-0 z-10 sticky top-0" style={{ paddingTop: 'var(--safe-top)' }}>
        <div className="flex items-center px-4 py-3">
          <div className="flex items-center gap-2 w-full">
              <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                  </svg>
              </button>
              <h1 className="text-xl font-medium text-slate-700 tracking-wide">外觀定製</h1>
          </div>
        </div>
      </div>

      <div className="flex border-b border-slate-200 bg-white sticky top-0 z-20">
          <button onClick={() => { setActiveTab('theme'); trackEvent('切换外观定制标签页', { tab: 'theme' }); }} className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === 'theme' ? 'text-primary border-b-2 border-primary' : 'text-slate-400'}`}>系統主題</button>
          <button onClick={() => { setActiveTab('icons'); trackEvent('切换外观定制标签页', { tab: 'icons' }); }} className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === 'icons' ? 'text-primary border-b-2 border-primary' : 'text-slate-400'}`}>應用圖標</button>
          <button onClick={() => { setActiveTab('presets'); trackEvent('切换外观定制标签页', { tab: 'presets' }); }} className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === 'presets' ? 'text-primary border-b-2 border-primary' : 'text-slate-400'}`}>外觀預設</button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6 no-scrollbar">
        {activeTab === 'theme' ? (
            <>
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">動畫與過場</h2>
                    <p className="text-[10px] text-slate-400 mb-2">三項都默認開啟，可以分別關閉；關閉加載動畫後，超過 15 秒的卡死恢復提示仍會保留。</p>
                    <div className="divide-y divide-slate-100">
                        {([
                            {
                                key: 'bootAnimationEnabled' as const,
                                title: '開機動畫',
                                description: '啟動 Soren 時的整機入場過場。',
                            },
                            {
                                key: 'chatCharacterSwitchAnimationEnabled' as const,
                                title: '聊天切換角色動畫',
                                description: '進入聊天或換角色時的頭像登場過場。',
                            },
                            {
                                key: 'appLoadingAnimationEnabled' as const,
                                title: '進入 App 加載動畫',
                                description: 'App 首次加載較慢時顯示的柔光等待畫面。',
                            },
                        ]).map(option => {
                            const enabled = theme[option.key] !== false;
                            return (
                                <div key={option.key} className="flex items-center gap-3 py-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-xs font-bold text-slate-700">{option.title}</div>
                                        <div className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{option.description}</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={enabled}
                                        aria-label={option.title}
                                        onClick={() => {
                                            updateTheme({ [option.key]: !enabled });
                                            trackEvent('设置外观动画', { animation: option.key, enabled: !enabled });
                                        }}
                                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-slate-300'}`}
                                    >
                                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} style={{ left: 2 }} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </section>

                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">桌面風格</h2>
                    <p className="text-[10px] text-slate-400 mb-4">一鍵切換整機主題：壁紙、配色與圖標外觀聯動；觸感陪伴不會改動全局聊天裝扮。</p>
                    <div className="grid grid-cols-2 gap-3">
                        {DESKTOP_SKINS.map(skin => {
                            const active = currentDesktopSkinId === skin.id;
                            return (
                                <button
                                    key={skin.id}
                                    onClick={() => applyDesktopSkin(skin)}
                                    className={`relative text-left rounded-2xl p-3 border-2 transition-all active:scale-[0.98] ${active ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200 hover:border-slate-300'}`}
                                >
                                    <div className="h-16 w-full rounded-xl mb-2 shadow-inner" style={{ background: skin.swatch }} />
                                    <div className="text-xs font-bold text-slate-700 flex items-center gap-1">
                                        {skin.name}
                                        {active && <span className="text-[9px] font-bold text-primary">· 當前</span>}
                                    </div>
                                    <div className="text-[9px] text-slate-400 mt-0.5 leading-snug">{skin.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    <button
                        onClick={() => applyDesktopSkin(NOSTALGIA_SKIN)}
                        aria-pressed={currentDesktopSkinId === 'nostalgia'}
                        className={`mt-3 w-full flex items-center gap-3 rounded-2xl p-3 text-left border-2 transition-all active:scale-[0.99] ${currentDesktopSkinId === 'nostalgia' ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200 hover:border-slate-300'}`}
                    >
                        <div className="h-14 w-20 shrink-0 rounded-xl shadow-inner" style={{ background: NOSTALGIA_SKIN.swatch }} />
                        <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold text-slate-700">
                                {NOSTALGIA_SKIN.name}
                                {currentDesktopSkinId === 'nostalgia' && <span className="ml-1 text-[9px] font-bold text-primary">· 當前</span>}
                            </div>
                            <div className="text-[9px] text-slate-400 mt-0.5 leading-snug">{NOSTALGIA_SKIN.desc}</div>
                        </div>
                        {currentDesktopSkinId !== 'nostalgia' && (
                            <span className="shrink-0 text-[9px] font-semibold text-slate-400">一鍵切換</span>
                        )}
                    </button>

                    {/* 動森模式專屬：聊天 App 是否聯動 */}
                    {(theme.skin || 'default') === 'animalcrossing' && (
                        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-slate-50 border border-slate-100 px-4 py-3">
                            <div className="min-w-0">
                                <div className="text-xs font-bold text-slate-700">聊天界面跟隨動森</div>
                                <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">關掉後，聊天 App 保持原來的樣式</div>
                            </div>
                            <button
                                onClick={() => updateTheme({ acnhChatSync: theme.acnhChatSync === false ? true : false })}
                                className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${theme.acnhChatSync !== false ? 'bg-primary' : 'bg-slate-300'}`}
                                aria-label="聊天界面跟隨動森"
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${theme.acnhChatSync !== false ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                    )}
                </section>

                {currentDesktopSkinId === 'companion' && (
                    <section className="overflow-hidden rounded-3xl border border-violet-100 bg-white shadow-sm" data-testid="companion-static-avatar-settings">
                        <input
                            ref={companionPortraitInputRef}
                            type="file"
                            className="hidden"
                            accept=".png,.gif,image/png,image/gif"
                            onChange={event => {
                                const file = event.target.files?.[0];
                                if (file) void handleCompanionPortraitUpload(file);
                                event.target.value = '';
                            }}
                        />
                        <div className="flex items-center gap-4 p-5">
                            <div className="flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-b from-violet-50 to-slate-100 p-1.5 shadow-inner">
                                <CompanionPortraitPreview value={companionPreview} alt={`${appearanceCharacter?.name || '角色'}桌面形象`} />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <h2 className="text-sm font-bold text-slate-700">陪伴形象</h2>
                                    <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[8px] font-bold tracking-wide text-violet-500">PNG / GIF</span>
                                </div>
                                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                                    桌面與視頻通話共用這裡的選擇。單圖保持原樣；見面立繪會按 AI 情緒切換同套表情。
                                </p>
                                <button
                                    type="button"
                                    onClick={() => companionPortraitInputRef.current?.click()}
                                    className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-3 py-2 text-[10px] font-bold text-white active:scale-95"
                                >
                                    <UploadSimple size={13} weight="bold" /> {appearanceCharacter?.companionAvatar?.imageRef ? '更換圖片' : '導入 PNG / GIF'}
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-3 border-y border-slate-100 bg-slate-50/80 p-1.5">
                            {([
                                ['model', '動態模型'],
                                ['upload', '圖片 / GIF'],
                                ['date', '見面立繪'],
                            ] as const).map(([source, label]) => (
                                <button
                                    key={source}
                                    type="button"
                                    aria-pressed={companionSource === source}
                                    onClick={() => chooseCompanionSource(source)}
                                    className={`flex items-center justify-center gap-1 rounded-xl px-2 py-2 text-[10px] font-semibold transition ${companionSource === source ? 'bg-white text-violet-600 shadow-sm' : 'text-slate-400'}`}
                                >
                                    {companionSource === source && <Check size={11} weight="bold" />}{label}
                                </button>
                            ))}
                        </div>

                        {companionSource === 'date' && (
                            <div className="p-5 pt-4">
                                <div className="mb-2 flex items-center justify-between">
                                    <div>
                                        <div className="text-[11px] font-bold text-slate-600">桌面衣櫥</div>
                                        <div className="mt-0.5 text-[9px] text-slate-400">獨立選擇，不會改掉見面模式正在穿的衣服</div>
                                    </div>
                                    <button type="button" onClick={() => openApp(AppID.Date)} className="text-[9px] font-semibold text-violet-500">補立繪表情 →</button>
                                </div>
                                <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                                    {companionDateOutfits.map(outfit => {
                                        const active = selectedCompanionOutfit?.id === outfit.id;
                                        return (
                                            <button
                                                key={outfit.id}
                                                type="button"
                                                onClick={() => chooseCompanionOutfit(outfit.id)}
                                                className={`w-20 shrink-0 rounded-2xl border p-2 text-left transition active:scale-95 ${active ? 'border-violet-400 bg-violet-50' : 'border-slate-100 bg-slate-50'}`}
                                            >
                                                <div className="flex h-16 items-center justify-center overflow-hidden rounded-xl bg-white">
                                                    <CompanionPortraitPreview value={outfit.preview} alt={outfit.name} />
                                                </div>
                                                <div className="mt-1.5 truncate text-[9px] font-bold text-slate-600">{outfit.name}</div>
                                                <div className={`mt-0.5 text-[8px] ${outfit.expressionCount >= 5 ? 'text-emerald-500' : 'text-amber-500'}`}>{outfit.expressionCount}/5 表情</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {appearanceCharacter?.companionAvatar?.imageRef && (
                            <button
                                type="button"
                                onClick={() => { void removeCompanionUpload(); }}
                                className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 py-3 text-[9px] font-semibold text-slate-400 active:bg-rose-50 active:text-rose-500"
                            >
                                <Trash size={12} /> 移除已導入圖片
                            </button>
                        )}
                    </section>
                )}

                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">Preset Themes</h2>
                    <div className="flex gap-3 mb-6 overflow-x-auto no-scrollbar pb-1">
                        {THEME_PRESETS.map(preset => (
                            <button 
                                key={preset.name}
                                onClick={() => { updateTheme(preset.config); trackEvent('应用配色预设', { preset: preset.name }); }}
                                className="flex flex-col items-center gap-1.5 shrink-0 group"
                            >
                                <div className="w-10 h-10 rounded-full shadow-sm border-2 border-white ring-1 ring-black/5 transition-transform group-active:scale-95" style={{ backgroundColor: preset.color }}></div>
                                <span className="text-[10px] text-slate-500 font-medium">{preset.name}</span>
                            </button>
                        ))}
                    </div>

                    <div className="space-y-5">
                        <div>
                            <div className="flex justify-between text-xs text-slate-500 mb-2 font-medium">
                                <span>Hue</span><span>{theme.hue}°</span>
                            </div>
                            <input type="range" min="0" max="360" value={theme.hue} onChange={(e) => updateTheme({ hue: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary" />
                            <div className="h-2 w-full rounded-full mt-3 opacity-50" style={{ background: `linear-gradient(to right, hsl(0, 50%, 80%), hsl(60, 50%, 80%), hsl(120, 50%, 80%), hsl(180, 50%, 80%), hsl(240, 50%, 80%), hsl(300, 50%, 80%), hsl(360, 50%, 80%))`}}></div>
                        </div>
                        <div>
                            <div className="flex justify-between text-xs text-slate-500 mb-2 font-medium">
                                <span>Saturation</span><span>{theme.saturation}%</span>
                            </div>
                            <input type="range" min="0" max="100" value={theme.saturation} onChange={(e) => updateTheme({ saturation: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary" />
                        </div>
                        <div>
                            <div className="flex justify-between text-xs text-slate-500 mb-2 font-medium">
                                <span>Lightness</span><span>{theme.lightness}%</span>
                            </div>
                            <input type="range" min="10" max="95" value={theme.lightness} onChange={(e) => updateTheme({ lightness: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-primary" />
                        </div>
                        <div>
                            <div className="flex justify-between text-xs text-slate-500 mb-2 font-medium">
                                <span>Text/Widget Color</span>
                            </div>
                            <div className="flex gap-4 items-center bg-slate-50 p-2 rounded-xl border border-slate-100">
                                <div 
                                    onClick={() => updateTheme({ contentColor: '#ffffff' })}
                                    className={`w-8 h-8 rounded-full border-2 cursor-pointer shadow-sm ${theme.contentColor === '#ffffff' ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200'}`} 
                                    style={{ backgroundColor: '#ffffff' }}
                                />
                                <div 
                                    onClick={() => updateTheme({ contentColor: '#334155' })} // Slate-700
                                    className={`w-8 h-8 rounded-full border-2 cursor-pointer shadow-sm ${theme.contentColor === '#334155' ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200'}`} 
                                    style={{ backgroundColor: '#334155' }}
                                />
                                <div className="h-6 w-px bg-slate-200 mx-1"></div>
                                <input 
                                    type="color" 
                                    value={theme.contentColor || '#ffffff'} 
                                    onChange={(e) => updateTheme({ contentColor: e.target.value })}
                                    className="w-8 h-8 rounded-lg border-none cursor-pointer bg-transparent p-0" 
                                />
                                <span className="text-xs text-slate-400 font-mono">{theme.contentColor}</span>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Global Font Section */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">全局字體 (Global Font)</h2>
                    
                    <div className="flex bg-slate-100 p-1 rounded-xl mb-4">
                        <button onClick={() => setFontMode('local')} className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${fontMode === 'local' ? 'bg-white text-primary shadow-sm' : 'text-slate-400'}`}>本地文件</button>
                        <button onClick={() => setFontMode('web')} className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${fontMode === 'web' ? 'bg-white text-primary shadow-sm' : 'text-slate-400'}`}>網絡 URL</button>
                    </div>

                    {fontMode === 'local' ? (
                        <>
                            <div 
                                className="w-full h-24 bg-slate-100 rounded-2xl overflow-hidden relative shadow-inner mb-2 group cursor-pointer border-2 border-dashed border-slate-200 hover:border-primary/50 flex items-center justify-center flex-col gap-2" 
                                onClick={() => fontInputRef.current?.click()}
                            >
                                {theme.customFont && theme.customFont.startsWith('data:') ? (
                                    <>
                                        <span className="text-lg font-bold text-slate-700">Abc 字體預覽</span>
                                        <span className="text-[10px] text-slate-400">已應用本地字體</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-2xl text-slate-400">Aa</span>
                                        <span className="text-xs text-slate-400">上傳字體文件 (.ttf / .otf)</span>
                                    </>
                                )}
                                <div className="absolute inset-0 bg-black/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                    <span className="text-white text-xs font-bold bg-black/40 px-3 py-1 rounded-full backdrop-blur-md">更換字體</span>
                                </div>
                            </div>
                            <input type="file" ref={fontInputRef} className="hidden" accept=".ttf,.otf,.woff,.woff2" onChange={handleFontUpload} />
                        </>
                    ) : (
                        <div className="space-y-2">
                            <input 
                                value={webFontUrl} 
                                onChange={e => setWebFontUrl(e.target.value)} 
                                placeholder="輸入字體文件 URL (https://...)" 
                                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs outline-none focus:border-primary transition-all"
                            />
                            <button onClick={applyWebFont} className="w-full py-2 bg-primary text-white font-bold text-xs rounded-xl shadow-md active:scale-95 transition-transform">
                                應用網絡字體
                            </button>
                            <div className="text-[10px] text-slate-400 px-1">
                                {theme.customFont && theme.customFont.startsWith('http') ? (
                                    <span className="text-green-500">當前使用: {theme.customFont}</span>
                                ) : '提示: 請確保鏈接直通字體文件 (.ttf/.woff)'}
                            </div>
                        </div>
                    )}

                    {theme.customFont && (
                        <button onClick={() => updateTheme({ customFont: undefined })} className="w-full py-2 text-xs font-bold text-red-400 bg-red-50 rounded-lg hover:bg-red-100 mt-2">恢復默認字體</button>
                    )}
                </section>

                {/* Status Bar Layout */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">狀態欄 (Status Bar)</h2>
                    <div className="grid grid-cols-3 gap-2">
                        {([
                            { id: 'standard', label: '安全顯示', hint: '額外留一行', icon: '◫' },
                            { id: 'compact', label: '緊湊顯示', hint: '保留時間並上移', icon: '⌃' },
                            { id: 'hidden', label: '隱藏時間', hint: '只留安全區', icon: '—' },
                        ] as Array<{ id: StatusBarMode; label: string; hint: string; icon: string }>).map(option => {
                            const active = resolveStatusBarMode(theme.statusBarMode, theme.hideStatusBar) === option.id;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => updateTheme({ statusBarMode: option.id, hideStatusBar: option.id === 'hidden' })}
                                    className={`min-w-0 rounded-2xl border px-2 py-3 text-center transition-all active:scale-[0.98] ${active ? 'border-primary bg-primary/10 text-primary shadow-sm' : 'border-slate-100 bg-slate-50 text-slate-500'}`}
                                >
                                    <div className="text-lg leading-none mb-1.5" aria-hidden="true">{option.icon}</div>
                                    <div className="text-xs font-bold whitespace-nowrap">{option.label}</div>
                                    <div className="text-[9px] mt-1 leading-tight opacity-70">{option.hint}</div>
                                </button>
                            );
                        })}
                    </div>
                    <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                        有劉海或靈動島優先用“緊湊顯示”：時間、電量進入頂部安全區，按鈕仍從遮擋區下方開始；若系統已顯示時間，可選“隱藏時間”。
                    </p>
                </section>

                {/* Desktop Music Widget Style */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">桌面組件</h2>
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-sm font-medium text-slate-700">音樂卡片淺色系</div>
                            <div className="text-[10px] text-slate-400 mt-0.5">桌面第二頁「正在播放」卡片改用淺色樣式。僅默認皮膚生效。</div>
                        </div>
                        <button
                            onClick={() => updateTheme({ nowPlayingWidgetLight: !theme.nowPlayingWidgetLight })}
                            className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ml-3 ${theme.nowPlayingWidgetLight ? 'bg-primary' : 'bg-slate-200'}`}
                        >
                            <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${theme.nowPlayingWidgetLight ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>
                </section>

                {/* Wallpaper Section */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">手機壁紙</h2>
                    <LongPressArea
                        className="aspect-[9/16] w-1/2 mx-auto bg-slate-100 rounded-2xl overflow-hidden relative shadow-inner mb-4 group cursor-pointer"
                        onClick={() => wallpaperInputRef.current?.click()}
                        onLongPress={async () => {
                            if (theme.wallpaper === DEFAULT_WALLPAPER) {
                                addToast('當前已是默認壁紙', 'info');
                                return;
                            }
                            await updateTheme({ wallpaper: DEFAULT_WALLPAPER });
                            addToast('已恢復默認壁紙', 'success');
                        }}
                    >
                         <div
                            className="w-full h-full"
                            style={{
                                background: !theme.wallpaper
                                    ? '#e2e8f0'
                                    : (theme.wallpaper.startsWith('linear-gradient') || theme.wallpaper.startsWith('radial-gradient') || theme.wallpaper.startsWith('conic-gradient'))
                                        ? theme.wallpaper
                                        : `url("${theme.wallpaper}") center/cover`,
                            }}
                         />
                         <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                             <span className="text-white text-xs font-bold bg-black/20 px-3 py-1 rounded-full backdrop-blur-md">更換壁紙</span>
                         </div>
                    </LongPressArea>
                    <input type="file" ref={wallpaperInputRef} className="hidden" accept="image/*" onChange={(e) => e.target.files?.[0] && handleWallpaperUpload(e.target.files[0])} />
                    <p className="text-center text-[10px] text-slate-400 mb-4">點擊上傳 / 長按恢復默認壁紙 (支持原畫質)</p>

                    <div className="border-t border-slate-100 pt-4 space-y-2">
                        <p className="text-[11px] font-bold text-slate-500">從 URL 導入</p>
                        <input
                            value={wallpaperUrl}
                            onChange={e => setWallpaperUrl(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applyWallpaperUrl(); }}
                            placeholder="輸入圖片地址 (https://...)"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs outline-none focus:border-primary transition-all"
                        />
                        <button
                            onClick={applyWallpaperUrl}
                            disabled={!wallpaperUrl.trim()}
                            className="w-full py-2 bg-primary text-white font-bold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100"
                        >
                            應用網絡壁紙
                        </button>
                        <p className="text-[10px] text-slate-400">直接引用網絡圖片，不佔用本地存儲</p>
                    </div>
                </section>

                {/* Lock Screen Wallpaper Section */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <div className="flex items-center justify-between mb-1">
                        <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest">鎖屏壁紙</h2>
                        <span className="text-[9px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-500 font-bold">
                            {theme.lockWallpaper ? '獨立設置' : '跟隨桌面'}
                        </span>
                    </div>
                    <p className="text-[10px] text-slate-400 mb-4">單獨設置鎖屏畫面，不會修改桌面壁紙。</p>
                    <LongPressArea
                        className="aspect-[9/16] w-1/2 mx-auto bg-slate-100 rounded-2xl overflow-hidden relative shadow-inner mb-4 group cursor-pointer"
                        onClick={() => lockWallpaperInputRef.current?.click()}
                        onLongPress={async () => {
                            if (!theme.lockWallpaper) {
                                addToast('鎖屏當前已跟隨桌面壁紙', 'info');
                                return;
                            }
                            await updateTheme({ lockWallpaper: undefined });
                            addToast('鎖屏已恢復跟隨桌面壁紙', 'success');
                        }}
                    >
                        <div
                            className="w-full h-full"
                            style={{
                                background: (() => {
                                    const value = theme.lockWallpaper || theme.wallpaper;
                                    if (!value) return '#e2e8f0';
                                    return (value.startsWith('linear-gradient') || value.startsWith('radial-gradient') || value.startsWith('conic-gradient'))
                                        ? value
                                        : `url("${value}") center/cover`;
                                })(),
                            }}
                        />
                        <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="text-white text-xs font-bold bg-black/20 px-3 py-1 rounded-full backdrop-blur-md">更換鎖屏</span>
                        </div>
                    </LongPressArea>
                    <input
                        type="file"
                        ref={lockWallpaperInputRef}
                        className="hidden"
                        accept="image/*"
                        onChange={(e) => {
                            if (e.target.files?.[0]) handleLockWallpaperUpload(e.target.files[0]);
                            e.target.value = '';
                        }}
                    />
                    <p className="text-center text-[10px] text-slate-400 mb-4">點擊上傳 / 長按恢復跟隨桌面</p>

                    <div className="border-t border-slate-100 pt-4 space-y-2">
                        <p className="text-[11px] font-bold text-slate-500">從 URL 導入</p>
                        <input
                            value={lockWallpaperUrl}
                            onChange={e => setLockWallpaperUrl(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applyLockWallpaperUrl(); }}
                            placeholder="輸入鎖屏圖片地址 (https://...)"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs outline-none focus:border-primary transition-all"
                        />
                        <button
                            onClick={applyLockWallpaperUrl}
                            disabled={!lockWallpaperUrl.trim()}
                            className="w-full py-2 bg-primary text-white font-bold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100"
                        >
                            應用網絡鎖屏壁紙
                        </button>
                    </div>
                <BootAnimationSettings theme={theme} updateTheme={updateTheme} />
                </section>

                {/* Page 1 Desktop Square Image */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">首頁方形圖片</h2>
                    <p className="text-[10px] text-slate-400 mb-4">桌面首頁右下角的方形圖片槽位，長按移除</p>
                    <div className="flex justify-center bg-slate-50 p-3 rounded-2xl border border-slate-100">
                        {(() => {
                            const slot = 'dsq';
                            const img = (theme.launcherWidgets || {})[slot];
                            return (
                                <LongPressArea
                                    className={`w-40 aspect-square rounded-2xl overflow-hidden relative cursor-pointer transition-transform active:scale-95 ${img ? 'shadow-sm' : 'border-2 border-dashed border-slate-200 bg-white flex items-center justify-center'}`}
                                    onClick={() => { setActiveWidgetSlot(slot); widgetInputRef.current?.click(); }}
                                    onLongPress={() => {
                                        if (img) {
                                            removeWidget(slot);
                                            addToast('已移除方圖', 'success');
                                        }
                                    }}
                                >
                                    {img ? (
                                        <>
                                            <TokenImg value={img} className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                                                <span className="text-white text-[10px] font-bold bg-black/40 px-2 py-0.5 rounded-full">更換</span>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="text-slate-300 text-center">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-7 h-7 mx-auto mb-1"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                                            <span className="text-[10px]">方圖</span>
                                        </div>
                                    )}
                                </LongPressArea>
                            );
                        })()}
                    </div>
                </section>

                {/* Page 2 Widget Images */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">桌面小組件</h2>
                    <p className="text-[10px] text-slate-400 mb-4">上傳小組件圖片（如時鐘截圖、推圖等），長按移除</p>
                    <input type="file" ref={widgetInputRef} className="hidden" accept="image/*" onChange={(e) => e.target.files?.[0] && handleWidgetUpload(e.target.files[0])} />
                    <div className="space-y-2 bg-slate-50 p-3 rounded-2xl border border-slate-100">
                        <div className="flex gap-2">
                            {['tl', 'tr'].map(slot => {
                                const img = (theme.launcherWidgets || {})[slot];
                                return (
                                    <LongPressArea
                                        key={slot}
                                        className={`flex-1 aspect-square rounded-xl overflow-hidden relative cursor-pointer transition-transform active:scale-95 ${img ? 'shadow-sm' : 'border-2 border-dashed border-slate-200 bg-white flex items-center justify-center'}`}
                                        onClick={() => { setActiveWidgetSlot(slot); widgetInputRef.current?.click(); }}
                                        onLongPress={() => {
                                            if (img) {
                                                removeWidget(slot);
                                                addToast('已移除小組件', 'success');
                                            }
                                        }}
                                    >
                                        {img ? (
                                            <>
                                                <TokenImg value={img} className="w-full h-full object-cover" />
                                                <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                                                    <span className="text-white text-[10px] font-bold bg-black/40 px-2 py-0.5 rounded-full">更換</span>
                                                </div>
                                            </>
                                        ) : (
                                            <div className="text-slate-300 text-center">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 mx-auto mb-1"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                                                <span className="text-[9px]">圖片</span>
                                            </div>
                                        )}
                                    </LongPressArea>
                                );
                            })}
                        </div>
                        {(() => {
                            const slot = 'wide';
                            const img = (theme.launcherWidgets || {})[slot];
                            return (
                                <LongPressArea
                                    className={`w-full h-20 rounded-xl overflow-hidden relative cursor-pointer transition-transform active:scale-[0.98] ${img ? 'shadow-sm' : 'border-2 border-dashed border-slate-200 bg-white flex items-center justify-center'}`}
                                    onClick={() => { setActiveWidgetSlot(slot); widgetInputRef.current?.click(); }}
                                    onLongPress={() => {
                                        if (img) {
                                            removeWidget(slot);
                                            addToast('已移除橫幅', 'success');
                                        }
                                    }}
                                >
                                    {img ? (
                                        <>
                                            <TokenImg value={img} className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                                                <span className="text-white text-[10px] font-bold bg-black/40 px-2 py-0.5 rounded-full">更換</span>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="text-slate-300 text-center">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 mx-auto mb-0.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                                            <span className="text-[9px]">橫幅</span>
                                        </div>
                                    )}
                                </LongPressArea>
                            );
                        })()}
                    </div>
                </section>

                {/* Desktop Decoration DIY Section */}
                <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
                    <div className="flex items-center justify-between mb-2">
                        <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest">桌面裝飾 DIY</h2>
                        <span className="text-[10px] bg-gradient-to-r from-pink-100 to-purple-100 text-pink-500 px-2 py-0.5 rounded-full font-bold">花裡胡哨模式</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mb-4">自由添加裝飾貼紙，調整位置/大小/旋轉/透明度，打造你的專屬痛機桌面！</p>
                    <input type="file" ref={decoInputRef} className="hidden" accept="image/*" onChange={(e) => { if (e.target.files?.[0]) handleDecoUpload(e.target.files[0]); e.target.value = ''; }} />

                    {/* Live Preview */}
                    <div className="relative w-full aspect-[9/16] bg-slate-100 rounded-2xl overflow-hidden mb-4 border border-slate-200 shadow-inner"
                         style={{ background: theme.wallpaper ? `url(${theme.wallpaper}) center/cover` : `linear-gradient(135deg, hsl(${theme.hue}, ${theme.saturation}%, ${theme.lightness}%), hsl(${theme.hue + 30}, ${theme.saturation}%, ${Math.max(theme.lightness - 15, 10)}%))` }}>
                        <div className="absolute inset-0 bg-black/10"></div>
                        {/* Render widget previews */}
                        <div className="absolute top-[12%] left-4 right-4 space-y-1.5 pointer-events-none">
                            {(() => {
                                const w = theme.launcherWidgets || {};
                                return (
                                    <>
                                        {(w['tl'] || w['tr']) && (
                                            <div className="flex gap-1.5">
                                                {['tl', 'tr'].map(k => w[k] ? (
                                                    <div key={k} className="flex-1 aspect-square rounded-lg overflow-hidden opacity-70"><TokenImg value={w[k]} className="w-full h-full object-cover" /></div>
                                                ) : <div key={k} className="flex-1" />)}
                                            </div>
                                        )}
                                        {w['wide'] && (
                                            <div className="w-full h-8 rounded-lg overflow-hidden opacity-70"><TokenImg value={w['wide']} className="w-full h-full object-cover" /></div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                        {/* Render decorations in preview */}
                        {decorations.map(deco => (
                            <div key={deco.id}
                                className={`absolute cursor-pointer transition-all duration-100 ${editingDecoId === deco.id ? 'ring-2 ring-pink-400 ring-offset-1' : ''}`}
                                style={{
                                    left: `${deco.x}%`, top: `${deco.y}%`,
                                    transform: `translate(-50%, -50%) scale(${deco.scale * 0.4}) rotate(${deco.rotation}deg)${deco.flip ? ' scaleX(-1)' : ''}`,
                                    opacity: deco.opacity, zIndex: deco.zIndex,
                                }}
                                onClick={() => setEditingDecoId(editingDecoId === deco.id ? null : deco.id)}>
                                <img src={deco.content} className="w-16 h-16 object-contain pointer-events-none select-none" draggable={false} />
                            </div>
                        ))}
                        {decorations.length === 0 && (
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className="text-center text-white/40">
                                    <Sparkle size={48} weight="fill" className="text-white/60 mb-2" />
                                    <div className="text-[10px] font-bold">添加裝飾開始DIY</div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Add Decoration Buttons */}
                    <div className="flex gap-2 mb-4">
                        <button onClick={() => { setShowPresetPicker(!showPresetPicker); if (!showPresetPicker) trackEvent('打开桌面装饰贴纸库'); }}
                            className="flex-1 py-2.5 bg-gradient-to-r from-pink-50 to-purple-50 text-pink-500 font-bold text-xs rounded-xl border border-pink-200 active:scale-95 transition-transform flex items-center justify-center gap-1.5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" /></svg>
                            預設貼紙
                        </button>
                        <button onClick={() => decoInputRef.current?.click()}
                            className="flex-1 py-2.5 bg-gradient-to-r from-blue-50 to-cyan-50 text-blue-500 font-bold text-xs rounded-xl border border-blue-200 active:scale-95 transition-transform flex items-center justify-center gap-1.5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
                            上傳自定義
                        </button>
                    </div>

                    {/* Preset Picker */}
                    {showPresetPicker && (
                        <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100 mb-4 animate-fade-in">
                            <div className="text-[10px] text-slate-400 font-bold uppercase mb-3">選擇預設裝飾</div>
                            {['stars', 'hearts', 'flowers', 'ribbons', 'animals', 'shapes', 'badges'].map(cat => {
                                const items = PRESET_DECOS.filter(p => p.category === cat);
                                if (items.length === 0) return null;
                                const catInfo = CATEGORY_LABELS[cat];
                                return (
                                    <div key={cat} className="mb-3">
                                        <div className="text-[10px] text-slate-500 mb-1.5 flex items-center gap-1">{catInfo && <TwemojiImg code={catInfo.code} className="w-3.5 h-3.5 inline-block" />} {catInfo?.label || cat}</div>
                                        <div className="flex gap-2 flex-wrap">
                                            {items.map(preset => (
                                                <button key={preset.name} onClick={() => { addDecoration(preset.content, 'preset'); trackEvent('添加桌面装饰贴纸', { 贴纸: preset.name, 分类: preset.category }); }}
                                                    className="w-14 h-14 bg-white rounded-xl border border-slate-200 flex flex-col items-center justify-center gap-0.5 hover:border-pink-300 hover:shadow-sm active:scale-90 transition-all group">
                                                    <img src={preset.content} className="w-8 h-8 object-contain group-hover:scale-110 transition-transform" />
                                                    <span className="text-[8px] text-slate-400">{preset.name}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Decoration List & Editor */}
                    {decorations.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-[10px] text-slate-400 font-bold uppercase mb-2">已添加裝飾 ({decorations.length})</div>
                            {decorations.map((deco, idx) => (
                                <div key={deco.id} className={`bg-slate-50 rounded-xl border transition-all ${editingDecoId === deco.id ? 'border-pink-300 shadow-md' : 'border-slate-100'}`}>
                                    {/* Decoration header row */}
                                    <div className="flex items-center gap-2 p-2.5 cursor-pointer" onClick={() => setEditingDecoId(editingDecoId === deco.id ? null : deco.id)}>
                                        <div className="w-10 h-10 bg-white rounded-lg border border-slate-200 flex items-center justify-center overflow-hidden shrink-0">
                                            <img src={deco.content} className="w-8 h-8 object-contain" style={{ transform: deco.flip ? 'scaleX(-1)' : undefined }} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-bold text-slate-600">裝飾 #{idx + 1}</div>
                                            <div className="text-[9px] text-slate-400">位置 ({Math.round(deco.x)}, {Math.round(deco.y)}) · {deco.scale}x · {deco.rotation}°</div>
                                        </div>
                                        <button onClick={(e) => { e.stopPropagation(); removeDecoration(deco.id); }} className="p-1.5 text-red-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                                        </button>
                                        <div className={`w-5 h-5 flex items-center justify-center transition-transform ${editingDecoId === deco.id ? 'rotate-180' : ''}`}>
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5 text-slate-400"><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
                                        </div>
                                    </div>

                                    {/* Expanded edit controls */}
                                    {editingDecoId === deco.id && (
                                        <div className="px-3 pb-3 space-y-4 animate-fade-in border-t border-slate-100 pt-3">
                                            {/* Position X */}
                                            <div>
                                                <div className="flex justify-between mb-1.5">
                                                    <label className="text-[10px] font-bold text-slate-400 uppercase">水平位置 X</label>
                                                    <span className="text-[10px] text-slate-500 font-mono">{Math.round(deco.x)}%</span>
                                                </div>
                                                <input type="range" min="0" max="100" value={deco.x} onChange={(e) => updateDecoration(deco.id, { x: parseFloat(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-pink-400" />
                                            </div>
                                            {/* Position Y */}
                                            <div>
                                                <div className="flex justify-between mb-1.5">
                                                    <label className="text-[10px] font-bold text-slate-400 uppercase">垂直位置 Y</label>
                                                    <span className="text-[10px] text-slate-500 font-mono">{Math.round(deco.y)}%</span>
                                                </div>
                                                <input type="range" min="0" max="100" value={deco.y} onChange={(e) => updateDecoration(deco.id, { y: parseFloat(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-pink-400" />
                                            </div>
                                            {/* Scale & Rotation */}
                                            <div className="grid grid-cols-2 gap-4">
                                                <div>
                                                    <div className="flex justify-between mb-1.5">
                                                        <label className="text-[10px] font-bold text-slate-400 uppercase">縮放</label>
                                                        <span className="text-[10px] text-slate-500 font-mono">{deco.scale}x</span>
                                                    </div>
                                                    <input type="range" min="0.2" max="3" step="0.1" value={deco.scale} onChange={(e) => updateDecoration(deco.id, { scale: parseFloat(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-purple-400" />
                                                </div>
                                                <div>
                                                    <div className="flex justify-between mb-1.5">
                                                        <label className="text-[10px] font-bold text-slate-400 uppercase">旋轉</label>
                                                        <span className="text-[10px] text-slate-500 font-mono">{deco.rotation}°</span>
                                                    </div>
                                                    <input type="range" min="-180" max="180" value={deco.rotation} onChange={(e) => updateDecoration(deco.id, { rotation: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-purple-400" />
                                                </div>
                                            </div>
                                            {/* Opacity */}
                                            <div>
                                                <div className="flex justify-between mb-1.5">
                                                    <label className="text-[10px] font-bold text-slate-400 uppercase">透明度</label>
                                                    <span className="text-[10px] text-slate-500 font-mono">{Math.round(deco.opacity * 100)}%</span>
                                                </div>
                                                <input type="range" min="0.1" max="1" step="0.05" value={deco.opacity} onChange={(e) => updateDecoration(deco.id, { opacity: parseFloat(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-blue-400" />
                                            </div>
                                            {/* Quick Actions */}
                                            <div className="flex gap-2 flex-wrap">
                                                <button onClick={() => updateDecoration(deco.id, { flip: !deco.flip })}
                                                    className={`px-3 py-1.5 text-[10px] font-bold rounded-lg border transition-all active:scale-95 ${deco.flip ? 'bg-pink-50 text-pink-500 border-pink-200' : 'bg-white text-slate-400 border-slate-200'}`}>
                                                    鏡像翻轉
                                                </button>
                                                <button onClick={() => updateDecoration(deco.id, { rotation: 0, scale: 1, opacity: 1, flip: false })}
                                                    className="px-3 py-1.5 text-[10px] font-bold rounded-lg bg-white text-slate-400 border border-slate-200 active:scale-95 transition-all">
                                                    重置參數
                                                </button>
                                                <button onClick={() => {
                                                    const dup: DesktopDecoration = { ...deco, id: `deco-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, x: Math.min(deco.x + 8, 95), y: Math.min(deco.y + 8, 95) };
                                                    const next = [...decorations, dup];
                                                    updateTheme({ desktopDecorations: next });
                                                    setEditingDecoId(dup.id);
                                                }}
                                                    className="px-3 py-1.5 text-[10px] font-bold rounded-lg bg-white text-slate-400 border border-slate-200 active:scale-95 transition-all">
                                                    複製一個
                                                </button>
                                                {/* Layer controls */}
                                                <button onClick={() => {
                                                    const maxZ = Math.max(...decorations.map(d => d.zIndex), 0);
                                                    updateDecoration(deco.id, { zIndex: maxZ + 1 });
                                                }}
                                                    className="px-3 py-1.5 text-[10px] font-bold rounded-lg bg-white text-slate-400 border border-slate-200 active:scale-95 transition-all">
                                                    置頂
                                                </button>
                                                <button onClick={() => updateDecoration(deco.id, { zIndex: 0 })}
                                                    className="px-3 py-1.5 text-[10px] font-bold rounded-lg bg-white text-slate-400 border border-slate-200 active:scale-95 transition-all">
                                                    置底
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                            {/* Clear all button */}
                            <button onClick={() => { updateTheme({ desktopDecorations: [] }); setEditingDecoId(null); }}
                                className="w-full py-2 text-xs font-bold text-red-400 bg-red-50 rounded-xl hover:bg-red-100 transition-colors mt-2">
                                清空所有裝飾
                            </button>
                        </div>
                    )}
                    <div className="text-[10px] text-slate-400 mt-3 px-1">提示: 裝飾會疊加顯示在桌面第二頁上，可自由調節每個裝飾的位置、大小、旋轉和透明度。支持上傳自定義圖片或使用預設貼紙。</div>
                </section>
            </>
        ) : activeTab === 'icons' ? (
            <div className="space-y-5">
              <AppIconEditor />
              <section className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-700">保留透明圖標原輪廓</div>
                    <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">開啟後按圖片原輪廓完整顯示，不套系統圓角底框；默認關閉。</div>
                  </div>
                  <button
                    onClick={() => updateTheme({ preserveCustomIconOutlines: !theme.preserveCustomIconOutlines })}
                    className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${theme.preserveCustomIconOutlines ? 'bg-primary' : 'bg-slate-200'}`}
                    aria-label="保留透明圖標原輪廓"
                  >
                    <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${theme.preserveCustomIconOutlines ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              </section>
              <div className="grid grid-cols-3 gap-4">
                {INSTALLED_APPS.map(app => {
                    const Icon = Icons[app.icon];
                    const customUrl = customIcons[app.id];
                    const preserveOutline = !!customUrl && theme.preserveCustomIconOutlines === true;
                    return (
                        <div key={app.id} className="flex flex-col items-center gap-2">
                              <div
                                className={`w-16 h-16 relative group cursor-pointer ${preserveOutline ? '' : 'rounded-2xl shadow-sm bg-slate-200 overflow-hidden'}`}
                                onClick={() => { setSelectedAppId(app.id); iconInputRef.current?.click(); }}
                              >
                                  {customUrl ? (
                                     <CustomIconImage value={customUrl} alt={`${app.name} 自定義圖標`} preserveOutline={preserveOutline} />
                                  ) : (
                                     <div className={`w-full h-full ${app.color} flex items-center justify-center text-white`}>
                                         <Icon className="w-8 h-8" />
                                     </div>
                                 )}
                                 <div className="absolute inset-0 rounded-2xl bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                     <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6 text-white"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>
                                 </div>
                             </div>
                             <span className="text-[10px] text-slate-500 font-medium">{app.name}</span>
                             {customUrl && (
                                 <button onClick={() => setCustomIcon(app.id, undefined)} className="text-[10px] text-red-400">重置</button>
                             )}
                        </div>
                    );
                })}
                <input type="file" ref={iconInputRef} className="hidden" accept="image/*" onChange={(e) => e.target.files?.[0] && handleIconUpload(e.target.files[0])} />
              </div>
            </div>
        ) : activeTab === 'presets' ? (
            <PresetManager
                presets={appearancePresets}
                onSave={saveAppearancePreset}
                onApply={applyAppearancePreset}
                onDelete={deleteAppearancePreset}
                onRename={renameAppearancePreset}
                onExport={exportAppearancePreset}
                onImport={importAppearancePreset}
                addToast={addToast}
                currentTheme={theme}
            />

        ) : null}
      </div>
    </div>
  );
};

export default Appearance;
