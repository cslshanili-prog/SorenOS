import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { deflateSync, inflateSync } from 'fflate';
import { crc32 } from './crc32';
import { buildCentralRecord, buildEndRecords, toDosDateTime, type ZipEntryRecord } from './zipFormat';
import { createJSZipWriter, createMemorySink, createZipStreamWriter, decodeBase64, type ZipSink } from './writer';

const deflate = (data: Uint8Array, options: { level: number }) => deflateSync(data, { level: options.level as any });
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const newWriter = (sink?: ZipSink) => createZipStreamWriter({ deflate, sink, date: new Date(2026, 10, 25, 12, 30, 0) });

describe('crc32', () => {
    it('標準測試向量', () => {
        expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926);
        expect(crc32(new Uint8Array(0))).toBe(0);
    });
});

describe('decodeBase64', () => {
    it('跟 Buffer 解出來的一樣，含補位與跨段', () => {
        for (const length of [0, 1, 2, 3, 4, 1000, 1024 * 1024 * 3 / 4 + 5]) {
            const raw = new Uint8Array(length);
            for (let i = 0; i < length; i++) raw[i] = (i * 31 + 7) & 0xFF;
            const b64 = Buffer.from(raw).toString('base64');
            expect(Buffer.from(decodeBase64(b64)).equals(Buffer.from(raw))).toBe(true);
        }
    });
    it('長度不是 4 的倍數直接報錯，不寫出壞檔', () => {
        expect(() => decodeBase64('abc')).toThrow(/Invalid base64/);
    });
});

