/**
 * amsg worker 滿血 v2 — 服務端工具循環的純邏輯（不碰網絡 / 存儲，方便單測）。
 *
 * 業務標籤的識別交給同目錄的 classifier（./classifier）：
 *   - 數據標籤（RECALL / SEARCH / READ_DIARY / XHS_* …）→ tool-request，
 *     由 index.ts 的 executeToolCalls 在 worker 裡就地執行（客戶端可能離線，
 *     工具只能在服務端跑）。
 *   - 副作用標籤（POKE / TRANSFER / MUSIC_ACTION / 寫日記 …）→ 結構化成
 *     directives 掛在最後一條 push 的 metadata 上，客戶端收到時重放
 *     （activeMsgRuntime 的 isLastChunk 守衛保證只重放一次）。
 *
 * 推送只在 finish 時發生，所以中間輪的旁白和副作用要跨輪累積（FireSessionState），
 * finish 時一起出——用戶一次收到整段回覆，內容與逐輪說出來的一致。
 */

import {
  classifyLLMOutput,
  type Directive,
  type MusicActionSong,
  type ToolCall,
} from './classifier';
import type { ToolCallRecord } from '../../../utils/agenticToolFeedback';
import {
  extractTextFakedMcpCalls,
  MCP_FIRE_NAME_PREFIX,
  stripTextFakedMcpCalls,
  type McpFireServer,
  type McpResolvedToolCore,
} from '../../../utils/mcpFireCore';
import { sanitizeIntoSegments } from '../../../utils/sanitize';
import {
  AMSG_FIRE_SCHEDULE_TOOL,
  extractFireScheduleTextCalls,
} from '../../../utils/amsgFireSchedule';
// type-only：編譯期擦除，不會把 realtimeContext 的瀏覽器依賴打進 worker bundle。
import type { XhsNote } from '../../../utils/realtimeContext';

/** 一次 fire 的跨輪累積狀態（index.ts 按 sessionId 持有，finish/skip 後丟棄）。 */
export interface FireSessionState {
  /**
   * 中間輪旁白的**原始文本**（只剝了數據標籤，副作用標籤原樣保留）。
   * 副作用不逐輪結構化——長形態日記這類跨行標籤塊可能被數據標籤劈開兩輪
   * （寫日記寫一半去 [[RECALL]]），逐輪掃會把孤立的 DIARY_START / DIARY_END
   * 當正文漏進 push、日記也丟。finish 時拼回全文統一掃一次。
   */
  narrations: string[];
  /**
   * 本次 fire 已經跑過的工具調用。兩個用處：回喂時把清單報給模型（「這些查過了」），
   * 以及攔住同名同參的重複調用（見 executeToolCalls）。跨輪累積，fire 結束隨 scratch 丟棄。
   */
  toolCalls: ToolCallRecord[];
  /** 被打回的重複調用次數（executeToolCalls 累加）。到閾值就收尾，見 MAX_DUPLICATE_TOOL_CALLS。 */
  duplicateToolCalls: number;
  /** 合成 tool_call id 的自增序號（正文那條路用；native 用模型自己的 id）。 */
  mcpCallSeq: number;
  /**
   * 出現 [[XHS_SHARE: n]] 那一輪手上的筆記列表快照（沒出現過為 null）。
   *
   * 序號 n 指的是**模型寫這句話時**看到的那份列表，而 finish 是拿本次 fire 結束時的
   * lastXhsNotesRef 解引用的——中間只要再搜一次，列表整個被換掉，正文聊的是 A 組第 3 篇
   * 露營帖、卡片推的卻是 B 組第 3 篇口紅帖。所以在那一輪就把當時的列表定格下來。
   */
  xhsShareNotes: XhsNote[] | null;
  /**
   * 最後一輪 LLM 的思考鏈（reasoning_content + 正文內聯 `<think>`，見 index.ts 的
   * onLLMOutput）。每輪覆蓋，finish 時隨第一條 push 的 metadata 回客戶端渲染思考鏈卡片。
   * 一輪都沒給過思考的模型留 null，那時候一個字段都不掛。
   */
  finalReasoning: string | null;
}

