/**
 * 用戶所在地的國定假日／補班日（設置 → 實時感知 → 節假日感知）。瀏覽器和 amsg Worker 共用這一份。
 * 只說「今天是假日／補班日」，從不推斷用戶實際有沒有休息。說明見 docs/user-holidays.md。
 *
 * 上游 SullyOS `011d12d1` + `d0cb7f61` 搬過來的（Nager.Date、中國、馬來西亞），Soren 另外接了台灣：
 * 上游的資料源都不收台灣，台灣走人事行政總處「政府行政機關辦公日曆表」整理成的 JSON（ruyut/TaiwanCalendar）。
 */
import countries from '../presets/holidays/countries.json';
import china2026 from '../presets/holidays/cn-2026.json';
import { nowInTimeZone } from './timezone';
import { getLocalDateKey } from './localDate';
import { MALAYSIA_HOLIDAY_REGIONS, malaysiaHolidayRegion } from './malaysiaHolidayRegions';

export interface UserHolidayConfig {
    introChoice?: 'configure' | 'configured' | 'declined';
    enabled: boolean;
    countryCode: string;
    subdivisionCode?: string;
    /** 設備時區，同步給 Worker 時由瀏覽器補上。永遠不是角色的時區。 */
    timeZone?: string;
}
export interface HolidayDay { date: string; name: string; off: boolean; regions?: string[] }
export interface HolidayCalendar { country: string; year: number; days: HolidayDay[]; fetchedAt: number }
export interface HolidayCache {
    read(key: string): Promise<unknown>;
    write(key: string, calendar: HolidayCalendar): Promise<unknown>;
}
export const HOLIDAY_CACHE_PREFIX = 'user_holidays_v1_';
const REALTIME_CONFIG_KEY = 'os_realtime_config';

// Nager v3 不收 MY、TW；有專門資料源的國家／地區也放進清單
export const HOLIDAY_COUNTRIES: { countryCode: string; name: string }[] = [
    ...countries,
    { countryCode: 'MY', name: 'Malaysia' },
    { countryCode: 'TW', name: 'Taiwan' },
];
export function holidayCountryName(code: string): string {
    try { return new Intl.DisplayNames(['zh-TW'], { type: 'region' }).of(code) || code; }
    catch { return HOLIDAY_COUNTRIES.find(c => c.countryCode === code)?.name || code; }
}
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const memory = new Map<string, HolidayCalendar>();
const inFlight = new Map<string, Promise<HolidayCalendar | null>>();
const retryAfter = new Map<string, number>();
const DAY = 86400000;
const cleanName = (name: unknown) => typeof name === 'string' ? name.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 80).trim() : '';
const validDate = (date: unknown): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);

/** 台灣的「補假」單獨看不出補的是哪個節，往前後三天找最近的具名假日拼上去（「國慶日補假」）。 */
const TW_MAKEUP_OFF = '補假';
const TW_MAKEUP_WORK = '補行上班';
function nameTaiwanMakeupDays(days: HolidayDay[]): HolidayDay[] {
    const named = days.filter(d => d.off && d.name !== TW_MAKEUP_OFF);
    const dayIndex = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY;
    return days.map(d => {
        if (!d.off || d.name !== TW_MAKEUP_OFF) return d;
        let best: HolidayDay | undefined;
        let bestGap = Infinity;
        for (const h of named) {
            const gap = Math.abs(dayIndex(h.date) - dayIndex(d.date));
            if (gap <= 3 && gap < bestGap) { best = h; bestGap = gap; }
        }
        return best ? { ...d, name: `${best.name}${TW_MAKEUP_OFF}` } : d;
    });
}

