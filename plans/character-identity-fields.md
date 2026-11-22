# 角色的別名、身份、簡介（把「描述」那一格拆開）

> 狀態：**三批都做完**（2026-11-22，實況在第 7、8、9 節）。Liora 點頭的方向：別名／身份／簡介分開，精簡人設不另開；第 6 節三件事都照建議定了。

## 1. 為什麼

神經鏈接的角色設定頁，名字下面有一格以前只寫「描述」（2026-11-22 先改成「一句話簡介」）。這一格被拿去當兩種東西：

- 私聊的提示詞把它標成「用戶備註／愛稱」，還附一句「可能包含比喻，跟核心設定衝突時以核心設定為準」。
- 群聊、AI 生成配角、查手機、各種清單把它當「這個角色的簡介」。

同一句話兩種讀法。寫「嘴甜心硬的前輩」的人，私聊裡被當成妳對 TA 的愛稱；寫「快樂小狗」的人，群聊裡被當成 TA 的自我介紹。

另外，系統認人只認名字那一格。角色寫到「Vivian」「陸姐」時，認不出那是陸薇寧。

## 2. 現況（照程式碼查的）

### 已經有自己格子的

| 東西 | 欄位 | 在哪裡填 | 誰的 |
|---|---|---|---|
| 妳怎麼叫 TA | `chatNickname` | 聊天設定 →「暱稱」 | 每條關係線各一個（`utils/chatLine.ts` 的線欄位） |
| TA 怎麼叫妳 | `userNickname` | 聊天設定 | 每條線 |
| 精簡人設 | `briefPersona` | 角色頁最下面，可 AI 生成 | 角色（`utils/briefPersona.ts`），100～200 字 |

這三個這次**都不動**。

### `description` 現在被誰讀

給 AI 看的：

| 哪裡 | 檔案 | 現在標成什麼 |
|---|---|---|
| 私聊、通話、見面、主動消息的角色身份段 | `utils/context.ts` `buildCoreContext` | 用戶備註／愛稱 |
| 群聊話題盒 | `utils/groupChat/topicBoxes.ts` | 角色簡介 |
| 群聊出場表、成員一行介紹 | `utils/groupChat/beatPlan.ts` `memberBrief`（沒填就截人設 80 字） | 簡介 |
| AI 生成配角：主角和同世界的人 | `utils/castGenerate.ts` | 簡介 |
| 精簡人設的素材 | `utils/briefPersona.ts` | 簡介 |
| 查手機真角色名單 | `apps/CheckPhone.tsx`（社群簡介 → 這格 → 人設） | 掃一眼設定 |
| 家園成員介紹 | `apps/WorldHomeApp.tsx`（精簡人設 → 這格 → 人設） | persona |
| 劇情演員與在場的角色 | `utils/storyTheater.ts`、`utils/storyPresence.ts` | description |
| 小號的對外樣子 | `utils/charAlt.ts` `altIdentityBlock`／`altMaskBlock` | 簡介 |
| 彼方、小說、七夕、已讀不回、通話、寫歌、足跡 | `utils/vrWorld/sarSimulation.ts`、`utils/novelUtils.ts`、`utils/qixiReunion.ts`、`utils/readNoReplyRuntime.ts`、`apps/CallApp.tsx`、`context/MusicContext.tsx`、`utils/trajectory.ts` | 各寫各的（用戶備註、persona、簡介） |

給人看的（名字下面那行小字）：角色列表、訊息列表、切換聊天、加好友、行事曆選人、見面選角色、轉發選人、攻略本、小紅書、寫歌、QQ 橋、桌面的上一句。

搜尋：`utils/worldSections.ts` `matchesSearch`（名字、`chatNickname`、這格、世界名、分組名）。

進出：

- SillyTavern 角色卡匯入（`utils/stCard.ts`）：這格填的是卡片的**標籤**前四個（`tags.join(' · ')`），卡片的 description 進人設。
- 從別的 App 匯入聊天（`components/chat/PhoneChatImport.tsx`）：檔案裡的 `role` 現在被寫成人設開頭的「身份：…」，沒有地方放。
- AI 生成配角（`utils/castGenerate.ts`）：模型出 `brief`（一句話介紹）→ 這格。
- 舊 NPC 搬成配角（`utils/npcMigration.ts`）：NPC 設定的第一句 → 這格。