export const createFireSessionState = (): FireSessionState => ({
  narrations: [],
  toolCalls: [],
  duplicateToolCalls: 0,
  mcpCallSeq: 0,
  xhsShareNotes: null,
  finalReasoning: null,
});

/**
 * 連著重複請求同一個工具這麼多次，就不再陪它轉了，直接收尾把已有內容發出去。
 *
 * 光把重複調用打回去只省下了網絡請求，模型該轉還是轉：提示詞裡但凡有一句常駐的
 * 「每輪先去查 X」，回喂裡說什麼都蓋不過它——實測就是連著五輪都在請求同一個 recall，
 * 最後撞上輪次上限拋 AGENTIC_LOOP_EXCEEDED，任務不出清、下一分鐘整條從頭重跑。
 *
 * 收尾比轉到上限好得多：用戶至少收到角色已經寫出來的那部分，任務也正常出清。
 * 閾值取 2 —— 第一次重複可能只是模型確認一下，連著兩次就是真卡住了。
 */
export const MAX_DUPLICATE_TOOL_CALLS = 2;

/**
 * 普通內置工具最多幾輪 LLM。搜索 / 記憶 / 排程通常 1~3 輪就能結束，繼續保留原來的
 * 5 輪預算，避免一次普通主動消息因為模型打轉而燒太多請求。
 *
 * 為什麼要自己判：上游在最後一輪遇到 tool-request 會直接拋 AGENTIC_LOOP_EXCEEDED，
 * 這次攢下的旁白全丟、任務不出清、下一分鐘整條從頭重跑再燒一遍 LLM。到最後一輪就不再
 * 放行工具請求、用手上的內容收尾，用戶至少收得到角色已經寫出來的那部分。
 */
export const DEFAULT_TOOL_ITERATIONS = 5;

/**
 * 通用 MCP 的硬上限。遊戲 / 論壇類 MCP 常見「讀規則 → 查狀態 → 執行動作 → 再查狀態」；
 * 5 輪會穩定地卡在真正動作之前。這裡給到 12，但不是固定跑 12 次：模型一旦返回正文就
 * 當場結束，連續重複調用也會由 MAX_DUPLICATE_TOOL_CALLS 提前收束，所以實際輪數仍是
 * 1~12 自適應。
 */
export const MCP_MAX_TOOL_ITERATIONS = 12;

/** 當前 fire 的工具預算：接了 MCP 才使用長預算，普通內置工具維持原成本。 */
export const resolveToolIterationBudget = (hasMcp: boolean): number =>
  hasMcp ? MCP_MAX_TOOL_ITERATIONS : DEFAULT_TOOL_ITERATIONS;

/** 判本輪旁白裡有沒有 [[XHS_SHARE: n]]（與 classifier 的模式同口徑，非全局免得帶 lastIndex）。 */
const XHS_SHARE_TAG_RE = /\[\[XHS_SHARE:\s*\d+\]\]/;

