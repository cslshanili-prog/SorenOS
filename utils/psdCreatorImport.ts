/**
 * 捏人器 PSD 整批導入（開發模式）。
 *
 * 畫師在一個 PSD 裡按"頂層圖層組 = 一個類目，組內每個圖層 = 一個部件"組織素材，
 * 直接把整個 PSD 丟進來，免去逐張導出 / 重命名 / 上傳的流程。約定：
 *
 * - 畫布須與捏人器素材同規格（472×472 正方形；過大會自動縮到 944 以內）。
 *   每個圖層按其在畫布上的位置導出，錨點天然對齊。
 * - **頂層圖層組 = 一個類目**（如"眼睛"文件夾），組名給出類目；
 *   **組內每個圖層 = 一個獨立部件**（如眼睛組裡"杏眼""圓眼""狐狸眼"各一個圖層，各成一個部件），
 *   圖層名 = 部件顯示名，類目繼承所在組。
 *   組內若有子圖層組，則該子組的圖層合併成一個部件（少數需要多圖層的部件用得上）。
 * - 頂層散圖層（不在組裡）= 一個部件，類目從它自己的名字猜。
 * - 組名 / 圖層名裡的類目別名支持中文或英文 key，如 `前發`、`earhair`、`後發1`。
 *   識別不出類目的，在開發面板裡手動選。
 * - 可換色標記：名字帶 `#色` / `#tint` 強制可換色，帶 `#原色` / `#notint`
 *   強制不可換色；不標記時頭髮四類 + 眼睛默認可換色，其餘默認不可。部件的自陰影/高光
 *   直接畫在圖層裡即可——換色按像素明度重上色，明暗關係會保留。
 *
 * 注意：不再有"正片疊底 = 投影層"那套（簡化：一個圖層就是一個部件，沒有單獨的陰影層）。
 */

export interface ParsedPsdPart {
    /** 猜出來的類目 key；識別不出為 null，由用戶在面板裡指定 */
    categoryKey: string | null;
    name: string;
    tintable: boolean;
    /** 部件本體（透明 PNG data URL，畫布尺寸） */
    src: string;
    /** @deprecated 舊「正片疊底=投影層」機制的產物，新導入不再產出；字段保留僅為下游類型兼容。 */
    shadowSrc?: string;
    warnings: string[];
}

export interface PsdImportResult {
    parts: ParsedPsdPart[];
    /** 全局提示（畫布尺寸不對之類） */
    warnings: string[];
    docWidth: number;
    docHeight: number;
}

/** 類目別名 → key（與 character_creator.html 的 PARTS key 對應） */
const CATEGORY_ALIASES: [string, string[]][] = [
    ['fronthair', ['fronthair', '前發', '前發', '劉海', '瀏海']],
    ['earhair', ['earhair', '耳發', '耳發', '鬢髮', '鬢髮']],
    ['back1', ['back1', '後發1', '後發1', '後發一']],
    ['back2', ['back2', '後發2', '後發2', '後發二']],
    ['skin', ['skin', '膚色', '皮膚', '身體', 'body']],
    ['eyes', ['eyes', '眼睛', '眼']],
    ['mouth', ['mouth', '嘴巴', '嘴']],
    ['outfit', ['outfit', '衣服', '服裝']],
    ['outer', ['outer', '外套']],
    ['facemark', ['facemark', '面紋', '臉紋', '腮紅']],
    ['decor', ['decor', '配飾', '飾品', '裝飾']],
];

// 不帶 #色/#原色 標記時，這些類目默認「可換色」：頭髮四類 + 眼睛。其餘默認不可換色。
const DEFAULT_TINTABLE_KEYS = new Set(['fronthair', 'earhair', 'back1', 'back2', 'eyes']);

/** 輸出上限：超過就整體縮到 472（數據存 IndexedDB，別塞幾千像素的 data URL） */
const MAX_OUT = 944;
const TARGET = 472;

