/**
 * OPFS 寫檔的核心（Worker 那一頭）。跟 Worker 的訊息收發分開，好在 node 裡用假的檔案把手測。
 * 見 plans/backup-streaming.md 第 4.2 節。
 *
 * 訊息一律照收到的順序處理：開檔是非同步的，後面的寫入要排在它後面。
 */

/** FileSystemSyncAccessHandle 用到的那幾個方法 */
export interface SyncFileHandle {
    write(buffer: Uint8Array, options?: { at?: number }): number;
    flush(): void;
    close(): void;
}

export type OpfsRequest =
    | { type: 'open'; dir: string; name: string }
    | { type: 'write'; chunk: Uint8Array }
    | { type: 'finish' }
    | { type: 'abort' };

export type OpfsReply =
    | { type: 'opened' }
    | { type: 'ack'; bytes: number }
    | { type: 'finished'; size: number }
    | { type: 'aborted' }
    | { type: 'error'; message: string; quota: boolean };

export interface OpfsFileSystem {
    /** 建檔（已經有就清空）並拿到同步寫的把手 */
    open(dir: string, name: string): Promise<SyncFileHandle>;
    /** 刪掉這個檔（沒有就算了） */
    remove(dir: string, name: string): Promise<void>;
}

const describe = (error: unknown): { message: string; quota: boolean } => {
    const name = (error as { name?: string })?.name || '';
    const message = (error as { message?: string })?.message || String(error);
    return { message: `${name ? `${name}: ` : ''}${message}`, quota: name === 'QuotaExceededError' || /quota/i.test(message) };
};

export const createOpfsWriterCore = (fs: OpfsFileSystem, reply: (message: OpfsReply) => void) => {
    let handle: SyncFileHandle | null = null;
    let target: { dir: string; name: string } | null = null;
    let offset = 0;
    let dead = false;
    let queue: Promise<void> = Promise.resolve();

    const closeQuietly = () => {
        try { handle?.close(); } catch { /* 已經關了 */ }
        handle = null;
    };

    const fail = (error: unknown) => {
        dead = true;
        closeQuietly();
        reply({ type: 'error', ...describe(error) });
    };

    const handleOne = async (message: OpfsRequest): Promise<void> => {
        if (message.type === 'abort') {
            dead = true;
            closeQuietly();
            if (target) await fs.remove(target.dir, target.name).catch(() => undefined);
            reply({ type: 'aborted' });
            return;
        }
        if (dead) return;
        try {
            if (message.type === 'open') {
                target = { dir: message.dir, name: message.name };
                handle = await fs.open(message.dir, message.name);
                offset = 0;
                reply({ type: 'opened' });
            } else if (message.type === 'write') {
                if (!handle) throw new Error('檔案還沒開');
                const { chunk } = message;
                // 一次沒寫完就接著寫剩下的；回 0 代表寫不進去了（多半是空間滿了）
                let done = 0;
                while (done < chunk.byteLength) {
                    const wrote = handle.write(done ? chunk.subarray(done) : chunk, { at: offset + done });
                    if (!(wrote > 0)) throw Object.assign(new Error('寫不進去（空間可能滿了）'), { name: 'QuotaExceededError' });
                    done += wrote;
                }
                offset += chunk.byteLength;
                reply({ type: 'ack', bytes: chunk.byteLength });
            } else if (message.type === 'finish') {
                if (!handle) throw new Error('檔案還沒開');
                handle.flush();
                closeQuietly();
                dead = true;
                reply({ type: 'finished', size: offset });
            }
        } catch (error) {
            fail(error);
        }
    };

    return {
        /** 收到一則訊息：排在前一則後面處理 */
        post(message: OpfsRequest): Promise<void> {
            queue = queue.then(() => handleOne(message));
            return queue;
        },
    };
};
