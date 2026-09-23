/**
 * worker 側「到點現拉外面的世界」的迴歸測試。
 *
 * 守的是幾個一眼就穿幫的點：
 *   - 角色關掉時間感知，主動消息裡也不能冒出今日節日（這個開關以前只在前台生效）
 *   - 這一段絕不能自帶「當前真實時間」——時間由 fire_pack 的槽位填，兩處都出就是兩個鍾
 *   - 拉不到就整段不要，不留半截；有快照就別重拉
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildRealtimeWorldBlock, AMSG_HOTNEWS_SNAPSHOT_KEY, AMSG_WEATHER_SNAPSHOT_KEY } from './realtimeWorld';
import type { AmsgToolConfig } from '../../../utils/amsgToolPack';

/** 上海時間 2026-12-25 12:00（聖誕節，用來驗節日那一行）。 */
const NOW = Date.parse('2026-12-25T04:00:00Z');
const TZ = 'Asia/Shanghai';

const cfg = (extra: Partial<AmsgToolConfig> = {}): AmsgToolConfig => ({
    v: 1,
    proxyWorkerUrl: 'https://proxy.example.com',
    weatherEnabled: false,
    newsEnabled: false,
    notionEnabled: false,
    feishuEnabled: false,
    ...extra,
});

const weatherSnapshot = (city: string, fetchedAt: number) => ({
    key: AMSG_WEATHER_SNAPSHOT_KEY,
    value: JSON.stringify({
        city,
        data: { temp: 3, feelsLike: 1, humidity: 40, description: '小雪', icon: '13d', city },
        fetchedAt,
    }),
});

const hotNewsSnapshot = (id: string, platforms: string[], titles: string[], fetchedAt = NOW) => ({
    key: AMSG_HOTNEWS_SNAPSHOT_KEY,
    value: JSON.stringify({
        id, platforms, fetchedAt,
        items: titles.map((t) => ({ title: t, source: '微博' })),
    }),
});

const run = (args: {
    toolConfig: AmsgToolConfig;
    timeAwarenessEnabled?: boolean;
    globalRows?: Array<{ key: string; value: string }>;
    writeState?: any;
}) => buildRealtimeWorldBlock({
    toolConfig: args.toolConfig,
    timeAwarenessEnabled: args.timeAwarenessEnabled ?? true,
    tzId: TZ,
    nowMs: NOW,
    globalRows: args.globalRows ?? [],
    globalNamespace: 'amsg:global',
    writeState: args.writeState,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('時間感知開關跟到後台', () => {
    it('開著 → 今日節日照給（天氣熱搜沒開也成段）', async () => {
        const out = await run({ toolConfig: cfg() });
        expect(out).toContain('🎉 今日特殊: 聖誕節');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('關掉 → 一個字都不提今天是什麼日子', async () => {
        // 迴歸守衛：這個開關以前只在前台生效，主動消息照樣在聖誕節問候。
        const out = await run({ toolConfig: cfg(), timeAwarenessEnabled: false });
        expect(out).toBe('');
    });

    it('關掉時間感知但開著天氣 → 有天氣沒節日', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海' }),
            timeAwarenessEnabled: false,
            globalRows: [weatherSnapshot('上海', NOW)],
        });
        expect(out).toContain('實時天氣');
        expect(out).not.toContain('今日特殊');
    });
});

describe('這一段永遠不帶自己的鐘', () => {
    it('渲染結果裡沒有「當前真實時間」', async () => {
        // 時間由 fire_pack 的 AMSG_SLOT_CURRENT_TIME 填。這裡再出一次，
        // 同一份提示詞裡就有兩個鍾，角色會照著其中一個說錯話。
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海' }),
            globalRows: [weatherSnapshot('上海', NOW)],
        });
        expect(out).toContain('真實世界感知系統');
        expect(out).not.toContain('當前真實時間');
    });
});

