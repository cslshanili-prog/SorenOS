/**
 * 桌面自訂小組件（plans/desktop-grid-widgets.md 第 2 批）。
 *
 * 模板存在 OSTheme.launcherCustomWidgets（跟著主題、外觀預設、完整備份走；圖片是 blobref 令牌）；
 * 放上桌面的每一份是 launcherLayout 裡一個 widget: 'custom' 的格子，記自己的欄位值、換過的圖、綁的角色。
 *
 * 畫面放進沙盒 iframe（sandbox="allow-scripts"，不給 allow-same-origin）：匯入的是別人寫的程式碼，
 * 拿不到 Soren 的資料、IndexedDB、API Key。iframe 本身不吃指標事件，桌面照常滑頁、長按整理；
 * 點一下由外層量好座標轉進去（見 buildWidgetSrcDoc 的尾段腳本）。
 *
 * 匯入格式相容 custom_widget_template v2（Liora 給的範例）：size small/medium/large、imageKeys、userFields，
 * 程式用 widget.getState(key) 讀欄位。匯入的內容原樣保留：不轉繁體、不清零寬字元。
 * 這裡全是純函式，不碰 React / DOM / IndexedDB。
 */

import type { WidgetSize } from './launcherLayout';
import { STORAGE_SHIM } from './sandboxShims';

export type CustomFieldType = 'text' | 'textarea' | 'color' | 'select' | 'number';

export interface CustomWidgetField {
    key: string;
    label: string;
    type: CustomFieldType;
    /** select 的選項 */
    options?: string[];
    /** 沒填時用的值 */
    default?: string;
}

export interface CustomWidgetTemplate {
    id: string;
    name: string;
    html: string;
    css: string;
    /** 預設尺寸（寬×高），放上桌面後每一份可以自己換 */
    w: number;
    h: number;
    /** 圖片素材的鍵（照順序），HTML/CSS 裡寫 {{鍵}} 或 {{img:鍵}} */
    imageKeys: string[];
    /** 模板自帶的圖（blobref 令牌）；放上桌面的每一份可以換成自己的 */
    images: Record<string, string>;
    fields: CustomWidgetField[];
    createdAt: number;
    updatedAt: number;
}

/** 自訂小組件能用的尺寸（寬×高） */
export const CUSTOM_WIDGET_SIZES: WidgetSize[] = [
    { w: 1, h: 1 }, { w: 1, h: 2 }, { w: 2, h: 1 }, { w: 2, h: 2 },
    { w: 4, h: 1 }, { w: 4, h: 2 }, { w: 4, h: 3 }, { w: 4, h: 4 },
];

export const isCustomWidgetSize = (size: WidgetSize) => CUSTOM_WIDGET_SIZES.some(s => s.w === size.w && s.h === size.h);

const NAMED_SIZES: Record<string, WidgetSize> = { small: { w: 2, h: 2 }, medium: { w: 4, h: 2 }, large: { w: 4, h: 4 } };

/** 匯入檔的 size：small／medium／large，或直接寫格數的 "4x2"、"4×2"、{ w, h } */
export const parseSizeSpec = (value: unknown): WidgetSize | null => {
    if (value && typeof value === 'object') {
        const w = Number((value as any).w), h = Number((value as any).h);
        const size = { w, h };
        return isCustomWidgetSize(size) ? size : null;
    }
    if (typeof value !== 'string') return null;
    const text = value.trim().toLowerCase();
    if (NAMED_SIZES[text]) return NAMED_SIZES[text];
    const match = text.match(/^(\d)\s*[x×*]\s*(\d)$/);
    if (!match) return null;
    const size = { w: Number(match[1]), h: Number(match[2]) };
    return isCustomWidgetSize(size) ? size : null;
};

/** 匯出時的 size：剛好是 small／medium／large 就寫名字（別的 app 也認得），其他寫 "寬x高" */
export const sizeToSpec = (size: WidgetSize): string => {
    const named = Object.entries(NAMED_SIZES).find(([, s]) => s.w === size.w && s.h === size.h);
    return named ? named[0] : `${size.w}x${size.h}`;
};

