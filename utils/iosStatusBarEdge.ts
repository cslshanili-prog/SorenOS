import { Capacitor } from '@capacitor/core';
import { isStandaloneDisplayMode } from './iosStandalone';

type Color = [number, number, number, number];
const EDGE_ID = 'sully-ios-status-bar-edge';
const FALLBACK: Color = [15, 17, 21, 1];

export const shouldInstallIOSStatusBarEdge = (ua: string, standalone: boolean, native: boolean): boolean => {
    if (!standalone || native || !/iPhone|iPad|iPod/.test(ua)) return false;
    // Safari 27 的 UA 可能還寫著 CPU iPhone OS 18_7，有 Version/ 就優先看它。
    // 認不出或比較舊的系統一律不動，等有真機證據再說。
    const version = ua.match(/Version\/(\d+)/)?.[1] ?? ua.match(/OS (\d+)[_\.]/)?.[1];
    return Number(version) >= 27;
};

export const parseStatusBarColor = (value: string): Color | null => {
    if (value === 'transparent') return [0, 0, 0, 0];
    const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
    if (hex && [3, 4, 6, 8].includes(hex.length)) {
        const full = hex.length < 5 ? [...hex].map(char => char + char).join('') : hex;
        return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1];
    }
    const rgb = value.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[,\s/]+/).filter(Boolean);
    if (!rgb || rgb.length < 3) return null;
    const channels = rgb.slice(0, 3).map(part => parseFloat(part) * (part.endsWith('%') ? 2.55 : 1));
    const alpha = rgb[3] ? parseFloat(rgb[3]) / (rgb[3].endsWith('%') ? 100 : 1) : 1;
    if (![...channels, alpha].every(Number.isFinite)) return null;
    return [channels[0], channels[1], channels[2], Math.min(1, Math.max(0, alpha))];
};

/** 圖層照由前到後排；半透明的頂欄會跟下面那層合成。 */
export const blendStatusBarColors = (layers: Color[]): string => {
    let remaining = 1;
    const rgb = [0, 0, 0];
    for (const color of [...layers, FALLBACK]) {
        for (let channel = 0; channel < 3; channel++) rgb[channel] += color[channel] * color[3] * remaining;
        remaining *= 1 - color[3];
        if (remaining < 0.001) break;
    }
    return `rgb(${rgb.map(Math.round).join(', ')})`;
};

export const createIOSStatusBarEdge = (): HTMLDivElement => {
    const edge = document.createElement('div');
    edge.id = EDGE_ID;
    edge.setAttribute('aria-hidden', 'true');
    // R1/C 在使用者的 iPhone 上驗證過：空的 text 裁切保留 WebKit 取色用的背景宣告，
    // 但不會在內容上畫出一條 11px 的色條。
    edge.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:11px;z-index:2147483647;pointer-events:none;background-color:#0f1115;-webkit-background-clip:text;background-clip:text';
    return edge;
};

type Surface = { color: Color; image: string; width: number; height: number; opacity: number };

/** 頂端的代表色，不是截圖，也不保證跟圖片接得天衣無縫。 */
const readTopSurfaces = (edge: HTMLElement): Surface[] => {
    const elements = document.elementsFromPoint?.(Math.round(innerWidth / 2), 1) ?? [];
    const surfaces: Surface[] = [];
    for (const element of [...new Set([...elements, document.body, document.documentElement])]) {
        if (element === edge) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const color = parseStatusBarColor(style.backgroundColor) ?? [0, 0, 0, 0];
        const image = style.backgroundImage === 'none' ? '' : style.backgroundImage;
        if (color[3] === 0 && !image) continue;
        const bounds = element.getBoundingClientRect();
        surfaces.push({ color, image, width: bounds.width || innerWidth, height: bounds.height || innerHeight, opacity: Number(style.opacity || 1) });
        if (color[3] === 1 && Number(style.opacity || 1) === 1) break;
        if (surfaces.length >= 12) break;
    }
    return surfaces;
};

// 每個看得到的來源／尺寸只解碼一張小圖。跨域圖片沒開 CORS 就退回 CSS 底色，
// 不走代理、不上傳像素。
const sampleImageTop = (url: string, width: number, height: number): Promise<Color | null> => new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const finish = (color: Color | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        image.onload = image.onerror = null;
        resolve(color);
    };
    const timeout = window.setTimeout(() => finish(null), 2500);
    image.crossOrigin = 'anonymous';
    image.onload = () => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 8; canvas.height = 1;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context || !image.naturalWidth || !image.naturalHeight) return finish(null);
            // 桌布是 background-size:cover、background-position:center。
            const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
            const cropWidth = width / scale;
            const cropTop = (image.naturalHeight - height / scale) / 2;
            context.drawImage(image, (image.naturalWidth - cropWidth) / 2, cropTop, cropWidth, Math.max(1, 2 / scale), 0, 0, 8, 1);
            const pixels = context.getImageData(0, 0, 8, 1).data;
            const sum = [0, 0, 0, 0];
            for (let i = 0; i < pixels.length; i += 4) {
                const alpha = pixels[i + 3] / 255;
                for (let channel = 0; channel < 3; channel++) sum[channel] += pixels[i + channel] * alpha;
                sum[3] += alpha;
            }
            finish(sum[3] ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3], sum[3] / 8] : null);
        } catch { finish(null); }
    };
    image.onerror = () => finish(null);
    image.src = url;
});

