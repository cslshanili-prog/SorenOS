// amsg2 打髒入口 & 刪角色阻塞的接線守衛。
//
// 倉庫的 vitest 是純 Node 環境（沒裝 jsdom），OSContext / Chat / Character 這些 React
// 組件沒法真渲染起來測行為，這裡退而求其次做**源碼級**斷言：把「保存路徑後面跟著
// markAmsgStateDirty」「刪角色會被雲端清理失敗攔下」這幾處接線釘住，誰把調用刪了
// 這裡就紅。它驗證不了運行時時序，只防「接線被誤刪」這一種迴歸——補上組件測試基建
// 後應該換成真正的行為測試。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');

/** 取 [start, end) 之間的源碼片段；找不到錨點直接讓斷言失敗。 */
const sliceBetween = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  expect(i, `找不到錨點: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `找不到結束錨點: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

describe('打髒入口接線（保存後調 markAmsgStateDirty）', () => {
  it('OSContext.updateCharacter：落庫成功後打髒（改人設/改記憶/面板取消任務的匯合點）', () => {
    const src = read('../context/OSContext.tsx');
    const fn = sliceBetween(src, 'const updateCharacter = async', 'const deleteCharacter');
    // 時序也要釘住：是「落庫成功後」（saveCharacter 的 then 裡），不是隨手同步調一下。
    expect(fn).toMatch(/DB\.saveCharacter\(target\)\.then\([\s\S]*?markAmsgStateDirty\(/);
  });

  it('Chat：刪除 / 編輯 / 清空消息路徑都打髒', () => {
    const src = read('../apps/Chat.tsx');
    for (const [start, end] of [
      ['const handleDeleteMessage', 'const confirmEditMessage'],
      ['const confirmEditMessage', 'const handleQuickReply'],
      ['const handleHistoryCleanupDone', '// 只在打開聊天設置時計算一鍵存入'],
      ['const handleReroll', 'const handleImageSelect'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 裡少了打髒調用`).toContain('markAmsgStateDirty(');
    }
  });

  it('OSContext 啟動路徑接了底帳補傳 resumePendingAmsgStateSync', () => {
    expect(read('../context/OSContext.tsx')).toContain('resumePendingAmsgStateSync({');
  });
});

// 換 Key 之後雲端那幾行憑據不重傳的話，已排程的任務到點全部 401，而界面上一切正常。
// 保存配置那兩處是它唯一的觸發點，接線被刪就沒人補了。
describe('LLM 憑據行的重傳接線', () => {
  it('設置頁換聊天 API：重傳憑據行 + 存量內聯任務照舊補刷（兩條並存）', () => {
    const src = read('../apps/Settings.tsx');
    // 保存按鈕和點預設切換匯到 commitApiConfig 這一個出口，憑據接線掛在它身上。
    const fn = sliceBetween(src, 'const commitApiConfig', 'const applyPreset');
    expect(fn).toContain('syncAmsgLlmCredentials(');
    expect(fn, '存量內聯任務還靠它續命，不能順手退役')
      .toContain('ActiveMsgClient.refreshApiCredentialsForPendingTasks(');
    // 兩個入口都得走這個出口：繞過去就是「聊天換了 API、後台任務還拿舊 Key」
    expect(sliceBetween(src, 'const handleSaveApi', 'const handleSaveVisionApi')).toContain('commitApiConfig(');
    expect(sliceBetween(src, 'const applyPreset', 'const openEditPreset')).toContain('commitApiConfig(');
  });

  it('角色 2.0 面板保存（單獨 API 可能剛改過）：也重傳一次', () => {
    expect(read('../components/chat/ActiveMsg2SettingsModal.tsx')).toContain('syncAmsgLlmCredentials(');
  });

  it('啟動補傳把 apiConfig 也遞進去（缺了它憑據那一項永遠補不上）', () => {
    const src = read('../context/OSContext.tsx');
    const call = sliceBetween(src, 'resumePendingAmsgStateSync({', '});');
    expect(call).toContain('apiConfig:');
  });

  it('刪角色時連它名下那幾行憑據一起清（keys 是 API Key，不能留在雲端）', () => {
    const src = read('./amsg2CharCleanup.ts');
    expect(src).toContain('deleteLlmCredentials({ credIds: charCredIds(');
  });
});

// 「更新 Worker」之後必須跑一次 init-tenant：新版後端帶了新表（這一波是 llm_credentials），
// 而建表只在那個端點裡做。少了它，代碼是新的、表還是舊的，cron 每分鐘靜默失敗。
describe('更新 Worker 之後的自動驗證', () => {
  it('自更新成功後接著 connect()（POST /init-tenant，新表在這一步建出來）', () => {
    const src = read('../components/settings/ActiveMsgGlobalSettingsModal.tsx');
    const fn = sliceBetween(src, 'const handleSelfUpdateWorker', 'const handleAttachUpdateKey');
    expect(fn).toContain('await ActiveMsgClient.connect()');
    expect(fn, '驗證沒過要單獨說，別把「代碼換上了」和「表補齊了」混成一句').toContain('重新連接並驗證');
  });
});

describe('刪角色阻塞接線（雲端任務清不掉先不刪本地）', () => {
  it('deleteCharacter：await 雲端清理、失敗返回 cloud-cleanup-failed', () => {
    const src = read('../context/OSContext.tsx');
    const fn = sliceBetween(src, 'const deleteCharacter = async', 'const createCharacterGroup');
    expect(fn).toContain('await ActiveMsgClient.cancelAllTasksForChar(');
    expect(fn).toContain("return { status: 'cloud-cleanup-failed' }");
    // 舊實現的「void (async () => { cancelAllTasksForChar ... })()」整段後台化是這次
    // 修的病根；只允許 force（仍然刪除）和無任務兩條路走後台。
    expect(fn).toContain("options?.force");
  });

  it('角色 App 對 cloud-cleanup-failed 彈「重試 / 仍然刪除」', () => {
    const src = read('../apps/Character.tsx');
    expect(src).toContain("cloud-cleanup-failed");
    expect(src).toContain('仍然刪除');
    expect(src).toMatch(/runDeleteCharacter\(cloudCleanupFailTarget, true\)/);
  });
});
