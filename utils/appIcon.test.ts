/// <reference types="vitest" />
/**
 * utils/appIcon.test.ts — PWA 圖標註入的迴歸測試。
 *
 * 釘住的三條不變式（每條都對應一個真實踩過的坑，見 appIcon.ts 頂部註釋）：
 *   1. 頁面上只能有一個 apple-touch-icon —— 多了 iOS 會挑排在前面的原裝圖標，新圖標靜默失效。
 *   2. href 必須是 PNG data URI —— iOS 只穩定認 PNG，JPEG/WebP 會被忽略。
 *   3. manifest 裡相對路徑要折成絕對地址 —— 動態 manifest 的 base 是 blob: URL。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock ────────────────────────────────────────────────────────────

const mockGetBlobForRef = vi.fn();
const mockBlobToDataUrl = vi.fn();
const mockIsStandalone = vi.fn();
const mockToSquarePngDataUrl = vi.fn();

vi.mock('./blobRef', () => ({
  isBlobRef: (v: unknown) => typeof v === 'string' && v.startsWith('blobref:'),
  getBlobForRef: (...args: any[]) => mockGetBlobForRef(...args),
  blobToDataUrl: (...args: any[]) => mockBlobToDataUrl(...args),
}));

vi.mock('./iosStandalone', () => ({
  isStandaloneDisplayMode: () => mockIsStandalone(),
}));

// canvas 在 jsdom 裡沒法真的渲染，柵格化整層 mock 掉；
// 真實的裁切/編碼邏輯由 iconRaster.test.ts 單獨覆蓋。
vi.mock('./iconRaster', () => ({
  toSquarePngDataUrl: (...args: any[]) => mockToSquarePngDataUrl(...args),
}));

// jsdom 沒有 URL.createObjectURL / revokeObjectURL；墊一層並記下 Blob 內容，
// 測試可以直接讀回生成的 manifest。
let lastBlobUrlId = 0;
const blobStore = new Map<string, Blob>();

const mockCreateObjectURL = (blob: Blob): string => {
  const id = `blob:mock-${++lastBlobUrlId}`;
  blobStore.set(id, blob);
  return id;
};
const mockRevokeObjectURL = (url: string): void => { blobStore.delete(url); };

// 轉出來的 PNG（內容不重要，前綴重要）
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAA';
// 源圖故意用 JPEG，用來驗證「不管進來什麼都得轉成 PNG」
const SOURCE_JPEG_BLOB = () => new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });

import { injectPwaIcon, clearPwaIcon, initPwaIcon, PWA_ICON_APP_ID, PWA_CLASSIC_ICON_VALUE } from './appIcon';

// ── helpers ─────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';
const ORIGINAL_MANIFEST_HREF = `${BASE}/manifest.webmanifest`;
const ORIGINAL_TOUCH_ICON_HREF = './icons/apple-touch-icon.png';
const ORIGINAL_FAVICON_HREF = './icons/icon-192.png';

/** 復刻 index.html 裡真實的三行 link（含那個寫死的 apple-touch-icon）。 */
function setupDOM() {
  document.head.innerHTML = `
    <link rel="icon" type="image/png" href="${ORIGINAL_FAVICON_HREF}">
    <link rel="apple-touch-icon" sizes="180x180" href="${ORIGINAL_TOUCH_ICON_HREF}">
    <link rel="manifest" href="${ORIGINAL_MANIFEST_HREF}">
  `;
}

const appleIconLinks = () =>
  Array.from(document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]'));
const faviconLinks = () =>
  Array.from(document.querySelectorAll('link[rel~="icon"]:not([rel~="apple-touch-icon"])'));

const appleIconHrefs = () => appleIconLinks().map(l => l.getAttribute('href'));
const faviconHrefs = () => faviconLinks().map(l => l.getAttribute('href'));
const manifestHref = () => document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null;

