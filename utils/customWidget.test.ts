import { describe, expect, it } from 'vitest';
import {
    BLANK_IMAGE, buildPlaceholderValues, buildWidgetFile, buildWidgetSrcDoc, fillHtml, isReservedKey, parseSizeSpec,
    parseWidgetFile, sizeToSpec, type CustomWidgetTemplate,
} from './customWidget';
import { addCustomWidget, countCustomWidgetsOf, normalizeLayout, patchWidget, removeCustomWidgetsOf, type LauncherLayout } from './launcherLayout';

// 跟 Liora 給的範例同一個形狀：size 用名字、程式用 widget.getState、選項值後面帶零寬字元
const ZW = '⁠';
const SAMPLE = JSON.stringify({
    type: 'custom_widget_template',
    version: 2,
    name: '时间胶囊',
    size: 'medium',
    html: '<div id="w"><img src="{{img1}}"><span id="msg"></span></div><script>(async()=>{document.getElementById("msg").textContent=await widget.getState("text1")})()</script>',
    css: `/*${ZW}​*/ #w { color: red; }`,
    imageKeys: ['img1', 'img2'],
    userFields: [
        { key: 'bgStyle', label: '背景样式', type: 'select', options: [`frosted${ZW}`, `transparent${ZW}`] },
        { key: 'timeColor', label: '时间颜色', type: 'color' },
        { key: 'text1', label: '文案', type: 'text' },
    ],
});

const template = (over: Partial<CustomWidgetTemplate> = {}): CustomWidgetTemplate => ({
    id: 'cw_1', name: 't', html: '', css: '', w: 4, h: 2, imageKeys: [], images: {}, fields: [], createdAt: 0, updatedAt: 0, ...over,
});

describe('匯入小組件檔', () => {
    it('讀得懂範例格式，內容原樣保留（簡體、零寬字元都不動）', () => {
        const parsed = parseWidgetFile(SAMPLE);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const t = parsed.file.template;
        expect(t.name).toBe('时间胶囊');
        expect({ w: t.w, h: t.h }).toEqual({ w: 4, h: 2 });
        expect(t.imageKeys).toEqual(['img1', 'img2']);
        expect(t.fields.map(f => f.type)).toEqual(['select', 'color', 'text']);
        expect(t.fields[0].options).toEqual([`frosted${ZW}`, `transparent${ZW}`]);
        expect(t.css).toContain(`${ZW}​`);
        expect(parsed.file.notes).toEqual([]);
    });

    it('壞掉的檔案給中文原因', () => {
        expect(parseWidgetFile('not json')).toMatchObject({ ok: false });
        expect(parseWidgetFile(JSON.stringify({ type: 'appearance_preset', html: 'x' }))).toMatchObject({ ok: false });
        expect(parseWidgetFile(JSON.stringify({ type: 'custom_widget_template' }))).toMatchObject({ ok: false, error: '小組件檔裡沒有 HTML' });
    });

    it('欄位：重複或不能用的鍵略過、沒選項的 select 變一行字、認不得的尺寸用 4×2', () => {
        const parsed = parseWidgetFile(JSON.stringify({
            html: '<b></b>', size: 'huge',
            userFields: [{ key: 'a', type: 'select' }, { key: 'a', type: 'text' }, { key: 'b c', type: 'text' }, { key: 'n', type: 'weird' }],
            imageKeys: ['a', 'pic', 'pic'],
        }));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.file.template.fields.map(f => [f.key, f.type])).toEqual([['a', 'text'], ['n', 'text']]);
        expect(parsed.file.template.imageKeys).toEqual(['pic']);
        expect(parsed.file.template.w).toBe(4);
        expect(parsed.file.notes.length).toBeGreaterThan(0);
    });

    it('尺寸：名字和格數都認', () => {
        expect(parseSizeSpec('small')).toEqual({ w: 2, h: 2 });
        expect(parseSizeSpec('large')).toEqual({ w: 4, h: 4 });
        expect(parseSizeSpec('1x2')).toEqual({ w: 1, h: 2 });
        expect(parseSizeSpec('4×3')).toEqual({ w: 4, h: 3 });
        expect(parseSizeSpec('3x3')).toBeNull();
        expect(sizeToSpec({ w: 4, h: 2 })).toBe('medium');
        expect(sizeToSpec({ w: 1, h: 2 })).toBe('1x2');
    });

    it('匯出再匯入回來是同一個東西，帶著模板自己的圖', () => {
        const t = template({
            name: '我的', html: '<i>{{note}}</i>', css: 'i{}', w: 2, h: 1, imageKeys: ['bg'], images: { bg: 'blobref:abc' },
            fields: [{ key: 'note', label: '一句話', type: 'text', default: '嗨' }],
        });
        const file = buildWidgetFile(t, { bg: 'data:image/png;base64,AAAA' });
        expect(file).toMatchObject({ type: 'custom_widget_template', version: 2, size: '2x1', imageKeys: ['bg'] });
        const back = parseWidgetFile(JSON.stringify(file));
        expect(back.ok).toBe(true);
        if (!back.ok) return;
        expect(back.file.template).toMatchObject({ name: '我的', html: t.html, css: t.css, w: 2, h: 1, fields: t.fields });
        expect(back.file.imageData).toEqual({ bg: 'data:image/png;base64,AAAA' });
    });
});

