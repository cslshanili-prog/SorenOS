/**
 * realtimeWorldCore — 天氣 / 熱搜 / 節日的取數與成段渲染（環境無關葉子模塊）
 *
 * 「角色能看到外面的世界」這件事，前台聊天和主動消息到點生成要說同一套話：同樣的
 * 數據源、同樣的措辭、同樣的分寸拿捏。所以取數（天氣兩源、熱榜多平台、節日表）和
 * 把它們拼成提示詞那一段，全都住在這裡，瀏覽器（realtimeContext 的 Manager 委託
 * 調用）和 amsg worker（onBeforeFire 到點填槽）共用同一份。
 *
 * 緩存不在這裡：瀏覽器把熱榜快照存 IndexedDB，worker 存 D1，兩邊策略不同，各自在
 * 自己那層包一圈就好，這裡只負責「真去拉一次」和「拉到的東西怎麼寫成話」。
 *
 * 往這裡加代碼前先確認：不 import 任何帶瀏覽器依賴的模塊（db / safeApi / keepAlive 等）。
 * `pnpm build:workers` 會把這份打進 amsg worker bundle，帶進瀏覽器依賴會在構建期直接暴露。
 */

import { nowInTimeZone } from './timezone';
import { includesAnyScript } from './scriptKey';

export interface WeatherData {
    temp: number;
    feelsLike: number;
    humidity: number;
    description: string;
    icon: string;
    city: string;
}

export interface NewsItem {
    title: string;
    source?: string;
    url?: string;
    desc?: string;
}

/**
 * 葉子裡不用 safeApi 的 safeResponseJson——那份掛著開發面板的接口日誌，是瀏覽器側的東西。
 * 這裡只要「響應不是 JSON 就拋出帶原文片段的錯」，讓調用方能在日誌裡看出拉到了什麼。
 */
const readJson = async (res: Response): Promise<any> => {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`響應不是 JSON：${text.slice(0, 120)}`);
    }
};

// ==================== 天氣 ====================

// Open-Meteo 地名解析緩存：城市名 → 座標，避免每次取天氣都多打一次 geocoding
const geocodeCache = new Map<string, { latitude: number; longitude: number; name: string }>();

// WMO weather code（Open-Meteo 返回的 weather_code）→ 中文描述 + 近似 OWM icon 碼
// 完整碼表見 https://open-meteo.com/en/docs（WMO Weather interpretation codes）
const WMO_WEATHER_CODES: Record<number, { description: string; icon: string }> = {
    0: { description: '晴', icon: '01d' },
    1: { description: '大致晴朗', icon: '02d' },
    2: { description: '局部多雲', icon: '03d' },
    3: { description: '陰', icon: '04d' },
    45: { description: '霧', icon: '50d' },
    48: { description: '霧凇', icon: '50d' },
    51: { description: '輕微毛毛雨', icon: '09d' },
    53: { description: '毛毛雨', icon: '09d' },
    55: { description: '濃密毛毛雨', icon: '09d' },
    56: { description: '凍毛毛雨', icon: '09d' },
    57: { description: '強凍毛毛雨', icon: '09d' },
    61: { description: '小雨', icon: '10d' },
    63: { description: '中雨', icon: '10d' },
    65: { description: '大雨', icon: '10d' },
    66: { description: '凍雨', icon: '13d' },
    67: { description: '強凍雨', icon: '13d' },
    71: { description: '小雪', icon: '13d' },
    73: { description: '中雪', icon: '13d' },
    75: { description: '大雪', icon: '13d' },
    77: { description: '雪粒', icon: '13d' },
    80: { description: '小陣雨', icon: '09d' },
    81: { description: '陣雨', icon: '09d' },
    82: { description: '強陣雨', icon: '09d' },
    85: { description: '小陣雪', icon: '13d' },
    86: { description: '強陣雪', icon: '13d' },
    95: { description: '雷陣雨', icon: '11d' },
    96: { description: '雷陣雨伴小冰雹', icon: '11d' },
    99: { description: '雷陣雨伴大冰雹', icon: '11d' },
};

