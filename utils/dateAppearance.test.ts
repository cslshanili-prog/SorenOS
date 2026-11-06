import { describe, expect, it } from 'vitest';
import { buildDateAppearanceCss, resolveDateBackdrop, resolveDateColors, resolveDateFontSize, scopeDateCss } from './dateAppearance';

describe('scopeDateCss', () => {
    it('每條選擇器都限定在 .date-root 裡', () => {
        expect(scopeDateCss('.date-line-dialogue{color:red}')).toBe('.date-root .date-line-dialogue{color:red}');
        expect(scopeDateCss('p, .a > .b{margin:0}')).toBe('.date-root p, .date-root .a > .b{margin:0}');
        expect(scopeDateCss('.date-root{background:#000}')).toBe('.date-root{background:#000}');
        expect(scopeDateCss('.date-root.date-theme-light .date-line{color:#333}')).toBe('.date-root.date-theme-light .date-line{color:#333}');
    });

    it(':root / html / body 當成見面畫面本身', () => {
        expect(scopeDateCss(':root{--x:1}')).toBe('.date-root{--x:1}');
        expect(scopeDateCss('body .date-line{color:red}')).toBe('.date-root .date-line{color:red}');
        expect(scopeDateCss('html body > .date-reading{color:red}')).toBe('.date-root > .date-reading{color:red}');
        expect(scopeDateCss('html.dark .x{color:red}')).toBe('.date-root.dark .x{color:red}');
        expect(scopeDateCss('bodyish{color:red}')).toBe('.date-root bodyish{color:red}');
    });

    it('@media 往裡限定，@keyframes／@font-face 原樣', () => {
        expect(scopeDateCss('@media (max-width: 400px){.a{color:red}.b,.c{color:blue}}'))
            .toBe('@media (max-width: 400px){.date-root .a{color:red}.date-root .b, .date-root .c{color:blue}}');
        expect(scopeDateCss('@keyframes glow{from{opacity:0}to{opacity:1}}')).toBe('@keyframes glow{from{opacity:0}to{opacity:1}}');
        expect(scopeDateCss("@font-face{font-family:x;src:url('a{b}.woff')}")).toBe("@font-face{font-family:x;src:url('a{b}.woff')}");
        expect(scopeDateCss("@import url('x.css');.a{color:red}")).toBe("@import url('x.css');.date-root .a{color:red}");
    });

    it('字串、屬性選擇器、:is() 裡的逗號不拆；註解拿掉', () => {
        expect(scopeDateCss('.a:is(.b, .c){content:"x, {y}"}')).toBe('.date-root .a:is(.b, .c){content:"x, {y}"}');
        expect(scopeDateCss('[data-x="a,b"]{color:red}')).toBe('.date-root [data-x="a,b"]{color:red}');
        expect(scopeDateCss('/* body{} */\n.a{color:red}')).toBe('.date-root .a{color:red}');
        expect(scopeDateCss('')).toBe('');
        expect(scopeDateCss(undefined)).toBe('');
    });

    it('沒關好的大括號不會吃掉後面、也不會丟錯', () => {
        expect(() => scopeDateCss('.a{color:red')).not.toThrow();
        expect(scopeDateCss('.a{color:red').startsWith('.date-root .a{')).toBe(true);
    });
});

describe('字級、字色、遮罩', () => {
    it('字級夾在範圍內，用戶小兩級', () => {
        expect(resolveDateFontSize(undefined)).toBeUndefined();
        expect(resolveDateFontSize({ fontSize: 40 })).toBe(24);
        expect(resolveDateFontSize({ fontSize: 3 })).toBe(14);
        const css = buildDateAppearanceCss({ fontSize: 20 }, false);
        expect(css).toContain('.date-root .date-line{font-size:20px;}');
        expect(css).toContain('.date-root .date-line-user{font-size:18px;}');
    });

    it('字色深淺各記各的，不合法的色值不用', () => {
        const a = { colors: { light: { dialogue: '#111111' }, dark: { narration: '#abc', dialogue: 'red;}body{x' } } };
        expect(resolveDateColors(a, true)).toEqual({ dialogue: '#111111', narration: undefined });
        expect(resolveDateColors(a, false)).toEqual({ dialogue: undefined, narration: '#abc' });
        expect(buildDateAppearanceCss(a, false)).toBe('.date-root .date-line-narration{color:#abc;}');
        expect(buildDateAppearanceCss(undefined, true)).toBe('');
    });

    it('遮罩沒設照原本的樣子；設了底圖清楚、遮罩照濃度', () => {
        expect(resolveDateBackdrop(undefined, false)).toEqual({ backgroundOpacity: 0.3, backgroundBlur: true });
        expect(resolveDateBackdrop({ backgroundDim: 40, backgroundBlur: false }, false)).toEqual({ backgroundOpacity: 1, backgroundBlur: false, overlayColor: 'rgba(0, 0, 0, 0.4)' });
        expect(resolveDateBackdrop({ backgroundDim: 150 }, true)).toEqual({ backgroundOpacity: 1, backgroundBlur: true, overlayColor: 'rgba(250, 248, 245, 1)' });
    });
});
