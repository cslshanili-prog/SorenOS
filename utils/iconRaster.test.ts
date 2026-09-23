/// <reference types="vitest" />
/**
 * utils/iconRaster.test.ts — 圖標柵格化的迴歸測試。
 *
 * 釘住的點：
 *   - 輸出恆為 PNG（iOS 的 apple-touch-icon 只穩定認 PNG）
 *   - cover 裁切：鋪滿正方形、居中、不變形（圖標不該留白邊或被拉扁）
 *   - Blob 走 objectURL 並回收；遠程 URL 帶 crossOrigin（否則汙染畫布 toDataURL 會拋）
 *
 * jsdom 沒有真實 canvas / 圖片解碼，所以 Image 和 canvas 都是替身，
 * 斷言落在「傳給 drawImage 的參數對不對」這一層。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toSquarePngDataUrl } from './iconRaster';

const PNG_OUT = 'data:image/png;base64,STUB';

// ── 替身 ────────────────────────────────────────────────────────────

type DrawCall = { x: number; y: number; w: number; h: number };

let drawCalls: DrawCall[] = [];
let toDataUrlCalls: Array<string | undefined> = [];
let canvasSizes: Array<{ w: number; h: number }> = [];
let createdObjectUrls: string[] = [];
let revokedObjectUrls: string[] = [];

/** 受控的 Image 替身：設 src 後由測試決定 onload / onerror 何時觸發。 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  width = 0;
  height = 0;
  #src = '';

  // 測試通過這兩個字段控制這張「圖」的原始尺寸與加載結果
  static nextSize: { width: number; height: number } = { width: 100, height: 100 };
  static nextResult: 'load' | 'error' = 'load';
  static lastInstance: FakeImage | null = null;

  set src(v: string) {
    this.#src = v;
    FakeImage.lastInstance = this;
    // 異步觸發，貼近真實瀏覽器行為
    setTimeout(() => {
      if (FakeImage.nextResult === 'error') {
        this.onerror?.();
        return;
      }
      this.width = FakeImage.nextSize.width;
      this.height = FakeImage.nextSize.height;
      this.onload?.();
    }, 0);
  }
  get src() { return this.#src; }
}

let origImage: any;
let origCreateElement: any;
let origCreateObjectURL: any;
let origRevokeObjectURL: any;

/** canvas 替身：記下尺寸、drawImage 參數、toDataURL 的 mime。 */
function makeFakeCanvas(ctxAvailable = true) {
  const canvas: any = {
    set width(v: number) { canvas._w = v; canvasSizes.push({ w: v, h: canvas._h ?? 0 }); },
    get width() { return canvas._w; },
    set height(v: number) {
      canvas._h = v;
      if (canvasSizes.length) canvasSizes[canvasSizes.length - 1].h = v;
    },
    get height() { return canvas._h; },
    getContext: () => (ctxAvailable ? ctx : null),
    toDataURL: (mime?: string) => { toDataUrlCalls.push(mime); return PNG_OUT; },
  };
  const ctx: any = {
    clearRect: () => {},
    drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => {
      drawCalls.push({ x, y, w, h });
    },
  };
  return canvas;
}

let ctxAvailable = true;

beforeEach(() => {
  drawCalls = [];
  toDataUrlCalls = [];
  canvasSizes = [];
  createdObjectUrls = [];
  revokedObjectUrls = [];
  ctxAvailable = true;
  FakeImage.nextSize = { width: 100, height: 100 };
  FakeImage.nextResult = 'load';
  FakeImage.lastInstance = null;

  origImage = globalThis.Image;
  (globalThis as any).Image = FakeImage;

  origCreateElement = document.createElement;
  document.createElement = ((tag: string) => {
    if (tag === 'canvas') return makeFakeCanvas(ctxAvailable);
    return origCreateElement.call(document, tag);
  }) as any;

  origCreateObjectURL = (URL as any).createObjectURL;
  origRevokeObjectURL = (URL as any).revokeObjectURL;
  let n = 0;
  (URL as any).createObjectURL = () => {
    const u = `blob:fake-${++n}`;
    createdObjectUrls.push(u);
    return u;
  };
  (URL as any).revokeObjectURL = (u: string) => { revokedObjectUrls.push(u); };
});

afterEach(() => {
  (globalThis as any).Image = origImage;
  document.createElement = origCreateElement;
  if (origCreateObjectURL !== undefined) (URL as any).createObjectURL = origCreateObjectURL;
  else delete (URL as any).createObjectURL;
  if (origRevokeObjectURL !== undefined) (URL as any).revokeObjectURL = origRevokeObjectURL;
  else delete (URL as any).revokeObjectURL;
  vi.restoreAllMocks();
});

const blob = (type = 'image/jpeg') => new Blob(['bytes'], { type });

