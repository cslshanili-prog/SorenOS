# 新聞熱點：中文熱榜＋國際／台灣新聞

設置 → 實時感知 →「新聞熱點」。打開後，聊天時角色會從這池新聞裡隨機挑幾條當作「最近真實發生的事」（`REALTIME_NEWS_PICK_COUNT`），「熱點」App 也看的是同一池。

## 兩組來源

| 組 | 來源 | 怎麼抓 |
|---|---|---|
| 國際／台灣新聞（2026-10-08 加） | `utils/newsFeeds.ts` 的 `NEWS_FEED_SOURCES`：中央社、公視、自由時報、BBC 中文、德國之聲、法廣、BBC World、Guardian、NPR、Al Jazeera 的 RSS | 用戶自己的**主動消息 2.0 Worker** 代抓 |
| 中文熱榜 | hot_news（news.orz.ai）的平台：微博、知乎、百度… | 瀏覽器直連 |

兩組輪流排（`interleaveNews`），各組內再按來源輪流，免得一家霸屏。

## 為什麼 RSS 要經 Worker

大部分新聞網站的 RSS 不開 CORS，瀏覽器讀不到。代抓放在每人自己的主動消息 2.0 Worker，**不放主代理 Worker**：主代理（`worker/index.js`，`DEFAULT_PROXY_WORKER`）是上游作者的公共實例，我們改不了。

- App：`utils/newsFeedsClient.ts` → `GET {workerUrl}/news-feeds?keys=cna,pts`（帶 `X-Client-Token`）。
- 雲端生成：`worker/amsg/src/realtimeWorld.ts` 的 `loadHotNews` 直接在 Worker 上抓。
- 端點只收登記過的 key，不收網址，不是開放代理。`/config-check` 回 `newsFeeds: true` 表示這份代碼有這條路由。

**沒有 Worker、或 Worker 還沒更新（404）**：App 退回維基百科「新聞動態」（`fetchWikipediaNews`，REST 的 featured feed 裡的 `news`，開了 CORS）。中文版沒有這一段時用英文版。

## 勾選的語意（`resolveNewsSelection`）

- `newsFeeds` 沒設過（老設定）→ 預設 `DEFAULT_NEWS_FEEDS`（中央社、公視、BBC 中文、德國之聲）。
- `newsFeeds: []` → 不要 RSS。
- 熱榜平台留空：有選 RSS 時就真的不要中文熱榜；兩邊都空才退回內置中文熱榜。
- 快照的 `platforms` 存的是來源集（熱榜 key ＋ `feed:` 前綴的 RSS key），換勾選就作廢、下一輪重拉。

## 加一個新來源

在 `NEWS_FEED_SOURCES` 加一筆（`urls` 可以放同一家的幾條分類 feed）。RSS 2.0、RSS 1.0（RDF）、Atom 都能解析（`parseFeedItems`，純字串、不用 DOMParser）。超過三天的條目丟掉（有日期才判斷）。改完要 `pnpm build:workers` 重打包，用戶按「更新 Worker」才拿得到新來源。

網址沒有在開發環境實測過（沙盒連不到外網），單一來源抓不到只會少那一家；有用戶回報哪家一直沒有，再換網址。