### 靠名字認人的地方

沒有共用的認人函式，各寫各的，全都只比 `name`：

| 哪裡 | 檔案 | 現在怎麼比 |
|---|---|---|
| 私下找人 `[[PRIVATE\|名字]]`／`[[DM\|名字]]` | `utils/sideMessage.ts` | 自己的 `norm`（全半形、空白、引號、大小寫） |
| 群聊動作的對象（紅包給誰…） | `utils/groupChat/dispatch.ts` `resolvePacketTarget` | 精確 → 互相包含 |
| 日程裡「跟誰」 | `utils/scheduleGenParts.ts` | 精確 → 互相包含 |
| 購物代付、送禮對象 | `utils/mallCharOrder.ts` | 自己的 `norm` → 精確 |
| 查手機聯繫人對回真角色 | `matchRealChar` | 名字 |
| 匯入聊天對回角色 | `components/chat/PhoneChatImport.tsx` | 名字 |
| 家園、彼方對回角色 | `utils/worldHome/threads.ts`、`utils/vrWorld/runSession.ts` | 名字 |

## 3. 定案

### 3.1 三格

| 介面上 | 欄位 | 放什麼 | 限制 |
|---|---|---|---|
| **別名** | `aliases?: string[]`（新） | TA 客觀上的其他名字：本名、英文名、綽號、圈名 | 介面一格，用逗號、頓號、分號分開（全形半形都收）；最多 8 個、每個 20 字；跟名字相同或重複的丟掉 |
| **身份／職位** | `roleTitle?: string`（新） | 一行：「攝影師」「段家長子」「妳的青梅竹馬」 | 40 字 |
| **簡介** | `description`（沿用） | 一句話介紹 | 不變 |

- 欄位名叫 `roleTitle` 不叫 `identity`：`identity` 在程式裡已經是查手機聯繫人的欄位，「身份卡」又是指妳自己，再用會混。介面上照 Liora 說的寫「身份／職位」。
- 精簡人設不另開一格。Liora 原本提的「精簡簡介」就是沿用的這格「簡介」。
- 跟聊天設定的「暱稱」是兩層：暱稱是「這張身份卡怎麼叫 TA」，每條線不同；別名是「TA 本來就有的名字」，角色自己的，所有線共用。

三格都在角色自己身上（不是線欄位）。配角一樣有。小號是另一張卡，自己一份。

### 3.2 讀取只走一個檔

新檔 `utils/charIdentity.ts`，零依賴，其他地方不直接拼：

- `parseAliasInput(text)`、`formatAliasInput(aliases)`：那一格的字 ↔ 陣列。
- `charAliases(c)`：整理過的別名（去空、去重、去掉跟名字一樣的）。
- `charNameLine(c)`：給 AI 的名字，「陸薇寧（又叫 Vivian、陸姐）」；沒別名就只有名字。
- `charSubtitle(c)`：清單上名字下面那行，見 3.3。
- `charOneLiner(c, { fallbackPersona? })`：給 AI 的一行介紹。有身份和簡介寫成「身份；簡介」，只有一樣就寫那一樣，都沒有才退回截人設（現在 `memberBrief` 的行為）。
- `matchPerson(name, people, opts)`：統一的認人，見 3.5（第 2 批）。

### 3.3 清單上那行小字

`charSubtitle`：身份和簡介都有 → 「身份 · 簡介」；只有一樣 → 那一樣；都沒有 → 各清單原本的預設字（「還不認識你」那些）不動。一行、太長截掉，跟現在一樣。

### 3.4 提示詞

私聊身份段（`utils/context.ts`）從一行變成最多三行，沒填的那行不出：

```
- 名字: 陸薇寧
- 別名: Vivian、陸姐
- 身份: Cos 圈的前輩
- 簡介: 嘴甜心硬
```

