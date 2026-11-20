/**
 * Sore 回覆的顯示：只認三樣——``` 程式碼塊（給複製鈕）、`行內程式碼`、**粗體**。
 * 其他照原樣（保留換行）。模型寫到一半被截斷、``` 沒收尾的，後面整段當程式碼塊。
 */
/** bold：在粗體裡（行內程式碼包在 ** 裡時，它也是粗的） */
export type SoreSpan = { type: 'plain' | 'bold' | 'code'; text: string; bold?: boolean };
export type SoreBlock = { type: 'text'; spans: SoreSpan[] } | { type: 'code'; lang: string; code: string };

/** 行內程式碼先換成這個佔位字，找粗體時才不會被裡面的星號、反引號打斷 */
const CODE_SLOT = '\uE000';

/** 一段文字 → 粗體、行內程式碼、一般字。粗體裡可以包行內程式碼（**漏了 `<giggle>` 的正則**） */
export const parseSoreSpans = (text: string): SoreSpan[] => {
    const codes: string[] = [];
    const flat = text.split(CODE_SLOT).join('').replace(/`([^`\n]+)`/g, (_, code: string) => { codes.push(code); return CODE_SLOT; });
    let used = 0;
    const out: SoreSpan[] = [];
    const push = (piece: string, bold: boolean) => {
        piece.split(CODE_SLOT).forEach((part, i) => {
            if (i > 0) out.push({ type: 'code', text: codes[used++], ...(bold ? { bold: true } : {}) });
            if (part) out.push({ type: bold ? 'bold' : 'plain', text: part });
        });
    };
    const re = /\*\*([^*\n][^\n]*?)\*\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat))) {
        if (m.index > last) push(flat.slice(last, m.index), false);
        push(m[1], true);
        last = m.index + m[0].length;
    }
    if (last < flat.length) push(flat.slice(last), false);
    return out;
};

export const parseSoreText = (text: string): SoreBlock[] => {
    const blocks: SoreBlock[] = [];
    const pushText = (raw: string) => {
        // 程式碼塊前後那個換行不要再多空一行
        const trimmed = raw.replace(/^\n+/, '').replace(/\n+$/, '');
        if (trimmed.trim()) blocks.push({ type: 'text', spans: parseSoreSpans(trimmed) });
    };
    const fence = /```([^\n`]*)\n?/g;
    let cursor = 0;
    let open: RegExpExecArray | null;
    while ((open = fence.exec(text))) {
        pushText(text.slice(cursor, open.index));
        const start = open.index + open[0].length;
        const end = text.indexOf('```', start);
        const code = (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\n+$/, '');
        if (code.trim()) blocks.push({ type: 'code', lang: open[1].trim().slice(0, 20), code });
        if (end === -1) { cursor = text.length; break; }
        cursor = end + 3;
        fence.lastIndex = cursor;
    }
    pushText(text.slice(cursor));
    return blocks;
};

/** 複製：先用剪貼簿 API，不給用（舊 WebView、非 https）就退回選取＋execCommand */
export const copyText = async (text: string): Promise<boolean> => {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* 往下退 */ }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
    } catch {
        return false;
    }
};
