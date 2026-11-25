import { beforeEach, describe, expect, it } from 'vitest';
import {
    BACKUP_RUN_LS_KEY, BACKUP_ZIP_WRITER_LS_KEY, beginBackupRun, describeInterruptedBackup, endBackupRun,
    interruptedBackupEventProps, isBackupRunning, preferredBackupSink, takeInterruptedBackupRun, updateBackupRun,
} from './backupRunState';

const makeStorage = () => {
    const map = new Map<string, string>();
    let writes = 0;
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { writes++; map.set(k, v); },
        removeItem: (k: string) => { map.delete(k); },
        get writes() { return writes; },
        map,
    };
};

describe('備份跑到哪了', () => {
    let storage: ReturnType<typeof makeStorage>;
    beforeEach(() => { storage = makeStorage(); endBackupRun(storage); });

    it('開始留字條、結束刪掉；進行中旗標跟著走', () => {
        expect(isBackupRunning()).toBe(false);
        beginBackupRun({ mode: 'full', sink: 'memory' }, 1000, storage);
        expect(isBackupRunning()).toBe(true);
        expect(JSON.parse(storage.map.get(BACKUP_RUN_LS_KEY)!)).toMatchObject({ mode: 'full', phase: 'tables', percent: 0, sink: 'memory', startedAt: 1000 });
        endBackupRun(storage);
        expect(isBackupRunning()).toBe(false);
        expect(storage.map.has(BACKUP_RUN_LS_KEY)).toBe(false);
    });

    it('同一階段進度沒跨 5% 不重寫；換階段一定寫', () => {
        beginBackupRun({ mode: 'full', sink: 'memory' }, 1000, storage);
        const base = storage.writes;
        updateBackupRun({ percent: 3 }, 1100, storage);
        expect(storage.writes).toBe(base);
        updateBackupRun({ percent: 12 }, 1200, storage);
        expect(storage.writes).toBe(base + 1);
        updateBackupRun({ phase: 'media', percent: 13 }, 1300, storage);
        expect(storage.writes).toBe(base + 2);
        expect(JSON.parse(storage.map.get(BACKUP_RUN_LS_KEY)!)).toMatchObject({ phase: 'media', percent: 13, updatedAt: 1300 });
    });

    it('雲端備份接著上傳：同一趟、開始時間不變', () => {
        beginBackupRun({ mode: 'full', sink: 'memory' }, 1000, storage);
        beginBackupRun({ mode: 'full', sink: 'memory', phase: 'upload', percent: 50 }, 9000, storage);
        expect(JSON.parse(storage.map.get(BACKUP_RUN_LS_KEY)!)).toMatchObject({ phase: 'upload', percent: 50, startedAt: 1000, updatedAt: 9000 });
    });

    it('開機看到字條＝上次被關掉：讀出來就刪，不會提醒兩遍', () => {
        storage.setItem(BACKUP_RUN_LS_KEY, JSON.stringify({ mode: 'full', phase: 'media', percent: 93, sink: 'memory', startedAt: 1, updatedAt: 2 }));
        const note = takeInterruptedBackupRun(storage);
        expect(note).toMatchObject({ mode: 'full', phase: 'media', percent: 93 });
        expect(takeInterruptedBackupRun(storage)).toBeNull();
    });

    it('自己正在跑的那趟不算被關掉', () => {
        beginBackupRun({ mode: 'full', sink: 'memory' }, 1000, storage);
        expect(takeInterruptedBackupRun(storage)).toBeNull();
        expect(storage.map.has(BACKUP_RUN_LS_KEY)).toBe(true);
    });

    it('字條壞掉或欄位亂寫：不炸，認不出模式就當沒有，其餘欄位退回預設', () => {
        storage.setItem(BACKUP_RUN_LS_KEY, '{壞掉');
        expect(takeInterruptedBackupRun(storage)).toBeNull();
        storage.setItem(BACKUP_RUN_LS_KEY, JSON.stringify({ mode: 'weird' }));
        expect(takeInterruptedBackupRun(storage)).toBeNull();
        storage.setItem(BACKUP_RUN_LS_KEY, JSON.stringify({ mode: 'media_only', phase: 'x', sink: 'y', percent: 'z' }));
        expect(takeInterruptedBackupRun(storage)).toMatchObject({ mode: 'media_only', phase: 'tables', sink: 'memory', percent: 0 });
    });

    it('說明文字帶模式、階段、進度；埋點屬性都是寫死的值', () => {
        const note = { mode: 'full' as const, phase: 'media' as const, percent: 93, sink: 'memory' as const, startedAt: 1, updatedAt: 2 };
        expect(describeInterruptedBackup(note).message).toBe('上次的備份沒做完（整合導出，做到「寫入圖片與附件」約 93%）');
        expect(describeInterruptedBackup(note).detail).toContain('先「純文字」，再單獨導「媒體」');
        expect(interruptedBackupEventProps(note)).toEqual({ 模式: '整合', 阶段: '图片与附件', 输出: '内存', 进度: '75-100' });
        expect(interruptedBackupEventProps({ ...note, mode: 'text_only', phase: 'upload', sink: 'jszip', percent: 10 }))
            .toEqual({ 模式: '纯文字', 阶段: '上传', 输出: '旧容器', 进度: '0-25' });
    });

    it('排查開關：沒設寫磁碟；memory 留在記憶體；jszip 用舊容器；亂寫當沒設', () => {
        expect(preferredBackupSink(storage)).toBe('opfs');
        storage.setItem(BACKUP_ZIP_WRITER_LS_KEY, 'memory');
        expect(preferredBackupSink(storage)).toBe('memory');
        storage.setItem(BACKUP_ZIP_WRITER_LS_KEY, 'jszip');
        expect(preferredBackupSink(storage)).toBe('jszip');
        storage.setItem(BACKUP_ZIP_WRITER_LS_KEY, '亂寫');
        expect(preferredBackupSink(storage)).toBe('opfs');
    });
});
