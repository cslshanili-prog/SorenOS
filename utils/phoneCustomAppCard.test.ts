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

describe('佔位符檢測與提取', () => {
    it('帶 {{xxx}} 判定為模板', () => {
        expect(hasTemplatePlaceholders('<div>{{title}}</div>')).toBe(true);
        expect(hasTemplatePlaceholders('生成一個漸變背景的卡片')).toBe(false);
    });

    it('按首次出現順序去重提取佔位符名字', () => {
        expect(extractPlaceholderNames('{{title}} - {{mood}} - {{title}} - {{value}}')).toEqual(['title', 'mood', 'value']);
    });
});

describe('substituteTemplate', () => {
    it('替換已知字段，未知字段替換成空串', () => {
        const out = substituteTemplate('<b>{{title}}</b><i>{{mood}}</i><u>{{missing}}</u>', { title: '標題', mood: '開心' });
        expect(out).toBe('<b>標題</b><i>開心</i><u></u>');
    });
});

describe('resolveCustomAppRecordHtml', () => {
    const fields = { title: '標題A', detail: '詳情A', value: '¥10' };

    it('未開啟或指令為空時返回 undefined（自動回退純文字）', () => {
        expect(resolveCustomAppRecordHtml({ htmlCardEnabled: false, htmlCardPrompt: '<div>{{title}}</div>' }, {}, fields)).toBeUndefined();
        expect(resolveCustomAppRecordHtml({ htmlCardEnabled: true, htmlCardPrompt: '  ' }, {}, fields)).toBeUndefined();
    });

    it('模板模式：本地替換標準字段 + 自定義佔位符（從 item 裡取）', () => {
        const app = { htmlCardEnabled: true, htmlCardPrompt: '<div>{{title}}-{{detail}}-{{value}}-{{mood}}</div>' };
        const html = resolveCustomAppRecordHtml(app, { mood: '興奮' }, fields);
        expect(html).toBe('<div>標題A-詳情A-¥10-興奮</div>');
    });

    it('自然語言模式：直接信任 item.html，空則 undefined', () => {
        const app = { htmlCardEnabled: true, htmlCardPrompt: '漸變背景卡片' };
        expect(resolveCustomAppRecordHtml(app, { html: '<div>卡片內容</div>' }, fields)).toBe('<div>卡片內容</div>');
        expect(resolveCustomAppRecordHtml(app, {}, fields)).toBeUndefined();
    });
});

describe('composeCustomAppCardHtml', () => {
    it('CSS 關閉或為空時原樣返回 html', () => {
        expect(composeCustomAppCardHtml({ htmlCardCssEnabled: false, htmlCardCss: '.x{color:red}' }, '<div>卡片</div>')).toBe('<div>卡片</div>');
        expect(composeCustomAppCardHtml({ htmlCardCssEnabled: true, htmlCardCss: '  ' }, '<div>卡片</div>')).toBe('<div>卡片</div>');
    });

    it('CSS 開啟且非空時前置成 <style> 標籤', () => {
        const out = composeCustomAppCardHtml({ htmlCardCssEnabled: true, htmlCardCss: '.phone-card{color:red}' }, '<div>卡片</div>');
        expect(out).toBe('<style>.phone-card{color:red}</style><div>卡片</div>');
    });
});

describe('buildCustomAppHtmlCardNote', () => {
    it('關閉或指令為空返回空串，不佔用 prompt', () => {
        expect(buildCustomAppHtmlCardNote({ htmlCardEnabled: false, htmlCardPrompt: '漸變卡片' })).toBe('');
        expect(buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '' })).toBe('');
    });

    it('模板模式：沒有自定義佔位符時不額外要求字段', () => {
        expect(buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '<div>{{title}}{{detail}}{{value}}</div>' })).toBe('');
    });

    it('模板模式：有自定義佔位符時要求 LLM 補充對應 JSON 字段', () => {
        const note = buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '<div>{{title}} {{mood}} {{level}}</div>' });
        expect(note).toContain('mood、level');
        expect(note).toContain('額外補上對應字段');
    });

    it('自然語言模式：要求 LLM 額外產出 html 字段，並帶上視覺指令原文', () => {
        const note = buildCustomAppHtmlCardNote({ htmlCardEnabled: true, htmlCardPrompt: '粉色漸變的小卡片' });
        expect(note).toContain('"html" 字段');
        expect(note).toContain('粉色漸變的小卡片');
        expect(note).not.toContain('class 控制');
    });

    it('自然語言模式 + 開啟了 CSS：額外提示用 class 把樣式交給 CSS', () => {
        const note = buildCustomAppHtmlCardNote({
            htmlCardEnabled: true,
            htmlCardPrompt: '粉色漸變的小卡片',
            htmlCardCssEnabled: true,
            htmlCardCss: '.phone-card { color: red; }',
        });
        expect(note).toContain('.phone-card');
        expect(note).toContain('不要在 HTML 裡塞大量內聯顏色');
    });
});

describe('buildCustomAppAntiRepeatNote', () => {
    const rec = (id: string, title: string, detail: string, timestamp: number): PhoneEvidence =>
        ({ id, type: 'app-1', title, detail, timestamp } as PhoneEvidence);

    it('沒有歷史記錄時返回空串', () => {
        expect(buildCustomAppAntiRepeatNote([])).toBe('');
    });

    it('按時間倒序列出最近記錄標題摘要，且要求換主題', () => {
        const note = buildCustomAppAntiRepeatNote([
            rec('1', '沐浴露', '薰衣草味道的沐浴露補貨了', 1000),
            rec('2', '洗髮水', '換了新洗髮水', 2000),
        ]);
        expect(note.indexOf('洗髮水')).toBeLessThan(note.indexOf('沐浴露'));
        expect(note).toContain('避免重複主題');
        expect(note).toContain('沐浴露');
    });

    it('超過 limit 時只取最近的那幾條', () => {
        const records = Array.from({ length: 12 }, (_, i) => rec(`${i}`, `標題${i}`, '', i));
        const note = buildCustomAppAntiRepeatNote(records, 8);
        // 時間戳倒序取前 8 條：應保留 11..4，丟掉 3..0
        expect(note).toContain('標題11');
        expect(note).toContain('標題4');
        expect(note).not.toContain('標題3');
        expect(note).not.toContain('標題0');
    });
});
