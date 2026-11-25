/**
 * 備份輸出寫進瀏覽器的私有檔案區（OPFS）：寫入器吐出來的位元組交給 Worker 往磁碟上的檔案後面接，
 * 收尾拿到的是磁碟上的檔案，整包不在記憶體裡（plans/backup-streaming.md 第 4.2 節）。
 *
 * 這個檔是主執行緒那一頭：節流（積壓太多就等）、錯誤往回報、寫完驗檔、清暫存。
 * Worker 和檔案系統都可以換成假的，node 裡測得到。
 */
import type { ZipSink } from './writer';
import type { OpfsReply, OpfsRequest } from './opfsWriterCore';

export const BACKUP_TMP_DIR = 'backup-tmp';

/** 積壓超過這麼多，drain() 就等到降下來（Worker 寫磁碟很快，平常不太會碰到） */
const HIGH_WATER_BYTES = 16 * 1024 * 1024;
const LOW_WATER_BYTES = 4 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 15_000;
const EOCD_SIGNATURE = 0x06054b50;

export interface WorkerLike {
    postMessage(message: OpfsRequest, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((event: { data: OpfsReply }) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

export interface OpfsSink extends ZipSink {
    drain(): Promise<void>;
    /** 輸出端出過事（開不了、寫不進、驗檔不過）：呼叫端看到就改用記憶體重跑 */
    readonly failed: boolean;
    /** 失敗是不是因為空間不夠 */
    readonly quotaExceeded: boolean;
}

export interface OpfsSinkDeps {
    createWorker: () => WorkerLike;
    /** 收尾後把寫好的檔案讀回來（磁碟上的 File） */
    readFile: (dir: string, name: string) => Promise<Blob>;
    openTimeoutMs?: number;
}

/** 這個環境能不能用：要有 Worker 和 OPFS。能用不代表一定寫得成，寫不成會退回記憶體 */
export const isOpfsSinkSupported = (): boolean => {
    try {
        return typeof Worker !== 'undefined'
            && typeof navigator !== 'undefined'
            && typeof navigator.storage?.getDirectory === 'function';
    } catch {
        return false;
    }
};

const browserDeps = (): OpfsSinkDeps => ({
    createWorker: () => new Worker(new URL('./opfsSinkWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    readFile: async (dir, name) => {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle(dir);
        const handle = await directory.getFileHandle(name);
        return handle.getFile();
    },
});

/**
 * 開一個暫存檔準備寫。開不了（不支援、私密瀏覽、Worker 起不來、逾時）就丟錯，呼叫端改用記憶體。
 */
export const createOpfsSink = async (
    options: { fileName: string; type?: string },
    deps: OpfsSinkDeps = browserDeps(),
): Promise<OpfsSink> => {
    const type = options.type || 'application/zip';
    const worker = deps.createWorker();
    let failure: Error | null = null;
    let quota = false;
    let pending = 0;
    let posted = 0;
    let closed = false;
    let waiters: Array<{ resolve: () => void; reject: (error: Error) => void; until: number }> = [];
    let onOpened: (() => void) | null = null;
    let onFinished: ((size: number) => void) | null = null;
    let onAborted: (() => void) | null = null;
    let onFailure: ((error: Error) => void) | null = null;

    const settleWaiters = () => {
        if (failure) {
            const error = failure;
            waiters.forEach(w => w.reject(error));
            waiters = [];
            return;
        }
        const ready = waiters.filter(w => pending <= w.until);
        waiters = waiters.filter(w => pending > w.until);
        ready.forEach(w => w.resolve());
    };

    const fail = (error: Error, isQuota = false) => {
        if (failure) return;
        failure = error;
        quota = isQuota;
        settleWaiters();
        onFailure?.(error);
    };

    worker.onmessage = ({ data }) => {
        if (data.type === 'ack') { pending -= data.bytes; settleWaiters(); }
        else if (data.type === 'opened') onOpened?.();
        else if (data.type === 'finished') onFinished?.(data.size);
        else if (data.type === 'aborted') onAborted?.();
        else if (data.type === 'error') fail(new Error(data.quota ? `手機剩餘空間不夠放備份的暫存檔（${data.message}）` : `寫入暫存檔失敗：${data.message}`), data.quota);
    };
    worker.onerror = (event) => fail(new Error(`備份寫檔的背景執行緒出錯：${(event as { message?: string })?.message || '不明原因'}`));

    const shutdown = () => {
        if (closed) return;
        closed = true;
        try { worker.terminate(); } catch { /* ignore */ }
    };

    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('開暫存檔逾時')), deps.openTimeoutMs ?? OPEN_TIMEOUT_MS);
            onOpened = () => { clearTimeout(timer); resolve(); };
            onFailure = (error) => { clearTimeout(timer); reject(error); };
            worker.postMessage({ type: 'open', dir: BACKUP_TMP_DIR, name: options.fileName });
        });
    } catch (error) {
        shutdown();
        throw error;
    } finally {
        onOpened = null;
        onFailure = null;
    }

    return {
        get failed() { return !!failure; },
        get quotaExceeded() { return quota; },

        write(chunk, owned) {
            if (failure) throw failure;
            // 長度先記：transfer 之後這塊就空了
            const size = chunk.byteLength;
            if (!size) return;
            pending += size;
            posted += size;
            // 自己產生的那塊直接交出去；呼叫端的位元組照一般方式送（送的當下複製一份，原本那塊不動）
            if (owned) worker.postMessage({ type: 'write', chunk }, [chunk.buffer]);
            else worker.postMessage({ type: 'write', chunk });
        },

        drain() {
            if (failure) return Promise.reject(failure);
            if (pending <= HIGH_WATER_BYTES) return Promise.resolve();
            return new Promise<void>((resolve, reject) => { waiters.push({ resolve, reject, until: LOW_WATER_BYTES }); });
        },

        async finish() {
            if (failure) throw failure;
            try {
                const size = await new Promise<number>((resolve, reject) => {
                    onFinished = resolve;
                    onFailure = reject;
                    worker.postMessage({ type: 'finish' });
                });
                if (size !== posted) throw new Error(`暫存檔大小不對（寫了 ${posted}，檔案回報 ${size}）`);
                const file = await deps.readFile(BACKUP_TMP_DIR, options.fileName);
                // 寫完要驗：有人回報過 Safari 用這個寫法寫出來的檔讀回來是空的，不能假設一定對
                if (file.size !== posted) throw new Error(`暫存檔讀回來大小不對（寫了 ${posted}，讀到 ${file.size}）`);
                if (posted < 22) throw new Error('暫存檔太小，不是完整的備份包');
                const tail = new DataView(await file.slice(posted - 22, posted - 18).arrayBuffer());
                if (tail.getUint32(0, true) !== EOCD_SIGNATURE) throw new Error('暫存檔結尾不對，不是完整的備份包');
                // 換上正確的類型；slice 不複製內容，背後還是磁碟上那個檔
                return file.slice(0, file.size, type);
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
                throw failure;
            } finally {
                shutdown();
            }
        },

        async abort() {
            if (closed) return;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 3000);
                onAborted = () => { clearTimeout(timer); resolve(); };
                try { worker.postMessage({ type: 'abort' }); } catch { clearTimeout(timer); resolve(); }
            });
            shutdown();
        },
    };
};

/**
 * 清掉備份的暫存檔。暫存檔跟備份檔一樣大、佔 App 的儲存額度，不清會一直佔著。
 * 清的時機：下一次備份開始前、App 開機時、雲端上傳結束後。正在寫的檔（別的分頁在備份）刪不掉，跳過。
 */
export const clearBackupTempFiles = async (): Promise<number> => {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return 0;
    let removed = 0;
    try {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle(BACKUP_TMP_DIR).catch(() => null);
        if (!directory) return 0;
        const names: string[] = [];
        for await (const name of (directory as any).keys() as AsyncIterable<string>) names.push(name);
        for (const name of names) {
            try { await directory.removeEntry(name); removed++; } catch { /* 正在用，下次再清 */ }
        }
    } catch { /* 清不掉不影響備份 */ }
    return removed;
};