// ── 輸出格式 ────────────────────────────────────────────────────────

describe('輸出格式', () => {
  it('恆為 PNG —— 源圖是 JPEG 也一樣', async () => {
    const out = await toSquarePngDataUrl(blob('image/jpeg'), 180);

    expect(out).toBe(PNG_OUT);
    expect(toDataUrlCalls).toEqual(['image/png']);
  });

  it('源圖是 WebP 也轉 PNG', async () => {
    await toSquarePngDataUrl(blob('image/webp'), 180);

    expect(toDataUrlCalls).toEqual(['image/png']);
  });

  it('canvas 按請求的邊長開', async () => {
    await toSquarePngDataUrl(blob(), 180);

    expect(canvasSizes).toEqual([{ w: 180, h: 180 }]);
  });
});

// ── cover 裁切 ──────────────────────────────────────────────────────

describe('cover 裁切', () => {
  it('正方形源圖：鋪滿，不偏移', async () => {
    FakeImage.nextSize = { width: 512, height: 512 };

    await toSquarePngDataUrl(blob(), 180);

    expect(drawCalls).toEqual([{ x: 0, y: 0, w: 180, h: 180 }]);
  });

  it('寬圖：按高度鋪滿，左右等量裁掉', async () => {
    FakeImage.nextSize = { width: 400, height: 200 }; // 2:1

    await toSquarePngDataUrl(blob(), 180);

    const [call] = drawCalls;
    // 高度撐滿 180，寬度等比放大到 360
    expect(call.h).toBeCloseTo(180);
    expect(call.w).toBeCloseTo(360);
    // 水平居中：(180 - 360) / 2 = -90
    expect(call.x).toBeCloseTo(-90);
    expect(call.y).toBeCloseTo(0);
  });

  it('高圖：按寬度鋪滿，上下等量裁掉', async () => {
    FakeImage.nextSize = { width: 200, height: 400 }; // 1:2

    await toSquarePngDataUrl(blob(), 180);

    const [call] = drawCalls;
    expect(call.w).toBeCloseTo(180);
    expect(call.h).toBeCloseTo(360);
    expect(call.x).toBeCloseTo(0);
    expect(call.y).toBeCloseTo(-90);
  });

  it('小圖會放大鋪滿，不留透明邊', async () => {
    FakeImage.nextSize = { width: 64, height: 64 };

    await toSquarePngDataUrl(blob(), 180);

    expect(drawCalls).toEqual([{ x: 0, y: 0, w: 180, h: 180 }]);
  });

  it('寬高比保持不變（不拉扁）', async () => {
    FakeImage.nextSize = { width: 300, height: 100 }; // 3:1

    await toSquarePngDataUrl(blob(), 180);

    const [call] = drawCalls;
    expect(call.w / call.h).toBeCloseTo(3);
  });
});

// ── 輸入來源 ────────────────────────────────────────────────────────

describe('輸入來源', () => {
  it('Blob：建 objectURL，用完回收', async () => {
    await toSquarePngDataUrl(blob(), 180);

    expect(createdObjectUrls).toHaveLength(1);
    expect(revokedObjectUrls).toEqual(createdObjectUrls);
  });

  it('Blob 不設 crossOrigin（本地數據不涉及 CORS）', async () => {
    await toSquarePngDataUrl(blob(), 180);

    expect(FakeImage.lastInstance!.crossOrigin).toBeNull();
  });

  it('遠程 URL 帶 crossOrigin=anonymous（不然畫布被汙染、toDataURL 拋錯）', async () => {
    await toSquarePngDataUrl('https://cdn.example.com/x.png', 180);

    expect(FakeImage.lastInstance!.crossOrigin).toBe('anonymous');
    expect(createdObjectUrls).toHaveLength(0); // 字符串源不建 objectURL
  });

  it('data: URL 直接用', async () => {
    await toSquarePngDataUrl('data:image/png;base64,AAA', 180);

    expect(FakeImage.lastInstance!.src).toBe('data:image/png;base64,AAA');
  });
});

// ── 失敗路徑 ────────────────────────────────────────────────────────

describe('失敗路徑', () => {
  it('圖片加載不出來 → reject，並回收 objectURL', async () => {
    FakeImage.nextResult = 'error';

    await expect(toSquarePngDataUrl(blob(), 180)).rejects.toThrow('圖片加載失敗');
    expect(revokedObjectUrls).toEqual(createdObjectUrls);
  });

  it('canvas context 拿不到 → reject，並回收 objectURL', async () => {
    ctxAvailable = false;

    await expect(toSquarePngDataUrl(blob(), 180)).rejects.toThrow('Canvas context');
    expect(revokedObjectUrls).toEqual(createdObjectUrls);
  });
});
