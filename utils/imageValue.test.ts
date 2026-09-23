import { describe, it, expect } from 'vitest';
import { isImageValue, putImageBlob, dataUrlToBlob } from './blobRef';

// 頭像、店員、貼紙這類字段是兩用的：可以是圖，也可以只填一個 emoji。界面上到處都有
// 「是圖就 <img>，不是圖就當文字畫出來」的分叉。判斷漏認一種圖片形態，那種圖就會被當成
// 文字直接印在界面上——不報錯也不破圖，只是明晃晃地顯示出一串內部標識。
// 這組用例釘住四種形態都算圖、純文字都不算。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('是圖還是文字', () => {
    it('blobref 令牌算圖（漏認這條，令牌會被當文字畫在界面上）', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        expect(isImageValue(token)).toBe(true);
    });

    it('內嵌 data URL、http(s) 外鏈、站內絕對路徑都算圖', () => {
        expect(isImageValue(TINY_PNG)).toBe(true);
        expect(isImageValue('https://example.com/a.png')).toBe(true);
        expect(isImageValue('http://example.com/a.png')).toBe(true);
        expect(isImageValue('/assets/room/wall.png')).toBe(true);
    });

    it('emoji 和普通文字不算圖', () => {
        expect(isImageValue('🐱')).toBe(false);
        expect(isImageValue('小明')).toBe(false);
        expect(isImageValue('A')).toBe(false);
    });

    it('空值一律不算圖', () => {
        expect(isImageValue('')).toBe(false);
        expect(isImageValue(undefined)).toBe(false);
        expect(isImageValue(null)).toBe(false);
        expect(isImageValue(123)).toBe(false);
    });

    it('長得像但不是的：不會把 database / httpd 這類詞當成圖', () => {
        // 老寫法是 startsWith('data') / startsWith('http')，不帶冒號和斜槓，這兩個會誤判
        expect(isImageValue('database')).toBe(false);
        expect(isImageValue('httpd 服務')).toBe(false);
    });
});
