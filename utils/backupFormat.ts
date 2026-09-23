// v2/v3 備份格式：分片讀寫的純邏輯，刻意不碰 React / DOM / Capacitor，只依賴一個最小的
// zip 讀寫接口，好在 node 測試環境裡拿真 jszip 單測往返。
//
// v3 與 v2 的分片佈局完全相同，區別只有一件事：圖片的 blobref 令牌不再在導出前解析回
// data URL，而是原樣留在 JSON 裡，二進制走 zip 的 blobs/<id> 旁路（見 utils/backupBlobs.ts）。
// 本文件對 blobs 旁路唯一的參與是 onSerialized 鉤子——把每段真正落包的 JSON 文本吐給
// 調用方，供其收集令牌。讀端同時接受 2 和 3：兩個版本的分片組裝邏輯一字不差。
//
// 設計主線（見 notes/backup-streaming-refactor-plan.md）：
//   導出端先按 v1 老邏輯把所有數據攢進一個 backupData 對象（角色/消息/單例/設置……，
//   特殊分支一字不改）；這裡只負責「換一種存法」——把其中的數組字段分片寫進
//   stores/<field>.NNN.json，其餘非數組字段（主題/設置/單例對象等）整進 metadata.json，
//   收尾寫一份 manifest.json 當導入契約。
//   導入端讀 manifest，把各片拼回「與 v1 完全相同的 data 對象」，再餵給原封不動的
//   importFullData——還原語義（clear-and-add / merge / 單例 / media_only 補丁……）全部
//   留在 importFullData 裡，這裡不重寫，所以不會出現「兩套語義彼此漂移」。
//
// 為什麼單根 data.json 會崩：對單個超大數組或整包做 JSON.stringify，文本長度逼近 JS
// 單字符串 ~512M（2^29）上限會確定性拋 RangeError。分片後每片字符串長度有界，永不觸上限。

export const BACKUP_FORMAT_VERSION = 3;

/** 讀端接受的版本：v2（令牌已解析成 data:）與 v3（令牌 + blobs/* 旁路）分片佈局相同。 */
export const SUPPORTED_IMPORT_FORMAT_VERSIONS: readonly number[] = [2, 3];

/** 分片閾值。注意這裡的「Len」量的是 JS 字符串長度（UTF-16 碼元數），正是 RangeError 盯的那個量，
 *  不是 UTF-8 字節數——用它當閾值剛好守住「單根字符串別逼近 512M」。 */
export interface ShardLimits {
    /** 單片字符串長度軟上限：攢到這個長度就 flush 一片 */
    maxLen: number;
    /** 單片條數軟上限：攢到這麼多條就 flush 一片（防超多小記錄擠進一片） */
    maxItems: number;
    /** 單條記錄序列化硬上限：單條就超它 → 乾淨報錯中止導出，絕不退回 RangeError */
    hardMaxLen: number;
}

export const DEFAULT_SHARD_LIMITS: ShardLimits = {
    maxLen: 32 * 1024 * 1024,        // 32M 碼元，遠低於 ~512M 上限
    maxItems: 5000,
    hardMaxLen: 256 * 1024 * 1024,   // 256M 碼元
};

/** 向量 bin 的索引項：每條向量在 memory_vectors.bin 裡的位置 + 重建所需元數據 */
export interface VectorIndexEntry {
    memoryId: string;
    charId: string;
    dimensions: number;
    model?: string;
    byteOffset: number;
    byteLength: number;
}

export interface BackupManifest {
    formatVersion: number;
    mode?: string;
    createdAt?: number;
    /** key = backupData 字段名（如 messages / galleryImages / memoryNodes），value = 分片數 + 總條數 */
    stores: Record<string, { parts: number; count: number }>;
    /** 向量走二進制旁路（memory_vectors.bin + .index.json），不進 stores。無向量時省略。 */
    vectors?: { count: number; byteLength: number };
    assetCount?: number;
}

