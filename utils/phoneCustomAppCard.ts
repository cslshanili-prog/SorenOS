import type { PhoneCustomApp, PhoneEvidence } from '../types';
import { phoneFieldToText } from './phoneEvidence';

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** 指令字段裡帶 {{xxx}} 佔位符 = 用戶粘的是固定 HTML 模板，走本地字符串替換（不經過 LLM，更穩定）。 */
export function hasTemplatePlaceholders(instruction: string): boolean {
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(instruction);
}

/** 模板裡出現過的佔位符名字，按首次出現順序去重。 */
export function extractPlaceholderNames(template: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const re = new RegExp(PLACEHOLDER_RE);
    let m: RegExpExecArray | null;
    while ((m = re.exec(template)) !== null) {
        if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
    }
    return names;
}

/** 用給定字段替換模板裡的 {{name}}；找不到的佔位符替換成空串，不留字面量。 */
export function substituteTemplate(template: string, fields: Record<string, string>): string {
    return template.replace(PLACEHOLDER_RE, (_full, name: string) => fields[name] ?? '');
}

const STANDARD_FIELDS = new Set(['title', 'detail', 'value']);

/**
 * 把 handleGenerate 解析出的單條 JSON item 渲染成這條記錄的卡片 HTML。
 * 模板模式：本地替換，LLM 只需按 buildCustomAppHtmlCardNote 裡的提示在 JSON 裡多給幾個自定義字段。
 * 自然語言模式：直接信任 LLM 在 item.html 裡給的那段 HTML。
 * 指令為空或兩種模式都沒產出內容時返回 undefined——調用方據此自動回退純文字展示。
 */
export function resolveCustomAppRecordHtml(
    app: Pick<PhoneCustomApp, 'htmlCardEnabled' | 'htmlCardPrompt'>,
    item: Record<string, unknown>,
    fields: { title: string; detail: string; value: string },
): string | undefined {
    const instruction = (app.htmlCardEnabled ? app.htmlCardPrompt : '')?.trim();
    if (!instruction) return undefined;
    if (hasTemplatePlaceholders(instruction)) {
        const values: Record<string, string> = { ...fields };
        for (const name of extractPlaceholderNames(instruction)) {
            if (STANDARD_FIELDS.has(name)) continue;
            values[name] = phoneFieldToText(item[name]);
        }
        const rendered = substituteTemplate(instruction, values).trim();
        return rendered || undefined;
    }
    return phoneFieldToText(item.html) || undefined;
}

/**
 * 渲染前拼一次：卡片 CSS 開著且非空時，作為 <style> 前置塞進 HTML 裡一起交給 HtmlCard（沙盒 iframe）。
 * iframe 本身就是隔離邊界，不需要額外的類名前綴/作用域處理——CSS 天然出不了這個 iframe。
 */
export function composeCustomAppCardHtml(app: Pick<PhoneCustomApp, 'htmlCardCssEnabled' | 'htmlCardCss'>, html: string): string {
    const css = app.htmlCardCssEnabled ? app.htmlCardCss?.trim() : '';
    return css ? `<style>${css}</style>${html}` : html;
}

/**
 * 教 LLM 怎麼配合這個 App 的 HTML 卡片設置生成內容。
 * 模板模式：只需要額外告訴它模板用到了哪些非標準佔位符，要在 JSON 裡補上對應字段。
 * 自然語言模式：直接要求它在每條記錄里加一個 "html" 字段。
 * 指令為空返回空串——不佔 prompt，也不會讓 LLM 意外生成用不上的字段。
 */
export function buildCustomAppHtmlCardNote(app: Pick<PhoneCustomApp, 'htmlCardEnabled' | 'htmlCardPrompt' | 'htmlCardCssEnabled' | 'htmlCardCss'>): string {
    const instruction = (app.htmlCardEnabled ? app.htmlCardPrompt : '')?.trim();
    if (!instruction) return '';
    if (hasTemplatePlaceholders(instruction)) {
        const extraNames = extractPlaceholderNames(instruction).filter(name => !STANDARD_FIELDS.has(name));
        if (extraNames.length === 0) return '';
        return `\n\n### 卡片模板佔位符\n這個 App 配置了固定 HTML 卡片模板，除了 title/detail/value，模板還用到了這些佔位符，請在每條 JSON 記錄裡額外補上對應字段（值必須是字符串）：${extraNames.join('、')}。`;
    }
    const hasCss = !!(app.htmlCardCssEnabled && app.htmlCardCss?.trim());
    return `\n\n### 卡片視覺（HTML）\n除了 title/detail/value，請給每條記錄額外生成一個 "html" 字段——一段用來渲染成卡片的 HTML（一個 <div> 區塊，內容要和 title/detail/value 一致，只是加上視覺呈現，不要另編新內容）。要求：\n- 整體寬度不超過 260px，在最外層用 style="width:260px" 限定；\n- 不要 <script> 標籤或 on* 事件屬性；不要引用外部圖片/字體鏈接；\n- 視覺風格指令：${instruction}${hasCss ? '\n- 這個 App 已經配置了獨立的 CSS（約定用 .phone-card、.phone-card-title 等類名），請讓 HTML 裡的元素帶上這些 class 把樣式交給 CSS 控制，不要在 HTML 裡塞大量內聯顏色/字號搶先決定樣式。' : ''}`;
}

/**
 * 防重複：把這個 App 最近生成過的記錄標題/摘要喂回去，讓下一輪刷新換主題而不是原地打轉
 * （比如上次刷出「沐浴露」，這次別還是沐浴露或同類商品）。沒有歷史記錄時返回空串。
 */
export function buildCustomAppAntiRepeatNote(pastRecords: PhoneEvidence[], limit = 8): string {
    if (pastRecords.length === 0) return '';
    const recent = [...pastRecords].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    const lines = recent
        .map(r => `- ${r.title}${r.detail ? ` · ${r.detail.replace(/\s+/g, ' ').slice(0, 40)}` : ''}`)
        .join('\n');
    return `\n\n### 避免重複主題\n這個 App 最近已經生成過下面這些記錄，這次刷新請換一批新主題，核心內容不要和它們重複：\n${lines}\n如果是同一件事有了新進展（比如訂單狀態變化），可以體現進展，但不要原地踏步、只是換個說法重複同一個主題。`;
}
