import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { deflateSync, inflateSync } from 'fflate';
import { createZipStreamWriter } from './writer';
import { encodeBase64, openZipReader } from './reader';

const deflate = (data: Uint8Array, options: { level: number }) => deflateSync(data, { level: options.level as any });
const inflate = (data: Uint8Array, size: number) => inflateSync(data, { out: new Uint8Array(size) });
const open = (bytes: Uint8Array | Blob) => openZipReader(bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]), { inflate });

/** 會記下每次 slice 讀了多少的 Blob：確認沒有把整個檔讀進來 */
const spyBlob = (bytes: Uint8Array) => {
    const blob = new Blob([bytes as BlobPart]);
    const reads: number[] = [];
    const proxy = {
        size: blob.size,
        slice: (start: number, end: number) => { reads.push(end - start); return blob.slice(start, end); },
    } as unknown as Blob;
    return { blob: proxy, reads };
};

const sample = () => ({
    'manifest.json': '{"formatVersion":3}',
    'stores/messages.000.json': JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ id: i, content: `第 ${i} 則：今天天氣很好` }))),
    'assets/圖 一.png': new Uint8Array(200_000).map((_, i) => (i * 7 + 1) & 0xFF),
    'blobs/abc': new Uint8Array(350_000).map((_, i) => (i * 13) & 0xFF),
    'empty.json': '',
});

const packWithJSZip = async (options: { streamFiles?: boolean; comment?: string } = {}) => {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(sample())) zip.file(name, data, typeof data === 'string' ? undefined : { compression: 'STORE' });
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles: options.streamFiles, comment: options.comment });
};

const packWithStreamWriter = async () => {
    const writer = createZipStreamWriter({ deflate });
    for (const [name, data] of Object.entries(sample())) writer.file(name, data, typeof data === 'string' ? undefined : { compression: 'STORE' });
    return new Uint8Array(await (await writer.finish()).arrayBuffer());
};

const expectSameAsSample = async (reader: Awaited<ReturnType<typeof open>>) => {
    const data = sample();
    expect(Object.keys(reader.files).filter(n => !reader.files[n].dir).sort()).toEqual(Object.keys(data).sort());
    expect(await reader.file('manifest.json')!.async('string')).toBe(data['manifest.json']);
    expect(await reader.file('stores/messages.000.json')!.async('string')).toBe(data['stores/messages.000.json']);
    expect(Buffer.from(await reader.file('assets/圖 一.png')!.async('uint8array')).equals(Buffer.from(data['assets/圖 一.png']))).toBe(true);
    expect(await reader.file('blobs/abc')!.async('base64')).toBe(Buffer.from(data['blobs/abc']).toString('base64'));
    expect(await reader.file('empty.json')!.async('string')).toBe('');
    expect(reader.file('不存在')).toBeNull();
    expect(reader.file('assets/圖 一.png')!._data).toEqual({ compressedSize: 200_000, uncompressedSize: 200_000 });
};

