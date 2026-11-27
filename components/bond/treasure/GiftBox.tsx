/**
 * 禮物盒（plans/bond-batch5.md 0.1）：程式畫的 SVG，盒身、盒蓋、緞帶與蝴蝶結分層，
 * open 時蝴蝶結鬆開飄走、緞帶淡掉、盒蓋滑到旁邊、裡面的東西（children）浮上來。
 * 包裝紙五種、緞帶四色；每件照 key 固定一款（utils/bond/gift.ts 的 giftWrapFor）。
 * 動畫照「減少動態效果」退成淡入淡出（CSS 在 bondUi 的 BOND_CSS）。
 */
import React, { useId } from 'react';
import type { GiftRibbon, GiftWrap } from '../../../utils/bond/gift';

export const RIBBON_COLORS: Record<GiftRibbon, { c: string; d: string; label: string }> = {
    wine: { c: '#8c4a52', d: '#6e3740', label: '酒紅' },
    cream: { c: '#f4ece0', d: '#d9ccb9', label: '米白' },
    moss: { c: '#55654f', d: '#3f4d3a', label: '墨綠' },
    gold: { c: '#c39a55', d: '#9c7a3f', label: '金' },
};
export const WRAP_LABEL: Record<GiftWrap, string> = { stripe: '條紋', dots: '點點', kraft: '牛皮紙', check: '格紋', solid: '素色' };

const WrapPattern: React.FC<{ id: string; wrap: GiftWrap }> = ({ id, wrap }) => {
    switch (wrap) {
        case 'stripe':
            return <pattern id={id} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="14" height="14" fill="#f1e2dc" /><rect width="6" height="14" fill="#d9b2ac" /></pattern>;
        case 'dots':
            return <pattern id={id} width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#f3ebe0" /><circle cx="4" cy="4" r="2.2" fill="#c9a5a2" /><circle cx="12" cy="12" r="2.2" fill="#c9a5a2" /></pattern>;
        case 'kraft':
            return <pattern id={id} width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#c8a47c" /><path d="M0 3h10M0 8h10" stroke="#b8956e" strokeWidth=".6" opacity=".6" /></pattern>;
        case 'check':
            return <pattern id={id} width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#e9eee7" /><rect width="8" height="8" fill="#c9d3c4" /><rect x="8" y="8" width="8" height="8" fill="#c9d3c4" /></pattern>;
        default:
            return <pattern id={id} width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#8c4a52" /></pattern>;
    }
};

export const GiftBox: React.FC<{
    wrap: GiftWrap;
    ribbon: GiftRibbon;
    /** 寬（高照比例）；圖鑑格子小、詳細頁大 */
    size?: number;
    open?: boolean;
    /** 打算送：淡一點 */
    faded?: boolean;
    /** 拆開時浮上來的東西 */
    children?: React.ReactNode;
    className?: string;
}> = ({ wrap, ribbon, size = 220, open = false, faded = false, children, className }) => {
    const pid = `gw-${useId().replace(/:/g, '')}`;
    const r = RIBBON_COLORS[ribbon];
    const fill = `url(#${pid})`;
    return (
        <div className={`bond-giftbox${open ? ' is-open' : ''} ${className || ''}`} style={{ width: size, height: size * 240 / 220, opacity: faded ? 0.55 : 1 }}>
            <svg viewBox="0 0 220 240" aria-hidden="true" className="bond-giftbox-layer">
                <defs><WrapPattern id={pid} wrap={wrap} /></defs>
                <ellipse cx="110" cy="218" rx="86" ry="8" fill="#463f3a" opacity=".12" />
            </svg>
            {children !== undefined && <div className="bond-giftbox-item">{children}</div>}
            <svg viewBox="0 0 220 240" aria-hidden="true" className="bond-giftbox-layer" style={{ zIndex: 3 }}>
                <rect x="34" y="96" width="152" height="118" rx="3" fill={fill} />
                <rect x="34" y="96" width="152" height="12" fill="#000" opacity=".07" />
                <rect className="gb-band" x="100" y="96" width="20" height="118" fill={r.c} />
                <rect className="gb-band" x="100" y="96" width="3" height="118" fill={r.d} opacity=".35" />
            </svg>
            <svg viewBox="0 0 220 240" aria-hidden="true" className="bond-giftbox-layer" style={{ zIndex: 4, overflow: 'visible' }}>
                <g className="gb-lid">
                    <rect x="26" y="70" width="168" height="32" rx="3" fill={fill} />
                    <rect x="26" y="96" width="168" height="6" fill="#000" opacity=".1" />
                    <rect className="gb-band" x="100" y="70" width="20" height="32" fill={r.c} />
                </g>
                <g className="gb-bow">
                    <path d="M110 70 C 84 38, 58 46, 66 64 C 72 76, 96 74, 110 70Z" fill={r.c} stroke={r.d} strokeWidth="1.2" />
                    <path d="M110 70 C 136 38, 162 46, 154 64 C 148 76, 124 74, 110 70Z" fill={r.c} stroke={r.d} strokeWidth="1.2" />
                    <path d="M104 72 L92 100 L100 97 L104 104Z" fill={r.c} stroke={r.d} strokeWidth="1" />
                    <path d="M116 72 L128 100 L120 97 L116 104Z" fill={r.c} stroke={r.d} strokeWidth="1" />
                    <rect x="102" y="62" width="16" height="15" rx="4" fill={r.d} />
                </g>
            </svg>
        </div>
    );
};

/** 禮物盒的動畫（接在 BOND_CSS 後面） */
export const GIFTBOX_CSS = `
.bond-giftbox { position: relative; }
.bond-giftbox-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
.bond-giftbox .gb-lid { transition: transform .7s cubic-bezier(.3,.1,.2,1) .35s; transform-origin: 110px 80px; }
.bond-giftbox .gb-bow { transition: transform .5s ease-in, opacity .5s ease-in; transform-origin: 110px 64px; }
.bond-giftbox .gb-band { transition: opacity .4s ease-in .2s; }
.bond-giftbox.is-open .gb-bow { transform: translateY(-26px) scale(1.25) rotate(-8deg); opacity: 0; }
.bond-giftbox.is-open .gb-band { opacity: 0; }
.bond-giftbox.is-open .gb-lid { transform: translate(96px, 40px) rotate(64deg); }
.bond-giftbox-item {
  position: absolute; left: -30%; right: -30%; top: 50%; z-index: 2; text-align: center; opacity: 0;
  transition: transform .8s cubic-bezier(.2,.8,.2,1) .9s, opacity .5s ease .9s;
}
.bond-giftbox.is-open .bond-giftbox-item { opacity: 1; transform: translateY(-88%); z-index: 6; }
@media (prefers-reduced-motion: reduce) {
  .bond-giftbox .gb-lid, .bond-giftbox .gb-bow, .bond-giftbox .gb-band, .bond-giftbox-item { transition: opacity .3s !important; transform: none !important; }
  .bond-giftbox.is-open .gb-lid { opacity: 0; }
}
`;
