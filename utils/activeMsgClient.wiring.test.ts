// amsg2 訂閱自檢 / 憑據重傳 / 失敗可見化的接線守衛。
//
// 倉庫的 vitest 是純 Node 環境（沒裝 jsdom），Settings / 兩個設置彈窗這些 React 組件
// 沒法真渲染起來測行為，這裡沿用 amsgStateSync.wiring.test.ts 的做法做**源碼級**斷言：
// 把「保存 API 後面跟著憑據重傳」「面板保存後刷其餘任務憑據」「SW 訂閱變化標記與主線程
// 消費兩頭 key 一致」這些接線釘住，誰把調用刪了這裡就紅。它驗證不了運行時時序，
// 只防「接線被誤刪」這一種迴歸——補上組件測試基建後應該換成真正的行為測試。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 取 [start, end) 之間的源碼片段；找不到錨點直接讓斷言失敗。 */
const sliceBetween = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  expect(i, `找不到錨點: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `找不到結束錨點: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

describe('③ 憑據變更重傳接線', () => {
  it('Settings.commitApiConfig：換了聊天 API 就觸發已排程任務的憑據重傳', () => {
    const src = read('../apps/Settings.tsx');
    // 保存按鈕和點預設切換共用 commitApiConfig 這一個出口。
    const fn = sliceBetween(src, 'const commitApiConfig', 'const applyPreset');
    expect(fn).toContain('ActiveMsgClient.refreshApiCredentialsForPendingTasks(');
    // 傳的是「這次要換過去的配置」疊在 apiConfig 上，而不是渲染時的舊快照。
    const call = fn.match(/refreshApiCredentialsForPendingTasks\(\{ \.\.\.apiConfig, \.\.\.(\w+) \}\)/);
    expect(call, '憑據重傳要把新配置疊在 apiConfig 上一起傳').not.toBeNull();
    expect(fn, '疊上去的得是這次切換現組的那份').toContain(`const commitApiConfig = (${call![1]}:`);
    // 兩個入口遞進去的都是現組的配置對象，不是舊的 localXxx 草稿
    expect(sliceBetween(src, 'const handleSaveApi', 'const handleSaveVisionApi'))
      .toMatch(/const nextConfig = \{[\s\S]*commitApiConfig\(nextConfig\)/);
    expect(sliceBetween(src, 'const applyPreset', 'const openEditPreset'))
      .toContain('commitApiConfig(configFromPreset(preset))');
  });

  it('ActiveMsg2SettingsModal.handleSubmit：角色級 API 保存後刷同角色其餘 pending AI 任務', () => {
    const src = read('../components/chat/ActiveMsg2SettingsModal.tsx');
    const fn = sliceBetween(src, 'const handleSubmit', 'return (');
    expect(fn).toContain('ActiveMsgClient.refreshCharPendingAiTaskCredentials(');
    // 剛排的這條（result.uuid）與被替換的舊條都要摘掉，別對著它們重複 PUT。
    expect(fn).toContain('t.taskUuid !== result.uuid');
    expect(fn).toContain('t.taskUuid !== editingTaskUuid');
  });
});

describe('③ 失敗可見化接線（遠端 lastError 上卡片）', () => {
  it('面板對帳改拉全量投影 listRemoteTasksForChar，並用 describeRemoteLastError 渲染', () => {
    const src = read('../components/chat/ActiveMsg2SettingsModal.tsx');
    expect(src).toContain('ActiveMsgClient.listRemoteTasksForChar(');
    expect(src).toContain('describeRemoteLastError(');
    // 進度文案吸收遠端 status（failed 終態不再謊報「待處理」）。
    expect(src).toMatch(/describeTaskProgress\(t, knownRemoteUuids, now, remoteInfo\?\.status\)/);
  });
});

describe('② 訂閱刷新接線（SW 標記 ↔ 主線程消費）', () => {
  it('SW：pushsubscriptionchange 監聽 + 往 kv store 寫標記 + 通知頁面', () => {
    const src = read('../worker/sw-keep-alive.ts');
    expect(src).toContain("addEventListener('pushsubscriptionchange'");
    const listener = sliceBetween(src, "addEventListener('pushsubscriptionchange'", 'notificationclick');
    expect(listener).toContain('PUSH_SUBSCRIPTION_CHANGED_KV_ID');
    expect(listener).toContain("withInboxTx(ACTIVE_MSG_KV_STORE, 'readwrite'");
    expect(listener).toContain("notifyClients({ type: 'active-msg-subscription-change'");
    // SW-first 安裝也要有 kv store 可寫（onupgradeneeded 補建）。
    expect(src).toMatch(/objectStoreNames\.contains\(ACTIVE_MSG_KV_STORE\)/);
  });

  it('SW 與主線程的標記 key 必須一字不差（兩個文件各自持有一份常量）', () => {
    const swSrc = read('../worker/sw-keep-alive.ts');
    const runtimeSrc = read('./activeMsgRuntime.ts');
    const pickKey = (src: string) => {
      const m = /PUSH_SUBSCRIPTION_CHANGED_KV_ID = '([^']+)'/.exec(src);
      expect(m, '找不到 PUSH_SUBSCRIPTION_CHANGED_KV_ID 常量').toBeTruthy();
      return m![1];
    };
    expect(pickKey(swSrc)).toBe(pickKey(runtimeSrc));
  });

  it('主線程：啟動兜底 + SW 通知兩條路都消費標記', () => {
    const src = read('./activeMsgRuntime.ts');
    const init = sliceBetween(src, 'export const ActiveMsgRuntime', 'handleDeepLink();');
    // 啟動路徑 fire-and-forget 一次
    expect(init).toContain('void refreshPushSubscriptionIfMarked()');
    // SW postMessage（頁面開著時立即處理）
    expect(init).toContain("type === 'active-msg-subscription-change'");
  });
});

describe('④ 多設備說明文案', () => {
  it('全局設置彈窗的通知區塊裡說明「推送跟著排程時所在的設備走」', () => {
    const src = read('../components/settings/ActiveMsgGlobalSettingsModal.tsx');
    expect(src).toContain('排程時所在的設備');
    expect(src).toContain('重新保存一次');
  });
});
