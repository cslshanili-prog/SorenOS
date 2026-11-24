# 角色名片（點角色頭像）

> 狀態：**做完（2026-11-24，Liora 點頭照建議做）**。對齊上游 SullyOS 的 `ChatCharacterProfile`（2026-11-19），但照我們的規矩改過。

## 1. 做什麼

私聊、群聊裡點角色的頭像，跳出一張**置中的小卡**（不是半窗，也不是整頁）：瞄一眼角色現在的心聲和狀態，看完就關。

## 2. 跟上游的差別

| | 上游 | 我們 |
|---|---|---|
| 樣子 | 置中卡，左邊直排三個分頁（當前／設定／日程） | 置中卡，上面兩個分頁（現在／今天） |
| 設定 | 整個角色編輯頁塞進 352px 小卡 | **不塞**：底下按鈕跳去我們的全螢幕頁 |
| 名字下面 | 「備註」（從描述截） | 別名／身份／簡介（`charSubtitle`） |
| 情緒 | 全部 buff 照列 | 只列還沒褪掉的（`liveBuffs`），條是此刻還剩多少（`buffRemaining`） |
| 心聲 | 只有日程＋情緒都開才顯示 | 一直有那一格；沒有時寫為什麼沒有（情緒沒開／還沒聊） |
| 群聊 | 沒有 | 有：點成員頭像一樣開，按鈕「聊天設定」換成「去私聊」 |
| 往上拉打開 | 有（聊到最底再往上拉） | **不做**（跟一般捲動打架） |
| 白框 CSS | 有 `chatProfileAppearance` | 先不接；元素都掛了 `sully-char-card-*` 鉤子，之後接進裝扮 App |

## 3. 內容

- **頭**：頭像、名字、`charSubtitle`、世界 · 分組、配角小標。
- **現在**：
  - 心聲：`getLastInnerState`（本機評估、雲端回程都會存），沒有就用日程這一格的 `innerThought`。卡開著時有新的會跟著換（本機評估發 `soren-innerstate-cached`，雲端回程發 `emotion-innerstate-updated`，兩個都聽）。
  - 此刻：角色那邊的時間（有自訂時區才標時區）、日程這一格在做什麼、在哪。
  - 情緒：還沒褪掉的 buff，點開看說明；底下一行「整體心情」（`buffInjection`）。
- **今天**：今天的日程時段，標出現在這格，過去的淡掉。
- **按鈕**：角色設定、聊天設定（私聊）／去私聊（群聊）、行事曆（停在「TA 的」）、記憶宮殿（直接進他的宮殿）。

## 4. 跳出去再回來

`utils/appLaunch.ts`：
- `calendarLaunch`／`memoryPalaceLaunch`：一次性字條，對方 App 打開時讀（跟 `characterLaunch` 同一個模式）。角色設定用 `characterLaunch` 多一個 `backToCaller`：編輯頁按「返回」直接回聊天，不先繞到清單，按鈕字也從「列表」改成「返回」。
- `appReturn`：開 App 前登記「它關掉時回哪裡」；`OSContext.closeApp` 先問它，沒有才回桌面。只認登記的那個 App，中途 `openApp` 去別的就作廢。私聊回到同一個角色，群聊回到同一個群（`openGroupChat`）。
- 記憶宮殿：從名片進來直接進宮殿，宮殿頁的「← 返回」回聊天；那個角色還沒開記憶宮殿時照舊停在說明頁，從選人頁關掉也會回聊天。

## 5. 檔案

- `components/chat/CharacterCard.tsx`：卡片本身，掛到 body。
- `components/chat/MessageItem.tsx`：`onOpenCharacterCard`，角色頭像（含「每輪頭像」那一份）變成按鈕；多選時不開。
- `apps/Chat.tsx`、`apps/GroupChat.tsx`：開卡、回來的路。群裡只有真角色（不是舊 NPC）的頭像能點。
- 埋點：`打开角色名片`（from：private / group）。
