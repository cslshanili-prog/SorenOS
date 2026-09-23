/**
 * 線上產物核對：把用戶瀏覽器真正會加載到的 js 全部抓下來，
 * 在裡面找統計站點 id 和 tracker 地址。
 *
 * 為什麼要抓全站而不是只看入口那一個文件：
 * 統計配置落在哪個 chunk 裡，是打包器按依賴圖自行決定的，跟隱私承諾無關。
 * 依賴圖一變它就換個地方待著（2026-08-16 起連紅兩天就是這麼來的：某個模塊
 * 在「記憶宮殿」和「amsg 運行時」之間架了條依賴邊，analytics 那一片被划進了
 * memory-palace 包，入口包裡從此不含這兩個值）。
 * 更要緊的是反方向：多出來的第二個上報端點只要待在懶加載 chunk 裡，
 * 「只看入口」的查法就永遠發現不了 —— 假紅只是難看，這個是真會漏。
 *
 * 所以這裡從 index.html 出發，順著各個 chunk 之間的引用一路跟下去，
 * 掃完再下結論；中途撞上限就直接判失敗，不按「已經掃到的那部分」報通過。
 *
 * 用法：
 *   node scripts/audit-online-bundle.mjs --base https://例子.github.io/倉庫/ \
 *        --website-id <uuid> --script-url https://統計實例/script.js
 *   node scripts/audit-online-bundle.mjs --dir dist --website-id ... --script-url ...
 *
 * stdout 是給機器看的 JSON（workflow 用 jq 取裡面的 checks），
 * 人看的日誌走 stderr。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 一輪掃描最多抓多少個 js / 多少字節。撞上就停，並且判失敗。 */
const DEFAULT_LIMITS = { maxFiles: 300, maxBytes: 120 * 1024 * 1024 };

/**
 * 產物裡出現的 tracker 腳本地址長這樣。跟 assert-privacy.sh 的判定保持一致。
 * 每次現造一個：帶 g 的正則自帶 lastIndex，共享一份遲早要在這上面翻車。
 */
const trackerPattern = () => /https:\/\/[A-Za-z0-9.-]+\/script\.js/g;

/**
 * 從一份文本（index.html 或某個 chunk）裡找出它引用的、本站內的 js 地址。
 *
 * 幾種寫法都要認：
 *   · `"./memory-palace-abc.js"`  chunk 之間的 import，相對當前文件
 *   · `"assets/Chat-abc.js"`      懶加載用的 __vite__mapDeps 數組，相對站點根
 *   · `"/assets/Chat-abc.js"`     根路徑寫法，取決於構建時的 base 配置
 *
 * 「算不算本站」按同源判定，跟瀏覽器一個標準：同源的它都會去加載，
 * 那審計就都得跟。用「地址以站點根開頭」來判會漏 —— base 配置一改，
 * 根路徑寫法就整批跳出前綴，從審計視野裡消失，而瀏覽器照加載不誤。
 *
 * @param {string} text 文件內容
 * @param {string} fromUrl 這份內容自己的地址
 * @param {string} baseUrl 站點根，必須以 / 結尾
 * @returns {string[]} 去重後的絕對地址
 */
