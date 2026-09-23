# QQ捏人工坊（神經鏈接 · 手辦櫃）

統一管理一隻角色在三處的 Q 版形象：**小小窩**房間立繪、**彼方**chibi、**特別時光** 520 大頭貼。每處可以單獨捏（互不影響），也可以挑一處形象「同步到全部」。入口在 神經鏈接 → 角色詳情 → **「手辦」tab**（獨立分區：迷你三格展示櫃預覽 `ChibiShelfPanel` + 「進入手辦櫃」按鈕），全屏工坊 UI 走手辦展示櫃風（三層展台 + 射燈 + 底座）。

## 三處形象的落庫位置（工坊不新增渲染路徑）

| 槽位 | 消費方 | 圖片存放 | 格式 |
|------|--------|----------|------|
| `room` | 小小窩 RoomApp（房間立繪） | `char.sprites['chibi']` | **blobref 令牌**（與上傳路徑一致，`putImageBlob`） |
| `vr` | 彼方 VRWorldApp | `char.vrState.chibi.img`（scale/offsetY/flip 保留不動） | dataURL |
| `like520` | 特別時光 520 活動 | 已通關：`char.specialMomentRecords['like520_2026'].customData.charChibi`；未通關：`char.chibiStudio.like520.img` 兜底 | dataURL |

> ⚠️ `char.sprites` 是混裝袋：`chibi`（blobref 令牌）與見面情緒立繪同居一個對象。任何「從 sprites 裡隨便挑一張當立繪」的兜底都必須跳過 `chibi` 鍵和 blobref 值（不能直接當 `<img src>`），統一走 `utils/dateSprites.ts` 的 `pickDateFallbackSprite`——否則會復現「沒傳見面立繪的角色，捏完 Q 版後見面模式裂圖」。

捏人器完整導出 state（選件 + 換色 + 翻轉 + 眼型…）按槽位存 `char.chibiStudio.{room,vr,like520}.state`（`types.ts` 的 `ChibiStudioData`），再編輯時整套還原。`chibiStudio` 屬運行時本地狀態，已加入 `CARD_STRIPPED_FIELDS`（角色卡導出/導入雙向剝離）。

## 關鍵文件

- `components/character/ChibiStudio.tsx` — 工坊本體（展示櫃 + 單槽編輯 + 一鍵同步）。
- `apps/Character.tsx` — 入口按鈕 + 全屏覆蓋層。**注意**：詳情頁 `formData` 是整體 auto-save 的副本，工坊直接寫庫後，關閉回調裡必須把最新角色數據 `setFormData` 拉回來，否則後續編輯會用舊副本蓋掉工坊成果（新增外部寫庫的面板都要防這個）。
- `public/like520/character_creator.html` — 捏人器 iframe。`like520_init` 新增 `savedState` 字段：**草稿 > savedState > presets**（presets 只有 `selected`，savedState 連換色/翻轉一起還原，見 `applyFullState`）。
- `components/Like520Event.tsx` — `CreatorIframe` 新增 `savedState` prop 透傳；`isSullyChar`/`sullyPresets` 改為導出；520 活動 fresh 模式的角色捏人器會帶上 `char.chibiStudio.like520.state`（工坊裡捏好的造型開場直接穿上）。
- `apps/VRWorldApp.tsx` — 彼方兩個 chibi 編輯器也改傳 `savedState`（原來 presets 只回填選件，丟換色）。

## 安全區（iOS 頂/底約束）

全屏工坊浮層遵循項目單一來源（`index.html :root`）約定，見 `ChibiStudio.tsx` 頂部常量：

- 頂欄 `STUDIO_TOP = var(--chrome-top)`——安全區 + SullyOS 狀態欄；狀態欄隱藏（iOS 全屏 PWA 默認）時自動塌回 `--safe-top`。**不能只用 `--safe-top`**，否則狀態欄顯示時頂欄會懟進時鐘/電量條。
- 底部 `--safe-bottom`（帶 JS 探測兜底，iOS 全屏 PWA 原生 `env(safe-area-inset-bottom)` 偶發返回 0，別直接用它）+ 手勢餘量。展示櫃滾動區 `STUDIO_BOTTOM`、同步彈層 `STUDIO_SHEET_BOTTOM`。

迷你預覽 `ChibiShelfPanel` 渲染在角色詳情 tab 內（非全屏浮層），安全區由神經鏈接（自理名單，見 `utils/safeAreaApps.ts`）統一處理，組件本身不再單獨讓位。

## 隨「設置 → 導出」往返

`chibiStudio` 是 `CharacterProfile` 上的普通字段，隨 `characters` store 走**整合導出（full）/ 純文字（text_only）**。導出/導入的圖片抽取（`extractImagesInPlace`）與還原（`restoreAssetsInPlace`）都是**全字段遞歸、無白名單**，所以：

- `chibiStudio.like520.img`（兜底大頭貼 dataURL）、`vrState.chibi.img`、`specialMomentRecords…charChibi.dataUrl` 三處 dataURL 會被抽進 zip `assets/*`、導入時原樣還原；
- `sprites.chibi`（blobref 令牌）原樣進 JSON，二進制隨 zip 的 `blobs/<id>` 旁路走、導入按原 id 寫回（收集免名單，見 `utils/backupBlobs.ts`）；
- `chibiStudio.*.state`（選件 JSON，無圖）隨文字走，`text_only` 模式下圖片被剝、但 state 仍在（可再編輯），與全局圖片剝離行為一致。

**媒體與美化素材（media_only）**模式的角色只導出一份手挑的視覺子集（avatar/sprites/roomItems/backgrounds…），不含 `chibiStudio`/`vrState`/`specialMomentRecords`——與這些運行時字段既有的處理一致，官方也提示「別只導媒體包」。迴歸測試見 `utils/backupExport.test.ts`「角色的 chibiStudio / vrState.chibi / 520 記錄裡的圖都會被遞歸抽取」。

角色**卡**分享（單角色導出）則會剝掉 `chibiStudio`（已在 `CARD_STRIPPED_FIELDS`），與 `vrState`/`specialMomentRecords` 同屬運行時本地狀態，不隨卡外傳。

## 草稿與 savedState 的關係

捏人器 iframe 用 `localStorage` 存未確認草稿（key 按 `draftKey` 隔離；工坊用 `studio_${charId}_${slot}`）。草稿優先於 savedState——用戶上次捏一半退出，再進來先恢復 WIP；確認導出後草稿內容與已存 state 一致，行為無感。
