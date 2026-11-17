# API 中心與備援鏈

> 狀態：**定案（Liora 2026-11-18）**，還沒動工。附加機制：不改任何一處叫 API 的代碼，只在設定和全局攔截器上做。

## 1. 為什麼改

介面上有三個地方都叫「副 API」，其實是三組不同的設定，散在三個地方填：

| 叫什麼 | 在哪填 | 誰在用 | 現在的回落 |
|---|---|---|---|
| 記憶宮殿的副 API（`memoryPalaceConfig.lightLLM`） | 設置 → 記憶宮殿 | 記憶整理、月度總結、門牌整理（含雲端）、Sore 預設用它、回覆草稿 | 沒配就不跑（不回落主 API） |
| 情緒／意識流 API（角色卡 `emotionConfig.api`） | 聊天設定 → 日程／情緒 | 情緒評估、意識流、日程生成（行事曆一天／一週／批量／自動，雲端自動生成的憑據也是這一行）、已讀不回判定 | 角色沒配 → 全局聊天 API |
| 主動消息 2.0 的「使用副 API」（角色 `activeMsg2Config.secondaryApi`） | 主動消息設定 | 主動消息到點生成 | 角色沒開 → 全局聊天 API |

Liora 的用法：記憶那組用便宜的（笨一點沒關係）、情緒／日程用細膩的、主動消息介於中間。多數用戶用中轉站，常掛；掛了要一個一個角色點進去改，太麻煩。

## 2. 定案

- **API 中心**：系統設置裡一個段，主 API 照舊，底下三個**全局副槽**各自從「我的預設」選：**記憶副 API**（就是 `lightLLM`，搬 UI 不搬資料）、**情緒／日程 API**（新增全局值）、**主動消息單獨 API**（新增全局值）。角色身上原本那兩處設定留著當**覆蓋**：角色自己設了 > 全局槽 > 主 API。
- **備援鏈**：每個槽（主 API 和三個副槽）各排一條，從預設挑 3～5 個、拖順序。請求失敗就換下一個再發一次；掛掉的記冷卻，這段時間直接跳過。做在全局 fetch 攔截器裡（OSContext 的 `patchedFetch`，它已經認得 `/chat/completions` 和 `__sullyMeta`），**那 175 個叫 API 的地方一個都不改**。
- **什麼算掛**：網路錯、逾時、5xx、429、408。**401／403 不算**（那是 Key 錯，換別家只是拿別人的額度兜一個填錯的 Key），4xx 其他也不算（多半是請求體的問題，換家一樣錯）。
- **串流**：HTTP 狀態就錯的能換；已經開始吐字再斷的不重來（會重複字），照舊報錯。
- **換了要說**：API 調用記錄標「備援：A → B」；系統日誌一條；同一個槽同一天第一次換家時 toast 一句「×× 掛了，先用 ××」。
- **雲端不做**（Liora 定的）：主動消息 2.0 到點、即時對話、後台任務在 worker 上拿憑據表那一行直接叫 LLM，是上游庫的事。能做的只有「上雲的那一行永遠是本機目前活著的那個」：本機換家之後把用到那個槽的角色打髒，憑據行重傳。介面上**提醒兩處**：備援鏈設定底下一行、主動消息 2.0 設定頁 API 那段。
- model 跟著預設走：換 API 時 URL、Key、model 一起換，各家模型名不一樣，這就是「排預設」而不是「排 URL」的理由。

## 3. 資料

```ts
/** 一個槽的備援鏈：預設 id 照順序 */
interface ApiFailoverChain {
  /** 預設 id，第一個是主用的；空＝沒有備援 */
  presetIds: string[];
}

/** 系統設置 → API 中心（存 settings，跟 apiPresets 一起） */
interface ApiCenterConfig {
  /** 全局情緒／日程 API（角色沒設就用它；沒設＝主 API） */
  meter?: APIConfig;
  /** 全局主動消息單獨 API（角色沒開就用它；沒設＝主 API） */
  amsg?: APIConfig;
  /** 記憶那組不另存：就是 memoryPalaceConfig.lightLLM */
  chains?: { chat?: ApiFailoverChain; memory?: ApiFailoverChain; meter?: ApiFailoverChain; amsg?: ApiFailoverChain };
}
```

- 冷卻只在記憶體（`utils/apiFailover.ts` 模組級 Map：`${baseUrl}|${apiKey}` → 冷卻到幾點），重開頁面歸零。預設 5 分鐘。
- 攔截器認槽的方法：請求的 `baseUrl`＋`Authorization` 對到哪個槽的主用預設（或鏈裡任何一個），就用那條鏈。對不到（角色自己填的、別處硬寫的）就照舊不管。
- 重發一次就是一次：鏈裡每個最多試一輪，全掛才把最後一個錯誤拋回去。

## 4. 介面

- 設置 → API 中心：主 API 那格照舊；底下三格副槽，每格「選預設 ▾」＋「備援鏈 ▸」。備援鏈開全螢幕頁（不要半窗）：勾預設、拖順序、每個旁邊顯示「活著／冷卻中 n 分」。底下一行：「雲端（主動消息 2.0 到點、即時對話）用的是本機目前活著的這家，不會自己換下一家。」
- 聊天設定 → 日程／情緒 → 副 API 配置：標題改「情緒／日程 API（角色自己的，不設就跟系統設置）」，加一個「跟系統設置」按鈕清掉角色自己那份。
- 主動消息設定 → 使用副 API：同樣加「跟系統設置」，API 那段底下加雲端提醒。
- 記憶宮殿設定頁裡那格留著，跟 API 中心是同一份資料。

## 5. 分批

1. **API 中心**：三個全局槽＋從預設選＋角色級「跟系統設置」；`resolveCharacterMeterApi`、主動消息的 `resolveApiConfig`／`buildCharChatCredRow` 多一層全局槽；記憶那格搬 UI。
2. **備援鏈**：`utils/apiFailover.ts`（純判斷：什麼算掛、挑下一個、冷卻）＋攔截器接線＋備援鏈全螢幕頁＋調用記錄標記＋兩處雲端提醒＋換家後打髒重傳憑據。

每批做完給 Liora 看一次再合。

## 6. 實況

### 第 1 批（2026-11-18 做完）：API 中心

- `APIConfig` 多兩格：`meterApi`（情緒／日程）、`amsgApi`（主動消息單獨），形狀是 `SecondaryApi`；記憶那格就是 `memoryPalaceConfig.lightLLM`。存法照舊跟 `apiConfig` 走（localStorage `os_api_config`）。
- 解析只在 `utils/apiCenter.ts` 寫一次（`globalMeterApi`／`globalAmsgApi`／`isUsableSecondaryApi`／`describeMeterApiSource`），接到三處：`resolveCharacterMeterApi`（角色自己的 > 全局情緒槽 > 主 API）、主動消息 2.0 的 `resolveApiConfig` 與憑據行 `buildCharChatCredRow`、1.0 主動消息（OSContext 到點那段；回覆照舊走對話模型）、雲端情緒憑據行 `buildCharEmotionCredRow`（角色自己的 > 全局情緒槽 > 主 API）。
- 介面：系統設置多一段「副 API 中心」（`components/settings/ApiCenterPanel.tsx`）：三格各自從「我的預設」選或手填、測連線、清掉；標籤寫現在是哪個預設。角色的「日程／情緒」面板改名「角色自己的情緒／日程 API」、寫出現在用的是哪一層、多「跟系統設置」把角色那份清掉；主動消息 1.0／2.0 設定頁的回落說明改成三層。Sore 的知識更新。
- 沒做：備援鏈（第 2 批）。
