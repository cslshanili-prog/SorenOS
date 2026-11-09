# 見面 · 觀測協議 OBSERVE

> 給「見面」(DateApp) 的一塊**觀測面板**：開啟後讓模型在每則回覆正文最前面吐一段
> 結構化觀測（時間／地點／狀態／細節＋自訂維度），前端剝出來顯示成觀測卡片。
> 改觀測相關邏輯（提示詞注入／解析容錯／卡片渲染）前必讀。

## 一句話

替代土味狀態欄，讓用戶**全方位觀察角色此刻的狀態**。開關跟著角色走，**只在內建規則下生效**。

## 來龍去脈

- 最早做在立繪（GAL）模式上，2026-11 見面改版（#113）跟 GAL／立繪一起拿掉了
- 後來發現只用內建規則的人還想要它，改回成開關：解析、五種樣式、自訂維度、設定頁原樣搬回，
  提示詞改接散文格式；程式從 `datePrompts.ts` 搬到獨立的 `utils/dateObserve.ts`
- **只限內建規則**：匯入的預設通常自帶狀態欄或裝飾卡片，再疊一個會重複、格式也會打架。
  角色選了自訂預設時設定頁的開關灰掉、寫一句說明，設定照樣留著，換回內建規則就生效
  （`isObserveActive(char, usingCustomPreset)`）。提示詞那頭天然只在內建：觀測塊只接在
  `DatePrompts.buildSessionPayload`／`buildPeekPayload`，預設模式走 `buildMeetingPresetPayload`，不帶
- 立繪模式的懸浮 HUD（`variant='hud'`）和見面選單的快捷開關沒搬回：畫面只剩閱讀模式，
  只用 `variant='card'`；開關只在見面設定

## 資料模型（`types.ts`）

- `DateObservation`：`{ time?, place?, state?, detail?, extra? }`，前四維全可缺省（模型漏寫不崩）；
  `extra?: Record<id,string>` 存用戶**追加的自訂維度**的值（按 `DateObserveCustomField.id`）。
- `CharacterProfile.dateObserve?: DateObserveConfig`：跟著角色的配置（開關＋樣式＋欄位自訂）。
  #113 只拿掉程式、沒清資料，所以以前的設定原樣還在。
  - `enabled?: boolean`：總開關。
  - `style?: DateObserveStyleId`：卡片樣式（`hologram` 預設／`ink`／`neon`／`crystal`／`terminal`）。
  - `fields?`：四個維度的自訂（`{ label?, hint?, enabled? }`）——`label` 只改顯示（**不參與解析**），
    `hint` 改「這一格讓 AI 生成什麼」，`enabled:false` 則不注入也不顯示。
  - `custom?: DateObserveCustomField[]`：**追加的自訂維度**（最多 6 個）。自訂維度的 `label`
    **同時是線格式欄位名和顯示標籤**，所以 `extractObservation` 必須收到 `custom` 才能解析。

## 線格式（wire format）

```
⟦OBSERVE⟧
時間｜傍晚六點過，天剛擦黑
地點｜便利店門口的塑料凳上
狀態｜有點疲憊，但見到你眼神亮了一下
細節｜指尖無意識地敲著關東煮的紙杯
⟦/OBSERVE⟧
她抬眼看你。
「你來啦。」
```

定界符故意用冷僻的 `⟦⟧`，避免和台詞引號、英文語氣標籤 `[softly]` 撞車。
提示詞接在散文塊最後（場景上下文之後），說明觀測塊不受「格式」那幾條約束；開場感知也帶。

## 解析魯棒性（重點）

LLM **一定會**偶爾掉格式，所以 `extractObservation` 分兩層。改這裡務必跑 `utils/dateObserve.test.ts`
裡的「掉格式容錯」一組。

**第 1 層 · 嚴格（永遠開，不會誤傷正文）**
成對定界塊。容忍：括號風格 `⟦⟧【】〔〕「」『』[]()<>`、關鍵字 `OBSERVE`/`觀測`/`觀測協議`、
大小寫、定界符內空格。塊內欄位行容忍 markdown 列表符／加粗／中英 key／全半角豎線 `｜|`／
中英冒號 `：:`。有定界符＝明確意圖，哪怕只解析出 1 個欄位也認。

**第 2 層 · 回退（lenient，只在觀測生效時開）**
處理「丟了閉合標記／換了標記／完全沒標記，只在開頭堆欄位行」。從文字**開頭**連續掃欄位行，
遇到第一行「非欄位、非標記、非空」的內容就停。防誤吞：**至少命中 2 個不同維度**才認、
**只掃開頭連續段**。

**不管開不開都剝**：顯示時一律先跑 `extractObservation`（沒生效時 `lenient: false`，只走嚴格層），
所以以前開著觀測寫的舊訊息、或換成自訂預設之後回看，正文都不會露出 `⟦OBSERVE⟧` 原文。
卡片只在生效時才顯示。語音是照顯示出來的台詞行念的，觀測塊不會被念出來。

落庫的 `message.content` **保留**原始觀測塊；渲染時才即時剝離，回看時能重新解析出卡片，不另外存。
正在生成時的「正在寫」那張卡片顯示的是原始輸出，觀測塊在那裡會露出來，收完就換成正式那則。

## 顯示（`ObserveHUD.tsx`，`variant='card'`）

- 閱讀模式每則回覆的標籤列下面一張（`.date-observe-card` 是畫面美化的 class 鉤子）；
  還沒對話時的開場、感知頁也有
- 只渲染存在的欄位；`hasObservation` 為假時不掛載

## 關鍵檔案

| 檔案 | 職責 |
|------|------|
| `utils/dateObserve.ts` | `buildObserveBlock`（提示詞）、`extractObservation`／`stripObservation`／`hasObservation`（解析）、`isObserveOn`／`isObserveActive`、`resolveObserveFields`、`OBSERVE_DIMENSIONS` |
| `utils/datePrompts.ts` | 內建模式的散文塊和開場感知在開著時接上 `buildObserveBlock` |
| `components/date/ObserveHUD.tsx` | 觀測卡片，五種樣式（`THEMES`）、`OBSERVE_STYLES` 選擇器資料 |
| `components/date/ObserveSettings.tsx` | 設定：開關＋樣式（即時預覽）＋每維度自訂＋一鍵重置；`usingCustomPreset` 時灰掉 |
| `components/date/DateSession.tsx`、`apps/DateApp.tsx`（感知頁） | 剝觀測塊、掛卡片 |
| `utils/dateObserve.test.ts` | 注入＋解析＋掉格式容錯＋只限內建規則 |

統計沿用原本的兩個屬性：`观测协议`（有沒有角色開）、`观测HUD样式`（見 `docs/analytics.md`）。
