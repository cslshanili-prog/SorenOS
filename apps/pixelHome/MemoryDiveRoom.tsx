/**
 * Memory Dive — 上屏房間渲染
 *
 * 修復 ROOM_SCALE 2.2 導致的傢俱錯位問題：
 *   - 通過 ResizeObserver 測量容器，動態計算適配尺寸
 *   - 房間按寬高比完整放入視口，傢俱 % 座標與編輯器完全一致
 *   - 角色 / 用戶 sprite 按 tile 比例縮放
 *
 * 角色與用戶小人使用 CSS transition 自動過渡到 charPos / playerPos，
 *   上層只需設置目標位置即可獲得"行走"動畫。
 */

import React, { useEffect, useRef, useState, useMemo } from 'react';
import type { MemoryRoom } from '../../utils/memoryPalace/types';
import type { PixelHomeState, PixelRoomLayout, PixelAsset } from './types';
import { decodeColorField } from './types';
import { ROOM_SIZES, ROOM_SLOTS } from './roomTemplates';
import TokenImg from '../../components/os/TokenImg';

const TILE_BASE = 28;

const FLOOR_STYLES: Record<string, { wallFace: string; floor: string }> = {
  living_room: { wallFace: '#e8d5b8', floor: '#c4a882' },
  bedroom:     { wallFace: '#e8ddd0', floor: '#d4b896' },
  study:       { wallFace: '#c9b99a', floor: '#8b6f47' },
  attic:       { wallFace: '#6b5d50', floor: '#706050' },
  self_room:   { wallFace: '#f0d0e0', floor: '#d4a8c0' },
  user_room:   { wallFace: '#c8e0d0', floor: '#a8c4b0' },
  windowsill:  { wallFace: '#a8bfb0', floor: '#92a89c' },
};

interface Props {
  roomId: MemoryRoom;
  layout: PixelRoomLayout | undefined;
  assets: PixelAsset[];
  charSprite?: string;
  playerSprite?: string;
  charName: string;
  userName: string;
  charPos: { x: number; y: number };
  playerPos: { x: number; y: number };
  charWalking: boolean;
  charFlip: boolean;
  walkStep: 0 | 1;
  transitionState: 'idle' | 'out' | 'in';
}