// ─── 鍵與佔位符 ──────────────────────────────────────────────────────────

/** 內建佔位符（欄位和圖片不能用這些鍵） */
export const BUILTIN_PLACEHOLDERS: Array<{ key: string; label: string }> = [
    { key: 'time', label: '現在幾點（10:24，會自己走）' },
    { key: 'date', label: '日期（2026/11/10）' },
    { key: 'weekday', label: '星期幾' },
    { key: 'user', label: '你的名字' },
    { key: 'char', label: '綁定角色的名字' },
    { key: 'char.avatar', label: '角色頭像（放在 img 的 src）' },
    { key: 'char.lastMessage', label: '跟角色的最後一則訊息' },
    { key: 'char.unread', label: '角色的未讀數' },
    { key: 'char.mood', label: '角色現在的情緒' },
];

const LIVE_KEYS = new Set(['time', 'date', 'weekday']);

export const isReservedKey = (key: string) =>
    BUILTIN_PLACEHOLDERS.some(p => p.key === key) || key === 'char.name' || key.startsWith('char.') || key.startsWith('img:');

/** 欄位／圖片的鍵：1～40 字、不含空白和大括號 */
export const isValidKey = (key: string) => key.length > 0 && key.length <= 40 && !/[\s{}]/.test(key);

const PLACEHOLDER_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export interface WidgetCharInfo {
    name: string;
    avatar?: string;
    lastMessage?: string;
    unread?: number;
    mood?: string;
}

export interface WidgetRenderInput {
    template: Pick<CustomWidgetTemplate, 'html' | 'css' | 'imageKeys' | 'fields'>;
    /** 這一份填的欄位值 */
    values?: Record<string, string>;
    /** 圖片鍵 → 已經能直接用的網址（data: 或 https:），沒有的就是空 */
    imageUrls: Record<string, string>;
    userName?: string;
    char?: WidgetCharInfo | null;
    size: WidgetSize;
    now?: Date;
    /** 桌面的字色，當作小組件的預設字色 */
    contentColor?: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 時間跟用戶自己的設備走（桌面上的鐘也是），不跟角色時區 */
export const liveValues = (now: Date) => ({
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    date: `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`,
    weekday: WEEKDAYS[now.getDay()],
});

/** 1×1 透明圖：圖片還沒選的時候放這個，不會出現破圖示 */
export const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 欄位值：這一份填的 → 模板預設 → 沒有 */
export const fieldValue = (field: CustomWidgetField, values?: Record<string, string>): string | null => {
    const own = values?.[field.key];
    if (own !== undefined && own !== '') return own;
    return field.default !== undefined && field.default !== '' ? field.default : null;
};

/** 所有佔位符的值（也是 widget.getState 讀得到的東西） */
export const buildPlaceholderValues = (input: WidgetRenderInput): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    for (const field of input.template.fields) out[field.key] = fieldValue(field, input.values);
    for (const key of input.template.imageKeys) {
        const url = input.imageUrls[key] || BLANK_IMAGE;
        out[key] = url;
        out[`img:${key}`] = url;
    }
    Object.assign(out, liveValues(input.now || new Date()));
    out.user = input.userName || '';
    const char = input.char;
    out.char = char?.name || '';
    out['char.name'] = char?.name || '';
    out['char.avatar'] = char?.avatar || BLANK_IMAGE;
    out['char.lastMessage'] = char?.lastMessage || '';
    out['char.unread'] = String(char?.unread || 0);
    out['char.mood'] = char?.mood || '';
    return out;
};

const escapeHtml = (text: string) => text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** 塞進 JS 字串裡：跳脫引號、換行、</script> */
const escapeJs = (text: string) => text
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/`/g, '\\`')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/</g, '\\x3c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
/** 塞進 CSS：只擋得住跳出 <style> 就好（顏色、網址照原樣） */
const escapeCss = (text: string) => text.replace(/</g, '\\3c ');

