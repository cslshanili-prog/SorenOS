import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { DB, openDB } from './db';
import { putImageBlob, dataUrlToBlob, getBlobForRef } from './blobRef';
import { collectBlobRefs, writeBlobsToZip, readBlobsIndex, restoreBlobsFromZip, BLOBS_INDEX_FILE } from './backupBlobs';
import { encodeVectorsForBackup, encodeVectorsForBackupChunked, MemoryVectorDB } from './memoryPalace/db';
import { writeV2Backup, assembleV2Backup, shardFileName, type ShardLimits } from './backupFormat';
import { ActiveMsgStore } from './activeMsgStore';

// fake-indexeddb 已通過 test-setup.ts 注入。
// 這組用例走「真實鏈路」：writeV2Backup → assembleV2Backup → DB.importFullData，釘死 v2 改造
// 裡最危險的幾個數據完整性 finding。和 backupFormat.test.ts（純格式往返）不同，這裡驗證的是
// 「拼回的 data 餵給原封不動的 importFullData 後，落庫行為和 v1 一致、且分片不引入丟數據」。

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
    file(name: string): FakeFile | null;
    file(name: string, data: string | Uint8Array, options?: {
        base64?: boolean;
        compression?: 'STORE' | 'DEFLATE';
        compressionOptions?: { level?: number };
    }): void;
    file(name: string, data?: string | Uint8Array): FakeFile | null | void {
        if (data === undefined) {
            if (!this.files.has(name)) return null;
            return new FakeFile(this.files.get(name)!);
        }
        this.files.set(name, data);
    }
}

const SMALL_SHARDS = (maxItems: number): ShardLimits => ({ maxLen: 1 << 30, maxItems, hardMaxLen: 1 << 30 });

async function seedStore(name: string, records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        store.clear();
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    // 清掉本組會斷言/寫入的 store，避免 importFullData 跨用例殘留串味
    for (const s of ['gallery', 'themes', 'user_profile', 'characters', 'messages', 'memory_nodes', 'memory_vectors']) {
        await seedStore(s, []);
    }
});

/** 把存儲形態的向量記錄讀回（vector 是 Uint8Array）解碼成 number[]，逐值比對用 */
function vecValues(v: any): number[] {
    const u8: Uint8Array = v.vector;
    const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >>> 2);
    return Array.from(f32);
}

