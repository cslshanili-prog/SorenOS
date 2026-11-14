/**
 * Sore 寫桌面自訂小組件（plans/ai-assistant.md 第 12 節，第 4 批）。純邏輯：列出、讀、把 Sore 給的內容算成提案。
 *
 * - 模板格式就是 utils/customWidget.ts 的 CustomWidgetTemplate（跟匯入檔同一套欄位與檢查）；在沙盒 iframe 裡跑，
 *   可以帶 script（Liora 定的），拿不到 Soren 的資料。
 * - Sore 沒辦法給圖：改既有模板時圖片鍵和圖照舊；新模板沒有圖，用戶之後在編輯頁自己加。
 * - 放上桌面：套用時留一張「請放這個模板」的字條（widgetPlacement.ts），桌面看到模板到了就用自己的找空位規則放。
 */
import type { AssistantWidgetProposal } from '../../types';
import {
    BUILTIN_PLACEHOLDERS, type CustomWidgetTemplate, isReservedKey, makeTemplateId, normalizeFields, parseSizeSpec,
} from '../customWidget';
import type { LauncherLayout } from '../launcherLayout';

export interface WidgetData {
    templates: CustomWidgetTemplate[];
    layout?: LauncherLayout;
}

const LIMITS = { html: 60_000, css: 40_000 };

/** 給 Sore 看的尺寸寫法跟它寫的一樣（4x2），不用 small／medium 那種 */
const sizeToSpec = (size: { w: number; h: number }) => `${size.w}x${size.h}`;

const placedCount = (id: string, layout?: LauncherLayout) =>
    (layout?.pages || []).reduce((n, page) => n + page.items.filter(i => i.kind === 'widget' && i.widget === 'custom' && i.templateId === id).length, 0);

export const hasScript = (html: string) => /<script\b/i.test(html);

export const describeWidgetList = (data: WidgetData): string => {
    if (!data.templates.length) return '還沒有自訂小組件。';
    return data.templates.map(t => {
        const n = placedCount(t.id, data.layout);
        return `- 「${t.name}」id=${t.id}｜${sizeToSpec(t)}｜欄位 ${t.fields.length}、圖片 ${t.imageKeys.length}${hasScript(t.html) ? '、有程式' : ''}｜${n ? `桌面上有 ${n} 份` : '沒放上桌面'}`;
    }).join('\n');
};

export const findWidget = (ref: unknown, data: WidgetData): CustomWidgetTemplate | { error: string } => {
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (!raw) return { error: '要指定是哪個小組件（填名字或 id）' };
    const byId = data.templates.find(t => t.id === raw);
    if (byId) return byId;
    const named = data.templates.filter(t => t.name.trim() === raw);
    if (named.length > 1) return { error: `有 ${named.length} 個叫「${raw}」，用 id：${named.map(t => t.id).join('、')}` };
    return named[0] || { error: `找不到「${raw}」這個小組件` };
};

export const describeWidget = (template: CustomWidgetTemplate): string => [
    `# 「${template.name}」id=${template.id}（${sizeToSpec(template)}${hasScript(template.html) ? '，有程式' : ''}）`,
    `欄位（用戶在桌面上填，HTML 裡寫 {{鍵}}）：${template.fields.map(f => `${f.key}（${f.label}，${f.type}${f.default ? `，預設「${f.default}」` : ''}）`).join('、') || '沒有'}`,
    `圖片鍵：${template.imageKeys.join('、') || '沒有'}`,
    `HTML：\n\`\`\`html\n${template.html}\n\`\`\``,
    `CSS：\n\`\`\`css\n${template.css}\n\`\`\``,
].join('\n\n');

/** 給 Sore 看的寫法說明（工具的 usage 用） */
export const WIDGET_GUIDE = `尺寸（寬×高格，桌面一頁 4×6）：1x1、1x2、2x1、2x2、4x1、4x2、4x3、4x4。
內建佔位符（HTML／CSS 裡寫 {{鍵}}）：${BUILTIN_PLACEHOLDERS.map(p => `{{${p.key}}}（${p.label}）`).join('、')}。
欄位 fields：[{"key":"note","label":"一句話","type":"text|textarea|color|select|number|date","default":"…","options":[…]}]，HTML 裡寫 {{note}}。
可以寫 <script>：widget.getState(鍵) 讀欄位（Promise）、widget.setState(鍵, 值) 存這一份的狀態（點了才會存）、widget.onReady(cb)、widget.size。在沙盒裡跑，拿不到 Soren 的資料。
背景透明，最外層自己畫底；字色預設跟桌面一樣（var(--soren-content-color)）。點一下會轉進去；data-open="chat" 這種屬性可以開 App。`;