/** 組 push payload 需要的業務字段（都來自 sessionCtx / task metadata）。 */
export interface PushBuildInput {
  contactName: string;
  avatarUrl: string | null;
  /** 任務行 id（從 sess_task_<id> 拆出），拆不出為 null。 */
  taskId: string | null;
  /** 'auto' | 'prompted'（metadata.amsgMode 透傳，缺省 'auto'）。 */
  messageType: string;
  metadata: Record<string, unknown>;
  /** 本次觸發時刻（任務行 next_send_at），隨每條 push 的 metadata.amsgOccurrenceMs 帶回客戶端。 */
  occurrenceMs: number;
  /**
   * round 1 XHS 工具抓到的筆記快照（stash.toolCtx.lastXhsNotesRef.current）。
   * amsg2 的 round 1 在 worker 裡跑，客戶端本地沒有這份筆記列表——不帶回去
   * [[XHS_SHARE: n]] 重放必然 available:0。
   * finish 時只挑 directive 引用到的幾張隨最後一條 push 帶回（web push 單條
   * payload ~4KB，全量 8 張會撐爆整條 push，那就不是掉卡片而是掉消息了）。
   */
  xhsNotes?: XhsNote[];
  /** xsecToken 緩存快照（[noteId, token][]），點贊/評論/回覆重放時客戶端要用。 */
  xhsXsecTokens?: Array<[string, string]>;
  /**
   * 本次觸發時 prompt 裡寫的「你此刻在聽」是哪一首（沒渲染那一段時為 null）。
   * 角色寫了 MUSIC_ACTION 就把它凍進 directive，見 attachSceneSong。
   */
  sceneSong?: MusicActionSong | null;
}

/** 掛在最後一條 push metadata.xhsSession 的形狀；idx 1-based，與 [[XHS_SHARE: n]] 同基。 */
export interface XhsSessionPayload {
  notes: Array<{ idx: number; note: XhsNote }>;
  xsecTokens: Array<[string, string]>;
}

/** desc 截斷長度：卡片預覽夠用，省 push 配額。 */
const XHS_DESC_MAX = 120;

/**
 * 從 finish 時的全部 directives 裡挑出 XHS 引用，組客戶端重放要的最小數據包：
 *   - xhs_share 的 idx → 對應筆記（越界/編造的序號取不到就跳過，客戶端照舊警告）；
 *   - xhs_like / fav / comment / reply 的 noteId → 對應 xsecToken。
 * 沒有任何 XHS 引用（或引用全落空）→ null，metadata 不多掛鍵。
 *
 * 這裡**不限張數**：角色說分享了幾張就帶幾張。塞不塞得進一條 push 是 index.ts 組裝時
 * 按真實字節預算算的，超出的部分旁路存 client_state（見 offloadOversizedPush），
 * 客戶端取回後照樣出卡——不會出現「說分享了 6 張只出來 4 張」。
 */
export function buildXhsSessionPayload(
  directives: Directive[],
  notes: XhsNote[] | undefined,
  xsecTokens: Array<[string, string]> | undefined,
): XhsSessionPayload | null {
  if (directives.length === 0) return null;
  const sharedIdx = new Set<number>();
  const refNoteIds = new Set<string>();
  for (const d of directives) {
    if (d.type === 'xhs_share') sharedIdx.add(d.idx);
    else if (d.type === 'xhs_like' || d.type === 'xhs_fav') refNoteIds.add(d.noteId);
    else if (d.type === 'xhs_comment' || d.type === 'xhs_reply') refNoteIds.add(d.noteId);
  }
  if (sharedIdx.size === 0 && refNoteIds.size === 0) return null;

  const pickedNotes: XhsSessionPayload['notes'] = [];
  for (const idx of [...sharedIdx].sort((a, b) => a - b)) {
    const note = idx >= 1 ? notes?.[idx - 1] : undefined;
    if (!note) continue;
    pickedNotes.push({ idx, note: { ...note, desc: (note.desc || '').slice(0, XHS_DESC_MAX) } });
  }
  const pickedTokens = (xsecTokens ?? []).filter(([noteId]) => refNoteIds.has(noteId));

  if (pickedNotes.length === 0 && pickedTokens.length === 0) return null;
  return { notes: pickedNotes, xsecTokens: pickedTokens };
}

/**
 * 把「這次角色在聽的那首歌」凍進 music_action directive。
 *
 * 為什麼要凍：正文裡那句「我在聽《X》」是 worker 到點挑的（renderFireSceneBlock），
 * 而 `[[MUSIC_ACTION:add|歌單標題]]` 標籤裡只有歌單名。客戶端重放時若只能取「用戶此刻
 * 在聽的那首」，定時消息補收的那一刻用戶多半什麼都沒在放 —— 正文聊著這首歌，卡片和加
 * 歌單卻整個沒發生；就算用戶恰好在聽，加的也是用戶那首，不是角色說的那首。
 *
 * 這次沒渲染「此刻在聽」（不在聽歌的時段 / 歌單空 / 跨天作廢）就不附，客戶端走它原來的
 * 實時快照那條路。其餘類型的 directive 一概不動。
 */
