import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 桌面小組件圖（OSTheme.launcherWidgets，槽位 tl / tr / wide / dsq）存的是 `blobref:` 令牌
// （見 utils/blobRef.ts），二進制在 IndexedDB 裡。令牌塞進裸 <img src> 就是一張裂圖，所以：
//   · 桌面（Launcher）和外觀設置頁（Appearance）的每一處縮略圖都走 TokenImg；
//   · 上傳時用 processImageToBlob + putImageBlob 產出令牌，且必須原樣帶上各槽位的
//     maxWidth（wide 800 / dsq 600 / 其餘 500）與 quality 0.9——換成 skipCompression
//     等於把用戶的圖從壓縮過的變成原圖直存，體積翻幾倍；
//   · OSContext 往 assets 表寫 widget_<slot> 時不能按 `data:` 前綴挑著存：令牌不帶這個
//     前綴，挑的結果是圖只剩 localStorage 一份，下次啟動小組件直接沒了。
const launcherSource = readFileSync(path.resolve(__dirname, '../apps/Launcher.tsx'), 'utf8');
const appearanceSource = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
const osContextSource = readFileSync(path.resolve(__dirname, '../context/OSContext.tsx'), 'utf8');

describe('桌面小組件圖的 blobref 讀寫路徑', () => {
  it('上傳後存的是令牌，不是 base64', () => {
    expect(appearanceSource).toContain('const blob = await processImageToBlob(file, { maxWidth: maxW, quality: 0.9 });');
    expect(appearanceSource).toContain('const ref = await putImageBlob(blob);');
    expect(appearanceSource).toContain('updateTheme({ launcherWidgets: { ...current, [activeWidgetSlot]: ref } });');
    expect(appearanceSource).not.toContain('const dataUrl = await processImage(file, { maxWidth: maxW, quality: 0.9 });');
  });

  it('壓縮口徑沒變：各槽位的 maxWidth 原樣保留，也沒順手加 skipCompression', () => {
    expect(appearanceSource).toContain(
      "const maxW = activeWidgetSlot === 'wide' ? 800 : activeWidgetSlot === 'dsq' ? 600 : 500;",
    );
    const upload = appearanceSource.slice(
      appearanceSource.indexOf('const handleWidgetUpload'),
      appearanceSource.indexOf('const removeWidget'),
    );
    expect(upload).not.toContain('skipCompression');
  });

  it('桌面（Launcher）的三個槽位都走 TokenImg，不是裸 <img>', () => {
    // 首頁方圖（DesktopSquareImage）
    expect(launcherSource).toContain('<TokenImg value={image} alt="" className="w-full h-full object-cover" loading="lazy" />');
    expect(launcherSource).not.toContain('<img src={image} alt="" className="w-full h-full object-cover" loading="lazy" />');
    // 第三頁的 tl / tr 與 wide
    expect(launcherSource).toContain('<TokenImg value={w[key]}');
    expect(launcherSource).toContain("<TokenImg value={w['wide']}");
    expect(launcherSource).not.toContain('<img src={w[key]}');
    expect(launcherSource).not.toContain("<img src={w['wide']}");
  });

  it('外觀設置頁的槽位縮略圖與 DIY 預覽都走 TokenImg', () => {
    // dsq / tl / tr / wide 四個槽位共用同一段縮略圖 JSX
    expect(appearanceSource).toContain('<TokenImg value={img} className="w-full h-full object-cover" />');
    expect(appearanceSource).not.toContain('<img src={img} className="w-full h-full object-cover" />');
    // 桌面裝飾 DIY 的實時預覽
    expect(appearanceSource).toContain('<TokenImg value={w[k]} className="w-full h-full object-cover" />');
    expect(appearanceSource).toContain('<TokenImg value={w[\'wide\']} className="w-full h-full object-cover" />');
    expect(appearanceSource).not.toContain('<img src={w[k]}');
  });

  it('assets 表的 widget_<slot> 一律原樣落庫，不按 data: 前綴挑', () => {
    expect(osContextSource).toContain('DB.saveAsset(`widget_${slot}`, val)');
    // 舊寫法：令牌不帶 data: 前綴，會被這道判斷整個跳過，assets 裡一行都不落
    expect(osContextSource).not.toContain("if (val && val.startsWith('data:'))");
    const block = osContextSource.slice(
      osContextSource.indexOf('// Save widget images to IndexedDB'),
      osContextSource.indexOf("await DB.deleteAsset('widget_bl');"),
    );
    expect(block).toContain('if (val) {');
    expect(block).not.toContain("startsWith('data:')");
  });

  it('應用外觀預設時把小組件圖寫進 assets（不寫的話下次啟動會被上一套主題蓋回去）', () => {
    expect(osContextSource).toContain('await DB.saveAsset(`widget_${slot}`, stored);');
  });

  it('localStorage 鏡像不剝令牌（os_theme 是孤兒清理的引用面之一）', () => {
    // 剝 data: 是防 base64 撐爆 quota 的運行時兜底，令牌必須原樣留在 os_theme 裡，
    // 否則這一面就沒人引用了。
    expect(osContextSource).toContain("cleanWidgets[k] = (v && v.startsWith('data:')) ? '' : v;");
  });
});
