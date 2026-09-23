/**
 * amsg worker 服務端工具循環用的 SullyOS 業務標籤分類器（調用方見 ./agentic.ts 的 processLLMRound）。
 *
 * 掃一輪 LLM 輸出，判定：
 *   - 數據標籤 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) →
 *     tool-request: 截出標籤之前的 prefix, 並把標籤轉成 toolCalls, 由 worker 的
 *     executeToolCalls 就地執行後進下一輪.
 *   - 副作用標籤 (ACTION:POKE / TRANSFER / ADD_EVENT / MUSIC_ACTION / XHS_LIKE /
 *     XHS_FAV / XHS_COMMENT / XHS_REPLY / XHS_POST / XHS_SHARE / schedule_message /
 *     DIARY / FS_DIARY / LIFE / NEWS_CARD) →
 *     finish + directive metadata. worker 識別但不執行, 客戶端 applyAssistantPostProcessing
 *     看到 directives 非空時只重放、不再掃原文.
 *   - 其他 (結構型 + 純文本) → finish, 原文給客戶端 13 步管線消化.
 *
 * 同時返回 sanitizedBody / sanitizedPrefix — push notification.body 終態文本.
 * 跟 message 原文不重疊時由 onLLMOutput 條件塞進 payload.notification.body.
 *
 * 故意沒有任何 sullyOS 業務執行邏輯 — 這層只做"看見什麼標籤 → 出什麼 decision".
 * tool 實際跑在 utils/agenticTools.ts (worker 裡經 dispatchAgenticTool 調用),
 * directive 實際重放在 utils/directiveReplayer.ts (客戶端).
 *
 * 把分類邏輯放獨立文件方便單測 (不需要起整個 cf adapter).
 */

import { sanitizeForNotification } from '../../../utils/sanitize';
import { extractTransferCommands, parseTransferAmount } from '../../../utils/transferFormat';
import { extractScheduleChangeDirectives } from '../../../utils/scheduleChangeParse';

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/**
 * MUSIC_ACTION 說的是哪一首歌 —— 標籤語法裡只有歌單名，帶不動歌名。
 *
 * classifier 自己永遠不產這個字段（它只看得到正文，看不到角色此刻在聽什麼）。填它的是
 * 主動消息 2.0 的 worker：到點渲染「你此刻在聽：《X》」的時候順手把 X 凍進來，客戶端
 * 重放時才知道角色說的是哪首（見 worker/amsg/src/agentic.ts 的 attachSceneSong）。
 * 沒填的時候（比如本地聊天），客戶端取「用戶此刻在聽的那首」。
 */
export interface MusicActionSong {
  /** 歌曲 id；從角色歌單抽出來的都有，缺了就只能按名字對。 */
  id?: number;
  name: string;
  artists: string;
}

export type Directive =
  | { type: 'poke' }
  | { type: 'transfer'; amount: number }
  // 角色收下 / 退回用戶那筆待處理轉帳。老實現沒把這兩個標籤列進 SIDE_EFFECT_TAGS,
  // 它們留在正文裡被 sanitize 剝成空塊然後整塊丟掉 —— push 路徑上收/退根本不生效。
  | { type: 'transfer_accept' }
  | { type: 'transfer_return' }
  | { type: 'add_event'; title: string; date: string }
  // 角色改自己今天的日程 [[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]。不在 SIDE_EFFECT_TAGS
  // 裡而走旁路，理由同轉帳：解析要認中文別名 / 全角標點 / 漏括號那一堆寫法，那份容錯
  // 跟客戶端共用一份源碼（utils/scheduleChangeParse）。
  | { type: 'change_schedule'; time: string; activity: string }
  | { type: 'schedule_message'; time: string; text: string }
  // song 是可選的後補字段（見 MusicActionSong），只有主動消息 2.0 的定時路徑會填。
  | { type: 'music_action'; verb: string; args: string[]; song?: MusicActionSong }
  | { type: 'xhs_like'; noteId: string }
  | { type: 'xhs_fav'; noteId: string }
  | { type: 'xhs_comment'; noteId: string; text: string }
  | { type: 'xhs_reply'; noteId: string; commentId: string; text: string }
  | { type: 'xhs_post'; title: string; content: string; tags: string }
  | { type: 'xhs_share'; idx: number }
  // 生活記錄代記 [[LIFE:MED|布洛芬]] / [[LIFE:PERIOD_START]] / [[LIFE:EXPENSE|38|打車]] ...
  // body = 冒號後的整段原文, 客戶端拼回原 tag 交給 lifeRecords.executeLifeDirectives 解析,
  // 開關校驗 / 去重 / 寫庫都在那邊, 這裡不拆字段。
  | { type: 'life_record'; body: string }
  // 分享熱點卡片 [[NEWS_CARD: 來源|標題]] (來源可省略). body 原樣帶走, 客戶端按 `|` 切。
  | { type: 'news_card'; body: string }
  // 寫日記: 短形態 [[DIARY: title|content]] 或長形態 [[DIARY_START: title|mood]]\n content \n[[DIARY_END]],
  // 飛書同形態 (FS_ 前綴). title 可空 → 客戶端兜底用 `${char.name}的日記 - M/D`. mood 可空.
  | { type: 'notion_write_diary'; title: string; content: string; mood?: string }
  | { type: 'feishu_write_diary'; title: string; content: string; mood?: string };

