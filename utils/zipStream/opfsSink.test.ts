import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { deflateSync } from 'fflate';
import { createOpfsWriterCore, type OpfsFileSystem, type OpfsReply, type OpfsRequest, type SyncFileHandle } from './opfsWriterCore';
import { BACKUP_TMP_DIR, createOpfsSink, type OpfsSinkDeps, type WorkerLike } from './opfsSink';
import { createZipStreamWriter } from './writer';

const deflate = (data: Uint8Array, options: { level: number }) => deflateSync(data, { level: options.level as any });

/** 假的磁碟：一個檔一個可以長大的位元組陣列 */
const makeDisk = (options: { quotaBytes?: number; shortWrites?: boolean; corruptOnRead?: 'empty' | 'tail' } = {}) => {
    const files = new Map<string, Uint8Array>();
    const sizes = new Map<string, number>();
    const fs: OpfsFileSystem = {
        async open(dir, name) {
            const key = `${dir}/${name}`;
            files.set(key, new Uint8Array(1024));
            sizes.set(key, 0);
            const handle: SyncFileHandle = {
                write(buffer, opts) {
                    const at = opts?.at ?? sizes.get(key)!;
                    let length = buffer.byteLength;
                    if (options.shortWrites) length = Math.max(1, Math.ceil(length / 3));
                    if (options.quotaBytes !== undefined && at + length > options.quotaBytes) {
                        throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
                    }
                    let data = files.get(key)!;
                    if (at + length > data.byteLength) {
                        const grown = new Uint8Array(Math.max(data.byteLength * 2, at + length));
                        grown.set(data);
                        data = grown;
                        files.set(key, data);
                    }
                    data.set(buffer.subarray(0, length), at);
                    sizes.set(key, Math.max(sizes.get(key)!, at + length));
                    return length;
                },
                flush() {},
                close() {},
            };
            return handle;
        },
        async remove(dir, name) { files.delete(`${dir}/${name}`); sizes.delete(`${dir}/${name}`); },
    };
    const read = async (dir: string, name: string): Promise<Blob> => {
        const key = `${dir}/${name}`;
        if (!files.has(key)) throw new Error('NotFoundError');
        if (options.corruptOnRead === 'empty') return new Blob([]);
        const bytes = files.get(key)!.slice(0, sizes.get(key)!);
        if (options.corruptOnRead === 'tail') bytes[bytes.length - 22] ^= 0xFF;
        return new Blob([bytes]);
    };
    return { fs, read, files, sizes };
};

/** 假的 Worker：訊息丟給真正的寫檔核心，回覆用微任務送回來（跟真的一樣是非同步的） */
const makeWorker = (disk: ReturnType<typeof makeDisk>, options: { neverOpen?: boolean; stallWrites?: boolean } = {}) => {
    const log: OpfsRequest['type'][] = [];
    const transferred: number[] = [];
    let terminated = false;
    let held: Array<() => void> = [];
    const worker: WorkerLike & { release: () => void; terminated: () => boolean } = {
        onmessage: null,
        onerror: null,
        postMessage(message, transfer) {
            log.push(message.type);
            if (message.type === 'write') {
                transferred.push(transfer?.length || 0);
                // 模擬 transfer：交出去的那塊在送的人手上就空了；沒交的要複製一份
                const copy = message.chunk.slice();
                if (transfer?.length) (message.chunk as any).__detached = true;
                message = { type: 'write', chunk: copy };
            }
            if (options.neverOpen && message.type === 'open') return;
            const run = () => { void core.post(message); };
            if (options.stallWrites && message.type === 'write') held.push(run); else run();
        },
        terminate() { terminated = true; },
        release() { const runs = held; held = []; runs.forEach(r => r()); },
        terminated: () => terminated,
    };
    const core = createOpfsWriterCore(disk.fs, (reply: OpfsReply) => { queueMicrotask(() => { if (!terminated) worker.onmessage?.({ data: reply }); }); });
    return { worker, log, transferred };
};

const depsFor = (disk: ReturnType<typeof makeDisk>, w: ReturnType<typeof makeWorker>, extra: Partial<OpfsSinkDeps> = {}): OpfsSinkDeps => ({
    createWorker: () => w.worker, readFile: disk.read, ...extra,
});

