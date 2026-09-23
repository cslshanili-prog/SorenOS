// 全局 fetch 攔截器（context/OSContext.tsx）抓到「請求壓根沒拿到響應」時，把瀏覽器那句
// 光禿禿的 `TypeError: Failed to fetch` 翻成一條能照著排查的日誌。
//
// 為什麼值得單開一份：
//   1. 瀏覽器出於安全，把「DNS 解析不了」「梯子把連接掐了」「擴展屏蔽了」「對方返回的
//      響應沒有 CORS 頭」這四件完全不同的事，統統報成同一句 Failed to fetch，不帶任何
//      細節。用戶把日誌複製出來發到群裡，信息量是零——這份文件的活就是把能補的旁證
//      （耗時、在線狀態、是否跨域、Resource Timing 裡那條記錄）全補上，再給一句初判。
//   2. 其中最關鍵的一條旁證是「換 no-cors 再打一次這個域名」：no-cors 不做 CORS 校驗，
//      只要網絡路徑通就會拿到一個 opaque 響應。它成功而原請求失敗 ⇒ 網絡沒問題，是響應
//      頭/CORS 的事（多半是對方擋在 Cloudflare 限流頁或人機驗證頁後面）；它也失敗 ⇒ 這台
//      設備到這個域名是真的不通，該去查梯子規則 / DNS / 防火牆 / 擴展。這一刀把排查範圍
//      直接砍掉一半，是整份文件存在的理由。
//   3. 判定全是純函數，能脫開瀏覽器單測；探測那部分把 fetch 當參數傳進來，測試塞假的。
//
// ⚠️ 探測必須用**未被攔截的原生 fetch**（攔截器裡的 originalFetch），否則探測自己失敗會
// 再寫一條日誌，一條網絡錯誤滾成一屏。

/** 連接失敗的粗分類。用於選那句初判，也用於決定要不要做 no-cors 複檢。 */
export type FetchFailureKind =
    | 'aborted'        // 調用方主動取消（頁面/組件卸載、用戶點停）
    | 'timeout'        // AbortSignal.timeout() 到點掐的：連接掛住不返回，跟「被拒」是兩回事
    | 'offline'        // navigator.onLine === false，瀏覽器自己知道沒網
    | 'mixed-content'  // https 頁面打 http 地址，被瀏覽器直接攔
    | 'bad-url'        // 地址本身就不合法（拼錯、少了協議頭）
    | 'blocked'        // 拿不到響應：代理/DNS/擴展/CORS 四選一，靠複檢再分
    | 'unknown';

export interface FetchFailureContext {
    url: string;
    /** 請求方法，取不到按 GET 記。 */
    method?: string;
    /** 從發起到拋錯的毫秒數。 */
    durationMs?: number;
    error?: unknown;
    /** 以下三項默認讀全局，測試裡顯式傳。 */
    online?: boolean;
    pageOrigin?: string;
    pageProtocol?: string;
    /** 只含體積/結構，不含消息正文；用於比較“同 API、不同功能”的請求差異。 */
    requestSummary?: FetchRequestSummary;
    /** 調用方顯式標註的用途，例如“劇情見面生成”。 */
    requestPurpose?: string;
    /** 同一 method + URL 在本頁面生命週期內最近一次成功讀完整個響應正文的記錄。 */
    recentSuccessfulSameRequest?: { timestamp: number; status: number };
}

export interface FetchRequestSummary {
    bodyBytes: number;
    messageCount?: number;
    contentChars?: number;
    lastMessageRole?: string;
    stream?: boolean;
    optionalParams?: string[];
}

const utf8ByteLength = (value: string): number => {
    try {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
    } catch { /* fall through */ }
    return value.length;
};

/**
 * 提取 chat/completions 請求的安全結構摘要。絕不把 prompt、API key 或角色正文寫進日誌。
 * 這組旁證專門回答“同一個 API 為什麼陪伴能出、劇情不能出”：兩邊 URL 相同不代表
 * 請求相同，劇情常見差異是更大的 messages、assistant 預填充和額外採樣參數。
 */
