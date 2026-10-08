/**
 * 國際／台灣新聞（RSS）—— 新聞熱點的第二組來源（2026-10-08）。
 *
 * 原本的熱點只有 hot_news（news.orz.ai）那份中文熱榜，平台全是微博、知乎、百度這類，
 * 換勾選也繞不出去。這裡補一組新聞媒體的 RSS。
 *
 * 瀏覽器讀不到大部分 RSS（對方沒開 CORS），所以由用戶自己的主動消息 2.0 Worker 代抓：
 * - Worker 的 `GET /news-feeds?keys=…`（worker/amsg/src/index.ts）給 App 用；
 * - Worker 到點生成時（realtimeWorld.ts）直接在伺服器上抓。
 * 沒有 Worker 的人，App 退回維基百科「新聞動態」（fetchWikipediaNews，那邊開了 CORS）。
 *
 * 這個檔案是純 TS、不碰 DOM，Worker 和瀏覽器共用。只抓下面登記過的來源，
 * 端點不接受任意網址，不會變成開放代理。
 */

import type { NewsItem } from './realtimeWorldCore';

export interface NewsFeedSource {
    key: string;
    label: string;
    /** 同一個來源可以合併幾條分類 feed（例如中央社的國際＋政治） */
    urls: string[];
    group: 'tw' | 'intl_zh' | 'intl_en';
}

export const NEWS_FEED_SOURCES: NewsFeedSource[] = [
    {
        key: 'cna', label: '中央社', group: 'tw',
        urls: [
            'https://feeds.feedburner.com/rsscna/politics',
            'https://feeds.feedburner.com/rsscna/intworld',
            'https://feeds.feedburner.com/rsscna/lifehealth',
        ],
    },
    { key: 'pts', label: '公視新聞', group: 'tw', urls: ['https://news.pts.org.tw/xml/newsfeed.xml'] },
    { key: 'ltn', label: '自由時報', group: 'tw', urls: ['https://news.ltn.com.tw/rss/all.xml'] },
    { key: 'bbc_zh', label: 'BBC 中文', group: 'intl_zh', urls: ['https://feeds.bbci.co.uk/zhongwen/trad/rss.xml'] },
    { key: 'dw_zh', label: '德國之聲', group: 'intl_zh', urls: ['https://rss.dw.com/rdf/rss-chi-all'] },
    { key: 'rfi_zh', label: '法廣', group: 'intl_zh', urls: ['https://www.rfi.fr/tw/rss'] },
    { key: 'bbc_world', label: 'BBC World', group: 'intl_en', urls: ['https://feeds.bbci.co.uk/news/world/rss.xml'] },
    { key: 'guardian', label: 'The Guardian', group: 'intl_en', urls: ['https://www.theguardian.com/world/rss'] },
    { key: 'npr', label: 'NPR', group: 'intl_en', urls: ['https://feeds.npr.org/1004/rss.xml'] },
    { key: 'aljazeera', label: 'Al Jazeera', group: 'intl_en', urls: ['https://www.aljazeera.com/xml/rss/all.xml'] },
];

export const DEFAULT_NEWS_FEEDS = ['cna', 'pts', 'bbc_zh', 'dw_zh'];

const SOURCE_BY_KEY = new Map(NEWS_FEED_SOURCES.map(s => [s.key, s] as const));

/** 只留登記過的 key；沒設過（undefined）用預設，明確清空（[]）就是不要。 */
export function resolveNewsFeeds(feeds?: string[]): string[] {
    if (!Array.isArray(feeds)) return [...DEFAULT_NEWS_FEEDS];
    return feeds.filter((k, i) => SOURCE_BY_KEY.has(k) && feeds.indexOf(k) === i);
}

/**
 * 熱榜平台跟 RSS 一起決定：熱榜平台留空時，以前一律退回內置的中文預設；
 * 現在選了 RSS 的話就尊重「中文熱榜一個都不要」。兩邊都空才退回中文預設。
 */
