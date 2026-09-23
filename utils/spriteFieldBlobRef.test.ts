import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 角色立繪的三個字段——`sprites.*`（見面情緒立繪 + 小小窩的 sprites.chibi）、
// `dateSkinSets[].sprites.*`（換裝套裝）、`savedDateState.currentSprite`（見面存檔快照）
// ——存的值可能是 `blobref:` 令牌（二進制在 IndexedDB，見 utils/blobRef.ts）。
// 令牌塞進裸 <img src> 或 CSS url() 就是一張裂圖，所以這些字段的渲染端一律走
// TokenImg（或先 useBlobRefUrl 解析再拼）。
//
// 這份守衛掃源碼：只要有人把立繪字段直接接回裸 <img src={...}> / backgroundImage，
// 這條就紅。變量名帶 Url 後綴的（已經解析過的地址）不在其列。

const ROOTS = ['components', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** 裸 <img src={ ...sprites[...] / ...sprite.xxx... }>：立繪字段值直接當地址用。 */
const BARE_IMG = /<img\b[^>]*\bsrc=\{[^}]*\bsprites?\s*[[.]/;
/** CSS url() 裡插立繪字段值。 */
const BARE_CSS_URL = /backgroundImage[^\n]*\$\{[^}]*\bsprites?\s*[[.]/;
/** 見面存檔快照裡的立繪值直接當地址用。 */
const BARE_SAVED_SPRITE = /(?:<img\b[^>]*\bsrc=|url\(\$)\{[^}]*\bcurrentSprite\b[^}]*\}/;

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsxFiles(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const repoRoot = path.resolve(__dirname, '..');
const files = ROOTS.flatMap(root => collectTsxFiles(path.join(repoRoot, root)));

const scan = (pattern: RegExp): string[] => files
  .filter(file => pattern.test(readFileSync(file, 'utf8')))
  .map(file => path.relative(repoRoot, file));

describe('立繪字段的 blobref 渲染路徑', () => {
  it('掃到了源碼文件（別讓路徑寫錯導致這份守衛空跑）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('沒有任何 sprites 字段值被塞進裸 <img src>', () => {
    expect(scan(BARE_IMG)).toEqual([]);
  });

  it('沒有任何 sprites 字段值被拼進 CSS url()', () => {
    expect(scan(BARE_CSS_URL)).toEqual([]);
  });

  it('見面存檔裡的 currentSprite 也不走裸 <img src> / url()', () => {
    expect(scan(BARE_SAVED_SPRITE)).toEqual([]);
  });
});

describe('見面場景佈置（DateSettings）的立繪縮略圖', () => {
  const source = readFileSync(path.join(repoRoot, 'components/date/DateSettings.tsx'), 'utf8');

  it('基礎情緒 / 自定義情緒的格子走 TokenImg', () => {
    expect(source).toContain('<TokenImg value={sprites[key]}');
    expect(source).not.toContain('<img src={sprites[key]}');
  });

  it('換裝套裝裡的格子走 TokenImg', () => {
    expect(source).toContain('<TokenImg value={skin.sprites[emoKey]}');
    expect(source).not.toContain('<img src={skin.sprites[emoKey]}');
  });
});

describe('見面場景佈置（DateSettings）的立繪上傳寫端', () => {
  const source = readFileSync(path.join(repoRoot, 'components/date/DateSettings.tsx'), 'utf8');

  it('上傳立繪存的是令牌，不是 base64', () => {
    expect(source).toContain('const ref = await putImageBlob(blob);');
    expect(source).not.toContain('const base64 = await processImage(file);');
  });

  it('三個入口（基礎情緒 / 自定義情緒 / 換裝套裝）寫的都是令牌', () => {
    // 基礎情緒和自定義情緒共用 char.sprites 這一條寫入分支。
    expect(source).toContain('const newSprites = { ...(char.sprites || {}), [key]: ref };');
    expect(source).toContain('sprites: { ...s.sprites, [key]: ref }');
    expect(source).not.toContain('[key]: base64');
  });

  it('立繪保持原來的壓縮口徑（不像背景那樣 skipCompression）', () => {
    // processImage(file) 不傳參 = 長邊 1200 / 質量 0.85 / PNG·WebP 保留透明通道，
    // processImageToBlob(file) 不傳參是同一套；給立繪補上 skipCompression 會把
    // 用戶的圖從「壓過」變成「原圖直存」，體積翻幾倍。
    expect(source).toContain('const blob = await processImageToBlob(file);');
    // 背景那一條仍然保原畫質，兩條別串了。
    expect(source).toContain('await processImageToBlob(file, { skipCompression: true })');
  });

  it('圖床 URL 入口照舊寫外鏈（外鏈不是本機資源，不該令牌化）', () => {
    expect(source).toContain('sprites: { ...s.sprites, [key]: url }');
    expect(source).toContain('const newSprites = { ...(char.sprites || {}), [key]: url };');
  });
});
