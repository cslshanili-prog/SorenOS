/**
 * 隨機讀取的 zip 讀取器（plans/backup-streaming.md 第 3 批）。
 *
 * JSZip.loadAsync 會先把整個檔案讀進記憶體，幾百 MB 的備份在 iPhone 上還原，光這一步就可能讓分頁被關。
 * 這裡只讀檔尾的目錄，之後要哪個條目才用 Blob.slice 去讀那一段、解壓、用完就放，
 * 記憶體裡同時只有一個條目。
 *
 * `file()`／`files` 的長相跟 JSZip 一樣（還原流程只用到這幾樣），所以還原那邊換個來源就行。
 * 讀不懂的 zip（加密、分卷、不認得的壓縮法）在開檔時就丟錯，呼叫端退回 JSZip。
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const MAX_UINT32 = 0xFFFFFFFF;
const MAX_UINT16 = 0xFFFF;
/** 結尾記錄 22 位元組＋最長 65535 的註解＋zip64 定位記錄 20 位元組 */
const TAIL_BYTES = 22 + 0xFFFF + 20;

/** 原始 DEFLATE 解壓。正式環境傳 fflate 的 inflateSync（size 是解開後的大小，可以先配好緩衝） */
export type InflateRaw = (data: Uint8Array, size: number) => Uint8Array;

/** 邊餵邊吐的解壓器：餵一段壓縮資料，回這一段解出來的（可能好幾塊，也可能沒有） */
export interface InflateStream {
    push(data: Uint8Array, final: boolean): Uint8Array[];
}

export interface ZipReaderFile {
    name: string;
    dir: boolean;
    /** 跟 JSZip 同名的欄位：還原進度拿它顯示檔案大小 */
    _data: { compressedSize: number; uncompressedSize: number };
    async(type: 'string' | 'base64'): Promise<string>;
    async(type: 'uint8array'): Promise<Uint8Array>;
    /**
     * 一段一段吐出解壓後的內容，整個條目不會同時在記憶體裡（第 3c 批：早期備份那一整根 data.json 用這個讀）。
     * JSZip 的檔案物件沒有這個方法，呼叫端要先確認有再用。
     */
    chunks(): AsyncGenerator<Uint8Array, void, void>;
}

/** 還原流程用到的最小介面。JSZip 載入後的物件和這裡的讀取器都符合 */
export interface BackupZipReader {
    files: Record<string, { name: string; dir: boolean }>;
    file(name: string): ZipReaderFile | null;
}

interface CentralEntry {
    name: string;
    method: number;
    compressedSize: number;
    size: number;
    /** 這個條目的檔頭在檔案裡的位移（已經加上前面多出來的位元組） */
    offset: number;
}

const readBytes = async (blob: Blob, start: number, end: number): Promise<Uint8Array> =>
    new Uint8Array(await blob.slice(start, end).arrayBuffer());

const getUint64 = (view: DataView, at: number): number => {
    const value = view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x100000000;
    if (!Number.isSafeInteger(value)) throw new Error('備份包裡的位移超出範圍');
    return value;
};

const utf8 = new TextDecoder('utf-8');
const decodeName = (bytes: Uint8Array, isUtf8: boolean): string => {
    if (isUtf8) return utf8.decode(bytes);
    // 沒標 UTF-8 的檔名照單位元組讀（我們自己的備份檔名都是 ASCII）
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
};

const BASE64_CHUNK = 24_576; // 3 的倍數：每段各自編碼，接起來中間不會出現補位

/** 位元組 → base64，分段做，不產生跟整個檔一樣長的中間字串 */
export const encodeBase64 = (bytes: Uint8Array): string => {
    const parts: string[] = [];
    for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
        const chunk = bytes.subarray(start, Math.min(bytes.length, start + BASE64_CHUNK));
        let binary = '';
        for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode.apply(null, chunk.subarray(i, i + 8192) as unknown as number[]);
        parts.push(btoa(binary));
    }
    return parts.join('');
};

/** 分段讀壓縮資料時一次讀多少。文字大約壓成五到十分之一，所以解出來每塊一兩 MB */
const STREAM_WINDOW_BYTES = 256 * 1024;

