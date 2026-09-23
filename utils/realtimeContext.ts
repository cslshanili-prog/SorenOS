/**
 * 實時上下文管理器 - 讓AI角色感知真實世界
 * Real-time Context Manager - Give AI characters awareness of the real world
 */

import { safeResponseJson } from './safeApi';
import { DB } from './db';
import { getProxyWorkerUrl } from './proxyWorker';
import { nowInTimeZone } from './timezone';
import {
    performSearch as performSearchCore,
    notionGetDiaryByDate,
    notionReadDiaryContent,
    notionSearchUserNotes,
    feishuGetToken,
    feishuGetDiaryByDate,
    type SearchResult,
    type DiaryPreview,
    type FeishuDiaryPreview,
} from './realtimeFetchCore';
import { formatFeishuWriteFailure } from './feishuDiagnostics';
import {
    fetchWeatherWithFallback,
    generateWeatherAdvice as generateWeatherAdviceCore,
    checkSpecialDates as checkSpecialDatesCore,
    clearGeocodeCache,
    fetchHotNews as fetchHotNewsCore,
    getHotNewsSlot as getHotNewsSlotCore,
    resolveHotNewsPlatforms,
    sameHotNewsPlatforms,
    pickRandomNews,
    renderRealtimeWorldBlock,
    HOTNEWS_PLATFORM_LABELS,
    DEFAULT_HOTNEWS_PLATFORMS,
    REALTIME_NEWS_PICK_COUNT,
    type WeatherData,
    type NewsItem,
} from './realtimeWorldCore';
import { getLocalDateKey } from './localDate';
import { lookupAnyScript } from './scriptKey';

// 兩份環境無關葉子，amsg worker 共用同一份，這裡的 Manager 方法委託過去；
// 類型與常量原樣 re-export，既有 import 路徑不用改：
//   realtimeFetchCore  搜索 / Notion / 飛書的讀取類純 fetch（服務端工具循環用）
//   realtimeWorldCore  天氣 / 熱搜 / 節日的取數與成段渲染（到點組 prompt 用）
export type { SearchResult, DiaryPreview, FeishuDiaryPreview } from './realtimeFetchCore';
export type { WeatherData, NewsItem } from './realtimeWorldCore';
export {
    fetchOwmWeather,
    fetchOpenMeteoWeather,
    HOTNEWS_API_BASE_URL,
} from './realtimeWorldCore';

export interface RealtimeConfig {
    // 天氣配置
    weatherEnabled: boolean;
    weatherApiKey: string;  // OpenWeatherMap API Key（可選；留空走免 key 的 Open-Meteo）
    weatherCity: string;    // 城市名 (如 "北京"、"Beijing"，Open-Meteo 支持中文)

    // 新聞配置
    newsEnabled: boolean;
    newsApiKey?: string;    // 可選，Brave Search 回落源用
    newsPlatforms?: string[]; // hot_news 熱榜平台 key（默認主源，免鑑權），留空用內置默認

    // Notion 配置
    notionEnabled: boolean;
    notionApiKey: string;   // Notion Integration Token
    notionDatabaseId: string; // 日記數據庫ID
    notionNotesDatabaseId?: string; // 用戶筆記數據庫ID（可選）

    // 飛書配置
    feishuEnabled?: boolean;
    feishuAppId?: string;
    feishuAppSecret?: string;
    feishuBaseId?: string;
    feishuTableId?: string;

    // 小紅書配置 (xiaohongshu-skills)
    xhsEnabled?: boolean;
    xhsMcpConfig?: {
        enabled: boolean;
        mode?: 'local' | 'lite';
        serverUrl: string;
        cookie?: string;        // Lite 模式：登錄後的完整小紅書 cookie
        platform?: 'xhs' | 'rednote'; // Lite 自動識別出的國內 / 全球后端
        rnoteApiKey?: string;   // Lite 模式：用戶自備的 Rnote Key，用於真實評論
        loggedInNickname?: string;
        loggedInUserId?: string;
        userXsecToken?: string; // 從 feed 列表自動獲取，用於 getUserProfile 等
    };

    // 緩存配置
    cacheMinutes: number;   // 緩存時長（分鐘）
}

// 默認配置
export const defaultRealtimeConfig: RealtimeConfig = {
    weatherEnabled: false,
    weatherApiKey: '',
    weatherCity: 'Beijing',
    newsEnabled: false,
    newsApiKey: '',
    newsPlatforms: ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'],
    notionEnabled: false,
    notionApiKey: '',
    notionDatabaseId: '',
    xhsEnabled: false,
    xhsMcpConfig: {
        enabled: false,
        mode: 'lite',
        serverUrl: `${getProxyWorkerUrl()}/api`,
        cookie: undefined,
        platform: undefined,
        rnoteApiKey: undefined,
        loggedInNickname: undefined,
        loggedInUserId: undefined,
        userXsecToken: undefined,
    },
    cacheMinutes: 30
};

// 緩存
let weatherCache: { data: WeatherData | null; timestamp: number } = { data: null, timestamp: 0 };
let newsCache: { data: NewsItem[]; timestamp: number } = { data: [], timestamp: 0 };


