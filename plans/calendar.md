# 行事曆：身份卡和角色的日程、待辦、旅行，一個 App 看全

> 狀態：**定案（Liora 2026-11-17）**，五批都做完（見第 7 節）。App 叫「行事曆」（Liora 定的）。取代「時光契約」（`apps/ScheduleApp.tsx`），角色的日程表（`DailySchedule`）不搬、行事曆讀它來顯示。時間怎麼算一律照 [`plans/time-system.md`](./time-system.md)（第 4 批「日曆顯示」就是這份）。

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

- **月曆**：月格子，有事的日子打點；下面「今日交會點」列今天所有人（身份卡＋開了日程的角色）的行程，參與者含對方的那幾條高亮；每條寫當地時間＋「你 xx:xx」。
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

1. **行事曆殼**：App、三個分頁、讀現有 `DailySchedule`／`tasks`／`anniversaries` 顯示、雙時間、今日交會點、身份卡切換。時光契約先留著，桌面兩個圖示並存。
2. **約定層**：`calendar_events` 表、加事件全螢幕頁、待辦（你的和角色的，含聊天標籤進來）與紀念日搬過來、注入改讀新表、時光契約退役（桌面圖示換成行事曆，舊 `AppID.Schedule` 導到行事曆）。
3. **生成強化**：行程提示詞、一天／一週、批量、身份卡 AI 生成、`participants`（生成輸出＋顯示頭像＋注入那句）、約定和待辦餵進生成、`todoId` 與自動勾掉。
4. **旅行**：`trips` 表、出行計劃介面、時區解析多一層、生成帶目的地、天氣跟目的地。
5. **自動生成**：本機排程（提早一天）＋主動消息 2.0 後台任務。

每批做完給 Liora 看一次再合。

## 7. 實況

### 第 1 批（2026-11-17 做完）：行事曆殼

- `apps/CalendarApp.tsx`（`AppID.Calendar`，桌面叫「行事曆」，跟時光契約並存到第 2 批）。三個分頁：**月曆**（月格子打點：藍＝有角色日程、黃＝待辦截止、紅＝紀念日；底下「今日交會點」：我的行程＝這張身份卡那天的待辦和紀念日，角色行程＝所有開了日程的角色那天的時段混排、NOW／Soon）、**我的**（身份卡切換，主線標出來；那天的待辦和紀念日；待辦清單能勾）、**TA 的**（角色切換；頭像卡寫現在在做什麼、時區或架空曆法；時間軸每段寫起訖＋「你 xx:xx」；✦ 生成今天／重新生成；刪掉這天）。
- 純邏輯在 `utils/calendarView.ts`：月格子、時段起訖（結束＝下一段開始）、`dualTime`（這個人那邊 vs 你那邊，含隔天標記）、身份卡清單（`personaOptions`，主線＝全域默認那張）、交會點混排、架空曆法的日期標題。
- 資料：角色日程照舊讀 `DailySchedule`，多一個 `DB.getDailySchedulesInRange(charId, from, to)`（id 字典序剛好照日期）按月撈；待辦、紀念日先讀時光契約的 `tasks`／`anniversaries`。
- 時間：角色那邊照 `resolveCharTimeZone`（先看世界）、你那邊照身份卡的 `timezone`；兩邊一樣就不重複寫。
- 沒做：約定層、加事件、你自己的日程、一週生成、旅行（後面幾批）；埋點照 `docs/analytics.md` 的規矩等事件登記了再加。

### 第 2 批（2026-11-17 做完）：約定層＋時光契約退役

