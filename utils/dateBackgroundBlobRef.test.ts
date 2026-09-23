import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 角色的見面背景（characters.dateBackground）存的是 `blobref:` 令牌（見 utils/blobRef.ts），
// 二進制在 IndexedDB 裡。令牌直接塞進裸 <img src> / CSS url() 就是一張裂圖，所以：
//   · 場景佈置頁的預覽底圖和縮略圖分別走 useBlobRefUrl / TokenImg；
//   · 查手機的桌面底圖、以 TA 的身份體驗（PersonaSim）的外殼底圖也各自先解析再拼 url()；
//   · 上傳時用 processImageToBlob + putImageBlob 產出令牌，別再寫回 base64
//     （寫端漏改的話，用戶新設的背景又變成幾 MB 的 data URL 塞在角色行裡）。
const settingsSource = readFileSync(path.resolve(__dirname, '../components/date/DateSettings.tsx'), 'utf8');
const checkPhoneSource = readFileSync(path.resolve(__dirname, '../apps/CheckPhone.tsx'), 'utf8');
const personaSimSource = readFileSync(path.resolve(__dirname, '../apps/PersonaSim.tsx'), 'utf8');

describe('見面背景的 blobref 讀寫路徑', () => {
  it('上傳後存的是令牌，不是 base64', () => {
    expect(settingsSource).toContain('const blob = await processImageToBlob(file, { skipCompression: true });');
    expect(settingsSource).toContain('updateCharacter(char.id, { dateBackground: ref });');
    expect(settingsSource).not.toContain('updateCharacter(char.id, { dateBackground: base64 });');
  });

  it('場景佈置頁的預覽底圖先用 useBlobRefUrl 解析再拼進 CSS url()', () => {
    expect(settingsSource).toContain('const dateBackgroundUrl = useBlobRefUrl(char.dateBackground);');
    expect(settingsSource).toContain('backgroundImage: dateBackgroundUrl ?');
    expect(settingsSource).not.toContain('url(${char.dateBackground})');
  });

  it('場景佈置頁的背景縮略圖走 TokenImg，不是裸 <img>', () => {
    expect(settingsSource).toContain('<TokenImg value={char.dateBackground}');
    expect(settingsSource).not.toContain('<img src={char.dateBackground}');
  });

  it('查手機的桌面底圖先解析再拼，且解析發生在組件頂層（不能塞進 renderDesktop 裡）', () => {
    expect(checkPhoneSource).toContain('const dateBackgroundUrl = useBlobRefUrl(targetChar?.dateBackground);');
    expect(checkPhoneSource).toContain('url("${dateBackgroundUrl}")');
    expect(checkPhoneSource).not.toContain('url(${targetChar!.dateBackground})');

    const hookAt = checkPhoneSource.indexOf('useBlobRefUrl(targetChar?.dateBackground)');
    const renderDesktopAt = checkPhoneSource.indexOf('const renderDesktop = () => {');
    expect(hookAt).toBeGreaterThan(-1);
    expect(renderDesktopAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(renderDesktopAt);
  });

  it('PersonaSim 的外殼底圖在 Shell 裡解析一次，覆蓋全部調用點', () => {
    expect(personaSimSource).toContain('const wallpaperUrl = useBlobRefUrl(wallpaper);');
    expect(personaSimSource).toContain('url("${wallpaperUrl}")');
    expect(personaSimSource).not.toContain('url(${wallpaper})');
  });
});
