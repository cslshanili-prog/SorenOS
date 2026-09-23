/**
 * Pixel Home — IndexedDB 存儲層
 *
 * 兩個 store：
 *   pixel_home_assets  — 用戶生成的像素資產
 *   pixel_home_layouts — 每個角色的每個房間佈局
 */

import type { PixelAsset, PixelRoomLayout, PixelHomeState } from './types';
import type { MemoryRoom } from '../../utils/memoryPalace/types';
import { ROOM_SLOTS, DEFAULT_ROOM_COLORS, ALL_ROOMS } from './roomTemplates';
import type { PlacedFurniture } from './types';
import { openDB } from '../../utils/db';

// ─── DB 常量 ─────────────────────────────────────────
// pixel_home_* 兩個 store 由 utils/db.ts 的 AetherOS_Data upgradeneeded 統一創建,
// 這裡直接複用 utils/db.ts 的單例 openDB —— 本地原來那個 openDB 每次操作都裸開一條
// AetherOS_Data 連接 (連版本號都沒傳), 既漏連接又繞過單例, 會一起喂大連接風暴。

const STORE_ASSETS = 'pixel_home_assets';
const STORE_LAYOUTS = 'pixel_home_layouts';

// ─── 資產 CRUD ──────────────────────────────────────

export const PixelAssetDB = {
  async save(asset: PixelAsset): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readwrite');
    tx.objectStore(STORE_ASSETS).put(asset);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async saveBatch(assets: PixelAsset[]): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readwrite');
    const store = tx.objectStore(STORE_ASSETS);
    for (const a of assets) store.put(a);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getAll(): Promise<PixelAsset[]> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readonly');
    const req = tx.objectStore(STORE_ASSETS).getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getById(id: string): Promise<PixelAsset | undefined> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readonly');
    const req = tx.objectStore(STORE_ASSETS).get(id);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async delete(id: string): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readwrite');
    tx.objectStore(STORE_ASSETS).delete(id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ─── 佈局 CRUD ──────────────────────────────────────

export const PixelLayoutDB = {
  async save(layout: PixelRoomLayout): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readwrite');
    tx.objectStore(STORE_LAYOUTS).put(layout);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async get(charId: string, roomId: MemoryRoom): Promise<PixelRoomLayout | undefined> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readonly');
    const req = tx.objectStore(STORE_LAYOUTS).get([charId, roomId]);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllForChar(charId: string): Promise<PixelRoomLayout[]> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readonly');
    const idx = tx.objectStore(STORE_LAYOUTS).index('charId');
    const req = idx.getAll(charId);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async saveBatch(layouts: PixelRoomLayout[]): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readwrite');
    const store = tx.objectStore(STORE_LAYOUTS);
    for (const l of layouts) store.put(l);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ─── 內置默認家園預設 ──────────────────────────────

/**
 * 嘗試為指定角色加載內置默認家園預設。
 * 查找順序：
 *   1. public/pixel-presets/<charId>.json   — 該角色專屬預設
 *   2. public/pixel-presets/default.json    — 所有角色共用的默認家園
 * 預設文件由倉庫 pixelroom/ 導出的 JSON 複製而來。
 *
 * 返回 true 表示成功加載並寫入了至少一個房間。
 */
async function trySeedDefaultHome(charId: string): Promise<boolean> {
  // 僅在瀏覽器環境（有 fetch + 靜態資源服務）下嘗試
  if (typeof fetch !== 'function') return false;

  const base = (import.meta as any).env?.BASE_URL ?? '/';
  const candidates = [
    `${base}pixel-presets/${encodeURIComponent(charId)}.json`,
    `${base}pixel-presets/default.json`,
  ];

  let preset: any = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: 'force-cache' });
      if (!resp.ok) continue;
      preset = await resp.json();
      if (preset && Array.isArray(preset.rooms) && preset.rooms.length > 0) break;
      preset = null;
    } catch {
      // 繼續下一個候選
    }
  }
  if (!preset) return false;

  // 導入資產（跳過已存在的）
  if (Array.isArray(preset.assets) && preset.assets.length > 0) {
    const existingAssets = await PixelAssetDB.getAll();
    const existingIds = new Set(existingAssets.map(a => a.id));
    const toSave = preset.assets
      .filter((a: any) => a && a.id && !existingIds.has(a.id))
      .map((a: any) => ({
        ...a,
        originalImage: a.pixelImage,
        createdAt: Date.now(),
        tags: ['default'],
      }));
    if (toSave.length > 0) await PixelAssetDB.saveBatch(toSave);
  }

  // 導入房間佈局
  const layouts: PixelRoomLayout[] = preset.rooms.map((r: any) => ({
    roomId: r.roomId,
    charId,
    furniture: r.furniture || [],
    wallColor: r.wallColor,
    floorColor: r.floorColor,
    ambiance: r.ambiance,
    wallFillMode: r.wallFillMode,
    wallOffsetX: r.wallOffsetX,
    wallOffsetY: r.wallOffsetY,
    floorFillMode: r.floorFillMode,
    floorOffsetX: r.floorOffsetX,
    floorOffsetY: r.floorOffsetY,
    lastUpdatedAt: Date.now(),
    lastDecoratedBy: 'character' as const,
  }));
  if (layouts.length === 0) return false;
  await PixelLayoutDB.saveBatch(layouts);
  return true;
}

