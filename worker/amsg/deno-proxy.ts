/**
 * amsg 的 Deno 門面 —— 給 Cloudflare worker 換一個國內能直連的地址。
 *
 * 主動消息的 worker 跑在 Cloudflare 上，默認地址是 `*.workers.dev`，這個域名
 * 在國內連不上。這份腳本部署到 Deno Deploy 之後會拿到一個 `*.deno.net` 地址，
 * 它只做一件事：把收到的請求原樣轉給你自己的 Cloudflare worker，再把響應原樣
 * 送回來。業務邏輯、D1 數據庫、Cron 定時任務全都還留在 Cloudflare，這一層不存
 * 任何數據、不認任何業務端點。
 *
 * 怎麼用：
 *   1. 打開 console.deno.com，點右上角「New Playground」
 *   2. 把這份文件整個貼進去
 *   3. 改下面 `UPSTREAM` 那一行，填你自己的 Cloudflare worker 地址
 *   4. 部署後拿到的 `https://xxx.deno.net` 地址，填進 SullyOS
 *      「設置 → 主動消息 → Worker 地址」，替換原來的 workers.dev 地址
 *
 * 兩件值得先知道的事：
 *   - 推送不走這條路。Cloudflare worker 是直接把消息發給 FCM / APNs 的，
 *     跟瀏覽器怎麼訪問 worker 是兩條獨立的路。所以這層掛了不影響收消息，
 *     只影響你打開設置面板改配置。
 *   - 設置頁裡「去 Cloudflare 控制台」那個鏈接靠 workers.dev 域名反推 worker
 *     名字，換成 deno.net 之後會退化成跳 worker 列表頁，得自己再點一下。
 */

/**
 * 你自己的 Cloudflare amsg worker 地址（就是原來填在 SullyOS 設置裡的那個）。
 * 不想把地址寫在代碼裡的話，可以留空不動，改在 Deno 的 Settings → Environment
 * Variables 里加一個 `AMSG_UPSTREAM`，那邊的值優先。
 */
const UPSTREAM = 'https://sullyos-amsg.你的帳號.workers.dev';

/**
 * 代理自己的自檢端點，跟上游無關。部署完直接在瀏覽器打開它，能看到 JSON 就說明
 * 這一層活著、上游地址也填對了。amsg 的端點都是 `/init-tenant` 這種單詞形式，
 * 不會跟雙下劃線開頭的路徑撞車。
 */
const HEALTH_PATH = '/__proxy-health';

/**
 * 改完這份腳本請順手把這裡 +1。自檢端點會把它報出來，是唯一能確認
 * 「Playground 裡跑的到底是哪一版」的辦法 —— 版本號不動的話，
 * 貼沒貼成功、部署有沒有生效，全靠猜。
 */
const PROXY_REVISION = 'amsg-deno-proxy-v2';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

/**
 * 轉發響應時必須摘掉的頭。
 *
 * 前四個是逐跳（hop-by-hop）頭：只描述「這一段 TCP 連接」，跨代理帶過去沒有意義。
 * `content-encoding` / `content-length` 是更要命的一對 —— fetch 拿到 gzip 響應時
 * 會自動解壓，但這兩個頭描述的還是壓縮前的狀態。原樣帶回瀏覽器的話，瀏覽器會拿
 * 已經解開的 body 再解一次壓，直接讀失敗。摘掉之後 Deno Deploy 出口會按瀏覽器的
 * accept-encoding 重新壓一遍，端到端的壓縮收益不會丟。
 */
const STRIPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
];

/** 上游地址：環境變量優先，都沒有就用文件頂上那個常量。統一去掉尾斜槓。 */
const resolveUpstream = (): string =>
  (Deno.env.get('AMSG_UPSTREAM') || UPSTREAM).trim().replace(/\/+$/, '');

/** 佔位符沒改就算沒配 —— 與其悶頭往一個不存在的域名轉發，不如直接說清楚。 */
export const isConfigured = (upstream: string): boolean =>
  /^https?:\/\//i.test(upstream) && !upstream.includes('你的帳號');

