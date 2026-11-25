# 備份改成邊壓邊寫（iPhone 備份到 9x% 分頁被關掉）

> 狀態：**Liora 2026-11-25 點頭**（確認 Sully ⇌ Soren 互轉不受影響就改）。**第 1 批做完**（實況在第 10 節），第 2～4 批還沒做。備份檔格式不變，舊備份照樣能還原。

## 1. 現象

用戶回報（都是 iPhone 的 Safari）：「整合導出 ZIP」或「雲端備份」跑到 9x% 時，畫面突然回到鎖屏；再試一次，Safari 顯示「『https://soren-os.vercel.app/』重複發生問題」，只能滑掉重開。有機率，不是每次。

這不是我們的程式丟錯：

- 回到鎖屏＝分頁被 iOS 強制收掉後自動重新載入，App 等於重開機。
- 「重複發生問題」＝同一個分頁短時間內被收掉第二次，Safari 不再重載。
- 所以沒有紅膠囊，錯誤記錄裡也沒有。

iPhone 對單一分頁的記憶體有上限（WebKit 工程師的說法是一般機型約 1.5 GB，新機高一些，系統吃緊時更早動手）。備份跑到尾段時我們握著的資料越過那條線，分頁就被關掉。

還沒在實機上重現，是照症狀和程式碼對出來的。第 1 批會先加「上次備份跑到哪裡被關掉」的痕跡（第 4.6 節），用來在用戶那邊確認。

## 2. 現況：尾段同時握著幾份

整合導出、媒體導出、雲端備份走同一個函式（`context/OSContext.tsx` 的 `exportSystem`），進度 70%～99% 是 JSZip 的 `generateAsync`。到那時記憶體裡有：

| 握著什麼 | 哪裡來的 | 多大 | 什麼時候放 |
|---|---|---|---|
| 整張資料表 | `DB.getRawStoreData`（`getAll`）一張一張讀進 `backupData` | 全部文字資料的物件 | `writeV2Backup` 寫成分片後才放 |
| 文字分片 | `stores/<欄位>.NNN.json`，每片最多 3200 萬字 | 全部文字，JS 字串（中文一個字佔 2 位元組） | 打包結束 |
| 舊格式內嵌圖片 | 資料裡的 `data:image…` 抽成 `assets/*`，JSZip 留著 base64 字串 | 圖片大小 × 1.33 | 打包結束 |
| 去重表 | `assetDedupMap`，**拿整串 base64 當鍵** | 跟上一列共用同一批字串，但讓它們放不掉 | 打包結束 |
| 新格式圖片 | `writeBlobsToZip` 把每張圖 `blob.arrayBuffer()` 讀進來放進 zip | 圖片原始大小 × 1 | 打包結束 |
| 語音、協同文件、向量 | 各自讀成位元組放進 zip | 原始大小 × 1 | 打包結束 |
| 輸出 | `generateAsync({ type: 'blob' })` 邊壓邊攢，最後串成一個 Blob | 接近整包大小（圖片不壓縮，等於圖片再一份） | 交給下載／上傳之後 |

最高點落在最後幾 %：前面幾列要等結束才放，最後一列隨進度長大。粗估是「媒體 × 2 以上＋全部文字」。圖片有 500 MB 的人，尾段就在 1 GB 以上。

「純文字備份」之前已經改成游標逐條讀、邊讀邊寫分片（`createV2ArrayFieldWriter`），又不含圖，所以沒事。出事的是整合和媒體這條路。

下游也看一下：

- **下載**（`apps/Settings.tsx` → `utils/shareExport.ts`）：拿到 Blob 後 `navigator.share` 或 `<a download>`，不再複製。
- **WebDAV**：整個 Blob 當請求內容送出，經 Worker 中轉時上限 100 MB。
- **GitHub**：`blob.slice` 切成 32 MB 一片一片傳。
- 三個都只需要「一個 Blob」，換成磁碟上的檔案（`File`）不用改。

