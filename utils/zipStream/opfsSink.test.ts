import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { deflateSync } from 'fflate';
import { createOpfsWriterCore, type OpfsReply } from './opfsWriterCore';
import { BACKUP_TMP_DIR, clearBackupTempFiles, createOpfsSink } from './opfsSink';
import { createZipStreamWriter } from './writer';

const deflate = (data: Uint8Array, options: { level: number }) => deflateSync(data, { level: options.level as any });

import { depsFor, makeDisk, makeWorker } from './opfsFake.testkit';

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

describe('清暫存檔：可以只清某幾種', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** 假的 OPFS 目錄：檔名 → 最後修改時間 */
    const stubTmpDir = (files: Record<string, number>) => {
        const entries = new Map(Object.entries(files));
        const directory = {
            keys: async function* () { yield* [...entries.keys()]; },
            getFileHandle: async (name: string) => ({ getFile: async () => ({ lastModified: entries.get(name)! }) }),
            removeEntry: async (name: string) => { entries.delete(name); },
        };
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } });
        return entries;
    };
    const now = Date.now();
    const fresh = now - 60_000;
    const old = now - 60 * 60_000;

    it('不帶參數：全清（開機時用）', async () => {
        const left = stubTmpDir({ 'backup-1.zip': fresh, 'models-1.zip': fresh, 'emoji-1.zip': old });
        expect(await clearBackupTempFiles()).toBe(3);
        expect([...left.keys()]).toEqual([]);
    });

    it('只給種類：別種的不動，就算放很久了', async () => {
        const left = stubTmpDir({ 'backup-1.zip': fresh, 'models-1.zip': fresh, 'emoji-1.zip': old });
        expect(await clearBackupTempFiles({ prefixes: ['backup-'] })).toBe(1);
        expect([...left.keys()]).toEqual(['models-1.zip', 'emoji-1.zip']);
    });

    it('種類＋時間：自己這種全清，別種的放久了才清（剛導出還在下載的不能動）', async () => {
        const left = stubTmpDir({ 'models-1.zip': fresh, 'models-0.zip': old, 'backup-1.zip': fresh, 'emoji-1.zip': old });
        expect(await clearBackupTempFiles({ prefixes: ['models-'], olderThanMs: 10 * 60_000 })).toBe(3);
        expect([...left.keys()]).toEqual(['backup-1.zip']);
    });
});