export const summarizeFetchRequestBody = (body: unknown): FetchRequestSummary | undefined => {
    if (typeof body !== 'string') return undefined;
    const summary: FetchRequestSummary = { bodyBytes: utf8ByteLength(body) };
    try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary;
        if (Array.isArray(parsed.messages)) {
            summary.messageCount = parsed.messages.length;
            summary.contentChars = parsed.messages.reduce((total: number, message: any) => {
                const content = message?.content;
                if (typeof content === 'string') return total + content.length;
                if (content == null) return total;
                try { return total + JSON.stringify(content).length; } catch { return total; }
            }, 0);
            const lastRole = parsed.messages.at(-1)?.role;
            if (typeof lastRole === 'string') summary.lastMessageRole = lastRole;
        }
        if (typeof parsed.stream === 'boolean') summary.stream = parsed.stream;
        const optionalParams = ['top_p', 'frequency_penalty', 'presence_penalty', 'reasoning_effort', 'tools']
            .filter(key => parsed[key] !== undefined);
        if (optionalParams.length > 0) summary.optionalParams = optionalParams;
    } catch { /* 非 JSON 只記錄字節數 */ }
    return summary;
};

const readError = (error: unknown): { name: string; message: string } => {
    if (error instanceof Error) return { name: error.name || 'Error', message: error.message || String(error) };
    if (error && typeof error === 'object') {
        const anyErr = error as { name?: unknown; message?: unknown };
        return {
            name: typeof anyErr.name === 'string' ? anyErr.name : 'Error',
            message: typeof anyErr.message === 'string' ? anyErr.message : String(error),
        };
    }
    return { name: 'Error', message: String(error ?? '') };
};

/**
 * 各家瀏覽器對「連不上」的說法不一樣，漏認一種就會掉進 unknown：
 * Chrome/Edge 是 Failed to fetch，Safari 是 Load failed，Firefox 是
 * NetworkError when attempting to fetch resource。
 */
const looksLikeNetworkError = (message: string) => (
    /failed to fetch/i.test(message)
    || /load failed/i.test(message)
    || /networkerror/i.test(message)
    || /network request failed/i.test(message)
);

/** 把 URL 拆成 origin/host，拆不動（相對路徑、拼錯）時用當前頁面兜底。 */
export const parseTargetUrl = (url: string, base?: string): { ok: boolean; origin: string; host: string; protocol: string; href: string } => {
    try {
        const parsed = new URL(url, base || (typeof location !== 'undefined' ? location.href : undefined));
        return { ok: true, origin: parsed.origin, host: parsed.host, protocol: parsed.protocol, href: parsed.href };
    } catch {
        return { ok: false, origin: '', host: '', protocol: '', href: url };
    }
};

/** http://localhost / 127.0.0.1 在 Chrome 裡算可信來源，不當混合內容攔；Firefox 會攔。 */
const isLoopbackHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

export const classifyFetchFailure = (ctx: FetchFailureContext): FetchFailureKind => {
    const { name, message } = readError(ctx.error);
    // AbortSignal.timeout() 拋的是 TimeoutError（"signal timed out"），跟用戶/組件主動
    // abort 拋的 AbortError 不是一回事：前者說明連接掛住了，必須繼續往下查；後者到此為止。
    // 先按 TimeoutError 判，再判 AbortError——順序反了會把超時吞進「主動取消」。
    if (name === 'TimeoutError' || /timed?\s?out|timeout/i.test(message)) return 'timeout';
    if (name === 'AbortError' || /aborted|abort/i.test(message)) return 'aborted';

    const target = parseTargetUrl(ctx.url);
    if (!target.ok) return 'bad-url';

    const pageProtocol = ctx.pageProtocol ?? (typeof location !== 'undefined' ? location.protocol : '');
    if (pageProtocol === 'https:' && target.protocol === 'http:' && !isLoopbackHost(target.host)) return 'mixed-content';

    const online = ctx.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
    if (online === false) return 'offline';

    if (looksLikeNetworkError(message) || name === 'TypeError') return 'blocked';
    return 'unknown';
};