- 「用戶備註／愛稱」這個標籤拿掉。妳對 TA 的叫法本來就由 `chatNickname` 另外注入（`utils/chatRelationship.ts`）。
- 簡介那行留一句相容的話：「簡介是用戶寫的一句話印象，跟核心設定衝突時以核心設定為準」。舊資料裡有人拿這格寫愛稱，這句話讓它不會被當成硬設定。
- **所有角色的私聊提示詞字面都會變一行**（就算沒填新欄位，標籤也從「用戶備註／愛稱」變成「簡介」）。Liora 定了要改（第 6 節）。

其他給 AI 看的地方（第 2 節那張表）一律改成 `charNameLine`＋`charOneLiner`，標籤統一成「身份」「簡介」。沒填新欄位時，除了私聊那行以外，送出去的字跟現在一樣（用測試鎖住）。

雲端：身份段經 `buildCoreContext` 進主動消息的 `fire_pack` 和即時對話。改了這三格要打髒這個角色；提示詞字面換版那次要讓所有角色重傳一次（升 `FIRE_PACK_VERSION` 或同等做法，實作時照 `plans/amsg2-instant-chat-contract.md` 確認）。

預設系統：身份段屬於「資料」段，`utils/chatPrompts.segments.test.ts` 鎖的是「接回去等於內建送出的那串」，不鎖字面，照樣成立。

### 3.5 別名接進認人（第 2 批）

`matchPerson(name, people, { allowFuzzy })`，順序：

1. 名字精確相同（先做 `sideMessage` 現在那套整理：全半形、空白、引號、大小寫，再加繁簡）。
2. 別名精確相同。
3. 這一步各處原本有才做：名字互相包含。
4. 別名不做互相包含（「小陸」包含在很多字串裡，太容易認錯）。

撞名：

- 名字贏過別名。A 叫「小陸」、B 的別名也有「小陸」，寫「小陸」認 A。
- 兩個人的別名撞在一起、又沒有人的名字是它 → **當沒認出來**，不猜。
- 角色頁填別名時當場提醒：「同一個世界的〇〇也叫這個」，可以照存。
- 範圍照各處原本的名單（同世界、群成員、關係清單…），不擴大。別名只是讓名單裡的人多幾個叫法。

小號：

- 小號用自己的別名。本人的別名**不會**讓小號被認出來，名單和提示詞裡也不會把本人的別名寫在小號旁邊（不然等於洩漏是誰的小號）。
- `altPersonaView` 把人設換成本人的時候，別名、身份、簡介留小號自己的（跟現在名字、頭像、簡介的處理一樣）。

給 AI 的名單（私下找人、群成員、日程能約的人…）名字改用 `charNameLine`，模型才知道可以寫哪些叫法；它寫本名或別名都收。

要接的地方就是第 2 節「靠名字認人」那張表，全部換成 `matchPerson`。

### 3.6 舊資料

不自動搬。現有內容全留在「簡介」，別名和身份空著。系統分不出誰以前寫的是愛稱、誰寫的是簡介。

補的方法：

- 角色頁那三格旁邊一顆「AI 幫我填」：讀人設和世界觀，出別名、身份；簡介空著的也補一句。出來先填進格子，妳看過按存才算數。用副 API。
- 角色多的人一個個按太累，所以再給批次：神經鏈接列表頁「批次補別名與身份」，勾角色（預設勾「兩格都空的」），跑完列出每個人的結果，逐個可改可取消，一次存。全螢幕頁，不做半窗。

### 3.7 進出

- **ST 角色卡匯入**：標籤前四個照舊進「簡介」。卡片沒有對應別名和身份的欄位，空著（匯入頁提示可以按「AI 幫我填」）。
- **從別的 App 匯入聊天**：檔案的 `role` 改放「身份／職位」，不再塞進人設開頭。
- **AI 生成配角**：模型多出 `aliases`（沒有就空陣列）和 `roleTitle`，直接落欄位；同世界名單用 `charNameLine`＋`charOneLiner`。
- **舊 NPC 搬配角**：不改（搬過的不重搬）。
- **Soren 角色卡匯出／匯入**（`utils/characterCard.ts`）：帶上兩個新欄位。
- **備份**：欄位在角色卡上，跟著走，不用另外處理。

