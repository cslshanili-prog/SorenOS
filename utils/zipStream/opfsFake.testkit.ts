/**
 * 測試用的假 OPFS：假的磁碟＋假的 Worker（訊息丟給真正的寫檔核心）。
 * opfsSink.test.ts 和 factory.test.ts 共用。
 */
import { createOpfsWriterCore, type OpfsFileSystem, type OpfsReply, type OpfsRequest, type SyncFileHandle } from './opfsWriterCore';
import type { OpfsSinkDeps, WorkerLike } from './opfsSink';

/** 假的磁碟：一個檔一個可以長大的位元組陣列 */
export const makeDisk = (options: { quotaBytes?: number; shortWrites?: boolean; corruptOnRead?: 'empty' | 'tail' } = {}) => {
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
export const makeWorker = (disk: ReturnType<typeof makeDisk>, options: { neverOpen?: boolean; stallWrites?: boolean } = {}) => {
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

export const depsFor = (disk: ReturnType<typeof makeDisk>, w: ReturnType<typeof makeWorker>, extra: Partial<OpfsSinkDeps> = {}): OpfsSinkDeps => ({
    createWorker: () => w.worker, readFile: disk.read, ...extra,
});
