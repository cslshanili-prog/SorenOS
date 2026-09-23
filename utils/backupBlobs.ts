// v3 備份的 blob 旁路（純邏輯，不碰 React / DOM / IndexedDB，node 測試直接測）。
//
// v2 的做法是導出前把 blobref 令牌解析回 data URL、再由 zip 抽取管線解碼成 assets/* 文件，
// 一來一回兩次 base64 編解碼，令牌身份也在恢復端丟失（恢復成 data: 後要靠惰性遷移重新
// 變回 blob，且同一張圖的多處引用會各自變成獨立副本）。v3 把這條路拆直：
//   · 令牌原樣留在 JSON 裡（JSON 分片一個字節不用改寫）；
//   · 二進制以原文件形態直寫 zip 的 blobs/<id> 條目（圖片本身已壓縮，STORE 不再壓）；
//   · blobs/index.json 記 id → { type, size }，導入端用它重建帶 mime 的 Blob；
//   · 導入端按原 id 寫回（SDK 的 restore），令牌身份保住，零重編碼、去重天然保留。
//
// 令牌收集不走對象樹掃描，而是從「真正落包的 JSON 文本」裡提（backupFormat 的
// onSerialized 鉤子 + SDK 的 extractRefs）——和孤兒 GC 的 mark 階段同一套認字邏輯，
// 令牌藏在嵌套 JSON 字符串裡（如 assets 表裡的 appearance_preset_* JSON）也逐字可見。
// 這樣導出端沒有「哪些 store 要處理」的名單可漏：任何字段裡的令牌都會被收進來。

import { extractRefs, DEFAULT_PREFIX } from '@rei-standard/blob-store';
import type { ZipFileWriter, ZipFileReader } from './backupFormat';

/** blob 旁路索引在 zip 裡的固定文件名。v2 老包沒有這個文件（讀端以此區分，無需看版本號）。 */
export const BLOBS_INDEX_FILE = 'blobs/index.json';

/** 單個 blob 在 zip 裡的條目路徑。id 已被字符集校驗約束，不會拼出越界路徑。 */
export const blobEntryPath = (id: string) => `blobs/${id}`;

/** 與 SDK 令牌 id 的字符集一致（extractRefs / GC 的邊界字符集）。 */
const ID_CHARSET = /^[A-Za-z0-9_]+$/;

export interface BackupBlobIndexEntry {
    id: string;
    /** Blob 的 mime（如 image/png）。可能為空串（存入時就沒有 type），恢復時原樣重建。 */
    type: string;
    /** 字節數。導入端校驗 zip 條目實際字節數與它一致，抓截斷的包。 */
    size: number;
}

/** 從一段已序列化的 JSON 文本里提取全部 blobref 令牌，去重收進 into。 */
export function collectBlobRefs(serialized: string, into: Set<string>): void {
    for (const ref of extractRefs(serialized)) into.add(ref);
}

/**
 * 把收集到的令牌對應的 Blob 逐個直寫 zip（blobs/<id>，STORE 不壓縮），
 * 收尾寫 blobs/index.json。一個都沒寫成時不落索引文件，產物與「無 blob 的包」同形。
 *
 * 解析不到的令牌（圖已丟）跳過並計入 missing——死令牌會原樣留在 JSON 裡，恢復端
 * 渲染為空圖，與 v2「置空串」的用戶可見結果等價，但這裡能把丟圖數量如實報給調用方。
 * 字符集不合法的「令牌」同樣計入 missing：它寫不進合法的 zip 路徑，而 extractRefs
 * 收集來的令牌結構上不會命中這條，命中即調用方傳了未經收集器的裸字符串。
 *
 * 內存峰值只有單個 Blob 的字節（arrayBuffer 一份），全程不經 base64。
 */
