import { describe, expect, it } from 'vitest';
import {
    GRID_COLS, GRID_ROWS, addPage, addWidget, buildLegacyLayout, cellFromPoint, findFreeSpot, hasWidget,
    moveItem, normalizeLayout, removePage, removeWidget, resizeWidget,
    type LauncherLayout, type LauncherPage, DOCK_MAX, moveAppToDock, moveDockAppToGrid, normalizeDockOrder } from './launcherLayout';

const apps = (n: number) => Array.from({ length: n }, (_, i) => `app${i + 1}`);
const pos = (layout: LauncherLayout, pageIndex: number) =>
    layout.pages[pageIndex].items.map(i => `${i.kind === 'app' ? i.appId : i.widget}@${i.x},${i.y}${i.kind === 'widget' ? `:${i.w}x${i.h}` : ''}`);

describe('桌面網格 · 從舊版排出來', () => {
    it('第 1 頁時鐘＋角色卡＋8 個；第 2 頁日程＋四塊；第 3 頁圖片位＋8 個；最後月曆和紀念日', () => {
        const layout = buildLegacyLayout({ gridAppIds: apps(30), widgetImages: { tl: 'blobref:a', wide: 'blobref:w', dsq: 'blobref:d' }, hasDecorations: true });
        expect(pos(layout, 0)).toEqual(['clock@0,0:4x2', 'character@0,2:4x1', 'app1@0,3', 'app2@1,3', 'app3@2,3', 'app4@3,3', 'app5@0,4', 'app6@1,4', 'app7@2,4', 'app8@3,4']);
        expect(pos(layout, 1)).toEqual([
            'schedule@0,0:4x2', 'music@0,2:2x2',
            'app9@2,2', 'app10@3,2', 'app11@2,3', 'app12@3,3',
            'app13@0,4', 'app14@1,4', 'app15@0,5', 'app16@1,5',
            'image@2,4:2x2',
        ]);
        expect(pos(layout, 2)).toEqual(['image@0,0:2x2', 'image@0,2:4x2', 'app17@0,4', 'app18@1,4', 'app19@2,4', 'app20@3,4', 'app21@0,5', 'app22@1,5', 'app23@2,5', 'app24@3,5']);
        expect(layout.pages[2].decorations).toBe(true);
        expect(pos(layout, 3)).toEqual(['app25@0,0', 'app26@1,0', 'app27@2,0', 'app28@3,0', 'app29@0,1', 'app30@1,1']);
        expect(pos(layout, 4)).toEqual(['calendar@0,0:4x3', 'events@0,3:4x3']);
        const images = layout.pages.flatMap(p => p.items).filter(i => i.kind === 'widget' && i.widget === 'image') as any[];
        expect(images.map(i => i.image)).toEqual(['blobref:d', 'blobref:a', 'blobref:w']);
    });

    it('第 2 頁四塊照存過的順序；沒有圖片位時第 3 頁 app 從頂上開始', () => {
        const layout = buildLegacyLayout({ gridAppIds: apps(20), pinwheelOrder: ['image', 'appsA', 'appsB', 'music'] });
        expect(pos(layout, 1).slice(0, 2)).toEqual(['schedule@0,0:4x2', 'image@0,2:2x2']);
        expect(pos(layout, 1)).toContain('music@2,4:2x2');
        expect(pos(layout, 2)[0]).toBe('app17@0,0');
    });
});

