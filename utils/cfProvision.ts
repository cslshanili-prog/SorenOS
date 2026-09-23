/**
 * 一鍵部署主動消息後端：用戶只提供一枚 Cloudflare API Token，剩下的全在這裡做完。
 *
 * 做的事按順序是：驗 token → 找出能用的帳號 → 建 D1 → 確認 workers.dev 子域 →
 * 拉最新 bundle → 上傳 Worker（密鑰和 D1 綁定一次帶齊）→ 加 cron → 開 workers.dev。
 * 密鑰（Master Key / VAPID / Server Token）在瀏覽器本地生成，用戶全程不用複製粘貼。
 *
 * 為什麼要繞一層代理：api.cloudflare.com 一個 CORS 頭都不返回，瀏覽器直接調不通，
 * 所有請求都得過中心 worker 的 /cf-api（見 worker/index.js）。
 *
 * 跟「更新後端」的分工：那條路是 worker 拿自己 env 裡的 token 覆蓋自己
 * （worker/amsg/src/selfUpdate.ts），能保住密鑰；這裡是從零裝，密鑰是新生成的。
 */

import { getProxyWorkerUrl } from './proxyWorker';
import { generateVapidKeyPair, generateClientToken } from './vapidGen';

/** 部署出來的 Worker / D1 默認叫這個，跟 worker/amsg/wrangler.toml 對齊。 */
export const AMSG_SCRIPT_NAME = 'sullyos-amsg';
export const AMSG_D1_NAME = 'sullyos-amsg';

/** 上傳時的模塊名，同時是 metadata.main_module，兩處必須一致。 */
const MAIN_MODULE = 'worker.bundle.js';

const BUNDLE_BASE = 'https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg';
const BUNDLE_URL = `${BUNDLE_BASE}/${MAIN_MODULE}`;
const WRANGLER_URL = `${BUNDLE_BASE}/wrangler.toml`;

/**
 * 讀不到線上 wrangler.toml 時用的兜底，值抄自 worker/amsg/wrangler.toml。
 * 正常路徑是現拉現解析，免得這邊的常量和 worker 那邊慢慢漂開——
 * compatibility_flags 少一個 global_fetch_strictly_public，角色調自配 MCP 就會 1042。
 */
const FALLBACK_CONFIG: WorkerDeployConfig = {
  compatibilityDate: '2026-01-01',
  compatibilityFlags: ['global_fetch_strictly_public'],
  crons: ['* * * * *'],
  d1Binding: 'DB',
};

/** bundle 的合理體積區間。太小多半是拉到了 404 頁面，太大是打包出了岔子。 */
const MIN_BUNDLE_BYTES = 100 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface WorkerDeployConfig {
  compatibilityDate: string;
  compatibilityFlags: string[];
  crons: string[];
  d1Binding: string;
}

export interface CfAccount {
  id: string;
  name: string;
}

export type ProvisionStepId =
  | 'relay'
  | 'token'
  | 'account'
  | 'database'
  | 'subdomain'
  | 'bundle'
  | 'upload'
  | 'cron'
  | 'expose'
  | 'done';

export interface ProvisionProgress {
  step: ProvisionStepId;
  message: string;
}

export interface AmsgSecrets {
  AMSG_MASTER_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_EMAIL: string;
  AMSG_SERVER_TOKEN: string;
}

export interface ProvisionInput {
  token: string;
  /** 多帳號時由界面選定；只有一個能用就自動選。 */
  accountId?: string;
  /** 帳號還沒有 workers.dev 子域時，由界面問出來再傳進來。 */
  desiredSubdomain?: string;
  scriptName?: string;
  /**
   * D1 庫名。跟 scriptName 一樣默認 sullyos-amsg，兩個都能改是為了在同一個帳號裡
   * 裝第二套時不會撞上——尤其別讓新實例靜默綁到已有實例的生產庫上。
   */
  databaseName?: string;
  /** 複用已有密鑰（重裝時傳，避免換掉 Master Key 讓舊任務解不開）。 */
  secrets?: Partial<AmsgSecrets>;
  onProgress?: (p: ProvisionProgress) => void;
}

export type ProvisionFailureCode =
  | 'RELAY_UNSUPPORTED'
  | 'TOKEN_INVALID'
  | 'TOKEN_NOT_YET_VALID'
  | 'SCRIPT_NAME_UNKNOWN'
  | 'SCRIPT_NOT_FOUND'
  | 'NO_USABLE_ACCOUNT'
  | 'ACCOUNT_AMBIGUOUS'
  | 'SUBDOMAIN_MISSING'
  | 'SUBDOMAIN_TAKEN'
  | 'BUNDLE_INVALID'
  | 'SCRIPT_EXISTS'
  | 'UPLOAD_FAILED'
  | 'CF_ERROR'
  | 'NETWORK';

export interface ProvisionFailure {
  ok: false;
  code: ProvisionFailureCode;
  message: string;
  /** ACCOUNT_AMBIGUOUS 時給界面挑。 */
  accounts?: CfAccount[];
}

