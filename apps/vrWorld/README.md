# 彼方 / SAR 開發交接

當前實現核對：2026-09-11。開發分支：`codex/dino-cafe-art`。

SAR 活動室使用用戶提供的原畫（`assets/sar-club-room.png`），按原比例顯示；恐龍箱庭在自己的設施頁面按需加載 Three.js。兩人的個人線、情緒立繪、特殊演出、真實贈品與名冊回放已經接入正式入口。

| 文檔 | 內容 |
| --- | --- |
| [SAR 活動室怎麼玩](../../docs/sar-user-guide.md) | 用戶入口、完整流程、模型調用次數與存檔 |
| [個人線](../../docs/sar-personal-lines.md) / [凱恩原稿核對](../../docs/sar-familiarity-caian-content.md) | 每日話題、星級事件、演出、獎勵、回憶與內容來源 |
| [數值規劃](../../docs/sar-economy.md) | 錢包、抽取、模塊、折扣和系統回收 |
| [敘事與世界意志](../../docs/sar-narrative-principles.md) | 生成式推演的敘事邊界，與固定個人線的區別 |
| [水域與佈告板](./FISHING.md) | 釣魚、交易、行情、圖鑑與事實回執 |
| [恐龍箱庭](./DINOSAUR-GARDEN.md) / [SAR 美術](./SAR-ART.md) | 模型、擺放、來訪、立繪與手遊式界面 |

這份文檔用於在另一台電腦上繼續開發當前的彼方大更新。當前結構：**SAR 是與「世界」並列的一級入口，點擊後進入獨立全屏活動室**，收起公共頂欄和世界翻頁；左上角返回彼方，右上角提供隱藏標記、設置與倉庫。凱恩與艾文是可關閉的固定 NPC；人格推演、陳列櫃、模塊商店都屬於這片空間的設施。

## 換電腦繼續開發

首次拉取這個分支：

```bash
git fetch origin
git switch -c codex/dino-cafe-art --track origin/codex/dino-cafe-art
pnpm install --frozen-lockfile
pnpm dev
```

如果本地已經有同名分支：

```bash
git switch codex/dino-cafe-art
git pull --ff-only
pnpm install --frozen-lockfile
pnpm dev
```

默認打開 Vite 輸出的本地地址。API、角色和歷史數據仍在瀏覽器本地存儲中；Git 分支只同步代碼，不會同步這台電腦裡的角色或測試檔案。需要復現原數據時，用 SullyOS 的完整導出/導入。

## 當前已經完成

### 1. SAR 空間與 NPC 開場

- 首次進入會顯示“更新－彼方活動室”，再讓用戶選擇“我很歡迎 / 我不想要 NPC”。
- NPC 開關只控制凱恩、艾文及固定對白，不影響設施。
- 右上角隱藏按鈕循環四檔：只隱藏名字/稱號、全房間文字、全部角色小人（恢復設施標記）、全部恢復；獨立於 NPC 偏好，舊隱藏狀態兼容映射全文字檔。
- 自家角色須當前房間為 SAR 且有具體 `sarActivity` 才進入 SAR 站位與在場名單；僅接入彼方或只殘留 SAR 房間字段不算。下一次活動去其它房間後不再顯示；用戶自己仍按主動進入的房間顯示。
- 凱恩初見是寫死的 Galgame 分支，不調用 LLM；結束後移除感嘆號。
- “初見回檔”只重置凱恩初見，不重置更新公告與 NPC 偏好。
- 歷史備份恢復後，SAR 首次觸發狀態跟隨導入數據，不沿用導入前設備狀態。
- 凱恩初見結束後及艾文入口進入各自個人線。每位 NPC 每個本地自然日固定一次隨機結果：80% 有未完成話題、20% 日常問候；當前星級十個普通話題完成後，直接開放星級事件。只有事件完整結束才升星，五顆星目前實現到三星。
- 默認單人居中；另一位 NPC 實際發言後保持當前段落同框，跨節點查看後續六句是否仍有對方台詞，避免短暫進出。提及名字不觸發首次出場；留場狀態隨游標保存，續看和回放遵循同一規則。日常台詞點擊氣泡逐句閱讀，居中選項浮層不擠壓立繪。
- 17 張用戶原畫表情已作為本地 WebP 隨包提供（凱恩 11 張、艾文 6 張），失敗才回落原 CDN。凱恩新增 `Enduring Pain`（忍痛）、`avoidant`（迴避）、`normal2`（平常2）、`warm`（溫柔），已同步用戶更新的透明背景原圖，供手動表情校對，已應用用戶校對的表情編排。證件、會議、合照、禮炮、券雨、物品堆、神秘按鈕和專屬混合恐龍由程序演出，不調用模型。
- 「倉庫 → 圖鑑 → 名冊」保留兩人完整簡介、星級和已完成回憶；名冊屬於用戶，不隨倉庫主人切換。回放不推進進度、不重複領物品或優惠，不發送第二次私聊彩蛋。

