// utils/networkFailureDiagnosis.test.ts
// 迴歸守衛：
//   1. 調試終端裡那條 network 日誌不能再退回「Failed to fetch + 一個 URL」——方法、耗時、
//      在線狀態、跨域與否、初判、可能原因，少一樣用戶就又只能來問作者。
//   2. 分類不能認錯：主動取消 / 離線 / https 打 http / 地址非法 這四種都有確定結論，
//      混進 blocked 會白白多打一次探測，還會給出跑偏的排查方向。
//   3. no-cors 複檢的兩個結論必須涇渭分明：「通了」指向 CORS/限流，「沒通」指向線路，
//      兩邊要查的東西完全相反，說反了比不說更糟。
//   4. 探測有 30s 冷卻：一串請求同時炸時不能對同一個域名連打探測。
//   5. Resource Timing 只認本次請求那條記錄。同一個地址被反覆請求時，timeline 裡躺著
//      早先成功過的記錄，誤取會打出「對方其實回了 200」這種跟事實相反的結論。
import { describe, it, expect, beforeEach } from 'vitest';
import {
    NETWORK_SELF_CHECK_STEPS,
    buildFetchFailureDetail,
    classifyFetchFailure,
    describeReachabilityProbe,
    parseTargetUrl,
    probeOriginReachability,
    readResourceTimingHint,
    readStallHint,
    resetReachabilityProbeCooldown,
    shouldProbeReachability,
    summarizeFetchRequestBody,
} from './networkFailureDiagnosis';

const failedToFetch = () => new TypeError('Failed to fetch');

describe('classifyFetchFailure', () => {
    it('Chrome / Safari / Firefox 三種說法都算「拿不到響應」', () => {
        for (const msg of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource']) {
            expect(classifyFetchFailure({
                url: 'https://sullymeow.ccwu.cc/api/health',
                error: new TypeError(msg),
                online: true,
                pageProtocol: 'https:',
            })).toBe('blocked');
        }
    });

    it('主動取消不算網絡失敗', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        expect(classifyFetchFailure({ url: 'https://a.example.com/x', error: err })).toBe('aborted');
    });

    // 線上實測踩到過：AbortSignal.timeout() 拋的是 TimeoutError("signal timed out")，
    // 既不含 abort 字樣也不是 TypeError，一度掉進 unknown，日誌只剩「不符合已知形態」。
    it('AbortSignal.timeout 的 TimeoutError 歸到 timeout，不是 aborted、更不是 unknown', () => {
        const err = new Error('signal timed out');
        err.name = 'TimeoutError';
        expect(classifyFetchFailure({ url: 'https://sullymeow.ccwu.cc/api/health', error: err })).toBe('timeout');
    });

    it('timeout 和 blocked 都要做連通性複檢，其餘不做', () => {
        expect(shouldProbeReachability('timeout')).toBe(true);
        expect(shouldProbeReachability('blocked')).toBe(true);
        expect(shouldProbeReachability('unknown')).toBe(true);
        expect(shouldProbeReachability('aborted')).toBe(false);
        expect(shouldProbeReachability('offline')).toBe(false);
        expect(shouldProbeReachability('mixed-content')).toBe(false);
        expect(shouldProbeReachability('bad-url')).toBe(false);
    });

    it('瀏覽器報離線時優先歸到離線', () => {
        expect(classifyFetchFailure({
            url: 'https://a.example.com/x', error: failedToFetch(), online: false, pageProtocol: 'https:',
        })).toBe('offline');
    });

    it('https 頁面打 http 地址 → 混合內容，且優先級高於離線判定', () => {
        expect(classifyFetchFailure({
            url: 'http://a.example.com/x', error: failedToFetch(), online: false, pageProtocol: 'https:',
        })).toBe('mixed-content');
    });

    it('http://localhost 不當混合內容攔（Chrome 視其為可信來源）', () => {
        expect(classifyFetchFailure({
            url: 'http://localhost:18060/api/health', error: failedToFetch(), online: true, pageProtocol: 'https:',
        })).toBe('blocked');
    });

    it('地址本身不合法 → bad-url', () => {
        expect(classifyFetchFailure({
            url: 'sullymeow ccwu cc/api', error: failedToFetch(), online: true, pageProtocol: 'https:',
        })).toBe('bad-url');
    });
});

