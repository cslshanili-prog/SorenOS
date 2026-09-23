/**
 * 一鍵部署裡那幾個「錯了會靜默出事」的地方。
 *
 * 都是踩過或者一眼能看出會踩的坑：密鑰漏一條 worker 直接 503、compat flag 少一個
 * 角色調工具就 1042、重裝換掉 Master Key 之前排的任務全解不開。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    parseWranglerConfig,
    buildBindings,
    deriveWorkerUrl,
    explainCfError,
    validateSubdomain,
    generateAmsgSecrets,
    scriptNameFromWorkerUrl,
    verifyToken,
    isAccountScopedToken,
    uploadWorkerScript,
    ensureSubdomain,
    type AmsgSecrets,
} from './cfProvision';

const FULL_SECRETS: AmsgSecrets = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_PUBLIC_KEY: 'pub-key',
    VAPID_PRIVATE_KEY: 'priv-key',
    VAPID_EMAIL: 'mailto:someone@example.com',
    AMSG_SERVER_TOKEN: 'server-token',
};

describe('parseWranglerConfig', () => {
    it('認得倉庫裡那份真的 wrangler.toml，不走兜底', () => {
        const toml = readFileSync(resolve(__dirname, '../worker/amsg/wrangler.toml'), 'utf8');
        const config = parseWranglerConfig(toml);

        // 少了這個 flag，角色到點調自配 MCP 會被當成內網調用拒掉（1042）
        expect(config.compatibilityFlags).toContain('global_fetch_strictly_public');
        // cron 是主動消息唯一的觸發方式
        expect(config.crons).toEqual(['* * * * *']);
        expect(config.d1Binding).toBe('DB');
        expect(config.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('註釋不會被當成配置讀進來', () => {
        const config = parseWranglerConfig(
            [
                '# compatibility_date = "1999-01-01"',
                'compatibility_date = "2026-01-01"  # 真正生效的是這行',
            ].join('\n'),
        );
        expect(config.compatibilityDate).toBe('2026-01-01');
    });

    it('讀不出來的項各自回落到兜底值，不返回半份配置', () => {
        const config = parseWranglerConfig('name = "whatever"');

        expect(config.compatibilityFlags).toContain('global_fetch_strictly_public');
        expect(config.crons).toEqual(['* * * * *']);
        expect(config.d1Binding).toBe('DB');
    });

    it('頂層的 binding 鍵不會被誤當成 D1 的 binding', () => {
        const config = parseWranglerConfig(
            ['binding = "NOT_THE_D1_ONE"', '', '[[d1_databases]]', 'binding = "REAL_DB"'].join('\n'),
        );
        expect(config.d1Binding).toBe('REAL_DB');
    });
});

describe('buildBindings', () => {
    it('D1 用 CF 要的 {type,name,id} 形狀', () => {
        const bindings = buildBindings('DB', 'db-uuid-1234', FULL_SECRETS);
        expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'db-uuid-1234' });
    });

    /**
     * 迴歸守衛：新部署必須自帶即時對話的起跳器。
     *
     * 漏了它，裝出來的 Worker 一發即時對話就 503（instantChat 認的就是這個 binding），
     * 而用戶剛走完一鍵部署，界面上一切正常，只會以為是功能壞了。
     */
    it('自帶 INSTANT_TICK 的 Durable Object binding', () => {
        const bindings = buildBindings('DB', 'x', FULL_SECRETS);
        expect(bindings).toContainEqual({
            type: 'durable_object_namespace',
            name: 'INSTANT_TICK',
            class_name: 'InstantTickDO',
        });
    });

    it('五個密鑰一條不落——漏一條上去 worker 就起不來', () => {
        const bindings = buildBindings('DB', 'x', FULL_SECRETS);
        const names = bindings.filter((b) => b.type === 'secret_text').map((b) => b.name);

        expect(names).toEqual(
            expect.arrayContaining([
                'AMSG_MASTER_KEY',
                'VAPID_PUBLIC_KEY',
                'VAPID_PRIVATE_KEY',
                'VAPID_EMAIL',
                'AMSG_SERVER_TOKEN',
            ]),
        );
    });

    it('空密鑰不寫進去：塞空串等於開了一道永遠對不上的門', () => {
        const bindings = buildBindings('DB', 'x', {
            ...FULL_SECRETS,
            AMSG_SERVER_TOKEN: '',
            VAPID_EMAIL: '   ',
        });
        const names = bindings.map((b) => b.name);

        expect(names).not.toContain('AMSG_SERVER_TOKEN');
        expect(names).not.toContain('VAPID_EMAIL');
        expect(names).toContain('AMSG_MASTER_KEY');
    });

    it('額外的項（自更新要的 CF token）也走 secret，不是明文', () => {
        const bindings = buildBindings('DB', 'x', FULL_SECRETS, {
            CF_API_TOKEN: 'cf-token',
            CF_SCRIPT_NAME: 'sullyos-amsg',
        });
        const cfToken = bindings.find((b) => b.name === 'CF_API_TOKEN');

        expect(cfToken?.type).toBe('secret_text');
        expect(cfToken?.text).toBe('cf-token');
    });
});

