import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
    createV2ArrayFieldWriter, writeV2Backup, assembleV2Backup, shardFileName,
    BACKUP_FORMAT_VERSION, type BackupManifest, type ShardLimits,
} from './backupFormat';

// 這組用例鎖住 v2 分片格式的「寫 → 讀」往返與各檔校驗。核心契約：
//   導入端拼出的 data 必須與導出端喂進去的 backupData 逐字段一致（數組照舊、非數組照舊），
//   這樣它餵給原封不動的 importFullData 時，還原行為就和 v1 完全一樣。
// 失敗檔（缺片 / 條數不符 / 版本不符 / 非數組 / 單條超大）必須在「拼數據之前/導出中途」
// 乾淨報錯，絕不退回 RangeError、絕不靜默少數據。

// 內存假 zip：同時實現 ZipFileWriter / ZipFileReader，支持文本與二進制（Uint8Array）。
class FakeFile {
    constructor(private content: string | Uint8Array) {}
    async(type: 'string'): Promise<string>;
    async(type: 'uint8array'): Promise<Uint8Array>;
    async(type: 'string' | 'uint8array'): Promise<string | Uint8Array> {
        if (type === 'uint8array') {
            return Promise.resolve(this.content instanceof Uint8Array ? this.content : new TextEncoder().encode(String(this.content)));
        }
        return Promise.resolve(typeof this.content === 'string' ? this.content : new TextDecoder().decode(this.content));
    }
}
class FakeZip {
    files = new Map<string, string | Uint8Array>();
    fileOptions = new Map<string, {
        base64?: boolean;
        compression?: 'STORE' | 'DEFLATE';
        compressionOptions?: { level?: number };
    } | undefined>();
    file(name: string): FakeFile | null;
    file(name: string, data: string | Uint8Array, options?: {
        base64?: boolean;
        compression?: 'STORE' | 'DEFLATE';
        compressionOptions?: { level?: number };
    }): void;
    file(
        name: string,
        data?: string | Uint8Array,
        options?: {
            base64?: boolean;
            compression?: 'STORE' | 'DEFLATE';
            compressionOptions?: { level?: number };
        },
    ): FakeFile | null | void {
        if (data === undefined) {
            if (!this.files.has(name)) return null;
            return new FakeFile(this.files.get(name)!);
        }
        this.files.set(name, data);
        this.fileOptions.set(name, options);
    }
}

const sampleBackup = () => ({
    // 非數組字段 → metadata.json
    timestamp: 123,
    version: 3,
    theme: { name: 'dark', wallpaper: 'assets/asset_1.png' },
    userProfile: { name: '小明', avatar: 'assets/asset_2.png' },
    lifeSimState: null,                 // 單例空 → null，仍要原樣帶回（v1 語義：清目標）
    apiConfig: undefined,               // undefined 字段 → JSON 丟棄，導入端拿不到（與 v1 一致）
    // 數組字段 → 分片
    messages: [{ id: 1, t: 'a' }, { id: 2, t: 'b' }, { id: 3, t: 'c' }],
    galleryImages: [],                  // 空數組 → count 0、parts 0，導入端必須拼回 []
    memoryNodes: [{ id: 'n1' }],
});

