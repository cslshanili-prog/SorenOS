/**
 * 「只改顯示」正則跑完之後的正文切段：一般文字照閱讀視圖排，HTML 裝飾（文字標題、摘要卡片…）
 * 交給沙盒 iframe（components/date/DecorationFrame.tsx）。
 *
 * 認成 HTML 的有兩種：
 * - 程式碼區塊 ```html … ```（或內容是 HTML 的 ``` … ```），酒館圈的美化正則多半輸出這種
 * - 直接寫出來的區塊元素（<details>、<div>、<style>、<!DOCTYPE html>…），到對應的結束標籤為止
 * 相鄰的 HTML 段（中間只有空白）併成一段，同一張卡片的 <style> 和內容才在同一個 iframe 裡。
 *
 * 文字段裡剩下的標籤（預設要模型輸出的 <meow_FM> 這類自訂標籤、<br>）和 HTML 註解不顯示、
 * 標籤裡的文字留著，跟 ST 渲染時被淨化掉的效果一樣。
 */

export type DisplaySegment = { type: 'text'; text: string } | { type: 'html'; html: string };

const BLOCK_TAGS = ['details', 'div', 'section', 'article', 'aside', 'style', 'table', 'html', 'head', 'body', 'svg', 'figure', 'center', 'script', 'link', 'ul', 'ol', 'iframe', 'canvas'];
const BLOCK_OPEN_RE = new RegExp(`<(?:!doctype\\s+html|(${BLOCK_TAGS.join('|')}))(?=[\\s>/])`, 'i');
const FENCE_RE = /```[ \t]*([A-Za-z]*)[ \t]*\r?\n?([\s\S]*?)```/g;
const looksLikeHtml = (text: string) => /<\s*(?:!doctype|[a-z][\w-]*)(?:\s[^>]*)?>/i.test(text);

/** 從 start 起找這個區塊元素的結尾（同名標籤的巢狀要算進去）；找不到就到全文結尾 */
const findBlockEnd = (text: string, start: number, tag: string | undefined): number => {
    if (!tag || tag === 'html') {
        const close = text.toLowerCase().indexOf('</html>', start);
        return close === -1 ? text.length : close + '</html>'.length;
    }
    if (tag === 'link') {
        const end = text.indexOf('>', start);
        return end === -1 ? text.length : end + 1;
    }
    const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'gi');
    re.lastIndex = start;
    let depth = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m[1]) depth--;
        else if (!m[0].endsWith('/>')) depth++;
        if (depth === 0) return m.index + m[0].length;
    }
    return text.length;
};

const splitRawHtml = (text: string): DisplaySegment[] => {
    const out: DisplaySegment[] = [];
    let rest = text;
    while (rest) {
        const m = rest.match(BLOCK_OPEN_RE);
        if (!m || m.index === undefined) { out.push({ type: 'text', text: rest }); break; }
        if (m.index > 0) out.push({ type: 'text', text: rest.slice(0, m.index) });
        const end = findBlockEnd(rest, m.index, m[1]?.toLowerCase());
        out.push({ type: 'html', html: rest.slice(m.index, end) });
        rest = rest.slice(end);
    }
    return out;
};

const merge = (segments: DisplaySegment[]): DisplaySegment[] => {
    const out: DisplaySegment[] = [];
    for (const segment of segments) {
        const prev = out[out.length - 1];
        if (segment.type === 'text' && !segment.text.trim()) {
            if (prev?.type === 'text') prev.text += segment.text;
            else out.push({ ...segment });
            continue;
        }
        if (segment.type === 'html' && prev) {
            // 跟前一段 HTML 只隔著空白就併起來
            const before = out[out.length - 2];
            if (prev.type === 'html') { prev.html += `\n${segment.html}`; continue; }
            if (prev.type === 'text' && !prev.text.trim() && before?.type === 'html') {
                out.pop();
                before.html += `\n${segment.html}`;
                continue;
            }
        }
        out.push({ ...segment });
    }
    return out.filter(segment => (segment.type === 'html' ? segment.html.trim() : segment.text.trim()));
};

export const splitDisplaySegments = (text: string): DisplaySegment[] => {
    if (!text) return [];
    const segments: DisplaySegment[] = [];
    let last = 0;
    for (const m of text.matchAll(FENCE_RE)) {
        const index = m.index ?? 0;
        if (index > last) segments.push(...splitRawHtml(text.slice(last, index)));
        const lang = m[1].toLowerCase();
        const body = m[2];
        if (lang === 'html' || looksLikeHtml(body)) segments.push({ type: 'html', html: body });
        else segments.push({ type: 'text', text: body });
        last = index + m[0].length;
    }
    if (last < text.length) segments.push(...splitRawHtml(text.slice(last)));
    return merge(segments);
};

/** 文字段：拿掉 HTML 註解和標籤本身，標籤裡的字留著 */
export const cleanDisplayText = (text: string): string => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[A-Za-z_一-鿿][^<>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n');
