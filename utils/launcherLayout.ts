/**
 * 桌面網格（plans/desktop-grid-widgets.md）。
 *
 * 每一頁 4 欄 × 6 列；app 佔 1 格，小組件佔 寬×高 格（寬在前：1×2 是直的長條）。
 * 放法是「Android 式」：放哪就在哪，中間可以空著，不自動往前補。
 *
 * 這裡全是純函式，回傳新的 layout；存在 OSTheme.launcherLayout（跟著主題、外觀預設、完整備份走）。
 * 沒有存過的（舊用戶第一次打開）由 buildLegacyLayout 照原本寫死的那幾頁排出來：同樣的東西、同樣的順序。
 */

export const GRID_COLS = 4;
export const GRID_ROWS = 6;

/** 內建小組件 */
export type BuiltinWidgetType = 'clock' | 'character' | 'schedule' | 'music' | 'image' | 'calendar' | 'events';

/** 桌面上的小組件：內建的，或用戶自己做／匯入的（utils/customWidget.ts） */
export type LauncherWidgetType = BuiltinWidgetType | 'custom';

export interface WidgetSize { w: number; h: number }

export interface LauncherAppItem {
    id: string;
    kind: 'app';
    appId: string;
    x: number;
    y: number;
}

export interface LauncherWidgetItem {
    id: string;
    kind: 'widget';
    widget: LauncherWidgetType;
    x: number;
    y: number;
    w: number;
    h: number;
    /** 圖片小組件：圖（blobref 令牌）、要不要外框 */
    image?: string;
    frame?: boolean;
    /** 自訂小組件：用哪個模板（OSTheme.launcherCustomWidgets）、這一份填的欄位、換掉的圖（鍵 → 令牌）、綁的角色（沒綁跟著目前角色） */
    templateId?: string;
    values?: Record<string, string>;
    images?: Record<string, string>;
    charId?: string;
    /** 小組件自己用 widget.setState 存的（待辦打勾、計數…），只屬於這一份 */
    state?: Record<string, string>;
}

export type LauncherItem = LauncherAppItem | LauncherWidgetItem;

export interface LauncherPage {
    id: string;
    items: LauncherItem[];
    /** 舊版第 3 頁那層自由擺放的桌面裝飾，跟著這一頁 */
    decorations?: boolean;
}

export interface LauncherLayout {
    version: 1;
    pages: LauncherPage[];
}

export const sizeLabel = (size: WidgetSize) => `${size.w}×${size.h}`;

/** 每種內建小組件能用的尺寸（第一個是預設） */
export const BUILTIN_WIDGETS: Record<BuiltinWidgetType, { name: string; sizes: WidgetSize[]; multiple: boolean }> = {
    clock: { name: '時鐘', sizes: [{ w: 4, h: 2 }, { w: 4, h: 1 }], multiple: true },
    character: { name: '角色卡', sizes: [{ w: 4, h: 1 }, { w: 4, h: 2 }], multiple: true },
    schedule: { name: '角色日程', sizes: [{ w: 4, h: 2 }, { w: 4, h: 3 }], multiple: false },
    music: { name: '正在播放', sizes: [{ w: 2, h: 2 }], multiple: false },
    image: { name: '圖片', sizes: [{ w: 2, h: 2 }, { w: 1, h: 1 }, { w: 1, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 1 }, { w: 4, h: 2 }, { w: 4, h: 3 }, { w: 4, h: 4 }], multiple: true },
    calendar: { name: '月曆', sizes: [{ w: 4, h: 3 }, { w: 4, h: 4 }], multiple: false },
    events: { name: '紀念日', sizes: [{ w: 4, h: 3 }, { w: 4, h: 2 }, { w: 4, h: 4 }], multiple: false },
};

const makeId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const itemSize = (item: LauncherItem): WidgetSize => (item.kind === 'app' ? { w: 1, h: 1 } : { w: item.w, h: item.h });

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const rect = (item: LauncherItem) => ({ x: item.x, y: item.y, ...itemSize(item) });

export const inBounds = (x: number, y: number, size: WidgetSize) =>
    x >= 0 && y >= 0 && x + size.w <= GRID_COLS && y + size.h <= GRID_ROWS;

/** 這一頁上跟這個範圍重疊的東西 */
export const itemsInArea = (page: LauncherPage, area: { x: number; y: number; w: number; h: number }, ignoreId?: string) =>
    page.items.filter(item => item.id !== ignoreId && overlaps(rect(item), area));

