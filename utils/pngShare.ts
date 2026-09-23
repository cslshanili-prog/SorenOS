/** Portable Soren files in a PNG ancillary chunk. No remote storage or image decoding needed.
 * Chunk layout and CRC: https://www.w3.org/TR/png-3/#5Chunk-layout
 * suLy = ancillary, private, reserved bit clear, safe to copy.
 */
export const SHARE_KINDS = {
    'chat-decoration': '聊天裝扮', character: '角色卡', worldbook: '世界書', 'chrome-css': '白框 CSS',
    'chrome-presets': '白框預設集', 'journal-css': '日記 CSS', 'chat-theme': '氣泡主題',
    appearance: '外觀預設', story: '劇情預設', room: '小屋樣板房',
    'pixel-home': '像素小屋', 'whitebox-sound': '白框提示音',
} as const;
export type ShareKind = keyof typeof SHARE_KINDS;
export type ShareCardStyle = 'paper' | 'poster' | 'business';
export interface ShareCardOptions {
    kind: ShareKind;
    title?: string;
    author?: string;
    restrictions?: string;
    previewUrl?: string;
}
export interface ShareCardMetadata {
    format: 'sullyos-share';
    version: 1;
    kind: ShareKind;
    title: string;
    author: string;
    restrictions: string;
    style: ShareCardStyle;
    fileName: string;
    mimeType: string;
}
export const MAX_SHARE_BYTES = 64 * 1024 * 1024;
const MAX_PNG_BYTES = MAX_SHARE_BYTES + 32 * 1024 * 1024;
const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CHUNK = 'suLy';
const MAGIC = new TextEncoder().encode('SullyOS\0');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
export function isPng(bytes: Uint8Array): boolean {
    return SIGNATURE.every((b, i) => bytes[i] === b);
}
function chunks(bytes: Uint8Array): { type: string; start: number; end: number; data: Uint8Array }[] {
    if (!isPng(bytes)) throw new Error('請選擇 PNG 原文件；截圖或轉換格式後的圖片無法導入');
    if (bytes.length > MAX_PNG_BYTES) throw new Error('圖片過大，請使用原格式文件導入');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    let hasImage = false;
    for (let start = 8; start < bytes.length;) {
        if (start + 12 > bytes.length) throw new Error('PNG 文件不完整');
        const length = view.getUint32(start);
        const end = start + length + 12;
        if (end > bytes.length) throw new Error('PNG 數據長度異常，文件可能已損壞');
        const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
        if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) throw new Error('PNG 數據塊無效');
        if (crc32(bytes.subarray(start + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error('PNG 校驗失敗，文件可能已損壞，請重新獲取原文件');
        if (result.length === 0 && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 圖片頭無效');
        if (type === 'IDAT') hasImage = true;
        result.push({ type, start, end, data: bytes.subarray(start + 8, end - 4) });
        if (type === 'IEND') {
            if (length !== 0 || end !== bytes.length || !hasImage) throw new Error('PNG 文件結構異常');
            return result;
        }
        start = end;
    }
    throw new Error('PNG 文件不完整');
}
function validateMetadata(value: unknown): asserts value is ShareCardMetadata {
    const m = value as ShareCardMetadata | null;
    if (!m || m.format !== 'sullyos-share') throw new Error('不是 Soren 分享圖片');
    if (m.version !== 1) throw new Error('暫不支持此分享圖片版本，請更新 Soren');
    if (!Object.prototype.hasOwnProperty.call(SHARE_KINDS, m.kind)) throw new Error('無法識別分享內容類型');
    for (const [key, max] of [['title', 60], ['author', 32], ['restrictions', 120], ['fileName', 240], ['mimeType', 120]] as const) {
        if (typeof m[key] !== 'string' || m[key].length > max) throw new Error('分享圖片信息無效');
    }
    if (!m.title.trim() || !m.fileName || /[\\/\x00-\x1f]/.test(m.fileName) || /[\r\n]/.test(m.mimeType)
        || !['paper', 'poster', 'business'].includes(m.style)) throw new Error('分享圖片信息無效');
}
export function safeShareFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 220) || 'Soren';
}
export function embedShareInPng(png: Uint8Array, metadata: ShareCardMetadata, payload: Uint8Array): Uint8Array {
    validateMetadata(metadata);
    if (!payload.length || payload.length > MAX_SHARE_BYTES) throw new Error('分享內容為空或超過 64 MB，請使用原格式導出');
    const parsed = chunks(png);
    const header = encoder.encode(JSON.stringify(metadata));
    const data = new Uint8Array(MAGIC.length + 4 + header.length + payload.length);
    data.set(MAGIC);
    new DataView(data.buffer).setUint32(MAGIC.length, header.length);
    data.set(header, MAGIC.length + 4);
    data.set(payload, MAGIC.length + 4 + header.length);
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(encoder.encode(CHUNK), 4);
    chunk.set(data, 8);
    view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
    // Replace existing Sully data, never retain a previous payload on re-export.
    const kept = parsed.filter(c => c.type !== CHUNK);
    const size = 8 + chunk.length + kept.reduce((n, c) => n + c.end - c.start, 0);
    if (size > MAX_PNG_BYTES) throw new Error('分享圖片過大，請使用原格式導出');
    const output = new Uint8Array(size);
    output.set(SIGNATURE);
    let offset = 8;
    for (const c of kept) {
        if (c.type === 'IEND') { output.set(chunk, offset); offset += chunk.length; }
        output.set(png.subarray(c.start, c.end), offset);
        offset += c.end - c.start;
    }
    return output;
}
export function extractShareFromPng(png: Uint8Array, expectedKind?: ShareKind): { metadata: ShareCardMetadata; payload: Uint8Array } {
    const found = chunks(png).filter(c => c.type === CHUNK);
    if (!found.length) throw new Error('圖片中沒有可導入的 Soren 內容。請使用導出的 PNG 原文件，不要截圖或壓縮');
    if (found.length !== 1) throw new Error('分享圖片含有重複數據，無法導入');
    const data = found[0].data;
    if (data.length < 12 || !MAGIC.every((b, i) => data[i] === b)) throw new Error('分享圖片標識無效');
    const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8);
    if (headerLength > 8192 || headerLength < 2 || 12 + headerLength >= data.length) throw new Error('分享圖片數據不完整');
    let metadata: unknown;
    try { metadata = JSON.parse(decoder.decode(data.subarray(12, 12 + headerLength))); }
    catch { throw new Error('分享圖片信息已損壞'); }
    validateMetadata(metadata);
    if (expectedKind && metadata.kind !== expectedKind) throw new Error(`這是一張${SHARE_KINDS[metadata.kind]}分享圖，請到對應功能導入；此處需要${SHARE_KINDS[expectedKind]}`);
    const payload = data.subarray(12 + headerLength);
    if (payload.length > MAX_SHARE_BYTES) throw new Error('分享內容超過 64 MB，請使用原格式文件導入');
    return { metadata, payload };
}

/** Keep original files unchanged; unwrap only PNGs, then use the existing domain importer. */
export async function readShareFile(file: File, expectedKind: ShareKind): Promise<File> {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (!isPng(signature) && !/\.png$/i.test(file.name) && file.type !== 'image/png') return file;
    if (file.size > MAX_PNG_BYTES) throw new Error('圖片過大，請使用原格式文件導入');
    const { metadata, payload } = extractShareFromPng(new Uint8Array(await file.arrayBuffer()), expectedKind);
    return new File([new Uint8Array(payload).buffer], metadata.fileName, { type: metadata.mimeType });
}
export async function readShareText(file: File, expectedKind: ShareKind): Promise<string> {
    return (await readShareFile(file, expectedKind)).text();
}

/** Distinguish a plain PNG from a share card; corrupt cards still fail validation. */
export function pngHasShare(bytes:Uint8Array):boolean { return chunks(bytes).some(chunk=>chunk.type===CHUNK); }
