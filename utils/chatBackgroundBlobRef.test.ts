import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 角色的聊天背景（characters.chatBackground）存的是 `blobref:` 令牌（見 utils/blobRef.ts），
// 二進制在 IndexedDB 裡。令牌直接塞進裸 <img src> / CSS url() 就是一張裂圖，所以：
//   · 設置彈窗裡的縮略圖走 TokenImg；
//   · 聊天頁根容器的背景先用 useBlobRefUrl 解析成可用地址再拼進 url()；
//   · 上傳時用 processImageToBlob + putImageBlob 產出令牌，別再寫回 base64
//     （寫端漏改的話，用戶新設的背景又變成幾 MB 的 data URL 塞在角色行裡）。
const chatSource = readFileSync(path.resolve(__dirname, '../apps/Chat.tsx'), 'utf8');
const modalsSource = readFileSync(path.resolve(__dirname, '../components/chat/ChatModals.tsx'), 'utf8');

describe('聊天背景的 blobref 讀寫路徑', () => {
  it('上傳後存的是令牌，不是 base64', () => {
    expect(chatSource).toContain('const blob = await processImageToBlob(file, { skipCompression: true });');
    expect(chatSource).toContain('updateCharacter(char.id, { chatBackground: ref });');
    expect(chatSource).not.toContain('updateCharacter(char.id, { chatBackground: dataUrl });');
  });

  it('聊天頁背景先用 useBlobRefUrl 解析再拼進 CSS url()', () => {
    expect(chatSource).toContain('const resolvedChatBackground = useBlobRefUrl(char?.chatBackground);');
    expect(chatSource).toContain('url("${resolvedChatBackground}")');
    expect(chatSource).not.toContain('url(${char.chatBackground})');
  });

  it('解析 hook 在「角色為空」的早退之前調用（hook 順序不能隨空態變化）', () => {
    const hookAt = chatSource.indexOf('useBlobRefUrl(char?.chatBackground)');
    const guardAt = chatSource.indexOf('if (!char) {');
    expect(hookAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(guardAt);
  });

  it('設置彈窗裡的背景縮略圖走 TokenImg，不是裸 <img>', () => {
    expect(modalsSource).toContain('<TokenImg value={activeCharacter.chatBackground}');
    expect(modalsSource).not.toContain('<img src={activeCharacter.chatBackground}');
  });
});
