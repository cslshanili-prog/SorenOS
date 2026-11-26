import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { ShareCardOptions } from './pngShare';
import { armViewportReset, settleViewportReset } from './viewportReset';

export interface ShareOrDownloadOptions {
    /** 有可導入內容的分享入口：打開 PNG 分享卡編輯器，並保留原格式導出。 */
    card?: ShareCardOptions;
    /** 文件文本內容（目前導出都是文本，如 JSON / txt）。 */
    content: string;
    /** 帶擴展名的文件名，如 `worldbook.json`。 */
    fileName: string;
    /** MIME 類型，默認 `application/json`。 */
    mimeType?: string;
    /** 系統 / Web 分享面板標題，默認取文件名。 */
    shareTitle?: string;
}

export interface ShareOrDownloadBlobOptions {
    card?: ShareCardOptions;
    blob: Blob;
    fileName: string;
    shareTitle?: string;
    /** 大型 ZIP 在原生 WebView 中分片轉 base64 並追加寫盤，避免一次性讀入導致 OOM。 */
    nativeChunked?: boolean;
    /** 網頁端明確顯示為“下載”的入口跳過 Web Share；原生 App 仍使用系統分享。 */
    preferDownloadOnWeb?: boolean;
    /**
     * iOS 網頁（含加到主畫面）自動分享沒成功時，不要退回 `<a download>`：那條路會跳到 Safari 的檔案預覽頁，
     * 還要再點分享，回來畫面常常放大偏移。改回傳 'needs-tap'，由呼叫端放一顆「分享／存到檔案」讓用戶點
     * （點一下就有新的使用者手勢，分享面板一定開得出來）。原因記在 `lastWebShareFailure()`。
     */
    deferDownloadOnIos?: boolean;
}

export type ShareBlobResult = 'shared' | 'downloaded' | 'cancelled' | 'needs-tap';

/** 依副檔名補 MIME：邊壓邊寫的備份檔（OPFS 暫存檔）沒有 type，iOS 拿到沒有類型的檔案常常不肯直接分享 */
export function mimeForFileName(fileName: string, fallback = 'application/octet-stream'): string {
    const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    const map: Record<string, string> = {
        zip: 'application/zip', json: 'application/json', jsonl: 'application/jsonl', txt: 'text/plain', md: 'text/markdown',
        csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', pdf: 'application/pdf',
    };
    return map[ext] || fallback;
}

/** iPhone／iPad 的網頁（不是原生殼）；iPadOS 會冒充 Mac，靠觸控點認出來 */
export function isIosWeb(): boolean {
    if (typeof navigator === 'undefined' || Capacitor.isNativePlatform()) return false;
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

let lastShareFailure = '';
/** 上一次網頁分享沒成功的原因（錯誤名稱＋訊息，給「備份下載」視窗顯示、方便回報） */
export const lastWebShareFailure = (): string => lastShareFailure;

const NATIVE_WRITE_CHUNK_SIZE = 3 * 1024 * 1024;

// Capacitor's iOS and Android plugins reject with this message (without AbortError).
const isShareCancelled = (error: any): boolean => error?.name === 'AbortError'
    || /^share cancel(?:ed|led)$/i.test(String(error?.message || '').trim());

const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) reject(new Error('文件編碼失敗'));
        else resolve(dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('文件讀取失敗'));
    reader.readAsDataURL(blob);
});

const base64ToBlob = (value: string, mimeType: string): Blob => {
    const base64 = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
};