describe('backupFormat v2 往返', () => {
    it('寫 → 讀：每個字段與原 backupData 逐字段一致（數組照舊、非數組照舊）', async () => {
        const zip = new FakeZip();
        const src = sampleBackup();
        const manifest = await writeV2Backup(zip, { ...src, messages: [...src.messages], galleryImages: [], memoryNodes: [...src.memoryNodes] }, { mode: 'full', createdAt: 999, assetCount: 2 });

        expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);
        expect(manifest.mode).toBe('full');
        expect(manifest.assetCount).toBe(2);
        // 數組字段都進了 manifest.stores（含空數組 count 0）
        expect(manifest.stores.messages).toEqual({ parts: 1, count: 3 });
        expect(manifest.stores.galleryImages).toEqual({ parts: 0, count: 0 });
        expect(manifest.stores.memoryNodes).toEqual({ parts: 1, count: 1 });
        // 非數組字段不進 stores
        expect(manifest.stores.theme).toBeUndefined();
        expect(manifest.stores.userProfile).toBeUndefined();

        const data = await assembleV2Backup(zip, manifest);
        expect(data.messages).toEqual(src.messages);
        expect(data.galleryImages).toEqual([]);              // 空數組拼回 []，不是 undefined
        expect(data.memoryNodes).toEqual(src.memoryNodes);
        expect(data.theme).toEqual(src.theme);
        expect(data.userProfile).toEqual(src.userProfile);
        expect(data.lifeSimState).toBe(null);                // null 原樣帶回
        expect('apiConfig' in data).toBe(false);             // undefined 字段被 JSON 丟棄，導入端沒有
        expect(data.timestamp).toBe(123);
    });

    it('大數組按 maxItems 分多片，拼回順序不亂、不漏不重', async () => {
        const zip = new FakeZip();
        const messages = Array.from({ length: 23 }, (_, i) => ({ id: i, body: `m${i}` }));
        const limits: ShardLimits = { maxLen: 1 << 30, maxItems: 5, hardMaxLen: 1 << 30 };
        const manifest = await writeV2Backup(zip, { messages: [...messages] }, { limits });

        expect(manifest.stores.messages.parts).toBe(5); // 23/5 → 5 片（5,5,5,5,3）
        expect(manifest.stores.messages.count).toBe(23);
        // 每片文件都在
        for (let p = 0; p < 5; p++) expect(zip.files.has(shardFileName('messages', p))).toBe(true);

        const data = await assembleV2Backup(zip, manifest);
        expect(data.messages).toEqual(messages); // 順序 + 內容完全一致
    });

    it('游標批次可增量寫入同一字段，收尾 manifest 能完整往返且無需整表數組', async () => {
        const zip = new FakeZip();
        const limits: ShardLimits = { maxLen: 1 << 30, maxItems: 3, hardMaxLen: 1 << 30 };
        const writer = createV2ArrayFieldWriter(zip, 'messages', { limits });
        await writer.append([{ id: 1 }, { id: 2 }]);
        await writer.append([{ id: 3 }, undefined, { id: 4 }]);
        await writer.append([{ id: 5 }]);
        const messagesMeta = await writer.finish();

        expect(messagesMeta).toEqual({ parts: 2, count: 5 });
        const manifest = await writeV2Backup(
            zip,
            { timestamp: 123, theme: { name: 'low-memory' } },
            { prewrittenStores: { messages: messagesMeta } },
        );
        const data = await assembleV2Backup(zip, manifest);
        expect(data.messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
        expect(data.theme).toEqual({ name: 'low-memory' });
    });

    it('同一字段不能同時走增量寫入與普通數組寫入，避免重複分片', async () => {
        const zip = new FakeZip();
        const writer = createV2ArrayFieldWriter(zip, 'messages');
        await writer.append([{ id: 1 }]);
        const messagesMeta = await writer.finish();

        await expect(writeV2Backup(
            zip,
            { messages: [{ id: 2 }] },
            { prewrittenStores: { messages: messagesMeta } },
        )).rejects.toThrow(/同[时時]走了增量[写寫]入和普通[写寫]入/);
    });

    it('單條超軟上限：該條獨佔一片（Finding 5），仍能完整往返', async () => {
        const zip = new FakeZip();
        const big = { id: 'big', blob: 'x'.repeat(2000) };
        const items = [{ id: 'a' }, big, { id: 'c' }];
        // maxLen 設 1000：big 條 ~2000 長度，獨佔一片；前後小條各自成片
        const limits: ShardLimits = { maxLen: 1000, maxItems: 9999, hardMaxLen: 1 << 30 };
        const manifest = await writeV2Backup(zip, { messages: items }, { limits });
        const data = await assembleV2Backup(zip, manifest);
        expect(data.messages).toEqual(items);
        expect(manifest.stores.messages.count).toBe(3);
        expect(manifest.stores.messages.parts).toBeGreaterThanOrEqual(2);
    });

    it('數組含 undefined 空洞：count 記實際寫入數，不讓被跳過的空洞觸發條數誤判 abort（G1）', async () => {
        const zip = new FakeZip();
        // JSON.stringify(undefined) === undefined，導出時該元素被跳過
        const arr = [{ id: 1 }, undefined, { id: 3 }];
        const manifest = await writeV2Backup(zip, { messages: arr }, {});
        // count 必須是「實際寫入的 2 條」而非 arr.length(3)，否則導入端條數自洽校驗會誤判損壞
        expect(manifest.stores.messages.count).toBe(2);
        const data = await assembleV2Backup(zip, manifest); // 舊寫法（count=3）會在這裡拋 count-mismatch
        expect(data.messages).toEqual([{ id: 1 }, { id: 3 }]);
    });

    it('單條超硬上限：乾淨報錯中止，不退回 RangeError', async () => {
        const zip = new FakeZip();
        const limits: ShardLimits = { maxLen: 100, maxItems: 10, hardMaxLen: 500 };
        await expect(
            writeV2Backup(zip, { messages: [{ id: 'x', blob: 'y'.repeat(1000) }] }, { limits })
        ).rejects.toThrow(/[单單][条條][记記][录錄][过過]大/);
        // 沒寫出 manifest（中途拋錯）
        expect(zip.files.has('manifest.json')).toBe(false);
    });
});

