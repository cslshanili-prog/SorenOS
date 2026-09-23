import React, { useEffect, useMemo, useRef, useState } from 'react';
import { trackEvent } from '../../utils/analytics';

// SullyOS 冷啟動「世界入場」電影化序列 —— 取代傳統黑屏 spinner。
// 目標：讓人覺得「進入了一個小世界」，而不是「在等一個 App 加載完」。
//   · 深空大氣場景 + 相機緩慢前推 + 漂浮塵埃/閃爍星點 + 核心柔光（呼吸）
//   · logo 從景深中浮現（遠→近對焦），隨後 tagline 與一道光線（UI 萌芽）
//   · 數據就緒 + 停留夠時長後，整場景「推進穿過」並淡出，無縫交還給鎖屏
// 設計取捨（呼應本項目對「動靜過多反而顯卡」的敏感）：
//   · 只在「本會話首次冷啟動」播放完整版；同會話刷新走極短版，不反覆佔用用戶
//   · 全程僅動 transform / opacity（GPU 友好）；數據沒加載完就持續呼吸等待，絕不出現 spinner
//   · 可輕觸跳過；尊重 prefers-reduced-motion
//   · 用內聯 @keyframes 而非 Tailwind 自定義 animate-*（CDN 版 Tailwind 不可靠生成自定義動畫類）

const BOOT_SEEN_KEY = 'sullyos_boot_seen_session';

