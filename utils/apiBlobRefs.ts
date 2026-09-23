// 令牌不出門：發往模型的請求體裡不該出現 `blobref:<id>`。
//
// 圖片改存 Blob 之後，字段裡躺的是一個只有本機認得的短令牌（見 utils/blobRef.ts）。
// 渲染那頭有 useBlobRefUrl 兜著，漏改一處頂多是「這裡不顯示圖」，看得見也改得回來；
// 送模型這頭沒有對應的東西——令牌原樣發出去，對面只會看到一串它讀不懂的字符，
// 然後一本正經地說「我沒看到圖片」。沒有報錯、沒有破圖，從外面完全看不出哪裡壞了。
//
// 所以在網絡出口統一處理：請求體裡凡是令牌，一律在發出去之前換掉。這樣各處構造
// 請求的代碼（聊天、群聊、相冊看圖、活動、通用識圖）不用各記一遍這件事，將來新加的
// 出口也自動被覆蓋。
//
// 換成什麼，取決於令牌出現在哪：
//
//   · 整個字段值就是一個令牌（`"url": "blobref:xxx"`）——這是「這裡要放一張圖」，
//     換成 data URL，對面就能看到圖。
//   · 令牌嵌在一段文本中間（`"[用戶引用了「blobref:xxx」]"`）——這是構造 prompt 時
//     把一條圖片消息的原始值當文字拼進去了。這種位置對面根本不會當圖片解析，把它
//     撐成幾 MB 的 base64 只是白白多花一次錢，而且這段文本在上下文裡待多久就每輪
//     重發多久。換成佔位符，對面讀到的語義也更準。
//
// 這條分界同時是一道保險：prompt 那邊將來再漏一處沒做媒體判斷，代價也只是模型看到
// 一個「[圖片]」，不會變成帳單上的一筆。
//
// 三條實現邊界：
//   · 只認字符串 body（模型請求都是 JSON 文本）。FormData / stream 原樣放行。
//   · 先 indexOf 探一下有沒有令牌，沒有就一個字節都不動——絕大多數請求走這條路。
//   · 替換後的 data URL 只含 base64 字母表和 `:;,/=+`，在 JSON 字符串裡無需轉義，
//     所以直接做文本替換是安全的，不必把整個請求體 parse 一遍再 stringify
//     （聊天歷史動輒幾 MB，來回一趟純屬浪費）。反過來 data URL 裡也拼不出 `blobref:`，
//     base64 正文中不會出現冒號，替換結果不會被二次命中。
//
// 圖已經丟了的令牌換成空串，跟 resolveBlobRefsDeep 的既有語義一致：寧可發一個空 url
// 讓對面明確報錯，也不要把內部令牌洩漏給第三方。

import { BLOBREF_PREFIX } from './blobRef';

/** 令牌嵌在文本里時的替身。跟 prompt 各處對媒體值的措辭保持一致。 */
const INLINE_TOKEN_PLACEHOLDER = '[圖片]';

/** 令牌的字面形態：前綴 + SDK 的 id 字符集。與 utils/blobDedupe.ts 的同名常量同源。 */
const TOKEN_BODY = `${BLOBREF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9_]+`;

/**
 * 帶引號的整串令牌優先匹配（JSON 裡「這個字段的值就是一張圖」），
 * 匹配不上才退到裸令牌（嵌在某段文本中間）。交替分支的順序決定了這個優先級，別調換。
 */
const TOKEN_PATTERN = new RegExp(`"${TOKEN_BODY}"|${TOKEN_BODY}`, 'g');

/** 去掉整串匹配兩側的引號，拿到令牌本身。 */
const unquote = (m: string) => m.slice(1, -1);

/**
 * 把請求體裡的 blobref 令牌換掉：整串是令牌的換成 data URL，嵌在文本里的換成佔位符。
 * 非字符串 body / 不含令牌的 body 原樣返回（同一個引用，調用方可以直接判等）。
 */
export async function resolveBlobRefsInRequestBody<T extends BodyInit | null | undefined>(
    body: T,
): Promise<T | string> {
    if (typeof body !== 'string') return body;
    if (!body.includes(BLOBREF_PREFIX)) return body;

    const matches = body.match(TOKEN_PATTERN) ?? [];
    if (matches.length === 0) return body;

    // 只有「整串是令牌」的才值得去讀二進制；嵌在文本里的直接換佔位符，一次庫都不用查。
    const wholeValueTokens = new Set(matches.filter(m => m.startsWith('"')).map(unquote));

    const resolved = new Map<string, string>();
    if (wholeValueTokens.size > 0) {
        const { resolveRefToDataUrl } = await import('./blobRef');
        for (const token of wholeValueTokens) {
            try {
                resolved.set(token, await resolveRefToDataUrl(token));
            } catch {
                resolved.set(token, ''); // 讀不出來就當圖丟了，別把令牌發出去
            }
        }
    }

    return body.replace(TOKEN_PATTERN, m =>
        m.startsWith('"')
            ? `"${resolved.get(unquote(m)) ?? ''}"`
            : INLINE_TOKEN_PLACEHOLDER,
    );
}
