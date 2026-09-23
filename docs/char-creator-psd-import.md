# 捏人器 · PSD 整批導入 & 內置素材包

> 覆蓋 520 / 彼方共用的捏人器（`public/like520/character_creator.html`）、
> 開發面板（`apps/CharCreatorDevApp.tsx`）、解析器（`utils/psdCreatorImport.ts`）、
> Blob 存儲橋（`utils/creatorPartsBlob.ts`）、內置素材包（`utils/builtinPartsPack.ts`）。

## 兩種素材，別搞混

| | 存哪 | 佔 IndexedDB 配額 | 誰能看到 |
|---|---|---|---|
| **內置素材** | 二進制 PNG 文件在 `public/like520/parts/`（+ `parts/manifest.json` 清單） | ❌ 不佔（走 bundle / HTTP 緩存） | 所有用戶 |
| **用戶上傳素材** | Blob 存 `cc_custom_parts`（`src` 存 blobref 令牌，見下） | ✅ 佔（已改 Blob，比 base64 省 ~33%） | 只本機 |

> 歷史包袱：`character_creator.html` 裡原本還內聯了一批 base64 內置部件（曾把文件撐到
> ~1.6MB）。新增內置素材一律走「PNG 文件 + 清單」，別再往 HTML 裡內聯 base64。

## PSD 組織約定（給畫師看）

- 畫布 **472×472**（大畫布等比縮到 472，超過 944 觸發），所有圖層按畫布位置導出，錨點天然對齊。
- **頂層圖層組 = 一個類目**（組名就寫類目，如 `眼睛` / `前發`）。
- **組內每個圖層 = 一個獨立部件**（圖層名 = 部件顯示名，如眼睛組裡「杏眼」「圓眼」各一層 → 拆成兩個部件）。
  組內若有子圖層組，則該子組的圖層合併成一個部件（少數需多圖層的部件用得上）。
- **頂層散圖層**（不在組裡）= 一個部件，類目從它自己名字猜。
- **顯示 / 隱藏**：要導入的圖層保持**顯示**；**隱藏的圖層/組會被跳過**（可藏草稿 / 參考層）。圖層不透明度會被照搬，要導的記得拉滿 100%。
- 類目認中文別名或英文 key：前發/劉海、耳發/鬢髮、後發1、後發2、膚色/皮膚/身體、眼睛、嘴、衣服/服裝、外套、面紋/腮紅、配飾/飾品/裝飾。識別不出的在面板裡手動選。
- 換色標記：名字帶 `#色`/`#tint` 強制可換色，`#原色`/`#notint` 強制不可；不標時**頭髮四類 + 眼睛默認可換色**，其餘默認不可。
- **沒有單獨的陰影/投影層**——一個圖層就是一個部件。部件自身的明暗（髮絲陰影、高光）直接畫進圖層即可，`applyTint` 按像素明度重上色，明暗關係天然保留。

## 數據流

```
畫師 PSD ──(CharCreatorDevApp「PSD 整批導入」)──> parseCreatorPsd
  組=類目、組內每圖層=一個部件 → part.src（透明 PNG dataURL）
        ↓ 面板確認（類目 / 名稱 / 可換色）
  ├─「全部加入捏人器」→ creatorPartToBlobRefs → DB.saveCustomCreatorPart（本機 IndexedDB，src 存 blobref 令牌）
  │        ↓ Like520Event loadCreatorPartsForRender（令牌→base64）隨 like520_init/add_items 注入 extraItems
  │   character_creator.html mergeExtraItems → PARTS
  └─「導出為內置素材包」→ buildBuiltinPartsPackZip → ZIP（parts/manifest.json + parts/*.png）
           ↓ 管理員把 parts/ 放進 public/like520/ 提交
     character_creator.html 啟動 fetch('parts/manifest.json') → mergeExtraItems → 全員內置
```

## 管理員：PSD → 全員內置素材（無需改代碼）

1. 開發面板 →「PSD 整批導入」→ 選 PSD → 逐個確認類目/名字/可換色。
2. 點 **「導出為內置素材包（PNG+清單）」**（或用已有列表那顆「把已有 N 個部件導出為內置素材包」），下到一個 ZIP。
3. 解壓，把裡面**整個 `parts/` 文件夾**放進倉庫 `public/like520/`
   （最終是 `public/like520/parts/manifest.json` + `public/like520/parts/*.png`；已存在就整體覆蓋，清單是全量快照）。
4. 提交併部署。`character_creator.html` 啟動時自動 `fetch('parts/manifest.json')` 合併進 PARTS，**不用手改 HTML 的 PARTS 數組**。

> 不會用 git 也行：GitHub 網頁版 → 進 `public/like520/parts/` 目錄 → `Add file → Upload files` 拖拽上傳 → 底部 `Commit changes`。

## 換畫風：老畫風摺疊（`LEGACY_IDS`）

`character_creator.html` 啟動時把當時 `PARTS` 裡的內置部件 id 快照進 `LEGACY_IDS`（不含
SULLY 專屬 special）。之後經內置素材包 / 用戶上傳進來的都是「新畫風」，不在此集合。

規則**按類目智能生效**：某類目**一旦有了新畫風部件**（`catHasNonLegacy`），它的老畫風就
**摺疊隱藏**（面板不展示）+ **隨機 roll 不到**；還沒上傳新款的類目，老款照常可用，避免遷移期留空檔。
老畫風數據始終保留在 `PARTS` 裡，**用了老部件的舊角色仍能正常渲染**——只是不能再在面板裡重新選它。

所以換畫風只需：把新畫風做成內置素材包傳上去，對應類目的老款自動隱去，無需刪任何東西。

## 用戶上傳部件的 Blob 存儲

`CustomCreatorPart.src` / `shadowSrc` 落庫前經 `creatorPartToBlobRefs` 轉成 `blobref:<id>` 令牌
（二進制進 `blob_assets` store，省配額）；讀出/注入 iframe 前經 `loadCreatorPartsForRender`
轉回 base64（iframe 契約要字符串）。備份（v3）裡令牌原樣進 JSON，二進制隨 zip 的 `blobs/<id>`
旁路走、導入按原 id 寫回（見 `utils/backupBlobs.ts`）。詳見 `utils/creatorPartsBlob.ts`。

測試：`pnpm vitest run utils/psdCreatorImport.test.ts utils/builtinPartsPack.test.ts utils/creatorPartsBlob.test.ts`。