export interface ProvisionSuccess {
  ok: true;
  workerUrl: string;
  scriptName: string;
  accountId: string;
  databaseId: string;
  /** 用的是已經存在的同名數據庫（不是新建的），界面要提醒一句。 */
  reusedDatabase: boolean;
  secrets: AmsgSecrets;
  /** observability 是盡力而為，沒開成不影響功能，但值得說一聲。 */
  warnings: string[];
}

export type ProvisionResult = ProvisionSuccess | ProvisionFailure;

// ---------------------------------------------------------------------------
// 純函數部分（可單測，不碰網絡）
// ---------------------------------------------------------------------------

/**
 * 從 wrangler.toml 裡挑出部署要用的四項。不是通用 TOML 解析器，只認這幾個鍵；
 * 任何一項沒匹配上就用兜底值，絕不返回半份配置——少一個 compat flag 比整個失敗更難查。
 */
export function parseWranglerConfig(toml: string): WorkerDeployConfig {
  const stripComments = (line: string) => line.replace(/#.*$/, '').trim();
  const lines = toml.split('\n').map(stripComments);

  const findScalar = (key: string): string | null => {
    for (const line of lines) {
      const m = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`));
      if (m) return m[1];
    }
    return null;
  };
  const findArray = (key: string): string[] | null => {
    for (const line of lines) {
      const m = line.match(new RegExp(`^${key}\\s*=\\s*\\[(.*)\\]$`));
      if (!m) continue;
      const items = m[1]
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      return items;
    }
    return null;
  };

  // binding 名在 [[d1_databases]] 段裡，跟頂層的同名鍵區分開：取該段之後第一個 binding。
  let d1Binding: string | null = null;
  const d1SectionIdx = lines.findIndex((l) => l === '[[d1_databases]]');
  if (d1SectionIdx >= 0) {
    for (let i = d1SectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('[')) break;
      const m = lines[i].match(/^binding\s*=\s*"([^"]*)"$/);
      if (m) {
        d1Binding = m[1];
        break;
      }
    }
  }

  return {
    compatibilityDate: findScalar('compatibility_date') || FALLBACK_CONFIG.compatibilityDate,
    compatibilityFlags: findArray('compatibility_flags') || FALLBACK_CONFIG.compatibilityFlags,
    crons: findArray('crons') || FALLBACK_CONFIG.crons,
    d1Binding: d1Binding || FALLBACK_CONFIG.d1Binding,
  };
}

/**
 * 即時對話起跳器的 binding 名 / 類名 / 建庫用的 migration tag。
 *
 * 三處必須跟 worker 側對齊：`worker/amsg/wrangler.toml`、`worker/amsg/src/index.ts`
 * 裡的 `InstantTickDO`、以及 `selfUpdate.ts`（老 Worker 更新時補建走那條）。
 */
const INSTANT_TICK_BINDING = 'INSTANT_TICK';
const INSTANT_TICK_CLASS = 'InstantTickDO';
export const INSTANT_TICK_MIGRATIONS = {
  new_tag: 'amsg-instant-tick-v1',
  new_sqlite_classes: [INSTANT_TICK_CLASS],
};

/**
 * 拼上傳用的 bindings。D1 一條 + Durable Object 一條 + 每個非空密鑰一條。
 *
 * 空值一律不寫：Cloudflare 會原樣收下空字符串，而 worker 側
 * 「配了 AMSG_SERVER_TOKEN 就強制校驗 X-Client-Token」判斷的是有沒有這一項——
 * 塞個空串進去，等於打開了一道永遠對不上的門。
 *
 * Durable Object 不用先建資源：namespace 會隨這次上傳一起創建（靠 metadata 裡的
 * migrations，見 INSTANT_TICK_MIGRATIONS），不像 D1 要先調一次建庫接口拿 id。
 */
export function buildBindings(
  d1Binding: string,
  databaseId: string,
  secrets: AmsgSecrets,
  extras: Record<string, string> = {},
): Array<Record<string, string>> {
  const bindings: Array<Record<string, string>> = [
    { type: 'd1', name: d1Binding, id: databaseId },
    { type: 'durable_object_namespace', name: INSTANT_TICK_BINDING, class_name: INSTANT_TICK_CLASS },
  ];
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value.trim()) {
      bindings.push({ type: 'secret_text', name, text: value });
    }
  }
  for (const [name, value] of Object.entries(extras)) {
    if (typeof value === 'string' && value.trim()) {
      bindings.push({ type: 'secret_text', name, text: value });
    }
  }
  return bindings;
}

/** workers.dev 的地址就是「腳本名.帳號子域.workers.dev」。 */
export function deriveWorkerUrl(scriptName: string, subdomain: string): string {
  return `https://${scriptName}.${subdomain}.workers.dev`;
}

/**
 * 反過來：從後端地址認出這個 Worker 在 Cloudflare 上叫什麼。
 *
 * 只有 `<腳本名>.<子域>.workers.dev` 這種地址認得出。自定義域名、Deno 門面那類
 * 代理地址跟腳本名沒有關係，猜出來的名字會指向別的 Worker——寧可返回 null 讓界面
 * 問一句，也不能猜。（worker 側 selfUpdate.ts 的 resolveScriptName 是同一套規矩。）
 */
export function scriptNameFromWorkerUrl(workerUrl: string): string | null {
  try {
    const host = new URL(workerUrl.trim()).hostname.toLowerCase();
    const parts = host.split('.');
    // <script>.<subdomain>.workers.dev → 至少四段
    if (parts.length < 4) return null;
    if (parts.slice(-2).join('.') !== 'workers.dev') return null;
    return parts[0] || null;
  } catch {
    return null;
  }
}

/**
 * 把 Cloudflare 的報錯翻譯成能照著做的話，末尾一律綴上原文。
 *
 * 翻譯是給用戶看的，原文是給排障用的，兩個都要有：
 *
 * - 權限類最常見——用戶建 token 時少勾一項，光看「Unauthorized」根本不知道少了哪個，
 *   所以要翻譯；
 * - 可 401/403 的不只 Cloudflare。中轉層（路徑不讓走、沒帶 Authorization）和路上的
 *   WAF 也回這兩個碼，一樣會被翻成「權限不夠」，於是 token 明明沒問題的人被指使著
 *   反覆去改 token。原文裡有沒有 CF 的 code、是不是 proxy 那句話，一眼就分得開。
 *
 * 原文取 CF 的 `errors[].message`；中轉層的錯誤體是 `{ error }`，不是同一個形狀，
 * 單獨撈一手。兩邊都沒有（非 JSON 響應）就只剩 HTTP 狀態碼，那也得說出來。
 *
 * `request` 是出事的那個請求（方法 + 路徑）。部署要連著調七八個接口，光有一句報錯
 * 認不出卡在建庫還是傳代碼，界面上的步驟名又在失敗時就清掉了。
 */
export function explainCfError(status: number, body: unknown, request?: string): string {
  const payload = body as {
    errors?: Array<{ code?: number; message?: string }>;
    error?: string;
  } | null;
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const code = errors[0]?.code;
  const raw =
    errors.map((e) => e?.message).filter(Boolean).join('；')
    || (typeof payload?.error === 'string' ? payload.error : '');

  const PERMISSION_HINT =
    'Token 權限不夠。建 token 時這三項都要勾上：Account → Workers Scripts:Edit、'
    + 'Account → D1:Edit、Account → Account Settings:Read。';

  const explain = (): string => {
    if (code === 6003 || code === 6111) return 'Token 格式不對，多半是複製時多帶了空格或換行。';
    if (code === 9109 || code === 10000 || status === 401 || status === 403) return PERMISSION_HINT;
    if (code === 10016) return 'Worker 名字不合法。';
    if (code === 10027) return 'Worker 代碼超過 Cloudflare 的體積上限，裝不上去。';
    if (code === 10037) return '這個帳號的 Worker 數量已經到上限了，先去面板刪掉不用的。';
    if (code === 10054 || code === 10055) return '密鑰數量或長度超限。';
    if (code === 7003) return '請求路徑不對（多半是代理那邊的問題，不是你的 token）。';
    return '這個錯沒見過，照原文查吧。';
  };

  const detail = `原文：${raw || '（空）'}｜code ${code ?? '無'}｜HTTP ${status}`;
  return `${explain()}\n${detail}${request ? `｜${request}` : ''}`;
}

/**
 * 校驗用戶想要的 workers.dev 子域。CF 的規矩是小寫字母數字和連字符，
 * 不能以連字符開頭結尾。這裡先擋一道，省得為一個明顯不合法的名字跑一趟網絡。
 */
export function validateSubdomain(name: string): string | null {
  const s = name.trim().toLowerCase();
  if (!s) return '子域名不能為空。';
  if (s.length < 3 || s.length > 63) return '子域名長度要在 3~63 個字符之間。';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) {
    return '子域名只能用小寫字母、數字和連字符，且不能以連字符開頭或結尾。';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 網絡層：所有 CF 請求都過中心 worker 的 /cf-api
// ---------------------------------------------------------------------------

interface CfResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  /** 已經翻成人話的錯誤，ok 為 false 時有值。 */
  error?: string;
}

const relayUrl = (apiPath: string): string =>
  `${getProxyWorkerUrl()}/cf-api?path=${encodeURIComponent(apiPath)}`;

async function cfApi<T = unknown>(
  token: string,
  apiPath: string,
  init: { method?: string; body?: FormData | string; contentType?: string } = {},
): Promise<CfResponse<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-CF-Method': init.method || 'GET',
  };
  // FormData 交給瀏覽器自己帶 Content-Type（裡面有 multipart 的 boundary），別手寫。
  if (init.contentType && !(init.body instanceof FormData)) {
    headers['Content-Type'] = init.contentType;
  }
  let res: Response;
  try {
    res = await fetch(relayUrl(apiPath), { method: 'POST', headers, body: init.body });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: `連不上代理（${String((e as Error)?.message || e)}）。檢查網絡，或在設置裡換一個網絡代理 Worker。`,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON（代理層的純文本錯誤）就留 null，下面按狀態碼處理 */
  }
  const success = res.ok && (body as { success?: boolean } | null)?.success !== false;
  return {
    ok: success,
    status: res.status,
    body: body as T,
    error: success ? undefined : explainCfError(res.status, body, `${init.method || 'GET'} ${apiPath}`),
  };
}

/** DO migration 的樂觀鎖衝突：這個 Worker 已經應用過 migration，「全新部署」的斷言不成立。 */
const MIGRATION_TAG_CONFLICT = 10079;

function firstCfErrorCode(body: unknown): number | null {
  const errors = (body as { errors?: Array<{ code?: number }> } | null)?.errors;
  return (Array.isArray(errors) && errors.length ? errors[0]?.code : null) ?? null;
}

async function putScript(
  token: string,
  accountId: string,
  scriptName: string,
  metadata: Record<string, unknown>,
  code: string,
): Promise<CfResponse> {
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(MAIN_MODULE, new Blob([code], { type: 'application/javascript+module' }), MAIN_MODULE);
  return cfApi(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
    method: 'PUT',
    body: form,
  });
}

