/**
 * 自更新：在 SullyOS 裡點一下，worker 自己去取最新代碼覆蓋自己。
 *
 * 為什麼要有這個：後端有三條安裝路，更新體驗差得很遠——
 *   - 照手冊 fork 一份再連倉庫：GitHub 上點一下 Sync fork 就自動重新部署
 *   - 「Deploy to Cloudflare」按鈕：它給你的是 clone 出來的獨立倉庫、不是 fork，
 *     沒有 Sync fork 可點，只能自己往倉庫裡傳新的 worker.bundle.js
 *   - 找人代配：每次更新都得再找一次
 * 有了這條，三條路的更新都變成「在 SullyOS 裡點一下」，手機上尤其省事。
 *
 * 瀏覽器為什麼不能直接幹這事：api.cloudflare.com 不返回 CORS 頭，前端 fetch 一律被攔。
 * 而 worker 自己跑在 Cloudflare 上，調 API 沒這個問題，所以這活兒只能落在這一側。
 *
 * 安全上的三條底線：
 *   1. 必須配了共享密鑰並校驗通過才讓動——沒有密鑰的實例直接拒絕，不給「誰都能觸發」的口子
 *   2. 新代碼先校驗再上傳，任何一項不對就原樣不動（把自己刷掛了就沒法再自更新了）
 *   3. token 只出現在發往 Cloudflare 的請求頭裡，任何響應體都不回顯它
 */

import { constantTimeEqual } from './instantChat';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Soren 的成品代碼（SorenOS 倉庫 dev 分支），跟一鍵部署（utils/cfProvision.ts）拉的是同一份。 */
const BUNDLE_URL =
  'https://raw.githubusercontent.com/cslshanili-prog/SorenOS/dev/worker/amsg/worker.bundle.js';

/** 上傳時用的模塊名，同時也是 metadata.main_module，兩處必須一致。 */
const MAIN_MODULE = 'worker.bundle.js';

/** 兜底用的運行時配置，只在讀不到現有配置時才用，跟 wrangler.toml 保持一致。 */
const FALLBACK_COMPATIBILITY_DATE = '2026-01-01';
const FALLBACK_COMPATIBILITY_FLAGS = ['global_fetch_strictly_public'];

/** 成品包實測 400 KB 出頭。低於這個數基本就是拿到錯誤頁了。 */
const MIN_BUNDLE_BYTES = 100 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** 成品包必須帶的導出標記，用來認「這確實是 amsg 的 worker」。 */
const BUNDLE_FINGERPRINT = 'src_default as default';

export interface SelfUpdateEnv {
  AMSG_SERVER_TOKEN?: string;
  /** Cloudflare API Token，只需要 Workers Scripts → Edit。沒配就用不了自更新。 */
  CF_API_TOKEN?: string;
  /** 可選：不配就拿 token 去問 Cloudflare。只有一個帳號時能問出來。 */
  CF_ACCOUNT_ID?: string;
  /** 可選：不配就從 workers.dev 域名反推。套了代理域名時必須配。 */
  CF_SCRIPT_NAME?: string;
}

export interface SelfUpdateResult {
  ok: boolean;
  code: string;
  message: string;
  /** 新代碼的指紋（sha-256 前 12 位），給前端顯示「現在跑的是哪一版」。 */
  bundleHash?: string;
  bundleBytes?: number;
  scriptName?: string;
}

const fail = (code: string, message: string): SelfUpdateResult => ({ ok: false, code, message });

/**
 * 調 Cloudflare API，把 {success, errors, result} 那層信封拆掉。
 *
 * body 傳 FormData 就是上傳腳本那種 multipart；傳字符串是 JSON 體，這時要自己帶上
 * `Content-Type: application/json`（見 ./cronTrigger 改定時觸發那一發）。
 */
export async function cf(
  token: string,
  path: string,
  init: { method?: string; body?: FormData | string; headers?: Record<string, string> } = {},
): Promise<{ ok: true; result: any } | { ok: false; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${CF_API}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      body: init.body,
    });
  } catch (err) {
    return { ok: false, detail: `連不上 Cloudflare API：${(err as Error).message}` };
  }

  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, detail: `Cloudflare 返回了非 JSON（HTTP ${res.status}）` };
  }
  if (!res.ok || payload?.success === false) {
    const detail =
      (payload?.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join('；') ||
      `HTTP ${res.status}`;
    return { ok: false, detail };
  }
  return { ok: true, result: payload.result };
}

