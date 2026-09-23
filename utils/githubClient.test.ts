import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    describeGithubUploadTransportFailure,
    downloadBackup,
    listBackups,
    readResponseArrayBuffer,
    shouldUseGithubProxy,
    uploadBackup,
} from './githubClient';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('GitHub 備份代理安全默認', () => {
    const base = {
        enabled: true,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
    };

    it('新用戶與缺少代理字段的舊配置默認直連', () => {
        expect(shouldUseGithubProxy(base)).toBe(false);
    });

    it('舊版默認寫入的 true 沒有新版確認標記時仍然直連', () => {
        expect(shouldUseGithubProxy({ ...base, githubUseProxy: true })).toBe(false);
    });

    it('只有用戶在新版說明下明確開啟後才走中轉', () => {
        expect(shouldUseGithubProxy({
            ...base,
            githubUseProxy: true,
            githubProxyConsentVersion: 1,
        })).toBe(true);
    });

    it('明確關閉始終直連', () => {
        expect(shouldUseGithubProxy({
            ...base,
            githubUseProxy: false,
            githubProxyConsentVersion: 1,
        })).toBe(false);
    });

    it('直連失敗時明確區分 GitHub 網頁、API 與附件域名', () => {
        const message = describeGithubUploadTransportFailure(base);
        expect(message).toContain('uploads.github.com');
        expect(message).toContain('api.github.com');
        expect(message).toContain('開著梯子');
        expect(message).toContain('應用內 Cloudflare 中轉');
    });

    it('中轉失敗時說明當前走的是獨立 Worker 線路', () => {
        const message = describeGithubUploadTransportFailure({
            ...base,
            githubUseProxy: true,
            githubProxyConsentVersion: 1,
        });
        expect(message).toContain('應用內 Cloudflare 中轉');
        expect(message).toContain('sullymeow.ccwu.cc');
        expect(message).toContain('自定義網絡代理 (Worker)');
    });
});

describe('readResponseArrayBuffer', () => {
    it('reports streamed byte progress while preserving the payload', async () => {
        const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const progress: number[] = [];
        const result = await readResponseArrayBuffer(new Response(source), value => progress.push(value));

        expect(Array.from(new Uint8Array(result))).toEqual(Array.from(source));
        expect(progress.length).toBeGreaterThan(0);
        expect(progress.at(-1)).toBe(source.byteLength);
    });
});

describe('GitHub 備份下載錯誤', () => {
    const config = {
        enabled: true,
        provider: 'github' as const,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
        githubToken: 'github_pat_test',
        githubOwner: 'owner',
        githubRepo: 'sully-backup',
        githubUseProxy: false,
    };

    const file = {
        name: 'Sully_Backup_full_1.zip',
        href: '123:512999539',
        size: 1024,
        lastModified: Date.now(),
    };

    it('正式環境能夠直連時仍直接下載，不會自動切到 Worker', async () => {
        const directFetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
        vi.stubGlobal('fetch', directFetch);

        const blob = await downloadBackup(config, file);

        expect(blob?.size).toBe(3);
        expect(String(directFetch.mock.calls[0][0])).toBe(
            'https://api.github.com/repos/owner/sully-backup/releases/assets/512999539',
        );
    });

    it('網頁直連被 CORS/網絡攔截時給出手動開啟中轉的提示', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        await expect(downloadBackup(config, file)).rejects.toThrow(
            '手動開啟 Cloudflare 中轉後重試；應用不會自動開啟',
        );
    });

    it('GitHub 返回權限錯誤時保留 HTTP 狀態和處理建議', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));

        await expect(downloadBackup(config, file)).rejects.toThrow('HTTP 403');
    });
});

describe('GitHub 備份列表完整性', () => {
    const config = {
        enabled: true,
        provider: 'github' as const,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
        githubToken: 'github_pat_test',
        githubOwner: 'owner',
        githubRepo: 'sully-backup',
        githubUseProxy: false,
    };

    it('翻頁讀取超過 100 條 Release 後仍能找到備份', async () => {
        const unrelated = Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            tag_name: `unrelated-${index}`,
            assets: [],
        }));
        const backup = {
            id: 500,
            tag_name: 'sully-backup-legacy-1',
            draft: false,
            created_at: '2026-08-20T00:00:00Z',
            assets: [{
                id: 900,
                name: 'Sully_Backup_full_1.zip',
                size: 3,
                state: 'uploaded',
                updated_at: '2026-08-20T00:00:01Z',
            }],
        };
        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            const payload = new URL(url).searchParams.get('page') === '1' ? unrelated : [backup];
            return Promise.resolve(new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        });
        vi.stubGlobal('fetch', fetchMock);

        const files = await listBackups(config);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ name: 'Sully_Backup_full_1.zip', status: 'ready' });
    });

    it('草稿、starter 和缺少完成標記的新版 Release 會顯示為上傳未完成', async () => {
        const releases = [
            {
                id: 10,
                tag_name: 'sully-backup-v2-10',
                name: 'Sully Backup interrupted',
                draft: true,
                created_at: '2026-08-20T00:00:00Z',
                assets: [{ id: 11, name: 'Sully_Backup_full_10.zip', size: 0, state: 'starter' }],
            },
            {
                id: 20,
                tag_name: 'sully-backup-v2-20',
                name: 'Sully Backup missing manifest',
                draft: false,
                created_at: '2026-08-20T01:00:00Z',
                assets: [{ id: 21, name: 'Sully_Backup_full_20.zip', size: 12, state: 'uploaded' }],
            },
        ];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            const payload = url.includes('/releases/20/assets') ? releases[1].assets : releases;
            return Promise.resolve(new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        }));

        const files = await listBackups(config);

        expect(files).toHaveLength(2);
        expect(files.every(file => file.status === 'incomplete')).toBe(true);
        expect(files.map(file => file.statusMessage).join(' ')).toContain('0 字節');
        expect(files.map(file => file.statusMessage).join(' ')).toContain('缺少完成標記');
    });

    it('內嵌附件達到截斷邊界時會讀取分頁附件，避免誤報缺少分片', async () => {
        const embeddedAssets = [
            { id: 31, name: 'Sully_Backup_full_30.zip', size: 3, state: 'uploaded' },
            ...Array.from({ length: 29 }, (_, index) => ({
                id: 1000 + index,
                name: `diagnostic-${index}.txt`,
                size: 1,
                state: 'uploaded',
            })),
        ];
        const completeAssets = [
            embeddedAssets[0],
            { id: 32, name: 'Sully_Backup_full_30.zip.sully-backup.json', size: 20, state: 'uploaded' },
        ];
        const release = {
            id: 30,
            tag_name: 'sully-backup-v2-30',
            draft: false,
            created_at: '2026-08-20T02:00:00Z',
            assets: embeddedAssets,
        };
        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            const payload = url.includes('/releases/30/assets') ? completeAssets : [release];
            return Promise.resolve(new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        });
        vi.stubGlobal('fetch', fetchMock);

        const files = await listBackups(config);

        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ name: 'Sully_Backup_full_30.zip', status: 'ready' });
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/releases/30/assets'))).toBe(true);
    });

    it('列表鑑權或限流錯誤不會再偽裝成空數組', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
            JSON.stringify({ message: 'API rate limit exceeded' }),
            {
                status: 403,
                headers: {
                    'Content-Type': 'application/json',
                    'X-RateLimit-Remaining': '0',
                },
            },
        )));

        await expect(listBackups(config)).rejects.toThrow('請求過於頻繁');
    });
});

