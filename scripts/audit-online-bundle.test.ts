import { describe, it, expect } from 'vitest';
// @ts-expect-error JavaScript helper has no type declarations.
import { collectSiteScripts, auditTrackerFootprint } from './audit-online-bundle.mjs';

const SITE = 'https://example.test/SullyOS/';
const WEBSITE_ID = '11111111-2222-3333-4444-555555555555';
const SCRIPT_URL = 'https://stats.example.test/script.js';

/** 把 { 完整 URL: 內容 } 當成一個靜態站點；沒列出的地址一律當 404。 */
function fakeSite(pages: Record<string, string>) {
  return async (url: string) => (url in pages ? pages[url] : null);
}

/** 只列出失敗項的名字，斷言時讀起來清楚些。 */
function failedNames(result: { failed: { name: string }[] }) {
  return result.failed.map((f) => f.name);
}

describe('線上產物審計 · 抓取範圍', () => {
  it('統計配置被打包進非入口 chunk 時照樣找得到', async () => {
    // 這正是 2026-08-16 起連紅兩天的場景：「門牌整理上雲」讓打包器把
    // analytics 那一片划進了 memory-palace 包，入口包裡就此不含這兩個值。
    const pages = {
      [SITE]: '<script type="module" crossorigin src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: 'import"./memory-palace-bbb.js";console.log(1);',
      [`${SITE}assets/memory-palace-bbb.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toEqual([]);
    expect(scan.stats.fetched).toBe(2);
  });

  it('跟得進只在 mapDeps 數組裡出現的懶加載 chunk', async () => {
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]:
        'const __vite__mapDeps=(i,m,d=(m.f||(m.f=["assets/Chat-ccc.js","assets/Chat-ddd.css"])))=>i.map(i=>d[i]);',
      [`${SITE}assets/Chat-ccc.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });

    expect(scan.files.map((f: { url: string }) => f.url)).toContain(`${SITE}assets/Chat-ccc.js`);
    expect(failedNames(auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL }))).toEqual([]);
  });

  it('根路徑寫法 /assets/xxx.js 也跟得到', async () => {
    // 產物用相對路徑（./assets/…）還是根路徑（/assets/…），取決於構建時的 base 配置。
    // 判定標準得跟瀏覽器一致：同源的它都會去加載，審計就都得跟，
    // 不然換個 base 配置就有一批文件從審計視野裡消失了。
    const pages = {
      [SITE]: '<script type="module" src="/assets/index-aaa.js"></script>',
      'https://example.test/assets/index-aaa.js': `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });

    expect(scan.stats.fetched).toBe(1);
    expect(failedNames(auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL }))).toEqual([]);
  });

  it('沒人 import 的靜態 js（public/ 那些）給了路徑就照樣審計', async () => {
    // public/ 下的文件是原樣複製上線的，有幾個由運行時拼出地址來加載
    // （MediaPipe 的 wasm glue 就是），import 鏈上找不到它們。
    // 瀏覽器該加載還是會加載，所以得把這些路徑直接喂進來。
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
      [`${SITE}mediapipe/wasm/vision-internal.js`]: 'const extra="https://tracker.evil.test/script.js";',
    };

    const scan = await collectSiteScripts({
      baseUrl: SITE,
      fetchText: fakeSite(pages),
      extraPaths: ['mediapipe/wasm/vision-internal.js'],
    });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.stats.fetched).toBe(2);
    expect(failedNames(result)).toContain('線上產物內 tracker 地址唯一且相符');
  });

  it('不跟去站外的地址', async () => {
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]:
        `const cdn="https://cdn.other.test/lib-eee.js",w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
      'https://cdn.other.test/lib-eee.js': 'const x=1;',
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });

    expect(scan.files.map((f: { url: string }) => f.url)).toEqual([`${SITE}assets/index-aaa.js`]);
  });
});

describe('線上產物審計 · 斷言', () => {
  it('多出來的上報端點藏在懶加載 chunk 裡也要被抓出來', async () => {
    // 舊寫法只 grep 入口包，這種「入口一切正常、第二個端點躲在懶加載包裡」
    // 的情況會一路綠燈 —— 恰恰是這條斷言本來要防的事。
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";import"./lazy-fff.js";`,
      [`${SITE}assets/lazy-fff.js`]: 'const extra="https://tracker.evil.test/script.js";',
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toContain('線上產物內 tracker 地址唯一且相符');
    const failure = result.failed.find((f) => f.name === '線上產物內 tracker 地址唯一且相符')!;
    expect(failure.actual).toContain('https://tracker.evil.test/script.js');
    expect(failure.actual).toContain(SCRIPT_URL);
  });

  it('站點 id 一處都不出現時判失敗', async () => {
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toContain('線上產物內含該站點 id');
  });

  it('一個 js 都沒抓到時判失敗，而不是「沒找到問題」', async () => {
    // 探測機制自己壞掉（index.html 拿不到、入口包 404、站點整個掛了）時，
    // 「沒掃到東西」和「掃完沒問題」長得一模一樣。必須紅。
    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite({}) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toContain('抓到了可供審計的產物');
  });

  it('掃描撞到上限被截斷時判失敗，不給出「唯一」的結論', async () => {
    // 截斷之後「tracker 地址唯一」這句話就沒有依據了 —— 沒掃到的那部分裡
    // 有沒有第二個端點，誰也不知道。這種時候必須紅，不能悄悄按掃到的部分報通過。
    const pages: Record<string, string> = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]:
        `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";import"./a-111.js";import"./b-222.js";`,
      [`${SITE}assets/a-111.js`]: 'const a=1;',
      [`${SITE}assets/b-222.js`]: 'const b=2;',
    };

    const scan = await collectSiteScripts({
      baseUrl: SITE,
      fetchText: fakeSite(pages),
      limits: { maxFiles: 2 },
    });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.truncated).not.toBeNull();
    expect(failedNames(result)).toContain('掃描覆蓋完整（沒撞上限）');
  });

  it('文件取不到（網絡抽風）時判失敗，不跟「認錯文件名」混為一談', async () => {
    // 404 是認錯了文件名，無所謂；取不到是這個文件沒被審計過。
    // 兩者都當 missing 放過的話，網絡抖一下就少掃幾個文件，而結論照樣是綠的。
    const fetchText = async (url: string) => {
      if (url === SITE) return '<script type="module" src="./assets/index-aaa.js"></script>';
      if (url.endsWith('index-aaa.js')) return `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";import"./lazy-bbb.js";`;
      throw new Error('502 Bad Gateway');
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.stats.unreachable).toBe(1);
    expect(failedNames(result)).toContain('引用到的文件都取到了');
  });

  it('抓不到的引用只記數，不算失敗', async () => {
    // 從壓縮後的代碼裡認文件名難免有認錯的，這些地址一取就是 404。
    // 它們不該把審計判紅，但要出現在統計裡，好判斷正則是不是太鬆了。
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";const nope="./ghost-999.js";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.stats.missing).toBe(1);
    expect(failedNames(result)).toEqual([]);
  });
});