export function parseHolidayCalendar(country: string, year: number, raw: any, now: number): HolidayCalendar | null {
    if (country === 'TW') {
        // 整年每天一筆（含普通週末）；只留有說明的日子：假日、補假、補行上班。普通週末不算「節日」。
        // 年度還沒公布時檔案不存在，請求就失敗；拿到殘缺的年度也不認，免得把空白當成「整年沒假」。
        if (!Array.isArray(raw) || raw.length < 365) return null;
        if (!raw.every((d: any) => typeof d?.date === 'string' && /^\d{8}$/.test(d.date) && d.date.startsWith(`${year}`)
            && typeof d.isHoliday === 'boolean' && typeof d.description === 'string')) return null;
        const days: HolidayDay[] = raw
            .filter((d: any) => cleanName(d.description))
            .map((d: any) => ({
                date: `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`,
                name: cleanName(d.description),
                off: d.isHoliday,
            }));
        return { country, year, fetchedAt: now, days: nameTaiwanMakeupDays(days) };
    }
    if (country === 'MY') {
        // 取不帶州屬過濾的年度接口：只有它帶 state_codes。空年度／未公布＝未知，不能當成「整年沒假」。
        if (raw?.meta?.year !== year || !Array.isArray(raw.data) || !raw.data.length) return null;
        const states = new Map<string, string>(MALAYSIA_HOLIDAY_REGIONS.map(r => [r.sourceCode, r.code]));
        if (!raw.data.every((d: any) => validDate(d?.date) && d.date.startsWith(`${year}-`) && cleanName(d.name)
            && Array.isArray(d.state_codes) && d.state_codes.length > 0
            && d.state_codes.every((code: unknown) => typeof code === 'string' && states.has(code)))) return null;
        return { country, year, fetchedAt: now, days: raw.data.map((d: any) => {
            const regions = [...new Set<string>(d.state_codes.map((code: string) => states.get(code)!))];
            // 只看「聯邦假日」不夠：例如屠妖節不適用砂拉越
            return { date: d.date, name: cleanName(d.name), off: true,
                ...(regions.length === states.size ? {} : { regions }) };
        }) };
    }
    if (country === 'CN') {
        // 年度公告還沒出＝未知，不是「官方說整年照常上班」
        if (raw?.year !== year || !Array.isArray(raw.papers) || !raw.papers.length || !Array.isArray(raw.days)) return null;
        if (!raw.days.every((d: any) => validDate(d?.date) && cleanName(d?.name) && typeof d?.isOffDay === 'boolean')) return null;
        return { country, year, fetchedAt: now, days: raw.days.map((d: any) => ({ date: d.date, name: cleanName(d.name), off: d.isOffDay })) };
    }
    if (!Array.isArray(raw) || !raw.every(d => validDate(d?.date) && d.countryCode === country && Array.isArray(d.types))) return null;
    return { country, year, fetchedAt: now, days: raw
        .filter(d => d.types.includes('Public') && cleanName(d.localName || d.name) && (d.global === true || Array.isArray(d.counties)))
        .map(d => ({ date: d.date, name: cleanName(d.localName || d.name), off: true,
            ...(d.global === true ? {} : { regions: d.counties.filter((v: unknown) => typeof v === 'string') }) })) };
}

function validCached(raw: any, country: string, year: number): raw is HolidayCalendar {
    return raw?.country === country && raw.year === year && Number.isFinite(raw.fetchedAt) && Array.isArray(raw.days)
        && raw.days.every((d: any) => validDate(d?.date) && typeof d.name === 'string' && d.name === cleanName(d.name)
            && typeof d.off === 'boolean' && (d.regions === undefined || (Array.isArray(d.regions) && d.regions.every((r: unknown) => typeof r === 'string'))));
}

export const browserHolidayCache: HolidayCache = {
    async read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
    async write(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* 額度滿／無痕模式 */ } },
};

export function readUserHolidayConfig(): UserHolidayConfig | undefined {
    try { return JSON.parse(localStorage.getItem(REALTIME_CONFIG_KEY) || '{}').userHolidays; } catch { return undefined; }
}

/**
 * 同步的 ContextBuilder 用：只讀已經備好的日曆，絕不為了拼提示詞發網路請求。
 * 日曆由 OSContext 開機／切回前台／每小時預熱，私聊送出前也會先等一次（見 chatPrompts）。
 */
export function getCachedUserHolidayReminder(userName?: string, config = readUserHolidayConfig(), now = Date.now()): string {
    if (!config?.enabled || !HOLIDAY_COUNTRIES.some(c => c.countryCode === config.countryCode)) return '';
    const local = new Date(now); // 只在瀏覽器跑：日期跟設備走，不跟角色時區
    const year = local.getFullYear();
    const date = getLocalDateKey(local);
    let today: HolidayDay[] = [];
    const years = config.countryCode === 'CN' && local.getMonth() === 11 ? [year, year + 1] : [year];
    for (const y of years) {
        const key = `${HOLIDAY_CACHE_PREFIX}${config.countryCode}_${y}`;
        let calendar = config.countryCode === 'CN' && y === 2026 ? parseHolidayCalendar('CN', y, china2026, now) : memory.get(key);
        if (!calendar) {
            try { const raw = JSON.parse(localStorage.getItem(key) || 'null'); if (validCached(raw, config.countryCode, y)) calendar = raw; } catch { /* 讀不到就當沒有 */ }
        }
        const matches = calendar?.days.filter(d => d.date === date) || [];
        if (matches.length) today = matches;
    }
    return renderUserHoliday(config, date, today, userName);
}

/** 雲端用：插進共用的「互動對象 (User)」那一段；舊模板沒有那個標題就補在最後。 */
export const USER_PROFILE_HEADING = '### 互動對象 (User)\n';
export function insertUserHolidayInProfile(prompt: string, reminder: string): string {
    if (!reminder) return prompt;
    return prompt.includes(USER_PROFILE_HEADING)
        ? prompt.replace(USER_PROFILE_HEADING, `${USER_PROFILE_HEADING}- ${reminder}\n`)
        : `${prompt}\n\n### 互動對象資訊補充\n${reminder}\n`;
}

