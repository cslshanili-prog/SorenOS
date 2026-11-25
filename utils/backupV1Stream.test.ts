import { describe, expect, it, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { Inflate, inflateSync } from 'fflate';
import { DB, openDB } from './db';
import { assembleV1Stream, blobChunks } from './backupV1Stream';
import { isLazyShardArray, LAZY_IMPORT_FIELDS } from './backupFormat';
import { createMemorySink, type ZipSink } from './zipStream/writer';
import { openZipReader, type InflateStream } from './zipStream/reader';

// 第 3c 批（plans/backup-streaming.md）：早期備份那一整根 data.json 邊讀邊組。
// 釘住：組出來的東西跟整根 JSON.parse 一樣；大的表不進記憶體；壞掉的檔在寫庫之前就擋下。

const inflate = (data: Uint8Array, size: number) => inflateSync(data, { out: new Uint8Array(size) });
const createInflateStream = (): InflateStream => {
    let out: Uint8Array[] = [];
    const inflater = new Inflate(chunk => { out.push(chunk); });
    return { push(data, final) { out = []; inflater.push(data, final); return out; } };
};

async function* bytesInChunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, Math.min(bytes.length, at + size));
}

const v1Data = () => ({
    timestamp: 1700000000000,
    version: 2,
    theme: { wallpaper: 'assets/wall.png', name: '預設 "主題"' },
    userProfile: { name: '柔', avatar: 'assets/me.png' },
    characters: [{ id: 'c1', name: '甲', avatar: 'assets/c1.png' }, { id: 'c2', name: '乙' }],
    messages: Array.from({ length: 137 }, (_, i) => ({ id: i + 1, charId: i % 2 ? 'c1' : 'c2', role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 則：今天天氣很好 😀 "引號" \\ 反斜線` })),
    galleryImages: Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, charId: 'c1', src: `assets/g${i}.png` })),
    diaries: [],
    tasks: [{ id: 't1', title: '任務' }],
});

const loadAll = async (lazy: any): Promise<any[]> => {
    const rows: any[] = [];
    for (let i = 0; i < lazy.parts; i++) rows.push(...await lazy.loadPart(i));
    return rows;
};

const assemble = (bytes: Uint8Array, chunkSize: number, extra: Partial<Parameters<typeof assembleV1Stream>[1]> = {}) =>
    assembleV1Stream(bytesInChunks(bytes, chunkSize), { lazyFields: LAZY_IMPORT_FIELDS, createSpill: () => createMemorySink('application/json'), maxItems: 20, ...extra });

describe('早期備份邊讀邊組', () => {
    it('組出來的跟整根 JSON.parse 一樣；大的表是一片一片的來源，讀回來逐筆相同', async () => {
        const source = v1Data();
        const bytes = new TextEncoder().encode(JSON.stringify(source));
        for (const chunkSize of [1, 3, 7, 1000, bytes.length]) {
            const data = await assemble(bytes, chunkSize);
            expect(data.timestamp).toBe(source.timestamp);
            expect(data.theme).toEqual(source.theme);
            expect(data.userProfile).toEqual(source.userProfile);
            // 要跟現有資料合併的表照舊是真的陣列
            expect(data.characters).toEqual(source.characters);
            expect(data.tasks).toEqual(source.tasks);
            expect(isLazyShardArray(data.messages)).toBe(true);
            expect(data.messages.length).toBe(137);
            expect(data.messages.parts).toBe(7); // 137 筆、一片 20 筆
            expect(await loadAll(data.messages)).toEqual(source.messages);
            expect(await loadAll(data.galleryImages)).toEqual(source.galleryImages);
            // 空的大表就是空陣列
            expect(data.diaries).toEqual([]);
        }
    });

    it('縮排過的 JSON、一片的字數上限也照樣', async () => {
        const source = v1Data();
        const bytes = new TextEncoder().encode(JSON.stringify(source, null, 2));
        const data = await assemble(bytes, 4096, { maxItems: 100_000, maxLen: 2000 });
        expect(data.messages.parts).toBeGreaterThan(5);
        expect(await loadAll(data.messages)).toEqual(source.messages);
    });

    it('沒有大表就不開暫存區', async () => {
        let opened = 0;
        const bytes = new TextEncoder().encode(JSON.stringify({ theme: { a: 1 }, tasks: [{ id: 't' }], messages: [] }));
        const data = await assemble(bytes, 5, { createSpill: () => { opened++; return createMemorySink(); } });
        expect(opened).toBe(0);
        expect(data).toEqual({ theme: { a: 1 }, tasks: [{ id: 't' }], messages: [] });
    });

    it('檔案壞掉（截斷、某一筆內容壞掉、最外層不是物件）：丟錯，暫存區收掉', async () => {
        const good = JSON.stringify(v1Data());
        const cases = [
            good.slice(0, good.length - 50),
            good.replace('"id":40,', '"id":4x,'),
            '[1,2,3]',
        ];
        for (const text of cases) {
            let aborted = 0;
            const sink = createMemorySink();
            const spy: ZipSink = { write: (c, o) => sink.write(c, o), finish: () => sink.finish(), abort: async () => { aborted++; await sink.abort(); } };
            let opened = false;
            await expect(assemble(new TextEncoder().encode(text), 200, { createSpill: () => { opened = true; return spy; } })).rejects.toThrow();
            if (opened) expect(aborted).toBe(1);
        }
    });

    it('blobChunks：把檔案切成一段一段，接起來一樣', async () => {
        const bytes = new Uint8Array(10_000).map((_, i) => i & 0xFF);
        const parts: number[] = [];
        for await (const chunk of blobChunks(new Blob([bytes as BlobPart]), 3000)) parts.push(...chunk);
        expect(parts).toEqual(Array.from(bytes));
    });
});

describe('讀取器分段吐內容', () => {
    it('壓縮的、沒壓縮的條目，分段接起來都跟一次讀的一樣', async () => {
        const zip = new JSZip();
        // 壓不太動的文字（亂數字串），壓完還有 1 MB 以上，會跨好幾個讀取窗
        let seed = 7;
        const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed.toString(36); };
        const text = JSON.stringify({ messages: Array.from({ length: 60_000 }, (_, i) => ({ id: i, content: noise() + noise() + noise() + noise() })) });
        const binary = new Uint8Array(2_500_000).map((_, i) => (i * 11) & 0xFF);
        zip.file('data.json', text);
        zip.file('assets/a.bin', binary, { compression: 'STORE' });
        zip.file('empty.json', '');
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles: true });
        for (const stream of [createInflateStream, undefined]) {
            const reader = await openZipReader(new Blob([bytes as BlobPart]), { inflate, createInflateStream: stream });
            for (const name of ['data.json', 'assets/a.bin', 'empty.json']) {
                const whole = await reader.file(name)!.async('uint8array');
                const parts: Uint8Array[] = [];
                for await (const chunk of reader.file(name)!.chunks()) parts.push(chunk.slice());
                expect(Buffer.concat(parts.map(p => Buffer.from(p))).equals(Buffer.from(whole)), name).toBe(true);
                if (stream && name === 'data.json') expect(parts.length).toBeGreaterThan(1);
            }
        }
    });
});

describe('早期備份整條路：zip → 邊讀邊組 → 寫進資料庫', () => {
    async function seed(name: string, records: any[]) {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).clear();
            for (const record of records) tx.objectStore(name).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    beforeEach(async () => { for (const store of ['gallery', 'messages', 'characters', 'tasks']) await seed(store, []); });

    it('落庫結果跟舊做法（整根 JSON.parse）逐筆一樣', async () => {
        const zip = new JSZip();
        zip.file('data.json', JSON.stringify(v1Data()));
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const readBack = async () => ({
            messages: await DB.getRawStoreData('messages'),
            gallery: await DB.getRawStoreData('gallery'),
            characters: await DB.getRawStoreData('characters'),
        });

        const legacy = await JSZip.loadAsync(bytes);
        await DB.importFullData(JSON.parse(await legacy.file('data.json')!.async('string')));
        const expected = await readBack();
        expect(expected.messages).toHaveLength(137);

        await seed('messages', [{ id: 9999, stale: true }]);
        await seed('gallery', [{ id: 'old', stale: true }]);
        const reader = await openZipReader(new Blob([bytes as BlobPart]), { inflate, createInflateStream });
        const data = await assembleV1Stream(reader.file('data.json')!.chunks(), {
            lazyFields: LAZY_IMPORT_FIELDS, createSpill: () => createMemorySink('application/json'), maxItems: 25,
        });
        expect(isLazyShardArray(data.messages)).toBe(true);
        await DB.importFullData(data as any);
        expect(await readBack()).toEqual(expected);
    });
});