describe('GitHub 事務式上傳', () => {
    const config = {
        enabled: true,
        provider: 'github' as const,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
        githubToken: 'github_pat_test',
        githubOwner: 'owner',
        githubRepo: 'sully-backup',
        githubUseProxy: false,
    };

    it('附件失敗時刪除草稿 Release 和 tag，不留下半截備份', async () => {
        class FailedUploadXhr {
            status = 422;
            responseText = '{"message":"unprocessable"}';
            timeout = 0;
            upload: { onprogress?: (event: ProgressEvent) => void } = {};
            onload?: () => void;
            onerror?: () => void;
            onabort?: () => void;
            ontimeout?: () => void;
            open() {}
            setRequestHeader() {}
            getAllResponseHeaders() { return ''; }
            send() { this.onload?.(); }
        }
        vi.stubGlobal('XMLHttpRequest', FailedUploadXhr as any);

        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/releases') && init?.method === 'POST') {
                return Promise.resolve(new Response(JSON.stringify({ id: 77 }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (url.includes('/releases/77/assets?') && init?.method === 'GET') {
                return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
            throw new Error(`unexpected request: ${init?.method} ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await uploadBackup(config, new Blob(['zip']), 'Sully_Backup_full_1.zip');

        expect(result.ok).toBe(false);
        expect(result.message).toContain('草稿已清理');
        expect(fetchMock.mock.calls.some(([url, init]) =>
            String(url).endsWith('/releases/77') && init?.method === 'DELETE')).toBe(true);
        expect(fetchMock.mock.calls.some(([url, init]) =>
            String(url).includes('/git/refs/tags/sully-backup-v2-') && init?.method === 'DELETE')).toBe(true);
    });

    it('全部附件校驗成功後寫完成標記併發布 Release', async () => {
        let assetId = 100;
        const uploadedNames: string[] = [];
        class SuccessfulUploadXhr {
            status = 0;
            responseText = '';
            timeout = 0;
            upload: { onprogress?: (event: ProgressEvent) => void } = {};
            onload?: () => void;
            onerror?: () => void;
            onabort?: () => void;
            ontimeout?: () => void;
            private url = '';
            open(_method: string, url: string) { this.url = url; }
            setRequestHeader() {}
            getAllResponseHeaders() { return 'Content-Type: application/json\r\n'; }
            send(body: Blob) {
                this.status = 201;
                const name = new URL(this.url).searchParams.get('name') || '';
                uploadedNames.push(name);
                this.responseText = JSON.stringify({
                    id: assetId++,
                    name,
                    size: body.size,
                    state: 'uploaded',
                });
                this.onload?.();
            }
        }
        vi.stubGlobal('XMLHttpRequest', SuccessfulUploadXhr as any);

        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/releases') && init?.method === 'POST') {
                const body = JSON.parse(String(init.body));
                expect(body.draft).toBe(true);
                expect(body.tag_name).toMatch(/^sully-backup-v2-/);
                return Promise.resolve(new Response(JSON.stringify({ id: 88 }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (url.endsWith('/releases/88') && init?.method === 'PATCH') {
                const body = JSON.parse(String(init.body));
                expect(body.draft).toBe(false);
                return Promise.resolve(new Response(JSON.stringify({ id: 88, draft: false }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }));
            }
            throw new Error(`unexpected request: ${init?.method} ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await uploadBackup(config, new Blob(['zip']), 'Sully_Backup_full_2.zip');

        expect(result).toMatchObject({ ok: true });
        expect(uploadedNames).toContain('Sully_Backup_full_2.zip');
        expect(uploadedNames.some(name => name.endsWith('.sully-backup.json'))).toBe(true);
        expect(fetchMock.mock.calls.some(([url, init]) =>
            String(url).endsWith('/releases/88') && init?.method === 'PATCH')).toBe(true);
    });
});