describe('隨機讀取的 zip 讀取器', () => {
    it('讀得了 JSZip 打的包（舊備份、上游的備份）', async () => {
        await expectSameAsSample(await open(await packWithJSZip()));
    });

    it('讀得了 JSZip 邊壓邊寫的包（檔頭大小是 0、後面帶 data descriptor，舊版整合導出就是這種）', async () => {
        await expectSameAsSample(await open(await packWithJSZip({ streamFiles: true })));
    });

    it('讀得了串流寫入器打的包（現在的備份）', async () => {
        await expectSameAsSample(await open(await packWithStreamWriter()));
    });

    it('結尾有註解也找得到目錄', async () => {
        await expectSameAsSample(await open(await packWithJSZip({ comment: '備份註解'.repeat(200) })));
    });

    it('檔案前面多了位元組（位移整體平移）也讀得了', async () => {
        const zip = await packWithJSZip();
        const padded = new Uint8Array(5000 + zip.length);
        padded.set(zip, 5000);
        await expectSameAsSample(await open(padded));
    });

    it('超過 65535 個檔案（zip64）讀得了，前面多了位元組也一樣', async () => {
        const writer = createZipStreamWriter({ deflate });
        const total = 66_000;
        for (let i = 0; i < total; i++) writer.file(`blobs/${i}`, new Uint8Array([i & 0xFF, (i >> 8) & 0xFF]), { compression: 'STORE' });
        const bytes = new Uint8Array(await (await writer.finish()).arrayBuffer());
        const reader = await open(bytes);
        expect(reader.entryCount).toBe(total);
        expect(Array.from(await reader.file('blobs/65999')!.async('uint8array'))).toEqual([65999 & 0xFF, (65999 >> 8) & 0xFF]);
        const padded = new Uint8Array(777 + bytes.length);
        padded.set(bytes, 777);
        const shifted = await open(padded);
        expect(shifted.entryCount).toBe(total);
        expect(Array.from(await shifted.file('blobs/123')!.async('uint8array'))).toEqual([123, 0]);
    }, 60_000);

    it('不會把整個檔讀進來：開檔只讀檔尾和目錄，讀一個條目只讀那一段', async () => {
        const bytes = await packWithStreamWriter();
        const { blob, reads } = spyBlob(bytes);
        const reader = await openZipReader(blob, { inflate });
        const openRead = reads.reduce((sum, n) => sum + n, 0);
        expect(openRead).toBeLessThan(bytes.length);
        reads.length = 0;
        await reader.file('manifest.json')!.async('string');
        expect(reads.reduce((sum, n) => sum + n, 0)).toBeLessThan(200);
        reads.length = 0;
        await reader.file('assets/圖 一.png')!.async('uint8array');
        expect(reads.reduce((sum, n) => sum + n, 0)).toBe(30 + 200_000);
    });

    it('目錄條目列在 files 裡、標成資料夾，不能當檔案讀', async () => {
        const reader = await open(await packWithJSZip());
        expect(reader.files['assets/']).toEqual({ name: 'assets/', dir: true });
        expect(reader.file('assets/')).toBeNull();
    });

    it('不是 zip、被截斷、目錄壞掉：開檔就報錯', async () => {
        await expect(open(new Uint8Array(10))).rejects.toThrow(/不是 zip/);
        await expect(open(new TextEncoder().encode('{"hello":"world"}'.repeat(10)))).rejects.toThrow(/不是 zip/);
        const zip = await packWithStreamWriter();
        await expect(open(zip.slice(0, zip.length - 30))).rejects.toThrow(/不是 zip|損壞/);
        const broken = zip.slice();
        // 把中央目錄第一筆的記號改掉
        const view = new DataView(broken.buffer);
        const cdOffset = view.getUint32(broken.length - 22 + 16, true);
        broken[cdOffset] = 0;
        await expect(open(broken)).rejects.toThrow(/中央目錄/);
    });

    it('條目內容被截斷：讀那個條目時報錯，說清楚是哪個檔', async () => {
        const zip = await packWithStreamWriter();
        const reader = await open(zip);
        // 目錄正常，但把某個條目的檔頭弄壞
        const broken = zip.slice();
        const index = Buffer.from(broken).indexOf(Buffer.from('blobs/abc')) - 30;
        broken[index] = 0;
        const bad = await open(broken);
        await expect(bad.file('blobs/abc')!.async('uint8array')).rejects.toThrow(/blobs\/abc/);
        expect(await reader.file('manifest.json')!.async('string')).toBe('{"formatVersion":3}');
    });

    it('加密或不認得壓縮方式的 zip：開檔就報錯（呼叫端會退回 JSZip）', async () => {
        const zip = await packWithStreamWriter();
        const view = new DataView(zip.buffer);
        const cdOffset = view.getUint32(zip.length - 22 + 16, true);
        const encrypted = zip.slice();
        encrypted[cdOffset + 8] |= 1;
        await expect(open(encrypted)).rejects.toThrow(/加密/);
        const weird = zip.slice();
        weird[cdOffset + 10] = 12;
        await expect(open(weird)).rejects.toThrow(/壓縮方式/);
    });
});

describe('encodeBase64', () => {
    it('跟 Buffer 編出來的一樣（含跨段和補位）', () => {
        for (const length of [0, 1, 2, 3, 24_575, 24_576, 24_577, 100_000]) {
            const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 5) & 0xFF);
            expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
        }
    });
});