const fillWith = (text: string, values: Record<string, string | null>, escape: (s: string) => string, live?: boolean) =>
    text.replace(PLACEHOLDER_RE, (whole, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(values, key)) return whole; // 不認得的照原樣留著
        const value = escape(values[key] ?? '');
        return live && LIVE_KEYS.has(key) ? `<span data-soren-live="${key}">${value}</span>` : value;
    });

/**
 * 把佔位符填進 HTML。文字裡的 {{time}}、{{date}}、{{weekday}} 換成會自己走的 <span>；
 * 標籤屬性、<script>、<style> 裡的照當下的值填死（各自用對的跳脫方式）。
 */
export const fillHtml = (html: string, values: Record<string, string | null>): string => {
    const parts: string[] = [];
    const re = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<[^>]*>/gi;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
        if (match.index > last) parts.push(fillWith(html.slice(last, match.index), values, escapeHtml, true));
        const chunk = match[0];
        const block = chunk.match(/^(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)$/i);
        if (block) {
            const isScript = block[2].toLowerCase() === 'script';
            parts.push(fillWith(block[1], values, escapeHtml), fillWith(block[3], values, isScript ? escapeJs : escapeCss), block[4]);
        } else if (chunk.startsWith('<!--')) {
            parts.push(chunk);
        } else {
            parts.push(fillWith(chunk, values, escapeHtml));
        }
        last = match.index + chunk.length;
    }
    if (last < html.length) parts.push(fillWith(html.slice(last), values, escapeHtml, true));
    return parts.join('');
};

export const fillCss = (css: string, values: Record<string, string | null>) => fillWith(css, values, escapeCss);

/** JSON 放進 <script>：擋掉 </script> 和兩個會讓舊引擎斷行的字元 */
const jsonForScript = (value: unknown) => JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// iframe 裡最先跑的：提供 widget 物件（跟匯入格式一樣是 async 的 getState）
const bootScript = (state: Record<string, string | null>, size: WidgetSize) => `<script>(function(){var S=${jsonForScript(state)};function post(m){try{parent.postMessage(m,'*')}catch(e){}}window.widget={getState:function(k){return Promise.resolve(Object.prototype.hasOwnProperty.call(S,k)?S[k]:null)},getAll:function(){var o={};for(var k in S)o[k]=S[k];return Promise.resolve(o)},open:function(t){post({sorenWidget:'open',target:String(t||'')})},size:${jsonForScript(size)}}})();</script>`;

// 最後跑的：會走的時間、轉進來的點擊、data-open、擋連結跳轉、回報毛玻璃（iframe 裡的 backdrop-filter 模糊不到桌布，交給外層做）
const TAIL_SCRIPT = `<script>(function(){function post(m){try{parent.postMessage(m,'*')}catch(e){}}
var WD=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];function p(n){return(n<10?'0':'')+n}
function live(){var d=new Date(),v={time:p(d.getHours())+':'+p(d.getMinutes()),date:d.getFullYear()+'/'+p(d.getMonth()+1)+'/'+p(d.getDate()),weekday:WD[d.getDay()]};var els=document.querySelectorAll('[data-soren-live]');for(var i=0;i<els.length;i++){var k=els[i].getAttribute('data-soren-live');if(v[k]!=null&&els[i].textContent!==v[k])els[i].textContent=v[k]}}
live();setInterval(live,10000);
document.addEventListener('click',function(e){var t=e.target;var a=t&&t.closest&&t.closest('a[href]');if(a)e.preventDefault()},true);
window.addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||d.sorenWidget!=='tap')return;var el=document.elementFromPoint(d.x,d.y);if(!el)return;var o=el.closest&&el.closest('[data-open]');if(o)post({sorenWidget:'open',target:o.getAttribute('data-open')||''});try{el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:d.x,clientY:d.y,view:window}))}catch(_){}});
function root(){var b=document.body;if(!b)return null;for(var i=0;i<b.children.length;i++){var c=b.children[i];if(c.tagName!=='SCRIPT'&&c.tagName!=='STYLE')return c}return null}
var last='',queued=0,watched=null;function report(){queued=0;var el=root(),out=null;if(el){var cs=getComputedStyle(el),f=cs.backdropFilter||cs.webkitBackdropFilter||'';if(f&&f!=='none'){var r=el.getBoundingClientRect();if(r.width>=innerWidth*0.9&&r.height>=innerHeight*0.9)out={filter:f,radius:cs.borderRadius}}if(el!==watched&&window.MutationObserver){watched=el;new MutationObserver(soon).observe(el,{attributes:true})}}var s=JSON.stringify(out);if(s!==last){last=s;post({sorenWidget:'backdrop',value:out})}}
function soon(){if(!queued)queued=setTimeout(report,80)}
window.addEventListener('load',soon);setTimeout(report,30);setTimeout(report,400);setTimeout(report,1500)})();</script>`;