describe('OPFS 輸出：寫進磁碟上的暫存檔', () => {
    it('整包寫完讀回來是完整的 zip，內容逐檔正確；Worker 收尾後關掉', async () => {
        const disk = makeDisk();
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'backup.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        const text = '聊天記錄'.repeat(20_000);
        const image = new Uint8Array(300_000).map((_, i) => (i * 7) & 0xFF);
        writer.file('stores/messages.000.json', text);
        writer.file('blobs/a', image, { compression: 'STORE' });
        writer.file('assets/a.png', Buffer.from([1, 2, 3]).toString('base64'), { base64: true, compression: 'STORE' });
        await writer.drain();
        const blob = await writer.finish();

        expect(blob.type).toBe('application/zip');
        expect(blob.size).toBe(writer.bytesWritten);
        expect(disk.sizes.get(`${BACKUP_TMP_DIR}/backup.zip`)).toBe(writer.bytesWritten);
        const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()), { checkCRC32: true });
        expect(await zip.file('stores/messages.000.json')!.async('string')).toBe(text);
        expect(Buffer.from(await zip.file('blobs/a')!.async('uint8array')).equals(Buffer.from(image))).toBe(true);
        expect(Array.from(await zip.file('assets/a.png')!.async('uint8array'))).toEqual([1, 2, 3]);
        expect(w.worker.terminated()).toBe(true);
        expect(sink.failed).toBe(false);
    });

    it('自己產生的位元組交出去不複製；呼叫端傳進來的原樣位元組不能被拿走', async () => {
        const disk = makeDisk();
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'b.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        const callerBytes = new Uint8Array(50_000).fill(5);
        writer.file('blobs/x', callerBytes, { compression: 'STORE' });
        // 檔頭（自己的，交出去）＋呼叫端的內容（沒交）
        expect(w.transferred).toEqual([1, 0]);
        expect((callerBytes as any).__detached).toBeUndefined();
        expect(callerBytes.byteLength).toBe(50_000);
        writer.file('a.json', 'x'.repeat(10_000));
        // 文字：檔頭和壓過的內容都是自己的
        expect(w.transferred).toEqual([1, 0, 1, 1]);
        await writer.finish();
    });

    it('一次沒寫完會接著寫剩下的（同步把手可能只寫一部分）', async () => {
        const disk = makeDisk({ shortWrites: true });
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'c.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        const image = new Uint8Array(100_000).map((_, i) => (i * 3) & 0xFF);
        writer.file('blobs/a', image, { compression: 'STORE' });
        const zip = await JSZip.loadAsync(new Uint8Array(await (await writer.finish()).arrayBuffer()), { checkCRC32: true });
        expect(Buffer.from(await zip.file('blobs/a')!.async('uint8array')).equals(Buffer.from(image))).toBe(true);
    });

    it('節流：積壓超過上限時 drain 會等，Worker 寫完才放行', async () => {
        const disk = makeDisk();
        const w = makeWorker(disk, { stallWrites: true });
        const sink = await createOpfsSink({ fileName: 'd.zip' }, depsFor(disk, w));
        const chunk = () => new Uint8Array(6 * 1024 * 1024);
        sink.write(chunk(), true);
        await expect(Promise.race([sink.drain().then(() => 'ok'), new Promise(r => setTimeout(() => r('waiting'), 20))])).resolves.toBe('ok');
        sink.write(chunk(), true); sink.write(chunk(), true); // 18 MB 積壓
        let drained = false;
        const waiting = sink.drain().then(() => { drained = true; });
        await new Promise(r => setTimeout(r, 20));
        expect(drained).toBe(false);
        w.worker.release();
        await waiting;
        expect(drained).toBe(true);
    });

    it('空間不夠：寫入器整包作廢、標成空間不足，之後 write／drain／finish 都報錯', async () => {
        const disk = makeDisk({ quotaBytes: 100_000 });
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'e.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        writer.file('blobs/a', new Uint8Array(300_000), { compression: 'STORE' });
        // 寫磁碟是排隊的：錯誤晚一拍才回來，最晚在下一次 drain／finish 報出來
        await new Promise(r => setTimeout(r, 10));
        await expect(writer.drain()).rejects.toThrow(/剩餘空間不夠/);
        expect(sink.failed).toBe(true);
        expect(sink.quotaExceeded).toBe(true);
        expect(() => writer.file('b', 'x')).toThrow(/剩餘空間不夠/);
        await expect(writer.finish()).rejects.toThrow(/剩餘空間不夠/);
    });

    it('寫完驗檔：讀回來是空的（Safari 回報過的情況）→ 失敗，呼叫端可以改用記憶體重跑', async () => {
        const disk = makeDisk({ corruptOnRead: 'empty' });
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'f.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        writer.file('a.json', 'hello');
        await expect(writer.finish()).rejects.toThrow(/讀回來大小不對/);
        expect(sink.failed).toBe(true);
        expect(sink.quotaExceeded).toBe(false);
        expect(w.worker.terminated()).toBe(true);
    });

    it('寫完驗檔：結尾記號不對 → 失敗', async () => {
        const disk = makeDisk({ corruptOnRead: 'tail' });
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'g.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        writer.file('a.json', 'hello');
        await expect(writer.finish()).rejects.toThrow(/結尾不對/);
        expect(sink.failed).toBe(true);
    });

    it('開不了檔（逾時或出錯）就丟錯並關掉 Worker，不會卡住', async () => {
        const disk = makeDisk();
        const stuck = makeWorker(disk, { neverOpen: true });
        await expect(createOpfsSink({ fileName: 'h.zip' }, depsFor(disk, stuck, { openTimeoutMs: 30 }))).rejects.toThrow(/逾時/);
        expect(stuck.worker.terminated()).toBe(true);

        const broken = makeDisk();
        broken.fs.open = async () => { throw Object.assign(new Error('not allowed'), { name: 'SecurityError' }); };
        const w = makeWorker(broken);
        await expect(createOpfsSink({ fileName: 'i.zip' }, depsFor(broken, w))).rejects.toThrow(/SecurityError/);
        expect(w.worker.terminated()).toBe(true);
    });

    it('空間不夠但呼叫端沒再 drain：finish 一定會報出來，不會交出壞檔', async () => {
        const disk = makeDisk({ quotaBytes: 100_000 });
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'e2.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        writer.file('blobs/a', new Uint8Array(300_000), { compression: 'STORE' });
        await expect(writer.finish()).rejects.toThrow(/剩餘空間不夠/);
        expect(sink.quotaExceeded).toBe(true);
    });

    it('中止：暫存檔刪掉、Worker 關掉', async () => {
        const disk = makeDisk();
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'j.zip' }, depsFor(disk, w));
        const writer = createZipStreamWriter({ deflate, sink });
        writer.file('a.json', 'hello');
        await writer.abort();
        expect(disk.files.has(`${BACKUP_TMP_DIR}/j.zip`)).toBe(false);
        expect(w.worker.terminated()).toBe(true);
    });

    it('Worker 自己掛掉（onerror）→ 當成輸出失敗', async () => {
        const disk = makeDisk();
        const w = makeWorker(disk);
        const sink = await createOpfsSink({ fileName: 'k.zip' }, depsFor(disk, w));
        w.worker.onerror?.({ message: 'boom' });
        expect(sink.failed).toBe(true);
        expect(() => sink.write(new Uint8Array(1), true)).toThrow(/背景執行緒出錯/);
    });
});