export const RealtimeContextManager = {

    /**
     * 獲取天氣信息。填了 OpenWeatherMap key 優先走 OWM，失敗或沒填 key 時回落免費的 Open-Meteo。
     */
    fetchWeather: async (config: RealtimeConfig): Promise<WeatherData | null> => {
        if (!config.weatherEnabled || !config.weatherCity) {
            return null;
        }

        const now = Date.now();
        const cacheMs = config.cacheMinutes * 60 * 1000;

        // 檢查緩存
        if (weatherCache.data && (now - weatherCache.timestamp) < cacheMs) {
            return weatherCache.data;
        }

        const weather = await fetchWeatherWithFallback(config.weatherCity, config.weatherApiKey);
        if (!weather) {
            return null;
        }

        // 更新緩存
        weatherCache = { data: weather, timestamp: now };

        return weather;
    },

    // 平台名表、默認平台、真正的多平台拉取都住在 realtimeWorldCore（主動消息到點
    // 也要用同一份），這裡保留同名入口，「熱點」App 與既有調用方不用改。
    HOTNEWS_PLATFORM_LABELS,

    DEFAULT_HOTNEWS_PLATFORMS,

    /**
     * 使用 hot_news（news.orz.ai）獲取中文多平台熱榜。
     * 免鑑權、半小時刷新。瀏覽器端優先直連；若被 CORS 攔截則本調用返回 []，
     * 由 fetchNews 自然回落到 Brave / Hacker News。
     */
    fetchHotNews: async (platforms?: string[], perPlatform = 12, total = 240): Promise<NewsItem[]> => {
        const list = resolveHotNewsPlatforms(platforms);
        const final = await fetchHotNewsCore(list, perPlatform, total);

        // ── F12 探針：看角色這次到底召回了哪些熱點 ──
        try {
            console.groupCollapsed(`%c[hot_news] 召回 ${final.length} 條 · 平台[${list.join(', ')}]`, 'color:#2563eb;font-weight:bold');
            if (final.length > 0 && typeof console.table === 'function') {
                console.table(final.map((n, i) => ({ '#': i + 1, 平台: n.source, 標題: n.title, 鏈接: n.url || '' })));
            } else if (final.length === 0) {
                console.warn('[hot_news] 一條都沒召回 → fetchNews 將回落到 Brave / Hacker News');
            }
            console.groupEnd();
        } catch { /* 探針掛了也不影響主流程 */ }

        return final;
    },

    // 一天分 6 段（每 4 小時）：0-4 凌晨 / 4-8 清晨 / 8-12 上午 / 12-16 午後 / 16-20 傍晚 / 20-24 夜間。
    getHotNewsSlot: (d: Date = new Date()) => getHotNewsSlotCore({ now: d }),

    // 同一時段併發只真正發一次請求（群聊 / 多角色同時回覆時複用同一 Promise）
    _hotNewsInFlight: new Map<string, Promise<NewsItem[]>>(),

    /**
     * 分時段熱點：每天每時段最多拉一次，持久化在 IndexedDB，全角色共享。
     * - 本時段已有快照且平台集一致 → 直接複用，不發請求
     * - 否則拉一次並存快照；拉失敗則退回最近一次快照（且不寫本時段，下次會重試）
     */
    getSlottedHotNews: async (config: RealtimeConfig): Promise<NewsItem[]> => {
        const { id, date, slot, label } = RealtimeContextManager.getHotNewsSlot();
        const platforms = resolveHotNewsPlatforms(config.newsPlatforms);

        // 1. 命中本時段快照（平台一致）→ 複用
        try {
            const snap = await DB.getHotNewsSnapshot(id);
            if (snap && snap.items?.length > 0 && sameHotNewsPlatforms(snap.platforms, platforms)) {
                const mins = Math.round((Date.now() - snap.fetchedAt) / 60000);
                console.log(`%c[hot_news] 命中今日${label}快照（${snap.items.length} 條，${mins} 分鐘前拉的）`, 'color:#16a34a');
                return snap.items;
            }
        } catch { /* 讀快照失敗就當沒有，繼續去拉 */ }

        // 2. in-flight 鎖：本時段已有在飛請求就複用
        const inflight = RealtimeContextManager._hotNewsInFlight.get(id);
        if (inflight) return inflight;

        const job = (async (): Promise<NewsItem[]> => {
            console.log(`%c[hot_news] 觸發今日${label}拉取…`, 'color:#2563eb;font-weight:bold');
            const items = await RealtimeContextManager.fetchHotNews(platforms);
            if (items.length > 0) {
                try {
                    await DB.saveHotNewsSnapshot({ id, date, slot, slotLabel: label, items, platforms, fetchedAt: Date.now() });
                    DB.pruneHotNewsSnapshots(12).catch(() => {});
                } catch { /* 存快照失敗不影響返回 */ }
                return items;
            }
            // 拉取失敗 → 退回最近一次快照（不寫本時段，下條消息會再試）
            try {
                const latest = await DB.getLatestHotNewsSnapshot();
                if (latest && latest.items?.length > 0) {
                    console.warn(`[hot_news] ${label}拉取失敗，複用最近快照（${latest.date} ${latest.slotLabel}，${latest.items.length} 條）`);
                    return latest.items;
                }
            } catch { /* ignore */ }
            return [];
        })();

        RealtimeContextManager._hotNewsInFlight.set(id, job);
        try {
            return await job;
        } finally {
            RealtimeContextManager._hotNewsInFlight.delete(id);
        }
    },

    /**
     * 使用 Brave Search API 獲取新聞（通過自建 Cloudflare Worker 代理）
     */
    fetchBraveNews: async (apiKey: string): Promise<NewsItem[]> => {
        try {
            // 使用自建的 Cloudflare Worker 代理
            const workerUrl = `${getProxyWorkerUrl()}/news?q=熱點新聞&count=5&country=cn`;

            const response = await fetch(workerUrl, {
                headers: {
                    'Accept': 'application/json',
                    'X-Brave-API-Key': apiKey  // Worker 需要這個 header
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Brave API error:', response.status, errorText);
                return [];
            }

            const data = await safeResponseJson(response);

            // Brave News API 返回結構
            if (data.results && data.results.length > 0) {
                return data.results.slice(0, 5).map((item: any) => ({
                    title: item.title,
                    source: item.meta_url?.netloc || item.source || 'Brave新聞',
                    url: item.url
                }));
            }
            return [];
        } catch (e) {
            console.error('Brave Search failed:', e);
            return [];
        }
    },

    /**
     * 獲取熱點新聞
     * 優先級: hot_news 分時段快照（默認主源，每天每時段最多拉一次）> Brave Search API > Hacker News
     */
    fetchNews: async (config: RealtimeConfig): Promise<NewsItem[]> => {
        if (!config.newsEnabled) {
            return [];
        }

        // 1. 默認主源：hot_news 分時段持久化快照（全角色共享，自帶 IndexedDB 緩存與 in-flight 鎖）
        const slotted = await RealtimeContextManager.getSlottedHotNews(config);
        if (slotted.length > 0) {
            return slotted;
        }

        // ── 回落源用內存緩存兜一下，避免降級態下每條消息都打 Brave/HN ──
        const now = Date.now();
        const cacheMs = config.cacheMinutes * 60 * 1000;
        if (newsCache.data.length > 0 && (now - newsCache.timestamp) < cacheMs) {
            return newsCache.data;
        }

        let news: NewsItem[] = [];

        // 2. 回落：Brave Search API（需 key，走 Worker 代理）
        if (config.newsApiKey) {
            news = await RealtimeContextManager.fetchBraveNews(config.newsApiKey);
            if (news.length > 0) {
                console.log(`%c[hot_news] 本次新聞源 = Brave 回落（${news.length} 條）`, 'color:#d97706;font-weight:bold');
                newsCache = { data: news, timestamp: now };
                return news;
            }
        }

        // 3. 兜底：Hacker News（英文但穩定，無CORS限制）
        news = await RealtimeContextManager.fetchBackupNews();
        if (news.length > 0) {
            console.log(`%c[hot_news] 本次新聞源 = Hacker News 兜底（${news.length} 條，英文）`, 'color:#dc2626;font-weight:bold');
            newsCache = { data: news, timestamp: now };
        }
        return news;
    },

    /**
     * 備用新聞源 - 使用Hacker News API（總是可用）
     */
    fetchBackupNews: async (): Promise<NewsItem[]> => {
        try {
            const response = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
            if (!response.ok) return [];

            const ids = await safeResponseJson(response);
            const topIds = ids.slice(0, 5);

            const stories = await Promise.all(
                topIds.map(async (id: number) => {
                    const storyRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
                    return safeResponseJson(storyRes);
                })
            );

            return stories.map((s: any) => ({
                title: s.title,
                source: 'Hacker News',
                url: s.url
            }));
        } catch (e) {
            return [];
        }
    },

    /**
     * 獲取時間上下文
     */
    getTimeContext: (tz?: string) => {
        const now = nowInTimeZone(tz);
        const hour = now.getHours();
        const dayNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
        const dayOfWeek = dayNames[now.getDay()];

        let timeOfDay = '凌晨';
        let mood = '安靜';

        if (hour >= 5 && hour < 9) {
            timeOfDay = '早晨';
            mood = '清新';
        } else if (hour >= 9 && hour < 12) {
            timeOfDay = '上午';
            mood = '精神';
        } else if (hour >= 12 && hour < 14) {
            timeOfDay = '中午';
            mood = '放鬆';
        } else if (hour >= 14 && hour < 17) {
            timeOfDay = '下午';
            mood = '平靜';
        } else if (hour >= 17 && hour < 19) {
            timeOfDay = '傍晚';
            mood = '慵懶';
        } else if (hour >= 19 && hour < 22) {
            timeOfDay = '晚上';
            mood = '溫馨';
        } else if (hour >= 22 || hour < 5) {
            timeOfDay = '深夜';
            mood = '安靜';
        }

        return {
            timestamp: now.toISOString(),
            dateStr: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
            timeStr: `${hour.toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`,
            dayOfWeek,
            timeOfDay,
            mood,
            hour,
            isWeekend: now.getDay() === 0 || now.getDay() === 6
        };
    },

    /**
     * 檢查特殊日期。
     * tz 非空時按角色所在時區判「今天幾號」——否則角色會跟著用戶的日曆過節：
     * 用戶這邊 2/14 早上，角色在紐約還是 13 號晚上，卻被告知今天是情人節。
     */
    checkSpecialDates: (tz?: string): string[] => checkSpecialDatesCore(tz),

    /**
     * 生成天氣建議
     */
    generateWeatherAdvice: (weather: WeatherData): string => generateWeatherAdviceCore(weather),

    /**
     * 構建完整的實時上下文（注入到系統提示詞）。
     * 取數在這裡（天氣兩源 + 熱點分時段快照），拼成話交給 realtimeWorldCore 的
     * renderRealtimeWorldBlock——主動消息到點生成時 worker 自己取數、調同一個渲染，
     * 兩邊說的是同一套話。
     */
    buildFullContext: async (
        config: RealtimeConfig,
        tz: string | undefined,
        // includeTime=false：角色關掉了「時間感知」。天氣/新聞還要，但當前時間和今日節日
        // 屬於時間感知的範疇，這個開關關著就不該從這一段裡漏出去。
        opts: { includeTime: boolean },
    ): Promise<string> => {
        const includeTime = opts.includeTime;

        // 1. 時間與節日。tz 非空時按角色所在時區折算，兩者同一個時區，否則同一段裡
        //    日期和節日會打架。時差提示（tzAwarenessNote）統一由 ContextBuilder.buildCoreContext
        //    注入，這裡不再追加，避免雙份。
        const time = includeTime ? RealtimeContextManager.getTimeContext(tz) : null;
        const timeLine = time ? `${time.dateStr} ${time.dayOfWeek} ${time.timeOfDay} ${time.timeStr}` : undefined;
        const specialDates = includeTime ? RealtimeContextManager.checkSpecialDates(tz) : [];

        // 2. 天氣（有沒有 OWM key 都能取：無 key 走 Open-Meteo）
        const weather = config.weatherEnabled ? await RealtimeContextManager.fetchWeather(config) : null;

        // 3. 新聞熱點（背景認知）
        //    完整快照存 IndexedDB 給「熱點」App；這裡每輪隨機抽幾條打散注入，控 token + 保持新鮮感。
        const newsPool = config.newsEnabled ? await RealtimeContextManager.fetchNews(config) : [];
        const picks = pickRandomNews(newsPool, REALTIME_NEWS_PICK_COUNT);

        const fullContext = renderRealtimeWorldBlock({ timeLine, specialDates, weather, news: picks });

        // ── F12 探針：本輪真正注入 prompt 的熱點 + 文本量（評估 token 用）──
        try {
            const pickDesc = picks.filter(n => n.desc).length;
            const poolDesc = newsPool.filter(n => n.desc).length;
            console.groupCollapsed(`%c[hot_news] 本輪注入 prompt：${picks.length} 條熱點（帶簡介 ${pickDesc}）· 整段 ${fullContext.length} 字（池子共 ${newsPool.length} 條，帶簡介 ${poolDesc}）`, 'color:#7c3aed;font-weight:bold');
            if (typeof console.table === 'function') {
                console.table(picks.map((n, i) => ({ '#': i + 1, 平台: n.source || '', 標題: n.title, 簡介: n.desc || '—' })));
            }
            console.log(fullContext);
            console.groupEnd();
        } catch { /* 探針不影響主流程 */ }

        return fullContext;
    },

    /**
     * 清除緩存
     */
    clearCache: () => {
        weatherCache = { data: null, timestamp: 0 };
        newsCache = { data: [], timestamp: 0 };
        clearGeocodeCache();
    },

    /**
     * 主動搜索 - 讓AI角色能夠主動搜索任意內容
     * Active Search - Let AI characters actively search for anything
     */
    performSearch: async (query: string, apiKey: string): Promise<{ success: boolean; results: SearchResult[]; message: string }> => {
        return performSearchCore(query, apiKey);
    }
};

// ============================================
// Notion 集成模塊
// ============================================

export interface NotionDiaryEntry {
    title: string;
    content: string;
    mood?: string;
    date?: string;
    tags?: string[];
    characterName?: string;  // 角色名，用於區分不同角色的日記
}

export const NotionManager = {

    // Worker 代理地址（中心配置，用戶可在設置裡換成自部署實例）
    get WORKER_URL() { return getProxyWorkerUrl(); },

    /**
     * 測試 Notion 連接（通過 Worker 代理）
     */
    testConnection: async (apiKey: string, databaseId: string): Promise<{ success: boolean; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/database/${databaseId}`, {
                method: 'GET',
                headers: {
                    'X-Notion-API-Key': apiKey
                }
            });

            const text = await response.text();

            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: `連接失敗: ${errJson.error || errJson.message || response.status}` };
                } catch {
                    return { success: false, message: `連接失敗: ${response.status}` };
                }
            }

            try {
                const data = JSON.parse(text);
                return { success: true, message: `連接成功！數據庫: ${data.title?.[0]?.plain_text || databaseId}` };
            } catch {
                return { success: false, message: '返回格式錯誤' };
            }
        } catch (e: any) {
            const msg = String(e?.message || e);
            // fetch 在請求根本沒到達服務器時拋 TypeError（Safari 報 "Load failed"、
            // Chrome 報 "Failed to fetch"），說明是代理 Worker 不可達，不是 Notion 拒絕了 Key
            if (/load failed|failed to fetch|networkerror/i.test(msg)) {
                return { success: false, message: `無法連接到代理服務器 ${NotionManager.WORKER_URL}：請先在瀏覽器裡試試能否直接打開該地址。打不開說明當前網絡訪問不了它（換網絡/開代理後重試），或在「設置 → 網絡代理 (Worker)」填入自部署的 Worker 地址` };
            }
            return { success: false, message: `網絡錯誤: ${msg}` };
        }
    },

    /**
     * 創建日記頁面（通過 Worker 代理）- 花裡胡哨美化版 ✨
     * 支持 Markdown 格式的日記內容，自動轉換為豐富的 Notion blocks
     */
    createDiaryPage: async (
        apiKey: string,
        databaseId: string,
        entry: NotionDiaryEntry
    ): Promise<{ success: boolean; pageId?: string; url?: string; message: string }> => {
        try {
            const now = new Date();
            const dateStr = entry.date || getLocalDateKey(now);

            // 使用 markdown 解析器生成豐富的 Notion blocks
            const children = parseMarkdownToNotionBlocks(entry.content, entry.mood, entry.characterName);

            // 構建頁面數據，標題包含角色名便於篩選
            const titlePrefix = entry.characterName ? `[${entry.characterName}] ` : '';
            const moodEmoji = getMoodEmoji(entry.mood || '平靜');
            const pageData = {
                parent: { database_id: databaseId },
                icon: { emoji: moodEmoji },
                properties: {
                    'Name': {
                        title: [{ text: { content: `${titlePrefix}${entry.title || dateStr + ' 的日記'}` } }]
                    },
                    'Date': {
                        date: { start: dateStr }
                    }
                },
                children
            };

            const response = await fetch(`${NotionManager.WORKER_URL}/notion/pages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify(pageData)
            });

            const text = await response.text();

            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: `寫入失敗: ${errJson.error || errJson.message || response.status}` };
                } catch {
                    return { success: false, message: `寫入失敗: ${response.status}` };
                }
            }

            try {
                const data = JSON.parse(text);
                return {
                    success: true,
                    pageId: data.id,
                    url: data.url,
                    message: '日記已寫入Notion!'
                };
            } catch {
                return { success: false, message: '返回格式錯誤' };
            }
        } catch (e: any) {
            return { success: false, message: `網絡錯誤: ${e.message}` };
        }
    },

    /**
     * 獲取角色最近的日記（通過 Worker 代理）
     */
    getRecentDiaries: async (
        apiKey: string,
        databaseId: string,
        characterName: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify({
                    database_id: databaseId,
                    filter: {
                        property: 'Name',
                        title: {
                            starts_with: `[${characterName}]`
                        }
                    },
                    sorts: [{ property: 'Date', direction: 'descending' }],
                    page_size: limit
                })
            });

            const text = await response.text();

            if (!response.ok) {
                console.error('Query diaries failed:', response.status, text);
                return { success: false, entries: [], message: `查詢失敗: ${response.status}` };
            }

            const data = JSON.parse(text);

            if (!data.results || data.results.length === 0) {
                return { success: true, entries: [], message: '暫無日記' };
            }

            const entries: DiaryPreview[] = data.results.map((page: any) => {
                const title = page.properties?.Name?.title?.[0]?.plain_text || '無標題';
                // 移除角色名前綴，只保留實際標題
                const cleanTitle = title.replace(/^\[.*?\]\s*/, '');
                return {
                    id: page.id,
                    title: cleanTitle,
                    date: page.properties?.Date?.date?.start || '',
                    url: page.url
                };
            });

            return { success: true, entries, message: '獲取成功' };
        } catch (e: any) {
            console.error('Get diaries failed:', e);
            return { success: false, entries: [], message: `獲取失敗: ${e.message}` };
        }
    },

    /**
     * 按日期查找角色的日記（通過 Worker 代理）
     * 支持一天多篇日記，全部返回
     */
    getDiaryByDate: async (
        apiKey: string,
        databaseId: string,
        characterName: string,
        date: string  // YYYY-MM-DD
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        return notionGetDiaryByDate(apiKey, databaseId, characterName, date);
    },

    /**
     * 讀取日記頁面的完整內容（通過 Worker 代理）
     * 調用 /notion/blocks/:pageId 端點，將 blocks 轉換為可讀文本
     */
    readDiaryContent: async (
        apiKey: string,
        pageId: string
    ): Promise<{ success: boolean; content: string; message: string }> => {
        return notionReadDiaryContent(apiKey, pageId);
    },

    /**
     * 獲取用戶筆記列表（從用戶的筆記數據庫）
     * 讓角色能偶爾看到用戶寫的日常筆記，增加溫馨感
     */
    getUserNotes: async (
        apiKey: string,
        notesDatabaseId: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify({
                    database_id: notesDatabaseId,
                    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
                    page_size: limit
                })
            });

            const text = await response.text();

            if (!response.ok) {
                console.error('Query user notes failed:', response.status, text);
                return { success: false, entries: [], message: `查詢失敗: ${response.status}` };
            }

            const data = JSON.parse(text);

            if (!data.results || data.results.length === 0) {
                return { success: true, entries: [], message: '暫無筆記' };
            }

            const entries: DiaryPreview[] = data.results.map((page: any) => {
                const title = page.properties?.Name?.title?.[0]?.plain_text
                    || page.properties?.['名稱']?.title?.[0]?.plain_text
                    || page.properties?.Title?.title?.[0]?.plain_text
                    || '無標題';
                // 嘗試多種日期屬性名
                const date = page.properties?.Date?.date?.start
                    || page.properties?.['日期']?.date?.start
                    || page.last_edited_time?.split('T')[0]
                    || '';
                return {
                    id: page.id,
                    title,
                    date,
                    url: page.url || ''
                };
            });

            return { success: true, entries, message: '獲取成功' };
        } catch (e: any) {
            console.error('Get user notes failed:', e);
            return { success: false, entries: [], message: `獲取失敗: ${e.message}` };
        }
    },

    /**
     * 讀取用戶筆記頁面的完整內容
     * 複用 readDiaryContent 的邏輯（都是通過 pageId 讀 blocks）
     */
    readNoteContent: async (
        apiKey: string,
        pageId: string
    ): Promise<{ success: boolean; content: string; message: string }> => {
        // 和 readDiaryContent 一樣，通過 blocks 端點讀取
        return NotionManager.readDiaryContent(apiKey, pageId);
    },

    /**
     * 按關鍵詞搜索用戶筆記
     */
    searchUserNotes: async (
        apiKey: string,
        notesDatabaseId: string,
        keyword: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        return notionSearchUserNotes(apiKey, notesDatabaseId, keyword, limit);
    }
};

