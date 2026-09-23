import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectFirstUrl, detectXhsShortUrl, extractXhsShareTitle, isXhsUrl, extractXhsNoteId, extractXhsNoteLink, expandShortUrl, parseWebpageHtml, extractWebpageContent } from './webpageExtractor';

describe('detectFirstUrl', () => {
  it('從一句話裡揪出 http(s) 鏈接', () => {
    expect(detectFirstUrl('看看這個 https://example.com/article 挺有意思'))
      .toBe('https://example.com/article');
    expect(detectFirstUrl('http://foo.bar/baz')).toBe('http://foo.bar/baz');
  });

  it('中文句號不進 URL，英文尾標點被剝掉', () => {
    // 中文句號不在 URL 字符集裡, 正則到此截斷
    expect(detectFirstUrl('鏈接是 https://example.com/x。後面還有字')).toBe('https://example.com/x');
    // 英文句點/右括號結尾要被剝掉
    expect(detectFirstUrl('see (https://example.com/a).')).toBe('https://example.com/a');
  });

  it('沒有鏈接時返回 null', () => {
    expect(detectFirstUrl('就是普通聊天沒有網址')).toBeNull();
    expect(detectFirstUrl('')).toBeNull();
    expect(detectFirstUrl('ftp://nope.com')).toBeNull();
  });
});

describe('isXhsUrl', () => {
  it('識別小紅書域名（已有專門 MCP 路徑，網頁抓取要避開）', () => {
    expect(isXhsUrl('https://www.xiaohongshu.com/explore/abc')).toBe(true);
    expect(isXhsUrl('https://xhslink.com/xxx')).toBe(true);
    expect(isXhsUrl('http://xhslink.cn/o/3hJ4anvedNl')).toBe(true);
    expect(isXhsUrl('https://www.rednote.com/explore/abc')).toBe(true);
    expect(isXhsUrl('https://example.com')).toBe(false);
    expect(isXhsUrl('https://rednote.com.example.com/explore/abc')).toBe(false);
    expect(isXhsUrl('https://fake-rednote.com/explore/abc')).toBe(false);
  });
});

describe('detectXhsShortUrl', () => {
  it('識別手機版 xhslink.cn 完整分享文案', () => {
    const text = '辦公室的領導看著不苟言笑 http://xhslink.cn/o/3hJ4anvedNl 存下鏈接，去【小紅書】閱讀全文~';
    expect(detectXhsShortUrl(text)).toBe('http://xhslink.cn/o/3hJ4anvedNl');
  });

  it('繼續兼容 xhslink.com 和不帶協議的短鏈', () => {
    expect(detectXhsShortUrl('https://xhslink.com/a/AbC_123-xy')).toBe('https://xhslink.com/a/AbC_123-xy');
    expect(detectXhsShortUrl('看看 xhslink.cn/o/AbC123')).toBe('https://xhslink.cn/o/AbC123');
  });

  it('不接受相似惡意域名', () => {
    expect(detectXhsShortUrl('https://xhslink.cn.example.com/o/AbC123')).toBeNull();
    expect(detectXhsShortUrl('https://fake-xhslink.cn/o/AbC123')).toBeNull();
  });
});

describe('extractXhsShareTitle', () => {
  it('從新版手機分享文案的短鏈前提取標題，不把【小紅書】當標題', () => {
    const text = '人機戀教主~ a社是不是該給你和你的克頒發結婚證嘞？ ... http://xhslink.cn/o/3udN9HGr5iT 把文本複製下來，打開【小紅書】即可查看。';
    expect(extractXhsShareTitle(text))
      .toBe('人機戀教主~ a社是不是該給你和你的克頒發結婚證嘞？');
  });

  it('繼續支持舊版【標題 | 小紅書】格式', () => {
    const text = '【今天也要好好吃飯 | 小紅書】 https://xhslink.com/a/AbC123';
    expect(extractXhsShareTitle(text)).toBe('今天也要好好吃飯');
  });

  it('只有應用名而沒有標題時返回空，允許接口標題兜底', () => {
    const text = 'http://xhslink.cn/o/AbC123 打開【小紅書】即可查看';
    expect(extractXhsShareTitle(text)).toBe('');
  });
});

describe('extractXhsNoteId', () => {
  const NOTE_ID = '6858ccaa0000000013013c94';

  it('從國內和新版 RedNote 完整鏈接中提取筆記 ID', () => {
    expect(extractXhsNoteId(`看看這個 https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=abc`))
      .toBe(NOTE_ID);
    expect(extractXhsNoteId(`分享給你 https://www.rednote.com/explore/${NOTE_ID}?xsec_token=abc`))
      .toBe(NOTE_ID);
    expect(extractXhsNoteId(`www.rednote.com/discovery/item/${NOTE_ID}`))
      .toBe(NOTE_ID);
  });

  it('支持短鏈展開後落到 rednote.com 的最終鏈接', () => {
    expect(extractXhsNoteId(`https://rednote.com/item/${NOTE_ID}?xsec_source=app_share`))
      .toBe(NOTE_ID);
  });

  it('不把相似惡意域名或非筆記頁面誤判成小紅書筆記', () => {
    expect(extractXhsNoteId(`https://rednote.com.example.com/explore/${NOTE_ID}`)).toBeNull();
    expect(extractXhsNoteId(`https://fake-rednote.com/explore/${NOTE_ID}`)).toBeNull();
    expect(extractXhsNoteId('https://www.rednote.com/explore')).toBeNull();
  });
});

