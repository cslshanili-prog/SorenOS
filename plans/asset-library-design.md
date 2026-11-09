# 資料庫（相簿改版）設計

> 狀態：四批都做完了（2026-11-07）：資料庫畫面、描述、分配、上傳；角色知道手邊的照片、能原樣傳出去；在資料庫裡生成；協同文件歸檔。提議來自 Liora（2026-11-07）：相簿改成「資料庫」——除了 Soren 生成的圖，也能自己上傳現成的圖、寫描述、直接在這裡生成照片，分配給角色用；協同工作做出來的文件也能歸檔進來。

## 現況

| | 存在哪 | 限制 |
|---|---|---|
| 相簿 | `gallery_images` 表（`GalleryImage`），圖本身是 blobref 令牌、二進制在 `blob_assets` | 每張綁**一個**角色（`charId`）；只記「誰傳的」（`sender`）和來源（`origin`，見面「拍下這一刻」才有）；沒有描述、不能自己上傳、角色不知道它們存在 |
| 角色發照片 | 私聊 `[[ACTION:SEND_PHOTO\|畫面描述]]` → `utils/pendingPhoto.ts` 現場生成 | 每次都重新生成（要錢、臉會飄），不能傳一張已經有的圖 |
| 協同工作的文件 | 獨立的 IndexedDB `SullyOS_Collaboration`（`features/collaboration/store.ts` 的 `assets`／文件櫃） | 只在那個協同視窗的文件櫃裡看得到 |

## 決定（Liora 已確認）

- 「分配給角色」＝ 角色**知道有這張圖**，而且**可以當成自己的照片傳給你**
- 「拿來當生圖參考」還沒想好，先不做，資料結構留位置
- 協同文件：**你選了才歸檔**，不自動複製
- App 改名「資料庫」
- 分配有三種：**所有角色共用**（一鍵、大家都能用）、**照世界分**（某幾個世界的角色能用）、**指定角色**

## 資料結構

**沿用相簿那張 `gallery` 表（`GalleryImage`），不另開新表**。原本設計稿寫的是新表 `library_items`，動工時改了：這張表已經接好完整備份、內容收藏（`contentFavorites` 按 id 回指）、存儲優化，還在圖片清理（`utils/blobGc.ts`）的引用面清單裡——另開新表得每條路重接一次，漏掉 GC 那條，只存在資料庫裡的上傳圖會被當成孤兒刪掉。所以也不用搬遷：舊圖原地不動，新欄位缺省就是舊行為。

`GalleryImage` 加的欄位（`types.ts`）：

```ts
type LibraryAccess =
  | { mode: 'all' }                              // 所有角色共用（之後新加的角色也算）
  | { mode: 'worlds'; worldIds: string[] }       // 世界＝神經鏈接分組（CharacterGroup，角色的 groupId）
  | { mode: 'chars'; charIds: string[] };        // 指定角色

interface GalleryImage {
  // …原本的 charId / url / sender / origin / review / chatContext…
  origin?: 'date_moment' | 'upload';             // 'upload'＝在資料庫自己上傳的，charId 是空字串
  description?: string;                          // 寫給角色看的描述，最多 500 字
  access?: LibraryAccess;                        // 沒寫＝原本那個角色（charId）
}
```

純邏輯在 `utils/library.ts`：
- `librarySourceOf`：來源六種（角色傳的／你傳的／見面拍的／你上傳的／在這裡生成的／協同歸檔的）；`isLibraryFile` 分照片和文件
- `resolveLibraryAccess`：沒寫分配的舊圖＝`{ mode: 'chars', charIds: [charId] }`；上傳的沒有來源角色，沒寫就是沒人能用（上傳時一定會寫，預設共用）
- `canCharUseLibraryImage`：第二批「角色知道有這張圖」就照它挑
- 改描述、分配走 `DB.updateGalleryImage`：讀最新那行再合併，不會蓋掉同時寫進去的點評

後來加的欄位：生成記錄 `generation`（第三批）、`kind: 'image' | 'file'` ＋ `file { name, mime, size, collabAssetId?, sessionTitle? }`、`origin: 'collab'`（第四批）。「拿來當生圖參考」還沒定，到時候也加在這張表上。

## 畫面

- **瀏覽**：所有照片放一起（不再按角色分相冊），按來源篩（角色傳的／你傳的／見面拍的／你上傳的／在這裡生成的），也能按角色篩「誰能用」（看某個角色能用哪些，含共用和照世界的）。「文件」分頁第四批再加
- **單張**：大圖、來源那行、描述（離開輸入框就存）、誰能用（改了立刻存）、收藏、刪除（只刪資料庫這筆，聊天／見面記錄裡那張不動）；你在私聊傳給角色的照片照舊有「讓 TA 點評」和當時的對話
- **AI 寫描述**：描述欄右上角「AI 寫」，選一個 API（主 API 或任一 API 預設，要能看圖；選過的記在本機）看圖寫一到三句客觀描述，直接換掉欄位裡的字；原本有字的話旁邊留一顆「還原」。單張和上傳兩處都有（`utils/libraryDescribe.ts`、`components/library/LibraryDescribeButton.tsx`）
- **上傳**：右上角「上傳」→ 選圖（壓到長邊 2048）→ 寫描述 → 分配（預設所有角色共用）→ 存進資料庫
- **在這裡生成**（右上角「生成」，`utils/libraryGenerate.ts`、`components/library/LibraryGenerateView.tsx`）：選類型（獨照／合照／物品／風景）→ 選人（獨照一個、合照兩到八個，「你」也算一個）→ 寫想拍什麼 → 生成 → 先看預覽，滿意了寫描述、選誰能用再存（`origin: 'generated'`，`generation` 記類型、送出去的提示詞、照片裡有誰、鎖了幾張臉）；不滿意就重新生成，沒存的不留
  - 每個人一行「人物一：長相；長相照第 N 張參考圖」，有參考圖的照順序一起送（不看「非自拍不帶參考圖」那個開關）；生圖服務不收多張就只鎖第一張，再不行純文字，預覽下面會說鎖了幾張
  - 你的長相：照片裡第一個角色認識的那張身份卡（`resolveUserProfileForChar`）；只有你自己的獨照用目前的身份卡
  - 物品、風景不帶參考圖，提示詞寫明畫面裡沒有人
  - 描述預設帶入你寫的提示詞，也能按「AI 寫」看圖重寫；分配預設給照片裡的角色，物品風景和只有你的獨照預設共用
  - 只要生圖 API 填了網址和模型就能用，不需要開「角色生圖」開關
