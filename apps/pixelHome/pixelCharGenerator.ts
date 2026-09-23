/**
 * Pixel Home — 像素小人生成器（基於圖層素材版）
 *
 * 素材位於 public/pixel-char/，按圖層從後到前合成：
 *   3-後發  → 2-身體(膚色+衣服+褲子+線稿) → 1-眼睛(顏色底+線稿) → 0-前發(顏色底+線稿)
 *
 * 每一層的"顏色底圖"是純色 alpha 蒙版，通過 Canvas 的 source-in 合成替換為用戶選擇的顏色；
 * 然後疊加同一位置的黑色線稿得到最終像素小人。
 */

export const ASSET_SIZE = { w: 53, h: 56 };
const OUTPUT_SCALE = 4; // 輸出再放大（保持像素風）

const BASE_URL = (import.meta as any).env?.BASE_URL ?? '/';
const asset = (p: string) => `${BASE_URL}pixel-char/${p}`.replace(/\/+/g, '/');

export const FRONT_HAIR_COUNT = 4;
export const BACK_HAIR_COUNT = 4;
export const EYE_COUNT = 3;

export const FRONT_HAIR_NAMES = ['前發A', '前發B', '前發C', '前發D'];
export const BACK_HAIR_NAMES = ['後發A', '後發B', '後發C', '後發D'];
export const EYE_NAMES = ['眼型1', '眼型2', '眼型3'];

export interface PixelCharConfig {
  /** 前發樣式，1..4；0 表示不戴前發 */
  frontHair: number;
  /** 後發樣式，1..4；0 表示不戴後發 */
  backHair: number;
  /** 眼睛樣式，1..3 */
  eyes: number;
  /** 頭髮顏色（同時作用於前發 + 後發） */
  hairColor: string;
  /** 眼睛顏色 */
  eyeColor: string;
  /** 膚色（body 填充） */
  skinTone: string;
  /** 上衣顏色 */
  outfitColor: string;
  /** 褲子顏色 */
  outfitColor2: string;
  /** 用戶直接上傳的像素小人 data URI（跳過合成） */
  customSprite?: string;
  /** 用戶在畫布上手繪覆蓋的像素："x,y" -> 顏色（或 'transparent' 表示擦除） */
  customPixels?: Record<string, string>;

  // ── 舊字段保留為可選，避免讀到老存檔時 TS 報錯 ──
  hairStyle?: number;
}

export const DEFAULT_CONFIG: PixelCharConfig = {
  frontHair: 1,
  backHair: 1,
  eyes: 1,
  hairColor: '#8b6914',
  eyeColor: '#4a3728',
  skinTone: '#fcd5b4',
  outfitColor: '#1e90ff',
  outfitColor2: '#2d3748',
};

export const HAIR_COLORS = [
  '#1a1a2e', '#2d3748', '#4a3728', '#8b6914',
  '#d4a017', '#e87461', '#c0392b', '#f5b7b1',
  '#a78bfa', '#e2e8f0', '#f4a460', '#ff6b9d',
];

export const EYE_COLORS = [
  '#63b3ed', '#48bb78', '#f6ad55', '#fc8181',
  '#b794f4', '#2d3748', '#e53e3e', '#d69e2e',
  '#4a3728', '#1a1a2e',
];

export const SKIN_TONES = [
  '#fce4d6', '#fcd5b4', '#f0c090', '#d4a574',
  '#c68642', '#8d5524', '#70361c',
];

export const OUTFIT_COLORS = [
  '#2d3748', '#1e3a5f', '#1a4731', '#5b1a1a',
  '#4a1a5e', '#e2e8f0', '#f5f0e1', '#c41e3a',
  '#1e90ff', '#ff6347', '#2ecc71', '#f39c12',
  '#ff6b9d', '#a78bfa', '#111111', '#ffffff',
];

// ─── 圖片加載 ────────────────────────────────────────

const imgCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imgCache.get(src);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load ${src}: ${e}`));
    img.src = src;
  });
  imgCache.set(src, p);
  return p;
}

/** 把顏色底圖按 alpha 蒙版貼上指定顏色 */
function drawTinted(
  dst: CanvasRenderingContext2D,
  maskImg: HTMLImageElement,
  color: string,
) {
  const tmp = document.createElement('canvas');
  tmp.width = ASSET_SIZE.w;
  tmp.height = ASSET_SIZE.h;
  const tctx = tmp.getContext('2d')!;
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(maskImg, 0, 0);
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, tmp.width, tmp.height);
  dst.drawImage(tmp, 0, 0);
}

// ─── 合成 ────────────────────────────────────────────

export async function generatePixelChar(config: PixelCharConfig): Promise<string> {
  if (config.customSprite) return config.customSprite;

  const {
    frontHair, backHair, eyes,
    hairColor, eyeColor, skinTone,
    outfitColor, outfitColor2, customPixels,
  } = { ...DEFAULT_CONFIG, ...config };

  // 預加載所有需要的圖片
  const jobs: Promise<HTMLImageElement | null>[] = [
    backHair > 0 ? loadImage(asset(`backhair/${backHair}-color.png`)) : Promise.resolve(null),
    backHair > 0 ? loadImage(asset(`backhair/${backHair}.png`)) : Promise.resolve(null),
    loadImage(asset('body/skin-color.png')),
    loadImage(asset('body/shirt-color.png')),
    loadImage(asset('body/pants-color.png')),
    loadImage(asset('body/body.png')),
    loadImage(asset('eyes/color.png')),
    loadImage(asset(`eyes/${eyes}.png`)),
    frontHair > 0 ? loadImage(asset(`fronthair/${frontHair}-color.png`)) : Promise.resolve(null),
    frontHair > 0 ? loadImage(asset(`fronthair/${frontHair}.png`)) : Promise.resolve(null),
  ];
  const [
    backHairColorMask, backHairLine,
    skinMask, shirtMask, pantsMask, bodyLine,
    eyeColorMask, eyeLine,
    frontHairColorMask, frontHairLine,
  ] = await Promise.all(jobs);

  const canvas = document.createElement('canvas');
  canvas.width = ASSET_SIZE.w;
  canvas.height = ASSET_SIZE.h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // 3-後發
  if (backHairColorMask) drawTinted(ctx, backHairColorMask, hairColor);
  if (backHairLine) ctx.drawImage(backHairLine, 0, 0);

  // 2-身體：皮膚底 + 衣服 + 褲子 + 黑色線稿
  if (skinMask) drawTinted(ctx, skinMask, skinTone);
  if (shirtMask) drawTinted(ctx, shirtMask, outfitColor);
  if (pantsMask) drawTinted(ctx, pantsMask, outfitColor2);
  if (bodyLine) ctx.drawImage(bodyLine, 0, 0);

  // 1-眼睛：統一顏色底 + 眼型線稿
  if (eyeColorMask) drawTinted(ctx, eyeColorMask, eyeColor);
  if (eyeLine) ctx.drawImage(eyeLine, 0, 0);

  // 0-前發
  if (frontHairColorMask) drawTinted(ctx, frontHairColorMask, hairColor);
  if (frontHairLine) ctx.drawImage(frontHairLine, 0, 0);

  // 眼睛"幽靈"層：30% 透明度壓在前發上方，營造"眼睛透過劉海"的二次元感
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = 0.3;
  if (eyeColorMask) drawTinted(ctx, eyeColorMask, eyeColor);
  if (eyeLine) ctx.drawImage(eyeLine, 0, 0);
  ctx.globalAlpha = prevAlpha;

  // 用戶手繪覆蓋（最頂層）
  if (customPixels) {
    for (const [key, color] of Object.entries(customPixels)) {
      const [cx, cy] = key.split(',').map(Number);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (cx < 0 || cx >= ASSET_SIZE.w || cy < 0 || cy >= ASSET_SIZE.h) continue;
      if (color === 'transparent' || color === '') {
        ctx.clearRect(cx, cy, 1, 1);
      } else {
        ctx.fillStyle = color;
        ctx.clearRect(cx, cy, 1, 1);
        ctx.fillRect(cx, cy, 1, 1);
      }
    }
  }

  // 放大輸出
  const display = document.createElement('canvas');
  display.width = ASSET_SIZE.w * OUTPUT_SCALE;
  display.height = ASSET_SIZE.h * OUTPUT_SCALE;
  const dctx = display.getContext('2d')!;
  dctx.imageSmoothingEnabled = false;
  dctx.drawImage(canvas, 0, 0, display.width, display.height);
  return display.toDataURL('image/png');
}

// ─── 緩存（同步讀取） ────────────────────────────────

const _cache = new Map<string, string>();
const _pending = new Map<string, Promise<string>>();
const _listeners = new Set<() => void>();

function keyOf(cfg: PixelCharConfig): string {
  if (cfg.customSprite) return `custom:${cfg.customSprite.length}:${cfg.customSprite.slice(-32)}`;
  return JSON.stringify({
    frontHair: cfg.frontHair, backHair: cfg.backHair, eyes: cfg.eyes,
    hairColor: cfg.hairColor, eyeColor: cfg.eyeColor, skinTone: cfg.skinTone,
    outfitColor: cfg.outfitColor, outfitColor2: cfg.outfitColor2,
    customPixels: cfg.customPixels || null,
  });
}

const TRANSPARENT_PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** 訂閱緩存更新，用於觸發 React 重渲染 */
export function onPixelCharCacheUpdate(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/**
 * 同步讀取緩存版本。若未緩存則立刻返回透明佔位圖並異步生成，生成完成後通知訂閱者。
 */
export function getCachedPixelChar(config: PixelCharConfig): string {
  if (config.customSprite) return config.customSprite;
  const k = keyOf(config);
  const hit = _cache.get(k);
  if (hit) return hit;
  if (!_pending.has(k)) {
    const task = generatePixelChar(config).then(uri => {
      _cache.set(k, uri);
      _pending.delete(k);
      _listeners.forEach(cb => { try { cb(); } catch {} });
      return uri;
    }).catch(err => {
      _pending.delete(k);
      throw err;
    });
    _pending.set(k, task);
  }
  return TRANSPARENT_PX;
}

/** 異步獲取並寫入緩存 */
export async function ensurePixelChar(config: PixelCharConfig): Promise<string> {
  if (config.customSprite) return config.customSprite;
  const k = keyOf(config);
  if (_cache.has(k)) return _cache.get(k)!;
  const uri = await generatePixelChar(config);
  _cache.set(k, uri);
  return uri;
}