### 3.8 其他跟著改的

- 搜尋（`matchesSearch`、行事曆選人等）加別名和身份。
- Sore：`讀取角色` 帶出三格；`utils/assistant/knowledge.ts` 寫明三格各是什麼、跟聊天設定的暱稱差在哪。
- 精簡人設的素材加身份和別名；指紋（`personaFingerprint`）**只在有填時才算進去**，沒填的角色指紋不變，已生成的精簡人設不會被誤判過期（跟當初加對話範例時同一招）。
- 查手機：聯繫人綁到真角色時，聯繫人的「身份／關係」沒填就拿角色的身份當預設（用戶手動確認過的不蓋）。

## 4. 分批

**第 1 批：欄位、畫面、提示詞**

- `types.ts` 兩個欄位；`utils/charIdentity.ts`＋測試。
- 角色頁：三格（別名、身份、簡介）＋「AI 幫我填」。
- 清單小字換 `charSubtitle`；搜尋加別名、身份。
- 給 AI 看的地方換 `charNameLine`／`charOneLiner`；私聊身份段改成三行。
- 進出（3.7）、雲端打髒與換版、Sore、精簡人設素材。
- 測試：沒填新欄位時，私聊以外各處送出去的字不變；私聊身份段三行的各種組合；別名那格的解析。

**第 2 批：別名接進認人**

- `matchPerson`＋測試（撞名、小號不洩漏、繁簡、全半形）。
- 第 2 節那張表全部換過去；名單給 AI 時帶別名。
- 角色頁填別名時的撞名提醒。

**第 3 批：批次補填**

- 列表頁「批次補別名與身份」全螢幕頁。
- 身份卡（妳自己）也加別名（第 6 節定了要加；不加身份）：角色私下找妳某張卡、日程裡約妳時認得出。

每批一個草稿 PR 到 `dev`。三批做完算一套新東西，到時再看要不要升版本。

## 5. 不做的

- 不自動把舊的「描述」猜成別名或身份。
- 不動 `chatNickname`、`userNickname`、精簡人設。
- 別名不做模糊比對。
- 世界書的關鍵詞觸發不自動加別名（那是世界書自己的規則，照 SillyTavern，見 `docs/worldbook-management.md`）。

## 6. Liora 定了（2026-11-22）

1. **私聊提示詞那行的標籤改掉。** 所有角色的私聊提示詞都會有一行字面不同（「用戶備註／愛稱」→「簡介」），沒填新欄位的也一樣。拿這格寫愛稱的人，之後把愛稱搬去聊天設定的「暱稱」。
2. **身份卡（妳自己）也加別名，不加身份。** 放第 3 批。
3. **清單小字顯示「身份 · 簡介」**，兩個都顯示，太長自己截掉。

## 7. 實況：第 1 批（欄位、畫面、提示詞）

做了的：

- 欄位 `aliases`、`roleTitle`；讀取層 `utils/charIdentity.ts`（`parseAliasInput`、`charAliases`、`charRoleTitle`、`charNameLine`、`charSubtitle`、`charOneLiner`、`charIdentityLines`、`charSearchFields`、`nameKey`）。沒填別名和身份時，每個函式吐出來的字跟拆欄位之前一樣。
- 角色頁：名字旁邊只留頭像網址，下面一塊「別名 · 身份 · 簡介」三格（`components/character/IdentityFields.tsx`）。別名打字時不整理，失焦才收成陣列（不然剛打的逗號會被吃掉）。
- 「AI 幫我填」（`utils/charIdentityFill.ts`）：副 API 有設就用，不然全域。
- 清單小字 12 處換成 `charSubtitle`；`matchesSearch` 加別名和身份（行事曆選人、切換聊天都走它）。
- 給 AI 看的 17 處換成 `charOneLiner`（群聊話題盒、AI 生成配角的同世界名單另外用 `charNameLine` 帶別名）。
- 私聊身份段：`charIdentityLines`，實測送出去的是「名字／別名／身份／簡介」四行。
- 進出：匯入聊天的 `role` 放「身份／職位」；AI 生成配角多出 `aliases`、`roleTitle`，生成頁每張卡多兩格可以改；Soren 角色卡是黑名單制，新欄位本來就會帶著走（補了測試鎖住）。
- 精簡人設：素材多【身份】【別名】；指紋有填才算進去。
- 小號：`altPersonaView` 明寫別名、身份用小號自己的。這一行不寫的話會從 `...owner` 把本人的帶進來（測試鎖著）。
- Sore：`讀取角色` 帶出三格；`knowledge.ts` 寫明三格和「暱稱」的差別。

