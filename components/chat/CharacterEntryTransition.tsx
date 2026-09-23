import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBlobRefUrl } from '../../utils/blobRef';

// 角色切換「登場」過場 —— 不是換頁/換 tab，而是「離開一個人，走進另一個人的空間」。
// 設計：以「即將見到的這個人」的頭像虛化鋪底（ta 的色彩世界），中心頭像帶柔光浮現 + 名字升起 → 推進穿過進入聊天。
//
// 性能要點（修「數據多時卡頓 + 頭像沒看清就進聊天」）：
//   · 全程只動 transform / opacity —— 這兩類走合成器線程，主線程再忙（進聊天要掛載大量帶圖消息）也不掉幀；
//     絕不動畫化 filter:blur（每幀重柵格化，是之前卡頓的真兇）。虛化底圖的 blur 是靜態的，只柵格化一次。
//   · 時間軸：頭像先快速「對焦清晰」（縮放+淡入，非模糊），清晰後明確停留一拍讓人看清臉與名字，再退場。
// 可輕觸跳過；尊重 prefers-reduced-motion；內聯 @keyframes（CDN Tailwind 不可靠生成自定義 animate-*）。

interface Props {
  name: string;
  avatar?: string;
  /** 過場播完（或被跳過）後回調，由父組件卸載本層。 */
  onDone: () => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const CharacterEntryTransition: React.FC<Props> = ({ name, avatar, onDone }) => {
  const reduced = useMemo(prefersReducedMotion, []);
  // 頭像約 650ms 對焦清晰、名字約 780ms 到位 → 停留到 REVEAL_AT 讓人看清，再退場。
  const REVEAL_AT = reduced ? 220 : 1000; // 開始退場的時刻（清晰後的停留終點）
  const EXIT = reduced ? 200 : 440;       // 退場（推進穿過 + 淡出）時長
  const TOTAL = REVEAL_AT + EXIT;

  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);
  const finish = () => { if (!doneRef.current) { doneRef.current = true; onDone(); } };

  useEffect(() => {
    const tExit = setTimeout(() => setExiting(true), REVEAL_AT);
    const tDone = setTimeout(finish, TOTAL);
    return () => { clearTimeout(tExit); clearTimeout(tDone); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 輕觸跳過：立刻進入退場（仍是平滑推進，不是硬切）
  const skip = () => { if (!exiting) { setExiting(true); window.setTimeout(finish, EXIT); } };

  // 頭像字段可能是 blobref 令牌，令牌拼進 url() 是加載不出來的地址。先解析成可用地址再拼，
  // 判空也看解析結果——否則「沒頭像時改用主題色光場」那條分支永遠走不到，整層過場會變成
  // 一張透明膜，底下的聊天界面直接透出來。令牌解析完成前 resolvedAvatar 是 undefined，
  // 那一幀走光場分支，照樣鋪滿蓋住聊天。
  const resolvedAvatar = useBlobRefUrl(avatar);
  const avatarBg = resolvedAvatar ? `url(${resolvedAvatar})` : '';

  return (
    <div
      onClick={skip}
      aria-hidden
      className="absolute inset-0 z-[140] overflow-hidden flex items-center justify-center cursor-pointer"
      style={{ opacity: exiting ? 0 : 1, transition: `opacity ${EXIT}ms ease-in`, willChange: 'opacity' }}
    >
      <style>{`
        @keyframes charVeilIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes charAvatarIn { 0% { opacity:0; transform: translateY(12px) scale(.84) } 100% { opacity:1; transform: translateY(0) scale(1) } }
        @keyframes charGlowIn { 0% { opacity:0; transform: translate(-50%,-50%) scale(.6) } 45% { opacity:.85 } 100% { opacity:.6; transform: translate(-50%,-50%) scale(1) } }
        @keyframes charNameIn { from { opacity:0; transform: translateY(12px) } to { opacity:1; transform: translateY(0) } }
        @keyframes charLineIn { from { opacity:0; transform: scaleX(0) } to { opacity:.7; transform: scaleX(1) } }
      `}</style>

      {/* 氛圍底：虛化頭像 = ta 的色彩世界（靜態 blur，只柵格化一次）。
          關鍵：不做淡入 —— showEntry 一為真就「立刻」鋪滿蓋住聊天，否則透明期會透出底下聊天界面，
          變成「聊天先閃一下，過場才淡進來」的本末倒置。無頭像時回退主題色光場。 */}
      {avatarBg ? (
        <div className="absolute inset-0 bg-cover bg-center" style={{
          background: avatarBg, backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(26px)', transform: 'scale(1.16)',
        }} />
      ) : (
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(120% 100% at 50% 40%, hsla(var(--primary-hue),55%,40%,0.9), #0c0b1e 70%)',
        }} />
      )}
      {/* 壓暗 + 暗角：讓中心頭像與名字清晰浮出（靜態） */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(115% 95% at 50% 42%, rgba(8,8,18,0.35) 30%, rgba(6,6,16,0.78) 100%)' }} />

      {/* 中心內容：退場時只對這層（無 filter，縮放廉價）做推進穿過；虛化底圖隨根層淡出即可。 */}
      <div
        className="relative flex flex-col items-center px-8"
        style={{
          transform: exiting ? 'scale(1.14)' : 'scale(1)',
          transition: `transform ${EXIT}ms cubic-bezier(0.4,0,0.2,1)`,
          willChange: 'transform',
        }}
      >
        <div className="relative" style={{ width: 132, height: 132 }}>
          {/* 柔光暈（在頭像後綻放） */}
          <div className="absolute" style={{
            left: '50%', top: '50%', width: 230, height: 230, transform: 'translate(-50%,-50%)',
            borderRadius: '9999px', filter: 'blur(8px)',
            background: 'radial-gradient(circle, rgba(255,255,255,0.5) 0%, hsla(var(--primary-hue),80%,80%,0.32) 40%, transparent 66%)',
            animation: reduced ? 'charVeilIn 240ms ease-out both' : 'charGlowIn 680ms cubic-bezier(0.22,1,0.36,1) 40ms both',
          }} />
          {/* 頭像：縮放 + 淡入「對焦」，不用 filter:blur（避免每幀重柵格化卡頓） */}
          <div
            className="absolute inset-0 rounded-full bg-cover bg-center"
            style={{
              backgroundImage: avatarBg || undefined,
              backgroundColor: avatarBg ? undefined : 'hsla(var(--primary-hue),50%,55%,0.6)',
              boxShadow: '0 8px 40px rgba(0,0,0,0.45), 0 0 0 1.5px rgba(255,255,255,0.5), 0 0 28px hsla(var(--primary-hue),80%,80%,0.45)',
              animation: reduced ? 'charVeilIn 280ms ease-out both' : 'charAvatarIn 560ms cubic-bezier(0.22,1,0.36,1) 90ms both',
              willChange: 'transform, opacity',
            }}
          />
        </div>
        <div
          className="mt-5 text-white text-2xl font-medium tracking-wide"
          style={{
            textShadow: '0 2px 18px rgba(0,0,0,0.5), 0 0 24px hsla(var(--primary-hue),80%,80%,0.3)',
            animation: reduced ? 'charNameIn 300ms ease-out both' : 'charNameIn 480ms cubic-bezier(0.22,1,0.36,1) 320ms both',
          }}
        >
          {name}
        </div>
        <div className="mt-3 h-px w-20" style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)',
          transformOrigin: 'center',
          animation: reduced ? 'charVeilIn 300ms ease-out both' : 'charLineIn 540ms ease-out 420ms both',
        }} />
      </div>
    </div>
  );
};

export default CharacterEntryTransition;
