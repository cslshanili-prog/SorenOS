// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ChatInputArea from '../components/chat/ChatInputArea';
import type { Emoji } from '../types';
import { DB } from './db';
import { dataUrlToBlob, putImageBlob } from './blobRef';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let objectUrlSeq = 0;
const createObjectURL = vi.fn(() => `blob:emoji-${++objectUrlSeq}`);
const revokeObjectURL = vi.fn();
(URL as any).createObjectURL = createObjectURL;
(URL as any).revokeObjectURL = revokeObjectURL;
let container: HTMLDivElement;
let root: Root;
const onPanelAction = vi.fn();
const categories = [{ id: 'a', name: '分組 A' }, { id: 'b', name: '分組 B' }];

function Panel({ emojis }: { emojis: Emoji[] }) {
    const [activeCategory, setActiveCategory] = useState('a');
    return createElement(ChatInputArea, {
        input: '', setInput: () => {}, isTyping: false, selectionMode: false,
        showPanel: 'emojis', setShowPanel: () => {}, onSend: () => {},
        onDeleteSelected: () => {}, selectedCount: 0,
        emojis: emojis.filter(e => e.categoryId === activeCategory), categories, activeCategory,
        onPanelAction: (action, payload) => {
            if (action === 'select-category') setActiveCategory(payload);
            onPanelAction(action, payload);
        },
        onImageSelect: () => {}, isSummarizing: false, onReroll: () => {}, canReroll: false,
    });
}
function thumbnails() {
    return Array.from(container.querySelectorAll<HTMLImageElement>('img.sully-emoji-thumb'));
}
function names() {
    return thumbnails().map(img => img.closest('button')!.querySelector('span')!.textContent);
}
function clickGroup(name: string) {
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === name)!;
    act(() => button.click());
}
function clickLabel(label: string) {
    act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
}
async function render(emojis: Emoji[]) {
    await act(async () => { root.render(createElement(Panel, { emojis })); });
}

beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe('表情面板的記錄身份與圖片複用', () => {
    it('共用圖片令牌的表情反覆切分組、重新讀取後，都不殘留或複製舊格子', async () => {
        const sharedRef = await putImageBlob(dataUrlToBlob(PNG));
        const emojis: Emoji[] = [
            { name: '我嗎', url: sharedRef, categoryId: 'a' },
            { name: '疑問', url: sharedRef, categoryId: 'a' },
            { name: '開心', url: 'https://example.com/happy.png', categoryId: 'a' },
            { name: '你好', url: 'https://example.com/hello.png', categoryId: 'b' },
            { name: '問號', url: sharedRef, categoryId: 'b' },
        ];
        for (const e of emojis) await DB.saveEmoji(e.name, e.url, e.categoryId);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (let reopen = 0; reopen < 2; reopen++) {
            await render(await DB.getEmojis());
            for (let i = 0; i < 5; i++) {
                expect(names().sort()).toEqual(['我嗎', '疑問', '開心'].sort());
                clickGroup('分組 B');
                expect(names().sort()).toEqual(['你好', '問號'].sort());
                clickGroup('分組 A');
            }
            await act(async () => { root.render(null); });
        }
        expect(errors.mock.calls.filter(args => args.join(' ').includes('same key'))).toEqual([]);
        expect(await DB.getEmojis()).toEqual(expect.arrayContaining(emojis));
    });

    it('大量共用 URL 的表情仍每頁最多掛載 40 張，翻頁和換組數量準確', async () => {
        const emojis: Emoji[] = ['a', 'b'].flatMap(categoryId => Array.from({ length: 85 }, (_, i) => ({
            name: `${categoryId}-${i}`, categoryId, url: `https://example.com/shared-${i % 3}.png`,
        })));
        await render(emojis);
        const expectPage = (category: string, start: number, end: number) => {
            expect(names()).toEqual(emojis.filter(e => e.categoryId === category).slice(start, end).map(e => e.name));
            expect(thumbnails().length).toBeLessThanOrEqual(40);
            for (const img of thumbnails()) {
                expect(img.getAttribute('loading')).toBe('lazy');
                expect(img.getAttribute('decoding')).toBe('async');
            }
        };
        expectPage('a', 0, 40);
        clickLabel('下一頁表情');
        expectPage('a', 40, 80);
        clickLabel('下一頁表情');
        expectPage('a', 80, 85);
        clickGroup('分組 B');
        expectPage('b', 0, 40);
        clickLabel('下一頁表情');
        expectPage('b', 40, 80);
        clickLabel('上一頁表情');
        expectPage('b', 0, 40);
        clickGroup('分組 A');
        expectPage('a', 0, 40);
    });

    it('同一表情未換圖時複用節點，換圖時重建圖片節點以免保留舊位圖', async () => {
        const original: Emoji = { name: '你好', categoryId: 'a', url: 'https://example.com/old.png' };
        await render([original]);
        const oldImage = thumbnails()[0];
        await render([{ ...original }]);
        expect(thumbnails()[0]).toBe(oldImage);
        await render([{ ...original, url: 'https://example.com/new.png' }]);
        expect(thumbnails()[0]).not.toBe(oldImage);
        expect(thumbnails()[0].getAttribute('src')).toBe('https://example.com/new.png');
    });

    it('同圖不同名的表情可分別選擇，刪除只提交實際選中的記錄', async () => {
        const emojis: Emoji[] = ['我嗎', '疑問'].map(name => ({
            name, categoryId: 'a', url: 'https://example.com/shared.png',
        }));
        await render(emojis);
        clickLabel('批量管理表情');
        const buttons = thumbnails().map(img => img.closest('button')!);
        act(() => buttons[0].click());
        expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
        act(() => buttons[1].click());
        expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
        act(() => buttons[0].click());
        expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
        clickLabel('刪除選中的表情');
        expect(onPanelAction).toHaveBeenLastCalledWith('delete-emoji-req', [emojis[1]]);
    });
});
