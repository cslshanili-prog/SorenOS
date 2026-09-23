/**
 * 到點現拉「外面的世界」：今日節日 + 實時天氣 + 熱搜，填進 fire_pack 的
 * AMSG_SLOT_REALTIME_WORLD 槽位。
 *
 * 為什麼不跟著模板一起烤進來：那一段抬頭寫著「以下信息來自真實世界」，措辭比任何
 * 免責聲明都硬。照著打包那一刻的讀數說話，就是大晴天叫人帶傘、隔天還在祝節日快樂、
 * 同一批舊聞當成「最近真實發生」說上三遍。所以留槽位、到點現拉。
 *
 * 取數與成段渲染都用 utils/realtimeWorldCore（瀏覽器那邊聊天時走的是同一份），
 * 這個文件只管兩件事：把結果按時段 / 按城市緩存進 client_state，別每條主動消息都
 * 重拉一遍；以及給整個取數過程封頂——拉不到、拉超時都只是少這一段，消息照常發。
 */

import {
  checkSpecialDates,
  fetchHotNews,
  fetchWeatherWithFallback,
  getHotNewsSlot,
  pickRandomNews,
  renderRealtimeWorldBlock,
  resolveHotNewsPlatforms,
  sameHotNewsPlatforms,
  REALTIME_NEWS_PICK_COUNT,
  type NewsItem,
  type WeatherData,
} from '../../../utils/realtimeWorldCore';
import type { AmsgToolConfig } from '../../../utils/amsgToolPack';

/** 兩份快照都放全局命名空間：天氣按城市、熱榜按時段，本來就是所有角色共用一份。 */
export const AMSG_WEATHER_SNAPSHOT_KEY = 'world_weather';
export const AMSG_HOTNEWS_SNAPSHOT_KEY = 'world_hotnews';

/** 天氣快照的保鮮期，與前台默認的緩存時長一致。 */
const WEATHER_TTL_MS = 30 * 60 * 1000;

/**
 * 拉不到時舊讀數還能頂多久 —— 天氣 3 小時、熱榜 24 小時，再舊就整段不要。
 *
 * 頂一會兒是划算的（半小時前的氣溫也比隻字不提強），但這一段抬頭寫著「以下信息來自
 * 真實世界」：接口連掛三天就會頂著這塊招牌播三天前的那場雨、聊三天前的同一批熱搜。
 * 「拉不到就整段消失」本來就是這條鏈的紅線，舊讀數也得守著它。
 */
const WEATHER_FALLBACK_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const HOTNEWS_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 熱榜按「國內現在幾點」分時段。worker 跑在 UTC 上，不指定時區的話「今日上午」
 * 會跟榜單自己的作息差好幾個時段。
 */
const HOTNEWS_SLOT_TZ = 'Asia/Shanghai';

/** 存進快照的熱榜條數。每次觸發只隨機抽幾條注入，留這些夠換著說很多輪了。 */
const HOTNEWS_KEEP = 60;

/**
 * 整個取數的時間封頂。主動消息後面還要跑 LLM、可能還要跑幾輪工具，
 * 不能讓一個卡住的熱榜站把這次觸發拖到超時。
 */
const FETCH_BUDGET_MS = 10_000;

type StateRow = { key: string; value: string };
type WriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<unknown>;

interface WeatherSnapshot {
  city: string;
  data: WeatherData;
  fetchedAt: number;
}

interface HotNewsSnapshot {
  /** getHotNewsSlot 的時段 id，形如 2026-08-02#5。 */
  id: string;
  platforms: string[];
  items: NewsItem[];
  fetchedAt: number;
}