/** Fetch a downloadable blob, using native HTTP as a CORS-free fallback in Capacitor. */
export async function fetchBlobForShare(sourceUrl: string, fallbackMimeType = 'application/octet-stream'): Promise<Blob> {
    try {
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error('文件為空');
        return blob;
    } catch (webError) {
        if (!Capacitor.isNativePlatform() || !/^https?:\/\//i.test(sourceUrl)) throw webError;
        const response = await CapacitorHttp.request({ url: sourceUrl, method: 'GET', responseType: 'blob' });
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
        const blob = base64ToBlob(String(response.data || ''), String(response.headers?.['content-type'] || fallbackMimeType));
        if (!blob.size) throw new Error('文件為空');
        return blob;
    }
}

/**
 * 保存二進制媒體：原生殼寫緩存並調系統分享，移動瀏覽器優先 Web Share，
 * 桌面瀏覽器才使用 a.download。WebView 普遍不可靠的裸 download 點擊只作為末級兜底。
 */
export async function shareOrDownloadBlob(options: ShareOrDownloadBlobOptions & { deferDownloadOnIos: true }): Promise<ShareBlobResult>;
export async function shareOrDownloadBlob(options: ShareOrDownloadBlobOptions): Promise<'shared' | 'downloaded' | 'cancelled'>;
export async function shareOrDownloadBlob(options: ShareOrDownloadBlobOptions): Promise<ShareBlobResult> {
    // 跳去系統分享／存檔再回來，iOS 可能留下放大偏移的畫面（utils/viewportReset.ts）
    if (options.card) return shareOrDownloadBlobImpl(options);
    armViewportReset();
    try { return await shareOrDownloadBlobImpl(options); } finally { settleViewportReset(); }
}

async function shareOrDownloadBlobImpl(options: ShareOrDownloadBlobOptions): Promise<ShareBlobResult> {
    const { blob, fileName, shareTitle = fileName, nativeChunked = false, preferDownloadOnWeb = false, deferDownloadOnIos = false } = options;
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('文件為空，無法保存');
    if (options.card) {
        const { openShareCardDialog } = await import('../components/share/ShareCardDialog');
        return openShareCardDialog(options, options.card);
    }

    const nativePlatform = Capacitor.isNativePlatform();
    let nativeFailure: unknown = null;
    if (nativePlatform) {
        const tempName = `${fileName}.${Date.now()}.part`;
        try {
            if (nativeChunked && blob.size > NATIVE_WRITE_CHUNK_SIZE) {
                for (let start = 0, index = 0; start < blob.size; start += NATIVE_WRITE_CHUNK_SIZE, index += 1) {
                    const data = await blobToBase64(blob.slice(start, Math.min(start + NATIVE_WRITE_CHUNK_SIZE, blob.size)));
                    if (index === 0) {
                        await Filesystem.writeFile({ path: tempName, data, directory: Directory.Cache });
                    } else {
                        await Filesystem.appendFile({ path: tempName, data, directory: Directory.Cache });
                    }
                }
                await Filesystem.rename({ from: tempName, to: fileName, directory: Directory.Cache });
            } else {
                await Filesystem.writeFile({
                    path: fileName,
                    data: await blobToBase64(blob),
                    directory: Directory.Cache,
                });
            }
            const uriResult = await Filesystem.getUri({ directory: Directory.Cache, path: fileName });
            await Share.share({ title: shareTitle, files: [uriResult.uri] });
            return 'shared';
        } catch (error: any) {
            if (isShareCancelled(error)) return 'cancelled';
            console.error('Native Blob Share Error', error);
            nativeFailure = error;
            if (nativeChunked) {
                try { await Filesystem.deleteFile({ path: tempName, directory: Directory.Cache }); } catch { /* best effort */ }
            }
        }
    }

    lastShareFailure = '';
    let webShareTried = false;
    try {
        const file = new File([blob], fileName, { type: blob.type || mimeForFileName(fileName) });
        const hasShare = typeof navigator !== 'undefined' && !preferDownloadOnWeb && typeof navigator.share === 'function';
        const canShareFile = hasShare && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }));
        if (hasShare && !canShareFile) lastShareFailure = '瀏覽器說這個檔案不能分享（canShare false）';
        if (canShareFile) {
            webShareTried = true;
            await navigator.share({ title: shareTitle, files: [file] });
            return 'shared';
        }
    } catch (error: any) {
        if (isShareCancelled(error)) return 'cancelled';
        lastShareFailure = `${error?.name || 'Error'}: ${String(error?.message || error).slice(0, 160)}`;
        const expectedPermissionFallback = error?.name === 'NotAllowedError'
            || /permission denied|not allowed|user activation/i.test(String(error?.message || error));
        if (!expectedPermissionFallback) console.error('Web Blob Share Error', error);
    }

    // iOS 網頁：分享面板開不出來時別自動跳下載（會進 Safari 預覽頁、回來畫面放大），讓用戶自己點一下分享
    if (deferDownloadOnIos && isIosWeb() && !preferDownloadOnWeb && typeof navigator.share === 'function') {
        if (!webShareTried && !lastShareFailure) lastShareFailure = '沒有試分享';
        return 'needs-tap';
    }

    // 原生殼絕不能偽裝成“瀏覽器已下載”：WebView 的 a.download 正是最常見的無反應來源。
    if (nativePlatform) {
        throw nativeFailure instanceof Error ? nativeFailure : new Error('無法拉起系統文件分享');
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'downloaded';
}

/**
 * 「分享／存到檔案」按鈕用（剛點下去、有新的使用者手勢）：先分享原檔；分享面板開不出來、又不是手勢的問題
 * （例如瀏覽器不肯分享暫存區裡的檔案），改用記憶體裡的一份再試；都不行才退回下載連結。
 */
