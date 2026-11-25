/**
 * 串流 zip 寫入器（plans/backup-streaming.md 第 4.1、4.2 節）。
 *
 * 跟 JSZip「先全部登記、最後一次生成」不同：一個檔案進來就算 CRC、壓好、寫出去，寫完不留，
 * 記憶體裡只剩目錄（一個檔案約一百位元組）。備份打包用它，最高用量才不會跟資料總量成正比。
 *
 * `file()` 的簽名包住 utils/backupFormat.ts 的 ZipFileWriter，所以分片、圖片、語音那幾個
 * 寫法不用改。字串和位元組是當場寫完才回來；Blob 要先讀，排隊一個一個來，用 `drain()` 等。
 */
import {
    METHOD_DEFLATE, METHOD_STORE, MAX_UINT32,
    buildCentralRecord, buildEndRecords, buildLocalHeader, toDosDateTime,
    type ZipEntryRecord,
} from './zipFormat';
import { crc32 } from './crc32';

export interface ZipFileOptions {
    /** 內容是 base64 字串（舊格式的內嵌圖片）：解成位元組再寫 */
    base64?: boolean;
    compression?: 'STORE' | 'DEFLATE';
    compressionOptions?: { level?: number };
}

export type ZipFileData = string | Uint8Array | Blob;

export interface ZipStreamWriter {
    /** 登記一個檔案。同步回來（IndexedDB 游標的回呼裡不能 await）；Blob 會排隊 */
    file(name: string, data: ZipFileData, options?: ZipFileOptions): void;
    /** 等排隊的都寫完。呼叫端每批之後 await 一次 */
    drain(): Promise<void>;
    /** 寫目錄、收尾，回整包 */
    finish(): Promise<Blob>;
    /** 中途放棄 */
    abort(): Promise<void>;
    /** 已寫出的位元組數 */
    readonly bytesWritten: number;
    /** 已寫出的檔案數 */
    readonly entryCount: number;
    /** 同名檔案被跳過幾次（照理是 0；不是 0 代表呼叫端有 bug，但不該讓整個備份失敗） */
    readonly duplicateCount: number;
}

/** 輸出去哪。write 是同步的：寫入器保證一個條目的檔頭和內容連著寫 */
export interface ZipSink {
    write(chunk: Uint8Array): void;
    finish(): Promise<Blob>;
    abort(): Promise<void>;
}

/** 原始 DEFLATE（不帶 zlib／gzip 外殼）。正式環境傳 fflate 的 deflateSync */
export type DeflateRaw = (data: Uint8Array, options: { level: number }) => Uint8Array;

/** 攢到這麼多就包成一個小 Blob，原始位元組隨即可以回收 */
const MEMORY_SINK_PART_BYTES = 8 * 1024 * 1024;

/**
 * 記憶體輸出：分段包成 Blob，最後串起來。輸出還是完整一份，
 * 但不會在 JS 堆裡留一長串位元組陣列。OPFS 不能用時的退路（第 2 批）。
 */
export const createMemorySink = (type = 'application/zip'): ZipSink => {
    let parts: Blob[] = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = () => {
        if (!pending.length) return;
        parts.push(new Blob(pending as BlobPart[]));
        pending = [];
        pendingBytes = 0;
    };
    return {
        write(chunk) {
            pending.push(chunk);
            pendingBytes += chunk.byteLength;
            if (pendingBytes >= MEMORY_SINK_PART_BYTES) flush();
        },
        async finish() {
            flush();
            const blob = new Blob(parts, { type });
            parts = [];
            return blob;
        },
        async abort() {
            parts = [];
            pending = [];
            pendingBytes = 0;
        },
    };
};

const BASE64_SLICE = 1024 * 1024; // 4 的倍數：每段各自解，段與段之間不用補位

/** base64 → 位元組。分段解，不產生跟整張圖一樣長的中間字串 */
export const decodeBase64 = (base64: string): Uint8Array => {
    const length = base64.length;
    if (length % 4 !== 0) throw new Error('Invalid base64 input, bad content length.');
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const out = new Uint8Array((length / 4) * 3 - padding);
    let at = 0;
    for (let start = 0; start < length; start += BASE64_SLICE) {
        const binary = atob(base64.slice(start, Math.min(length, start + BASE64_SLICE)));
        for (let i = 0; i < binary.length; i++) out[at++] = binary.charCodeAt(i);
    }
    return out;
};

const encoder = new TextEncoder();

export interface ZipStreamWriterOptions {
    sink?: ZipSink;
    deflate: DeflateRaw;
    /** 沒指定等級的檔案用這個（預設 6） */
    level?: number;
    /** 寫進每個條目的時間（預設現在） */
    date?: Date;
}

