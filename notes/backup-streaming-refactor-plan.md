# 備份鏈路流式化改造方案（v2 格式）

## 1. 背景與目標

SullyOS 是 local-first 的瀏覽器虛擬手機，全部數據存在 IndexedDB（主庫 `AetherOS_Data`，50+ store）。
備份功能把這些 store 導出成一個 DEFLATE zip。當前實現從「攢數據」到「打包」到「上傳」到「還原」
幾乎每一步都是**整庫/整包壓在內存裡、沒有分片均衡**，重度帳號（萬級向量、幾十萬條消息、
幾百 MB base64 素材）在備份時會：

- **確定性硬崩**：對單個超大 store / 整包 JSON 做 `JSON.stringify`，文本逼近 JS 單字符串 ~512MB
  上限 → `RangeError: Invalid string length`。這是「直接崩」，不是變慢。
- **概率性 OOM**：`getAll()` 整表 + 向量解碼膨脹 + stringify 多份副本疊加，撐爆移動端瀏覽器內存。

目標（已 narrow，誠實版）：

- **徹底消除確定性硬崩**：分片後任何單根字符串都有界，永不觸 `RangeError`。這是本輪的核心承諾。
- **顯著降低 OOM 概率**：去掉 `join('')` 的整包翻倍（~2× → ~1×）；#2 向量轉二進制再砍掉重度
  記憶宮殿帳號的最大一塊（number[] 文本 → 原始字節，~4-5×）。
- **不承諾 `O(單片)` 峰值**：JSZip 在 `generateAsync` 前會攥著所有文件，導出峰值仍 ~O(整包未壓縮)，
  導入峰值 ~O(整樹)。真要降到 `O(單片)` 必須換流式壓縮庫（fflate）+ 落盤流，工作量過大，**本輪不做，
  列為 follow-up**（見 §7）。所以極端帳號（幾十萬消息 + 幾百 MB 圖疊低端機）仍可能 OOM——但不再有
  「低門檻、鐵定觸發」的 RangeError。
- **老備份永遠還能導入**。

本輪範圍 = 工程改造（#1/#2/#3/#5/#6），不動「該不該刪老消息」那類產品決策（原 #4，已單獨擱置）。

## 2. 現狀確診（帶行號）

| 環節 | 位置 | 現狀 | 問題 |
|------|------|------|------|
| 整表讀 | `db.ts:2176 getRawStoreData` | `store.getAll()` 一次性整表進內存 | 無游標分批，峰值 = 整個 store |
| 向量解碼 | `OSContext.tsx:2857-2875` | 整庫 `.map` 把 `Uint8Array` 解成 `number[]` | 再複製一份且膨脹，之後還要 stringify |
| 單 store 序列化 | `OSContext.tsx:3038` | `JSON.stringify(單個大數組)` | 單庫文本可超 512MB → RangeError |
| 拼整包 | `OSContext.tsx:3032-3047` | `jsonParts.join('')` 拼成一根 `data.json` 大字符串 | 整備份再複製一份，峰值翻倍 |
| 壓包 | `OSContext.tsx:3054` | `zip.generateAsync({type:'blob',streamFiles:true,level:9})` | 入參 `data.json` 已成型；JSZip 生成前持有全部文件 |
| WebDAV 上傳(web) | `webdavClient.ts:204-228` | XHR `send(blob)` 經 Worker 代理 POST | **blob 本身是流式的**，真風險是 Worker body 上限 + 上行超時 |
| WebDAV 上傳(native) | `webdavClient.ts:86,190-201` | `blob.arrayBuffer()` 整包 → CapacitorHttp PUT | 整包進 ArrayBuffer，內存翻倍；且 CapacitorHttp 無法流式傳 Blob |
| import 解析 | `OSContext.tsx:3160-3167` | `loadAsync` 整包 + `data.json` 整串 + `JSON.parse` 整樹 | 整棵對象樹同時在內存 |
| import 素材回填 | `OSContext.tsx:3176-3259` + `db.ts:2487` | **已是按 50 條 chunk 跑 beforeWrite、寫完釋放** | 這塊已經均衡，不是瓶頸 |
| import 寫庫 | `db.ts:2470-2496 putItems` | CHUNK_SIZE=50 分批 put + 釋放 | 已經均衡，不是瓶頸 |

