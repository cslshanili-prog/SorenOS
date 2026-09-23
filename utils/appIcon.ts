// 自定義 PWA 應用圖標：把用戶選的圖接到 apple-touch-icon / favicon / manifest 上。
//
// 三條踩過的坑，改這份文件前先讀：
//
// 1. **只能有一個 apple-touch-icon**。index.html 裡寫死了一個 180x180 的，
//    如果再 append 一個同尺寸的，iOS 會挑排在前面那個（也就是原裝圖標），
//    新圖標靜默失效。所以這裡的做法是**改原有 link 的 href**，而不是新增。
//
// 2. **必須是 PNG**。iOS 的 apple-touch-icon 只穩定支持 PNG；上傳管線默認吐 JPEG、
//    圖床還可能給 WebP，直接用會被 iOS 忽略。統一走 utils/iconRaster 轉 PNG。
//
// 3. **尺寸要壓到 180**。源圖存的是 512，base64 後幾百 KB，塞進 href 又慢又冒險。
//
// 另一條固有約束（不是 bug，改不了）：圖標在「添加到主屏幕」那一刻固化。裝完之後
// 再改這裡的任何東西，主屏和通知圖標都不變，只能刪掉 App 重新添加。
//
// 詳見 docs/superpowers/specs/2026-08-09-pwa-custom-icon-design.md

import appMetadata from '../metadata.json';
import { getBlobForRef, isBlobRef, blobToDataUrl } from './blobRef';
import { toSquarePngDataUrl } from './iconRaster';

export const PWA_ICON_APP_ID = '_pwa_';
export const PWA_CLASSIC_ICON_VALUE = 'builtin:classic';
export const PWA_DEFAULT_ICON_URL = import.meta.env.BASE_URL + 'icons/jellyfish-512.png?v=38b1adde1d';
export const PWA_CLASSIC_ICON_URL = import.meta.env.BASE_URL + 'icons/icon-512.png';
let iconRevision = 0;

/** apple-touch-icon 的標準邊長。 */
const TOUCH_ICON_SIZE = 180;

const APPLE_ICON_SELECTOR = 'link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]';
const FAVICON_SELECTOR = 'link[rel~="icon"]:not([rel~="apple-touch-icon"])';
const MANIFEST_SELECTOR = 'link[rel="manifest"]';

// 原始 href 備份，clearPwaIcon 時逐個還原。
const originalHrefs = new WeakMap<HTMLLinkElement, string>();
let originalManifestHref: string | null = null;
let dynamicManifestUrl: string | null = null;

// ── 公開 API ──────────────────────────────────────────────────────

/**
 * 把圖標值（blobRef 令牌 / data: URI / http(s) URL）接到頁面上。
 * - 總是更新 apple-touch-icon + favicon（瀏覽器標籤頁當場就變）
 * - 同時更新 manifest，瀏覽器安裝前選擇的圖標也能生效
 */
export async function injectPwaIcon(value: string): Promise<void> {
  const revision = ++iconRevision;
  if (value === PWA_CLASSIC_ICON_VALUE) {
    applyHref(APPLE_ICON_SELECTOR, import.meta.env.BASE_URL + 'icons/apple-touch-icon.png', () => createAppleTouchIcon());
    applyHref(FAVICON_SELECTOR, import.meta.env.BASE_URL + 'icons/icon-192.png');
    const manifestLink = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
    if (manifestLink) {
      if (!originalManifestHref) originalManifestHref = manifestLink.href;
      manifestLink.href = new URL(import.meta.env.BASE_URL + 'manifest-classic.webmanifest', document.baseURI).href;
    }
    if (dynamicManifestUrl) { URL.revokeObjectURL(dynamicManifestUrl); dynamicManifestUrl = null; }
    return;
  }
  const source = await resolveIconSource(value);
  if (!source || revision !== iconRevision) return;

  const pngDataUrl = await rasterize(source, TOUCH_ICON_SIZE);
  if (!pngDataUrl || revision !== iconRevision) return;

  applyHref(APPLE_ICON_SELECTOR, pngDataUrl, () => createAppleTouchIcon());
  applyHref(FAVICON_SELECTOR, pngDataUrl);

  await replaceManifest(pngDataUrl, revision);
}

/** 恢復默認圖標：所有被改過的 href 還原。 */
export function clearPwaIcon(): void {
  iconRevision++;
  restoreHrefs(APPLE_ICON_SELECTOR);
  restoreHrefs(FAVICON_SELECTOR);

  const manifestLink = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
  if (manifestLink && originalManifestHref) {
    manifestLink.href = originalManifestHref;
  }
  if (dynamicManifestUrl) {
    URL.revokeObjectURL(dynamicManifestUrl);
    dynamicManifestUrl = null;
  }
}

