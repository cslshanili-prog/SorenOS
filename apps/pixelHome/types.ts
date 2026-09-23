/**
 * Pixel Home — 像素家園類型定義
 */

import type { MemoryRoom } from '../../utils/memoryPalace/types';
import { isImageValue } from '../../utils/blobRef';

// ─── 像素資產 ─────────────────────────────────────────

export interface PixelAsset {
  id: string;
  name: string;
  originalImage: string;      // 原始圖片 data URI
  pixelImage: string;         // 像素化後 data URI
  pixelSize: number;          // 24/32/48/64
  palette: string[];          // 提取的調色板顏色 (hex)
  width: number;              // 像素寬
  height: number;             // 像素高
  createdAt: number;
  tags: string[];
}

// ─── 房間槽位定義（保留作為默認傢俱模板） ─────────────

export interface RoomSlotDef {
  id: string;
  name: string;
  category: string;
  required: boolean;
  defaultX: number;
  defaultY: number;
  defaultScale: number;
}

// ─── 已放置的傢俱（支持自由放置）─────────────────────

export interface PlacedFurniture {
  slotId: string;             // 默認傢俱用槽位 ID，用戶自由放置用 unique ID
  assetId: string | null;     // 像素資產 ID（null = 使用默認像素圖）
  x: number;
  y: number;
  scale: number;
  rotation: number;
  colorOverride?: string;
  placedBy: 'user' | 'character';
  isDefault?: boolean;        // 是否為默認槽位傢俱（false/undefined = 用戶自由放置）
  /**
   * 前後遮擋手動覆蓋：
   *   'front' = 總是壓在其他傢俱上方
   *   'back'  = 總是墊在其他傢俱下方（但仍在地毯之上）
   *   undefined / 'auto' = 按傢俱底邊自動排
   */
  zOrder?: 'auto' | 'front' | 'back';
}

// ─── 單個房間佈局 ─────────────────────────────────────

export interface PixelRoomLayout {
  roomId: MemoryRoom;
  charId: string;
  furniture: PlacedFurniture[];
  /** 牆顏色：空字符串 = 用房間默認；以 "data:" 開頭 = 圖片紋理；以 "#" 開頭 = 純色；其它視為空 */
  wallColor: string;
  /** 地板顏色：規則同 wallColor */
  floorColor: string;
  ambiance: string;
  lastUpdatedAt: number;
  lastDecoratedBy: 'user' | 'character';
  /** 牆紙鋪設模式：'tile' = 循環平鋪（默認），'stretch' = 整張放大鋪滿（cover） */
  wallFillMode?: 'tile' | 'stretch';
  /** 拉伸模式下的位置百分比（0..100，默認 50 居中） */
  wallOffsetX?: number;
  wallOffsetY?: number;
  /** 地板鋪設模式，同上 */
  floorFillMode?: 'tile' | 'stretch';
  floorOffsetX?: number;
  floorOffsetY?: number;
}

// ─── 整個家園狀態 ─────────────────────────────────────

export interface PixelHomeTheme {
  /** 房間外圍深色描邊色 */
  wallBorder: string;
  /** 房間外圍淺色描邊（高光） */
  wallBorderLight: string;
  /** 家園最外層背景色（小地圖畫布底色） */
  bgColor: string;
  /** 樓梯/走廊的亮條顏色（跟隨外框風格） */
  corridorStep: string;
}

export const DEFAULT_HOME_THEME: PixelHomeTheme = {
  wallBorder: '#3d2b1f',
  wallBorderLight: '#5c4332',
  bgColor: '#1a1410',
  corridorStep: '#c4a882',
};

/** wallColor/floorColor 的解讀器：判斷是圖片、純色還是默認 */
export function decodeColorField(v: string | undefined | null):
  | { kind: 'image'; value: string }
  | { kind: 'color'; value: string }
  | { kind: 'default' } {
  if (!v) return { kind: 'default' };
  if (isImageValue(v)) return { kind: 'image', value: v };
  // 允許 "#rgb"/"#rgba"/"#rrggbb"/"#rrggbbaa"
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return { kind: 'color', value: v };
  return { kind: 'default' };
}

export interface PixelHomeState {
  charId: string;
  rooms: PixelRoomLayout[];
  lastLLMDecoration: number;
  /** 全局主題色（外圍牆體 + 背景）；不設置時用 DEFAULT_HOME_THEME */
  theme?: PixelHomeTheme;
}

// ─── LLM 裝修動作 ─────────────────────────────────────

export type DecorationActionType = 'move' | 'recolor' | 'rescale' | 'set_wall' | 'set_floor' | 'set_ambiance';

export interface DecorationAction {
  type: DecorationActionType;
  roomId: MemoryRoom;
  slotId?: string;
  x?: number;
  y?: number;
  scale?: number;
  color?: string;
  ambiance?: string;
}

export interface DecorationDiff {
  charId: string;
  actions: DecorationAction[];
  summary: string;
  timestamp: number;
}

// ─── 視圖狀態 ─────────────────────────────────────────

export type PixelHomeViewMode = 'map' | 'room' | 'generator' | 'library' | 'charEditor' | 'dive';

// ─── 房屋預設（導入/導出）─────────────────────────────

export interface PixelHomePreset {
  version: 1;
  name: string;
  author: string;
  createdAt: number;
  rooms: PixelRoomPreset[];
  assets: PixelAssetPreset[];   // 包含的像素資產（用到的才導出）
}

/** 房間預設（去掉 charId，便於跨角色導入） */
export interface PixelRoomPreset {
  roomId: MemoryRoom;
  furniture: PlacedFurniture[];
  wallColor: string;
  floorColor: string;
  ambiance: string;
  /** 鋪設模式 + 偏移（和 PixelRoomLayout 保持同步） */
  wallFillMode?: 'tile' | 'stretch';
  wallOffsetX?: number;
  wallOffsetY?: number;
  floorFillMode?: 'tile' | 'stretch';
  floorOffsetX?: number;
  floorOffsetY?: number;
}

/** 精簡版資產（僅包含渲染需要的信息） */
export interface PixelAssetPreset {
  id: string;
  name: string;
  pixelImage: string;
  pixelSize: number;
  palette: string[];
  width: number;
  height: number;
}
