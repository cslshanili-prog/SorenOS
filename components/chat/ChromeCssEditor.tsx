import React, { useEffect, useRef, useState } from 'react';
import { DB } from '../../utils/db';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { readShareText } from '../../utils/pngShare';
import { FileOrImageImport } from '../share/FileOrImageImport';

// 聊天「白框」自定義 CSS 編輯器（Appearance 全局默認 與 單角色定製 共用）。
// 選擇器鉤子覆蓋頂欄、輸入欄、整屏背景與普通消息佈局；完整清單見下方 AI_PROMPT。

const PRESET_STORE_KEY = 'sully_chrome_css_presets_v1';

// 丟給別的 AI 的提示詞（讓它按想要的風格生成整段 CSS）。
const AI_PROMPT = `你是一個 CSS 設計師。我在用一個叫 Soren 的「瀏覽器裡的虛擬手機」聊天 App，
它允許我用一段自定義 CSS 來重新設計聊天外殼與消息佈局。
這段 CSS 會被注入到聊天界面裡，通過下面這些固定類名生效。請幫我寫一整段 CSS，
實現我想要的風格——你有很高的自由度，不要只改顏色，可以大膽重構整個頂欄的視覺。

【可用的類名（只能用這些，別用全局選擇器）】
- .sully-chat-root      整個聊天屏（最外層背景）
- .sully-chat-header    頂欄整塊（已是 position: relative，可在內部絕對定位子元素）
- .sully-chat-back      左側返回箭頭按鈕
- .sully-chat-avatar    角色頭像（默認圓形 img，可改尺寸/形狀/位置/遮罩）
- .sully-chat-name      角色名字
- .sully-chat-status    名字旁/下的在線狀態區
- .sully-chat-buffs     情緒狀態欄容器；其中每個情緒膠囊是 .sully-chat-buffs button
- .sully-chat-token     右上角 token 用量小標籤
- .sully-chat-trigger   右側「觸發 AI」的小閃電按鈕
- .sully-chat-inputbar  底部輸入欄整塊
- .sully-chat-composer 輸入欄內的輸入行（建議用此類名，不依賴子元素序號）
- .sully-chat-input-wrap / .sully-chat-textarea 輸入框外殼 / 文本輸入框
- .sully-chat-actions-button / .sully-chat-send-button 功能按鈕 / 發送按鈕
- .sully-chat-emoji-suggestions 表情聯想區（輸入欄外的獨立同級區域）
- .sully-chat-auto-reply 自動回覆倒計時（輸入欄外的獨立同級區域）
- .sully-chat-panel     點「＋」拉起的功能面板（表情/動作菜單），其中按鈕是 .sully-chat-panel button
- .sully-chat-message   普通消息整行；同時帶 -ai / -user 和 -group-first / -group-last 狀態類
- .sully-chat-message-content 該條消息的氣泡列
- .sully-chat-message-avatar  默認貼在組末氣泡旁的頭像
- .sully-chat-turn-avatar-slot 每組首條的頭像槽（默認 display:none，內部已有正確的雙方頭像）
- .sully-chat-turn-avatar      上述頭像槽裡的頭像容器；圖片是 .sully-chat-message-avatar-img
- .sully-bubble-ai / .sully-bubble-user 角色 / 用戶氣泡
- .sully-schedule-change      角色修改未來日程後浮出的整張回執
- .sully-schedule-change-head / -mark / -kicker  回執標題行 / 勾選標記 / 標題文字
- .sully-schedule-change-list / -row             修改列表 / 單條修改
- .sully-schedule-change-time / -before / -arrow / -after  時段 / 原計劃 / 箭頭 / 新計劃
- .sully-schedule-change-shine                    掠過回執的一次性高光

【必須遵守的規範】
1. 覆蓋默認樣式必須加 !important（尤其 .sully-chat-buffs button 帶內聯樣式，不加 !important 蓋不掉）。
2. 只允許使用上面的 .sully-chat-* / .sully-bubble-* / .sully-schedule-change* 選擇器及其後代/偽元素，禁止寫 body、*、div、html 這類全局選擇器（會汙染其它界面）。
3. 這是移動端窄屏（寬約 390px），尺寸請克制、用相對單位或小數值。
4. 頂欄頂部已自動留出狀態欄安全區。裝飾若要貼最頂部，用 top: calc(var(--safe-top) + 數值)。
5. 不要 display:none 掉 .sully-chat-back（否則用戶無法返回），除非我明確要求。
6. 想讓裝飾溢出到頂欄外（如垂下的掛飾、超出的波浪），需給 .sully-chat-header 加 overflow: visible。
7. 性能：可以用靜態 backdrop-filter/blur，但不要對 blur/backdrop 做持續動畫。
8. 若要“每輪頭像在氣泡上方”：顯示 .sully-chat-turn-avatar-slot、隱藏 .sully-chat-message-avatar，
   給 .sully-chat-message-group-first 留出頂部空間，並清零 .sully-chat-message-content 的左右 margin。

【可以自由發揮的部分】
- 背景：純色、漸變、重複圖案、圖片（background: url(圖片直鏈)）、多層疊加，隨意。
- 形狀：border-radius、clip-path（不規則切角/波浪）任意；不規則形狀不必額外墊白底。
- 質感：box-shadow、inset 陰影、發光、描邊。
- 頭像：加邊框、光環、改大小/形狀（甚至異形/橫幅）。
- 文字：字色、字重、字間距、文字陰影/發光。
- 情緒膠囊 / token / 面板按鈕：背景色、字色、邊框、圓角。
- 重新佈局：用 position: absolute 把頭像/名字/閃電/token 擺到頂欄裡的任意位置。
- 裝飾元素：用 ::before / ::after 加角標、條紋、圖標、掛件、光帶等（記得寫 content 和 position）。
- 動畫：可用 @keyframes + animation（適度、別太晃眼）。

【輸出要求】
直接輸出一整段可用的 CSS（可以帶少量註釋說明），不需要長篇解釋。
我現在想要的風格是：______（在這裡填你的需求，例如「賽博朋克霓虹」「和風溫泉」「Y2K 千禧辣妹」「極簡性冷淡」等）`;

