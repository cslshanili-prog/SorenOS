/**
 * 共享 sanitize 工具 — 零依賴純字符串處理.
 *
 * 兩個 facade:
 *  - sanitizeForBubble(text, opts)  — chatParser.sanitize 的實現, 給客戶端 13 步管線**預處理**用.
 *    保留 SEND_EMOJI / [html] / <翻譯> / <think> / [[INNER_STATE:...]] 等標籤, 因為
 *    applyAssistantPostProcessing Step 4 (think chain) / Step 5 (html card) /
 *    Step 8 (雙語) / Step 9 (sticker) 還要靠這些標籤接管.
 *  - sanitizeForNotification(text)  — worker push 之前的**終態**處理, 沒有下游 step,
 *    所以剝得更徹底: think 塊 / INNER_STATE 全刪, SEND_EMOJI → [表情：名稱],
 *    [html]...[/html] → [HTML 卡片], <翻譯> 只保留原文, 鏈接 → [鏈接：text].
 *
 * 真理來源:
 *  - 共享底層規則: utils/chatParser.ts:sanitize 原版正則 (lines 207-252)
 *  - notification 專用 / Step 9-相關規則: utils/applyAssistantPostProcessing.ts:normalizeAiContent
 */

import { segmentTextWithProtectedBlocks } from '@rei-standard/amsg-instant';

// ─── 底層 helper (共享, 無歧義清理) ─────────────────────────────────────────

/** `\\n` 字面 → 真實換行. 必須先跑, 否則後續 ^ 行錨定失效. */
const stripLiteralBackslashN = (t: string): string => t.replace(/\\n/g, '\n');

/**
 * 歷史來源標籤 → 換行（保留分隔語義）。
 *
 * 歷史原文只會注入 `[聊天]/[通話]/[約會]`，但模型偶爾會在模仿時把標籤做成
 * 中英混寫（線上實例如 `[聊chat]`），甚至直接翻成 `[chat]`。這些仍然是內部
 * 元數據，不該作為角色正文展示。只對白名單中的三組來源詞做容錯，避免吞掉普通
 * 方括號內容。
 */
export const stripLeakedSourceTags = (t: string): string => t.replace(
  /\s*\[\s*(?:聊\s*(?:天|chat)|chat|通\s*(?:[话話]|call)|call|[约約]\s*(?:[会會]|date)|date)\s*\]\s*/giu,
  '\n',
);

/** 4 種時間格式: 帶括號 ISO / 行首裸 ISO / 中文 12h / 英文 12h */
const stripTimestamps = (t: string): string =>
  t
    .replace(/\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*/gm, '')
    .replace(/（[上下]午\d{1,2}[：:]\d{2}）/g, '')
    .replace(/\(\d{1,2}:\d{2}\s*[AP]M\)/gi, '');

/** `[2024年5月20]` / `[2024/5/20...]` 中文或斜槓日期 (兼容 normalizeAiContent 的更寬鬆匹配) */
const stripChineseDate = (t: string): string => t.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');

/**
 * 整個字符串首行的角色名 prefix `Sully:` / `User:` (無 m flag — 跟
 * applyAssistantPostProcessing.ts:normalizeAiContent 行為對齊).
 */
const stripRoleNamePrefix = (t: string): string => t.replace(/^[\w一-龥]+:\s*/, '');

/**
 * 業務標籤 (ACTION / RECALL / SEARCH / DIARY / READ_DIARY / FS_DIARY / FS_READ_DIARY /
 * DIARY_START / DIARY_END / FS_DIARY_START / FS_DIARY_END / MUSIC_ACTION) + schedule_message.
 * 保持跟 chatParser.sanitize 原版字節對齊 — 不含 READ_NOTE / XHS_x (那些只在 notification 路徑剝).
 */
const stripBusinessTagsForBubble = (t: string): string =>
  t
    .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END|MUSIC_ACTION)[:\s][\s\S]*?\]\]/g, '')
    // `[[記錄:...]]` 整個命名空間 —— 歷史渲染形態 (utils/transferFormat.ts:formatTransferRecord),
    // 模型復讀歷史會抄出來。能還原成動作的 (記錄:TRANSFER) 在上游 chatParser / worker classifier
    // 已被消費; 走到這裡的一律是純 leak, 不進氣泡。全角冒號一併容 (模型手寫變體)。
    // 對原版 chatParser.sanitize 是**有意**分叉 (C4 oracle 測的是 refactor 不漂移, 這條是新規則)。
    .replace(/\[\[\s*[记記記][录錄錄]\s*[:：][\s\S]*?\]\]/g, '')
    .replace(/\[schedule_message[^\]]*\]/g, '');

/**
 * notification 路徑專用 — 在 stripBusinessTagsForBubble 基礎上額外剝 READ_NOTE / XHS_x /
 * LIFE / NEWS_CARD. 這些標籤在 chatParser.sanitize 老路徑裡被保留 (downstream 由
 * applyAssistantPostProcessing / ChatParser.parseAndExecuteActions 重新掃描+執行),
 * 但 push notification 是終態, 不會再有 downstream, 所以剝得更狠.
 *
 * LIFE / NEWS_CARD 的副作用走 worker classifier 的 directive 通道 (SIDE_EFFECT_TAGS 裡
 * 的 life_record / news_card), 跟 POKE / ADD_EVENT / DIARY 同一條路: 正文裡剝光,
 * 結構化掛在最後一條 push 上, 客戶端 reconstructDirectiveTags 拼回原 tag 執行。
 */