export function extractScriptRefs(text, fromUrl, baseUrl) {
  const refs = new Set();
  const pattern = /["'`]([^"'`\s<>]{1,300}\.js)["'`]/g;
  const siteOrigin = new URL(baseUrl).origin;

  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    let resolved;
    try {
      // 以 . 或 / 開頭的是相對/根路徑寫法，按當前文件解析；
      // 裸路徑（mapDeps 數組裡那種）按站點根解析。
      const anchor = raw.startsWith('.') || raw.startsWith('/') ? fromUrl : baseUrl;
      resolved = new URL(raw, anchor);
    } catch {
      continue;
    }
    if (resolved.origin !== siteOrigin) continue;
    refs.add(resolved.href);
  }

  return [...refs];
}

/**
 * 從 index.html 出發，把站內所有能引用到的 js 抓下來。
 *
 * 有幾個文件是 import 鏈上找不到的：public/ 下原樣複製上線的那些，
 * 其中一部分由運行時拼出地址來加載（MediaPipe 的 wasm glue 就是這樣）。
 * 瀏覽器照樣會加載它們，所以調用方可以用 extraPaths 把這些路徑直接補進起點。
 *
 * @param {object} options
 * @param {string} options.baseUrl 站點根，必須以 / 結尾
 * @param {(url: string) => Promise<string | null>} options.fetchText 取文本；取不到返回 null
 * @param {string[]} [options.extraPaths] 額外起點，相對站點根
 * @param {{ maxFiles?: number, maxBytes?: number }} [options.limits]
 * @returns {Promise<{ files: {url: string, text: string, bytes: number}[],
 *                     stats: { fetched: number, missing: number, bytes: number, indexReadable: boolean },
 *                     truncated: null | { reason: string, limit: number } }>}
 */
export async function collectSiteScripts({ baseUrl, fetchText, extraPaths = [], limits = {} }) {
  const { maxFiles, maxBytes } = { ...DEFAULT_LIMITS, ...limits };

  const files = [];
  const stats = { fetched: 0, missing: 0, unreachable: 0, bytes: 0, indexReadable: false };
  let truncated = null;

  const indexText = await fetchText(baseUrl);
  const queue = [];
  const seen = new Set();

  const enqueue = (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    queue.push(url);
  };

  if (indexText !== null) {
    stats.indexReadable = true;
    for (const ref of extractScriptRefs(indexText, baseUrl, baseUrl)) enqueue(ref);
  }

  for (const extra of extraPaths) {
    try {
      enqueue(new URL(extra, baseUrl).href);
    } catch {
      // 給了個解析不了的路徑，跳過就行 —— 抓不到的引用本來也只記數。
    }
  }

  while (queue.length > 0) {
    if (files.length >= maxFiles) {
      truncated = { reason: 'maxFiles', limit: maxFiles };
      break;
    }
    if (stats.bytes >= maxBytes) {
      truncated = { reason: 'maxBytes', limit: maxBytes };
      break;
    }

    const url = queue.shift();
    let text;
    try {
      text = await fetchText(url);
    } catch (error) {
      // 取不到 ≠ 不存在。這個文件沒被審計過，結論就有個缺口，
      // 不能跟「認錯文件名」一樣放過去。
      stats.unreachable += 1;
      console.error(`  ⚠️  取不到 ${url}：${error?.message || error}`);
      continue;
    }
    if (text === null) {
      // 從壓縮過的代碼裡認文件名難免認錯，認錯的地址一取就是 404。
      // 這些不算失敗，但要記數：數字太大就說明上面那個正則該收緊了。
      stats.missing += 1;
      continue;
    }

    const bytes = Buffer.byteLength(text);
    files.push({ url, text, bytes });
    stats.fetched += 1;
    stats.bytes += bytes;

    for (const ref of extractScriptRefs(text, url, baseUrl)) enqueue(ref);
  }

  return { files, stats, truncated };
}

/**
 * 對掃到的產物做斷言。
 *
 * @param {object} options
 * @param {{ files: {url: string, text: string}[], truncated: any }} options.scan
 * @param {string} options.websiteId
 * @param {string} options.scriptUrl
 * @returns {{ checks: {name: string, expected: string, actual: string, ok: boolean, note?: string}[],
 *             failed: {name: string, expected: string, actual: string}[] }}
 */
export function auditTrackerFootprint({ scan, websiteId, scriptUrl }) {
  const checks = [];
  const add = (name, expected, actual, note) => {
    checks.push({ name, expected, actual, ok: expected === actual, ...(note ? { note } : {}) });
  };

  // 這幾條是「結論有沒有依據」的前提，放最前面。
  // 探測這一側自己壞掉的時候（站點拿不到、入口包 404、爬了一半撞上限、
  // 有文件取不到），「什麼都沒查出來」和「查完沒問題」長得一模一樣，而且是綠的。
  add('抓到了可供審計的產物', 'yes', scan.files.length > 0 ? 'yes' : 'no');
  add(
    '掃描覆蓋完整（沒撞上限）',
    'yes',
    scan.truncated ? `no（撞上 ${scan.truncated.reason}=${scan.truncated.limit}）` : 'yes',
  );
  add('引用到的文件都取到了', '0 個取不到', `${scan.stats.unreachable} 個取不到`);

  const idHit = scan.files.find((file) => file.text.includes(websiteId));
  add(
    '線上產物內含該站點 id',
    'yes',
    idHit ? 'yes' : 'no',
    idHit ? `出現在 ${idHit.url.split('/').pop()}` : undefined,
  );

  // 產物裡出現的 tracker 地址去重後必須只有一個，且就是配的那個。
  // 多出一個 = 頁面上還掛著第二個上報端點。
  const found = new Set();
  for (const file of scan.files) {
    for (const match of file.text.matchAll(trackerPattern())) found.add(match[0]);
  }
  const got = [...found].sort().join(',');
  add('線上產物內 tracker 地址唯一且相符', scriptUrl, got || '（沒找到）');

  return { checks, failed: checks.filter((check) => !check.ok) };
}

// ───────────────────────── 以下是命令行入口 ─────────────────────────

/** `--a b --c d` → { a: 'b', c: 'd' } */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? '' : (argv[i + 1] ?? '');
  }
  return out;
}

/**
 * 走網絡取文本。404 當「這個地址本來就沒有」（多半是從壓縮代碼裡認錯了文件名），
 * 其餘的失敗先重試，重試完還不行就拋 —— 那意味著這個文件沒被審計到，
 * 是結論上的缺口，不能跟認錯文件名一樣默默放過。
 */
function httpFetcher(timeoutMs = 60_000, retries = 2) {
  return async (url) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw lastError;
  };
}

/** 從本地構建產物裡取，用來自查（node scripts/audit-online-bundle.mjs --dir dist）。 */
function directoryFetcher(dir, baseUrl) {
  return async (url) => {
    const relative = url.slice(baseUrl.length) || 'index.html';
    try {
      return await readFile(path.join(dir, decodeURIComponent(relative)), 'utf8');
    } catch {
      return null;
    }
  };
}

/**
 * 列出 public/ 下所有 js 的相對路徑。這個目錄是原樣複製上線的，
 * 站點上的地址就是「站點根 + 這裡的相對路徑」。
 */
async function listPublicScripts(dir) {
  const found = [];
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (entry.name.endsWith('.js')) found.push(relative);
    }
  }
  await walk(dir, '');
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const websiteId = args['website-id'] || process.env.AUDIT_WEBSITE_ID || '';
  const scriptUrl = args['script-url'] || process.env.AUDIT_SCRIPT_URL || '';
  const dir = args.dir || '';
  // 本地目錄模式借一個 http 假地址當站點根：同源判定要有 origin，
  // 而 file:// 的 origin 是 null，判不了。
  const baseUrl = dir ? 'http://local/' : (args.base || process.env.AUDIT_BASE_URL || '');

  if (!websiteId || !scriptUrl || (!dir && !args.base && !process.env.AUDIT_BASE_URL)) {
    console.error('用法：--base <站點根 URL> | --dir <本地目錄>，外加 --website-id 與 --script-url');
    process.exit(2);
  }

  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const fetchText = dir ? directoryFetcher(dir, base) : httpFetcher();

  // 改 workflow 的 push 會順帶觸發一次部署，兩邊撞車時 index.html 指向的 chunk
  // 可能正在被換掉，抓下來是 404。整輪重試 —— 部署一次 chunk 名就變一次，
  // 只重試下載單個文件是沒用的。
  const extraPaths = args['public-dir'] ? await listPublicScripts(args['public-dir']) : [];

  let scan = null;
  const attempts = dir ? 1 : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    scan = await collectSiteScripts({ baseUrl: base, fetchText, extraPaths });
    if (scan.files.length > 0) break;
    if (attempt < attempts) {
      console.error(`  第 ${attempt} 次一個 js 都沒抓到，等 20 秒重試（多半是正撞上部署）`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
  }

  const result = auditTrackerFootprint({ scan, websiteId, scriptUrl });

  console.error(`  掃描起點 ${base}${extraPaths.length ? `，外加 public/ 裡的 ${extraPaths.length} 個靜態 js` : ''}`);
  console.error(
    `  抓到 ${scan.stats.fetched} 個 js（${scan.stats.bytes} 字節）；` +
      `${scan.stats.missing} 個地址是 404（認錯文件名，正常）；` +
      `${scan.stats.unreachable} 個取不到`,
  );
  for (const check of result.checks) {
    const suffix = check.note ? `  ${check.note}` : '';
    if (check.ok) console.error(`  ✅ ${check.name.padEnd(38)} ${check.actual}${suffix}`);
    else console.error(`  ❌ ${check.name.padEnd(38)} 期望 ${check.expected}，實際 ${check.actual}`);
  }

  process.stdout.write(`${JSON.stringify({ checks: result.checks, stats: scan.stats }, null, 2)}\n`);
  process.exit(result.failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`審計腳本自己出錯了：${error?.stack || error}`);
    process.exit(2);
  });
}