/** 組出 iframe 的 srcdoc */
export const buildWidgetSrcDoc = (input: WidgetRenderInput): string => {
    const values = buildPlaceholderValues(input);
    const color = /^[#\w(),.%\s-]+$/.test(input.contentColor || '') ? input.contentColor : '#ffffff';
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:${color};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-tap-highlight-color:transparent;}</style>`
        + STORAGE_SHIM + bootScript(values, input.size)
        + `<style>${fillCss(input.template.css || '', values).replace(/<\/style/gi, '<\\/style')}</style>`;
    const body = fillHtml(input.template.html || '', values);
    const trimmed = body.trim();
    if (/^<!doctype|^<html/i.test(trimmed)) {
        const withHead = /<head[^>]*>/i.test(trimmed)
            ? trimmed.replace(/<head[^>]*>/i, m => `${m}${head}`)
            : trimmed.replace(/<html[^>]*>/i, m => `${m}<head>${head}</head>`);
        return /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>/i, `${TAIL_SCRIPT}</body>`) : `${withHead}${TAIL_SCRIPT}`;
    }
    return `<!DOCTYPE html><html><head>${head}</head><body>${body}${TAIL_SCRIPT}</body></html>`;
};

// ─── 匯入匯出 ────────────────────────────────────────────────────────────

export const WIDGET_FILE_TYPE = 'custom_widget_template';
export const WIDGET_FILE_EXT = '.widget.json';

const LIMITS = { html: 300_000, css: 200_000, fields: 40, images: 20, options: 50, label: 60, value: 2_000 };
const FIELD_TYPES: CustomFieldType[] = ['text', 'textarea', 'color', 'select', 'number'];

export type ParsedWidgetFile = {
    template: Omit<CustomWidgetTemplate, 'id' | 'createdAt' | 'updatedAt' | 'images'>;
    /** 檔案裡帶的圖（data:image/…），由呼叫端存成 blob 再填進 template.images */
    imageData: Record<string, string>;
    /** 匯入時略過的東西，給用戶看 */
    notes: string[];
};

const asText = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

export const normalizeFields = (raw: unknown, notes?: string[]): CustomWidgetField[] => {
    const out: CustomWidgetField[] = [];
    const seen = new Set<string>();
    for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item !== 'object') continue;
        const key = typeof item.key === 'string' ? item.key : '';
        if (!isValidKey(key) || seen.has(key)) { if (key) notes?.push(`欄位「${key}」的鍵不能用或重複，略過了`); continue; }
        if (out.length >= LIMITS.fields) { notes?.push(`欄位超過 ${LIMITS.fields} 個，後面的略過了`); break; }
        seen.add(key);
        let type: CustomFieldType = FIELD_TYPES.includes(item.type) ? item.type : 'text';
        const options = Array.isArray(item.options)
            ? item.options.filter((o: unknown): o is string => typeof o === 'string').slice(0, LIMITS.options)
            : [];
        if (type === 'select' && !options.length) type = 'text';
        const field: CustomWidgetField = { key, label: asText(item.label, LIMITS.label) || key, type };
        if (type === 'select') field.options = options;
        const def = item.default ?? item.defaultValue;
        if (typeof def === 'string' || typeof def === 'number') field.default = String(def).slice(0, LIMITS.value);
        out.push(field);
    }
    return out;
};

export const normalizeImageKeys = (raw: unknown, fieldKeys: string[] = []): string[] => {
    const out: string[] = [];
    for (const key of Array.isArray(raw) ? raw : []) {
        if (typeof key !== 'string' || !isValidKey(key) || out.includes(key) || fieldKeys.includes(key)) continue;
        out.push(key);
        if (out.length >= LIMITS.images) break;
    }
    return out;
};

/** 讀一份小組件檔；壞掉的回 error（中文，直接給用戶看） */
export const parseWidgetFile = (text: string): { ok: true; file: ParsedWidgetFile } | { ok: false; error: string } => {
    let data: any;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { ok: false, error: '這不是小組件檔（讀不出 JSON）' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '這不是小組件檔' };
    if (data.type && data.type !== WIDGET_FILE_TYPE) return { ok: false, error: `這份檔案的類型是「${String(data.type).slice(0, 40)}」，不是小組件` };
    if (typeof data.html !== 'string' || !data.html.trim()) return { ok: false, error: '小組件檔裡沒有 HTML' };
    if (data.html.length > LIMITS.html) return { ok: false, error: 'HTML 太長了（超過 30 萬字）' };
    if (typeof data.css === 'string' && data.css.length > LIMITS.css) return { ok: false, error: 'CSS 太長了（超過 20 萬字）' };
    const notes: string[] = [];
    const fields = normalizeFields(data.userFields ?? data.fields, notes);
    const imageKeys = normalizeImageKeys(data.imageKeys, fields.map(f => f.key));
    const imageData: Record<string, string> = {};
    if (data.images && typeof data.images === 'object') {
        for (const key of imageKeys) {
            const value = data.images[key];
            if (typeof value === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value)) imageData[key] = value;
        }
    }
    const size = parseSizeSpec(data.size);
    if (data.size !== undefined && !size) notes.push(`尺寸「${String(data.size).slice(0, 20)}」認不得，先用 4×2`);
    return {
        ok: true,
        file: {
            template: {
                name: asText(data.name, LIMITS.label).trim() || '自訂小組件',
                html: data.html,
                css: typeof data.css === 'string' ? data.css : '',
                ...(size || { w: 4, h: 2 }),
                imageKeys,
                fields,
            },
            imageData,
            notes,
        },
    };
};

/** 匯出成小組件檔。imageData 是模板自帶的圖（data URL）；放上桌面那幾份自己換的圖不帶 */
export const buildWidgetFile = (template: CustomWidgetTemplate, imageData: Record<string, string> = {}) => {
    const images = Object.fromEntries(template.imageKeys.filter(k => imageData[k]).map(k => [k, imageData[k]]));
    return {
        type: WIDGET_FILE_TYPE,
        version: 2,
        name: template.name,
        size: sizeToSpec(template),
        html: template.html,
        css: template.css,
        imageKeys: template.imageKeys,
        userFields: template.fields.map(f => ({
            key: f.key, label: f.label, type: f.type,
            ...(f.options ? { options: f.options } : {}),
            ...(f.default !== undefined ? { default: f.default } : {}),
        })),
        ...(Object.keys(images).length ? { images } : {}),
    };
};

export const makeTemplateId = () => `cw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** 新建時給的起手式 */
export const starterTemplate = (): Omit<CustomWidgetTemplate, 'id' | 'createdAt' | 'updatedAt'> => ({
    name: '我的小組件',
    w: 4,
    h: 2,
    imageKeys: [],
    images: {},
    fields: [{ key: 'note', label: '一句話', type: 'text', default: '今天也要好好的' }],
    html: '<div class="card">\n  <div class="time">{{time}}</div>\n  <div class="sub">{{weekday}} · {{date}}</div>\n  <div class="note">{{note}}</div>\n</div>',
    css: '.card {\n  height: 100%;\n  box-sizing: border-box;\n  padding: 14px 18px;\n  border-radius: 22px;\n  background: rgba(255, 255, 255, 0.25);\n  backdrop-filter: blur(16px);\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n}\n.time { font-size: 34px; font-weight: 800; line-height: 1; }\n.sub { margin-top: 6px; font-size: 11px; opacity: 0.7; }\n.note { margin-top: 8px; font-size: 12px; }',
});