describe('summarizeFetchRequestBody', () => {
    it('只保留結構統計，不洩露劇情正文', () => {
        const summary = summarizeFetchRequestBody(JSON.stringify({
            messages: [
                { role: 'system', content: '絕不能寫進日誌的秘密設定' },
                { role: 'assistant', content: '預填充' },
            ],
            stream: true,
            top_p: 0.7,
            presence_penalty: 0.2,
        }));
        expect(summary).toMatchObject({
            messageCount: 2,
            contentChars: 15,
            lastMessageRole: 'assistant',
            stream: true,
            optionalParams: ['top_p', 'presence_penalty'],
        });
        expect(JSON.stringify(summary)).not.toContain('秘密設定');
    });
});

describe('buildFetchFailureDetail', () => {
    const detail = () => buildFetchFailureDetail({
        url: 'https://sullymeow.ccwu.cc/api/health',
        method: 'get',
        durationMs: 43,
        error: failedToFetch(),
        online: true,
        pageOrigin: 'https://sullyos.example.com',
        pageProtocol: 'https:',
    }, { startedAt: 0, perf: { getEntriesByName: () => [] } });

    it('把能補的旁證全補上', () => {
        const text = detail();
        expect(text).toContain('URL: https://sullymeow.ccwu.cc/api/health');
        expect(text).toContain('GET');
        expect(text).toContain('43ms');
        expect(text).toContain('TypeError: Failed to fetch');
        expect(text).toContain('sullymeow.ccwu.cc');
        expect(text).toContain('跨域');
        expect(text).toContain('在線');
        expect(text).toContain('初判:');
        expect(text).toContain('可能原因:');
    });

    it('同源請求不會被標成跨域', () => {
        const text = buildFetchFailureDetail({
            url: 'https://sullyos.example.com/api/x',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('同源');
        expect(text).not.toContain('跨域請求');
    });

    it('同一個 POST 剛成功時，不再把劇情模式失敗甩給 DNS 或整域名代理', () => {
        const now = 1_786_894_455_703;
        const text = buildFetchFailureDetail({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            durationMs: 3828,
            error: new TypeError('Load failed'),
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
            requestPurpose: '劇情見面生成',
            requestSummary: summarizeFetchRequestBody(JSON.stringify({
                messages: [{ role: 'system', content: '設定' }, { role: 'assistant', content: '<content>' }],
                stream: true,
                top_p: 0.8,
            })),
            recentSuccessfulSameRequest: { timestamp: now - 42_000, status: 200 },
        }, { startedAt: 0, now, perf: { getEntriesByName: () => [] } });

        expect(text).toContain('調用用途: 劇情見面生成');
        expect(text).toContain('messages=2');
        expect(text).toContain('末條 role=assistant');
        expect(text).toContain('額外參數: top_p');
        expect(text).toContain('同一個 POST 已成功返回 HTTP 200');
        expect(text).toContain('當前請求/響應特有的失敗');
        expect(text).toContain('劇情上下文或請求體更大');
        expect(text).toContain('末條 assistant 預填充或額外參數');
        expect(text).not.toContain('DNS 解析不到');
        expect(text).not.toContain('代理把這個域名的連接掐了');
    });

    it('普通聊天和記憶請求不會套用劇情專屬診斷', () => {
        const now = 1_786_894_455_703;
        const text = buildFetchFailureDetail({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            durationMs: 3828,
            error: new TypeError('Load failed'),
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
            requestPurpose: '記憶提取',
            requestSummary: summarizeFetchRequestBody(JSON.stringify({
                messages: [{ role: 'system', content: '設定' }, { role: 'assistant', content: '<content>' }],
                stream: false,
                top_p: 0.8,
            })),
            recentSuccessfulSameRequest: { timestamp: now - 42_000, status: 200 },
        }, { startedAt: 0, now, perf: { getEntriesByName: () => [] } });

        expect(text).toContain('調用用途: 記憶提取');
        expect(text).toContain('當前請求體或響應與剛才成功的請求不同');
        expect(text).toContain('上游限流或臨時故障');
        expect(text).not.toContain('劇情上下文');
        expect(text).not.toContain('assistant 預填充');
    });

    it('混合內容給的是「改成 https」而不是「查梯子」', () => {
        const text = buildFetchFailureDetail({
            url: 'http://my-bridge.example.com/api/health',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('混合內容');
        expect(text).not.toContain('DNS 解析不到');
    });

    // 復刻線上那條真實日誌：/api/health 被 10s 超時掐斷。舊版把它歸到 unknown，
    // 初判打成「不符合已知的幾種失敗形態」、可能原因打成「看下面的錯誤原文」——等於沒說。
    it('10s 超時的探活不能再打出「不符合已知形態」', () => {
        const err = new Error('signal timed out');
        err.name = 'TimeoutError';
        const text = buildFetchFailureDetail({
            url: 'https://sullymeow.ccwu.cc/api/health',
            method: 'GET',
            durationMs: 10001,
            error: err,
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('請求超時');
        expect(text).toContain('不能僅憑耗時確定失敗階段');
        expect(text).not.toContain('不符合已知');
        expect(text).not.toContain('看下面的錯誤原文');
    });

    it('Resource Timing 裡有狀態碼時，直接點破「不是網絡不通」', () => {
        const text = buildFetchFailureDetail({
            url: 'https://sullymeow.ccwu.cc/api/health',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [{ startTime: 50_010, responseStatus: 429, transferSize: 0, duration: 120 }],
            },
        });
        expect(text).toContain('responseStatus=429');
        expect(text).toContain('CORS');
    });

    // 整條日誌級別的守衛：早先那次成功的記錄不能反過來推翻本次「掛了 10s、一個字節沒收到」
    // 的判斷。兩句結論同時出現在一條日誌裡，用戶只會更懵。
    it('掛 10s 的失敗不能被歷史記錄改口成「對方其實回了 200」', () => {
        const text = buildFetchFailureDetail({
            url: 'https://sullyos-amsg.example.workers.dev/client-state',
            method: 'PUT',
            durationMs: 10078,
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
        }, {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [{ startTime: 9_000, responseStatus: 200, transferSize: 0, duration: 1038 }],
            },
        });
        expect(text).toContain('不能僅憑耗時確定失敗階段');
        expect(text).not.toContain('對方其實回了');
        expect(text).not.toContain('responseStatus=200');
    });
});

describe('readStallHint', () => {
    it('MiniMax 的快速 GET 失敗保留 CORS 可能性，不誤判為請求未發出', () => {
        const text = buildFetchFailureDetail({
            url: 'https://audio.example.com/voice.mp3', method: 'GET', durationMs: 162,
            error: new TypeError('Load failed'), online: true, pageOrigin: 'https://friedsully.com',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('請求: GET');
        expect(text).toContain('CORS');
        expect(text).not.toContain('拿到響應頭之前就失敗');
        expect(text).not.toContain('通常說明連接壓根沒建立');
    });
    it('耗時較長不能確定卡在連接階段，也可能是上游處理或 CORS', () => {
        const hint = readStallHint(20187, 'blocked');
        expect(hint).toContain('20.2s');
        expect(hint).toContain('代理');
        expect(hint).toContain('CORS');
        expect(hint).toContain('不能僅憑耗時');
        expect(hint).not.toContain('一個字節都沒收到');
    });

    it('幾十毫秒就失敗也可能是已收到響應後的 CORS 拒絕', () => {
        const hint = readStallHint(43, 'blocked');
        expect(hint).toContain('CORS');
        expect(hint).toContain('DNS');
        expect(hint).not.toContain('連接建立階段被吞');
    });

    it('中間地帶不硬猜（寧可不說）', () => {
        expect(readStallHint(1500, 'blocked')).toBe('');
    });

    it('已有確定結論的幾類不摻和耗時猜測', () => {
        expect(readStallHint(20000, 'mixed-content')).toBe('');
        expect(readStallHint(20000, 'aborted')).toBe('');
    });
});

describe('readResourceTimingHint', () => {
    it('沒有記錄時不武斷認定連接未建立', () => {
        expect(readResourceTimingHint('https://a.example.com/x', {
            startedAt: 1000, perf: { getEntriesByName: () => [] },
        })).toContain('沒有這條請求的記錄');
    });

    it('同一 URL 請求過多次時，取本次這條', () => {
        const hint = readResourceTimingHint('https://a.example.com/x', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [
                    { startTime: 9_000, responseStatus: 200, duration: 1038 },
                    { startTime: 50_120, responseStatus: 503, duration: 88 },
                ],
            },
        });
        expect(hint).toContain('503');
        expect(hint).not.toContain('1038');
    });

    // 線上翻車實錄：/client-state 被反覆 PUT，timeline 裡躺著早先成功那次的 200。本次連接
    // 壓根沒建立、什麼都沒往 timeline 裡寫，舊版取「最後一條」就把那條陳舊的 200 當成了本次
    // 的響應，打出「對方其實回了 HTTP 200，是響應被 CORS 攔掉的」——跟同一條日誌裡「掛了
    // 10.1s 一個字節沒收到」「no-cors 也連不上」直接打架，把人往查 CORS 的方向帶。
    it('不能把早先成功那次的記錄當成本次失敗的證據', () => {
        const hint = readResourceTimingHint('https://sullyos-amsg.example.workers.dev/client-state', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [
                    { startTime: 9_000, responseStatus: 200, transferSize: 0, duration: 1038 },
                ],
            },
        });
        expect(hint).toContain('沒有這條請求的記錄');
        expect(hint).not.toContain('200');
        expect(hint).not.toContain('CORS');
    });

    // 跨域拿不到 Timing-Allow-Origin 授權時，responseStatus / transferSize 被規範統統置 0。
    // 直接印出來會被讀成「狀態碼是 0」「一個字節都沒傳」——後者尤其坑，跟「連接被吞」是完全
    // 不同的兩回事。這時候只有耗時可信，其餘整個不印，並說清為什麼少了。
    it('拿不到 Timing-Allow-Origin 時只報耗時，不印那兩個恆為 0 的字段', () => {
        const hint = readResourceTimingHint('https://a.example.com/x', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [
                    { startTime: 50_010, responseStart: 0, responseStatus: 0, transferSize: 0, duration: 10_078 },
                ],
            },
        });
        expect(hint).not.toContain('responseStatus');
        expect(hint).not.toContain('transferSize');
        expect(hint).toContain('10078ms');
        expect(hint).toContain('Timing-Allow-Origin');
    });

    // 有授權時 transferSize=0 才真的是「沒傳字節」，得照常給。這條同時釘住 responseStart
    // 這個探針：Safari 沒有 responseStatus 字段，只能靠它判斷有沒有授權。
    it('有 Timing-Allow-Origin 授權時照常給字節數', () => {
        const hint = readResourceTimingHint('https://a.example.com/x', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [{ startTime: 50_010, responseStart: 50_050, transferSize: 0, duration: 88 }],
            },
        });
        expect(hint).toContain('transferSize=0');
        expect(hint).not.toContain('Timing-Allow-Origin');
    });

    it('performance 不可用時靜默返回空串，不能拋', () => {
        expect(readResourceTimingHint('https://a.example.com/x', { startedAt: 0, perf: {} })).toBe('');
        expect(readResourceTimingHint('https://a.example.com/x', {
            startedAt: 0,
            perf: { getEntriesByName: () => { throw new Error('boom'); } },
        })).toBe('');
    });

    // 沒有 performance.now() 就沒法分辨哪條記錄是本次的，這時候整段不出比瞎猜強。
    it('拿不到發起時刻時整段不出，不退回「取最後一條」', () => {
        expect(readResourceTimingHint('https://a.example.com/x', {
            startedAt: Number.NaN,
            perf: { getEntriesByName: () => [{ startTime: 9_000, responseStatus: 200 }] },
        })).toBe('');
    });
});

