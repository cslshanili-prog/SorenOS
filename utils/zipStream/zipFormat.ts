/**
 * zip 容器的位元組格式：檔頭、中央目錄、結尾記錄（含 zip64）。純函式，不碰壓縮、不碰輸出。
 * 見 plans/backup-streaming.md 第 4.1 節。
 *
 * 每個條目的 CRC 和大小在寫檔頭時就已經知道（整個檔案在手上才寫），所以不用 data descriptor，
 * 輸出只需要「往後接」。
 */

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** 檔名用 UTF-8（通用旗標第 11 位） */
const FLAG_UTF8 = 0x0800;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;

export const MAX_UINT32 = 0xFFFFFFFF;
export const MAX_UINT16 = 0xFFFF;

/** 中央目錄要記的東西：一個條目大約一百位元組，整包只有這份留在記憶體 */
export interface ZipEntryRecord {
    nameBytes: Uint8Array;
    method: number;
    crc: number;
    compressedSize: number;
    size: number;
    /** 這個條目的檔頭在整包裡的位移 */
    offset: number;
    dosTime: number;
    dosDate: number;
}

export const toDosDateTime = (date: Date): { dosTime: number; dosDate: number } => {
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    return {
        dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
};

/** 64 位元無號整數（小端）。位移和大小都遠小於 2^53，拆成高低兩半寫 */
const setUint64 = (view: DataView, at: number, value: number) => {
    view.setUint32(at, value >>> 0, true);
    view.setUint32(at + 4, Math.floor(value / 0x100000000) >>> 0, true);
};

/** 條目檔頭（後面緊接內容） */
export const buildLocalHeader = (entry: ZipEntryRecord): Uint8Array => {
    const out = new Uint8Array(30 + entry.nameBytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, SIG_LOCAL, true);
    view.setUint16(4, VERSION_DEFAULT, true);
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, entry.method, true);
    view.setUint16(10, entry.dosTime, true);
    view.setUint16(12, entry.dosDate, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.compressedSize, true);
    view.setUint32(22, entry.size, true);
    view.setUint16(26, entry.nameBytes.length, true);
    view.setUint16(28, 0, true);
    out.set(entry.nameBytes, 30);
    return out;
};

/** 中央目錄的一筆。位移超過 4 GB 時改寫進 zip64 的額外欄位 */
export const buildCentralRecord = (entry: ZipEntryRecord): Uint8Array => {
    const needsZip64 = entry.offset >= MAX_UINT32;
    const extraLength = needsZip64 ? 12 : 0;
    const out = new Uint8Array(46 + entry.nameBytes.length + extraLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, SIG_CENTRAL, true);
    view.setUint16(4, needsZip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
    view.setUint16(6, needsZip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
    view.setUint16(8, FLAG_UTF8, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, entry.dosTime, true);
    view.setUint16(14, entry.dosDate, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.compressedSize, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, extraLength, true);
    view.setUint16(32, 0, true); // 註解長度
    view.setUint16(34, 0, true); // 起始磁碟
    view.setUint16(36, 0, true); // 內部屬性
    view.setUint32(38, 0, true); // 外部屬性
    view.setUint32(42, needsZip64 ? MAX_UINT32 : entry.offset, true);
    out.set(entry.nameBytes, 46);
    if (needsZip64) {
        const at = 46 + entry.nameBytes.length;
        view.setUint16(at, 0x0001, true);
        view.setUint16(at + 2, 8, true);
        setUint64(view, at + 4, entry.offset);
    }
    return out;
};

/**
 * 結尾：條目數超過 65535、或中央目錄的位移／大小超過 4 GB 時，前面多寫 zip64 的兩筆記錄，
 * 舊欄位填滿（讀的那邊看到填滿就去讀 zip64 的）。
 */
export const buildEndRecords = (entryCount: number, centralSize: number, centralOffset: number): Uint8Array => {
    const needsZip64 = entryCount >= MAX_UINT16 || centralSize >= MAX_UINT32 || centralOffset >= MAX_UINT32;
    const out = new Uint8Array((needsZip64 ? 56 + 20 : 0) + 22);
    const view = new DataView(out.buffer);
    let at = 0;
    if (needsZip64) {
        view.setUint32(at, SIG_ZIP64_EOCD, true);
        setUint64(view, at + 4, 44); // 這筆記錄後面還有幾個位元組
        view.setUint16(at + 12, VERSION_ZIP64, true);
        view.setUint16(at + 14, VERSION_ZIP64, true);
        view.setUint32(at + 16, 0, true);
        view.setUint32(at + 20, 0, true);
        setUint64(view, at + 24, entryCount);
        setUint64(view, at + 32, entryCount);
        setUint64(view, at + 40, centralSize);
        setUint64(view, at + 48, centralOffset);
        at += 56;
        view.setUint32(at, SIG_ZIP64_LOCATOR, true);
        view.setUint32(at + 4, 0, true);
        setUint64(view, at + 8, centralOffset + centralSize);
        view.setUint32(at + 16, 1, true);
        at += 20;
    }
    view.setUint32(at, SIG_EOCD, true);
    view.setUint16(at + 4, 0, true);
    view.setUint16(at + 6, 0, true);
    view.setUint16(at + 8, Math.min(entryCount, MAX_UINT16), true);
    view.setUint16(at + 10, Math.min(entryCount, MAX_UINT16), true);
    view.setUint32(at + 12, Math.min(centralSize, MAX_UINT32), true);
    view.setUint32(at + 16, Math.min(centralOffset, MAX_UINT32), true);
    view.setUint16(at + 20, 0, true);
    return out;
};
