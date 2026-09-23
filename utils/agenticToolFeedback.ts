/**
 * 工具跑完之後跟模型說什麼 —— 前台和 worker 共用這一份。
 *
 * 背景：工具本體早就抽成共用葉子了（agenticTools.ts），**編排沒有**。前台的編排全在
 * applyAssistantPostProcessing.ts 裡，那份文件綁死瀏覽器依賴（IndexedDB / 日記 / 小紅書
 * 客戶端），worker 打不進去，於是 worker 自己重寫了一遍——重寫的時候只寫了「怎麼跑循環」，
 * 沒寫「跑完跟模型說什麼」。結果兩邊行為分叉：
 *
 *   前台：把結果包成一條 user 消息，明說「現在請結合這些細節回答」「不要再輸出
 *         [[SEARCH:...]] 了」——所以它從來不打轉。
 *   worker：把結果 JSON.stringify 一下就丟回去，零引導。模型看不出「這一步已經做完了」，
 *         提示詞裡但凡有一句常駐的「先去查 X」，它每輪都會照做，直接跑滿上限。
 *
 * 跑滿上限的代價不是「少查一次」：超限拋 AGENTIC_LOOP_EXCEEDED，任務不出清，下一分鐘的
 * cron 把整條從頭再跑一遍，反覆燒 LLM。實測有過從 12:45 拖到 13:11 才收場的。
 *
 * 這份模塊就是把「跑完說什麼」也變成共用的一份。它只管措辭和「別重複」的規則，不碰
 * 具體工具怎麼跑，所以兩邊各自的循環形態（前台是流水線、worker 是真循環）都能用。
 */

import { MCP_FIRE_NAME_PREFIX } from './mcpFireCore';

/**
 * 一次工具調用的指紋：工具名 + 規範化後的參數。
 *
 * 參數按 key 排序後序列化，`{a:1,b:2}` 和 `{b:2,a:1}` 算同一次調用——模型兩輪之間
 * 重新拼參數時字段順序常常會變，不規範化的話同一個查詢會被當成兩次不同的。
 */
export const toolCallFingerprint = (name: string, args: unknown): string => {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return value;
  };
  return `${name}:${JSON.stringify(normalize(args ?? {}))}`;
};

/** 本次 fire 裡已經調用過的一次工具。 */
export interface ToolCallRecord {
  name: string;
  fingerprint: string;
  /**
   * 這次調用到底跑沒跑起來（`!neverRan(result)`）。沒配 key / 連不上 / 服務器沒開機的
   * 那些壓根沒發出請求，跟「跑了但沒查到」不是一回事。
   *
   * 只有需要分辨這件事的地方才填（雲端工具痕跡要靠它篩）。沒填時按「跑過了」算，
   * 跟 neverRan 認不出形狀時的兜底同一個口徑。
   */
  ran?: boolean;
}

/** 工具名 → 給模型看的說法。認不出來的直接用原名，不編。 */
const TOOL_LABELS: Record<string, string> = {
  recall: '調取某個月的記憶',
  web_search: '聯網搜索',
  notion_read_diary: '翻日記（Notion）',
  feishu_read_diary: '翻日記（飛書）',
  read_note: '翻對方的筆記',
  xhs_search: '在小紅書搜索',
  xhs_browse: '刷小紅書首頁',
  xhs_my_profile: '打開自己的小紅書',
  xhs_detail: '點開一條小紅書筆記',
  // 後台到點時角色能給自己排下一條消息（worker 的 fire 循環裡就這一個非數據工具）。
  // 漏在表外的話，回喂會拼出「你schedule_active_message，拿回了…」——內部工具名直接
  // 進了模型能看見的散文裡。
  schedule_active_message: '給自己排下一條消息',
  // 前台聊天裡角色還能取消 / 改期 / 查清單（見 utils/amsg2ToolBridge.ts）。同樣是漏在
  // 表外就會把內部工具名拼進散文，所以三個一起登記。
  cancel_active_message: '取消一條排好的消息',
  renew_active_message: '把排好的消息改到別的時間',
  list_active_messages: '查自己排了哪些消息',
};

/**
 * 工具名 → 塞進「你__，拿回了下面這些」這句話裡的說法。
 *
 * 用戶自配的 MCP 工具不在上表裡，名字還帶著路由用的 mcp__ 前綴。直接回填原名會拼出
 * 「你mcp__get_secret，拿回了…」——句子讀不通，內部前綴也漏進了模型能看見的散文裡
 * （模型照著學，回頭就往正文裡寫 mcp__ 開頭的假調用）。所以這類名字剝掉前綴、
 * 補成完整的動賓短語。內置工具都在表裡，走不到這兩條分支。
 */
export const describeTool = (name: string): string => {
  const label = TOOL_LABELS[name];
  if (label) return label;
  if (name.startsWith(MCP_FIRE_NAME_PREFIX)) {
    return `調用「${name.slice(MCP_FIRE_NAME_PREFIX.length)}」`;
  }
  return name;
};

/**
 * 工具結果 → 回餵給模型的那段話。
 *
 * 結構照抄前台那套（`[系統: 做了什麼]` + 結果 + `[系統: 接下來幹嘛]`），關鍵是最後那段
 * 收尾：把本次已經用過的工具點名列出來，並且說死「同樣的調用不要再來一遍」。裸 JSON 裡
 * 沒有任何東西在告訴模型「這一步結束了」，這段話就是。
 */