describe('v2 真實鏈路：分片 → 組裝 → importFullData', () => {
    it('跨分片 clear-and-add：所有片的數據都落庫、不只剩最後一片（Finding 1）', async () => {
        await seedStore('gallery', [{ id: 'old', url: 'old' }]);
        const items = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, url: `u${i}` }));

        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: items }, { limits: SMALL_SHARDS(2) });
        expect(manifest.stores.galleryImages.parts).toBe(3); // 5/2 → 3 片，確保真跨片

        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        const ids = (await DB.getRawStoreData('gallery')).map((g: any) => g.id).sort();
        // 舊 'old' 被 clear、5 條全部還原（老的「逐片喂 importFullData」寫法只會剩最後一片 → 這裡會掛）
        expect(ids).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']);
    });
    it('MCP 配置作為 v2 元數據完整組裝並由全量導入恢復', async () => {
        const mcpLocal = {
            'aetheros.mcp.servers': '[{"id":"srv-test","name":"測試 MCP"}]',
            'aetheros.mcp.useNativeTools': 'false',
        };
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { mcpLocal } as any, {});
        const data: any = await assembleV2Backup(zip, manifest);
        expect(data.mcpLocal).toEqual(mcpLocal);
        localStorage.removeItem('aetheros.mcp.servers');
        localStorage.removeItem('aetheros.mcp.useNativeTools');
        await DB.importFullData(data);
        expect(localStorage.getItem('aetheros.mcp.servers')).toBe(mcpLocal['aetheros.mcp.servers']);
        expect(localStorage.getItem('aetheros.mcp.useNativeTools')).toBe('false');
        localStorage.removeItem('aetheros.mcp.servers');
        localStorage.removeItem('aetheros.mcp.useNativeTools');
    });

    // ─── 主動消息 2.0 的全局配置 ───
    // 它存在獨立的 ActiveMsg 庫裡，不在主庫那份 store 清單內。曾經整份漏在備份外：
    // 同一台設備上恢復看不出問題（那個庫沒被動過），換設備就是 Worker 地址、共享密鑰、
    // 一鍵部署生成的 master key 全丟，主動消息和即時對話得從頭配。
    it('主動消息 2.0 全局配置隨備份往返：Worker 地址與 master key 都回得來', async () => {
        await ActiveMsgStore.saveGlobalConfig({
            userId: 'u-amsg-roundtrip',
            workerUrl: 'https://amsg.example.workers.dev',
            serverToken: 'token-abc',
            masterKey: 'master-key-xyz',
            initializedAt: 1700000000000,
            instantChatEnabled: true,
        });

        const exported = await DB.exportFullData();
        expect(exported.amsg2GlobalConfig?.workerUrl).toBe('https://amsg.example.workers.dev');

        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { ...exported } as any, {});
        const data: any = await assembleV2Backup(zip, manifest);

        // 換設備 / 清了瀏覽器數據：這台機器上什麼都沒配過
        await ActiveMsgStore.saveGlobalConfig({
            userId: '', workerUrl: '', serverToken: undefined,
            masterKey: undefined, initializedAt: undefined, instantChatEnabled: undefined,
        });
        expect((await ActiveMsgStore.getGlobalConfig()).workerUrl).toBe('');

        await DB.importFullData(data);

        const restored = await ActiveMsgStore.getGlobalConfig();
        expect(restored.workerUrl).toBe('https://amsg.example.workers.dev');
        expect(restored.serverToken).toBe('token-abc');
        // master key 一換，之前加密進 D1 的任務就全解不開，而 worker 裡的值讀不回來
        expect(restored.masterKey).toBe('master-key-xyz');
        expect(restored.userId).toBe('u-amsg-roundtrip');
        expect(restored.initializedAt).toBe(1700000000000);
        expect(restored.instantChatEnabled).toBe(true);
    });

    it('instantChatSupported 不隨備份還原：留空等重新探一次，不照抄過期結論', async () => {
        await ActiveMsgStore.saveGlobalConfig({
            workerUrl: 'https://amsg.example.workers.dev',
            instantChatSupported: false, // 備份那會兒那台 Worker 還是舊版
        });
        const exported = await DB.exportFullData();

        // 這台機器上的 Worker 早就更新過了
        await ActiveMsgStore.saveGlobalConfig({ workerUrl: '', instantChatSupported: true });
        await DB.importFullData({ ...exported } as any);

        // 照抄回 false 會把即時對話白擋在門外，直到用戶手動去重開開關
        expect((await ActiveMsgStore.getGlobalConfig()).instantChatSupported).toBeUndefined();
    });

    it('沒配過 Worker 的用戶：備份裡乾脆不出現這一項', async () => {
        await ActiveMsgStore.saveGlobalConfig({ workerUrl: '', masterKey: undefined });
        const exported = await DB.exportFullData();
        expect(exported.amsg2GlobalConfig).toBeUndefined();
    });

    it('media_only 補丁：文字角色字段 + 文字消息存活，只有媒體被更新（R4·F1）', async () => {
        await seedStore('characters', [{ id: 'c1', name: 'Alice', bio: 'text-bio', avatar: 'old-avatar' }]);
        await seedStore('messages', [{ id: 1, charId: 'c1', type: 'text', content: 'hello' }]);

        // media_only 形狀：沒有 characters 字段（關鍵！），只有 mediaAssets + 過濾後的 image 消息
        const backupData = {
            mediaAssets: [{
                charId: 'c1',
                avatar: 'new-avatar',
                companionAvatar: { version: 1, source: 'upload', imageRef: 'blobref:static-companion' },
                companionTouchSettings: {
                    enabledZones: ['head'],
                    reactions: { head: [{ id: 'touch-1', text: '別揉亂啦', performance: { emotion: 'happy', gesture: 'idle' }, voiceAssetId: 'companion-touch-voice:c1:pack:head:0' }] },
                    touchPresets: [{
                        id: 'touch-preset-1',
                        name: '摸頭',
                        enabledZones: ['head'],
                        reactions: { head: [{ id: 'touch-1', text: '別揉亂啦', performance: { emotion: 'happy', gesture: 'idle' }, voiceAssetId: 'companion-touch-voice:c1:pack:head:0' }] },
                        createdAt: 1,
                        updatedAt: 1,
                    }],
                    activeTouchPresetId: 'touch-preset-1',
                },
                backgrounds: {},
            }],
            messages: [
                { id: 2, charId: 'c1', type: 'image', content: 'img' },
                {
                    id: 3,
                    charId: 'c1',
                    role: 'user',
                    type: 'text',
                    content: 'video turn',
                    metadata: { source: 'call', callSessionId: 'call-1', cameraSnapshotExpired: true },
                },
            ],
        };
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, backupData, {});
        const data = await assembleV2Backup(zip, manifest);
        expect('characters' in data).toBe(false); // 沒有 characters → importFullData 走 patch、不破壞性清

        await DB.importFullData(data as any);

        const c1 = (await DB.getRawStoreData('characters')).find((c: any) => c.id === 'c1');
        expect(c1.name).toBe('Alice');        // 文字字段存活
        expect(c1.bio).toBe('text-bio');      // 文字字段存活
        expect(c1.avatar).toBe('new-avatar'); // 媒體被 patch
        expect(c1.companionAvatar).toEqual({ version: 1, source: 'upload', imageRef: 'blobref:static-companion' });
        expect(c1.companionTouchSettings.activeTouchPresetId).toBe('touch-preset-1');
        expect(c1.companionTouchSettings.touchPresets[0].reactions.head[0].voiceAssetId)
            .toBe('companion-touch-voice:c1:pack:head:0');
        // 老文字消息 id1 沒被清，新 image id2 加上（patch/merge，不 clear）
        const msgIds = (await DB.getRawStoreData('messages')).map((m: any) => m.id).sort();
        expect(msgIds).toEqual([1, 2, 3]);
    });

    it('空數組按 shape 還原：clear-and-add 清、merge 不動、單例省略不動（test 9）', async () => {
        await seedStore('gallery', [{ id: 'gold', url: 'x' }]);          // clear-and-add 目標
        await seedStore('themes', [{ id: 'told', name: 'old-theme' }]);  // merge 目標
        await seedStore('user_profile', [{ id: 'me', name: 'OldUser' }]); // 單例目標

        // galleryImages 空數組（clear-and-add → 清）、customThemes 空數組（merge → 不動）、
        // 不含 userProfile（單例省略 → 不動）
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: [], customThemes: [] }, {});
        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        expect(await DB.getRawStoreData('gallery')).toEqual([]);                                    // 被清
        expect((await DB.getRawStoreData('themes')).map((t: any) => t.id)).toEqual(['told']);       // merge 空 → 保留
        expect((await DB.getRawStoreData('user_profile')).map((u: any) => u.name)).toEqual(['OldUser']); // 省略 → 保留
    });

    it('聊天裝扮隨備份走：角色 chatFineTune 與主題微調字段 v2 往返不丟', async () => {
        // 收官迴歸釘子：全局微調（OSTheme 七字段 + 表情包大小）走 metadata.json 的 theme 整包，
        // 角色級覆蓋（char.chatFineTune）隨 characters store 整對象 clear-and-add——兩頭都不許丟。
        const char = {
            id: 'ft1', name: '小調', avatar: '',
            chatFineTune: { enabled: true, chatBubbleFontSize: 15, chatAvatarVisibility: 'hide_ai' },
        };
        const theme = { chatAvatarVisibility: 'hide_both', chatSnapToEdge: true, chatBubbleLineHeight: 1.5, chatEmojiSize: 'large' };
        // 分角色聊天頭像（URL 形態）隨 user_profile 單例走；data: 形態在 full/media 模式
        // 走 assets 抽取回填（restoreAssetsInPlace），text_only 剝掉——與整體頭像同規則。
        const userProfile = { name: 'me', avatar: 'https://img.example/me.png', bio: '', perCharAvatars: { ft1: 'https://img.example/me-ft1.png' } };

        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { characters: [char], theme, userProfile } as any, {});
        const data: any = await assembleV2Backup(zip, manifest);

        // theme 是非數組字段 → 原樣拼回（導入端 OSContext 直接拿它 updateTheme）
        expect(data.theme).toEqual(theme);

        await DB.importFullData(data);
        const restored = (await DB.getRawStoreData('characters')).find((c: any) => c.id === 'ft1');
        expect(restored.chatFineTune).toEqual(char.chatFineTune);
        const profile = (await DB.getRawStoreData('user_profile'))[0];
        expect(profile.perCharAvatars).toEqual(userProfile.perCharAvatars);
    });

    it('AI 原文範圍設置隨角色備份完整往返', async () => {
        const char = {
            id: 'ctx1',
            name: '上下文角色',
            avatar: '',
            description: '',
            systemPrompt: '',
            memories: [],
            contextRangePolicyVersion: 1,
            contextRangeMode: 'manual',
            contextLimit: 1200,
            contextUserStartMessageId: 345,
            memoryPalaceWaterline: {
                preset: 'custom',
                hotZoneSize: 80,
                bufferThreshold: 30,
            },
        };
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { characters: [char] } as any, {});
        const data = await assembleV2Backup(zip, manifest);

        await DB.importFullData(data as any);

        const restored = (await DB.getRawStoreData('characters')).find((c: any) => c.id === 'ctx1');
        expect(restored).toMatchObject({
            contextRangePolicyVersion: 1,
            contextRangeMode: 'manual',
            contextLimit: 1200,
            contextUserStartMessageId: 345,
            memoryPalaceWaterline: {
                preset: 'custom',
                hotZoneSize: 80,
                bufferThreshold: 30,
            },
        });
    });

    it('不支持的 formatVersion（如未來 v4）在組裝階段 abort，DB 未發生任何寫（test 12）', async () => {
        await seedStore('gallery', [{ id: 'keep', url: 'x' }]);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: [{ id: 'new' }] }, {});
        const v4 = { ...manifest, formatVersion: 4 };
        await expect(assembleV2Backup(zip, v4)).rejects.toThrow(/不支持的[备備]份格式版本/);
        // 從沒調用 importFullData → gallery 原樣
        expect((await DB.getRawStoreData('gallery')).map((g: any) => g.id)).toEqual(['keep']);
    });

    it('缺分片在組裝階段 abort，DB 未發生任何寫（test 8）', async () => {
        await seedStore('gallery', [{ id: 'keep', url: 'x' }]);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { galleryImages: [{ id: 'a' }, { id: 'b' }] }, { limits: SMALL_SHARDS(1) });
        zip.files.delete(shardFileName('galleryImages', 1)); // 刪掉第二片
        await expect(assembleV2Backup(zip, manifest)).rejects.toThrow(/中止[导導]入/);
        expect((await DB.getRawStoreData('gallery')).map((g: any) => g.id)).toEqual(['keep']);
    });
});

