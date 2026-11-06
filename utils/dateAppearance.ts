/**
 * 見面畫面美化：把角色的 dateAppearance 變成實際的樣式。說明見 docs/date-appearance.md。
 *
 * - 字級、字色產生一小段 CSS（掛在 .date-root 底下，蓋得過 Tailwind 的單 class，又讓用戶自訂 CSS 能再蓋回去）
 * - 底圖遮罩：沒設就是原本的樣子；設了底圖就清楚顯示，上面蓋一層照濃度的遮罩
 * - 自訂 CSS 先過 scopeDateCss，每條選擇器都限定在 .date-root 裡，寫錯也汙染不到見面以外的畫面
 */

import type { DateAppearance, DateLineColors } from '../types';

export const DATE_ROOT_CLASS = 'date-root';
const ROOT = `.${DATE_ROOT_CLASS}`;

export const DATE_FONT_SIZE = { min: 14, max: 24, default: 18 } as const;
/** 原本的遮罩：深色 80%、淺色 90% */
export const DATE_DEFAULT_DIM = { dark: 80, light: 90 } as const;
export const DATE_CUSTOM_CSS_MAX = 50_000;

/** 原生字色（台詞深、旁白淺一階），給設定頁當起點和「還原」用 */
export const DATE_NATIVE_COLORS: Record<'light' | 'dark', Required<DateLineColors>> = {
    light: { dialogue: '#292524', narration: '#78716c' },
    dark: { dialogue: '#f1f5f9', narration: '#94a3b8' },
};

/** 給用戶自訂 CSS 用的鉤子（設定頁和說明文件共用這份清單） */
export const DATE_CSS_HOOKS: { selector: string; label: string }[] = [
    { selector: '.date-root', label: '整個見面畫面（最外層）' },
    { selector: '.date-root.date-theme-light / .date-theme-dark', label: '目前是淺色／深色' },
    { selector: '.date-background', label: '底圖' },
    { selector: '.date-reading', label: '閱讀區（可捲動那塊，遮罩也在這）' },
    { selector: '.date-opening', label: '開場（還沒開始對話時那段）' },
    { selector: '.date-emotion-line', label: '左上角那行當下情緒' },
    { selector: '.date-message / .date-message-ai / .date-message-user', label: '一則訊息' },
    { selector: '.date-line', label: '角色正文的每一行' },
    { selector: '.date-line-dialogue / .date-line-narration', label: '台詞／旁白' },
    { selector: '.date-line-user', label: '你說的話' },
    { selector: '.date-line-name', label: '你那行後面的名字' },
    { selector: '.date-decoration-card', label: '裝飾卡片外框（裡面是獨立頁面，CSS 管不到）' },
    { selector: '.date-input-bar / .date-input', label: '輸入框外殼／輸入框' },
];

const clampInt = (value: unknown, min: number, max: number): number | undefined => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const safeColor = (value: unknown): string | undefined => (typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim() : undefined);

export const resolveDateFontSize = (appearance?: DateAppearance): number | undefined =>
    appearance?.fontSize === undefined ? undefined : clampInt(appearance.fontSize, DATE_FONT_SIZE.min, DATE_FONT_SIZE.max);

/** 這個主題下用戶改過的字色（沒改的不回） */
export const resolveDateColors = (appearance: DateAppearance | undefined, light: boolean): DateLineColors => {
    const set = appearance?.colors?.[light ? 'light' : 'dark'];
    return { dialogue: safeColor(set?.dialogue), narration: safeColor(set?.narration) };
};

export interface DateBackdrop {
    /** 底圖層 */
    backgroundOpacity: number;
    backgroundBlur: boolean;
    /** 閱讀區遮罩；undefined 表示照原本的 class 走 */
    overlayColor?: string;
}

export const resolveDateBackdrop = (appearance: DateAppearance | undefined, light: boolean): DateBackdrop => {
    const dim = appearance?.backgroundDim === undefined ? undefined : clampInt(appearance.backgroundDim, 0, 100);
    if (dim === undefined) return { backgroundOpacity: 0.3, backgroundBlur: true };
    const alpha = Math.round(dim) / 100;
    return {
        backgroundOpacity: 1,
        backgroundBlur: appearance?.backgroundBlur !== false,
        overlayColor: light ? `rgba(250, 248, 245, ${alpha})` : `rgba(0, 0, 0, ${alpha})`,
    };
};