interface Props {
  /** 數據是否已就緒（IndexedDB 加載完）。未就緒時場景持續呼吸等待，不退場。 */
  dataReady: boolean;
  /** 當前壁紙（url / data / blob / 漸變或顏色字符串 / 空）。開機場景以它為底「活過來」。 */
  wallpaper?: string;
  /** 退場動畫播完後回調，交還控制權給 PhoneShell。 */
  onDone: () => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ClassicBootSequence: React.FC<Props> = ({ dataReady, wallpaper, onDone }) => {
  // 壁紙解析：url/data/blob 走 url() 並虛化壓暗；漸變/顏色字符串直接當背景；空則回退深空漸變。
  const wp = wallpaper?.trim() || '';
  const wpIsImage = /^(https?:|data:|blob:|\.?\/)/.test(wp);
  const wpBackground = wp ? (wpIsImage ? `url(${wp})` : wp) : '';
  // 本會話是否首次看到開場：刷新頁面仍屬同 session → 走極短版。
  const firstThisSession = useMemo(() => {
    try { return !sessionStorage.getItem(BOOT_SEEN_KEY); } catch { return true; }
  }, []);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const cinematic = firstThisSession && !reduced;

  const HOLD = cinematic ? 2000 : 520; // 退場前最短停留（也是「等數據」的下限）
  const EXIT = cinematic ? 680 : 300;  // 推進式退場時長

  const [phase, setPhase] = useState<'enter' | 'exit'>('enter');
  const startRef = useRef(0);
  if (startRef.current === 0) {
    startRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  useEffect(() => {
    try { sessionStorage.setItem(BOOT_SEEN_KEY, '1'); } catch { /* ignore */ }
  }, []);

  // 「數據就緒 且 停留夠 HOLD」→ 退場；否則一直呼吸等待。
  useEffect(() => {
    if (phase === 'exit') return;
    let raf = 0;
    const tick = () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (dataReady && now - startRef.current >= HOLD) {
        setPhase('exit');
        // 只報區間不報精確毫秒。注意這裡的時長帶 HOLD 下限（完整版 2000ms / 極短版 520ms），
        // 真正有信息量的是 3-8s / 8s+ 這條尾巴 —— 數據加載慢才會落到那兒。
        const waited = now - startRef.current;
        trackEvent('冷启动等待数据就绪', {
          等待档位: waited < 1000 ? '<1s' : waited < 3000 ? '1-3s' : waited < 8000 ? '3-8s' : '8s+',
          开场版本: cinematic ? '完整版' : '极短版',
        });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dataReady, phase, HOLD]);

  // 退場動畫播完 → 交還控制權。
  useEffect(() => {
    if (phase !== 'exit') return;
    const t = setTimeout(onDone, EXIT);
    return () => clearTimeout(t);
  }, [phase, EXIT, onDone]);

  // 輕觸跳過：進入平滑退場（非硬切）。
  const skip = () => {
    if (phase !== 'exit') {
      setPhase('exit');
      trackEvent('跳过开机动画', {
        数据是否已就绪: dataReady ? '是' : '否',
        开场版本: cinematic ? '完整版' : '极短版',
      });
    }
  };

  // 漂浮塵埃（自下而上緩升）與閃爍星點（原地明滅）—— 僅完整版生成，只動 transform/opacity。
  const motes = useMemo(() =>
    cinematic ? Array.from({ length: 16 }, () => ({
      left: Math.random() * 100,
      size: 1.5 + Math.random() * 2.5,
      delay: -Math.random() * 12,
      dur: 11 + Math.random() * 9,
      sway: (Math.random() * 2 - 1) * 24,
      op: 0.25 + Math.random() * 0.45,
    })) : [], [cinematic]);
  const stars = useMemo(() =>
    cinematic ? Array.from({ length: 18 }, () => ({
      left: Math.random() * 100,
      top: Math.random() * 62,
      size: 1 + Math.random() * 1.8,
      delay: -Math.random() * 4,
      dur: 2.4 + Math.random() * 3,
      op: 0.4 + Math.random() * 0.5,
    })) : [], [cinematic]);

  const exiting = phase === 'exit';

  return (
    <div
      onClick={skip}
      aria-label="Soren"
      className="fixed inset-0 z-[9999] overflow-hidden select-none cursor-pointer"
      style={{
        background: '#05060f',
        opacity: exiting ? 0 : 1,
        transition: `opacity ${EXIT}ms ease-in`,
      }}
    >
      <style>{`
        @keyframes bootSceneIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes bootCamera { from { transform: scale(1) } to { transform: scale(1.06) } }
        @keyframes bootBloom { 0%,100% { opacity:.55; transform: translate(-50%,-50%) scale(1) } 50% { opacity:.85; transform: translate(-50%,-50%) scale(1.08) } }
        @keyframes bootRise { from { transform: translateY(8vh) translateX(0) } to { transform: translateY(-112vh) translateX(var(--sway,0px)) } }
        @keyframes bootTwinkle { 0%,100% { opacity:.15 } 50% { opacity:1 } }
        @keyframes bootLogoIn { 0% { opacity:0; transform: translateY(10px) scale(1.14); filter: blur(10px) } 60% { opacity:1 } 100% { opacity:1; transform: translateY(0) scale(1); filter: blur(0) } }
        @keyframes bootSoftIn { from { opacity:0; transform: translateY(8px) } to { opacity:.8; transform: translateY(0) } }
        @keyframes bootLineIn { from { opacity:0; transform: scaleX(0) } to { opacity:.6; transform: scaleX(1) } }
        @keyframes bootHintIn { from { opacity:0 } to { opacity:.45 } }
      `}</style>

      {/* 退場推進層：退場時整體放大並隨根層淡出，營造「相機穿過場景」 */}
      <div
        className="absolute inset-0"
        style={{
          transform: exiting ? 'scale(1.12)' : undefined,
          transition: exiting ? `transform ${EXIT}ms cubic-bezier(0.4,0,0.2,1)` : undefined,
          willChange: 'transform',
        }}
      >
        {/* 相機緩推層：完整版下場景緩慢前移 */}
        <div
          className="absolute inset-0"
          style={{ animation: cinematic ? 'bootCamera 6s ease-out forwards' : undefined, willChange: 'transform' }}
        >
          {/* 深空大氣底（無壁紙時的回退；有壁紙時也墊底，讓暗部仍有紫調景深） */}
          <div className="absolute inset-0" style={{
            animation: cinematic ? 'bootSceneIn 700ms ease-out both' : 'bootSceneIn 300ms ease-out both',
            background: 'radial-gradient(130% 120% at 50% 118%, #3a2766 0%, #1d1740 34%, #0c0b22 66%, #05060f 100%)',
          }} />
          {/* 壁紙層：以用戶壁紙為底「活過來」。圖片虛化壓暗 + 預放大遮住虛化邊；相機層再緩推。 */}
          {wpBackground && (
            <>
              <div className="absolute inset-0 bg-cover bg-center" style={{
                background: wpBackground,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                filter: wpIsImage ? 'blur(10px)' : 'none',
                transform: wpIsImage ? 'scale(1.14)' : undefined,
                animation: cinematic ? 'bootSceneIn 700ms ease-out both' : 'bootSceneIn 300ms ease-out both',
              }} />
              {/* 壓暗 scrim：保證柔光/塵埃/logo 在任意壁紙上都清晰可讀 */}
              <div className="absolute inset-0" style={{ background: 'rgba(6,7,18,0.5)' }} />
            </>
          )}
          {/* 星雲疊加：紫 + 青雙光源（screen 混合，輕輕暈染壁紙，與整套世界觀統一） */}
          <div className="absolute inset-0" style={{
            mixBlendMode: 'screen',
            background: 'radial-gradient(70% 55% at 72% 22%, rgba(139,108,232,0.30), transparent 60%), radial-gradient(64% 48% at 22% 32%, rgba(64,150,210,0.20), transparent 62%)',
          }} />
          {/* 核心柔光（呼吸）—— logo 所在處的光源 */}
          <div className="absolute" style={{
            left: '50%', top: '42%', width: '120vw', height: '120vw', maxWidth: 900, maxHeight: 900,
            transform: 'translate(-50%,-50%)',
            background: 'radial-gradient(circle, rgba(168,150,255,0.45) 0%, rgba(120,110,220,0.16) 32%, transparent 60%)',
            animation: cinematic ? 'bootBloom 5.5s ease-in-out infinite' : undefined,
            opacity: cinematic ? undefined : 0.6,
          }} />

          {/* 漂浮塵埃 */}
          {motes.map((p, i) => (
            <span key={`m${i}`} className="absolute rounded-full" style={{
              left: `${p.left}%`, bottom: 0, width: p.size, height: p.size,
              ['--sway' as any]: `${p.sway}px`,
              background: 'radial-gradient(circle, rgba(214,205,255,0.95), rgba(214,205,255,0) 70%)',
              opacity: p.op,
              animation: `bootRise ${p.dur}s linear ${p.delay}s infinite`,
              willChange: 'transform',
            }} />
          ))}
          {/* 閃爍星點 */}
          {stars.map((s, i) => (
            <span key={`s${i}`} className="absolute rounded-full" style={{
              left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size,
              background: 'rgba(255,255,255,0.95)',
              boxShadow: '0 0 6px rgba(190,200,255,0.8)',
              opacity: s.op,
              animation: `bootTwinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
            }} />
          ))}

          {/* 暗角，聚焦中心 */}
          <div className="absolute inset-0" style={{
            background: 'radial-gradient(125% 100% at 50% 44%, transparent 52%, rgba(0,0,0,0.6) 100%)',
          }} />
        </div>

        {/* 前景：logo 自景深浮現 + 光線 + tagline（UI 從場景中生長出來） */}
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 pointer-events-none">
          <div className="text-white font-light" style={{
            fontSize: 'clamp(38px, 12vw, 64px)',
            letterSpacing: '0.04em',
            textShadow: '0 0 36px rgba(170,150,255,0.55), 0 2px 14px rgba(0,0,0,0.4)',
            animation: cinematic ? 'bootLogoIn 1400ms cubic-bezier(0.22,1,0.36,1) 250ms both' : 'bootLogoIn 600ms ease-out both',
          }}>
            Soren
          </div>
          <div className="mt-3 h-px w-28" style={{
            background: 'linear-gradient(90deg, transparent, rgba(200,190,255,0.85), transparent)',
            transformOrigin: 'center',
            animation: cinematic ? 'bootLineIn 900ms ease-out 1100ms both' : 'bootLineIn 400ms ease-out 200ms both',
          }} />
          <div className="mt-3 text-[12px] text-white/85" style={{
            letterSpacing: '0.3em',
            animation: cinematic ? 'bootSoftIn 1200ms ease-out 1250ms both' : 'bootSoftIn 500ms ease-out 250ms both',
          }}>
            歡迎回家！
          </div>
        </div>
      </div>

      {/* 輕觸跳過提示（僅完整版、過 1.8s 後；極淡，不打擾） */}
      {cinematic && !exiting && (
        <div className="absolute bottom-10 left-0 right-0 text-center text-[10px] tracking-[0.3em] text-white/40"
             style={{ animation: 'bootHintIn 800ms ease-out 1800ms both' }}>
          輕觸進入
        </div>
      )}
    </div>
  );
};

export default ClassicBootSequence;