describe('generateAmsgSecrets', () => {
    it('傳了已有的 Master Key 就原樣保留——換掉會讓之前排的任務全解不開', async () => {
        const existing = 'b'.repeat(64);
        const secrets = await generateAmsgSecrets({ AMSG_MASTER_KEY: existing });

        expect(secrets.AMSG_MASTER_KEY).toBe(existing);
    });

    it('傳了已有的 VAPID 就原樣保留——換掉之前的推送訂閱會全部 403', async () => {
        const secrets = await generateAmsgSecrets({
            VAPID_PUBLIC_KEY: 'old-pub',
            VAPID_PRIVATE_KEY: 'old-priv',
        });

        expect(secrets.VAPID_PUBLIC_KEY).toBe('old-pub');
        expect(secrets.VAPID_PRIVATE_KEY).toBe('old-priv');
    });

    it('什麼都不傳就全新生成，Master Key 是 64 位 hex', async () => {
        const secrets = await generateAmsgSecrets();

        expect(secrets.AMSG_MASTER_KEY).toMatch(/^[0-9a-f]{64}$/);
        expect(secrets.VAPID_PUBLIC_KEY.length).toBeGreaterThan(80);
        expect(secrets.AMSG_SERVER_TOKEN).toBeTruthy();
    });

    it('兩次生成不會撞', async () => {
        const a = await generateAmsgSecrets();
        const b = await generateAmsgSecrets();

        expect(a.AMSG_MASTER_KEY).not.toBe(b.AMSG_MASTER_KEY);
        expect(a.VAPID_PUBLIC_KEY).not.toBe(b.VAPID_PUBLIC_KEY);
    });
});

describe('verifyToken', () => {
    /** 裝一個假的中轉，返回它收到的請求路徑。 */
    const stubRelay = (payload: unknown, status = 200) => {
        const paths: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const relayed = new URL(String(url)).searchParams.get('path');
            if (relayed) paths.push(relayed);
            return new Response(JSON.stringify(payload), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        }));
        return paths;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('還沒到生效日期的 token 要攔下來——CF 這時照樣回 success:true', async () => {
        // 放過去的話，後面每一步都收到通用的 Authentication error，會被歸成
        // 「權限不夠」，用戶跑去改權限，可那根本不是原因。真機上踩過一次。
        stubRelay({
            success: true,
            result: { id: 'x', status: 'active', not_before: '2026-08-10T00:00:00Z' },
            messages: [{ code: 10002, message: 'This API Token can not be used before 2026-08-10' }],
        });

        const result = await verifyToken('plain-token');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.code).toBe('TOKEN_NOT_YET_VALID');
            expect(result.message).toContain('2026-08-10');
        }
    });

    it('正常的 token 放行', async () => {
        stubRelay({ success: true, result: { id: 'x', status: 'active' }, messages: [] });

        expect((await verifyToken('plain-token')).ok).toBe(true);
    });

    it('帳號令牌當場說清楚該換哪種，而不是拿用戶級端點去撞 401', async () => {
        // cfat_ 打 /user/tokens/verify 必然 1000，報錯原文只會說 Invalid API Token，
        // 用戶對著那句話查不出「你建錯了種類」。
        const paths = stubRelay({ success: true });

        const result = await verifyToken('cfat_abcdef');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.code).toBe('TOKEN_INVALID');
            expect(result.message).toContain('API Tokens');
        }
        // 一次網絡都不該發
        expect(paths).toHaveLength(0);
    });

    it('普通 token 走用戶級端點', async () => {
        const paths = stubRelay({ success: true, result: { status: 'active' }, messages: [] });

        await verifyToken('plain-token');

        expect(paths).toEqual(['/user/tokens/verify']);
    });

    it('認得出帳號令牌的前綴', () => {
        expect(isAccountScopedToken('cfat_abc')).toBe(true);
        expect(isAccountScopedToken('  cfat_abc  ')).toBe(true);
        expect(isAccountScopedToken('abcdef123')).toBe(false);
    });
});