describe('串流 zip 寫入器：寫出來的包 JSZip 讀得回來', () => {
    it('文字、位元組、base64、Blob、中文檔名、空檔，逐檔一樣', async () => {
        const writer = newWriter();
        const big = '記憶宮殿'.repeat(50_000);
        const binary = new Uint8Array(70_000).map((_, i) => (i * 13) & 0xFF);
        const image = new Uint8Array(5000).map((_, i) => (i * 7 + 3) & 0xFF);
        writer.file('manifest.json', '{"formatVersion":3}');
        writer.file('stores/messages.000.json', big);
        writer.file('stores/memory_vectors.bin', binary, { compression: 'STORE' });
        writer.file('assets/asset_1.png', Buffer.from(image).toString('base64'), { base64: true, compression: 'STORE' });
        writer.file('blobs/圖片 一.bin', new Blob([image]), { compression: 'STORE' });
        writer.file('empty.json', '');
        await writer.drain();
        expect(writer.entryCount).toBe(6);
        const blob = await writer.finish();
        expect(blob.size).toBe(writer.bytesWritten);

        const zip = await JSZip.loadAsync(await bytesOf(blob), { checkCRC32: true });
        expect(Object.keys(zip.files).sort()).toEqual([
            'assets/asset_1.png', 'blobs/圖片 一.bin', 'empty.json', 'manifest.json',
            'stores/memory_vectors.bin', 'stores/messages.000.json',
        ]);
        expect(await zip.file('manifest.json')!.async('string')).toBe('{"formatVersion":3}');
        expect(await zip.file('stores/messages.000.json')!.async('string')).toBe(big);
        expect(Buffer.from(await zip.file('stores/memory_vectors.bin')!.async('uint8array')).equals(Buffer.from(binary))).toBe(true);
        expect(Buffer.from(await zip.file('assets/asset_1.png')!.async('uint8array')).equals(Buffer.from(image))).toBe(true);
        expect(Buffer.from(await zip.file('blobs/圖片 一.bin')!.async('uint8array')).equals(Buffer.from(image))).toBe(true);
        expect(await zip.file('empty.json')!.async('string')).toBe('');
    });

    it('文字有壓縮、指定 STORE 的照原樣、壓了沒變小的也照原樣', async () => {
        const chunks: Uint8Array[] = [];
        const sink: ZipSink = { write: c => { chunks.push(c); }, finish: async () => new Blob(chunks as BlobPart[]), abort: async () => {} };
        const writer = newWriter(sink);
        const text = 'a'.repeat(100_000);
        writer.file('text.json', text);
        const afterText = writer.bytesWritten;
        expect(afterText).toBeLessThan(2000);

        const stored = new Uint8Array(10_000);
        writer.file('stored.bin', stored, { compression: 'STORE' });
        expect(writer.bytesWritten - afterText).toBe(30 + 'stored.bin'.length + 10_000);

        // 亂數壓不小：自動改成原樣存
        const noise = new Uint8Array(20_000);
        crypto.getRandomValues(noise);
        const before = writer.bytesWritten;
        writer.file('noise.bin', noise);
        expect(writer.bytesWritten - before).toBe(30 + 'noise.bin'.length + 20_000);

        const zip = await JSZip.loadAsync(await bytesOf(await writer.finish()), { checkCRC32: true });
        expect(await zip.file('text.json')!.async('string')).toBe(text);
        expect(Buffer.from(await zip.file('noise.bin')!.async('uint8array')).equals(Buffer.from(noise))).toBe(true);
    });

    it('CRC 真的有寫：把內容改掉一個位元組，JSZip 驗得出來', async () => {
        const writer = newWriter();
        writer.file('a.bin', new Uint8Array(1000).fill(7), { compression: 'STORE' });
        const bytes = await bytesOf(await writer.finish());
        bytes[30 + 'a.bin'.length + 10] ^= 0xFF;
        await expect(JSZip.loadAsync(bytes, { checkCRC32: true })).rejects.toThrow(/Corrupted zip/i);
    });

    it('超過 65535 個檔案寫 zip64，JSZip 照樣全讀得到', async () => {
        const writer = newWriter();
        const total = 66_000;
        for (let i = 0; i < total; i++) writer.file(`blobs/${i}`, new Uint8Array([i & 0xFF, (i >> 8) & 0xFF]), { compression: 'STORE' });
        const zip = await JSZip.loadAsync(await bytesOf(await writer.finish()));
        expect(Object.keys(zip.files)).toHaveLength(total);
        expect(Array.from(await zip.file('blobs/65999')!.async('uint8array'))).toEqual([65999 & 0xFF, (65999 >> 8) & 0xFF]);
        expect(Array.from(await zip.file('blobs/0')!.async('uint8array'))).toEqual([0, 0]);
    }, 60_000);

    it('同名檔案留先寫的、不讓備份失敗，次數記下來', async () => {
        const writer = newWriter();
        writer.file('a.json', 'first');
        writer.file('a.json', 'second');
        expect(writer.duplicateCount).toBe(1);
        const zip = await JSZip.loadAsync(await bytesOf(await writer.finish()));
        expect(await zip.file('a.json')!.async('string')).toBe('first');
    });

    it('收尾或中止之後不能再寫', async () => {
        const done = newWriter();
        done.file('a', 'x');
        await done.finish();
        expect(() => done.file('b', 'y')).toThrow(/已經收尾/);

        const aborted = newWriter();
        await aborted.abort();
        expect(() => aborted.file('b', 'y')).toThrow(/中止/);
    });

    it('壞的 base64：當場報錯、不寫出壞檔，包裡其他檔案照常，同一個檔名之後還能再寫', async () => {
        const writer = newWriter();
        writer.file('a.json', 'ok');
        expect(() => writer.file('assets/x.png', 'abc', { base64: true })).toThrow(/Invalid base64/);
        writer.file('assets/x.png', Buffer.from([1, 2, 3]).toString('base64'), { base64: true, compression: 'STORE' });
        const zip = await JSZip.loadAsync(await bytesOf(await writer.finish()), { checkCRC32: true });
        expect(Object.keys(zip.files).sort()).toEqual(['a.json', 'assets/x.png']);
        expect(Array.from(await zip.file('assets/x.png')!.async('uint8array'))).toEqual([1, 2, 3]);
    });

    it('輸出寫到一半失敗：整包作廢，之後 file／finish 都報錯', async () => {
        let calls = 0;
        const sink: ZipSink = {
            write: () => { calls++; if (calls === 2) throw new Error('磁碟滿了'); },
            finish: async () => new Blob([]), abort: async () => {},
        };
        const writer = newWriter(sink);
        expect(() => writer.file('a.bin', new Uint8Array(10), { compression: 'STORE' })).toThrow('磁碟滿了');
        expect(() => writer.file('b.bin', new Uint8Array(10))).toThrow('磁碟滿了');
        await expect(writer.finish()).rejects.toThrow('磁碟滿了');
    });

    it('Blob 讀失敗時 drain 和 finish 都報錯', async () => {
        const writer = newWriter();
        const broken = new Blob(['x']);
        (broken as any).arrayBuffer = () => Promise.reject(new Error('讀不到'));
        writer.file('blobs/x', broken);
        await expect(writer.drain()).rejects.toThrow('讀不到');
        await expect(writer.finish()).rejects.toThrow('讀不到');
    });

    it('記憶體輸出分段包成 Blob，接起來跟一次寫的一樣', async () => {
        const sink = createMemorySink();
        const writer = newWriter(sink);
        const chunk = new Uint8Array(3 * 1024 * 1024).fill(9);
        for (let i = 0; i < 7; i++) writer.file(`blobs/${i}`, chunk, { compression: 'STORE' });
        const zip = await JSZip.loadAsync(await bytesOf(await writer.finish()), { checkCRC32: true });
        expect(Object.keys(zip.files)).toHaveLength(7);
        expect((await zip.file('blobs/6')!.async('uint8array')).byteLength).toBe(chunk.byteLength);
    });
});

