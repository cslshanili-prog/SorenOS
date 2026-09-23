/**
 * 用戶手動部署自己的 Worker 時用到的兩個小工具：複製站點發布的 bundle、跳 Cloudflare 控制台。
 * 主動消息 2.0 的設置面板在用。
 */

/**
 * 複製站點隨 build 發佈的某個 worker bundle 到剪貼板（Dashboard 粘貼部署用）。
 *
 * 拋出原始錯誤讓調用方決定怎麼顯示 (toast / inline status / 不顯示)。
 */
export async function copyWorkerBundleToClipboard(bundleName: string): Promise<void> {
  const base = import.meta.env.BASE_URL || '/';
  const res = await fetch(`${base}${bundleName}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  await navigator.clipboard.writeText(text);
}

/**
 * 根據用戶填的 workerUrl 推算 Cloudflare dashboard 編輯界面的 deep link。
 *
 * Cloudflare 接受 `?to=/:account/...` 模式, 登錄後會自動用當前帳號 ID 替換 :account
 * (多帳號會出選擇器)。這樣我們不需要知道用戶的 account ID, 只要從 workers.dev
 * 子域名裡摳出 worker name 就能直達 /production 編輯界面。
 *
 * 非 workers.dev 域名 (自定義域 / 反代) 沒法可靠反推 worker name, 退回 worker 列表頁,
 * 用戶自己點項目名進去 —— 這類用戶清楚自己的部署結構, 不會被卡住。
 */
export function buildCloudflareDashboardUrl(workerUrl: string | undefined): string {
  const FALLBACK = 'https://dash.cloudflare.com/?to=/:account/workers/overview';
  if (!workerUrl) return FALLBACK;
  try {
    const u = new URL(workerUrl);
    if (u.hostname.endsWith('.workers.dev')) {
      const workerName = u.hostname.split('.')[0];
      if (workerName) {
        return `https://dash.cloudflare.com/?to=/:account/workers/services/view/${encodeURIComponent(workerName)}/production`;
      }
    }
  } catch { /* invalid url → fallback */ }
  return FALLBACK;
}
