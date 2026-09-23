import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { resolveBlobRefsInRequestBody } from './apiBlobRefs';
import { putImageBlob, dataUrlToBlob, BLOBREF_PREFIX } from './blobRef';
import { safeFetchJson } from './safeApi';

// 令牌是本機存儲的內部形態，發給模型對面讀不懂——只會得到「我沒看到圖片」這種
// 不報錯也不破圖的靜默失敗。這組用例釘住網絡出口一定會把它還原成 data URL。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_JPEG = 'data:image/jpeg;base64,AQIDBAUG';

describe('令牌不出門：請求體裡的 blobref 還原成 data URL', () => {
    it('image_url 裡的令牌換成可用的 data URL，JSON 結構完好', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const body = JSON.stringify({
            model: 'x',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: '看看這張圖' },
                    { type: 'image_url', image_url: { url: token } },
                ],
            }],
        });

        const out = await resolveBlobRefsInRequestBody(body);

        expect(out).not.toContain(BLOBREF_PREFIX);
        const parsed = JSON.parse(out as string);   // 替換後仍是合法 JSON
        const url = parsed.messages[0].content[1].image_url.url;
        expect(url.startsWith('data:image/')).toBe(true);
        expect(parsed.messages[0].content[0].text).toBe('看看這張圖');
    });

    it('多個不同令牌各換各的，不會串圖', async () => {
        const a = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const b = await putImageBlob(dataUrlToBlob(TINY_JPEG));
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ a, b })) as string;

        const parsed = JSON.parse(out);
        expect(parsed.a).toContain('image/png');
        expect(parsed.b).toContain('image/jpeg');
        expect(parsed.a).not.toBe(parsed.b);
    });

    it('圖已經丟了的令牌換成空串——寧可發空 url 也不把令牌洩漏出去', async () => {
        const dead = `${BLOBREF_PREFIX}b_deadbeef_1_zzzzzz`;
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ url: dead })) as string;

        expect(out).not.toContain(BLOBREF_PREFIX);
        expect(JSON.parse(out).url).toBe('');
    });

    it('不含令牌的請求體一個字節都不動（原樣返回同一引用）', async () => {
        const body = JSON.stringify({ messages: [{ role: 'user', content: '普通文字' }] });
        expect(await resolveBlobRefsInRequestBody(body)).toBe(body);
    });

    it('非字符串 body 原樣放行', async () => {
        const fd = new FormData();
        expect(await resolveBlobRefsInRequestBody(fd)).toBe(fd);
        expect(await resolveBlobRefsInRequestBody(undefined)).toBeUndefined();
        expect(await resolveBlobRefsInRequestBody(null)).toBeNull();
    });

    it('整串是令牌的字段值，還原後旁邊的 JSON 結構完好', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const out = await resolveBlobRefsInRequestBody(
            JSON.stringify({ before: '前面', url: token, after: '後面' }),
        ) as string;

        const parsed = JSON.parse(out);
        expect(parsed.url.startsWith('data:image/')).toBe(true);
        expect(parsed.before).toBe('前面');
        expect(parsed.after).toBe('後面');
    });
});

// 令牌只在「整個字段值就是它」時才代表一張圖。嵌在一段文本中間的令牌是構造 prompt 時
// 把圖片消息的原始值當文字拼進去了——對面不會把它當圖片解析，還原成 base64 只是白花錢，
// 而且這段文本在上下文裡待多久就每輪重發多久。這組用例釘住那條分界。
describe('嵌在文本里的令牌換成佔位符，不撐成 base64', () => {
    it('文本中間的令牌不還原，也不洩漏令牌本身', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const out = await resolveBlobRefsInRequestBody(
            JSON.stringify({ text: `[用戶引用了「${token}」，並回復了 ↓]` }),
        ) as string;

        expect(out).not.toContain('data:image/');   // 沒被撐開
        expect(out).not.toContain(BLOBREF_PREFIX);  // 也沒原樣漏出去
        expect(JSON.parse(out).text).toBe('[用戶引用了「[圖片]」，並回復了 ↓]');
    });

    it('同一個請求體裡，圖片字段照常還原、文本里的同一個令牌只換佔位符', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({
            messages: [
                { role: 'user', content: `我剛發的 ${token} 你看到了嗎` },
                { role: 'user', content: [{ type: 'image_url', image_url: { url: token } }] },
            ],
        })) as string;

        const parsed = JSON.parse(out);
        expect(parsed.messages[0].content).toBe('我剛發的 [圖片] 你看到了嗎');
        expect(parsed.messages[1].content[0].image_url.url.startsWith('data:image/')).toBe(true);
    });

    it('一段文本里塞了很多個令牌，也不會一個個撐成 base64', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const text = Array.from({ length: 20 }, () => token).join(' / ');
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ text })) as string;

        // 舊實現在這裡會產出 20 份 base64；現在整個請求體應該比原文還短
        expect(out.length).toBeLessThan(JSON.stringify({ text }).length);
        expect(out).not.toContain('data:image/');
    });

    it('圖已經丟了的令牌嵌在文本里，同樣只換佔位符（不會去查庫）', async () => {
        const dead = `${BLOBREF_PREFIX}b_deadbeef_1_zzzzzz`;
        const out = await resolveBlobRefsInRequestBody(
            JSON.stringify({ text: `前面 ${dead} 後面` }),
        ) as string;

        expect(JSON.parse(out).text).toBe('前面 [圖片] 後面');
    });
});

describe('接線守衛：safeFetchJson 真的發不出令牌', () => {
    let sent: string | null = null;

    beforeEach(() => {
        sent = null;
        vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
            sent = typeof init?.body === 'string' ? init.body : null;
            return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }));
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('帶令牌的聊天請求，發到網絡上的 body 裡已經是 data URL', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await safeFetchJson('https://example.com/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ messages: [{ content: [{ type: 'image_url', image_url: { url: token } }] }] }),
        });

        expect(sent).not.toBeNull();
        expect(sent).not.toContain(BLOBREF_PREFIX);
        expect(sent).toContain('data:image/png;base64,');
    });
});