export function resolveNewsSelection(
    platforms: string[] | undefined,
    feeds: string[] | undefined,
    defaultPlatforms: string[],
): { platforms: string[]; feeds: string[] } {
    const f = resolveNewsFeeds(feeds);
    const p = platforms && platforms.length > 0 ? platforms : (f.length > 0 ? [] : defaultPlatforms);
    return { platforms: p, feeds: f };
}

/** 快照的「來源集」：熱榜平台 key ＋ `feed:` 前綴的 RSS key。換了勾選快照就作廢。 */
export const newsSelectionIds = (sel: { platforms: string[]; feeds: string[] }): string[] =>
    [...sel.platforms, ...sel.feeds.map(k => `feed:${k}`)];

// ==================== RSS / Atom 解析（不用 DOMParser，Worker 也能跑） ====================

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
        if (code[0] === '#') {
            const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        return ENTITY[code.toLowerCase()] ?? m;
    });
}

const unwrapCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

/** 標籤裡的文字：去 CDATA、解實體（描述常是轉義過的 HTML，所以解完再剝一次標籤）、壓空白。 */
export function cleanText(raw: string): string {
    const once = decodeEntities(unwrapCdata(raw).replace(/<[^>]+>/g, ' '));
    return once.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const tagContent = (block: string, names: string[]): string | undefined => {
    for (const name of names) {
        const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
        if (m && m[1].trim()) return m[1];
    }
    return undefined;
};

const atomLink = (block: string): string | undefined => {
    const links = block.match(/<link\b[^>]*\/?>/gi) || [];
    let fallback: string | undefined;
    for (const l of links) {
        const href = l.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!href) continue;
        const rel = l.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!rel || rel === 'alternate') return href;
        fallback ??= href;
    }
    return fallback;
};

export interface ParsedFeedItem {
    title: string;
    url?: string;
    desc?: string;
    publishedAt?: number;
}

const DESC_MAX = 140;

/** RSS 2.0（<item>）、RSS 1.0／RDF（<item rdf:about>）、Atom（<entry>）都收。 */
export function parseFeedItems(xml: string): ParsedFeedItem[] {
    const blocks = String(xml ?? '').match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi) || [];
    const out: ParsedFeedItem[] = [];
    for (const block of blocks) {
        const title = cleanText(tagContent(block, ['title']) ?? '');
        if (!title) continue;
        const linkText = tagContent(block, ['link']);
        const url = (linkText ? cleanText(linkText) : '') || atomLink(block) || cleanText(tagContent(block, ['guid']) ?? '') || undefined;
        const descRaw = tagContent(block, ['description', 'summary', 'content:encoded', 'content']);
        let desc = descRaw ? cleanText(descRaw) : '';
        if (desc === title) desc = '';
        if (desc.length > DESC_MAX) desc = `${desc.slice(0, DESC_MAX)}…`;
        const dateRaw = tagContent(block, ['pubDate', 'dc:date', 'published', 'updated']);
        const ts = dateRaw ? Date.parse(cleanText(dateRaw)) : NaN;
        out.push({
            title,
            ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
            ...(desc ? { desc } : {}),
            ...(Number.isFinite(ts) ? { publishedAt: ts } : {}),
        });
    }
    return out;
}

/** 超過這麼久的就不算「最近發生」了（有日期才判斷，沒日期的照收）。 */
export const NEWS_FEED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const FEED_TIMEOUT_MS = 6000;

