# 聊天語言：說話語言、夾雜第二語言、翻譯、翻譯 API

> 狀態：已定案（2026-11-15），照第 5 節分批做。

## 1. 現況

- 聊天設定「翻譯與語音」裡的「消息翻譯」只有兩格：
  - 「選」：氣泡顯示的語言，也就是角色說話的語言。
  - 「譯」：點一下切換過去的語言。
  - 另外有一顆「原文與譯文同時展開」。
- 開了以後，在私聊提示詞裡加「雙語輸出模式」（`utils/chatRequestPayload.ts` 第 4 段）。聊天模型每句都要輸出 `<翻譯><原文>…</原文><譯文>…</譯文></翻譯>`。
- 後處理（`utils/applyAssistantPostProcessing.ts`）把每組標籤存成一則 `原文\n%%BILINGUAL%%\n譯文`。氣泡（`MessageItem`）認這個格式做切換或展開。送回模型的歷史只留原文（`chatPrompts.ts`）。
- 設定存在 localStorage（`chat_translate_enabled_<charId>` 等），只在這台裝置、只在私聊生效。
  - 雲端（主動消息、即時對話）、群聊、電話、見面都不知道這個設定。
  - 電話和見面各自另記了一份翻譯語言。
- 現有的問題：
  - 只有「說什麼語言」和「翻成什麼」，沒辦法讓雙語人設自然混著說。
  - 翻譯一定要聊天模型自己順便做：輸出變兩倍長、多花 token，偶爾標籤跑掉，整句就不翻了。
  - 你自己打的字不能自動變成角色那邊的語言。

## 2. 要做成什麼樣

聊天設定裡的「聊天語言」一區（取代原本的「消息翻譯」）：

| 設定 | 說明 |
|---|---|
| **角色說話語言** | 首要語言，佔七成以上。選項：英文、繁中、簡中、粵語、日文、韓文、法文、自訂。 |
| **夾雜第二語言** | 可不選。給雙語人設用，說話時自然混用（句中換語言、口頭禪、某些詞只用那個語言講）。另外選混多少（見決定 4）。 |
| **翻譯成** | 你看得懂的語言。選「不翻譯」就沒有譯文。跟說話語言一樣、又沒有夾雜時，自動不翻。 |
| **原文與譯文同時展開** | 沿用原本那顆。 |
| **我的訊息自動譯出** | 你用「翻譯成」那個語言打字，送出時自動翻成角色說話語言。氣泡顯示譯好的那句，點一下看你打的原句。角色只看到譯好的版本。 |
| **翻譯用哪個** | 預設「聊天模型順便翻」（就是現在的做法）。也可以選系統設置裡設好的翻譯 API（見決定 1）。 |

- 存的格式不變，還是 `原文\n%%BILINGUAL%%\n譯文`。氣泡、展開、語音、引用這些讀現有格式的地方都不用改。
- 用翻譯 API 時，流程改成兩步：
  1. 聊天模型只用說話語言（加夾雜）寫，不再輸出翻譯標籤。
  2. 寫完的每個氣泡交給翻譯 API 翻成「翻譯成」，再存成同樣的格式。
  - 這樣聊天模型的輸出只剩一半長，格式也不會因為標籤壞掉。
  - 翻譯 API 失敗時，那則照樣存，只是沒有譯文，下面多一行小字「沒翻成，點一下再翻」，不會擋住整輪回覆。
- **夾雜第二語言只動提示詞**：首要語言要佔大部分，第二語言只在人設合理的地方自然冒出來，不要整句輪流切換。譯文一律整句翻成「翻譯成」。
- 舊資料搬遷：原本 localStorage 的「選／譯」搬成「說話語言／翻譯成」。舊的「中文」對應到「繁中」；不在新清單裡的（例如 Español）變成自訂。

## 3. 翻譯 API 放哪裡（建議）

**建議：系統設置裡另開一區「翻譯 API」，放在「識圖 API」旁邊，不塞進「API 配置」。**

理由：
- 「API 配置」那區全是聊天模型（OpenAI 相容：網址＋Key＋模型），預設、副 API、各功能都從那裡挑。DeepL、Google、Azure 不是這種格式：沒有模型，Azure 還要填區域，放進去只會讓清單更亂。
- 識圖 API、生圖 API 都是「專門做一件事的另一組服務」，各自一區。翻譯 API 是同一類，使用者也比較好找。

「翻譯 API」那區的內容：

| 服務 | 要填的 | 備註 |
|---|---|---|
| 用聊天模型（某組 API 預設） | 從「API 配置」挑一組，建議挑便宜的小模型 | 唯一能好好翻粵語的選擇；可以帶角色語氣 |
| DeepL | Key（Free 或 Pro 自動判斷） | 瀏覽器不能直接呼叫 DeepL（它不開 CORS），要經過你自己的主動消息 2.0 Worker 轉一手；沒設 Worker 就不能選 |
| Google Cloud Translation | API Key | 瀏覽器可以直接呼叫 |
| Azure Translator | Key＋區域 | 瀏覽器可以直接呼叫 |