/**
 * 上傳 Worker 腳本。metadata 帶著建 DO namespace 的 migrations，等於斷言「全新部署」；
 * 對著一個已經裝過的 Worker 重裝（清了地址重跑、換設備對同一個帳號再部署）時這個斷言
 * 不成立，CF 會回 10079 把整次上傳頂回來。
 *
 * 這時 namespace 本來就已經在了，migrations 純屬多餘——去掉重傳一次即可，binding 原樣
 * 保留（與 worker 側 selfUpdate 的補建路徑同一套實測結論：migration_tag 不變、DO 類還在）。
 * 只對 10079 重試：全新部署一次就過，其他錯誤照舊當場返回。
 */
export async function uploadWorkerScript(
  token: string,
  accountId: string,
  scriptName: string,
  metadata: Record<string, unknown>,
  code: string,
): Promise<CfResponse & { reusedExistingWorker?: boolean }> {
  const first = await putScript(token, accountId, scriptName, metadata, code);
  if (first.ok || firstCfErrorCode(first.body) !== MIGRATION_TAG_CONFLICT) return first;

  const withoutMigrations = { ...metadata };
  delete withoutMigrations.migrations;
  const second = await putScript(token, accountId, scriptName, withoutMigrations, code);
  return second.ok ? { ...second, reusedExistingWorker: true } : second;
}