**結論**：真正沒做均衡的是 **導出側的「整表讀 → 單 store stringify → join 整包」** 和 **import 側的
「整包 JSON.parse」**。import 的素材回填和寫庫其實已經分塊了（這點要糾正之前的判斷）。

## 3. v2 備份格式設計

保持 zip 容器不變，改內部佈局：

```
backup.zip
├── manifest.json                  ← {formatVersion:2, mode, createdAt, stores:{<field>:{parts:N, count:M}}, assetCount}
├── metadata.json                  ← 所有「非 store」字段：theme/API 配置/customIcons/appearancePresets/socialAppData/設置等（R4·F2）
├── stores/characters.json         ← 小 store：整數組一個文件
├── stores/messages.000.json       ← 大 store：分片，每片 ≤ SHARD_BYTES（如 32MB）或 ≤ SHARD_ITEMS（如 5000 條）
├── stores/messages.001.json
├── stores/memory_vectors.index.json ← 向量元數據索引（每條 memoryId/charId/dims/model/byteLen）
├── stores/memory_vectors.bin      ← 向量 Float32 原始字節，按 index 順序拼接（#2）
└── assets/asset_xxx.png           ← 圖片照舊抽出去 + 全局去重（不變）
```

要點：
- **字段名 vs store 名**：沿用現有 `backupData` 的字段命名（`themes→customThemes`、`gallery→galleryImages`
  等，映射在 `OSContext.tsx:2930` 的 switch）。`manifest.stores` 的 key 用字段名，import 時餵給
  `importFullData`（它本來就按字段名認數據），改動面最小。
- **大 store 分片（sharding）**：單個 store 即使本身 >512MB，分成多片後每片獨立 stringify、寫進 zip、釋放，
  避免觸 RangeError。**單條超大記錄護欄（Finding 5）**：按累積超 `SHARD_BYTES`/`SHARD_ITEMS` flush；若**單條
  記錄**序列化就超預算（圖片已抽 assets/，剩極端是超大文本/字體 base64 等留在 JSON 的字段），它獨佔一片；
  若單條 JSON 仍超硬上限（如 256MB），**乾淨報錯、不產出半截 zip**，絕不退回 RangeError。
- **manifest 驅動 import**：導入時先讀 manifest 決定走哪些文件、每個 store 幾片，不靠猜文件名。
- **manifest 枚舉本 mode 的所有 store（含 count:0）**：空 store 也必須列出，否則「源為空、目標有舊數據」時
  舊數據殘留、full restore 名不副實（Finding 1·空 store 殘留）。
- **單一真相源 `BACKUP_STORE_SPECS`（修 R3·Finding 1）**：一張聲明表，每個被備份的 store 一條——
  `{ store, field, shape: array|singleton|composite, restore: clear-and-add|merge|put|singleton, emptyBehavior }`。
  **導出、manifest、導入共讀這一張表**，杜絕「導出 switch 和 importFullData 各寫一套、彼此漂移」。
  - 為什麼不能「count:0 一律置 `[]`」：導入器各 store 行為不一致——clear-and-add 扔 `[]` 會清；merge（themes/
    emojis/categories/stickers）扔 `[]` 啥也不清；singleton（userProfile/lifeSim/vrMusic/vrGuestbook）扔 `[]` 會寫
    **空殼**把好數據沖掉。所以空時清不清、傳什麼形狀，**按 spec 來**。
  - **範圍**：目標是 v2 還原**與 v1 行為完全一致、且不寫空殼**；**不**順手修 v1 本身「merge 不鏡像」的老語義
    （那是獨立課題，超本輪）。
  - **mode 專屬虛擬字段（修 R4·F1，critical）**：spec 不是「每 store 一條靜態行」就夠——要建模 mode 專屬字段和
    跨字段不變量：① `mediaAssets` 是 media_only 下 characters 的**投影**（不是 characters store 本身）；
    ② messages 在 media_only 下只篩 image/emoji；③ importFullData 靠「`data.characters` 在不在」判斷 messages
    是否破壞性寫——所以 **media_only 絕不能把 characters/messages 物化成 `[]`**，否則會誤清掉文字/聊天。
    spec 要按 mode 給出**各自的應有字段集**，media_only 的集合裡是 `mediaAssets`，不是 `characters`。
  - **非 store 字段單獨裝（修 R4·F2）**：theme/API 配置/customIcons/appearancePresets/socialAppData/設置等不是
    IndexedDB store，進 `metadata.json`，同樣跑素材抽取/還原，納入預檢與組裝。