const SAMPLE_MANIFEST = {
  short_name: 'SullyOS',
  name: 'SullyOS',
  display: 'standalone' as const,
  theme_color: '#0f1115',
  background_color: '#0f1115',
  start_url: './',
  scope: './',
  icons: [
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

// ── setup / teardown ────────────────────────────────────────────────

let origCreate: any;
let origRevoke: any;

beforeEach(() => {
  origCreate = (URL as any).createObjectURL;
  origRevoke = (URL as any).revokeObjectURL;
  (URL as any).createObjectURL = mockCreateObjectURL;
  (URL as any).revokeObjectURL = mockRevokeObjectURL;
  blobStore.clear();
  lastBlobUrlId = 0;

  setupDOM();
  mockGetBlobForRef.mockReset();
  mockBlobToDataUrl.mockReset();
  mockIsStandalone.mockReset();
  mockToSquarePngDataUrl.mockReset();

  mockIsStandalone.mockReturnValue(false);
  // 默認：柵格化成功，返回 PNG
  mockToSquarePngDataUrl.mockResolvedValue(PNG_DATA_URL);

  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    if (url === ORIGINAL_MANIFEST_HREF) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...SAMPLE_MANIFEST }) } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch url: ${url}`));
  });
});

afterEach(() => {
  clearPwaIcon();
  if (origCreate !== undefined) (URL as any).createObjectURL = origCreate;
  else delete (URL as any).createObjectURL;
  if (origRevoke !== undefined) (URL as any).revokeObjectURL = origRevoke;
  else delete (URL as any).revokeObjectURL;
  vi.restoreAllMocks();
});

// ── 不變式 1：只能有一個 apple-touch-icon ───────────────────────────

describe('只能有一個 apple-touch-icon（iOS 會挑排在前面那個）', () => {
  beforeEach(() => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
  });

  it('注入後 apple-touch-icon 仍然只有一個', async () => {
    expect(appleIconLinks()).toHaveLength(1); // index.html 自帶那一個

    await injectPwaIcon('blobref:test');

    expect(appleIconLinks()).toHaveLength(1);
  });

  it('改的是原有 link 的 href，不是 append 新的', async () => {
    await injectPwaIcon('blobref:test');

    // 唯一那個 link 的 href 已經是新圖標——舊的 ./icons/apple-touch-icon.png 不存在了
    expect(appleIconHrefs()).toEqual([PNG_DATA_URL]);
    expect(appleIconHrefs()).not.toContain(ORIGINAL_TOUCH_ICON_HREF);
  });

  it('反覆注入也不會堆出第二個 link', async () => {
    await injectPwaIcon('blobref:a');
    await injectPwaIcon('blobref:b');
    await injectPwaIcon('blobref:c');

    expect(appleIconLinks()).toHaveLength(1);
  });

  it('頁面上有 precomposed 變體時也一起改掉（否則它會搶贏）', async () => {
    const extra = document.createElement('link');
    extra.rel = 'apple-touch-icon-precomposed';
    extra.setAttribute('href', './icons/old-precomposed.png');
    document.head.appendChild(extra);

    await injectPwaIcon('blobref:test');

    // 兩個都指向新圖標，沒有任何一個還留著舊地址
    expect(appleIconHrefs()).toEqual([PNG_DATA_URL, PNG_DATA_URL]);
  });

  it('頁面上沒有 apple-touch-icon 時會建一個', async () => {
    document.head.innerHTML = `<link rel="manifest" href="${ORIGINAL_MANIFEST_HREF}">`;

    await injectPwaIcon('blobref:test');

    expect(appleIconLinks()).toHaveLength(1);
    expect(appleIconHrefs()).toEqual([PNG_DATA_URL]);
  });
});

// ── 不變式 2：href 必須是 PNG ───────────────────────────────────────

describe('href 必須是 PNG（iOS 只認 PNG）', () => {
  it('源圖是 JPEG 也要轉成 PNG data URI', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:jpeg-source');

    const href = appleIconHrefs()[0]!;
    expect(href).toMatch(/^data:image\/png;base64,/);
    // 不能是 blob:（iOS/Chrome 不認作圖標）
    expect(href).not.toMatch(/^blob:/);
  });

  it('柵格化尺寸固定 180（apple-touch-icon 標準邊長）', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:test');

    expect(mockToSquarePngDataUrl).toHaveBeenCalledWith(expect.anything(), 180);
  });

  it('data: 源圖也過一遍柵格化——原圖可能是 JPEG/WebP', async () => {
    await injectPwaIcon('data:image/webp;base64,UklGRg==');

    expect(mockToSquarePngDataUrl).toHaveBeenCalled();
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });

  it('柵格化失敗 → 退回原圖，不讓頁面沒圖標', async () => {
    mockToSquarePngDataUrl.mockRejectedValue(new Error('canvas 掛了'));
    const rawDataUrl = 'data:image/jpeg;base64,/9j/4AA';

    await injectPwaIcon(rawDataUrl);

    expect(appleIconHrefs()[0]).toBe(rawDataUrl);
  });

  it('柵格化失敗且源是 Blob → 走 blobToDataUrl 兜底', async () => {
    mockToSquarePngDataUrl.mockRejectedValue(new Error('canvas 掛了'));
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
    mockBlobToDataUrl.mockResolvedValue('data:image/jpeg;base64,fallback');

    await injectPwaIcon('blobref:test');

    expect(appleIconHrefs()[0]).toBe('data:image/jpeg;base64,fallback');
  });
});

// ── favicon 一起換（UI 提示說了「標籤頁圖標已更新」，得真的更新） ────

describe('favicon 同步更新', () => {
  it('rel="icon" 的 href 也換成新圖標', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    expect(faviconHrefs()).toEqual([ORIGINAL_FAVICON_HREF]);

    await injectPwaIcon('blobref:test');

    expect(faviconHrefs()).toEqual([PNG_DATA_URL]);
  });

  it('favicon 選擇器不會誤傷 apple-touch-icon', async () => {
    // rel~="icon" 若不排除 apple-touch-icon，兩者會互相干擾
    expect(faviconLinks()).toHaveLength(1);
    expect(faviconLinks()[0].getAttribute('rel')).toBe('icon');
  });
});

// ── 輸入合法性 ─────────────────────────────────────────────────────

describe('輸入合法性', () => {
  it('http URL → 直接交給柵格化（會帶 crossOrigin）', async () => {
    const remote = 'https://cdn.example.com/icon.png';
    await injectPwaIcon(remote);

    expect(mockToSquarePngDataUrl).toHaveBeenCalledWith(remote, 180);
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });

  it('blobRef 解析失敗 → 什麼都不改，不拋異常', async () => {
    mockGetBlobForRef.mockResolvedValue(null);

    await expect(injectPwaIcon('blobref:dead')).resolves.toBeUndefined();
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
    expect(faviconHrefs()).toEqual([ORIGINAL_FAVICON_HREF]);
  });

  it('亂七八糟的值 → 什麼都不改，不拋異常', async () => {
    await expect(injectPwaIcon('/relative/path.png')).resolves.toBeUndefined();
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
  });
});

// ── 不變式 3：manifest（standalone） ────────────────────────────────

describe('manifest 替換（standalone）', () => {
  beforeEach(() => {
    mockIsStandalone.mockReturnValue(true);
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
  });

  const readManifest = async () => {
    const blob = blobStore.get(manifestHref()!);
    expect(blob).toBeTruthy();
    return JSON.parse(await blob!.text());
  };

  it('manifest href 換成 blob: URL', async () => {
    await injectPwaIcon('blobref:test');
    expect(manifestHref()).toMatch(/^blob:mock-/);
  });

  it('圖標槽全部換成 PNG data URI', async () => {
    await injectPwaIcon('blobref:test');
    const manifest = await readManifest();

    expect(manifest.icons).toHaveLength(3); // 192 / 512 / 512 maskable
    for (const icon of manifest.icons) {
      expect(icon.src).toBe(PNG_DATA_URL);
      expect(icon.type).toBe('image/png');
    }
  });

  it('相對路徑折成絕對地址（blob: base 會讓相對路徑 404）', async () => {
    await injectPwaIcon('blobref:test');
    const manifest = await readManifest();

    expect(manifest.start_url).toBe(`${BASE}/`);
    expect(manifest.scope).toBe(`${BASE}/`);
    // Even a cached manifest with the old name keeps the updated display name.
    expect(manifest.name).toBe('Soren');
    expect(manifest.short_name).toBe('Soren');
  });

  it('瀏覽器安裝前也更新 manifest', async () => {
    mockIsStandalone.mockReturnValue(false);

    await injectPwaIcon('blobref:test');

    expect(manifestHref()).toMatch(/^blob:mock-/);
  });

  it('fetch manifest 失敗 → apple-touch-icon 照常更新，不拋異常', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    await expect(injectPwaIcon('blobref:test')).resolves.toBeUndefined();
    expect(manifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });
});

// ── clearPwaIcon ────────────────────────────────────────────────────

describe('clearPwaIcon', () => {
  it('所有 href 還原成原始值', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
    mockIsStandalone.mockReturnValue(true);

    await injectPwaIcon('blobref:test');
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);

    clearPwaIcon();

    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
    expect(faviconHrefs()).toEqual([ORIGINAL_FAVICON_HREF]);
    expect(manifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
  });

  it('還原後 apple-touch-icon 數量不變（不留殘骸也不刪原裝）', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:test');
    clearPwaIcon();

    expect(appleIconLinks()).toHaveLength(1);
  });

  it('原本沒有 apple-touch-icon 時，還原會把建的那個刪掉', async () => {
    document.head.innerHTML = `<link rel="manifest" href="${ORIGINAL_MANIFEST_HREF}">`;
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:test');
    expect(appleIconLinks()).toHaveLength(1);

    clearPwaIcon();
    expect(appleIconLinks()).toHaveLength(0);
  });

  it('沒注入過時調用也不拋異常', () => {
    expect(() => clearPwaIcon()).not.toThrow();
  });
});

// ── initPwaIcon ─────────────────────────────────────────────────────

describe('initPwaIcon', () => {
  it('customIcons 裡有 _pwa_ → 接上', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await initPwaIcon({ [PWA_ICON_APP_ID]: 'blobref:saved', some_app: 'blobref:other' });

    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });

  it('沒有 _pwa_ → 一動不動', async () => {
    await initPwaIcon({ some_app: 'blobref:other' });

    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
    expect(mockGetBlobForRef).not.toHaveBeenCalled();
  });

  it('空對象 → 不炸', async () => {
    await expect(initPwaIcon({})).resolves.toBeUndefined();
  });

  it('注入過程拋異常也不會把啟動流程帶崩', async () => {
    mockGetBlobForRef.mockRejectedValue(new Error('IndexedDB 掛了'));

    await expect(initPwaIcon({ [PWA_ICON_APP_ID]: 'blobref:x' })).resolves.toBeUndefined();
  });
});

// ── 常量 ───────────────────────────────────────────────────────────

describe('PWA_ICON_APP_ID', () => {
  it('是 _pwa_，下劃線前綴保證不跟 App id 撞名', () => {
    expect(PWA_ICON_APP_ID).toBe('_pwa_');
    expect(PWA_ICON_APP_ID.startsWith('_')).toBe(true);
  });
});

describe('built-in icon choices', () => {
  it.each([false, true])('classic uses bundled PNGs and a stable manifest (standalone=%s)', async standalone => {
    mockIsStandalone.mockReturnValue(standalone);
    await injectPwaIcon(PWA_CLASSIC_ICON_VALUE);
    expect(appleIconHrefs()[0]).toMatch(/icons\/apple-touch-icon\.png$/);
    expect(manifestHref()).toMatch(/manifest-classic\.webmanifest$/);
    expect(mockGetBlobForRef).not.toHaveBeenCalled();
    expect(mockToSquarePngDataUrl).not.toHaveBeenCalled();
    clearPwaIcon();
    expect(manifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
  });
  it('restores classic from the existing saved icon field', async () => {
    await initPwaIcon({ [PWA_ICON_APP_ID]: PWA_CLASSIC_ICON_VALUE });
    expect(manifestHref()).toMatch(/manifest-classic\.webmanifest$/);
  });
  it('a slow upload cannot overwrite a later default selection', async () => {
    let release!: (blob: Blob) => void;
    mockGetBlobForRef.mockReturnValue(new Promise<Blob>(resolve => { release = resolve; }));
    const pending = injectPwaIcon('blobref:slow');
    clearPwaIcon();
    release(SOURCE_JPEG_BLOB());
    await pending;
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
  });
});
