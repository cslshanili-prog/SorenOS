# 資料庫（相簿改版）設計

> 狀態：第一、二批已做（2026-11-07）：資料庫畫面、描述、分配、上傳；角色知道手邊的照片、能原樣傳出去。第三批起還沒動。提議來自 Liora（2026-11-07）：相簿改成「資料庫」——除了 Soren 生成的圖，也能自己上傳現成的圖、寫描述、直接在這裡生成照片，分配給角色用；協同工作做出來的文件也能歸檔進來。

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
- `librarySourceOf`：來源五種裡的四種（角色傳的／你傳的／見面拍的／你上傳的），第三批加「在這裡生成的」
- `resolveLibraryAccess`：沒寫分配的舊圖＝`{ mode: 'chars', charIds: [charId] }`；上傳的沒有來源角色，沒寫就是沒人能用（上傳時一定會寫，預設共用）
- `canCharUseLibraryImage`：第二批「角色知道有這張圖」就照它挑
- 改描述、分配走 `DB.updateGalleryImage`：讀最新那行再合併，不會蓋掉同時寫進去的點評

之後再加的欄位（第三、四批）：生成記錄 `generation { prompt, lock }`、文件 `kind: 'file'` ＋ `file { name, mime, size }`；「拿來當生圖參考」還沒定，到時候也加在這張表上。

## 畫面

- **瀏覽**：所有照片放一起（不再按角色分相冊），按來源篩（角色傳的／你傳的／見面拍的／你上傳的；第三批加在這裡生成的），也能按角色篩「誰能用」（看某個角色能用哪些，含共用和照世界的）。「文件」分頁第四批再加
- **單張**：大圖、來源那行、描述（離開輸入框就存）、誰能用（改了立刻存）、收藏、刪除（只刪資料庫這筆，聊天／見面記錄裡那張不動）；你在私聊傳給角色的照片照舊有「讓 TA 點評」和當時的對話
- **上傳**：右上角「上傳」→ 選圖（壓到長邊 2048）→ 寫描述 → 分配（預設所有角色共用）→ 存進資料庫
- **在這裡生成**：寫提示詞 → 選類型（獨照／合照／物品／風景）→ 選角色（獨照選一個、合照選兩個以上，用各自的參考圖鎖臉，你用身份卡的長相）→ 生成後先預覽，滿意才存
- **協同文件櫃**：每個文件多一顆「歸檔到資料庫」，複製一份進來；資料庫裡可以打開、下載、分配

## 角色怎麼用

純邏輯在 `utils/libraryPrompt.ts`。

1. **知道有這張圖**：私聊提示詞的易變段加一節「你手邊的照片」（新照片隨時進來，放易變段不弄髒穩定段快取）。列的是**分配給這個角色（含共用、照世界）而且有描述**的照片，最近的 20 張，每張一行 `編號｜來源｜描述`，描述截到 60 字。沒描述的不列：角色「知道」一張圖靠的就是描述。來源只對這個角色自己的那幾張說（你之前傳過的／對方傳給你的／見面時拍的），別的角色私聊裡的事它不該知道
2. **自動有描述的**：角色 `SEND_PHOTO` 生成的照片，用它自己寫的畫面描述；見面「拍下這一刻」用那一刻的畫面。所以角色自己拍過的照片，之後能再傳。你在私聊傳的、舊相簿的圖要你自己寫描述才會出現
3. **當成自己的照片傳**：`[[ACTION:SEND_SAVED_PHOTO|編號]]`，`ChatParser.settleSavedPhotoCommands` 照編號找回那張，原樣落一條 `type: 'image'` 的訊息（`metadata.savedPhoto.libraryImageId`、`visionDescription`＝描述），不生成、不花錢、臉不會飄。編號對不上（列表外、刪了、不再分配給它）就不發、留日誌；同一則寫兩次同一張只發一次。跟 `SEND_PHOTO` 並存：想要新的畫面還是現場生成，這個不需要生圖 API
4. **編號**：從圖的 id 算出來（FNV-1a 取 4 位 36 進位），不是列表順序——提示詞送出到回覆解析之間資料庫多了一張也對得上
5. **哪些路徑帶**：`PromptBuildOptions.libraryPhotos`（`buildChatRequestPayload` 的 `libraryPhotos`）傳 true 的才帶，現在是私聊前台（`useChatAI` → `applyAssistantPostProcessing` → `parseAndExecuteActions`）和背景延遲回覆（OSContext，單獨調 `settleSavedPhotoCommands`）。協同、彼方這些借用私聊提示詞的入口不傳
6. **雲端先不帶**：fire_pack 和即時對話（`timelyByWorker`）都不帶，worker 的透傳清單（`SOREN_PASSTHROUGH_TAG_RE`）也還沒加這個標籤。要接得在 worker 側先放行標籤，客戶端沖刷時再走 `settleSavedPhotoCommands`

## 分批

| 批 | 內容 |
|---|---|
| 1 ✅ | 相簿表加描述／分配、資料庫畫面（瀏覽、篩選、上傳、描述、分配）；App 改名資料庫 |
| 2 ✅ | 角色知道＋`SEND_SAVED_PHOTO`（雲端還沒接） |
| 3 | 在資料庫裡生成（獨照／合照／物品／風景） |
| 4 | 協同文件歸檔 |