## 4. 逐項改造

### #1 整表讀 → 游標分批讀（`db.ts`）
- 新增 `getStoreDataChunked(storeName, onBatch, batchSize)`：用 `store.openCursor()` 游標，每攢夠
  `batchSize` 條回調一次 `onBatch(batch)`，回調內消費完即釋放，絕不在內存裡攢整表。
- `getRawStoreData` 保留（老 import 路徑 / 其它調用方還用），不動。
- **效果**：導出讀取階段內存從「整個 store」降到「一個 batch」。
- **影響**：所有走新導出的 store 改用游標讀；迴歸測試釘「不漏條、順序與 getAll 一致」。

### #3 流式骨架 + v2 格式（`OSContext.tsx exportSystem` / `importSystem`）
- **導出**：對每個 store，游標分批讀（#1）→ 每批做圖片抽取（複用現有 `processObject`/`extractImagesInPlace`，
  邏輯不變）→ 累積到當前分片緩衝，超過 `SHARD_BYTES`/`SHARD_ITEMS` 就 `zip.file('stores/<field>.NNN.json', 分片串)`
  並清空緩衝 → 釋放該批對象。小 store 不分片，單文件。
- 寫 `manifest.json` 收尾，刪掉老的 `largeArrayKeys` + `jsonParts.join('')` 整包邏輯。
- **導入（assemble-then-import-once，修 Finding 1）**：`loadAsync` 後先找 `manifest.json`；存在且
  `formatVersion>=2` → 走 v2 路徑：
  1. **先校驗**：先確認 `formatVersion === 2`（Finding 4）；**再從 `BACKUP_STORE_SPECS` + mode 算出「完整應有
     字段集」，要求每個應有 store/虛擬字段（含 count:0、composite、`metadata.json`）都在 manifest 裡——漏聲明
     當損壞、abort（修 R4·F3，防 export 漏 store 導致靜默留舊數據）**；再確認 manifest 聲明的每個分片文件、
     `memory_vectors.bin`、`metadata.json` 都在 zip 裡（缺則 abort，此時 DB 一字未動）。**素材文件（`assets/*`）不進這道硬邊界（已定·Finding 2，選 A）**：
     缺圖維持 v1 的 warn+skip——缺圖只可能來自篡改，且真丟了也無從恢復，為它拒絕整個導入沒意義。實現處寫註釋
     說明此豁免。
  1b. **資源預檢（修 R3·Finding 3）**：按 manifest 的 count + zip 未壓縮體積 + bin/asset 體積估算導入峰值，
     超過設備閾值就**乾淨拒絕、根本不開始導入**（數據完好），避免「強機導得出、弱機導一半 OOM 把舊數據毀了」。
  2. **再組裝（按 `BACKUP_STORE_SPECS` 還原模式，修 R3·Finding 1）**：逐 store 逐片 `file.async('string')` +
     `JSON.parse(單片)`，把同一 store 的各片**拼回完整數組**，parse 完一片即釋放該片字符串；向量從 `.bin`+index
     重建成 `MemoryVector[]` 塞進 `data.memoryVectors`；**解析 `metadata.json` 把非 store 字段填回 `data`（R4·F2），
     素材回填同樣覆蓋它**。空 store 按 spec 處理（clear-and-add 才置 `[]` 清舊；merge/singleton 按 v1 形狀，
     **不寫空殼**；media_only 不物化 characters/messages，R4·F1）。**輕量自洽校驗（修 R3·Finding 2，瘦身版）**：每片必須是數組、
     `組裝後條數 === manifest count`、每條向量 `byteLength === dimensions*4`——抓的是我們自己的 export bug，
     不是防篡改（offset 單調不重疊那套深校驗不做）。組裝出完整的 `data` 對象。
  3. **後寫庫**：調用**一次**現有的 `DB.importFullData(data, ...)`——每個 store 的完整數組只經過一次
     `clearAndAdd`，自然只 clear 一次（不會出現「第二片把第一片清掉」）；characters↔mediaAssets 等跨字段
     邏輯、分塊寫庫、素材回填鉤子全部原樣複用，不重寫。
  - **為什麼不按 codex 說的「clear once + 逐片 append」**：那要把 importFullData 拆成可逐片調用、還得自己
    復刻跨字段邏輯。assemble-then-import-once 更簡單、複用現有邏輯，且「組裝在前/寫庫在後」天然就是
    Finding 3 要的「破壞性寫之前的校驗邊界」。**代價**：import 峰值 ≈ 整樹（與現狀 v1 相同，narrow 下接受）。