**還原更重**（`importSystem`）：`JSZip.loadAsync(file)` 先把整個 zip 讀進記憶體，再把全部資料組回一個大物件，圖片還原成 base64 塞回去，最後才寫庫。在 iPhone 上還原大備份，照理比導出更早被關。這次的回報是導出，但只修導出會變成「備得出來、還原不了」，所以放進同一份計畫（第 3 批）。

### 從上游 Sully 搬過來的備份

Soren 的備份格式是從上游帶過來的，讀的那邊三種都收（`importSystem`）：

| 格式 | 長相 | 還原時多重 |
|---|---|---|
| v1（早期） | zip 裡一根 `data.json`，圖片在 `assets/*` | 最重：整根 `data.json` 解壓成一條大字串再整個 `JSON.parse`，沒有分片可以一段一段來 |
| v2 | `manifest.json`＋`stores/*.json` 分片，圖片在 `assets/*`（還原時變回 base64 塞進資料） | 重：分片本身可以一段一段讀，但現在是全部組回一個大物件 |
| v3（Soren 現在寫的） | 同 v2，新格式圖片走 `blobs/*`，直接存成 Blob | 同 v2，圖片那部分輕一些 |

所以：

- **相容性不受這份計畫影響**。導出的格式不變（上游讀得了我們的包）；還原照舊三種都收（我們讀得了上游的包，不管新舊）。`assertSupportedSullyBackup` 擋的是別的系統的備份，不是 Sully。
- **上游的包在 iPhone 上還原，現在就會被關**，跟還原自己的包是同一條路、同一個問題，資料大的人從 Sully 搬家過來最容易中。要到第 3 批才收掉。
- **上游那邊導出時一樣會被關**（同一份程式），那個我們改不了。搬家的人在上游導不出來時，只能用第 8 節的繞法，或在電腦上導。
- **從雲端還原更重**（`cloudRestoreFromWebDAV`）：WebDAV 和 GitHub 都是先把整包下載進記憶體（`downloadBackup` 把每一段攢起來），再交給 `importSystem`，等於同一包握兩次。

## 3. 定案方向

三件事一起做，缺一個都還是會握著整包：

1. **輸入一個一個來**：資料表分批讀、圖片一張一張讀，寫完就放。
2. **打包邊壓邊吐**：不用 JSZip 那種「先全部登記、最後一次生成」的模型，自己寫一個串流的 zip 寫入器，每個檔案進來就壓好吐出去，只記住目錄。
3. **輸出落磁碟**：吐出來的位元組寫進瀏覽器的私有檔案區（OPFS），最後拿到的是磁碟上的 `File`，不佔記憶體。

做完之後，最高點是「一批資料＋一張圖＋一個分片」，幾十 MB，跟資料總量無關。

### 不這樣做的理由

- **只把 JSZip 換成 `generateInternalStream`**：只省輸出那一份，輸入還是全握著，圖多的人照樣越線。
- **系統的存檔對話框（`showSaveFilePicker`）**：Safari 沒有。
- **拆成好幾個檔案**：用戶要管好幾個檔，還原要一次選對，雲端格式也得跟著改。
- **Service Worker 串流下載**：iOS 上不穩，而且雲端上傳用不上。
- **圖片不壓縮、降壓縮等級**：圖片現在就不壓（STORE）；降等級省的是時間，不是那幾份資料。

## 4. 設計

### 4.1 串流 zip 寫入器（`utils/zipStream/`）

```ts
interface ZipStreamWriter {
  /** 登記一個檔案。同步回來（IndexedDB 游標的回呼裡不能 await），資料進佇列 */
  file(name: string, data: string | Uint8Array | Blob, options?: { compression?: 'STORE' | 'DEFLATE'; base64?: boolean }): void;
  /** 等佇列降到門檻以下。呼叫端每批之後 await 一次，這就是節流 */
  drain(): Promise<void>;
  /** 寫目錄、收尾，回一個 Blob（OPFS 時是磁碟上的 File） */
  finish(): Promise<Blob>;
  /** 中途放棄：停下來、刪掉暫存檔 */
  abort(): Promise<void>;
  /** 已寫出的位元組數（進度用） */
  readonly bytesWritten: number;
}
```