/** 寫端：往 zip 裡塞文本文件，或二進制（Uint8Array）文件。二進制直寫，絕不經 base64 大字符串。 */
export interface ZipFileWriter {
    file(name: string, data: string | Uint8Array, options?: {
        base64?: boolean;
        compression?: 'STORE' | 'DEFLATE';
        compressionOptions?: { level?: number };
    }): void;
}

/** 讀端：按名取文件，能按類型 async 出文本或字節；取不到返回 null */
export interface ZipFileReader {
    file(name: string): {
        async(type: 'string'): Promise<string>;
        async(type: 'uint8array'): Promise<Uint8Array>;
    } | null;
}

/** 向量 bin / index 在 zip 裡的固定文件名 */
export const VECTOR_BIN_FILE = 'stores/memory_vectors.bin';
export const VECTOR_INDEX_FILE = 'stores/memory_vectors.index.json';

/** 分片文件名：stores/<field>.NNN.json。寫讀兩端用同一個公式，靠數字下標對齊，不靠文件名字典序。 */
export function shardFileName(field: string, index: number): string {
    return `stores/${field}.${String(index).padStart(3, '0')}.json`;
}

export interface WriteV2Options {
    mode?: string;
    createdAt?: number;
    assetCount?: number;
    limits?: ShardLimits;
    /** React 端傳 `() => new Promise(r => setTimeout(r, 0))` 讓出主線程；測試端可不傳 */
    onYield?: () => Promise<void>;
    /** 向量二進制旁路：調用方（OSContext）已把 memory_vectors 歸一化拼成 bin + index 時傳進來。
     *  寫進 memory_vectors.bin（二進制直寫）+ .index.json，並在 manifest.vectors 記 count/byteLength。
     *  傳了這個就不要再把 memoryVectors 放進 backupData（否則會被當普通數組又分片一遍）。 */
    vectors?: { bin: Uint8Array; index: VectorIndexEntry[] };
    /**
     * 已由調用方增量寫進 zip 的數組字段。大數據量導出可用 createV2ArrayFieldWriter 一批批寫，
     * 不必先把整個 store 攢進 backupData；writeV2Backup 收尾時會把這些統計合進 manifest。
     */
    prewrittenStores?: Record<string, { parts: number; count: number }>;
    /**
     * 通用文本鉤子：每段真正落包的 JSON 文本（分片裡的每條記錄 + metadata.json）都過一遍。
     * v3 導出方靠它收集 blobref 令牌——只有這一層見得到「實際寫進包裡的字符串」，在上游
     * 對象樹上另掃一遍既貴又可能與真實序列化結果不一致（令牌可能藏在嵌套 JSON 字符串裡，
     * 序列化後逐字可見）。manifest / 向量 bin·index 不含用戶字段值，不過鉤。
     */
    onSerialized?: (json: string) => void;
}

export interface V2ArrayFieldWriter {
    /** 同步追加，供單個 IndexedDB 游標事務內使用；不能在事務回調裡 await。 */
    appendSync(items: any[]): void;
    /** 追加一批記錄；調用返回後，調用方即可釋放這批原始對象。 */
    append(items: any[]): Promise<void>;
    /** 沖掉最後不足一片的緩衝並返回 manifest 統計；每個 writer 只能 finish 一次。 */
    finish(): Promise<{ parts: number; count: number }>;
}

/**
 * 增量數組分片寫入器。與 writeV2Backup 的普通數組路徑使用同一套序列化/閾值規則，
 * 但允許調用方從 IndexedDB 游標分批喂數據，峰值內存只與單批和單片大小有關。
 */