const LARGE_VECTOR_COUNT = 4500;
const LARGE_VECTOR_DIMENSIONS = 1024;

function largeVectorMeta(row: number) {
    return {
        memoryId: `memory_${row}`,
        charId: `char_${row % 3}`,
        dimensions: LARGE_VECTOR_DIMENSIONS,
        model: row % 2 === 0 ? 'BAAI/bge-m3' : 'Pro/BAAI/bge-m3',
    };
}

function makeLargeVector(row: number): Float32Array {
    const vector = new Float32Array(LARGE_VECTOR_DIMENSIONS);
    for (let d = 0; d < vector.length; d++) {
        vector[d] = (((row * 31 + d * 17) % 1009) - 504) / 504;
    }
    return vector;
}

function updateVectorDigest(
    hash: ReturnType<typeof createHash>,
    meta: ReturnType<typeof largeVectorMeta>,
    bytes: Uint8Array,
) {
    hash.update(`${meta.memoryId}\0${meta.charId}\0${meta.dimensions}\0${meta.model}\0`);
    hash.update(bytes);
}

function numericMemoryOrder(a: { memoryId: string }, b: { memoryId: string }) {
    return Number(a.memoryId.slice('memory_'.length)) - Number(b.memoryId.slice('memory_'.length));
}

async function seedLargeVectorLibrary(): Promise<string> {
    const expected = createHash('sha256');
    const db = await openDB();
    const CHUNK_SIZE = 25;
    for (let start = 0; start < LARGE_VECTOR_COUNT; start += CHUNK_SIZE) {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['memory_nodes', 'memory_vectors'], 'readwrite');
            const nodeStore = tx.objectStore('memory_nodes');
            const vectorStore = tx.objectStore('memory_vectors');
            const end = Math.min(start + CHUNK_SIZE, LARGE_VECTOR_COUNT);
            for (let row = start; row < end; row++) {
                const meta = largeVectorMeta(row);
                const f32 = makeLargeVector(row);
                const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
                updateVectorDigest(expected, meta, bytes);
                nodeStore.put({
                    id: meta.memoryId,
                    charId: meta.charId,
                    content: `第 ${row} 條記憶`,
                    room: 'living_room',
                    tags: [],
                    importance: 5,
                    embedded: true,
                    createdAt: row,
                    lastAccessedAt: row,
                    accessCount: 0,
                });
                vectorStore.put({
                    ...meta,
                    // 兩種歷史存儲形態各佔一半，確保 number[] 與 Uint8Array 都逐字節無損。
                    vector: row % 2 === 0 ? Array.from(f32) : bytes,
                });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
    return expected.digest('hex');
}

function digestStoredVectors(vectors: any[]): string {
    const hash = createHash('sha256');
    for (const vector of [...vectors].sort(numericMemoryOrder)) {
        const f32 = vector.vector instanceof Float32Array
            ? vector.vector
            : vector.vector instanceof Uint8Array
                ? new Float32Array(vector.vector.buffer, vector.vector.byteOffset, vector.vector.byteLength >>> 2)
                : new Float32Array(vector.vector);
        updateVectorDigest(
            hash,
            {
                memoryId: vector.memoryId,
                charId: vector.charId,
                dimensions: vector.dimensions,
                model: vector.model,
            },
            new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength),
        );
    }
    return hash.digest('hex');
}