// 心情對應的 Emoji
function getMoodEmoji(mood: string): string {
    const moodMap: Record<string, string> = {
        'happy': '😊',
        'sad': '😢',
        'angry': '😠',
        'excited': '🎉',
        'tired': '😴',
        'calm': '😌',
        'anxious': '😰',
        'love': '❤️',
        'nostalgic': '🌅',
        'curious': '🔍',
        'grateful': '🙏',
        'confused': '😵‍💫',
        'proud': '✨',
        'lonely': '🌙',
        'hopeful': '🌈',
        'playful': '🎮',
        '開心': '😊',
        '難過': '😢',
        '生氣': '😠',
        '興奮': '🎉',
        '疲憊': '😴',
        '平靜': '😌',
        '焦慮': '😰',
        '愛': '❤️',
        '懷念': '🌅',
        '好奇': '🔍',
        '感恩': '🙏',
        '迷茫': '😵‍💫',
        '驕傲': '✨',
        '孤獨': '🌙',
        '期待': '🌈',
        '調皮': '🎮',
        '溫暖': '☀️',
        '感動': '🥹',
        '害羞': '😳',
        '無聊': '😑',
        '緊張': '😬',
        '滿足': '😌',
        '幸福': '🥰',
        '心動': '💓',
        '思念': '💭',
        '委屈': '🥺',
        '釋然': '🍃'
    };
    return lookupAnyScript(moodMap, mood.toLowerCase()) || '📝';
}