describe('probeOriginReachability', () => {
    beforeEach(() => resetReachabilityProbeCooldown());

    it('打的是域名根路徑，不是原地址——原地址可能有副作用', async () => {
        const seen: any[] = [];
        const fakeFetch = ((url: any, init: any) => { seen.push([url, init]); return Promise.resolve(new Response('')); }) as any;
        const verdict = await probeOriginReachability('https://sullymeow.ccwu.cc/api/publish', fakeFetch);
        expect(verdict).toBe('reachable');
        expect(seen[0][0]).toBe('https://sullymeow.ccwu.cc/');
        expect(seen[0][1].mode).toBe('no-cors');
        expect(seen[0][1].credentials).toBe('omit');
    });

    it('探測也失敗 → unreachable', async () => {
        const fakeFetch = (() => Promise.reject(failedToFetch())) as any;
        expect(await probeOriginReachability('https://sullymeow.ccwu.cc/api/health', fakeFetch)).toBe('unreachable');
    });

    it('被超時控制器掐斷 → timeout，不是 unreachable', async () => {
        const fakeFetch = (() => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        }) as any;
        expect(await probeOriginReachability('https://sullymeow.ccwu.cc/api/health', fakeFetch)).toBe('timeout');
    });

    it('同一域名 30s 內只探一次', async () => {
        let calls = 0;
        const fakeFetch = (() => { calls += 1; return Promise.resolve(new Response('')); }) as any;
        const now = () => 1_000_000;
        expect(await probeOriginReachability('https://a.example.com/1', fakeFetch, { now })).toBe('reachable');
        expect(await probeOriginReachability('https://a.example.com/2', fakeFetch, { now })).toBe('cooldown');
        expect(calls).toBe(1);
        // 換個域名不受上一個的冷卻影響
        expect(await probeOriginReachability('https://b.example.com/1', fakeFetch, { now })).toBe('reachable');
        expect(calls).toBe(2);
    });

    it('地址非法直接跳過，不浪費一次請求', async () => {
        let calls = 0;
        const fakeFetch = (() => { calls += 1; return Promise.resolve(new Response('')); }) as any;
        expect(await probeOriginReachability('not a url', fakeFetch)).toBe('skipped');
        expect(calls).toBe(0);
    });
});