/** 每種分類給一句「現在能確定什麼」+ 一行「可能是什麼」。 */
const VERDICTS: Record<FetchFailureKind, { verdict: string; causes: string }> = {
    aborted: {
        verdict: '請求被主動取消（頁面/組件卸載了，或調用方自己撤了）。',
        causes: '中途切走了頁面 · 手動點了停止',
    },
    timeout: {
        verdict: '請求超時：在截止時間前未完成。僅憑超時無法判斷是連接、上游處理還是響應傳輸階段。',
        causes: '代理/梯子接下了連接但上游是黑洞 · 這個域名沒走代理、直連被攔截丟包 · 解析到的 IP 不可達 · 對方服務器無響應',
    },
    offline: {
        verdict: '瀏覽器自己報告當前離線，請求根本沒發出去。',
        causes: '網絡斷了 · 梯子剛切換/掉線 · 設備進了飛行模式',
    },
    'mixed-content': {
        verdict: 'https 頁面去打 http 地址，被瀏覽器的混合內容策略直接攔下，請求沒有發出去。',
        causes: '地址少了 s（http:// 應為 https://） · 自建服務沒配證書',
    },
    'bad-url': {
        verdict: '這個地址本身不是合法 URL，請求沒有發出去。',
        causes: '地址填錯/少了 https:// · 複製時帶進了空格或中文引號',
    },
    blocked: {
        verdict: '瀏覽器沒有向頁面提供可讀取的響應；可能是連接失敗，也可能已收到響應但被 CORS 攔截，暫時無法確定。',
        causes: '梯子/代理把這個域名的連接掐了 · DNS 解析不到 · 瀏覽器擴展（廣告攔截/隱私盾/腳本管理器）屏蔽了 · 對方返回的是一張不帶 CORS 頭的頁面（限流、人機驗證、網關報錯）',
    },
    unknown: {
        verdict: '請求失敗，且不符合已知的幾種失敗形態。',
        causes: '看下面的錯誤原文',
    },
};

/**
 * Resource Timing 裡那條記錄能補兩個關鍵旁證：到底有沒有收到響應狀態碼、傳了多少字節。
 *
 * ⚠️ 必須按發起時刻篩。getEntriesByName() 撈的是整個頁面生命週期內打過這個地址的**全部**
 * 記錄，而像 /client-state 這種反覆請求的端點，timeline 裡一直躺著早先成功那次的 200。
 * 偏偏「連接壓根沒建立」的失敗什麼都不會往 timeline 裡寫——於是不篩的話，越是老用戶、
 * 越是之前一直用得好好的地址，越會拿到一條陳舊的成功記錄，並據此打出「對方其實回了 200，
 * 是被 CORS 攔的」，跟同一條日誌裡的耗時線索和 no-cors 複檢結論正面打架。
 *
 * startedAt 用 performance.now() 的基準（跟 entry.startTime 同一條時間軸，不能換成
 * Date.now()）。取不到就整段不出——寧可少說一句，也不能說反。
 */