const stripBusinessTagsForNotification = (t: string): string =>
  stripBusinessTagsForBubble(t)
    .replace(/\[\[(?:READ_NOTE|XHS_[A-Z_]+|LIFE|NEWS_CARD)[:\s][\s\S]*?\]\]/g, '')
    .replace(/\[\[XHS_[A-Z_]+\]\]/g, '');

/**
 * 剝掉**所有** `[[...]]`, 不看標籤名 —— 客戶端 `chatParser.hasDisplayContent` 的口徑.
 * 只在段級判空時用, 不參與正文清洗 (白名單之外的標籤該不該留給客戶端是另一件事).
 *
 * 存在的理由: 上面那兩條白名單隻認識約定好的標籤, 模型現編的 `[[擁抱]]` 會原樣留下來。
 * 客戶端 hasDisplayContent 剝光一切 `[[...]]` 後判空, 這種段不落庫; worker 這邊卻算它
 * 「有內容」照發一條 push —— 於是橫幅響了一下、點進去一個氣泡都沒有。
 */
const stripAllDoubleBracketTags = (t: string): string => t.replace(/\[\[[\s\S]*?\]\]/g, '');

/** 引用類: `[[QUOTE|引用]] / [QUOTE|引用] / [回覆 "..."] / 模仿歷史渲染的 [xx引用了xx「…」…]` */
const stripQuotes = (t: string): string =>
  t
    .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')
    .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
    .replace(/\[回[复覆]\s*[""“][^""”]*?[""”](?:\.{0,3})\]\s*[：:]?\s*/g, '')
    // buildMessageHistory 把引用渲染成 [xx引用了xx說的「…」，並回復了 ↓]，模型會學這個格式輸出。
    // 解析端 (applyAssistantPostProcessing QUOTE_RE_NL) 已把它認作引用，這裡保證殘留不漏進氣泡/通知。
    .replace(/\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g, '');

/**
 * 歷史裡的系統日誌 leak — `[系統: ...]` / `[系統提示: ...]` / `[系統] ...` / `[System: ...]`。
 *
 * buildMessageHistory 把 transfer / interaction / 時間間隔提示都渲染成這個形態餵給模型
 * (`[系統: 你向xx轉帳 1999]`、`[系統: 用戶戳了你一下]`、`[系統提示: 距離上一條消息: 3 小時]`),
 * 模型會照抄。這是**終線**: 能還原成動作的已經在上游被 chatParser (轉帳見
 * utils/transferFormat.ts) 認領走了, 走到這裡的一律不該進氣泡/通知。
 *
 * 加這條會讓 sanitizeForBubble 跟 chatParser.sanitize 原版產生**有意的**行為分叉 ——
 * C4 oracle 測的是 refactor 不漂移, 這條是明確的新規則, 不屬於漂移。
 */
const stripSystemLogLeak = (t: string): string =>
  t
    .replace(/[\[【]\s*(?:系[统統]|系統|System)\s*(?:提示)?\s*[:：][^\[\]【】]*[\]】]\s*/gi, '')
    .replace(/\[\s*(?:系[统統]|系統)\s*\]\s*/g, '');