/** 由上而下、由左而右找第一個放得下的位置 */
export const findFreeSpot = (page: LauncherPage, size: WidgetSize): { x: number; y: number } | null => {
    for (let y = 0; y + size.h <= GRID_ROWS; y++) {
        for (let x = 0; x + size.w <= GRID_COLS; x++) {
            if (!itemsInArea(page, { x, y, ...size }).length) return { x, y };
        }
    }
    return null;
};

const newPage = (): LauncherPage => ({ id: makeId('page'), items: [] });

/** 放一個東西：先試指定的頁，放不下往後找，都放不下就加一頁 */
const placeAnywhere = (pages: LauncherPage[], startIndex: number, make: (spot: { x: number; y: number }) => LauncherItem, size: WidgetSize): { pages: LauncherPage[]; pageId: string } => {
    const next = pages.map(page => ({ ...page, items: [...page.items] }));
    for (let i = Math.max(0, startIndex); i < next.length; i++) {
        const spot = findFreeSpot(next[i], size);
        if (spot) {
            next[i].items.push(make(spot));
            return { pages: next, pageId: next[i].id };
        }
    }
    const page = newPage();
    page.items.push(make({ x: 0, y: 0 }));
    next.push(page);
    return { pages: next, pageId: page.id };
};

// ─── 從舊版寫死的那幾頁排出來 ─────────────────────────────────────────────

export interface LegacyLayoutInput {
    /** 照順序的桌面 app（不含 Dock） */
    gridAppIds: string[];
    /** 舊版第 2 頁那四塊的順序 */
    pinwheelOrder?: Array<'music' | 'appsA' | 'appsB' | 'image'>;
    /** 外觀訂製的圖片位：tl／tr／wide（第 3 頁）、dsq（第 2 頁那張方圖） */
    widgetImages?: Record<string, string | undefined>;
    hasDecorations?: boolean;
}

/**
 * 舊版：第 1 頁時鐘＋角色卡＋8 個 app；第 2 頁日程＋四塊（音樂、4 個 app、4 個 app、方圖）；
 * 第 3 頁三個圖片位＋8 個 app（裝飾貼紙也在這頁）；之後每頁 8 個 app；最後一頁月曆＋紀念日。
 */
export const buildLegacyLayout = (input: LegacyLayoutInput): LauncherLayout => {
    const ids = [...input.gridAppIds];
    const take = (n: number) => ids.splice(0, n);
    const app = (appId: string, x: number, y: number): LauncherAppItem => ({ id: `app_${appId}`, kind: 'app', appId, x, y });
    const widget = (widgetType: BuiltinWidgetType, x: number, y: number, w: number, h: number, extra: Partial<LauncherWidgetItem> = {}): LauncherWidgetItem =>
        ({ id: makeId(`w_${widgetType}`), kind: 'widget', widget: widgetType, x, y, w, h, ...extra });
    const appsAt = (list: string[], startRow: number, cols = GRID_COLS, startCol = 0) =>
        list.map((appId, i) => app(appId, startCol + (i % cols), startRow + Math.floor(i / cols)));

    const pages: LauncherPage[] = [];

    // 第 1 頁
    pages.push({ id: 'page_home', items: [widget('clock', 0, 0, 4, 2), widget('character', 0, 2, 4, 1), ...appsAt(take(8), 3)] });

    // 第 2 頁：四塊照存過的順序排在 2×2 的四個角
    const pinwheel = input.pinwheelOrder?.length === 4 ? input.pinwheelOrder : ['music', 'appsA', 'appsB', 'image'] as const;
    const quadA = take(4);
    const quadB = take(4);
    const page2: LauncherItem[] = [widget('schedule', 0, 0, 4, 2)];
    pinwheel.forEach((cell, index) => {
        const x = (index % 2) * 2;
        const y = 2 + Math.floor(index / 2) * 2;
        if (cell === 'music') page2.push(widget('music', x, y, 2, 2));
        else if (cell === 'image') page2.push(widget('image', x, y, 2, 2, input.widgetImages?.dsq ? { image: input.widgetImages.dsq } : {}));
        else page2.push(...appsAt(cell === 'appsA' ? quadA : quadB, y, 2, x));
    });
    pages.push({ id: 'page_2', items: page2 });

    // 第 3 頁：有圖的圖片位才放
    const images = input.widgetImages || {};
    const page3: LauncherItem[] = [];
    let row = 0;
    if (images.tl || images.tr) {
        if (images.tl) page3.push(widget('image', 0, 0, 2, 2, { image: images.tl, frame: true }));
        if (images.tr) page3.push(widget('image', 2, 0, 2, 2, { image: images.tr, frame: true }));
        row = 2;
    }
    if (images.wide) {
        page3.push(widget('image', 0, row, 4, 2, { image: images.wide, frame: true }));
        row += 2;
    }
    page3.push(...appsAt(take(8), row));
    pages.push({ id: 'page_3', items: page3, ...(input.hasDecorations ? { decorations: true } : {}) });

    // 之後每頁 8 個
    while (ids.length) pages.push({ id: makeId('page'), items: appsAt(take(8), 0) });

    // 最後一頁
    pages.push({ id: 'page_widgets', items: [widget('calendar', 0, 0, 4, 3), widget('events', 0, 3, 4, 3)] });

    return { version: 1, pages };
};