describe('v2 真實鏈路：向量二進制旁路', () => {
    it('4500×1024 真 ZIP → importFullData → 檢索讀取：數量、關聯、元數據和全部 Float32 字節零變化', async () => {
        const expectedDigest = await seedLargeVectorLibrary();
        const sourceNodes = await DB.getRawStoreData('memory_nodes');

        const payload = await encodeVectorsForBackupChunked(async (onBatch) => {
            await DB.streamRawStoreData('memory_vectors', item => onBatch([item]));
        });
        expect(payload.index).toHaveLength(LARGE_VECTOR_COUNT);
        expect(payload.bin.byteLength).toBe(LARGE_VECTOR_COUNT * LARGE_VECTOR_DIMENSIONS * 4);

        const zip = new JSZip();
        await writeV2Backup(zip as any, { memoryNodes: sourceNodes }, { vectors: payload, mode: 'text_only' });
        const archive = await zip.generateAsync({
            type: 'uint8array',
            streamFiles: true,
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });
        const loaded = await JSZip.loadAsync(archive);
        const manifest = JSON.parse(await loaded.file('manifest.json')!.async('string'));
        const data: any = await assembleV2Backup(loaded as any, manifest);

        expect(data.memoryVectors).toHaveLength(LARGE_VECTOR_COUNT);
        expect(data.memoryNodes).toHaveLength(LARGE_VECTOR_COUNT);
        // 每條必須是獨立 buffer；否則寫入 IDB 時可能把整根 17.6 MiB bin 為每條重複克隆。
        expect(new Set(data.memoryVectors.map((v: any) => v.vector.buffer)).size).toBe(LARGE_VECTOR_COUNT);

        await seedStore('memory_nodes', [{ id: 'stale', charId: 'stale', content: '應被清除' }]);
        await seedStore('memory_vectors', [{
            memoryId: 'stale', charId: 'stale', dimensions: 1, model: 'old', vector: new Uint8Array(4),
        }]);
        await DB.importFullData(data);

        const restoredNodes = await DB.getRawStoreData('memory_nodes');
        const restoredRaw = await DB.getRawStoreData('memory_vectors');
        expect(restoredNodes).toHaveLength(LARGE_VECTOR_COUNT);
        expect(restoredRaw).toHaveLength(LARGE_VECTOR_COUNT);
        expect(restoredRaw.every((v: any) => v.vector instanceof Uint8Array)).toBe(true);
        expect(digestStoredVectors(restoredRaw)).toBe(expectedDigest);

        const nodeById = new Map(restoredNodes.map((node: any) => [node.id, node]));
        for (const vector of restoredRaw) {
            expect(nodeById.get(vector.memoryId)?.charId).toBe(vector.charId);
        }

        // 再走實際檢索側公開讀取 API：應解碼成 Float32Array，仍與導出前全量哈希相同。
        const searchSideVectors = (
            await Promise.all(['char_0', 'char_1', 'char_2'].map(charId => MemoryVectorDB.getAllByCharId(charId)))
        ).flat();
        expect(searchSideVectors).toHaveLength(LARGE_VECTOR_COUNT);
        expect(searchSideVectors.every(v => v.vector instanceof Float32Array)).toBe(true);
        expect(digestStoredVectors(searchSideVectors)).toBe(expectedDigest);
    }, 30_000);

    it('向量 clear-once：目標獨有的舊向量被清、備份的向量落庫、逐值一致（test 10 + 二進制往返）', async () => {
        // 目標已有 vA、vB（存儲形態 Uint8Array）
        const toU8 = (vals: number[]) => { const f = new Float32Array(vals); return new Uint8Array(f.buffer, f.byteOffset, f.byteLength); };
        await seedStore('memory_vectors', [
            { memoryId: 'vA', charId: 'c1', dimensions: 4, vector: toU8([9, 9, 9, 9]) },
            { memoryId: 'vB', charId: 'c1', dimensions: 4, vector: toU8([8, 8, 8, 8]) },
        ]);

        // 備份只含 vA（新值）+ vC，不含 vB
        const payload = encodeVectorsForBackup([
            { memoryId: 'vA', charId: 'c1', vector: toU8([1, 2, 3, 4]) },
            { memoryId: 'vC', charId: 'story-theater:backup-entry', vector: toU8([5, 6, 7, 8]) },
        ]);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, { memoryNodes: [{ id: 'n1' }] }, { vectors: payload });
        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        const stored = await DB.getRawStoreData('memory_vectors');
        const byId = new Map(stored.map((v: any) => [v.memoryId, v]));
        // vB 被清（走 importFullData 的 clearStore，不是 saveMany upsert 旁路）
        expect([...byId.keys()].sort()).toEqual(['vA', 'vC']);
        // 逐值一致，且 vA 是新值不是舊值
        expect(vecValues(byId.get('vA'))).toEqual([1, 2, 3, 4]);
        expect(vecValues(byId.get('vC'))).toEqual([5, 6, 7, 8]);
        expect(byId.get('vC').charId).toBe('story-theater:backup-entry');
        // 落庫形態是 Uint8Array（緊湊存儲）
        expect(byId.get('vA').vector).toBeInstanceOf(Uint8Array);
    });

    it('遺留 number[] 向量導出 v2、再導入逐值一致（R4·F4 / test 18）', async () => {
        // 老數據：vector 還是 raw number[]（未遷移成 Uint8Array）
        await seedStore('memory_vectors', [
            { memoryId: 'legacy1', charId: 'c1', dimensions: 4, vector: [0.11, 0.22, 0.33, 0.44] },
        ]);

        // 導出走和 OSContext 完全相同的歸一化函數
        const raw = await DB.getRawStoreData('memory_vectors');
        const payload = encodeVectorsForBackup(raw);
        const zip = new FakeZip();
        const manifest = await writeV2Backup(zip, {}, { vectors: payload });
        expect(manifest.vectors).toEqual({ count: 1, byteLength: 16 });

        await seedStore('memory_vectors', []); // 清空目標，證明是從備份還原
        const data = await assembleV2Backup(zip, manifest);
        await DB.importFullData(data as any);

        const stored = await DB.getRawStoreData('memory_vectors');
        expect(stored).toHaveLength(1);
        expect(stored[0].memoryId).toBe('legacy1');
        const vals = vecValues(stored[0]);
        expect(vals).toEqual([
            expect.closeTo(0.11, 6), expect.closeTo(0.22, 6), expect.closeTo(0.33, 6), expect.closeTo(0.44, 6),
        ]);
    });
});