export function attachSceneSong(
  directives: Directive[],
  sceneSong: MusicActionSong | null | undefined,
): Directive[] {
  if (!sceneSong) return directives;
  return directives.map((d) => (d.type === 'music_action' ? { ...d, song: sceneSong } : d));
}

export type RoundDecision =
  | { decision: 'tool-request'; toolCalls: ToolCall[] }
  | { decision: 'finish'; pushPayloads: Array<Record<string, unknown>> }
  /** reason 直接進 last_skip，面板照實告訴用戶那次為什麼沒響。 */
  | {
      decision: 'skip-push';
      reason: 'empty-generation' | 'side-effects-only';
      /**
       * 這一輪被整條丟掉、但仍要送到客戶端的日程改動（沒有就沒有這個字段）。
       * 別的副作用丟了就丟了，日程不行——理由見下面 skip-push 那處的註釋。
       */
      scheduleChanges?: Array<{ startTime: string; activity: string }>;
    };

/** 本輪的通用 MCP 識別輸入（沒配 MCP 的角色不傳，行為與改動前完全一致）。 */
export interface McpRoundInput {
  resolve: Map<string, McpResolvedToolCore<McpFireServer>>;
  /** 本輪 LLM 響應裡已識別為 MCP 的 native tool_calls（名字已是 mcp__ 聲明名）；文本模式/無調用時缺省。 */
  nativeToolCalls?: ToolCall[];
}

/**
 * 本輪的任務管理工具識別輸入（schedule / cancel / renew 共用一個池，
 * 由 index.ts 的 classifyNativeToolCalls 認領好傳進來）。
 *
 * 和 MCP 一樣兩層：native tool_calls 優先，沒有 native 的排程調用時從正文摳
 * schedule_active_message({...})。同一輪兩處都寫了排程時只認 native——同一個意圖
 * 跑兩遍就是排出兩條一模一樣的任務（取消 / 改期不教正文協議，沒有這層問題）。
 */
export interface ScheduleRoundInput {
  nativeToolCalls?: ToolCall[];
}

/** classifyNativeToolCalls 的結果：認領的進兩個池，認不出的名字留給調用方記日誌。 */
export interface NativeCallClassification {
  /** 排程 / 取消 / 改期（聲明清單命中），名字已改寫成聲明名。 */
  manage: ToolCall[];
  /** 通用 MCP（mcpResolve 命中），名字已改寫成 `mcp__暴露名`。 */
  mcp: ToolCall[];
  /** 兩份清單都對不上的原始名字（模型幻覺的工具），調用方丟棄並記日誌。 */
  dropped: Array<string | null>;
}

/**
 * 把模型回報的名字解析成聲明清單裡的那一個。模型常把聲明名的「姓」搞丟或換家：
 * 聲明的是 `mcp__foo`，回報成 `foo`、`default_api:foo`、`functions.foo` 之類。
 * 原名嚴格命中優先（老規矩不變）；對不上再去掉命名空間取最後一段重試。
 * 每個候選按「mcp__ 前綴名 → 管理工具名 → MCP 裸名」的順序找，清單鍵本身唯一，
 * 「唯一命中才認」由 Map/Set 語義天然保證。
 */