describe('uploadWorkerScript', () => {
    /**
     * 裝一個假的中轉，按次序吐響應，並把每次上傳的 metadata 記下來。
     */
    const stubUploadRelay = (responses: Array<{ status: number; payload: unknown }>) => {
        const metadatas: Array<Record<string, unknown>> = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            const form = init?.body as FormData;
            const metaBlob = form.get('metadata') as Blob;
            metadatas.push(JSON.parse(await metaBlob.text()));
            const next = responses[Math.min(metadatas.length - 1, responses.length - 1)];
            return new Response(JSON.stringify(next.payload), {
                status: next.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }));
        return metadatas;
    };

    const FRESH_METADATA = {
        main_module: 'worker.bundle.js',
        bindings: [{ type: 'durable_object_namespace', name: 'INSTANT_TICK', class_name: 'InstantTickDO' }],
        migrations: { new_tag: 'amsg-instant-tick-v1', new_sqlite_classes: ['InstantTickDO'] },
    };

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    /**
     * 迴歸守衛：對著已經裝過的 Worker 重裝（清了地址重跑、換設備再部署）。
     *
     * metadata 裡的 migrations 斷言「全新部署」，這時 CF 會回 10079 樂觀鎖衝突把整次
     * 上傳頂回來——修法是去掉 migrations 重傳（namespace 本來就在），binding 原樣保留。
     */
    it('撞上 10079 就去掉 migrations 重傳一次，並標記這是覆蓋更新', async () => {
        const metadatas = stubUploadRelay([
            {
                status: 400,
                payload: {
                    success: false,
                    errors: [{ code: 10079, message: "Actor migration tag precondition failed, got tag '' when expected tag is 'amsg-instant-tick-v1'." }],
                },
            },
            { status: 200, payload: { success: true, result: {} } },
        ]);

        const result = await uploadWorkerScript('tok', 'acct', 'sullyos-amsg', FRESH_METADATA, 'export default {}');

        expect(result.ok).toBe(true);
        expect(result.reusedExistingWorker).toBe(true);
        expect(metadatas).toHaveLength(2);
        expect(metadatas[1].migrations).toBeUndefined();
        // 只該去掉 migrations，binding 等其餘字段原樣保留
        expect(metadatas[1].bindings).toEqual(metadatas[0].bindings);
        expect(metadatas[1].main_module).toBe(metadatas[0].main_module);
    });

    it('全新部署一次成功就不重試，也不標記覆蓋更新', async () => {
        const metadatas = stubUploadRelay([{ status: 200, payload: { success: true, result: {} } }]);

        const result = await uploadWorkerScript('tok', 'acct', 'sullyos-amsg', FRESH_METADATA, 'export default {}');

        expect(result.ok).toBe(true);
        expect(result.reusedExistingWorker).toBeUndefined();
        expect(metadatas).toHaveLength(1);
    });

    it('其他錯誤不套這個重試——盲目去掉 migrations 只會把真錯誤拖成兩次', async () => {
        const metadatas = stubUploadRelay([
            {
                status: 400,
                payload: { success: false, errors: [{ code: 10037, message: 'workers limit reached' }] },
            },
        ]);

        const result = await uploadWorkerScript('tok', 'acct', 'sullyos-amsg', FRESH_METADATA, 'export default {}');

        expect(result.ok).toBe(false);
        expect(metadatas).toHaveLength(1);
    });
});

describe('explainCfError', () => {
    it('權限不夠時把要勾的三項列出來，而不是幹說 Unauthorized', () => {
        const msg = explainCfError(403, { errors: [{ code: 9109, message: 'Unauthorized' }] });

        expect(msg).toContain('Workers Scripts:Edit');
        expect(msg).toContain('D1:Edit');
        expect(msg).toContain('Account Settings:Read');
    });

    it('token 格式錯（多帶了空格換行）單獨提示', () => {
        const msg = explainCfError(400, { errors: [{ code: 6111, message: 'Invalid format' }] });
        expect(msg).toContain('空格');
    });

    it('認不出來的錯至少把 CF 的原話帶上', () => {
        const msg = explainCfError(500, { errors: [{ code: 12345, message: 'Something odd' }] });
        expect(msg).toContain('Something odd');
    });

    // 下面三條釘住「翻譯之外一定留原文」。翻譯是兜底猜的，猜錯時用戶得有東西可查——
    // 尤其 401/403 那條：不留原文的話，中轉層和 WAF 的 403 都長得跟「token 缺權限」
    // 一模一樣，人會被指使著反覆去改一枚本來就沒問題的 token。
    it('權限提示後面帶著 CF 原文、code 和 HTTP 狀態', () => {
        const msg = explainCfError(403, { errors: [{ code: 9109, message: 'Unauthorized' }] });

        expect(msg).toContain('Unauthorized');
        expect(msg).toContain('9109');
        expect(msg).toContain('403');
    });

    it('中轉層自己回的 403 也要露出原話，別看著像 token 缺權限', () => {
        // 中轉的錯誤體是 { error }，不是 CF 的 errors 數組，得單獨撈。
        const msg = explainCfError(403, {
            error: 'This proxy only relays account-scoped Cloudflare API paths',
        });

        expect(msg).toContain('This proxy only relays');
    });

    it('響應根本不是 JSON 時，至少把 HTTP 狀態說出來', () => {
        const msg = explainCfError(403, null);

        expect(msg).toContain('403');
    });

    it('帶上出事的那個請求，認得出卡在哪一步', () => {
        const msg = explainCfError(403, null, 'POST /accounts/acc-1/d1/database');

        expect(msg).toContain('POST /accounts/acc-1/d1/database');
    });
});