/** 把進來的請求改寫成打給上游的請求：換掉 host，路徑和查詢串原樣保留。 */
export const buildUpstreamRequest = (request: Request, upstream: string): Request => {
  const incoming = new URL(request.url);
  const target = new URL(upstream);
  // 上游地址允許帶路徑前綴（少見但合法），拼接時不要把它吃掉。
  target.pathname = `${target.pathname.replace(/\/+$/, '')}${incoming.pathname}`;
  target.search = incoming.search;

  const headers = new Headers(request.headers);
  // host 交給 fetch 按目標地址自己填，否則上游會收到 deno.net 的 host。
  headers.delete('host');
  // 壓縮協商也交給 fetch 自己做，別把瀏覽器那份原樣轉過去。
  //
  // 瀏覽器會要 zstd，上游就用 zstd 壓著回來；而 fetch 只自動解開它自己協商的那幾種
  // （gzip / deflate / br），zstd 不在內，body 於是還是壓縮態。下面 relayResponse 又
  // 按「已經解開了」把 content-encoding 摘掉，出口便拿這坨壓縮字節當明文再壓一層，
  // 瀏覽器解完外層拿到的還是壓縮數據 —— 頁面上就是一片亂碼。
  //
  // 刪掉之後 fetch 用自己認得的編碼去協商、拿回明文，摘頭才名副其實，
  // 出口再按瀏覽器的 accept-encoding 重新壓一遍，端到端的壓縮收益一點不少。
  headers.delete('accept-encoding');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // 上游返回 3xx 時不要自動跟過去，原樣交給瀏覽器判斷。
    redirect: 'manual',
  };
  // 流式轉發請求體（配置上雲可能不小）時，fetch 標準要求顯式聲明 duplex。
  // TS 的 RequestInit 還沒收錄這個字段，所以在這裡單獨掛上去。
  if (hasBody) (init as { duplex?: string }).duplex = 'half';

  return new Request(target.toString(), init);
};

/** 原樣回傳上游響應，只摘掉那些跨代理會出問題的頭。 */
export const relayResponse = (upstreamResponse: Response): Response => {
  const headers = new Headers(upstreamResponse.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
};

/**
 * 代理層自己造的響應（自檢、錯誤回執）必須帶 CORS 頭。
 *
 * 不帶的話，上游連不上、地址沒配這類錯誤在瀏覽器裡全部顯示成
 * 「No 'Access-Control-Allow-Origin' header is present」—— 真正的原因連同
 * 狀態碼一起被擋在外面，排查的人只能看見一個跟病因毫不相干的 CORS 報錯。
 * 轉發回來的響應不用管，CF 那邊自帶 CORS 頭。
 */
const SELF_RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: SELF_RESPONSE_HEADERS,
  });

/** 抽出來是為了能在測試裡直接調，不必真起一個服務。 */
export const handleRequest = async (request: Request): Promise<Response> => {
  const upstream = resolveUpstream();
  const pathname = new URL(request.url).pathname;

  if (pathname === HEALTH_PATH) {
    return json(
      {
        ok: isConfigured(upstream),
        revision: PROXY_REVISION,
        upstream: isConfigured(upstream) ? upstream : null,
        hint: isConfigured(upstream)
          ? '這一層活著。把當前 deno.net 地址填進 SullyOS 的主動消息設置即可。'
          : '還沒填上游地址：改腳本里的 UPSTREAM 常量，或加一個 AMSG_UPSTREAM 環境變量。',
      },
      isConfigured(upstream) ? 200 : 503,
    );
  }

  if (!isConfigured(upstream)) {
    return json({ error: `代理沒配上游地址，打開 ${HEALTH_PATH} 看說明。` }, 503);
  }

  try {
    return relayResponse(await fetch(buildUpstreamRequest(request, upstream)));
  } catch (error) {
    // 上游連不上（地址填錯、Cloudflare 那邊掛了）時給個能看懂的回執，
    // 別讓前端只拿到一個沒有上下文的 500。
    return json(
      {
        error: '連不上 Cloudflare worker',
        upstream,
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
};

Deno.serve(handleRequest);