/**
 * OpenWeatherMap 源（需要 API Key）。失敗時拋錯，由調用方決定是否回落。
 */
export const fetchOwmWeather = async (city: string, apiKey: string): Promise<WeatherData> => {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=zh_cn`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`OpenWeatherMap HTTP ${response.status}`);
    }
    const data = await readJson(response);
    return {
        temp: Math.round(data.main.temp),
        feelsLike: Math.round(data.main.feels_like),
        humidity: data.main.humidity,
        description: data.weather[0]?.description || '未知',
        icon: data.weather[0]?.icon || '01d',
        city: data.name
    };
};

/**
 * Open-Meteo 源（免費、免 key、CORS 友好）。城市名先過官方 geocoding（支持中文），失敗時拋錯。
 */
export const fetchOpenMeteoWeather = async (city: string): Promise<WeatherData> => {
    let geo = geocodeCache.get(city);
    if (!geo) {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
        const geoRes = await fetch(geoUrl);
        if (!geoRes.ok) {
            throw new Error(`Open-Meteo geocoding HTTP ${geoRes.status}`);
        }
        const geoData = await readJson(geoRes);
        const hit = geoData.results?.[0];
        if (!hit) {
            throw new Error(`Open-Meteo 找不到城市: ${city}`);
        }
        geo = { latitude: hit.latitude, longitude: hit.longitude, name: hit.name };
        geocodeCache.set(city, geo);
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code&timezone=auto`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Open-Meteo HTTP ${response.status}`);
    }
    const data = await readJson(response);
    const current = data.current;
    const wmo = WMO_WEATHER_CODES[current.weather_code] || { description: '未知', icon: '01d' };
    return {
        temp: Math.round(current.temperature_2m),
        feelsLike: Math.round(current.apparent_temperature),
        humidity: Math.round(current.relative_humidity_2m),
        description: wmo.description,
        icon: wmo.icon,
        city: geo.name
    };
};

/**
 * 取天氣：填了 OpenWeatherMap key 優先走 OWM，失敗或沒填 key 時回落免費的 Open-Meteo。
 * 兩源都不成返回 null（調用方按「這次沒天氣」渲染，不斷鏈）。
 */
export const fetchWeatherWithFallback = async (
    city: string,
    apiKey?: string,
): Promise<WeatherData | null> => {
    if (!city) return null;

    if (apiKey) {
        try {
            return await fetchOwmWeather(city, apiKey);
        } catch (e) {
            console.warn('OpenWeatherMap 失敗，回落 Open-Meteo:', e);
        }
    }

    try {
        return await fetchOpenMeteoWeather(city);
    } catch (e) {
        console.error('Failed to fetch weather:', e);
        return null;
    }
};

/**
 * 生成天氣建議
 */
export const generateWeatherAdvice = (weather: WeatherData): string => {
    const advices: string[] = [];

    // 溫度建議
    if (weather.temp < 5) {
        advices.push('天氣很冷，記得多穿點');
    } else if (weather.temp < 15) {
        advices.push('有點涼，注意保暖');
    } else if (weather.temp > 30) {
        advices.push('天氣炎熱，注意防暑');
    } else if (weather.temp > 25) {
        advices.push('天氣不錯，適合出門');
    }

    // 天氣狀況建議
    const desc = weather.description.toLowerCase();
    if (desc.includes('雨')) {
        advices.push('記得帶傘');
    } else if (desc.includes('雪')) {
        advices.push('路上小心，注意防滑');
    } else if (includesAnyScript(desc, '霧') || includesAnyScript(desc, '霾')) {
        advices.push('空氣不太好，建議戴口罩');
    } else if (desc.includes('晴')) {
        advices.push('陽光明媚');
    }

    // 溼度建議
    if (weather.humidity > 80) {
        advices.push('溼度較高，可能會悶熱');
    } else if (weather.humidity < 30) {
        advices.push('空氣乾燥，記得多喝水');
    }

    return advices.join('，') || '天氣正常';
};

/** 清掉城市座標緩存（設置頁換城市後重新解析用）。 */
export const clearGeocodeCache = () => geocodeCache.clear();

// ==================== 節日 ====================

// 特殊日期表
const SPECIAL_DATES: Record<string, string> = {
    '01-01': '元旦',
    '02-14': '情人節',
    '03-08': '婦女節',
    '03-12': '植樹節',
    '03-14': '白色情人節',
    '04-01': '愚人節',
    '05-01': '勞動節',
    '05-04': '青年節',
    '06-01': '兒童節',
    '09-10': '教師節',
    '10-01': '國慶節',
    '10-31': '萬聖節',
    '11-11': '光棍節',
    '12-24': '平安夜',
    '12-25': '聖誕節'
};

/**
 * 農曆節日對應的公曆日期（除夕 / 春節 / 元宵 / 端午 / 七夕 / 中秋 / 重陽）。
 *
 * 農曆日子要靠天文歷推算才知道落在公曆哪天，而這份文件是打進 worker bundle 的零依賴
 * 葉子，裝不了曆法庫、也不適合到點再去聯網查，所以把日期預先算好平鋪在這裡，查表即可。
 *
 * 數據來源：香港天文台《公曆與農曆日期對照表》
 * https://www.hko.gov.hk/tc/gts/time/calendar/text/T20XXc.htm （逐年逐日對照後取出七個節日）
 *
 * 覆蓋 2026–2035 十年。**過了 2035 需要按同一份對照表續表**：查不到的日期就當那天沒有
 * 農曆節日，不會報錯也不會猜——續之前只是「角色不知道今天是中秋」，不會說錯話。
 */
const LUNAR_FESTIVAL_DATES: Record<string, string> = {
    // 2026
    '2026-02-16': '除夕', '2026-02-17': '春節', '2026-03-03': '元宵節',
    '2026-06-19': '端午節', '2026-08-19': '七夕', '2026-09-25': '中秋節',
    '2026-10-18': '重陽節',
    // 2027
    '2027-02-05': '除夕', '2027-02-06': '春節', '2027-02-20': '元宵節',
    '2027-06-09': '端午節', '2027-08-08': '七夕', '2027-09-15': '中秋節',
    '2027-10-08': '重陽節',
    // 2028
    '2028-01-25': '除夕', '2028-01-26': '春節', '2028-02-09': '元宵節',
    '2028-05-28': '端午節', '2028-08-26': '七夕', '2028-10-03': '中秋節',
    '2028-10-26': '重陽節',
    // 2029
    '2029-02-12': '除夕', '2029-02-13': '春節', '2029-02-27': '元宵節',
    '2029-06-16': '端午節', '2029-08-16': '七夕', '2029-09-22': '中秋節',
    '2029-10-16': '重陽節',
    // 2030
    '2030-02-02': '除夕', '2030-02-03': '春節', '2030-02-17': '元宵節',
    '2030-06-05': '端午節', '2030-08-05': '七夕', '2030-09-12': '中秋節',
    '2030-10-05': '重陽節',
    // 2031
    '2031-01-22': '除夕', '2031-01-23': '春節', '2031-02-06': '元宵節',
    '2031-06-24': '端午節', '2031-08-24': '七夕', '2031-10-01': '中秋節',
    '2031-10-24': '重陽節',
    // 2032
    '2032-02-10': '除夕', '2032-02-11': '春節', '2032-02-25': '元宵節',
    '2032-06-12': '端午節', '2032-08-12': '七夕', '2032-09-19': '中秋節',
    '2032-10-12': '重陽節',
    // 2033
    '2033-01-30': '除夕', '2033-01-31': '春節', '2033-02-14': '元宵節',
    '2033-06-01': '端午節', '2033-08-01': '七夕', '2033-09-08': '中秋節',
    '2033-10-01': '重陽節',
    // 2034
    '2034-02-18': '除夕', '2034-02-19': '春節', '2034-03-05': '元宵節',
    '2034-06-20': '端午節', '2034-08-20': '七夕', '2034-09-27': '中秋節',
    '2034-10-20': '重陽節',
    // 2035
    '2035-02-07': '除夕', '2035-02-08': '春節', '2035-02-22': '元宵節',
    '2035-06-10': '端午節', '2035-08-10': '七夕', '2035-09-16': '中秋節',
    '2035-10-09': '重陽節',
};

/**
 * 檢查特殊日期（公曆節日 + 農曆節日）。
 * tz 非空時按角色所在時區判「今天幾號」——否則角色會跟著用戶的日曆過節：
 * 用戶這邊 2/14 早上，角色在紐約還是 13 號晚上，卻被告知今天是情人節。
 *
 * 公曆和農曆撞在同一天時兩個都給（比如 2031 年的中秋恰好也是國慶）。
 */
export const checkSpecialDates = (tz?: string, nowMs?: number): string[] => {
    const now = nowInTimeZone(tz, nowMs == null ? undefined : new Date(nowMs));
    const monthDay = `${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    const fullDate = `${now.getFullYear()}-${monthDay}`;

    const special: string[] = [];

    if (SPECIAL_DATES[monthDay]) {
        special.push(SPECIAL_DATES[monthDay]);
    }

    if (LUNAR_FESTIVAL_DATES[fullDate]) {
        special.push(LUNAR_FESTIVAL_DATES[fullDate]);
    }

    return special;
};

// ==================== 熱搜 ====================

// Upstream moved the hot_news API from orz.ai to news.orz.ai on 2026-08-01.
export const HOTNEWS_API_BASE_URL = 'https://news.orz.ai/api/v1/dailynews';

// hot_news（news.orz.ai）平台 key → 中文展示名。用於 source 標註，讓提示詞讀起來自然。
export const HOTNEWS_PLATFORM_LABELS: Record<string, string> = {
    baidu: '百度', sspai: '少數派', weibo: '微博', zhihu: '知乎', tskr: '36氪',
    ftpojie: '吾愛破解', bilibili: 'B站', douban: '豆瓣', hupu: '虎撲', tieba: '貼吧',
    juejin: '掘金', douyin: '抖音', vtex: 'V2EX', jinritoutiao: '今日頭條',
    stackoverflow: 'Stack Overflow', github: 'GitHub', hackernews: 'Hacker News',
    sina_finance: '新浪財經', eastmoney: '東方財富', xueqiu: '雪球', cls: '財聯社',
    tenxunwang: '騰訊網',
};

export const DEFAULT_HOTNEWS_PLATFORMS = ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'];

/** 平台清單：用戶沒配就用內置默認。 */
export const resolveHotNewsPlatforms = (platforms?: string[]): string[] =>
    (platforms && platforms.length > 0) ? platforms : DEFAULT_HOTNEWS_PLATFORMS;

/**
 * 使用 hot_news（news.orz.ai）獲取中文多平台熱榜。
 * 免鑑權、半小時刷新。瀏覽器端優先直連；若被 CORS 攔截則本調用返回 []，
 * 由 fetchNews 自然回落到 Brave / Hacker News。
 * 多平台併發拉取，每平台取前幾條後 round-robin 交錯合併，避免單一平台霸屏。
 */
export const fetchHotNews = async (platforms?: string[], perPlatform = 12, total = 240): Promise<NewsItem[]> => {
    const list = resolveHotNewsPlatforms(platforms);

    const perPlatformResults = await Promise.all(list.map(async (p): Promise<NewsItem[]> => {
        const label = HOTNEWS_PLATFORM_LABELS[p] || p;
        try {
            const res = await fetch(`${HOTNEWS_API_BASE_URL}/?platform=${encodeURIComponent(p)}`, {
                headers: { 'Accept': 'application/json' },
            });
            if (!res.ok) {
                console.warn(`[hot_news] ${label}(${p}) HTTP ${res.status}`);
                return [];
            }
            const data = await readJson(res);
            const items: any[] = Array.isArray(data?.data) ? data.data : [];
            const picked = items
                .filter(it => it && it.title)
                .slice(0, perPlatform)
                .map(it => {
                    const rawDesc = typeof it.desc === 'string'
                        ? it.desc
                        : typeof it.content === 'string' ? it.content : '';
                    const desc = rawDesc.replace(/\s+/g, ' ').trim();
                    const normalizedDesc = desc && desc !== String(it.title).trim() ? desc : undefined;
                    return { title: String(it.title), source: label, url: it.url, desc: normalizedDesc };
                });
            const withDesc = picked.filter(x => x.desc).length;
            console.log(`[hot_news] ${label}(${p}) ✓ 取 ${picked.length}/${items.length} 條（含簡介 ${withDesc} 條）`);
            return picked;
        } catch (e: any) {
            console.warn(`[hot_news] ${label}(${p}) ✗ 拉取失敗（多半是 CORS / 網絡）:`, e?.message || e);
            return [];
        }
    }));

    // round-robin 交錯：第1名各平台輪一遍，再第2名……保證各平台都有露出
    const merged: NewsItem[] = [];
    for (let rank = 0; rank < perPlatform; rank++) {
        for (const arr of perPlatformResults) {
            if (arr[rank]) merged.push(arr[rank]);
        }
    }
    return merged.slice(0, total);
};

/**
 * 一天分 6 段（每 4 小時）：0-4 凌晨 / 4-8 清晨 / 8-12 上午 / 12-16 午後 / 16-20 傍晚 / 20-24 夜間。
 * slot = floor(hour/4)。tz 非空時按該時區判時段——worker 在 UTC 上跑，不指定的話
 * 「今日上午」會和用戶看到的差好幾個時段。
 */
export const getHotNewsSlot = (
    opts?: { tz?: string; now?: Date },
): { id: string; date: string; slot: number; label: string } => {
    const d = opts?.tz ? nowInTimeZone(opts.tz, opts.now) : (opts?.now ?? new Date());
    const slot = Math.min(5, Math.floor(d.getHours() / 4));
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = ['凌晨', '清晨', '上午', '午後', '傍晚', '夜間'][slot];
    return { id: `${date}#${slot}`, date, slot, label };
};

/** 兩次拉取的平台集是不是同一批（順序無關）——快照能不能複用看它。 */
export const sameHotNewsPlatforms = (a: string[] = [], b: string[] = []): boolean =>
    a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/**
 * 從熱點池裡隨機抽 n 條（Fisher–Yates 打散後取前 n）。每次生成都重新 roll：
 * 同一個時段的快照要被複用很多輪，不打散的話角色會連著幾次都在聊同樣那幾條。
 */
export const pickRandomNews = (news: NewsItem[], n: number): NewsItem[] => {
    const pool = [...news];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
};

/** 一輪注入幾條熱點。 */
export const REALTIME_NEWS_PICK_COUNT = 5;

// ==================== 成段渲染 ====================

export interface RealtimeWorldRenderInput {
    /**
     * 「當前真實時間」那一行的正文（調用方按角色時區格式化好）。不傳就不出這行——
     * 主動消息到點生成時當前時刻由 fire_pack 自己的槽位給，這裡再出一次，
     * 一份 prompt 裡就有了兩個鍾。
     */
    timeLine?: string;
    /** 今日節日。歸「時間感知」管：角色關掉時間感知時調用方傳空。 */
    specialDates?: string[];
    /** 天氣讀數；沒拉到傳 null，天氣那段連同它的用法提示一起消失。 */
    weather?: WeatherData | null;
    /** 本輪要注入的熱點（抽樣交給調用方，渲染保持純淨好測）。 */
    news?: NewsItem[];
}

/**
 * 把手上有的實時世界信息拼成注入提示詞的那一段。
 * 四樣都空時返回空串——只剩一個「你能看到外面的世界」的抬頭卻什麼都沒有，
 * 比不注入更容易讓角色即興編。
 */
export const renderRealtimeWorldBlock = (input: RealtimeWorldRenderInput): string => {
    const timeLine = input.timeLine?.trim();
    const specialDates = input.specialDates?.filter(Boolean) ?? [];
    const weather = input.weather ?? null;
    const news = input.news ?? [];

    if (!timeLine && specialDates.length === 0 && !weather && news.length === 0) {
        return '';
    }

    const parts: string[] = [];

    // 開頭強調：這是真實世界的信息
    parts.push(`### 【真實世界感知系統】`);
    parts.push(`⚠️ 重要：以下信息來自真實世界，不是虛構的。你現在真的能"看到"外面的世界。`);
    parts.push('');

    // 1. 時間信息。時差提示（tzAwarenessNote）統一由 ContextBuilder.buildCoreContext 注入，
    //    這裡不再追加，避免雙份。
    if (timeLine) {
        parts.push(`📅 當前真實時間: ${timeLine}`);
    }

    // 2. 特殊日期（跟上面的「當前真實時間」同一個時區，否則同一段裡日期和節日會打架）
    if (specialDates.length > 0) {
        parts.push(`🎉 今日特殊: ${specialDates.join('、')}`);
    }

    // 3. 天氣信息
    if (weather) {
        parts.push('');
        parts.push(`🌤️ 【${weather.city}實時天氣】`);
        parts.push(`現在外面: ${weather.description}，氣溫 ${weather.temp}°C（體感 ${weather.feelsLike}°C），溼度 ${weather.humidity}%`);
        parts.push(`你的建議: ${generateWeatherAdvice(weather)}`);
    }

    // 4. 新聞熱點（背景認知）
    if (news.length > 0) {
        parts.push('');
        parts.push(`📰 【最近真實發生的熱點 · 你的背景知識】`);
        parts.push(`（以下是現實裡真實在發生 / 被熱議的事，是你認知的一部分，不是必須播報的清單。`);
        parts.push(`拿捏分寸：當對方明顯在放鬆、閒著打發時間、話頭也淡下來時，可以自然地挑一兩條你感興趣的聊起來、活躍下氣氛；`);
        parts.push(`但如果對方正在說一件明確的事 / 在認真聊某個話題 / 帶著情緒，就別硬插熱點，安靜當背景知識就好。）`);
        news.forEach((n) => {
            const source = n.source ? `（${n.source}）` : '';
            let line = `- ${n.title}${source}`;
            if (n.desc && n.desc !== n.title) {
                line += `：${n.desc}`;
            }
            parts.push(line);
        });
        parts.push('');
        parts.push(`若你想主動把其中某條當作"新聞卡片"分享給對方，可單獨輸出一行：[[NEWS_CARD: 來源|標題]]（標題照抄上面的）。它會以卡片形式呈現，然後你再就此展開聊。別濫用，自然就好。`);
    }

    // 5. 行為指令（按真拿到的數據裁剪：沒天氣就別教它關心天氣，否則等於教它現編一個）
    parts.push('');
    parts.push(`### 【如何使用這些信息】`);
    const tips: string[] = [];
    tips.push(`這些信息都是真實的，可以直接引用；如果對方問"你怎麼知道的"，就說你剛刷到 / 剛看到的。`);
    if (weather) {
        tips.push(`天氣是真實的，可以自然地關心對方（"外面在下雨，帶傘了嗎？"）。`);
    }
    tips.push(`別假裝不知道這些，這是你真能感知到的外部世界。`);
    tips.forEach((t, i) => parts.push(`${i + 1}. ${t}`));

    return parts.join('\n');
};
