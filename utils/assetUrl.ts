/**
 * GitHub 素材倉庫（qegj567-cloud/SullyOS-assets）的統一出口 + 多 CDN 鏡像兜底。
 *
 * 背景：房間底圖 / 活動背景 / BGM 等素材託管在上面這個 GitHub 倉庫，之前散落著
 * jsDelivr / raw.githubusercontent 的寫死鏈接。單一 host 抽風時——jsDelivr 在大陸常被牆、
 * raw.githubusercontent 根本沒 CDN 全球都慢——用戶就「看不到圖」。
 *
 * 這裡把「倉庫內相對路徑」映射成一串跨【獨立網絡】的等價鏡像；主源拉不到就自動換下一個。
 * 同一個文件在各 CDN 邊緣字節完全一致，隨便切、切了就好。
 *
 * 三種消費方式，各用對應工具（都在瀏覽器裡跑，探測用 new Image()/<audio>）：
 *   · <img>          → components/os/CdnImg.tsx（onError 自動切鏡像）
 *   · CSS background → useResilientAssetUrl(path)（JS 預探測，返回第一個能加載的 url 並觸發重渲染）
 *   · new Audio()    → attachAudioMirrorFallback(audio, pathOrUrl)（error 事件切鏡像）
 * 不需要運行時兜底的一次性場景（canvas 合成等）直接 assetUrl(path) 拿主源即可。
 *
 * 注：sharkpan 等第三方圖床沒有等價鏡像，assetPathFromUrl 認不出會原樣返回單條，
 * 想讓它們也享受兜底得先把文件搬進這個 GitHub 倉庫。
 */

import { useEffect, useMemo, useState } from 'react';

const ASSETS_REPO = 'qegj567-cloud/SullyOS-assets';
const ASSETS_REF = 'main';

const stripLead = (p: string) => p.replace(/^\/+/, '');

/** 倉庫相對路徑 → 一串跨獨立網絡的等價鏡像 url（越靠前越優先）。 */
export function assetMirrors(path: string): string[] {
    const p = stripLead(path);
    return [
        `https://cdn.jsdelivr.net/gh/${ASSETS_REPO}@${ASSETS_REF}/${p}`,
        `https://fastly.jsdelivr.net/gh/${ASSETS_REPO}@${ASSETS_REF}/${p}`,
        `https://gcore.jsdelivr.net/gh/${ASSETS_REPO}@${ASSETS_REF}/${p}`,
        `https://cdn.statically.io/gh/${ASSETS_REPO}/${ASSETS_REF}/${p}`,
        `https://raw.githubusercontent.com/${ASSETS_REPO}/${ASSETS_REF}/${p}`,
    ];
}

/** 主源（mirror[0]）。給不需要運行時兜底的一次性場景。 */
export function assetUrl(path: string): string {
    return assetMirrors(path)[0];
}

/**
 * 把一個已知的完整素材 url（jsdelivr / statically / raw.githubusercontent 任意形態）反解回
 * 倉庫相對路徑，好讓歷史寫死鏈接也能接進鏡像兜底。認不出的（如 sharkpan 圖床）返回 null。
 */
export function assetPathFromUrl(url: string): string | null {
    let m = url.match(/\/gh\/[^/]+\/[^/@]+@[^/]+\/(.+)$/);                     // jsdelivr @ref
    if (m) return m[1];
    m = url.match(/statically\.io\/gh\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);           // statically /ref/
    if (m) return m[1];
    m = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);  // raw /ref/
    if (m) return m[1];
    return null;
}

/** 把任意素材 url 歸一成鏡像鏈：認得的按倉庫路徑展開，認不得的原樣單條返回。 */
export function mirrorsForUrl(url: string): string[] {
    const p = assetPathFromUrl(url);
    return p ? assetMirrors(p) : [url];
}

/**
 * Audio files need byte-range support. jsDelivr rejects this repository once its
 * total package size exceeds 50 MB, while Statically currently returns 403 for
 * these MP3 requests. Prefer GitHub Raw for audio so playback does not have to
 * fail through several known-bad mirrors before reaching the working source.
 */
export function audioMirrors(pathOrUrl: string): string[] {
    const mirrors = pathOrUrl.includes('://') ? mirrorsForUrl(pathOrUrl) : assetMirrors(pathOrUrl);
    const raw = mirrors.filter(url => url.startsWith('https://raw.githubusercontent.com/'));
    const rest = mirrors.filter(url => !url.startsWith('https://raw.githubusercontent.com/'));
    return [...raw, ...rest];
}

// ─── 運行時探測（瀏覽器）────────────────────────────────────────────────────
// 探測結果緩存（key=主源 url）：整個會話每個素材只探一次，命中直接複用。
const probed = new Map<string, string>();
const probing = new Map<string, Promise<string>>();

/** 依次嘗試鏡像，返回第一個能被瀏覽器成功加載為圖片的 url。全掛則回退末位鏡像。 */
export function loadFirstWorkingImage(mirrors: string[]): Promise<string> {
    if (!mirrors.length) return Promise.resolve('');
    const key = mirrors[0];
    const hit = probed.get(key);
    if (hit) return Promise.resolve(hit);
    const inflight = probing.get(key);
    if (inflight) return inflight;

    const run = (async () => {
        for (const url of mirrors) {
            const ok = await new Promise<boolean>((resolve) => {
                const img = new Image();
                img.onload = () => resolve(true);
                img.onerror = () => resolve(false);
                img.src = url;
            });
            if (ok) { probed.set(key, url); return url; }
        }
        const last = mirrors[mirrors.length - 1];
        probed.set(key, last); // 全掛：記末位，別每次重探
        return last;
    })();
    probing.set(key, run);
    run.finally(() => probing.delete(key));
    return run;
}

/**
 * CSS 背景專用 hook：給一個倉庫路徑，先同步返回主源（不留白），後台探測到能加載的鏡像後
 * 切過去並觸發重渲染。path 為空返回空字符串。
 */
export function useResilientAssetUrl(path: string | null | undefined): string {
    const mirrors = useMemo(() => (path ? assetMirrors(path) : []), [path]);
    const [url, setUrl] = useState<string>(() => mirrors[0] ?? '');
    useEffect(() => {
        if (!mirrors.length) { setUrl(''); return; }
        setUrl(mirrors[0]);
        let alive = true;
        loadFirstWorkingImage(mirrors).then((ok) => { if (alive && ok) setUrl(ok); });
        return () => { alive = false; };
    }, [mirrors]);
    return url;
}

/**
 * 給 JS 構造的 <audio> 掛 CDN 鏡像兜底：設好首源，加載/播放報錯就切下一個鏡像重試，
 * 全掛才罷休。返回解綁函數（調用它會移除監聽，元素複用換曲前先解綁舊的，避免監聽堆疊）。
 * pathOrUrl 可為倉庫相對路徑或完整素材 url。
 */
export function attachAudioMirrorFallback(audio: HTMLAudioElement, pathOrUrl: string): () => void {
    const mirrors = audioMirrors(pathOrUrl);
    let idx = 0;
    audio.src = mirrors[0];
    const onError = () => {
        if (idx >= mirrors.length - 1) return; // 鏡像用盡，認栽
        idx++;
        const wasPlaying = !audio.paused;
        audio.src = mirrors[idx];
        audio.load();
        if (wasPlaying) audio.play().catch(() => { /* 自動播放策略攔截：靜待用戶交互 */ });
    };
    audio.addEventListener('error', onError);
    return () => audio.removeEventListener('error', onError);
}
