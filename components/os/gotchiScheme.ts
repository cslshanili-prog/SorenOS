// 界面風格方案 —— tamagotchi（電子寵物）與 mobilegame（手遊風）兩套桌面皮膚共用。
// 每個方案 = { 色相 hue, 明暗 dark, 金線 gold, 壓飽和 mute }，各皮膚用自己的
// makeVars 把它推導成整套 CSS 變量（角色 S/L 定死只轉色相，任何 hue 都和諧）。

export type TgStyle = { id: string; name: string; hue: number; dark: boolean; gold: boolean; mute: boolean };

export const SCHEMES: TgStyle[] = [
    { id: 'nebula', name: '星雲紫', hue: 262, dark: true, gold: false, mute: false },
    { id: 'cream', name: '奶油白', hue: 38, dark: false, gold: true, mute: false },
    { id: 'blackgold', name: '暗夜黑金', hue: 45, dark: true, gold: true, mute: true },
    { id: 'mint', name: '薄荷青', hue: 168, dark: false, gold: false, mute: false },
    { id: 'sakura', name: '粉櫻夢', hue: 340, dark: false, gold: false, mute: false },
    { id: 'abyss', name: '深海藍', hue: 218, dark: true, gold: false, mute: false },
    { id: 'peach', name: '蜜桃汽水', hue: 25, dark: false, gold: false, mute: false },
    { id: 'aurora', name: '極光青', hue: 185, dark: true, gold: false, mute: false },
    { id: 'silver', name: '月霧銀', hue: 240, dark: false, gold: false, mute: true },
    { id: 'rose', name: '薔薇夜', hue: 350, dark: true, gold: false, mute: false },
    { id: 'matcha', name: '抹茶拿鐵', hue: 105, dark: false, gold: false, mute: false },
    { id: 'graphite', name: '曜夜銀', hue: 250, dark: true, gold: false, mute: true },
];

export const hsl = (h: number, s: number, l: number, a?: number) => {
    const hh = ((h % 360) + 360) % 360;
    return a === undefined ? `hsl(${hh}, ${s}%, ${l}%)` : `hsla(${hh}, ${s}%, ${l}%, ${a})`;
};

// 面板小預覽用：方案的底色 / 線色
export const schemePreview = (s: TgStyle) => ({
    bg: s.dark ? hsl(s.hue, s.mute ? 10 : 26, 14) : hsl(s.hue, s.mute ? 10 : 50, 92),
    line: s.gold ? (s.dark ? hsl(45, 48, 64) : hsl(43, 42, 56)) : hsl(s.hue, s.mute ? 12 : 45, s.dark ? 74 : 62),
});
