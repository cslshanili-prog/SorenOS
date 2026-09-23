import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 520 活動的合照（canvas 生成的 1200×780 PNG，聊天卡片裡最大的一張圖）要改存
// `blobref:<id>` 令牌（見 utils/blobRef.ts）。令牌塞進裸 <img src> 就是一張裂圖，
// 所以氣泡裡的小圖和展開態的大圖都必須走認令牌的 TokenImg。
const source = readFileSync(path.resolve(__dirname, '../components/chat/MessageItem.tsx'), 'utf8');

describe('520 合照的 blobref 渲染路徑', () => {
    it('兩處合照都走 TokenImg', () => {
        const hits = source.match(/<TokenImg value=\{data\.photoDataUrl\}/g) || [];
        // 氣泡裡的小圖 + 點開的大圖
        expect(hits).toHaveLength(2);
    });

    it('文件裡不再有任何裸 <img> 直接吃 photoDataUrl', () => {
        expect(source).not.toMatch(/<img[^>]*photoDataUrl/);
        expect(source).not.toContain('src={data.photoDataUrl}');
    });

    it('photoDataUrl 也沒有被拼進 CSS url()', () => {
        expect(source).not.toMatch(/url\(\$\{[^}]*photoDataUrl/);
    });
});