- **效果**：消除導出側 join 整包 + 單 store stringify 的 RangeError；導入側修掉跨片清庫的數據丟失。
- **影響**：導出主流程重寫；導入新增 v2 組裝路徑（寫庫仍走舊 importFullData）；manifest 是新增契約。

### #2 向量走二進制（`OSContext.tsx` + `utils/memoryPalace`）
- 導出：`memory_vectors` 不再解碼成 `number[]` 進 JSON。游標讀出每條，**先過現有歸一化路徑
  （ensureFloat32/vecForStorage：Uint8Array / Float32Array / 遺留 number[] 三態統一成 Float32 字節，修 R4·F4）**——
  現有 IndexedDB 裡可能還存著沒遷移的遺留 number[] 向量，不歸一化直接當 Uint8Array 讀會寫出無效字節。
  歸一化後順序寫進 `memory_vectors.bin`（拼接字節），按歸一化後的字節算 `byteLength`，往 `memory_vectors.index.json`
  push 一條 `{memoryId, charId, dimensions, model, byteOffset, byteLength}`。
- 導入：讀 index + bin，按 offset/len 切出每條 `Uint8Array`，組回 `MemoryVector[]`，**塞進 `data.memoryVectors`，
  跟其它 store 一樣走那一次 `importFullData` 的 memory_vectors 段（clear-once）**——不走 `saveMany` 旁路。
  `saveMany` 是 upsert、不清舊數據，當旁路用會讓目標上舊向量殘留、破壞 clear-once 不變量（Finding 3）。
- **效果**：同時幹掉「解碼膨脹」和「向量內聯進 JSON 撞上限」兩個崩點，體積也更小（二進制 vs JSON 文本 ~4-5×）。
- **影響**：備份格式裡向量部分變二進制；import 要兼容老備份裡向量仍是 `number[]` 的情況（見 §5）。

### #5 WebDAV 上傳（`webdavClient.ts`）——**本輪最受限、最該被質疑的一項**
- 先糾正：備份 blob 已是壓縮 zip，**gzip 上行無效**，從方案裡刪掉。
- web 路徑 XHR `send(blob)` 已是流式，**內存不是瓶頸**；真瓶頸是 Worker 代理 body 上限 + 上行超時。
  WebDAV 協議是單次 PUT，不原生支持分片/續傳；分塊 PUT（Content-Range）依賴服務端支持，不通用。
- native 路徑 `blob.arrayBuffer()` 整包進內存是真問題，但 CapacitorHttp 無法流式傳 Blob，
  徹底解需改成「先寫臨時文件、用支持文件路徑上傳的原生能力 PUT」，是更大的改動。
- **本輪擬定動作（保守）**：(a) 給上傳加大小預檢 + 明確報錯（超 Worker 限制時提示用戶用本地導出/GitHub），
  (b) native 端儘量避免額外拷貝、或文檔化其上限。**是否值得在本輪就上「臨時文件上傳」存疑，留給評審定。**
