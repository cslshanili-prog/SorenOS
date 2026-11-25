/// <reference lib="webworker" />
/**
 * 備份的 OPFS 寫檔 Worker：主執行緒把壓好的位元組一塊一塊丟過來，這裡用同步把手接著往檔案後面寫。
 * 同步把手（createSyncAccessHandle）只能在 Worker 裡用，iPhone 從 iOS 15.2 就有。
 * 邏輯在 opfsWriterCore.ts，這個檔只接線。
 */
import { createOpfsWriterCore, type OpfsFileSystem, type OpfsReply, type OpfsRequest, type SyncFileHandle } from './opfsWriterCore';

const directoryOf = async (dir: string, create: boolean) => {
    const root = await (self as any).navigator.storage.getDirectory();
    return root.getDirectoryHandle(dir, { create });
};

const fs: OpfsFileSystem = {
    async open(dir, name) {
        const directory = await directoryOf(dir, true);
        const file = await directory.getFileHandle(name, { create: true });
        const handle = await file.createSyncAccessHandle();
        handle.truncate(0);
        return handle as SyncFileHandle;
    },
    async remove(dir, name) {
        const directory = await directoryOf(dir, false);
        await directory.removeEntry(name);
    },
};

const core = createOpfsWriterCore(fs, (message: OpfsReply) => (self as any).postMessage(message));
self.onmessage = (event: MessageEvent<OpfsRequest>) => { void core.post(event.data); };