const resolveNativeFireToolName = (
  raw: string,
  manageToolNames: ReadonlySet<string>,
  mcpResolve: Map<string, McpResolvedToolCore> | null,
): { kind: 'manage' | 'mcp'; name: string } | null => {
  const candidates = [raw];
  const lastSegment = raw.split(/[:./]/).pop();
  if (lastSegment && lastSegment !== raw) candidates.push(lastSegment);
  for (const c of candidates) {
    if (!c) continue;
    if (c.startsWith(MCP_FIRE_NAME_PREFIX) && mcpResolve?.has(c.slice(MCP_FIRE_NAME_PREFIX.length))) {
      return { kind: 'mcp', name: c };
    }
    if (manageToolNames.has(c)) return { kind: 'manage', name: c };
    // 裸名回退：模型把 mcp__ 前綴弄丟時，報的就是暴露名本身。
    if (mcpResolve?.has(c)) return { kind: 'mcp', name: `${MCP_FIRE_NAME_PREFIX}${c}` };
  }
  return null;
};

/**
 * 認領本輪 LLM 響應裡的 native tool_calls：管理工具（schedule / cancel / renew）
 * 與 MCP 各進各的池，兩份清單都對不上的丟進 dropped。認領時名字改寫回聲明名——
 * 下游 executeToolCalls 按聲明名分流、還要 slice mcp__ 前綴，裸名直接透傳會撞上
 * 沒有映射的名字。
 */
export const classifyNativeToolCalls = (
  rawToolCalls: unknown,
  manageToolNames: ReadonlySet<string>,
  mcpResolve: Map<string, McpResolvedToolCore> | null,
): NativeCallClassification => {
  const out: NativeCallClassification = { manage: [], mcp: [], dropped: [] };
  const calls = (Array.isArray(rawToolCalls) ? rawToolCalls : []) as ToolCall[];
  for (const tc of calls) {
    const raw = tc?.function?.name;
    const resolved = typeof raw === 'string' && raw
      ? resolveNativeFireToolName(raw, manageToolNames, mcpResolve)
      : null;
    if (!resolved) {
      out.dropped.push(typeof raw === 'string' && raw ? raw : null);
      continue;
    }
    const call = resolved.name === raw ? tc : { ...tc, function: { ...tc.function, name: resolved.name } };
    (resolved.kind === 'mcp' ? out.mcp : out.manage).push(call);
  }
  return out;
};

/**
 * 處理一輪 LLM 輸出（入參已 stripReasoningTags）：
 *   - 有數據標籤（或本輪有 MCP 調用）→ 原始旁白（prefix）暫存，返回 tool-request；
 *   - 無數據標籤 → finish：把全部中間輪旁白 + 本輪正文**拼回一份全文**統一
 *     classify（跨輪被劈開的副作用標籤塊在這裡合體），乾淨正文經
 *     sanitizeIntoSegments 分段（與客戶端 chatParser.chunkText 同一份：
 *     按換行切、[[...]] / [html] / <翻譯> / <語音> 等標籤塊保持原子），
 *     每段一條 push；全部 directives 掛最後一條的 metadata；
 *     全程無正文 → skip-push（這輪有沒有副作用都不發，理由見分支處註釋）。
 *
 * 還有一條穿透收尾：模型卡在同一個工具上出不來、或者已經是最後一輪時，本輪的工具請求
 * 不再放行，直接拿之前幾輪的內容收尾；這一輪那句「等我查查」會被丟掉（它永遠沒有下文）。
 *
 * 通用 MCP 的調用識別是兩層（native tool_calls + 正文協議），與前台同構，見函數體開頭。
 */