- **影響**：可能本輪 WebDAV 只做「預檢 + 提示」，把「大帳號雲備份」正式收口留到下一輪。

### #6 import 流式（大部分已存在）
- 素材回填（`putItems` 每 50 條 `beforeWrite`）和分塊寫庫**已實現**，v2 組裝路徑（§#3）直接複用這套寫庫邏輯。
- 本項實際工作 = §#3 的「先校驗 → 逐片拼回完整數組 → 調一次 importFullData」，不再額外大改。

## 5. 兼容與遷移（最高風險點）

- **導入雙路徑**：`importSystem` 先探 `manifest.json`。
  - 有 manifest 且 v2 → 新路徑。
  - 無 manifest（或只有 `data.json`）→ 老 v1 路徑，**原樣保留現有邏輯**，老備份永遠打得開。
- **向量兼容**：v2 import 讀 `.bin`；v1（老備份）import 走老邏輯，向量仍是 JSON 裡的 `number[]`，
  `saveMany` 照舊壓回。兩條都要測。
- **導出只產 v2**：新版本導出統一產 v2，不再產 v1。
- **版本號嚴格匹配（Finding 4）**：v2 解析路徑只認 `formatVersion === 2`；`>2`（未來 v3 改佈局）在組裝/寫庫
  前直接報錯，絕不用 v2 parser 去解未知佈局還做破壞性寫。
- **寫庫前校驗分三檔（都在 DB 未動時完成）**：① 文件存在性（分片/`memory_vectors.bin` 齊全，缺則 abort）；
  ② 輕量自洽（每片是數組、`組裝後條數 === manifest count`、向量 `byteLength === dimensions*4`）——抓我們自己的
  export bug，不是防篡改；③ 資源預檢（估算峰值，超閾值乾淨拒絕，修 R3·Finding 3）。
- **不做** 逐條 checksum、向量 offset 單調不重疊那類深校驗——備份壞只可能是用戶手動改文件，那種不兜
  （符合 `import-discards-old-data` 原則）；`assets/*` 缺圖也維持 warn+skip（§#3 step 1）。
- **不做事務暫存**：組裝通過後 `importFullData` 若寫到一半遇 IndexedDB 配額炸等，按既有原則可接受
  （大不了重導），不為此上跨 store 事務回滾。

## 6. 測試清單（迴歸守衛，舊行為下掛、新行為下過）

1. `sliceRanges`/分片純函數：已有測試，擴展覆蓋「單 store 超一片」分片邊界。
2. **大 store RangeError 迴歸**：構造一個會讓 v1 `join` 超長的 mock 數據，斷言 v1 stringify 拋錯、
   v2 分片導出成功。這是釘住「修好別退化」的核心守衛。
3. 向量 round-trip：`Uint8Array → .bin → 切片 → saveMany → 讀回`，逐字節相等；維度=1024 不丟精度。
4. v1→v2 兼容：用一箇舊格式 `data.json`-only zip 走 import，斷言數據完整落庫。
5. 游標讀 vs getAll：同一 store 兩種讀法結果集相等（條數、順序、內容）。
6. 素材去重/回填：跨 store 共享的 base64 導出後只存一份、導入後每處都還原。
7. **跨片 clear-and-add 還原（Finding 1 守衛，核心）**：構造一個 `galleryImages` 跨 ≥2 片的 v2 備份，
   走 import，斷言**所有片的數據都在**（舊的「逐片喂 importFullData」寫法下只剩最後一片 → 必須掛）。
8. **缺片 abort**：manifest 聲明 2 片但 zip 裡只有 1 片，斷言 import 在寫庫前拋錯、且**目標 store 數據未被
   清空**（DB 未發生破壞性寫）。
9. **空 store 按 spec 還原（R3·Finding 1，核心）**：覆蓋四種 shape 的空備份——
   clear-and-add（如 gallery）空時**清舊**；merge（themes）空時**與 v1 一致地不動**；singleton（userProfile）空時
   **不寫空殼**、保持 v1 形狀。斷言每種都與 v1 行為逐字節一致（「count:0 一律置 []」的錯寫法在 merge/singleton 上必須掛）。