describe('ensureSubdomain', () => {
    /** 按路徑派響應的假中轉，返回它收到的「方法 + 路徑」清單。 */
    const stubRelay = (
        handler: (path: string, method: string) => { payload: unknown; status?: number },
    ) => {
        const seen: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            const path = new URL(String(url)).searchParams.get('path') || '';
            const headers = (init?.headers || {}) as Record<string, string>;
            const method = headers['X-CF-Method'] || 'GET';
            seen.push(`${method} ${path}`);
            const { payload, status = 200 } = handler(path, method);
            return new Response(JSON.stringify(payload), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        }));
        return seen;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('帳號已經有子域名就直接用', async () => {
        stubRelay(() => ({ payload: { success: true, result: { subdomain: 'kaede' } } }));

        expect(await ensureSubdomain('tok', 'acc-1')).toEqual({ ok: true, subdomain: 'kaede' });
    });

    it('讀子域名被 403 時說權限，而不是請用戶再起一個名字', async () => {
        // 讀都讀不動，註冊那一步同樣過不去。當成新帳號勸人換名字，用戶會一直換下去。
        const seen = stubRelay(() => ({
            payload: { success: false, errors: [{ code: 9109, message: 'Unauthorized' }] },
            status: 403,
        }));

        const result = await ensureSubdomain('tok', 'acc-1', 'kaede');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.code).toBe('CF_ERROR');
            expect(result.error).toContain('Unauthorized');
        }
        // 註定失敗的註冊請求也不該發
        expect(seen).toEqual(['GET /accounts/acc-1/workers/subdomain']);
    });

    it('403 之外的讀失敗照舊當新帳號處理，別把還沒建過子域名的人堵死', async () => {
        const seen = stubRelay((_path, method) => (method === 'GET'
            ? { payload: { success: false, errors: [{ code: 10007, message: 'not found' }] }, status: 404 }
            : { payload: { success: true, result: {} } }));

        const result = await ensureSubdomain('tok', 'acc-1', 'kaede');

        expect(result).toEqual({ ok: true, subdomain: 'kaede' });
        expect(seen).toContain('PUT /accounts/acc-1/workers/subdomain');
    });
});

describe('scriptNameFromWorkerUrl', () => {
    it('workers.dev 地址認得出腳本名', () => {
        expect(scriptNameFromWorkerUrl('https://sullyos-amsg.kaede.workers.dev')).toBe('sullyos-amsg');
        expect(scriptNameFromWorkerUrl('https://sullyos-amsg.kaede.workers.dev/')).toBe('sullyos-amsg');
    });

    it('自定義域名和代理門面一律返回 null，不猜', () => {
        // 猜出來的名字會指向帳號裡另一個 Worker，把鑰匙寫到別人身上去。
        expect(scriptNameFromWorkerUrl('https://amsg.example.com')).toBeNull();
        expect(scriptNameFromWorkerUrl('https://my-proxy.deno.dev')).toBeNull();
        // 少一段：這是帳號子域本身，不是某個腳本
        expect(scriptNameFromWorkerUrl('https://kaede.workers.dev')).toBeNull();
    });

    it('填的不是地址時返回 null 而不是拋錯', () => {
        expect(scriptNameFromWorkerUrl('隨便寫的')).toBeNull();
        expect(scriptNameFromWorkerUrl('')).toBeNull();
    });
});

describe('deriveWorkerUrl / validateSubdomain', () => {
    it('地址是「腳本名.子域.workers.dev」', () => {
        expect(deriveWorkerUrl('sullyos-amsg', 'kaede')).toBe('https://sullyos-amsg.kaede.workers.dev');
    });

    it('合法子域放行', () => {
        expect(validateSubdomain('kaede-123')).toBeNull();
    });

    it('連字符開頭結尾、太短、帶大寫和非法字符都要擋下', () => {
        expect(validateSubdomain('-nope')).not.toBeNull();
        expect(validateSubdomain('nope-')).not.toBeNull();
        expect(validateSubdomain('ab')).not.toBeNull();
        expect(validateSubdomain('has_underscore')).not.toBeNull();
        expect(validateSubdomain('')).not.toBeNull();
    });
});