/** 當前生效的網絡代理 Worker 支不支持一鍵部署（老版本沒有 /cf-api 這條路由）。 */
export async function checkRelayAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${getProxyWorkerUrl()}/cf-api`, { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { relay?: string };
    return body?.relay === 'cf-api';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 編排
// ---------------------------------------------------------------------------

interface CfListEnvelope<T> {
  result?: T[];
}
interface CfItemEnvelope<T> {
  result?: T;
}

/** 帳號令牌的前綴。它屬於帳號本身、不屬於任何用戶，這裡不支持，見 verifyToken。 */
const ACCOUNT_TOKEN_PREFIX = 'cfat_';

export const isAccountScopedToken = (token: string): boolean =>
  token.trim().startsWith(ACCOUNT_TOKEN_PREFIX);

interface CfVerifyResult {
  result?: { status?: string; not_before?: string; expires_on?: string };
  messages?: Array<{ code?: number; message?: string }>;
}

/**
 * 驗 token。只認普通 API Token（屬於用戶那種）。
 *
 * 帳號令牌（cfat_ 開頭）是另一套東西：它不屬於任何用戶，`/user/tokens/verify` 和
 * `/accounts` 對它一律 401，於是沒法自動找帳號，用戶還得自己去抄一串 Account ID。
 * 而普通 Token 建的時候一樣能把範圍限定到單個帳號，權限一樣小、還省一次粘貼——
 * 所以這裡直接不支持它，認出來就明說該換哪種，別讓人對著 401 猜。
 *
 * 另一個坑：**token 還沒到生效日期時，verify 照樣返回 success: true**，只在 messages
 * 裡塞一條 code 10002。放它過去的話，後面每一步都收到通用的 Authentication error，
 * 會被歸成「權限不夠」——用戶跑去改權限，可那根本不是原因。真機上踩過。
 */
export async function verifyToken(
  token: string,
): Promise<{ ok: true } | { ok: false; code: ProvisionFailureCode; message: string }> {
  if (isAccountScopedToken(token)) {
    return {
      ok: false,
      code: 'TOKEN_INVALID',
      message:
        '這是一枚帳號令牌（cfat_ 開頭），這裡用不了。'
        + '去 Cloudflare 右上角頭像 → My Profile → API Tokens 建一枚普通的 API Token，'
        + '建的時候在 Account Resources 裡選上你要裝到的那個帳號就行。',
    };
  }

  const res = await cfApi<CfVerifyResult>(token, '/user/tokens/verify');
  if (!res.ok) {
    return { ok: false, code: 'TOKEN_INVALID', message: res.error || 'Token 驗證不通過。' };
  }

  const notYet = (res.body?.messages ?? []).find((m) => m.code === 10002);
  if (notYet) {
    return {
      ok: false,
      code: 'TOKEN_NOT_YET_VALID',
      message:
        `這枚 Token 還沒到生效時間，現在用不了。${notYet.message ? `\nCloudflare 說：${notYet.message}` : ''}`
        + '\n重新建一枚，把「Start Date」留空或設成今天。',
    };
  }
  const status = res.body?.result?.status;
  if (status && status !== 'active') {
    return { ok: false, code: 'TOKEN_INVALID', message: `這枚 Token 的狀態是 ${status}，不能用。` };
  }
  return { ok: true };
}

/**
 * 找出這枚 token 真正能用的帳號。
 *
 * GET /accounts 是用戶級端點，返回這人名下所有帳號，跟 token 授權了哪個無關，
 * 所以不能直接拿第一個用。挨個問「這個帳號下能不能列 Worker」，能列的才算數。
 */
async function findUsableAccounts(token: string): Promise<CfResponse<CfAccount[]>> {
  const listed = await cfApi<CfListEnvelope<CfAccount>>(token, '/accounts?per_page=50');
  if (!listed.ok) return { ...listed, body: null } as CfResponse<CfAccount[]>;
  const all = listed.body?.result ?? [];
  const usable: CfAccount[] = [];
  for (const acc of all) {
    const probe = await cfApi(token, `/accounts/${acc.id}/workers/scripts`);
    if (probe.ok) usable.push({ id: acc.id, name: acc.name });
  }
  return { ok: true, status: 200, body: usable };
}

async function ensureDatabase(
  token: string,
  accountId: string,
  databaseName: string,
): Promise<{ ok: true; id: string; reused: boolean } | { ok: false; error: string }> {
  const existing = await cfApi<CfListEnvelope<{ uuid?: string; name?: string }>>(
    token,
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}`,
  );
  if (existing.ok) {
    const hit = (existing.body?.result ?? []).find((db) => db.name === databaseName && db.uuid);
    if (hit?.uuid) return { ok: true, id: hit.uuid, reused: true };
  }
  const created = await cfApi<CfItemEnvelope<{ uuid?: string }>>(
    token,
    `/accounts/${accountId}/d1/database`,
    { method: 'POST', body: JSON.stringify({ name: databaseName }), contentType: 'application/json' },
  );
  const uuid = created.body?.result?.uuid;
  if (!created.ok || !uuid) {
    return { ok: false, error: created.error || '建數據庫失敗，Cloudflare 沒有返回數據庫 id。' };
  }
  return { ok: true, id: uuid, reused: false };
}