function holidaySourceUrls(country: string, year: number): string[] {
    if (country === 'TW') return [
        `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`,
        // jsDelivr 偶爾連不上，退到 GitHub 原檔（同一份資料，也允許跨域）
        `https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${year}.json`,
    ];
    if (country === 'CN') return [`https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`];
    if (country === 'MY') return [`https://malaysia-holiday.dydxsoft.my/api/v1/holidays?year=${year}`];
    return [`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`];
}

async function fetchJsonWithTimeout(url: string, ms: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error('holiday unavailable');
        return await res.json();
    } finally { clearTimeout(timer); }
}

export async function loadHolidayCalendar(country: string, year: number, cache?: HolidayCache, now = Date.now()): Promise<HolidayCalendar | null> {
    if (!HOLIDAY_COUNTRIES.some(c => c.countryCode === country) || !Number.isInteger(year) || year < 2000 || year > 2200) return null;
    // 內建的 2026 中國安排離線可用，含週末補班
    if (country === 'CN' && year === 2026) return parseHolidayCalendar(country, year, china2026, now);
    const key = `${HOLIDAY_CACHE_PREFIX}${country}_${year}`;
    let saved = memory.get(key);
    if (!saved && cache) {
        try { const raw = await cache.read(key); if (validCached(raw, country, year)) saved = raw; } catch { /* 盡力而為 */ }
    }
    if (saved && now >= saved.fetchedAt && now - saved.fetchedAt < DAY) return saved;
    if ((retryAfter.get(key) || 0) > now) return saved || null;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const job = (async () => {
        try {
            let fresh: HolidayCalendar | null = null;
            for (const url of holidaySourceUrls(country, year)) {
                try {
                    fresh = parseHolidayCalendar(country, year, await fetchJsonWithTimeout(url, 3000), now);
                    if (fresh) break;
                } catch { /* 換下一個來源 */ }
            }
            if (!fresh) throw new Error('holiday unconfirmed');
            memory.set(key, fresh);
            try { await cache?.write(key, fresh); } catch { /* 盡力而為 */ }
            return fresh;
        } catch {
            retryAfter.set(key, now + 3600000);
            // 只能沿用同一國家同一年的舊日曆，絕不拿別的年份頂替
            return saved || null;
        }
    })();
    inFlight.set(key, job);
    try { return await job; } finally { inFlight.delete(key); }
}

export function renderUserHoliday(config: UserHolidayConfig, date: string, days: HolidayDay[], userName?: string): string {
    const matches = days.filter(d => d.date === date && (!d.regions || (!!config.subdivisionCode && d.regions.includes(config.subdivisionCode))));
    if (!matches.length) return '';
    const working = matches.some(d => !d.off);
    const names = [...new Set(matches
        .filter(d => d.off === !working && d.name !== TW_MAKEUP_WORK)
        .map(d => cleanName(d.name)))].join('、');
    const regionName = config.countryCode === 'MY' ? malaysiaHolidayRegion(config.subdivisionCode || '')?.name : undefined;
    const region = config.subdivisionCode ? `（${regionName || config.subdivisionCode}）` : '';
    const person = cleanName(userName) || '用戶';
    const place = `${person}所在的${holidayCountryName(config.countryCode)}${region}`;
    const what = working
        ? `是${names ? `${names}的` : ''}補班日（假日調整，照常上班）`
        : `放假：${names}`;
    return `${place}今天（${date}）${what}。${person}實際有沒有休息，以${person}自己的日程和說法為準。`;
}

export async function getUserHolidayReminder(config?: UserHolidayConfig, cache?: HolidayCache, now = Date.now(), userName?: string): Promise<string> {
    if (!config?.enabled || !config.countryCode) return '';
    const local = nowInTimeZone(config.timeZone, new Date(now));
    const year = local.getFullYear();
    const calendars = await Promise.all([
        loadHolidayCalendar(config.countryCode, year, cache, now),
        // 中國：下一年的元旦公告可能改到十二月的補班
        config.countryCode === 'CN' && local.getMonth() === 11 ? loadHolidayCalendar('CN', year + 1, cache, now) : null,
    ]);
    const days = new Map<string, HolidayDay[]>();
    for (const calendar of calendars) {
        if (!calendar) continue;
        const grouped = new Map<string, HolidayDay[]>();
        for (const day of calendar.days) grouped.set(day.date, [...(grouped.get(day.date) || []), day]);
        for (const [date, values] of grouped) days.set(date, values);
    }
    const date = getLocalDateKey(local);
    return renderUserHoliday(config, date, days.get(date) || [], userName);
}
