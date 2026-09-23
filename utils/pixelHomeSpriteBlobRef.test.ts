import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 像素小屋（apps/pixelHome）裡走來走去的那兩個小人，圖從哪來是分層的：
//   1. 用戶捏過像素形象 → 捏人器生成的 data URL；
//   2. 沒捏過 → 退回 char.avatar 當立繪。
// 第 2 條是問題所在：char.avatar 存的是 `blobref:` 令牌（二進制在 IndexedDB，
// 見 utils/blobRef.ts），令牌塞進裸 <img src> 就是一張裂圖。所以小人的渲染端
// 一律走 TokenImg（認令牌，非令牌原樣透傳）。
//
// 這份守衛掃源碼：只要有人把 charSprite / playerSprite / sprite 直接接回
// 裸 <img src={...}> 或 CSS url()，這條就紅。

const PIXEL_HOME_DIR = path.resolve(__dirname, '../apps/pixelHome');

/** 裸 <img src={charSprite}> / <img src={sprite}>：立繪值直接當地址用。 */
const BARE_SPRITE_IMG = /<img\b[^>]*\bsrc=\{\s*(?:charSprite|playerSprite|sprite)\b/;
/** CSS url() 裡插立繪值。 */
const BARE_SPRITE_CSS = /url\(\$\{\s*(?:charSprite|playerSprite|sprite)\b/;

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsxFiles(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = collectTsxFiles(PIXEL_HOME_DIR);
const scan = (pattern: RegExp): string[] => files
  .filter(file => pattern.test(readFileSync(file, 'utf8')))
  .map(file => path.basename(file));

const read = (name: string) => readFileSync(path.join(PIXEL_HOME_DIR, name), 'utf8');

describe('像素小屋小人立繪的 blobref 渲染路徑', () => {
  it('掃到了源碼文件（別讓路徑寫錯導致這份守衛空跑）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('沒有任何小人立繪被塞進裸 <img src>', () => {
    expect(scan(BARE_SPRITE_IMG)).toEqual([]);
  });

  it('沒有任何小人立繪被拼進 CSS url()', () => {
    expect(scan(BARE_SPRITE_CSS)).toEqual([]);
  });

  it('全景地圖裡的角色小人走 TokenImg', () => {
    expect(read('PixelHomeMap.tsx')).toContain('<TokenImg value={charSprite}');
  });

  it('房間編輯器裡的角色小人走 TokenImg', () => {
    expect(read('PixelRoomEditor.tsx')).toContain('<TokenImg value={charSprite}');
  });

  it('記憶潛行房間裡的角色 / 用戶小人走 TokenImg', () => {
    // SpritePerson 一個組件同時渲染 charSprite 和 playerSprite，改一處覆蓋兩個小人。
    const source = read('MemoryDiveRoom.tsx');
    expect(source).toContain('<TokenImg value={sprite}');
    expect(source).toContain('sprite={playerSprite}');
    expect(source).toContain('sprite={charSprite}');
  });
});

describe('小人立繪的取值鏈路', () => {
  it('沒捏過像素形象時確實會退回 char.avatar（這就是令牌進來的口子）', () => {
    // 這條鏈路一旦改掉，上面那幾條守衛就失去了存在理由；留著它把因果釘在一起。
    const view = read('PixelHomeView.tsx');
    expect(view).toContain('charSprite={pixelCharSprite || charAvatar}');
    const roomApp = readFileSync(path.resolve(__dirname, '../apps/RoomApp.tsx'), 'utf8');
    expect(roomApp).toContain('charAvatar={char.avatar}');
  });
});
