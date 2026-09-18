import type { PhoneCustomApp, PhoneEvidence } from '../types';
import { phoneFieldToText } from './phoneEvidence';

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** 指令字段里带 {{xxx}} 占位符 = 用户粘的是固定 HTML 模板，走本地字符串替换（不经过 LLM，更稳定）。 */
export function hasTemplatePlaceholders(instruction: string): boolean {
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(instruction);
}

/** 模板里出现过的占位符名字，按首次出现顺序去重。 */
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

/** 用给定字段替换模板里的 {{name}}；找不到的占位符替换成空串，不留字面量。 */
export function substituteTemplate(template: string, fields: Record<string, string>): string {
    return template.replace(PLACEHOLDER_RE, (_full, name: string) => fields[name] ?? '');
}

const STANDARD_FIELDS = new Set(['title', 'detail', 'value']);

/**
 * 把 handleGenerate 解析出的单条 JSON item 渲染成这条记录的卡片 HTML。
 * 模板模式：本地替换，LLM 只需按 buildCustomAppHtmlCardNote 里的提示在 JSON 里多给几个自定义字段。
 * 自然语言模式：直接信任 LLM 在 item.html 里给的那段 HTML。
 * 指令为空或两种模式都没产出内容时返回 undefined——调用方据此自动回退纯文字展示。
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
 * 渲染前拼一次：卡片 CSS 开着且非空时，作为 <style> 前置塞进 HTML 里一起交给 HtmlCard（沙盒 iframe）。
 * iframe 本身就是隔离边界，不需要额外的类名前缀/作用域处理——CSS 天然出不了这个 iframe。
 */
export function composeCustomAppCardHtml(app: Pick<PhoneCustomApp, 'htmlCardCssEnabled' | 'htmlCardCss'>, html: string): string {
    const css = app.htmlCardCssEnabled ? app.htmlCardCss?.trim() : '';
    return css ? `<style>${css}</style>${html}` : html;
}

/**
 * 教 LLM 怎么配合这个 App 的 HTML 卡片设置生成内容。
 * 模板模式：只需要额外告诉它模板用到了哪些非标准占位符，要在 JSON 里补上对应字段。
 * 自然语言模式：直接要求它在每条记录里加一个 "html" 字段。
 * 指令为空返回空串——不占 prompt，也不会让 LLM 意外生成用不上的字段。
 */
export function buildCustomAppHtmlCardNote(app: Pick<PhoneCustomApp, 'htmlCardEnabled' | 'htmlCardPrompt' | 'htmlCardCssEnabled' | 'htmlCardCss'>): string {
    const instruction = (app.htmlCardEnabled ? app.htmlCardPrompt : '')?.trim();
    if (!instruction) return '';
    if (hasTemplatePlaceholders(instruction)) {
        const extraNames = extractPlaceholderNames(instruction).filter(name => !STANDARD_FIELDS.has(name));
        if (extraNames.length === 0) return '';
        return `\n\n### 卡片模板占位符\n这个 App 配置了固定 HTML 卡片模板，除了 title/detail/value，模板还用到了这些占位符，请在每条 JSON 记录里额外补上对应字段（值必须是字符串）：${extraNames.join('、')}。`;
    }
    const hasCss = !!(app.htmlCardCssEnabled && app.htmlCardCss?.trim());
    return `\n\n### 卡片视觉（HTML）\n除了 title/detail/value，请给每条记录额外生成一个 "html" 字段——一段用来渲染成卡片的 HTML（一个 <div> 区块，内容要和 title/detail/value 一致，只是加上视觉呈现，不要另编新内容）。要求：\n- 整体宽度不超过 260px，在最外层用 style="width:260px" 限定；\n- 不要 <script> 标签或 on* 事件属性；不要引用外部图片/字体链接；\n- 视觉风格指令：${instruction}${hasCss ? '\n- 这个 App 已经配置了独立的 CSS（约定用 .phone-card、.phone-card-title 等类名），请让 HTML 里的元素带上这些 class 把样式交给 CSS 控制，不要在 HTML 里塞大量内联颜色/字号抢先决定样式。' : ''}`;
}

/**
 * 防重复：把这个 App 最近生成过的记录标题/摘要喂回去，让下一轮刷新换主题而不是原地打转
 * （比如上次刷出「沐浴露」，这次别还是沐浴露或同类商品）。没有历史记录时返回空串。
 */
export function buildCustomAppAntiRepeatNote(pastRecords: PhoneEvidence[], limit = 8): string {
    if (pastRecords.length === 0) return '';
    const recent = [...pastRecords].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    const lines = recent
        .map(r => `- ${r.title}${r.detail ? ` · ${r.detail.replace(/\s+/g, ' ').slice(0, 40)}` : ''}`)
        .join('\n');
    return `\n\n### 避免重复主题\n这个 App 最近已经生成过下面这些记录，这次刷新请换一批新主题，核心内容不要和它们重复：\n${lines}\n如果是同一件事有了新进展（比如订单状态变化），可以体现进展，但不要原地踏步、只是换个说法重复同一个主题。`;
}