export function processLLMRound(
  state: FireSessionState,
  llmOutputText: string,
  build: PushBuildInput,
  mcp?: McpRoundInput | null,
  schedule?: ScheduleRoundInput | null,
  /** 本輪序號（上游 sessionCtx.iteration，0-based）。到最後一輪就不再放行工具請求。 */
  iteration?: number,
  /** 與 onBeforeFire 回給上游的 maxToolIterations 必須是同一個值。 */
  maxToolIterations: number = DEFAULT_TOOL_ITERATIONS,
): RoundDecision {
  const isFinalRound = typeof iteration === 'number' && iteration >= maxToolIterations - 1;
  // 通用 MCP 兩層識別（與前台同構）：native tool_calls 優先；沒有 native 時
  // 用前台「兼容模式」同一個解析器從正文摳 tool_name({...})。兩種來源都可能
  // 與數據標籤同輪出現，最終合併成同一個 tool-request，executeToolCalls 按
  // mcp__ 前綴分流。正文裡出現過的調用語法一律剝掉——它不能進旁白/推送。
  // 正文解析認 mcp__ 前綴名（native 模式下模型在 tools 數組裡見到的名字帶前綴，
  // 掉格式寫進正文時寫的也是它）——core 的 alsoMatchPrefix 選項負責，exposedName 回裸名。
  const nativeToolCalls = mcp?.nativeToolCalls ?? [];
  const textCalls = mcp?.resolve.size
    ? extractTextFakedMcpCalls(llmOutputText, mcp.resolve, { alsoMatchPrefix: MCP_FIRE_NAME_PREFIX })
    : [];
  // 排程工具同樣兩層，語法提取與入列拆開管：正文裡的排程語法**始終**摳出來剝掉
  // （跟 MCP 同一條紅線：調用語法不能進旁白/推送），要不要當調用入列另說——
  // native 排程在場時不入列，同一意圖兩處都寫的話，跑兩遍就是排出兩條一模一樣的
  // 任務（而 MCP 那邊重複調用只是白查一次）。池裡現在可能混著 cancel / renew
  // （見 classifyNativeToolCalls），「不入列」只看有沒有真正的 native 排程調用：
  // 本輪只 native 取消了一條時，正文裡的排程語法照常入列，兩個是不同意圖。
  const nativeScheduleCalls = schedule?.nativeToolCalls ?? [];
  const hasNativeSchedule = nativeScheduleCalls.some(
    (tc) => tc?.function?.name === AMSG_FIRE_SCHEDULE_TOOL,
  );
  const scheduleTextCalls = schedule ? extractFireScheduleTextCalls(llmOutputText) : [];
  const scheduleCalls: ToolCall[] = [
    ...nativeScheduleCalls,
    ...(hasNativeSchedule ? [] : scheduleTextCalls).map((c) => ({
      id: `sched_${state.mcpCallSeq++}`,
      type: 'function' as const,
      function: { name: AMSG_FIRE_SCHEDULE_TOOL, arguments: JSON.stringify(c.args) },
    })),
  ];

  const strippedText = scheduleTextCalls.length
    ? stripTextFakedMcpCalls(llmOutputText, scheduleTextCalls)
    : llmOutputText;
  const scanText = textCalls.length ? stripTextFakedMcpCalls(strippedText, textCalls) : strippedText;
  // native 在場時正文摳出來的不再入列（同一意圖大概率兩處都寫了；庫只給 assistant
  // 消息合併 decision 裡的 toolCalls，native 已含語義）。兩份都入列會把同一個工具跑
  // 兩遍，第二次還會被判成重複調用往收尾計數上加。語法照剝。
  const mcpToolCalls: ToolCall[] = nativeToolCalls.length > 0
    ? nativeToolCalls
    : textCalls.map((c) => ({
        // id 只需在一輪的 assistant/tool 消息配對裡唯一；本次 fire 內自增，絕不重號。
        id: `mcp_${state.mcpCallSeq++}`,
        type: 'function',
        // exposedName 恆為裸名（alsoMatchPrefix 的命中也回裸名），統一補前綴即可。
        function: { name: `${MCP_FIRE_NAME_PREFIX}${c.exposedName}`, arguments: JSON.stringify(c.args) },
      }));

  // MCP 與排程走同一條工具通道，executeToolCalls 按名字分流。
  const extraToolCalls = [...mcpToolCalls, ...scheduleCalls];

  const result = classifyLLMOutput(scanText);
  const isToolRound = result.kind === 'tool-request' || extraToolCalls.length > 0;

  if (isToolRound) {
    // prefix = 旁白 + 可能只寫了一半的副作用標籤塊。這裡不剝不結構化——
    // 等 finish 拼回全文統一掃（見 FireSessionState.narrations 註釋）。
    // MCP-only 輪沒有數據標籤，整段剝淨後的文本都是旁白（與 tag 輪的 prefix 同角色）。
    const narration = result.kind === 'tool-request' ? result.prefix : scanText;
    // 還能不能再轉一輪：連著打回這麼多次重複調用 = 模型卡在同一個工具上出不來；到最後一輪
    // 再返回 tool-request 則會被上游拋 AGENTIC_LOOP_EXCEEDED。兩種情況都不再給下一輪，
    // 直接用手上的內容收尾——整條任務失敗重跑的話，用戶一個字都收不到。
    if (state.duplicateToolCalls < MAX_DUPLICATE_TOOL_CALLS && !isFinalRound) {
      if (narration.trim()) state.narrations.push(narration);
      // 這一輪說了「我分享給你」，那 n 指的就是此刻手上這份列表。定格下來，別讓後面幾輪
      // 的搜索把它換掉（詳見 FireSessionState.xhsShareNotes）。只定格第一次：一次 fire 裡
      // 跨兩份列表各分享一張的情況極少，定格第一份至少讓先說的那張對得上。
      if (state.xhsShareNotes === null && XHS_SHARE_TAG_RE.test(narration)) {
        state.xhsShareNotes = [...(build.xhsNotes ?? [])];
      }
      return {
        decision: 'tool-request',
        toolCalls: result.kind === 'tool-request' ? [...result.toolCalls, ...extraToolCalls] : extraToolCalls,
      };
    }
    // 穿透收尾：這一輪的旁白是「等我翻翻記錄哈」這種半句，而它請求的工具永遠不會跑了。
    // 發出去用戶收到的最後一條就是一句沒有下文的話，比少說這句更假——丟掉，只發之前
    // 幾輪已經說完的內容。
  }

  // 拼回全文再掃一次。中間輪 prefix 裡不含數據標籤（prefix 定義即「首個數據標籤
  // 之前」），本輪正文也沒有（有就走上面 tool-request 分支了），所以這次分類必然
  // 落 finish；萬一未來 classifier 語義變化落了 tool-request，取其 prefix 兜底，
  // 不讓 fire 鏈在 finish 關頭斷掉。
  // 沒有旁白（一輪直出，最常見）時全文就是本輪正文，同樣的輸入不必再掃一遍。
  // 從上面 tool-request 分支穿透下來收尾時，本輪的正文已經進過 narrations 了，
  // 這裡再拼一次 llmOutputText 就會重複一段（而且它還帶著那個轉不出來的數據標籤）。
  const thisRound = isToolRound ? '' : scanText;
  const fullText = [...state.narrations, thisRound]
    .filter((part) => part.trim().length > 0)
    .join('\n');
  // result 是在 scanText（剝掉 MCP 調用語法之後的文本）上算的，比對基準必須跟著換，
  // 否則 MCP 輪穿透到收尾時會拿錯緩存。沒有 MCP 參與時 scanText === llmOutputText，
  // 這裡與改動前完全一致。
  const finalScan = fullText === scanText ? result : classifyLLMOutput(fullText);
  const cleanedText = finalScan.kind === 'finish' ? finalScan.cleanedText : finalScan.prefix;
  // 角色寫了 MUSIC_ACTION 的話，把 prompt 裡那句「你此刻在聽」的那首歌凍進去（見 attachSceneSong）。
  const directives = attachSceneSong(
    finalScan.kind === 'finish' ? finalScan.directives : [],
    build.sceneSong,
  );

  // XHS 引用的筆記/token 與 directives 掛同一條 push（最後一條），客戶端先落庫再重放。
  // 筆記列表優先用「說要分享那一輪」定格的快照，沒定格過（分享和搜索同一輪或壓根沒搜過）
  // 才用最終列表——兩者此時是同一份。
  const xhsSession = buildXhsSessionPayload(
    directives, state.xhsShareNotes ?? build.xhsNotes, build.xhsXsecTokens);
  const finishMeta = directives.length > 0
    ? { directives, ...(xhsSession ? { xhsSession } : {}) }
    : undefined;
  const segments = sanitizeIntoSegments(cleanedText);

  if (segments.length === 0) {
    // 沒有正文就整條不發，這輪有沒有副作用都一樣。
    //
    // 空正文 push 的 banner body 也是空的：用戶鎖屏收到一條只有標題、正文空白的橫幅，
    // 未讀 +1，點進去 0 氣泡。而訂閱是按 userVisibleOnly:true 建的，用
    // notification.show:false 壓掉橫幅等於跟瀏覽器違約（Firefox 對不展示通知的 push 有
    // 配額、超了直接退訂，iOS 可能撤權限，且都是靜默發生），所以「發但不彈」也不是出路。
    //
    // 只有副作用標籤、沒有正文時同樣放棄：角色一個字沒說卻在小紅書點了贊、寫了日記，
    // 用戶看到的是「ta 什麼都沒說但做了事」，本身就穿幫。後台產生的副作用該等客戶端
    // 上線時主動拉，不塞進一條沒內容的推送裡（amsg-sw README 裡也是這個結論）。
    //
    // 日程改動是這條規矩裡唯一的例外，單拎出來交給調用方走 emitResult。它不是做給用戶
    // 看的動作，是角色在糾正自己的表：一起丟掉的話，下一次 fire 讀到的還是那條舊安排，
    // 角色會反覆想改又反覆改不掉，用戶那邊則永遠看到表和角色說的話對不上。emitResult
    // 落的是服務端收件箱，不佔聊天正文，也不用為它硬發一條空推送。
    const scheduleChanges = directives
      .filter((d): d is Extract<Directive, { type: 'change_schedule' }> => d.type === 'change_schedule')
      .map((d) => ({ startTime: d.time, activity: d.activity }));
    return {
      decision: 'skip-push',
      reason: finishMeta ? 'side-effects-only' : 'empty-generation',
      ...(scheduleChanges.length > 0 ? { scheduleChanges } : {}),
    };
  }

  const lastIdx = segments.length - 1;
  return {
    decision: 'finish',
    pushPayloads: segments.map((seg, i) =>
      buildScheduledPush(seg.raw, build, i === lastIdx ? finishMeta : undefined, seg.sanitized),
    ),
  };
}