describe('backupFormat v2 校驗檔（寫庫前 abort，DB 未動）', () => {
    it('缺分片文件 → abort', async () => {
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { messages: [{ id: 1 }, { id: 2 }] }, {});
        zip.files.delete(shardFileName('messages', 0)); // 人為刪掉一片
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/[没沒]有|找不到|中止[导導]入/);
    });

    it('條數與 manifest 不符 → abort', async () => {
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { messages: [{ id: 1 }, { id: 2 }] }, {});
        const tampered: BackupManifest = { ...manifest, stores: { ...manifest.stores, messages: { parts: 1, count: 99 } } };
        await expect(assembleV2Backup(zip, tampered)).rejects.toThrow(/[对對]不上|中止[导導]入/);
    });

    it('formatVersion 不在支持清單（如未來 v4）→ abort，不拿現有 parser 硬解', async () => {
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { messages: [{ id: 1 }] }, {});
        const v4: BackupManifest = { ...manifest, formatVersion: 4 };
        await expect(assembleV2Backup(zip, v4)).rejects.toThrow(/不支持的[备備]份格式版本/);
    });

    it('formatVersion 2 的老包仍可組裝（迴歸守衛：升 v3 不棄 v2）', async () => {
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { messages: [{ id: 1, t: 'a' }] }, {});
        const v2: BackupManifest = { ...manifest, formatVersion: 2 };
        const data = await assembleV2Backup(zip, v2);
        expect(data.messages).toEqual([{ id: 1, t: 'a' }]);
    });

    it('onSerialized 鉤子看到每條分片記錄與 metadata 的落包文本', async () => {
        const zip = new FakeZip();
        const seen: string[] = [];
        await writeV2Backup(
            zip,
            { theme: { wallpaper: 'blobref:b_meta' }, messages: [{ id: 1, img: 'blobref:b_item' }, { id: 2 }] },
            { onSerialized: s => seen.push(s) },
        );
        // 兩條 messages 記錄 + 一段 metadata，逐段可見（v3 blob 旁路靠它收集令牌）
        expect(seen.some(s => s.includes('blobref:b_item'))).toBe(true);
        expect(seen.some(s => s.includes('blobref:b_meta'))).toBe(true);
        expect(seen.filter(s => s.startsWith('{"id"')).length).toBe(2);
    });

    it('分片內容不是數組 → abort', async () => {
        const zip = new FakeZip();
        zip.file('metadata.json', '{}');
        zip.file(shardFileName('messages', 0), '{"not":"an array"}');
        const manifest: BackupManifest = { formatVersion: 2, stores: { messages: { parts: 1, count: 1 } } };
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/不是[数數][组組]/);
    });

    it('缺 metadata.json → abort', async () => {
        const zip = new FakeZip();
        const manifest: BackupManifest = { formatVersion: 2, stores: {} };
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/metadata\.json/);
    });
});