- `file()` 的簽名包住現有的 `ZipFileWriter`（`utils/backupFormat.ts`），所以 `writeV2Backup`、`createV2ArrayFieldWriter`、`writeBlobsToZip`、`externalizeVoiceMessageBlobs` 不用改呼叫方式。
- 一個檔案＝一個完整的 zip 條目：整個檔案的位元組在手上時算 CRC、壓縮，寫「檔頭＋內容」。不用 data descriptor，也不用回頭改檔頭，所以輸出只要能「往後接」就行。
- 記憶體裡只留目錄（檔名、CRC、大小、位移），一個檔案約一百位元組。
- 收尾寫中央目錄。檔案數超過 65535 或位移超過 4 GB 時寫 zip64（JSZip 讀得懂；它自己寫不出來，所以現在超過這兩個數的備份其實是壞的）。
- 壓縮用 `fflate`（新增依賴，約 8 KB，跟 JSZip 一樣動態載入）。文字分片用 DEFLATE 等級 6；圖片、語音、向量照舊 STORE。**實作前先對 fflate 的文件確認 API**。
- `base64: true`（舊格式內嵌圖）在寫入器裡解成位元組再寫，解完就放，不留字串。
- `Blob` 輸入（新格式圖片）：寫入器自己 `arrayBuffer()`，一次一張。

輸出格式是標準 zip，檔名、內容跟現在一模一樣，`manifest.json` 的 `formatVersion` 還是 3。舊版 App、上游 Sully 的 JSZip 都讀得了。

### 4.2 輸出去哪（sink）

寫入器後面接一個 sink，兩種：

| sink | 什麼時候用 | 怎麼做 |
|---|---|---|
| **OPFS**（第 2 批） | `navigator.storage.getDirectory` 和 Worker 都有 | 專用 Worker 裡用 `createSyncAccessHandle()` 往 `backup-tmp/<檔名>` 接著寫。壓縮也搬進這個 Worker，主畫面不卡。收尾後主執行緒 `getFile()` 拿到磁碟上的 `File` |
| **記憶體**（第 1 批，之後當退路） | 上面任何一樣沒有（私密瀏覽、很舊的 Safari、Worker 起不來），或 OPFS 寫到一半失敗 | 每攢 8 MB 包成一個小 Blob，最後 `new Blob(parts)`。輸出還是一份，但輸入那幾份已經省掉 |

為什麼用 Worker＋`createSyncAccessHandle`：這個寫法 iPhone 從 iOS 15.2 就有；主執行緒的 `createWritable()` 要到 Safari 26 才有。Worker 的寫法照 `utils/memoryPalace/vectorSearch.ts` 那個（`new Worker(new URL(...), { type: 'module' })`，起不來就標壞、走退路）。

OPFS 要防的事：

- **寫完要驗**：收尾後比對 `file.size` 跟寫出的位元組數，再讀尾巴確認 zip 的結尾記號在。對不上就整個用記憶體 sink 重跑一次。（有人回報過 Safari 用這個寫法寫出來的檔讀回來是空的，不能假設它一定對。）
- **空間**：開始前用 `navigator.storage.estimate()` 看剩餘額度，不夠就先講「手機剩的空間不夠放備份檔，大約需要 ××」，不要跑到一半才失敗。
- **清暫存**：暫存檔的大小＝備份檔的大小，佔的是 App 的儲存額度。清的時機：下載框關掉時、雲端上傳結束時（成功失敗都清）、下一次備份開始前、App 開機時（保底，清掉上次被關掉留下的）。
- 一次只允許一個備份在跑（現在靠遮罩擋，寫入器再擋一次）。

### 4.3 輸入：資料表分批讀

整合和媒體模式現在是 `getRawStoreData` 整張讀。改成：