export const readResourceTimingHint = (
    href: string,
    opts: { startedAt: number; perf?: { getEntriesByName?: (name: string, type?: string) => any[] } },
): string => {
    const { startedAt } = opts;
    if (!Number.isFinite(startedAt)) return '';
    const target = opts.perf ?? (typeof performance !== 'undefined' ? (performance as any) : undefined);
    if (!target?.getEntriesByName) return '';
    let entries: any[] = [];
    try {
        entries = target.getEntriesByName(href, 'resource') || [];
    } catch {
        return '';
    }
    const entry = entries
        .filter(item => typeof item?.startTime === 'number' && item.startTime >= startedAt)
        .pop();
    if (!entry) return 'Resource Timing: 沒有這條請求的記錄；無法據此判斷連接是否建立，或響應是否被瀏覽器隱藏。';
    // 跨域資源拿不到 Timing-Allow-Origin 授權時，規範要求把 responseStatus、transferSize、
    // 各階段時間戳統統置 0。這時候「transferSize=0」的意思是「沒授權看」，不是「一個字節都
    // 沒傳」——照字面讀會得出跟事實相反的結論，所以這些字段整個不印，改成一句說明。
    // responseStart 是判斷有沒有授權最穩的探針：它比 responseStatus 老得多，Safari 也有。
    const timingAllowed = (typeof entry.responseStart === 'number' && entry.responseStart > 0)
        || (typeof entry.responseStatus === 'number' && entry.responseStatus > 0);
    const parts: string[] = [];
    if (timingAllowed) {
        if (typeof entry.responseStatus === 'number' && entry.responseStatus > 0) {
            parts.push(`responseStatus=${entry.responseStatus}`);
        }
        if (typeof entry.transferSize === 'number') parts.push(`transferSize=${entry.transferSize}`);
    }
    if (typeof entry.duration === 'number') parts.push(`duration=${Math.round(entry.duration)}ms`);
    let note = '';
    if (timingAllowed && typeof entry.responseStatus === 'number' && entry.responseStatus > 0) {
        note = ` → 對方其實回了 HTTP ${entry.responseStatus}，是響應被 CORS 攔掉的，不是網絡不通`;
    } else if (!timingAllowed) {
        note = '（對方沒給 Timing-Allow-Origin，狀態碼和字節數看不到，只有耗時可信）';
    }
    return `Resource Timing: ${parts.join(', ') || '有記錄'}${note}`;
};

/**
 * 耗時只能幫助縮小範圍，不能區分 DNS、握手、上游處理和響應 CORS 檢查。
 */
export const readStallHint = (durationMs?: number, kind?: FetchFailureKind): string => {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '';
    if (kind && kind !== 'blocked' && kind !== 'timeout' && kind !== 'unknown') return '';
    if (durationMs >= 5000) {
        return `耗時線索: ${(durationMs / 1000).toFixed(1)}s 後失敗，可能涉及代理/連接等待、上游處理或傳輸中斷；也可能是較晚返回的響應被 CORS 攔截，不能僅憑耗時確定失敗階段。`;
    }
    if (durationMs <= 300) {
        return `耗時線索: ${Math.round(durationMs)}ms 就失敗，可能是快速的 CORS 拒絕、DNS/代理失敗或擴展攔截；不能僅憑耗時認定請求未發出。`;
    }
    return '';
};

/**
 * 拼出寫進調試終端 detail 的那一段。同步、無副作用——no-cors 複檢結論由
 * describeReachabilityProbe() 單獨產出，異步補到這段後面。
 */
