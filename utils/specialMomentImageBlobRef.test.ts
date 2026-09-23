import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 活動留存記錄（characters 表的 specialMomentRecords.<活動key>.image）裡那張大圖要改存
// `blobref:<id>` 令牌（見 utils/blobRef.ts）：白色情人節是 canvas 畫出來的明信片（300KB+），
// 520 是捏人器吐出來的帶框定妝照（500KB+），兩張都直接 base64 躺在角色行裡。
//
// 令牌不是能直接用的 URL：塞進裸 <img src> 是一張裂圖，塞給 a.download / fetch /
// Filesystem.writeFile 更是直接失敗。所以寫端要產令牌，讀端要麼走 TokenImg，
// 要麼先 resolveRefToDataUrl 還原成真 base64。
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
const whiteDay = read('../components/WhiteDayEvent.tsx');
const like520 = read('../components/Like520Event.tsx');

describe('白色情人節明信片（specialMomentRecords.whiteday_2026.image）', () => {
    it('寫端存的是令牌，不是 canvas 吐出來的 base64', () => {
        expect(whiteDay).toMatch(/putImageBlob\(dataUrlToBlob\(base64\)\)/);
        // 老寫法：`image: base64,`
        expect(whiteDay).not.toMatch(/\bimage:\s*base64\b/);
    });

    it('回看頁的明信片走 TokenImg，沒有裸 <img> 吃 savedImage', () => {
        expect(whiteDay).toMatch(/<TokenImg\s+value=\{savedImage\}/);
        expect(whiteDay).not.toMatch(/<img[^>]*\{savedImage\}/);
    });

    it('重新下載前先把令牌還原成真 base64（a.download / fetch / Filesystem 都只認 data:）', () => {
        expect(whiteDay).toMatch(/resolveRefToDataUrl\(savedImage\)/);
        expect(whiteDay).not.toMatch(/downloadOrShare\(\s*savedImage/);
    });

    it('savedImage 沒有被拼進 CSS url()', () => {
        expect(whiteDay).not.toMatch(/url\(\$\{[^}]*savedImage/);
    });
});

describe('520 定妝照（specialMomentRecords.like520_2026.image）', () => {
    it('寫端存的是令牌，不是捏人器吐的 frameDataUrl', () => {
        expect(like520).toMatch(/putImageBlob\(dataUrlToBlob\(charChibi\.frameDataUrl\)\)/);
        // 老寫法：`image: charChibi.frameDataUrl,`
        expect(like520).not.toMatch(/\bimage:\s*charChibi\.frameDataUrl\b/);
    });

    it('隔壁兩張手辦圖仍然是 dataURL（canvas 合成大頭貼要能同步開始加載，令牌過不去）', () => {
        expect(like520).toMatch(/charChibi:\s*\{\s*dataUrl:\s*charChibi\.transparentDataUrl/);
        expect(like520).toMatch(/userChibi:\s*\{\s*dataUrl:\s*userChibi\.transparentDataUrl/);
    });
});
