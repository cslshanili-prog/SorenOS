/**
 * 桌面 Dock 的樣式（外觀 → Dock）。存在 OSTheme.dockStyle／dockCustom，跟著主題、外觀預設、完整備份走。
 *
 * - glass（預設，沒設也是它）：原本那條 Liquid Glass 膠囊；紙感桌布、動森皮膚照舊用各自的版本
 * - none：無膠囊，只有圖示
 * - custom：自己調底色（含透明度）、模糊、圓角、邊框、陰影，也能放一張底圖（blobref 令牌）
 *
 * 純函式，桌面和外觀頁的預覽共用，畫出來才會一樣。
 */

import type React from 'react';

export type DockStyleKind = 'glass' | 'none' | 'custom';

export interface DockCustomStyle {
    /** 底色 #rrggbb */
    color: string;
    /** 底色不透明度 0～100 */
    opacity: number;
    /** 背景模糊 px，0～40 */
    blur: number;
    /** 圓角 px，0～40 */
    radius: number;
    borderColor: string;
    /** 邊框粗細 px，0～3 */
    borderWidth: number;
    shadow: boolean;
    /** 底圖（blobref 令牌或網址）；有圖時底色當作疊在圖上的那層 */
    image?: string;
}

export const DEFAULT_DOCK_CUSTOM: DockCustomStyle = {
    color: '#ffffff',
    opacity: 30,
    blur: 16,
    radius: 28,
    borderColor: '#ffffff',
    borderWidth: 1,
    shadow: true,
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** 存進來的值可能缺欄位或被手改壞，一律補齊、夾在範圍裡 */
export const normalizeDockCustom = (raw: Partial<DockCustomStyle> | undefined): DockCustomStyle => ({
    color: isHex(raw?.color) ? raw!.color : DEFAULT_DOCK_CUSTOM.color,
    opacity: clamp(raw?.opacity, 0, 100, DEFAULT_DOCK_CUSTOM.opacity),
    blur: clamp(raw?.blur, 0, 40, DEFAULT_DOCK_CUSTOM.blur),
    radius: clamp(raw?.radius, 0, 40, DEFAULT_DOCK_CUSTOM.radius),
    borderColor: isHex(raw?.borderColor) ? raw!.borderColor : DEFAULT_DOCK_CUSTOM.borderColor,
    borderWidth: clamp(raw?.borderWidth, 0, 3, DEFAULT_DOCK_CUSTOM.borderWidth),
    shadow: typeof raw?.shadow === 'boolean' ? raw.shadow : DEFAULT_DOCK_CUSTOM.shadow,
    ...(typeof raw?.image === 'string' && raw.image ? { image: raw.image } : {}),
});

export const hexToRgba = (hex: string, alpha: number) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(alpha * 1000) / 1000})`;
};

const GLASS_CLASS = 'bg-white/30 border border-white/25 shadow-[0_8px_40px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.08)]';

/**
 * Dock 外框的 class 和 style。imageUrl 是 custom.image 解析出來能直接用的網址（呼叫端用 useBlobRefUrl 解）。
 */
export const dockContainerLook = (
    kind: DockStyleKind | undefined,
    custom: Partial<DockCustomStyle> | undefined,
    opts: { acnh?: boolean; paper?: boolean; imageUrl?: string } = {},
): { className: string; style: React.CSSProperties | undefined } => {
    if (kind === 'none') return { className: '', style: { background: 'transparent' } };
    if (kind === 'custom') {
        const c = normalizeDockCustom(custom);
        const tint = hexToRgba(c.color, c.opacity / 100);
        const style: React.CSSProperties = {
            background: opts.imageUrl ? `linear-gradient(${tint}, ${tint}), center / cover no-repeat url("${opts.imageUrl}")` : tint,
            borderRadius: c.radius,
            border: c.borderWidth ? `${c.borderWidth}px solid ${hexToRgba(c.borderColor, 0.45)}` : 'none',
            boxShadow: c.shadow ? '0 8px 30px rgba(0,0,0,0.22)' : 'none',
        };
        if (c.blur) {
            style.backdropFilter = `blur(${c.blur}px)`;
            style.WebkitBackdropFilter = `blur(${c.blur}px)`;
        }
        return { className: '', style };
    }
    // glass／沒設：照原本各皮膚的樣子
    if (opts.acnh) return { className: '', style: { background: 'transparent' } };
    if (opts.paper) {
        return {
            className: '',
            style: { background: 'rgba(224,221,215,0.42)', border: '1px solid rgba(91,72,51,0.07)', boxShadow: '0 6px 18px rgba(91,72,51,0.065)' },
        };
    }
    return { className: GLASS_CLASS, style: undefined };
};
