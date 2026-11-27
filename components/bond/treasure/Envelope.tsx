/**
 * 信封與蠟封（plans/bond-batch5.md 0.1，照 Liora 看過的樣張）：背面、信紙、前面口袋、封口蓋四層；
 * 拆開＝蠟封裂成兩半掉下 → 封口往上掀（尖角朝上）→ 信紙滑出。減少動態效果時只淡入淡出。
 * 300×200 的原尺寸，用 scale 縮放（清單上的小信封）。
 */
import React, { useId } from 'react';
import { letterPaper, WAX_COLORS, type WaxColor } from '../../../utils/bond/letter';

export type EnvelopeStage = 'closed' | 'cracked' | 'open' | 'out';

const sealPath = (() => {
    let d = '';
    const n = 22;
    for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = 21 + (i % 2 ? 2.4 : 0) + Math.sin(i * 1.7) * 0.8;
        d += (i ? 'L' : 'M') + (24 + Math.cos(a) * r).toFixed(1) + ' ' + (24 + Math.sin(a) * r).toFixed(1);
    }
    return `${d}Z`;
})();

/** 蠟封：左右兩半各一個 clipPath，裂開時各飛一邊 */
export const WaxSeal: React.FC<{ color: WaxColor; initial: string; className?: string }> = ({ color, initial, className = '' }) => {
    const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
    const w = WAX_COLORS[color] || WAX_COLORS.wine;
    const face = (
        <>
            <path d={sealPath} fill={w.c} />
            <circle cx="24" cy="24" r="14.5" fill="none" stroke={w.d} strokeWidth="1.4" />
            <circle cx="24" cy="24" r="12.5" fill={w.d} opacity=".18" />
            <text x="24" y="29.5" textAnchor="middle" fontFamily="'Noto Serif TC', serif" fontSize="15" fontWeight="600" fill={w.d} opacity=".9">{initial}</text>
            <path d="M14 13 q6 -5 13 -4" stroke="#fff" strokeOpacity=".28" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
    );
    return (
        <div className={`bond-seal ${className}`} aria-hidden="true">
            <svg className="half l" viewBox="0 0 48 48"><defs><clipPath id={`cl${uid}`}><path d="M0 0H25L21 15 27 26 22 48H0Z" /></clipPath></defs><g clipPath={`url(#cl${uid})`}>{face}</g></svg>
            <svg className="half r" viewBox="0 0 48 48"><defs><clipPath id={`cr${uid}`}><path d="M25 0H48V48H22L27 26 21 15Z" /></clipPath></defs><g clipPath={`url(#cr${uid})`}>{face}</g></svg>
        </div>
    );
};

export const Envelope: React.FC<{
    paperStyle?: string;
    wax: WaxColor;
    /** 蠟封中間那個字（寫信人名字的第一個字） */
    initial: string;
    stage?: EnvelopeStage;
    /** 慢寄在路上：郵戳上的字（「寄出中・預計 11/29」） */
    postmark?: string;
    /** 信紙露出來那塊寫的抬頭（「給你」） */
    heading?: string;
    scale?: number;
    /** 留給以後（5c）：信封外一圈封條 */
    band?: React.ReactNode;
    className?: string;
    onClick?: () => void;
}> = ({ paperStyle, wax, initial, stage = 'closed', postmark, heading, scale = 1, band, className = '', onClick }) => {
    const p = letterPaper(paperStyle);
    const cls = ['bond-env', stage !== 'closed' ? 'cracked' : '', stage === 'open' || stage === 'out' ? 'open' : '', stage === 'out' ? 'out' : '', className].filter(Boolean).join(' ');
    const widths = [92, 100, 86, 97, 74, 90, 46];
    const inner = (
        <div className={cls} style={{ '--env': p.envelope } as React.CSSProperties} onClick={onClick} role={onClick ? 'button' : undefined}>
            <div className="back" />
            <div className="sheet" style={{ background: p.bg, color: p.ink, backgroundImage: p.line || undefined, backgroundSize: p.size || undefined }}>
                {heading && <div className="head">{heading}</div>}
                {widths.map((w, i) => <div key={i} className="ln" style={{ width: `${w}%` }} />)}
            </div>
            <svg className="pocket" viewBox="0 0 300 200" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0 0 L150 112 L0 200Z" fill={p.pocket} />
                <path d="M300 0 L150 112 L300 200Z" fill={p.pocket} />
                <path d="M0 200 L150 96 L300 200Z" fill={p.envelope} />
                <path d="M0 200 L150 96 L300 200" fill="none" stroke="rgba(0,0,0,.06)" />
            </svg>
            <div className="flap">
                <svg viewBox="0 0 300 118" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0 H300 L158 112 Q150 118 142 112 Z" fill={p.flap} /><path d="M0 0 L142 112 Q150 118 158 112 L300 0" fill="none" stroke="rgba(0,0,0,.07)" /></svg>
                <svg className="inner" viewBox="0 0 300 118" preserveAspectRatio="none" aria-hidden="true"><path d="M0 118 H300 L158 6 Q150 0 142 6 Z" fill={p.pocket} /><path d="M0 118 L142 6 Q150 0 158 6 L300 118" fill="none" stroke="rgba(0,0,0,.07)" /></svg>
            </div>
            <WaxSeal color={wax} initial={initial} className="seal" />
            {band}
            {postmark && <div className="postmark" style={{ color: (WAX_COLORS[wax] || WAX_COLORS.wine).c }}>{postmark.split('\n').map((l, i) => <div key={i}>{l}</div>)}</div>}
        </div>
    );
    if (scale === 1) return inner;
    return (
        <div style={{ width: 300 * scale, height: 200 * scale }} className="relative shrink-0">
            <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0 }}>{inner}</div>
        </div>
    );
};

