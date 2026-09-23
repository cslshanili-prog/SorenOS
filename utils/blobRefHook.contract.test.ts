// @vitest-environment jsdom

// useBlobRefUrl 契約測試 —— 釘住委託 @rei-standard/blob-store/react 後的兩條關鍵語義
// （SDK 側說好的行為測試隨首個消費者落地，就是這份）：
//   1. 令牌 → 令牌切換期間返回 undefined，絕不把上一個（已 revoke 的）objectURL 吐給渲染層；
//   2. 非令牌值在渲染期直接透傳，不等 effect、無一幀滯後（含 value 變化的那一幀）。
// 外加第 3 條 SullyOS 特有分支：builtin-room-asset:// 令牌在首幀就解析成當前部署 URL。
//
// 環境說明：vitest 全局是 node 環境，本文件靠文件頭指令單獨跑 jsdom（React DOM 需要
// document）；vitest.config.ts 的 include 只收 utils/**/*.test.ts，所以不寫 JSX、
// 用 React.createElement。fake-indexeddb 由 test-setup.ts 注入，putImageBlob 直接可用。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useBlobRefUrl, putImageBlob, dataUrlToBlob } from './blobRef';

// React 18 下 createRoot + act 必須顯式聲明 act 環境，否則 act 直接告警且不聚合更新。
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 沒有 URL.createObjectURL / revokeObjectURL，自己 stub：每次造一個可區分的假 URL，
// 順便讓測試能斷言「切換後舊 URL 被 revoke」。
let objectUrlSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-${++objectUrlSeq}`);
const revokeObjectURL = vi.fn();
(URL as any).createObjectURL = createObjectURL;
(URL as any).revokeObjectURL = revokeObjectURL;

const TINY_PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 探針組件工廠：把 hook 每一幀的返回值按渲染順序記進 frames。 */
function makeProbe() {
    const frames: Array<string | undefined> = [];
    function Probe({ value }: { value: string | undefined | null }) {
        frames.push(useBlobRefUrl(value));
        return null;
    }
    return { frames, Probe };
}

/** 反覆放行宏任務，直到 predicate 成立（等 fake-indexeddb 的異步讀完成）。 */
async function flushUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !predicate(); i++) {
        await act(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 2));
        });
    }
    expect(predicate()).toBe(true);
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useBlobRefUrl 契約（委託 SDK useBlobUrl 後的語義）', () => {
    it('令牌 → 令牌切換期間返回 undefined，不吐已 revoke 的舊 objectURL', async () => {
        const refA = await putImageBlob(dataUrlToBlob(TINY_PNG_A));
        const refB = await putImageBlob(dataUrlToBlob(TINY_PNG_B));
        const { frames, Probe } = makeProbe();

        // 首掛令牌 A：解析前 undefined，Blob 讀出後拿到 objectURL_A。
        act(() => root.render(createElement(Probe, { value: refA })));
        expect(frames[frames.length - 1]).toBeUndefined();
        await flushUntil(() => frames[frames.length - 1] !== undefined);
        const urlA = frames[frames.length - 1]!;
        expect(urlA).toMatch(/^blob:mock-/);

        // 切到令牌 B：同步 act 裡提交 + 跑完 effect，但 B 的 Blob 是異步讀的、此刻還沒解析完。
        // 契約：此時 hook 返回 undefined，而不是已被 revoke 的 objectURL_A。
        act(() => root.render(createElement(Probe, { value: refB })));
        expect(frames[frames.length - 1]).toBeUndefined();
        expect(frames[frames.length - 1]).not.toBe(urlA);
        // 舊 URL 在切換時就被 revoke（不洩漏，也正因如此絕不能再吐給渲染層）。
        expect(revokeObjectURL).toHaveBeenCalledWith(urlA);

        // B 解析完成後拿到新的 objectURL_B。
        await flushUntil(() => frames[frames.length - 1] !== undefined);
        const urlB = frames[frames.length - 1]!;
        expect(urlB).toMatch(/^blob:mock-/);
        expect(urlB).not.toBe(urlA);
    });

    it('非令牌值渲染期直接透傳，無一幀滯後（含 undefined 與 value 變化幀）', async () => {
        const passthroughValues: Array<string | undefined> = [
            TINY_PNG_A,
            'https://example.com/a.png',
            'linear-gradient(180deg, #fff, #000)',
            undefined,
        ];
        for (const value of passthroughValues) {
            const { frames, Probe } = makeProbe();
            const localRoot = createRoot(document.createElement('div'));
            act(() => localRoot.render(createElement(Probe, { value })));
            // 首幀（第 0 項）就是原值，而不是先 undefined 再補一幀。
            expect(frames[0]).toBe(value);
            act(() => localRoot.unmount());
        }

        // 非令牌 → 非令牌切換：變化的那一幀就已經是新值，不吐上一個值的滯後幀。
        const { frames, Probe } = makeProbe();
        act(() => root.render(createElement(Probe, { value: TINY_PNG_A })));
        expect(frames[0]).toBe(TINY_PNG_A);
        const framesBeforeSwitch = frames.length;
        act(() => root.render(createElement(Probe, { value: 'https://example.com/a.png' })));
        expect(frames.length).toBeGreaterThan(framesBeforeSwitch);
        for (const frame of frames.slice(framesBeforeSwitch)) {
            expect(frame).toBe('https://example.com/a.png');
        }
    });

    it('builtin-room-asset:// 令牌首幀就解析成當前部署的內置資源 URL', () => {
        const { frames, Probe } = makeProbe();
        const portable = 'builtin-room-asset://forest-cottage/assets/chair.png';
        // 獨立算一份期望值：BASE_URL 拼在頁面 origin 下，再掛 room-templates 路徑。
        const appBase = new URL((import.meta as any).env?.BASE_URL || '/', window.location.href);
        const expected = new URL('room-templates/forest-cottage/assets/chair.png', appBase).href;

        act(() => root.render(createElement(Probe, { value: portable })));
        expect(frames[0]).toBe(expected);
    });
});