describe('佔位符', () => {
    const now = new Date(2026, 10, 10, 9, 5);
    const input = {
        template: template({
            imageKeys: ['img1'],
            fields: [{ key: 'note', label: 'n', type: 'text' as const, default: '預設' }, { key: 'color', label: 'c', type: 'color' as const }],
        }),
        values: { color: '#ff0000' },
        imageUrls: { img1: 'data:image/png;base64,QQ==' },
        userName: '莉',
        char: { name: '煦', lastMessage: '<b>早</b>', unread: 3, mood: '😊 開心' },
        size: { w: 4, h: 2 },
        now,
    };

    it('欄位、圖片、角色、時間都有值；沒填的欄位用預設，沒選的圖給透明圖', () => {
        const values = buildPlaceholderValues(input);
        expect(values).toMatchObject({
            note: '預設', color: '#ff0000', img1: 'data:image/png;base64,QQ==', 'img:img1': 'data:image/png;base64,QQ==',
            time: '09:05', date: '2026/11/10', weekday: '星期二', user: '莉', char: '煦', 'char.unread': '3', 'char.mood': '😊 開心',
        });
        expect(buildPlaceholderValues({ ...input, imageUrls: {} }).img1).toBe(BLANK_IMAGE);
    });

    it('文字裡的時間會自己走、屬性和程式裡填死；角色訊息要跳脫', () => {
        const values = buildPlaceholderValues(input);
        const html = fillHtml('<p title="{{time}}">{{time}} {{char.lastMessage}} {{unknown}}</p><script>var s="{{char.lastMessage}}";</script><!-- {{time}} -->', values);
        expect(html).toContain('<p title="09:05">');
        expect(html).toContain('<span data-soren-live="time">09:05</span>');
        expect(html).toContain('&lt;b&gt;早&lt;/b&gt;');
        expect(html).toContain('{{unknown}}');
        expect(html).toContain('var s="\\x3cb>早\\x3c/b>";');
        expect(html).toContain('<!-- {{time}} -->');
    });

    it('srcdoc：沙盒裡有 widget.getState，CSS 放進 head，狀態裡的 </script> 擋掉', () => {
        const doc = buildWidgetSrcDoc({ ...input, template: { ...input.template, html: '<div>{{note}}</div>', css: '.x{color:{{color}}}' }, values: { color: '#ff0000', note: '</script><b>' } });
        expect(doc).toContain('window.widget=');
        expect(doc).toContain('getState:function(k)');
        expect(doc).toContain('.x{color:#ff0000}');
        expect(doc).not.toMatch(/"note":"<\/script>/);
        expect(doc).toContain('&lt;/script&gt;&lt;b&gt;');
        expect(doc.indexOf('window.widget=')).toBeLessThan(doc.indexOf('<div>'));
    });

    it('內建的鍵不能拿來當欄位', () => {
        expect(isReservedKey('time')).toBe(true);
        expect(isReservedKey('char.anything')).toBe(true);
        expect(isReservedKey('img:x')).toBe(true);
        expect(isReservedKey('text1')).toBe(false);
    });
});

describe('桌面上的自訂小組件', () => {
    const base: LauncherLayout = { version: 1, pages: [{ id: 'p1', items: [] }] };

    it('放上去、每一份各填各的、刪模板時一起拿掉', () => {
        const a = addCustomWidget(base, 0, 'cw_1', { w: 4, h: 2 });
        const b = addCustomWidget(a.layout, 0, 'cw_1', { w: 2, h: 2 });
        expect(countCustomWidgetsOf(b.layout, 'cw_1')).toBe(2);
        const filled = patchWidget(b.layout, a.item.id, { values: { text1: '嗨' }, charId: 'c1' });
        const items = filled.pages[0].items as any[];
        expect(items.find(i => i.id === a.item.id)).toMatchObject({ values: { text1: '嗨' }, charId: 'c1' });
        expect(items.find(i => i.id === b.item.id).values).toBeUndefined();
        expect(countCustomWidgetsOf(removeCustomWidgetsOf(filled, 'cw_1'), 'cw_1')).toBe(0);
    });

    it('normalize 留著自訂小組件，沒有模板 id 的丟掉', () => {
        const a = addCustomWidget(base, 0, 'cw_1', { w: 4, h: 2 });
        const broken = { ...a.layout, pages: [{ ...a.layout.pages[0], items: [...a.layout.pages[0].items, { id: 'x', kind: 'widget', widget: 'custom', x: 0, y: 4, w: 1, h: 1 } as any] }] };
        const normalized = normalizeLayout(broken, [])!;
        expect(normalized.pages[0].items.map(i => i.id)).toEqual([a.item.id]);
    });
});
