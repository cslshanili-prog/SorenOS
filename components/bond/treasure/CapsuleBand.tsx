/**
 * 留給以後的封條與小牌子（plans/bond-batch5.md 0.1，照樣張）：信封外一圈「留 給 以 後」封條、掛一張小牌子（封面那句、還有幾天）。
 * 放進 Envelope 的 band 槽；信封加 className 'capsule'（到期 'due'、撕開 'torn'）。到期封條微微發亮；撕開＝封條裂成兩半飛走。
 */
import React from 'react';

export const CapsuleBand: React.FC<{ cover?: string; when: string; due?: boolean; locked?: boolean }> = ({ cover, when, due, locked }) => (
    <>
        <div className="cap-band" aria-hidden="true"><span className="bl">留 給 以</span><span className="br">後</span></div>
        <div className="cap-tag">
            {cover ? <div className="cap-cover">{cover}</div> : null}
            <div className={`cap-when ${due ? 'is-due' : ''}`}>{locked && !due ? <span className="cap-lock" /> : null}{when}</div>
        </div>
    </>
);

export const CAPSULE_CSS = `
.bond-env .cap-band { position: absolute; left: -6px; right: -6px; top: 104px; height: 30px; z-index: 6; display: flex; }
.bond-env .cap-band span { flex: 1; background: repeating-linear-gradient(45deg, #e6d8c4 0 8px, #efe3d1 8px 16px);
  border-top: 1px solid rgba(140,74,82,.25); border-bottom: 1px solid rgba(140,74,82,.25);
  transition: transform .5s cubic-bezier(.5,0,.6,1), opacity .5s; display: grid; align-content: center;
  font-family: 'Noto Serif TC', serif; font-size: 10px; letter-spacing: .25em; color: #8c4a52; }
.bond-env .cap-band .bl { text-align: right; padding-right: 16px; clip-path: polygon(0 0, 100% 0, 94% 50%, 100% 100%, 0 100%); }
.bond-env .cap-band .br { padding-left: 10px; clip-path: polygon(6% 0, 100% 0, 100% 100%, 6% 100%, 0 50%); margin-left: -6%; }
.bond-env.torn .cap-band .bl { transform: translate(-60px, 18px) rotate(-14deg); opacity: 0; }
.bond-env.torn .cap-band .br { transform: translate(60px, 22px) rotate(12deg); opacity: 0; }
.bond-env .cap-tag { position: absolute; z-index: 7; right: -4px; top: 132px; width: 128px; transform-origin: 70% 0; transform: rotate(5deg);
  background: #f1e6d4; border: 1px solid #dccbb2; border-radius: 6px 6px 10px 10px; padding: 14px 10px 10px;
  font-family: 'Noto Serif TC', serif; font-size: 11.5px; color: #463f3a; text-align: center; box-shadow: 0 6px 14px -10px rgba(70,63,58,.6); transition: opacity .4s; }
.bond-env .cap-tag::before { content: ""; position: absolute; top: 5px; left: calc(50% - 4px); width: 8px; height: 8px; border-radius: 50%; background: #f6f1e9; border: 1px solid #c9b494; }
.bond-env .cap-cover { line-height: 1.5; word-break: break-word; }
.bond-env .cap-when { font-size: 10px; letter-spacing: .1em; color: #a1958c; margin-top: 6px; font-family: var(--app-font, sans-serif); }
.bond-env .cap-when.is-due { color: #8c4a52; font-weight: 700; }
.bond-env.due .cap-band span { animation: bondCapGlow 2.4s ease-in-out infinite; }
@keyframes bondCapGlow { 50% { box-shadow: 0 0 14px 2px rgba(201,165,162,.75); } }
.bond-env.torn .cap-tag { opacity: 0; }
.bond-env .cap-lock { display: inline-block; width: 8px; height: 6px; border: 1.3px solid currentColor; border-radius: 1px; position: relative; margin-right: 4px; vertical-align: 0; }
.bond-env .cap-lock::before { content: ""; position: absolute; left: 1px; top: -5px; width: 4px; height: 5px; border: 1.3px solid currentColor; border-bottom: 0; border-radius: 3px 3px 0 0; }
@media (prefers-reduced-motion: reduce) {
  .bond-env .cap-band span { transition: opacity .3s !important; transform: none !important; animation: none !important; }
}
`;