describe('手機小紅書分享迴歸', () => {
  const noteId = '6aa4aaf6000000000b00eab5';
  const shortUrl = 'https://xhslink.cn/o/2KuQOsv8aMN';
  const noteUrl = `http://www.xiaohongshu.com/discovery/item/${noteId}?xsec_source=app_share&xsec_token=test%2Btoken%3D`;
  const captchaUrl = `https://www.xiaohongshu.com/website-login/captcha?redirectPath=${encodeURIComponent(noteUrl)}&verifyType=217`;

  afterEach(() => vi.unstubAllGlobals());

  it('識別用戶手機分享文案以及 Markdown 鏈接', () => {
    for (const link of [shortUrl, `[${shortUrl}](${shortUrl})`]) {
      const text = `胡鬧廚房別太胡鬧 敵人8雙人滿血的含金量 兩個人重開... ${link} 先複製一下，打開【小紅書】看看這篇好文！`;
      expect(detectXhsShortUrl(text)).toBe(shortUrl);
      expect(extractXhsShareTitle(text)).toBe('胡鬧廚房別太胡鬧 敵人8雙人滿血的含金量 兩個人重開');
    }
  });

  it('兼容線上舊代理的驗證碼頁響應，恢復筆記和 token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { finalUrl: captchaUrl },
    }))));
    const expanded = await expandShortUrl(shortUrl);
    expect(extractXhsNoteLink(expanded)).toEqual({ noteId, xsecToken: 'test+token=' });
    expect(extractXhsNoteId(expanded)).toBe(noteId);
  });

  it('兼容直接筆記 URL 和電腦版文案，token 僅解碼一次', () => {
    expect(extractXhsNoteLink(noteUrl)).toEqual({ noteId, xsecToken: 'test+token=' });
    expect(extractXhsNoteLink(`80 【胡鬧廚房別太胡鬧 - 兮橙 | 小紅書】 😆 code 😆 [https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=desktop_token=](https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=desktop_token=)`))
      .toEqual({ noteId, xsecToken: 'desktop_token=' });
    expect(extractXhsNoteLink(noteUrl.replace('test%2Btoken%3D', 'test%253D'))?.xsecToken).toBe('test%3D');
  });

  it('不從外站或無效驗證碼回跳鏈接中提取筆記', () => {
    expect(extractXhsNoteLink(captchaUrl.replace('https://www.xiaohongshu.com/', 'https://example.com/'))).toBeNull();
    expect(extractXhsNoteLink(`https://www.xiaohongshu.com/website-login/captcha?redirectPath=${encodeURIComponent(noteUrl.replace('www.xiaohongshu.com', 'example.com'))}`)).toBeNull();
    expect(extractXhsNoteLink('https://www.xiaohongshu.com/website-login/captcha?verifyType=217')).toBeNull();
  });
});

describe('parseWebpageHtml', () => {
  // node 測試環境無 DOMParser，會走正則 fallback（htmlToText）。兩條路徑都應產出標題/正文。
  const html = `
    <html><head>
      <title>測試標題</title>
      <meta name="description" content="這是一段網頁摘要描述">
      <meta property="og:site_name" content="測試站">
    </head><body>
      <nav>導航不該進正文</nav>
      <article><p>第一段正文內容。</p><p>第二段正文內容。</p></article>
      <script>console.log('noise')</script>
    </body></html>`;

  it('提取出正文文字（去掉 script 噪音）', () => {
    const r = parseWebpageHtml(html, 'https://test.example.com/p');
    expect(r.content).toContain('第一段正文內容');
    expect(r.content).toContain('第二段正文內容');
    expect(r.content).not.toContain('console.log');
  });

  it('沒有站點名時用域名兜底', () => {
    const r = parseWebpageHtml('<p>hi</p>', 'https://www.foo.bar/x');
    expect(r.siteName).toBe('foo.bar');
    expect(r.title).toBeTruthy();
  });

  it('摘要非空且有上限', () => {
    const longBody = '<p>' + '內容'.repeat(500) + '</p>';
    const r = parseWebpageHtml(longBody, 'https://x.com');
    expect(r.excerpt.length).toBeLessThanOrEqual(141); // 140 + 省略號
  });
});

