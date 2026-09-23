/**
 * Memory Dive — 房間導航順序
 *
 * 新版劇本流程：角色不再走向傢俱，只在房間裡說話。
 * 這裡只保留「下一個該去哪個房間」的邏輯。
 */

import type { MemoryRoom } from '../../utils/memoryPalace/types';

/** 引導順序——從客廳日常逐步進入內心深處，閣樓最後 */
export const GUIDED_ROOM_ORDER: MemoryRoom[] = [
  'living_room', 'bedroom', 'study', 'self_room', 'user_room', 'windowsill', 'attic',
];

/**
 * 角色站位點（每個房間一個腳底點）
 *
 * 這些座標是按各房間 roomTemplates 裡傢俱的 default 位置挑出來的空地——
 * 避開了沙發、床、桌子這些大件，讓角色落腳的時候不會踩在傢俱上。
 * 後續用戶改過傢俱佈局之後也不一定完美避開，但至少默認佈局下是乾淨的。
 * 用戶小人 = 角色位置左偏 10%、下偏 4%（見 userPos），所以這裡的 x 不能太靠左邊。
 */
const ROOM_CHAR_POS: Record<MemoryRoom, { x: number; y: number }> = {
  living_room: { x: 62, y: 82 }, // 沙發(25,60) 茶几(40,65) 地毯(50,75) 右下空地
  bedroom:     { x: 32, y: 80 }, // 床(60,55) 床頭櫃(85,55) 左下空地
  study:       { x: 35, y: 82 }, // 書桌(50,55) 書架(15,35) 左下空地
  attic:       { x: 48, y: 82 }, // 箱子(30,60) 八音盒(65,65) 中下空地
  self_room:   { x: 45, y: 82 }, // 梳妝檯(25,50) 寵物窩(70,70) 中下空地
  user_room:   { x: 35, y: 75 }, // 客床(55,55) 門墊(50,85) 左中空地
  windowsill:  { x: 55, y: 78 }, // 花盆(30,55) 望遠鏡(75,45) 種子盒(20,65) 中下空地
};

export function roomCharPos(roomId: MemoryRoom): { x: number; y: number } {
  return ROOM_CHAR_POS[roomId] || { x: 52, y: 78 };
}

/** 用戶小人斜後跟隨 */
export function userPos(charX: number, charY: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(92, charX - 10)),
    y: Math.max(42, Math.min(92, charY + 4)),
  };
}

/** 角色在一個房間裡 beat 之間的輕微漂移，讓畫面活一點 */
export function jitterPos(base: { x: number; y: number }): { x: number; y: number } {
  const jx = (Math.random() - 0.5) * 18; // ±9%
  const jy = (Math.random() - 0.5) * 10; // ±5%
  // 以 base.y 為參考做 ±5% 上下抖動，不再硬鎖死在 58..86；
  // 否則小房間裡 base.y 已經挪到 78-82 的空地，硬鉗住 58..86 會把角色拽回家具身上。
  const minY = Math.max(55, base.y - 12);
  const maxY = Math.min(88, base.y + 8);
  return {
    x: Math.max(18, Math.min(82, base.x + jx)),
    y: Math.max(minY, Math.min(maxY, base.y + jy)),
  };
}

/**
 * 選下一個房間。優先 LLM 推薦，否則按固定順序取第一個未訪問過的房間；
 * 全部訪問完返回 null。
 */
export function pickNextRoom(
  currentRoom: MemoryRoom,
  visitedRooms: MemoryRoom[],
  preferred?: MemoryRoom,
): MemoryRoom | null {
  if (preferred && preferred !== currentRoom && !visitedRooms.includes(preferred)) {
    return preferred;
  }
  const idx = GUIDED_ROOM_ORDER.indexOf(currentRoom);
  for (let i = idx + 1; i < GUIDED_ROOM_ORDER.length; i++) {
    const r = GUIDED_ROOM_ORDER[i];
    if (!visitedRooms.includes(r)) return r;
  }
  for (const r of GUIDED_ROOM_ORDER) {
    if (!visitedRooms.includes(r)) return r;
  }
  return null;
}
