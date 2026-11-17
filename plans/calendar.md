# 行事曆：身份卡和角色的日程、待辦、旅行，一個 App 看全

> 狀態：**定案（Liora 2026-11-17）**，還沒動工。App 叫「行事曆」（Liora 定的）。取代「時光契約」（`apps/ScheduleApp.tsx`），角色的日程表（`DailySchedule`）不搬、行事曆讀它來顯示。時間怎麼算一律照 [`plans/time-system.md`](./time-system.md)（第 4 批「日曆顯示」就是這份）。

## 1. 為什麼改

現在三塊各管各的：

| 現有 | 管什麼 | 問題 |
|---|---|---|
| 日程表（`DailySchedule`，`utils/dailySchedule.ts`、`scheduleGenerator.ts`、`scheduleInjection.ts`） | 角色的一天：時段、內心獨白、意識流、小劇場；注入聊天、桌面組件、小小窩；角色在聊天裡能改；主動消息到點挑時段 | 只有「今天」、進聊天才補生成、沒提示詞欄位、看不出哪段跟誰有關 |
| 時光契約（`apps/ScheduleApp.tsx`） | 用戶待辦（有監督角色＋語氣）、紀念日（角色記得、每年提）、三套皮膚 | 跟日程表不在一起；用戶自己沒有日程 |
| 沒有 | 用戶身份卡的日程、旅行／出差、跨角色的關聯 | |

## 2. 定案

- **一個 App「行事曆」**取代時光契約，三個分頁：**月曆／我的／TA 的**。皮膚不留（Liora：不留），一套風格。影集不做：見面「拍下這一刻」的照片在資料庫裡，行事曆不另收。
- **日程表不搬。** 角色的一天還是 `DailySchedule`，整條注入鏈（聊天、桌面、小小窩、主動消息）不動；行事曆讀它顯示，生成入口搬進行事曆。
- **兩層資料**：
  - **生活流**＝現有的 `DailySchedule`（AI 生成、角色自己的一天）。`ScheduleSlot` 加 `participants?: Participant[]`，生成時讓模型標「這段跟誰一起」，顯示才有頭像。
  - **約定層**＝新的 `CalendarEvent`：你手動加的、或你跟某人約好的事。待辦是沒有時段、只有截止日的約定；紀念日是每年重複的全天約定。生成某人某天的生活流時，把當天跟他有關的約定餵進提示詞，他會把那個約排進自己的一天。
- **「我的」**預設顯示主線那張身份卡，可以切換看別張卡（Liora：可切換）。身份卡的日程可以自己加，也可以讓 AI 照這張卡的人設生成（同一個生成器）。
- **時間顯示**照 `plans/time-system.md`：每條寫這個人當地時間，旁邊「你 19:42」照身份卡的所在地算；架空世界的日期照曆法寫；月曆的「今天」照身份卡的時區。
- **旅行**是獨立一層（`Trip`），角色和身份卡都能排：目的地（城市打字＋時區從清單選，Liora：可以）、起訖日、類型（出差／旅行／其他）、備註。期間：時區暫時換成目的地（解析順序變成 **旅行 > 世界 > 角色**）、生成那幾天的生活流時提示詞帶「出行中，在杭州」、天氣跟目的地。
- **角色督促待辦**不留（Liora：不需要）。待辦搬過來只剩標題、截止日、完成；`Task.supervisorId`／`tone` 丟掉。
- **角色自己的待辦，跟日程一條閉環**（Liora：要做）：
  1. 進來：聊天裡角色提到要做什麼 → 標籤 `[[TODO|標題|截止日]]` 落成他的待辦（跟角色改日程的標籤同一條路：解析是零依賴葉子，前台和主動消息 worker 都認）；生成一週日程時模型也可以順手列幾條（來源 AI）；你也能手動加。
  2. 排進去：生成某天日程時，把這個人沒做完的待辦餵進提示詞，讓他排進某個時段，那個時段記 `todoId`，顯示帶待辦圖示。
  3. 勾掉：三條路都通——你手動勾；生成下一天時模型順便回「這幾條做完了」自動勾掉；聊天裡角色說做完了用 `[[TODO_DONE|標題]]` 自己勾。AI 勾的記 `doneBy: 'ai'`，你隨時能取消。
  身份卡一樣：自己加或 AI 照人設列，生成你的日程時排進去。
- **生成**：一天或一週（一週＝一次請求出 7 天大綱、每天的時段分開補，Liora：照建議）；每角色一份「行程提示詞」存角色卡；批量（所有開了日程的角色一次）；「提早一天生成明天的」自動生成，頁面開著時本機排，頁面關著走主動消息 2.0 的後台任務（`plans/amsg2-expansion.md`），放最後一批。

## 3. 資料

```ts
/** 誰的、跟誰：身份卡（personaKey）、角色、配角 */
interface Participant { kind: 'persona' | 'char' | 'npc'; id: string }

/** 約定層：手動加的、約好的、待辦、紀念日 */
interface CalendarEvent {
  id: string;
  owner: Participant;                 // 誰的日曆上
  title: string;
  /** 當地牆上時間 'YYYY-MM-DDTHH:mm'；allDay 只看日期 */
  start: string; end?: string; allDay?: boolean;
  location?: string;
  participants?: Participant[];       // 跟誰一起（顯示頭像；生成對方那天時餵進去）
  kind: 'event' | 'todo' | 'anniversary';
  done?: boolean; completedAt?: number;          // todo
  doneBy?: 'user' | 'ai';                        // todo：誰勾的（AI 勾的你取消得掉）
  repeat?: 'yearly';                              // anniversary
  charRemembers?: boolean;                        // anniversary：照舊注入 utils/anniversary.ts
  note?: string;
  source: 'user' | 'ai' | 'char';     // 誰加的：你、AI 生成、角色在聊天裡改的
  createdAt: number; updatedAt: number;
}

/** 旅行／出差 */
interface Trip {
  id: string;
  owner: Participant;
  destination: string;                // 城市，打字（天氣用它查）
  timezone?: string;                  // IANA，清單選；沒選＝不換時區
  from: string; to: string;           // 'YYYY-MM-DD'，含頭尾
  kind: 'business' | 'travel' | 'other';
  note?: string;
}
```

