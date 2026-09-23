import { describe, it, expect } from 'vitest';
import { scanPlaintextSecrets, assessExport, confirmExportSafety } from './exportGuard';

describe('scanPlaintextSecrets', () => {
  it('揪出嵌套的明文 apiKey', () => {
    const hits = scanPlaintextSecrets({
      name: '角色',
      emotionConfig: { enabled: true, api: { baseUrl: 'https://x', apiKey: 'sk-ABCD1234EFGH5678IJKL', model: 'g' } },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.path === 'emotionConfig.api.apiKey')).toBe(true);
    // 打碼：不回顯完整密鑰
    expect(hits.every(h => !h.masked.includes('sk-ABCD1234EFGH5678IJKL'))).toBe(true);
  });

  it('按值也能揪出（字段名無辜但值像密鑰）', () => {
    const hits = scanPlaintextSecrets({ note: 'my token is sk-ZZZZ9999YYYY8888XXXX ok' });
    expect(hits.some(h => h.path === 'note')).toBe(true);
  });

  it('不誤報正文 / 圖片 dataURL / 普通 URL', () => {
    const hits = scanPlaintextSecrets({
      systemPrompt: '這是一段很長很長的系統提示詞'.repeat(10),
      avatar: 'data:image/png;base64,AAAABBBBCCCCDDDDEEEEFFFF0000111122223333',
      baseUrl: 'https://api.example.com/v1/chat/completions',
    });
    expect(hits.length).toBe(0);
  });

  it('不把語音模型 ID 誤報成明文密鑰', () => {
    const hits = scanPlaintextSecrets({
      voiceProfile: {
        voiceId: 'speech-02-turbo-240501',
        fishReferenceId: '35230ec20d9bebb2215a50a5e53cf112',
      },
    });
    expect(hits).toEqual([]);
  });

  it('仍會檢出未知字段裡的 32 位長密鑰狀字符串', () => {
    const hits = scanPlaintextSecrets({
      opaqueValue: '35230ec20d9bebb2215a50a5e53cf112',
    });
    expect(hits.some(h => h.path === 'opaqueValue')).toBe(true);
  });

  it('不把 customCss 內嵌的 base64 圖片或字體誤報成密鑰', () => {
    const hits = scanPlaintextSecrets({
      chatThemes: [{
        customCss: `
          .sully-bubble-ai {
            background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC");
          }
          @font-face {
            font-family: "demo";
            src: url(data:font/woff2;base64,d09GMgABAAAAAAG0AAoAAAAAA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAA);
          }
        `,
      }],
    });
    expect(hits).toEqual([]);
  });

  it('CSS 字段仍會檢出 sk/Bearer/JWT 等強密鑰特徵', () => {
    const hits = scanPlaintextSecrets({
      customCss: '.x::after { content: "sk-AAAA1111BBBB2222CCCC"; }',
      chromeCustomCss: '/* Authorization: Bearer abcdefghijklmnop */',
    });
    expect(hits.some(h => h.path === 'customCss')).toBe(true);
    expect(hits.some(h => h.path === 'chromeCustomCss')).toBe(true);
  });

  it('乾淨對象返回空', () => {
    expect(scanPlaintextSecrets({ name: 'x', worldview: 'w' })).toEqual([]);
  });

  it('循環引用不死循環', () => {
    const a: any = { name: 'x' }; a.self = a;
    expect(() => scanPlaintextSecrets(a)).not.toThrow();
  });
});

describe('assessExport', () => {
  const dirty = { emotionConfig: { api: { apiKey: 'sk-AAAA1111BBBB2222CCCC' } } };

  it('安全內容 → safe + 可分享文案', () => {
    const a = assessExport({ name: 'x' });
    expect(a.level).toBe('safe');
    expect(a.message).toBe('該導出內容安全，可以用於分享');
  });

  it('備份含密鑰（預期內）→ contains-secret + 別發給任何人', () => {
    const a = assessExport(dirty, { expectSecrets: true });
    expect(a.level).toBe('contains-secret');
    expect(a.message).toBe('該導出數據包含了明文密鑰，請不要發送給任何人');
  });

  it('分享類竟含密鑰（不該出現）→ unexpected-secret + 截圖發作者', () => {
    const a = assessExport(dirty);
    expect(a.level).toBe('unexpected-secret');
    expect(a.message).toContain('請截圖併發送給作者');
    expect(a.message).toContain('emotionConfig.api.apiKey');
  });
});

describe('confirmExportSafety', () => {
  it('safe 直接放行，不打斷', async () => {
    const ok = await confirmExportSafety({ name: 'x' });
    expect(ok).toBe(true);
  });

  it('檢出密鑰時把提示交給 confirmImpl，返回其結果', async () => {
    let seen = '';
    const ok = await confirmExportSafety(
      { api: { apiKey: 'sk-AAAA1111BBBB2222CCCC' } },
      { confirmImpl: (a) => { seen = a.message; return false; } },
    );
    expect(ok).toBe(false);
    expect(seen).toContain('請截圖併發送給作者');
  });
});