// ─── 跟 app 清單對齊 ──────────────────────────────────────────────────────

/**
 * 存著的版面跟現在的 app 清單對齊：不存在的 app 拿掉、重複的留第一個、出界或疊在一起的重新找位置，
 * 新的 app 接在最後一頁有空位的地方（沒空位就加一頁）。至少留一頁。
 */
export const normalizeLayout = (layout: LauncherLayout | undefined | null, availableAppIds: string[]): LauncherLayout | null => {
    if (!layout || !Array.isArray(layout.pages)) return null;
    const available = new Set(availableAppIds);
    const seenApps = new Set<string>();
    const seenSingle = new Set<BuiltinWidgetType>();
    const displaced: LauncherItem[] = [];
    let pages: LauncherPage[] = layout.pages.map(page => {
        const kept: LauncherItem[] = [];
        for (const raw of Array.isArray(page.items) ? page.items : []) {
            if (!raw || typeof raw !== 'object') continue;
            if (raw.kind === 'app') {
                if (!available.has(raw.appId) || seenApps.has(raw.appId)) continue;
                seenApps.add(raw.appId);
            } else if (raw.kind === 'widget' && raw.widget === 'custom') {
                if (typeof raw.templateId !== 'string' || !raw.templateId) continue;
            } else if (raw.kind === 'widget') {
                const spec = BUILTIN_WIDGETS[raw.widget as BuiltinWidgetType];
                if (!spec) continue;
                if (!spec.multiple && seenSingle.has(raw.widget as BuiltinWidgetType)) continue;
                seenSingle.add(raw.widget as BuiltinWidgetType);
            } else continue;
            const item = { ...raw } as LauncherItem;
            const fits = inBounds(item.x, item.y, itemSize(item)) && !kept.some(other => overlaps(rect(other), rect(item)));
            if (fits) kept.push(item); else displaced.push(item);
        }
        return { ...page, id: page.id || makeId('page'), items: kept };
    });
    if (!pages.length) pages = [newPage()];
    for (const item of displaced) {
        pages = placeAnywhere(pages, 0, spot => ({ ...item, ...spot }), itemSize(item)).pages;
    }
    const missing = availableAppIds.filter(id => !seenApps.has(id));
    for (const appId of missing) {
        pages = placeAnywhere(pages, pages.length - 1, spot => ({ id: `app_${appId}`, kind: 'app', appId, ...spot }), { w: 1, h: 1 }).pages;
    }
    return { version: 1, pages };
};

// ─── 編輯動作 ────────────────────────────────────────────────────────────

export type MoveResult =
    | { layout: LauncherLayout; ok: true; /** 被擠下去、這頁塞不下、搬到別頁的有幾個 */ overflowed?: number }
    | { layout: LauncherLayout; ok: false; reason: 'out-of-bounds' | 'occupied' };

/**
 * 把放下去的東西蓋到的那些往下擠：由上往下一個一個看，跟已經定位的重疊就往下挪一列，直到不重疊（會連鎖往下推）。
 * 擠到超出最後一列的，先在這頁找空位，這頁沒有就往後面的頁放（再沒有就加一頁）。
 */