export const installIOSStatusBarEdge = (): (() => void) => {
    const noop = () => {};
    if (typeof document === 'undefined' || !document.body) return noop;
    if (!shouldInstallIOSStatusBarEdge(navigator.userAgent, isStandaloneDisplayMode(), Capacitor.isNativePlatform())) return noop;
    if (document.getElementById(EDGE_ID)) return noop;

    // manifest 的 standalone 版面比 R1 的 web-clip 實驗大；系統把背景延伸進狀態列時
    // 不理那條裁切色條，照樣把內容糊掉。改用 contain 讓網頁內容停在系統狀態列下面；
    // 要在量安全區之前裝好。
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousViewport = viewport?.content;
    const contained = !!viewport && !!window.matchMedia?.('(display-mode: standalone)').matches;
    if (contained) {
        viewport.content = /viewport-fit\s*=\s*[^,]+/.test(viewport.content)
            ? viewport.content.replace(/viewport-fit\s*=\s*[^,]+/, 'viewport-fit=contain')
            : `${viewport.content}, viewport-fit=contain`;
        document.documentElement.setAttribute('data-ios-status-bar-contained', '');
    }

    const edge = createIOSStatusBarEdge();
    document.body.appendChild(edge);
    const imageColors = new Map<string, Promise<Color | null>>();
    let timer: number | undefined;
    let revision = 0;
    let disposed = false;

    const update = async (currentRevision: number) => {
        const layers: Color[] = [];
        for (const surface of readTopSurfaces(edge)) {
            let imageColor: Color | null = null;
            const url = surface.image.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
            if (url) {
                const key = `${url}|${surface.width}|${surface.height}`;
                if (!imageColors.has(key)) {
                    if (imageColors.size >= 12) imageColors.delete(imageColors.keys().next().value!);
                    imageColors.set(key, sampleImageTop(url, surface.width, surface.height));
                }
                imageColor = await imageColors.get(key)!;
            } else if (surface.image.includes('gradient(')) {
                // 實色的系統狀態列畫不出漸變，取第一個色標當穩定的代表色。
                const firstStop = surface.image.match(/rgba?\([^)]+\)|#[\da-f]{3,8}/i)?.[0];
                imageColor = firstStop ? parseStatusBarColor(firstStop) : null;
            }
            if (imageColor) layers.push([imageColor[0], imageColor[1], imageColor[2], imageColor[3] * surface.opacity]);
            layers.push([surface.color[0], surface.color[1], surface.color[2], surface.color[3] * surface.opacity]);
            if (layers.some(color => color[3] === 1)) break;
        }
        // 切頁之後才載完的桌布，不能把新畫面（例如聊天頂欄）的顏色蓋回去。
        if (disposed || revision !== currentRevision) return;
        const color = blendStatusBarColors(layers);
        if (edge.style.backgroundColor !== color) edge.style.backgroundColor = color;
        if (contained && document.documentElement.style.getPropertyValue('--ios-status-bar-color') !== color) {
            document.documentElement.style.setProperty('--ios-status-bar-color', color);
        }
    };
    const schedule = () => {
        revision++;
        // 合併成一次，但動畫期間也不能一直往後延。
        if (timer !== undefined) return;
        timer = window.setTimeout(() => { timer = undefined; void update(revision); }, 80);
    };
    const touchesTop = (node: Node) => {
        if (!(node instanceof Element) || node === edge) return false;
        if (node === document.documentElement || node === document.body || document.head.contains(node)) return true;
        const bounds = node.getBoundingClientRect();
        return bounds.top <= 1 && bounds.bottom >= 1;
    };
    const observer = new MutationObserver(records => {
        // 串流中的訊息文字不影響頂端，不用每個字都喚醒一次。
        if (records.some(record => touchesTop(record.target) && (
            record.type === 'attributes' ||
            record.target instanceof HTMLStyleElement ||
            [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element)
        ))) schedule();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    const events = ['pageshow', 'resize', 'orientationchange', 'focusout'];
    for (const event of events) window.addEventListener(event, schedule);
    const visible = () => { if (document.visibilityState === 'visible') schedule(); };
    document.addEventListener('visibilitychange', visible);
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('animationend', schedule, true);
    document.addEventListener('load', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    schedule();

    return () => {
        disposed = true;
        revision++;
        if (timer !== undefined) clearTimeout(timer);
        observer.disconnect();
        for (const event of events) window.removeEventListener(event, schedule);
        document.removeEventListener('visibilitychange', visible);
        document.removeEventListener('transitionend', schedule, true);
        document.removeEventListener('animationend', schedule, true);
        document.removeEventListener('load', schedule, true);
        window.visualViewport?.removeEventListener('resize', schedule);
        imageColors.clear();
        edge.remove();
        if (contained) {
            viewport.content = previousViewport!;
            document.documentElement.removeAttribute('data-ios-status-bar-contained');
            document.documentElement.style.removeProperty('--ios-status-bar-color');
        }
    };
};