### 2. 異世界人格推演

- 兩個獨立卡池：`人格異格` 與 `異界座標`，每池每天免費一次。
- 常駐 NPC 開關同時控制稱號顯示/編輯、名冊、專屬紀念和 NPC 專屬圖鑑條目；關閉時暫停個人線與待投遞彩蛋，聊天/活動不注入 NPC 背景或稱號元數據，異步活動不能寫回稱號。普通設施保留，售魚改為中性回收站，重新開啟恢復保存的進度。統一門禁在 `sarNpcPreference.ts`，設置變動通過同頁事件和跨頁 storage 事件同步。
- 鑄造時選擇角色，再組合兩枚芯片；LLM 生成角色異格身份、鋼印、代價、User 身份面具、異世界座標和可直接參與的開場。
- 現實記憶不整包搬入異世界，只讀取雙方“關係門牌”；具體聊天和近期現實事件不進入推演。
- 正式演繹最多 50 次成功互動；世界意志跟隨用戶當下關注，事件可被忽略，日常與關係互動有效，旁白允許為空。一次調用同時生成演出與私有連續性事實，後者隨消息保存且不進入正文或導出。末段收束實際經歷，不強迫完成主線。見 [敘事運行原則](../../docs/sar-narrative-principles.md)。
- 封存檔案可重複閱讀、下載，並可把返航簡報分享給原角色聊天。
- 陳列櫃按角色整理 User 的身份卡與旅程；“看看角色的櫃子”展示角色自由活動時自己抽芯片、給其他人使用後寫下的事故隨筆。

### 3. 模塊商店與裝載

- 固定模塊目錄目前 46 件；每日隨機上架 5 件，每天可手動刷新 3 次。
- 用戶模塊按目錄價及實際優惠扣鱗幣；個人線可給 30 分鐘八折和九折券，取最優單項，不疊加。扭蛋兩池每日各免費一次，其後每次 90 鱗幣。餘額與水域、佈告板共用，原庫存保留；無限抽取與免費購買只屬於早期試玩行為。
- 購買只發生在 SAR 櫃檯；使用從角色本身發起：在彼方任意房間點擊任意小人，都可以“抓住 TA · 使用模塊”。
- 對角色使用持續 10 次成功 LLM 互動；對 User 使用持續 5 次。
- 結束後保留 3 次穩定提示：第 1 次明確察覺模塊解除，後 2 次防止模型繼續沿用汙染語氣。
- 角色對 User 使用模塊默認關閉，需 User 主動開啟“允許角色對我使用模塊”。
- 失敗、取消和重擲不會扣模塊壽命；新回覆成功落庫才扣一次。
- `關鍵詞消音器` 與 `禁止說名字` 在裝載確認頁填寫短字面值；配置隨本次運行時保存，不作為第二份自由 prompt。
- 模塊貨架、庫存和購買記錄已進入 SAR 完整備份；換設備導入後可恢復。

### 4. Chat / Date 真意與外顯隔離

核心約束：**模塊只能改變當時被看見、被聽見的表達，不能改寫真實意圖、事實、行動、關係和長期人格。**

```text
角色/User 當前模塊狀態
        ↓
ContextBuilder 高優先級模塊段
        ↓
一次 LLM：CHAR_TRUE + CHAR_SURFACE + USER_SURFACE
        ↓
Message.content              metadata.sarModuleSurface.surface
真實/規範語義                臨時界面外顯
        ↓                              ↓
事實/意圖判斷基準              Chat / Date 顯示與 TTS
        └──────────┬───────────────────┘
                   ↓
上下文、總結、記憶宮殿：同時知道真意與當時外顯，外顯只作歷史引文
```