// 向量二進制旁路：構造 Float32 字節拼成的 bin + 索引，餵給 writeV2Backup 的 vectors 選項。
function makeVectorPayload(vecs: Array<{ memoryId: string; charId: string; values: number[]; model?: string }>) {
    const index: any[] = [];
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (const v of vecs) {
        const f32 = new Float32Array(v.values);
        const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
        parts.push(bytes);
        index.push({ memoryId: v.memoryId, charId: v.charId, dimensions: f32.length, model: v.model, byteOffset: offset, byteLength: bytes.byteLength });
        offset += bytes.byteLength;
    }
    const bin = new Uint8Array(offset);
    let p = 0;
    for (const part of parts) { bin.set(part, p); p += part.byteLength; }
    return { bin, index };
}

describe('backupFormat v2 向量二進制旁路', () => {
    it('向量寫 bin → 讀回：逐值一致、維度保留、每條 vector 是獨立 buffer 的 Uint8Array', async () => {
        const zip = new FakeZip();
        const payload = makeVectorPayload([
            { memoryId: 'm1', charId: 'c1', values: [0.1, 0.2, 0.3, 0.4], model: 'embed-test' },
            { memoryId: 'm2', charId: 'c1', values: [1, 2, 3, 4] },
            { memoryId: 'm3', charId: 'c2', values: [-0.5, 0.5, -0.25, 0.25] },
        ]);
        const manifest = await writeV2Backup(zip, { memoryNodes: [{ id: 'm1' }] }, { vectors: payload });
        expect(manifest.vectors).toEqual({ count: 3, byteLength: 3 * 4 * 4 });
        expect(zip.fileOptions.get('stores/memory_vectors.bin')).toMatchObject({ compression: 'STORE' });
        // 向量不進 stores（走旁路）
        expect(manifest.stores.memoryVectors).toBeUndefined();

        const data = await assembleV2Backup(zip, manifest);
        expect(data.memoryVectors).toHaveLength(3);
        const v1 = data.memoryVectors[0];
        expect(v1.memoryId).toBe('m1');
        expect(v1.charId).toBe('c1');
        expect(v1.model).toBe('embed-test');
        expect(v1.dimensions).toBe(4);
        // vector 是 Uint8Array，且 buffer 緊貼自己的 byteLength（證明是 slice 獨立 buffer，不是整 bin 的 subarray 視圖）
        expect(v1.vector).toBeInstanceOf(Uint8Array);
        expect(v1.vector.byteLength).toBe(16);
        expect(v1.vector.buffer.byteLength).toBe(16);
        // 逐值還原
        const back = new Float32Array(v1.vector.buffer, v1.vector.byteOffset, v1.vector.byteLength >>> 2);
        expect(Array.from(back)).toEqual([
            expect.closeTo(0.1, 6), expect.closeTo(0.2, 6), expect.closeTo(0.3, 6), expect.closeTo(0.4, 6),
        ]);
        // 第二條整數值精確
        const back2 = new Float32Array(data.memoryVectors[1].vector.buffer, data.memoryVectors[1].vector.byteOffset, 4);
        expect(Array.from(back2)).toEqual([1, 2, 3, 4]);
    });

    it('向量 byteLength 與維度對不上 → abort', async () => {
        const zip = new FakeZip();
        const payload = makeVectorPayload([{ memoryId: 'm1', charId: 'c1', values: [1, 2, 3, 4] }]);
        payload.index[0].dimensions = 5; // 謊稱 5 維但只有 16 字節（4 維）
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/[维維]度[对對]不上|中止[导導]入/);
    });

    it('向量條數與 manifest 不符 → abort', async () => {
        const zip = new FakeZip();
        const payload = makeVectorPayload([{ memoryId: 'm1', charId: 'c1', values: [1, 2, 3, 4] }]);
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        const tampered: BackupManifest = { ...manifest, vectors: { count: 99, byteLength: manifest.vectors!.byteLength } };
        await expect(assembleV2Backup(zip, tampered)).rejects.toThrow(/向量[条條][数數].*不符|中止[导導]入/);
    });

    it('向量 bin 字節數與 manifest 不符 → abort', async () => {
        const zip = new FakeZip();
        const payload = makeVectorPayload([{ memoryId: 'm1', charId: 'c1', values: [1, 2, 3, 4] }]);
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        const tampered: BackupManifest = { ...manifest, vectors: { count: 1, byteLength: 9999 } };
        await expect(assembleV2Backup(zip, tampered)).rejects.toThrow(/bin 字[节節][数數].*不符|中止[导導]入/);
    });

    it('聲明了向量但缺 bin 文件 → abort', async () => {
        const zip = new FakeZip();
        const payload = makeVectorPayload([{ memoryId: 'm1', charId: 'c1', values: [1, 2, 3, 4] }]);
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        zip.files.delete('stores/memory_vectors.bin');
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/缺 index\/bin|中止[导導]入/);
    });

    // codex 二審 finding：壞 byteOffset 會被 slice 鉗制成空/截斷字節、組裝卻照樣過 → 寫庫前必須擋住
    it('向量 byteOffset 越過 bin 末尾 → abort（不被 slice 靜默鉗制）', async () => {
        const zip = new FakeZip();
        const payload = makeVectorPayload([
            { memoryId: 'm1', charId: 'c1', values: [1, 2, 3, 4] },
            { memoryId: 'm2', charId: 'c1', values: [5, 6, 7, 8] },
        ]);
        payload.index[1].byteOffset = payload.bin.byteLength; // 指到 bin 末尾之外
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/越[过過] bin 末尾|中止[导導]入/);
    });

    it('向量 byteOffset 為負數 → abort', async () => {
        const zip = new FakeZip();
        const payload = makeVectorPayload([{ memoryId: 'm1', charId: 'c1', values: [1, 2, 3, 4] }]);
        payload.index[0].byteOffset = -4;
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/偏移\/[长長]度\/[维維]度非法|中止[导導]入/);
    });
});