export const createZipStreamWriter = (options: ZipStreamWriterOptions): ZipStreamWriter => {
    const sink = options.sink || createMemorySink();
    const defaultLevel = options.level ?? 6;
    const { dosTime, dosDate } = toDosDateTime(options.date || new Date());

    const entries: ZipEntryRecord[] = [];
    const names = new Set<string>();
    let offset = 0;
    let duplicates = 0;
    let state: 'open' | 'finished' | 'aborted' = 'open';
    let failure: Error | null = null;
    /** Blob 要先讀：一個接一個，不同時讀好幾張 */
    let blobChain: Promise<void> = Promise.resolve();

    const emit = (chunk: Uint8Array) => {
        sink.write(chunk);
        offset += chunk.byteLength;
    };

    /** 算 CRC、壓縮、組檔頭。這一步出錯還沒寫出任何東西，整包沒壞 */
    const prepareEntry = (name: string, bytes: Uint8Array, fileOptions: ZipFileOptions) => {
        if (bytes.byteLength >= MAX_UINT32) throw new Error(`備份裡有單個檔案超過 4 GB（${name}），無法寫入。`);
        const nameBytes = encoder.encode(name);
        if (nameBytes.length > 0xFFFF) throw new Error(`備份裡的檔名太長：${name.slice(0, 80)}…`);
        let method = METHOD_STORE;
        let payload = bytes;
        if (fileOptions.compression !== 'STORE' && bytes.byteLength > 0) {
            const level = fileOptions.compressionOptions?.level ?? defaultLevel;
            const deflated = level > 0 ? options.deflate(bytes, { level }) : bytes;
            // 壓了沒變小（已經壓過的東西）就原樣存
            if (deflated.byteLength < bytes.byteLength) {
                method = METHOD_DEFLATE;
                payload = deflated;
            }
        }
        const entry: ZipEntryRecord = {
            nameBytes, method, crc: crc32(bytes), compressedSize: payload.byteLength, size: bytes.byteLength,
            offset: 0, dosTime, dosDate,
        };
        return { entry, payload };
    };

    /** 檔頭和內容連著寫出去。這一步出錯代表輸出斷在半個條目上，整包作廢（failure 記住，之後都報錯） */
    const emitEntry = ({ entry, payload }: ReturnType<typeof prepareEntry>) => {
        try {
            entry.offset = offset;
            emit(buildLocalHeader(entry));
            if (payload.byteLength) emit(payload);
            entries.push(entry);
        } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            throw failure;
        }
    };

    const assertOpen = () => {
        if (failure) throw failure;
        if (state !== 'open') throw new Error(state === 'finished' ? '備份包已經收尾，不能再寫。' : '備份已經中止。');
    };

    const file: ZipStreamWriter['file'] = (name, data, fileOptions = {}) => {
        assertOpen();
        if (names.has(name)) {
            // JSZip 是後寫的蓋掉先寫的；串流寫出去的收不回來，只能留先寫的。
            duplicates++;
            console.warn(`[Backup] 備份包裡出現同名檔案，後面那個已跳過：${name}`);
            return;
        }
        names.add(name);
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            blobChain = blobChain.then(async () => {
                if (failure || state !== 'open') return;
                try {
                    emitEntry(prepareEntry(name, new Uint8Array(await data.arrayBuffer()), fileOptions));
                } catch (error) {
                    // Blob 是排隊寫的，呼叫端當下接不到錯：讀不到也算整包失敗，由 drain／finish 報出來
                    failure = failure || (error instanceof Error ? error : new Error(String(error)));
                }
            });
            return;
        }
        let prepared: ReturnType<typeof prepareEntry>;
        try {
            const bytes = typeof data === 'string'
                ? (fileOptions.base64 ? decodeBase64(data) : encoder.encode(data))
                : data as Uint8Array;
            prepared = prepareEntry(name, bytes, fileOptions);
        } catch (error) {
            // 還沒寫出任何東西：這個檔案當作沒登記過，丟給呼叫端決定（例如把圖片留在 JSON 裡）
            names.delete(name);
            throw error;
        }
        emitEntry(prepared);
    };

    const drain = async () => {
        await blobChain;
        if (failure) throw failure;
    };

    const finish = async (): Promise<Blob> => {
        await drain();
        assertOpen();
        const centralOffset = offset;
        for (const entry of entries) emit(buildCentralRecord(entry));
        const centralSize = offset - centralOffset;
        emit(buildEndRecords(entries.length, centralSize, centralOffset));
        state = 'finished';
        return sink.finish();
    };

    const abort = async () => {
        if (state !== 'open') return;
        state = 'aborted';
        await blobChain.catch(() => undefined);
        await sink.abort();
    };

    return {
        file, drain, finish, abort,
        get bytesWritten() { return offset; },
        get entryCount() { return entries.length; },
        get duplicateCount() { return duplicates; },
    };
};

/** JSZip 的最小長相（context/OSContext.tsx 動態載入的那個） */
interface JSZipInstanceLike {
    file(name: string, data: any, options?: any): unknown;
    generateAsync(options: any, onUpdate?: (metadata: { percent: number }) => void): Promise<Blob>;
}

/**
 * 同一個介面、後面接 JSZip（舊做法：全部登記、最後一次生成）。
 * 只給兩個地方用：測試拿它當對照組；出事時用 localStorage 的開關退回舊容器排查
 * （見 utils/backupRunState.ts 的 BACKUP_ZIP_WRITER_LS_KEY）。不省記憶體。
 */
export const createJSZipWriter = (zip: JSZipInstanceLike, options: { level?: number } = {}): ZipStreamWriter => {
    const names = new Set<string>();
    let duplicates = 0;
    let finished = false;
    return {
        file(name, data, fileOptions = {}) {
            if (finished) throw new Error('備份包已經收尾，不能再寫。');
            if (names.has(name)) { duplicates++; return; }
            names.add(name);
            zip.file(name, data, fileOptions);
        },
        async drain() { /* JSZip 全留在記憶體，沒有東西可以等 */ },
        async finish() {
            finished = true;
            return zip.generateAsync({
                type: 'blob',
                streamFiles: true,
                compression: 'DEFLATE',
                compressionOptions: { level: options.level ?? 6 },
            });
        },
        async abort() { finished = true; },
        get bytesWritten() { return 0; },
        get entryCount() { return names.size; },
        get duplicateCount() { return duplicates; },
    };
};
