// 網頁分享 — 把用戶粘貼的網址抓成「角色能看見」的純文字。
//
// 設計目標（對齊 html_card / xhs_card 的「卡片給人看、純文字摘要喂 LLM」模式）：
//  1) 用戶在聊天裡粘貼一個 http(s) 鏈接 → 抓取網頁 → 存成 webpage_card 消息；
//  2) 卡片在聊天裡渲染成標題 + 摘要的小卡（components/chat/MessageItem.tsx）；
//  3) 上下文 / 歸檔只看到剝離 HTML 後的純文字正文（utils/messageFormat.ts），角色就「讀到」了網頁內容。
//
// 提取鏈路（extractWebpageContent，逐層降級）：
//  1. apizero content-extract（主）：服務端文本密度算法，瀏覽器直連（CORS 全開），
//     正文乾淨、配額充裕（匿名 5000 次/天/IP，帶 key 10000 次/天，key 與 videoParser 共用）。
//     疑似 SPA 殼（正文過短）/ 服務掛了 → 降級下一層。
//  2. 用戶配置 Firecrawl 時，用 /scrape 讀取動態頁（Key 本地保存，直接請求服務商）。
//  3. sfworker /fetch-webpage（Jina Reader 無頭渲染，SPA 也能讀）→ 失敗退裸 HTML。
//  4. 前端直連抓裸 HTML + DOMParser 啟發式提取（多數站點會被 CORS 擋掉，純末路兜底）。

import { htmlToText } from './htmlPrompt';
import { getProxyWorkerUrl } from './proxyWorker';
import { getVideoParseKey } from './videoParser';
import { getFirecrawlApiKey, scrapeWebpageWithFirecrawl } from './firecrawl';

// sfworker：項目自帶的通用代理 Worker（小紅書籤名 / 網易雲 weapi / Brave 搜索 / WebDAV /
// 網頁抓取都走它，代碼見 worker/index.js）。地址走中心配置 utils/proxyWorker.ts，
// 用戶可在「設置 → 網絡代理 (Worker)」裡換成自部署實例。
const sfworkerUrl = (): string => getProxyWorkerUrl();

/** 視頻平台分享的附加信息（utils/videoParser.ts 解析產出，webpage_card 複用展示）。 */
export interface VideoShareInfo {
  /** 平台標識（bilibili / douyin / …）。 */
  platform: string;
  /** 平台中文名（嗶哩嗶哩 / 抖音），卡片角標用。 */
  platformLabel?: string;
  /** 視頻還是圖集。 */
  contentType?: 'video' | 'image';
  authorName?: string;
  authorAvatar?: string;
  playCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  collectCount?: number;
  /** 原平台發佈時間（字符串原樣保留）。 */
  publishTime?: string;
  /** 圖集張數（contentType === 'image' 時）。 */
  imageCount?: number;
}

/** 抓取並解析後的網頁結構。卡片 metadata 存這一份。 */
export interface ExtractedWebpage {
  /** 抓取用的原始 URL（跳轉後可能與 finalUrl 不同）。 */
  url: string;
  /** 重定向後的最終 URL（worker 能拿到時回填，否則等於 url）。 */
  finalUrl?: string;
  /** 網頁標題（<title> / og:title）。 */
  title: string;
  /** 站點名（og:site_name / 域名兜底）。 */
  siteName?: string;
  /** 提取出的正文純文字（已截斷到 MAX_CONTENT_CHARS）。 */
  content: string;
  /** 短摘要（meta description / 正文開頭）。 */
  excerpt: string;
  /** 封面圖 URL（og:image / 正文首圖），卡片顯示用。 */
  image?: string;
  /** 正文是否因超長被截斷。 */
  truncated: boolean;
  /** 抓取時間戳。 */
  fetchedAt: number;
  /** 實際命中的抓取來源，便於診斷和實時展示，不參與角色提示詞。 */
  provider?: 'apizero-content' | 'apizero-video' | 'firecrawl' | 'jina' | 'worker-raw' | 'direct';
  /** 視頻平台分享時的附加信息（走 videoParser 解析路徑才有）。 */
  video?: VideoShareInfo;
}

/** 卡片 metadata 里正文的存儲上限：太長既佔 IndexedDB 也沒必要全留。 */
const MAX_CONTENT_CHARS = 8000;
/** 摘要長度。 */
const EXCERPT_CHARS = 140;