/**
 * 這些 reason 的意思是「這次調用壓根沒跑到」：沒配、沒開、連不上、被攔下。
 *
 * 跟「跑了但沒東西」（no_results / not_found / no_logs）必須分開：後者角色說
 * 「我搜了下沒啥」是實話，前者說同一句就是把沒發生的事說成發生過。裸 JSON 裡
 * 一個 reason 字段攔不住這件事——模型看見 `ok:false` 只會挑個說法圓過去，所以下面
 * 明著寫一句「不要說你查過」。
 *
 * 後台觸發時最常走的就是這一類：小紅書 / MCP 服務器多半跑在用戶自己電腦上，
 * 人睡了機器關了，worker 那邊怎麼也連不上。
 *
 * `empty_content` 看著像「跑了但是空的」，其實不是：日記/筆記類工具只有在「條目找到了、
 * 每一篇正文都沒讀回來」時才發它（真的空白日記會帶著「（空白日記）」正常返回），
 * 所以它也是一次讀取失敗。往這個集合里加名字前先確認語義，別照字面猜。
 */
const NEVER_RAN_REASONS = new Set([
  'unreachable',
  'not_enabled',
  'not_configured',
  'not_supported',
  'no_api_key',
  'no_identity',
  'parse_error',
  'empty_content',
  'unknown_tool',
  'tool_error',
  'mcp_error',
  'mcp_budget_exhausted',
]);

/** 結果是不是「這次沒跑成」。形狀認不出來時當作跑過了（不硬加一句可能不對的告誡）。 */
export const neverRan = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') return false;
  const r = result as { ok?: unknown; reason?: unknown };
  return r.ok === false && typeof r.reason === 'string' && NEVER_RAN_REASONS.has(r.reason);
};

/**
 * 少數工具的結果需要額外補一句提醒，跟著結果一起回喂。
 *
 * 搜索結果裡沒有任何時間信息（拿回來的只有標題和摘要），模型看不出這條是今早的還是
 * 三年前的，很容易把一條舊聞當成剛發生的事講出來——後台主動消息尤其明顯，角色會
 * 興沖沖地跟用戶說一件早就過去的新聞。
 */
const TOOL_RESULT_NOTES: Record<string, string> = {
  web_search: '[系統: 搜索結果不帶日期，不一定是最新的——別把舊聞當成剛發生的事說，也別自己給它安一個時間。]',
};

export const buildToolResultMessage = (opts: {
  name: string;
  /** dispatchAgenticTool 的返回值，原樣序列化給模型看。 */
  result: unknown;
  /** 本次 fire 到目前為止調過的全部工具（含這一次）。 */
  history: ToolCallRecord[];
}): string => {
  const { name, result, history } = opts;
  const used = [...new Set(history.map((r) => describeTool(r.name)))];
  const label = describeTool(name);
  const head = neverRan(result)
    ? [
        `[系統: 你想${label}，但這次沒能跑起來——下面是失敗原因]`,
        JSON.stringify(result),
        '',
        `[系統: 這件事**沒有發生**。不要在消息裡說你${label}過、看到了什麼、或者「查了沒找到」——`,
        '那等於把沒做過的事說成做過了。就當這回沒查成：要麼換個別的說，要麼直接說你現在不方便查。]',
      ]
    : [
        `[系統: 你${label}，拿回了下面這些]`,
        JSON.stringify(result),
        ...(TOOL_RESULT_NOTES[name] ? [TOOL_RESULT_NOTES[name]] : []),
        '',
      ];
  return [
    ...head,
    `[系統: 本次已經用過的工具：${used.join('、')}。結果都在上面了，同樣的調用不要再來一遍。`,
    '接下來只有兩條路：直接把要發的消息寫出來，或者用一個還沒用過的工具。',
    // 「把要發的消息寫出來」很容易被讀成「從頭再寫一遍」：模型會把已經說出去的幾句連同
    // 裡面的標記一起重抄，下游照著標記再執行一次（轉帳就會真的發兩次）。
    '前面已經說出去的內容和標籤不要重寫，接著往下寫就行——重寫一遍，用戶那邊就會再收到一遍。',
    '別把工具調用當成回答——用戶等的是你說的話。]',
  ].join('\n');
};

/**
 * 同一個調用又來了一次時回給模型的話（不真跑工具）。
 *
 * 光靠上面那段提示是軟約束，模型不聽就還是會轉滿上限、把任務拖進「不出清 → 下一分鐘整條
 * 重跑」的循環。這條是硬的：同名同參第二次直接打回，一次網絡請求都不發。它只攔**完全
 * 一樣**的調用，換個月份、換個關鍵詞都照常放行，多輪能力一點不減。
 */
export const buildDuplicateToolMessage = (name: string): string => [
  `[系統: 你剛剛已經${describeTool(name)}過一次了，參數完全相同，結果就在上面。]`,
  // 說「沒有再執行」而不是「沒有再去查」：這段話現在也管排程/取消/改期這類不是查詢的
  // 工具，說成「查」的話，角色收到的交代跟它剛做的事對不上。
  '[系統: 這一次沒有再執行。別再重複同樣的調用了——現在把要發的消息寫出來，',
  '或者換一個還沒用過的工具。前面已經說出去的內容和標籤不要重寫，接著往下寫就行。]',
].join('\n');