- `ScheduleSlot.participants?: Participant[]`（生活流裡跟誰一起）、`ScheduleSlot.todoId?: string`（這段是在做哪條待辦）。
- 聊天標籤 `[[TODO|標題|YYYY-MM-DD]]`（截止日可省）加待辦、`[[TODO_DONE|標題]]` 勾掉（對標題模糊比對，對不上就不動）：解析放 `utils/todoTagParse.ts`（零依賴，worker 共用，同 `scheduleChangeParse.ts`），落庫在 `utils/todoTag.ts`；角色和配角都能用，落在自己名下。
- 角色卡加 `schedulePrompt?: string`（行程提示詞）、`scheduleAuto?: { enabled: boolean; every: 'day' | 'week'; ahead: 0 | 1 }`。身份卡（`UserPersona`／`UserProfile`）同樣兩個欄位。
- 存法：`calendar_events`、`trips` 兩張新表；時光契約的 `tasks` 搬成 `kind: 'todo'`、`anniversaries` 搬成 `kind: 'anniversary'`（`charRemembers`、`repeatAnnually` 照搬），搬完舊表留著不讀。`Anniversary` 的注入（`utils/anniversary.ts`）改讀 `CalendarEvent`。
- 旅行期間的時區：`resolveCharTimeZone`（`utils/timezone.ts`）多一層，先看這個人今天有沒有旅行（登記表跟世界一樣放 `charNameRegistry.ts`）；身份卡的所在地同理（`utils/userPersona.ts` 套用時看）。

## 4. 介面

- **月曆**：月格子，有事的日子打點；下面「今日次元重疊」列今天所有人（身份卡＋開了日程的角色）的行程，參與者含對方的那幾條高亮；每條寫當地時間＋「你 xx:xx」。
- **我的**：身份卡選擇器（主線在前）；時間軸：約定層＋這張卡的生活流（有生成的話）；待辦清單收在底下；「生成我的行程」。
- **TA 的**：角色選擇器；時間軸同上（做待辦的那段帶圖示）；底下「TA 的待辦」清單：勾、取消勾、刪、手動加；右上「生成角色行程」：時長（一天／一週）、行程提示詞、批量、自動生成設定、出行計劃清單（新增／編輯／刪除）。
- 加事件：全螢幕頁（AGENTS 規矩：不要半窗），選誰的、標題、時間、地點、參與者（頭像多選）、備註；待辦只要標題＋截止日。
- 桌面的日程組件、小小窩、聊天設定裡的日程卡照舊讀 `DailySchedule`，不動；聊天設定的「生成日程」按鈕改成連去日曆。

## 5. 提示詞

- 生成生活流時多四段：**行程提示詞**（角色卡那份）、**當天的約定**（約定層裡跟他有關的，含「跟誰」）、**沒做完的待辦**（讓他挑幾條排進時段）、**出行中**（有旅行就帶目的地、第幾天）。輸出格式多三欄：「跟誰一起」（名字，落庫時對回 id，對不上就只留名字當文字）、「這段在做哪條待辦」（對回 `todoId`）、「哪幾條待辦已經做完」（自動勾，`doneBy: 'ai'`）；一週生成時另外可以列「這週想做的事」落成待辦（來源 AI）。
- 聊天提示詞多一段：角色沒做完的待辦清單＋`[[TODO|…]]` 的用法（有日程功能的角色才給），注入位置跟日程注入放一起（`scheduleInjection.ts`）。
- 身份卡生成：同一個生成器，把身份卡當「人」餵進去（名字、簡介、自定義設定），沒有內心獨白和小劇場那些角色專用的段。
- 聊天注入照舊走 `scheduleInjection.ts`；參與者有的話在時段後面加「（跟 ×× 一起）」。

## 6. 分批

1. **行事曆殼**：App、三個分頁、讀現有 `DailySchedule`／`tasks`／`anniversaries` 顯示、雙時間、今日次元重疊、身份卡切換。時光契約先留著，桌面兩個圖示並存。
2. **約定層**：`calendar_events` 表、加事件全螢幕頁、待辦（你的和角色的，含聊天標籤進來）與紀念日搬過來、注入改讀新表、時光契約退役（桌面圖示換成行事曆，舊 `AppID.Schedule` 導到行事曆）。
3. **生成強化**：行程提示詞、一天／一週、批量、身份卡 AI 生成、`participants`（生成輸出＋顯示頭像＋注入那句）、約定和待辦餵進生成、`todoId` 與自動勾掉。
4. **旅行**：`trips` 表、出行計劃介面、時區解析多一層、生成帶目的地、天氣跟目的地。
5. **自動生成**：本機排程（提早一天）＋主動消息 2.0 後台任務。

每批做完給 Liora 看一次再合。

## 7. 待確認

- ~~「TA 的待辦」要不要做~~：做，見第 2 節的閉環。
- ~~一週生成一次請求還是 7 次~~：一次請求出 7 天大綱、每天的時段分開補。
- 時光契約退役後，`AppID.Schedule` 的桌布／主題引用（`constants.tsx`、幾套桌面）要跟著換名字和圖示。