/**
 * 拿帳號的 workers.dev 子域；沒有就用 desiredSubdomain 註冊一個。
 * 全新的 Cloudflare 帳號是沒有子域的，而它決定了最終的 Worker 地址，繞不過去。
 */
export async function ensureSubdomain(
  token: string,
  accountId: string,
  desired?: string,
): Promise<{ ok: true; subdomain: string } | { ok: false; code: ProvisionFailureCode; error: string }> {
  const current = await cfApi<CfItemEnvelope<{ subdomain?: string }>>(
    token,
    `/accounts/${accountId}/workers/subdomain`,
  );
  // 401/403 是「沒讓我讀」，不是「這個帳號沒有子域名」。不單獨拎出來的話，下面會把它
  // 當成新帳號，請用戶起一個名字——而讀都讀不動，註冊那一步同樣過不去，用戶於是對著
  // 「換一個名字再試」換個不停。只挑這兩個狀態碼：帳號真沒有子域名時 CF 回什麼沒實測過，
  // 把所有失敗都當權限的話，會把全新帳號堵死在這裡，那比現在更糟。
  if (!current.ok && (current.status === 401 || current.status === 403)) {
    return {
      ok: false,
      code: 'CF_ERROR',
      error: `讀不到這個帳號的 workers.dev 子域名。\n${current.error}`,
    };
  }
  const existing = current.body?.result?.subdomain;
  if (current.ok && existing) return { ok: true, subdomain: existing };

  if (!desired) {
    return {
      ok: false,
      code: 'SUBDOMAIN_MISSING',
      error: '這個 Cloudflare 帳號還沒有 workers.dev 子域名，需要先起一個。',
    };
  }
  const invalid = validateSubdomain(desired);
  if (invalid) return { ok: false, code: 'SUBDOMAIN_MISSING', error: invalid };

  const registered = await cfApi(token, `/accounts/${accountId}/workers/subdomain`, {
    method: 'PUT',
    body: JSON.stringify({ subdomain: desired.trim().toLowerCase() }),
    contentType: 'application/json',
  });
  if (!registered.ok) {
    return {
      ok: false,
      code: 'SUBDOMAIN_TAKEN',
      error: `${desired} 這個子域名註冊不下來（多半被別人佔了）。換一個再試。${registered.error ? `\n${registered.error}` : ''}`,
    };
  }
  return { ok: true, subdomain: desired.trim().toLowerCase() };
}

