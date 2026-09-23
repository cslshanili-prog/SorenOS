/**
 * Memory Dive — 下屏氛圍面板
 *
 * 不再承載對話框（對話框現在浮在上屏房間下沿）。
 * 這裡是"夢核"氛圍區：
 *   - 居中大字的房間名（半透明，柔光）
 *   - 底下循環飄過一段當次房間召回的記憶碎片（純本地數據，不調 LLM）
 *   - 轉場 / 劇本生成中改成沉浸式引導文案
 */

import React, { useEffect, useMemo, useState } from 'react';

interface Props {
  /** 當前房間名（已本地化） */
  roomName: string;
  /** 當次進入這個房間檢索到的記憶碎片（純文本） */
  memoryFragments: string[];
  isLoading: boolean;
  /** 加載文案（"走向臥室" / "薄霧正在聚攏" 等） */
  loadingText?: string;
  /** API 失敗時的錯誤信息；非空會顯示"重新召回"按鈕 */
  loadError?: string | null;
  /** 點擊重新召回 */
  onRetry?: () => void;
}

const FRAGMENT_CYCLE_MS = 5200;
const FRAGMENT_MAX_LEN = 60;

function trim(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

const MemoryDiveAmbient: React.FC<Props> = ({
  roomName, memoryFragments, isLoading, loadingText, loadError, onRetry,
}) => {
  const [fragIdx, setFragIdx] = useState(0);

  // 切換房間或片段數組變了 → 重置並啟動循環
  useEffect(() => {
    setFragIdx(0);
    if (memoryFragments.length <= 1) return;
    const t = window.setInterval(() => {
      setFragIdx(i => (i + 1) % memoryFragments.length);
    }, FRAGMENT_CYCLE_MS);
    return () => window.clearInterval(t);
  }, [memoryFragments]);

  const currentFrag = memoryFragments[fragIdx] || '';

  return (
    <div
      className="shrink-0 w-full relative overflow-hidden"
      style={{ height: '38vh', minHeight: 200 }}
    >
      {/* 背景：深色漸變 + 像素星點 */}
      <div className="absolute inset-0 bg-gradient-to-b from-slate-900 via-slate-950 to-black">
        <DecorStars />
      </div>

      {/* 錯誤態（最高優先級）：顯示重新召回按鈕 */}
      {loadError && <ErrorRetry message={loadError} onRetry={onRetry} />}

      {/* 加載態 —— 覆蓋正常態 */}
      {!loadError && isLoading && <ImmersiveLoading text={loadingText || '記憶正在浮現'} />}

      {/* 非加載 / 非錯誤態：房間名 + 記憶碎片 */}
      {!loadError && !isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6 pointer-events-none">
          {/* 房間名（大字幽光） */}
          <div
            className="text-[24px] font-bold text-violet-200/30 tracking-[0.6em] select-none"
            style={{
              textShadow: '0 0 18px rgba(167,139,250,0.25), 0 0 4px rgba(167,139,250,0.4)',
              letterSpacing: '0.5em',
            }}
          >
            {roomName}
          </div>

          {/* 分隔細線 */}
          <div className="mt-3 w-20 h-px bg-gradient-to-r from-transparent via-violet-400/30 to-transparent" />

          {/* 記憶碎片（循環淡入淡出） */}
          {currentFrag ? (
            <div
              key={fragIdx}
              className="mt-3 text-center italic text-[11px] leading-[1.7] text-violet-100/40 max-w-md"
              style={{
                textShadow: '0 0 10px rgba(167,139,250,0.18)',
                animation: 'diveFragIn 1.6s ease-out both',
              }}
            >
              {trim(currentFrag, FRAGMENT_MAX_LEN)}
            </div>
          ) : (
            <div className="mt-3 text-[10px] text-slate-600 italic">……</div>
          )}
        </div>
      )}

      <style>{`
        @keyframes diveFragIn {
          0% { opacity: 0; transform: translateY(6px); filter: blur(4px); }
          15% { opacity: 0.85; filter: blur(0); }
          85% { opacity: 0.85; }
          100% { opacity: 0; transform: translateY(-4px); filter: blur(2px); }
        }
      `}</style>
    </div>
  );
};

// ─── 錯誤態浮層 ────────────────────────────────────────