/**
 * 單段 → 老鏈路 scheduled push 形狀（業務字段同 v1，可選多掛
 * metadata 追加鍵（directives / xhsSession）與 notification）。messageId/sessionId/
 * timestamp/messageIndex/totalMessages 由庫的 sendHookPushPayloads 統一補齊/覆寫。
 *
 * bannerBody = segment 的 sanitized 文本，塞進 notification.body 給 OS banner
 * 顯示（[[SEND_EMOJI: x]] → [表情：x] 這類可讀形態）；message 保留 raw 讓客戶端
 * applyAssistantPostProcessing 渲染卡片/表情。不帶 notification.show —— SW 對
 * content push 的默認彈窗行為不變。
 */
function buildScheduledPush(
  message: string,
  build: PushBuildInput,
  extraMeta?: Record<string, unknown>,
  bannerBody?: string,
): Record<string, unknown> {
  const title = `來自 ${build.contactName}`;
  return {
    messageKind: 'content' as const,
    messageType: build.messageType,
    source: 'scheduled' as const,
    message,
    title,
    contactName: build.contactName,
    avatarUrl: build.avatarUrl,
    messageSubtype: 'chat',
    taskId: build.taskId,
    metadata: {
      ...build.metadata,
      amsgOccurrenceMs: build.occurrenceMs,
      ...(extraMeta ?? {}),
    },
    ...(bannerBody !== undefined ? { notification: { title, body: bannerBody } } : {}),
  };
}
