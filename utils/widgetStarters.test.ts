import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, WIDGET_STARTERS, contentFingerprint, findUntouchedStarterCopies, instantiateStarter, isStarterTemplateId, starterTemplateId } from './widgetStarters';
import { applyWidgetState, buildPlaceholderValues, buildWidgetSrcDoc, fillHtml, isCustomWidgetSize, isReservedKey, isValidKey, parseWidgetFile, buildWidgetFile, WIDGET_STATE_LIMITS } from './customWidget';

describe('內建範本', () => {
    it('每個範本的鍵、尺寸、選項都合規，id 不重複', () => {
        expect(new Set(WIDGET_STARTERS.map(s => s.id)).size).toBe(WIDGET_STARTERS.length);
        for (const { id, template } of WIDGET_STARTERS) {
            expect(isCustomWidgetSize(template), id).toBe(true);
            const keys = [...template.imageKeys, ...template.fields.map(f => f.key)];
            expect(new Set(keys).size, id).toBe(keys.length);
            for (const key of keys) {
                expect(isValidKey(key), `${id}.${key}`).toBe(true);
                expect(isReservedKey(key), `${id}.${key}`).toBe(false);
            }
            for (const f of template.fields) {
                if (f.type === 'select') {
                    expect(f.options?.length, `${id}.${f.key}`).toBeGreaterThan(0);
                    if (f.default) expect(f.options, `${id}.${f.key}`).toContain(f.default);
                }
            }
        }
    });

    it('組得出 srcdoc，CSS 裡的欄位填好了，程式裡沒有被佔位符弄壞的字串', () => {
        for (const { id, template } of WIDGET_STARTERS) {
            const doc = buildWidgetSrcDoc({ template, imageUrls: {}, size: template, char: { name: '煦', unread: 0 } });
            expect(doc, id).not.toMatch(/\{\{accent\}\}/);
            expect(doc, id).toContain('window.widget=');
            // 範本自己的程式裡不該有被換成 span 的佔位符
            const filled = fillHtml(template.html, buildPlaceholderValues({ template, imageUrls: {}, size: template }));
            for (const script of filled.match(/<script>[\s\S]*?<\/script>/g) || []) expect(script, id).not.toContain('data-soren-live');
            // widget.size 只有寬高
            expect(doc, id).toContain(`size:{"w":${template.w},"h":${template.h}}`);
        }
    });

    it('用範本是複製一份，改了不影響範本；也能照樣匯出再匯入', () => {
        const starter = WIDGET_STARTERS.find(s => s.id === 'todo')!;
        const t = instantiateStarter(starter, 'cw_x', 1);
        t.fields[0].label = '改掉';
        t.fields.find(f => f.key === 'daily')!.options!.push('多一個');
        expect(starter.template.fields[0].label).toBe('標題');
        expect(starter.template.fields.find(f => f.key === 'daily')!.options).toEqual(['每天重來', '一直留著']);
        const back = parseWidgetFile(JSON.stringify(buildWidgetFile(t)));
        expect(back.ok).toBe(true);
    });
});

describe('widget.setState', () => {
    it('沙盒裡有 setState，存的東西 getState 先讀到', () => {
        const doc = buildWidgetSrcDoc({
            template: { html: '<b></b>', css: '', imageKeys: [], fields: [{ key: 'a', label: 'a', type: 'text', default: '欄位' }] },
            imageUrls: {}, size: { w: 2, h: 2 }, state: { a: '存的' },
        });
        expect(doc).toContain('setState:function(k,v)');
        expect(doc).toContain('T={"a":"存的"}');
        expect(doc).toContain('H.call(T,k)?T[k]:H.call(S,k)?S[k]:null');
    });

    it('合併、刪除、超過上限不存', () => {
        expect(applyWidgetState(undefined, 'n', '1')).toEqual({ n: '1' });
        expect(applyWidgetState({ n: '1', m: '2' }, 'n', null)).toEqual({ m: '2' });
        expect(applyWidgetState({}, '', '1')).toBeNull();
        expect(applyWidgetState({}, 'x'.repeat(41), '1')).toBeNull();
        expect(applyWidgetState({}, 'big', 'x'.repeat(WIDGET_STATE_LIMITS.value + 1))).toBeNull();
        const many = Object.fromEntries(Array.from({ length: WIDGET_STATE_LIMITS.keys }, (_, i) => [`k${i}`, '1']));
        expect(applyWidgetState(many, 'one-more', '1')).toBeNull();
        const heavy = { a: 'x'.repeat(4900), b: 'x'.repeat(4900), c: 'x'.repeat(4900), d: 'x'.repeat(4900) };
        expect(applyWidgetState(heavy, 'e', 'x'.repeat(1000))).toBeNull();
    });
});

describe('範本直接指著用，不複製進「我的小組件」', () => {
    it('範本模板的 id 是 starter:<id>，每個範本都有', () => {
        expect(STARTER_TEMPLATES.map(t => t.id)).toEqual(WIDGET_STARTERS.map(s => starterTemplateId(s.id)));
        expect(isStarterTemplateId('starter:todo')).toBe(true);
        expect(isStarterTemplateId('cw_abc')).toBe(false);
        expect(isStarterTemplateId(undefined)).toBe(false);
    });

    it('舊版複製出來、沒改過的認得出來；改過的、放了自己圖的不動', () => {
        const todo = WIDGET_STARTERS.find(s => s.id === 'todo')!;
        const polaroid = WIDGET_STARTERS.find(s => s.id === 'polaroid')!;
        const untouched = instantiateStarter(todo, 'cw_old1', 5);
        const edited = { ...instantiateStarter(todo, 'cw_old2', 5), css: '.x{}' };
        const withImage = { ...instantiateStarter(polaroid, 'cw_old3', 5), images: { photo1: 'blobref:abc' } };
        const renamed = { ...instantiateStarter(todo, 'cw_old4', 5), name: '我的待辦' };
        const copies = findUntouchedStarterCopies([untouched, edited, withImage, renamed]);
        expect([...copies.entries()]).toEqual([['cw_old1', 'starter:todo']]);
    });
});

describe('內容指紋', () => {
    it('同樣內容同樣指紋，差一個字就不同', () => {
        expect(contentFingerprint('abc')).toBe(contentFingerprint('abc'));
        expect(contentFingerprint('abc')).not.toBe(contentFingerprint('abd'));
        expect(contentFingerprint('')).toMatch(/^[0-9a-z]+:0$/);
    });
});