// 心情對應的顏色主題
function getMoodColorTheme(mood: string): { primary: string; secondary: string; accent: string } {
    const moodColors: Record<string, { primary: string; secondary: string; accent: string }> = {
        'happy': { primary: 'yellow_background', secondary: 'orange', accent: 'yellow' },
        'sad': { primary: 'blue_background', secondary: 'blue', accent: 'purple' },
        'angry': { primary: 'red_background', secondary: 'red', accent: 'orange' },
        'excited': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        'tired': { primary: 'gray_background', secondary: 'gray', accent: 'brown' },
        'calm': { primary: 'blue_background', secondary: 'blue', accent: 'green' },
        'anxious': { primary: 'purple_background', secondary: 'purple', accent: 'gray' },
        'love': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        '開心': { primary: 'yellow_background', secondary: 'orange', accent: 'yellow' },
        '難過': { primary: 'blue_background', secondary: 'blue', accent: 'purple' },
        '生氣': { primary: 'red_background', secondary: 'red', accent: 'orange' },
        '興奮': { primary: 'pink_background', secondary: 'orange', accent: 'red' },
        '疲憊': { primary: 'gray_background', secondary: 'gray', accent: 'brown' },
        '平靜': { primary: 'blue_background', secondary: 'blue', accent: 'green' },
        '焦慮': { primary: 'purple_background', secondary: 'purple', accent: 'gray' },
        '愛': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        '溫暖': { primary: 'yellow_background', secondary: 'orange', accent: 'brown' },
        '感動': { primary: 'pink_background', secondary: 'pink', accent: 'blue' },
        '害羞': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        '思念': { primary: 'purple_background', secondary: 'purple', accent: 'blue' },
        '幸福': { primary: 'yellow_background', secondary: 'pink', accent: 'orange' },
        '心動': { primary: 'pink_background', secondary: 'red', accent: 'pink' },
        '孤獨': { primary: 'gray_background', secondary: 'blue', accent: 'purple' },
        '期待': { primary: 'green_background', secondary: 'green', accent: 'blue' },
    };
    return lookupAnyScript(moodColors, mood.toLowerCase()) || { primary: 'blue_background', secondary: 'blue', accent: 'gray' };
}