const ErrorRetry: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 z-10">
    {/* 柔光環（琥珀色，表示"卡住了" vs 紫色的"正常加載"） */}
    <div className="absolute w-36 h-36 rounded-full"
      style={{
        background: 'radial-gradient(circle, rgba(251,191,36,0.15) 0%, rgba(251,191,36,0.05) 40%, transparent 70%)',
        animation: 'diveErrorBreath 3.2s ease-in-out infinite',
      }}
    />

    <div className="relative text-[12px] italic text-amber-200/80 text-center tracking-[0.15em]"
      style={{ textShadow: '0 0 10px rgba(251,191,36,0.35)' }}
    >
      記憶像卡在薄霧裡了
    </div>

    <button
      type="button"
      onClick={onRetry}
      className="relative group px-5 py-2 rounded-sm bg-slate-900/90 hover:bg-amber-900/50 border-2 border-amber-500/60 hover:border-amber-300/90 text-[12px] text-amber-100 hover:text-white tracking-[0.2em] transition-colors active:scale-[0.97]"
      style={{
        boxShadow: '0 2px 0 #0f172a, inset 0 0 0 1px rgba(251,191,36,0.08)',
      }}
    >
      <span className="mr-1.5">✦</span>重新召回<span className="ml-1.5">✦</span>
      {/* 懸停光暈 */}
      <span className="absolute inset-0 rounded-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        style={{ boxShadow: '0 0 16px rgba(251,191,36,0.25)' }} />
    </button>

    {message && (
      <div className="relative max-w-xs text-[9px] text-slate-500 italic text-center truncate"
        title={message}>
        {message.slice(0, 60)}{message.length > 60 ? '…' : ''}
      </div>
    )}

    <style>{`
      @keyframes diveErrorBreath {
        0%, 100% { transform: scale(1); opacity: 0.5; }
        50% { transform: scale(1.15); opacity: 0.8; }
      }
    `}</style>
  </div>
);

// ─── 內部：背景星點 + 沉浸式加載 ────────────────────────

const DecorStars: React.FC = () => {
  const stars = useMemo(() => {
    const out: Array<{ x: number; y: number; s: number; o: number }> = [];
    const rng = mulberry32(98742);
    for (let i = 0; i < 40; i++) {
      out.push({
        x: rng() * 100,
        y: rng() * 100,
        s: 1 + Math.round(rng() * 2),
        o: 0.2 + rng() * 0.4,
      });
    }
    return out;
  }, []);
  return (
    <div className="absolute inset-0 pointer-events-none">
      {stars.map((s, i) => (
        <div key={i} className="absolute bg-slate-400 rounded-sm"
          style={{
            left: `${s.x}%`, top: `${s.y}%`,
            width: s.s, height: s.s,
            opacity: s.o,
          }}
        />
      ))}
    </div>
  );
};

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const ImmersiveLoading: React.FC<{ text: string }> = ({ text }) => (
  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
    <div className="absolute w-40 h-40 rounded-full"
      style={{
        background: 'radial-gradient(circle, rgba(167,139,250,0.22) 0%, rgba(167,139,250,0.08) 40%, transparent 70%)',
        animation: 'diveLoadingBreath 2.6s ease-in-out infinite',
      }}
    />
    <div key={text}
      className="relative flex items-center gap-2 text-[12px] tracking-[0.25em] italic text-violet-200/90"
      style={{
        textShadow: '0 0 12px rgba(167,139,250,0.5)',
        animation: 'diveLoadingTextIn 500ms ease-out both',
      }}
    >
      <span style={{ animation: 'diveLoadingFade 2.6s ease-in-out infinite' }}>
        {text}
      </span>
      <span className="inline-flex gap-1">
        <span className="w-1 h-1 rounded-full bg-violet-300"
          style={{ animation: 'diveLoadingDot 1.4s ease-in-out 0ms infinite' }} />
        <span className="w-1 h-1 rounded-full bg-violet-300"
          style={{ animation: 'diveLoadingDot 1.4s ease-in-out 200ms infinite' }} />
        <span className="w-1 h-1 rounded-full bg-violet-300"
          style={{ animation: 'diveLoadingDot 1.4s ease-in-out 400ms infinite' }} />
      </span>
    </div>
    <style>{`
      @keyframes diveLoadingBreath {
        0%, 100% { transform: scale(1); opacity: 0.55; }
        50% { transform: scale(1.25); opacity: 0.9; }
      }
      @keyframes diveLoadingFade {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 1; }
      }
      @keyframes diveLoadingDot {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
        40% { transform: translateY(-3px); opacity: 1; }
      }
      @keyframes diveLoadingTextIn {
        from { opacity: 0; transform: translateY(6px); letter-spacing: 0.4em; }
        to { opacity: 1; transform: translateY(0); letter-spacing: 0.25em; }
      }
    `}</style>
  </div>
);

export default MemoryDiveAmbient;