describe('桌面網格 · 跟 app 清單對齊', () => {
    it('拿掉不存在的、重複的；新 app 接在最後一頁有空的地方；疊住的重新找位置', () => {
        const layout: LauncherLayout = { version: 1, pages: [
            { id: 'p1', items: [
                { id: 'a', kind: 'app', appId: 'chat', x: 0, y: 0 },
                { id: 'b', kind: 'app', appId: 'gone', x: 1, y: 0 },
                { id: 'c', kind: 'app', appId: 'chat', x: 2, y: 0 },
                { id: 'd', kind: 'app', appId: 'music', x: 0, y: 0 },
                { id: 'e', kind: 'widget', widget: 'calendar', x: 0, y: 5, w: 4, h: 3 },
            ] },
            { id: 'p2', items: [{ id: 'f', kind: 'widget', widget: 'calendar', x: 0, y: 0, w: 4, h: 3 }] },
        ] };
        const next = normalizeLayout(layout, ['chat', 'music', 'news'])!;
        const all = next.pages.flatMap(p => p.items.map(i => (i.kind === 'app' ? i.appId : i.widget)));
        expect(all.sort()).toEqual(['calendar', 'chat', 'music', 'news']);
        expect(next.pages[0].items.find(i => i.kind === 'app' && i.appId === 'music')).toMatchObject({ x: 1, y: 0 });
        // 只能放一個的月曆重複了：留一個；第 2 頁空出來，新 app 放進去
        expect(next.pages[1].items.find(i => i.kind === 'app' && i.appId === 'news')).toMatchObject({ x: 0, y: 0 });
        expect(next.pages[0].items.find(i => i.kind === 'widget')).toMatchObject({ x: 0, y: 1, w: 4, h: 3 });
    });

    it('壞資料回 null（由呼叫端改用舊版排法）', () => {
        expect(normalizeLayout(undefined, ['chat'])).toBeNull();
        expect(normalizeLayout({ version: 1 } as any, ['chat'])).toBeNull();
    });
});

describe('桌面網格 · 搬動', () => {
    const base = (): LauncherLayout => ({ version: 1, pages: [
        { id: 'p1', items: [
            { id: 'a', kind: 'app', appId: 'chat', x: 0, y: 0 },
            { id: 'b', kind: 'app', appId: 'music', x: 1, y: 0 },
            { id: 'w', kind: 'widget', widget: 'image', x: 0, y: 2, w: 2, h: 2 },
        ] },
        { id: 'p2', items: [{ id: 'c', kind: 'app', appId: 'news', x: 3, y: 5 }] },
    ] });

    it('放到空格：中間可以空著（Android 式）', () => {
        const r = moveItem(base(), 'a', 'p1', 3, 5);
        expect(r.ok).toBe(true);
        expect(r.layout.pages[0].items.find(i => i.id === 'a')).toMatchObject({ x: 3, y: 5 });
    });

    it('一樣大、對齊的就交換，跨頁也行', () => {
        const r = moveItem(base(), 'a', 'p1', 1, 0);
        expect(r.layout.pages[0].items.find(i => i.id === 'a')).toMatchObject({ x: 1, y: 0 });
        expect(r.layout.pages[0].items.find(i => i.id === 'b')).toMatchObject({ x: 0, y: 0 });
        const cross = moveItem(base(), 'a', 'p2', 3, 5);
        expect(cross.ok).toBe(true);
        expect(cross.layout.pages[1].items.find(i => i.id === 'a')).toMatchObject({ x: 3, y: 5 });
        expect(cross.layout.pages[0].items.find(i => i.id === 'c')).toMatchObject({ x: 0, y: 0 });
    });

    it('出界的：不動', () => {
        expect(moveItem(base(), 'w', 'p1', 3, 0)).toMatchObject({ ok: false, reason: 'out-of-bounds' });
    });

    it('蓋到大小不同的：放下去，蓋到的往下擠（連鎖）', () => {
        // 2×2 的 w 拖到最上面 (1,0)：蓋到 b，b 往下擠到 w 下面
        const r = moveItem(base(), 'w', 'p1', 1, 0);
        expect(r.ok).toBe(true);
        const items = r.layout.pages[0].items;
        expect(items.find(i => i.id === 'w')).toMatchObject({ x: 1, y: 0 });
        expect(items.find(i => i.id === 'a')).toMatchObject({ x: 0, y: 0 });
        expect(items.find(i => i.id === 'b')).toMatchObject({ x: 1, y: 2 });
        // app 丟到 2×2 的中間：小組件往下擠
        const r2 = moveItem(base(), 'a', 'p1', 1, 3);
        expect(r2.layout.pages[0].items.find(i => i.id === 'a')).toMatchObject({ x: 1, y: 3 });
        expect(r2.layout.pages[0].items.find(i => i.id === 'w')).toMatchObject({ x: 0, y: 4 });
    });

    it('擠到最底還放不下：先找這頁的空位，沒有就搬到下一頁', () => {
        // 一整頁塞滿 4×2 三塊，再把另一頁的 4×2 拖到最上面
        const full: LauncherLayout = { version: 1, pages: [
            { id: 'p1', items: [0, 2, 4].map(y => ({ id: `w${y}`, kind: 'widget' as const, widget: 'clock' as const, x: 0, y, w: 4, h: 2 })) },
            { id: 'p2', items: [{ id: 'n', kind: 'widget', widget: 'clock', x: 0, y: 0, w: 4, h: 2 }] },
        ] };
        // 剛好對齊一樣大的是交換
        expect(moveItem(full, 'n', 'p1', 0, 0).layout.pages[1].items[0].id).toBe('w0');
        // 錯開一列：蓋到兩塊，往下擠，最後兩塊塞不下搬到下一頁
        const r = moveItem(full, 'n', 'p1', 0, 1);
        expect(r).toMatchObject({ ok: true, overflowed: 2 });
        expect(r.layout.pages[0].items.map(i => [i.id, i.y])).toEqual([['n', 1], ['w0', 3]]);
        expect(r.layout.pages[1].items.map(i => [i.id, i.y])).toEqual([['w2', 0], ['w4', 2]]);
        // 這頁還有空位的話，擠出去的先放這頁
        const roomy: LauncherLayout = { version: 1, pages: [{ id: 'p1', items: [
            { id: 'a', kind: 'app', appId: 'chat', x: 0, y: 5 },
            { id: 'w', kind: 'widget', widget: 'clock', x: 0, y: 0, w: 4, h: 2 },
        ] }] };
        const r2 = moveItem(roomy, 'w', 'p1', 0, 4);
        expect(r2).toMatchObject({ ok: true, overflowed: 0 });
        expect(r2.layout.pages[0].items.find(i => i.id === 'a')).toMatchObject({ x: 0, y: 0 });
    });
});