async function fetchFeedText(url: string, fetchImpl: FetchLike): Promise<string> {
    const signal = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function'
        ? (AbortSignal as any).timeout(FEED_TIMEOUT_MS) as AbortSignal
        : undefined;
    const res = await fetchImpl(url, {
        headers: {
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
            'User-Agent': 'Mozilla/5.0 (compatible; SorenOS-News/1.0)',
        },
        redirect: 'follow',
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

/**
 * 抓勾選的來源，每個來源取前 perSource 條（同來源的幾條分類 feed 先合併去重），
 * 再各來源輪流排（round-robin），免得一家霸屏。單一來源失敗只是少那一家。
 */
export async function fetchNewsFeeds(
    keys: string[],
    opts: { fetchImpl?: FetchLike; perSource?: number; total?: number; now?: number } = {},
): Promise<NewsItem[]> {
    const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    const perSource = opts.perSource ?? 8;
    const now = opts.now ?? Date.now();
    const sources = resolveNewsFeeds(keys).map(k => SOURCE_BY_KEY.get(k)!).filter(Boolean);

    const perSourceItems = await Promise.all(sources.map(async (src): Promise<NewsItem[]> => {
        const lists = await Promise.all(src.urls.map(u => fetchFeedText(u, fetchImpl)
            .then(parseFeedItems)
            .catch((e) => {
                console.warn(`[news-feeds] ${src.label} ${u} 抓不到：`, e?.message || e);
                return [] as ParsedFeedItem[];
            })));
        const seen = new Set<string>();
        const merged: ParsedFeedItem[] = [];
        // 分類 feed 之間也輪流取，國際、政治、生活各露一點
        const longest = Math.max(0, ...lists.map(l => l.length));
        for (let i = 0; i < longest; i++) {
            for (const l of lists) {
                const it = l[i];
                if (!it || seen.has(it.title)) continue;
                if (it.publishedAt && now - it.publishedAt > NEWS_FEED_MAX_AGE_MS) continue;
                seen.add(it.title);
                merged.push(it);
            }
        }
        return merged.slice(0, perSource).map(it => ({
            title: it.title, source: src.label,
            ...(it.url ? { url: it.url } : {}),
            ...(it.desc ? { desc: it.desc } : {}),
        }));
    }));

    return interleaveNews(perSourceItems).slice(0, opts.total ?? 60);
}

/** 幾組新聞輪流排：第一名各組輪一遍，再第二名…… */
export function interleaveNews(groups: NewsItem[][]): NewsItem[] {
    const out: NewsItem[] = [];
    const longest = Math.max(0, ...groups.map(g => g.length));
    for (let i = 0; i < longest; i++) {
        for (const g of groups) if (g[i]) out.push(g[i]);
    }
    return out;
}

// ==================== 沒有 Worker 時：維基百科「新聞動態」 ====================

/**
 * 維基百科 REST 的每日精選裡有 `news`（首頁「新聞動態」那幾條），開了 CORS、免 key，
 * 瀏覽器能直接讀。一天只有幾條國際大事，當沒有 Worker 時的底線。
 * 中文版沒有這一段時退回英文版。
 */
export async function fetchWikipediaNews(opts: { fetchImpl?: FetchLike; now?: Date } = {}): Promise<NewsItem[]> {
    const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    const d = opts.now ?? new Date();
    const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    for (const lang of ['zh', 'en']) {
        try {
            const res = await fetchImpl(`https://${lang}.wikipedia.org/api/rest_v1/feed/featured/${path}`, {
                headers: { 'Accept': 'application/json', ...(lang === 'zh' ? { 'Accept-Language': 'zh-tw' } : {}) },
            });
            if (!res.ok) continue;
            const data: any = await res.json().catch(() => null);
            const news: any[] = Array.isArray(data?.news) ? data.news : [];
            const items = news
                .map((n): NewsItem | null => {
                    const title = cleanText(String(n?.story ?? '').replace(/<!--[\s\S]*?-->/g, ''));
                    if (!title) return null;
                    const link = Array.isArray(n?.links) ? n.links[0] : null;
                    const extract = typeof link?.extract === 'string' ? cleanText(link.extract) : '';
                    const url = link?.content_urls?.desktop?.page;
                    return {
                        title, source: lang === 'zh' ? '維基百科新聞動態' : 'Wikipedia In the news',
                        ...(typeof url === 'string' ? { url } : {}),
                        ...(extract ? { desc: extract.length > DESC_MAX ? `${extract.slice(0, DESC_MAX)}…` : extract } : {}),
                    };
                })
                .filter((x): x is NewsItem => !!x);
            if (items.length > 0) return items;
        } catch (e: any) {
            console.warn(`[news-feeds] 維基百科（${lang}）新聞動態拉不到：`, e?.message || e);
        }
    }
    return [];
}
