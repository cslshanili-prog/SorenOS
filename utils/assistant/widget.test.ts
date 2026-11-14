import { describe, expect, it } from 'vitest';
import type { AssistantWidgetProposal } from '../../types';
import type { CustomWidgetTemplate } from '../customWidget';
import { buildWidgetProposal, describeWidget, describeWidgetList, type WidgetData } from './widgetOps';
import { applyWidgetProposal, restoreWidgetProposal, type WidgetWriter, widgetChangedSinceApply } from './applyProposal';
import { peekWidgetPlacement, takeWidgetPlacement } from './widgetPlacement';

const tpl = (): CustomWidgetTemplate => ({
    id: 'cw1', name: '倒數', html: '<div>{{note}}</div>', css: 'div{color:red}', w: 4, h: 2,
    imageKeys: ['bg'], images: { bg: 'blobref:x' }, fields: [{ key: 'note', label: '一句話', type: 'text', default: '嗨' }], createdAt: 1, updatedAt: 1,
});
const makeData = (): WidgetData => ({
    templates: [tpl()],
    layout: { version: 1, pages: [{ id: 'p1', items: [{ id: 'w', kind: 'widget', widget: 'custom', templateId: 'cw1', x: 0, y: 0, w: 4, h: 2 }] }] },
});
const fakeWriter = (data: WidgetData): WidgetWriter & { placed: string[] } => {
    const w = {
        placed: [] as string[],
        setTemplates: (templates: CustomWidgetTemplate[], removePlacedOf?: string) => {
            data.templates = templates;
            if (removePlacedOf && data.layout) data.layout = { ...data.layout, pages: data.layout.pages.map(p => ({ ...p, items: p.items.filter(i => !(i.kind === 'widget' && i.templateId === removePlacedOf)) })) };
        },
        requestPlacement: (id: string) => { w.placed.push(id); },
        cancelPlacement: () => {},
    };
    return w;
};

describe('讀', () => {
    it('列出、讀一個', () => {
        expect(describeWidgetList(makeData())).toContain('「倒數」id=cw1｜4x2｜欄位 1、圖片 1｜桌面上有 1 份');
        expect(describeWidget(tpl())).toContain('note（一句話，text，預設「嗨」）');
    });
});

describe('寫小組件', () => {
    it('新的：尺寸、欄位、有程式、預設放上桌面', () => {
        const r = buildWidgetProposal({ name: '心情', size: '2x2', html: '<div id="m">{{mood}}</div><script>widget.onReady(()=>{})</script>', fields: [{ key: 'mood', label: '心情', type: 'text' }] }, makeData());
        const d = (r as any).draft as AssistantWidgetProposal;
        expect(d).toMatchObject({ isNew: true, place: true, hasScript: true });
        expect(d.template).toMatchObject({ name: '心情', w: 2, h: 2, imageKeys: [] });
        expect(d.changes.map(c => c.label)).toEqual(expect.arrayContaining([expect.stringContaining('有程式'), expect.stringContaining('放上桌面')]));
        expect((buildWidgetProposal({ name: 'x', html: '<b/>', place: false }, makeData()) as any).draft.place).toBe(false);
    });
    it('改既有的：圖片照舊、只列有改的；一樣就不出卡片', () => {
        const r = (buildWidgetProposal({ widget: '倒數', css: 'div{color:blue}' }, makeData()) as any).draft as AssistantWidgetProposal;
        expect(r.isNew).toBe(false);
        expect(r.place).toBe(false);
        expect(r.template.images).toEqual({ bg: 'blobref:x' });
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({ before: 'div{color:red}', after: 'div{color:blue}' });
        expect(buildWidgetProposal({ widget: '倒數', css: 'div{color:red}' }, makeData())).toHaveProperty('error');
    });
    it('擋：沒 html、壞尺寸、欄位撞內建', () => {
        expect(buildWidgetProposal({ name: 'x' }, makeData())).toHaveProperty('error');
        expect(buildWidgetProposal({ name: 'x', html: '<b/>', size: '3x3' }, makeData())).toHaveProperty('error');
        expect((buildWidgetProposal({ name: 'x', html: '<b/>', fields: [{ key: 'time', label: 't', type: 'text' }] }, makeData()) as any).error).toContain('撞名');
    });
});

describe('套用與還原', () => {
    it('新的：套用存模板、留放置字條；還原刪模板和桌面上的', async () => {
        const data = makeData();
        const w = fakeWriter(data);
        const d = (buildWidgetProposal({ name: '心情', html: '<b/>' }, data) as any).draft;
        const applied = await applyWidgetProposal({ ...d, id: 'p', status: 'pending' }, data, w);
        expect(data.templates).toHaveLength(2);
        expect(w.placed).toEqual([d.templateId]);
        data.layout!.pages[0].items.push({ id: 'w2', kind: 'widget', widget: 'custom', templateId: d.templateId, x: 0, y: 2, w: 4, h: 2 });
        await restoreWidgetProposal(applied, data, w);
        expect(data.templates.map(t => t.id)).toEqual(['cw1']);
        expect(data.layout!.pages[0].items.map(i => i.id)).toEqual(['w']);
    });
    it('改既有的：還原寫回原本的模板', async () => {
        const data = makeData();
        const w = fakeWriter(data);
        const d = (buildWidgetProposal({ widget: 'cw1', html: '<i>新</i>' }, data) as any).draft;
        const applied = await applyWidgetProposal({ ...d, id: 'p', status: 'pending' }, data, w);
        expect(data.templates[0].html).toBe('<i>新</i>');
        expect(widgetChangedSinceApply(applied, data)).toBe(false);
        await restoreWidgetProposal(applied, data, w);
        expect(data.templates[0].html).toBe('<div>{{note}}</div>');
    });
    it('放置字條拿一次就沒了', () => {
        expect(takeWidgetPlacement()).toBeNull();
        expect(peekWidgetPlacement()).toBeNull();
    });
});