async function fetchBundle(): Promise<{ ok: true; code: string; config: WorkerDeployConfig } | { ok: false; error: string }> {
  let code: string;
  try {
    const res = await fetch(BUNDLE_URL, { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `拉取 Worker 代碼失敗（HTTP ${res.status}）。` };
    code = await res.text();
  } catch (e) {
    return { ok: false, error: `拉取 Worker 代碼失敗：${String((e as Error)?.message || e)}` };
  }
  const bytes = new TextEncoder().encode(code).length;
  if (bytes < MIN_BUNDLE_BYTES || bytes > MAX_BUNDLE_BYTES) {
    return { ok: false, error: `拉到的 Worker 代碼大小不對（${bytes} 字節），沒敢往上傳。` };
  }
  if (!code.includes('src_default as default')) {
    return { ok: false, error: '拉到的文件不像是打包好的 Worker，沒敢往上傳。' };
  }

  // 配置跟著 bundle 一起從線上拿，拿不到就用兜底，不因為這個中斷部署。
  let config = FALLBACK_CONFIG;
  try {
    const res = await fetch(WRANGLER_URL, { cache: 'no-store' });
    if (res.ok) config = parseWranglerConfig(await res.text());
  } catch {
    /* 用兜底 */
  }
  return { ok: true, code, config };
}

/**
 * 等新部署的 Worker 真的能響應。
 *
 * 剛建好的 workers.dev 地址要過一會兒才解析得到（實測上傳成功後還得幾十秒）。
 * **這期間 Cloudflare 會返回它自己的 404 佔位頁**，所以「收到 HTTP 響應」不能當成
 * 活了的判據——真機上就是這麼誤判的，緊接著去建表必然失敗。
 * 佔位頁是 text/html，Worker 一律回 JSON，拿 Content-Type 分得乾淨。
 *
 * 超時返回 false 而不是拋錯：沒等到不代表裝失敗，讓調用方提示「過會兒點連接」即可。
 */
export async function waitForWorkerReady(workerUrl: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // 新地址在各個邊緣節點上不是同時生效的：探到一次成功、下一秒又落到沒生效的節點上，
  // 真機上就這麼反覆了幾輪。連著兩次才算數，把這個抖動期讓過去。
  const NEEDED_STREAK = 2;
  let streak = 0;
  let delay = 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${workerUrl}/config-check`, { method: 'GET', cache: 'no-store' });
      streak = res.headers.get('content-type')?.includes('json') ? streak + 1 : 0;
      if (streak >= NEEDED_STREAK) return true;
    } catch {
      streak = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 5000);
  }
  return false;
}

/** 生成這套後端要的全部密鑰。已有的原樣保留（重裝時不換 Master Key）。 */
export async function generateAmsgSecrets(existing: Partial<AmsgSecrets> = {}): Promise<AmsgSecrets> {
  const vapid = existing.VAPID_PUBLIC_KEY && existing.VAPID_PRIVATE_KEY
    ? { publicKey: existing.VAPID_PUBLIC_KEY, privateKey: existing.VAPID_PRIVATE_KEY }
    : await generateVapidKeyPair();
  const masterKey = existing.AMSG_MASTER_KEY
    || Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  return {
    AMSG_MASTER_KEY: masterKey,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_EMAIL: existing.VAPID_EMAIL || '',
    AMSG_SERVER_TOKEN: existing.AMSG_SERVER_TOKEN || generateClientToken(),
  };
}

/**
 * 給一台**已經裝好的**後端補上「自己更新自己」的能力。
 *
 * 老辦法裝的（fork 倉庫 / 部署按鈕 / 手動粘代碼）Worker 裡沒有 CF_API_TOKEN，點「更新
 * 後端」會被頂回來，原本得去 Cloudflare 面板手動加一條密鑰。這裡用 Workers 的密鑰接口
 * （`PUT .../secrets`）單獨寫這一條——**它不碰腳本，也不碰其它綁定**，所以對手動部署的
 * 用戶是安全的：前端手裡沒有他們的 Master Key，走上傳那條路會把密鑰抹掉，走這條不會。
 *
 * 寫完 token 就留在用戶自己的 Worker 裡，前端不保存。
 */
export async function attachUpdateCapability(input: {
  token: string;
  /** 用戶當前配的後端地址，用來認出腳本叫什麼。 */
  workerUrl: string;
  /** 地址是自定義域名 / 代理時認不出來，由界面問出來再傳進來。 */
  scriptName?: string;
  accountId?: string;
  onProgress?: (p: ProvisionProgress) => void;
}): Promise<
  | { ok: true; accountId: string; scriptName: string }
  | { ok: false; code: ProvisionFailureCode; message: string; accounts?: CfAccount[] }
> {
  const token = input.token.trim();
  const report = (step: ProvisionStepId, message: string) => input.onProgress?.({ step, message });

  report('relay', '檢查中轉是否可用…');
  if (!(await checkRelayAvailable())) {
    return {
      ok: false,
      code: 'RELAY_UNSUPPORTED',
      message: '當前的網絡代理 Worker 不支持這個操作（缺 /cf-api）。把代理地址改回默認的再試。',
    };
  }

  report('token', '驗證 Token…');
  const verified = await verifyToken(token);
  if (!verified.ok) return { ok: false, code: verified.code, message: verified.message };

  const scriptName = input.scriptName?.trim() || scriptNameFromWorkerUrl(input.workerUrl);
  if (!scriptName) {
    return {
      ok: false,
      code: 'SCRIPT_NAME_UNKNOWN',
      message:
        '認不出你這台後端在 Cloudflare 上叫什麼名字（地址不是 workers.dev 那種，多半套了自定義域名或代理）。'
        + '去 Cloudflare 的 Workers 列表看一眼它的名字，填進來。',
    };
  }

  report('account', '找這台 Worker 在哪個帳號下…');
  const scriptPath = (accId: string) =>
    `/accounts/${accId}/workers/scripts/${encodeURIComponent(scriptName)}`;

  let accountId = input.accountId?.trim() || '';
  if (accountId) {
    const found = await cfApi(token, `${scriptPath(accountId)}/settings`);
    if (!found.ok) {
      return {
        ok: false,
        code: 'SCRIPT_NOT_FOUND',
        message: `這個帳號下沒找到名叫 ${scriptName} 的 Worker。`,
      };
    }
  } else {
    const accounts = await findUsableAccounts(token);
    if (!accounts.ok) {
      return { ok: false, code: 'CF_ERROR', message: accounts.error || '讀取帳號列表失敗。' };
    }
    // 挨個帳號問「你這兒有沒有這個 Worker」。同名 Worker 可能在多個帳號裡都存在，
    // 那就得讓用戶自己指認，別替他猜一個寫進去。
    const owners: CfAccount[] = [];
    for (const account of accounts.body ?? []) {
      const found = await cfApi(token, `${scriptPath(account.id)}/settings`);
      if (found.ok) owners.push(account);
    }
    if (owners.length === 0) {
      return {
        ok: false,
        code: 'SCRIPT_NOT_FOUND',
        message:
          `這枚 Token 能看到的帳號裡都沒有名叫 ${scriptName} 的 Worker。`
          + '確認一下 Token 建的時候選對帳號了沒有。',
      };
    }
    if (owners.length > 1) {
      return {
        ok: false,
        code: 'ACCOUNT_AMBIGUOUS',
        message: `有多個帳號下都有名叫 ${scriptName} 的 Worker，選一個。`,
        accounts: owners,
      };
    }
    accountId = owners[0].id;
  }

  report('upload', '寫入更新用的鑰匙…');
  // 兩條：token 本身，外加腳本名——地址套了代理時 Worker 認不出自己叫什麼，
  // 顯式寫進去它才知道要更新哪一個。
  for (const [name, text] of [['CF_API_TOKEN', token], ['CF_SCRIPT_NAME', scriptName]]) {
    const written = await cfApi(token, `${scriptPath(accountId)}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name, text, type: 'secret_text' }),
      contentType: 'application/json',
    });
    if (!written.ok) {
      return { ok: false, code: 'CF_ERROR', message: `寫入 ${name} 失敗（${written.error}）。` };
    }
  }

  report('done', '裝好了。');
  return { ok: true, accountId, scriptName };
}