export type ClassificationResult =
  | {
      kind: 'tool-request';
      /** 用戶可見的前置 narration (剝掉了數據標籤); 可能為空串 */
      prefix: string;
      /**
       * sanitizeForNotification(prefix). 給 push notification.body 用 — 業務標籤 /
       * markdown / 時間戳 leak 都剝光. 跟 prefix 字節相同時 onLLMOutput 不重複塞,
       * 節省 payload size.
       */
      sanitizedPrefix: string;
      toolCalls: ToolCall[];
    }
  | {
      kind: 'finish';
      /** 剝光數據標籤 + 副作用標籤後的純文本; 給客戶端管線消化 */
      cleanedText: string;
      /**
       * sanitizeForNotification(cleanedText). 給 push notification.body 用. 見
       * sanitizedPrefix 註釋 — 同樣的"跟 cleanedText 相同則不塞"邏輯.
       */
      sanitizedBody: string;
      directives: Directive[];
    };

// ── 數據型 (tool-request) ────────────────────────────────────────────────

interface DataTagSpec {
  /** 全局正則; 一定要帶 g flag 才能 matchAll 出多個調用 */
  re: RegExp;
  toolName: string;
  /** 把單條 match 轉成 args 對象; 返回 null 跳過這條 (兼容降級) */
  toArgs: (m: RegExpMatchArray) => Record<string, unknown> | null;
}

const DATA_TAGS: DataTagSpec[] = [
  // [[RECALL: 2024-05]] / [[RECALL: 2024年5]]
  {
    re: /\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/g,
    toolName: 'recall',
    toArgs: (m) => ({ year: m[1], month: m[2].padStart(2, '0') }),
  },
  // [[SEARCH: query]]
  {
    re: /\[\[SEARCH:\s*(.+?)\]\]/g,
    toolName: 'web_search',
    toArgs: (m) => ({ query: m[1].trim() }),
  },
  // [[READ_DIARY: 2024-05-19]] / [[READ_DIARY: 今天]]
  {
    re: /\[\[READ_DIARY:\s*(.+?)\]\]/g,
    toolName: 'notion_read_diary',
    toArgs: (m) => ({ date: m[1].trim() }),
  },
  // [[FS_READ_DIARY: 2024-05-19]]
  {
    re: /\[\[FS_READ_DIARY:\s*(.+?)\]\]/g,
    toolName: 'feishu_read_diary',
    toArgs: (m) => ({ date: m[1].trim() }),
  },
  // [[READ_NOTE: keyword]]
  {
    re: /\[\[READ_NOTE:\s*(.+?)\]\]/g,
    toolName: 'read_note',
    toArgs: (m) => ({ keyword: m[1].trim() }),
  },
  // [[XHS_SEARCH: keyword]]
  {
    re: /\[\[XHS_SEARCH:\s*(.+?)\]\]/g,
    toolName: 'xhs_search',
    toArgs: (m) => ({ keyword: m[1].trim() }),
  },
  // [[XHS_BROWSE]] / [[XHS_BROWSE: category]]
  {
    re: /\[\[XHS_BROWSE(?::\s*(.+?))?\]\]/g,
    toolName: 'xhs_browse',
    toArgs: (m) => (m[1] ? { category: m[1].trim() } : {}),
  },
  // [[XHS_DETAIL: noteId]]
  {
    re: /\[\[XHS_DETAIL:\s*(.+?)\]\]/g,
    toolName: 'xhs_detail',
    toArgs: (m) => ({ noteId: m[1].trim() }),
  },
  // [[XHS_MY_PROFILE]]
  {
    re: /\[\[XHS_MY_PROFILE\]\]/g,
    toolName: 'xhs_my_profile',
    toArgs: () => ({}),
  },
];

