// 捏人器「內置素材包」導出（管理員用）。
//
// 背景：捏人器本體 character_creator.html 裡的內置部件歷來是 base64 內聯在 PARTS 數組，
// 整個 HTML 因此被撐到 ~1.6MB（95% 是 base64），每個用戶首次都要下這一坨；再往裡加 PSD
// 素材只會更大。省法：內置部件改成引用二進制 PNG 文件（src 寫成相對路徑），HTML 只留一份
// 路徑清單。PNG 比 base64 小 ~25% 且瀏覽器逐張緩存。
//
// 這個模塊把「一批部件（PSD 解析結果 / 已存自定義部件）」打成一個可提交的素材包 ZIP：
//   parts/manifest.json       —— 清單（src/shadowSrc 已寫成 parts/<id>.png 相對路徑）
//   parts/<id>.png            —— 部件圖（二進制）
//   parts/<id>_shadow.png     —— 投影層（舊數據可能有，新導入不再產出）
//   README.txt                —— 怎麼落地成內置素材的說明
// 管理員把整個 parts/ 丟進 public/like520/ 即可——character_creator.html 啟動時會 fetch
// parts/manifest.json 自動合併進 PARTS，無需手改 HTML。

export interface BuiltinPackItem {
    categoryKey: string | null;
    name: string;
    /** 部件圖：data:image/... base64 會被抽成 PNG 文件；http(s) URL 原樣寫進清單不落文件。 */
    src: string;
    /** 投影層，同 src 規則。 */
    shadowSrc?: string;
    tintable?: boolean;
}

export interface BuiltinPackManifestEntry {
    categoryKey: string;
    id: string;
    name: string;
    src: string;
    tintable: boolean;
    shadowSrc?: string;
}

export interface BuiltinPackFile {
    /** zip 內路徑，如 parts/fronthair_liuhai.png */
    path: string;
    /** 僅 base64 負載（不含 data: 前綴），供 JSZip { base64:true } 寫入 */
    base64: string;
}

export interface BuiltinPackPlan {
    manifest: BuiltinPackManifestEntry[];
    files: BuiltinPackFile[];
    /** 沒類目被跳過的部件數 */
    skipped: number;
}

/** data:URL → 僅 base64 負載；非 base64 data URL 返回 null。 */
const dataUrlPayload = (v: string): string | null => {
    if (!v.startsWith('data:')) return null;
    const comma = v.indexOf(',');
    if (comma < 0) return null;
    if (!/;base64/i.test(v.slice(0, comma))) return null;
    return v.slice(comma + 1);
};

/** 文件名安全化：保留字母數字 / 中文 / 連字符，其餘折成下劃線；空則回落 'part'。 */
export const safePartSlug = (s: string): string =>
    (s || '').replace(/[^\w一-龥-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';

/**
 * 純函數：把一批部件規劃成「清單 + 待寫文件」。不碰 zip / DOM，便於單測。
 *  · 每個部件生成穩定唯一 id（categoryKey_名字，重名自動 _2/_3…）；
 *  · data: 圖 → 落成 parts/<id>.png，清單 src 寫相對路徑；
 *  · http(s) 圖 → 不落文件，清單 src 原樣保留該 URL；
 *  · 沒類目的部件跳過並計入 skipped。
 */
export function planBuiltinPartsPack(items: BuiltinPackItem[]): BuiltinPackPlan {
    const manifest: BuiltinPackManifestEntry[] = [];
    const files: BuiltinPackFile[] = [];
    const usedIds = new Set<string>();
    let skipped = 0;

    for (const it of items) {
        if (!it.categoryKey) { skipped++; continue; }
        const base = `${it.categoryKey}_${safePartSlug(it.name)}`;
        let id = base;
        let n = 2;
        while (usedIds.has(id)) id = `${base}_${n++}`;
        usedIds.add(id);

        const entry: BuiltinPackManifestEntry = {
            categoryKey: it.categoryKey,
            id,
            name: it.name || id,
            tintable: !!it.tintable,
            src: '',
        };

        const srcPayload = dataUrlPayload(it.src || '');
        if (srcPayload) {
            const path = `parts/${id}.png`;
            files.push({ path, base64: srcPayload });
            entry.src = path;
        } else {
            entry.src = it.src || ''; // http(s) URL 原樣保留
        }

        if (it.shadowSrc) {
            const shadowPayload = dataUrlPayload(it.shadowSrc);
            if (shadowPayload) {
                const path = `parts/${id}_shadow.png`;
                files.push({ path, base64: shadowPayload });
                entry.shadowSrc = path;
            } else {
                entry.shadowSrc = it.shadowSrc;
            }
        }

        manifest.push(entry);
    }

    return { manifest, files, skipped };
}

const README = `捏人器內置素材包
================

這個 ZIP 是「PSD → 內置素材」的產物，用來把部件作為內置素材隨包發給所有用戶
（而不是每台設備各存一份 base64，也不把 base64 塞進 character_creator.html 撐大體積）。

內容：
  parts/manifest.json   部件清單（src 已寫成 parts/<id>.png 相對路徑）
  parts/*.png           部件圖（二進制 PNG，比 base64 省 ~25%，瀏覽器逐張緩存）

怎麼落地成內置素材（無需改任何代碼！）：
  1. 解壓這個 ZIP。
  2. 把裡面的整個 parts/ 文件夾，放進倉庫的  public/like520/  目錄下
     （最終是  public/like520/parts/manifest.json  +  public/like520/parts/*.png）。
     —— 若 public/like520/parts/ 已存在，用新的整個覆蓋它（清單是全量的）。
  3. 提交。character_creator.html 啟動時會自動 fetch parts/manifest.json 加載，
     不用手改它的 PARTS 數組。

說明：
  · 清單是「你當前所有自定義部件」的全量快照，所以每次發佈用新包整體覆蓋即可，
    不用手動往裡加條目。
  · 每個部件 id 由「類目_名字」生成，改名字會變 id；保持名字穩定，dedup 才穩。
`;

/**
 * 把一批部件打成內置素材包 ZIP（Blob）。瀏覽器環境用（動態載入 JSZip）。
 * @returns { blob, plan } —— blob 供下載，plan.skipped 供提示。
 */
export async function buildBuiltinPartsPackZip(items: BuiltinPackItem[]): Promise<{ blob: Blob; plan: BuiltinPackPlan }> {
    const plan = planBuiltinPartsPack(items);
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const f of plan.files) {
        zip.file(f.path, f.base64, { base64: true });
    }
    zip.file('parts/manifest.json', JSON.stringify(plan.manifest, null, 2));
    zip.file('README.txt', README);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    return { blob, plan };
}