/** 字級、字色產生的 CSS；什麼都沒改就是空字串 */
export const buildDateAppearanceCss = (appearance: DateAppearance | undefined, light: boolean): string => {
    const rules: string[] = [];
    const size = resolveDateFontSize(appearance);
    if (size) {
        rules.push(`${ROOT} .date-line{font-size:${size}px;}`);
        rules.push(`${ROOT} .date-line-user{font-size:${Math.max(DATE_FONT_SIZE.min - 2, size - 2)}px;}`);
    }
    const colors = resolveDateColors(appearance, light);
    if (colors.dialogue) rules.push(`${ROOT} .date-line-dialogue{color:${colors.dialogue};}`);
    if (colors.narration) rules.push(`${ROOT} .date-line-narration{color:${colors.narration};}`);
    return rules.join('\n');
};

// ---------- 自訂 CSS 限定範圍 ----------

/** 這些 at-rule 的大括號裡還是一般規則，要往裡面繼續限定 */
const NESTED_AT_RULES = /^@(?:media|supports|container|layer|document)\b/i;

const splitTopLevel = (text: string, separator: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === separator && depth === 0) {
            out.push(text.slice(start, i));
            start = i + 1;
        }
    }
    out.push(text.slice(start));
    return out;
};

const ROOT_LIKE = /^(?::root|html|body)(?=$|[\s>+~.:#[])(?:\s*>?\s*(?::root|html|body)(?=$|[\s>+~.:#[]))*/i;

const scopeSelector = (selector: string): string => {
    const s = selector.trim();
    if (!s || s.includes(ROOT)) return s;
    // :root / html / body（連寫的 html body 也算）都當成見面畫面本身
    const root = s.match(ROOT_LIKE);
    if (root) return `${ROOT}${s.slice(root[0].length)}`;
    return `${ROOT} ${s}`;
};

/** 找到從 open（指向 `{`）開始的對應 `}`，字串和註解裡的括號不算 */
const findBlockEnd = (css: string, open: number): number => {
    let depth = 0;
    let quote = '';
    for (let i = open; i < css.length; i++) {
        const ch = css[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return css.length;
};

const scopeBlock = (css: string): string => {
    let out = '';
    let i = 0;
    while (i < css.length) {
        // 找下一個 { 或 ;（at-rule 陳述式）
        let j = i;
        let quote = '';
        while (j < css.length) {
            const ch = css[j];
            if (quote) {
                if (ch === '\\') j++;
                else if (ch === quote) quote = '';
            } else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === '{' || ch === ';' || ch === '}') break;
            j++;
        }
        const prelude = css.slice(i, j);
        if (j >= css.length) { out += prelude; break; }
        if (css[j] === ';' || css[j] === '}') {
            // @import 之類的陳述式、或多出來的分號／右括號：原樣保留
            out += prelude + css[j];
            i = j + 1;
            continue;
        }
        const end = findBlockEnd(css, j);
        const body = css.slice(j + 1, end);
        const head = prelude.trim();
        if (head.startsWith('@')) {
            out += NESTED_AT_RULES.test(head) ? `${prelude}{${scopeBlock(body)}}` : `${prelude}{${body}}`;
        } else {
            const lead = prelude.match(/^\s*/)?.[0] ?? '';
            out += `${lead}${splitTopLevel(head, ',').map(scopeSelector).join(', ')}{${body}}`;
        }
        i = end + 1;
    }
    return out;
};

/** 用戶的自訂 CSS：拿掉註解、每條選擇器都限定在 .date-root 裡 */
export const scopeDateCss = (css: string | undefined): string => {
    if (!css || !css.trim()) return '';
    const withoutComments = css.slice(0, DATE_CUSTOM_CSS_MAX).replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
    return scopeBlock(withoutComments).trim();
};