- **協同文件櫃**（`utils/libraryArchive.ts`）：文件櫃長按一份文件 → 「歸檔到資料庫」（可安裝作品不給，它們在協同裡安裝才有意義），複製一份 Blob 進 `blob_assets`，協同那邊原樣不動、刪了也不影響這份。圖片歸成照片、其他歸成文件（`kind: 'file'`），`origin: 'collab'`，`file` 記檔名、類型、大小、協同的 assetId（同一份只歸一次）和窗口標題；預設給那個協同角色
- **文件分頁**：資料庫上面「照片／文件」兩個分頁，文件一行一份，也能按「誰能用」篩；單份詳情有「打開／下載」（走系統分享，不支援就下載）、備註、誰能用、刪除。文件不進照片格子、不列給角色當照片傳；角色在私聊讀資料庫的文件還沒做，分配先存著

## 角色怎麼用

純邏輯在 `utils/libraryPrompt.ts`。

1. **知道有這張圖**：私聊提示詞的易變段加一節「你手邊的照片」（新照片隨時進來，放易變段不弄髒穩定段快取）。列的是**分配給這個角色（含共用、照世界）而且有描述**的照片，最近的 20 張，每張一行 `編號｜來源｜描述`，描述截到 60 字。沒描述的不列：角色「知道」一張圖靠的就是描述。來源只對這個角色自己的那幾張說（你之前傳過的／對方傳給你的／見面時拍的），別的角色私聊裡的事它不該知道
2. **自動有描述的**：角色 `SEND_PHOTO` 生成的照片，用它自己寫的畫面描述；見面「拍下這一刻」用那一刻的畫面。所以角色自己拍過的照片，之後能再傳。你在私聊傳的、舊相簿的圖要你自己寫描述才會出現
3. **當成自己的照片傳**：`[[ACTION:SEND_SAVED_PHOTO|編號]]`，`ChatParser.settleSavedPhotoCommands` 照編號找回那張，原樣落一條 `type: 'image'` 的訊息（`metadata.savedPhoto.libraryImageId`、`visionDescription`＝描述），不生成、不花錢、臉不會飄。編號對不上（列表外、刪了、不再分配給它）就不發、留日誌；同一則寫兩次同一張只發一次。跟 `SEND_PHOTO` 並存：想要新的畫面還是現場生成，這個不需要生圖 API
4. **編號**：從圖的 id 算出來（FNV-1a 取 4 位 36 進位），不是列表順序——提示詞送出到回覆解析之間資料庫多了一張也對得上
5. **哪些路徑帶**：`PromptBuildOptions.libraryPhotos`（`buildChatRequestPayload` 的 `libraryPhotos`）傳 true 的才帶，現在是私聊前台（`useChatAI` → `applyAssistantPostProcessing` → `parseAndExecuteActions`）和背景延遲回覆（OSContext，單獨調 `settleSavedPhotoCommands`）。協同、彼方這些借用私聊提示詞的入口不傳
6. **雲端也帶**（2026-11-09）：fire_pack（`activeMsgClient.ts` 打包時傳 `libraryPhotos: true`）和即時對話（`timelyByWorker`）都帶「你手邊的照片」。worker 的透傳清單（`SOREN_PASSTHROUGH_TAG_RE`）放行 `SEND_SAVED_PHOTO`，以 `soren_tag` 原樣送回，收件時跟本機回覆走同一份後處理（`applyAssistantPostProcessing` → `parseAndExecuteActions` → `settleSavedPhotoCommands`）。`AMSG_BUNDLE_VERSION` 推到 2026-11-09：舊 Worker 會把標籤剝掉，設定頁會提示重新部署
   - fire_pack 裡是打包那一刻的清單：編號從 id 算，到點才傳也對得上；那段時間被刪掉、或不再分配給它的，收件時找不到就不發
   - 資料庫改了描述、分配，或上傳、生成、刪除，都會對所有開了主動消息的角色打髒（`markAmsgStateDirtyForAll`），雲端那份跟著刷新

## 分批

| 批 | 內容 |
|---|---|
| 1 ✅ | 相簿表加描述／分配、資料庫畫面（瀏覽、篩選、上傳、描述、分配）；App 改名資料庫 |
| 2 ✅ | 角色知道＋`SEND_SAVED_PHOTO`（雲端還沒接） |
| 3 ✅ | 在資料庫裡生成（獨照／合照／物品／風景） |
| 4 ✅ | 協同文件歸檔 |