export const openZipReader = async (
    blob: Blob,
    options: { inflate: InflateRaw; createInflateStream?: () => InflateStream },
): Promise<BackupZipReader & { entryCount: number }> => {
    const total = blob.size;
    if (total < 22) throw new Error('不是 zip 檔（太小）');

    // 1. 從檔尾找結尾記錄
    const tailStart = Math.max(0, total - TAIL_BYTES);
    const tail = await readBytes(blob, tailStart, total);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocdAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tailView.getUint32(i, true) === SIG_EOCD && i + 22 + tailView.getUint16(i + 20, true) <= tail.length) { eocdAt = i; break; }
    }
    if (eocdAt < 0) throw new Error('不是 zip 檔（找不到結尾記錄）');
    if (tailView.getUint16(eocdAt + 4, true) !== 0 && tailView.getUint16(eocdAt + 4, true) !== MAX_UINT16) throw new Error('不支援分卷的 zip');

    let entryCount = tailView.getUint16(eocdAt + 10, true);
    let centralSize = tailView.getUint32(eocdAt + 12, true);
    let centralOffset = tailView.getUint32(eocdAt + 16, true);
    /** 中央目錄的結尾在檔案裡的真實位置（平常就是結尾記錄的開頭；zip64 時是 zip64 結尾記錄的開頭） */
    let centralEnd = tailStart + eocdAt;

    // 2. zip64：條目太多或位移太大時，真正的數字在前面的 zip64 記錄裡
    const locatorAt = eocdAt - 20;
    const hasLocator = locatorAt >= 0 && tailView.getUint32(locatorAt, true) === SIG_ZIP64_LOCATOR;
    if (entryCount === MAX_UINT16 || centralSize === MAX_UINT32 || centralOffset === MAX_UINT32) {
        if (!hasLocator) throw new Error('損壞的 zip：缺少 zip64 定位記錄');
        const zip64RecordedAt = getUint64(tailView, locatorAt + 8);
        // 檔案前面可能多了位元組（自解壓外殼之類），記錄裡的位移要整體平移。zip64 結尾記錄固定 56 位元組、
        // 緊貼在定位記錄前面，用這個位置反推平移量
        const zip64ActualAt = tailStart + locatorAt - 56;
        const shift = zip64ActualAt - zip64RecordedAt;
        const record = await readBytes(blob, zip64ActualAt, zip64ActualAt + 56);
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        if (zip64ActualAt < 0 || view.getUint32(0, true) !== SIG_ZIP64_EOCD) throw new Error('損壞的 zip：zip64 結尾記錄不對');
        entryCount = getUint64(view, 32);
        centralSize = getUint64(view, 40);
        centralOffset = getUint64(view, 48);
        centralEnd = zip64ActualAt;
        if (shift !== 0 && centralOffset + shift !== centralEnd - centralSize) throw new Error('損壞的 zip：中央目錄位置對不上');
    }
    // 前面多出來的位元組：中央目錄實際的位置跟記錄的差多少，所有位移一起平移
    const shift = (centralEnd - centralSize) - centralOffset;
    if (shift < 0 || centralEnd - centralSize < 0) throw new Error('損壞的 zip：中央目錄位置不對');

    // 3. 讀中央目錄（一筆幾十個位元組，幾萬個檔也才幾 MB）
    const central = await readBytes(blob, centralEnd - centralSize, centralEnd);
    const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
    const entries = new Map<string, CentralEntry>();
    const files: Record<string, { name: string; dir: boolean }> = {};
    let at = 0;
    for (let index = 0; index < entryCount; index++) {
        if (at + 46 > central.length || view.getUint32(at, true) !== SIG_CENTRAL) throw new Error('損壞的 zip：中央目錄讀到一半斷了');
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        let compressedSize = view.getUint32(at + 20, true);
        let size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        let offset = view.getUint32(at + 42, true);
        const name = decodeName(central.subarray(at + 46, at + 46 + nameLength), (flags & 0x0800) !== 0);

        // zip64 額外欄位：只有填滿的那幾欄會出現，順序固定是 原始大小 → 壓縮後大小 → 位移
        let extraAt = at + 46 + nameLength;
        const extraEnd = extraAt + extraLength;
        while (extraAt + 4 <= extraEnd) {
            const id = view.getUint16(extraAt, true);
            const length = view.getUint16(extraAt + 2, true);
            if (id === 0x0001) {
                let field = extraAt + 4;
                if (size === MAX_UINT32) { size = getUint64(view, field); field += 8; }
                if (compressedSize === MAX_UINT32) { compressedSize = getUint64(view, field); field += 8; }
                if (offset === MAX_UINT32) { offset = getUint64(view, field); field += 8; }
            }
            extraAt += 4 + length;
        }

        const dir = name.endsWith('/');
        if (!dir) {
            if (flags & 0x0001) throw new Error(`不支援加密的 zip（${name}）`);
            if (method !== 0 && method !== 8) throw new Error(`不支援的壓縮方式 ${method}（${name}）`);
            // 同名條目以後面的為準（跟 JSZip 一樣）
            entries.set(name, { name, method, compressedSize, size, offset: offset + shift });
        }
        files[name] = { name, dir };
        at = extraEnd + commentLength;
    }

    const readEntry = async (entry: CentralEntry): Promise<Uint8Array> => {
        // 檔頭裡的檔名和額外欄位長度可能跟中央目錄不同，要讀檔頭才知道內容從哪開始。
        // 大小一律用中央目錄的（邊壓邊寫的 zip，檔頭裡的大小是 0）
        const header = await readBytes(blob, entry.offset, entry.offset + 30);
        if (header.length < 30) throw new Error(`損壞的備份包：${entry.name} 的檔頭不完整`);
        const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (headerView.getUint32(0, true) !== SIG_LOCAL) throw new Error(`損壞的備份包：${entry.name} 的檔頭不對`);
        const dataStart = entry.offset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true);
        const raw = await readBytes(blob, dataStart, dataStart + entry.compressedSize);
        if (raw.length !== entry.compressedSize) throw new Error(`損壞的備份包：${entry.name} 讀到一半就沒了（檔案被截斷）`);
        if (entry.method === 0) return raw;
        const inflated = options.inflate(raw, entry.size);
        if (inflated.length !== entry.size) throw new Error(`損壞的備份包：${entry.name} 解開後大小不對`);
        return inflated;
    };

    /** 內容從檔案的哪個位置開始（要讀檔頭才知道） */
    const dataStartOf = async (entry: CentralEntry): Promise<number> => {
        const header = await readBytes(blob, entry.offset, entry.offset + 30);
        if (header.length < 30) throw new Error(`損壞的備份包：${entry.name} 的檔頭不完整`);
        const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (headerView.getUint32(0, true) !== SIG_LOCAL) throw new Error(`損壞的備份包：${entry.name} 的檔頭不對`);
        return entry.offset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true);
    };

    async function* streamEntry(entry: CentralEntry): AsyncGenerator<Uint8Array, void, void> {
        // 沒給邊餵邊吐的解壓器：退回整個讀（結果一樣，只是不省記憶體）
        if (entry.method === 8 && !options.createInflateStream) {
            yield await readEntry(entry);
            return;
        }
        const dataStart = await dataStartOf(entry);
        const inflater = entry.method === 8 ? options.createInflateStream!() : null;
        let produced = 0;
        if (entry.compressedSize === 0 && inflater) {
            for (const out of inflater.push(new Uint8Array(0), true)) { produced += out.length; yield out; }
        }
        for (let at = 0; at < entry.compressedSize; at += STREAM_WINDOW_BYTES) {
            const end = Math.min(entry.compressedSize, at + STREAM_WINDOW_BYTES);
            const raw = await readBytes(blob, dataStart + at, dataStart + end);
            if (raw.length !== end - at) throw new Error(`損壞的備份包：${entry.name} 讀到一半就沒了（檔案被截斷）`);
            if (!inflater) { produced += raw.length; yield raw; continue; }
            for (const out of inflater.push(raw, end === entry.compressedSize)) { produced += out.length; yield out; }
        }
        if (produced !== entry.size) throw new Error(`損壞的備份包：${entry.name} 解開後大小不對`);
    }

    const file = (name: string): ZipReaderFile | null => {
        const entry = entries.get(name);
        if (!entry) return null;
        const async = (async (type: 'string' | 'base64' | 'uint8array') => {
            const bytes = await readEntry(entry);
            if (type === 'uint8array') return bytes;
            if (type === 'base64') return encodeBase64(bytes);
            return utf8.decode(bytes);
        }) as ZipReaderFile['async'];
        return { name: entry.name, dir: false, _data: { compressedSize: entry.compressedSize, uncompressedSize: entry.size }, async, chunks: () => streamEntry(entry) };
    };

    return { files, file, entryCount: entries.size };
};
