// amsg2 打髒缺口補完後的接線守衛（通話 / 群聊 / 見面 / 日程 / 生活記錄 / 聽歌加歌單 /
// 改用戶資料 / 世界書 / 情緒廣播 / 角色自排任務 / 備份導入）。
//
// 和 amsgStateSync.wiring.test.ts 同一套路數：倉庫的 vitest 是純 Node 環境（沒裝 jsdom，
// vitest.config.ts 也只收 utils / worker / scripts 下的測試），React 組件渲染不起來，
// 只能做**源碼級**斷言。它驗證不了運行時時序，只防「接線被誤刪」這一種迴歸。
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

const OS_CONTEXT = '../context/OSContext.tsx';
const MUSIC_CONTEXT = '../context/MusicContext.tsx';

// ─── 跨模塊事件名（改一個字兩邊就對不上，靜默斷供）───

describe('utils 層直寫 DB 後的內存回灌（事件名契約）', () => {
  it('OSContext 對主動消息處理失敗給出有冷卻的可見提示', () => {
    const src = read(OS_CONTEXT);
    expect(src).toContain('const inboxFailHandler = (e: Event) =>');
    expect(src).toContain("window.addEventListener('active-msg-process-failed', inboxFailHandler)");
    expect(src).toContain("window.removeEventListener('active-msg-process-failed', inboxFailHandler)");
    expect(src).toContain('inboxFailToastAt[charId]');
  });

  it('OSContext 監聽 amsg2-tasks-adopted：重讀 DB → 只合並 activeMsg2Config → 打髒', () => {
    const src = read(OS_CONTEXT);
    // 事件名一字不差：派發方（activeMsgRuntime 採納角色自排任務）按這個名字發。
    expect(src).toContain("window.addEventListener('amsg2-tasks-adopted'");
    expect(src).toContain("window.removeEventListener('amsg2-tasks-adopted'");

    const handler = sliceBetween(src, 'const tasksAdoptedHandler', 'const musicProfileSyncHandler');
    expect(handler).toContain('detail || {}).charId');
    // 順序釘住：任務清單隻落在 DB，必須重讀 DB 再合併，不能拿內存裡那份舊的。
    expect(handler).toMatch(/DB\.getAllCharacters\(\)[\s\S]*?activeMsg2Config: fresh\.activeMsg2Config/);
    // 只搬 activeMsg2Config 一個字段：整對象覆蓋會把內存裡更新的字段頂回去。
    expect(handler).not.toMatch(/setCharacters\([\s\S]*?\?\s*fresh\s*:/);
    // 合併進內存 + 打髒是一套動作，缺哪一半都算斷供。
    expect(handler).toMatch(/setCharacters\([\s\S]*?markAmsgStateDirty\(/);
  });

  it('MusicContext 加歌落庫後廣播 char-music-profile-updated（帶 charId + musicProfile）', () => {
    const src = read(MUSIC_CONTEXT);
    const fn = sliceBetween(src, 'addSongToCharPlaylist: async', '\n    };\n  }, [current');
    // 先落庫再廣播——反過來的話監聽方拿到的 musicProfile 還沒進 DB。
    expect(fn).toMatch(/DB\.saveCharacter\([\s\S]*?dispatchEvent\(new CustomEvent\('char-music-profile-updated'/);
    expect(fn).toContain('detail: { charId: cid, musicProfile: updatedProfile }');
  });

  it('OSContext 監聽 char-music-profile-updated：同步進內存 characters + 打髒', () => {
    const src = read(OS_CONTEXT);
    expect(src).toContain("window.addEventListener('char-music-profile-updated'");
    expect(src).toContain("window.removeEventListener('char-music-profile-updated'");

    const handler = sliceBetween(src, 'const musicProfileSyncHandler', "window.addEventListener('amsg2-tasks-adopted'");
    // 內存不回灌的話，之後任一 updateCharacter 會拿舊內存把剛加的歌反向抹掉。
    expect(handler).toMatch(/setCharacters\([\s\S]*?musicProfile[\s\S]*?markAmsgStateDirty\(/);
  });
});

// ─── 備份導入後的雲端對帳 ───

describe('備份導入後跟 amsg2 雲端對帳', () => {
  const importTail = () =>
    sliceBetween(read(OS_CONTEXT), '// ─── 主動消息 2.0：導入後跟雲端對一次帳', 'setSysOperation({ status: \'idle\', message: \'\', progress: 100 })');

  it('沒配 worker 一個請求都不發', () => {
    const tail = importTail();
    expect(tail).toContain('ActiveMsgStore.getGlobalConfig()');
    expect(tail).toMatch(/workerUrl\?\.trim\(\)[\s\S]*?if \(amsgWorkerUrl\)/);
  });

  it('無主任務（角色已不在新檔裡）逐個 cancel', () => {
    const tail = importTail();
    expect(tail).toContain('ActiveMsgClient.listAllTasks()');
    expect(tail).toContain('knownCharIds.has(owner)');
    expect(tail).toContain('ActiveMsgClient.cancelTask(');
  });

  it('任務沒投影出主人時也當無主任務取消，不額外設門跳過', () => {
    const tail = importTail();
    expect(tail).not.toContain('hasCharIdProjection');
    // 只有「主人還在新檔裡」才放過，其餘（含沒主人的）一律取消
    expect(tail).toMatch(/if \(owner && knownCharIds\.has\(owner\)\) continue;[\s\S]*?cancelTask\(/);
  });

  it('導入進來的角色刷雲端快照 + 憑據走同一個入口上傳', () => {
    const tail = importTail();
    expect(tail).toContain('syncAmsgToolConfigAndPrompts(');
    expect(tail).toContain('characters: importedChars');
  });

  it('整段 best-effort：雲端夠不著不讓導入失敗', () => {
    const tail = importTail();
    expect(tail).toMatch(/try \{[\s\S]*?\} catch \(e\) \{[\s\S]*?console\.warn/);
    expect(tail).not.toContain('throw');
  });
});

// ─── 其餘打髒入口（補一行就夠的那些，只釘「有沒有接上」）───

describe('其餘打髒入口接線', () => {
  it('OSContext：改用戶資料 / 世界書增刪 / 群增刪改 / 情緒廣播都打髒', () => {
    const src = read(OS_CONTEXT);
    for (const [start, end] of [
      // 用戶資料是全角色共享素材（名字烤在模板裡），走 ForAll
      ['const updateUserProfile', 'const addCustomTheme'],
      // 世界書同步角色緩存那兩處繞開了 updateCharacter 的匯聚點
      ['const updateWorldbook', 'const deleteWorldbook'],
      ['const deleteWorldbook', '// Novel Methods'],
      // 情緒 buff 廣播：一個點堵住 emotionApply / memoryDive 等幾個上游
      ['const buffSyncHandler', '// 本地 fetch 聊天回覆的全局回落'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 裡少了打髒調用`).toMatch(/markAmsgStateDirty(ForAll)?\(/);
    }

    // 群名 / 成員變了，成員的 fire_pack 裡那份群信息要跟著刷（走 markGroupMembersDirty）
    expect(sliceBetween(src, 'const markGroupMembersDirty', 'const createGroup'))
      .toContain('markAmsgStateDirty(');
    for (const [start, end] of [
      ['const createGroup', 'const updateGroup'],
      ['const updateGroup', 'const deleteGroup'],
      ['const deleteGroup', '// Worldbook Methods'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 裡少了對成員打髒`).toContain('markGroupMembersDirty(');
    }
  });

  it('CallApp：用戶發言 / 角色回覆 / 掛斷落庫後都打髒', () => {
    const src = read('../apps/CallApp.tsx');
    expect(src).toContain("import { markAmsgStateDirty } from '../utils/amsgStateSync'");
    // 通話三個落庫點各跟一次（同一個事件循環裡的會在微任務內合併成一次上傳）。
    // 接通後不再自動生成開場白，必須等用戶明確發送。
    expect(src.match(/markCallTurnDirty\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const finishCall = sliceBetween(src, 'const finishCall = async', 'const handleHangup');
    expect(finishCall, '掛斷這一下最要緊（用戶接著就關 App）').toContain('markCallTurnDirty()');
  });

  it('GroupChat：群消息 / 一輪收尾 / 話題盒歸檔都對成員打髒', () => {
    const src = read('../apps/GroupChat.tsx');
    expect(src).toContain('markAmsgStateDirty(');
    for (const [start, end] of [
      ['const handleSendMessage = async', 'const handleImageFile'],
      ['const createNextGroupTopicBox', 'const runGroupTopicArchive'],
      ['const triggerDirector = async', '// 輪詢模式'],
      ['const triggerRoundRobin = async', '// 觸發入口'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 裡少了對成員打髒`).toContain('markGroupMembersDirty(');
    }
  });

  it('DateApp：輪次落庫與刪改處理器都打髒（對齊 Chat.tsx）', () => {
    const src = read('../apps/DateApp.tsx');
    for (const [start, end] of [
      ['const handleSendMessage = async', 'const handleReroll'],
      ['const handleReroll = async', '// --- Editing & Deletion ---'],
      ['const handleDeleteMessage = async', 'const handleDeleteMessages'],
      ['const handleDeleteMessages = async', 'const confirmEditMessage'],
      ['const confirmEditMessage = async', '// --- History Long Press ---'],
      ['const handleHistoryDelete = async', 'const handleHistoryEditOpen'],
      ['const handleHistoryEditConfirm = async', 'const onExitSession'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 裡少了打髒調用`).toContain('markDateTurnDirty(');
    }
  });

  it('Chat：日程編輯 / 刪除 / 跨天重新生成 + 生活記錄否決都打髒', () => {
    const src = read('../apps/Chat.tsx');
    for (const [start, end, expected] of [
      ['const handleScheduleEdit', 'const handleScheduleDelete', 'markAmsgStateDirty('],
      ['const handleScheduleDelete', 'const handleScheduleCoverChange', 'markAmsgStateDirty('],
      ['const generateDailySchedule', 'const handleScheduleStyleChange', 'markAmsgStateDirty('],
      // 生活記錄注入所有開了開關的角色 → ForAll
      ['const handleResolveLifeRecord', 'const handleManualTrigger', 'markAmsgStateDirtyForAll('],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 裡少了打髒調用`).toContain(expected);
    }
    // 封面圖不進包、小劇場緩存不進 scene —— 這兩處不該順手加
    expect(sliceBetween(src, 'const handleScheduleCoverChange', 'const runTheater'))
      .not.toContain('markAmsgStateDirty');
  });

  it('LifeRecordPanel：寫庫後打髒，首次進面板（只讀）不打', () => {
    const src = read('../components/lifeRecord/LifeRecordPanel.tsx');
    const reload = sliceBetween(src, 'const reload = async', 'useEffect(() => { reload(');
    expect(reload).toContain('if (mutated) markAmsgStateDirtyForAll(');
    expect(src, '首次加載只是讀庫，不該把所有角色的快照都推一遍').toContain('useEffect(() => { reload(false); }, []);');
  });

  it('ValentineEvent：節日事件消息落庫後打髒', () => {
    const src = read('../components/ValentineEvent.tsx');
    const fn = sliceBetween(src, 'const generateValentineMessage = async', '/** 點擊屏幕推進對話 */');
    expect(fn).toMatch(/DB\.saveMessage\([\s\S]*?markAmsgStateDirty\(/);
  });
});
