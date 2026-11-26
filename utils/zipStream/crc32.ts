/** CRC-32（zip 用的那個，多項式 0xEDB88320）。fflate 沒有公開它的，自己帶一份。 */
const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** 分段算：`crc32Update(CRC32_INIT, 第一段)` → 再餵下一段 → 最後 `crc32Finish` */
export const CRC32_INIT = 0xFFFFFFFF;
export const crc32Update = (crc: number, bytes: Uint8Array): number => {
    for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return crc;
};
export const crc32Finish = (crc: number): number => (crc ^ 0xFFFFFFFF) >>> 0;

export const crc32 = (bytes: Uint8Array): number => crc32Finish(crc32Update(CRC32_INIT, bytes));