跟設計稿不一樣的地方：

- **「AI 幫我填」不是「看過按存才算」。** 角色頁是自動存檔，沒有存檔鈕。改成：空的格子直接填；別名補上原本沒有的；身份、簡介已經有字就不動，把建議列在那格底下，自己按「換成這個」。
- **字面有變的不只私聊。** 彼方 SAR 那行原本也標「用戶備註」（`utils/vrWorld/sarSimulation.ts`），一起改成「簡介」。其他地方沒填新欄位時字面不變。
- **雲端沒有升 `FIRE_PACK_VERSION`。** 升版要連 Worker 一起重新部署。改成每台裝置重傳一次（`amsg2_identity_labels_resync_v1`，`context/OSContext.tsx` 啟動補傳那裡），沒開主動消息的角色自己會被篩掉。
- **查手機聯繫人不拿角色的身份當預設（3.8 那條撤掉）。** 聯繫人那格是「機主跟 TA 的關係」（同事、前任），角色的身份是「TA 是什麼人」（攝影師），兩個不是同一種東西，填進去反而錯。AI 判關係時本來就看得到名單上的身份。
- **ST 角色卡匯入頁沒加「可以按 AI 幫我填」的提示。** 匯入後進角色頁就看得到那顆鈕。
- **桌面上「角色上一句話」的預設字**（`apps/Launcher.tsx`、`components/os/MobileGameHome.tsx`）照舊只用簡介，不加身份：那裡要的是一句話，不是名片。
- **劇情演員、私下找人、群成員名單的名字還沒帶別名。** 留到第 2 批跟認人一起做，免得名單寫了別名、系統卻還認不出來。
- 沒加埋點。

## 8. 實況：第 2 批（別名接進認人）

認人的規則只在 `utils/personMatch.ts`：

- `matchPerson(name, people, { fuzzy, fuzzyMinLength })`：名字（全半形、空白、引號、大小寫、繁簡不計）→ 別名剛好一位 → 開了 `fuzzy` 才做名字互相包含。別名撞到兩位以上回 null，開了 `fuzzy` 也不猜。
- `findPersonByRef`／`peopleByAlias`：Sore 的工具用，「角色名或 id」→ id、名字剛好一位、別名剛好一位。
- `findAliasClashes`：角色頁的撞名提醒。

接上的地方：

| 哪裡 | 檔案 |
|---|---|
| 私下找人 `[[PRIVATE]]`／`[[DM]]` | `utils/sideMessage.ts`（原本自己的 `norm` 拿掉） |
| 群聊紅包對象 | `utils/groupChat/dispatch.ts` `resolvePacketTarget` |
| 群聊出場表（排班的模型寫的名字） | `utils/groupChat/beatPlan.ts` `matchMember` |
| 日程「跟誰」 | `utils/scheduleGenParts.ts` `resolveSlotPeople`（`loadNamedParticipants` 帶別名） |
| 查手機聯繫人對回真角色 | `utils/relationshipChat.ts` `matchRealChar` |
| 家園：私信對象、關係變化 | `utils/worldHome/threads.ts`、`engine.ts` |
| 匯入聊天時預選角色 | `components/chat/PhoneChatImport.tsx`（選單標「別名對得上」） |
| Sore 找角色 | `utils/assistant/worldbookOps.ts`（2 處）、`presetOps.ts`、`decorationOps.ts`、`decorationRead.ts` |