export async function writeBlobsToZip(
    zip: ZipFileWriter,
    tokens: Iterable<string>,
    getBlob: (token: string) => Promise<Blob | null>,
    opts: {
        onYield?: () => Promise<void>;
        onProgress?: (done: number, total: number) => void;
    } = {},
): Promise<{ written: number; missing: string[] }> {
    // 排序讓產物字節穩定（同一份數據兩次導出 diff 得出來），也方便測試斷言。
    const list = [...tokens].sort();
    const entries: BackupBlobIndexEntry[] = [];
    const missing: string[] = [];
    let done = 0;

    for (const token of list) {
        done++;
        const id = token.startsWith(DEFAULT_PREFIX) ? token.slice(DEFAULT_PREFIX.length) : '';
        if (!ID_CHARSET.test(id)) {
            missing.push(token);
            continue;
        }
        const blob = await getBlob(token);
        if (!blob) {
            missing.push(token);
            continue;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        zip.file(blobEntryPath(id), bytes, { compression: 'STORE' });
        entries.push({ id, type: blob.type || '', size: bytes.byteLength });
        opts.onProgress?.(done, list.length);
        if (opts.onYield) await opts.onYield();
    }

    if (entries.length > 0) {
        zip.file(BLOBS_INDEX_FILE, JSON.stringify(entries));
    }
    return { written: entries.length, missing };
}

/**
 * 讀並校驗 blobs/index.json。文件不存在返回 []（v2 老包 / 純文字包）。
 * 所有校驗（結構、字符集、聲明的條目文件都在）在返回前完成——調用方拿到非空結果時
 * 可以放心開始寫回，不會出現「校驗到一半才發現缺文件」的半程狀態。
 */
export async function readBlobsIndex(zip: ZipFileReader): Promise<BackupBlobIndexEntry[]> {
    const indexFile = zip.file(BLOBS_INDEX_FILE);
    if (!indexFile) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(await indexFile.async('string'));
    } catch {
        throw new Error('損壞的備份包：blobs/index.json 解析失敗，已中止導入（數據未改動）。');
    }
    if (!Array.isArray(parsed)) {
        throw new Error('損壞的備份包：blobs/index.json 不是數組，已中止導入（數據未改動）。');
    }

    for (const e of parsed as BackupBlobIndexEntry[]) {
        if (!e || typeof e.id !== 'string' || !ID_CHARSET.test(e.id)
            || typeof e.type !== 'string'
            || !Number.isSafeInteger(e.size) || e.size < 0) {
            throw new Error('損壞的備份包：blobs/index.json 含非法條目，已中止導入（數據未改動）。');
        }
        if (!zip.file(blobEntryPath(e.id))) {
            throw new Error(`損壞的備份包：索引聲明了 blobs/${e.id} 但 zip 裡沒有，已中止導入（數據未改動）。`);
        }
    }
    return parsed as BackupBlobIndexEntry[];
}

/**
 * 把 blobs/* 逐個還原成帶 mime 的 Blob，經 restore 按原令牌 id 寫回宿主存儲。
 * 任何一步失敗直接上拋，調用方應中止整個導入——此時主數據（JSON 分片）尚未寫庫，
 * 已寫回的部分 blob 只是暫時的孤兒，由孤兒 GC 收口，不構成數據損壞。
 * 字節數與索引聲明不符視為包被截斷，同樣上拋。
 */
export async function restoreBlobsFromZip(
    zip: ZipFileReader,
    entries: BackupBlobIndexEntry[],
    restore: (token: string, blob: Blob) => Promise<void>,
    opts: {
        onYield?: () => Promise<void>;
        onProgress?: (done: number, total: number, id: string) => void;
    } = {},
): Promise<number> {
    let done = 0;
    for (const entry of entries) {
        const file = zip.file(blobEntryPath(entry.id));
        if (!file) {
            // readBlobsIndex 已驗過文件都在；走到這說明調用方傳了未經校驗的索引。
            throw new Error(`損壞的備份包：缺少 blobs/${entry.id}，已中止導入。`);
        }
        const bytes = await file.async('uint8array');
        if (bytes.byteLength !== entry.size) {
            throw new Error(
                `損壞的備份包：blobs/${entry.id} 實際 ${bytes.byteLength} 字節、索引聲明 ${entry.size} 字節，` +
                '備份可能被截斷，已中止導入。',
            );
        }
        // zip 讀出的視圖可能背靠更大的共享 buffer（TS 5.7 起類型上也是 ArrayBufferLike）；
        // slice() 拷出等長獨立 ArrayBuffer 再喂 Blob，與 avatarModelBackup 同款處理。
        const buf = bytes.slice().buffer;
        const blob = entry.type ? new Blob([buf], { type: entry.type }) : new Blob([buf]);
        await restore(DEFAULT_PREFIX + entry.id, blob);
        done++;
        opts.onProgress?.(done, entries.length, entry.id);
        if (opts.onYield) await opts.onYield();
    }
    return done;
}
