# 拿掉舊 NPC 程式碼：清單（等 Liora 看過再動手）

> 狀態：**清單，還沒刪任何東西**（2026-11-26 盤點）。對應 `plans/todo.md` 第 3 項。

## 背景

關係線開給所有人後，打開 App、資料載入完，還有沒搬的 NPC 就會自動搬家：NPC 搬成配角、群成員併進去、查手機綁 NPC 的聯繫人改綁角色、朋友圈 NPC 的貼文改成角色作者、劇情客串併進演員（`plans/persona-line-batch6.md` 6b）。搬過的 NPC 記 `migratedToCharAt`，`OSContext` 的 `npcs` 只放**還沒搬的**，所以搬完之後 `npcs` 是空的，下面「刪」那一欄的程式都在空轉。

## 一、要留的（搬家、讀舊資料、舊備份）

| 東西 | 為什麼留 |
|---|---|
| `utils/npcMigration.ts`、`utils/npcMigrationRun.ts`（＋測試） | 搬家本體。還有人沒開過新版、或從舊備份還原，打開時要能搬 |
| `utils/pairLineMigration.ts` | 查手機裡跟真角色的舊對話搬進角色私聊 |
| `types.ts` 的 `NPCProfile`（含 `memory`、`relationships`、`knownPersonaId` 等） | 搬家要讀舊資料的形狀 |
| `utils/db.ts` 的 `npcs` 表、`getAllNPCs`、建表那行（`saveNPC` 只給舊編輯頁用，可以一起刪） | 舊資料在這張表，不能刪表 |
| `utils/backupExport.ts` 清單裡的 `'npcs'`、還原時寫回 `npcs` 表 | 舊備份還原回來要有地方放，還原完照常搬家 |
| `context/OSContext.tsx` 載入 `pendingNpcs`＋跑 `runNpcMigration` 那段 | 觸發搬家 |
| 搬家寫進去的欄位（角色的 `relationships`、`castRole`、群的 `members`） | 已經是角色那套在用 |

## 二、要刪的（只服務舊 NPC，搬完就閒著）

| 位置 | 內容 | 刪了之後 |
|---|---|---|
| `components/character/NPCManagerView.tsx` | 舊的 NPC 清單與編輯頁 | 整支刪 |
| `apps/Character.tsx` | 頂端「NPC」分頁（`topTab: 'npcs'`）、`addNPC`／`updateNPC`／`deleteNPC` 的接線 | 只剩主角／配角兩頁 |
| `utils/characterLaunch.ts`、`apps/ChatHub.tsx` | `tab: 'npcs'`、聯絡人清單裡的 NPC 行、點了跳 NPC 分頁 | 聯絡人只列角色（配角已在裡面） |
| `context/OSContext.tsx` | `addNPC`／`updateNPC`／`deleteNPC` 三個函式、context 上的 `npcs` 對外欄位 | 載入與搬家那段留著（見上表） |
| `utils/groupChat/npcMembers.ts`（＋測試） | 群聊 NPC 成員的檔案塊、`npcMemberIds` 的處理 | 群成員只剩 `members` |
| `apps/GroupChat.tsx` | `npcMemberIds` 約 12 處、NPC 成員的頭像／名字／禁言、建群與群設定裡加 NPC | 同上 |
| `utils/npcGroupGuestLine.ts`（＋測試） | 群聊「客串」 | **不是整支刪**：客串現在已經拉角色（`castAsGuestProfile` 把角色轉成 NPC 的形狀再丟進去），要改寫成直接吃角色，把 NPC 那條候選拿掉 |
| `utils/npcMemory.ts`、`utils/npcMemoryRuntime.ts`（＋測試） | NPC 輕量記憶整理、`resolveNpcApi`、`buildNpcMemoryBlock` | 整支刪；客串改寫後不再用 `buildNpcMemoryBlock` |
| 朋友圈：`utils/momentsAutoRuntime.ts`、`momentsPool.ts`、`momentsContext.ts`、`momentsReply.ts`、`momentsVoice.ts`（`npcVoice`）、`momentsGenerate.ts`（`generateNpcMoment`）、`momentsPersona.ts`、`components/moments/MomentsFeed.tsx`、`components/trajectory/TrajectoryMomentsTab.tsx` | NPC 當發文者、留言者、按讚者的那幾支路 | 只剩角色（配角照角色那套） |
| `components/user/MomentsInteractionSettingsPanel.tsx`＋`utils/momentsSettings.ts` | 「NPC 按讚機率」「NPC 留言機率」「NPC 互動延遲」「角色回覆 NPC 留言延遲」四格 | **要你決定**：直接拿掉；或改名成「配角」的機率，讓配角跟主角分開調（現在配角吃的是主角那組） |
| 劇情：`components/date/story/StoryTheater.tsx`、`StoryTheaterEditor.tsx`、`StoryTheaterSession.tsx`、`utils/storyTheater.ts`（NPC 輕量檔案塊） | 選「客串 NPC」、NPC 演員 | 舊的 `entry.npcIds` 搬家時已併進演員；編輯頁那格「客串 NPC」拿掉 |
| `apps/CheckPhone.tsx` | 聯繫人綁 NPC（`linkedNpcId`、`npcId`、`updateNPC` 回寫） | 只剩綁真角色；查手機自己腦補的虛構聯繫人**不動** |
| 行事曆：`apps/CalendarApp.tsx`、`components/calendar/PersonPickerPage.tsx`、`utils/scheduleGenerator.ts` | 「TA 的」選人裡的 NPC、`Participant.kind === 'npc'` | 只列角色；最近看過的清單裡殘留的 NPC 項讀到時略過 |
| 軌跡：`components/trajectory/TrajectoryHome.tsx`、`TrajectoryJourneyTab.tsx` | 旅程選同伴時列 NPC | 只列角色 |
| 文件與 Sore 知識 | 提到「NPC 分頁」的說明 | 跟著改 |

## 三、名字有 NPC 但跟這件事無關（不動）

- **家園**（`apps/WorldHomeApp.tsx`、`utils/worldHome/*`）的 `world.npcs`：家園自己生成的鎮民。
- **彼方**（`utils/vrWorld/marketNPCs.ts`、`marketNPCSession.ts`、`npcRoll.ts`、`sarNpcPreference.ts`、`apps/vrWorld/SARNpcArt.tsx`）：市集和 SAR 的固定人物；`utils/analyticsSnapshot.ts` 讀的是彼方熟悉度。
- **查手機的虛構聯繫人**：查手機自己腦補的路人，不在 `npcs` 表裡。

## 四、做法（點頭後）

1. 一個 PR：先改寫客串（吃角色）、朋友圈和劇情的 NPC 路，再刪 `NPCManagerView`、群聊 NPC 成員、NPC 記憶，最後收 `OSContext` 對外的 `npcs`／三個函式。
2. 每刪一塊跑 `tsc`（錯誤數不增加）、相關測試；刪掉的測試只限測被刪程式本身的那些。
3. 搬家路徑另外加一個測試：塞一筆舊 NPC 資料，開機後它變成配角、`npcs` 清空——確保刪完還搬得動。