1. 先在一個交易裡 `getAllKeys()` 拿這張表的主鍵清單（很小）。
2. 照清單一批一批 `get`：一般的表 200 筆一批，圖多的表（`gallery`、`messages`、`characters`、`emojis`、`assets`、`journal_stickers`、`moment_posts`、`pixel_home_assets`、`cc_custom_parts`…）20 筆一批。
3. 每批：照舊處理（抽圖 `processObject`、角色房間素材正規化、媒體模式的篩選）→ 交給 `createV2ArrayFieldWriter.append` → `await writer.drain()` → 這批放掉。
4. 分片上限三個模式都用純文字那組（400 萬字／500 筆），不再用 3200 萬字。

不能整段照搬純文字那條「單一交易游標」：游標的回呼裡不能 `await`，圖多的表會在一個交易裡把整張表的圖都塞進佇列，等於沒節流。

**一致性**：分批讀不是單一交易的快照。備份途中新增的那幾筆不會進來（主鍵清單是開頭拿的）、被刪的跳過、被改的拿到新值，`manifest` 的筆數照實際寫入的算（現在就是這樣）。跨表本來就沒有快照（現在也是一張一張讀）。為了把途中的變動壓到最少，加一個「備份進行中」旗標（`utils/backupRunState.ts`，只在記憶體），本機會自己動的排程看到就跳過這一輪：日程自動生成（`utils/scheduleAutoRun.ts`）、記憶整理、主動消息的本機檢查。用戶本來就被遮罩擋著，不會自己去聊天。

特殊的幾張表照舊整張讀（都很小，而且後面要整張一起處理）：`user_profile`、`bank_data`、`life_sim`、`vr_music`、`vr_guestbook` 這些單例，和媒體模式的 `characters`（只抽媒體欄位組成 `mediaAssets`，但改成分批抽）。`memory_vectors` 在整合模式也改用純文字那條「兩遍游標」的壓縮路（`encodeVectorsForBackupChunked`），不再整張讀。

### 4.4 輸入：圖片與去重

- **新格式圖片**（`blobs/<id>`）：`writeBlobsToZip` 改成把 `Blob` 直接交給寫入器（不先讀成位元組），每張之後 `drain()`。
- **舊格式內嵌圖**（`assets/*`）：`assetDedupMap` 現在拿整串 base64 當鍵，等於把所有舊圖的字串留到最後。改成拿「長度＋兩個獨立的 53 位雜湊」當鍵，字串用完就放。同一張圖還是只存一份。
  - 雜湊撞到的機率小到可以不管，但撞到的後果是「這張圖被換成另一張」，所以多一道保險：鍵裡帶長度和頭尾各 32 個字，三樣都一樣才算同一張。
- 語音（`externalizeVoiceMessageBlobs`）、協同文件（`collaboration/assets/*`）照舊一個一個 `file()`，每個之後 `drain()`。

### 4.5 進度

現在 70% 之後是「壓縮中」，數字是 JSZip 報的，最後幾 % 最久。改成照實際做的事算：

- 0～55%：資料表（做完幾張／共幾張）
- 55～97%：圖片與附件（做完幾個／共幾個；新格式圖片的總數在資料表寫完後才知道，那時候才開始這一段）
- 97～100%：寫目錄、驗檔
- 訊息寫清楚在做什麼：「正在打包：聊天記錄」「正在寫入圖片 312/1480」。

雲端備份的 0～50% 打包、50～95% 上傳不變，只是前半段換成上面這套。

### 4.6 備份被關掉的痕跡

分頁被系統收掉時我們什麼都來不及做，所以要事先留字條：

- 備份開始時寫 `localStorage['backup_run_v1'] = { mode, startedAt, phase, percent, sink }`，每換一個階段更新一次；正常結束、失敗、用戶取消都刪掉。
- App 開機時看到這張字條＝上次備份途中分頁被關掉。做三件事：寫一條錯誤記錄（設置裡翻得到）、跳一則提醒（「上次備份沒做完，分頁被系統關掉了」，附上做到哪個階段和可以試的做法）、清掉暫存檔。
- 埋點：一個事件「備份途中分頁被關」，屬性只有固定枚舉（模式、階段、sink 種類、進度分檔），照 `docs/analytics.md` 的規矩先登記再加。這樣能看出修之前有多少人中、修之後還剩多少。