// ── 副作用型 (finish + directives) ───────────────────────────────────────

interface SideEffectSpec {
  re: RegExp;
  toDirective: (m: RegExpMatchArray) => Directive | null;
}

const SIDE_EFFECT_TAGS: SideEffectSpec[] = [
  // [[ACTION:POKE]]
  {
    re: /\[\[ACTION:POKE\]\]/g,
    toDirective: () => ({ type: 'poke' }),
  },
  // 轉帳 (TRANSFER / TRANSFER_ACCEPT / TRANSFER_RETURN) 不在這張表裡 —— 見 classifyLLMOutput
  // 裡的 extractTransferCommands, 那份解析跟客戶端共用一份源碼, 且要認模仿歷史日誌的口語形態。
  // [[ACTION:ADD_EVENT|title|date]]
  {
    re: /\[\[ACTION:ADD_EVENT\s*\|\s*(.*?)\s*\|\s*(.*?)\]\]/g,
    toDirective: (m) => ({ type: 'add_event', title: m[1], date: m[2] }),
  },
  // [schedule_message | time | fixed | text]  (note: 單方括號, 跟原 chatParser 一致)
  {
    re: /\[schedule_message\s*\|\s*(.+?)\s*\|\s*fixed\s*\|\s*(.+?)\]/g,
    toDirective: (m) => ({ type: 'schedule_message', time: m[1], text: m[2] }),
  },
  // [[MUSIC_ACTION:verb]] 或 [[MUSIC_ACTION:verb|arg1|arg2]]
  {
    re: /\[\[MUSIC_ACTION:(join|add|add_new|join_and_add|join_and_add_new)(?:\|([^\]]*))?\]\]/g,
    toDirective: (m) => ({
      type: 'music_action',
      verb: m[1],
      args: m[2] ? m[2].split('|').map((s) => s.trim()) : [],
    }),
  },
  // [[XHS_LIKE: noteId]]
  {
    re: /\[\[XHS_LIKE:\s*(.+?)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_like', noteId: m[1].trim() }),
  },
  // [[XHS_FAV: noteId]]
  {
    re: /\[\[XHS_FAV:\s*(.+?)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_fav', noteId: m[1].trim() }),
  },
  // [[XHS_COMMENT: noteId | text]]
  {
    re: /\[\[XHS_COMMENT:\s*([^|]+?)\s*\|\s*([^\]]+?)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_comment', noteId: m[1].trim(), text: m[2].trim() }),
  },
  // [[XHS_REPLY: noteId | commentId | text]]
  {
    re: /\[\[XHS_REPLY:\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^\]]+?)\]\]/g,
    toDirective: (m) => ({
      type: 'xhs_reply',
      noteId: m[1].trim(),
      commentId: m[2].trim(),
      text: m[3].trim(),
    }),
  },
  // [[XHS_POST: title | content | tags]]   (用 s flag 兼容多行 content)
  {
    re: /\[\[XHS_POST:\s*([^|]+?)\s*\|\s*([\s\S]+?)\s*\|\s*([^\]]+?)\]\]/g,
    toDirective: (m) => ({
      type: 'xhs_post',
      title: m[1].trim(),
      content: m[2].trim(),
      tags: m[3].trim(),
    }),
  },
  // [[XHS_SHARE: 3]]
  {
    re: /\[\[XHS_SHARE:\s*(\d+)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_share', idx: Number(m[1]) }),
  },
  // [[LIFE:MED|布洛芬]] 生活記錄代記 — 跟 chatParser.ts 的 `\[\[LIFE:[^\]]*\]\]` 同口徑,
  // 冒號後整段原樣帶走, 不在這裡拆 verb/args (那份解析在 lifeRecords.parseLifeDirective)。
  {
    re: /\[\[LIFE:([^\]]*)\]\]/g,
    toDirective: (m) => ({ type: 'life_record', body: m[1] }),
  },
  // [[NEWS_CARD: 來源|標題]] 分享熱點卡片 — 跟 chatParser.ts:NEWS_CARD_RE 同口徑。
  {
    re: /\[\[NEWS_CARD:\s*([^\]]*?)\s*\]\]/g,
    toDirective: (m) => ({ type: 'news_card', body: m[1] }),
  },
  // 寫日記 — 長形態: [[DIARY_START: title|mood]]\n content \n[[DIARY_END]]
  // 短形態: [[DIARY: title|content]] 或 [[DIARY: content]] (無 title)
  // 行為跟 applyAssistantPostProcessing.ts:465-495 字節對齊:
  //   - 長形態 header 含 `|` → title|mood 切, 不含 `|` → 整段 = title
  //   - 短形態 raw 含 `|` → title|content 切, 不含 `|` → 整段 = content (title 留空, 客戶端兜底)
  // 多行 content 用 [\s\S]*? 跨行, 別用 `s` flag (worker 端 esbuild target 默認 ok 但避免冗餘)
  {
    re: /\[\[DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[DIARY_END\]\]/g,
    toDirective: (m) => parseDiaryLong(m, 'notion_write_diary'),
  },
  {
    re: /\[\[DIARY:\s*([\s\S]+?)\]\]/g,
    toDirective: (m) => parseDiaryShort(m, 'notion_write_diary'),
  },
  // 飛書寫日記 — 同形態, FS_ 前綴
  {
    re: /\[\[FS_DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[FS_DIARY_END\]\]/g,
    toDirective: (m) => parseDiaryLong(m, 'feishu_write_diary'),
  },
  {
    re: /\[\[FS_DIARY:\s*([\s\S]+?)\]\]/g,
    toDirective: (m) => parseDiaryShort(m, 'feishu_write_diary'),
  },
];

type DiaryDirectiveType = 'notion_write_diary' | 'feishu_write_diary';

/**
 * 長日記 (DIARY_START..DIARY_END / FS_DIARY_START..FS_DIARY_END) → directive.
 * m[1] = header (可能含 `|`), m[2] = body. 跟客戶端 applyAssistantPostProcessing.ts:473-484 同切法.
 */
function parseDiaryLong(m: RegExpMatchArray, type: DiaryDirectiveType): Directive | null {
  const header = m[1].trim();
  const content = (m[2] || '').trim();
  let title = '';
  let mood = '';
  if (header.includes('|')) {
    const parts = header.split('|');
    title = parts[0].trim();
    mood = parts.slice(1).join('|').trim();
  } else {
    title = header;
  }
  // title 可空 — 客戶端 applyAssistantPostProcessing.ts:498-501 會用 `${char.name}的日記 - M/D` 兜底,
  // worker 端不知道角色名, 讓客戶端拼.
  return { type, title, content, mood: mood || undefined } as Directive;
}

/**
 * 短日記 ([[DIARY: ...]] / [[FS_DIARY: ...]]) → directive.
 * m[1] = raw (可能含 `|`). 跟客戶端 applyAssistantPostProcessing.ts:486-495 同切法.
 */
function parseDiaryShort(m: RegExpMatchArray, type: DiaryDirectiveType): Directive | null {
  const raw = m[1].trim();
  let title = '';
  let content = '';
  if (raw.includes('|')) {
    const parts = raw.split('|');
    title = parts[0].trim();
    content = parts.slice(1).join('|').trim();
  } else {
    content = raw;
  }
  return { type, title, content } as Directive;
}

/**
 * 把 LLM 輸出分類成一個 decision payload.
 *
 * @param text  ctx.llmOutputText (可能為空串 —— 純 tool_calls 響應也合法; 不過那種情況我們
 *              不會進 SullyOS 分類器, 因為 SullyOS 走的是文本協議 [[...]], 不是 OpenAI tool
 *              格式. 但保留兼容性: 空字符串 → finish + 空 cleanedText)
 */
export function classifyLLMOutput(text: string): ClassificationResult {
  // 1. 先掃數據標籤. 任意一個命中就走 tool-request, 同一輪多個 SEARCH/RECALL 也一次性收集.
  const toolCalls: ToolCall[] = [];
  for (const spec of DATA_TAGS) {
    // matchAll 拿迭代器, 轉 array 才能多次遍歷
    const matches = Array.from(text.matchAll(spec.re));
    for (const m of matches) {
      const args = spec.toArgs(m);
      if (!args) continue;
      toolCalls.push({
        id: `call_${spec.toolName}_${toolCalls.length}_${Date.now().toString(36)}`,
        type: 'function',
        function: { name: spec.toolName, arguments: JSON.stringify(args) },
      });
    }
  }

  if (toolCalls.length > 0) {
    // 把數據標籤從可見 prefix 剝掉; 副作用標籤**保留**在 prefix 裡: 調用方把 prefix 當旁白
    // 跨輪累積, finish 時拼回全文再分類一次, 副作用標籤在那次統一結構化成 directives.
    let prefix = text;
    for (const spec of DATA_TAGS) prefix = prefix.replace(spec.re, '');
    prefix = prefix.trim();
    const sanitizedPrefix = sanitizeForNotification(prefix);
    return { kind: 'tool-request', prefix, sanitizedPrefix, toolCalls };
  }

  // 2. 沒數據標籤 → 掃副作用標籤, 湊成 directives.
  const directives: Directive[] = [];

  // 2.0 轉帳先走 utils/transferFormat —— 跟客戶端 chatParser 共用同一份解析, 規範標籤
  // (`[[ACTION:TRANSFER:520元]]` 這類金額寫法一併容錯) 和模仿歷史日誌的口語形態
  // (`[系統: 你向xx轉帳 1999]`) 一起認, 方向偽造的在那裡就被丟掉了。
  //
  // 必須走 directive 通道而不是留在正文裡讓客戶端掃: sanitizeIntoSegments 會把
  // "banner 文本為空" 的整塊丟掉 (index.ts 拿 segments 發 push), 獨佔一行的轉帳日誌
  // 到不了客戶端。directives 掛在最後一條 push 上, 沒有 segment 時還會單發一條
  // directive-only push, 是這類純副作用唯一可靠的通道。
  const { text: textAfterTransfers, events: transferEvents } = extractTransferCommands(text);
  for (const ev of transferEvents) {
    if (ev.kind === 'send') {
      const amount = parseTransferAmount(ev.amount);
      if (amount !== null) directives.push({ type: 'transfer', amount });
    } else if (ev.kind === 'accept') {
      directives.push({ type: 'transfer_accept' });
    } else {
      directives.push({ type: 'transfer_return' });
    }
  }

  // 2.0b 日程修改同理走 directive 通道。不走的話標籤會留在正文裡，被 sanitizeIntoSegments
  // 的 stripBusinessTagsForNotification（正則含 ACTION）連 raw 一起剝掉——客戶端永遠收不到，
  // 角色嘴上說「日程改好了」而表其實沒動，下一輪它讀到的還是舊安排。
  // 解析跟客戶端 scheduleChange 共用一份（中文「修改日程」、全角冒號、漏括號都認）。
  // 一個標籤都沒認出來時 cleanedText 就是原文——這條由 extractScheduleChangeDirectives
  // 自己保證，兩側都不必在外面再守一道（守漏的那一側正文會悄悄少一截）。
  const scheduleParsed = extractScheduleChangeDirectives(textAfterTransfers);
  const textAfterSchedule = scheduleParsed.cleanedText;
  for (const d of scheduleParsed.directives) {
    directives.push({ type: 'change_schedule', time: d.startTime, activity: d.activity });
  }

  for (const spec of SIDE_EFFECT_TAGS) {
    const matches = Array.from(textAfterSchedule.matchAll(spec.re));
    for (const m of matches) {
      const d = spec.toDirective(m);
      if (d) directives.push(d);
    }
  }

  // 2.5 同一件事只出一個 directive.
  // 複述型模型經常把整條消息重寫一遍 (先說一遍、再"總結"一遍), 同一個 [[ACTION:TRANSFER:520]]
  // 就會出現兩次; 客戶端重放沒有去重, 放過去就是同一筆錢轉兩次帳、同一篇日記寫兩遍。
  // 判據是 type + 參數**完全一致**: 金額不同 / 筆記 id 不同的兩條仍是兩件事, 照常都留。
  const dedupedDirectives: Directive[] = [];
  const seenDirectives = new Set<string>();
  for (const d of directives) {
    const key = JSON.stringify(d);
    if (seenDirectives.has(key)) {
      console.warn('[classifier] 同一條消息裡重複的副作用, 只保留第一個:', key);
      continue;
    }
    seenDirectives.add(key);
    dedupedDirectives.push(d);
  }

  // 3. 不管 directives 有沒有, 都剝光所有標籤 (數據 + 副作用) 出乾淨文本.
  let cleanedText = textAfterSchedule;
  for (const spec of DATA_TAGS) cleanedText = cleanedText.replace(spec.re, '');
  for (const spec of SIDE_EFFECT_TAGS) cleanedText = cleanedText.replace(spec.re, '');
  cleanedText = cleanedText.trim();
  const sanitizedBody = sanitizeForNotification(cleanedText);

  return { kind: 'finish', cleanedText, sanitizedBody, directives: dedupedDirectives };
}
