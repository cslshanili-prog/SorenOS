import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { deflateSync } from 'fflate';
import { assembleV2Backup, createV2ArrayFieldWriter, writeV2Backup, type BackupManifest, type ZipFileReader, type ZipFileWriter } from '../backupFormat';
import { BLOBS_INDEX_FILE, collectBlobRefs, readBlobsIndex, writeBlobsToZip } from '../backupBlobs';
import { externalizeVoiceMessageBlobs } from '../voiceMessageBackup';
import { createJSZipWriter, createZipStreamWriter, type ZipStreamWriter } from './writer';

// 新舊對照（plans/backup-streaming.md 第 6 節）：同一份資料，舊容器（JSZip 全部登記、最後一次生成）
// 和新容器（串流寫入器）各打一包，還原那邊組回來的東西必須一模一樣。備份檔的格式沒有變，
// 變的只是「怎麼打包」。

const deflate = (data: Uint8Array, options: { level: number }) => deflateSync(data, { level: options.level as any });
const SMALL = { maxLen: 4 * 1024 * 1024, maxItems: 500, hardMaxLen: 256 * 1024 * 1024 };

const makeData = () => ({
    timestamp: 1764000000000,
    version: 3,
    theme: { wallpaper: 'blobref:wall_1', accent: '#b5622a' },
    userProfile: { name: '柔', avatar: 'assets/asset_1.png' },
    characters: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, name: `角色${i}`, avatar: `blobref:avatar_${i}`, systemPrompt: '人設'.repeat(400) })),
    messages: Array.from({ length: 2600 }, (_, i) => ({ id: i + 1, charId: `c${i % 30}`, role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 則：${'今天天氣很好。'.repeat(20)}` })),
    galleryImages: Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, charId: 'c0', src: `blobref:img_${i}` })),
    emptyStore: [] as unknown[],
    mediaAssets: [] as unknown[],
});

const blobFor = (token: string): Blob => {
    const seed = Array.from(token).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const bytes = new Uint8Array(4000 + (seed % 3000));
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + seed) & 0xFF;
    return new Blob([bytes], { type: 'image/png' });
};

/** 照 exportSystem 的順序寫：分批寫的表 → 其餘＋manifest → 圖片 → 語音 */
const pack = async (zip: ZipStreamWriter): Promise<Uint8Array> => {
    const data = makeData();
    const tokens = new Set<string>();
    const collect = (json: string) => collectBlobRefs(json, tokens);
    const writer = zip as unknown as ZipFileWriter;

    // 圖多的表分批寫（這裡拿 messages 當代表，20 筆一批）
    const field = createV2ArrayFieldWriter(writer, 'messages', { limits: SMALL, onSerialized: collect });
    for (let i = 0; i < data.messages.length; i += 20) {
        await field.append(data.messages.slice(i, i + 20));
        await zip.drain();
    }
    const prewritten = { messages: await field.finish() };
    const { messages: _streamed, ...rest } = data;

    const vectors = {
        bin: new Uint8Array(1024 * 4 * 3).map((_, i) => (i * 5) & 0xFF),
        index: [0, 1, 2].map(i => ({ memoryId: `m${i}`, charId: 'c0', dimensions: 1024, byteOffset: i * 4096, byteLength: 4096 })),
    };
    await writeV2Backup(writer, rest as Record<string, any>, {
        mode: 'full', createdAt: 1764000000000, assetCount: 1, vectors, prewrittenStores: prewritten, limits: SMALL, onSerialized: collect,
    });

    zip.file('assets/asset_1.png', Buffer.from([1, 2, 3, 4, 5]).toString('base64'), { base64: true, compression: 'STORE' });
    await writeBlobsToZip(writer, tokens, async token => blobFor(token), { onYield: () => zip.drain() });

    const assets = [{ id: 'voice_fav_1', data: { favorite: true, blob: new Blob([new Uint8Array([9, 9, 9, 9])], { type: 'audio/mpeg' }) } }];
    await externalizeVoiceMessageBlobs(assets, (path, bytes) => { zip.file(path, bytes, { compression: 'STORE' }); }, 40);

    return new Uint8Array(await (await zip.finish()).arrayBuffer());
};

const filesOf = (zip: JSZip) => Object.values(zip.files).filter(f => !f.dir).map(f => f.name).sort();

describe('新舊容器打出來的包，還原那邊看到的一模一樣', () => {
    it('檔名一樣、每個檔的內容逐位元組一樣、組回來的資料深度相等', async () => {
        const streamBytes = await pack(createZipStreamWriter({ deflate }));
        const legacyBytes = await pack(createJSZipWriter(new JSZip() as any));
        const a = await JSZip.loadAsync(streamBytes, { checkCRC32: true });
        const b = await JSZip.loadAsync(legacyBytes, { checkCRC32: true });

        expect(filesOf(a)).toEqual(filesOf(b));
        expect(filesOf(a)).toContain(BLOBS_INDEX_FILE);
        expect(filesOf(a).filter(n => n.startsWith('blobs/')).length).toBe(1 + 30 + 12 + 1); // 索引＋頭像＋相簿＋桌布
        expect(filesOf(a).filter(n => n.startsWith('stores/messages.')).length).toBeGreaterThan(1);
        for (const name of filesOf(a)) {
            const left = Buffer.from(await a.file(name)!.async('uint8array'));
            const right = Buffer.from(await b.file(name)!.async('uint8array'));
            expect(left.equals(right), name).toBe(true);
        }

        const manifestA = JSON.parse(await a.file('manifest.json')!.async('string')) as BackupManifest;
        const manifestB = JSON.parse(await b.file('manifest.json')!.async('string')) as BackupManifest;
        expect(manifestA).toEqual(manifestB);
        expect(manifestA.formatVersion).toBe(3);
        expect(manifestA.stores.messages.count).toBe(2600);
        expect(manifestA.stores.emptyStore).toEqual({ parts: 0, count: 0 });

        const dataA = await assembleV2Backup(a as unknown as ZipFileReader, manifestA);
        const dataB = await assembleV2Backup(b as unknown as ZipFileReader, manifestB);
        expect(dataA).toEqual(dataB);
        expect(dataA.messages).toHaveLength(2600);
        expect(dataA.messages[2599].content).toContain('第 2599 則');
        expect(dataA.memoryVectors).toHaveLength(3);

        expect(await readBlobsIndex(a as unknown as ZipFileReader)).toEqual(await readBlobsIndex(b as unknown as ZipFileReader));
    });

    it('新容器打的包比舊的沒有大多少（文字有壓、圖片照原樣）', async () => {
        const streamBytes = await pack(createZipStreamWriter({ deflate }));
        const legacyBytes = await pack(createJSZipWriter(new JSZip() as any, { level: 9 }));
        expect(streamBytes.byteLength).toBeLessThan(legacyBytes.byteLength * 1.1);
    });
});