/**
 * 上傳時要帶上的實時日誌開關。
 *
 * **不帶就等於關掉**：上傳是整體覆蓋，metadata 裡沒有 observability 的話，重傳一次
 * 之前開著的日誌就沒了（實測確認過）。而排障恰恰是更新之後最可能需要日誌的時候。
 *
 * 傳入的是上傳前讀回來的那份，原樣帶上；讀不到就按開啟兜底（倉庫裡的 wrangler.toml
 * 聲明的就是開）。
 *
 * 注：官方的 multipart-upload-metadata 文檔沒把 observability 列進合法字段，但實測
 * 是認的——上傳 enabled:false 能關掉、enabled:true 能開起來、不帶就沒有，三向都驗過。
 */
export function resolveObservability(existing: unknown): Record<string, unknown> {
  const current = existing as { enabled?: boolean } | null | undefined;
  if (current && typeof current.enabled === 'boolean') return current as Record<string, unknown>;
  return { enabled: true, logs: { enabled: true } };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 定位「我是誰」。
 *
 * 域名反推只在 *.workers.dev 上成立：國內套了 Deno 門面之後請求進來時掛的是代理域名，
 * 照著推會得出一個不存在的 worker 名，那就必須讓 CF_SCRIPT_NAME 說了算。
 */
export function resolveScriptName(env: SelfUpdateEnv, requestUrl: string): string | null {
  const configured = env.CF_SCRIPT_NAME?.trim();
  if (configured) return configured;
  let host: string;
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith('.workers.dev')) return null;
  const name = host.split('.')[0];
  return name || null;
}

/**
 * 找出「我住在哪個帳號下」，順帶把這個帳號的配置讀回來。
 *
 * `GET /accounts` 是用戶級端點，返回的是這個人名下的**所有**帳號，跟 token 限定了哪個帳號
 * 沒關係。所以同時有工作號和個人號的人在這兒會拿到好幾條，光看列表分不出該更新哪個。
 * 辦法是挨個問一句「你這兒有沒有這個 Worker」——能讀出配置的那個就是。
 */
export async function locateScript(
  env: SelfUpdateEnv,
  token: string,
  scriptName: string,
): Promise<{ ok: true; accountId: string; settings: any } | { ok: false; message: string }> {
  const settingsPath = (accountId: string) =>
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`;

  const configured = env.CF_ACCOUNT_ID?.trim();
  if (configured) {
    const settings = await cf(token, settingsPath(configured));
    if (!settings.ok) {
      return {
        ok: false,
        message: `在 CF_ACCOUNT_ID 指定的帳號裡讀不到這個 Worker 的配置（${settings.detail}）。`,
      };
    }
    return { ok: true, accountId: configured, settings: settings.result };
  }

  const listed = await cf(token, '/accounts');
  if (!listed.ok) {
    return {
      ok: false,
      message: `問不到帳號列表（${listed.detail}）。給 Worker 加一條 CF_ACCOUNT_ID 變量即可跳過這一步。`,
    };
  }
  const accounts: any[] = Array.isArray(listed.result) ? listed.result : [];
  if (!accounts.length) {
    return { ok: false, message: '這枚 token 一個帳號都讀不到，多半是權限沒給全或者已經過期。' };
  }

  for (const account of accounts) {
    const settings = await cf(token, settingsPath(account.id));
    if (settings.ok) return { ok: true, accountId: account.id, settings: settings.result };
  }
  return {
    ok: false,
    message:
      `在這枚 token 能碰到的 ${accounts.length} 個帳號裡都沒找到名為 ${scriptName} 的 Worker。` +
      '要麼 token 的權限沒覆蓋到它所在的帳號，要麼 Worker 名字對不上（可用 CF_SCRIPT_NAME 指定）。',
  };
}

/** 取回最新成品包，並確認它確實是 amsg 的 worker 而不是一張錯誤頁。 */
async function fetchLatestBundle(): Promise<
  { ok: true; code: string } | { ok: false; message: string }
> {
  let res: Response;
  try {
    res = await fetch(BUNDLE_URL, { headers: { 'User-Agent': 'sullyos-amsg-self-update' } });
  } catch (err) {
    return { ok: false, message: `取不到最新代碼：${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, message: `取最新代碼失敗（HTTP ${res.status}）` };

  const code = await res.text();
  const bytes = new TextEncoder().encode(code).length;
  if (bytes < MIN_BUNDLE_BYTES || bytes > MAX_BUNDLE_BYTES) {
    return { ok: false, message: `取回來的文件大小不對（${bytes} 字節），沒有覆蓋，當前版本不動。` };
  }
  if (!code.includes(BUNDLE_FINGERPRINT)) {
    return { ok: false, message: '取回來的文件不像 amsg 的 worker 代碼，沒有覆蓋，當前版本不動。' };
  }
  return { ok: true, code };
}