/** markdown 標題 `# heading` → `heading` (保留文字) */
const stripMarkdownHeaders = (t: string): string => t.replace(/^#{1,6}\s+/gm, '');

/** markdown 加粗 `**bold**` → `bold` (聊天裡粗體沒用, 直接吃掉星號) */
const stripMarkdownBold = (t: string): string => t.replace(/\*{2,}/g, '');

/** `---` / 空 bullet 行 */
const stripMarkdownDividers = (t: string): string =>
  t.replace(/^\s*---\s*$/gm, '').replace(/^\s*[-*+]\s*$/gm, '');

/** backtick: 保留 ``` `[[...]]` ``` 內部, 剝 ``` `` ``` 和單 backtick */
const stripBackticks = (t: string): string =>
  t
    .replace(/`(\[\[[\s\S]*?\]\])`/g, '$1')
    .replace(/``+/g, '')
    .replace(/(^|\s)`(\s|$)/gm, '$1$2');

/** `%%TRANS%%...` 老翻譯標記 (保留 `%%BILINGUAL%%` 跟 `<翻譯>` XML) */
const stripLegacyTrans = (t: string): string => t.replace(/%%TRANS%%[\s\S]*/gi, '');

/** `\n{3,}` → `\n\n` + trim */
const collapseWhitespace = (t: string): string => t.replace(/\n{3,}/g, '\n\n').trim();

// ─── notification 專用 helper ──────────────────────────────────────────────

/** `<think|thinking|thought>...</...>` 整塊, 含未閉合兜底 */
const stripThinkBlocks = (t: string): string =>
  t
    .replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');

/** `[[INNER_STATE:...]]` */
const stripInnerState = (t: string): string => t.replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '');

/** `[text](url)` → `[鏈接：text]` (全角冒號) */
const replaceMarkdownLinks = (t: string): string =>
  t.replace(/\[([^\]]+)\]\([^)]+\)/g, '[鏈接：$1]');

/**
 * `[[SEND_EMOJI: 名稱]]` → `[表情：名稱]`.
 * 全角冒號一併容 (`[[SEND_EMOJI：抱抱]]` 是中文輸入法下的高頻手寫變體, 跟
 * `[[記錄：...]]` 那條同一個理由)。
 */
const replaceSendEmoji = (t: string): string =>
  t.replace(/\[\[SEND_EMOJI[:：]\s*(.+?)\]\]/g, '[表情：$1]');

/** `[xxx 發送了表情包: 名稱]` → `[表情：名稱]` (直接轉最終展示, 跳過 SEND_EMOJI 中間形態) */
const replaceEmojiReverseTag = (t: string): string =>
  t.replace(/\[(?:你|User|用[户戶]|System|[\w一-龥]+)\s*[发發]送了表情包[:：]\s*(.*?)\]/g, '[表情：$1]');

/** `[html]...[/html]` → `[HTML 卡片]` */
const replaceHtmlBlocks = (t: string): string =>
  t.replace(/\[html\][\s\S]*?\[\/html\]/gi, '[HTML 卡片]');

/** `<翻譯>...</翻譯>` → `<原文>` 內容 (banner 用; segment 路徑裡有專門 sentinel 保護跳過這條) */
const replaceTranslationForBanner = (t: string): string =>
  t
    .replace(/<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/g, '$1')
    .replace(/<[译譯]文>[\s\S]*?<\/[译譯]文>/g, '')
    .replace(/<\/?(?:翻[译譯]|原文)>/g, '');

/** `<語音>...</語音>(<字幕>...</字幕>)` → 字幕優先、否則語音內文 (banner 用;
 *  segment 路徑裡有 sentinel 保護跳過這條)。閉合容許空格/簡繁互換。 */
const replaceVoiceForBanner = (t: string): string =>
  t
    .replace(
      /(?:<字幕>([\s\S]*?)<\/字幕>\s*)?<[语語語]音[^>]*>([\s\S]*?)<\/\s*[语語語]音\s*>(?:\s*<字幕>([\s\S]*?)<\/字幕>)?/g,
      (_m, pre, inner, post) => ((post || pre || inner || '') as string).trim(),
    )
    .replace(/<字幕>([\s\S]*?)<\/字幕>/g, '$1')  // 落單字幕塊: 剝標籤留中文
    .replace(/<\/?字幕>/g, '');

// ─── 語音標籤規整 (掉格式自愈) ──────────────────────────────────────────────

/**
 * 單個標籤家族的配對修復掃描: 孤兒閉合刪除、嵌套多餘開標籤刪除、自閉合空標籤刪除、
 * 未閉合開標籤在末尾補閉合。
 * closeBeforeTrailingSubtitle: 補語音閉合時, 若末尾跟著完整 <字幕> 塊, 閉合插在字幕
 * 之前 —— 否則字幕會被吞進語音塊裡被朗讀出來。
 */
function repairPairedTag(
  text: string,
  tokenRe: RegExp,
  closeFormOf: (openTok: string) => string,
  closeBeforeTrailingSubtitle: boolean,
): string {
  const kept: string[] = [];
  let cursor = 0;
  let openForm: string | null = null;
  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(text)) !== null) {
    const isClose = tok[0].startsWith('</');
    if (!isClose && /\/\s*>$/.test(tok[0])) {
      // 自閉合空標籤: 無意義, 直接刪 (別讓配對邏輯把後文全吞進去)
      kept.push(text.slice(cursor, tok.index));
      cursor = tok.index + tok[0].length;
      continue;
    }
    if (isClose) {
      if (openForm === null) {
        // 孤兒閉合: 刪除
        kept.push(text.slice(cursor, tok.index));
        cursor = tok.index + tok[0].length;
      } else {
        openForm = null; // 正常配對
      }
    } else if (openForm !== null) {
      // 塊內又出現開標籤 (嵌套/復讀): 刪掉多餘的這個
      kept.push(text.slice(cursor, tok.index));
      cursor = tok.index + tok[0].length;
    } else {
      openForm = closeFormOf(tok[0]);
    }
  }
  kept.push(text.slice(cursor));
  let result = kept.join('');
  if (openForm !== null) {
    const closeTag = `</${openForm}>`;
    if (closeBeforeTrailingSubtitle) {
      const trail = result.match(/(\s*<字幕>[\s\S]*?<\/字幕>\s*)$/);
      if (trail) {
        const at = result.length - trail[0].length;
        return result.slice(0, at).replace(/\s+$/, '') + closeTag + trail[0].replace(/\s+$/, '');
      }
    }
    result = result.replace(/\s+$/, '') + closeTag;
  }
  return result;
}

/**
 * 把 LLM 寫歪的 <語音> / <字幕> 標籤修回規範形態, 讓下游所有配對正則 (chunkText
 * 原子塊保護 / MessageItem hasVoiceTag / parseVoiceOutput / worker Phase 1.5) 都能命中。
 * 落庫前跑一次 (sanitizeForBubble / sanitizeIntoSegments), 下游不用各自容錯。
 *
 * 修復的形態 (全部來自真實掉格式報告):
 *  1. 全角尖括號:  ＜語音＞…＜/語音＞ / ＜／字幕＞     → <語音>…</語音> / </字幕>
 *  2. 閉合標籤內空格 / 全角斜槓: </ 語音 > / <／字幕>  → </語音> / </字幕>
 *  3. 開標籤屬性: <語音emotion=…> 少空格、全角引號 “” / 全角等號 ＝ → 規範屬性
 *  4. 配對修復: 有開無閉 → 末尾補閉合 (語音的閉合會插在末尾完整 <字幕> 塊之前);
 *     孤兒閉合 (無開) / 嵌套多餘開標籤 / 自閉合空標籤 → 刪除
 */
export function normalizeVoiceTags(t: string): string {
  if (!/[语語語]音|字幕/.test(t)) return t; // fast path
  let result = t;
  // 1. 全角尖括號 → 半角 (只動語音/字幕標籤本身, 不碰正文其他全角符號)
  result = result.replace(/＜\s*[/／]\s*([语語語]音|字幕)\s*＞/g, '</$1>');
  result = result.replace(/＜\s*((?:[语語語]音|字幕)[^<>＜＞]*?)\s*＞/g, '<$1>');
  // 2. 閉合標籤規整: </ 語音 > / <／字幕> / < /語音> → </語音> 等
  result = result.replace(/<\s*[/／]\s*([语語語]音|字幕)\s*>/g, '</$1>');
  // 3. 開標籤屬性規整: 少空格 / 全角引號 / 全角等號
  result = result.replace(/<([语語語]音|字幕)\s*([^<>]*?)\s*>/g, (_m, tag: string, attrs: string) => {
    if (!attrs) return `<${tag}>`;
    const fixed = attrs.replace(/[“”＂]/g, '"').replace(/[‘’]/g, "'").replace(/＝/g, '=').trim();
    return `<${tag} ${fixed}>`;
  });
  // 4. 配對掃描: 先修語音 (閉合避讓末尾字幕塊), 再修字幕
  result = repairPairedTag(result, /<\/?[语語語]音[^>]*>/g, tok => (/語/.test(tok) ? '語音' : '語音'), true);
  result = repairPairedTag(result, /<\/?字幕[^>]*>/g, () => '字幕', false);
  return result;
}

// ─── 翻譯標籤規整 (掉格式自愈) ──────────────────────────────────────────────

const simpTransTag = (tag: string): string => tag.replace(/譯/g, '譯');

/**
 * 把 LLM 寫歪的 <翻譯>/<原文>/<譯文> 標籤修回規範形態
 * `<翻譯><原文>X</原文><譯文>Y</譯文></翻譯>`, 讓下游所有嚴格配對正則
 * (applyAssistantPostProcessing Step 8 雙語拆泡 / sanitizeIntoSegments Phase 1.5
 * 原子保護 / extractTranslationOriginal banner 提取) 都能命中。
 * 落庫前跑一次 (三個 facade 都掛了), 下游不用各自容錯。
 *
 * 修復的形態 (來自真實掉格式報告 —— 多模型多站點同時出現"掉格式"):
 *  1. 全角尖括號 / 全角斜槓 / 標籤內空格 / 簡繁互換: ＜／譯文＞ → </譯文>
 *  2. 截斷標籤少寫 `>`: 行尾/文尾/緊貼下一標籤的 `</譯文` → `</譯文>` (截圖報告形態)
 *  3. 配對修復: 有開無閉 → 末尾補閉合; 孤兒閉合 / 嵌套重複開標籤 / 自閉合 → 刪除
 *  4. 結構自愈 → 規範塊:
 *     - 缺外層包裹 / 缺 </翻譯>: `<原文>X</原文><譯文>Y</譯文>` → 補齊 <翻譯> 包裹
 *     - sibling 幻覺: `<翻譯>X</翻譯><譯文>Y</譯文>` → 規範塊
 *       (extractTranslationOriginal 註釋裡記錄的已知形態)
 *  5. 兜底不變量: 自愈後文本里只允許存在規範完整塊 —— 仍配不成對的翻譯標籤
 *     全部剝除、正文保留 (寧可退化成普通氣泡, 也絕不把 `</譯文` 這類破標籤漏給用戶)。
 */
export function normalizeTranslationTags(t: string): string {
  if (!/[<＜]\s*[/／]?\s*(?:翻[译譯譯]|原文|[译譯譯]文)/.test(t)) return t; // fast path
  let result = t;
  // 1. 全角尖括號/斜槓 + 標籤內空格 + 簡繁 → 規範半角簡體
  result = result.replace(/[<＜]\s*[/／]\s*(翻[译譯譯]|原文|[译譯譯]文)\s*[>＞]/g, (_m, tag) => `</${simpTransTag(tag)}>`);
  result = result.replace(/[<＜]\s*(翻[译譯譯]|原文|[译譯譯]文)\s*[>＞]/g, (_m, tag) => `<${simpTransTag(tag)}>`);
  // 2. 截斷補全: 行尾/文尾/緊貼下一個 `<` 處少寫 `>` (流截斷 / 模型偷懶的高頻形態)
  result = result.replace(
    /[<＜]\s*([/／]?)\s*(翻[译譯譯]|原文|[译譯譯]文)\s*(?=$|\n|[<＜])/g,
    (_m, slash, tag) => `<${slash ? '/' : ''}${simpTransTag(tag)}>`,
  );
  // 3. 配對修復: 先內層 (原文/譯文) 再外層 (翻譯), 未閉合開標籤才能按嵌套順序補對
  result = repairPairedTag(result, /<\/?原文[^>]*>/g, () => '原文', false);
  result = repairPairedTag(result, /<\/?[译譯]文[^>]*>/g, () => '譯文', false);
  result = repairPairedTag(result, /<\/?翻[译譯][^>]*>/g, () => '翻譯', false);
  // 4. 結構自愈。先把本來就規範的完整塊 (多行/緊湊都算) 用佔位符護住原樣保留,
  //    只對剩餘的掉格式殘局做規範化重寫。
  const HOLD = String.fromCharCode(3);
  const blocks: string[] = [];
  const hold = (m: string): string => { blocks.push(m); return `${HOLD}${blocks.length - 1}${HOLD}`; };
  result = result.replace(/<翻[译譯]>\s*<原文>[\s\S]*?<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/g, hold);
  // 4a. 配好的 原文+譯文 對 (外層 <翻譯> 包裹缺失/只剩半邊) → 規範塊
  result = result.replace(
    /(?:<翻[译譯]>\s*)?<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>([\s\S]*?)<\/[译譯]文>\s*(?:<\/翻[译譯]>)?/g,
    (_m, a: string, b: string) => hold(`<翻譯><原文>${a.trim()}</原文><譯文>${b.trim()}</譯文></翻譯>`),
  );
  // 4b. sibling 幻覺形態 <翻譯>X</翻譯><譯文>Y</譯文> → 規範塊
  result = result.replace(
    /<翻[译譯]>\s*(?!<原文>)((?:(?!<\/?翻[译譯]>)[\s\S])*?)<\/翻[译譯]>\s*<[译譯]文>([\s\S]*?)<\/[译譯]文>/g,
    (_m, a: string, b: string) => hold(`<翻譯><原文>${a.trim()}</原文><譯文>${b.trim()}</譯文></翻譯>`),
  );
  // 5. 兜底不變量: 規範塊之外不允許殘留任何翻譯標籤。
  //    配不成對的 <譯文> 整塊是重複的目標語內容 —— 按 extractTranslationOriginal
  //    既有策略整塊丟棄; 其餘散標籤 (全角/截斷/貼字) 剝掉標籤保留正文。
  result = result.replace(/<[译譯]文>[\s\S]*?<\/[译譯]文>/g, '');
  result = result.replace(/[<＜]\s*[/／]?\s*(?:翻[译譯譯]|原文|[译譯譯]文)\s*[>＞]?/g, '');
  result = result.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_m, n) => blocks[Number(n)] || '');
  return result;
}

/**
 * 翻譯塊只保留原文.
 *
 * 兩種格式都處理:
 *  - 規範 (chatRequestPayload.ts prompt 教 LLM 用的): `<翻譯><原文>X</原文><譯文>Y</譯文></翻譯>` → `X`
 *  - LLM 幻覺常見錯誤:                                  `<翻譯>X</翻譯><譯文>Y</譯文>`             → `X`
 *
 * 第二種 LLM 偶爾會寫, 嚴格 regex 不命中就會讓 banner 上漏出原始 `<翻譯>` 標籤字符.
 * 處理順序: 先吃規範形態, 再兜底吃 `<譯文>` 整塊 + 殘留的 `<翻譯>` / `<原文>` 標籤.
 */
const extractTranslationOriginal = (t: string): string => {
  let result = t.replace(
    /<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/g,
    '$1',
  );
  // 兜底: 先剝光 <譯文>...</譯文> 整塊 (LLM 直接 sibling tag 的形態), 再剝殘留的開/閉合標籤
  result = result.replace(/<[译譯]文>[\s\S]*?<\/[译譯]文>/g, '');
  result = result.replace(/<\/?(?:翻[译譯]|原文)>/g, '');
  return result;
};

// ─── facade 高層 API ───────────────────────────────────────────────────────

/**
 * worker push notification.body 終態處理:
 *  - 剝光 <think> / INNER_STATE / 業務標籤 / 引用 / 時間戳 / 歷史 leak
 *  - 替換 SEND_EMOJI / [html] / [text](url) 為可讀 placeholder
 *  - <翻譯> 只保留原文
 *
 * 順序很重要 — 見處理順序註釋.
 */
export function sanitizeForNotification(text: string): string {
  let result = text;
  // 1. 字面 \n 還原 — 否則後續 ^ 錨定失效
  result = stripLiteralBackslashN(result);
  // 2. think 塊最早剝 — 裡面可能含其他 tag 影響後續匹配
  result = stripThinkBlocks(result);
  // 3. HTML 塊替換 — 內部 markdown/tag 不應被處理
  result = replaceHtmlBlocks(result);
  // 4. 反向 emoji tag 先於正向 SEND_EMOJI (反向可能也走 SEND_EMOJI 重寫, 但這裡直接轉最終展示)
  result = replaceEmojiReverseTag(result);
  result = replaceSendEmoji(result);
  // 5. 翻譯塊保留原文剝譯文 (先自愈掉格式的標籤, 嚴格提取正則才能命中)
  result = normalizeTranslationTags(result);
  result = extractTranslationOriginal(result);
  // 6. LLM mimicking 歷史的 leak: 時間戳 / 日期 / 角色名 prefix / 系統日誌
  result = stripTimestamps(result);
  result = stripChineseDate(result);
  result = stripRoleNamePrefix(result);
  result = stripSystemLogLeak(result);
  // 7. 源標籤 [聊天] 等
  result = stripLeakedSourceTags(result);
  // 8. 內部狀態 / 業務標籤 / 引用
  result = stripInnerState(result);
  result = stripBusinessTagsForNotification(result);
  result = stripQuotes(result);
  // 9. 鏈接 → [鏈接：text] (必須先於 markdown header/bold strip, 避免 [text](url) 內的 # 被誤剝)
  result = replaceMarkdownLinks(result);
  // 10. markdown 修飾
  result = stripMarkdownHeaders(result);
  result = stripMarkdownBold(result);
  result = stripMarkdownDividers(result);
  // 11. backtick
  result = stripBackticks(result);
  // 12. 老翻譯標記
  result = stripLegacyTrans(result);
  // 13. 空白收尾
  result = collapseWhitespace(result);
  return result;
}

/**
 * chatParser.sanitize 實現 — 客戶端 13 步管線**預處理**.
 *
 * 跟 sanitizeForNotification 的差異:
 *  - 保留 SEND_EMOJI / [html] / <翻譯> / <think> / [[INNER_STATE:...]] (後續 step 接管)
 *  - 保留 markdown 鏈接 text(url) (chatParser 老行為是只剝 url 留 text, 這裡也保持一致)
 *  - keepCitations 選項控制 `[[QUOTE|引用]]` 是否保留 (chunking 用)
 */
export function sanitizeForBubble(
  text: string,
  options?: { keepCitations?: boolean },
): string {
  let result = text;
  // 1. 字面 \n 還原
  result = stripLiteralBackslashN(result);
  // 1.5. 語音/翻譯標籤自愈 — 必須在 chunkText 之前 (下游原子塊保護 /
  //      applyAssistantPostProcessing Step 8 雙語拆泡都靠嚴格配對正則)
  result = normalizeVoiceTags(result);
  result = normalizeTranslationTags(result);
  // 2. 源標籤 / 時間戳 / 系統日誌 leak / 業務標籤
  result = stripLeakedSourceTags(result);
  result = stripTimestamps(result);
  result = stripSystemLogLeak(result);
  result = stripMarkdownHeaders(result);
  result = stripBusinessTagsForBubble(result);
  if (!options?.keepCitations) {
    result = stripQuotes(result);
  }
  // 3. backtick / markdown link (chatParser 老行為: 剝 url 留 text)
  result = stripBackticks(result);
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // 4. markdown bold / dividers
  result = stripMarkdownBold(result);
  result = stripMarkdownDividers(result);
  // 5. 老翻譯標記
  result = stripLegacyTrans(result);
  // 6. 收尾
  result = collapseWhitespace(result);
  return result;
}

// ─── Segments API (amsg-instant 0.8+ pushPayloads) ─────────────────────────

/**
 * 一段內容 → 一條 push.
 *  - `raw`: 給客戶端 `message` 字段, 保留 SEND_EMOJI / [html] / <翻譯> / <語音> /
 *           [[QUOTE|引用]] 等業務標籤讓 applyAssistantPostProcessing Step 5/7/8/9 +
 *           Chat.tsx extractVoiceTag 正確接管 (HTML 卡 / 引用回覆 / 雙語氣泡 / sticker / 語音條)
 *  - `sanitized`: 給 `notification.body`, OS banner 顯示用的可讀 placeholder
 *
 * 兩個字段在大多數 chunk 上是一樣的 (普通文本); 只有原子單元 (SEND_EMOJI / [html] /
 * <翻譯> / <語音>) 時兩者才分叉.
 */
export interface Segment {
  raw: string;
  sanitized: string;
}

interface ProtectedAtomSegment {
  raw: string;
  sanitized: unknown;
  protect: boolean;
}

/**
 * worker push notification + bubble 共用的分段器.
 *
 * 算法:
 *  1. Phase 1   — 全文 strip suppress content (think 塊 / INNER_STATE / 業務標籤 /
 *                  時間戳 leak / source tag / 歷史 leak / divider / 老 trans). 必須先全文
 *                  跑, 因為 think 跨多行, 單行 chunk 看不到完整塊.
 *  1.5. Phase 1.5 — 用 amsg-instant 標準保護分段器識別客戶端要二次消費的"原子語義塊",
 *                   防止 chunkText 按 \n 把它們切碎: [html]...[/html] / <翻譯>...</翻譯> /
 *                   <語音>...</語音>. 保護塊兩側按舊邏輯補 \n, 讓 chunkText 必把它獨立成 chunk.
 *  2. Phase 2   — chunkText: 只按顯式換行切, 跟客戶端 `chatParser.chunkText`
 *                  字節對齊 (普通空格屬於正文, 不能把中日混排的一句話攔腰拆開).
 *  3. Phase 3   — 還原佔位符 (獨佔 chunk → 直接成單 segment; 同行 inline → 替換回原文 +
 *                  banner 兜底). 每個文字 chunk 內拆 SEND_EMOJI 獨立成段, 文字段跑
 *                  banner-only 替換 (markdown link / [html] / markdown header/bold/backtick /
 *                  引用 / <翻譯> / <語音>).
 *
 * 不切句號 — 客戶端 chunkText 也不切, 保持氣泡數 == banner 數.
 *
 * 引用 ([[QUOTE|引用]] / [回覆 "..."]) 跟 SEND_EMOJI 一樣**不**剝, 留給客戶端
 * applyAssistantPostProcessing Step 7 / per-chunk QUOTE_RE 配對設置 aiReplyTarget.
 * banner 那邊在 sanitizeTextForBanner 裡單獨剝, 保證通知乾淨.
 *
 * 返回空數組的情況: LLM 整段輸出 sanitize 完只剩 think / 業務標籤 / 空白 — 此時
 * 不發任何 banner / bubble (skip-push 語義).
 */
export function sanitizeIntoSegments(text: string): Segment[] {
  // Phase 1: 全文 suppress
  let cleaned = stripLiteralBackslashN(text);
  cleaned = stripThinkBlocks(cleaned);
  cleaned = normalizeVoiceTags(cleaned); // 語音標籤自愈 — Phase 1.5 的配對保護靠它兜底
  cleaned = normalizeTranslationTags(cleaned); // 翻譯標籤自愈 — 同上, Phase 1.5 的 <翻譯> 原子保護靠它命中

  // Phase 1.5: 原子語義塊交給 amsg-instant 標準 protected-block splitter 識別,
  // 再橋回舊 pipeline。這樣只替換"如何保護原子塊", 不改變後續清洗/分段語義。
  const ATOM_MARKER = String.fromCharCode(2);
  const atomBlocks: Segment[] = [];
  const atomSegments = segmentTextWithProtectedBlocks(cleaned, {
    splitText: (plainText: string) => [plainText],
    protectedPatterns: [
      {
        pattern: /\[html\][\s\S]*?\[\/html\]/i,
        preview: '[HTML 卡片]',
      },
      {
        pattern: /<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/,
        preview: (_raw: string, match: RegExpMatchArray) => (match[1] || '').trim() || '[翻譯]',
      },
      {
        // 語音塊 + 緊鄰的 <字幕> 塊是一個原子單元 (字幕是這條語音的中文對照, 拆開
        // 就配不上了)。字幕前置/後置都容忍; banner 預覽優先用字幕 (用戶讀得懂中文)。
        // 閉合容許空格 + 簡繁互換 (normalizeVoiceTags 已修, 這裡不再依賴 \1 回引)。
        pattern: /(?:<字幕>([\s\S]*?)<\/字幕>\s*)?<[语語語]音[^>]*>([\s\S]*?)<\/\s*[语語語]音\s*>(?:\s*<字幕>([\s\S]*?)<\/字幕>)?/,
        preview: (_raw: string, match: RegExpMatchArray) =>
          (match[3] || match[1] || match[2] || '').trim() || '[語音]',
      },
    ],
  }) as ProtectedAtomSegment[];
  cleaned = atomSegments.map((seg) => {
    if (!seg.protect) return seg.raw;
    const idx = atomBlocks.length;
    atomBlocks.push({
      raw: seg.raw,
      sanitized: typeof seg.sanitized === 'string'
        ? seg.sanitized
        : sanitizeTextForBanner(seg.raw),
    });
    return `\n${ATOM_MARKER}B${idx}${ATOM_MARKER}\n`;
  }).join('');

  cleaned = extractTranslationOriginal(cleaned); // 兜底吃殘留的 <譯文> / <翻譯> 標籤
  cleaned = stripInnerState(cleaned);
  cleaned = stripBusinessTagsForNotification(cleaned);
  cleaned = stripTimestamps(cleaned);
  cleaned = stripChineseDate(cleaned);
  cleaned = stripRoleNamePrefix(cleaned);
  cleaned = stripLeakedSourceTags(cleaned);
  // 注意: 這裡**不**剝 stripQuotes — 引用要帶到客戶端讓 Step 7 配 aiReplyTarget.
  // sanitizeTextForBanner 單獨剝引用給 notification.
  //
  // 同理**不**剝 stripSystemLogLeak: 模型抄出來的 `[系統: ...]` 原樣留在 raw 裡帶給客戶端。
  // 轉帳那一類不靠這條路 (worker classifier 已在 directive 通道認領, 見 classifier.ts
  // extractTransferCommands —— 因為獨佔一行的日誌塊 banner 為空會被下面的 skip 規則整塊丟掉),
  // 這裡保留是為了讓還沒被認領的形態到得了客戶端。banner 側在 sanitizeTextForBanner 剝乾淨。
  cleaned = stripLegacyTrans(cleaned);
  cleaned = stripMarkdownDividers(cleaned);

  // Phase 2: chunk 跟客戶端 chatParser.chunkText 同算法 (內聯避免 import chatParser
  // 把 DB / React / Capacitor 依賴拖進 worker bundle)
  const rawChunks = chunkText(cleaned);

  // Phase 3: 還原原子塊佔位符 + 拆 SEND_EMOJI + banner-only 替換
  const SOLO_RE = new RegExp(`^${ATOM_MARKER}B(\\d+)${ATOM_MARKER}$`);
  const GLOBAL_RE = new RegExp(`${ATOM_MARKER}B(\\d+)${ATOM_MARKER}`, 'g');
  const segments: Segment[] = [];
  // 引用標籤獨佔一行時 banner 側會被 stripQuotes 剝空，整段丟掉的話 raw 裡的引用也跟著沒了,
  // 客戶端就配不上 replyTo——而提示詞教的寫法（回覆開頭寫 [[QUOTE:]]）產出的正是這種形態。
  // 所以攢著，拼到下一個文字段的 raw 開頭，客戶端照常解析。表情段不消費它：客戶端那邊
  // 表情氣泡本來也不掛 replyTo，引用會繼續順延到後面的文字氣泡。
  let pendingQuoteRaw = '';
  for (const rawChunk of rawChunks) {
    const soloMatch = rawChunk.trim().match(SOLO_RE);
    if (soloMatch) {
      const blk = atomBlocks[Number(soloMatch[1])];
      if (blk) segments.push({ raw: blk.raw, sanitized: blk.sanitized });
      continue;
    }
    const parts = splitOnSendEmoji(rawChunk);
    for (const part of parts) {
      if (part.kind === 'emoji') {
        segments.push({
          raw: `[[SEND_EMOJI: ${part.name}]]`,
          sanitized: `[表情：${part.name}]`,
        });
        continue;
      }
      // 安全網: 佔位符跟正文同行 (chunkText 沒拆開) 時把整塊還原回 raw,
      // sanitized 路徑 sanitizeTextForBanner 會再把 [html]/<翻譯>/<語音>/引用 折成 placeholder.
      let rawText = part.text.replace(
        GLOBAL_RE,
        (_m, n) => atomBlocks[Number(n)]?.raw || '',
      );
      rawText = rawText.trim();
      if (!rawText) continue;
      const sanitized = sanitizeTextForBanner(rawText).trim();
      if (!sanitized) {
        // 只有剝掉引用就空了的段才留著順延；別的剝空成因（純系統日誌 leak 之類）照舊丟。
        if (!stripQuotes(rawText).trim()) pendingQuoteRaw += `${rawText}\n`;
        continue;
      }
      // 再按客戶端口徑判一次空：剝光所有 `[[...]]` 後什麼都不剩的段（模型現編的未知
      // 標籤獨佔一行），客戶端不會落成氣泡，這邊也就別發橫幅——兩端判空規則一致，
      // 橫幅數才等於氣泡數。攢著的引用不消費，會繼續順延到後面真有正文的那一段。
      if (!stripAllDoubleBracketTags(sanitized).trim()) continue;
      segments.push({
        raw: pendingQuoteRaw ? `${pendingQuoteRaw}${rawText}` : rawText,
        sanitized,
      });
      pendingQuoteRaw = '';
    }
  }
  return segments;
}

/**
 * 單個文字 chunk 的 banner-side 替換. 不動 raw 文字, 只產 sanitized 版本.
 * SEND_EMOJI 已經在 splitOnSendEmoji 階段獨立成段, 這裡不處理.
 *
 * 注意: 引用 / <翻譯> / <語音> 在 sanitizeIntoSegments Phase 1.5 protect 路徑裡
 * 已經被佔位符兜走, 走到這裡的只可能是同行 inline / 殘留 / 老格式 — 這裡全部
 * 強制剝成 banner 友好的形態, 保證通知乾淨.
 */
function sanitizeTextForBanner(text: string): string {
  let result = text;
  result = replaceHtmlBlocks(result);            // [html]...[/html] → [HTML 卡片]
  result = replaceTranslationForBanner(result);  // <翻譯>...</翻譯> → 原文
  result = replaceVoiceForBanner(result);        // <語音>...</語音> → 內部文字
  result = stripQuotes(result);                  // 引用 / 回覆 → ''
  result = stripSystemLogLeak(result);           // [系統: 你向xx轉帳 1999] 等歷史日誌 leak → ''
  result = replaceEmojiReverseTag(result);       // [xxx 發送了表情包: yyy] → [表情：yyy]
  result = replaceMarkdownLinks(result);         // [text](url) → [鏈接：text]
  result = stripMarkdownHeaders(result);
  result = stripMarkdownBold(result);
  result = stripBackticks(result);
  result = collapseWhitespace(result);
  return result;
}

/**
 * `chatParser.chunkText` 的無依賴版本. 行為字節對齊:
 *  1. 只按顯式換行符切 (\n / \r\n / \r /   /  )
 *  2. trim + filter empty；行內普通空格原樣保留
 */
function chunkText(text: string): string[] {
  return text.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * 把 chunk 裡的 `[[SEND_EMOJI: 名稱]]` 拆出來當獨立 part. 跟客戶端
 * `chatParser.splitResponse` 行為對齊 (輸出 shape 不同, 這裡用 kind 字段區分).
 *
 * 冒號容全角 (`[[SEND_EMOJI：抱抱]]`): 拆出來後 raw 按半角規範形態重寫, 客戶端拿到的
 * 永遠是它認得的那一種。不容的話這段會當普通文字走下去, banner 上直接是裸標籤。
 */
function splitOnSendEmoji(chunk: string): Array<
  | { kind: 'text'; text: string }
  | { kind: 'emoji'; name: string }
> {
  const re = /\[\[SEND_EMOJI[:：]\s*(.*?)\]\]/g;
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'emoji'; name: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: 'text', text: chunk.slice(lastIndex, m.index) });
    }
    parts.push({ kind: 'emoji', name: m[1].trim() });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < chunk.length) {
    parts.push({ kind: 'text', text: chunk.slice(lastIndex) });
  }
  if (parts.length === 0 && chunk) parts.push({ kind: 'text', text: chunk });
  return parts;
}