describe('天氣快照', () => {
    it('同城半小時內 → 直接複用，不發請求', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海' }),
            globalRows: [weatherSnapshot('上海', NOW - 10 * 60_000)],
        });
        expect(out).toContain('🌤️ 【上海實時天氣】');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('快照過期 → 重拉並寫回', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            main: { temp: 5.4, feels_like: 2.2, humidity: 55 },
            weather: [{ description: '多雲', icon: '03d' }],
            name: '上海',
        }), { status: 200 }));
        const writeState = vi.fn().mockResolvedValue({});

        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('上海', NOW - 60 * 60_000)],
            writeState,
        });

        expect(out).toContain('氣溫 5°C（體感 2°C）');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [ns, rows] = writeState.mock.calls[0];
        expect(ns).toBe('amsg:global');
        expect(rows[0].key).toBe(AMSG_WEATHER_SNAPSHOT_KEY);
    });

    it('拉失敗但手上有同城舊讀數 → 先用舊的，且不寫回（下次重試）', async () => {
        const writeState = vi.fn().mockResolvedValue({});
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('上海', NOW - 60 * 60_000)],
            writeState,
        });
        expect(out).toContain('小雪');
        expect(writeState).not.toHaveBeenCalled();
    });

    // 頂一小會兒可以，頂三天不行：這一段抬頭寫著「以下信息來自真實世界」，
    // 接口連掛幾天就會頂著這塊招牌一直播那場早就停了的雨。
    it('拉失敗且舊讀數超過保鮮上限 → 整段不說天氣', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('上海', NOW - 5 * 60 * 60_000)],
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });

    it('拉失敗且舊讀數是別的城市 → 寧可不說天氣', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('北京', NOW)],
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });
});

describe('熱榜快照', () => {
    it('同時段同平台 → 複用，不發請求', async () => {
        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['weibo'] }),
            // 上海 12-25 12:00 落在 slot 3（午後）
            globalRows: [hotNewsSnapshot('2026-12-25#3', ['weibo'], ['某某官宣'])],
        });
        expect(out).toContain('- 某某官宣（微博）');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('平台配置變了 → 快照作廢，重新拉', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            data: [{ title: '新的熱搜', url: 'https://x' }],
        }), { status: 200 }));
        const writeState = vi.fn().mockResolvedValue({});

        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['zhihu'] }),
            globalRows: [hotNewsSnapshot('2026-12-25#3', ['weibo'], ['舊的'])],
            writeState,
        });

        expect(out).toContain('新的熱搜');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(writeState.mock.calls[0][1][0].key).toBe(AMSG_HOTNEWS_SNAPSHOT_KEY);
    });

    it('拉不到 → 退回上個時段的，不留空段', async () => {
        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['weibo'] }),
            globalRows: [hotNewsSnapshot('2026-12-25#2', ['weibo'], ['上個時段的'])],
        });
        expect(out).toContain('上個時段的');
    });

    it('拉不到且快照是隔天的 → 整段不說熱搜（那不叫「最近發生的事」了）', async () => {
        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['weibo'] }),
            globalRows: [hotNewsSnapshot('2026-12-23#3', ['weibo'], ['前天的'], NOW - 30 * 60 * 60_000)],
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });
});

describe('全拉掛也不斷鏈', () => {
    it('天氣熱搜都開、都拉不到、又關了時間感知 → 空串（槽位被抹平）', async () => {
        const out = await run({
            toolConfig: cfg({
                weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'k',
                newsEnabled: true, newsPlatforms: ['weibo'],
            }),
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });

    it('寫快照失敗不連累這次觸發', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            main: { temp: 5, feels_like: 2, humidity: 55 },
            weather: [{ description: '多雲', icon: '03d' }],
            name: '上海',
        }), { status: 200 }));
        const writeState = vi.fn().mockRejectedValue(new Error('D1 掛了'));

        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'k' }),
            writeState,
        });
        expect(out).toContain('實時天氣');
    });
});