export const buildFetchFailureDetail = (
    ctx: FetchFailureContext,
    opts: { startedAt: number; perf?: { getEntriesByName?: (name: string, type?: string) => any[] }; now?: number },
): string => {
    const { name, message } = readError(ctx.error);
    const kind = classifyFetchFailure(ctx);
    const target = parseTargetUrl(ctx.url);
    const pageOrigin = ctx.pageOrigin ?? (typeof location !== 'undefined' ? location.origin : '');
    const online = ctx.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
    const method = (ctx.method || 'GET').toUpperCase();

    const lines: string[] = [];
    lines.push(`URL: ${ctx.url}`);
    const durationText = typeof ctx.durationMs === 'number' ? ` · 失敗於 ${ctx.durationMs}ms` : '';
    lines.push(`請求: ${method}${durationText}`);
    lines.push(`錯誤: ${name}: ${message}`);
    if (target.ok) {
        const crossOrigin = pageOrigin && target.origin !== pageOrigin;
        lines.push(`目標域名: ${target.host}${crossOrigin ? '（跨域請求，受 CORS 約束）' : '（同源）'}`);
    }
    if (pageOrigin) lines.push(`本頁來源: ${pageOrigin}`);
    lines.push(`瀏覽器聯網狀態: ${online === false ? '離線' : '在線'}`);
    if (ctx.requestPurpose) lines.push(`調用用途: ${ctx.requestPurpose}`);
    if (ctx.requestSummary) {
        const requestParts = [`${ctx.requestSummary.bodyBytes} bytes`];
        if (typeof ctx.requestSummary.messageCount === 'number') requestParts.push(`messages=${ctx.requestSummary.messageCount}`);
        if (typeof ctx.requestSummary.contentChars === 'number') requestParts.push(`消息內容=${ctx.requestSummary.contentChars} 字符`);
        if (ctx.requestSummary.lastMessageRole) requestParts.push(`末條 role=${ctx.requestSummary.lastMessageRole}`);
        if (typeof ctx.requestSummary.stream === 'boolean') requestParts.push(`stream=${ctx.requestSummary.stream}`);
        lines.push(`請求體摘要: ${requestParts.join(' · ')}`);
        if (ctx.requestSummary.optionalParams?.length) {
            lines.push(`額外參數: ${ctx.requestSummary.optionalParams.join(', ')}`);
        }
    }
    const timing = readResourceTimingHint(target.href, { startedAt: opts.startedAt, perf: opts.perf });
    if (timing) lines.push(timing);
    const stall = readStallHint(ctx.durationMs, kind);
    if (stall) lines.push(stall);
    const now = opts.now ?? Date.now();
    const recentSuccess = ctx.recentSuccessfulSameRequest;
    const successAgeMs = recentSuccess ? now - recentSuccess.timestamp : Number.POSITIVE_INFINITY;
    const hasRecentSameRequestSuccess = kind === 'blocked'
        && successAgeMs >= 0
        && successAgeMs <= 10 * 60 * 1000;
    if (hasRecentSameRequestSuccess && recentSuccess) {
        const ageSeconds = Math.max(1, Math.round(successAgeMs / 1000));
        lines.push(`同接口對照: ${ageSeconds} 秒前，同一個 ${method} 已成功返回 HTTP ${recentSuccess.status}`);
        lines.push('初判: 同一接口剛剛成功過，基本排除域名整體不可達、DNS 錯誤或代理把整個域名攔掉；這是當前請求/響應特有的失敗。');
        if (ctx.requestPurpose === '劇情見面生成') {
            lines.push('更可能原因: 劇情上下文或請求體更大 · 服務商不接受末條 assistant 預填充或額外參數 · 上游生成/流式傳輸中途斷開 · 上游錯誤頁漏了 CORS 響應頭');
        } else {
            lines.push('更可能原因: 當前請求體或響應與剛才成功的請求不同 · 上游限流或臨時故障 · 生成/傳輸中途斷開 · 上游錯誤頁漏了 CORS 響應頭');
        }
    } else {
        lines.push(`初判: ${VERDICTS[kind].verdict}`);
        lines.push(`可能原因: ${VERDICTS[kind].causes}`);
    }
    return lines.join('\n');
};

// ─── no-cors 連通性複檢 ───

export type ReachabilityVerdict = 'reachable' | 'unreachable' | 'timeout' | 'cooldown' | 'skipped';

/**
 * 只有「拿不到響應」和「超時」兩類值得複檢：
 * 主動取消 / 混合內容 / 地址非法 / 離線 都已經有確定結論，再打一次純屬浪費。
 */
export const shouldProbeReachability = (kind: FetchFailureKind): boolean => (
    kind === 'blocked' || kind === 'timeout' || kind === 'unknown'
);

/** 同一個域名 30s 內只複檢一次，避免一串請求同時炸時打出一片探測流量。 */
const probeCooldown = new Map<string, number>();
const PROBE_COOLDOWN_MS = 30_000;

