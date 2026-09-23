/**
 * 啟動時清一次 Instant Push 留在本機的舊數據。
 *
 * 要清的東西：
 *  - localStorage 裡的舊配置（含 Worker 地址和 client token）、Worker 更新提醒 / 版本探測 /
 *    下線通知的記帳、每個角色的工具調用狀態；
 *  - ActiveMsg 庫裡三張閒置表：outbound_sessions（存著 API key 副本和整段消息快照）、
 *    pending_tool_calls、reasoning_buffer。
 *
 * 只跑一次：清完寫標記，之後啟動直接返回。IDB 清表失敗就不寫標記，下次啟動再試；
 * localStorage 那幾項反正每次都能重刪，不影響。任何一步出錯都只 warn，不攔啟動。
 */
import { ActiveMsgStore } from './activeMsgStore';

export const INSTANT_PUSH_LEGACY_CLEANUP_DONE_KEY = 'sullyos_instant_push_legacy_cleanup_v1';

const LEGACY_LOCAL_STORAGE_KEYS = [
  'instant_push_config_v1',
  'sullyos_worker_build_seen',
  'sullyos_worker_update_snooze_until',
  'sullyos_worker_version_probe_at',
  'sullyos_instant_push_sunset_seen_date',
];

const LEGACY_LOCAL_STORAGE_PREFIXES = ['instant_tool_status_'];

const removeLegacyLocalStorage = (): void => {
  for (const key of LEGACY_LOCAL_STORAGE_KEYS) localStorage.removeItem(key);
  // 先收集再刪：邊遍歷邊刪會讓 key(i) 的下標錯位、漏掉一半。
  const prefixed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && LEGACY_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      prefixed.push(key);
    }
  }
  for (const key of prefixed) localStorage.removeItem(key);
};

export async function cleanupInstantPushLegacyData(): Promise<void> {
  try {
    if (localStorage.getItem(INSTANT_PUSH_LEGACY_CLEANUP_DONE_KEY)) return;
  } catch {
    return; // localStorage 用不了，這一趟什麼都做不成
  }

  try {
    removeLegacyLocalStorage();
  } catch (e) {
    console.warn('[legacy-cleanup] 清理 Instant Push 舊配置失敗', e);
  }

  try {
    await ActiveMsgStore.clearLegacyInstantPushStores();
  } catch (e) {
    console.warn('[legacy-cleanup] 清理 Instant Push 舊會話表失敗，下次啟動再試', e);
    return;
  }

  try {
    localStorage.setItem(INSTANT_PUSH_LEGACY_CLEANUP_DONE_KEY, String(Date.now()));
  } catch { /* 寫不進標記就下次再清一遍，無害 */ }
}
