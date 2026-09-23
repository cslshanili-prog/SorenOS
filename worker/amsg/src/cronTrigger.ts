/**
 * 暫停 / 恢復後台任務：摘掉或加回這台 Worker 的 cron trigger。
 *
 * 主動消息和定時消息都靠 cron 每分鐘一跳來投遞（見 wrangler.toml 的 [triggers]）。
 * 把 trigger 摘掉，到點的任務就不會被處理；任務本身還在 D1 裡排著，一條都不會丟。
 * 加回來之後的第一跳會把攢下的那些一起投遞出去。
 *
 * 什麼時候用：用戶想讓角色安靜一陣（考試、出差、暫時不想被打擾），又不想逐個角色關開關、
 * 逐條取消任務，回頭再一個個排回來。
 *
 * 跟 ./selfUpdate 走的是同一套基礎設施：worker 拿自己環境裡的 CF_API_TOKEN 調
 * Cloudflare API 改 schedules。瀏覽器直接調不了（api.cloudflare.com 不返回 CORS 頭），
 * 所以這活兒只能落在 worker 這一側。
 *
 * 這不是永久開關：走 GitHub Actions / wrangler deploy 重新部署時，會按 wrangler.toml
 * 把 cron 加回來。設置頁裡的「更新 Worker」（自更新）只覆蓋腳本代碼，不碰 schedules，
 * 所以暫停狀態能撐過自更新，但撐不過一次 Sync fork。
 *
 * 安全上跟自更新同一條底線：必須配了共享密鑰並校驗通過才讓動。沒配密鑰的實例地址等於
 * 全公開，留這個口子相當於誰都能把別人的主動消息關掉。
 */

import { constantTimeEqual } from './instantChat';
import { cf, locateScript, resolveScriptName, type SelfUpdateEnv } from './selfUpdate';

/**
 * 恢復時加回去的 cron 表達式。
 *
 * 必須與 `worker/amsg/wrangler.toml` 的 `[triggers] crons` 一致：worker 運行時讀不到那份
 * 配置，所以這裡抄一份。改了那邊記得同步這裡（cronTrigger.test.ts 有一條守衛會對比兩處）。
 */
export const AMSG_CRON_EXPRESSION = '* * * * *';

export type CronTriggerFailCode =
  | 'SERVER_TOKEN_REQUIRED'
  | 'UNAUTHORIZED'
  | 'CF_TOKEN_MISSING'
  | 'SCRIPT_NAME_UNKNOWN'
  | 'SCRIPT_NOT_LOCATED'
  | 'CF_ERROR';

export interface CronTriggerFailure {
  code: CronTriggerFailCode;
  message: string;
}

/** `GET /cron-trigger` 的回執：讀得到就報開沒開，讀不到就說明為什麼。 */
export type CronTriggerReadResult =
  | { supported: true; enabled: boolean }
  | ({ supported: false } & CronTriggerFailure);

/** `POST /cron-trigger` 的回執。 */
export type CronTriggerWriteResult =
  | { ok: true; enabled: boolean }
  | ({ ok: false } & CronTriggerFailure);

/** 認證沒過的兩種代號，路由據此回 401 而不是 400。 */
export const isCronTriggerAuthFailure = (code: CronTriggerFailCode): boolean =>
  code === 'SERVER_TOKEN_REQUIRED' || code === 'UNAUTHORIZED';

const fail = (code: CronTriggerFailCode, message: string): CronTriggerFailure => ({ code, message });

/**
 * 認證 + 定位「我是哪台 Worker」，兩個端點共用的前半段。
 * 走完拿到的是調 CF API 要用的 token、帳號 id 和腳本名；任何一步不通就帶著代號返回。
 */
async function prepare(
  env: SelfUpdateEnv,
  request: Request,
): Promise<
  | { ok: true; token: string; schedulesPath: string }
  | { ok: false; failure: CronTriggerFailure }
> {
  const serverToken = env.AMSG_SERVER_TOKEN?.trim();
  if (!serverToken) {
    return {
      ok: false,
      failure: fail(
        'SERVER_TOKEN_REQUIRED',
        '這個 Worker 沒設共享密鑰（AMSG_SERVER_TOKEN），出於安全考慮不開放暫停後台任務。先補上再試。',
      ),
    };
  }
  // 常時比較：這個端點能把別人的主動消息整個關掉，密鑰校驗不能從耗時上漏字。
  const clientToken = request.headers.get('X-Client-Token');
  if (!clientToken || !(await constantTimeEqual(clientToken, serverToken))) {
    return { ok: false, failure: fail('UNAUTHORIZED', '共享密鑰對不上。') };
  }

  const token = env.CF_API_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      failure: fail(
        'CF_TOKEN_MISSING',
        '沒配 CF_API_TOKEN，沒法改定時觸發。去 Cloudflare 建一枚只勾 Workers Scripts → Edit 的 API Token，加進這個 Worker 的變量裡。',
      ),
    };
  }

  const scriptName = resolveScriptName(env, request.url);
  if (!scriptName) {
    return {
      ok: false,
      failure: fail(
        'SCRIPT_NAME_UNKNOWN',
        '認不出這個 Worker 叫什麼（多半是套了代理域名）。給它加一條 CF_SCRIPT_NAME 變量，值填 Worker 的名字。',
      ),
    };
  }

  const located = await locateScript(env, token, scriptName);
  if (!located.ok) return { ok: false, failure: fail('SCRIPT_NOT_LOCATED', located.message) };

  return {
    ok: true,
    token,
    schedulesPath: `/accounts/${located.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
  };
}

/** CF 回的 schedules 列表。讀和寫兩個接口都是 `result.schedules` 這個形狀。 */
const readSchedules = (result: unknown): unknown[] => {
  const schedules = (result as { schedules?: unknown } | null)?.schedules;
  return Array.isArray(schedules) ? schedules : [];
};

/** 查這台 Worker 現在有沒有 cron trigger。 */
export async function handleCronTriggerRead(
  env: SelfUpdateEnv,
  request: Request,
): Promise<CronTriggerReadResult> {
  const prepared = await prepare(env, request);
  if (!prepared.ok) return { supported: false, ...prepared.failure };

  const current = await cf(prepared.token, prepared.schedulesPath);
  if (!current.ok) {
    return { supported: false, ...fail('CF_ERROR', `讀不到定時觸發的狀態（${current.detail}）。`) };
  }
  return { supported: true, enabled: readSchedules(current.result).length > 0 };
}

/** 把 cron trigger 摘掉（enabled=false）或加回來（enabled=true）。整體覆蓋，不是增刪單條。 */
export async function handleCronTriggerWrite(
  env: SelfUpdateEnv,
  request: Request,
  enabled: boolean,
): Promise<CronTriggerWriteResult> {
  const prepared = await prepare(env, request);
  if (!prepared.ok) return { ok: false, ...prepared.failure };

  const schedules = enabled ? [{ cron: AMSG_CRON_EXPRESSION }] : [];
  const written = await cf(prepared.token, prepared.schedulesPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedules),
  });
  if (!written.ok) {
    return {
      ok: false,
      ...fail(
        'CF_ERROR',
        `${enabled ? '恢復' : '暫停'}沒成功（${written.detail}）。定時觸發保持原樣。`,
      ),
    };
  }
  return { ok: true, enabled };
}