// FakeZip 只驗邏輯，驗不到真 JSZip 的二進制編碼 + generateAsync/loadAsync 實際行為。
// 這條用真 JSZip 跑完整往返，釘死「bin 直寫 Uint8Array、讀回 async('uint8array') 字節無損」。
describe('backupFormat v2 真實 JSZip 二進制往返', () => {
    it('真 JSZip：寫 bin + 分片 + metadata → generateAsync → loadAsync → 讀 manifest → 完整還原', async () => {
        const zip = new JSZip();
        const payload = makeVectorPayload([
            { memoryId: 'm1', charId: 'c1', values: [0.1, 0.2, 0.3, 0.4], model: 'e' },
            { memoryId: 'm2', charId: 'c2', values: [1, 2, 3, 4] },
        ]);
        await writeV2Backup(zip as any, {
            messages: [{ id: 1, t: 'a' }, { id: 2, t: 'b' }],
            theme: { name: 'dark' },
        }, { vectors: payload, mode: 'full' });

        // 真正打包成字節，再原樣解回來（模擬落盤 → 重新導入）
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        const loaded = await JSZip.loadAsync(bytes);
        // manifest 從 zip 裡讀（不是用內存裡的），走和導入端一模一樣的路徑
        const manifest = JSON.parse(await loaded.file('manifest.json')!.async('string'));
        const data = await assembleV2Backup(loaded as any, manifest);

        expect(data.messages).toEqual([{ id: 1, t: 'a' }, { id: 2, t: 'b' }]);
        expect(data.theme).toEqual({ name: 'dark' });
        expect(data.memoryVectors).toHaveLength(2);
        expect(data.memoryVectors[0].vector).toBeInstanceOf(Uint8Array);
        expect(data.memoryVectors[0].vector.byteLength).toBe(16);
        const back = new Float32Array(data.memoryVectors[0].vector.buffer, data.memoryVectors[0].vector.byteOffset, 4);
        expect(Array.from(back)).toEqual([
            expect.closeTo(0.1, 6), expect.closeTo(0.2, 6), expect.closeTo(0.3, 6), expect.closeTo(0.4, 6),
        ]);
        const back2 = new Float32Array(data.memoryVectors[1].vector.buffer, data.memoryVectors[1].vector.byteOffset, 4);
        expect(Array.from(back2)).toEqual([1, 2, 3, 4]);
    });
});