- **資料**：`CalendarEvent`／`Participant`（`types.ts`），存 `calendar_events` 表（`utils/db.ts` v81，備份匯出匯入的「行事曆」段）。純邏輯在 `utils/calendarEvents.ts`：誰的（`personaParticipant`／`charParticipant`）、這天有沒有（`eventOnDay`：有時段看開始那天、跨天事件中間也算、`repeat: 'yearly'` 看每年那次、待辦看截止日）、`eventsInvolving`（名下＋有份的）、`openTodos`、`anniversaryView`（轉成舊 `Anniversary` 形狀餵 `utils/anniversary.ts`，注入那套沒改）、`loadCalendarEvents`（先搬家再讀）。
- **搬家**：第一次讀約定層時 `migrateLegacyCalendar` 把時光契約的 `tasks`／`anniversaries` 搬成真實身份名下的待辦／紀念日（id `legacy-task-*`／`legacy-anni-*`，重跑不疊；搬過記 localStorage `soren_calendar_legacy_migrated_v1`），舊表留著不讀。
- **加一條**：右下角 ＋ 開全螢幕 `components/calendar/AddEventPage.tsx`（不要半窗）：誰的（身份卡、角色）、種類（事件／待辦／紀念日）、標題、日期、全天或起訖、地點、跟誰（含配角，多選）、備註（`ExpandableTextarea`）；點已有的那條也開它改、刪。紀念日多「每年重複」「讓 TA 記住這一天」。
- **待辦**：「我的」「TA 的」底下各一個清單（快速加、勾、刪）；角色在聊天裡 `[[TODO|事情|YYYY-MM-DD]]` 給自己加一條、`[[TODO_DONE|事情]]` 勾掉（`doneBy: 'ai'`，標題模糊比對，對不上不動）。解析零依賴在 `utils/todoTagParse.ts`（容錯：全角豎線、冒號、`ACTION:`、中文別名），落庫在 `utils/todoTag.ts`（改了就發 `calendar-todo-changed` 事件，行事曆開著會重讀），私聊接在 `chatParser` 的 ADD_EVENT 後面（toast＋系統訊息），主動消息 worker 的 `classifier.ts` 把整段標籤直通回客戶端。
- **注入**（`chatPrompts`）：紀念日改讀約定層；有日程功能的角色多一段「📝【你的待辦】」（`utils/calendarInjection.ts`，截止日寫成今天／明天／過期幾天、對方幫記的標出來、最多 8 條）＋標籤教學；fire_pack 不烤。角色自己 `ADD_EVENT` 加的也存成紀念日（owner 是角色、參與者是你、`source: 'char'`）。
- **「TA 的」選人**：角色和配角都能看（配角沒有日程表，只有約好的事和待辦；沒開日程功能的角色也一樣）。頭像列只放最近看過的幾個（localStorage `soren_calendar_recent_people_v1`），「…」開全螢幕 `components/calendar/PersonPickerPage.tsx`：搜尋、主角／配角篩選、照世界 → 分組收起來（跟切換聊天同一套 `groupForSwitcher`），大世界幾十個人也找得到。
- **日期列**：「今天」放日期下方；不是今天就變「回到今天」；點日期開全螢幕 `components/calendar/DayPickerPage.tsx` 選一天（有東西的天打點）。
- **月曆**：打點多一色（紫＝事件），「今日交會點」的我的行程＝這張身份卡有份的約定，角色行程＝角色名下的約定＋日程時段。
- **時光契約退役**：`apps/ScheduleApp.tsx` 刪掉、桌面不再列 `AppID.Schedule`（`constants.tsx`），舊 id 在 `PhoneShell`／`appPreload` 都導到行事曆，小小窩、手遊桌面等家園的入口照舊用舊 id、文案改「行事曆」；桌面存過的版面裡的 schedule 項目由 `normalizeLayout` 自己清掉。皮膚沒留。
- 沒做：生成餵約定和待辦、`todoId` 自動勾掉、你自己的 AI 日程、一週、旅行、自動生成（第 3～5 批）。

### 第 3 批（2026-11-17 做完）：生成強化

- **一個生成器兩種人**：`utils/schedulePerson.ts` 把角色和身份卡抽成 `SchedulePerson`（身份卡的日程照樣存 `DailySchedule`，`charId` 是 `persona~<key>`，角色那頭讀日程的地方撈不到它）。`utils/scheduleGenerator.ts` 的 `generateScheduleFor(person, …, { dateKey, force, outline })` 是核心，舊的 `generateDailyScheduleForChar` 變成它的殼（Chat、家園照舊）。身份卡用自己的提示詞（`buildPersonaPrompt`：名字、簡介、自定義設定；沒有意識流獨白）。
- **多帶的段**（純函數在 `utils/scheduleGenParts.ts`）：行程提示詞（`schedulePrompt`，角色卡／身份卡／真實身份各一格，在行事曆的生成頁改）、這天的約定（名下＋有份的，寫跟誰、紀念日標出來）、沒做完的待辦（最多 8 條，過期標出來）、一週大綱裡這天那句。
- **輸出多三欄**：時段的 `with`（名字）→ 落庫對回 `participants`（對不上只留 `with` 文字）、`todo`（標題）→ `todoId`、頂層 `doneTodos` → 勾掉（`doneBy: 'ai'`）。`ScheduleSlot` 多 `participants`／`with`／`todoId`。注入（`scheduleInjection.ts`）當前時段和整天表都加「（跟 ×× 一起）」，零依賴靠 `with` 文字。
- **一週**：`generateWeekFor`：一次請求出 7 天大綱＋「這週想做的事」（落成待辦，`source: 'ai'`，截止那週最後一天），再每天分開補時段（已有的不動，`force` 才重生）；共 8 次 API。
- **生成頁**：`components/calendar/GeneratePage.tsx`（全螢幕）：行程提示詞、生成今天／重新生成、生成這週／這週全部重生、所有開了日程的角色今天還沒排的都生成（逐個跑、列進度）。「我的」頭像卡右邊 ✦ 開身份卡的；「TA 的」✦ 開角色的。
- **顯示**：「我的」多身份卡的時間軸（跟「TA 的」同一個 `renderTimeline`），時段卡片列參與者頭像＋「跟 ×× 一起」、待辦標記；月曆「我的行程」也混進身份卡的時段。
- 沒做：旅行、自動生成（第 4、5 批）；生成時的「出行中」那段等旅行。