type Preset = { name: string; code: string; swatch?: string };

// 從一段 CSS 裡盡力摳出 .sully-chat-header 的背景值，給「我的預設」生成縮略色塊（摳不到則用中性灰）。
const extractSwatch = (code: string): string => {
    const block = code.match(/\.sully-chat-header\s*\{([^}]*)\}/);
    const body = block ? block[1] : code;
    const m = body.match(/background(?:-color)?\s*:\s*([^;!]+)/i);
    const val = m ? m[1].trim() : '';
    return val && !/url\(/i.test(val) ? val : '#e2e8f0';
};

// 內置完整風格（點擊=替換文本框、立刻生效）。
const PRESETS: Preset[] = [
    {
        name: '奶油少女',
        swatch: 'linear-gradient(135deg,#ffe3ef,#fff2e2 55%,#f1e7ff)',
        code: `/* 奶油少女 */
.sully-chat-header{
  background:linear-gradient(135deg,#ffe3ef,#fff2e2 55%,#f1e7ff)!important;
  border-bottom:none!important;
  box-shadow:0 6px 18px rgba(214,160,180,.18);
  border-radius:0 0 22px 22px;
}
.sully-chat-name{color:#c2587f!important;}
.sully-chat-avatar{border:2px solid #ffb8d4!important;box-shadow:0 0 0 4px rgba(255,184,212,.25)!important;}
.sully-chat-buffs button{background:#fff0f6!important;color:#d6478b!important;border-color:#ffc6df!important;}
.sully-chat-trigger{color:#e86aa6!important;}
.sully-chat-token{background:#fff0f6!important;color:#c76aa0!important;border-color:#ffd4e6!important;}`,
    },
    {
        name: '霓虹夜',
        swatch: 'radial-gradient(circle at 30% 30%,#3b1d63,#0e0b1e 75%)',
        code: `/* 霓虹夜 */
.sully-chat-header{
  background:#0e0b1e!important;
  border-bottom:1px solid rgba(168,85,247,.45)!important;
  box-shadow:0 0 26px rgba(168,85,247,.3);
}
.sully-chat-name{color:#e9d5ff!important;text-shadow:0 0 10px rgba(192,132,252,.9);}
.sully-chat-status{color:#a78bfa!important;}
.sully-chat-back,.sully-chat-trigger{color:#67e8f9!important;}
.sully-chat-avatar{border:2px solid #67e8f9!important;box-shadow:0 0 12px rgba(103,232,249,.6)!important;}
.sully-chat-buffs button{background:rgba(103,232,249,.12)!important;color:#a5f3fc!important;border-color:rgba(103,232,249,.4)!important;}
.sully-chat-token{background:rgba(168,85,247,.15)!important;color:#d8b4fe!important;border-color:rgba(168,85,247,.4)!important;}`,
    },
    {
        name: '薄荷奶綠',
        swatch: 'linear-gradient(135deg,#e3f9ee,#f0fff4 60%,#e0f5ff)',
        code: `/* 薄荷奶綠 */
.sully-chat-header{
  background:linear-gradient(135deg,#e3f9ee,#f0fff4 60%,#e0f5ff)!important;
  border-bottom:none!important;
  box-shadow:0 6px 16px rgba(120,190,160,.16);
  border-radius:0 0 20px 20px;
}
.sully-chat-name{color:#2f8f6b!important;}
.sully-chat-avatar{border:2px solid #8fe0bf!important;box-shadow:0 0 0 4px rgba(143,224,191,.25)!important;}
.sully-chat-buffs button{background:#e7faf0!important;color:#22936a!important;border-color:#abe6cd!important;}
.sully-chat-trigger{color:#2bb088!important;}
.sully-chat-token{background:#e7faf0!important;color:#3a9b76!important;border-color:#bdebd6!important;}`,
    },
    {
        name: '暮光紫',
        swatch: 'linear-gradient(135deg,#3b2a63,#5a3f86 55%,#7e5aa6)',
        code: `/* 暮光紫 */
.sully-chat-header{
  background:linear-gradient(135deg,#3b2a63,#5a3f86 55%,#7e5aa6)!important;
  border-bottom:none!important;
  box-shadow:0 8px 22px rgba(80,50,130,.3);
  border-radius:0 0 18px 18px;
}
.sully-chat-name{color:#fce7ff!important;}
.sully-chat-status{color:#d6bcfa!important;}
.sully-chat-back,.sully-chat-trigger{color:#f5d0fe!important;}
.sully-chat-avatar{border:2px solid rgba(255,255,255,.7)!important;box-shadow:0 4px 14px rgba(0,0,0,.3)!important;}
.sully-chat-buffs button{background:rgba(255,255,255,.16)!important;color:#fbe8ff!important;border-color:rgba(255,255,255,.3)!important;}
.sully-chat-token{background:rgba(255,255,255,.14)!important;color:#f0e0ff!important;border-color:rgba(255,255,255,.25)!important;}`,
    },
    {
        name: '極簡白',
        swatch: 'linear-gradient(135deg,#ffffff,#f3f4f6)',
        code: `/* 極簡白 */
.sully-chat-header{background:#ffffff!important;border-bottom:1px solid #eef1f5!important;box-shadow:none!important;}
.sully-chat-name{color:#1f2937!important;}
.sully-chat-avatar{border:1.5px solid #e5e7eb!important;}
.sully-chat-buffs button{background:#f5f6f8!important;color:#6b7280!important;border-color:#e5e7eb!important;}
.sully-chat-trigger{color:#6366f1!important;}
.sully-chat-token{background:#f5f6f8!important;color:#9ca3af!important;border-color:#e5e7eb!important;}`,
    },
    {
        name: '淡紫毛絨',
        swatch: 'radial-gradient(150% 120% at 50% -30%,#ddc9ff,#c9b2f4 45%,#bda0ee)',
        code: `/* ===== 淡紫毛絨 · 溫柔風 ===== */
.sully-chat-root{
  background:
    radial-gradient(120% 80% at 18% 0%, #f4ecff 0%, transparent 58%),
    radial-gradient(120% 80% at 92% 8%, #ffe9f7 0%, transparent 52%),
    linear-gradient(180deg, #efe6ff 0%, #f6f1ff 48%, #fcf9ff 100%) !important;
}
.sully-chat-header{
  overflow:visible !important;
  background:radial-gradient(150% 120% at 50% -30%, #ddc9ff 0%, #c9b2f4 45%, #bda0ee 100%) !important;
  border:none !important;
  border-radius:0 0 24px 24px !important;
  box-shadow:inset 0 2px 6px rgba(255,255,255,.6), inset 0 -10px 20px rgba(150,108,222,.35), 0 10px 26px rgba(178,142,236,.4) !important;
}
.sully-chat-header::before{
  content:"" !important;position:absolute !important;
  top:calc(var(--safe-top) + 4px) !important;right:14px !important;
  width:60px !important;height:60px !important;border-radius:50% !important;
  background:radial-gradient(circle, rgba(255,255,255,.55) 0%, transparent 70%) !important;
  filter:blur(2px) !important;pointer-events:none !important;
}
.sully-chat-back{
  color:#8a6bc4 !important;background:rgba(255,255,255,.65) !important;border-radius:50% !important;
  box-shadow:inset 0 1px 2px rgba(255,255,255,.9), 0 2px 6px rgba(160,120,220,.35) !important;
}
.sully-chat-avatar{
  width:46px !important;height:46px !important;border-radius:50% !important;border:3px solid #fff !important;
  box-shadow:0 0 0 3px rgba(220,200,255,.75), 0 0 16px 3px rgba(200,160,245,.6), 0 4px 10px rgba(160,120,220,.45) !important;
  animation:sully-float 4.5s ease-in-out infinite !important;
}
@keyframes sully-float{0%,100%{transform:translateY(0);}50%{transform:translateY(-2.5px);}}
.sully-chat-name{color:#fff !important;font-weight:700 !important;letter-spacing:.5px !important;text-shadow:0 1px 4px rgba(135,95,205,.55), 0 0 10px rgba(255,255,255,.4) !important;}
.sully-chat-name::after{content:" ✦" !important;color:#fff3ff !important;font-size:.8em !important;text-shadow:0 0 6px rgba(255,255,255,.8) !important;}
.sully-chat-status{color:#f3ebff !important;font-size:.72rem !important;text-shadow:0 1px 2px rgba(130,90,200,.4) !important;}
.sully-chat-buffs button{
  background:rgba(255,255,255,.62) !important;color:#7a5bb0 !important;border:1.5px solid rgba(255,255,255,.85) !important;
  border-radius:999px !important;font-weight:600 !important;padding:2px 10px !important;
  box-shadow:0 2px 6px rgba(180,140,230,.3), inset 0 1px 2px rgba(255,255,255,.85) !important;backdrop-filter:blur(4px) !important;
}
.sully-chat-token{color:#8a6bc4 !important;background:rgba(255,255,255,.5) !important;border-radius:999px !important;padding:1px 8px !important;font-size:.66rem !important;box-shadow:inset 0 1px 2px rgba(255,255,255,.8) !important;}
.sully-chat-trigger{
  color:#fff !important;background:radial-gradient(circle at 35% 30%, #d9b8ff, #b98cf0) !important;border-radius:50% !important;
  box-shadow:0 0 0 2px rgba(255,255,255,.6), 0 0 14px 2px rgba(200,150,250,.7), 0 3px 8px rgba(150,100,210,.45) !important;
  animation:sully-breathe 3.2s ease-in-out infinite !important;
}
@keyframes sully-breathe{0%,100%{box-shadow:0 0 0 2px rgba(255,255,255,.6), 0 0 12px 2px rgba(200,150,250,.55), 0 3px 8px rgba(150,100,210,.45);}50%{box-shadow:0 0 0 2px rgba(255,255,255,.7), 0 0 20px 5px rgba(210,165,255,.85), 0 3px 8px rgba(150,100,210,.45);}}
.sully-chat-inputbar{
  background:linear-gradient(180deg, rgba(255,255,255,.85), rgba(245,238,255,.92)) !important;border:1.5px solid rgba(255,255,255,.9) !important;
  border-radius:22px 22px 0 0 !important;box-shadow:inset 0 2px 5px rgba(255,255,255,.9), 0 -6px 18px rgba(180,140,230,.28) !important;backdrop-filter:blur(8px) !important;
}`,
    },
    {
        name: '和風溫泉',
        swatch: 'linear-gradient(165deg,#ffe3c4,#ffd0b0 38%,#ffb9ad 62%,#f7a9b0 84%,#ef9bb0)',
        code: `/* ===== 和風溫泉・晨光湯屋 ===== */
.sully-chat-root{background:linear-gradient(180deg,#fdf3e7 0%, #fbe9da 45%, #f6e4ea 100%) !important;}
.sully-chat-header{
  overflow:visible !important;border-bottom:none !important;box-shadow:0 .3rem .9rem rgba(180,120,110,.28) !important;
  background:
    radial-gradient(circle at 100% 50%, transparent 62%, rgba(122,74,68,.07) 63% 70%, transparent 71%) 0 0 / 1.1rem 1.9rem,
    radial-gradient(circle at 0 50%,   transparent 62%, rgba(122,74,68,.07) 63% 70%, transparent 71%) .55rem -.95rem / 1.1rem 1.9rem,
    linear-gradient(165deg,#ffe3c4 0%, #ffd0b0 38%, #ffb9ad 62%, #f7a9b0 84%, #ef9bb0 100%) !important;
}
.sully-chat-header::before{
  content:"";position:absolute;left:.6rem;right:.6rem;top:calc(var(--safe-top) + .1rem);height:2.6rem;pointer-events:none;z-index:0;
  background:
    radial-gradient(42% 60% at 22% 80%, rgba(255,255,255,.55), transparent 70%),
    radial-gradient(36% 55% at 52% 85%, rgba(255,255,255,.48), transparent 70%),
    radial-gradient(34% 50% at 80% 82%, rgba(255,255,255,.42), transparent 70%);
  filter:blur(3px);opacity:0;animation:sully-steam 7s ease-in-out infinite;
}
.sully-chat-header::after{
  content:"";position:absolute;left:0;right:0;bottom:-.55rem;height:1rem;pointer-events:none;z-index:2;
  background-image:
    radial-gradient(circle at .5rem .62rem, rgba(246,178,107,.98) 0 .3rem, rgba(212,96,74,.98) .3rem .34rem, transparent .36rem),
    linear-gradient(rgba(160,100,90,.6), rgba(160,100,90,.6));
  background-size:1.5rem 100%, 100% .07rem;background-position:0 0, 0 .18rem;background-repeat:repeat-x, repeat-x;
  filter:drop-shadow(0 .15rem .25rem rgba(212,96,74,.4));
}
.sully-chat-back{color:#7d4a44 !important;background:rgba(255,255,255,.5) !important;border:.08rem solid rgba(122,74,68,.3) !important;border-radius:50% !important;box-shadow:inset 0 0 .35rem rgba(255,255,255,.6), 0 .1rem .25rem rgba(180,120,110,.25) !important;}
.sully-chat-avatar{width:2.6rem !important;height:2.6rem !important;border-radius:50% !important;border:.12rem solid #fff7ee !important;object-fit:cover !important;box-shadow:0 0 0 .16rem rgba(212,96,74,.55), 0 0 .8rem rgba(246,178,107,.7), inset 0 0 .4rem rgba(0,0,0,.18) !important;}
.sully-chat-name{position:relative;z-index:1;color:#5a3243 !important;font-weight:700 !important;letter-spacing:.06em !important;text-shadow:0 .06rem 0 rgba(255,255,255,.5) !important;}
.sully-chat-status{position:relative;z-index:1;color:#3f8f6a !important;font-size:.66rem !important;letter-spacing:.04em !important;}
.sully-chat-status::before{content:"";display:inline-block;width:.42rem;height:.42rem;margin-right:.3rem;border-radius:50%;vertical-align:middle;background:#5cc486;box-shadow:0 0 .35rem rgba(92,196,134,.85);animation:sully-pulse 2.6s ease-in-out infinite;}
.sully-chat-buffs{gap:.3rem !important;position:relative;z-index:1;}
.sully-chat-buffs button{background:linear-gradient(#ffffff, #fdeede) !important;color:#8a4a44 !important;border:.07rem solid rgba(122,74,68,.4) !important;border-radius:.7rem !important;font-size:.66rem !important;font-weight:600 !important;letter-spacing:.02em !important;padding:.16rem .5rem !important;box-shadow:0 .1rem .25rem rgba(180,120,110,.3), inset 0 .05rem 0 rgba(255,255,255,.8) !important;}
.sully-chat-token{color:#6a3d38 !important;background:linear-gradient(#ffffff, #fbeede) !important;border:.06rem solid rgba(122,74,68,.35) !important;border-radius:.5rem !important;font-size:.62rem !important;letter-spacing:.02em !important;box-shadow:0 .1rem .25rem rgba(180,120,110,.28) !important;}
.sully-chat-trigger{color:#fff5e8 !important;background:radial-gradient(circle at 30% 30%, #f6b26b, #e0664a 72%) !important;border:.1rem solid rgba(255,255,255,.7) !important;border-radius:50% !important;animation:sully-ember 3.2s ease-in-out infinite;}
.sully-chat-inputbar{background:linear-gradient(180deg,#fff6ea,#ffece0) !important;border-top:.12rem solid rgba(212,96,74,.4) !important;border-radius:.9rem .9rem 0 0 !important;box-shadow:0 -.3rem .7rem rgba(180,120,110,.22), inset 0 .08rem 0 rgba(255,255,255,.7) !important;}
@keyframes sully-steam{0%{opacity:0;transform:translateY(.4rem) scaleY(.9);}50%{opacity:.5;}100%{opacity:0;transform:translateY(-.5rem) scaleY(1.12);}}
@keyframes sully-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.5;transform:scale(.82);}}
@keyframes sully-ember{0%,100%{box-shadow:0 0 .5rem rgba(224,102,74,.6), inset 0 .1rem .2rem rgba(255,255,255,.35);}50%{box-shadow:0 0 .9rem rgba(246,178,107,.95), inset 0 .1rem .2rem rgba(255,255,255,.4);}}`,
    },
];

