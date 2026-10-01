import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    getCachedUserHolidayReminder,
    getUserHolidayReminder,
    insertUserHolidayInProfile,
    loadHolidayCalendar,
    parseHolidayCalendar,
    renderUserHoliday,
    type UserHolidayConfig,
} from './userHolidays';
import { buildToolConfig, parseToolConfig } from './amsgToolPack';
import { defaultRealtimeConfig } from './realtimeContext';
import { buildUserHolidayBlock } from '../worker/amsg/src/realtimeWorld';
import { ContextBuilder } from './context';

const china: UserHolidayConfig = { enabled: true, countryCode: 'CN', timeZone: 'Asia/Shanghai' };
const taiwan: UserHolidayConfig = { enabled: true, countryCode: 'TW', timeZone: 'Asia/Taipei' };

afterEach(() => {
    localStorage.removeItem('os_realtime_config');
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** 照 ruyut/TaiwanCalendar 的格式造一整年：每天一筆，週末 isHoliday，特別的日子帶說明。 */
function taiwanYear(year: number, special: Record<string, { isHoliday: boolean; description: string }>) {
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    const rows = [];
    for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
        const key = d.toISOString().slice(0, 10).replace(/-/g, '');
        const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
        rows.push({ date: key, week: week[d.getUTCDay()], isHoliday: weekend, description: '', ...special[key] });
    }
    return rows;
}

describe('台灣行事曆', () => {
    const raw2026 = taiwanYear(2026, {
        '20261009': { isHoliday: true, description: '補假' },
        '20261010': { isHoliday: true, description: '國慶日' },
        '20261231': { isHoliday: true, description: '補假' },
    });

    it('只留有說明的日子；補假拼上附近的節名，找不到就照寫補假', () => {
        const calendar = parseHolidayCalendar('TW', 2026, raw2026, 1)!;
        expect(calendar.days).toEqual([
            { date: '2026-10-09', name: '國慶日補假', off: true },
            { date: '2026-10-10', name: '國慶日', off: true },
            { date: '2026-12-31', name: '補假', off: true },
        ]);
        // 普通週末不是節日，不提醒
        expect(renderUserHoliday(taiwan, '2026-10-03', calendar.days)).toBe('');
        expect(renderUserHoliday(taiwan, '2026-10-09', calendar.days, 'Liora'))
            .toBe('Liora所在的台灣今天（2026-10-09）放假：國慶日補假。Liora實際有沒有休息，以Liora自己的日程和說法為準。');
    });

    it('補行上班是補班日，不把「補行上班」四個字當節名', () => {
        const raw = taiwanYear(2025, { '20250208': { isHoliday: false, description: '補行上班' } });
        const calendar = parseHolidayCalendar('TW', 2025, raw, 1)!;
        expect(renderUserHoliday(taiwan, '2025-02-08', calendar.days, '小桃'))
            .toBe('小桃所在的台灣今天（2025-02-08）是補班日（假日調整，照常上班）。小桃實際有沒有休息，以小桃自己的日程和說法為準。');
    });

    it('殘缺、年份不對、格式不對的資料不認，不能當成「整年沒假」', () => {
        expect(parseHolidayCalendar('TW', 2026, raw2026.slice(0, 100), 1)).toBeNull();
        expect(parseHolidayCalendar('TW', 2027, raw2026, 1)).toBeNull();
        expect(parseHolidayCalendar('TW', 2026, { data: raw2026 }, 1)).toBeNull();
    });

    it('jsDelivr 失敗就退到 GitHub 原檔，取到後寫緩存，ContextBuilder 隨後讀得到', async () => {
        const raw = taiwanYear(2031, { '20311010': { isHoliday: true, description: '國慶日' } });
        const fetcher = vi.fn(async (url: string) => url.includes('jsdelivr')
            ? new Response('nope', { status: 503 })
            : new Response(JSON.stringify(raw)));
        vi.stubGlobal('fetch', fetcher);
        const cache = { read: vi.fn(async () => null), write: vi.fn(async () => {}) };
        const at = Date.parse('2031-10-10T04:00Z');
        expect(await getUserHolidayReminder(taiwan, cache, at, 'Liora')).toContain('放假：國慶日');
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[1][0]).toContain('raw.githubusercontent.com/ruyut/TaiwanCalendar');
        expect(cache.write).toHaveBeenCalledTimes(1);
        // 同步路徑讀記憶體裡備好的那份，不再發請求
        expect(getCachedUserHolidayReminder('Liora', taiwan, new Date(2031, 9, 10, 12).getTime())).toContain('國慶日');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('年度還沒公布（兩個來源都失敗）就沒有提醒，一小時內不重打', async () => {
        const fetcher = vi.fn(async () => new Response('', { status: 404 }));
        vi.stubGlobal('fetch', fetcher);
        const at = Date.parse('2032-01-01T04:00Z');
        expect(await getUserHolidayReminder(taiwan, undefined, at)).toBe('');
        expect(await loadHolidayCalendar('TW', 2032, undefined, at + 1000)).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});

describe('用戶所在地節假日（上游搬來的部分）', () => {
    it('中國 2026 內建：連休與週末補班，平常日子不提醒，離線可用', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-10-01T04:00Z'))).toContain('放假：國慶節');
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-09-20T04:00Z'))).toContain('是國慶節的補班日');
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-09-28T04:00Z'))).toBe('');
        expect(await getUserHolidayReminder({ ...china, enabled: false })).toBe('');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('照用戶的日曆日算，跟角色、伺服器無關', async () => {
        const at = Date.parse('2026-09-24T17:00Z'); // 上海已經 25 號，紐約還是 24 號
        expect(await getUserHolidayReminder(china, undefined, at)).toContain('2026-09-25');
        expect(await getUserHolidayReminder({ ...china, timeZone: 'America/New_York' }, undefined, at)).toBe('');
    });

    it('Nager：排除銀行假日，只在部分地區放的假要選了地區才算', () => {
        const raw = ['Public', 'Bank'].map(type => ({ date: '2026-09-25', countryCode: 'US', localName: type, types: [type], global: true }));
        raw.push({ ...raw[0], localName: 'Local', global: false, counties: ['US-CA'] } as any);
        const data = parseHolidayCalendar('US', 2026, raw, 1)!;
        expect(data.days).toHaveLength(2);
        expect(renderUserHoliday({ enabled: true, countryCode: 'US' }, '2026-09-25', data.days)).not.toContain('Local');
        expect(renderUserHoliday({ enabled: true, countryCode: 'US', subdivisionCode: 'US-CA' }, '2026-09-25', data.days)).toContain('Public、Local');
    });

    it('雲端工具包帶上國家地區，時區用同步這一刻的設備時區', () => {
        const pack = buildToolConfig({ ...defaultRealtimeConfig, userHolidays: { enabled: true, countryCode: 'TW' } });
        expect(parseToolConfig(JSON.stringify(pack))?.userHolidays)
            .toEqual({ enabled: true, countryCode: 'TW', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        expect(buildToolConfig(defaultRealtimeConfig).userHolidays).toBeUndefined();
    });

    it('Worker 那一半：時間感知關了不給，照用戶時區不照角色時區', async () => {
        const args = {
            toolConfig: { ...buildToolConfig(defaultRealtimeConfig), userHolidays: china },
            nowMs: Date.parse('2026-09-24T17:00Z'), tzId: 'America/New_York',
            globalRows: [], globalNamespace: 'amsg:global', timeAwarenessEnabled: true, userName: '小桃',
        };
        const text = await buildUserHolidayBlock(args);
        expect(text).toContain('小桃所在的中國今天（2026-09-25）放假：中秋節');
        expect(text.split('\n')).toHaveLength(1);
        expect(await buildUserHolidayBlock({ ...args, timeAwarenessEnabled: false })).toBe('');
        expect(await buildUserHolidayBlock({ ...args, nowMs: Date.parse('2026-09-28T04:00Z') })).toBe('');
    });

    it('雲端插進「互動對象 (User)」段；舊模板沒有那段就補在最後；空提醒一字不加', () => {
        const prompt = '角色\n### 互動對象 (User)\n- 名字: 小桃\n記憶';
        expect(insertUserHolidayInProfile(prompt, '小桃那邊今天補班。')).toContain('### 互動對象 (User)\n- 小桃那邊今天補班。\n- 名字');
        expect(insertUserHolidayInProfile('沒有用戶段', '小桃那邊今天補班。')).toBe('沒有用戶段\n\n### 互動對象資訊補充\n小桃那邊今天補班。\n');
        expect(insertUserHolidayInProfile(prompt, '')).toBe(prompt);
    });
});

describe('ContextBuilder 的用戶資料段', () => {
    const char = { id: 'c1', name: 'Sully', timeAwarenessEnabled: true } as any;
    const user = { name: '小桃', bio: '測試' } as any;

    it('有假日那天緊跟在標題下面一行；角色關時間感知、見面架空、交給 Worker 的都不烤', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 1, 12));
        localStorage.setItem('os_realtime_config', JSON.stringify({ userHolidays: china }));
        const line = getCachedUserHolidayReminder('小桃');
        expect(line).toContain('放假：國慶節');
        const prompt = ContextBuilder.buildCoreContext(char, user);
        expect(prompt).toContain(`### 互動對象 (User)\n- ${line}\n- 名字: 小桃`);
        expect(prompt.split(line)).toHaveLength(2);
        expect(ContextBuilder.buildCoreContext({ ...char, timeAwarenessEnabled: false }, user)).not.toContain(line);
        expect(ContextBuilder.buildCoreContext(char, user, true, undefined, undefined, { skipTimeAwareness: true })).not.toContain(line);
        expect(ContextBuilder.buildCoreContext(char, user, true, undefined, undefined, { skipUserHoliday: true })).not.toContain(line);
        // 顯式傳設定的優先於 localStorage
        expect(ContextBuilder.buildCoreContext(char, user, true, undefined, undefined, { userHolidays: { ...china, enabled: false } })).not.toContain(line);
    });

    it('沒開或平常日子，用戶段一字不多', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 28, 12));
        localStorage.setItem('os_realtime_config', JSON.stringify({ userHolidays: china }));
        expect(ContextBuilder.buildCoreContext(char, user)).toContain('### 互動對象 (User)\n- 名字: 小桃');
        localStorage.setItem('os_realtime_config', JSON.stringify({ userHolidays: { ...china, enabled: false } }));
        vi.setSystemTime(new Date(2026, 9, 1, 12));
        expect(ContextBuilder.buildCoreContext(char, user)).toContain('### 互動對象 (User)\n- 名字: 小桃');
    });
});