- Chat 使用明確的「汙染台詞 / 原台詞」文字切換，不覆蓋用戶自定義氣泡樣式。
- Date 的閱讀和立繪模式各自提供「汙染台詞 / 原台詞」切換，按整批進度匹配重複短句，併兼容舊的原文續接快照。
- 純括號動作/旁白氣泡不附加汙染文本，也不消耗下一句外顯序號。
- 兩側拆泡前共用歷史標籤/表情預處理：`[你 發送了表情包: …]`、分類展示、單括號、全角冒號與大小寫變體統一識別。表情只從真意發出，外顯的表情不佔台詞序號，原位後續台詞與末句都保留。
- 外顯不執行控制命令；HTML 與歷史格式分享卡片使用和真意相同的純提取器排除，內聯控制標籤僅剝除。HTML 關閉後留下的佔位泡也不佔外顯台詞序號。新增迴歸通過真實後處理落庫和 MessageItem 真言切換驗證，不改寫已有錯位歷史記錄。
- 內置翻譯把一整組 `<原文>/<譯文>` 當成一個氣泡；原文和譯文保持同一份汙染含義。
- `日文（中文翻譯）`、`English (中文翻譯)` 等角色自定義同泡格式會整體保留，不把括號翻譯誤判為動作。
- `<語音>` 與 `<字幕>` 是一個原子氣泡；TTS 朗讀外顯版，數據庫仍保存真意。切換真言只改變文字查看，已經生成的音頻保留當時實際說出口的版本。
- 總結與記憶格式化只讀取 `content`，並附帶“SAR 臨時外顯不代表內心/事實”的護欄。
- 模塊在提示詞裡是角色可感知、會記得是誰裝上的外來裝置，不是幕後寫作風格；首輪必須察覺，後續每輪保留符合性格的反應或應對，但避免機械復讀說明。

## 關鍵代碼入口

| 文件 | 負責內容 |
| --- | --- |
| `apps/VRWorldApp.tsx` | 彼方總路由、SAR 獨立入口、設施彈層、任意房間抓取角色、設置與回檔入口 |
| `apps/vrWorld/SARClubEvent.tsx` | 更新彈窗、NPC 舞台、凱恩固定初見對白 |
| `apps/vrWorld/SARFamiliarityDialog.tsx` / `SARFamiliarityEffects.tsx` | 個人線重開、分支、情緒立繪、交互演出與獨立回放 |
| `apps/vrWorld/SARFamiliarityRoster.tsx` / `SARCollectionView.tsx` | 圖鑑收藏與名冊兩頁、五顆星、已完成回憶入口 |
| `utils/vrWorld/sarFamiliarity/` | 兩人原稿、每日與星級狀態、獎勵事務、優惠與數據校驗 |
| `apps/vrWorld/SARGacha.tsx` | 雙卡池與扭蛋動效 |
| `apps/vrWorld/SARAssemblyCabinet.tsx` | 陳列櫃、角色分類史冊、身份檔案與角色隨筆 |
| `apps/vrWorld/SARSimulationSession.tsx` | 正式 50 輪推演、封存、閱讀與導出 |
| `apps/vrWorld/SARModuleShop.tsx` | 每日貨架、刷新、購買、模塊袋、目標鎖定與裝載動效 |
| `utils/vrWorld/sarClub.ts` | NPC 偏好、初見狀態與分支對白數據 |
| `utils/vrWorld/sarGacha.ts` | 兩個卡池母體、每日抽取與收藏狀態 |
| `utils/vrWorld/sarCommerce.ts` | 用戶鱗幣結算、原子發貨、購買去重與庫存遷移 |
| `utils/vrWorld/sarSimulation.ts` | 身份鑄造、User 面具、異界座標、世界意志、50 輪狀態、封存與導出 |
| `utils/vrWorld/sarCharacterCabinet.ts` | 角色自主抽卡事故、隨筆生成與櫃子索引 |
| `utils/vrWorld/sarModuleShop.ts` | 46 件模塊、每日 5 件/3 次刷新、庫存與消費 |
| `utils/vrWorld/sarModuleRuntime.ts` | 10/5 回合壽命、3 回合退場、LLM 信封、氣泡對齊與語音外顯源 |
| `utils/context.ts` | Chat / Date 共用的模塊上下文唯一出口 |
| `hooks/useChatAI.ts` | Chat 請求解析、User/Char 外顯 metadata 寫入與壽命推進 |
| `utils/chatRequestPayload.ts` | 高注意力提醒、翻譯模式與 SAR 容器協調 |
| `utils/applyAssistantPostProcessing.ts` | canonical 落庫、雙語/語音/普通氣泡的 surface 對齊 |
| `components/chat/MessageItem.tsx` | Chat 汙染台詞 / 原台詞切換、語音與雙語顯示 |
| `utils/datePrompts.ts` / `components/date/DateSession.tsx` | Date 的模塊協議、發光外顯與真言切換 |
| `utils/messageFormat.ts` | 給上下文、總結和記憶宮殿的 canonical 護欄 |

