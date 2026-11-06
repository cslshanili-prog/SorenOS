import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 見面背景和角色立繪的字段裡存的可能是 `blobref:` 令牌（見 utils/blobRef.ts）。
// 令牌塞進裸 <img src> / CSS url() 就是一張裂圖，所以必須走認令牌的渲染路徑：
// 立繪用 TokenImg，背景用 useBlobRefUrl 解析後再拼。
//
// 這份守衛還釘住另一條：認令牌之前，這裡靠「看到令牌就躲開、退回 char.avatar」硬撐；
// char.avatar 本身也會是令牌（一鍵優化會把它轉成令牌），於是躲開等於換一張同樣裂的圖。
// 挑選邏輯裡不該再出現任何 `!isBlobRef(...)` 的過濾。
const read = (file: string) => readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const session = read('components/date/DateSession.tsx');
const spriteManager = read('components/character/CharacterSpriteManager.tsx');

describe('見面背景 / 角色立繪的 blobref 渲染路徑', () => {
  it('見面背景先用 useBlobRefUrl 解析再拼進 CSS url()', () => {
    expect(session).toContain("const bgImageUrl = useBlobRefUrl(char.dateBackground || '')");
    expect(session).toContain('backgroundImage: bgImageUrl ?');
    expect(session).not.toMatch(/backgroundImage: char\.dateBackground/);
  });

  it('角色立繪走 TokenImg，不是裸 <img>', () => {
    expect(spriteManager).toContain('<TokenImg value={sprites[key]}');
    expect(spriteManager).toContain('value={currentSpriteImg}');
    expect(spriteManager).not.toMatch(/<img src=\{sprites/);
  });

  it('挑立繪時不跳過令牌，也不把令牌換成 char.avatar', () => {
    expect(spriteManager).not.toMatch(/!isBlobRef\s*\(/);
    expect(session).not.toMatch(/!isBlobRef\s*\(/);
  });
});