/**
 * 把現有 binding 原樣搬到新版本上。
 *
 * Cloudflare 的上傳接口是整體替換：這一發沒帶的 binding 等於刪掉。D1 那條能從接口原樣讀回，
 * 但密鑰只回名字不回值——值得從 env 裡補。補不齊就中止，不能帶著殘缺的 binding 上傳，
 * 那等於把用戶的密鑰抹了。
 */
export function rebuildBindings(
  existing: any[],
  env: Record<string, unknown>,
): { ok: true; bindings: any[] } | { ok: false; missing: string[] } {
  const bindings: any[] = [];
  const missing: string[] = [];

  for (const binding of existing) {
    if (binding?.type === 'secret_text') {
      const value = env[binding.name];
      if (typeof value !== 'string' || !value) {
        missing.push(binding.name);
        continue;
      }
      bindings.push({ type: 'secret_text', name: binding.name, text: value });
    } else {
      bindings.push(binding);
    }
  }

  if (missing.length) return { ok: false, missing };
  return { ok: true, bindings };
}

// ─── 即時對話的 Durable Object ───

/** 起跳器的 binding 名與類名，跟 wrangler.toml、index.ts 的 InstantTickDO 三處對齊。 */
const INSTANT_TICK_BINDING = 'INSTANT_TICK';
const INSTANT_TICK_CLASS = 'InstantTickDO';
/** 建這個 namespace 用的 migration tag；只在首次創建時發一次，見 buildDurableObjectPlan。 */
const INSTANT_TICK_MIGRATION_TAG = 'amsg-instant-tick-v1';

export interface DurableObjectPlan {
  /** 要補進 bindings 的那條；已經有了就是 null。 */
  binding: { type: string; name: string; class_name: string } | null;
  /** metadata.migrations 的值；不需要動 migration 時是 null（字段整個不帶）。 */
  migrations: { new_tag: string; new_sqlite_classes: string[] } | null;
}

/**
 * 算出這次上傳要不要建 Durable Object namespace。
 *
 * Cloudflare 的 migrations 字段是**帶樂觀鎖的**：不給 `old_tag` 等於斷言「這個 Worker
 * 現在一個 migration 都沒應用過」。所以它不能每次都原樣重傳——第二次就會撞上
 * `10079 Actor migration tag precondition failed, got tag '' when expected tag is
 * 'xxx'`，把整個自更新搞失敗（2026-08-09 實測確認）。
 *
 * 於是按「現有 binding 裡有沒有它」分流：
 *   - 沒有 → 這是第一次，帶 migrations 把 namespace 建出來，同時補上 binding；
 *   - 已有 → 完全不帶 migrations，binding 原樣傳即可（實測這樣上傳成功，
 *     migration_tag 保持不變，DO 類也還在）。
 *
 * 另注：API 的 migrations 是**一個對象**，不是 wrangler.toml 裡那種數組——傳數組會被
 * 頂回來（`10021 cannot unmarshal array into ... ActorMigrations`）。
 */
export function buildDurableObjectPlan(existing: any[]): DurableObjectPlan {
  const already = existing.some(
    (binding) => binding?.type === 'durable_object_namespace' && binding?.name === INSTANT_TICK_BINDING,
  );
  if (already) return { binding: null, migrations: null };
  return {
    binding: {
      type: 'durable_object_namespace',
      name: INSTANT_TICK_BINDING,
      class_name: INSTANT_TICK_CLASS,
    },
    migrations: { new_tag: INSTANT_TICK_MIGRATION_TAG, new_sqlite_classes: [INSTANT_TICK_CLASS] },
  };
}