10. **向量 clear-once（Finding 3）**：目標有舊向量、備份向量集不含其中一部分，斷言 import 後目標獨有的舊向量
    消失（走 saveMany 旁路時殘留 → 必須掛）。
11. **單條超大記錄（Finding 5）**：構造一條 JSON 超 `SHARD_BYTES` 的記錄，斷言獨佔一片導出成功；再造一條超
    硬上限的，斷言**乾淨報錯、無半截 zip/import 副作用**（不復現 RangeError）。
12. **版本護欄（Finding 4）**：`formatVersion:3` 的 zip 走 import，斷言乾淨報錯、DB 未動。
13. **條數自洽（R3·Finding 2）**：manifest count 與組裝後實際條數不符（或某片不是數組）→ 寫庫前 abort、DB 未動。
14. **資源預檢拒絕（R3·Finding 3）**：manifest 估算峰值超閾值 → import **根本不開始**、目標數據完好無損
    （證明「拒絕」而非「毀一半」）。
15. **media_only patch 存活（R4·F1，核心）**：目標有完整角色 + 文字消息，導入 media_only 備份後，**非 media 的
    角色字段和文字消息全部存活**、只有 media（頭像/立繪/背景）被更新（錯把 characters/messages 物化成 [] 時必須掛）。
16. **非 store 字段 round-trip（R4·F2）**：theme / API 配置 / customIcons / appearancePresets / socialAppData /
    設置導出再導入逐字段一致（漏 metadata.json 時必須掛）。
17. **漏聲明 store abort（R4·F3）**：manifest 漏掉某應有 store（如 gallery）→ import 在組裝前 abort、DB 未動。
18. **遺留向量導出（R4·F4）**：`memory_vectors` 裡塞 raw 遺留 `number[]` 行，導出 v2、再導入與原始逐字節/逐值一致。

## 7. 取捨記錄與仍待評審的點

### 已定的取捨（評審第 1 輪後拍板）

- **A. 不追 `O(單片)` 真流式**：JSZip 在 `generateAsync` 前持有所有文件，導出峰值 ~O(整包)。換 fflate +
  落盤流才能真降，工作量過大 → **本輪接受「峰值 ~O(整包) 但無 RangeError」**，真流式列 follow-up。
  代價：極端帳號仍可能 OOM，但確定性硬崩已除。
- **B. Finding 1（跨片清庫丟數據）= must-fix**：採用 assemble-then-import-once（§#3），不復用「逐片喂
  importFullData」。
- **C. Finding 3（寫庫前校驗）= 瘦身版**：只做分片完整性檢查，不做 checksum/byte-range，不做事務暫存（§5）。
- **D. #5 WebDAV**：本輪只做「體積預檢 + 明確提示」，native 端避免多餘拷貝；「臨時文件上傳」列 follow-up。

### follow-up（不在本輪）

- 換 fflate / File System Access 真流式壓縮落盤，把導出/導入峰值降到 `O(單片)`。
- WebDAV 大帳號雲備份：臨時文件上傳 / 分塊。
- 原 #4：messages/gallery 保留策略（產品決策）。

### 第 2 輪 codex 複審結果（已折入上文）

- **Finding 1·空 store 殘留** → 已修：manifest 枚舉本 mode 所有 store（含 count:0），import 對 count:0 置空數組清舊（§3、§#3、測試 9）。
- **Finding 3·向量 saveMany 旁路** → 已修：向量併入 `data.memoryVectors` 走 importFullData 一次（§#2、§#3、測試 10）。
- **Finding 4·版本號** → 已修：`formatVersion === 2` 嚴格匹配，`>2` 寫庫前報錯（§5、§#3、測試 12）。
- **Finding 5·單條超大記錄** → 已修：超大記錄獨佔一片，超硬上限乾淨報錯不退回 RangeError（§3、測試 11）。
- **Finding 2·缺素材不在硬邊界** → 已定（選 A）：維持 v1 的 warn+skip + 註釋說明豁免。理由：缺圖只可能來自篡改、
  真丟了也無從恢復，為它拒絕整個導入沒意義。