const MemoryDiveRoom: React.FC<Props> = ({
  roomId, layout, assets, charSprite, playerSprite, charName, userName,
  charPos, playerPos, charWalking, charFlip, walkStep, transitionState,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const roomSize = ROOM_SIZES[roomId] || { w: 10, h: 6 };

  // 關鍵：按寬高比適配視口，保證完整可見、不裁切
  const { pw, ph, tilePx } = useMemo(() => {
    if (size.w === 0 || size.h === 0) return { pw: 0, ph: 0, tilePx: TILE_BASE };
    const aspect = roomSize.w / roomSize.h;
    const viewportAspect = size.w / size.h;
    let width: number, height: number;
    if (viewportAspect > aspect) {
      // 視口更寬 → 以高度填滿
      height = size.h;
      width = height * aspect;
    } else {
      // 視口更瘦 → 以寬度填滿
      width = size.w;
      height = width / aspect;
    }
    // 離散化到整數像素，避免子像素渲染
    width = Math.floor(width);
    height = Math.floor(height);
    return { pw: width, ph: height, tilePx: width / roomSize.w };
  }, [size.w, size.h, roomSize.w, roomSize.h]);

  const roomStyle = FLOOR_STYLES[roomId] || FLOOR_STYLES.living_room;
  // 與編輯器 WALL_TOP_RATIO 保持一致，避免牆/地板分界線位置不同導致傢俱看起來錯位
  const wallH = Math.round(ph * 0.38);
  // 傢俱尺寸：與編輯器保持同一公式
  const furBase = Math.min(pw, ph);
  // 角色尺寸固定以視口（容器）為基準，而不是 tilePx ——
  // 否則像臥室 5x5、客廳 10x6 這種寬高比差異會讓 tilePx 在房間間相差近 2 倍，
  // 角色在臥室看起來比客廳大很多。視口本身在房間切換時尺寸不變，這裡才能做到
  // "走到任何房間都是同樣大小的小人"。
  const charBase = Math.min(size.w, size.h) || furBase;
  const charSize = Math.max(22, Math.round(charBase * 0.11));
  const playerSize = Math.max(20, Math.round(charBase * 0.10));

  const slotDefs = ROOM_SLOTS[roomId] || [];

  const transitionOpacity = transitionState === 'out' ? 0 : 1;
  const transitionFilter = transitionState === 'out' ? 'brightness(0.3)' : 'brightness(1)';

  return (
    <div ref={viewportRef} className="relative w-full h-full overflow-hidden bg-slate-950 flex items-center justify-center">
      {/* 房間畫布 —— 固定像素寬高，傢俱 % 定位自然對齊 */}
      {pw > 0 && (
        <div
          className="relative"
          style={{
            width: pw,
            height: ph,
            opacity: transitionOpacity,
            filter: transitionFilter,
            transition: 'opacity 350ms ease, filter 350ms ease',
          }}
        >
          {/* 牆面 */}
          <div className="absolute inset-x-0 top-0 overflow-hidden" style={{ height: wallH }}>
            <WallOrFloor
              field={layout?.wallColor}
              fillMode={layout?.wallFillMode}
              offsetX={layout?.wallOffsetX}
              offsetY={layout?.wallOffsetY}
              tileSize={tilePx * 2}
              fallback={roomStyle.wallFace}
            />
          </div>

          {/* 地板 */}
          <div className="absolute inset-x-0 bottom-0 overflow-hidden" style={{ top: wallH }}>
            <WallOrFloor
              field={layout?.floorColor}
              fillMode={layout?.floorFillMode}
              offsetX={layout?.floorOffsetX}
              offsetY={layout?.floorOffsetY}
              tileSize={tilePx}
              fallback={roomStyle.floor}
            />
          </div>

          {/* 傢俱（純裝飾，無互動、無訪問狀態）
             位置與編輯器完全一致：錨點是傢俱方框（width × width）的中心，
             用 px 偏移 -furSize/2 定位，而不是 translate(-50%, -50%) ——
             因為 translate 會用 img 的實際高度（height:auto），高傢俱就會往上漂。
             編輯器裡一直是用 furSize（寬度）作為垂直偏移基準的，這裡也一樣，
             潛行視圖的傢俱位置就能和房間編輯器裡拖出來的位置一模一樣。 */}
          {layout?.furniture.map(f => {
            const asset = f.assetId ? assets.find(a => a.id === f.assetId) : null;
            const imgSrc = asset?.pixelImage;
            if (!imgSrc) return null;

            const slot = slotDefs.find(s => s.id === f.slotId);
            const furSize = Math.round(furBase * 0.22 * f.scale);
            const isRug = !!asset?.tags?.includes('rug');

            const autoZ = Math.round(f.y * 4) + 20;
            let zIdx: number;
            if (isRug) zIdx = 1;
            else if (f.zOrder === 'back') zIdx = 2 + Math.round(autoZ / 200);
            else if (f.zOrder === 'front') zIdx = 1000 + autoZ;
            else zIdx = autoZ;

            const posX = Math.round((f.x / 100) * pw - furSize / 2);
            const posY = Math.round((f.y / 100) * ph - furSize / 2);

            return (
              <div
                key={f.slotId}
                className="absolute pointer-events-none"
                style={{
                  left: posX, top: posY,
                  width: furSize,
                  zIndex: zIdx,
                }}
                title={slot?.name}
              >
                <img src={imgSrc} alt={slot?.name || f.slotId}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: 'auto',
                    imageRendering: 'pixelated',
                    transform: `rotate(${f.rotation || 0}deg)`,
                  }}
                  draggable={false}
                />
              </div>
            );
          })}

          {/* 用戶小人（跟隨，先繪製低 z，這樣與角色重疊時在後） */}
          <SpritePerson
            pos={playerPos}
            size={playerSize}
            sprite={playerSprite}
            label={userName}
            labelColor="bg-emerald-600/60"
            walking={charWalking}
            flip={charFlip}
            step={walkStep}
            zBoost={0}
            defaultColor="emerald"
          />

          {/* 角色小人（NPC） */}
          <SpritePerson
            pos={charPos}
            size={charSize}
            sprite={charSprite}
            label={charName}
            labelColor="bg-violet-600/70"
            walking={charWalking}
            flip={charFlip}
            step={walkStep}
            zBoost={1}
            defaultColor="violet"
          />
        </div>
      )}

      {/* 場景轉換黑幕（淡入時覆蓋一層） */}
      {transitionState !== 'idle' && (
        <div
          className="absolute inset-0 pointer-events-none bg-black"
          style={{
            opacity: transitionState === 'out' ? 0.7 : 0,
            transition: 'opacity 350ms ease',
          }}
        />
      )}
    </div>
  );
};

