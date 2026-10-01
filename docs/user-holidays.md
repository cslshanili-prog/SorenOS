# 用戶所在地節假日感知

設置 → 實時感知 → 節假日感知。默認關閉；國家／地區由用戶自己選，不定位。設備在台北時區時，第一次打開會先幫忙選好台灣，可以改。

上游 SullyOS `011d12d1`（2026-09-27）＋ `d0cb7f61`（馬來西亞）搬過來的，只搬了這個功能，沒跟同一個 commit 裡的裝扮、相機那些東西走。台灣是 Soren 另外接的（上游的資料源都不收台灣）。

## 會說什麼

只有用戶那邊今天剛好是國定假日、補假或補班日，才在「互動對象 (User)」段標題下面多一行，例如：

> Liora所在的台灣今天（2026-10-09）放假：國慶日補假。Liora實際有沒有休息，以Liora自己的日程和說法為準。

平常日子、普通週末、查不到年度資料時一個字都不加。只說「今天是什麼日子」，不推斷用戶真的有沒有休息——用戶自己的日程和說法優先。

- 跟時間感知同一個開關：角色關了時間感知、見面用架空模式（`dateTimeAwarenessEnabled=false` → `skipTimeAwareness`）都不給。
- 共用 `ContextBuilder.buildCoreContext` 的用戶資料段，所以私聊、見面、通話、查手機等走這段的地方都看得到；群聊的多人分角色塊（`skipUserProfile`）不重複注入。
- 不改用戶原本的設定、人設、世界書或記憶；名字只在拼句子時帶入，不寫進日曆緩存、不送給資料源。

## 資料來源

| 地區 | 來源 | 備註 |
|---|---|---|
| 台灣 `TW` | 人事行政總處「政府行政機關辦公日曆表」，用 [ruyut/TaiwanCalendar](https://github.com/ruyut/TaiwanCalendar) 整理好的 JSON：先拉 `cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/{year}.json`，失敗退到 `raw.githubusercontent.com` 同一份 | 整年每天一筆。只留有說明的日子（假日、補假、補行上班），普通週末不算。「補假」往前後三天找最近的具名假日拼成「國慶日補假」，找不到照寫「補假」；「補行上班」算補班日。整年不到 365 筆、年份或格式不對都不認。年度還沒公布時檔案不存在，就沒有提醒，不猜 |
| 中國 `CN` | [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT，`presets/holidays/holiday-cn-LICENSE`） | 2026 年內建在 `presets/holidays/cn-2026.json`（節名已轉繁體），其他年份線上拉；十二月合併下一年的公告（可能有十二月補班） |
| 馬來西亞 `MY` | [Malaysia Holiday API](https://malaysia-holiday.dydxsoft.my/api/docs) | 取不帶州屬過濾的年度接口；只有覆蓋全部 16 地的才算全國假期，選了州屬才提醒地區假期 |
| 其他 | [Nager.Date](https://date.nager.at) v3 PublicHolidays | 國家清單快照在 `presets/holidays/countries.json`（2026-09-27）；只收 `Public` 類型；沒選地區時，只在部分地區放的假不算 |

## 什麼時候取數、怎麼緩存

- 瀏覽器：OSContext 開機、切回前台、每小時預熱一次今年的日曆；私聊送出前（`chatPrompts`）再等一次，最多 1.5 秒，不拖慢送出。`ContextBuilder` 是同步的，只讀備好的日曆，絕不為拼提示詞發請求。
- 緩存：localStorage `user_holidays_v1_{國家}_{年}`，24 小時內不重拉；請求逾時 3 秒，失敗後一小時內不重試，期間只沿用同國家同年份的舊日曆，絕不拿別的年份頂替。緩存不是用戶資料，不進備份。
- 設定本身（`RealtimeConfig.userHolidays`）跟著實時感知配置進備份。

## 日期跟誰走

照**用戶設備**的時區算「今天」，不是角色時區，也不是 Cloudflare 的 UTC。`buildToolConfig` 同步工具配置時把當下的設備時區塞進 `userHolidays.timeZone`；用戶出國換了時區，下次同步工具配置（例如再存一次實時感知）雲端才會跟上。

## 雲端（主動消息 2.0）

- 打包 fire_pack 和即時對話時（`forFirePack` / `timelyByWorker`）**不烤**這一行（`skipUserHoliday`），不然到點講的是打包那天的假。
- Worker 到點用 `buildUserHolidayBlock`（`worker/amsg/src/realtimeWorld.ts`）照當天取數，緩存在 `amsg:global`，再用 `insertUserHolidayInProfile` 插回「互動對象 (User)」段；舊模板沒有那段就補在最後。不放進天氣熱搜那塊——那塊講外面的世界，這句講用戶本人。
- 這是 Worker 改動，`AMSG_BUNDLE_VERSION` 推到 `2026-10-02`。用戶按一次「更新 Worker」，主動消息和即時對話才會帶上這一行；沒更新的話雲端那兩條路只是沒有這行，本機照常。

## 驗證

`pnpm vitest run utils/userHolidays.test.ts worker/amsg/src/realtimeWorld.test.ts utils/amsgToolPack.test.ts`
