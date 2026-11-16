# 你的聲音：身份卡音色＋私聊發語音條

> 狀態：三批都做完（2026-11-16）。文末「實況」是落地的樣子。

## 想做的事

1. **身份卡編輯頁加一塊「我的聲音」**：跟角色同一套音色欄位（MiniMax voice_id／模型、魚聲 reference_id、ElevenLabs Voice ID、語速、拉取可用音色、試聽），只是存的是「你」的聲音。
2. **私聊裡你也能發語音條**：打字，或對著麥克風說話、辨識成文字（可以先改再送），送出去是一條語音條。用你那張卡的聲音念出來，可以播、可以下載、可以點「查看語音內容」看文字，長得跟角色的語音條一樣，只是在你這邊。

## 現況（摸過的）

- 角色的音色在 `CharacterProfile.voiceProfile`（`types.ts`），TTS 一律走 `utils/ttsRouter.ts` 的 `synthesizeSpeechDetailed(text, char, apiConfig, opts)`，各家只讀 `char.voiceProfile`（加上全域 Key／模型）。`canSynthesizeSpeech(char, apiConfig)` 判斷這家有沒有配齊。
- 角色的音色 UI 是直接寫在 `apps/Character.tsx` 裡的一大塊（約 1830–1990 行），不是元件。
- 聊天語音條：`apps/Chat.tsx` 的 `voiceDataMap`（訊息 id → 音檔＋文字），合成後存 asset `voice_msg_${id}`，離開再進來照樣在。`MessageItem` 只在 `!isUser` 且內容有 `<語音>` 標籤時畫語音條。
- 說話辨識已經有 `utils/speechToText.ts`（`startStt`／`isSttSupported`，網頁 SpeechRecognition 或 Capacitor 外掛），電話裡在用。
- `type: 'voice'` 只有「從別的 App 匯入」會產生，歷史與記憶已經認它（`[語音轉寫] …`）。

## 設計

### 音色存哪

- `UserPersona.voiceProfile` 與 `UserProfile.voiceProfile`（真實身份），結構直接用 `CharacterProfile['voiceProfile']`。同一世界裡不同身份卡是不同的人，聲音也各管各的。
- 私聊時用**這條線的那張卡**（`utils/chatLine.ts` 已經知道這條線是哪張卡），沒設音色就沒有真聲音。
- 合成時把角色換成「借你音色的殼」：`{ ...char, voiceProfile: 你的 voiceProfile }` 丟進同一個 `synthesizeSpeechDetailed`，三家 TTS 一行都不用改。

### 音色 UI

- 把 `Character.tsx` 那一塊抽成 `components/voice/VoiceProfileFields.tsx`（值＋onChange，拉取音色、試聽都在裡面），角色頁和身份卡頁一起用，角色頁畫面不變。
- 「捏聲音」（VoiceDesigner）綁的是角色，這次身份卡先不接。

### 發語音條

- 訊息照舊是 `type: 'text'`，內容就是你說的那句純文字，`metadata.userVoice = { via: 'typed' | 'spoken' }`。不塞 `<語音>` 標籤：標籤是角色的輸出格式，混進你的訊息會被模型學走。
- 送出當下就用你的聲音合成，存同一個 `voice_msg_${id}`；播放、下載、收藏語音都走現成那套。
- 沒配音色或合成失敗：照樣是語音條（跟角色沒配音色時一樣，可以看文字），提醒一次，點一下重試。
- 聊天語言開了「我的訊息自動譯出」：念**譯好、送出去的那句**，原句照舊收在 `typedOriginal`。
- 角色看到的歷史：`[語音] 內容`（私聊歷史、雲端、記憶宮殿都認同一個寫法）。

### 輸入

- 輸入欄多一個麥克風鈕，切到「語音條模式」：
  - 輸入框照樣能打字，送出鈕變成「發語音條」的樣子。
  - 旁邊一顆「說話」鈕，按一下開始辨識、再按一下停，辨識出來的字放進輸入框，可以改了再送。
  - 再點一次麥克風回到一般打字。
- 辨識語言預設中文（台灣），在語音條模式裡可以換，記在本機。

## 這次不做

- 送真的錄音（原聲）：這次只做「辨識成文字＋你的音色念」。
- 群聊發語音條。
- 身份卡的「捏聲音」。

## 分批

1. 資料欄位＋抽出音色元件＋身份卡「我的聲音」
2. 私聊語音條：送出、合成、氣泡、歷史寫法、雲端
3. 輸入欄的語音條模式＋說話辨識

## 實況

- 型別：`UserPersona.voiceProfile`、`UserProfile.voiceProfile`（`types.ts`）；`utils/userPersona.ts` 套用身份卡時連 voiceProfile 一起換，卡沒設就是 undefined。
- 音色欄位：`components/voice/VoiceProfileFields.tsx`（從 `apps/Character.tsx` 原樣抽出來；角色頁多傳「捏聲音」，身份卡多一顆照目前服務商「試聽」）。身份卡編輯頁存的時候，一家音色都沒填就不留空殼。
- 純邏輯：`utils/userVoice.ts`（`isUserVoiceMessage`、`userVoiceMeta`、`userVoiceShell`、`formatUserVoiceContent`、說話辨識語言清單與記憶），測試 `utils/userVoice.test.ts`。
- 送出：`apps/Chat.tsx` 的 `sendText` 收到 `metadata.userVoice` 就跳過口令（麥請求、瑞一杯）和連結卡片；存好當下 `synthUserVoice` 用你的聲音合成、存 `voice_msg_${id}`，不自動播。開了「我的訊息自動譯出」念譯好的那句，轉文字裡附原句。點沒聲音的語音條＝重新合成並播放；長按「轉換語音」也走同一個函式。
- 氣泡：`components/chat/MessageItem.tsx` 的 `isUserVoiceMsg`，整則畫成你這邊的語音條（不畫文字氣泡），語音條沒單獨設色時借你氣泡的底色字色；殼多一個 class `sully-voice-bar-user`。
- 歷史：`ChatPrompts.buildMessageHistory`（本機、即時對話、主動消息 fire_pack 都用它）和 `normalizeMessageContent`（記憶宮殿、歸檔）都寫成 `[語音] 內容`。
- 輸入欄：`components/chat/ChatInputArea.tsx` 給了 `onSendVoice` 才有麥克風鈕（群聊沒給）。點一下進語音條模式（輸入欄上方多一條：說明、辨識語言、離開），再點麥克風開始／停止說話辨識，辨識的字接在已打的字後面、可以改；送出鈕變成波形。這條放在輸入欄外面，跟表情聯想、自動回覆同一層，不動社區 CSS 的 nth-child。
- 埋點：打开语音条模式、发送语音条（`方式`）、身份卡选了音色。
- 電話：`apps/CallApp.tsx` 的說話辨識原本寫死 `zh-CN`（出簡體），改讀同一個辨識語言設定，輸入框下面多一個「辨識：…」可以換；`utils/speechToText.ts` 沒給語言時也退回 `zh-TW`。