### 第 4 批（2026-11-17 做完）：旅行

- **資料**：`Trip`（`types.ts`）存 `trips` 表（`utils/db.ts` v82，備份匯出匯入的「旅行」段）；純邏輯在 `utils/trips.ts`（誰的、這天在哪趟、第幾天／共幾天、`tripLabel`、`newTrip`、`refreshTripRegistry`）。登記表在 `utils/charNameRegistry.ts`（`setTripRegistry`／`getActiveTrip`，零依賴），OSContext 啟動時載一次、行事曆存改刪之後自己刷。
- **時區多一層**：`resolveCharTimeZone` 變成「旅行 > 世界 > 角色」（旅行沒選時區就不換；「今天」照原本那邊的日曆日算），不看旅行的那層拆成 `resolveCharBaseTimeZone`。身份卡的所在地同理（`utils/userPersona.ts` 的 `withTripTimezone`，真實身份和卡都看；沒旅行回同一個物件）。
- **生成帶出行**：`buildTripBlock`（`utils/scheduleGenParts.ts`）：目的地、第幾天（第一天／最後一天措辭不同）、出差／旅行的節奏、備註；一天和一週大綱都帶。
- **天氣跟目的地**：私聊提示詞（`chatPrompts`）角色旅行中把 `weatherCity` 換成目的地；天氣快取照城市分。雲端（主動消息 worker 的 `realtimeWorld`）還是照設定裡的城市，沒接。
- **介面**：「我的」「TA 的」各一段「✈ 旅行」清單（＋ 加一趟、點了改／刪），頭像卡下多一行「✈️ 旅行 · 杭州 · 第 2／5 天」，那天的時區、時間軸都照旅行的；月曆打點多一色（青＝有人在旅行），「今日交會點」上方列誰出行中。全螢幕 `components/calendar/TripPage.tsx`：誰的、類型（旅行／出差／其他）、目的地（打字）、時區（`COMMON_TIMEZONES` 清單選，可不換）、起訖日、備註。
- 沒做：自動生成（第 5 批）；雲端天氣跟目的地。

### 第 5 批（2026-11-17 做完）：自動生成

- **設定**：`ScheduleAutoConfig { enabled, every: 'day'|'week', ahead: 0|1, cloud? }`，角色卡 `scheduleAuto`、身份卡／真實身份同名；在生成頁改。
- **本機那條路**（`utils/scheduleAutoRun.ts`）：OSContext 每 5 分鐘、切回前台各跑一次 `runScheduleAutoTick`。判斷在 `decideAutoTarget`：每天模式 `ahead=1` 是那邊 20:00 之後排明天、之前補今天；`ahead=0` 當天沒有就補；每週模式這週有缺就 `generateWeekFor` 補。一次 tick 只排一個人，同一天最多試兩次、失敗隔一小時再試（localStorage `soren_schedule_auto_attempts_v1`）。角色排了雲端的，本機只補今天（明天交給雲端）。
- **雲端那條路**（角色；`utils/scheduleAutoCloud.ts`、契約 `utils/amsgScheduleJob.ts`、worker `worker/amsg/src/scheduleFire.ts`，`amsgKind: 'schedule-generate'`）：一條**每天到點**的後台任務（`scheduleBackgroundJob` 多了 `recurring`：`firstSendTime`＋`recurrenceType: 'daily'`＋`tzId`，ahead=1 是那邊 20:00、ahead=0 是 00:30），憑據走情緒那一行（角色單獨的情緒 API，否則全局聊天 API）。輸入是一份 **standing job**（`amsg:job` 的 `schedule:<charId>`，不刪）：人設上下文＋接下來 8 天每天要帶的段（行程提示詞、出行、約定、待辦，已渲染好）；上線時 tick 順手每天刷一次，worker 到點照 `tzId`＋`ahead` 算目標日、挑那天的段、用 `utils/schedulePromptCore.ts`（提示詞本體抽成零依賴葉子，本機同一份）拼提示詞，結果 `schedule-generate` 帶模型回的 JSON 原樣送回收件箱（不彈通知），客戶端 `utils/scheduleGenerateResultApply.ts` 落地（對回 id／todoId、doneTodos 勾、存表、打髒）；本機已經排了那天就丟棄不蓋。輸入十天沒刷（客戶端沒上線）worker 就跳過不排。關掉＝取消任務＋把輸入寫空；刪角色走原本按 charId 取消遠端任務那條路。
- **沒接**：身份卡只有本機那條路（雲端沒有身份卡的角色 id）；每週模式只有本機。

## 8. 待確認

- ~~「TA 的待辦」要不要做~~：做，見第 2 節的閉環。
- ~~一週生成一次請求還是 7 次~~：一次請求出 7 天大綱、每天的時段分開補。
- ~~時光契約退役後，`AppID.Schedule` 的桌布／主題引用（`constants.tsx`、幾套桌面）要跟著換名字和圖示~~：第 2 批做了（桌面不列、家園入口導到行事曆、文案改了，圖示沿用）。