// 自定義預設存 IndexedDB（STORE_ASSETS，隨 app 備份/導出一起走）；舊 localStorage 自動一次性遷移過來。
const PRESET_ASSET_KEY = 'chrome_css_presets';

const loadCustom = async (): Promise<Preset[]> => {
    try { const fromDb = await DB.getAssetRaw(PRESET_ASSET_KEY); if (Array.isArray(fromDb)) return fromDb; } catch { /* ignore */ }
    // 遷移舊 localStorage → IndexedDB
    try {
        const raw = localStorage.getItem(PRESET_STORE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr) && arr.length) { await DB.saveAssetRaw(PRESET_ASSET_KEY, arr); localStorage.removeItem(PRESET_STORE_KEY); return arr; }
    } catch { /* ignore */ }
    return [];
};
const persistCustom = async (list: Preset[]) => { try { await DB.saveAssetRaw(PRESET_ASSET_KEY, list); } catch { /* ignore */ } };

// 導出碼：SULLYCSS1: + base64(utf8(JSON))，方便整段複製分享/換機帶走。
const encodePresets = (list: Preset[]): string => 'SULLYCSS1:' + btoa(unescape(encodeURIComponent(JSON.stringify(list))));
const decodePresets = (code: string): Preset[] => {
    const body = code.trim().replace(/^SULLYCSS1:/, '');
    const json = decodeURIComponent(escape(atob(body)));
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((p: any) => p && typeof p.name === 'string' && typeof p.code === 'string') : [];
};

