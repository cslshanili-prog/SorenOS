/**
 * realtimeWorldCore 迴歸測試。
 *
 * 這份葉子被瀏覽器聊天和主動消息到點生成共用，所以守兩件事：
 * 渲染函數按「手上真有什麼」裁剪（半截的一段比沒有更容易讓角色現編），
 * 以及熱榜時段 key 按指定時區算（worker 跑在 UTC 上，不指定就跟用戶差好幾個時段）。
 */

import { describe, expect, it } from 'vitest';
import {
    checkSpecialDates,
    getHotNewsSlot,
    pickRandomNews,
    renderRealtimeWorldBlock,
    resolveHotNewsPlatforms,
    sameHotNewsPlatforms,
    DEFAULT_HOTNEWS_PLATFORMS,
    type NewsItem,
    type WeatherData,
} from './realtimeWorldCore';

const weather: WeatherData = {
    temp: 31, feelsLike: 35, humidity: 60,
    description: '小雨', icon: '10d', city: '上海',
};
const news: NewsItem[] = [{ title: '某某官宣', source: '微博', desc: '一句簡介' }];

describe('renderRealtimeWorldBlock', () => {
    it('四樣都空 → 返回空串（不留一個什麼都沒有的抬頭）', () => {
        expect(renderRealtimeWorldBlock({})).toBe('');
        expect(renderRealtimeWorldBlock({ specialDates: [], news: [], weather: null })).toBe('');
    });

    it('不傳 timeLine 就不出「當前真實時間」那一行', () => {
        // 主動消息到點生成時時間由 fire_pack 的 AMSG_SLOT_CURRENT_TIME 填，
        // 這一段再出一次，同一份提示詞裡就有了兩個鍾。
        const out = renderRealtimeWorldBlock({ weather, news });
        expect(out).toContain('真實世界感知系統');
        expect(out).not.toContain('當前真實時間');

        const withTime = renderRealtimeWorldBlock({ timeLine: '2026年8月2日 週日 晚上 21:30', weather });
        expect(withTime).toContain('📅 當前真實時間: 2026年8月2日 週日 晚上 21:30');
    });

    it('節日單獨給，天氣熱搜沒開也照樣成段', () => {
        const out = renderRealtimeWorldBlock({ specialDates: ['七夕'] });
        expect(out).toContain('🎉 今日特殊: 七夕');
        expect(out).not.toContain('實時天氣');
        expect(out).not.toContain('最近真實發生的熱點');
    });

    it('天氣沒拉到 → 連帶撤掉「天氣是真實的」那條用法提示', () => {
        // 留著的話等於在教角色聊一個它手上根本沒有的讀數。
        const withWeather = renderRealtimeWorldBlock({ weather });
        expect(withWeather).toContain('🌤️ 【上海實時天氣】');
        expect(withWeather).toContain('你的建議: ');
        expect(withWeather).toContain('天氣是真實的');

        const without = renderRealtimeWorldBlock({ weather: null, news });
        expect(without).not.toContain('天氣是真實的');
    });

    it('熱點帶來源與簡介，並教一遍新聞卡片的寫法', () => {
        const out = renderRealtimeWorldBlock({ news });
        expect(out).toContain('- 某某官宣（微博）：一句簡介');
        expect(out).toContain('[[NEWS_CARD: 來源|標題]]');
    });
});

describe('getHotNewsSlot', () => {
    it('按指定時區分時段：同一時刻在不同時區落在不同段', () => {
        // 2026-08-02T23:30Z = 上海 8/3 07:30（清晨，slot 1）、紐約 8/2 19:30（傍晚，slot 4）
        const at = new Date('2026-08-02T23:30:00Z');
        expect(getHotNewsSlot({ tz: 'Asia/Shanghai', now: at })).toMatchObject({
            id: '2026-08-03#1', date: '2026-08-03', slot: 1, label: '清晨',
        });
        expect(getHotNewsSlot({ tz: 'America/New_York', now: at })).toMatchObject({
            id: '2026-08-02#4', slot: 4, label: '傍晚',
        });
    });
});

