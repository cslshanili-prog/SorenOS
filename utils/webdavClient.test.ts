import { afterEach, describe, it, expect, vi } from 'vitest';
import { downloadBackup, uploadBackup } from './webdavClient';
import { createMemorySink, type ZipSink } from './zipStream/writer';
import type { CloudBackupConfig } from '../types';

// 這條鎖住 #5 的大小預檢：經 Worker 代理上傳（web 路徑）時，備份 blob 超體積上限必須在發起上傳
// 前就給可執行報錯（提示改用本地導出 / GitHub），而不是傻等幾十秒上行後才失敗。
// node 測試環境非 native，走 web 分支；超限會在創建 XMLHttpRequest 之前 resolve，所以這裡無需 XHR。

const config: CloudBackupConfig = {
    webdavUrl: 'https://example.invalid/dav',
    remotePath: '/backups',
    username: 'u',
    password: 'p',
} as CloudBackupConfig;

describe('uploadBackup 大小預檢（#5）', () => {
    it('超過 Worker 上傳上限：直接報錯且提示改用本地導出 / GitHub，不發起上傳', async () => {
        // 只讀 blob.size，造一個聲明超大的假 blob，避免真分配幾百 MB
        const oversized = { size: 200 * 1024 * 1024 } as Blob;
        const res = await uploadBackup(config, oversized, 'backup.zip');
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/超[过過][云雲]端代理上[传傳]上限/);
        expect(res.message).toMatch(/本地[导導]出|GitHub/);
    });
});

// 第 3d 批（plans/backup-streaming.md）：雲端還原的下載一段一段寫進暫存區，不在記憶體裡攢整包。
describe('downloadBackup：一段一段寫進暫存區', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    const CHUNK = 8 * 1024 * 1024;
    const source = new Uint8Array(CHUNK * 2 + 12345);
    for (let i = 0; i < source.length; i += 4099) source[i] = (i * 7) & 0xFF;
    const file = { name: 'Sully_Backup_full_1.zip', href: '/backups/Sully_Backup_full_1.zip', size: source.length, lastModified: 1 };
    const sameBytes = async (blob: Blob | null) => !!blob && Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(source));

    /** 記下每次寫了多少、有沒有收掉的暫存區 */
    const spyStore = () => {
        const sink = createMemorySink();
        const log = { writes: [] as number[], owned: [] as boolean[], finished: 0, aborted: 0 };
        const store: ZipSink = {
            write: (chunk, owned) => { log.writes.push(chunk.byteLength); log.owned.push(!!owned); sink.write(chunk, owned); },
            drain: async () => {},
            finish: async () => { log.finished++; return sink.finish(); },
            abort: async () => { log.aborted++; await sink.abort(); },
        };
        return { store, log };
    };

    it('分段下載：每一段各寫一次，接起來跟原檔一樣', async () => {
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            const start = call++ * CHUNK;
            return new Response(source.slice(start, Math.min(source.length, start + CHUNK)), { status: 206 });
        }));
        const { store, log } = spyStore();
        const progress: number[] = [];
        const blob = await downloadBackup(config, file, p => progress.push(p), () => store);
        expect(await sameBytes(blob)).toBe(true);
        expect(log.writes).toEqual([CHUNK, CHUNK, 12345]);
        expect(log.owned).toEqual([true, true, true]);
        expect(log.finished).toBe(1);
        expect(log.aborted).toBe(0);
        expect(progress[progress.length - 1]).toBe(100);
    });

    it('沒給暫存區照舊攢在記憶體，結果一樣', async () => {
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            const start = call++ * CHUNK;
            return new Response(source.slice(start, Math.min(source.length, start + CHUNK)), { status: 206 });
        }));
        expect(await sameBytes(await downloadBackup(config, file))).toBe(true);
    });

    it('分段抓到一半失敗：寫到一半的暫存區收掉，改成整個重抓，結果還是對的', async () => {
        vi.useFakeTimers();
        try {
            let call = 0;
            vi.stubGlobal('fetch', vi.fn(async () => {
                call++;
                if (call === 1) return new Response(source.slice(0, CHUNK), { status: 206 });
                if (call <= 4) return new Response('nope', { status: 500 }); // 第二段三次都失敗
                return new Response(source.slice(), { status: 200 }); // 退回整個抓
            }));
            const { store, log } = spyStore();
            const pending = downloadBackup(config, file, undefined, () => store);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await sameBytes(await pending)).toBe(true);
            expect(log.writes).toEqual([CHUNK]);
            expect(log.aborted).toBe(1);
            expect(log.finished).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
