# 見面 · 觀測協議 OBSERVE

> 給「見面」(DateApp) 加的一塊**全息觀測面板**：開啟後讓 LLM 在每條回覆正文最前面吐一段
> 結構化觀測（時間 / 地點 / 狀態 / 細節），前端剝出來既留在記錄裡、又渲染成可獨立查看的 HUD。
> 改觀測相關邏輯（提示詞注入 / 解析容錯 / HUD 渲染）前必讀。

## 一句話

替代土味狀態欄，做成中二感的全息 HUD，讓用戶**全方位觀察角色此刻的狀態**。開關是 per-character 的。

## 數據模型（`types.ts`）

- `DateObservation`：`{ time?, place?, state?, detail?, extra? }`，前四維全可缺省（模型漏寫不崩）；
  `extra?: Record<id,string>` 存用戶**追加的自定義維度**的值（按 `DateObserveCustomField.id`）。
- `CharacterProfile.dateObserve?: DateObserveConfig`：per-character 配置（開關 + 樣式 + 字段自定義）。
  - `enabled?: boolean`：總開關。
  - `style?: DateObserveStyleId`：HUD 視覺樣式（`hologram` 默認 / `ink` / `neon` / `crystal` / `terminal`）。
  - `fields?: Partial<Record<keyof DateObservation, DateObserveFieldConfig>>`：四個維度的自定義。
    - `DateObserveFieldConfig`：`{ label?, hint?, enabled? }`——`label` 只改 HUD 展示標籤（**不參與解析**），
      `hint` 改「這一格讓 AI 生成什麼」，`enabled:false` 則該維度既不注入提示、HUD 也不渲染。任一項留空回落默認。
    - `custom?: DateObserveCustomField[]`：**追加的自定義維度**（最多 6 個），`{ id, label, hint?, enabled? }`。
      與默認維度不同，自定義維度的 `label` **同時是線格式字段名和 HUD 標籤**——解析時按 label 精確匹配回該維度，
      所以 `extractObservation` 必須收到 `custom` 才能解析（DateSession 傳 `char.dateObserve?.custom`）。空 label 或禁用的不注入/不解析。
- `DateState.observation?: DateObservation`：當前批次的觀測，存進 savedDateState，恢復會話時回填 HUD。

## 樣式與自定義（`datePrompts.ts` + `ObserveHUD.tsx` + `ObserveSettings.tsx`）

- **默認維度單一來源**：`OBSERVE_DIMENSIONS`（`datePrompts.ts`）固定四項 `時間/地點/狀態/細節`，
  其 `label` 同時是**線格式字段名**——`buildObserveBlock` 注入時永遠用它，所以用戶改 `label` 不會讓
  `extractObservation` 失配。`resolveObserveFields(char)` 合併默認 + 自定義並過濾禁用項，HUD 與提示詞共用。
- **五種樣式**：`ObserveHUD.tsx` 的 `THEMES` 表，每個主題給一組類名/內聯樣式，渲染走同一條路徑；
  新增樣式 = 往 `THEMES` 加一項 + `OBSERVE_STYLES`（設置面板選擇器用，含名稱/簡介/預覽色塊）加一項。
- **設置入口**：`ObserveSettings.tsx`（嵌在 DateSettings）——總開關、樣式選擇（帶實時預覽）、
  每個維度的啟用開關 + 顯示標籤 + 生成提示、「一鍵重置」（清空 `style` + `fields` 回默認，保留 `enabled`）。

## 數據流

```
開關 ON
  └─ datePrompts.buildObserveBlock 注入提示詞（session 的 VN 塊末尾 + peek 指令）
       └─ LLM 在回覆最前面輸出 ⟦OBSERVE⟧…⟦/OBSERVE⟧ 塊 + 正常 VN 正文
            └─ DateSession 收到回覆 → extractObservation(text, { lenient })
                 ├─ observation → setObservation → ObserveHUD（獨立查看）
                 └─ rest（剝掉觀測塊的正文）→ parseDialogue → 立繪/台詞
```

落庫的 `message.content` **保留**原始觀測塊（它是「正文的一部分」）；渲染時才用 `extractObservation`
即時剝離，所以歷史記錄、閱讀模式回看都能重新解析出 HUD，不依賴額外存儲。

## 關鍵文件