describe('平台清單', () => {
    it('留空用內置默認，配了就用配的', () => {
        expect(resolveHotNewsPlatforms()).toEqual(DEFAULT_HOTNEWS_PLATFORMS);
        expect(resolveHotNewsPlatforms([])).toEqual(DEFAULT_HOTNEWS_PLATFORMS);
        expect(resolveHotNewsPlatforms(['weibo'])).toEqual(['weibo']);
    });

    it('比對與順序無關（快照能不能複用看它）', () => {
        expect(sameHotNewsPlatforms(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(sameHotNewsPlatforms(['a'], ['a', 'b'])).toBe(false);
    });
});

// 節日表原本只有公曆，春節/除夕當天角色毫無反應。農曆日期靠預算好的公曆日期表查，
// 所以這裡抽查幾個已知日子釘住表沒抄錯，也釘住「超出年限就靜默沒有」不會瞎猜。
describe('checkSpecialDates 農曆節日', () => {
    // 12:00 Asia/Shanghai，避開跨日邊界；不受跑測試的機器時區影響
    const noonInShanghai = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 4, 0, 0);
    const on = (y: number, m: number, d: number) => checkSpecialDates('Asia/Shanghai', noonInShanghai(y, m, d));

    it('抽查幾個已知日子：除夕、春節、元宵、端午、七夕、中秋、重陽', () => {
        expect(on(2026, 2, 16)).toContain('除夕');
        expect(on(2026, 2, 17)).toContain('春節');
        expect(on(2026, 3, 3)).toContain('元宵節');
        expect(on(2026, 6, 19)).toContain('端午節');
        expect(on(2026, 8, 19)).toContain('七夕');
        expect(on(2026, 9, 25)).toContain('中秋節');
        expect(on(2026, 10, 18)).toContain('重陽節');
        // 換一年也得對上（春節每年浮動，抄錯一年整年都歪）
        expect(on(2027, 2, 6)).toContain('春節');
        expect(on(2030, 2, 3)).toContain('春節');
        expect(on(2034, 2, 19)).toContain('春節');
    });

    it('不是節日的日子什麼都不給', () => {
        expect(on(2026, 2, 18)).toEqual([]);
        expect(on(2026, 7, 7)).toEqual([]); // 七夕看農曆，公曆 7/7 不算
    });

    it('公曆跟農曆撞一天時兩個都給', () => {
        expect(on(2031, 10, 1)).toEqual(['國慶節', '中秋節']);
        expect(on(2033, 2, 14)).toEqual(['情人節', '元宵節']);
    });

    it('超出表覆蓋的年份 → 靜默沒有農曆節日，不會拿別年的日子頂上', () => {
        expect(on(2036, 2, 17)).toEqual([]);
        expect(on(2025, 2, 17)).toEqual([]);
    });

    it('農曆節日也跟角色所在地的日曆走', () => {
        // 上海 2026-02-17 09:00（春節）== 紐約 2026-02-16 20:00（除夕）
        const at = Date.UTC(2026, 1, 17, 1, 0, 0);
        expect(checkSpecialDates('Asia/Shanghai', at)).toContain('春節');
        expect(checkSpecialDates('America/New_York', at)).toContain('除夕');
    });
});

describe('pickRandomNews', () => {
    it('抽的條數不超過池子，且都來自池子', () => {
        const pool = Array.from({ length: 3 }, (_, i) => ({ title: `t${i}` }));
        const picks = pickRandomNews(pool, 5);
        expect(picks).toHaveLength(3);
        expect(pickRandomNews(pool, 2)).toHaveLength(2);
        for (const p of picks) expect(pool).toContainEqual(p);
        // 原池子不能被打亂（調用方還拿著它做別的事）
        expect(pool.map(p => p.title)).toEqual(['t0', 't1', 't2']);
    });
});
