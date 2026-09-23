/**
 * 全局懸浮 Mini 播放器
 * 僅在 非 Music / 非 Launcher 應用裡 顯示，表示「後台正在放歌」。
 * Launcher 頁讓位給已有的 Dock，Music 頁讓位給頁面內自帶的 MiniPlayer。
 *
 * 默認摺疊：只顯示一個帶封面的小圓球，點開才展開完整控制條；
 * 小球可拖動、可長按隱藏；切到新歌時會自動再出現。
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, SkipForward, SkipBack, CaretDown, X } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { useMusic } from '../../context/MusicContext';
import { AppID } from '../../types';
import { isIOSStandaloneWebApp, readSafeAreaInsets } from '../../utils/iosStandalone';
import {
  clampBubblePos,
  clampExpandedBottom,
  resolveInsets,
  resolveSafeTopInset,
} from '../../utils/floatingBallBounds';
import TokenImg from './TokenImg';

const STORAGE_KEY = 'globalMiniPlayer.bubblePos.v1';
const HIDDEN_KEY = 'globalMiniPlayer.hidden.v1';
const EXPANDED_BOTTOM_KEY = 'globalMiniPlayer.expandedBottom.v1';
const DRAG_THRESHOLD = 4; // 像素：超過這個位移算拖動，不觸發點擊

type Pos = { x: number; y: number } | null;

const readPos = (): Pos => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
  } catch {}
  return null;
};

const readExpandedBottom = (): number | null => {
  try {
    const raw = localStorage.getItem(EXPANDED_BOTTOM_KEY);
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
};

const parsePx = (value: string): number => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readSafeTopInset = (): number => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;

  // 優先複用 iosStandalone.ts 寫到 :root 的值：iOS standalone 冷啟動時 raw env/probe
  // 可能先給 0，但 --standalone-safe-area-top 已經有 44px 兜底。
  const standaloneSafeTop = parsePx(
    window.getComputedStyle(document.documentElement).getPropertyValue('--standalone-safe-area-top'),
  );
  if (standaloneSafeTop > 0) return standaloneSafeTop;

  return resolveSafeTopInset({
    standaloneSafeTop,
    probedSafeTop: readSafeAreaInsets().top || 0,
    isIOSStandalone: isIOSStandaloneWebApp(),
  });
};

// 把父容器（PhoneShell 外殼）的 padding 與安全區合成球要讓出的高度。
// 只在每次拖拽手勢開始（pointerdown）時調一次並緩存進 dragState：
// safe-area 讀取可能觸發樣式計算 / 探針讀取，放進高頻 pointermove 會抖。
const computeInsets = (parent: HTMLElement): { insetTop: number; insetBottom: number } => {
  const cs = window.getComputedStyle(parent);
  return resolveInsets({
    padTop: parseFloat(cs.paddingTop) || 0,
    padBottom: parseFloat(cs.paddingBottom) || 0,
    safeTop: readSafeTopInset(),
  });
};

const GlobalMiniPlayer: React.FC = () => {
  const { activeApp } = useOS();
  const { current, playing, togglePlay, nextSong, prevSong, progress, duration } = useMusic();

  const [expanded, setExpanded] = useState(false); // 默認摺疊
  const [pos, setPos] = useState<Pos>(() => readPos()); // null = 默認右下
  const [expandedBottom, setExpandedBottom] = useState<number | null>(() => readExpandedBottom()); // 展開態距底部像素
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return sessionStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
  });

  const expandedRef = useRef<HTMLDivElement | null>(null);
  const expandedDragState = useRef<{
    startY: number;
    startBottom: number;
    parentH: number;
    selfH: number;
    insetTop: number;
    insetBottom: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{
    startX: number; startY: number;
    offX: number; offY: number;
    parentW: number; parentH: number;
    insetTop: number; insetBottom: number;
    moved: boolean;
    pointerId: number | null;
  } | null>(null);
  const longPressTimer = useRef<number | null>(null);

  // 只有用戶真正"重新按下播放"（playing 從 false → true）才自動取消隱藏。
  // 僅靠 current.id 判斷會讓組件每次掛載（比如打開聊天 App）就把上一首歌"復活"顯示出來——
  // 即使用戶上次已經手動關掉了球、並且當下並沒有在聽歌。
  // ref 初始化為當前 playing 值：避免掛載瞬間被誤判為 false→true 跳變。
  const prevPlayingRef = useRef(playing);
  // 本次會話是否真正播放過。冷啟動/重新進入項目時，MusicContext 會從 localStorage
  // 恢復 queue+idx（於是 current 非空），但新建的 <audio> 尚未播放（playing=false）。
  // 這種"恢復出來但沒在放"的暫停態不應該彈出懸浮球——只有真正播放過之後，
  // 會話內的手動暫停才保留顯示。
  const [everPlayed, setEverPlayed] = useState(playing);
  useEffect(() => {
    if (playing) {
      setEverPlayed(true);
      if (!prevPlayingRef.current) {
        setHidden(false);
        try { sessionStorage.removeItem(HIDDEN_KEY); } catch {}
      }
    }
    prevPlayingRef.current = playing;
  }, [playing]);

  // 持久化位置
  useEffect(() => {
    if (!pos) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch {}
  }, [pos]);

  useEffect(() => {
    if (expandedBottom == null) return;
    try { localStorage.setItem(EXPANDED_BOTTOM_KEY, String(expandedBottom)); } catch {}
  }, [expandedBottom]);

  // 展開態：拖把手垂直拖動；點擊則收起
  const onExpandedHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = expandedRef.current;
    if (!el) return;
    const parent = el.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const selfRect = el.getBoundingClientRect();
    const currentBottom = parentRect.bottom - selfRect.bottom;
    const { insetTop, insetBottom } = computeInsets(parent);
    expandedDragState.current = {
      startY: e.clientY,
      startBottom: currentBottom,
      parentH: parentRect.height,
      selfH: selfRect.height,
      insetTop,
      insetBottom,
      moved: false,
      pointerId: e.pointerId,
    };
    try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}
  }, []);

  const onExpandedHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = expandedDragState.current;
    if (!ds) return;
    const dy = e.clientY - ds.startY;
    if (!ds.moved && Math.abs(dy) > DRAG_THRESHOLD) ds.moved = true;
    if (!ds.moved) return;
    const nextBottom = clampExpandedBottom(ds.startBottom - dy, {
      parentH: ds.parentH,
      selfH: ds.selfH,
      insetTop: ds.insetTop,
      insetBottom: ds.insetBottom,
    });
    setExpandedBottom(nextBottom);
  }, []);

  const onExpandedHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = expandedDragState.current;
    expandedDragState.current = null;
    try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
    if (ds && !ds.moved) {
      // 當作"收起到小球"
      setExpanded(false);
    }
  }, []);

  const hide = useCallback(() => {
    setHidden(true);
    setExpanded(false);
    try { sessionStorage.setItem(HIDDEN_KEY, '1'); } catch {}
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const parent = el.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const bubbleRect = el.getBoundingClientRect();
    const { insetTop, insetBottom } = computeInsets(parent);

    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - bubbleRect.left,
      offY: e.clientY - bubbleRect.top,
      parentW: parentRect.width,
      parentH: parentRect.height,
      insetTop,
      insetBottom,
      moved: false,
      pointerId: e.pointerId,
    };

    // 長按隱藏
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      if (dragState.current && !dragState.current.moved) {
        hide();
        dragState.current = null;
      }
    }, 600);

    try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}
  }, [hide]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const ds = dragState.current;
    const el = wrapRef.current;
    if (!ds || !el) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (!ds.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      ds.moved = true;
      if (longPressTimer.current) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    }
    if (!ds.moved) return;

    const parent = el.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const next = clampBubblePos(
      e.clientX - parentRect.left - ds.offX,
      e.clientY - parentRect.top - ds.offY,
      {
        parentW: ds.parentW,
        parentH: ds.parentH,
        insetTop: ds.insetTop,
        insetBottom: ds.insetBottom,
      },
    );
    setPos(next);
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const ds = dragState.current;
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (ds && !ds.moved) {
      // 算作點擊 → 展開
      setExpanded(true);
    }
    dragState.current = null;
    try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
  }, []);

  if (!current) return null;
  // 重新進入項目時音樂是暫停的（從未真正播放過本次會話）→ 不顯示懸浮球
  if (!everPlayed && !playing) return null;
  if (activeApp === AppID.Music) return null;
  if (activeApp === AppID.Launcher) return null; // Launcher 的 dock 夠用了
  if (activeApp === AppID.Call) return null;     // 通話中不打擾
  if (hidden) return null;

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  // 摺疊態：小圓球（可拖動、長按隱藏、單擊展開）
  if (!expanded) {
    const positional: React.CSSProperties = pos
      ? { left: pos.x, top: pos.y }
      : { right: 12, bottom: 12 };
    return (
      <div
        ref={wrapRef}
        className="absolute z-[55] pointer-events-none"
        style={positional}
      >
        <button
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onContextMenu={(e) => e.preventDefault()}
          className="pointer-events-auto relative w-10 h-10 rounded-full overflow-hidden active:scale-95 transition-transform touch-none select-none"
          style={{
            boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.25)',
          }}
          aria-label="音樂播放器（點擊展開，拖動移位，長按隱藏）"
          title="點擊展開 · 拖動移位 · 長按隱藏"
        >
          <TokenImg
            value={current.albumPic}
            alt=""
            draggable={false}
            className="w-full h-full object-cover pointer-events-none"
          />
          {/* 播放/暫停小指示 */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ background: 'rgba(0,0,0,0.25)' }}
          >
            {playing
              ? <Pause size={14} weight="fill" color="#fff" />
              : <Play size={14} weight="fill" color="#fff" />}
          </div>
          {/* 進度細條 */}
          <div className="absolute left-0 bottom-0 w-full h-[2px] bg-white/20 pointer-events-none">
            <div
              className="h-full bg-gradient-to-r from-sky-400 to-indigo-400 transition-all duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
        </button>
      </div>
    );
  }

  // 展開態：原來的完整 Mini 播放器
  // 刻意不給外層 wrapper 綁 onClick —— 在別的 App 裡點它不應該跳到 Music App
  // （會把用戶正在做的事情弄丟），只有裡面的按鈕生效。
  return (
    <div
      ref={expandedRef}
      className="absolute left-3 right-3 z-[55] pointer-events-none"
      style={{ bottom: expandedBottom != null ? expandedBottom : 12 }}
    >
      <div
        className="pointer-events-auto flex items-center gap-2.5 rounded-2xl pl-1.5 pr-2.5 py-2 relative overflow-hidden animate-fade-in"
        style={{
          background: 'rgba(20, 24, 35, 0.65)',
          backdropFilter: 'blur(24px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
          border: '1px solid rgba(255,255,255,0.15)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        }}
      >
        {/* 拖動把手 — 垂直拖動整個條；點擊則收起 */}
        <div
          onPointerDown={onExpandedHandleDown}
          onPointerMove={onExpandedHandleMove}
          onPointerUp={onExpandedHandleUp}
          onPointerCancel={onExpandedHandleUp}
          className="shrink-0 flex items-center justify-center px-1 cursor-grab active:cursor-grabbing touch-none select-none"
          style={{ alignSelf: 'stretch' }}
          aria-label="拖動調整位置（點擊收起）"
          title="上下拖動 · 點擊收起"
        >
          <div className="w-1 h-7 rounded-full" style={{ background: 'rgba(255,255,255,0.25)' }} />
        </div>
        {/* 封面 */}
        <TokenImg
          value={current.albumPic}
          alt=""
          className="w-9 h-9 rounded-lg object-cover shrink-0"
          style={{ border: '1px solid rgba(255,255,255,0.2)' }}
        />

        {/* 文字 */}
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[11px] font-medium truncate text-white">{current.name}</div>
          <div className="text-[9px] truncate text-white/60">{current.artists}</div>
        </div>

        {/* 控制 */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); prevSong(); }}
            className="p-1.5 rounded-full text-white/80 active:scale-95 transition-transform"
          >
            <SkipBack size={14} weight="fill" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
            className="p-1.5 rounded-full text-white active:scale-95 transition-transform"
            style={{ background: 'rgba(255,255,255,0.15)' }}
          >
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); nextSong(); }}
            className="p-1.5 rounded-full text-white/80 active:scale-95 transition-transform"
          >
            <SkipForward size={14} weight="fill" />
          </button>
          {/* 摺疊按鈕 */}
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
            className="p-1.5 rounded-full text-white/70 active:scale-95 transition-transform ml-0.5"
            aria-label="收起播放器"
            title="收起成小球"
          >
            <CaretDown size={14} weight="bold" />
          </button>
          {/* 隱藏按鈕 */}
          <button
            onClick={(e) => { e.stopPropagation(); hide(); }}
            className="p-1.5 rounded-full text-white/70 active:scale-95 transition-transform"
            aria-label="隱藏播放器（切到下一首時會再出現）"
            title="隱藏（下一首會再出現）"
          >
            <X size={14} weight="bold" />
          </button>
        </div>

        {/* 底部細進度條 */}
        <div className="absolute left-0 bottom-0 h-[2px] bg-gradient-to-r from-sky-400 to-indigo-400 transition-all duration-150"
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

export default GlobalMiniPlayer;