// ─── 家園狀態整合 ────────────────────────────────────

/**
 * 判斷一組房間是不是"還沒裝修過"——沒有任何用戶放置的傢俱、也沒有任何關聯到具體資產的傢俱。
 * 用於判斷是否值得跑一次默認預設填充（如存在舊版空殼數據）。
 */
function layoutsLookUntouched(layouts: PixelRoomLayout[]): boolean {
  if (layouts.length === 0) return true;
  for (const r of layouts) {
    for (const f of r.furniture || []) {
      if (f.placedBy === 'user') return false;
      if (f.assetId) return false;
    }
  }
  return true;
}

/** 獲取角色的完整家園狀態，不存在則初始化默認 */
export async function getOrCreateHomeState(charId: string): Promise<PixelHomeState> {
  let existing = await PixelLayoutDB.getAllForChar(charId);

  // 首次進入、或之前只存了空殼（沒傢俱/沒用戶放置）：嘗試加載內置默認家園預設
  if (layoutsLookUntouched(existing)) {
    try {
      const seeded = await trySeedDefaultHome(charId);
      if (seeded) existing = await PixelLayoutDB.getAllForChar(charId);
    } catch (e) {
      console.warn('[pixelHome] seed default home failed:', e);
    }
  }

  if (existing.length === ALL_ROOMS.length) {
    return {
      charId,
      rooms: existing,
      lastLLMDecoration: 0,
    };
  }

  // 補齊缺失的房間
  const existingMap = new Map(existing.map(r => [r.roomId, r]));
  const allRooms: PixelRoomLayout[] = ALL_ROOMS.map(roomId => {
    if (existingMap.has(roomId)) return existingMap.get(roomId)!;

    const slots = ROOM_SLOTS[roomId];
    const colors = DEFAULT_ROOM_COLORS[roomId];
    const furniture: PlacedFurniture[] = slots.map(slot => ({
      slotId: slot.id,
      assetId: null,
      x: slot.defaultX,
      y: slot.defaultY,
      scale: slot.defaultScale,
      rotation: 0,
      placedBy: 'character' as const,
      isDefault: true,
    }));

    return {
      roomId,
      charId,
      furniture,
      wallColor: colors.wall,
      floorColor: colors.floor,
      ambiance: '',
      lastUpdatedAt: Date.now(),
      lastDecoratedBy: 'character' as const,
    };
  });

  // 保存新建的房間
  const newRooms = allRooms.filter(r => !existingMap.has(r.roomId));
  if (newRooms.length > 0) {
    await PixelLayoutDB.saveBatch(newRooms);
  }

  return {
    charId,
    rooms: allRooms,
    lastLLMDecoration: 0,
  };
}
