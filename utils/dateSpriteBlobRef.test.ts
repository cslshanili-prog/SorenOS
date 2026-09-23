import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 見面（DateApp）的立繪和背景，字段裡存的可能是 `blobref:` 令牌（見 utils/blobRef.ts）。
// 令牌塞進裸 <img src> / CSS url() 就是一張裂圖，所以這兩處必須走認令牌的渲染路徑：
// 立繪用 TokenImg，背景用 useBlobRefUrl 解析後再拼。
//
// 這份守衛還釘住另一條：認令牌之前，這裡靠「看到令牌就躲開、退回 char.avatar」硬撐；
// char.avatar 本身也會是令牌（一鍵優化會把它轉成令牌），於是躲開等於換一張同樣裂的圖。
// 挑選邏輯裡不該再出現任何 `!isBlobRef(...)` 的過濾。
const source = readFileSync(path.resolve(__dirname, '../components/date/DateSession.tsx'), 'utf8');

describe('見面立繪 / 背景的 blobref 渲染路徑', () => {
  it('立繪走 TokenImg，不是裸 <img>', () => {
    expect(source).toContain('<TokenImg value={currentSprite}');
    expect(source).not.toContain('<img src={currentSprite}');
  });

  it('背景先用 useBlobRefUrl 解析再拼進 CSS url()', () => {
    expect(source).toContain('const bgImageUrl = useBlobRefUrl(bgImage)');
    expect(source).toContain('backgroundImage: bgImageUrl ?');
    expect(source).not.toContain('backgroundImage: bgImage ?');
  });

  it('挑立繪時不再跳過令牌，也不把令牌換成 char.avatar', () => {
    expect(source).not.toMatch(/!isBlobRef\s*\(/);
    expect(source).not.toContain('isBlobRef(restoredSprite.src)');
  });

  it('currentSprite state 裡存的是原始字段值，解析只發生在渲染那一刻', () => {
    // inferSpriteKey 靠「立繪值 === sprites 表裡的值」反查情緒 key。
    // 一旦把解析後的 objectURL 存進 state，這個比對就永遠查不到鍵。
    expect(source).toContain('Object.entries(sprites).find(([, value]) => value === src)');
    expect(source).not.toMatch(/setCurrentSprite\([^)]*Url[)\s]/);
  });
});