跟還原那邊的 `markImportInProgress` 是同一種做法。

### 4.7 下載與上傳

`exportSystem` 照舊回 `Promise<Blob>`，只是 OPFS 時回的是磁碟上的 `File`。

- 下載：`shareOrDownloadBlob` 不用改。它會 `new File([blob], 檔名)` 包一層，不會複製內容。
- WebDAV、GitHub：不用改，`blob.slice` 會從磁碟讀那一段。
- 原生殼（Capacitor）：照舊一段一段轉 base64 寫進快取資料夾，每段從磁碟讀。

## 5. 分批

| 批 | 做什麼 | 做完之後 |
|---|---|---|
| **1** | 被關掉的痕跡（4.6）；串流 zip 寫入器＋記憶體 sink（4.1、4.2）；`exportSystem` 三個模式改成分批讀、圖片逐張、去重表換鍵、「備份進行中」旗標（4.3、4.4）；新的進度（4.5） | 輸入那幾份都省掉，最高點剩「輸出一份」。圖 500 MB 的人從 1 GB 以上降到約 500 MB |
| **2** | OPFS sink＋Worker（壓縮搬進去）；寫完驗檔、空間檢查、清暫存；下載與兩種雲端上傳用磁碟上的檔案實測 | 最高點變成幾十 MB，跟資料量無關。iPhone 的問題在這批收掉 |
| **3** | 還原不整包讀：自己寫 zip 讀取器（從檔尾讀目錄，用 `file.slice` 一個條目一個條目讀、解壓），取代 `JSZip.loadAsync`；v2／v3 的組裝與寫庫改成一張表一張表來（`importFullData` 已經是一段一段寫、有 `beforeWrite` 鉤子，圖片還原跟著那一段做）；v1 的 `data.json` 用串流解析（邊解壓邊讀，頂層一個欄位一個欄位、陣列一筆一筆吐出來），不先變成一條大字串；雲端還原的下載改成一段一段寫進 OPFS，不在記憶體裡攢整包。**開工前把這一節的細節補進來** | 大備份在 iPhone 上還原得回來，包括從上游 Sully 帶過來的新舊備份、從雲端抓回來的 |
| **4** | 其他會打大包的地方換成同一個寫入器：VRM 模型備份（`utils/avatarModelBackup.ts`）、Live2D 模型（`utils/live2dModelStore.ts`）、表情包導出（`utils/emojiExport.ts`） | 這幾個也不會因為檔案大被關掉 |

每一批各開一個 PR。第 1、2 批之間 App 是能用的（第 1 批本身就比現在省）。

## 6. 測試

備份是最不能出錯的地方，測試跟著每一批走：

- **上游的包**：第 3 批用三種格式（v1 單根 `data.json`、v2、v3）各一份樣本，舊流程和新流程還原出來的資料庫內容要一樣。
- **寫入器**（node，vitest）：寫出來的 zip 用真的 JSZip 讀回來，逐檔比對檔名和內容；STORE／DEFLATE、中文檔名、空檔、單檔很大、65536 個以上的檔案（zip64）、base64 輸入、Blob 輸入；CRC 故意寫錯時 JSZip 會報錯（確認我們真的有寫 CRC）。
- **新舊對照**：同一份假資料，用舊流程（JSZip）和新流程各打一包，都餵給 `assembleV2Backup`，組出來的物件要深度相等；`blobs/*`、`assets/*`、語音、協同文件、向量逐位元組相等。現有的 `backupRoundtrip.test.ts`、`backupExport.test.ts`、`backupFormat.test.ts` 改成兩種寫入器各跑一遍。
- **分批讀**：分批讀出來的跟 `getAll` 一樣；途中新增、刪除、修改各一條回歸測試，確認筆數對得上 `manifest`、不會寫出壞包。
- **去重**：同一張圖出現在好幾張表只存一份；長度相同、內容不同的兩張圖不會被當成同一張。
- **OPFS**（無頭 Chromium）：Worker 寫出來的檔跟記憶體 sink 的逐位元組相等；驗檔失敗時自動退回記憶體 sink；暫存檔在各個時機確實被刪。
- **記憶體**（無頭 Chromium）：塞幾百 MB 的假圖進 IndexedDB，量舊流程和新流程的最高用量，寫進 PR。
- **痕跡**：字條在開始、換階段、結束、失敗時的寫與刪；開機看到字條會出提醒並清暫存。