/** apizero content-extract 端點（與 videoParser 的 video-parse 同一服務商、同一 key）。 */
const APIZERO_EXTRACT_ENDPOINT = 'https://v1.apizero.cn/api/content-extract';
/** 提取正文短於這個就當失敗：多半是 SPA 殼 / 反爬佔位頁，讓 Jina（無頭渲染）接手。 */
const MIN_EXTRACT_CHARS = 80;
const APIZERO_TIMEOUT_MS = 20000;

/**
 * 從一段文本里揪出第一個 http(s) 鏈接。返回 null 表示沒有可抓的鏈接。
 * 末尾的常見標點（。，！？、）以及成對括號不算進 URL，避免把中文句號粘進去。
 */
export function detectFirstUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s，。！？；、"'《》()（）【】]+/i);
  if (!m) return null;
  // 去掉尾部可能誤吞的英文標點
  return m[0].replace(/[.,;:!?'")\]]+$/, '');
}

const XHS_NOTE_PATH_RE = /^\/(?:discovery\/item|explore|item)\/([a-f0-9]{24})(?:[/?#]|$)/i;
const XHS_SHORT_HOSTS = ['xhslink.com', 'xhslink.cn'];

function isXhsHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return ['xiaohongshu.com', 'rednote.com', ...XHS_SHORT_HOSTS]
    .some(domain => host === domain || host.endsWith(`.${domain}`));
}

/**
 * 從分享文案中提取小紅書短鏈。
 * 桌面/舊版常見 xhslink.com，手機版新版會生成 xhslink.cn。
 */
export function detectXhsShortUrl(text: string): string | null {
  if (!text) return null;

  const candidates: string[] = [...(text.match(/https?:\/\/[^\s，。！？；、"'《》()（）【】]+/ig) || [])];
  const naked = text.match(/(?:^|[\s，。！？；、"'《》()（）【】])((?:www\.)?xhslink\.(?:com|cn)\/[A-Za-z0-9/_-]+)/i)?.[1];
  if (naked) candidates.push(`https://${naked}`);

  for (const candidate of candidates) {
    try {
      const cleaned = candidate.replace(/[.,;:!?'")\]]+$/, '');
      const parsed = new URL(cleaned);
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      if (XHS_SHORT_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
        return cleaned;
      }
    } catch {
      // 忽略壞鏈接，繼續檢查下一個 URL。
    }
  }
  return null;
}

function cleanXhsShareTitle(raw: string): string {
  return raw
    .replace(/\s*[|｜]\s*(?:小[红紅][书書]|REDnote).*$/i, '')
    .replace(/\s*(?:\.{2,}|…+|。{2,})\s*$/u, '')
    .replace(/^[\s“”"'「」『』《》]+|[\s“”"'「」『』《》]+$/g, '')
    .trim();
}

/**
 * 從小紅書分享文案中提取卡片標題。
 *
 * 桌面舊版常見「【標題 | 小紅書】」，手機新版則是
 * 「標題 ... http://xhslink.cn/... 打開【小紅書】即可查看」。
 * 後一種不能直接取第一個【】塊，否則會把應用名“小紅書”誤當標題。
 */
export function extractXhsShareTitle(text: string): string {
  if (!text) return '';

  const bracketed = [...text.matchAll(/【(.+?)】/g)]
    .map(match => cleanXhsShareTitle(match[1] || ''))
    .find(candidate => candidate && !/^(?:小[红紅][书書]|REDnote)$/i.test(candidate));
  if (bracketed) return bracketed;

  const urls = text.match(/https?:\/\/[^\s，。！？；、'"」』）】]+/ig) || [];
  const xhsUrl = urls.find(candidate => isXhsUrl(candidate.replace(/[.,;:!?'"）)\]】]+$/, '')));
  if (!xhsUrl) return '';

  const prefix = cleanXhsShareTitle(text.slice(0, text.indexOf(xhsUrl)).replace(/\[$/, ''));
  return /^(?:小[红紅][书書]|REDnote)$/i.test(prefix) ? '' : prefix;
}

/** XHS 鏈接已有專門的 MCP 卡片路徑，網頁抓取要避開它，免得搶同一條消息。 */
export function isXhsUrl(url: string): boolean {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return isXhsHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 從完整分享文案或單個鏈接中提取小紅書筆記 ID 和已解碼的 token。
 * 同時支持國內域名 xiaohongshu.com 和新版國際域名 rednote.com；
 * xhslink.com / xhslink.cn 短鏈沒有 ID，需先 expandShortUrl 後再調用本函數。
 */
export function extractXhsNoteLink(text: string): { noteId: string; xsecToken?: string } | null {
  if (!text) return null;

  const candidates: string[] = [...(text.match(/https?:\/\/[^\s，。！？；、"'《》()（）【】]+/ig) || [])];
  const naked = text.match(/(?:^|[\s，。！？；、"'《》()（）【】])((?:www\.)?(?:xiaohongshu\.com|rednote\.com)\/[^\s，。！？；、"'《》()（）【】]+)/i)?.[1];
  if (naked) candidates.push(`https://${naked}`);

  for (const candidate of candidates) {
    try {
      // 分享文本可能來自 Markdown；只還原鏈接中的常見轉義。
      let parsed = new URL(candidate.replace(/\\([_&])/g, '$1').replace(/[.,;:!?'")\]]+$/, ''));
      for (let depth = 0; depth < 4; depth++) {
        const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
        const isNoteHost = ['xiaohongshu.com', 'rednote.com']
          .some(domain => host === domain || host.endsWith(`.${domain}`));
        if (!isNoteHost || !/^https?:$/.test(parsed.protocol)) break;
        const noteId = parsed.pathname.match(XHS_NOTE_PATH_RE)?.[1];
        if (noteId) {
          // URLSearchParams 解碼一次即可：手機分享常帶 %3D，不能原樣送給詳情 API。
          return { noteId, xsecToken: parsed.searchParams.get('xsec_token') || undefined };
        }
        // 兼容舊代理一路 follow 到驗證碼頁的響應，不需要訪問或通過驗證碼。
        if (parsed.pathname !== '/website-login/captcha') break;
        const redirectPath = parsed.searchParams.get('redirectPath');
        if (!redirectPath) break;
        parsed = new URL(redirectPath, parsed.origin);
      }
    } catch {
      // 忽略文案裡的壞鏈接，繼續檢查下一個 URL。
    }
  }
  return null;
}

export function extractXhsNoteId(text: string): string | null {
  return extractXhsNoteLink(text)?.noteId || null;
}

/**
 * 經 sfworker 展開短鏈（xhslink.com / xhslink.cn 等），返回跟隨 HTTP 重定向後的最終 URL。
 * 小紅書短鏈不含 note id / xsec_token，展開後才拿得到。
 */
export async function expandShortUrl(url: string): Promise<string> {
  const res = await fetch(`${sfworkerUrl()}/expand-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    // 小紅書短鏈在部分網絡/代理組合下會一直掛起。及時失敗，交給聊天頁給出
    // 可操作的網絡提示，避免用戶看到“發送後什麼都沒發生”。
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!res.ok || !parsed?.success) {
    const err = parsed?.error;
    throw new Error((err && (err.message || err)) || `短鏈展開失敗 (HTTP ${res.status})`);
  }
  return String(parsed?.data?.finalUrl || url);
}

/** sfworker /fetch-webpage 的返回：reader=已渲染提取的乾淨正文；raw=原始 HTML 待前端解析。 */
type WorkerFetchResult =
  | { mode: 'reader'; title: string; content: string; finalUrl?: string }
  | { mode: 'raw'; html: string; finalUrl?: string };

/**
 * 通過 sfworker 的 /fetch-webpage 代理抓取網頁（繞過瀏覽器 CORS）。
 * worker 優先用 Jina Reader 渲染 + 正文提取（SPA 也能讀），失敗回退裸 HTML。
 * 失敗拋錯（由 extractWebpageContent 兜底到直連）。
 */
async function fetchViaWorker(url: string): Promise<WorkerFetchResult> {
  const res = await fetch(`${sfworkerUrl()}/fetch-webpage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }

  if (!res.ok || !parsed?.success) {
    // sfworker 失敗返回 { error: '中文說明' }（字符串）；也兼容 { error: { message } }。
    const err = parsed?.error;
    const msg = (err && (err.message || err)) || `網頁抓取失敗 (HTTP ${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : '網頁抓取失敗');
  }
  const data = parsed?.data || {};
  if (data.mode === 'reader' && typeof data.content === 'string' && data.content.trim()) {
    return { mode: 'reader', title: String(data.title || ''), content: data.content, finalUrl: data.finalUrl };
  }
  const html = String(data.html || '');
  if (!html) throw new Error('worker 返回的網頁內容為空');
  return { mode: 'raw', html, finalUrl: data.finalUrl };
}

/** 直連兜底：大多數站點會被 CORS 擋掉，僅對放開跨域的頁面有效。 */
async function fetchHtmlDirect(url: string): Promise<{ html: string }> {
  const res = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`直連抓取失敗 (HTTP ${res.status})`);
  const html = await res.text();
  if (!html) throw new Error('網頁內容為空');
  return { html };
}

/** 從一段正文生成短摘要（截到 EXCERPT_CHARS）。 */
function makeExcerpt(text: string): string {
  const t = (text || '').trim();
  return t.length > EXCERPT_CHARS ? t.slice(0, EXCERPT_CHARS).trim() + '…' : t;
}

/** 從 URL 取站點名（去掉 www.）。 */
function siteNameFromUrl(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return undefined; }
}

/**
 * 把 HTML 解析成「正文純文字 + 標題 + 摘要」。純前端用 DOMParser，不引第三方庫。
 * 啟發式：去掉 script/style/nav/header/footer/aside 等噪音節點，優先取 <article>/<main>，
 * 退而取 <body>，再用現成的 htmlToText() 轉純文字。
 */
export function parseWebpageHtml(html: string, url: string): {
  title: string;
  siteName?: string;
  content: string;
  excerpt: string;
  image?: string;
} {
  let title = '';
  let siteName: string | undefined;
  let metaDesc = '';
  let content = '';
  let image: string | undefined;

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 標題：og:title 優先，其次 <title>。
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    title = (ogTitle || doc.querySelector('title')?.textContent || '').trim();

    siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() || undefined;
    metaDesc = (
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      ''
    ).trim();
    // 封面圖：og:image / twitter:image。
    image = (
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
      ''
    ).trim() || undefined;

    // 幹掉明顯的非正文噪音節點。
    doc.querySelectorAll(
      'script, style, noscript, nav, header, footer, aside, form, svg, iframe, button, [aria-hidden="true"]'
    ).forEach((el) => el.remove());

    const main = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    content = htmlToText(main?.innerHTML || '');
  } catch {
    // DOMParser 不可用（極端環境）時退回純正則剝標籤。
    content = htmlToText(html);
  }

  if (!siteName) {
    try { siteName = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  }

  let truncatedContent = content;
  if (truncatedContent.length > MAX_CONTENT_CHARS) {
    truncatedContent = truncatedContent.slice(0, MAX_CONTENT_CHARS);
  }

  const excerptSource = metaDesc || truncatedContent;
  const excerpt = excerptSource.length > EXCERPT_CHARS
    ? excerptSource.slice(0, EXCERPT_CHARS).trim() + '…'
    : excerptSource.trim();

  return {
    title: title || siteName || '網頁',
    siteName,
    content: truncatedContent,
    excerpt,
    image,
  };
}

/** 從 Jina Reader 的 markdown 正文裡揪出第一張圖片 URL（![alt](url)）作封面。 */
function firstImageFromMarkdown(md: string): string | undefined {
  const m = md.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
  return m ? m[1] : undefined;
}

/**
 * 主路徑：apizero content-extract 服務端正文提取（瀏覽器直連）。
 * 業務失敗 / 正文過短（疑似 SPA 殼）拋錯，由 extractWebpageContent 降級到 Jina 鏈路。
 */
async function extractViaApizero(url: string): Promise<ExtractedWebpage> {
  const params = new URLSearchParams({ url });
  const key = getVideoParseKey(); // apizero 的 key 是帳號級的，視頻解析 / 正文提取通用
  if (key) params.set('key', key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIZERO_TIMEOUT_MS);
  let parsed: any = null;
  try {
    const res = await fetch(`${APIZERO_EXTRACT_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
    const text = await res.text().catch(() => '');
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!parsed) throw new Error(`正文提取服務無響應 (HTTP ${res.status})`);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('正文提取超時');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (Number(parsed.code) !== 0) {
    throw new Error(String(parsed.msg || `正文提取失敗 (code ${parsed.code})`));
  }
  const d: any = parsed.data || {};
  const rawContent = String(d.content || '').trim();
  if (rawContent.length < MIN_EXTRACT_CHARS) throw new Error('提取到的正文過短');

  const content = rawContent.length > MAX_CONTENT_CHARS ? rawContent.slice(0, MAX_CONTENT_CHARS) : rawContent;
  const finalUrl = String(d.url || '') || undefined;
  const siteName = siteNameFromUrl(finalUrl || url);
  const images: string[] = Array.isArray(d.images)
    ? d.images.filter((u: any) => typeof u === 'string' && /^https?:\/\//i.test(u))
    : [];
  return {
    url,
    finalUrl,
    title: String(d.title || '').trim() || siteName || '網頁',
    siteName,
    content,
    excerpt: makeExcerpt(content),
    image: images[0],
    truncated: rawContent.length > MAX_CONTENT_CHARS,
    fetchedAt: Date.now(),
    provider: 'apizero-content',
  };
}

/**
 * 抓取 + 解析一個網頁，返回可直接塞進 webpage_card metadata 的結構。
 * 抓取失敗（CORS / worker 報錯 / 網絡）時拋錯，調用方負責給用戶 toast。
 */
export async function extractWebpageContent(url: string): Promise<ExtractedWebpage> {
  // 主路徑：apizero 正文提取。失敗（服務掛 / SPA 殼 / 配額）降級到 sfworker/Jina 老鏈路。
  const viaApizero = await extractViaApizero(url).catch((e) => {
    console.warn('[webpageExtractor] apizero extract failed, fallback to worker/Jina:', e);
    return null;
  });
  if (viaApizero) return viaApizero;

  // 用戶自備 Firecrawl Key 時，用它接手 apizero 抓不到的動態頁。Key 只在本機保存，
  // 客戶端直連 Firecrawl，不經過公共 Worker，也不會擠作者的共享額度。
  if (getFirecrawlApiKey()) {
    const viaFirecrawl = await scrapeWebpageWithFirecrawl(url).catch((e) => {
      console.warn('[webpageExtractor] Firecrawl failed, fallback to worker/Jina:', e);
      return null;
    });
    if (viaFirecrawl) {
      const rawContent = viaFirecrawl.markdown;
      const content = rawContent.length > MAX_CONTENT_CHARS ? rawContent.slice(0, MAX_CONTENT_CHARS) : rawContent;
      const finalUrl = viaFirecrawl.finalUrl;
      const siteName = siteNameFromUrl(finalUrl || url);
      return {
        url,
        finalUrl,
        title: viaFirecrawl.title || siteName || '網頁',
        siteName,
        content,
        excerpt: makeExcerpt(content),
        image: viaFirecrawl.image || firstImageFromMarkdown(rawContent),
        truncated: rawContent.length > MAX_CONTENT_CHARS,
        fetchedAt: Date.now(),
        provider: 'firecrawl',
      };
    }
  }

  const viaWorker = await fetchViaWorker(url).catch((e) => {
    // sfworker 抓取報錯：記錄後讓直連兜底再試一把。
    console.warn('[webpageExtractor] sfworker fetch failed, will try direct:', e);
    return null;
  });

  // Jina Reader 路徑：worker 已渲染 + 提取好乾淨正文，直接用，不必再 DOMParser。
  if (viaWorker && viaWorker.mode === 'reader') {
    const finalUrl = viaWorker.finalUrl;
    const rawContent = viaWorker.content;
    const content = rawContent.length > MAX_CONTENT_CHARS ? rawContent.slice(0, MAX_CONTENT_CHARS) : rawContent;
    const siteName = siteNameFromUrl(finalUrl || url);
    return {
      url,
      finalUrl,
      title: (viaWorker.title || '').trim() || siteName || '網頁',
      siteName,
      content,
      excerpt: makeExcerpt(content),
      image: firstImageFromMarkdown(rawContent),
      truncated: rawContent.length > MAX_CONTENT_CHARS,
      fetchedAt: Date.now(),
      provider: 'jina',
    };
  }

  // raw HTML 路徑：worker 裸抓回退 或 直連兜底，前端自己 DOMParser 提取。
  let html = '';
  let finalUrl: string | undefined;
  if (viaWorker && viaWorker.mode === 'raw') {
    html = viaWorker.html;
    finalUrl = viaWorker.finalUrl;
  } else {
    const direct = await fetchHtmlDirect(url); // 失敗直接拋給調用方
    html = direct.html;
  }

  const parsed = parseWebpageHtml(html, finalUrl || url);
  const rawContent = htmlToText(html); // 僅用於判斷是否截斷
  return {
    url,
    finalUrl,
    title: parsed.title,
    siteName: parsed.siteName,
    content: parsed.content,
    excerpt: parsed.excerpt,
    image: parsed.image,
    truncated: rawContent.length > MAX_CONTENT_CHARS,
    fetchedAt: Date.now(),
    provider: viaWorker?.mode === 'raw' ? 'worker-raw' : 'direct',
  };
}