describe('桌面網格 · 小組件與頁', () => {
    it('加小組件：這頁放得下就放這頁，放不下往後，都不行加一頁', () => {
        const full: LauncherPage = { id: 'full', items: Array.from({ length: 24 }, (_, i) => ({ id: `a${i}`, kind: 'app' as const, appId: `x${i}`, x: i % 4, y: Math.floor(i / 4) })) };
        const layout: LauncherLayout = { version: 1, pages: [full, { id: 'p2', items: [] }] };
        const r = addWidget(layout, 0, 'image', { w: 2, h: 2 });
        expect(r.pageId).toBe('p2');
        expect(r.item).toMatchObject({ x: 0, y: 0, w: 2, h: 2 });
        const r2 = addWidget({ version: 1, pages: [full] }, 0, 'image', { w: 4, h: 4 });
        expect(r2.layout.pages).toHaveLength(2);
        expect(hasWidget(r.layout, 'image')).toBe(true);
    });

    it('換尺寸：原地放得下就原地，否則同頁找；刪小組件', () => {
        const layout: LauncherLayout = { version: 1, pages: [{ id: 'p', items: [
            { id: 'w', kind: 'widget', widget: 'image', x: 0, y: 0, w: 2, h: 2 },
            { id: 'a', kind: 'app', appId: 'chat', x: 2, y: 0 },
        ] }] };
        expect(resizeWidget(layout, 'w', { w: 1, h: 1 }).layout.pages[0].items.find(i => i.id === 'w')).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
        expect(resizeWidget(layout, 'w', { w: 4, h: 2 }).layout.pages[0].items.find(i => i.id === 'w')).toMatchObject({ x: 0, y: 1, w: 4, h: 2 });
        expect(resizeWidget(layout, 'w', { w: 4, h: 6 }).ok).toBe(false);
        expect(removeWidget(layout, 'w').pages[0].items.map(i => i.id)).toEqual(['a']);
        expect(removeWidget(layout, 'a').pages[0].items.map(i => i.id)).toEqual(['w', 'a']);
    });

    it('加頁插在目前這頁後面；只有空頁能刪、至少留一頁', () => {
        const layout: LauncherLayout = { version: 1, pages: [{ id: 'p1', items: [{ id: 'a', kind: 'app', appId: 'chat', x: 0, y: 0 }] }, { id: 'p2', items: [] }] };
        const added = addPage(layout, 0);
        expect(added.pageIndex).toBe(1);
        expect(added.layout.pages).toHaveLength(3);
        expect(removePage(layout, 'p1').pages).toHaveLength(2);
        expect(removePage(layout, 'p2').pages.map(p => p.id)).toEqual(['p1']);
        expect(removePage({ version: 1, pages: [{ id: 'only', items: [] }] }, 'only').pages).toHaveLength(1);
    });

    it('指標換格子；找空位', () => {
        expect(cellFromPoint({ left: 0, top: 0, width: 400, height: 600 }, 399, 599)).toEqual({ x: GRID_COLS - 1, y: GRID_ROWS - 1 });
        expect(findFreeSpot({ id: 'p', items: [] }, { w: 4, h: 6 })).toEqual({ x: 0, y: 0 });
    });
});