/**
 * 全流程。任何一步失敗都直接返回，不做回滾——半途失敗會留下已經建好的 D1 或 Worker，
 * 但每一步都是「先查後建」，把同樣的參數再跑一遍能接著往下走，不會建出第二份。
 */
export async function provisionAmsgBackend(input: ProvisionInput): Promise<ProvisionResult> {
  const scriptName = input.scriptName?.trim() || AMSG_SCRIPT_NAME;
  const databaseName = input.databaseName?.trim() || AMSG_D1_NAME;
  const token = input.token.trim();
  const report = (step: ProvisionStepId, message: string) => input.onProgress?.({ step, message });
  const warnings: string[] = [];

  report('relay', '檢查中轉是否可用…');
  if (!(await checkRelayAvailable())) {
    return {
      ok: false,
      code: 'RELAY_UNSUPPORTED',
      message:
        '當前的網絡代理 Worker 不支持一鍵部署（缺 /cf-api）。'
        + '如果你在設置裡換過代理地址，把它改回默認的，或者把代理 Worker 更新到最新版。',
    };
  }

  report('token', '驗證 Token…');
  const verified = await verifyToken(token);
  if (!verified.ok) {
    return { ok: false, code: verified.code, message: verified.message };
  }

  report('account', '查找可用的 Cloudflare 帳號…');
  let accountId = input.accountId?.trim() || '';
  if (!accountId) {
    const accounts = await findUsableAccounts(token);
    if (!accounts.ok) {
      return { ok: false, code: 'CF_ERROR', message: accounts.error || '讀取帳號列表失敗。' };
    }
    const usable = accounts.body ?? [];
    if (usable.length === 0) {
      return {
        ok: false,
        code: 'NO_USABLE_ACCOUNT',
        message:
          '這枚 token 在你名下任何一個帳號裡都沒有 Workers 權限。'
          + '重新建一枚，把 Account → Workers Scripts:Edit 勾上。',
      };
    }
    if (usable.length > 1) {
      return {
        ok: false,
        code: 'ACCOUNT_AMBIGUOUS',
        message: '這枚 token 能用在多個帳號上，選一個裝到哪兒。',
        accounts: usable,
      };
    }
    accountId = usable[0].id;
  }

  report('database', '準備數據庫…');
  const db = await ensureDatabase(token, accountId, databaseName);
  if (!db.ok) return { ok: false, code: 'CF_ERROR', message: db.error };
  if (db.reused) {
    warnings.push(`用的是帳號裡已有的同名數據庫 ${databaseName}。如果之前裝過一套，兩邊會共用同一個庫。`);
  }

  report('subdomain', '確認 workers.dev 地址…');
  const sub = await ensureSubdomain(token, accountId, input.desiredSubdomain);
  if (!sub.ok) return { ok: false, code: sub.code, message: sub.error };

  report('bundle', '下載最新的後端代碼…');
  const bundle = await fetchBundle();
  if (!bundle.ok) return { ok: false, code: 'BUNDLE_INVALID', message: bundle.error };

  report('upload', '上傳 Worker…');
  const secrets = await generateAmsgSecrets(input.secrets);
  const metadata = {
    main_module: MAIN_MODULE,
    compatibility_date: bundle.config.compatibilityDate,
    compatibility_flags: bundle.config.compatibilityFlags,
    // CF_API_TOKEN / CF_SCRIPT_NAME 是留給「更新後端」用的：worker 以後拿它自己
    // 覆蓋自己，就不用再經過瀏覽器和中轉了。
    bindings: buildBindings(bundle.config.d1Binding, db.id, secrets, {
      CF_API_TOKEN: token,
      CF_SCRIPT_NAME: scriptName,
    }),
    // 實時日誌（面板上的 Workers Logs）默認是關的，amsg 排障全靠它。
    // 官方的 multipart-upload-metadata 文檔沒把 observability 列進合法字段，但實測是認的
    // ——上傳 enabled:false 能關掉、true 能開起來、不帶就沒有，三向都驗過。
    observability: { enabled: true, logs: { enabled: true } },
    // 建即時對話起跳器的 Durable Object namespace。不給 old_tag 即斷言「還沒應用過
    // 任何 migration」；重裝撞上 10079 時由 uploadWorkerScript 去掉它重傳。注意它是
    // 一個對象，不是 wrangler.toml 裡那種數組——傳數組會被 10021 頂回來。
    migrations: INSTANT_TICK_MIGRATIONS,
  };
  const uploaded = await uploadWorkerScript(token, accountId, scriptName, metadata, bundle.code);
  if (!uploaded.ok) {
    return { ok: false, code: 'UPLOAD_FAILED', message: uploaded.error || '上傳 Worker 失敗。' };
  }
  if (uploaded.reusedExistingWorker) {
    warnings.push(`帳號裡已經有一套裝好的 ${scriptName}，這次是在它上面覆蓋更新。`);
  }

  report('cron', '設置定時觸發…');
  const schedules = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    {
      method: 'PUT',
      body: JSON.stringify(bundle.config.crons.map((cron) => ({ cron }))),
      contentType: 'application/json',
    },
  );
  if (!schedules.ok) {
    // 這條不能降級成警告：cron 是主動消息唯一的投遞觸發方式，沒有它整個功能不動。
    return {
      ok: false,
      code: 'CF_ERROR',
      message: `定時觸發沒設上（${schedules.error}）。主動消息全靠它，先解決這個再用。`,
    };
  }

  report('expose', '開啟訪問地址…');
  const exposed = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    {
      method: 'POST',
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
      contentType: 'application/json',
    },
  );
  if (!exposed.ok) {
    return { ok: false, code: 'CF_ERROR', message: `開啟 workers.dev 地址失敗（${exposed.error}）。` };
  }

  report('done', '部署完成。');
  return {
    ok: true,
    workerUrl: deriveWorkerUrl(scriptName, sub.subdomain),
    scriptName,
    accountId,
    databaseId: db.id,
    reusedDatabase: db.reused,
    secrets,
    warnings,
  };
}
