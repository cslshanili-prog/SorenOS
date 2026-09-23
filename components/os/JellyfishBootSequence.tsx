import React, { useEffect, useMemo, useRef, useState } from 'react';
import './BootSequence.css';
import { trackEvent } from '../../utils/analytics';

// CSS 水母開場：紫黑星空、輕浮與微光，沿用原有數據等待和同會話短開場。
// 動畫僅使用 transform / opacity；減少動態效果時以靜態圖形呈現。
const BOOT_SEEN_KEY = 'sullyos_boot_seen_session';

interface Props {
  /** 數據是否已就緒（IndexedDB 加載完）。未就緒時場景持續呼吸等待，不退場。 */
  dataReady: boolean;
  /** 退場動畫播完後回調，交還控制權給 PhoneShell。 */
  onDone: () => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const JellyfishBootSequence: React.FC<Props> = ({ dataReady, onDone }) => {
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

  const exiting = phase === 'exit';

  return (
    <div
      className="sully-boot"
      data-phase={phase}
      data-cinematic={cinematic}
      onClick={skip}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); skip(); } }}
      role="button"
      tabIndex={0}
      aria-label="Soren，輕觸進入"
      style={{ opacity: exiting ? 0 : 1, transition: 'opacity ' + EXIT + 'ms ease-in' }}
    >
      <div className="sully-boot-scene">
        <div className="sully-boot-halo" aria-hidden="true" />
        {Array.from({ length: 18 }, (_, i) => (
          <span key={i} className="sully-boot-star" aria-hidden="true" style={{
            left: ((i * 37 + 7) % 100) + '%', top: ((i * 23 + 11) % 100) + '%',
            width: i % 4 === 0 ? 2 : 1, height: i % 4 === 0 ? 2 : 1, animationDelay: (-i * .37) + 's',
          }} />
        ))}
        <div className="sully-boot-art" aria-hidden="true">
          <div className="sully-boot-orbit" />
          <div className="sully-boot-jelly">
            <div className="sully-boot-threads"><i /><i /><i /></div>
            <div className="sully-boot-ribbons"><i /><i /><i /><i /></div>
            <div className="sully-boot-bell"><div className="sully-boot-facets" /><span>∞</span><i className="sully-boot-shine" /></div>
          </div>
          <i className="sully-boot-planet planet-one" /><i className="sully-boot-planet planet-two" /><i className="sully-boot-planet planet-three" />
          <i className="sully-boot-spark spark-one" /><i className="sully-boot-spark spark-two" /><i className="sully-boot-spark spark-three" />
        </div>
        <div className="sully-boot-wordmark">Soren</div>
        <div className="sully-boot-rule" aria-hidden="true" />
        <p className="sully-boot-greeting">歡迎回家</p>
      </div>
      {cinematic && !exiting && <div className="sully-boot-hint">輕觸進入</div>}
    </div>
  );
};

export default JellyfishBootSequence;