const copyText = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
};

const ChromeCssEditor: React.FC<{ value: string; onChange: (css: string) => void }> = ({ value, onChange }) => {
    const [copied, setCopied] = useState(false);
    const [custom, setCustom] = useState<Preset[]>([]);
    const presetImageRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let alive = true;
        loadCustom().then((list) => { if (alive) setCustom(list); });
        return () => { alive = false; };
    }, []);

    const commitCustom = (next: Preset[]) => { setCustom(next); persistCustom(next); };

    const handleCopyPrompt = async () => {
        if (await copyText(AI_PROMPT)) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    };
    const handleSavePreset = () => {
        if (!value.trim() || typeof window === 'undefined') return;
        const name = window.prompt('給這套裝扮 CSS 預設起個名字（所有角色通用）：', '我的預設')?.trim();
        if (!name) return;
        commitCustom([...custom.filter((p) => p.name !== name), { name, code: value }]);
    };
    const handleDeletePreset = (name: string) => commitCustom(custom.filter((p) => p.name !== name));

    const handleTxtImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const css = (await readShareText(file, 'chrome-css')).replace(/^\uFEFF/, '');
            if (!css.trim()) {
                window.alert('TXT 文件內容為空。');
                return;
            }
            onChange(css);
        } catch (error: any) {
            window.alert(error?.message || '樣式導入失敗，請確認文件可以正常讀取。');
        } finally {
            event.target.value = '';
        }
    };

    const handleTxtExport = async () => {
        if (!value.trim()) {
            window.alert('當前沒有可導出的 CSS。');
            return;
        }
        const date = new Date();
        const dateKey = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const fileName = `sullyos-whitebox-${dateKey}.txt`;
        try {
            await shareOrDownloadFile({
                card: { kind: 'chrome-css', title: '白框樣式' },
                content: value,
                fileName,
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: 'Soren 白框樣式',
            });
        } catch (error: any) {
            if (error?.name !== 'AbortError') window.alert('TXT 導出失敗，請重試。');
        }
    };

    const handleExport = async () => {
        if (!custom.length) { window.alert('還沒有「我的預設」可導出。'); return; }
        const ok = await copyText(encodePresets(custom));
        window.alert(ok ? `已複製 ${custom.length} 套預設的導出碼到剪貼板，發給別人或換機粘貼導入即可。` : '複製失敗，請重試。');
    };
    const handleImport = () => {
        if (typeof window === 'undefined') return;
        const code = window.prompt('粘貼預設導出碼（SULLYCSS1:...）：', '')?.trim();
        if (!code) return;
        importPresetCode(code);
    };
    const importPresetCode = (code: string) => {
        let incoming: Preset[] = [];
        try { incoming = decodePresets(code); } catch { window.alert('導出碼無法識別，請確認完整粘貼。'); return; }
        if (!incoming.length) { window.alert('沒解析到有效預設。'); return; }
        // 同名覆蓋，其餘追加
        const map = new Map(custom.map((p) => [p.name, p] as const));
        incoming.forEach((p) => map.set(p.name, p));
        commitCustom(Array.from(map.values()));
        window.alert(`已導入 ${incoming.length} 套預設。`);
    };

    const cardCls = 'group relative h-14 w-[78px] shrink-0 overflow-hidden rounded-xl border border-black/5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-95';
    const cardLabelCls = 'absolute inset-x-0 bottom-0 truncate px-1.5 py-1 text-[10px] font-bold text-white';

    return (
        <div className="space-y-4">
            {/* 需要靈感：複製提示詞給 AI */}
            <button onClick={handleCopyPrompt}
                className="flex w-full items-center gap-2.5 rounded-2xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-violet-50 px-3.5 py-3 text-left transition-all hover:from-indigo-100 hover:to-violet-100 active:scale-[0.99]">
                <span className="text-lg leading-none">{copied ? '✓' : '🪄'}</span>
                <span className="min-w-0">
                    <span className="block text-[12px] font-bold text-indigo-700">{copied ? '已複製！丟給任意 AI 即可' : '讓 AI 幫你寫一套'}</span>
                    <span className="block text-[10px] leading-snug text-indigo-400">複製提示詞 → 發給任何 AI，說出你想要的風格，把它給的 CSS 粘回來</span>
                </span>
            </button>

            {/* 內置風格：縮略色塊卡片 */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">內置風格 <span className="font-normal text-slate-400">· 點一下套用</span></div>
                <div className="flex flex-wrap gap-2">
                    {PRESETS.map((p) => (
                        <button key={p.name} onClick={() => onChange(p.code)} title={p.name} className={cardCls}>
                            <span className="absolute inset-0" style={{ background: p.swatch }} />
                            <span className={cardLabelCls} style={{ background: 'linear-gradient(to top, rgba(0,0,0,.5), transparent)' }}>{p.name}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* 我的預設：全角色通用，存 IndexedDB（隨備份走），可導入導出 */}
            <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
                    <span className="text-[11px] font-bold text-slate-500">我的預設 <span className="font-normal text-slate-400">· 全角色通用</span></span>
                    <div className="flex items-center gap-1">
                        <input ref={presetImageRef} type="file" accept=".png,.txt,image/png,text/plain" hidden onChange={async event => {
                            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
                            try { importPresetCode(await readShareText(file, 'chrome-presets')); }
                            catch (error: any) { window.alert(error?.message || '預設導入失敗'); }
                        }} />
                        <button onClick={() => presetImageRef.current?.click()} className="rounded-md px-2 py-1 text-[10px] font-semibold text-indigo-500">圖片導入</button>
                        <button disabled={!custom.length} onClick={async () => {
                            try { await shareOrDownloadFile({ content: encodePresets(custom), fileName: '白框預設集.txt', mimeType: 'text/plain', card: { kind: 'chrome-presets', title: '白框預設集' } }); }
                            catch (error: any) { window.alert(error?.message || '預設導出失敗'); }
                        }} className="rounded-md px-2 py-1 text-[10px] font-semibold text-indigo-500 disabled:opacity-30">圖片分享</button>
                        <button onClick={handleImport} className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600">導入</button>
                        <button onClick={handleExport} disabled={!custom.length} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${custom.length ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-slate-300'}`}>導出</button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {custom.map((p) => (
                        <div key={p.name} className={cardCls}>
                            <button onClick={() => onChange(p.code)} title={p.name} className="absolute inset-0">
                                <span className="absolute inset-0" style={{ background: extractSwatch(p.code) }} />
                                <span className={cardLabelCls} style={{ background: 'linear-gradient(to top, rgba(0,0,0,.5), transparent)' }}>{p.name}</span>
                            </button>
                            <button onClick={() => handleDeletePreset(p.name)} title="刪除"
                                className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/45 text-[10px] leading-none text-white opacity-80 hover:bg-rose-500">×</button>
                        </div>
                    ))}
                    {/* 保存當前為預設 */}
                    <button onClick={handleSavePreset} disabled={!value.trim()} title={value.trim() ? '把當前 CSS 存為預設' : '先寫點 CSS'}
                        className={`flex h-14 w-[78px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed text-[10px] font-bold transition-all active:scale-95 ${value.trim() ? 'border-emerald-300 text-emerald-600 hover:bg-emerald-50' : 'border-slate-200 text-slate-300'}`}>
                        <span className="text-lg leading-none">＋</span>存當前
                    </button>
                </div>
            </div>

            {/* CSS 代碼區 */}
            <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-500">CSS 代碼 <span className="font-normal text-slate-400">· 可手改 / 粘貼</span></span>
                    <div className="flex items-center gap-1">
                        <FileOrImageImport onChange={handleTxtImport} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-500 hover:bg-indigo-50" />
                        <button onClick={handleTxtExport} disabled={!value.trim()} className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${value.trim() ? 'text-indigo-500 hover:bg-indigo-50' : 'text-slate-300'}`}>導出分享</button>
                        {value && <button onClick={() => onChange('')} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-rose-400 hover:bg-rose-50 hover:text-rose-500">清空</button>}
                    </div>
                </div>
                <textarea
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={'/* 點上面任一套，或在這裡直接寫 / 粘貼 CSS */\n.sully-chat-header{\n  background: linear-gradient(135deg,#ffe3ef,#f1e7ff) !important;\n  border-bottom: none !important;\n}'}
                    spellCheck={false}
                    rows={8}
                    className="w-full resize-y rounded-2xl border border-slate-700 bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-200 outline-none focus:border-primary/50 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                />
                <div className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                    可用選擇器：<code className="rounded bg-slate-100 px-1 text-slate-500">.sully-chat-header / -avatar / -name / -buffs / -token / -trigger / -back / -status / -inputbar / -panel / -root</code>
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    日程修改動效：<code className="rounded bg-slate-100 px-1 text-slate-500">.sully-schedule-change / -head / -mark / -kicker / -list / -row / -time / -before / -arrow / -after / -shine</code>
                </div>
            </div>
        </div>
    );
};

export default ChromeCssEditor;