describe('桌面網格 · Dock 互換', () => {
    const base = (): LauncherLayout => ({ version: 1, pages: [{ id: 'p1', items: [
        { id: 'a', kind: 'app', appId: 'music', x: 0, y: 0 },
        { id: 'w', kind: 'widget', widget: 'image', x: 0, y: 2, w: 2, h: 2 },
    ] }] });
    const dock = ['chat_hub', 'group_chat', 'moments', 'settings'];

    it('Dock 順序：沒存過用預設，存過照存的、不補回、最多 5 個', () => {
        const all = ['chat_hub', 'group_chat', 'moments', 'settings', 'music', 'a', 'b'];
        expect(normalizeDockOrder(undefined, all, dock)).toEqual(dock);
        expect(normalizeDockOrder(['music', 'chat_hub', 'music', 'gone'], all, dock)).toEqual(['music', 'chat_hub']);
        expect(normalizeDockOrder([], all, dock)).toEqual([]);
        expect(normalizeDockOrder(all, all, dock)).toHaveLength(DOCK_MAX);
    });

    it('桌面的 app 丟到 Dock 上某一個：交換，Dock 那個搬到原本的格子', () => {
        const r = moveAppToDock(base(), dock, 'a', 1);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.dock).toEqual(['chat_hub', 'music', 'moments', 'settings']);
        expect(r.layout.pages[0].items.find(i => i.kind === 'app')).toMatchObject({ appId: 'group_chat', x: 0, y: 0 });
    });

    it('丟到 Dock 空處：接在最後；滿了不行；小組件不行', () => {
        const r = moveAppToDock(base(), dock, 'a');
        expect(r.ok && r.dock).toEqual([...dock, 'music']);
        expect(r.ok && r.layout.pages[0].items.some(i => i.kind === 'app')).toBe(false);
        expect(moveAppToDock(base(), [...dock, 'x'], 'a').ok).toBe(false);
        expect(moveAppToDock(base(), dock, 'w').ok).toBe(false);
    });

    it('Dock 的 app 放到桌面：空格就放、蓋到 app 交換、蓋到小組件往下擠', () => {
        const empty = moveDockAppToGrid(base(), dock, 'settings', 'p1', 3, 5);
        expect(empty.ok && empty.dock).toEqual(['chat_hub', 'group_chat', 'moments']);
        expect(empty.ok && empty.layout.pages[0].items.find(i => i.kind === 'app' && i.appId === 'settings')).toMatchObject({ x: 3, y: 5 });
        const swap = moveDockAppToGrid(base(), dock, 'settings', 'p1', 0, 0);
        expect(swap.ok && swap.dock).toEqual(['chat_hub', 'group_chat', 'moments', 'music']);
        expect(swap.ok && swap.layout.pages[0].items.find(i => i.kind === 'app')).toMatchObject({ appId: 'settings', x: 0, y: 0 });
        const push = moveDockAppToGrid(base(), dock, 'settings', 'p1', 1, 2);
        expect(push.ok && push.layout.pages[0].items.find(i => i.id === 'w')).toMatchObject({ x: 0, y: 3 });
        expect(moveDockAppToGrid(base(), dock, 'nope', 'p1', 0, 5).ok).toBe(false);
    });
});