const pushDown = (pages: LauncherPage[], pageIndex: number, placed: LauncherItem): { pages: LauncherPage[]; overflowed: number } => {
    const page = pages[pageIndex];
    const settled: LauncherItem[] = [placed];
    const overflow: LauncherItem[] = [];
    const rest = page.items.filter(i => i.id !== placed.id).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const item of rest) {
        let y = item.y;
        const size = itemSize(item);
        while (settled.some(other => overlaps(rect(other), { x: item.x, y, ...size }))) y += 1;
        if (y + size.h > GRID_ROWS) overflow.push(item);
        else settled.push(y === item.y ? item : { ...item, y });
    }
    let next = pages.map((p, i) => (i === pageIndex ? { ...p, items: settled } : p));
    let overflowed = 0;
    for (const item of overflow) {
        const placedAt = placeAnywhere(next, pageIndex, spot => ({ ...item, ...spot }), itemSize(item));
        if (placedAt.pageId !== page.id) overflowed += 1;
        next = placedAt.pages;
    }
    return { pages: next, overflowed };
};

/**
 * 把一個東西移到某頁的 (x, y)（左上角）。目標範圍空著就放；正好蓋住一個一樣大、左上角也對齊的東西就交換；
 * 其他情況放下去，蓋到的往下擠（pushDown）。只有出界才放不下。
 */
export const moveItem = (layout: LauncherLayout, itemId: string, toPageId: string, x: number, y: number): MoveResult => {
    const fromPage = layout.pages.find(page => page.items.some(item => item.id === itemId));
    const toPage = layout.pages.find(page => page.id === toPageId);
    const item = fromPage?.items.find(i => i.id === itemId);
    if (!fromPage || !toPage || !item) return { layout, ok: false, reason: 'occupied' };
    const size = itemSize(item);
    if (!inBounds(x, y, size)) return { layout, ok: false, reason: 'out-of-bounds' };
    if (fromPage.id === toPageId && item.x === x && item.y === y) return { layout, ok: true };
    const blockers = itemsInArea(toPage, { x, y, ...size }, itemId);
    if (blockers.length === 0) {
        return {
            ok: true,
            layout: {
                ...layout,
                pages: layout.pages.map(page => {
                    let items = page.items;
                    if (page.id === fromPage.id) items = items.filter(i => i.id !== itemId);
                    if (page.id === toPageId) items = [...items, { ...item, x, y }];
                    return items === page.items ? page : { ...page, items };
                }),
            },
        };
    }
    const other = blockers[0];
    const otherSize = itemSize(other);
    const swappable = blockers.length === 1 && other.x === x && other.y === y && otherSize.w === size.w && otherSize.h === size.h;
    if (!swappable) {
        // 先從原本那頁拿掉，再放到目標，蓋到的往下擠
        const lifted = layout.pages.map(page => (page.id === fromPage.id ? { ...page, items: page.items.filter(i => i.id !== itemId) } : page));
        const targetIndex = lifted.findIndex(page => page.id === toPageId);
        const placed = { ...item, x, y };
        lifted[targetIndex] = { ...lifted[targetIndex], items: [...lifted[targetIndex].items, placed] };
        const pushed = pushDown(lifted, targetIndex, placed);
        return { ok: true, layout: { ...layout, pages: pushed.pages }, overflowed: pushed.overflowed };
    }
    return {
        ok: true,
        layout: {
            ...layout,
            pages: layout.pages.map(page => {
                if (page.id !== fromPage.id && page.id !== toPageId) return page;
                const items = page.items
                    .filter(i => !(page.id === fromPage.id && i.id === itemId) && !(page.id === toPageId && i.id === other.id))
                    .concat(page.id === toPageId ? [{ ...item, x, y }] : [])
                    .concat(page.id === fromPage.id ? [{ ...other, x: item.x, y: item.y }] : []);
                return { ...page, items };
            }),
        },
    };
};

/** 加一個內建小組件：先放目前這頁，放不下往後找，都不行就加一頁 */
export const addWidget = (layout: LauncherLayout, pageIndex: number, widgetType: BuiltinWidgetType, size: WidgetSize): { layout: LauncherLayout; pageId: string; item: LauncherWidgetItem } => {
    const item: LauncherWidgetItem = { id: makeId(`w_${widgetType}`), kind: 'widget', widget: widgetType, x: 0, y: 0, ...size };
    const placed = placeAnywhere(layout.pages, pageIndex, spot => ({ ...item, ...spot }), size);
    const final = placed.pages.find(p => p.id === placed.pageId)!.items.find(i => i.id === item.id) as LauncherWidgetItem;
    return { layout: { ...layout, pages: placed.pages }, pageId: placed.pageId, item: final };
};