**這裡測不到的**：真的 iPhone。這個環境只有 Chromium，WebKit 的 OPFS 和記憶體上限只能靠實機。第 2 批的預覽版出來後，需要遇到問題的用戶（或手邊有圖多的資料的人）在 iPhone 上各跑一次整合導出和雲端備份。

## 7. 這份計畫不做的

- 不改備份檔格式（`formatVersion` 還是 3、檔名與內容不變）。
- 不改還原的語義（清空再寫／合併／單例／媒體模式補丁照舊）。
- 不改雲端備份的檔案格式和 WebDAV 中轉的 100 MB 上限。
- 不處理「匯出 ZIP 之後首頁破格」（`plans/todo.md` 第 2 項），那是分享面板關掉後的縮放問題，另外查。

## 8. 動工前給用戶的繞法

- 備份前把 Safari 其他分頁關掉、整個 Safari 滑掉重開，進來直接備份。
- 還是不行就分開做：先「純文字」，再單獨導「媒體」。

## 9. 參考

- iPhone 分頁的記憶體上限、被系統收掉後顯示「重複發生問題」：[WebKit Bugzilla 256703](https://bugs.webkit.org/show_bug.cgi?id=256703)、[Apple 開發者論壇 823061](https://developer.apple.com/forums/thread/823061)
- OPFS 與 `createSyncAccessHandle()`（只在 Worker、iOS 15.2 起）：[WebKit 部落格](https://webkit.org/?p=12257)、[caniuse](https://caniuse.com/mdn-api_filesystemfilehandle_createsyncaccesshandle)
- `createWritable()` 在 Safari 的進度：[WebKit Bugzilla 231706](https://bugs.webkit.org/show_bug.cgi?id=231706)、[254726](https://bugs.webkit.org/show_bug.cgi?id=254726)
- Safari 用 sync access handle 寫出的檔讀回來是空的（所以寫完要驗）：[gist](https://gist.github.com/myobie/021fc07f09e013b1e5c137ec09282aeb)

## 10. 實況：第 1 批（導出的輸入端、串流寫入器、被關掉的痕跡）

做了的：

- **串流 zip 寫入器** `utils/zipStream/`：`crc32.ts`、`zipFormat.ts`（檔頭、中央目錄、結尾、zip64，純函式）、`writer.ts`（`createZipStreamWriter`、記憶體輸出 `createMemorySink`、舊容器對照組 `createJSZipWriter`）。壓縮用 `fflate` 的 `deflateSync`（新依賴，用到才載）。
- **`exportSystem` 三個模式都接上**：整合／媒體的陣列表分批讀（圖多的表 20 筆一批，其他 200 筆，`backupBatchSize`）、處理完就寫分片、寫完就放；媒體模式的 `mediaAssets` 也分批寫；`memory_vectors` 整合模式改走兩遍游標那條；分片上限三個模式都是 400 萬字／500 筆；新格式圖片一張寫完才讀下一張。
- **去重表換鍵**：`imageDedupKey`（`utils/backupExport.ts`），長度＋兩個 53 位雜湊＋頭尾各 32 字。
- **被關掉的痕跡與「備份進行中」旗標** `utils/backupRunState.ts`：字條 `backup_run_v1`；開機看到就寫一筆記錄（設置的錯誤記錄，來源「備份」）、送埋點「备份途中分页被关」；提醒等**解鎖之後**才跳（鎖屏上不顯示 toast，開機當下跳用戶看不到）。雲端備份在上傳階段接著留字條。
- **旗標擋住的本機排程**：排程訊息到點送出、日程自動生成、補生成照片、朋友圈自動化（連同拉黑冷靜期、臨時會話）、延遲回覆。備份結束後下一輪照常跑。
- **進度**：資料表 0～55%（純文字 0～95%）、新格式圖片 55～97%（逐張）、收尾 97%。不再有「壓縮中」卡在最後幾 % 的那段。

實測（無頭 Chromium，開發模式，同一份資料；數字是分頁的實體記憶體比導出前多了多少）：

| 資料 | 舊做法（dev） | 第 1 批 | 花的時間 |
|---|---|---|---|
| 120 張 1.2 MB 內嵌圖＋6000 則訊息，整合導出 | +707 MB | +311 MB | 7.6 秒 → 3.9 秒 |
| 360 張同樣的圖，整合導出 | +1612 MB | +398 MB | 19.1 秒 → 10.5 秒 |
| 360 張，媒體導出 | +1608 MB | +304 MB | 17.8 秒 → 10.0 秒 |

舊做法大約是圖片大小的 3.7 倍，跟著資料量長；第 1 批長得很慢，剩下那一點是輸出還留在記憶體（第 2 批搬到磁碟）。這是 Chromium 的數字，iPhone 上的實際上限和行為要等實機。

新舊對照（同一個資料庫，dev 的程式和這一批各導一包，整合／媒體／純文字三種都做）：`assets/*` 逐張一樣、每張表筆數一樣、組回來的資料逐欄位一樣。只有兩個本來就隨時間變的欄位不同（`assets` 表裡 `ls_mirror_v1` 的 `savedAt`、`eventNotifFlags` 裡的備份提醒時間）。分片數不同（訊息 2 片變 12 片）是分片上限調小的關係，還原時照 `manifest` 讀，不影響。

跟設計稿不一樣的地方：

- **分批讀用的是現成的 `DB.getStoreDataChunked`**（游標一批一批、用上一批最後的主鍵接著讀），不是 4.3 節寫的「先 `getAllKeys` 再一批批 `get`」。效果一樣，少寫一套；差別是備份途中新增、主鍵排在後面的資料會被帶進來（設計稿那版不會）。
- **圖片、語音、協同文件的呼叫端沒改**：它們本來就是「讀成位元組 → `file()`」。換成串流寫入器後 `file()` 當場寫完，那份位元組隨即可以回收，效果等於一張一張來。寫入器有支援直接丟 `Blob`（排隊、`drain()` 等），留給第 2 批搬進 Worker 時用。
- **同名檔案**：JSZip 是後寫的蓋掉先寫的；串流寫出去的收不回來，改成留先寫的、記次數、不讓備份失敗。
- **寫入失敗分兩種**：還沒寫出任何位元組就出錯（例如 base64 壞掉）只丟給呼叫端，包裡其他檔案照常；寫到一半出錯才整包作廢。
- **壓縮等級統一 6**（整合和媒體原本是 9）。實測同一份資料兩邊都是 381 MB，圖片本來就不壓，差在文字那一點點。
- **JSZip 會替每層資料夾寫一筆目錄條目，串流寫入器不寫**。還原那邊沒有人讀它。
- **排查開關**：`localStorage['backup_zip_writer'] = 'jszip'` 退回舊容器（只換容器，輸入端還是分批）。沒有介面，出事時臨時用。
- **「備份進行中」沒有擋記憶整理**：它是聊天觸發的，不是定時跑；備份時用戶被遮罩擋著，不會觸發。
- **單例表、設定、協同工作的對話**還是整份在記憶體裡再寫（都很小，或不是照片那種量級）。

沒測到的：真的 iPhone；雲端上傳途中被關掉的字條（邏輯跟打包階段同一套，有單元測試）；資料庫裡真的有 `blobs/*` 新格式圖片時的整條瀏覽器路徑（寫入與比對在 node 的對照測試裡有，瀏覽器實測用的是舊格式內嵌圖）。