// 裝飾性 emoji 池 - 根據心情隨機選取
function getDecorativeEmojis(mood: string): string[] {
    const moodDecorations: Record<string, string[]> = {
        'happy': ['🌟', '✨', '🎵', '🌻', '🍀', '🎈', '💫'],
        'sad': ['🌧️', '💧', '🍂', '🌊', '🕊️', '🌙'],
        'angry': ['🔥', '⚡', '💢', '🌪️', '💥'],
        'excited': ['🎉', '🎊', '🚀', '✨', '💥', '🎆', '⭐'],
        'love': ['💕', '💗', '🌹', '💝', '🦋', '🌸', '💖'],
        'calm': ['🍃', '☁️', '🌿', '🕊️', '💠', '🌊'],
        'tired': ['💤', '🌙', '☕', '🛏️', '😪'],
        '開心': ['🌟', '✨', '🎵', '🌻', '🍀', '🎈', '💫'],
        '難過': ['🌧️', '💧', '🍂', '🌊', '🕊️', '🌙'],
        '興奮': ['🎉', '🎊', '🚀', '✨', '💥', '🎆', '⭐'],
        '愛': ['💕', '💗', '🌹', '💝', '🦋', '🌸', '💖'],
        '平靜': ['🍃', '☁️', '🌿', '🕊️', '💠', '🌊'],
        '溫暖': ['☀️', '🌼', '🍵', '🧡', '🌅'],
        '思念': ['💭', '🌙', '⭐', '🌌', '📮'],
        '幸福': ['🥰', '🌈', '🌸', '💖', '✨'],
    };
    return lookupAnyScript(moodDecorations, mood.toLowerCase()) || ['📝', '✨', '💫', '🌟'];
}

function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================
// 解析內聯格式 (Markdown → Notion Rich Text)
// ============================================
function parseInlineFormatting(text: string): any[] {
    const richTexts: any[] = [];
    // 正則匹配: **bold**, *italic*, ~~strikethrough~~, `code`
    const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        // 前面的普通文本
        if (match.index > lastIndex) {
            richTexts.push({
                type: 'text',
                text: { content: text.slice(lastIndex, match.index) }
            });
        }

        if (match[2]) {
            // **bold**
            richTexts.push({
                type: 'text',
                text: { content: match[2] },
                annotations: { bold: true }
            });
        } else if (match[3]) {
            // *italic*
            richTexts.push({
                type: 'text',
                text: { content: match[3] },
                annotations: { italic: true }
            });
        } else if (match[4]) {
            // ~~strikethrough~~
            richTexts.push({
                type: 'text',
                text: { content: match[4] },
                annotations: { strikethrough: true }
            });
        } else if (match[5]) {
            // `code`
            richTexts.push({
                type: 'text',
                text: { content: match[5] },
                annotations: { code: true }
            });
        }

        lastIndex = match.index + match[0].length;
    }

    // 剩餘文本
    if (lastIndex < text.length) {
        richTexts.push({
            type: 'text',
            text: { content: text.slice(lastIndex) }
        });
    }

    if (richTexts.length === 0) {
        richTexts.push({ type: 'text', text: { content: text } });
    }

    return richTexts;
}