/** 放一份自訂小組件：模板的預設尺寸，位置規則跟 addWidget 一樣 */
export const addCustomWidget = (layout: LauncherLayout, pageIndex: number, templateId: string, size: WidgetSize): { layout: LauncherLayout; pageId: string; item: LauncherWidgetItem } => {
    const item: LauncherWidgetItem = { id: makeId('w_custom'), kind: 'widget', widget: 'custom', templateId, x: 0, y: 0, ...size };
    const placed = placeAnywhere(layout.pages, pageIndex, spot => ({ ...item, ...spot }), size);
    const final = placed.pages.find(p => p.id === placed.pageId)!.items.find(i => i.id === item.id) as LauncherWidgetItem;
    return { layout: { ...layout, pages: placed.pages }, pageId: placed.pageId, item: final };
};

/** 刪模板時，桌面上用這個模板的每一份也一起拿掉 */
export const removeCustomWidgetsOf = (layout: LauncherLayout, templateId: string): LauncherLayout => ({
    ...layout,
    pages: layout.pages.map(page => (page.items.some(i => i.kind === 'widget' && i.templateId === templateId)
        ? { ...page, items: page.items.filter(i => !(i.kind === 'widget' && i.widget === 'custom' && i.templateId === templateId)) }
        : page)),
});

export const countCustomWidgetsOf = (layout: LauncherLayout, templateId: string) =>
    layout.pages.reduce((n, page) => n + page.items.filter(i => i.kind === 'widget' && i.widget === 'custom' && i.templateId === templateId).length, 0);

/** 這一頁有沒有這種（只能放一個的）小組件 */
export const hasWidget = (layout: LauncherLayout, widgetType: BuiltinWidgetType) =>
    layout.pages.some(page => page.items.some(item => item.kind === 'widget' && item.widget === widgetType));

/** 刪小組件（app 不能刪，只能搬） */
export const removeWidget = (layout: LauncherLayout, itemId: string): LauncherLayout => ({
    ...layout,
    pages: layout.pages.map(page => (page.items.some(i => i.id === itemId && i.kind === 'widget')
        ? { ...page, items: page.items.filter(i => i.id !== itemId) }
        : page)),
});

export const patchWidget = (layout: LauncherLayout, itemId: string, patch: Partial<Pick<LauncherWidgetItem, 'image' | 'frame' | 'values' | 'images' | 'charId' | 'state'>>): LauncherLayout => ({
    ...layout,
    pages: layout.pages.map(page => (page.items.some(i => i.id === itemId)
        ? { ...page, items: page.items.map(i => (i.id === itemId && i.kind === 'widget' ? { ...i, ...patch } : i)) }
        : page)),
});

/** 換尺寸：原位置放得下就原地換；放不下在同一頁找；同頁都不行就不換 */
export const resizeWidget = (layout: LauncherLayout, itemId: string, size: WidgetSize): { layout: LauncherLayout; ok: boolean } => {
    const page = layout.pages.find(p => p.items.some(i => i.id === itemId));
    const item = page?.items.find(i => i.id === itemId);
    if (!page || !item || item.kind !== 'widget') return { layout, ok: false };
    const others: LauncherPage = { ...page, items: page.items.filter(i => i.id !== itemId) };
    const here = inBounds(item.x, item.y, size) && !itemsInArea(others, { x: item.x, y: item.y, ...size }).length;
    const spot = here ? { x: item.x, y: item.y } : findFreeSpot(others, size);
    if (!spot) return { layout, ok: false };
    return {
        ok: true,
        layout: {
            ...layout,
            pages: layout.pages.map(p => (p.id === page.id ? { ...others, items: [...others.items, { ...item, ...size, ...spot }] } : p)),
        },
    };
};

export const addPage = (layout: LauncherLayout, afterIndex: number): { layout: LauncherLayout; pageIndex: number } => {
    const pages = [...layout.pages];
    const at = Math.min(pages.length, Math.max(0, afterIndex + 1));
    pages.splice(at, 0, newPage());
    return { layout: { ...layout, pages }, pageIndex: at };
};

/** 只能刪空頁；至少留一頁 */
export const removePage = (layout: LauncherLayout, pageId: string): LauncherLayout => {
    const page = layout.pages.find(p => p.id === pageId);
    if (!page || page.items.length || layout.pages.length <= 1) return layout;
    return { ...layout, pages: layout.pages.filter(p => p.id !== pageId) };
};

/** 格子座標：指標在頁面網格裡的位置換成哪一格 */
export const cellFromPoint = (gridRect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) => ({
    x: Math.floor(((clientX - gridRect.left) / gridRect.width) * GRID_COLS),
    y: Math.floor(((clientY - gridRect.top) / gridRect.height) * GRID_ROWS),
});