describe('v3 blob 旁路：令牌原樣進包、二進制隨包、按原 id 還原', () => {
    // v2 時代 songs 掉出 resolveBlobRefsDeep 名單會導出死令牌，專門有條源碼錨守衛。
    // v3 的收集不走名單（onSerialized 從落包文本里提令牌），那類「漏名單」缺陷在結構上
    // 不存在了；這裡改釘三件事：令牌保真（舊行為解析成 data: 時這條會紅）、字節保真、
    // 嵌套 JSON 字符串裡的令牌照樣被收集（免名單的核心承諾）。
    const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    it('songs 封面令牌導出後原樣保留，blobs/* 按原 id 還原出同字節同 mime', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await seedStore('songs', [{ id: 'song-cover-1', title: '封面測試曲', coverImage: token }]);

        // 導出：與 OSContext 相同的三步 —— onSerialized 收集令牌、寫分片、寫 blobs 旁路
        const rawData: any[] = await DB.getRawStoreData('songs');
        const zip = new FakeZip();
        const tokens = new Set<string>();
        const manifest = await writeV2Backup(zip, { songs: rawData } as any, {
            onSerialized: s => collectBlobRefs(s, tokens),
        });
        expect(tokens.has(token)).toBe(true);
        const { written, missing } = await writeBlobsToZip(zip, tokens, getBlobForRef);
        expect({ written, missing }).toEqual({ written: 1, missing: [] });

        // 組裝：令牌一字不改地回來（v2 舊行為會把它解析成 data:，這條立刻紅）
        const data: any = await assembleV2Backup(zip, manifest);
        const song = data.songs.find((s: any) => s.id === 'song-cover-1');
        expect(song.coverImage).toBe(token);

        // 還原：索引校驗通過，按原令牌 id 交回 Blob，字節與原圖逐一致、mime 保真
        const entries = await readBlobsIndex(zip);
        expect(entries).toHaveLength(1);
        const restored = new Map<string, Blob>();
        await restoreBlobsFromZip(zip, entries, async (tk, blob) => { restored.set(tk, blob); });
        const blob = restored.get(token)!;
        expect(blob.type).toBe('image/png');
        expect(new Uint8Array(await blob.arrayBuffer()))
            .toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
    });

    it('令牌藏在嵌套 JSON 字符串裡（assets 表的預設行形態）也會被收集進旁路', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        // 模擬 assets 表裡 appearance_preset_* 行：值是 stringify 過的 JSON，令牌在字符串內部
        const rows = [{ id: 'appearance_preset_x', data: JSON.stringify({ theme: { wallpaper: token } }) }];
        const zip = new FakeZip();
        const tokens = new Set<string>();
        await writeV2Backup(zip, { assets: rows } as any, { onSerialized: s => collectBlobRefs(s, tokens) });
        expect(tokens.has(token)).toBe(true);
    });

    it('令牌對應 Blob 已丟：跳過並計入 missing，不落索引文件（與無 blob 的包同形）', async () => {
        const zip = new FakeZip();
        const { written, missing } = await writeBlobsToZip(
            zip, ['blobref:b_gone_0_aaaaaa'], async () => null);
        expect({ written, missing }).toEqual({ written: 0, missing: ['blobref:b_gone_0_aaaaaa'] });
        expect(zip.file(BLOBS_INDEX_FILE)).toBeNull();
        expect(await readBlobsIndex(zip)).toEqual([]); // 讀端把它當 v2 老包，安靜走老路
    });

    it('索引聲明的 blob 文件缺失 → 寫庫前 abort', async () => {
        const zip = new FakeZip();
        zip.file(BLOBS_INDEX_FILE, JSON.stringify([{ id: 'b_x_0_aaaaaa', type: 'image/png', size: 3 }]));
        await expect(readBlobsIndex(zip)).rejects.toThrow(/blobs\/b_x_0_aaaaaa/);
    });

    it('blob 字節數與索引聲明不符（截斷包）→ 還原中止', async () => {
        const zip = new FakeZip();
        zip.file('blobs/b_y_0_aaaaaa', new Uint8Array([1, 2]));
        zip.file(BLOBS_INDEX_FILE, JSON.stringify([{ id: 'b_y_0_aaaaaa', type: 'image/png', size: 3 }]));
        const entries = await readBlobsIndex(zip);
        await expect(restoreBlobsFromZip(zip, entries, async () => {})).rejects.toThrow(/截[断斷]/);
    });
});