// ============================================
// Markdown → Notion Blocks 轉換器
// ============================================
function parseMarkdownToNotionBlocks(content: string, mood?: string, characterName?: string): any[] {
    const blocks: any[] = [];
    const lines = content.split('\n');
    const colors = getMoodColorTheme(mood || '平靜');
    const decorEmojis = getDecorativeEmojis(mood || '平靜');
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // ── 頂部: 心情橫幅 ──
    if (mood) {
        blocks.push({
            object: 'block', type: 'callout',
            callout: {
                rich_text: [{
                    type: 'text',
                    text: { content: `${pickRandom(decorEmojis)} 今日心情: ${mood} ${pickRandom(decorEmojis)}` },
                    annotations: { bold: true }
                }],
                icon: { emoji: getMoodEmoji(mood) },
                color: colors.primary
            }
        });
    }

    // ── 時間戳 ──
    blocks.push({
        object: 'block', type: 'quote',
        quote: {
            rich_text: [
                { type: 'text', text: { content: '🕐 ' }, annotations: { color: 'gray' } },
                { type: 'text', text: { content: `寫於 ${timeStr}` }, annotations: { italic: true, color: 'gray' } }
            ],
            color: 'gray'
        }
    });

    blocks.push({ object: 'block', type: 'divider', divider: {} });

    // ── 正文解析 ──
    let sectionIndex = 0;
    const sectionColors = ['default', colors.secondary, 'default', colors.accent, 'default'];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) continue; // 跳過空行

        // --- 或 *** → 分割線
        if (/^[-*]{3,}$/.test(trimmed)) {
            blocks.push({ object: 'block', type: 'divider', divider: {} });
            sectionIndex++;
            continue;
        }

        // # Heading 1
        if (trimmed.startsWith('# ')) {
            const headingText = trimmed.slice(2);
            blocks.push({
                object: 'block', type: 'heading_2',
                heading_2: {
                    rich_text: [
                        { type: 'text', text: { content: `${pickRandom(decorEmojis)} ` } },
                        { type: 'text', text: { content: headingText }, annotations: { bold: true, color: colors.secondary } }
                    ],
                    color: colors.primary
                }
            });
            continue;
        }

        // ## Heading 2
        if (trimmed.startsWith('## ')) {
            const headingText = trimmed.slice(3);
            blocks.push({
                object: 'block', type: 'heading_3',
                heading_3: {
                    rich_text: parseInlineFormatting(headingText),
                    color: colors.accent
                }
            });
            continue;
        }

        // ### Heading 3 → 用 callout 代替，更好看
        if (trimmed.startsWith('### ')) {
            const headingText = trimmed.slice(4);
            const bgColors = [colors.primary, 'green_background', 'purple_background', 'orange_background', 'pink_background'];
            blocks.push({
                object: 'block', type: 'callout',
                callout: {
                    rich_text: parseInlineFormatting(headingText),
                    icon: { emoji: pickRandom(decorEmojis) },
                    color: bgColors[sectionIndex % bgColors.length]
                }
            });
            continue;
        }

        // > quote
        if (trimmed.startsWith('> ')) {
            const quoteText = trimmed.slice(2);
            blocks.push({
                object: 'block', type: 'quote',
                quote: {
                    rich_text: parseInlineFormatting(quoteText),
                    color: colors.secondary
                }
            });
            continue;
        }

        // - bullet / * bullet
        if (/^[-*]\s/.test(trimmed)) {
            const bulletText = trimmed.slice(2);
            blocks.push({
                object: 'block', type: 'bulleted_list_item',
                bulleted_list_item: {
                    rich_text: parseInlineFormatting(bulletText),
                    color: sectionColors[sectionIndex % sectionColors.length]
                }
            });
            continue;
        }

        // 1. numbered list
        if (/^\d+\.\s/.test(trimmed)) {
            const numText = trimmed.replace(/^\d+\.\s/, '');
            blocks.push({
                object: 'block', type: 'numbered_list_item',
                numbered_list_item: {
                    rich_text: parseInlineFormatting(numText)
                }
            });
            continue;
        }

        // [!callout] 特殊 callout 語法
        if (trimmed.startsWith('[!') && trimmed.includes(']')) {
            const calloutMatch = trimmed.match(/^\[!(.+?)\]\s*(.*)/);
            if (calloutMatch) {
                const calloutType = calloutMatch[1];
                const calloutText = calloutMatch[2] || '';
                const calloutColorMap: Record<string, string> = {
                    'warning': 'orange_background', 'danger': 'red_background',
                    'info': 'blue_background', 'success': 'green_background',
                    'note': 'purple_background', 'tip': 'green_background',
                    'heart': 'pink_background', 'star': 'yellow_background',
                    '重要': 'red_background', '想法': 'purple_background',
                    '秘密': 'pink_background', '提醒': 'orange_background',
                    '開心': 'yellow_background', '難過': 'blue_background',
                };
                const calloutEmojiMap: Record<string, string> = {
                    'warning': '⚠️', 'danger': '🚨', 'info': 'ℹ️',
                    'success': '✅', 'note': '📝', 'tip': '💡',
                    'heart': '💖', 'star': '⭐',
                    '重要': '❗', '想法': '💭', '秘密': '🤫',
                    '提醒': '📌', '開心': '😊', '難過': '😢',
                };
                blocks.push({
                    object: 'block', type: 'callout',
                    callout: {
                        rich_text: parseInlineFormatting(calloutText),
                        icon: { emoji: calloutEmojiMap[calloutType] || '📌' },
                        color: calloutColorMap[calloutType] || colors.primary
                    }
                });
                continue;
            }
        }

        // 普通段落 - 帶隨機微妙顏色
        const currentColor = sectionIndex % 3 === 0 ? 'default' : sectionColors[sectionIndex % sectionColors.length];
        blocks.push({
            object: 'block', type: 'paragraph',
            paragraph: {
                rich_text: parseInlineFormatting(trimmed),
                color: currentColor
            }
        });
    }

    // ── 底部裝飾 ──
    blocks.push({ object: 'block', type: 'divider', divider: {} });

    // 簽名
    if (characterName) {
        blocks.push({
            object: 'block', type: 'paragraph',
            paragraph: {
                rich_text: [
                    { type: 'text', text: { content: `${pickRandom(decorEmojis)} ` } },
                    { type: 'text', text: { content: `—— ${characterName}` }, annotations: { italic: true, color: 'gray' } },
                    { type: 'text', text: { content: ` ${pickRandom(decorEmojis)}` } }
                ]
            }
        });
    }

    return normalizeBlocksForNotion(blocks);
}

