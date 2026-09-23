/// <reference types="vitest" />
/**
 * utils/iosStandalone.keyboard.test.ts — 鍵盤態佈局的迴歸守衛。
 *
 * 背景：iOS 全屏 PWA 下 body 高度會比可視區多出一段底部安全區（給 home 條留位），
 * `.ios-keyboard-open` 一掛，外殼就鋪到那段溢出區、聊天輸入欄同時收掉自己的讓位間隙。
 * 兩個動作合起來淨位移為 0，前提是「標記掛上」和「app 高度收到鍵盤上方」同時發生。
 * 只要有一邊先動，輸入條就整條沉出屏幕、home 條騎到輸入框上。
 *
 * 這裡釘住的不變式：鍵盤態只認 visualViewport 真的變矮，不認焦點事件。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SCREEN_H = 852; // 豎屏可視高度
const SAFE_BOTTOM = 34; // home 條安全區
const SAFE_TOP = 44;
const KEYBOARD_H = 336;

type Listener = () => void;
let vvListeners: Record<string, Listener[]>;
let visualViewport: { height: number; offsetTop: number; addEventListener: (t: string, fn: Listener) => void; removeEventListener: () => void };

const setupIOSStandalone = () => {
    vvListeners = { resize: [], scroll: [] };
    visualViewport = {
        height: SCREEN_H,
        offsetTop: 0,
        addEventListener: (type: string, fn: Listener) => { (vvListeners[type] ||= []).push(fn); },
        removeEventListener: () => {},
    };
    Object.defineProperty(window, 'visualViewport', { value: visualViewport, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: SCREEN_H, configurable: true, writable: true });
    Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
        configurable: true,
    });
    window.matchMedia = ((query: string) => ({
        matches: query.includes('standalone'),
        media: query,
        onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    window.scrollTo = vi.fn() as typeof window.scrollTo;

    // jsdom 不認 env()，安全區探針會讀到 0，那段 34px 溢出區就不存在、用例也就測不到錯位。
    // 認出探針（fixed + hidden 的臨時 div）後返回真機數值，其餘元素照常走 jsdom。
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element, pseudo?: string | null) => {
        const style = (el as HTMLElement).style;
        if (style?.position === 'fixed' && style?.visibility === 'hidden') {
            return { paddingTop: `${SAFE_TOP}px`, paddingBottom: `${SAFE_BOTTOM}px` } as CSSStyleDeclaration;
        }
        return realGetComputedStyle(el as Element, pseudo as string | undefined);
    }) as typeof window.getComputedStyle);
};

/** 重新加載模塊再裝載，繞開「只裝一次」的單例標誌，順帶清掉基線高度等模塊級狀態。 */
const install = async () => {
    vi.resetModules();
    const mod = await import('./iosStandalone');
    mod.installIOSStandaloneWorkaround();
    return mod;
};

const emitViewportResize = (height: number) => {
    visualViewport.height = height;
    vvListeners.resize.forEach(fn => fn());
};

const focusTextarea = () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    return textarea;
};

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');
const inKeyboardMode = () => document.body.classList.contains('ios-keyboard-open');

describe('iOS 全屏 PWA 鍵盤態', () => {
    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('style');
        setupIOSStandalone();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('無鍵盤時 app 高度 = 可視高度 + 底部安全區（那段溢出區留給 home 條）', async () => {
        await install();
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
        expect(inKeyboardMode()).toBe(false);
    });

    // 迴歸守衛：輸入框拿到焦點不等於鍵盤彈出來了。設備上鍵盤彈不出來時（外接鍵盤、輸入法異常），
    // 舊實現照樣掛標記，外殼鋪到那 34px 溢出區、輸入欄又收掉讓位間隙，輸入條整條沉出屏幕。
    it('焦點進來但可視區沒變矮 → 不進鍵盤態，高度不動', async () => {
        await install();
        focusTextarea();

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });

    it('可視區真的變矮 → 標記和高度一起進鍵盤態', async () => {
        await install();
        focusTextarea();
        emitViewportResize(SCREEN_H - KEYBOARD_H);

        expect(inKeyboardMode()).toBe(true);
        expect(appHeight()).toBe(`${SCREEN_H - KEYBOARD_H}px`);
    });

    // 迴歸守衛：聚焦中的輸入框被 React 卸載時（退出聊天頁），WebKit 不派發 focusout。
    // 舊實現只有 focusout 能摘標記，於是標記永久卡在 body 上，全局界面底部一直錯位。
    it('輸入框被直接移除、沒有 focusout → 鍵盤收起後標記不殘留', async () => {
        await install();
        const textarea = focusTextarea();
        emitViewportResize(SCREEN_H - KEYBOARD_H);
        expect(inKeyboardMode()).toBe(true);

        textarea.remove();
        emitViewportResize(SCREEN_H);

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });

    it('鍵盤動畫期可視高度報髒值 → 退化成無鍵盤態，不把佈局撐崩', async () => {
        await install();
        focusTextarea();
        emitViewportResize(80);

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });
});
