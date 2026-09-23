/**
 * 像素化引擎 — Canvas 圖片→像素轉換核心算法
 *
 * 純 Canvas API，無外部依賴。
 * - pixelizeImage: 縮放 + 調色板量化 + 輪廓生成
 * - removeBackground: 四角 flood fill 背景去除
 * - autoSplit: 連通域分析，分割合併的形狀
 */

// ─── 像素化主函數 ────────────────────────────────────

export interface PixelizeResult {
  imageData: ImageData;
  width: number;
  height: number;
}

/**
 * 將圖片像素化。
 * @param source 原始圖片 ImageData
 * @param targetSize 目標像素尺寸（較長邊）
 * @param palette 可選調色板 (hex 數組)，如果提供則量化到該調色板
 */
export function pixelizeImage(
  source: ImageData,
  targetSize: number,
  palette?: string[],
): PixelizeResult {
  const { width: srcW, height: srcH } = source;

  // 計算等比縮放後的尺寸
  const ratio = srcW / srcH;
  let dstW: number, dstH: number;
  if (ratio >= 1) {
    dstW = targetSize;
    dstH = Math.max(1, Math.round(targetSize / ratio));
  } else {
    dstH = targetSize;
    dstW = Math.max(1, Math.round(targetSize * ratio));
  }

  // 1. 縮放（nearest neighbor 通過取樣）
  const result = new ImageData(dstW, dstH);

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      // 對應原圖區域的中心點
      const sx = Math.floor((dx + 0.5) * srcW / dstW);
      const sy = Math.floor((dy + 0.5) * srcH / dstH);
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (dy * dstW + dx) * 4;

      let r = source.data[srcIdx];
      let g = source.data[srcIdx + 1];
      let b = source.data[srcIdx + 2];
      let a = source.data[srcIdx + 3];

      // 2. 調色板量化
      if (palette && palette.length > 0 && a > 20) {
        const nearest = findNearestColor(r, g, b, palette);
        r = nearest[0];
        g = nearest[1];
        b = nearest[2];
      }

      result.data[dstIdx] = r;
      result.data[dstIdx + 1] = g;
      result.data[dstIdx + 2] = b;
      result.data[dstIdx + 3] = a;
    }
  }

  // 3. 生成輪廓線
  addOutline(result, dstW, dstH);

  return { imageData: result, width: dstW, height: dstH };
}

// ─── 背景去除 ────────────────────────────────────────

/**
 * 從四角 flood fill 去除相似背景色。
 * @param source 原始 ImageData（會被修改）
 * @param threshold 顏色差異閾值 (0-255)，默認 30
 */
export function removeBackground(source: ImageData, threshold = 30): ImageData {
  const { width, height, data } = source;
  const result = new ImageData(new Uint8ClampedArray(data), width, height);
  const visited = new Uint8Array(width * height);

  // 從四個角取樣背景色
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  // 取四角顏色的平均值作為背景參考色
  let bgR = 0, bgG = 0, bgB = 0, count = 0;
  for (const [cx, cy] of corners) {
    const idx = (cy * width + cx) * 4;
    if (data[idx + 3] > 128) { // 不算已經透明的角
      bgR += data[idx];
      bgG += data[idx + 1];
      bgB += data[idx + 2];
      count++;
    }
  }
  if (count === 0) return result; // 四角都透明，無需處理
  bgR = Math.round(bgR / count);
  bgG = Math.round(bgG / count);
  bgB = Math.round(bgB / count);

  // BFS flood fill 從四角開始
  const queue: number[] = [];
  for (const [cx, cy] of corners) {
    const idx = cy * width + cx;
    if (!visited[idx]) {
      queue.push(idx);
      visited[idx] = 1;
    }
  }

  while (queue.length > 0) {
    const pos = queue.shift()!;
    const px = pos % width;
    const py = Math.floor(pos / width);
    const dataIdx = pos * 4;

    const r = result.data[dataIdx];
    const g = result.data[dataIdx + 1];
    const b = result.data[dataIdx + 2];

    // 判斷是否是背景色
    const dist = Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2);
    if (dist <= threshold) {
      // 標記為透明
      result.data[dataIdx + 3] = 0;

      // 擴展到相鄰像素
      const neighbors = [
        [px - 1, py], [px + 1, py],
        [px, py - 1], [px, py + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = ny * width + nx;
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            queue.push(nIdx);
          }
        }
      }
    }
  }

  return result;
}

// ─── 連通域分割 ──────────────────────────────────────

/**
 * 分割合併的形狀，返回每個獨立形狀的邊界框。
 */
export function autoSplit(source: ImageData): { x: number; y: number; w: number; h: number }[] {
  const { width, height, data } = source;
  const labels = new Int32Array(width * height);
  let nextLabel = 1;
  const boxes: Map<number, { minX: number; minY: number; maxX: number; maxY: number }> = new Map();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const a = data[idx * 4 + 3];
      if (a < 20 || labels[idx] !== 0) continue;

      // BFS 標記連通域
      const label = nextLabel++;
      const queue = [idx];
      labels[idx] = label;
      let minX = x, minY = y, maxX = x, maxY = y;

      while (queue.length > 0) {
        const pos = queue.shift()!;
        const px = pos % width;
        const py = Math.floor(pos / width);
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);

        const neighbors = [
          [px - 1, py], [px + 1, py],
          [px, py - 1], [px, py + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdx = ny * width + nx;
            if (labels[nIdx] === 0 && data[nIdx * 4 + 3] >= 20) {
              labels[nIdx] = label;
              queue.push(nIdx);
            }
          }
        }
      }

      boxes.set(label, { minX, minY, maxX, maxY });
    }
  }

  // 過濾掉太小的碎片（面積 < 總面積的 1%）
  const totalArea = width * height;
  return Array.from(boxes.values())
    .map(b => ({ x: b.minX, y: b.minY, w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1 }))
    .filter(b => b.w * b.h >= totalArea * 0.01);
}

// ─── 輔助函數 ────────────────────────────────────────

/** 在非透明像素邊緣添加 1px 黑色輪廓 */
function addOutline(imageData: ImageData, width: number, height: number): void {
  const { data } = imageData;
  const outlineColor = [30, 30, 30, 255]; // 深灰輪廓

  // 先標記需要添加輪廓的位置
  const outlinePositions: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < 20) {
        // 當前像素是透明的，檢查是否相鄰非透明像素
        const neighbors = [
          [x - 1, y], [x + 1, y],
          [x, y - 1], [x, y + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdx = (ny * width + nx) * 4;
            if (data[nIdx + 3] >= 20) {
              outlinePositions.push(idx);
              break;
            }
          }
        }
      }
    }
  }

  // 應用輪廓
  for (const idx of outlinePositions) {
    data[idx] = outlineColor[0];
    data[idx + 1] = outlineColor[1];
    data[idx + 2] = outlineColor[2];
    data[idx + 3] = outlineColor[3];
  }
}

/** 將 hex 顏色轉為 [r, g, b] */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/** 找到調色板中最接近的顏色 */
function findNearestColor(r: number, g: number, b: number, palette: string[]): [number, number, number] {
  let minDist = Infinity;
  let nearest: [number, number, number] = [r, g, b];

  for (const hex of palette) {
    const [pr, pg, pb] = hexToRgb(hex);
    const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (dist < minDist) {
      minDist = dist;
      nearest = [pr, pg, pb];
    }
  }

  return nearest;
}