// Notion API 硬限制：單個 rich_text content ≤ 2000 字符；單次 POST children ≤ 100。
// 留點 buffer 防 emoji / 雙字節邊界拼接。
const NOTION_MAX_RICH_TEXT_LEN = 1900;
const NOTION_MAX_CHILDREN = 100;

function splitRichTextItem(item: any): any[] {
    const content = item?.text?.content;
    if (typeof content !== 'string' || content.length <= NOTION_MAX_RICH_TEXT_LEN) return [item];
    const chunks: any[] = [];
    for (let i = 0; i < content.length; i += NOTION_MAX_RICH_TEXT_LEN) {
        chunks.push({
            ...item,
            text: { ...item.text, content: content.slice(i, i + NOTION_MAX_RICH_TEXT_LEN) }
        });
    }
    return chunks;
}

function normalizeBlocksForNotion(blocks: any[]): any[] {
    // 1. 每個 block 的 rich_text 切 2000 字符
    const safe = blocks.map(block => {
        const payload = block[block.type];
        if (payload && Array.isArray(payload.rich_text)) {
            const split: any[] = [];
            for (const item of payload.rich_text) split.push(...splitRichTextItem(item));
            return { ...block, [block.type]: { ...payload, rich_text: split } };
        }
        return block;
    });

    // 2. 總 block 數限制 100；超出截斷並附提示
    if (safe.length <= NOTION_MAX_CHILDREN) return safe;
    const truncated = safe.slice(0, NOTION_MAX_CHILDREN - 1);
    truncated.push({
        object: 'block',
        type: 'callout',
        callout: {
            rich_text: [{
                type: 'text',
                text: { content: `（日記內容過長，已截斷 ${safe.length - (NOTION_MAX_CHILDREN - 1)} 個段落）` },
                annotations: { italic: true, color: 'gray' }
            }],
            icon: { emoji: '✂️' },
            color: 'gray_background'
        }
    });
    return truncated;
}

// ============================================
// Notion Blocks → 可讀文本 轉換器
// ============================================
// ============================================
// 飛書多維表格 集成模塊 (中國區 Notion 替代)
// ============================================

export interface FeishuDiaryEntry {
    title: string;
    content: string;
    mood?: string;
    date?: string;
    characterName?: string;
}

/**
 * 飛書日記內容美化格式化器
 * 把 AI 寫的原始文本變成帶 emoji、分隔線、心情橫幅的漂亮文本
 */
function formatFeishuDiaryContent(content: string, mood?: string, characterName?: string): string {
    const moodEmoji = getMoodEmoji(mood || '平靜');
    const decorEmojis = getDecorativeEmojis(mood || '平靜');
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    const lines: string[] = [];

    // ── 心情橫幅 ──
    if (mood) {
        lines.push(`${pick(decorEmojis)} ━━━━━━━━━━━━━━━━━━ ${pick(decorEmojis)}`);
        lines.push(`${moodEmoji}  今日心情: ${mood}  ${moodEmoji}`);
        lines.push(`${pick(decorEmojis)} ━━━━━━━━━━━━━━━━━━ ${pick(decorEmojis)}`);
        lines.push('');
    }

    // ── 時間戳 ──
    lines.push(`🕐 寫於 ${timeStr}`);
    lines.push('');
    lines.push('─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─');
    lines.push('');

    // ── 正文處理 ──
    const contentLines = content.split('\n');
    for (const line of contentLines) {
        const trimmed = line.trim();
        if (!trimmed) {
            lines.push('');
            continue;
        }

        // # 大標題 → emoji 裝飾
        if (trimmed.startsWith('# ')) {
            lines.push('');
            lines.push(`${pick(decorEmojis)} 【${trimmed.slice(2)}】${pick(decorEmojis)}`);
            lines.push('');
            continue;
        }

        // ## 中標題
        if (trimmed.startsWith('## ')) {
            lines.push('');
            lines.push(`✦ ${trimmed.slice(3)}`);
            lines.push('');
            continue;
        }

        // ### 小標題
        if (trimmed.startsWith('### ')) {
            lines.push(`  ▸ ${trimmed.slice(4)}`);
            continue;
        }

        // > 引用
        if (trimmed.startsWith('> ')) {
            lines.push(`  ❝ ${trimmed.slice(2)} ❞`);
            continue;
        }

        // --- 分割線
        if (/^[-*]{3,}$/.test(trimmed)) {
            lines.push('');
            lines.push(`  ${pick(decorEmojis)} · · · · · · · · · ${pick(decorEmojis)}`);
            lines.push('');
            continue;
        }

        // - 列表
        if (/^[-*]\s/.test(trimmed)) {
            lines.push(`  ${pick(decorEmojis)} ${trimmed.slice(2)}`);
            continue;
        }

        // 1. 有序列表
        if (/^\d+\.\s/.test(trimmed)) {
            lines.push(`  ${trimmed}`);
            continue;
        }

        // [!callout] 特殊標記
        const calloutMatch = trimmed.match(/^\[!(.+?)\]\s*(.*)/);
        if (calloutMatch) {
            const calloutType = calloutMatch[1];
            const calloutText = calloutMatch[2] || '';
            const calloutEmojis: Record<string, string> = {
                'heart': '💖', 'star': '⭐', 'warning': '⚠️', 'danger': '🚨',
                'info': 'ℹ️', 'success': '✅', 'note': '📝', 'tip': '💡',
                '重要': '❗', '想法': '💭', '秘密': '🤫', '提醒': '📌',
                '開心': '😊', '難過': '😢',
            };
            const emoji = calloutEmojis[calloutType] || '📌';
            lines.push(`  ┊ ${emoji} ${calloutText}`);
            continue;
        }

        // 普通段落
        lines.push(trimmed);
    }

    // ── 底部裝飾 ──
    lines.push('');
    lines.push('─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─');

    if (characterName) {
        lines.push(`${pick(decorEmojis)} —— ${characterName} ${pick(decorEmojis)}`);
    }

    return lines.join('\n');
}