/** 從組名解析 類目 / 顯示名 / tintable 標記 */
export function parseLayerName(raw: string, hasCategory = true): { categoryKey: string | null; name: string; tintable: boolean | null } {
    let name = (raw || '').trim();
    let tintable: boolean | null = null;
    // tint 標記（全角井號也認；先匹配否定形，免得 #notint 被 tint 搶走）
    name = name.replace(/[#＃]\s*(原色|notint)/i, () => { tintable = false; return ''; }).trim();
    if (tintable === null) {
        name = name.replace(/[#＃]\s*(色|tint)/i, () => { tintable = true; return ''; }).trim();
    }
    if (!hasCategory) return { categoryKey: null, name, tintable };

    const lower = name.toLowerCase();
    let matched: { key: string; alias: string } | null = null;
    for (const [key, aliases] of CATEGORY_ALIASES) {
        for (const alias of aliases) {
            if (lower.startsWith(alias.toLowerCase()) && (!matched || alias.length > matched.alias.length)) {
                matched = { key, alias };
            }
        }
    }
    if (!matched) return { categoryKey: null, name, tintable };
    const rest = name.slice(matched.alias.length).replace(/^[\s\-_·、:：/｜|]+/, '').trim();
    return { categoryKey: matched.key, name: rest || name, tintable };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
}

function hasInk(canvas: HTMLCanvasElement): boolean {
    const px = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) return true;
    return false;
}

function exportDataUrl(canvas: HTMLCanvasElement, scale: number): string {
    if (scale >= 1) return canvas.toDataURL('image/png');
    const out = makeCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
}

/** 深度優先展平一個組的葉子圖層（ag-psd children 從底到頂） */
function flattenLeaves(node: any, acc: any[] = []): any[] {
    for (const child of node.children || []) {
        if (child.children) flattenLeaves(child, acc);
        else if (!child.hidden) acc.push(child);
    }
    return acc;
}

/** 把一組葉子圖層按畫布位置正常合成到一張畫布（不支持的混合模式按普通處理並告警）。 */
function compositeLeaves(leaves: any[], W: number, H: number, warnings: string[]): HTMLCanvasElement {
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d')!;
    for (const layer of leaves) {
        if (!layer.canvas) continue;
        const bm = layer.blendMode;
        if (bm && bm !== 'normal' && bm !== 'pass through') {
            warnings.push(`圖層「${layer.name || '?'}」混合模式 ${bm} 不支持，按普通處理`);
        }
        ctx.globalAlpha = typeof layer.opacity === 'number' ? layer.opacity : 1;
        ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
        ctx.globalAlpha = 1;
    }
    return canvas;
}

export async function parseCreatorPsd(buffer: ArrayBuffer): Promise<PsdImportResult> {
    const { readPsd } = await import('ag-psd');
    const psd = readPsd(buffer, { skipThumbnail: true, skipCompositeImageData: true });
    const W = psd.width, H = psd.height;
    const warnings: string[] = [];
    if (W !== H) warnings.push(`畫布 ${W}×${H} 不是正方形，會和現有素材（472×472）錯位`);
    else if (W !== TARGET) warnings.push(`畫布 ${W}×${H}（現有素材是 472×472，按比例縮放對齊，錨點一致即可）`);
    const scale = W > MAX_OUT ? TARGET / W : 1;

    const parts: ParsedPsdPart[] = [];
    // 頂層組 = 類目；組內每個圖層（或子組）= 一個部件。頂層散圖層 = 一個部件（類目從自己名字猜）。
    for (const top of psd.children || []) {
        if (top.hidden) continue;

        if (top.children) {
            // —— 頂層組 = 類目 ——
            const groupParsed = parseLayerName(top.name || ''); // 取類目 + 可能的組級 tint
            const catKey = groupParsed.categoryKey;
            if (!catKey) {
                warnings.push(`組「${top.name || '?'}」沒識別出類目，組內部件需在面板手動選類目`);
            }
            let made = 0;
            for (const child of top.children) {
                if (child.hidden) continue;
                // 子級：圖層 = 一個部件；子組 = 合併其圖層成一個部件
                const leaves = child.children ? flattenLeaves(child) : (child.canvas ? [child] : []);
                if (!leaves.length) continue;
                const partWarnings: string[] = [];
                const canvas = compositeLeaves(leaves, W, H, partWarnings);
                if (!hasInk(canvas)) continue;
                // 部件名 + tint 來自子級名（類目已由組給出，故 hasCategory=false 只取名字/標記）
                const childParsed = parseLayerName(child.name || '', false);
                const tintable = childParsed.tintable !== null
                    ? childParsed.tintable
                    : (groupParsed.tintable !== null ? groupParsed.tintable : DEFAULT_TINTABLE_KEYS.has(catKey || ''));
                parts.push({
                    categoryKey: catKey,
                    name: childParsed.name || child.name || '',
                    tintable,
                    src: exportDataUrl(canvas, scale),
                    warnings: partWarnings,
                });
                made++;
            }
            if (!made) warnings.push(`組「${top.name || '?'}」裡沒有可用圖層`);
        } else {
            // —— 頂層散圖層 = 一個部件（類目從自己名字猜）——
            if (!top.canvas) continue;
            const partWarnings: string[] = [];
            const canvas = compositeLeaves([top], W, H, partWarnings);
            if (!hasInk(canvas)) {
                warnings.push(`「${top.name || '?'}」是空圖層，跳過`);
                continue;
            }
            const parsed = parseLayerName(top.name || '');
            parts.push({
                categoryKey: parsed.categoryKey,
                name: parsed.name,
                tintable: parsed.tintable !== null ? parsed.tintable : DEFAULT_TINTABLE_KEYS.has(parsed.categoryKey || ''),
                src: exportDataUrl(canvas, scale),
                warnings: partWarnings,
            });
        }
    }

    if (!parts.length) warnings.push('沒解析出任何部件：確認結構是"頂層組=類目，組內每個圖層=一個部件"');
    return { parts, warnings, docWidth: W, docHeight: H };
}