describe('寫檔核心：訊息照順序處理', () => {
    it('開檔還沒好就收到寫入，也會排在後面寫，不會掉', async () => {
        const disk = makeDisk();
        const slowOpen = disk.fs.open;
        disk.fs.open = async (dir, name) => { await new Promise(r => setTimeout(r, 20)); return slowOpen(dir, name); };
        const replies: OpfsReply[] = [];
        const core = createOpfsWriterCore(disk.fs, r => replies.push(r));
        void core.post({ type: 'open', dir: 'd', name: 'f' });
        void core.post({ type: 'write', chunk: new Uint8Array([1, 2, 3]) });
        void core.post({ type: 'write', chunk: new Uint8Array([4, 5]) });
        await core.post({ type: 'finish' });
        expect(replies.map(r => r.type)).toEqual(['opened', 'ack', 'ack', 'finished']);
        expect(replies[3]).toEqual({ type: 'finished', size: 5 });
        expect(Array.from(disk.files.get('d/f')!.slice(0, 5))).toEqual([1, 2, 3, 4, 5]);
    });

    it('出錯之後的寫入都不再處理，只回一次錯', async () => {
        const disk = makeDisk({ quotaBytes: 4 });
        const replies: OpfsReply[] = [];
        const core = createOpfsWriterCore(disk.fs, r => replies.push(r));
        void core.post({ type: 'open', dir: 'd', name: 'f' });
        void core.post({ type: 'write', chunk: new Uint8Array(10) });
        void core.post({ type: 'write', chunk: new Uint8Array(10) });
        await core.post({ type: 'finish' });
        expect(replies.map(r => r.type)).toEqual(['opened', 'error']);
        expect(replies[1]).toMatchObject({ quota: true });
    });
});