## 本地狀態鍵

| Key | 內容 |
| --- | --- |
| `vr_sar_club_state_v1` | 更新公告、NPC 偏好、凱恩是否見過 |
| `vr_fishing_market_v1` | 錢包、魚獲、交易、箱庭、收集記錄；`sarCommerce` 保存用戶卡池/模塊，`sarCharacterModules` 保存角色模塊，`sarFamiliarity` 保存個人線、紀念物、優惠與解鎖 |
| `vr_sar_gacha_state_v1` | 兼容舊卡池存檔；完成遷移後以市場內 `sarCommerce.gacha` 為準 |
| `vr_sar_simulations_v1` | 身份卡與 50 輪推演實例 |
| `vr_sar_module_shop_v1` | 兼容舊商店存檔；完成遷移後以市場內 `sarCommerce.moduleShop` 為準 |

角色身上的模塊存在 `CharacterProfile.vrState.sarModule`；User 身上的模塊存在 `UserProfile.vrState.sarModule`。角色自由活動隨筆以普通 `vr_card` 寫進聊天，因此自然進入原有消息、上下文和記憶流程。

完整 ZIP 通過 `sarBackup.ts` 採集 SAR 狀態，並隨 `metadata.json` 掃描紀念物及未完成照片草稿的嵌套 `blobref:`，導出二進制圖片，恢復時保留原 token。純文字備份去掉這些圖片引用及內嵌圖片，保留進度、文字、構圖和優惠記錄。代碼提交不會代替用戶存檔備份。

## 建議先跑的檢查

不需要啟動瀏覽器的重點回歸：

```bash
pnpm test:run utils/sarGacha.test.ts utils/sarSimulation.test.ts utils/sarCharacterCabinet.test.ts utils/sarModuleShop.test.ts utils/sarModuleRuntime.test.ts utils/vrWorld/vrWorld.test.ts utils/applyAssistantPostProcessing.test.ts utils/chatRequestPayload.test.ts utils/chatParser.chunkText.test.ts utils/minimaxTts.voice.test.ts --no-cache
```

個人線還需跑 `utils/sarFamiliarity.test.ts`、`utils/sarFamiliarityEdges.test.ts`、`utils/sarFamiliarityDiscounts.test.ts`、`utils/sarCollection.test.ts`、`utils/sarEconomy.test.ts`、`utils/fishBackup.roundtrip.test.ts`，以及 `scripts/test-sar-familiarity-*.mjs`、`scripts/test-sar-roster-ui.mjs`。真實 Root 測試覆蓋新對話、中斷重開、單人/連續同框、名冊返回、回放不寫檔和贈品去重；全部使用隔離存檔，模型分支使用假 API。

手動測試優先順序：

1. 普通 Chat：角色回覆混合“括號動作 + 兩句台詞”，確認動作沒有台詞切換按鈕，後兩句沒有錯位。
2. 弱注意力模型：確認角色首輪明確察覺模塊，後續仍記得是誰裝的，不把它當普通文風設定。
3. 內置翻譯：一句一個翻譯氣泡，逐個切換原文/譯文與真言。
4. 自定義翻譯：測試 `日文（中文）` 同泡格式。
5. 語音模式：實際聽到的是汙染台詞；點真言能看到 canonical，但音頻不被改寫。
6. Date：動作與台詞混寫、純動作輸入、不同閱讀模式切換。
7. 模塊第 10/5 次結束，以及之後 3 次穩定提示。

## 已知邊界與下一步