describe('describeReachabilityProbe', () => {
    it('通了 → 只確認域名可達，並警告生成後失敗仍可能計費', () => {
        const text = describeReachabilityProbe('reachable', 'sullymeow.ccwu.cc', 'POST');
        expect(text).toContain('域名當前可達');
        expect(text).toContain('原 POST');
        expect(text).toContain('CORS');
        expect(text).toContain('可能計費');
        expect(text).toContain('不要連續重發');
        expect(text).not.toContain('問題出在響應本身');
        expect(text).not.toContain('梯子的分流規則');
    });

    it('GET 音頻下載失敗不能被說成 POST 生成失敗', () => {
        const text = describeReachabilityProbe('reachable', 'audio.example.com', 'GET');
        expect(text).toContain('原 GET');
        expect(text).toContain('資源加載失敗不等於生成失敗');
        expect(text).not.toContain('POST');
        expect(text).not.toContain('可能計費');
    });

    it('沒通 → 指向線路，不能再提 CORS 把人帶偏', () => {
        const text = describeReachabilityProbe('unreachable', 'sullymeow.ccwu.cc');
        expect(text).toContain('連不上');
        expect(text).toContain('梯子');
        expect(text).not.toContain('域名當前可達');
    });

    it('冷卻期內要說清「已經查過了，看上一條」，不能一聲不吭讓人以為漏了', () => {
        expect(describeReachabilityProbe('cooldown', 'sullymeow.ccwu.cc')).toContain('之前那一條日誌');
    });

    it('skipped 不產出文案（不往日誌裡塞廢話）', () => {
        expect(describeReachabilityProbe('skipped', 'a.example.com')).toBe('');
    });
});

describe('parseTargetUrl / 自查清單', () => {
    it('相對地址按 base 解析', () => {
        expect(parseTargetUrl('/api/health', 'https://sullyos.example.com/index.html').host).toBe('sullyos.example.com');
    });

    it('自查清單第一步就是「換節點 / 關梯子直連」', () => {
        expect(NETWORK_SELF_CHECK_STEPS.length).toBeGreaterThanOrEqual(4);
        expect(NETWORK_SELF_CHECK_STEPS[0]).toContain('梯子');
    });
});