describe('extractWebpageContent 提取鏈路（apizero → Firecrawl → sfworker/Jina）', () => {
  // 長到能過 MIN_EXTRACT_CHARS(80) 的正文樣例。
  const LONG_BODY = 'curl 是常用的命令行工具，用來請求 Web 服務器。'.repeat(10);

  // apizero content-extract 的真實響應結構（阮一峰博客實測裁剪版）。
  const apizeroOk = {
    code: 0,
    msg: '成功',
    data: {
      url: 'https://www.ruanyifeng.com/blog/2019/09/curl-reference.html',
      title: 'curl 的用法指南',
      publish_time: '',
      content: LONG_BODY,
      word_count: LONG_BODY.length,
      reading_time: '2 分鐘',
      image_count: 1,
      images: ['https://www.ruanyifeng.com/blog/images/cover.png'],
    },
  };

  // 按 URL 分流的 fetch stub：apizero 端點一份響應，sfworker /fetch-webpage 一份響應。
  const stubFetch = (apizeroBody: any, workerBody?: any) => {
    const fn = vi.fn(async (input: any) => {
      const target = String(input);
      const body = target.includes('apizero.cn') ? apizeroBody : workerBody;
      if (body === undefined) throw new Error(`unexpected fetch: ${target}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  beforeEach(() => {
    localStorage.removeItem('sully_firecrawl_api_key_v1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('主路徑：apizero 成功 → 直接用其結果，不再碰 sfworker', async () => {
    const fn = stubFetch(apizeroOk);
    const wp = await extractWebpageContent('https://www.ruanyifeng.com/blog/2019/09/curl-reference.html');
    expect(wp.title).toBe('curl 的用法指南');
    expect(wp.content).toBe(LONG_BODY);
    expect(wp.siteName).toBe('ruanyifeng.com');
    expect(wp.image).toBe('https://www.ruanyifeng.com/blog/images/cover.png');
    expect(wp.excerpt.length).toBeGreaterThan(0);
    expect(wp.video).toBeUndefined();
    expect(wp.provider).toBe('apizero-content');
    // 只調了 apizero 一次，沒走 worker
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain('apizero.cn/api/content-extract');
    expect(String(fn.mock.calls[0][0])).toContain('key=sk_live_'); // 默認攜帶項目方共享 key
  });

  it('配置 Firecrawl 後：apizero 失敗 → Firecrawl 成功，不再請求 Worker', async () => {
    localStorage.setItem('sully_firecrawl_api_key_v1', 'fc-test');
    const firecrawlMarkdown = '# 動態網頁\n\n' + LONG_BODY;
    const fn = vi.fn(async (input: any) => {
      const target = String(input);
      const body = target.includes('apizero.cn')
        ? { code: 5020, msg: '目標網頁無法訪問' }
        : target.includes('api.firecrawl.dev')
          ? { success: true, data: { markdown: firecrawlMarkdown, metadata: { title: 'Firecrawl 標題', sourceURL: 'https://dynamic.example.com/final', ogImage: 'https://dynamic.example.com/cover.jpg' } } }
          : undefined;
      if (body === undefined) throw new Error(`unexpected fetch: ${target}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    vi.stubGlobal('fetch', fn);

    const wp = await extractWebpageContent('https://dynamic.example.com/page');
    expect(wp.title).toBe('Firecrawl 標題');
    expect(wp.content).toContain(LONG_BODY);
    expect(wp.image).toBe('https://dynamic.example.com/cover.jpg');
    expect(wp.provider).toBe('firecrawl');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(String(fn.mock.calls[1][0])).toContain('api.firecrawl.dev/v2/scrape');
  });

  it('apizero 業務失敗（code≠0）→ 降級 sfworker/Jina 老鏈路', async () => {
    const fn = stubFetch(
      { code: 5020, msg: '目標網頁無法訪問' },
      { success: true, data: { mode: 'reader', title: 'Jina 抓到的標題', content: LONG_BODY } },
    );
    const wp = await extractWebpageContent('https://example.com/a');
    expect(wp.title).toBe('Jina 抓到的標題');
    expect(wp.content).toBe(LONG_BODY);
    expect(wp.provider).toBe('jina');
    expect(fn).toHaveBeenCalledTimes(2); // apizero 一次 + worker 一次
  });

  it('apizero 正文過短（SPA 殼 / 登錄牆 / 文檔站）→ 降級 Jina 拿正文，不拿殼當正文', async () => {
    const fn = stubFetch(
      { code: 0, data: { title: '標題', content: '請開啟 JavaScript', images: [] } },
      { success: true, data: { mode: 'reader', title: '渲染後的真標題', content: LONG_BODY } },
    );
    const wp = await extractWebpageContent('https://spa.example.com/page');
    expect(wp.title).toBe('渲染後的真標題');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('超長正文截斷到 8000 字並標記 truncated', async () => {
    const huge = 'x'.repeat(9000);
    stubFetch({ code: 0, data: { title: '長文', content: huge, images: [] } });
    const wp = await extractWebpageContent('https://example.com/long');
    expect(wp.content.length).toBe(8000);
    expect(wp.truncated).toBe(true);
  });
});