export function createV2ArrayFieldWriter(
    zip: ZipFileWriter,
    field: string,
    options: Pick<WriteV2Options, 'limits' | 'onYield' | 'onSerialized'> = {},
): V2ArrayFieldWriter {
    const limits = options.limits || DEFAULT_SHARD_LIMITS;
    const onYield = options.onYield;
    const onSerialized = options.onSerialized;
    let buf: string[] = [];
    let bufLen = 0;
    let parts = 0;
    let writtenCount = 0;
    let inputIndex = 0;
    let finished = false;

    const flush = () => {
        if (buf.length === 0) return;
        zip.file(shardFileName(field, parts), '[' + buf.join(',') + ']');
        parts++;
        buf = [];
        bufLen = 0;
    };

    const pushOne = (item: any): number => {
        if (finished) throw new Error(`備份分片 ${field} 已結束，不能繼續寫入。`);
        let s: string;
        try {
            s = JSON.stringify(item);
        } catch (e: any) {
            throw new Error(`備份序列化失敗（${field} 第 ${inputIndex} 條）：${e?.message || e}`);
        }
        inputIndex++;
        // JSON.stringify(undefined) === undefined；與舊 v1 JSON 語義一致地跳過空洞。
        if (s === undefined) return 0;
        onSerialized?.(s);
        if (s.length > limits.hardMaxLen) {
            throw new Error(
                `備份中有單條記錄過大（${field}，約 ${Math.round(s.length / 1048576)}M 字符），` +
                `超出安全上限，已中止導出以免生成損壞的備份包。`,
            );
        }
        let flushes = 0;
        // 單條超過軟上限時讓它獨佔一片，避免與前一批記錄粘成更大的臨時字符串。
        if (s.length >= limits.maxLen && buf.length > 0) { flush(); flushes++; }
        buf.push(s);
        bufLen += s.length;
        writtenCount++;
        if (bufLen >= limits.maxLen || buf.length >= limits.maxItems) { flush(); flushes++; }
        return flushes;
    };

    const appendSync = (items: any[]) => {
        for (const item of items) pushOne(item);
    };

    const append = async (items: any[]) => {
        for (const item of items) {
            const flushes = pushOne(item);
            if (flushes > 0 && onYield) await onYield();
        }
    };

    const finish = async () => {
        if (finished) throw new Error(`備份分片 ${field} 被重複結束。`);
        const hadBufferedItems = buf.length > 0;
        flush();
        if (hadBufferedItems && onYield) await onYield();
        finished = true;
        return { parts, count: writtenCount };
    };

    return { appendSync, append, finish };
}

/**
 * 把已攢好的 backupData 寫成 v2 分片佈局，返回 manifest。
 *
 * 會「消費」backupData：數組字段寫完即把該字段置 undefined 釋放引用，方便大數組儘早被 GC。
 * 調用方不應在調用後再讀 backupData。
 */
export async function writeV2Backup(
    zip: ZipFileWriter,
    backupData: Record<string, any>,
    options: WriteV2Options = {},
): Promise<BackupManifest> {
    const limits = options.limits || DEFAULT_SHARD_LIMITS;
    const onYield = options.onYield;
    const manifestStores: Record<string, { parts: number; count: number }> = {
        ...(options.prewrittenStores || {}),
    };

    const shardArrayField = async (field: string, arr: any[]) => {
        if (Object.prototype.hasOwnProperty.call(manifestStores, field)) {
            throw new Error(`備份字段 ${field} 同時走了增量寫入和普通寫入，已中止以免生成重複分片。`);
        }
        const writer = createV2ArrayFieldWriter(zip, field, { limits, onYield, onSerialized: options.onSerialized });
        await writer.append(arr);
        // count 用「實際寫入條數」而非 arr.length：writer 會跳過 JSON.stringify(undefined)
        // 得到的空洞，避免導入端「拼出條數 === count」校驗誤判損壞。
        manifestStores[field] = await writer.finish();
    };

    // 一遍掃 backupData：數組字段分片（寫完釋放），其餘非數組字段進 metadata。
    const metaFields: Record<string, any> = {};
    for (const key of Object.keys(backupData)) {
        const value = backupData[key];
        if (Array.isArray(value)) {
            await shardArrayField(key, value);
            backupData[key] = undefined; // 釋放引用，已落 zip
        } else {
            metaFields[key] = value;
        }
    }

    const metaJson = JSON.stringify(metaFields);
    options.onSerialized?.(metaJson);
    zip.file('metadata.json', metaJson);

    // 向量二進制旁路：bin 直寫 Uint8Array（不經 base64，bin 多大都不會撞字符串上限），
    // index 是小 JSON。manifest.vectors 記 count/byteLength 供導入端校驗。
    let vectorsMeta: { count: number; byteLength: number } | undefined;
    if (options.vectors) {
        // embedding 浮點字節近似隨機數據，DEFLATE 幾乎壓不小，卻會在手機上消耗大量 CPU/內存。
        // 直接 STORE 保持字節無損，索引和其它 JSON 仍走外層壓縮。
        zip.file(VECTOR_BIN_FILE, options.vectors.bin, { compression: 'STORE' });
        zip.file(VECTOR_INDEX_FILE, JSON.stringify(options.vectors.index));
        vectorsMeta = { count: options.vectors.index.length, byteLength: options.vectors.bin.byteLength };
    }

    const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        mode: options.mode,
        createdAt: options.createdAt,
        stores: manifestStores,
        vectors: vectorsMeta,
        assetCount: options.assetCount,
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    return manifest;
}