/** 啟動時調用：customIcons 裡有 `_pwa_` 就接上。 */
export async function initPwaIcon(customIcons: Record<string, string>): Promise<void> {
  const icon = customIcons[PWA_ICON_APP_ID];
  if (!icon) return;
  try {
    await injectPwaIcon(icon);
  } catch (e) {
    console.warn('[PWA Icon] 啟動注入失敗', e);
  }
}

// ── 圖標源解析 ────────────────────────────────────────────────────

/** 把存儲值解析成能餵給 canvas 的東西：Blob 優先（不會汙染畫布），否則原樣的 URL 字符串。 */
async function resolveIconSource(value: string): Promise<Blob | string | null> {
  if (isBlobRef(value)) {
    const blob = await getBlobForRef(value);
    if (!blob) {
      console.warn('[PWA Icon] blobRef 令牌解析失敗，圖標可能已被清理');
      return null;
    }
    return blob;
  }
  if (value.startsWith('data:') || /^https?:\/\//i.test(value)) {
    return value;
  }
  console.warn('[PWA Icon] 不支持的圖標值:', value.slice(0, 50));
  return null;
}

/**
 * 轉成正方形 PNG data URL。轉換失敗時退回原圖（能顯示總比沒有強），
 * 但會明確警告——iOS 大概率不認非 PNG，這時候圖標就是不會變。
 */
async function rasterize(source: Blob | string, size: number): Promise<string | null> {
  try {
    return await toSquarePngDataUrl(source, size);
  } catch (e) {
    console.warn('[PWA Icon] 轉 PNG 失敗，退回原圖（iOS 可能不認非 PNG 格式）', e);
    if (typeof source === 'string') return source;
    try {
      return await blobToDataUrl(source);
    } catch {
      return null;
    }
  }
}

// ── DOM 操作 ──────────────────────────────────────────────────────

/**
 * 改掉匹配到的所有 link 的 href（首次調用時備份原值）。
 * 一個都沒匹配到且給了 fallback 時，創建一個。
 */
function applyHref(selector: string, href: string, createIfMissing?: () => HTMLLinkElement): void {
  const links = Array.from(document.querySelectorAll(selector)) as HTMLLinkElement[];

  if (links.length === 0 && createIfMissing) {
    links.push(createIfMissing());
  }

  for (const link of links) {
    if (!originalHrefs.has(link)) {
      originalHrefs.set(link, link.getAttribute('href') || '');
    }
    link.setAttribute('href', href);
  }
}

function restoreHrefs(selector: string): void {
  const links = Array.from(document.querySelectorAll(selector)) as HTMLLinkElement[];
  for (const link of links) {
    const original = originalHrefs.get(link);
    if (original === undefined) continue;
    if (original) link.setAttribute('href', original);
    else link.remove(); // 本來就是我們建的，直接刪掉
    originalHrefs.delete(link);
  }
}

function createAppleTouchIcon(): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'apple-touch-icon';
  link.setAttribute('sizes', `${TOUCH_ICON_SIZE}x${TOUCH_ICON_SIZE}`);
  document.head.appendChild(link);
  return link;
}

// ── manifest ──────────────────────────────────────────────────────

async function replaceManifest(iconDataUrl: string, revision: number): Promise<void> {
  const link = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
  if (!link) return;

  if (!originalManifestHref) originalManifestHref = link.href;

  try {
    const resp = await fetch(originalManifestHref);
    if (!resp.ok) throw new Error(`Fetch manifest failed: ${resp.status}`);
    const manifest = await resp.json();

    manifest.name = appMetadata.name;
    manifest.short_name = appMetadata.name;
    manifest.icons = [
      { src: iconDataUrl, sizes: '192x192', type: 'image/png' },
      { src: iconDataUrl, sizes: '512x512', type: 'image/png' },
      { src: iconDataUrl, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ];

    // 動態 manifest 掛的是 blob: 地址，裡面的相對路徑會相對 blob 解析導致 404。
    // 所有路徑先折成絕對地址（base 取原始 manifest 的絕對 URL）。
    const toAbs = (p: string): string => {
      if (!p || p.startsWith('data:') || /^https?:\/\//i.test(p)) return p;
      return new URL(p, originalManifestHref!).href;
    };
    if (manifest.start_url) manifest.start_url = toAbs(manifest.start_url);
    if (manifest.scope) manifest.scope = toAbs(manifest.scope);

    if (revision !== iconRevision) return;
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    if (dynamicManifestUrl) URL.revokeObjectURL(dynamicManifestUrl);
    dynamicManifestUrl = URL.createObjectURL(blob);
    link.href = dynamicManifestUrl;
  } catch (e) {
    console.warn('[PWA Icon] manifest 替換失敗，apple-touch-icon 已注入', e);
  }
}