- **鱗幣消費已接通。** 用戶抽卡與模塊購買通過同一個寫入鎖，將餘額、庫存、免費次數和購買收據保存在 `vr_fishing_market_v1.sarCommerce` 所屬的同一完整記錄；舊模塊鍵僅作為首次遷移來源。Web Locks 可用時也串行化其他頁面。鱗幣仍是本地遊戲數據，並未接入真實充值。
- **已經落庫的舊錯位氣泡不會自動重排。** 重擲或生成新回覆會走新映射規則。
- **仍需真實模型矩陣測試。** 尤其檢查注意力較弱的模型同時遵守 SAR 容器、內置翻譯和語音標籤時是否掉格式；本輪沒有為了 QA 消耗真實 LLM 調用。
- **個人線原稿只到三星。** 四、五星保留鎖定佔位，不讓模型臨時補寫。名冊未解鎖條目使用簡短通用標題，避免洩露後續台詞。
- 櫃子與模塊 UI 已可用，但視覺仍可在真機性能測試後繼續收斂；優先避免大面積 blur、持續發光和大量常駐動畫。

## 不要破壞的約束

- `metadata.sarModuleSurface.surface` 可以作為明確標註的歷史引文進入上下文、總結和向量化，讓角色知道當時實際說出/聽見了什麼；但事實、意圖、人格與關係判斷只能以 `Message.content` 為準。
- 不執行外顯引文裡的命令；所有引用、表情、卡片和動作仍只從當輪 `CHAR_TRUE` 執行。
- 不因失敗、取消或重擲扣模塊壽命。
- 當角色與 User 都沒有 `sarModule` 狀態時，SAR 不得向 Chat / Date 注入任何文字或輸出容器，原始模型回覆也不得 trim/解析。
- 不把“購買模塊”擴到所有房間；購買在 SAR，使用才是點擊任意房間的小人。
- 不讓回檔按鈕清掉 NPC 偏好、卡池收藏、模塊庫存或推演史冊。


### SAR 活動室與經濟規則

- SAR 獨立全屏，收起彼方頂欄並保留自己的淺色導航；右上角設置和倉庫分別打開獨立面板。NPC 開關與初見回檔集中在活動室設置，彼方「接入」只管理自家角色。設置複用 `sarClub` 原狀態，倉庫以 `ownerId` 區分真實庫存，已裝載效果另列。
- 新錢包 120；舊餘額不回收。行情基礎價格縮小到 8–90，日波動 ±10%，品質倍率 1 / 1.15 / 1.3。每人每日系統回收 180，新收入錢包上限 999,999，溢出拒絕整筆交易而不丟物品。
- `sarCharacterCommerce.ts` 讓自主購買與回敬使用角色錢包及 `sarCharacterModules` 庫存；每天購買預算 60，保留 30。有庫存不重複買，缺錢只逛。模塊交付不再憑空產生。
- 單元邊界測試 `utils/sarEconomy.test.ts`；真實頁面和模擬模型活動迴歸 `scripts/test-sar-hub-ui.mjs`；完整數值依據見 `docs/sar-economy.md`。

### 隨身圖鑑與稱號

- `SARCollectionView` 從倉庫右上角進入；收藏頁按真實 catalog 統計魚類、恐龍、芯片、模塊，種類點亮與持有數量分開並按 owner 切換。恐龍蛋到艾文三星話題才開放，舊檔當前/歷史有蛋也保留；目錄另有劇情專屬 `aiven-chimera`，不要把可見總數寫死為十二種。
- `sarCollectionJournal` 在消耗舊庫存前保留可證實的芯片/模塊收集；歷史購買及真實付款人的回執可補錄，不把效果接收人或臨時演繹算成擁有者。journal 與錢包庫一起存儲和備份，魚類繼續使用原有個人 collectionEntries。
- `KanataTitleEditor` 寫入個人/角色 `vrState.title` 與隨機 revision；頭頂稱號、腳下人名、暖白設施牌採用三套外觀，站位避讓可見標籤，自定義 chibi 縮放也計入頭頂位置。
- 新檔在艾文二星事件開放稱號；已獲得的「聽懂風的人」可選，也可自定義，不自動覆蓋當前稱號。舊檔已有稱號保留編輯資格。個人線紀念物和未用券在用戶倉庫的「紀念」「優惠券」中，實際物品只發一次。
- `kanataTitle.ts` 統一 12 字符文本規範、JSON/XML 可選 metadata 提取與併發檢查。`chatPrompts.ts` 注入當前聊天狀態；`prompts.ts` / `runSession.ts` 接受角色本次活動的自改請求。先保存有效活動，後嘗試稱號更新；被關閉接入或 revision 已改變時不覆蓋。普通活動狀態回寫也必須保留最新稱號。
- `scripts/test-sar-collection-ui.mjs` 覆蓋倉庫編輯、圖鑑四類進度、消耗留檔、主人隔離、嵌套返回與六種模型返回路徑。全部模型請求在隔離瀏覽器裡本地模擬。