| 文件 | 職責 |
|------|------|
| `utils/datePrompts.ts` | `buildObserveBlock`（提示詞）、`extractObservation`/`stripObservation`/`hasObservation`（解析）、`OBSERVE_OPEN`/`OBSERVE_CLOSE` |
| `components/date/ObserveHUD.tsx` | 觀測面板組件，`variant: 'hud' \| 'card'`、`THEMES` 五樣式、`OBSERVE_STYLES` 選擇器元數據 |
| `components/date/ObserveSettings.tsx` | 設置面板：開關 + 樣式選擇（實時預覽）+ 每維度自定義 + 一鍵重置 |
| `components/date/DateSession.tsx` | 調 extractObservation、驅動 HUD、持久化、菜單快捷開關（傳 `config={char.dateObserve}` 給 HUD） |
| `components/date/DateSettings.tsx` | 渲染 `<ObserveSettings>` |
| `utils/datePrompts.test.ts` | 注入 + 解析 + 掉格式容錯測試 |

## 線格式（wire format）

模型被要求逐字輸出：

```
⟦OBSERVE⟧
時間｜傍晚六點過，天剛擦黑
地點｜便利店門口的塑料凳上
狀態｜有點疲憊，但見到你眼神亮了一下
細節｜指尖無意識地敲著關東煮的紙杯
⟦/OBSERVE⟧
[normal] 抬眼看你。
[happy] "你來啦。"
```

定界符故意用冷僻的 `⟦⟧`，避免和 `[emotion]` 立繪標籤、台詞引號撞車。

## 解析魯棒性（重點）

LLM **一定會**偶爾掉格式，所以 `extractObservation` 分兩層。改這裡務必跑 `datePrompts.test.ts`
裡的「掉格式容錯」一組。

**第 1 層 · 嚴格（永遠開，不會誤傷正文）**
成對定界塊。容忍：括號風格 `⟦⟧【】〔〕「」『』[]()<>`、關鍵字 `OBSERVE`/`觀測`/`觀測協議`、
大小寫、定界符內空格。塊內字段行容忍 markdown 列表符 / 加粗 / 中英 key / 全半角豎線 `｜|` /
中英冒號 `：:`。有定界符 = 明確意圖，哪怕只解析出 1 個字段也認。

**第 2 層 · 回退（lenient，僅開關打開時啟用）**
處理「丟了閉合標記 / 換了標記 / 完全沒標記，只在開頭堆字段行」。從文本**開頭**連續掃字段行，
遇到第一行「非字段、非標記、非空」的內容（正文 / 台詞 / `[emotion]` 行）就停。

防誤吞的兩道閘：
1. **至少命中 2 個不同維度**才認（正文裡偶發一句"狀態：…"不會被當觀測）。
2. **只掃開頭連續段**（`maxScan` 限制 + 遇正文即停），正文中部出現 field 樣式旁白不受影響。

因為回退層有誤吞風險，它由調用方按 `observeEnabled` 傳 `{ lenient }` 控制——開關關閉、或歷史
遺留消息，都不會走回退層。

**兜底**：兩層都沒解析出有效觀測時，`observation = null`、`rest = 原文`，HUD 自動隱藏、正文照常顯示，
對話流程不受影響。

## HUD 渲染（`ObserveHUD.tsx`）

- 視覺：暗色玻璃 + 青紫漸變描邊（內聯 style 實現 border + glow）+ 四角科技括號 + 頂部掃描線 + 脈衝點。
- `variant='hud'`：立繪模式左上角懸浮，可摺疊（▾）、可放大（⛶）成全屏獨立查看面板。
- `variant='card'`：閱讀模式內嵌在每條回覆正文上方，peek 開場也用這個。
- 只渲染存在的字段；`hasObservation` 為假時上層直接不掛載。
- 面板根節點帶 `.control-panel` 類 + `stopPropagation`，避免點 HUD 時誤觸發推進對話 /
  收菜單（見 DateSession `handleScreenClick`）。

## 開關入口（兩處，都寫 `char.dateObserve.enabled`）

- 見面菜單的「觀測 · 開/關」快捷鈕（即點即用，像語音開關）。
- 設置面板「觀測協議 · OBSERVE」section。

> 即時生效：system prompt 每次請求重建，存上就影響**下一條**回覆（已生成的回覆不會追溯補觀測）。
