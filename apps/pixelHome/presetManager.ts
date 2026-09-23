/**
 * Pixel Home — 房屋預設導入/導出
 *
 * 導出：當前角色的全部房間佈局 + 用到的像素資產 → JSON 文件
 * 導入：讀取 JSON → 覆蓋當前角色的房間佈局 + 導入缺失的資產
 */

import type {
  PixelHomePreset, PixelRoomPreset, PixelAssetPreset,
  PixelHomeState, PixelRoomLayout, PixelAsset,
} from './types';
import { PixelLayoutDB, PixelAssetDB } from './pixelHomeDb';
import { confirmExportSafety } from '../../utils/exportGuard';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { readShareText } from '../../utils/pngShare';

// ─── 導出 ────────────────────────────────────────────

export async function exportPreset(
  homeState: PixelHomeState,
  allAssets: PixelAsset[],
  presetName: string,
  author: string,
): Promise<string> {
  // 收集所有使用的 assetId
  const usedAssetIds = new Set<string>();
  for (const room of homeState.rooms) {
    for (const f of room.furniture) {
      if (f.assetId) usedAssetIds.add(f.assetId);
    }
  }

  // 導出房間（去掉 charId）
  const rooms: PixelRoomPreset[] = homeState.rooms.map(r => ({
    roomId: r.roomId,
    furniture: r.furniture,
    wallColor: r.wallColor,
    floorColor: r.floorColor,
    ambiance: r.ambiance,
    wallFillMode: r.wallFillMode,
    wallOffsetX: r.wallOffsetX,
    wallOffsetY: r.wallOffsetY,
    floorFillMode: r.floorFillMode,
    floorOffsetX: r.floorOffsetX,
    floorOffsetY: r.floorOffsetY,
  }));

  // 導出用到的資產（精簡，去掉 originalImage 節省空間）
  const assets: PixelAssetPreset[] = allAssets
    .filter(a => usedAssetIds.has(a.id))
    .map(a => ({
      id: a.id,
      name: a.name,
      pixelImage: a.pixelImage,
      pixelSize: a.pixelSize,
      palette: a.palette,
      width: a.width,
      height: a.height,
    }));

  const preset: PixelHomePreset = {
    version: 1,
    name: presetName,
    author,
    createdAt: Date.now(),
    rooms,
    assets,
  };

  return JSON.stringify(preset);
}

/** 導出並下載為 .json 文件 */
export async function downloadPreset(
  homeState: PixelHomeState,
  allAssets: PixelAsset[],
  presetName: string,
  author: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const json = await exportPreset(homeState, allAssets, presetName, author);
  // 導出前明文密鑰體檢 + 二次確認（小屋預設正常不含密鑰 → 提示「安全，可分享」）。
  if (!(await confirmExportSafety(JSON.parse(json)))) return 'cancelled';
  return shareOrDownloadFile({
    card: { kind: 'pixel-home', title: presetName, author },
    content: json,
    fileName: `pixel_home_${presetName.replace(/\s+/g, '_')}_${Date.now()}.json`,
    mimeType: 'application/json;charset=utf-8',
    shareTitle: `像素小屋預設：${presetName}`,
  });
}

// ─── 導入 ────────────────────────────────────────────

export interface ImportResult {
  success: boolean;
  roomsImported: number;
  assetsImported: number;
  error?: string;
}

/** 從 JSON 字符串解析並導入預設 */
export async function importPreset(
  json: string,
  charId: string,
): Promise<ImportResult> {
  try {
    const preset: PixelHomePreset = JSON.parse(json);

    // 驗證格式
    if (!preset.version || !preset.rooms || !Array.isArray(preset.rooms)) {
      return { success: false, roomsImported: 0, assetsImported: 0, error: '無效的預設文件格式' };
    }

    // 導入資產（跳過已存在的）
    let assetsImported = 0;
    if (preset.assets && preset.assets.length > 0) {
      const existingAssets = await PixelAssetDB.getAll();
      const existingIds = new Set(existingAssets.map(a => a.id));

      for (const presetAsset of preset.assets) {
        if (!existingIds.has(presetAsset.id)) {
          const fullAsset: PixelAsset = {
            ...presetAsset,
            originalImage: presetAsset.pixelImage, // 沒有原圖，用像素圖代替
            createdAt: Date.now(),
            tags: ['imported'],
          };
          await PixelAssetDB.save(fullAsset);
          assetsImported++;
        }
      }
    }

    // 導入房間佈局
    let roomsImported = 0;
    for (const presetRoom of preset.rooms) {
      const layout: PixelRoomLayout = {
        roomId: presetRoom.roomId,
        charId,
        furniture: presetRoom.furniture,
        wallColor: presetRoom.wallColor,
        floorColor: presetRoom.floorColor,
        ambiance: presetRoom.ambiance,
        wallFillMode: presetRoom.wallFillMode,
        wallOffsetX: presetRoom.wallOffsetX,
        wallOffsetY: presetRoom.wallOffsetY,
        floorFillMode: presetRoom.floorFillMode,
        floorOffsetX: presetRoom.floorOffsetX,
        floorOffsetY: presetRoom.floorOffsetY,
        lastUpdatedAt: Date.now(),
        lastDecoratedBy: 'user',
      };
      await PixelLayoutDB.save(layout);
      roomsImported++;
    }

    return { success: true, roomsImported, assetsImported };
  } catch (err: any) {
    return { success: false, roomsImported: 0, assetsImported: 0, error: err.message || '解析失敗' };
  }
}

/** 從文件讀取 JSON 字符串 */
export function readFileAsText(file: File): Promise<string> {
  return readShareText(file, 'pixel-home');
}