export type WidgetDraft = Omit<AssistantWidgetProposal, 'id' | 'status'>;

/** 新建（widget 沒給或找不到且有 name）或改既有的；html／css 是整段取代 */
export const buildWidgetProposal = (args: Record<string, unknown>, data: WidgetData): { draft: WidgetDraft } | { error: string } => {
    const ref = typeof args.widget === 'string' ? args.widget.trim() : '';
    let base: CustomWidgetTemplate | undefined;
    if (ref) {
        const found = findWidget(ref, data);
        if ('error' in found) return found;
        base = found;
    }
    const html = typeof args.html === 'string' ? args.html : base?.html;
    if (!html?.trim()) return { error: '要有 html' };
    if (html.length > LIMITS.html) return { error: `HTML 太長了（上限 ${LIMITS.html.toLocaleString()} 字）` };
    const css = typeof args.css === 'string' ? args.css : base?.css ?? '';
    if (css.length > LIMITS.css) return { error: `CSS 太長了（上限 ${LIMITS.css.toLocaleString()} 字）` };
    let size = base ? { w: base.w, h: base.h } : { w: 4, h: 2 };
    if (args.size !== undefined) {
        const parsed = parseSizeSpec(args.size);
        if (!parsed) return { error: 'size 要是 1x1、1x2、2x1、2x2、4x1、4x2、4x3、4x4 其中一個' };
        size = parsed;
    }
    let fields = base?.fields ?? [];
    if (args.fields !== undefined) {
        const notes: string[] = [];
        fields = normalizeFields(args.fields, notes);
        const reserved = fields.find(f => isReservedKey(f.key));
        if (reserved) return { error: `欄位鍵「${reserved.key}」跟內建佔位符撞名，換一個` };
        if (notes.length) return { error: notes.join('；') };
    }
    const name = (typeof args.name === 'string' && args.name.trim()) || base?.name || '';
    if (!name) return { error: '新小組件要有 name' };
    const now = Date.now();
    const template: CustomWidgetTemplate = {
        id: base?.id ?? makeTemplateId(),
        name: name.slice(0, 60),
        html, css, ...size,
        imageKeys: base?.imageKeys ?? [],
        images: base?.images ?? {},
        fields,
        ...(base?.sizes ? { sizes: base.sizes } : {}),
        createdAt: base?.createdAt ?? now,
        updatedAt: now,
    };
    const changes: WidgetDraft['changes'] = [];
    if (!base) changes.push({ label: `新小組件「${template.name}」（${sizeToSpec(template)}，欄位 ${fields.length} 個${hasScript(html) ? '，有程式' : ''}）` });
    else {
        if (base.name !== template.name) changes.push({ label: `改名：「${base.name}」→「${template.name}」` });
        if (base.w !== template.w || base.h !== template.h) changes.push({ label: `預設尺寸：${sizeToSpec(base)} → ${sizeToSpec(template)}` });
        if (base.html !== html) changes.push({ label: `改了 HTML（${base.html.length} → ${html.length} 字）`, before: base.html, after: html });
        if (base.css !== css) changes.push({ label: `改了 CSS（${base.css.length} → ${css.length} 字）`, before: base.css, after: css });
        if (JSON.stringify(base.fields) !== JSON.stringify(fields)) changes.push({ label: `欄位：${base.fields.map(f => f.key).join('、') || '沒有'} → ${fields.map(f => f.key).join('、') || '沒有'}` });
        if (!changes.length) return { error: '跟現在的一模一樣，沒有改動' };
    }
    if (!base && hasScript(html)) changes.push({ label: '有程式（在沙盒裡跑，拿不到 Soren 的資料）' });
    const place = !base && args.place !== false;
    if (place) changes.push({ label: '套用後放上桌面（第一個放得下的空位）' });
    return {
        draft: {
            kind: 'widget', templateId: template.id, isNew: !base, template, place, hasScript: hasScript(html), changes,
            targetLabel: `桌面小組件 · ${template.name}${base ? '' : '（新的）'}`,
            summary: typeof args.summary === 'string' ? args.summary.trim().slice(0, 200) || undefined : undefined,
        },
    };
};
