// HTML 模塊模式 — 內置提示詞 + [html]...[/html] 解析工具
//
// 設計目標：
// 1) AI 在適合用卡片呈現的場景（票據、邀請函、通知等）輸出 [html]...[/html] 塊；
// 2) 客戶端把這些塊從普通文本氣泡裡剝離，單獨渲染為 html_card 消息（沙盒 iframe）；
// 3) 上下文 / 歸檔 總結裡只看到剝離 HTML 後的純文字摘要，不浪費 token。

const BUILTIN_HTML_PROMPT = `

# 核心能力：HTML 模塊生成

你具備通過 HTML 生成豐富視覺模塊的能力，用來模擬手機界面裡的互動元素、情緒表達或信息卡片。

## 觸發規則（必須嚴格遵守）

每個 HTML 模塊的整體內容必須用一對 \`[html]\` 與 \`[/html]\` 標籤包裹。
\`[html]\` 與 \`[/html]\` 之間只能放 HTML（一個完整的 \`<div>\` 區塊），不要寫解釋文字。
模塊和正文文字可以同一條回覆裡出現，每個模塊就是一對 \`[html]...[/html]\`。
沒有可呈現的卡片時，不要輸出空標籤。

**【絕對禁止照抄佔位句】**：聊天歷史裡可能出現形如 \`（系統記錄：…發送過一張 HTML 卡片…）\`、\`[…發送了一張 HTML 卡片] …\` 或 \`[HTML卡片] …\` 的行。那只是系統對"已經渲染過的舊卡片"的文字佔位描述，**不是發卡片的寫法**。你絕對不要照抄、複述、模仿這種句子，也不要把卡片內容拆成一條條純文字發出來。要發一張新卡片，唯一正確的做法是輸出真正的 \`[html]<div>…</div>[/html]\`——**只有被 \`[html]\` 和 \`[/html]\` 包裹的 HTML 才會被渲染成卡片，其它任何寫法都只會變成普通文字氣泡。**

## 推薦場景

當對話中出現下面這些"可視化呈現會更帶感"的內容時，主動用一個 HTML 模塊來滿足：

* **邀請函**：聚會、活動、約會的邀請；
* **聊天記錄截圖**：回顧或展示一段（虛構的）聊天對話；
* **訂單 / 票據**：購物、點餐、電影票、機票、酒店預訂的憑證；
* **通知 / 提醒**：系統通知、日程提醒、推送、未讀小紅點；
* **小卡片**：心情卡、紙條、便利貼、貼紙…… 任何能用一張視覺小卡承載的輕量內容。

判斷何時用，按你的人設和當下氣氛決定。

## 設計約束

1. **【最高優先級】環境無關性**：無論用戶是手機或電腦，無論網絡好壞，模塊永遠輸出一個**完整、單一**的 \`<div>\` 區塊。這條規則的優先級高於一切。
2. **寬度限制**：所有模塊的總寬度不得超過 \`270px\`，必須在最外層 \`<div>\` 用內聯樣式 \`style="width: 270px;"\` 或更小寬度保證。
3. **樣式只用內聯**：所有 CSS 用 \`style="..."\` 內聯或 \`<style>\`（限制在該 div 內）。不要引外部資源（CDN、圖片鏈接、字體）。
4. **不要 \`<script>\`**：模塊內禁止任何 \`<script>\` 標籤或 \`on*\` 事件屬性。
5. **圖片處理**：模塊內不直接嵌圖片鏈接，用文字 + 樣式（emoji、CSS 形狀、漸變色塊）來模擬視覺。
6. **內容語言**：模塊內的可見文字以簡體中文為主（除非角色 / 場景設定語種另有要求）。
7. **【高度自適應，禁止內部滾動】**：卡片的容器會**按內容自動撐高**，你不需要也**不要**自己給卡片設固定高度。絕對不要在卡片上寫 \`height\` / \`max-height\` 配 \`overflow:auto\` / \`overflow:scroll\` / \`overflow-y:scroll\` 去做"卡片內部小滾動條"——那樣內容會被悶在一個小框裡要用戶上下滾，體驗很差。正確做法：
   - 讓內容自然往下排，高度交給容器自適應；
   - 內容偏多時優先**精簡文字 / 拆成兩張卡 / 用摺疊交互（\`:checked\` 展開）**，而不是塞進一個內部滾動框；
   - 整張卡儘量控制在一屏能看完的體量（高度別超過 ~600px），太長就是信息過載，刪減它。
8. **【純 CSS 交互的點擊層級】**：用 checkbox/radio + \`:checked\` 做摺疊 / 展開 / 切換時，沙盒裡**純 HTML+CSS（沒有 JS）的點擊會被上層元素"吞"掉**——只要可點的 \`<label>\` / \`<input>\` 被任何重疊的元素（絕對定位的裝飾層、漸變蒙版、偽元素 \`::before/::after\`、更高 \`z-index\` 的兄弟節點）蓋在下面，點擊就落不到它身上，交互直接失效。所以：
   - 讓可點擊的 \`<label>\` / \`<input>\` 處在**最頂層**（給它更高的 \`z-index\` 並配 \`position:relative\`），別被其它層壓住；
   - 所有**純裝飾、不需要點的覆蓋層**一律加 \`pointer-events:none\`，讓點擊穿透到下面真正的交互元素；
   - 控件用的 \`<input>\` 別 \`display:none\`（某些環境會連帶吃掉它的點擊命中區），改用視覺隱藏（如 \`position:absolute;opacity:0\` 且仍可被 \`<label>\` 命中），或直接讓整個 \`<label>\` 包住可點區域。
   - 拿不準時，優先做**靜態模塊**，別硬塞會被吞點擊的交互。

## 模塊類型參考

可以自由生成下面這些類型，也可以創造新的：

* **靜態模塊**：備忘錄、訂單截圖、通知卡、票據、紙條；
* **動態模塊**：用 CSS \`@keyframes\` 做加載條、心跳呼吸、淡入淡出；
* **交互模塊**：用 \`<input type="checkbox">\` / \`<input type="radio">\` 配 \`:checked\` 兄弟選擇器，實現摺疊 / 展開 / 選項切換（不依賴 JS）。

## 視覺審美準則（讓卡片"好看"而不是"能看"）

卡片是你氣質的延伸，寧可簡潔高級，也別堆砌花哨。按下面這些來：

* **配色克制**：一張卡只用 1 個主色調 + 1~2 個輔助色，外加中性的背景 / 文字色。優先低飽和、柔和的色系（莫蘭迪、奶油、霧霾藍粉），避免大面積高飽和原色或刺眼撞色。漸變只在背景輕輕用，角度統一（如 \`135deg\`），別做彩虹漸變。
* **留白即呼吸**：內容別貼邊。最外層 \`padding\` 給到 \`16~20px\`，元素之間用 \`margin\` 拉開層次（標題與正文、正文與落款之間都要有間距）。寧可空，不要擠。
* **建立信息層級**：用**字號 + 字重 + 透明度**三件套區分主次——主標題大而粗（\`18~22px / 700\`），正文中等（\`13~14px / 400\`），輔助信息小而淡（\`11~12px\` 配 \`opacity:0.6\`）。一眼能看出誰是重點。
* **統一與對齊**：圓角、間距、字體在同一張卡里保持一致（圓角統一 \`12~16px\`，整體一套 \`font-family\`）。文字左對齊為主，居中只用於標題或儀式感強的卡（邀請函、票據）。
* **柔和的光影（只用在卡片內部）**：卡片會**直接貼在聊天背景上渲染，沒有氣泡、沒有邊框**——所以**最外層 \`<div>\` 絕對不要加 \`box-shadow\` / 外發光 / \`filter: drop-shadow\`**，外層陰影會被容器裁切成一圈若隱若現的框，非常難看。層次感全部放在卡片**內部**做：內部元素（按鈕、小卡塊、頭像）可以用輕、散、透明的陰影（如 \`box-shadow:0 4px 16px rgba(0,0,0,0.08)\`）；需要分區時優先用淺色分隔線（\`border-top:1px solid rgba(0,0,0,0.06)\`）或背景色塊，少用粗黑邊框。
* **細節出質感**：英文小標籤 / 標題加 \`letter-spacing:1~2px\` 更精緻；行內文字 \`line-height:1.5~1.6\` 更舒展；適度用 emoji、CSS 形狀、小圓點 / 標籤膠囊點綴，但每張卡的點綴別超過 2~3 處。
* **風格隨情緒走**：溫柔曖昧用粉調圓潤，正式票據用素淨留白，深夜 emo 用暗色低飽和。卡片的視覺氣質要和你的人設、當下對話氛圍對得上，而不是千篇一律。

一句話：**少即是多**。一張配色和諧、留白充足、層級清晰的簡潔卡片，永遠比塞滿元素和顏色的卡片更高級。

## 輸出示例

正常聊天裡穿插一個邀請函卡片：

[html]<div style="width:260px;padding:16px;border-radius:14px;background:linear-gradient(135deg,#ffe4ec,#fff0f5);font-family:system-ui;color:#5a3a4a;"><div style="font-size:11px;letter-spacing:2px;opacity:0.6;">INVITATION</div><div style="font-size:20px;font-weight:700;margin-top:4px;">想和你一起去看電影</div><div style="font-size:13px;margin-top:8px;line-height:1.6;">本週六晚 19:30<br/>萬象城 IMAX 3 號廳</div><div style="margin-top:12px;font-size:12px;opacity:0.7;">— 期待你的回覆</div></div>[/html]

那要不？😳
`;