// ─── 子組件：牆 / 地板背景 ────────────────────────────

const WallOrFloor: React.FC<{
  field: string | undefined;
  fillMode: 'tile' | 'stretch' | undefined;
  offsetX: number | undefined;
  offsetY: number | undefined;
  tileSize: number;
  fallback: string;
}> = ({ field, fillMode, offsetX, offsetY, tileSize, fallback }) => {
  const d = decodeColorField(field);
  if (d.kind === 'image') {
    const style: React.CSSProperties = fillMode === 'stretch'
      ? {
          backgroundImage: `url(${d.value})`,
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: `${offsetX ?? 50}% ${offsetY ?? 50}%`,
          imageRendering: 'pixelated',
        }
      : {
          backgroundImage: `url(${d.value})`,
          backgroundSize: `${tileSize}px ${tileSize}px`,
          backgroundRepeat: 'repeat',
          imageRendering: 'pixelated',
        };
    return <div className="absolute inset-0" style={style} />;
  }
  const color = d.kind === 'color' ? d.value : fallback;
  return <div className="absolute inset-0" style={{ backgroundColor: color }} />;
};

// ─── 子組件：像素小人（角色或用戶） ───────────────────

const SpritePerson: React.FC<{
  pos: { x: number; y: number };
  size: number;
  sprite?: string;
  label: string;
  labelColor: string;
  walking: boolean;
  flip: boolean;
  step: 0 | 1;
  zBoost: number;
  defaultColor: 'emerald' | 'violet';
}> = ({ pos, size, sprite, label, labelColor, walking, flip, step, zBoost, defaultColor }) => {
  const bob = walking ? (step === 0 ? -1 : 0) : 0;
  const tilt = walking ? (step === 0 ? -4 : 4) : 0;
  const baseColor = defaultColor === 'emerald'
    ? 'linear-gradient(135deg, #6ee7b7 0%, #34d399 50%, #10b981 100%)'
    : 'linear-gradient(135deg, #c4b5fd 0%, #a78bfa 50%, #8b5cf6 100%)';

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        width: size,
        height: size,
        transform: 'translate(-50%, -100%)',
        transition: 'left 900ms ease-in-out, top 900ms ease-in-out',
        zIndex: Math.round(pos.y * 4) + 20 + zBoost,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `scaleX(${flip ? -1 : 1}) rotate(${tilt}deg) translateY(${bob}px)`,
          transformOrigin: 'center bottom',
          transition: 'transform 200ms ease-out',
        }}
      >
        {sprite ? (
          <TokenImg value={sprite}
            style={{
              display: 'block', width: '100%', height: '100%',
              objectFit: 'contain', imageRendering: 'pixelated',
              filter: 'drop-shadow(0 2px 2px rgba(0,0,0,0.35))',
            }}
            draggable={false}
            alt={label}
          />
        ) : (
          <DefaultSprite bgGradient={baseColor} />
        )}
      </div>
      {/* 標籤 */}
      <div className="absolute left-1/2 -translate-x-1/2 -bottom-4">
        <span className={`text-[8px] px-1 rounded-sm text-white/90 whitespace-nowrap ${labelColor}`}>
          {label}
        </span>
      </div>
      {/* 腳下陰影 */}
      <div className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black/25"
        style={{ width: size * 0.55, height: 3, bottom: -2 }}
      />
    </div>
  );
};

const DefaultSprite: React.FC<{ bgGradient: string }> = ({ bgGradient }) => (
  <div className="relative w-full h-full">
    <div className="absolute inset-x-[15%] inset-y-[10%] rounded-sm border border-white/40"
      style={{ background: bgGradient, imageRendering: 'pixelated' }}>
      <div className="absolute top-[25%] left-[15%] w-1 h-1 rounded-full bg-white" />
      <div className="absolute top-[25%] right-[15%] w-1 h-1 rounded-full bg-white" />
      <div className="absolute top-[30%] left-[20%] w-[2px] h-[2px] rounded-full bg-slate-900" />
      <div className="absolute top-[30%] right-[20%] w-[2px] h-[2px] rounded-full bg-slate-900" />
    </div>
  </div>
);

export default MemoryDiveRoom;