給 AI 的名單帶別名（沒別名的人字面不變）：私下找人名單、群聊出場表名單、查手機真角色名單、私聊「你身邊的人」（`utils/castRelations.ts` 多一個 `aliasesOf`）。群聊成員檔案和劇情演員檔案走的是 `buildCoreContext`，第 1 批的身份段已經帶別名，不用另外做。

角色頁：別名跟同一個世界的人撞到時，那格底下出提醒（撞到別人的名字、撞到別人的別名兩種寫法），照樣可以存。

跟設計稿不一樣的地方：

- **購物那條不是認人。** 第 2 節表裡寫的 `utils/mallCharOrder.ts` 比的是商品名，不是角色，沒有東西要接。
- **設計稿漏列兩處，這次補上**：群聊出場表（`beatPlan.ts`）和私聊的「你身邊的人」。後者很要緊：妳提到「Vivian」時，角色要先知道那是自己關係清單上的誰。
- **日程的提示詞本來就不列「能約的人」**，所以只接了「對回」那一步，沒有名單可以帶別名。
- **彼方那處**（`utils/vrWorld/runSession.ts`）只是在組名單，不是認人，沒動。
- **家園鎮上的 NPC** 沒有別名欄位，照舊只比名字；成員（角色）才認別名。
- 身份卡的別名是第 3 批：`SideTargets.personas` 已經留了 `aliases`，到時把身份卡的別名帶進來就會認。

## 9. 實況：第 3 批（身份卡加別名、批次補填）

### 身份卡的別名

- `UserProfile.aliases`（真實身份）、`UserPersona.aliases`（身份卡），整理規則跟角色的同一套。**不加身份**（照第 6 節定的）。
- 套用身份卡時別名跟著卡走（`applyActivePersona`、`profileForPersonaKey`）：卡沒填就沒有，不借真實身份的。同一個世界裡不同身份卡是不同的人。
- 讀一律 `utils/userPersona.ts` 的 `personaAliasesForKey(profileBase, key)`。
- 編輯頁（`components/user/UserPersonaEditor.tsx`，真實身份和身份卡同一頁）名字下面多一格「別名」。
- 給 AI 看：用戶資料段「互動對象 (User)」名字後面多一行「別名」，填了才出（`utils/context.ts`）；劇情的「用戶側執筆身份」同理（`utils/storyPresence.ts` 的 `StoryPresent.aliases`，身份卡和你演的角色都帶，面具沒有）。
- 認人：私下找人 `[[PRIVATE|名字]]`（`sideTargets` 的 personas 帶別名）、群聊專屬紅包發給哪張在場的卡（`packetUserTargets`）、日程「跟誰」（`loadNamedParticipants`）。

身份卡沒有撞名提醒：角色找妳是在「它認識的那幾張卡」裡找，通常只有一兩張。

### 批次補別名與身份

- 入口：神經鏈接列表頁，主角／配角那排右邊「補別名與身份」。全螢幕頁 `components/character/IdentityBatchFillPage.tsx`。
- 三步：勾角色 → 一起讀人設（同時 3 個，`runLimited`）→ 逐個看結果，最後一次存。**存之前不會寫進角色。**
- 預設勾「別名和身份都空、而且有人設可讀」的（`defaultBatchPicks`）；切到「全部」可以重讀已經填過的。沒有人設的不能勾。
- 每個角色的結果是三格可以再改的草稿，規則跟角色頁那顆「AI 幫我填」一樣（`draftFromFill`）：空的填上，有字的不動、把建議列在底下。每張可以「不要這個」，讀失敗的顯示原因、可以重試，中途可以停。
- 存的時候只寫有變的欄位（`patchFromDraft`），走 `updateCharacter`，雲端那邊照平常的打髒。
- **小號不列**（`batchFillCandidates`）。小號卡上的人設是空的，組提示詞時才換成本人的；拿本人的去讀會把本人的別名寫到小號上。

### 三批做完之後

- 用戶看得到的變化：角色頁三格與「AI 幫我填」、清單小字「身份 · 簡介」、角色寫別名也認得出是誰、批次補填、身份卡別名。
- 還留著沒做的：ST 角色卡匯入頁提示可以按「AI 幫我填」；家園鎮上的 NPC 沒有別名。