export interface AssembleV2Options {
    /** React 端傳讓出主線程的函數；測試端可不傳 */
    onYield?: () => Promise<void>;
    /** 進度回調：當前字段、已處理字段序號、字段總數 */
    onShardProgress?: (field: string, fieldIndex: number, fieldTotal: number) => void;
}

/**
 * 讀 v2 備份，把各分片拼回「與 v1 完全相同的 data 對象」。
 *
 * 全程只讀 zip、組裝內存對象，不碰數據庫——所以任何校驗不過直接拋錯時，DB 一字未動，
 * 調用方應在調用 importFullData 之前先 await 本函數。
 *
 * 校驗三檔（都在寫庫前）：① formatVersion 嚴格等於 2；② manifest 聲明的每個分片文件都在
 * （缺則 abort）；③ 每字段組裝後條數 === manifest count、每片必須是數組（抓我們自己導出的 bug，
 * 不是防用戶篡改）。素材文件 assets/* 不進這道硬邊界——缺圖維持 warn+skip（缺圖只可能來自
 * 篡改，真丟了也無從恢復，為它拒絕整個導入沒意義）。
 */
export async function assembleV2Backup(
    zip: ZipFileReader,
    manifest: BackupManifest,
    options: AssembleV2Options = {},
): Promise<Record<string, any>> {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('損壞的備份包：manifest.json 無法解析。');
    }
    if (!SUPPORTED_IMPORT_FORMAT_VERSIONS.includes(manifest.formatVersion)) {
        throw new Error(
            `不支持的備份格式版本：${manifest.formatVersion}（本版本只能導入 formatVersion ` +
            `${SUPPORTED_IMPORT_FORMAT_VERSIONS.join(' / ')} 的備份），已中止導入（數據未改動）。`,
        );
    }

    const metaFile = zip.file('metadata.json');
    if (!metaFile) throw new Error('損壞的備份包：有 manifest 但缺 metadata.json，已中止導入（數據未改動）。');
    let data: Record<string, any>;
    try {
        data = JSON.parse(await metaFile.async('string'));
    } catch {
        throw new Error('損壞的備份包：metadata.json 解析失敗，已中止導入（數據未改動）。');
    }

    const stores = manifest.stores || {};
    const fields = Object.keys(stores);

    // 先一遍校驗所有聲明的分片文件都在（缺則 abort，此時還沒拼任何數據、DB 未動）
    for (const field of fields) {
        const { parts } = stores[field];
        for (let p = 0; p < parts; p++) {
            const name = shardFileName(field, p);
            if (!zip.file(name)) {
                throw new Error(`損壞的備份包：manifest 聲明了 ${name} 但 zip 裡沒有，已中止導入（數據未改動）。`);
            }
        }
    }

    // 逐字段逐片拼回完整數組；parse 完一片即釋放該片字符串；組裝後條數必須等於 manifest count
    for (let fi = 0; fi < fields.length; fi++) {
        const field = fields[fi];
        const { parts, count } = stores[field];
        const arr: any[] = [];
        for (let p = 0; p < parts; p++) {
            const name = shardFileName(field, p);
            let str = await zip.file(name)!.async('string');
            let chunk: any;
            try {
                chunk = JSON.parse(str);
            } catch {
                throw new Error(`損壞的備份包：${name} 解析失敗，已中止導入（數據未改動）。`);
            }
            str = ''; // 釋放該片字符串
            if (!Array.isArray(chunk)) {
                throw new Error(`損壞的備份包：${name} 不是數組，已中止導入（數據未改動）。`);
            }
            for (const item of chunk) arr.push(item);
            if (options.onYield) await options.onYield();
        }
        if (arr.length !== count) {
            throw new Error(
                `損壞的備份包：${field} 實際拼出 ${arr.length} 條、manifest 聲明 ${count} 條，對不上，` +
                `已中止導入（數據未改動）。`,
            );
        }
        data[field] = arr;
        options.onShardProgress?.(field, fi, fields.length);
    }

    // 向量二進制旁路：從 bin + index 重建 MemoryVector[]，塞進 data.memoryVectors，
    // 跟其它 store 一樣走那一次 importFullData（clear-once），不走 saveMany 旁路。
    if (manifest.vectors) {
        const idxFile = zip.file(VECTOR_INDEX_FILE);
        const binFile = zip.file(VECTOR_BIN_FILE);
        if (!idxFile || !binFile) {
            throw new Error('損壞的備份包：manifest 聲明了向量但缺 index/bin 文件，已中止導入（數據未改動）。');
        }
        let index: VectorIndexEntry[];
        try {
            index = JSON.parse(await idxFile.async('string'));
        } catch {
            throw new Error('損壞的備份包：memory_vectors.index.json 解析失敗，已中止導入（數據未改動）。');
        }
        const bin = await binFile.async('uint8array');
        if (!Array.isArray(index) || index.length !== manifest.vectors.count) {
            throw new Error('損壞的備份包：向量條數與 manifest 不符，已中止導入（數據未改動）。');
        }
        if (bin.byteLength !== manifest.vectors.byteLength) {
            throw new Error('損壞的備份包：向量 bin 字節數與 manifest 不符，已中止導入（數據未改動）。');
        }
        const okInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
        const vectors = index.map((e) => {
            // 偏移/長度/維度必須是非負安全整數，且字節區間落在 bin 內。少了這道校驗，壞 byteOffset
            // 會被 Uint8Array.slice() 鉗制成空/截斷的字節（不報錯），組裝照樣過，importFullData 清舊
            // 存新 → 本該 abort 的損壞變成丟數據。這裡把它擋在寫庫前（也順帶抓自家 offset 算錯的 bug）。
            if (!okInt(e.byteOffset) || !okInt(e.byteLength) || !okInt(e.dimensions)) {
                throw new Error(`損壞的備份包：向量 ${e.memoryId} 的偏移/長度/維度非法，已中止導入（數據未改動）。`);
            }
            if (e.byteLength !== e.dimensions * 4) {
                throw new Error(`損壞的備份包：向量 ${e.memoryId} 的字節數與維度對不上，已中止導入（數據未改動）。`);
            }
            if (e.byteOffset + e.byteLength > bin.byteLength) {
                throw new Error(`損壞的備份包：向量 ${e.memoryId} 的字節區間越過 bin 末尾，已中止導入（數據未改動）。`);
            }
            // slice 切出獨立 buffer（不是 subarray 視圖）：否則 IndexedDB 結構化克隆會把整根 bin
            // 給每條向量各複製一遍。importFullData 的 memory_vectors 段對 Uint8Array 形態原樣存。
            const vector = bin.slice(e.byteOffset, e.byteOffset + e.byteLength);
            if (vector.byteLength !== e.byteLength) {
                throw new Error(`損壞的備份包：向量 ${e.memoryId} 切片長度異常，已中止導入（數據未改動）。`);
            }
            return { memoryId: e.memoryId, charId: e.charId, dimensions: e.dimensions, model: e.model, vector };
        });
        data.memoryVectors = vectors;
        options.onShardProgress?.('memoryVectors', fields.length, fields.length + 1);
    }

    return data;
}