describe('zip64 的位元組', () => {
    const base: ZipEntryRecord = {
        nameBytes: new TextEncoder().encode('a'), method: 0, crc: 1, compressedSize: 2, size: 2, offset: 0,
        ...toDosDateTime(new Date(2026, 10, 25)),
    };
    it('位移超過 4 GB：舊欄位填滿，真正的位移在額外欄位', () => {
        const offset = 5 * 1024 * 1024 * 1024 + 123;
        const record = buildCentralRecord({ ...base, offset });
        const view = new DataView(record.buffer);
        expect(view.getUint32(42, true)).toBe(0xFFFFFFFF);
        expect(view.getUint16(30, true)).toBe(12);
        const at = 46 + 1;
        expect(view.getUint16(at, true)).toBe(0x0001);
        expect(view.getUint16(at + 2, true)).toBe(8);
        expect(view.getUint32(at + 4, true) + view.getUint32(at + 8, true) * 0x100000000).toBe(offset);
    });
    it('沒超過就是一般的 46 位元組記錄', () => {
        const record = buildCentralRecord({ ...base, offset: 1000 });
        expect(record.byteLength).toBe(47);
        expect(new DataView(record.buffer).getUint32(42, true)).toBe(1000);
    });
    it('結尾：平常 22 位元組；條目太多或位移太大時前面多兩筆 zip64 記錄', () => {
        expect(buildEndRecords(10, 500, 1000).byteLength).toBe(22);
        const many = buildEndRecords(70_000, 500, 1000);
        expect(many.byteLength).toBe(56 + 20 + 22);
        const view = new DataView(many.buffer);
        expect(view.getUint32(0, true)).toBe(0x06064b50);
        expect(view.getUint32(24, true)).toBe(70_000);
        expect(view.getUint32(56, true)).toBe(0x07064b50);
        expect(view.getUint32(56 + 8, true)).toBe(1500);
        expect(view.getUint16(76 + 10, true)).toBe(0xFFFF);
        expect(buildEndRecords(10, 500, 5 * 1024 * 1024 * 1024).byteLength).toBe(98);
    });
});

describe('JSZip 對照組（舊容器，同一個介面）', () => {
    it('寫出來的內容跟串流寫入器一樣', async () => {
        const files: Array<[string, string | Uint8Array, any]> = [
            ['manifest.json', '{"a":1}', undefined],
            ['stores/x.000.json', '[1,2,3]'.repeat(1000), undefined],
            ['blobs/1', new Uint8Array([1, 2, 3, 4]), { compression: 'STORE' }],
            ['assets/a.png', Buffer.from([9, 8, 7]).toString('base64'), { base64: true, compression: 'STORE' }],
        ];
        const stream = newWriter();
        const legacy = createJSZipWriter(new JSZip() as any);
        for (const [name, data, options] of files) { stream.file(name, data, options); legacy.file(name, data, options); }
        const a = await JSZip.loadAsync(await bytesOf(await stream.finish()));
        const b = await JSZip.loadAsync(await bytesOf(await legacy.finish()));
        // JSZip 會替每一層資料夾多寫一筆目錄條目；串流寫入器不寫（還原時沒有人讀它）
        const filesOf = (zip: JSZip) => Object.values(zip.files).filter(f => !f.dir).map(f => f.name).sort();
        expect(filesOf(a)).toEqual(filesOf(b));
        for (const name of Object.keys(a.files)) {
            expect(Buffer.from(await a.file(name)!.async('uint8array')).equals(Buffer.from(await b.file(name)!.async('uint8array')))).toBe(true);
        }
    });
});

describe('fflate 的原始 DEFLATE', () => {
    it('壓了解得回來（確認用的是不帶外殼的那個）', () => {
        const data = new TextEncoder().encode('備份'.repeat(1000));
        expect(Buffer.from(inflateSync(deflateSync(data, { level: 6 }))).equals(Buffer.from(data))).toBe(true);
    });
});