export const FeishuManager = {

    // Worker 代理地址（中心配置，用戶可在設置裡換成自部署實例）
    get WORKER_URL() { return getProxyWorkerUrl(); },

    /**
     * 獲取飛書 tenant_access_token（通過 Worker 代理，帶緩存）
     */
    getToken: async (appId: string, appSecret: string): Promise<{ success: boolean; token: string; message: string }> => {
        return feishuGetToken(appId, appSecret);
    },

    /**
     * 測試飛書連接（驗證憑據 + 列出數據表驗證權限）
     */
    testConnection: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string
    ): Promise<{ success: boolean; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, message: tokenResult.message };
            }

            // 用列出所有表的端點（飛書沒有獲取單個表的GET端點）
            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/tables`, {
                method: 'GET',
                headers: { 'X-Feishu-Token': tokenResult.token }
            });

            const text = await response.text();
            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: `連接失敗: ${errJson.msg || errJson.error || response.status}` };
                } catch {
                    return { success: false, message: `連接失敗: ${response.status}` };
                }
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, message: `飛書錯誤: ${data.msg || '請檢查多維表格權限'}` };
            }

            const tables = data.data?.items || [];
            const targetTable = tables.find((t: any) => t.table_id === tableId);
            if (targetTable) {
                return { success: true, message: `讀取連接成功！數據表: ${targetTable.name}。注意：這裡不創建測試記錄，新增記錄權限會在角色首次寫日記時驗證。` };
            } else {
                const tableNames = tables.map((t: any) => `${t.name}(${t.table_id})`).join(', ');
                return { success: false, message: `多維表格中未找到表 ${tableId}。可用表: ${tableNames || '無'}` };
            }
        } catch (e: any) {
            return { success: false, message: `網絡錯誤: ${e.message}` };
        }
    },

    /**
     * 創建日記記錄（寫入飛書多維表格）
     * 數據表需要字段: 標題(文本), 內容(文本), 日期(日期), 心情(文本), 角色(文本)
     */
    createDiaryRecord: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        entry: FeishuDiaryEntry
    ): Promise<{ success: boolean; recordId?: string; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, message: tokenResult.message };
            }

            const now = new Date();
            const dateStr = entry.date || getLocalDateKey(now);
            const dateTimestamp = new Date(dateStr).getTime();
            const titlePrefix = entry.characterName ? `[${entry.characterName}] ` : '';

            // 美化日記內容
            const formattedContent = formatFeishuDiaryContent(
                entry.content || '',
                entry.mood,
                entry.characterName
            );

            const fields: Record<string, any> = {
                '標題': `${getMoodEmoji(entry.mood || '平靜')} ${titlePrefix}${entry.title || dateStr + ' 的日記'}`,
                '內容': formattedContent,
                '日期': dateTimestamp,
                '心情': `${getMoodEmoji(entry.mood || '平靜')} ${entry.mood || '平靜'}`,
                '角色': entry.characterName || ''
            };

            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/${tableId}/records`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Feishu-Token': tokenResult.token
                },
                body: JSON.stringify({ fields })
            });

            const text = await response.text();
            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: formatFeishuWriteFailure(response.status, errJson) };
                } catch {
                    return { success: false, message: formatFeishuWriteFailure(response.status, { error: text }) };
                }
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, message: `飛書錯誤: ${data.msg || '寫入失敗'}` };
            }

            return {
                success: true,
                recordId: data.data?.record?.record_id,
                message: '日記已寫入飛書!'
            };
        } catch (e: any) {
            return { success: false, message: `網絡錯誤: ${e.message}` };
        }
    },

    /**
     * 獲取角色最近的日記
     */
    getRecentDiaries: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        characterName: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: FeishuDiaryPreview[]; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, entries: [], message: tokenResult.message };
            }

            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/${tableId}/records/search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Feishu-Token': tokenResult.token
                },
                body: JSON.stringify({
                    filter: {
                        conjunction: 'and',
                        conditions: [{
                            field_name: '角色',
                            operator: 'is',
                            value: [characterName]
                        }]
                    },
                    sort: [{ field_name: '日期', desc: true }],
                    page_size: limit
                })
            });

            const text = await response.text();
            if (!response.ok) {
                return { success: false, entries: [], message: `查詢失敗: ${response.status}` };
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, entries: [], message: `飛書錯誤: ${data.msg || '查詢失敗'}` };
            }

            const items = data.data?.items || [];
            if (items.length === 0) {
                return { success: true, entries: [], message: '暫無日記' };
            }

            const entries: FeishuDiaryPreview[] = items.map((item: any) => {
                const fields = item.fields || {};
                const rawTitle = (Array.isArray(fields['標題']) ? fields['標題']?.[0]?.text : fields['標題']) || '無標題';
                const cleanTitle = String(rawTitle).replace(/^\[.*?\]\s*/, '');
                const rawDate = fields['日期'];
                const rawDateText = typeof rawDate === 'string' ? rawDate.trim() : '';
                const parsedDate = rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDateText)
                    ? new Date(rawDate)
                    : null;
                const dateStr = rawDate
                    ? /^\d{4}-\d{2}-\d{2}$/.test(rawDateText)
                        ? rawDateText
                        : parsedDate && !Number.isNaN(parsedDate.getTime())
                            ? getLocalDateKey(parsedDate)
                            : ''
                    : '';

                return {
                    recordId: item.record_id,
                    title: cleanTitle,
                    date: dateStr,
                    content: (Array.isArray(fields['內容']) ? fields['內容']?.[0]?.text : fields['內容']) || ''
                };
            });

            return { success: true, entries, message: '獲取成功' };
        } catch (e: any) {
            return { success: false, entries: [], message: `獲取失敗: ${e.message}` };
        }
    },

    /**
     * 按日期查找角色的日記
     */
    getDiaryByDate: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        characterName: string,
        date: string  // YYYY-MM-DD
    ): Promise<{ success: boolean; entries: FeishuDiaryPreview[]; message: string }> => {
        return feishuGetDiaryByDate(appId, appSecret, baseId, tableId, characterName, date);
    },

    /**
     * 讀取指定記錄的日記內容
     * 飛書多維表格直接存儲在字段中，不需要像 Notion 一樣讀取 blocks
     */
    readDiaryContent: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        recordId: string
    ): Promise<{ success: boolean; content: string; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, content: '', message: tokenResult.message };
            }

            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/${tableId}/records/${recordId}`, {
                method: 'GET',
                headers: { 'X-Feishu-Token': tokenResult.token }
            });

            const text = await response.text();
            if (!response.ok) {
                return { success: false, content: '', message: `讀取失敗: ${response.status}` };
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, content: '', message: `飛書錯誤: ${data.msg || '讀取失敗'}` };
            }

            const fields = data.data?.record?.fields || {};
            const content = (Array.isArray(fields['內容']) ? fields['內容']?.[0]?.text : fields['內容']) || '（空白日記）';

            return { success: true, content: String(content), message: '讀取成功' };
        } catch (e: any) {
            return { success: false, content: '', message: `讀取失敗: ${e.message}` };
        }
    }
};

// ==================== 小紅書 Types ====================

export interface XhsNote {
    noteId: string;
    title: string;
    desc: string;
    likes: number;
    collects?: number;
    commentCount?: number;
    shareCount?: number;
    author: string;
    authorId: string;
    xsecToken?: string;
    coverUrl?: string;
    type?: string;  // 'normal' | 'video'
    comments?: {
        author: string;
        content: string;
        likes: number;
        commentId?: string;
        userId?: string;
    }[];
}
// XhsManager removed — all XHS ops go through xhsMcpClient.ts
