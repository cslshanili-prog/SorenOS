import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REF_SOURCE_STORES } from './blobGc';

// 「瑞一杯 / Spark」自己的兩張圖（assets 表的 spark_user_bg 與 spark_social_profile.avatar）
// 走 blobref 令牌：二進制在 IndexedDB，行裡只留令牌。
//
// 這組用例是源碼錨——寫端一旦退回 processImage（吐 data URL）、或讀端退回裸 <img src=...>，
// 都會在這裡掛掉。寫端和讀端必須同進同退：只改一邊就是「存了令牌但渲染不出來」或
// 「界面認令牌但庫裡還在攢 base64」。
const SOCIAL_APP = readFileSync(path.resolve(__dirname, '../apps/SocialApp.tsx'), 'utf8');

describe('Spark 主頁背景與頭像存 blobref 令牌', () => {
    it('寫端產出令牌，不再往 assets 行裡塞 data URL', () => {
        expect(SOCIAL_APP).toContain("import { processImageToBlob } from '../utils/file'");
        expect(SOCIAL_APP).toContain("import { putImageBlob } from '../utils/blobRef'");

        // 背景圖：blob → 令牌 → 存 assets 行
        expect(SOCIAL_APP).toContain("const blob = await processImageToBlob(file, { skipCompression: true })");
        expect(SOCIAL_APP).toContain("await DB.saveAsset('spark_user_bg', ref)");

        // 頭像：blob → 令牌 → 進 socialProfile（落庫在 saveUserProfileChanges）
        expect(SOCIAL_APP).toContain("const blob = await processImageToBlob(file)");
        expect(SOCIAL_APP).toContain('setSocialProfile(prev => ({ ...prev, avatar: ref }))');

        // 吐 data URL 的那個 processImage 不該再出現在這個文件裡
        expect(SOCIAL_APP).not.toMatch(/\bprocessImage\s*\(/);
    });

    it('讀端認令牌：背景圖走 TokenImg，沒有裸 <img src={userBgImage}>', () => {
        expect(SOCIAL_APP).toContain('<TokenImg value={userBgImage}');
        expect(SOCIAL_APP).not.toMatch(/<img\s+src=\{userBgImage\}/);
        // 頭像及其在帖子裡的副本本來就走 TokenImg，一併釘住
        expect(SOCIAL_APP).toContain('<TokenImg value={socialProfile.avatar}');
        expect(SOCIAL_APP).toContain('<TokenImg value={post.authorAvatar}');
    });

    it('spark_* 所在的 assets 表在孤兒 GC 的引用面清單裡（否則轉出的圖會被當垃圾刪）', () => {
        expect(REF_SOURCE_STORES).toContain('assets');
    });
});