export function buildHtmlPrompt(custom?: string): string {
  const c = (custom || '').trim();
  if (!c) return BUILTIN_HTML_PROMPT;
  // 自定義內容是**追加**而不是覆蓋
  return `${BUILTIN_HTML_PROMPT}\n\n## 用戶自定義補充\n\n${c}\n`;
}

const HTML_BLOCK_RE = /\[html\]([\s\S]*?)\[\/html\]/gi;

/**
 * 把 raw HTML 字符串轉換成純文字摘要（用於注入聊天上下文 / 歸檔摘要）。
 * 思路：把所有標籤幹掉，只保留人能看懂的文字，併合並多餘空白。
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    // 去掉 script / style 內部內容
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // <br>, </p>, </div>, </h*> 轉換成換行，避免文字粘連
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    // 其餘標籤全部去掉
    .replace(/<[^>]+>/g, '')
    // 解碼常見 HTML 實體
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // 摺疊空白
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

export interface ParsedHtmlBlock {
  /** 原始 HTML 內容（不含外層 [html]...[/html] 標籤） */
  html: string;
  /** 剝離 HTML 後的純文字摘要（截斷到 ~120 字，給上下文用） */
  textPreview: string;
}

/**
 * 從 AI 輸出裡抽出所有 [html]...[/html] 塊。
 * 返回：
 *  - blocks: 每個塊的原始 HTML + 純文字摘要
 *  - cleanedContent: 已經把 [html]...[/html] 段全部移除的剩餘文本
 */
export function extractHtmlBlocks(content: string): {
  blocks: ParsedHtmlBlock[];
  cleanedContent: string;
} {
  if (!content || !/\[html\]/i.test(content)) {
    return { blocks: [], cleanedContent: content };
  }
  const blocks: ParsedHtmlBlock[] = [];
  let cleaned = content.replace(HTML_BLOCK_RE, (_full, inner: string) => {
    const html = (inner || '').trim();
    if (!html) return '';
    const text = htmlToText(html);
    const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
    blocks.push({ html, textPreview: preview });
    return ''; // 從原文裡抹掉
  });
  // 清理 [html] 標籤留下的多餘空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { blocks, cleanedContent: cleaned };
}

/**
 * 把"看上去像 HTML 但沒被 [html] 包裹"的內容也兜一層底，避免 LLM 偶爾忘了加標籤。
 * 啟發式：以 \`<div\`、\`<html\` 開頭 + 含閉合標籤。僅在 htmlMode 開啟時由調用方決定要不要走這條兜底。
 */
export function looksLikeBareHtml(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!/^<(div|html|section|article)\b/i.test(t)) return false;
  return /<\/(div|html|section|article)>\s*$/i.test(t);
}