- 底下有「測試」：翻一句固定的句子給你看。
- Key 跟其他 API 一樣只存在這台裝置，Sore 讀不到，錯誤訊息也照樣過 `scrubSecret`。
- 粵語：DeepL 不支援，Google、Azure 對口語粵語都翻得很硬。說話語言或翻譯成選了粵語時，設定頁會提示改用「聊天模型」那種。

## 4. 定案（Liora，2026-11-15）

四項都照建議：翻譯 API 在系統設置另開一區；設定存在角色卡；這輪做私聊＋雲端（即時對話、主動消息），群聊、電話、見面之後；夾雜給三段可選。

原本列的決定點：

1. 翻譯 API 放哪裡：系統設置另開「翻譯 API」一區（建議），還是併進「API 配置」？
2. 設定存哪裡：
   - 建議存在角色卡上（`CharacterProfile.chatLanguage`），換裝置、雲端都跟著走。
   - 還是維持只存這台裝置？
3. 這次要接到哪些地方：
   - 建議第一輪只做私聊，包含雲端的即時對話和主動消息，不然頁面關著時回來的訊息語言會不對。
   - 群聊、電話、見面之後再接。
4. 夾雜第二語言要不要能調比例？
   - 建議給三段：偶爾冒幾個詞／自然混用（約兩到三成）／兩種差不多。
   - 不給的話就固定「自然混用」。

## 5. 分批（暫定）

- **第 1 批**：
  - 資料欄位與舊設定搬遷。
  - 聊天語言設定頁改版（說話語言、夾雜、翻譯成、展開）。
  - 提示詞（首要語言、夾雜、聊天模型順便翻）。
- **第 2 批**：
  - 系統設置「翻譯 API」（用聊天模型、DeepL 經 Worker、Google、Azure、測試）。
  - AI 回覆改走「先寫再翻」，失敗時補翻。
  - 「我的訊息自動譯出」。
- **第 3 批**：
  - 雲端即時對話、主動消息照說話語言寫。
  - 收件時在本機補譯文。
- 之後：群聊、電話、見面改讀同一份設定，拿掉它們各自記的那份。

## 6. 實況

### 第 1 批（2026-11-15）

- **資料**：`CharacterProfile.chatLanguage`（`types.ts` 的 `ChatLanguageConfig`）。欄位有 `speak`、`mix`、`mixLevel`、`translateTo`、`expanded`。
  - 存在角色本人身上，不跟著線走。
- **純邏輯**在 `utils/chatLanguage.ts`：
  - 語言清單 `CHAT_LANGUAGES`：值是給模型看的名稱，介面顯示短名。
  - `resolveChatLanguage`：夾雜跟說話語言一樣就當沒夾雜。`translating` 的條件是設了「翻譯成」，而且跟說話語言不同或有夾雜。
  - `cleanChatLanguage`：全空就不寫欄位。
  - `buildChatLanguagePrompt`：語言段加上雙語標籤段。雙語標籤格式跟舊版一字不差，只把原文的語言換成說話語言（有夾雜就寫上比例）。
  - 粵語會提醒寫廣東話口語。
- **提示詞**：`chatRequestPayload` 第 4 段改吃 `chatLanguage`，不再吃 `translationConfig`。`Chat.tsx` 傳 `char.chatLanguage`。
  - 雲端兩條路這批還沒傳，所以照舊沒有語言段，第 3 批接。
- **搬遷**：
  - OSContext 載入角色時，把舊的 `chat_translate_*_<charId>` 搬上角色卡（`legacyChatLanguage`），存好才清掉舊鍵。
  - 只搬「消息翻譯」開著的：舊的「選」變說話語言，「譯」變翻譯成（中文→繁中），展開照搬。
  - 舊備份還原回來又寫了舊鍵的話，下次載入會再搬一次。
- **介面**：
  - 聊天設定頁多一區「聊天語言 (LANGUAGE)」（`components/chat/ChatLanguageSettings.tsx`），放在關係和場景之間，按「完成」才存。
  - 最上面一行白話摘要，例如「說英文，夾雜繁中（兩種差不多），翻成繁中給你看」。
  - 原本「翻譯與語音」裡的消息翻譯拿掉，那一組改叫「語音」。
- **統計**：「当前功能启用」多一格「聊天语言」（`翻译+夹杂`／`翻译`／`夹杂`／`指定语言`／`没设`），不報語言名。舊的「开启聊天翻译」事件跟著設定頁一起拿掉了。
- Sore 的知識（`utils/assistant/knowledge.ts`）加了聊天語言這一行。

### 第 2 批（2026-11-15）