設置旁的「隱藏」按鈕依次切換：只隱藏角色名字與稱號、隱藏全部房間文字、隱藏全部角色小人並恢復設施標記、全部恢復。隱藏的設施入口不會留下不可見的點擊區域。此偏好隨 SAR 本地設置和備份保留。


### 2026-09-11 設置備份與發佈整合

設置的 full / text_only 備份保留完整 SAR 本地存檔（club、遷移後的卡池/商店、推演、水產市場及其中花園/名冊/劇情/收藏），並補充簡易釣魚、推演配色、花園引導三個本機偏好。full 對嵌套自定義圖片執行資源提取、blob 旁路和還原；text_only 按原約定剝除自定義圖片。media_only 不覆蓋玩法狀態。恢復舊主歷史時清理缺失的 SAR 偏好，局部導入保留現有值。

活動室、角色交談/回顧、釣魚/市場/花園、卡池/組裝櫃/推演/模塊商店、倉庫/收藏冊/名冊/設置入口通過 sarAnalytics 白名單接入 Umami。偏好在 analyticsSnapshot 按會話收集，不記角色或劇情內容。

### Chat 用戶模塊逐條外顯（2026-09-13）

- 用戶本輪連續發送的文字按消息 ID 分別生成、分別寫入 metadata.sarModuleSurface；不會把整段 USER_SURFACE 塞進最後一個氣泡。content 和原話切換保持不變。
- Chat 專用 USER_SURFACE 使用 JSON 數組（id / surface），請求明確列出當前私聊未回覆、裝載後發送的文字；不追溯舊聊天、不處理別的角色或圖片消息。見面協議不變。
- 兼容舊模型的時間戳分段：只有段數與輸入條數一致時才按順序匹配並去掉記錄頭；多條合併、重複 ID、未知 ID 等無法可靠匹配的結果保留原話。用戶自己輸入的日期、換行、動作和翻譯格式不被當成記錄頭刪除。
- 模塊浮窗收起時顯示受影響者，展開時同時顯示裝載者；多人時以姓名 + 人數提示，長名省略，移動端不溢出。
- 迴歸：utils/sarUserSurface.test.ts；scripts/test-sar-user-module.mjs（實際 Chat 請求、氣泡原話切換、舊格式兼容、320px 浮窗）。

表情格式兼容補充：用戶側反饋模型會誤抄歷史中的“發送了表情包”記錄。共享表情規範化現覆蓋單雙層方括號、中文/全角括號與全角冒號；群聊只接表情規範化，不接私聊的轉帳或 LIFE 動作恢復。故意加分隔符的示例、反引號說明不修復成發送命令，表情分類的角色可見範圍保持生效。迴歸覆蓋私聊落庫順序、群聊發送、相鄰指令及隱藏表情包。

### 異格回覆維護與 TRPG 原文（2026-09-13）

- 每條異格角色回覆的「…」可複製、修改、重新生成或刪除。修改同時支持世界旁白，後續已有正文保持原樣。
- 重生成只讀取該幕用戶輸入之前的歷史，使用原輸入、原幕次與原回覆 ID；成功前不改舊文，失敗可重試，不重複消耗互動次數。封存檔案也可維護已有回覆，不因此開啟新旅程。
- 刪除清空角色正文、旁白和相應連續性事實，保留一個不可見正文的回覆位置，記錄 `sarDeleted`。用戶輸入與幕次不刪除；刷新後仍顯示「生成這一幕」，底部生成按鈕優先補上未完成回覆。所有空位補齊前不新增幕次。
- 修改、刪除、重生成採用 IndexedDB 同一事務校驗舊版本並替換，同時清理從該幕起的隱藏導演事實，避免舊事實覆蓋修改後的正文；併發過期寫入會拒絕。被刪除的正文不進入推演上下文、導出或返航簡報。
- 模型原樣返回 JSON 中的角色模板說明會按無效回覆處理；默認旁白佔位也不會顯示給用戶。
- TRPG 總結原本已保留完整 logs，僅回看渲染截斷至 140 字。現在完整渲染原文與段落，仍按總結摺疊；模型上下文繼續使用原有總結機制。
- 迴歸：`utils/sarSimulationEdits.test.ts`、`scripts/test-story-edits.mjs`，包含刷新重試、API 故障、封存維護、原文切換與舊總結兼容。
