import { describe, expect, it } from 'vitest';
import {
    cleanText, fetchNewsFeeds, fetchWikipediaNews, newsSelectionIds, parseFeedItems,
    resolveNewsFeeds, resolveNewsSelection, DEFAULT_NEWS_FEEDS,
} from './newsFeeds';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>中央社</title>
<item><title><![CDATA[總統出席國慶大會 &amp; 發表談話]]></title>
<link>https://www.cna.com.tw/news/aipl/1.aspx</link>
<description><![CDATA[<p>總統今天上午出席國慶大會。</p>]]></description>
<pubDate>Thu, 08 Oct 2026 02:00:00 GMT</pubDate></item>
<item><title>颱風逼近 氣象署發布海上警報</title><link>https://www.cna.com.tw/news/2.aspx</link>
<description>&lt;b&gt;颱風&lt;/b&gt;持續增強</description></item>
</channel></rss>`;

const RDF = `<rdf:RDF xmlns:rdf="x"><channel rdf:about="x"><title>DW</title></channel>
<item rdf:about="https://www.dw.com/zh/a-1"><title>欧盟峰会今日召开</title><link>https://www.dw.com/zh/a-1</link>
<description>峰会讨论能源议题</description><dc:date>2026-10-08T01:00:00Z</dc:date></item></rdf:RDF>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Leaders meet in Geneva</title>
<link rel="alternate" href="https://example.com/geneva"/><summary>Talks on &#8220;climate&#8221;</summary>
<updated>2026-10-07T12:00:00Z</updated></entry></feed>`;

describe('parseFeedItems', () => {
    it('RSS 2.0：CDATA、實體、描述裡的 HTML 都清乾淨', () => {
        const items = parseFeedItems(RSS2);
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({
            title: '總統出席國慶大會 & 發表談話',
            url: 'https://www.cna.com.tw/news/aipl/1.aspx',
            desc: '總統今天上午出席國慶大會。',
        });
        expect(items[0].publishedAt).toBe(Date.parse('Thu, 08 Oct 2026 02:00:00 GMT'));
        expect(items[1].desc).toBe('颱風 持續增強');
    });
    it('RSS 1.0／RDF 的 <item rdf:about> 與 dc:date', () => {
        expect(parseFeedItems(RDF)[0]).toMatchObject({ title: '欧盟峰会今日召开', url: 'https://www.dw.com/zh/a-1', desc: '峰会讨论能源议题' });
    });
    it('Atom 的 <entry> 與 <link href>', () => {
        expect(parseFeedItems(ATOM)[0]).toMatchObject({ title: 'Leaders meet in Geneva', url: 'https://example.com/geneva', desc: 'Talks on “climate”' });
    });
    it('壞資料不炸', () => {
        expect(parseFeedItems('<html>not a feed</html>')).toEqual([]);
        expect(parseFeedItems(undefined as any)).toEqual([]);
        expect(cleanText('&#x1F600; &unknown;')).toBe('😀 &unknown;');
    });
});

describe('resolveNewsFeeds / resolveNewsSelection', () => {
    it('沒設過用預設、明確清空就是不要、未知 key 丟掉', () => {
        expect(resolveNewsFeeds(undefined)).toEqual(DEFAULT_NEWS_FEEDS);
        expect(resolveNewsFeeds([])).toEqual([]);
        expect(resolveNewsFeeds(['bbc_zh', 'nope', 'bbc_zh'])).toEqual(['bbc_zh']);
    });
    it('選了 RSS 時熱榜平台可以一個都不要；兩邊都空才退回中文預設', () => {
        const def = ['weibo'];
        expect(resolveNewsSelection([], ['cna'], def)).toEqual({ platforms: [], feeds: ['cna'] });
        expect(resolveNewsSelection([], [], def)).toEqual({ platforms: ['weibo'], feeds: [] });
        expect(resolveNewsSelection(['zhihu'], undefined, def)).toEqual({ platforms: ['zhihu'], feeds: DEFAULT_NEWS_FEEDS });
        expect(newsSelectionIds({ platforms: ['zhihu'], feeds: ['cna'] })).toEqual(['zhihu', 'feed:cna']);
    });
});

const fakeFetch = (routes: Record<string, string | number>) => async (url: string) => {
    const r = routes[url];
    if (r === undefined || typeof r === 'number') return new Response('x', { status: typeof r === 'number' ? r : 404 });
    return new Response(r, { status: 200 });
};

describe('fetchNewsFeeds', () => {
    const now = Date.parse('2026-10-08T06:00:00Z');
    it('各來源輪流排、單一來源失敗不影響其他、標上來源名', async () => {
        const items = await fetchNewsFeeds(['cna', 'dw_zh', 'pts'], {
            now,
            fetchImpl: fakeFetch({
                'https://feeds.feedburner.com/rsscna/politics': RSS2,
                'https://feeds.feedburner.com/rsscna/intworld': 500,
                'https://feeds.feedburner.com/rsscna/lifehealth': RSS2,
                'https://rss.dw.com/rdf/rss-chi-all': RDF,
                'https://news.pts.org.tw/xml/newsfeed.xml': 503,
            }),
        });
        expect(items.map(i => `${i.source}:${i.title}`)).toEqual([
            '中央社:總統出席國慶大會 & 發表談話',
            '德國之聲:欧盟峰会今日召开',
            '中央社:颱風逼近 氣象署發布海上警報',
        ]);
    });
    it('太舊的（超過三天）丟掉', async () => {
        const items = await fetchNewsFeeds(['dw_zh'], {
            now: Date.parse('2026-10-20T00:00:00Z'),
            fetchImpl: fakeFetch({ 'https://rss.dw.com/rdf/rss-chi-all': RDF }),
        });
        expect(items).toEqual([]);
    });
});

describe('fetchWikipediaNews', () => {
    it('取 news 段落、去 HTML 與註解；中文沒有就退英文', async () => {
        const day = new Date('2026-10-08T06:00:00Z');
        const items = await fetchWikipediaNews({
            now: day,
            fetchImpl: fakeFetch({
                'https://zh.wikipedia.org/api/rest_v1/feed/featured/2026/10/08': JSON.stringify({ tfa: {} }),
                'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/08': JSON.stringify({
                    news: [{ story: '<!--Oct 7--><b><a href="./X">X</a></b> wins the Nobel Prize.', links: [{ extract: 'X is a writer.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/X' } } }] }],
                }),
            }) as any,
        });
        expect(items).toEqual([{ title: 'X wins the Nobel Prize.', source: 'Wikipedia In the news', url: 'https://en.wikipedia.org/wiki/X', desc: 'X is a writer.' }]);
    });
});
