import { describe, it, expect } from 'vitest';
import { uploadBackup } from './webdavClient';
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