/** 快照讀出來形狀不對就當沒有——重拉一次的代價遠小於拿髒數據去說話。 */
const parseSnapshot = <T>(rows: StateRow[], key: string, ok: (v: any) => boolean): T | null => {
  const raw = rows.find((r) => r.key === key)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return ok(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
};

/**
 * 給一個取數任務封頂：到點還沒回來就用兜底值繼續。
 * 被丟下的那個 promise 單獨接住，別變成 unhandled rejection 把 worker 吵醒。
 */
const withBudget = async <T>(job: Promise<T>, ms: number, fallback: T, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = job.catch((e) => {
    console.warn(`[amsg:world] ${label} 拉取失敗`, e);
    return fallback;
  });
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[amsg:world] ${label} 超過 ${ms}ms 沒回來，這次先不帶這一段`);
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** 天氣：同城半小時內複用快照，過期或換城市才真去拉。 */
const loadWeather = async (
  cfg: AmsgToolConfig,
  nowMs: number,
  globalRows: StateRow[],
  pendingWrites: Array<{ key: string; value: string }>,
): Promise<WeatherData | null> => {
  const city = cfg.weatherCity?.trim();
  if (!city) return null;

  const snap = parseSnapshot<WeatherSnapshot>(globalRows, AMSG_WEATHER_SNAPSHOT_KEY,
    (v) => v && typeof v.city === 'string' && v.data && typeof v.fetchedAt === 'number');
  if (snap && snap.city === city && nowMs - snap.fetchedAt < WEATHER_TTL_MS) {
    console.log('[amsg:world] 天氣命中快照', { city, ageMin: Math.round((nowMs - snap.fetchedAt) / 60000) });
    return snap.data;
  }

  const fresh = await fetchWeatherWithFallback(city, cfg.weatherApiKey);
  if (fresh) {
    pendingWrites.push({
      key: AMSG_WEATHER_SNAPSHOT_KEY,
      value: JSON.stringify({ city, data: fresh, fetchedAt: nowMs } satisfies WeatherSnapshot),
    });
    return fresh;
  }
  // 拉不到就用手上這份舊的：半小時前的氣溫也比「今天天氣怎麼樣都不知道」強，
  // 而且不寫快照，下次觸發會再試一次。城市換過了、或者舊得過頭了就寧可不說。
  if (snap && snap.city === city && nowMs - snap.fetchedAt <= WEATHER_FALLBACK_MAX_AGE_MS) {
    console.warn('[amsg:world] 天氣拉取失敗，先用上一次的讀數', { city });
    return snap.data;
  }
  return null;
};

/** 熱榜：同一時段 + 同一批平台複用快照，換時段才真去拉。 */
const loadHotNews = async (
  cfg: AmsgToolConfig,
  nowMs: number,
  globalRows: StateRow[],
  pendingWrites: Array<{ key: string; value: string }>,
): Promise<NewsItem[]> => {
  const platforms = resolveHotNewsPlatforms(cfg.newsPlatforms);
  const slot = getHotNewsSlot({ tz: HOTNEWS_SLOT_TZ, now: new Date(nowMs) });

  const snap = parseSnapshot<HotNewsSnapshot>(globalRows, AMSG_HOTNEWS_SNAPSHOT_KEY,
    (v) => v && typeof v.id === 'string' && Array.isArray(v.items) && Array.isArray(v.platforms)
      && typeof v.fetchedAt === 'number');
  if (snap && snap.id === slot.id && snap.items.length > 0 && sameHotNewsPlatforms(snap.platforms, platforms)) {
    console.log('[amsg:world] 熱榜命中快照', { slot: slot.id, count: snap.items.length });
    return snap.items;
  }

  const fresh = await fetchHotNews(platforms, 12, HOTNEWS_KEEP);
  if (fresh.length > 0) {
    pendingWrites.push({
      key: AMSG_HOTNEWS_SNAPSHOT_KEY,
      value: JSON.stringify({ id: slot.id, platforms, items: fresh, fetchedAt: nowMs } satisfies HotNewsSnapshot),
    });
    return fresh;
  }
  // 一條都沒拉到：用上個時段的頂一下，且不寫快照，下次觸發重試。
  // 隔天的舊聞不頂——那時候「最近發生的事」已經不是最近了。
  if (snap && snap.items.length > 0 && nowMs - snap.fetchedAt <= HOTNEWS_FALLBACK_MAX_AGE_MS) {
    console.warn('[amsg:world] 熱榜拉取失敗，先用上個時段的', { was: snap.id, want: slot.id });
    return snap.items;
  }
  return [];
};

/**
 * 組這次觸發要注入的「真實世界感知」那一段。
 *
 * 返回空串 = 這次什麼都沒有（功能沒開 / 全拉掛了），槽位被抹平，
 * 提示詞讀起來跟沒有這回事一樣，絕不半截。
 *
 * 注意這裡不給「當前時間」那一行：時間由 fire_pack 自己的 AMSG_SLOT_CURRENT_TIME 填，
 * 兩邊都出就是一份提示詞兩個鍾。
 */
export const buildRealtimeWorldBlock = async (args: {
  toolConfig: AmsgToolConfig;
  /** 角色的時間感知開關（tool_pack 帶上來的）：關掉就連今日節日一起不給。 */
  timeAwarenessEnabled: boolean;
  /** 角色的時區，判「今天幾號」用。 */
  tzId: string;
  nowMs: number;
  /** onBeforeFire 已經讀過的 amsg:global 行，直接複用，不再多查一次。 */
  globalRows: StateRow[];
  globalNamespace: string;
  writeState?: WriteState;
}): Promise<string> => {
  const { toolConfig: cfg, nowMs, globalRows } = args;

  const specialDates = args.timeAwarenessEnabled ? checkSpecialDates(args.tzId, nowMs) : [];
  if (!cfg.weatherEnabled && !cfg.newsEnabled) {
    // 天氣熱搜都沒開，只剩節日：有就單說一句，沒有就整段不要。
    return renderRealtimeWorldBlock({ specialDates });
  }

  const pendingWrites: Array<{ key: string; value: string }> = [];
  const [weather, news] = await withBudget(
    Promise.all([
      cfg.weatherEnabled ? loadWeather(cfg, nowMs, globalRows, pendingWrites) : Promise.resolve(null),
      cfg.newsEnabled ? loadHotNews(cfg, nowMs, globalRows, pendingWrites) : Promise.resolve([] as NewsItem[]),
    ]),
    FETCH_BUDGET_MS,
    [null, [] as NewsItem[]] as [WeatherData | null, NewsItem[]],
    '實時世界',
  );

  // 快照寫回是 best-effort：寫不進去只是下次還得重拉，不能連累這次觸發。
  if (pendingWrites.length > 0 && typeof args.writeState === 'function') {
    try {
      await args.writeState(args.globalNamespace, pendingWrites);
    } catch (e) {
      console.warn('[amsg:world] 快照寫回失敗（下次觸發會重拉）', e);
    }
  }

  const block = renderRealtimeWorldBlock({
    specialDates,
    weather,
    news: pickRandomNews(news, REALTIME_NEWS_PICK_COUNT),
  });
  console.log('[amsg:world] 本次注入', {
    節日: specialDates.length,
    天氣: weather ? weather.city : '無',
    熱點池: news.length,
    整段字數: block.length,
  });
  return block;
};
