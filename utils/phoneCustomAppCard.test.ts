import { describe, it, expect } from 'vitest';
import {
    hasTemplatePlaceholders,
    extractPlaceholderNames,
    substituteTemplate,
    resolveCustomAppRecordHtml,
    composeCustomAppCardHtml,
    buildCustomAppHtmlCardNote,
    buildCustomAppAntiRepeatNote,
} from './phoneCustomAppCard';
import type { PhoneEvidence } from '../types';

describe('占位符检测与提取', () => {
    it('带 {{xxx}} 判定为模板', () => {
        expect(hasTemplatePlaceholders('<div>{{title}}</div>')).toBe(true);
        expect(hasTemplatePlaceholders('生成一个渐变背景的卡片')).toBe(false);
    });

    it('按首次出现顺序去重提取占位符名字', () => {
        expect(extractPlaceholderNames('{{title}} - {{mood}} - {{title}} - {{value}}')).toEqual(['title', 'mood', 'value']);
    });
});

describe('substituteTemplate', () => {
    it('替换已知字段，未知字段替换成空串', () => {
        const out = substituteTemplate('<b>{{title}}</b><i>{{mood}}</i><u>{{missing}}</u>', { title: '标题', mood: '开心' });
        expect(out).toBe('<b>标题</b><i>开心</i><u></u>');
    });
});

describe('resolveCustomAppRecordHtml', () => {
    const fields = { title: '标题A', detail: '详情A', value: '¥10' };

    it('未开启或指令为空时返回 undefined（自动回退纯文字）', () => {
        expect(resolveCustomAppRecordHtml({ htmlCardEnabled: false, htmlCardPrompt: '<div>{{title}}</div>' }, {}, fields)).toBeUndefined();
        expect(resolveCustomAppRecordHtml({ htmlCardEnabled: true, htmlCardPrompt: '  ' }, {}, fields)).toBeUndefined();
    });

    it('模板模式：本地替换标准字段 + 自定义占位符（从 item 里取）', () => {
        const app = { htmlCardEnabled: true, htmlCardPrompt: '<div>{{title}}-{{detail}}-{{value}}-{{mood}}</div>' };
        const html = resolveCustomAppRecordHtml(app, { mood: '兴奋' }, fields);
        expect(html).toBe('<div>标题A-详情A-¥10-兴奋</div>');
    });

    it('自然语言模式：直接信任 item.html，空则 undefined', () => {
        const app = { htmlCardEnabled: true, htmlCardPrompt: '渐变背景卡片' };
        expect(resolveCustomAppRecordHtml(app, { html: '<div>卡片内容</div>' }, fields)).toBe('<div>卡片内容</div>');
        expect(resolveCustomAppRecordHtml(app, {}, fields)).toBeUndefined();
    });
});

describe('composeCustomAppCardHtml', () => {
    it('CSS 关闭或为空时原样返回 html', () => {
        expect(composeCustomAppCardHtml({ htmlCardCssEnabled: false, htmlCardCss: '.x{color:red}' }, '<div>卡片</div>')).toBe('<div>卡片</div>');
        expect(composeCustomAppCardHtml({ htmlCardCssEnabled: true, htmlCardCss: '  ' }, '<div>卡片</div>')).toBe('<div>卡片</div>');
    });

    it('CSS 开启且非空时前置成 <style> 标签', () => {
        const out = composeCustomAppCardHtml({ htmlCardCssEnabled: true, htmlCardCss: '.phone-card{color:red}' }, '<div>卡片</div>');
        expect(out).toBe('<style>.phone-card{color:red}</style><div>卡片</div>');
    });
});

describe('buildCustomAppHtmlCardNote', () => {
    it('关闭或指令为空返回空串，不占用 prompt', () => {
        expect(buildCustomAppHtmlCardNote({ htmlCardEnabled: false, htmlCardPrompt: '渐变卡片' })).toBe('');
        expect(buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '' })).toBe('');
    });

    it('模板模式：没有自定义占位符时不额外要求字段', () => {
        expect(buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '<div>{{title}}{{detail}}{{value}}</div>' })).toBe('');
    });

    it('模板模式：有自定义占位符时要求 LLM 补充对应 JSON 字段', () => {
        const note = buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '<div>{{title}} {{mood}} {{level}}</div>' });
        expect(note).toContain('mood、level');
        expect(note).toContain('额外补上对应字段');
    });

    it('自然语言模式：要求 LLM 额外产出 html 字段，并带上视觉指令原文', () => {
        const note = buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '粉色渐变的小卡片' });
        expect(note).toContain('"html" 字段');
        expect(note).toContain('粉色渐变的小卡片');
        expect(note).not.toContain('class 控制');
    });

    it('自然语言模式 + 开启了 CSS：额外提示用 class 把样式交给 CSS', () => {
        const note = buildCustomAppHtmlCardNote({
            htmlCardEnabled: true,
            htmlCardPrompt: '粉色渐变的小卡片',
            htmlCardCssEnabled: true,
            htmlCardCss: '.phone-card { color: red; }',
        });
        expect(note).toContain('.phone-card');
        expect(note).toContain('不要在 HTML 里塞大量内联颜色');
    });
});

describe('buildCustomAppAntiRepeatNote', () => {
    const rec = (id: string, title: string, detail: string, timestamp: number): PhoneEvidence =>
        ({ id, type: 'app-1', title, detail, timestamp } as PhoneEvidence);

    it('没有历史记录时返回空串', () => {
        expect(buildCustomAppAntiRepeatNote([])).toBe('');
    });

    it('按时间倒序列出最近记录标题摘要，且要求换主题', () => {
        const note = buildCustomAppAntiRepeatNote([
            rec('1', '沐浴露', '薰衣草味道的沐浴露补货了', 1000),
            rec('2', '洗发水', '换了新洗发水', 2000),
        ]);
        expect(note.indexOf('洗发水')).toBeLessThan(note.indexOf('沐浴露'));
        expect(note).toContain('避免重复主题');
        expect(note).toContain('沐浴露');
    });

    it('超过 limit 时只取最近的那几条', () => {
        const records = Array.from({ length: 12 }, (_, i) => rec(`${i}`, `标题${i}`, '', i));
        const note = buildCustomAppAntiRepeatNote(records, 8);
        // 时间戳倒序取前 8 条：应保留 11..4，丢掉 3..0
        expect(note).toContain('标题11');
        expect(note).toContain('标题4');
        expect(note).not.toContain('标题3');
        expect(note).not.toContain('标题0');
    });
});