export const ENVELOPE_CSS = `
.bond-env { width: 300px; height: 200px; position: relative; perspective: 900px; }
.bond-env .back, .bond-env .pocket, .bond-env .flap, .bond-env .sheet, .bond-env .seal { position: absolute; }
.bond-env .back { inset: 0; border-radius: 6px; background: var(--env); box-shadow: 0 10px 24px -14px rgba(70,63,58,.45); }
.bond-env .sheet { left: 16px; right: 16px; top: 12px; height: 172px; border-radius: 4px; z-index: 2; box-shadow: 0 1px 2px rgba(0,0,0,.08);
  transition: transform .8s cubic-bezier(.2,.7,.2,1) .15s; padding: 18px 20px; font-family: 'Noto Serif TC', serif; font-size: 11px; overflow: hidden; }
.bond-env .sheet .head { opacity: .7; letter-spacing: .15em; }
.bond-env .sheet .ln { height: 6px; border-radius: 3px; background: currentColor; opacity: .16; margin: 9px 0; }
.bond-env .pocket { inset: 0; z-index: 3; pointer-events: none; }
.bond-env .flap { left: 0; top: 0; width: 300px; height: 118px; z-index: 4; transform-origin: 50% 0; transform-style: preserve-3d;
  transition: transform .6s cubic-bezier(.4,.1,.3,1), z-index 0s .3s; }
.bond-env .flap svg { position: absolute; inset: 0; width: 100%; height: 100%; backface-visibility: hidden; }
.bond-env .flap .inner { transform: rotateX(180deg); }
.bond-env .seal { left: calc(50% - 24px); top: 92px; width: 48px; height: 48px; z-index: 5; }
.bond-seal { position: relative; width: 48px; height: 48px; }
.bond-seal .half { position: absolute; inset: 0; width: 100%; height: 100%; transition: transform .45s ease-in, opacity .45s ease-in; }
.bond-env.cracked .seal .l { transform: translate(-16px, 26px) rotate(-28deg); opacity: 0; }
.bond-env.cracked .seal .r { transform: translate(16px, 30px) rotate(24deg); opacity: 0; }
.bond-env.open .flap { transform: rotateX(180deg); z-index: 1; }
.bond-env.out .sheet { transform: translateY(-118px); }
.bond-env .postmark { position: absolute; right: 18px; bottom: 14px; z-index: 6; font-family: 'Noto Serif TC', serif; font-size: 10px; letter-spacing: .15em;
  border: 1.5px solid currentColor; border-radius: 50%; width: 64px; height: 64px; display: grid; place-content: center; text-align: center; line-height: 1.3; transform: rotate(-12deg); opacity: .75; }
.bond-letter-sheet { border-radius: 6px; padding: 30px 26px 26px; font-family: 'Noto Serif TC', serif; font-size: 15px; line-height: 2; box-shadow: 0 24px 60px -20px rgba(40,30,30,.45); animation: bondSheetIn .45s cubic-bezier(.2,.8,.2,1); white-space: pre-wrap; word-break: break-word; }
@keyframes bondSheetIn { from { transform: translateY(24px) scale(.96); opacity: 0 } to { transform: none; opacity: 1 } }
@media (prefers-reduced-motion: reduce) {
  .bond-env .flap, .bond-env .sheet, .bond-seal .half { transition: opacity .3s !important; transform: none !important; }
  .bond-letter-sheet { animation: none; }
}
`;