export async function shareBlobOnTap(blob: Blob, fileName: string, shareTitle = fileName): Promise<'shared' | 'downloaded' | 'cancelled'> {
    armViewportReset();
    try {
        const first = await shareOrDownloadBlobImpl({ blob, fileName, shareTitle, deferDownloadOnIos: true });
        if (first !== 'needs-tap') return first;
        const reason = lastShareFailure;
        if (!/NotAllowedError|activation/i.test(reason) && typeof navigator.share === 'function') {
            try {
                const copy = new File([await blob.arrayBuffer()], fileName, { type: mimeForFileName(fileName) });
                await navigator.share({ title: shareTitle, files: [copy] });
                return 'shared';
            } catch (error: any) {
                if (isShareCancelled(error)) return 'cancelled';
                lastShareFailure = `${reason}；記憶體副本：${error?.name || 'Error'}: ${String(error?.message || error).slice(0, 120)}`;
            }
        }
        const fallback = await shareOrDownloadBlobImpl({ blob, fileName, shareTitle, preferDownloadOnWeb: true });
        return fallback === 'needs-tap' ? 'downloaded' : fallback;
    } finally { settleViewportReset(); }
}

/**
 * 強制拉起分享的文件導出：原生（Capacitor Share）→ Web Share API → 瀏覽器下載兜底。
 *
 * SullyOS 常被包成移動端 WebView / 原生殼，這類環境裡 `<a download>` 往往不觸發任何東西，
 * 直接下載會「點了沒反應 = 導不出來」。所以先嘗試調起系統 / 瀏覽器的分享面板把文件送出去，
 * 只有在既沒有原生分享、也沒有 Web Share 能力時，才退回到瀏覽器下載。
 *
 * 與 apps/Character.tsx 的角色卡導出保持一致的三級兜底策略。
 *
 * @returns `'shared'` 已調起分享面板；`'downloaded'` 走了瀏覽器下載兜底。
 */
export async function shareOrDownloadFile(options: ShareOrDownloadOptions & { card?: undefined }): Promise<'shared' | 'downloaded'>;
export async function shareOrDownloadFile(options: ShareOrDownloadOptions): Promise<'shared' | 'downloaded' | 'cancelled'>;
export async function shareOrDownloadFile(options: ShareOrDownloadOptions): Promise<'shared' | 'downloaded' | 'cancelled'> {
    if (options.card) return shareOrDownloadFileImpl(options);
    armViewportReset();
    try { return await shareOrDownloadFileImpl(options); } finally { settleViewportReset(); }
}

async function shareOrDownloadFileImpl(options: ShareOrDownloadOptions): Promise<'shared' | 'downloaded' | 'cancelled'> {
    const { content, fileName, mimeType = 'application/json', shareTitle = fileName } = options;
    if (options.card) return shareOrDownloadBlob({ blob: new Blob([content], { type: mimeType }), fileName, shareTitle, card: options.card });

    // 1) 原生平台：寫緩存 → 取 URI → 調起系統分享面板。
    const nativePlatform = Capacitor.isNativePlatform();
    let nativeFailure: unknown = null;
    if (nativePlatform) {
        try {
            await Filesystem.writeFile({
                path: fileName,
                data: content,
                directory: Directory.Cache,
                encoding: Encoding.UTF8,
            });
            const uriResult = await Filesystem.getUri({
                directory: Directory.Cache,
                path: fileName,
            });
            await Share.share({
                title: shareTitle,
                files: [uriResult.uri],
            });
            return 'shared';
        } catch (e) {
            // 原生插件失敗後仍嘗試 Web Share；若也不可用則明確報錯，不偽裝成已下載。
            console.error('Native Export Error', e);
            nativeFailure = e;
        }
    }

    // 2) Web Share API（移動端瀏覽器 / 支持的 WebView）。
    try {
        const file = new File([content], fileName, { type: mimeType });
        const canShareFile = typeof navigator !== 'undefined'
            && typeof navigator.share === 'function'
            && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }));

        if (canShareFile) {
            await navigator.share({
                title: shareTitle,
                files: [file],
            });
            return 'shared';
        }
    } catch (e: any) {
        // 用戶取消（AbortError）與不支持的情況都繼續走下載兜底，保證一定能拿到文件。
        if (e?.name !== 'AbortError') {
            console.error('Web Share Export Error', e);
        }
    }

    if (nativePlatform) {
        throw nativeFailure instanceof Error ? nativeFailure : new Error('無法拉起系統文件分享');
    }

    // 3) 瀏覽器下載兜底。
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return 'downloaded';
}