- **翻譯 API**（系統設置 → 「翻譯 API」，在「識圖 API」下面；`components/settings/TranslationApiSettings.tsx`）：
  - 存在 `APIConfig.translationApi`（`TranslationApiConfig`），按「保存」才寫。
  - 服務有四家：
    - 聊天模型：網址、Key、模型留空就用主 API，可以從模型預設載入。
    - DeepL。
    - Google（Cloud Translation v2）。
    - Azure（Key＋區域）。
  - 「測試一句」用草稿翻一句固定的英文給你看。
- **呼叫**在 `utils/translateApi.ts` 的 `translateTexts(texts, to, apiConfig)`：
  - 一次送一批句子，回傳的句數要跟送出去的一樣。
  - 各家語言代碼都在 `CODES` 表。表裡查不到（自訂語言，或 DeepL、Google 遇到粵語）就直接說「不支援，換成用聊天模型翻」，不打 API。
  - 錯誤訊息過 `scrubKeys`。
  - 聊天模型那家的請求記在 API 調用記錄（appName 消息、purpose 翻譯）。
- **DeepL 經 Worker**：主動消息 2.0 Worker 新增 `POST /deepl-translate`。
  - 只轉 DeepL，Key 每次由 App 帶來、Worker 不存；跟其它端點同一道共享密鑰。
  - Key 結尾是 `:fx` 打 Free 端點。
  - `/config-check` 多報 `deeplTranslate: true`。
  - `AMSG_BUNDLE_VERSION` 升到 `2026-11-15`，用戶要更新 Worker 才能用 DeepL。
- **角色卡多兩個欄位**：
  - `chatLanguage.translator`：`'chat'` 是聊天模型順便翻（預設），`'api'` 是先寫再翻。
  - `chatLanguage.translateMine`：我的訊息自動譯出。
  - `resolveChatLanguage` 多給 `inlineTranslate`、`postTranslate`、`translateMine`。
  - 提示詞的雙語標籤只在 `inlineTranslate` 時加，`bilingualActive` 也跟著它。
- **先寫再翻**（`utils/chatTranslateRun.ts`）：
  - `useChatAI` 在回覆存好之後，把這一輪新存的 TA 的文字氣泡交給 `translateTexts`，改寫成 `原文\n%%BILINGUAL%%\n譯文`。
  - 不擋這一輪收尾：氣泡先出來，譯文後補。
  - 翻不成的在 `metadata.translationFailed` 記原因，氣泡下面出現「沒翻成，點一下再翻」（`MessageItem` 的 memo 也比這個欄位）。
- **我的訊息自動譯出**（`Chat.tsx` 的 `sendText`）：
  - 純文字訊息送出前翻成說話語言，存的 content 是譯好的那句，你打的原句放在 `metadata.typedOriginal`。
  - 角色只看到譯好的版本；氣泡下面「看原句／看譯文」切換。
  - 翻不成就照原句送，跳一個提示。
  - 沒設翻譯 API 時用主 API 的聊天模型翻。
- **聊天語言設定頁**：有翻譯時多「誰來翻」二選一；有說話語言時多「我的訊息自動譯出」開關。摘要也會寫出「寫完再翻」「你打的字自動翻成…」。
- **統計**：「当前功能启用」多一格「翻译API」（`聊天模型`／`deepl`／`google`／`azure`）。

### 第 3 批（2026-11-16）

雲端一律只照說話語言寫，不帶雙語標籤；有設翻譯的角色收件後在本機補譯文。這樣 Worker 不用懂 `<翻譯>` 標籤，也不怕雲端把一組標籤拆到兩條 push 裡。

- **即時對話**：`useChatAI` 走雲端那一輪，`chatLanguage` 先過 `chatLanguageForCloud`。有翻譯就改成先寫再翻，提示詞裡只有語言段。本地那一輪照舊。
- **主動消息 fire_pack**（`utils/activeMsgClient.ts`）：模板的【重要規則】後面多一段 `buildSpeakingRulesPrompt`，只有說話語言與夾雜。
  - 改聊天語言走 `updateCharacter`，本來就會打髒，雲端會重新打包。
- **收件補譯**（`utils/activeMsgRuntime.ts`）：
  - `applyAssistantPostProcessing` 落庫之後呼叫 `translateCloudReply`，用這條 push 的 `metadata.activeMsg2.messageId` 認出它拆出來的氣泡。這跟 `findInboxArtifacts` 是同一個認法。
  - 不管角色選的是順便翻還是先寫再翻，都會翻。已經是雙語的不重翻。
  - 不擋收尾，翻好或翻不成都會再發一次 `active-msg-progress` 刷畫面。翻不成一樣出「點一下再翻」。
  - 即時對話、主動消息、chat_outbox 補收、延遲回覆交給雲端的那條，都走同一個收件函式。
- **測試**：`utils/chatTranslateRun.test.ts`（真庫：只翻這條 push、選順便翻也補、翻不成標記與重翻、收件接線順序）、`utils/activeMsgClient.test.ts`（模板帶語言段、不帶標籤）。
- **之後**：群聊、電話、見面改讀同一份設定，拿掉它們各自記的翻譯語言。