export async function handleSelfUpdate(
  request: Request,
  env: SelfUpdateEnv,
): Promise<SelfUpdateResult> {
  // ① 沒設共享密鑰的實例一律不給自更新：那種實例的地址等於全公開，
  //    留這個口子相當於誰都能讓別人的後端重新部署一次。
  const serverToken = env.AMSG_SERVER_TOKEN?.trim();
  if (!serverToken) {
    return fail(
      'SERVER_TOKEN_REQUIRED',
      '這個 Worker 沒設共享密鑰（AMSG_SERVER_TOKEN），出於安全考慮不開放自更新。先補上再試。',
    );
  }
  // 常時比較：這個端點能讓 worker 覆蓋自己的代碼，密鑰校驗不能從耗時上漏字。
  const clientToken = request.headers.get('X-Client-Token');
  if (!clientToken || !(await constantTimeEqual(clientToken, serverToken))) {
    return fail('UNAUTHORIZED', '共享密鑰對不上。');
  }

  const token = env.CF_API_TOKEN?.trim();
  if (!token) {
    return fail(
      'CF_TOKEN_MISSING',
      '沒配 CF_API_TOKEN，沒法自己更新。去 Cloudflare 建一枚只勾 Workers Scripts → Edit 的 API Token，加進這個 Worker 的變量裡。',
    );
  }

  const scriptName = resolveScriptName(env, request.url);
  if (!scriptName) {
    return fail(
      'SCRIPT_NAME_UNKNOWN',
      '認不出這個 Worker 叫什麼（多半是套了代理域名）。給它加一條 CF_SCRIPT_NAME 變量，值填 Worker 的名字。',
    );
  }

  // ② 定位自己住在哪個帳號下，同時把現有配置讀回來：binding、兼容性日期都照搬，
  //    免得自更新順手改了運行時行為。
  const located = await locateScript(env, token, scriptName);
  if (!located.ok) return fail('SCRIPT_NOT_LOCATED', located.message);
  const account = { id: located.accountId };
  const settings = { result: located.settings };

  // ③ 新代碼先拿到手並驗明正身，再碰線上的東西。
  const bundle = await fetchLatestBundle();
  if (!bundle.ok) return fail('BUNDLE_INVALID', bundle.message);

  // 密鑰的名字要到運行時才知道（讀回來的 binding 列表說了算），所以這裡按名取值，
  // 類型上就只能當成一袋 key-value 看。
  const rebuilt = rebuildBindings(
    settings.result?.bindings ?? [],
    env as unknown as Record<string, unknown>,
  );
  if (!rebuilt.ok) {
    return fail(
      'BINDING_VALUE_MISSING',
      `這幾項密鑰在運行時讀不到值：${rebuilt.missing.join('、')}。` +
        '照原樣傳上去會把它們抹掉，所以沒有覆蓋，當前版本不動。',
    );
  }

  // 即時對話的起跳器：老 Worker 上還沒有，這一發順手把它建出來（見 buildDurableObjectPlan）。
  const doPlan = buildDurableObjectPlan(settings.result?.bindings ?? []);
  if (doPlan.binding) {
    console.log('[amsg:self-update] 這台 Worker 還沒有 INSTANT_TICK，本次上傳一併創建');
  }

  const metadata = {
    main_module: MAIN_MODULE,
    compatibility_date: settings.result?.compatibility_date || FALLBACK_COMPATIBILITY_DATE,
    compatibility_flags: settings.result?.compatibility_flags?.length
      ? settings.result.compatibility_flags
      : FALLBACK_COMPATIBILITY_FLAGS,
    bindings: doPlan.binding ? [...rebuilt.bindings, doPlan.binding] : rebuilt.bindings,
    // 不帶這一項等於把實時日誌關掉（上傳是整體覆蓋）。原樣帶上讀回來的那份。
    observability: resolveObservability(settings.result?.observability),
    // 已經建過就整個字段不帶：它帶樂觀鎖，重傳會被頂回來。
    ...(doPlan.migrations ? { migrations: doPlan.migrations } : {}),
  };

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    MAIN_MODULE,
    new Blob([bundle.code], { type: 'application/javascript+module' }),
    MAIN_MODULE,
  );

  // ④ 覆蓋自己。這一刻之後的請求就走新代碼了，本次響應仍由舊代碼發出。
  const uploaded = await cf(
    token,
    `/accounts/${account.id}/workers/scripts/${encodeURIComponent(scriptName)}`,
    { method: 'PUT', body: form },
  );
  if (!uploaded.ok) {
    return fail('UPLOAD_FAILED', `上傳失敗（${uploaded.detail}）。當前版本不動。`);
  }

  const hash = (await sha256Hex(bundle.code)).slice(0, 12);
  const bytes = new TextEncoder().encode(bundle.code).length;
  return {
    ok: true,
    code: 'UPDATED',
    message: '已經更新到最新版本。',
    bundleHash: hash,
    bundleBytes: bytes,
    scriptName,
  };
}
