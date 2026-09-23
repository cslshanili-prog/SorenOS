/**
 * 電話 App 淺色主題：作用域 CSS 覆蓋層。
 *
 * CallApp 的深色皮膚散落在幾百處 Tailwind 工具類裡（text-white/xx、
 * bg-black/xx、border-white/xx…），逐處改成條件 class 不現實。這裡按
 * 「同一透明度、翻轉基色」的規則生成一層 `.sully-call-light` 作用域覆蓋：
 *   · 白字 → 墨色（深紫灰），白玻璃面板 → 墨色淡染，黑玻璃膠囊 → 白玻璃；
 *   · `.sully-stage-dark` 子樹（視頻舞台 / Live2D 設置面板 / 導入遮罩）
 *     成對生成還原規則，保持視頻畫面的深色質感；
 *   · 實色按鈕（accent/綠/紅底）標 `.keep-white` 強制白字。
 */

const INK = '38,34,57'; // #262239 深紫灰墨色

const rules: string[] = [];

/** 生成一對規則：淺色覆蓋 + 舞台子樹還原。 */
const pair = (selector: string, lightDecl: string, darkDecl: string): void => {
  rules.push(`.sully-call-light ${selector}{${lightDecl} !important}`);
  rules.push(`.sully-call-light .sully-stage-dark ${selector}{${darkDecl} !important}`);
};

// ── 文字：白 → 墨（低透明度略抬高保證可讀） ──
pair('.text-white', 'color:#262239', 'color:#fff');
// 根容器自己就掛著 text-white（後代選擇器夠不到自身），補一條複合選擇器
rules.push('.sully-call-light.text-white{color:#262239 !important}');
for (const alpha of [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30]) {
  const lightAlpha = Math.min(1, alpha / 100 + 0.08).toFixed(2);
  pair(`.text-white\\/${alpha}`, `color:rgba(${INK},${lightAlpha})`, `color:rgba(255,255,255,${alpha / 100})`);
}

// ── 邊框：白描邊 → 墨描邊（略加深，淺底上太淡會消失） ──
for (const alpha of [8, 10, 12, 15, 20]) {
  pair(`.border-white\\/${alpha}`, `border-color:rgba(${INK},${((alpha / 100) * 1.5).toFixed(3)})`, `border-color:rgba(255,255,255,${alpha / 100})`);
}

// ── 白玻璃面板（bg-white/[0.0x] 微提亮）→ 墨色微染 ──
for (const alpha of ['0.03', '0.035', '0.04', '0.05', '0.06', '0.07', '0.08']) {
  const escaped = alpha.replace('.', '\\.');
  pair(`.bg-white\\/\\[${escaped}\\]`, `background-color:rgba(${INK},${(parseFloat(alpha) * 1.3).toFixed(3)})`, `background-color:rgba(255,255,255,${alpha})`);
}
for (const alpha of [8, 10, 12, 15, 40]) {
  pair(`.bg-white\\/${alpha}`, `background-color:rgba(${INK},${(alpha / 100).toFixed(2)})`, `background-color:rgba(255,255,255,${alpha / 100})`);
}
// 星星點綴用的純白圓點
pair('.bg-white', `background-color:rgba(${INK},0.75)`, 'background-color:#fff');

// ── 黑玻璃膠囊/工具條 → 白玻璃；模態遮罩保持暗但減淡 ──
pair('.bg-black\\/20', 'background-color:rgba(255,255,255,0.6)', 'background-color:rgba(0,0,0,0.2)');
pair('.bg-black\\/30', 'background-color:rgba(255,255,255,0.62)', 'background-color:rgba(0,0,0,0.3)');
pair('.bg-black\\/35', 'background-color:rgba(255,255,255,0.66)', 'background-color:rgba(0,0,0,0.35)');
pair('.bg-black\\/40', 'background-color:rgba(255,255,255,0.7)', 'background-color:rgba(0,0,0,0.4)');
pair('.bg-black\\/60', `background-color:rgba(${INK},0.3)`, 'background-color:rgba(0,0,0,0.6)');
pair('.bg-black\\/70', `background-color:rgba(${INK},0.34)`, 'background-color:rgba(0,0,0,0.7)');

// ── 輸入框佔位符 ──
for (const alpha of [30, 35]) {
  rules.push(`.sully-call-light .placeholder\\:text-white\\/${alpha}::placeholder{color:rgba(${INK},0.42) !important}`);
}

// ── 玫紅系（掛斷/刪除/錯誤）淺底上換成深玫紅 ──
pair('.text-rose-200', 'color:#be123c', 'color:#fecdd3');
pair('.text-rose-300', 'color:#e11d48', 'color:#fda4af');
pair('.text-rose-300\\/90', 'color:#e11d48', 'color:rgba(253,164,175,0.9)');
pair('.text-rose-300\\/80', 'color:rgba(225,29,72,0.85)', 'color:rgba(253,164,175,0.8)');
pair('.text-rose-300\\/65', 'color:rgba(225,29,72,0.7)', 'color:rgba(253,164,175,0.65)');

// 實色底按鈕（accent/綠/紅）不論主題都要白字
rules.push('.sully-call-light .keep-white{color:#fff !important}');
rules.push('.sully-call-light{color-scheme:light}');

export const CALL_LIGHT_THEME_CSS = rules.join('\n');