export const resetReachabilityProbeCooldown = () => probeCooldown.clear();

/**
 * 用 no-cors 打一次目標域名的根路徑，只為回答一個問題：這台設備到底能不能碰到這個域名。
 *
 * - 打根路徑而不是原地址：原地址可能是有副作用的接口（下單、發消息），複檢不該順手觸發它；
 *   而 DNS / 梯子 / 防火牆 / 擴展這幾層攔的都是整個域名，打根路徑一樣能測出來。
 * - no-cors 拿到的是 opaque 響應，讀不出狀態碼——但「拿到了」本身就是結論。
 */
export const probeOriginReachability = async (
    url: string,
    fetchImpl: typeof fetch,
    opts?: { timeoutMs?: number; now?: () => number },
): Promise<ReachabilityVerdict> => {
    const target = parseTargetUrl(url);
    if (!target.ok || !target.origin || target.origin === 'null') return 'skipped';

    const now = opts?.now ?? (() => Date.now());
    const last = probeCooldown.get(target.origin);
    const at = now();
    if (typeof last === 'number' && at - last < PROBE_COOLDOWN_MS) return 'cooldown';
    probeCooldown.set(target.origin, at);

    const timeoutMs = opts?.timeoutMs ?? 6000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
        await fetchImpl(`${target.origin}/`, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'follow',
            signal: controller?.signal,
        });
        return 'reachable';
    } catch (e) {
        const { name } = readError(e);
        return name === 'AbortError' ? 'timeout' : 'unreachable';
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

/** 把複檢結論翻成給人看的一句話 + 下一步該往哪查。 */
export const describeReachabilityProbe = (verdict: ReachabilityVerdict, host: string, method = 'GET'): string => {
    const who = host || '該域名';
    switch (verdict) {
        case 'reachable':
            return `連通性複檢: no-cors 直連 ${who} 成功 → 只能確認這個域名當前可達，不能確認原文件或接口可用；原 ${method.toUpperCase()} 可能被網關關閉、鏈接失效，或因響應缺少 CORS 頭而被瀏覽器攔截。`
                + (method.toUpperCase() === 'POST' ? '上游若已開始生成，即使頁面顯示失敗也可能計費；請先核對服務商日誌，不要連續重發。' : '資源加載失敗不等於生成失敗；請檢查原資源鏈接的有效期及響應頭。');
        case 'unreachable':
            return `連通性複檢: no-cors 直連 ${who} 同樣失敗 → 這台設備到 ${who} 是真的連不上。按順序查：梯子的分流規則（把該域名放進代理）、DNS、瀏覽器擴展（廣告攔截/隱私盾）、系統或路由器防火牆。`;
        case 'timeout':
            return `連通性複檢: no-cors 直連 ${who} 超時（連接掛住不返回）→ 多半是代理/網關把連接吞了，或對方正被限速。優先換一個梯子節點再試。`;
        case 'cooldown':
            return `連通性複檢: 30 秒內已對 ${who} 檢測過，結論看這條之前那一條日誌（同一次故障刷出來的多條，複檢結果是一樣的）。`;
        default:
            return '';
    }
};

/** 給調試終端用的通用自查清單——網絡類錯誤一律先照這個走一遍。 */
export const NETWORK_SELF_CHECK_STEPS: string[] = [
    '換一個梯子節點，或先關掉梯子直連試一次——兩種都失敗才說明不是線路問題',
    '把瀏覽器擴展（廣告攔截、隱私盾、腳本管理器）全禁掉再試，或換用無痕窗口',
    '在新標籤頁直接打開日誌裡那個 URL：能出 JSON 說明網絡通，是頁面這邊的跨域被攔；打不開就是線路/DNS 的事',
    '換一個瀏覽器或換手機熱點各試一次，能定位到是「這台設備」還是「這個網絡」',
    '如果只有部分功能報錯，去設置裡看對應的服務地址是不是填錯了（少 https://、多空格、多結尾斜槓）',
];