### 第 3 輪 codex 複審結果（已折入上文）

- **R3·Finding 1·count:0 不能統一置 []** → 已修：引入 `BACKUP_STORE_SPECS` 單一真相源，空 store 按 shape/restore
  mode 處理（clear-and-add 才清、merge/singleton 按 v1 形狀不寫空殼）。範圍限定「與 v1 一致、不寫空殼」，不修 v1
  老語義（§3、§#3 step 2、測試 9）。這張表同時收掉了下文「3 文件知識漂移」的耦合隱患。
- **R3·Finding 2·校驗太薄** → 已折（瘦身版）：加「每片是數組 + 條數 === count + 向量 byteLength === dims*4」
  自洽檢查（抓自家 export bug），深校驗仍不做（§5、§#3 step 2、測試 13）。
- **R3·Finding 3·弱機導入 OOM 不可恢復** → 已修：寫庫前加資源預檢，超閾值乾淨拒絕、不開始導入（§#3 step 1b、
  測試 14）。真·流式導入列 follow-up。

### 第 4 輪 codex 複審結果（已折入上文）

- **R4·F1·media_only patch 被誤清（critical）** → 已修：store-spec 建模 mode 專屬虛擬字段，media_only 不物化
  characters/messages（§3、§#3 step 2、測試 15）。
- **R4·F2·非 store 字段丟失** → 已修：加 `metadata.json` 容器（§3 佈局、§3 spec、§#3、測試 16）。
- **R4·F3·漏聲明 store 靜默留舊數據** → 已修：預檢從 spec+mode 算完整應有字段集，反查 manifest 漏沒漏（§#3 step 1、測試 17）。
- **R4·F4·遺留向量導出寫無效字節** → 已修：導出每條先歸一化三態再寫 bin（§#2、測試 18）。

> **收斂判斷**：四輪每輪都挖出真問題（critical/high），未收斂。結論是「純文檔 plan 審到 codex approve」不是合適的
> 終點——v2 觸及的特殊分支（media_only patch、非 store 字段、遺留向量、各 store 還原模式）太多，應轉入實現，
> 用 18 條迴歸測試 + 對**真實 diff** 跑 codex 來兜，而不是繼續審 plan 散文。

### 仍待評審的點

1. **分片大小 / 資源預檢閾值怎麼定**：`SHARD_BYTES=32MB`、import 拒絕閾值都是拍的。要不要按設備內存/平台自適應？
   閾值定太嚴會誤拒正常大帳號，定太鬆又擋不住 OOM。
2. **向量二進制的字節序/對齊**：`Uint8Array(v.vector.buffer, byteOffset, ...)` 直接拼接，IndexedDB 結構化克隆
   回來的 typed array 是平台原生序——同機導出導入沒問題，**跨設備遷移**（大端↔小端，雖極罕見）會不會讀亂？
   要不要在 manifest 裡記字節序、讀時校正？
3. **assemble-then-import-once 的 import 峰值 ≈ 整樹**：R3·Finding 3 的資源預檢已堵住「毀一半」的危險路徑
   （超閾值乾淨拒絕），但**弱機導大備份依舊是「拒絕」而非「能導」**——這個能力缺口要不要靠「無耦合大 store
   流式導入」補上（follow-up），還是接受「拒絕」就行？
4. **改動集中在 OSContext/db.ts**：`BACKUP_STORE_SPECS` 單一真相源已把「導出/import 知識漂移」收斂成一處，
   緩解了耦合；但 #1/#3/#6 主流程仍需一起改才自洽——落地時怎麼切分提交/測試邊界更穩？

## 8. 落地順序

1. **骨架**（#1 游標讀 + #3 v2 格式 + #6 逐片 parse）——一起改、一起測，立住 manifest 契約。
2. **向量二進制**（#2）——掛到骨架上。
3. **WebDAV**（#5）——獨立，按評審結論決定做到哪一步。

> 三步串行，不裸並行多 agent（同改 OSContext/db.ts 會互踩）。每步帶回歸測試再進下一步。
