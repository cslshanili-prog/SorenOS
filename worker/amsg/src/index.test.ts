// worker/amsg/src/index.test.ts
// onBeforeFire 的四道門 —— 這個功能最關鍵的決策路徑，一個判斷寫錯位就是「該攔的沒攔」
// 或者「全都不發」。門的順序本身也是行為的一部分（註釋裡專門寫過），一起釘住。
//
// 順序：charId 校驗 → 活躍會話租約(skip) → fire_pack 存在(否則拋) → 防穿幫閘(skip)
//      → 任務指令存在(否則拋) → 掛 scratch + 填槽返回
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

import worker, {
  amsgFireSettled, amsgHooks, amsgReasoningKey, amsgStaleSkip, attachScheduledTasks,
  buildWorkerConfig, configureInstantErrorPush, inspectWorkerEnv,
  offloadOversizedPush, resolveVapidEmail, runFireCancelTool, runFireRenewTool,
  inspectPushDelivery,
  runFireScheduleTool, runMcpFireTool, splitSchemaMissing, classifySchemaProbeError,
} from './index';
import * as workerEntry from './index';
import { DEFAULT_TOOL_ITERATIONS, MCP_MAX_TOOL_ITERATIONS } from './agentic';
import { configureSkipDiagnostics } from './skipDiagnostics';
import { MAX_PUSH_PAYLOAD_BYTES } from '@rei-standard/amsg-server/cloudflare';
import { amsgEmotionUpdateKey, EMOTION_EVAL_RIDE_ALONG_MS } from './emotionEval';
import { INSTANT_TOTAL_TIMEOUT_MS } from './instantChat';
import {
  AMSG_CHAT_FAIL_KEY,
  AMSG_FIRE_PACK_KEY,
  AMSG_LAST_SKIP_KEY,
  AMSG_SELF_LOG_KEY,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG2_INSTANT_STUB_TEMPLATE,
  amsgStateNamespace,
  amsgXhsSessionKey,
  appendSelfLogEntry,
  createSelfLog,
  FIRE_PACK_VERSION,
  packStateValue,
  parseSelfLog,
  SELF_LOG_MAX_ENTRIES,
} from '../../../utils/amsgFirePack';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from '../../../utils/amsgToolPack';
import { buildMcpNameMap, MCP_FIRE_NAME_BUDGET, type McpFireServer } from '../../../utils/mcpFireCore';
import { MAX_FIRE_SCHEDULES } from '../../../utils/amsgFireSchedule';
import { MAX_ACTIVE_TASKS_PER_CHAR, shortTaskId } from '../../../utils/amsg2Tasks';
import { isAmsgServerVersionAtLeast } from '../../../utils/amsgWorkerVersion';
import { AMSG_TASK_KIND_KEY } from '../../../utils/amsgTaskKinds';
import { PLATE_CONSOLIDATE_KIND } from '../../../utils/amsgPlateJob';

const CHAR_ID = 'preset-nyah';
const TASK_UUID = '3637dae1-1461-4444-a747-34e406f67acc';
const NOW = new Date('2026-07-25T12:00:00.000Z');

const PACK_BUILT_AT = Date.parse('2026-07-25T09:00:00.000Z');

const firePackValue = (
  lastUserMessageAt: number | null = null,
  extra: Record<string, unknown> = {},
) => JSON.stringify({
  // 版本跟著 amsgFirePack 走：升版是前端 + worker 一起動的事，測試跟著走就行。
  v: FIRE_PACK_VERSION,
  template: `現在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
  lastUserMessageAt,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '小明',
  builtAt: PACK_BUILT_AT,
  pendingTasks: [],
  scene: null,
  selfScheduleEnabled: true,
  ...extra,
});

const presenceValue = (
  activeAt: number,
  opts: { lastUserMessageAt?: number | null; charId?: string } = {},
) => JSON.stringify({
  v: 1,
  charId: opts.charId ?? CHAR_ID,
  activeAt,
  lastUserMessageAt: opts.lastUserMessageAt === undefined ? activeAt : opts.lastUserMessageAt,
});

// tool_pack / tool_config 與 fire_pack 同批原子上傳，所以默認造齊——缺任何一份都是
// 雲端狀態異常，走拋錯路徑（見下面「缺 tool_pack → 拋錯」那條）。
const toolPackValue = JSON.stringify({
  v: 1, charName: 'Nyah', xhsEnabled: false, activeMemoryMonths: [], memories: [],
  timeAwarenessEnabled: true,
});
const toolConfigValue = JSON.stringify({
  v: 1, proxyWorkerUrl: '', weatherEnabled: false, newsEnabled: false,
  notionEnabled: false, feishuEnabled: false,
});

/** 帶一台通用 MCP 服務器的 tool_config（extra 用來改開關 / 服務器可見範圍）。 */
const mcpToolConfigValue = (extra: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
  mcpServers: [{
    id: 'srv-memory',
    name: '記憶庫',
    url: 'https://mcp.example.com/mcp',
    tools: [{
      name: 'search_memory',
      description: '按關鍵詞查記憶',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }],
  }],
  ...extra,
});

/** 造一個 FireCtx；rows 是 readState 按 namespace 返回的內容。 */
const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  charRows?: Array<{ key: string; value: string }>;
  globalRows?: Array<{ key: string; value: string }>;
  recurrenceType?: string;
  nextSendAt?: string | null;
  /** 寫不進 client_state 時的樣子：跳過原因寫失敗不該連累這次 skip。 */
  writeStateFails?: boolean;
}) => {
  const charRows = opts.charRows ?? [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
  ];
  const globalRows = opts.globalRows ?? [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }];
  const readState = vi.fn(async (namespace: string) =>
    namespace.startsWith('amsg:char:') ? charRows : globalRows);
  const writeState = vi.fn(async (
    _namespace: string,
    _entries: Array<{ key: string; value: string | null }>,
  ) => {
    if (opts.writeStateFails) throw new Error('write failed');
    return { upserted: 1, skipped: 0, deleted: 0 };
  });
  const scratch: Record<string, unknown> = {};
  return {
    ctx: {
      task: {
        id: 42,
        uuid: TASK_UUID,
        contactName: 'Nyah',
        recurrenceType: opts.recurrenceType ?? 'none',
        nextSendAt: opts.nextSendAt ?? '2026-07-25T12:00:00.000Z',
        metadata: {
          charId: CHAR_ID,
          amsgExpirePolicy: 'expire',
          amsgTaskInstruction: '問問對方吃了沒',
          ...opts.metadata,
        },
      },
      userId: 'u1',
      readState,
      writeState,
      now: NOW,
      scratch,
    } as any,
    scratch,
    readState,
    writeState,
  };
};

/** onBeforeFire 生成路徑的返回值：{ messages, tools? }（skip 那一支各測各的）。 */
interface FiredResult {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string; parameters: unknown } }>;
  maxToolIterations?: number;
}

/** 取生成路徑的返回值；順手確認沒退回 skip / null，省得每條用例各自強轉。 */
const fired = (result: unknown): FiredResult => {
  expect(result, '生成路徑應該返回 { messages, tools? }').toHaveProperty('messages');
  return result as FiredResult;
};

const FIRE_TASK_ID = 42;
const FIRE_NEXT_SEND_AT = '2026-07-25T12:00:00.000Z';

/**
 * 會記帳的 client_state 夾具：readState / writeState 打在同一個 Map 上，
 * 這一輪寫進去的東西下一輪讀得到（outbox 累積、self_log 回寫這些都要它）。
 *
 * 給了 chatMessages 就是即時對話那種 fire_pack（帶 chat 段），不給就是定時任務那種。
 */
const makeFireStore = (chatMessages?: Array<{ role: string; content: unknown }>) => {
  const rows = new Map<string, string>([
    [AMSG_FIRE_PACK_KEY, firePackValue(null, chatMessages
      ? { chat: { messages: chatMessages, builtAt: PACK_BUILT_AT } }
      : {})],
    [AMSG_TOOL_PACK_KEY, toolPackValue],
  ]);
  const readState = vi.fn(async (namespace: string) => (
    namespace.startsWith('amsg:char:')
      ? [...rows].map(([key, value]) => ({ key, value }))
      : [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }]
  ));
  const writeState = vi.fn(async (
    _namespace: string,
    entries: Array<{ key: string; value: string | null }>,
  ) => {
    for (const entry of entries) {
      if (entry.value === null) rows.delete(entry.key);
      else rows.set(entry.key, entry.value);
    }
    return { upserted: entries.length, skipped: 0, deleted: 0 };
  });
  return { rows, readState, writeState };
};

/**
 * 完整跑一次 fire：onBeforeFire → onLLMOutput。
 *
 * metadata 一併交還，而且**兩個 hook 收到的是同一個對象引用**——上游就是這麼傳的
 * （見 chunk-RRWCPPOY 的 buildHookTask 淺拷貝），照搬才驗得出「就地刪憑據」那類行為。
 */
const runFire = async (
  store: ReturnType<typeof makeFireStore>,
  opts: {
    metadata: Record<string, unknown>;
    llmOutput: string;
    /** 整個響應體；把思考放在 reasoning_content 字段的模型（deepseek-r1 那類）用它塞。 */
    llmResponse?: Record<string, unknown>;
    /** 同一個 store 連跑幾輪時換一下，messageId 才跟著變。 */
    taskId?: number;
    sessionId?: string;
  },
) => {
  const scratch: Record<string, unknown> = {};
  const metadata = { charId: CHAR_ID, ...opts.metadata };
  const taskId = opts.taskId ?? FIRE_TASK_ID;
  await amsgHooks.onBeforeFire({
    task: {
      id: taskId, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
      nextSendAt: FIRE_NEXT_SEND_AT, metadata,
    },
    userId: 'u1',
    readState: store.readState,
    writeState: store.writeState,
    now: NOW,
    scratch,
  } as any);
  const decision = await amsgHooks.onLLMOutput({
    sessionId: opts.sessionId ?? `sess_task_${taskId}@1`, taskId, taskUuid: TASK_UUID,
    llmResponse: opts.llmResponse ?? {}, llmOutputText: opts.llmOutput, contactName: 'Nyah',
    metadata, scratch, writeState: store.writeState,
  } as any) as any;
  return { decision, metadata, scratch };
};

describe('Worker 入口的具名導出', () => {
  /**
   * 迴歸守衛：入口不能導出數字 / 字符串這類原始值。
   *
   * Worker 入口模塊的具名導出會被 workerd 當成「命名入口點」——Durable Object 和
   * WorkerEntrypoint 的類就是靠這個認出來的——所以每一個都得是函數（類也是函數）或者
   * ExportedHandler 那樣的對象。從入口順手導出一個數字常量（給測試用的那種），
   * 整個 Worker 直接起不來：`Incorrect type for map entry '<導出名>':
   * the provided value is not of type 'function or ExportedHandler'`。
   * 而這事兒只有真跑 workerd 才看得見，單測和 tsc 全綠，`wrangler dev` 一開才炸。
   *
   * 常量一律住在別的模塊裡（先例：EMOTION_EVAL_RIDE_ALONG_MS 在 ./emotionEval）。
   */
  it('沒有原始值——導出一個數字常量就夠讓整個 Worker 起不來', () => {
    const offenders = Object.entries(workerEntry)
      .filter(([name]) => name !== 'default')
      .filter(([, value]) => typeof value !== 'function' && (typeof value !== 'object' || value === null))
      .map(([name, value]) => `${name}: ${typeof value}`);
    expect(offenders).toEqual([]);
  });
});

describe('onBeforeFire 四道門', () => {
  it('正常路徑：填好槽返回 prompt，並把工具狀態掛上 scratch', async () => {
    const { ctx, scratch } = makeCtx({});
    const result = await amsgHooks.onBeforeFire(ctx);

    const messages = fired(result).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    // 槽位必須被填掉，不能把 {{AMSG_*}} 原樣發給 LLM
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
    expect(messages[0].content).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
    expect(messages[0].content).toContain('問問對方吃了沒');
    // scratch.fire 必須在返回 messages 之前掛好——onLLMOutput / executeToolCalls 全靠它
    expect(scratch.fire).toBeTruthy();
    expect((scratch.fire as any).occurrenceMs).toBe(Date.parse('2026-07-25T12:00:00.000Z'));
  });

  it('活躍會話租約新鮮 → skip，而且排在 fire_pack 檢查之前（缺 fire_pack 也照樣 skip）', async () => {
    const { ctx } = makeCtx({
      // 故意不給 fire_pack：如果 presence 門被挪到後面，這裡會變成拋錯而不是 skip
      charRows: [{ key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) }],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('force 策略不吃活躍租約這道門（鬧鐘型照發）', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgExpirePolicy: 'force' },
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('租約過期（超 TTL）不攔', async () => {
    const { ctx } = makeCtx({
      charRows: [
        // 用戶最後一次開口挪到熱聊窗外：這條測的是「租約過期這道門不攔」，
        // 讓窗口那道閘搶答的話，過了也說明不了租約的事。
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 120_000, { lastUserMessageAt: NOW.getTime() - 30 * 60_000 }) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('防穿幫閘：到點前十分鐘內用戶還在聊 → skip', async () => {
    const { ctx } = makeCtx({
      // 到點（= NOW）前一分鐘用戶剛說過話，正撞在對話上
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(NOW.getTime() - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  // presence 行是每輪聊天一開場就寫的小值，幾十字節就發完了；fire_pack 是整包幾十 KB，
  // 同樣是打髒即發，但傳完總要慢一截。只看 fire_pack 的話，用戶剛說完話、包還在路上的
  // 那幾秒裡任務照發，正撞在對話上。
  it('防穿幫閘：presence 記的用戶開口時刻比 fire_pack 新 → 用新的那份判，作廢', async () => {
    const { ctx } = makeCtx({
      charRows: [
        // 租約本身已經過期（不吃第一道門），但它記著的「最後一條用戶消息」仍然算數：
        // 落在熱聊窗內 → 作廢。fire_pack 那份是半小時前的，只看它就會誤放行。
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 120_000, { lastUserMessageAt: NOW.getTime() - 60_000 }) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(NOW.getTime() - 30 * 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('防穿幫閘：presence 是別的角色的 → 不拿來當判定材料', async () => {
    const { ctx } = makeCtx({
      charRows: [
        {
          key: AMSG_CHAT_PRESENCE_KEY,
          value: presenceValue(NOW.getTime() - 120_000, { lastUserMessageAt: NOW.getTime() - 60_000, charId: 'other-char' }),
        },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(NOW.getTime() - 30 * 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('防穿幫閘：到點前十分鐘內沒人說話 → 照發（半小時前聊過不算）', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(NOW.getTime() - 30 * 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  // ─── 不降級：狀態不完整一律拋錯，不再退回排程時凍結的 prompt ───

  it('雲端沒有 fire_pack → 拋錯（不降級）', async () => {
    const { ctx } = makeCtx({ charRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  // 這批失敗是確定性的狀態問題，重試三次只是讓等回覆的用戶白等六分鐘。
  // permanent: true 是上游 isNonRetryableError 認的鴨子契約 → 直接終審處置。
  it('狀態類失敗標 permanent，上游不再走重試階梯', async () => {
    const { ctx } = makeCtx({ charRows: [] });
    const error = await amsgHooks.onBeforeFire(ctx).then(() => null, (e: unknown) => e);
    expect((error as { permanent?: boolean }).permanent).toBe(true);
  });

  it('fire_pack 解析失敗 → 拋錯（不降級）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: '{"v":1,"template":"老格式"}' }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  // ─── 閘跳過時留一句原因 ───
  //
  // 閘判定該讓路就直接跳過，一條 push 都不發，而遠端那行任務照樣被消費掉——客戶端事後
  // 看到的跟「發出去了但沒收到」一模一樣，用戶只會覺得功能壞了。這幾條釘住那句解釋。

  it('用戶正在聊天被攔下 → 寫下原因，說明是讓路了', async () => {
    const { ctx, writeState } = makeCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '應該寫過 last_skip').toBeTruthy();
    const skip = JSON.parse(String(call![1][0].value));
    expect(skip.reason).toBe('active-chat-presence');
    expect(skip.taskUuid).toBe(TASK_UUID);
  });

  it('對話已經聊到別處被作廢 → 原因寫成另一種，兩者能分開', async () => {
    const { ctx, writeState } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(NOW.getTime() - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(JSON.parse(String(call![1][0].value)).reason).toBe('conversation-moved-on');
  });

  it('正常觸發不留跳過記錄（別讓上一次的解釋賴著不走）', async () => {
    const { ctx, writeState } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call).toBeUndefined();
  });

  it('原因寫失敗照樣把這次攔下來——閘的效果不能取決於能不能寫日誌', async () => {
    const { ctx } = makeCtx({
      writeStateFails: true,
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  // ─── 值壓縮：前端壓過的 fire_pack 要能讀出來，沒壓過的老數據也要照常讀 ───

  it('前端壓過的 fire_pack 照常讀出來', async () => {
    // 真實的 fire_pack 是幾萬字的角色設定加聊天記錄，這裡也得湊到那個量級：
    // 太短的內容壓完反而更大，packStateValue 會按設計原樣返回、測不到解壓路徑。
    const bulky = JSON.stringify({
      ...JSON.parse(firePackValue()),
      template: `${'【角色系統設定】你是一個會在深夜突然想起對方的人。\n'.repeat(400)}`
        + `現在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '這個量級應該壓得動').toBe(true);
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: packed },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const messages = fired(await amsgHooks.onBeforeFire(ctx)).messages;
    expect(messages[0].content).toContain('問問對方吃了沒');
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
  });

  it('壓過的值壞掉 → 拋錯，不拿半截內容當 prompt 發出去', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: 'gz1:bm90LWd6aXAtYXQtYWxs' },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('前端壓過的 tool_pack 照常讀出來（帶幾條月度總結就到壓縮量級）', async () => {
    // 空記憶的 tool_pack 一百來字節、壓完反而更大，packStateValue 會原樣放行；
    // 攢了幾條月度總結的角色輕鬆過千字節、必然被壓——正是活躍用戶的常態形狀。
    const months = ['2026-05', '2026-06', '2026-07'];
    const bulky = JSON.stringify({
      ...JSON.parse(toolPackValue),
      activeMemoryMonths: months,
      memories: months.map((date) => ({
        date,
        summary: '這個月聊了很多工作上的壓力，也一起看了兩場電影，月底約好下次去海邊散心。'.repeat(3),
      })),
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '這個量級應該壓得動').toBe(true);
    const { ctx, scratch } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: packed },
      ],
    });
    fired(await amsgHooks.onBeforeFire(ctx));
    // 光不拋錯不夠：得確認解出來的是真數據（recall 按這些月份找總結全靠它）
    expect((scratch.fire as any).toolCtx.char.activeMemoryMonths).toEqual(months);
  });

  it('壓過的 tool_pack 壞掉 → 拋錯（和 fire_pack 同款語義，不降級成無工具數據）', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: 'gz1:bm90LWd6aXAtYXQtYWxs' },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('壓過的 tool_config 也照常讀出來（今天前端沒壓它，但讀側不該賭客戶端壓哪份）', async () => {
    const bulky = mcpToolConfigValue({
      mcpServers: [{
        id: 'srv-memory',
        name: '記憶庫',
        url: 'https://mcp.example.com/mcp',
        tools: [{
          name: 'search_memory',
          description: '按關鍵詞在長期記憶庫裡檢索過往對話的要點，返回最相關的幾條。'.repeat(8),
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }],
      }],
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '這個量級應該壓得動').toBe(true);
    const { ctx, scratch } = makeCtx({
      globalRows: [{ key: AMSG_TOOL_CONFIG_KEY, value: packed }],
    });
    fired(await amsgHooks.onBeforeFire(ctx));
    expect((scratch.fire as any).mcpResolve.get('search_memory').toolName).toBe('search_memory');
  });

  it('雲端沒有 tool_pack → 拋錯（和 fire_pack 同批上傳，缺了就是狀態異常，不給空殼繼續）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: firePackValue() }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_pack/);
  });

  it('雲端沒有 tool_config → 拋錯（同上）', async () => {
    const { ctx } = makeCtx({ globalRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_config/);
  });

  it('任務行 next_send_at 解析不出時間 → 拋錯（occurrence 是閘和緩存鍵的必需字段）', async () => {
    const { ctx } = makeCtx({ nextSendAt: '不是時間' });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/next_send_at/);
  });

  it('任務缺 amsgTaskInstruction（舊格式）→ 拋錯，不能用默認指令湊一個', async () => {
    const { ctx } = makeCtx({ metadata: { amsgTaskInstruction: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/amsgTaskInstruction/);
  });

  it('任務 metadata 缺 charId → 拋錯', async () => {
    const { ctx } = makeCtx({ metadata: { charId: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/charId/);
  });
});

// ─── 連發上限：用戶主權硬閘（2026-08 炸屏事故的到點兜底半邊）───
//
// 語義：「用戶未回覆期間，角色自己排的任務最多響 N 次」。只攔 metadata 標了
// amsgSelfScheduled 的任務——用戶面板排的是明確意願，不受自己的防騷擾上限誤傷；
// 即時對話是在答用戶剛說的話，也不攔。計數隨「用戶開口」清零，不隨 fire_pack
// 重傳清零（後者正是當年提醒失效的迴路）。
describe('連發上限（到點兜底閘）', () => {
  /**
   * 造一份自述日誌：n 條主動 + 可選幾條即時回覆。
   *
   * 連發條數記在 unansweredSends 上，entries 只是給 prompt 看的上下文（最多留 8 條）；
   * 兩者分開正是「上限設 9 / 10 時閘失效」那條的修法，夾具也照真格式造。
   */
  const selfLogValue = (sends: number, opts: { replies?: number; basePackAt?: number } = {}) => {
    const entries = [
      ...Array.from({ length: sends }, (_, i) => ({ id: `s@${i}`, at: NOW.getTime() - (sends - i) * 60_000, text: `主動第${i + 1}條` })),
      ...Array.from({ length: opts.replies ?? 0 }, (_, i) => ({ id: `r@${i}`, at: NOW.getTime() - 30_000, text: `回覆${i + 1}`, reply: true })),
    ];
    return JSON.stringify({
      v: 4,
      basePackAt: opts.basePackAt ?? PACK_BUILT_AT,
      anchorUserMsgAt: null,
      entries: entries.slice(-SELF_LOG_MAX_ENTRIES),
      unansweredSends: sends,
      tasks: [],
    });
  };

  const rowsWith = (selfLog: string, packExtra: Record<string, unknown> = {}, lastUserMessageAt: number | null = null) => [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue(lastUserMessageAt, packExtra) },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
    { key: AMSG_SELF_LOG_KEY, value: selfLog },
  ];

  const lastSkipReason = (writeState: ReturnType<typeof vi.fn>) => {
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    return call ? JSON.parse(String(call[1][0].value)).reason : undefined;
  };

  it('自排任務到點、連發已達默認上限(3) → skip 並留 unanswered-limit 痕', async () => {
    const { ctx, writeState } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3)),
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    expect(lastSkipReason(writeState)).toBe('unanswered-limit');
  });

  it('用戶面板排的任務不受上限管：同樣 3 條連發，照常生成', async () => {
    const { ctx } = makeCtx({ charRows: rowsWith(selfLogValue(3)) });
    fired(await amsgHooks.onBeforeFire(ctx));
  });

  it('用戶開口後計數清零：自排任務照常發', async () => {
    // fire_pack 記錄的 lastUserMessageAt 比日誌錨新 → reconcile 清空 entries。
    const { ctx } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3), {}, NOW.getTime() - 10 * 60_000),
    });
    fired(await amsgHooks.onBeforeFire(ctx));
  });

  it('炸屏迴歸守衛：客戶端認領重傳（fire_pack 換代）不清計數，自排任務仍被攔', async () => {
    const { ctx, writeState } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3, { basePackAt: PACK_BUILT_AT - 1000 })),
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    expect(lastSkipReason(writeState)).toBe('unanswered-limit');
  });

  it('用戶自設上限按用戶的來：設 5 時第 4 條照常發、0（不限）永不攔', async () => {
    const looser = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3), { maxUnansweredSends: 5 }),
    });
    fired(await amsgHooks.onBeforeFire(looser.ctx));

    const unlimited = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(9), { maxUnansweredSends: 0 }),
    });
    fired(await amsgHooks.onBeforeFire(unlimited.ctx));
  });

  it('即時對話的回覆（reply 條目）不算連發', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(2, { replies: 3 })),
    });
    fired(await amsgHooks.onBeforeFire(ctx));
  });

  // 迴歸守衛：設置頁的下拉給到 1–10，而連發計數以前是數 entries 數出來的、entries 只留
  // 最近 8 條 —— 9 和 10 兩檔因此等於「不限」，這道專門為自排鏈炸屏加的硬閘整個失效。
  // 日誌按真實路徑攢（appendSelfLogEntry 會削 entries），才驗得出這件事。
  it('上限設 10、已連發 10 條 → 照樣攔下（計數不被 entries 的 8 條上限壓平）', async () => {
    let log = createSelfLog(PACK_BUILT_AT);
    for (let i = 0; i < 10; i += 1) {
      log = appendSelfLogEntry(log, {
        id: `s@${i}`, at: NOW.getTime() - (10 - i) * 60_000, text: `主動第${i + 1}條`,
      });
    }
    expect(log.entries).toHaveLength(SELF_LOG_MAX_ENTRIES);   // 前提：entries 確實被削過

    const { ctx, writeState } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(JSON.stringify(log), { maxUnansweredSends: 10 }),
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    expect(lastSkipReason(writeState)).toBe('unanswered-limit');
  });

  it('上限設 10、只連發 9 條 → 還差一條，照常生成', async () => {
    let log = createSelfLog(PACK_BUILT_AT);
    for (let i = 0; i < 9; i += 1) {
      log = appendSelfLogEntry(log, {
        id: `s@${i}`, at: NOW.getTime() - (9 - i) * 60_000, text: `主動第${i + 1}條`,
      });
    }
    const { ctx } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(JSON.stringify(log), { maxUnansweredSends: 10 }),
    });
    fired(await amsgHooks.onBeforeFire(ctx));
  });
});

// ─── 通用 MCP：到點把工具說明塊和 tools 聲明一起帶上 ───
//
// 提示詞塊和 tools 數組同源同拍（都來自那一行 tool_config），所以這幾條一起釘：
// 教了角色用工具，請求裡就得真有工具；沒配 MCP 的用戶則一個字都不該多出來。

describe('onBeforeFire 注入通用 MCP', () => {
  it('配了 MCP 服務器 → prompt 尾部帶工具塊，請求帶 mcp__ 前綴的 tools', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{ key: AMSG_TOOL_CONFIG_KEY, value: mcpToolConfigValue() }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    const prompt = result.messages[0].content;
    expect(prompt).toContain('問問對方吃了沒');           // 原來的任務指令還在
    expect(prompt).toContain('【外部工具');
    expect(prompt).toContain('search_memory');

    expect(result.tools?.map((t) => t.function.name)).toEqual(['mcp__search_memory']);
    expect(result.maxToolIterations).toBe(MCP_MAX_TOOL_ITERATIONS);
    // 參數表要原樣帶上，不然模型只能瞎猜字段名
    expect(result.tools?.[0].function.parameters).toMatchObject({
      properties: { query: { type: 'string' } },
    });
    // 名映射進 scratch，executeToolCalls 按暴露名回查是哪台服務器的哪個工具
    expect((scratch.fire as any).mcpResolve.get('search_memory').toolName).toBe('search_memory');
  });

  it('沒配 MCP → 一切照舊：不帶 tools、prompt 裡沒有工具塊', async () => {
    const { ctx, scratch } = makeCtx({});
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    expect(result.maxToolIterations).toBe(DEFAULT_TOOL_ITERATIONS);
    expect(result.messages[0].content).not.toContain('【外部工具');
    expect((scratch.fire as any).mcpResolve).toBeNull();
  });

  it('服務器只對別的角色可見 → 當作沒配（憑據不該串到不相干的角色身上）', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{
        key: AMSG_TOOL_CONFIG_KEY,
        value: mcpToolConfigValue({
          mcpServers: [{
            id: 'srv-memory', name: '記憶庫', url: 'https://mcp.example.com/mcp',
            charIds: ['別的角色'],
            tools: [{ name: 'search_memory', inputSchema: { type: 'object', properties: {} } }],
          }],
        }),
      }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    expect(result.messages[0].content).not.toContain('【外部工具');
    expect((scratch.fire as any).mcpResolve).toBeNull();
  });

  it('用戶關了原生 tools（中轉拒 tools）→ 不帶 tools 參數，改用正文協議教一遍', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{
        key: AMSG_TOOL_CONFIG_KEY,
        value: mcpToolConfigValue({ mcpUseNativeTools: false }),
      }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    const prompt = result.messages[0].content;
    expect(prompt).toContain('tool_name({"參數":"值"})');
    expect(prompt).toContain('search_memory(query*:string)');
    // 工具還是要認識的，只是走正文那條路
    expect((scratch.fire as any).mcpResolve.size).toBe(1);
  });
});

// ─── VAPID 配置兜底 ───
// scheduled() 在 !vapid.email 時會 console.error 後直接 return——整個 tick 一條任務都不處理。
// 而「推送憑據」面板複製出來的 env 裡 VAPID_EMAIL 是註釋掉的可選項，照著部署必然缺它，
// 表現是「到點了什麼都不發、前端沒有任何報錯」。email 只是 VAPID JWT 的 sub（聯繫方式），
// 不影響簽名有效性，缺省給一個合法 mailto 即可。
describe('VAPID 配置', () => {
  const baseEnv = {
    AMSG_MASTER_KEY: 'k'.repeat(64),
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: {},
  } as any;

  it('沒配 VAPID_EMAIL 時回退到合法 mailto，不能讓 scheduled() 整輪跳過', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: undefined });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('VAPID_EMAIL 只有空白字符時同樣回退（空串一樣會讓 scheduled 跳過）', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: '   ' });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('配了就用配的那個，不覆蓋用戶的聯繫方式', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: 'mailto:me@example.com' });
    expect(config.vapid.email).toBe('mailto:me@example.com');
  });

  // 上游端點的 CORS 頭由上游按 config.cors 出，包裝層自己的路由用另一份常量。
  // 兩處不一致的話，一半端點能用、另一半被瀏覽器攔死，而攔下的表現都是那句沒有
  // 下文的 "Failed to fetch"——最難查的那種半癱。
  it('上游 config 的 allowHeaders 跟包裝層預檢那份是同一串，且都放行 Content-Encoding', async () => {
    const config = buildWorkerConfig(baseEnv);
    const preflight = await (worker as any).fetch(
      new Request('https://w.example/instant-chat', { method: 'OPTIONS' }),
      baseEnv,
      { waitUntil: () => {} },
    );
    expect(config.cors.allowHeaders).toBe(preflight.headers.get('Access-Control-Allow-Headers'));
    expect(config.cors.allowHeaders).toContain('Content-Encoding');
  });

  it('解析函數本身：缺省/空白回退，配了就原樣用', () => {
    expect(resolveVapidEmail(undefined)).toMatch(/^mailto:/);
    expect(resolveVapidEmail('')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('  ')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

// 迴歸守衛：一條 Web Push 只裝得下 3993 字節明文，而角色一次可能分享六七張筆記。
// 過去的做法是硬砍到 4 張，用戶看到的是「說分享了 6 張、只出來 4 張卡」。現在按真實
// 字節算：裝得下照裝，裝不下把整份挪進 client_state、push 只留引用鍵，一張不少。
describe('offloadOversizedPush — push 裝不下時旁路存儲', () => {
  const CLIENT_TASK_ID = 'task-uuid-1';
  const bigNote = (n: number) => ({
    idx: n,
    note: {
      noteId: `note-${n}`,
      title: `第 ${n} 篇筆記的標題`.repeat(4),
      desc: '描述'.repeat(60),
      likes: 100 + n,
      author: `作者${n}`,
      authorId: `author-${n}`,
      coverUrl: `https://example.com/cover-${n}-${'x'.repeat(40)}.jpg`,
    },
  });
  const pushWith = (noteCount: number) => ({
    messageKind: 'content',
    message: '看到幾個好東西，分享給你～',
    title: '來自 小滿',
    metadata: {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      directives: Array.from({ length: noteCount }, (_, i) => ({ type: 'xhs_share', idx: i + 1 })),
      xhsSession: {
        notes: Array.from({ length: noteCount }, (_, i) => bigNote(i + 1)),
        xsecTokens: [],
      },
    },
  });

  it('裝得下就原樣發，不碰雲端狀態（日常 1-3 張走的就是這條）', async () => {
    const writeState = vi.fn();
    const payload = pushWith(1);
    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(payload);
    expect(writeState).not.toHaveBeenCalled();
  });

  it('裝不下 → 整份 xhsSession 存進 client_state，push 換成引用鍵且回到限內', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = pushWith(8);
    // 上限按 UTF-8 字節算，不是字符數——中文一個字三個字節，拿 .length 比會算漏一大截。
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgXhsSessionKey(CLIENT_TASK_ID);
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [
      { key, value: JSON.stringify((payload.metadata as any).xhsSession) },
    ]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.xhsSessionRef).toBe(key);
    expect(meta.xhsSession).toBeUndefined();
    expect(meta.directives).toHaveLength(8);          // 引用一條不少，只是數據挪了地方
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  it('老部署沒有寫入口 → 拋錯走重試，絕不砍掉筆記湊合發出去', async () => {
    await expect(offloadOversizedPush(pushWith(8) as any, undefined, CHAR_ID, CLIENT_TASK_ID))
      .rejects.toThrow(/AMSG2_WRITE_STATE_UNSUPPORTED/);
  });

  // 存儲鍵是按 clientTaskId 編的，缺了就沒法旁路。這時候庫會拋 PUSH_PAYLOAD_TOO_LARGE
  // 把整條消息卡住，光看那個錯認不出根因——所以先吼一聲，wrangler tail 上一眼看得見。
  it('超限但沒有 clientTaskId → 吼一聲說清「旁路用不上」，別只留一個超限錯', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeState = vi.fn();
    const payload = pushWith(8) as any;

    const out = await offloadOversizedPush(payload, writeState, CHAR_ID, '');

    expect(out).toBe(payload);
    expect(writeState).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('沒有 clientTaskId'))).toBe(true);
    warn.mockRestore();
  });

  it('超限但沒有可旁路的內容 → 原樣交給庫拋 PUSH_PAYLOAD_TOO_LARGE，不假裝成功', async () => {
    const writeState = vi.fn();
    const fat = { messageKind: 'content', message: '正'.repeat(2000), metadata: { charId: CHAR_ID } };
    const out = await offloadOversizedPush(fat as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(fat);
    expect(writeState).not.toHaveBeenCalled();
  });

  // 迴歸守衛：判定要留餘量。這裡量的是 hook 交還給庫的那份，庫之後還會補
  // messageId / sessionId / timestamp / messageIndex / totalMessages（sendHookPushPayloads），
  // 實測多出一百多字節。卡著上限判的話，量出來「剛好裝得下」的那一檔補完字段就超了：
  // 既沒旁路、也發不出去，整條消息丟掉，而且每次重試都死在同一處。
  it('貼著上限（餘量不足）也走旁路，別等庫補完字段才發現超了', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

    // 拿真實形狀撐到「限內、但餘量不到 256 字節」這一檔，逐字節逼近，不寫死魔數。
    const payload = pushWith(1) as any;
    while (utf8Bytes(payload) < MAX_PUSH_PAYLOAD_BYTES - 200) {
      payload.message += '一';
    }
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);   // 舊判定會說「裝得下」

    const out = await offloadOversizedPush(payload, writeState, CHAR_ID, CLIENT_TASK_ID);

    expect(writeState).toHaveBeenCalledTimes(1);
    expect((out.metadata as any).xhsSessionRef).toBe(amsgXhsSessionKey(CLIENT_TASK_ID));
    // 挪走之後要給庫補字段留出足夠空間。
    expect(MAX_PUSH_PAYLOAD_BYTES - utf8Bytes(out)).toBeGreaterThanOrEqual(256);
  });

  // 雲端情緒評估的結果是一整段模型輸出，撐爆一條 push 很正常。它得跟 XHS 那份一樣能
  // 旁路走，而且**排在前面**：客戶端拿它只是落 buff，晚一步取回來不影響這條消息本身，
  // 而 XHS 數據關係到這條消息裡的卡片能不能出來。
  it('情緒評估結果撐爆一條 push → 先挪它，push 換成 amsgEmotionRef', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const evalRaw = `{"changed":true,"innerState":"${'想'.repeat(1500)}"}`;
    const payload = {
      messageKind: 'content',
      message: '在的。',
      metadata: { charId: CHAR_ID, amsgClientTaskId: CLIENT_TASK_ID, amsgEmotionUpdate: evalRaw },
    };
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgEmotionUpdateKey(CLIENT_TASK_ID);
    // 存原文（不再包一層 JSON）：客戶端取回來直接喂 applyEmotionEvalRaw
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [{ key, value: evalRaw }]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgEmotionRef).toBe(key);
    expect(meta.amsgEmotionUpdate).toBeUndefined();
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  // 思考鏈也是一整段模型輸出，而且常常比評估結果還長，所以排在最前面挪。
  it('思考鏈撐爆一條 push → 先挪它，push 換成 amsgReasoningRef', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const reasoning = '他這句話背後想說的是'.repeat(300);
    const payload = {
      messageKind: 'content',
      message: '在的。',
      metadata: { charId: CHAR_ID, amsgClientTaskId: CLIENT_TASK_ID, amsgReasoning: reasoning },
    };
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgReasoningKey(CLIENT_TASK_ID);
    // 存原文：客戶端取回來直接當思考鏈渲染
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [{ key, value: reasoning }]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgReasoningRef).toBe(key);
    expect(meta.amsgReasoning).toBeUndefined();
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  // 迴歸守衛：接力要一棒接一棒。第二棒若是從原始 metadata 重新起算，第一棒挪走的思考鏈
  // 會被原樣塞回 push、引用鍵也丟——push 照樣超限，而日誌上看著「兩份都挪了」。
  it('思考鏈和評估結果都得挪 → 兩個引用鍵都在，原文一個不留', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = {
      messageKind: 'content',
      message: '在的。',
      metadata: {
        charId: CHAR_ID,
        amsgClientTaskId: CLIENT_TASK_ID,
        // 兩份各自都撐得爆一條 push：只挪走一份還是超限，才逼得出接力那一步。
        amsgReasoning: '他這句話背後想說的是'.repeat(300),
        amsgEmotionUpdate: `{"changed":true,"innerState":"${'想'.repeat(1500)}"}`,
      },
    };

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    expect(writeState).toHaveBeenCalledTimes(2);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgReasoningRef).toBe(amsgReasoningKey(CLIENT_TASK_ID));
    expect(meta.amsgEmotionRef).toBe(amsgEmotionUpdateKey(CLIENT_TASK_ID));
    expect(meta.amsgReasoning).toBeUndefined();
    expect(meta.amsgEmotionUpdate).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(out)).length)
      .toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  it('挪完評估還是裝不下 → XHS 那份接著挪（兩個引用鍵都留在 push 上）', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = pushWith(8) as any;
    payload.metadata.amsgEmotionUpdate = `{"changed":true,"innerState":"${'想'.repeat(300)}"}`;

    const out = await offloadOversizedPush(payload, writeState, CHAR_ID, CLIENT_TASK_ID);

    expect(writeState).toHaveBeenCalledTimes(2);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgEmotionRef).toBe(amsgEmotionUpdateKey(CLIENT_TASK_ID));
    expect(meta.xhsSessionRef).toBe(amsgXhsSessionKey(CLIENT_TASK_ID));
    expect(meta.directives).toHaveLength(8);
  });
});

// 服務端工具循環的編排：跑完一個工具之後跟模型說什麼，以及重複調用怎麼辦。
// 這段是「amsg2 和前台行為對齊」的落點——前台每次回喂都明說「別再輸出這個標籤了」，
// worker 以前只回裸 JSON，模型看不出這一步已經做完，提示詞裡有句常駐的「先去查 X」
// 就會每輪照做、跑滿上限，然後 AGENTIC_LOOP_EXCEEDED、任務不出清、下一分鐘整條重跑。
describe('executeToolCalls 的工具編排', () => {
  const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    function: { name, arguments: JSON.stringify(args) },
  });

  /** 造一個跑到 executeToolCalls 那一步的 sessionCtx（scratch.fire 由 onBeforeFire 掛好）。 */
  const readySession = async () => {
    const { ctx, scratch } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    return { sessionId: 'sess_task_42', scratch } as any;
  };

  it('回喂的不是裸 JSON，而是帶「別重複」引導的一段話', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    expect(out.content).not.toMatch(/^\{/);        // 不是裸 JSON
    expect(out.content).toContain('不要再來一遍');
    expect(out.content).toContain('調取某個月的記憶');
  });

  it('同名同參第二次直接打回，不再真跑一遍工具', async () => {
    const session = await readySession();
    const call = toolCall('c1', 'recall', { year: '2026', month: '06' });
    await amsgHooks.executeToolCalls([call], session);
    const [second] = await amsgHooks.executeToolCalls(
      [{ ...call, id: 'c2' }],
      session,
    );
    expect(second.content).toContain('沒有再執行');
  });

  // 閘只攔「完全一樣」的調用。換個月份是正當的多輪使用，攔了就是把能力砍了。
  it('換了參數照常放行——多輪能力不受影響', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [other] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { year: '2026', month: '07' })],
      session,
    );
    expect(other.content).not.toContain('沒有再執行');
  });

  it('狀態查詢中間執行過動作後允許再次查詢——遊戲流程不會被歷史去重誤殺', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { year: '2026', month: '07' })],
      session,
    );
    const [afterAction] = await amsgHooks.executeToolCalls(
      [toolCall('c3', 'recall', { year: '2026', month: '06' })],
      session,
    );
    expect(afterAction.content).not.toContain('沒有再執行');

    const [immediateRepeat] = await amsgHooks.executeToolCalls(
      [toolCall('c4', 'recall', { year: '2026', month: '06' })],
      session,
    );
    expect(immediateRepeat.content).toContain('沒有再執行');
  });

  it('參數字段順序變了仍算同一次調用', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [reordered] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { month: '06', year: '2026' })],
      session,
    );
    expect(reordered.content).toContain('沒有再執行');
  });

  // 輪次快用完了還在請求工具，上游會拋 AGENTIC_LOOP_EXCEEDED：這次攢的旁白全丟、任務
  // 不出清、下一分鐘整條從頭重跑。先在回喂裡說一聲，模型自己收尾最省。
  it('倒數第二輪的回喂末尾加一句「這是最後一輪」', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      { ...session, iteration: DEFAULT_TOOL_ITERATIONS - 2 },
    );
    expect(out.content).toContain('最後一輪');
  });

  it('還早的輪次不加那句話（別一上來就催著收尾）', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      { ...session, iteration: 0 },
    );
    expect(out.content).not.toContain('最後一輪');
  });
});

// 輪次預算：worker 判「這是最後一輪了」用的數必須和上游真正跑的輪數是同一個，
// 否則不是提前一輪白收尾、就是照舊撞上 AGENTIC_LOOP_EXCEEDED。
describe('輪次上限與上游共用同一個數', () => {
  const sessionCtx = (scratch: Record<string, unknown>, llmOutputText: string, iteration: number) => ({
    sessionId: 'sess_task_42',
    taskId: 42,
    taskUuid: TASK_UUID,
    llmResponse: {},
    llmOutputText,
    contactName: 'Nyah',
    metadata: { charId: CHAR_ID, amsgMode: 'auto' },
    scratch,
    iteration,
  }) as any;

  it('onBeforeFire 把輪次上限顯式回傳給上游', async () => {
    const { ctx } = makeCtx({});
    const result = await amsgHooks.onBeforeFire(ctx) as { maxToolIterations?: number };
    expect(result.maxToolIterations).toBe(DEFAULT_TOOL_ITERATIONS);
  });

  it('最後一輪還想調工具 → 直接收尾，不把 tool-request 交回上游', async () => {
    const { ctx, scratch } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);

    const first = await amsgHooks.onLLMOutput(
      sessionCtx(scratch, '我先想想六月的事。\n[[RECALL: 2026-06]]', 0)) as any;
    expect(first.decision).toBe('tool-request');

    const last = await amsgHooks.onLLMOutput(
      sessionCtx(scratch, '再查一次。\n[[RECALL: 2026-07]]', DEFAULT_TOOL_ITERATIONS - 1)) as any;
    expect(last.decision).toBe('finish');
    expect(last.pushPayloads.map((p: any) => p.message).join('\n')).toContain('我先想想六月的事');
  });
});

// 雲端生成的思考鏈要跟著回覆一起回到客戶端，否則聊天走即時對話這條路時思考鏈卡片整個缺席
// （用戶開著「顯示思考鏈」，本地路徑有、雲端路徑沒有，看上去就是角色這次沒想）。
// 它掛在**第一條** push 的 metadata 上：卡片渲染在第一條氣泡上，收側也只在
// messageIndex<=1 時認領。
describe('雲端思考鏈隨首條 push 回客戶端', () => {
  const CLIENT_TASK_ID = 'client-task-reasoning';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在嗎' },
  ];
  /** 兩段正文 → 兩條 push，才驗得出「只掛第一條」。 */
  const TWO_SEGMENT_OUTPUT = '在的。\n怎麼啦？';

  afterEach(() => vi.unstubAllGlobals());

  /** 一輪 LLM：正文 + 可選的思考（放在哪個響應字段裡也能挑）。 */
  interface Round {
    output: string;
    reasoning?: string;
    /** 思考放哪個字段，默認 reasoning_content。 */
    field?: 'reasoning_content' | 'reasoning' | 'thinking';
  }

  /**
   * 跑一次即時對話的 fire，可以連喂好幾輪（工具循環）；返回最後一輪的 decision。
   * 走即時對話是因為思考鏈只在這條路回傳——定時任務那條見下面單獨一條用例。
   */
  const instantFire = async (rounds: Round[], extraMeta: Record<string, unknown> = {}) => {
    const store = makeFireStore(CHAT_MESSAGES);
    const scratch: Record<string, unknown> = {};
    const metadata = {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant',
      amsgInstantChat: true,
      ...extraMeta,
    };
    await amsgHooks.onBeforeFire({
      task: {
        id: FIRE_TASK_ID, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
        nextSendAt: FIRE_NEXT_SEND_AT, metadata,
      },
      userId: 'u1',
      readState: store.readState,
      writeState: store.writeState,
      now: NOW,
      scratch,
    } as any);

    let decision: any;
    for (const [iteration, round] of rounds.entries()) {
      decision = await amsgHooks.onLLMOutput({
        sessionId: `sess_task_${FIRE_TASK_ID}@1`, taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
        llmResponse: {
          choices: [{
            message: {
              content: round.output,
              ...(round.reasoning ? { [round.field ?? 'reasoning_content']: round.reasoning } : {}),
            },
          }],
        },
        llmOutputText: round.output, contactName: 'Nyah',
        metadata, scratch, writeState: store.writeState, iteration,
      } as any);
    }
    return decision;
  };

  // 字段名各家不一樣：reasoning_content 是 deepseek-r1 / GLM 那批，OpenRouter 轉出來叫
  // reasoning，還有渠道寫 thinking。只認一個的話，換個渠道就靜默沒有卡片了。
  it.each(['reasoning_content', 'reasoning', 'thinking'] as const)(
    '響應字段 %s 裡的思考 → 掛第一條 push，正文不帶 <think>',
    async (field) => {
      const decision = await instantFire([{
        output: TWO_SEGMENT_OUTPUT,
        reasoning: '他這句問得很輕，先接住再問一句。',
        field,
      }]);

      expect(decision.decision).toBe('finish');
      const payloads = decision.pushPayloads as Array<Record<string, any>>;
      expect(payloads.length).toBeGreaterThanOrEqual(2);
      expect(payloads[0].metadata.amsgReasoning).toContain('先接住再問一句');
      for (const payload of payloads.slice(1)) {
        expect(payload.metadata.amsgReasoning).toBeUndefined();
      }
      expect(JSON.stringify(payloads)).not.toContain('<think>');
    },
  );

  it('只有正文內聯 <think> 的模型也拿得到（正文照舊剝乾淨）', async () => {
    const decision = await instantFire([{ output: '<think>他好像有點累了。</think>在的。\n怎麼啦？' }]);

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads[0].metadata.amsgReasoning).toContain('他好像有點累了');
    for (const payload of payloads.slice(1)) {
      expect(payload.metadata.amsgReasoning).toBeUndefined();
    }
    expect(payloads.map((p) => p.message)).toEqual(['在的。', '怎麼啦？']);
    expect(JSON.stringify(payloads)).not.toContain('<think>');
  });

  // 工具循環一次 fire 跑好幾輪，每輪都有自己的思考。留最後一輪的：用戶看到的正文就是
  // 那一輪寫的，配上「我先去查一下」的中間輪思考等於答非所問。
  it('多輪工具循環 → 留下產出正文那一輪的思考', async () => {
    const decision = await instantFire([
      { output: '等我想想。\n[[RECALL: 2026-06]]', reasoning: '第一輪：先去翻六月的記憶。' },
      { output: '想起來了，那天你說想去看海。', reasoning: '第二輪：翻到了那天的事，說給他聽。' },
    ]);

    expect(decision.decision).toBe('finish');
    const meta = decision.pushPayloads[0].metadata;
    expect(meta.amsgReasoning).toContain('第二輪');
    expect(meta.amsgReasoning).not.toContain('第一輪');
  });

  // 「留最後一輪的」包括最後一輪沒思考的情形：這時候一個字段都不掛。拿中間輪那句
  // 「我先去查一下」頂上的話，卡片裡寫的是查資料，正文說的是看海。
  it('最後一輪沒思考 → 中間輪那句不許頂上來', async () => {
    const decision = await instantFire([
      { output: '等我想想。\n[[RECALL: 2026-06]]', reasoning: '第一輪：先去翻六月的記憶。' },
      { output: '想起來了，那天你說想去看海。' },
    ]);

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgReasoning).toBeUndefined();
    }
  });

  // 定時任務這條路的 prompt 是 renderFirePack 現拼的，沒有「心象」那段提示詞，模型的
  // thinking 就是原始推理腔（「用戶三小時沒說話了，我應該……」）。那個當心象卡片放出去
  // 是穿幫，所以這道門先只對即時對話開。
  it('定時任務的那份思考不回傳（沒有心象提示詞，推理腔不當心象）', async () => {
    const { decision } = await runFire(makeFireStore(), {
      metadata: {
        amsgClientTaskId: CLIENT_TASK_ID,
        amsgMode: 'auto',
        amsgTaskInstruction: '想到什麼說什麼',
      },
      llmOutput: TWO_SEGMENT_OUTPUT,
      llmResponse: {
        choices: [{
          message: {
            content: TWO_SEGMENT_OUTPUT,
            reasoning_content: '用戶三小時沒說話了，我應該主動關心一下。',
          },
        }],
      },
    });

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    for (const payload of payloads) {
      expect(payload.metadata.amsgReasoning).toBeUndefined();
    }
    expect(JSON.stringify(payloads)).not.toContain('我應該主動關心');
  });

  // 只有一段正文時，思考鏈（掛第一條）和情緒評估（掛最後一條）落在同一條 push 上。
  // 兩次掛載各自 spread 一遍 metadata，誰把誰蓋掉都是靜默的：要麼沒有心象卡片、
  // 要麼情緒永遠不更新，而日誌上什麼都看不出來。
  it('只有一條 push 時思考鏈和情緒評估同時掛上，誰也不蓋誰', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"changed":true,"buffs":[]} EVAL-RAW-MARKER' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const decision = await instantFire(
      [{ output: '在的。', reasoning: '他終於開口了。' }],
      {
        amsgEmotionEval: {
          prompt: '你是一個角色情緒分析系統。',
          api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-eval', model: 'eval-mini' },
        },
      },
    );

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads).toHaveLength(1);
    const meta = payloads[0].metadata;
    expect(meta.amsgReasoning).toContain('他終於開口了');
    expect(meta.amsgEmotionUpdate).toContain('EVAL-RAW-MARKER');
    expect(meta.amsgEmotionDone).toBe(true);
  });
});

// 即時對話這一輪在雲端跑過哪些工具，要跟著回覆一起回到客戶端，氣泡底下才畫得出那行灰字
// （「調用了工具：搜索網頁 ×2」）。本地那條路全程有搜索狀態條，雲端這條路全程靜默——
// 不帶這份的話，角色突然知道了今天的新聞，用戶看不出這是查來的。
// 它掛在**最後一條** push 上：跟正文一起收尾，用戶讀完才看到痕跡。
// 線上傳的是原始工具名 + 次數，翻譯成人話是客戶端的事（見 utils/amsgToolTrace.ts）。
describe('雲端工具痕跡隨末條 push 回客戶端', () => {
  const CLIENT_TASK_ID = 'client-task-tooltrace';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '今天有什麼新聞' },
  ];
  /** 兩段正文 → 兩條 push，才驗得出「只掛最後一條」。 */
  const TWO_SEGMENT_OUTPUT = '我看了下。\n沒什麼大事。';

  const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    function: { name, arguments: JSON.stringify(args) },
  });

  /**
   * 跑一次 fire：onBeforeFire → 依次執行工具 → onLLMOutput 收尾，返回 decision。
   *
   * 一次網絡請求都不發也能驗完整條：這套夾具裡 recall 讀 tool_pack 裡那份記憶（真跑了，
   * 只是沒查到）、web_search 缺 key 直接打回（壓根沒跑）、排程走注進去的 scheduleTask 樁。
   */
  const fireWithTools = async (opts: {
    instant: boolean;
    tools: Array<{ name: string; args: Record<string, unknown> }>;
    /** 給了才注入取消能力（不給的話取消工具會以 not_supported 打回，測不出別的）。 */
    cancelTask?: (uuid: string) => Promise<{ cancelled: boolean }>;
  }) => {
    const store = makeFireStore(opts.instant ? CHAT_MESSAGES : undefined);
    const scratch: Record<string, unknown> = {};
    const scheduleTask = async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    });
    const cancelTask = opts.cancelTask;
    const metadata = {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      ...(opts.instant
        ? { amsgMode: 'instant', amsgInstantChat: true }
        : { amsgMode: 'auto', amsgTaskInstruction: '想到什麼說什麼' }),
    };
    await amsgHooks.onBeforeFire({
      task: {
        id: FIRE_TASK_ID, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
        nextSendAt: FIRE_NEXT_SEND_AT, metadata,
      },
      userId: 'u1',
      readState: store.readState,
      writeState: store.writeState,
      now: NOW,
      scratch,
      scheduleTask,
    } as any);

    for (const [i, tool] of opts.tools.entries()) {
      await amsgHooks.executeToolCalls(
        [toolCall(`c${i}`, tool.name, tool.args)],
        {
          sessionId: `sess_task_${FIRE_TASK_ID}@1`, scratch, iteration: 0,
          scheduleTask, cancelTask,
        } as any,
      );
    }

    return await amsgHooks.onLLMOutput({
      sessionId: `sess_task_${FIRE_TASK_ID}@1`, taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
      llmResponse: {}, llmOutputText: TWO_SEGMENT_OUTPUT, contactName: 'Nyah',
      metadata, scratch, writeState: store.writeState, iteration: 1, scheduleTask,
    } as any) as any;
  };

  // 排程工具校驗 send_at 用的是真實時鍾（executeToolCalls 傳的是 Date.now()，不是
  // ctx.now），所以這裡必須相對**現在**取未來時刻——照夾具裡那個固定的 NOW 算的話，
  // 這次排程會被 send_at_too_soon 打回，測的就不是「排成功的調用記進痕跡」了。
  const SEND_AT = new Date(Date.now() + 90 * 60_000).toISOString();

  it('同一個工具跑了兩次 → 按第一次出現的順序壓成名字 + 次數，只掛最後一條', async () => {
    const decision = await fireWithTools({
      instant: true,
      tools: [
        { name: 'recall', args: { year: '2026', month: '06' } },
        { name: 'schedule_active_message', args: { send_at: SEND_AT } },
        { name: 'recall', args: { year: '2026', month: '07' } },
      ],
    });

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    const lastMeta = payloads[payloads.length - 1].metadata;
    expect(lastMeta.amsgToolTrace).toEqual([
      { name: 'recall', count: 2 },
      { name: 'schedule_active_message', count: 1 },
    ]);
    for (const payload of payloads.slice(0, -1)) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  // 這行灰字要防的就是「角色說了句我查過」而其實什麼都沒發生。沒配 key / 連不上 /
  // 服務器沒開機的調用一個請求都沒發出去，記進痕跡等於自己造了個新的穿幫點。
  it('沒配就沒跑的調用不算數（web_search 缺 key，一個請求都沒發）', async () => {
    const decision = await fireWithTools({
      instant: true,
      tools: [{ name: 'web_search', args: { query: '今天的新聞' } }],
    });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  // 「跑了沒查到」跟「壓根沒跑」是兩回事：前者角色說「我翻了下沒找到」是實話，
  // 痕跡也該記上——它是真去翻了。
  it('跑了但沒查到東西的照樣算', async () => {
    const decision = await fireWithTools({
      instant: true,
      // 夾具裡 memories 是空的 → recall 返回 no_logs（跑到了，只是這個月沒東西）
      tools: [{ name: 'recall', args: { year: '2026', month: '06' } }],
    });

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads[payloads.length - 1].metadata.amsgToolTrace)
      .toEqual([{ name: 'recall', count: 1 }]);
  });

  // 被打回的調用同樣不算。排程 / 取消 / 改期的打回碼（no_tasks、task_not_found、
  // ambiguous_task、unanswered_limit…）都不在 neverRan 那個集合裡，照它篩的話這些會被
  // 當成「跑起來了」記進痕跡——於是取消失敗的那次也在氣泡底下寫一行「調用了工具：
  // 取消排好的消息」，用戶據此以為排程沒了，而那條任務原封不動到點照響。
  it('被打回的取消不算數（遠端一次都沒調，什麼都沒改）', async () => {
    const cancelTask = vi.fn(async () => ({ cancelled: true }));
    const decision = await fireWithTools({
      instant: true,
      cancelTask,
      // 這個角色現在一條排程都沒掛著 → no_tasks 打回
      tools: [{ name: 'cancel_active_message', args: { task_id: 'nosuch12' } }],
    });

    expect(decision.decision).toBe('finish');
    expect(cancelTask, '連遠端都沒調，更沒改動任何東西').not.toHaveBeenCalled();
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  it('被打回的排程不算數（send_at 太近，一條任務都沒建）', async () => {
    const decision = await fireWithTools({
      instant: true,
      tools: [{
        name: 'schedule_active_message',
        args: { send_at: new Date(Date.now() + 10_000).toISOString() },
      }],
    });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  it('這一輪一個工具都沒跑 → 一個字段都不掛（氣泡底下不該憑空多一行）', async () => {
    const decision = await fireWithTools({ instant: true, tools: [] });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  // 定時任務那條路的氣泡是憑空冒出來的（用戶沒在等這一輪），底下再掛一行「調用了工具」
  // 等於把後台實現攤開給用戶看。這行灰字先只給即時對話。
  it('定時任務那條路不帶痕跡', async () => {
    const decision = await fireWithTools({
      instant: false,
      tools: [{ name: 'recall', args: { year: '2026', month: '06' } }],
    });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });
});

// 通用 MCP 的執行環節：worker 直連用戶自己配的服務器（服務端 fetch 沒有 CORS，
// 不經代理）。這裡釘三件事——真的打到了配置裡那個地址並帶上憑據、同一次 fire 內
// 握手只做一次、以及任何失敗都以 ok:false 回喂而不是把整條 fire 炸掉。
describe('runMcpFireTool', () => {
  const probe: McpFireServer = {
    id: 's1',
    name: '探針',
    url: 'https://probe.example.com/mcp',
    token: 'tok-1',
    tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: {} } }],
  };
  // maxNameLen 與 onBeforeFire 一致（給前綴留位）。
  const stashFragment = () => ({
    mcpResolve: buildMcpNameMap([probe], { maxNameLen: MCP_FIRE_NAME_BUDGET }),
    mcpSessions: new Map(),
    mcpSpentMs: 0,
  });

  const rpcOk = (id: number, result: unknown) => new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  afterEach(() => vi.unstubAllGlobals());

  it('握手 + tools/call 直連 server.url，帶 Bearer，結果 ok', async () => {
    const seen: Array<{ url: string; body: any; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(input), body, auth: new Headers(init.headers).get('Authorization') });
      if (body.method === 'initialize') {
        return rpcOk(body.id, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: '暗號 MARKER-123' }] });
    }));

    const result = await runMcpFireTool(stashFragment(), 'mcp__get_secret', {});

    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain('MARKER-123');
    expect(seen.every((s) => s.url.startsWith('https://probe.example.com/mcp'))).toBe(true);
    expect(seen.every((s) => s.auth === 'Bearer tok-1')).toBe(true);
    expect(seen.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  });

  // 會話掛在單次 fire 的 stash 上；一次 fire 最多五輪，每輪都重握手就是白燒往返。
  it('同一 fire 內第二次調用複用 session（不重複握手）', async () => {
    let handshakes = 0;
    vi.stubGlobal('fetch', vi.fn(async (_: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        handshakes++;
        return rpcOk(body.id, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: 'x' }] });
    }));

    const stash = stashFragment();
    await runMcpFireTool(stash, 'mcp__get_secret', {});
    await runMcpFireTool(stash, 'mcp__get_secret', { a: 1 });

    expect(handshakes).toBe(1);
  });

  it('未配置的工具名 → ok:false 而不是拋錯（回餵給模型圓場）', async () => {
    const result = await runMcpFireTool(stashFragment(), 'mcp__nope', {});
    expect(result).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('服務器錯誤 → ok:false 帶原因（不炸 fire 鏈）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await runMcpFireTool(stashFragment(), 'mcp__get_secret', {});
    expect(result).toMatchObject({ ok: false, reason: 'mcp_error', source: '探針' });
  });

  // 單次超時之外還有一條全 fire 共享的總預算：native FC 一輪能吐好幾個調用，
  // executeToolCalls 串行 await，只卡單次的話 25s × N 照樣能頂穿 240s 總預算，
  // 那就是 AGENTIC_LOOP_EXCEEDED、任務不出清、下一分鐘整條從頭重跑。
  it('預算用盡 → 直接 ok:false 早退，一個請求都不發', async () => {
    const fetchSpy = vi.fn(async () => new Response('never', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const stash = { ...stashFragment(), mcpSpentMs: 120_000 };
    const result = await runMcpFireTool(stash, 'mcp__get_secret', {});

    expect(result).toMatchObject({ ok: false, reason: 'mcp_budget_exhausted', source: '探針' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('調用完把耗時記進 mcpSpentMs（後續調用才知道還剩多少）', async () => {
    // 假時鐘：只在服務器回 tools/call 結果那一刻往前撥 700ms，模擬這次調用真的花了這麼久。
    // 不用真等，也不受「這段代碼一共讀了幾次 Date.now」影響。
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('fetch', vi.fn(async (_: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return rpcOk(body.id, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      clock += 700;
      return rpcOk(body.id, { content: [{ type: 'text', text: 'x' }] });
    }));

    const stash = stashFragment();
    await runMcpFireTool(stash, 'mcp__get_secret', {});
    nowSpy.mockRestore();

    expect(stash.mcpSpentMs).toBe(700);
  });
});

// 迴歸守衛：主動消息的多輪連續性。
//
// fire_pack 的【最近對話上下文】停在「用戶最後一次聊天」那一刻，用戶離線期間不會刷新。
// 沒有這條回寫鏈的話，連著觸發兩次，角色第二次讀到的上下文與第一次逐字一樣——它不知道
// 自己剛說過什麼，只會把同一句話換個說法再發一遍，而且全程不報錯，靜默退化成單輪。
// 下面這組用例是端到端的：真的跑兩次 fire，第二次的 prompt 裡必須出現第一次發的正文。
describe('self_log — 角色自述回寫', () => {
  const CLIENT_TASK_ID = 'client-task-1';

  /** 帶自述槽位的 fire_pack（當前客戶端打的包長這樣）。 */
  const slottedFirePack = (builtAt: number = PACK_BUILT_AT) => JSON.stringify({
    v: FIRE_PACK_VERSION,
    template: `【最近對話上下文】\n用戶：先睡了${AMSG_SLOT_SELF_LOG}\n\n【本次任務】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    lastUserMessageAt: null,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    builtAt,
    pendingTasks: [],
    scene: null,
    selfScheduleEnabled: true,
  });

  /** 會真的記住寫入的假 client_state：第二次 fire 靠它讀回第一次寫下的自述。 */
  const makeStore = (firePack: string) => {
    const rows = new Map<string, string>([
      [AMSG_FIRE_PACK_KEY, firePack],
      [AMSG_TOOL_PACK_KEY, toolPackValue],
    ]);
    let writeFails = false;
    const readState = vi.fn(async (namespace: string) => (
      namespace.startsWith('amsg:char:')
        ? [...rows].map(([key, value]) => ({ key, value }))
        : [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }]
    ));
    const writeState = vi.fn(async (
      _namespace: string,
      entries: Array<{ key: string; value: string | null }>,
    ) => {
      if (writeFails) throw new Error('write failed');
      for (const entry of entries) {
        if (entry.value === null) rows.delete(entry.key);
        else rows.set(entry.key, entry.value);
      }
      return { upserted: entries.length, skipped: 0, deleted: 0 };
    });
    return {
      rows,
      readState,
      writeState,
      failWrites: () => { writeFails = true; },
      selfLog: () => parseSelfLog(rows.get(AMSG_SELF_LOG_KEY) ?? ''),
    };
  };

  /**
   * 跑一次完整的 fire：組 prompt → 交一段 LLM 輸出 → 走完 finish → 模擬庫發完推送後
   * 調 onAfterSend（amsg-server 2.6.0-next.10 的發送後回執；task 傳 D1 行原樣的最小
   * 子集，對號只看 id）。sentCount 缺省 = 全部段都送出去了；傳數字模擬部分失敗。
   * 返回這次實際發給 LLM 的 prompt，第二次調用時用它斷言「接上了沒有」。
   */
  const runFire = async (
    store: ReturnType<typeof makeStore>,
    opts: { sendAt: string; llmOutput: string; sentCount?: number; skipAfterSend?: boolean },
  ) => {
    const scratch: Record<string, unknown> = {};
    const fireCtx = {
      task: {
        id: 42,
        uuid: TASK_UUID,
        contactName: 'Nyah',
        recurrenceType: 'daily',
        nextSendAt: opts.sendAt,
        metadata: {
          charId: CHAR_ID,
          amsgExpirePolicy: 'force',
          amsgTaskInstruction: '想到什麼說什麼',
          amsgClientTaskId: CLIENT_TASK_ID,
        },
      },
      userId: 'u1',
      readState: store.readState,
      writeState: store.writeState,
      now: new Date(opts.sendAt),
      scratch,
    } as any;

    const prompt = fired(await amsgHooks.onBeforeFire(fireCtx)).messages[0].content;

    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42@1',
      taskId: 42,
      taskUuid: TASK_UUID,
      llmResponse: {},
      llmOutputText: opts.llmOutput,
      contactName: 'Nyah',
      metadata: {
        charId: CHAR_ID,
        amsgClientTaskId: CLIENT_TASK_ID,
        amsgMode: 'auto',
      },
      scratch,
      writeState: store.writeState,
    } as any) as any;

    // 上游的 onFireSettled 無論這次 fire 是發出去了、跳過了還是拋錯了都會調一次，
    // 這裡照著來——只在 finish 分支調的話，驗不到「沒正文可發時角色自排的任務還落不落帳」。
    if (!opts.skipAfterSend) {
      const sent = decision.decision === 'finish';
      const total = sent ? decision.pushPayloads.length : 0;
      await amsgFireSettled({
        status: sent ? 'sent' : 'skipped',
        sentCount: sent ? (opts.sentCount ?? total) : 0,
        scratch,
        writeState: store.writeState,
      });
    }

    return { prompt, decision, scratch };
  };

  it('第二次觸發能看見第一次發了什麼（核心迴歸守衛）', async () => {
    const store = makeStore(slottedFirePack());

    const first = await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '剛看到樓下那隻貓又來了',
    });
    expect(first.decision.decision).toBe('finish');
    expect(first.prompt, '第一次當然還沒有自述').not.toContain('剛看到樓下那隻貓又來了');

    const second = await runFire(store, {
      sendAt: '2026-07-25T14:00:00.000Z',
      llmOutput: '它蹲在那兒一直沒走',
    });
    expect(second.prompt).toContain('剛看到樓下那隻貓又來了');
    expect(second.prompt).toContain('【這之後你又發過（對方還沒回）】');
    // 位置：夾在對話上下文和本次任務之間，別跑到指令後面被當成新指令讀。
    expect(second.prompt.indexOf('剛看到樓下那隻貓又來了'))
      .toBeLessThan(second.prompt.indexOf('想到什麼說什麼'));

    // 兩次都記下了，第三次能一路接上去。
    expect(store.selfLog()?.entries.map((e) => e.text))
      .toEqual(['剛看到樓下那隻貓又來了', '它蹲在那兒一直沒走']);
  });

  it('多段消息合成一條記（用戶那邊是幾條氣泡，對角色是一次「我說了這些」）', async () => {
    const store = makeStore(slottedFirePack());
    await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '喂\n在嗎',
    });
    expect(store.selfLog()?.entries).toHaveLength(1);
    expect(store.selfLog()?.entries[0].text).toBe('喂\n在嗎');
  });

  it('同一次觸發重跑（投遞失敗重試）不會記成兩條', async () => {
    const store = makeStore(slottedFirePack());
    const sendAt = '2026-07-25T12:00:00.000Z';
    await runFire(store, { sendAt, llmOutput: '第一次生成的話' });
    await runFire(store, { sendAt, llmOutput: '重跑時生成的話' });

    const entries = store.selfLog()?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].text, '同 id 覆蓋，留最後一次真正發出去的那份').toBe('重跑時生成的話');
  });

  it('客戶端傳了新 fire_pack → 舊正文不再重複渲染，但連發計數保留', async () => {
    const store = makeStore(slottedFirePack());
    await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '剛看到樓下那隻貓又來了',
    });

    // 客戶端認領那條推送後重新打包上傳（打髒即傳）：新轉寫的對話記錄裡本來就含那條
    // 主動消息，正文不能再抄一遍；但用戶並沒有開口，連發計數必須留著——
    // 掛在換代上清零正是 2026-08 炸屏時連發提醒失效的迴路。
    store.rows.set(AMSG_FIRE_PACK_KEY, slottedFirePack(Date.now() + 60_000));

    const next = await runFire(store, {
      sendAt: '2026-07-25T14:00:00.000Z',
      llmOutput: '那隻貓今天還來嗎',
    });
    expect(next.prompt).not.toContain('- 剛剛　剛看到樓下那隻貓又來了');
    expect(next.prompt).toContain('你已連發 1 條');
    // 錨點跟上新的那份包（tasks 段作廢），連發記錄兩條都在。
    expect(store.selfLog()?.entries.map((e) => e.text))
      .toEqual(['剛看到樓下那隻貓又來了', '那隻貓今天還來嗎']);
  });

  // 對齊錨點是必填的，沒有它自述日誌無從判斷新舊。所以缺錨點的包按「雲端狀態壞了」
  // 硬失敗，而不是悄悄退回單輪——靜默降級的話，多輪連續性沒了也沒人會發現。
  it('包裡缺對齊錨點 → 拋錯，不靜默退回單輪', async () => {
    const store = makeStore(JSON.stringify({
      v: FIRE_PACK_VERSION,
      template: `【最近對話上下文】\n用戶：先睡了${AMSG_SLOT_SELF_LOG}\n\n【本次任務】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
      lastUserMessageAt: null,
      tzId: 'Asia/Shanghai',
      userTzId: 'Asia/Shanghai',
      targetName: '小明',
      pendingTasks: [],
      scene: null,
    }));
    await expect(runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '在幹嘛呢',
    })).rejects.toThrow('AMSG2_FIRE_STATE_MISSING');
    expect(store.rows.has(AMSG_SELF_LOG_KEY)).toBe(false);
  });

  it('自述寫不進去不連累這次投遞（消息照發，只是下次接不上）', async () => {
    const store = makeStore(slottedFirePack());
    store.failWrites();
    const { decision } = await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '在幹嘛呢',
    });
    expect(decision.decision).toBe('finish');
    expect(decision.pushPayloads[0].message).toBe('在幹嘛呢');
  });

  // ⑥ 的核心迴歸守衛：寫庫時機從「推送發出前」挪到「發出後」。舊實現在 onLLMOutput
  // 裡就落盤——推送全掛時雲端記了「說過」，下次 fire 角色接著一句用戶根本沒收到的話說。
  describe('發送後才寫（onAfterSend 回執）', () => {
    it('onLLMOutput 只掛到 scratch 上不落盤；onAfterSend 才寫庫', async () => {
      const store = makeStore(slottedFirePack());
      const { decision, scratch } = await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '剛看到樓下那隻貓又來了',
        skipAfterSend: true,
      });
      expect(decision.decision).toBe('finish');
      expect(store.selfLog(), '推送還沒發出去，不能已經記了「說過」').toBeNull();
      expect((scratch.fire as any).selfLogTexts).toEqual(['剛看到樓下那隻貓又來了']);

      await amsgFireSettled({ sentCount: 1, scratch, writeState: store.writeState });
      expect(store.selfLog()?.entries.map((e) => e.text)).toEqual(['剛看到樓下那隻貓又來了']);
      expect((scratch.fire as any).selfLogTexts, '認領後清空，重複回執不會記兩遍').toBeNull();
    });

    it('部分失敗：只把真送出去的前 sentCount 段寫進日誌，沒送出去的正文不進', async () => {
      const store = makeStore(slottedFirePack());
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '第一段送出去了\n第二段沒送出去',
        sentCount: 1,
      });
      const entries = store.selfLog()?.entries ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('第一段送出去了');
      expect(entries[0].text).not.toContain('第二段沒送出去');
    });

    it('sentCount=0（推送全掛）不寫——用戶什麼都沒收到，雲端不能記「說過」', async () => {
      const store = makeStore(slottedFirePack());
      const { scratch } = await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '一段都沒送出去的話',
        sentCount: 0,
      });
      expect(store.selfLog()).toBeNull();
      expect((scratch.fire as any).selfLogTexts, '認領過就清空，重試的下一條 fire 會重新生成').toBeNull();
    });

    it('entry.at 是實際發送時刻，不再是名義 occurrenceMs（cron 遲到半小時時名義時刻是謊話）', async () => {
      const store = makeStore(slottedFirePack());
      const before = Date.now();
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',   // 名義時刻在 2026 年
        llmOutput: '在幹嘛呢',
      });
      const entry = store.selfLog()?.entries[0];
      expect(entry?.at).toBeGreaterThanOrEqual(before);
      expect(entry?.at).not.toBe(Date.parse('2026-07-25T12:00:00.000Z'));
      // 去重語義不動：id 仍是 clientTaskId@occurrenceMs。
      expect(entry?.id).toBe(`${CLIENT_TASK_ID}@${Date.parse('2026-07-25T12:00:00.000Z')}`);
    });

    // scratch 上沒掛本次 fire 的記錄：onBeforeFire 拋錯、或者這次走的是 skip 出口。
    it('scratch 上沒有本次 fire 的記錄 → 不猜不寫，也不炸', async () => {
      const store = makeStore(slottedFirePack());
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '在幹嘛呢',
        skipAfterSend: true,
      });
      await expect(amsgFireSettled({ sentCount: 1, scratch: {}, writeState: store.writeState }))
        .resolves.toBeUndefined();
      expect(store.selfLog()).toBeNull();
    });

    it('併發的兩次 fire 各寫各的——scratch 是每次 fire 獨有的一份', async () => {
      const storeA = makeStore(slottedFirePack());
      const storeB = makeStore(slottedFirePack());
      const a = await runFire(storeA, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: 'A 的話',
        skipAfterSend: true,
      });
      const b = await runFire(storeB, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: 'B 的話',
        skipAfterSend: true,
      });

      await amsgFireSettled({ sentCount: 1, scratch: b.scratch, writeState: storeB.writeState });
      expect(storeB.selfLog()?.entries.map((e) => e.text)).toEqual(['B 的話']);
      expect(storeA.selfLog(), 'B 的回執不能把 A 的正文帶走').toBeNull();

      await amsgFireSettled({ sentCount: 1, scratch: a.scratch, writeState: storeA.writeState });
      expect(storeA.selfLog()?.entries.map((e) => e.text)).toEqual(['A 的話']);
    });
  });
});

// 迴歸守衛：角色到點給自己排下一條。這是「連續自行回覆」的觸發端——上面那組 self_log
// 保證第二次知道第一次說了什麼，這組保證第二次會自己發生。
describe('自排後續任務', () => {
  const makeStash = (over: Record<string, unknown> = {}) => ({
    session: { narrations: [], toolCalls: [], duplicateToolCalls: 0, mcpCallSeq: 0 },
    occurrenceMs: Date.parse('2026-07-25T12:00:00.000Z'),
    selfLog: {
      v: 4 as const, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [],
    },
    pendingTaskCount: 0,
    scheduledTasks: [],
    selfScheduleSeq: 0,
    cancelledTasks: [],
    charId: CHAR_ID,
    tz: { tzId: 'Asia/Shanghai' },
    taskUuid: TASK_UUID,
    taskRowId: '42',
    instant: false,
    // 連發上限相關：單測夾具默認不限，上限行為由「連發上限」那組用例單獨釘。
    maxUnansweredSends: Infinity,
    plannedSelfSends: 0,
    plannedSelfSendUuids: [],
    ...over,
  }) as any;

  const okSchedule = vi.fn(async (opts: any) => ({
    created: true as const, id: 7, uuid: opts.uuid, nextSendAt: opts.firstSendTime,
  }));
  const NOW_MS = Date.parse('2026-07-25T12:00:00.000Z');
  const sendAt = new Date(NOW_MS + 90 * 60_000).toISOString();

  afterEach(() => { okSchedule.mockClear(); });

  it('連發到上限：排程工具直接打回，一條任務都不建', async () => {
    const stash = makeStash({
      maxUnansweredSends: 3,
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, tasks: [], unansweredSends: 3,
        entries: [
          { id: 's@1', at: NOW_MS - 3 * 60_000, text: '一' },
          { id: 's@2', at: NOW_MS - 2 * 60_000, text: '二' },
          { id: 's@3', at: NOW_MS - 60_000, text: '三' },
        ],
      },
    });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unanswered_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('已發 2 條 + 先前自排的 1 條還沒響，上限 3 → 第 4 條打回', async () => {
    const stash = makeStash({
      maxUnansweredSends: 3,
      plannedSelfSends: 1,
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, tasks: [], unansweredSends: 2,
        entries: [
          { id: 's@1', at: NOW_MS - 2 * 60_000, text: '一' },
          { id: 's@2', at: NOW_MS - 60_000, text: '二' },
        ],
      },
    });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unanswered_limit');
  });

  it('即時對話的回覆不佔連發額度：2 回覆 + 2 主動，上限 3 → 還能排', async () => {
    const stash = makeStash({
      maxUnansweredSends: 3,
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, tasks: [], unansweredSends: 2,
        entries: [
          { id: 'r@1', at: NOW_MS - 4 * 60_000, text: '在的', reply: true },
          { id: 'r@2', at: NOW_MS - 3 * 60_000, text: '嗯嗯', reply: true },
          { id: 's@1', at: NOW_MS - 2 * 60_000, text: '一' },
          { id: 's@2', at: NOW_MS - 60_000, text: '二' },
        ],
      },
    });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(true);
  });

  it('自排任務的 metadata 帶 amsgSelfScheduled 標記（到點兜底閘認它）', async () => {
    const stash = makeStash();
    await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(okSchedule.mock.calls[0][0].metadata.amsgSelfScheduled).toBe(true);
  });

  it('即時對話的回覆記進 self_log 帶 reply 標記，定時任務的不帶', async () => {
    const written = async (stash: any) => {
      const writeState = vi.fn(async (
        _namespace: string,
        _entries: Array<{ key: string; value: string | null }>,
      ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
      await amsgFireSettled({ status: 'sent', sentCount: 1, scratch: { fire: stash }, writeState } as any);
      const entries = writeState.mock.calls[0][1];
      return JSON.parse(String(entries.find((e) => e.key === AMSG_SELF_LOG_KEY)!.value));
    };
    const instantLog = await written(makeStash({ instant: true, selfLogTexts: ['嗯我在'] }));
    expect(instantLog.entries[0].reply).toBe(true);
    const timerLog = await written(makeStash({ selfLogTexts: ['突然想你了'] }));
    expect(timerLog.entries[0].reply).toBeUndefined();
  });

  it('排成功：任務落到遠端，也記進自述日誌供下次讀回', async () => {
    const stash = makeStash();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);

    expect(out.ok).toBe(true);
    expect(okSchedule).toHaveBeenCalledTimes(1);
    const opts = okSchedule.mock.calls[0][0];
    expect(opts.firstSendTime).toBe(sendAt);
    expect(opts.metadata.charId).toBe(CHAR_ID);
    // 到點那條要能走滿血鏈路：任務指令、歸屬鍵、防穿幫字段一個都不能少
    expect(opts.metadata.amsgTaskInstruction).toBeTruthy();
    expect(opts.metadata.amsgClientTaskId).toBeTruthy();
    expect(opts.metadata.amsgExpirePolicy).toBe('expire');

    expect(stash.scheduledTasks).toHaveLength(1);
    expect(stash.selfLog.tasks).toHaveLength(1);
    expect(stash.selfLog.tasks[0].source).toBe('character');
  });

  // 迴歸守衛：排程清單裡印給角色看的短 id 取的是 uuid 前 8 個字符。uuid 要是以固定字樣
  // 開頭（舊寫法 `amsgself-…`），同一次 fire 排下的兩條在清單裡就印成一模一樣的
  // `[amsgself]` —— 角色說「晚上那條不用了」，取消的卻是早上那條，兩邊還都回 ok。
  it('同一次 fire 排的兩條，清單裡的短 id 不撞車', async () => {
    const stash = makeStash();
    await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    await runFireScheduleTool(
      stash, okSchedule, { send_at: new Date(NOW_MS + 8 * 3600_000).toISOString() }, NOW_MS);

    expect(stash.scheduledTasks).toHaveLength(2);
    const shortIds = stash.scheduledTasks.map((t: any) => shortTaskId(t.taskUuid));
    expect(new Set(shortIds).size, `兩條印出來都是 ${shortIds[0]}`).toBe(2);
  });

  // 幽靈任務迴歸守衛：角色排了任務，但這輪最終一句話都沒發出去（只做了副作用 / 空生成 /
  // 推送全掛）。任務在 scheduleTask 那一刻就真的建進 D1 了 —— 帳要是沒落下來，客戶端認領
  // 不到、面板看不見、用戶取消不掉，它卻會一直按時發下去。
  it('這輪沒發出任何正文時，角色自排的任務照樣落進 self_log', async () => {
    const stash = makeStash();
    await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(stash.selfLogDirty, '排完任務就該標記有未落盤改動').toBe(true);

    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'skipped', sentCount: 0, scratch: { fire: stash }, writeState,
    } as any);

    const entries = writeState.mock.calls[0][1];
    const written = JSON.parse(String(entries.find((e) => e.key === AMSG_SELF_LOG_KEY)!.value));
    expect(written.tasks).toHaveLength(1);
    expect(written.tasks[0].source).toBe('character');
    // 一段都沒送出去 = 用戶什麼都沒收到，不能記「我說過什麼」
    expect(written.entries ?? []).toHaveLength(0);
  });

  it('什麼都沒添進日誌時不寫庫（別為一次空 fire 白打一個請求）', async () => {
    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'skipped', sentCount: 0, scratch: { fire: makeStash() }, writeState,
    } as any);
    expect(writeState).not.toHaveBeenCalled();
  });

  // 即時對話這一跳掛了 → chat_fail 留痕：客戶端點名判到「行已出清」後靠它向用戶交代
  // 原因，不再按角色掃全量任務列表逐條解密（幾秒起步 + 競態窗口）。
  it('即時對話 fire 失敗 → 原因寫進 chat_fail（帶 uuid 和重試計數）', async () => {
    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 3 },
      error: new Error('LLM HTTP 502'),
      scratch: { fire: makeStash({ instant: true }) }, writeState,
    } as any);

    const entries = writeState.mock.calls.flatMap((c) => c[1] as Array<{ key: string; value: string }>);
    const record = JSON.parse(String(entries.find((e) => e.key === 'chat_fail')!.value));
    expect(record.uuid).toBe(TASK_UUID);
    expect(record.reason).toBe('LLM HTTP 502');
    expect(record.retryCount).toBe(3);
  });

  // 上游給這一族錯誤掛了穩定的 code。帶下去，客戶端才說得出「該查 API Key」還是
  // 「重發就行」；不帶的話它只能去正則匹配 reason 那句人話，上游改個措辭就靜默失效。
  it('錯誤對象上的 code 一起寫進 chat_fail', async () => {
    const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
    const error = Object.assign(new Error('AI API error: 401 …'), { code: 'LLM_CALL_FAILED' });
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 3 }, error,
      scratch: { fire: makeStash({ instant: true }) }, writeState,
    } as any);

    const entries = writeState.mock.calls.flatMap((c) => (c as any)[1] as Array<{ key: string; value: string }>);
    const record = JSON.parse(String(entries.find((e) => e.key === 'chat_fail')!.value));
    expect(record.errorCode).toBe('LLM_CALL_FAILED');
  });

  // 只認 `code`，不認 `statusCode`。Node 生態的 HTTP 庫習慣把上游狀態碼掛成
  // statusCode，而這個 catch 罩著整條投遞鏈——宿主 hook 裡轉手拋出的一個 404 會被
  // 讀成「推送訂閱已失效」，客戶端於是引導用戶白重建一次訂閱。上游踩過這個坑。
  it('錯誤上只有 statusCode（不是推送那一步的）→ 不認，chat_fail 裡沒有 errorCode', async () => {
    const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
    const error = Object.assign(new Error('hook 裡轉手拋的 404'), { statusCode: 404 });
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 3 }, error,
      scratch: { fire: makeStash({ instant: true }) }, writeState,
    } as any);

    const entries = writeState.mock.calls.flatMap((c) => (c as any)[1] as Array<{ key: string; value: string }>);
    const record = JSON.parse(String(entries.find((e) => e.key === 'chat_fail')!.value));
    expect(record.errorCode).toBeUndefined();
    expect(record.pushStatus).toBeUndefined();
  });

  it('定時任務 fire 失敗不寫 chat_fail（那條路走面板對帳，不佔即時通道）', async () => {
    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'failed', sentCount: 0, error: new Error('x'),
      scratch: { fire: makeStash() }, writeState,
    } as any);
    expect(writeState).not.toHaveBeenCalled();
  });

  /** 撞車回執：帶上已存在那行的脫敏投影（上游 2.6.0-next.11 起）。 */
  const dupSchedule = (over: Record<string, unknown> = {}) => vi.fn(async (opts: any) => ({
    created: false as const,
    reason: 'duplicate' as const,
    uuid: opts.uuid,
    task: {
      nextSendAt: sendAt,
      recurrenceType: 'none',
      messageType: 'auto',
      clientTaskId: 'client-dup',
      ...over,
    },
  }));

  it('uuid 由觸發時刻推出來 —— fire 重跑撞車不多排一條，但這一輪照樣記帳', async () => {
    const first = makeStash();
    await runFireScheduleTool(first, okSchedule, { send_at: sendAt }, NOW_MS);
    const uuidA = okSchedule.mock.calls[0][0].uuid;

    // 同一次觸發重跑：新 stash（fire 重跑會重新掛 scratch），uuid 應該一模一樣。
    // 重跑的起因通常是投遞失敗——上一輪記的帳隨那次失敗一起沒了。這一輪再不記，任務
    // 就只活在 D1 裡：隨 push 帶不回客戶端、面板列不出來、用戶也取消不掉。
    okSchedule.mockClear();
    const retry = makeStash();
    const remoteSendAt = new Date(NOW_MS + 95 * 60_000).toISOString();
    const dup = dupSchedule({ nextSendAt: remoteSendAt });
    const out = await runFireScheduleTool(retry, dup, { send_at: sendAt }, NOW_MS);

    expect(dup.mock.calls[0][0].uuid).toBe(uuidA);
    expect(out.ok, '撞車對模型來說結果一樣：那條確實排上了').toBe(true);
    expect(out.already_scheduled).toBe(true);
    expect(retry.scheduledTasks, '這一輪也要記下來').toHaveLength(1);
    expect(retry.selfLog.tasks).toHaveLength(1);
    // 真正會響的是遠端那行的時間，不是這一輪模型想改成的那個。
    expect(retry.scheduledTasks[0].firstSendTime).toBe(remoteSendAt);
    expect(out.send_at).toBe(remoteSendAt);
  });

  // uuid 的序號取自「這一輪已經排了幾條」。撞車不記帳的話序號不漲，同一輪裡第二次排
  // 會算出同一個 uuid、再撞一次——模型以為排了兩條，實際只有一條。
  it('撞車之後序號照漲：同一輪第二次排的是新任務，不是又撞回同一條', async () => {
    const stash = makeStash();
    const dup = dupSchedule();
    await runFireScheduleTool(stash, dup, { send_at: sendAt }, NOW_MS);
    await runFireScheduleTool(
      stash, dup, { send_at: new Date(NOW_MS + 150 * 60_000).toISOString() }, NOW_MS);

    const uuids = dup.mock.calls.map((c: any[]) => c[0].uuid);
    expect(new Set(uuids).size, '兩次調用不能落到同一個 uuid 上').toBe(2);
  });

  it('單次 fire 排滿就打回，不再調遠端', async () => {
    const stash = makeStash();
    for (let i = 0; i < MAX_FIRE_SCHEDULES; i += 1) {
      await runFireScheduleTool(stash, okSchedule, { send_at: new Date(NOW_MS + (90 + i) * 60_000).toISOString() }, NOW_MS);
    }
    okSchedule.mockClear();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('fire_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('角色掛著的任務已經到上限 → 打回（離線連排也繞不過每角色上限）', async () => {
    const stash = makeStash({ pendingTaskCount: MAX_ACTIVE_TASKS_PER_CHAR });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('task_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('參數寫歪 → 回喂一句能照做的話，不拋錯（拋錯等於整條任務重跑）', async () => {
    const stash = makeStash();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: '明天' }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(String(out.message)).toContain('牆鍾');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  // ③ 在 fire 工具入口的落地：角色寫的裸牆鍾按 stash.tz（fire_pack 的參照系）解析。
  it('裸 send_at 按角色時區解析（UTC 運行時不再差一個時差）', async () => {
    const stash = makeStash();   // Asia/Shanghai
    const out = await runFireScheduleTool(
      stash, okSchedule, { send_at: '2026-07-26T09:00:00' }, NOW_MS,
    );
    expect(out.ok).toBe(true);
    // 上海牆鍾 07-26 09:00 = 01:00Z。舊行為（按 UTC 解析）會給 09:00Z，差 8 小時。
    expect(okSchedule.mock.calls[0][0].firstSendTime).toBe('2026-07-26T01:00:00.000Z');
  });

  it('上游護欄拋錯 → 轉成回喂，不連累這次投遞', async () => {
    const stash = makeStash();
    const boom = vi.fn(async () => { throw new RangeError('firstSendTime 至少要比現在晚 60 秒'); });
    const out = await runFireScheduleTool(stash, boom as any, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('schedule_rejected');
    expect(String(out.message)).toContain('60 秒');
  });

  it('老部署沒有這個口子 → 明確告訴角色排不了，別讓它承諾了又沒下文', async () => {
    const out = await runFireScheduleTool(makeStash(), undefined, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_supported');
  });
});

describe('attachScheduledTasks', () => {
  const task = { taskUuid: 'u1', clientTaskId: 'c1' } as any;

  it('掛在最後一條 push 上（與 directives 同位置，收側只重放一次）', () => {
    const out = attachScheduledTasks(
      [{ message: 'a', metadata: { charId: CHAR_ID } }, { message: 'b', metadata: { charId: CHAR_ID } }],
      [task],
    );
    expect((out[0].metadata as any).amsgSelfScheduled).toBeUndefined();
    expect((out[1].metadata as any).amsgSelfScheduled).toEqual([task]);
    expect((out[1].metadata as any).charId, '原有 metadata 不能被頂掉').toBe(CHAR_ID);
  });

  it('沒排任務 / 沒有 push 時原樣返回', () => {
    const payloads = [{ message: 'a' }];
    expect(attachScheduledTasks(payloads, [])).toBe(payloads);
    expect(attachScheduledTasks([], [task])).toEqual([]);
  });
});

// 取消 / 改期開到 fire 側（amsg-server 2.6.0-next.15 的 ctx.cancelTask / renewTask）。
// 語義與前台同名工具對齊：短 id 指定、只有一條時可省略；帳目兩頭消
// （selfLog.tasks + 隨末條 push 的 amsgTaskMutations 回客戶端）。
describe('fire 側取消 / 改期任務', () => {
  const NOW_MS = Date.parse('2026-07-25T12:00:00.000Z');
  const taskRec = (uuid: string, over: Record<string, unknown> = {}) => ({
    taskUuid: uuid,
    clientTaskId: `${uuid}-c`,
    mode: 'auto',
    firstSendTime: new Date(NOW_MS + 3600_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'user',
    status: 'scheduled',
    createdAt: NOW_MS - 3600_000,
    ...over,
  }) as any;

  const makeStash = (over: Record<string, unknown> = {}) => ({
    session: { narrations: [], toolCalls: [], duplicateToolCalls: 0, mcpCallSeq: 0 },
    toolCtx: { char: { name: 'Nyah' } },
    occurrenceMs: NOW_MS,
    selfLog: {
      v: 4 as const, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [],
    },
    pendingTaskCount: 0,
    pendingTasks: [],
    scheduledTasks: [],
    selfScheduleSeq: 0,
    cancelledTasks: [],
    renewedTasks: [],
    charId: CHAR_ID,
    tz: { tzId: 'Asia/Shanghai' },
    taskUuid: TASK_UUID,
    taskRowId: '42',
    instant: false,
    maxUnansweredSends: Infinity,
    plannedSelfSends: 0,
    plannedSelfSendUuids: [],
    ...over,
  }) as any;

  const okCancel = () => vi.fn(async (_uuid: string) => ({ cancelled: true }));
  const okRenew = () => vi.fn(async (uuid: string, nextSendAt: string) => ({
    renewed: true as const, uuid, nextSendAt,
  }));
  const newSendAt = new Date(NOW_MS + 2 * 3600_000).toISOString();

  it('短 id 找目標、全 uuid 傳給 ctx.cancelTask，帳記進 cancelledTasks', async () => {
    const cancel = okCancel();
    const stash = makeStash({ pendingTasks: [taskRec('11112222-aaaa-4bbb-8ccc-000000000001')] });
    const out = await runFireCancelTool(stash, cancel, { task_id: '11112222' }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(cancel).toHaveBeenCalledWith('11112222-aaaa-4bbb-8ccc-000000000001');
    expect(stash.cancelledTasks).toEqual(['11112222-aaaa-4bbb-8ccc-000000000001']);
  });

  it('只有一條時可省略 task_id；多條時打回 ambiguous、一條都不動', async () => {
    const cancel = okCancel();
    const one = makeStash({ pendingTasks: [taskRec('u-only')] });
    expect((await runFireCancelTool(one, cancel, {}, NOW_MS)).ok).toBe(true);

    const many = makeStash({ pendingTasks: [taskRec('u-a'), taskRec('u-b')] });
    const out = await runFireCancelTool(many, cancel, {}, NOW_MS);
    expect(out.reason).toBe('ambiguous_task');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // 與前台 resolveTargetTask 對齊的迴歸守衛：清單快照裡混著一條已過點變陳舊的一次性
  // 任務（pack 只在打包那一刻篩過 pending）時，不帶 task_id 也能鎖定唯一還活著的那條。
  // 不復篩的話，同一句 cancel_active_message 本地能成、雲端卻被打回 ambiguous_task。
  it('快照裡混著過點的陳舊任務 → 不帶 task_id 仍鎖定唯一 pending 那條', async () => {
    const cancel = okCancel();
    const stale = taskRec('u-stale', { firstSendTime: new Date(NOW_MS - 2 * 3600_000).toISOString() });
    const stash = makeStash({ pendingTasks: [stale, taskRec('u-live')] });
    const out = await runFireCancelTool(stash, cancel, {}, NOW_MS);
    expect(out.ok).toBe(true);
    expect(cancel).toHaveBeenCalledWith('u-live');
  });

  it('當前正在 fire 的這條不在可取消視圖裡（它的收尾歸 run-tick 管）', async () => {
    const cancel = okCancel();
    const stash = makeStash({ pendingTasks: [taskRec(TASK_UUID)] });
    const out = await runFireCancelTool(stash, cancel, { task_id: TASK_UUID.slice(0, 8) }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  // 撞車守衛（配合自排 uuid 那條）：萬一哪天兩條任務的短 id 又長一樣了，寧可打回讓角色
  // 重說一次，也不能挑一條刪了 —— 刪錯的那條無聲無息地沒了，說好要響的那條照樣響。
  it('兩條任務共用一個短 id → 打回 ambiguous_task，遠端一次都不調', async () => {
    const cancel = okCancel();
    const stash = makeStash({
      pendingTasks: [taskRec('samehead-aaaa-1'), taskRec('samehead-bbbb-2')],
    });
    const out = await runFireCancelTool(stash, cancel, { task_id: 'samehead' }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('ambiguous_task');
    expect(cancel).not.toHaveBeenCalled();
    expect(stash.cancelledTasks).toEqual([]);
    // 打回的話要能照做：帶上兩條各自的完整 id，角色下一輪指得準
    expect(String(out.message)).toContain('samehead-aaaa-1');
    expect(String(out.message)).toContain('samehead-bbbb-2');
  });

  it('改期同樣不猜：短 id 撞車時打回，不去改另一條的時間', async () => {
    const renew = okRenew();
    const stash = makeStash({
      pendingTasks: [taskRec('samehead-aaaa-1'), taskRec('samehead-bbbb-2')],
    });
    const out = await runFireRenewTool(
      stash, { renewTask: renew }, { task_id: 'samehead', send_at: newSendAt }, NOW_MS);
    expect(out.reason).toBe('ambiguous_task');
    expect(renew).not.toHaveBeenCalled();
  });

  it('取消掉 selfLog 裡備著帳的自排任務：日誌同步摘除並打髒', async () => {
    const rec = taskRec('u-selflog', { source: 'character' });
    const stash = makeStash({
      pendingTasks: [rec],
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [rec],
      },
    });
    await runFireCancelTool(stash, okCancel(), { task_id: 'u-selflog' }, NOW_MS);
    expect(stash.selfLog.tasks).toEqual([]);
    expect(stash.selfLogDirty).toBe(true);
  });

  it('本輪剛排的那條允許當場反悔：scheduledTasks 一併摘掉', async () => {
    const rec = taskRec('u-fresh', { source: 'character' });
    const stash = makeStash({ scheduledTasks: [rec] });
    const out = await runFireCancelTool(stash, okCancel(), { task_id: 'u-fresh' }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(stash.scheduledTasks).toEqual([]);
  });

  // uuid 序號只增不減的迴歸守衛：取消會讓 scheduledTasks 回縮，序號要是取數組長度，
  // 「排A→排B→取消A→排C」時 C 會算出和還活著的 B 一樣的 uuid——createTask 報 duplicate
  // 被當成 fire 重跑，回 ok:true already_scheduled，C 實際不存在卻告訴模型排上了。
  it('排A→排B→取消A→排C：三個 uuid 互不相同，C 是真新建的', async () => {
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const stash = makeStash();
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 90 * 60_000).toISOString() }, NOW_MS);
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 120 * 60_000).toISOString() }, NOW_MS);
    const uuidA = schedule.mock.calls[0][0].uuid;
    await runFireCancelTool(stash, okCancel(), { task_id: uuidA }, NOW_MS);
    const outC = await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 150 * 60_000).toISOString() }, NOW_MS);

    const uuids = schedule.mock.calls.map((c: any[]) => c[0].uuid);
    expect(new Set(uuids).size, 'C 不能撞上還活著的 B 的 uuid').toBe(3);
    expect(outC.ok).toBe(true);
    expect(outC.already_scheduled, 'C 是真新建的，不是被撞車話術糊過去').toBeUndefined();
  });

  // 另一變體：排A→取消A→排B。序號回退的話 B 會複用 A 的 uuid，而 A 已在
  // cancelledTasks 裡——客戶端消帳時會把 B 當成已取消刪掉，B 成了幽靈任務。
  it('排A→取消A→排B：B 不復用 A 的 uuid（不落進 cancelledTasks）', async () => {
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const stash = makeStash();
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 90 * 60_000).toISOString() }, NOW_MS);
    const uuidA = schedule.mock.calls[0][0].uuid;
    await runFireCancelTool(stash, okCancel(), { task_id: uuidA }, NOW_MS);
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 120 * 60_000).toISOString() }, NOW_MS);

    const uuidB = schedule.mock.calls[1][0].uuid;
    expect(uuidB).not.toBe(uuidA);
    expect(stash.cancelledTasks).toEqual([uuidA]);
    expect(stash.cancelledTasks).not.toContain(uuidB);
  });

  // 連發閘退額度的迴歸守衛：3 條 pending 打滿上限時，提示詞教的「cancel + 重排」要能
  // 落地——取消掉快照裡的任務把額度還回來，重排 1 條放行；額度只是中性不是解鎖，
  // 緊接著第 2 條仍要被閘。
  it('取消退還連發額度：cancel 1 條後重排 1 條放行，第 2 條仍被閘', async () => {
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const planned = [
      taskRec('u-plan-1', { source: 'character' }),
      taskRec('u-plan-2', { source: 'character' }),
      taskRec('u-plan-3', { source: 'character' }),
    ];
    const stash = makeStash({
      maxUnansweredSends: 3,
      pendingTasks: planned,
      pendingTaskCount: planned.length,
      plannedSelfSends: planned.length,
      plannedSelfSendUuids: planned.map((t: any) => t.taskUuid),
    });
    const sendAt = new Date(NOW_MS + 90 * 60_000).toISOString();

    // 先釘住閘還在收：打滿時直接排要被打回（不然下面的放行可能是閘整個失效）
    const blockedFull = await runFireScheduleTool(stash, schedule, { send_at: sendAt }, NOW_MS);
    expect(blockedFull.reason).toBe('unanswered_limit');

    await runFireCancelTool(stash, okCancel(), { task_id: 'u-plan-1' }, NOW_MS);
    const rescheduled = await runFireScheduleTool(stash, schedule, { send_at: sendAt }, NOW_MS);
    expect(rescheduled.ok, '取消 1 條後額度該還回來').toBe(true);

    const blockedAgain = await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 120 * 60_000).toISOString() }, NOW_MS);
    expect(blockedAgain.ok).toBe(false);
    expect(blockedAgain.reason).toBe('unanswered_limit');
  });

  it('行已經不在了（cancelled:false）→ 照實說、不記帳', async () => {
    const cancel = vi.fn(async () => ({ cancelled: false }));
    const stash = makeStash({ pendingTasks: [taskRec('u-gone')] });
    const out = await runFireCancelTool(stash, cancel, { task_id: 'u-gone' }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(out.already_gone).toBe(true);
    expect(stash.cancelledTasks).toEqual([]);
  });

  it('老部署沒有 ctx.cancelTask → not_supported，一句能照做的話', async () => {
    const out = await runFireCancelTool(makeStash({ pendingTasks: [taskRec('u-x')] }), undefined, {}, NOW_MS);
    expect(out.reason).toBe('not_supported');
  });

  it('一次性任務改期：ctx.renewTask 原地換時間，帳記進 renewedTasks、selfLog 跟著改', async () => {
    const rec = taskRec('u-renew', { source: 'character' });
    const renew = okRenew();
    const stash = makeStash({
      pendingTasks: [rec],
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [rec],
      },
    });
    const out = await runFireRenewTool(stash, { renewTask: renew }, { send_at: newSendAt }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(renew).toHaveBeenCalledWith('u-renew', newSendAt);
    expect(stash.renewedTasks).toEqual([{ taskUuid: 'u-renew', sendAt: newSendAt }]);
    expect(stash.selfLog.tasks[0].firstSendTime).toBe(newSendAt);
  });

  it('循環任務改期 = 補發一條一次性（走排程工具的完整入口），原序列不動', async () => {
    const renew = okRenew();
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const rec = taskRec('u-daily', { recurrenceType: 'daily', promptHint: '說早安' });
    const stash = makeStash({ pendingTasks: [rec] });
    const out = await runFireRenewTool(
      stash, { renewTask: renew, scheduleTask: schedule }, { send_at: newSendAt }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(renew).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0].recurrenceType).toBe('none');
    expect(schedule.mock.calls[0][0].metadata.amsgTaskInstruction).toContain('說早安');
    // 原序列沒被記成取消或改期
    expect(stash.cancelledTasks).toEqual([]);
    expect(stash.renewedTasks).toEqual([]);
  });

  it('fixed 任務不讓動；send_at 太近打回；行沒了回 task_gone', async () => {
    const fixedOut = await runFireRenewTool(
      makeStash({ pendingTasks: [taskRec('u-fx', { mode: 'fixed' })] }),
      { renewTask: okRenew() }, { send_at: newSendAt }, NOW_MS);
    expect(fixedOut.reason).toBe('fixed_task');

    const soonOut = await runFireRenewTool(
      makeStash({ pendingTasks: [taskRec('u-soon')] }),
      { renewTask: okRenew() }, { send_at: new Date(NOW_MS + 10_000).toISOString() }, NOW_MS);
    expect(soonOut.reason).toBe('send_at_too_soon');

    const gone = vi.fn(async () => ({ renewed: false as const, reason: 'not_found' }));
    const goneOut = await runFireRenewTool(
      makeStash({ pendingTasks: [taskRec('u-gone2')] }),
      { renewTask: gone }, { send_at: newSendAt }, NOW_MS);
    expect(goneOut.reason).toBe('task_gone');
  });

  it('usage 隨末條 push 的 amsgUsage 回客戶端（只挑兩個數，不透傳供應商私有字段）', async () => {
    const stash = makeStash({ instant: true });
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42', taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
      llmResponse: {}, llmOutputText: '在的。', contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'ct-u', amsgMode: 'instant', amsgInstantChat: true },
      scratch: { fire: stash },
      usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, provider_secret_detail: 'x' },
      writeState: vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 })),
    } as any) as any;
    const last = decision.pushPayloads[decision.pushPayloads.length - 1];
    expect(last.metadata.amsgUsage).toEqual({ promptTokens: 1234, completionTokens: 56 });
  });

  it('取消 / 改期的帳隨末條 push 的 amsgTaskMutations 回客戶端（首條不帶）', async () => {
    const stash = makeStash({
      cancelledTasks: ['u-cancelled'],
      renewedTasks: [{ taskUuid: 'u-renewed', sendAt: newSendAt }],
    });
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42', taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
      llmResponse: {}, llmOutputText: '好，改好了。\n到時候見。', contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'ct-1', amsgMode: 'auto' },
      scratch: { fire: stash },
      writeState: vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 })),
    } as any) as any;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[0].metadata.amsgTaskMutations).toBeUndefined();
    expect(decision.pushPayloads[1].metadata.amsgTaskMutations).toEqual({
      cancelled: ['u-cancelled'],
      renewed: [{ taskUuid: 'u-renewed', sendAt: newSendAt }],
    });
  });
});

// ⑤ 沒發出去也留痕：模型返回空 / 純拒答、或者只做了副作用沒說話時，上游都把任務當成功
// 消費，面板過去無從解釋。現在 skip-push 分支寫一條 last_skip，兩種成因分開記。
describe('沒發出去時寫 last_skip', () => {
  const runEmptyFire = async (opts: { writeStateFails?: boolean; llmOutputText?: string } = {}) => {
    const { ctx, scratch, writeState } = makeCtx({ writeStateFails: opts.writeStateFails });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: opts.llmOutputText ?? '',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any);
    return { decision: decision as any, writeState };
  };

  it('空輸出 → skip-push 且寫 last_skip（reason: empty-generation，帶任務定位）', async () => {
    const { decision, writeState } = await runEmptyFire();
    expect(decision.decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '應該寫過 last_skip').toBeTruthy();
    const skip = JSON.parse(String(call![1][0].value));
    expect(skip.reason).toBe('empty-generation');
    expect(skip.taskUuid).toBe(TASK_UUID);
    expect(skip.occurrenceMs).toBe(Date.parse('2026-07-25T12:00:00.000Z'));
  });

  // 只做事不說話的那一輪：空正文 push 的 banner body 也是空的，用戶鎖屏會收到一條
  // 只有標題的空橫幅、未讀 +1、點進去 0 氣泡。整條不發，副作用一起放棄。
  it('只有副作用標籤沒有正文 → skip-push 且寫 last_skip（reason: side-effects-only）', async () => {
    const { decision, writeState } = await runEmptyFire({ llmOutputText: '[[ACTION:POKE]]' });
    expect(decision.decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '應該寫過 last_skip').toBeTruthy();
    expect(JSON.parse(String(call![1][0].value)).reason).toBe('side-effects-only');
  });

  it('留痕寫失敗不影響 skip 本身（best-effort）', async () => {
    const { decision } = await runEmptyFire({ writeStateFails: true });
    expect(decision.decision).toBe('skip-push');
  });

  // 即時對話被 skip 時一次性行會被上游當成功消費刪掉，客戶端點名只能看到 gone + 空
  // outbox——不寫 chat_fail 的話，給用戶的解釋是「回覆沒能取回」，把「沒生成出來」說成
  // 了「取不回」。定時任務不用寫：那條路沒有人在等著銷帳，last_skip 就夠面板解釋了。
  it('即時對話空輸出 → 除 last_skip 外還寫 chat_fail（認 uuid，客戶端 gone 分支照實解釋）', async () => {
    const { ctx, scratch, writeState } = makeCtx({
      metadata: { amsgInstantChat: true, amsgMode: 'instant', amsgTaskInstruction: undefined },
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(null, { chat: { messages: [{ role: 'user', content: '在嗎' }], builtAt: PACK_BUILT_AT } }) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'instant', amsgInstantChat: true },
      scratch,
      writeState,
    } as any);
    expect((decision as any).decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_CHAT_FAIL_KEY));
    expect(call, '應該寫過 chat_fail').toBeTruthy();
    const fail = JSON.parse(String(call![1].find((e: { key: string }) => e.key === AMSG_CHAT_FAIL_KEY)!.value));
    expect(fail.uuid).toBe(TASK_UUID);
    expect(fail.reason).toBe('empty-generation');
  });

  it('定時任務空輸出 → 只寫 last_skip，不寫 chat_fail', async () => {
    const { writeState } = await runEmptyFire();
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_CHAT_FAIL_KEY));
    expect(call).toBeFalsy();
  });

  // 迴歸守衛：跳過那一刻要留一行形狀診斷，不然「為什麼沒說話」又只能靠猜。正文默認不進日誌，
  // 原文片段只在 Worker 配了 AMSG_DEBUG_LLM_RAW 時才帶——這條接線斷了，開關就是個擺設。
  describe('跳過時記一行診斷', () => {
    const THINK_ONLY = '<think>在想要不要回</think>';
    const thinkOnlyResponse = {
      model: 'm-1',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: THINK_ONLY } }],
    };
    const runFireCapturingDiag = async (llmOutputText: string, llmResponse: unknown) => {
      const { ctx, scratch, writeState } = makeCtx({});
      await amsgHooks.onBeforeFire(ctx);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await amsgHooks.onLLMOutput({
          sessionId: 'sess_task_42',
          iteration: 0,
          llmResponse,
          llmOutputText,
          contactName: 'Nyah',
          metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
          scratch,
          writeState,
        } as any);
        return warn.mock.calls.find(([tag]) => tag === '[amsg:skip-diag]')?.[1];
      } finally {
        warn.mockRestore();
      }
    };

    afterEach(() => {
      configureSkipDiagnostics({ rawExcerpt: false });
      configureInstantErrorPush(null);
    });

    it('正文全在思考塊裡 → 記下 reason 和形狀，不帶正文', async () => {
      const diag = await runFireCapturingDiag(THINK_ONLY, thinkOnlyResponse);
      expect(diag, '跳過時應該記一行 [amsg:skip-diag]').toMatchObject({
        sessionId: 'sess_task_42', reason: 'empty-generation', model: 'm-1', contentType: 'string', visibleChars: 0,
      });
      expect(JSON.stringify(diag)).not.toContain('在想要不要回');
    });

    it('Worker 配了 AMSG_DEBUG_LLM_RAW=1 → 診斷帶上原文片段', async () => {
      buildWorkerConfig({
        AMSG_MASTER_KEY: 'k'.repeat(64),
        VAPID_EMAIL: 'mailto:a@b.c',
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        DB: {},
        AMSG_DEBUG_LLM_RAW: '1',
      } as any);
      const diag = await runFireCapturingDiag(THINK_ONLY, thinkOnlyResponse);
      expect(diag?.raw?.content).toContain('在想要不要回');
    });

    it('正常出正文不記診斷', async () => {
      expect(await runFireCapturingDiag('在幹嘛呢', {})).toBeUndefined();
    });
  });

  it('正常出正文的 fire 不寫 empty-generation', async () => {
    const { ctx, scratch, writeState } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '在幹嘛呢',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any);
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call).toBeUndefined();
  });
});

// 推送橫幅上的名字：任務行裡那份是排程當天凍進去的，用戶改名之後不會跟著變（上游
// update-message 的可寫字段裡也沒有它）。tool_pack 每輪聊天都重新上雲，所以以它為準。
describe('推送標題跟著當前角色名', () => {
  it('tool_pack 的 charName 蓋過任務行凍結的 contactName', async () => {
    const { ctx, scratch, writeState } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        {
          key: AMSG_TOOL_PACK_KEY,
          value: JSON.stringify({
            v: 1, charName: '夜', xhsEnabled: false, activeMemoryMonths: [], memories: [],
            timeAwarenessEnabled: true,
          }),
        },
      ],
    });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '睡了嗎',
      contactName: 'Nyah',   // 任務行還頂著改名前的舊名字
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any) as any;

    expect(decision.decision).toBe('finish');
    expect(decision.pushPayloads[0].title).toBe('來自 夜');
    expect(decision.pushPayloads[0].contactName).toBe('夜');
  });
});

// ⑥ stale 守衛消費端：上游過期不補發時調 onStaleSkip(task, info)，這裡寫 last_skip
// 讓面板能解釋「說好的消息為什麼憑空消失」。
describe('stale 跳過留痕（onStaleSkip）', () => {
  const TASK_ROW_UUID = '3637dae1-1461-4444-a747-34e406f67acc';
  type SkipEntry = { key: string; value: string | null };
  const makeWriteState = () => vi.fn(
    async (_namespace: string, _entries: SkipEntry[]) => ({ upserted: 1, skipped: 0, deleted: 0 }));
  const lastSkipOf = (writeState: ReturnType<typeof makeWriteState>) => {
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e) => e.key === AMSG_LAST_SKIP_KEY));
    return call
      ? { namespace: call[0], skip: JSON.parse(String(call[1][0].value)) }
      : null;
  };

  it('charId 取 info.metadata.charId，寫 reason: stale + 那一次的名義觸發時刻', async () => {
    const writeState = makeWriteState();
    const occurrence = '2026-07-25T09:00:00.000Z';
    await amsgStaleSkip(
      { id: 101, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse(occurrence),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    );
    const written = lastSkipOf(writeState);
    expect(written, '應該寫過 last_skip').toBeTruthy();
    expect(written!.namespace).toBe(amsgStateNamespace(CHAR_ID));
    expect(written!.skip.reason).toBe('stale');
    expect(written!.skip.occurrenceMs).toBe(Date.parse(occurrence));
    expect(written!.skip.staleAction).toBe('expired');
  });

  // 循環任務的快進跳過也會調這個 hook。跟一次性任務的過期混為一談的話，每日提醒斷更
  // 一天會被面板說成「已經徹底沒了」——而它下一次照常響。
  it('循環任務快進：記 fast_forwarded + 跳過次數 + 快進到的下一次', async () => {
    const writeState = makeWriteState();
    await amsgStaleSkip(
      { id: 102, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'fast_forwarded',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 4,
        nextSendAt: '2026-07-29T09:00:00.000Z',
        writeState,
      },
    );
    const written = lastSkipOf(writeState);
    expect(written!.skip.staleAction).toBe('fast_forwarded');
    expect(written!.skip.skippedCount).toBe(4);
    expect(written!.skip.nextSendAtMs).toBe(Date.parse('2026-07-29T09:00:00.000Z'));
    // 記的是最早被跳過的那一次，不是快進之後的時間。
    expect(written!.skip.occurrenceMs).toBe(Date.parse('2026-07-25T09:00:00.000Z'));
  });

  // 迴歸守衛：這個 hook 原先只認 metadata.charId，不分種類。於是服務停擺幾小時之後，
  // 一條掛著的門牌整理任務被過期跳過，就會給那個角色寫一條「上次主動消息沒響、已被
  // 丟棄」——而用戶根本沒給他排過主動消息。onBeforeFire 裡那條 kind-skip 分支特意
  // 躲開了這個謊，但它排在這個 hook 後面，攔不到。
  it('後台任務過期跳過 → 不寫 last_skip（面板會拿它當主動消息說謊）', async () => {
    const writeState = makeWriteState();
    await amsgStaleSkip(
      { id: 104, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: { charId: CHAR_ID, [AMSG_TASK_KIND_KEY]: PLATE_CONSOLIDATE_KIND, amsgJobId: 'job-1' },
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    );
    expect(lastSkipOf(writeState), '門牌整理過期跟主動消息毫無關係').toBeNull();
  });

  it('metadata 缺 charId（真異常）→ warn 放棄留痕，不寫也不炸', async () => {
    const writeState = makeWriteState();
    await expect(amsgStaleSkip(
      { id: 100, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: null,
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    )).resolves.toBeUndefined();
    expect(lastSkipOf(writeState)).toBeNull();
  });

  // 寫口由回執載荷直接給。攢一份 fire 級寫口的老做法在 isolate 冷啟動後的第一跳是
  // 空的，而服務停擺恢復後的第一波過期，正是這個 hook 最該留下痕跡的時候。
  it('這一跳一次 fire 都沒跑過，照樣留得下痕', async () => {
    const writeState = makeWriteState();
    await amsgStaleSkip(
      { id: 103, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    );
    expect(lastSkipOf(writeState), 'isolate 冷啟動的第一跳也要寫得下').toBeTruthy();
  });
});

describe('worker 配置接線', () => {
  it('onAfterSend / onStaleSkip 掛在 config 上（漏接任何一個，發送後回執/過期留痕都靜默失效）', () => {
    const cfg = buildWorkerConfig({
      AMSG_MASTER_KEY: 'k'.repeat(64),
      VAPID_EMAIL: 'mailto:a@b.c',
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      DB: {},
    } as any);
    expect(cfg.onFireSettled).toBe(amsgFireSettled);
    expect(cfg.onStaleSkip).toBe(amsgStaleSkip);

    // 同角色的多條任務不併發跑，靠這個分組鍵。取不到 charId 時返回 null（= 不分組），
    // 別讓一批「認不出屬於誰」的任務擠成同一組互相堵。
    expect(cfg.serializeBy({ metadata: { charId: 'char-a' } })).toBe('char-a');
    expect(cfg.serializeBy({ metadata: {} })).toBeNull();
    expect(cfg.serializeBy({})).toBeNull();
  });

  // 迴歸守衛：後台任務原先跟聊天擠在同一個 charId 組裡。一次門牌整理最長佔住這個角色
  // 120 秒，而它恰恰是在一輪對話剛結束時起跑的——用戶下一句話的即時對話任務被排在它
  // 後面，人就乾等著「正在輸入…」。
  it('後台任務另開一組，不跟同角色的聊天任務串行', () => {
    const cfg = buildWorkerConfig({
      AMSG_MASTER_KEY: 'k'.repeat(64),
      VAPID_EMAIL: 'mailto:a@b.c',
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      DB: {},
    } as any);
    const chatGroup = cfg.serializeBy({ metadata: { charId: 'char-a' } });
    const jobGroup = cfg.serializeBy({
      metadata: { charId: 'char-a', [AMSG_TASK_KIND_KEY]: PLATE_CONSOLIDATE_KIND },
    });

    expect(jobGroup, '同一組的話，聊天要乾等門牌整理跑完').not.toBe(chatGroup);
    // 同角色同種後台任務仍要串行：兩份整理併發落地就是拿兩份舊快照互相蓋。
    expect(cfg.serializeBy({
      metadata: { charId: 'char-a', [AMSG_TASK_KIND_KEY]: PLATE_CONSOLIDATE_KIND },
    })).toBe(jobGroup);
    // 不同角色的後台任務照樣分得開。
    expect(cfg.serializeBy({
      metadata: { charId: 'char-b', [AMSG_TASK_KIND_KEY]: PLATE_CONSOLIDATE_KIND },
    })).not.toBe(jobGroup);
  });
});

// ─── 配置自檢 ───
// 部署這個 worker 最常翻車的兩處是「D1 沒綁」和「密鑰被下一次部署沖掉」。上游遇到
// 這兩種都是拋異常 → 被它的全局 catch 吞成一句「服務器內部錯誤」，且那個響應不帶
// CORS 頭，瀏覽器於是連這句話都不給前端讀，用戶只看得到 "Failed to fetch"——既分不清
// 是哪一樣沒配，也分不清是不是自己網斷了。下面這組把「說清楚缺什麼」釘住。
describe('inspectWorkerEnv — 配置自檢', () => {
  const fullEnv = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    AMSG_SERVER_TOKEN: 'shared-secret',
    DB: { prepare: () => {} },
  } as any;

  it('配齊了就沒有 missing、也沒有警告', () => {
    const report = inspectWorkerEnv(fullEnv);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('D1 沒綁時點名 DB，並指向 Bindings（不是 Variables and Secrets，指錯地方等於沒說）', () => {
    const report = inspectWorkerEnv({ ...fullEnv, DB: undefined });
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('DB');
    expect(report.message).toContain('Bindings');
  });

  it('D1 綁成了別的變量名等同於沒綁（上游讀的固定是 env.DB）', () => {
    // 綁定存在但不是 D1 實例（比如綁成 KV、或者名字打錯導致 env.DB 是 undefined）
    expect(inspectWorkerEnv({ ...fullEnv, DB: {} }).missing).toContain('DB');
  });

  it('master key 缺失時點名它，並說明要存成 Secret（存成明文會被下一次部署沖掉）', () => {
    const report = inspectWorkerEnv({ ...fullEnv, AMSG_MASTER_KEY: '' });
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('AMSG_MASTER_KEY');
    expect(report.message).toContain('Secret');
  });

  it('master key 只有空白字符也算缺（上游只判空，空白串會一路跑到解密才炸）', () => {
    expect(inspectWorkerEnv({ ...fullEnv, AMSG_MASTER_KEY: '   ' }).missing).toContain('AMSG_MASTER_KEY');
  });

  it('master key 格式不對只警告不攔——上游拿它做 SHA-256，長度不對照樣能跑，攔了會打掛正常實例', () => {
    const report = inspectWorkerEnv({ ...fullEnv, AMSG_MASTER_KEY: 'short-but-working' });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.warnings.map((w: any) => w.code)).toContain('MASTER_KEY_FORMAT');
  });

  it('VAPID 缺失只警告不攔：讀寫任務照常，但到點消息發不出去且界面上毫無異常', () => {
    const report = inspectWorkerEnv({ ...fullEnv, VAPID_PRIVATE_KEY: '' });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w: any) => w.code)).toContain('VAPID_MISSING');
  });

  it('沒配共享密鑰時提醒端點是公開的（這種壞法完全靜默，不提醒沒人會發現）', () => {
    const report = inspectWorkerEnv({ ...fullEnv, AMSG_SERVER_TOKEN: undefined });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w: any) => w.code)).toContain('SERVER_TOKEN_MISSING');
  });
});

describe('worker 入口 — 配置不全時的響應', () => {
  const brokenEnv = { AMSG_MASTER_KEY: '', DB: undefined } as any;
  const fullEnv = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: { prepare: () => {} },
  } as any;

  const call = (url: string, init: RequestInit = {}, env: any = brokenEnv) =>
    (worker as any).fetch(new Request(url, init), env, { waitUntil: () => {} });

  it('回明確的 WORKER_CONFIG_MISSING，而不是籠統的「服務器內部錯誤」', async () => {
    const response = await call('https://w.example/messages');
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('WORKER_CONFIG_MISSING');
    expect(body.error.missing).toEqual(['DB', 'AMSG_MASTER_KEY']);
  });

  it('這個響應必須帶 CORS 頭，否則瀏覽器不讓前端讀，又變回 "Failed to fetch"', async () => {
    const response = await call('https://w.example/messages');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('配置不全時預檢照樣放行——預檢被擋住的話正式請求根本發不出去', async () => {
    const response = await call('https://w.example/messages', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  // 大 body 走 gzip 上行時請求帶 Content-Encoding，而它不在 CORS 安全列表裡 ——
  // 預檢不放行的話，瀏覽器連正式請求都不會發，用戶側只看得到一句沒有下文的
  // "Failed to fetch"，從外面完全看不出是 CORS 的事。
  it('預檢放行 Content-Encoding，否則壓過的請求一條都發不出去', async () => {
    const response = await call('https://w.example/instant-chat', { method: 'OPTIONS' });
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Encoding');
  });

  it('/config-check 在配置缺一半時也要能答，否則前端沒法告訴用戶缺的是哪一樣', async () => {
    const response = await call('https://w.example/config-check');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.ok).toBe(false);
    expect(body.data.missing).toEqual(['DB', 'AMSG_MASTER_KEY']);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('配置齊全時放行到上游：/vapid-public-key 該由上游回公鑰，不能被自檢層截胡', async () => {
    const response = await call('https://w.example/vapid-public-key', {}, fullEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, publicKey: 'pub' });
  });

  it('配置齊全時未知路由由上游回 404，不是自檢層的 503（否則等於把整個路由表吃掉了）', async () => {
    const response = await call('https://w.example/', {}, fullEnv);
    expect(response.status).toBe(404);
  });
});

// 上游報的 missing 是一摞帶類型前綴的串（table: / column: / index:），體檢面板按
// 「缺表」「缺列」兩類分開說話——兩者要用戶做的事不一樣：缺表點一下連接就建好了，
// 缺列則是升級後沒重連的典型症狀。
describe('splitSchemaMissing', () => {
  it('按前綴分兩摞，列保留表名前綴', () => {
    expect(splitSchemaMissing([
      'table:message_outbox',
      'column:scheduled_messages.last_error',
      'column:client_state.updated_at',
    ])).toEqual({
      missingTables: ['message_outbox'],
      missingColumns: ['scheduled_messages.last_error', 'client_state.updated_at'],
    });
  });

  // 索引缺失對用戶來說也是「點一次重新連接」，沒必要多造一個詞讓人分辨。
  it('索引並進「缺表」那一摞', () => {
    expect(splitSchemaMissing(['index:uidx_uuid'])).toEqual({
      missingTables: ['uidx_uuid'],
      missingColumns: [],
    });
  });

  it('什麼都不缺時兩摞都是空的（這是「一切正常」的判據）', () => {
    expect(splitSchemaMissing([])).toEqual({ missingTables: [], missingColumns: [] });
  });
});

// /debug 是隔著屏幕幫別人看部署時用的：對方只會截圖或者把 JSON 貼過來，所以它既要
// 說得足夠多（配置、schema、cron），又不能帶出任何一樣不該外傳的東西——它不設防。
describe('classifySchemaProbeError — 自查掛了歸到哪一檔', () => {
  // 分檔的意義全在「用戶該做什麼」上：unsupported 點一下更新就好，denied 點什麼都沒用
  // （後端自己的毛病），timeout 再體檢一次多半就過。混成一句「查不了」等於什麼都沒說。
  it('D1 的授權器拒了 → denied', () => {
    expect(classifySchemaProbeError(new Error('D1_ERROR: not authorized: SQLITE_AUTH'))).toBe('denied');
  });

  it('後端太舊、壓根沒這個方法 → unsupported', () => {
    expect(classifySchemaProbeError(new TypeError('upstream.getSchemaVersion is not a function')))
      .toBe('unsupported');
    expect(classifySchemaProbeError(new Error('[amsg-server] 這個數據庫適配器不支持 schema 自查（沒實現 describeSchema）。')))
      .toBe('unsupported');
  });

  it('庫沒在時限內回話 → timeout', () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(classifySchemaProbeError(aborted)).toBe('timeout');
    expect(classifySchemaProbeError(new Error('D1_ERROR: query timed out'))).toBe('timeout');
  });

  it('歸不了類的一律 other，絕不誤報成上面三檔', () => {
    expect(classifySchemaProbeError(new Error('D1_ERROR: something else entirely'))).toBe('other');
    expect(classifySchemaProbeError('一段字符串')).toBe('other');
    expect(classifySchemaProbeError(null)).toBe('other');
  });
});

describe('/debug — 只讀診斷', () => {
  /**
   * 假 D1：按 SQL 關鍵字給回答，只支持這個端點真正會發的那幾條。
   *
   * schema 自查（上游的 describeSchema）會發三種：列表、`PRAGMA table_info(表名)`、
   * 索引列表。`columns` 給每張表配列名，不配的表當成沒有列——上游會照著自己的建表語句
   * 比對，缺什麼它說了算，這裡不再自己抄一份期望清單。
   */
  const fakeDb = ({ tables, columns = {}, indexes = [], pending = [], pushRows = 0 }: {
    tables: string[];
    columns?: Record<string, string[]>;
    indexes?: string[];
    pending?: { next_send_at: string }[];
    pushRows?: number;
  }) => ({
    prepare(sql: string) {
      const answer = async () => {
        const pragma = /PRAGMA table_info\((\w+)\)/.exec(sql);
        if (pragma) return { results: (columns[pragma[1]] || []).map((name) => ({ name })) };
        if (sql.includes("type = 'index'")) return { results: indexes.map((name) => ({ name })) };
        if (sql.includes('sqlite_master')) return { results: tables.map((name) => ({ name })) };
        if (sql.includes('push_subscriptions')) return { n: pushRows };
        const nowIso = new Date().toISOString();
        const overdue = pending.filter((task) => task.next_send_at <= nowIso);
        return {
          pending: pending.length,
          overdue: overdue.length,
          oldest: overdue.map((t) => t.next_send_at).sort()[0] ?? null,
        };
      };
      return { bind: () => ({ first: answer }), first: answer, all: answer };
    },
  });

  const ALL_TABLES = ['scheduled_messages', 'client_state', 'push_subscriptions'];

  const envWith = (db: unknown) => ({
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub-key',
    VAPID_PRIVATE_KEY: 'priv-key',
    AMSG_SERVER_TOKEN: 'shared-secret',
    DB: db,
  } as any);

  const debug = async (db: unknown) => {
    const response = await (worker as any).fetch(new Request('https://w.example/debug'), envWith(db));
    return (await response.json()).data;
  };

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  it('一個字都不能帶出密鑰、用戶標識或任務正文（這個端點不設防）', async () => {
    const data = await debug(fakeDb({ tables: ALL_TABLES }));
    const dumped = JSON.stringify(data);
    expect(dumped).not.toContain('a'.repeat(64));   // master key
    expect(dumped).not.toContain('priv-key');       // VAPID 私鑰
    expect(dumped).not.toContain('shared-secret');  // 共享密鑰
    // 公鑰是例外：前端訂閱時本來就要用它，另有一個公開端點專門返回它。
    // 放進來是為了能一眼比對兩邊配的是不是同一對。
    expect(data.vapidPublicKey).toBe('pub-key');
  });

  /**
   * 換了 bundle 卻沒跑 init-tenant 時，已有的表不會自己長出新列，cron 每分鐘都會因為
   * 讀不到它們而掛——前端一切正常、任務列表也在，就是一條都不發。這一項是那種故障
   * 唯一的可查證據，所以缺列必須點到名（缺哪張表哪一列，而不只是「有問題」）。
   *
   * 「缺哪些」由上游按它自己的建表語句判定，這裡只釘住「它說缺，/debug 就得報出來」。
   */
  /**
   * 迴歸守衛：比對不出來時報 null，**不是 true**。
   *
   * 這一項的全部意義就是查出上面那種漂移。查詢本身掛了（個別運行時不讓讀 sqlite_master /
   * PRAGMA，就是這種長相）卻回一句「齊了」，等於在唯一能發現這件事的地方給假綠燈——
   * 庫真缺列、cron 每分鐘靜默掛，而面板一路綠到底。寧可說「不知道」。
   */
  it('schema 比對不出來 → schemaReady 報 null（查不了 ≠ 齊了）', async () => {
    const db = fakeDb({ tables: ALL_TABLES });
    const blind = {
      prepare(sql: string) {
        if (/PRAGMA table_info/.test(sql)) {
          const boom = async () => { throw new Error('D1_ERROR: not authorized: SQLITE_AUTH'); };
          return { bind: () => ({ first: boom }), first: boom, all: boom };
        }
        return db.prepare(sql);
      },
    };
    const data = await debug(blind);
    expect(data.storage.reachable).toBe(true);
    expect(data.storage.schemaReady).toBeNull();
    expect(data.storage.schemaReady).not.toBe(true);
  });

  /**
   * 迴歸守衛：庫裡混著 Cloudflare 內部表 `_cf_KV` 時，自查必須繞開它跑完。
   *
   * 2026-08-09 在真機上撞到的：新建的 D1 庫自帶這張內部表，當時的上游遍歷全庫逐表
   * 問列，問到它被 D1 一口回絕（SQLITE_AUTH），整個自查斷在第一張表上。修復隨
   * amsg-server 2.6.0-next.18+ 發佈：內部表直接跳過。這個夾具裡 `PRAGMA
   * table_info(_cf_KV)` 仍然會炸——上游哪天退回去問它一句，自查就會重新斷掉、
   * schemaError 變回 denied，這條就紅。
   */
  it('庫裡混著 _cf_KV 內部表 → 上游跳過它，自查照常跑完', async () => {
    const db = fakeDb({ tables: ['_cf_KV', ...ALL_TABLES] });
    const withInternalTable = {
      prepare(sql: string) {
        if (sql.includes('PRAGMA table_info(_cf_KV)')) {
          const boom = async () => { throw new Error('D1_ERROR: not authorized: SQLITE_AUTH'); };
          return { bind: () => ({ first: boom }), first: boom, all: boom };
        }
        return db.prepare(sql);
      },
    };
    const data = await debug(withInternalTable);
    // 自查沒被內部表噎死：跑出了結論（缺不缺另說），且沒把 _cf_KV 當成該建的表。
    expect(data.storage.schemaError).toBeNull();
    expect(data.storage.schemaReady).not.toBeNull();
    expect(data.storage.missingTables).not.toContain('_cf_KV');
    // 走完了全程才對得出完整清單：credRefs 那張 llm_credentials 也在比對範圍裡。
    expect(data.storage.missingTables).toContain('llm_credentials');
  });

  it('自查跑成了就不帶 schemaError（有值等於「這次沒查成」）', async () => {
    const data = await debug(fakeDb({ tables: ALL_TABLES }));
    expect(data.storage.schemaError).toBeNull();
  });

  /**
   * 迴歸守衛：一張業務表都沒有的庫（一鍵部署完還沒點「連接並啟用」的樣子，只剩
   * `_cf_KV`）絕不許顯示成全綠，而且要點得出名來。
   *
   * 舊版上游在這裡會被 `_cf_KV` 噎死，「缺哪些表」只能是空數組，界面全靠
   * schemaError 撐著說「查不了」；amsg-server 2.6.0-next.18+ 跳過內部表後，
   * 自查能跑完並點名全部缺表，界面直接說得清「該點重新連接建表」。
   */
  it('庫裡一張業務表都沒有 → 點名全部缺表，空庫不算綠', async () => {
    const empty = {
      prepare(sql: string) {
        const answer = async () => {
          if (sql.includes('PRAGMA')) throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
          if (sql.includes('sqlite_master')) return { results: [{ name: '_cf_KV' }] };
          return { pending: 0, overdue: 0, oldest: null };
        };
        return { bind: () => ({ first: answer }), first: answer, all: answer };
      },
    };
    const data = await debug(empty);
    expect(data.storage.schemaReady).toBe(false);
    expect(data.storage.missingTables).toContain('scheduled_messages');
    expect(data.storage.missingTables).toContain('llm_credentials');
    expect(data.storage.schemaError).toBeNull();
  });

  it('換了 bundle 沒跑 init-tenant → 點名缺的那幾列（cron 會因此每分鐘靜默掛）', async () => {
    const data = await debug(fakeDb({
      tables: ALL_TABLES,
      columns: { scheduled_messages: ['id', 'next_send_at', 'status'] },
    }));
    expect(data.storage.schemaReady).toBe(false);
    // 帶表名前綴：同名列（created_at 之類）在好幾張表裡都有，光報列名說不清是哪張。
    expect(data.storage.missingColumns).toContain('scheduled_messages.lease_until');
    expect(data.storage.missingColumns.every((item: string) => item.includes('.'))).toBe(true);
  });

  it('整張表都沒有時報的是缺表，不是把它的列一條條列出來', async () => {
    const data = await debug(fakeDb({ tables: ['scheduled_messages'] }));
    expect(data.storage.missingTables).toContain('client_state');
    expect(data.storage.missingColumns.some((item: string) => item.startsWith('client_state.'))).toBe(false);
  });

  /**
   * 迴歸守衛：schema 查不動的時候不許報假警。
   *
   * 這一項紅了意味著「你的庫該遷移了」，而用戶照著去點「重新連接」並不能解決
   * 「查不了」這件事——反覆點、反覆紅，比不報更糟。
   */
  it('schema 查不了時不報假警（不是所有表都缺）', async () => {
    const brokenDb = {
      prepare(sql: string) {
        const answer = async () => {
          if (sql.includes('PRAGMA')) throw new Error('PRAGMA not supported');
          if (sql.includes('sqlite_master')) return { results: ALL_TABLES.map((name) => ({ name })) };
          return { pending: 0, overdue: 0, oldest: null };
        };
        return { bind: () => ({ first: answer }), first: answer, all: answer };
      },
    };
    const data = await debug(brokenDb);
    expect(data.storage.missingTables).toEqual([]);
    expect(data.storage.missingColumns).toEqual([]);
    expect(data.schema).toBeNull();
  });

  // 這個假庫只答得上計數，逐條細帳那條查詢會失敗——下面兩條測的正是那時的退路：
  // 只看最老那條晚了多久。逐條判定（重試中不算卡住之類）在 tickReport.test.ts 裡用真 SQLite 測。
  it('細帳讀不了時退回老判據：任務到點很久還掛著 pending → cron 那側有問題', async () => {
    const data = await debug(fakeDb({
      tables: ALL_TABLES,
      pending: [{ next_send_at: minutesAgo(47) }],
    }));
    expect(data.tick).toBe('stalled');
    expect(data.storage.oldestOverdueMinutes).toBeGreaterThanOrEqual(47);
  });

  it('細帳讀不了時退回老判據：剛到點一兩分鐘不算掛——cron 一分鐘一跳，得留重試餘量', async () => {
    const data = await debug(fakeDb({
      tables: ALL_TABLES,
      pending: [{ next_send_at: minutesAgo(1) }],
    }));
    expect(data.tick).toBe('healthy');
  });

  it('手上沒有待發任務時說 idle，不能拿「沒活幹」當「掛了」報', async () => {
    const data = await debug(fakeDb({ tables: ALL_TABLES }));
    expect(data.tick).toBe('idle');
  });

  it('雲端沒有推送訂閱時看得出來（換 worker 後最常見的「全綠但收不到」）', async () => {
    const empty = await debug(fakeDb({ tables: ALL_TABLES, pushRows: 0 }));
    expect(empty.storage.pushSubscriptionRegistered).toBe(false);
    const registered = await debug(fakeDb({ tables: ALL_TABLES, pushRows: 1 }));
    expect(registered.storage.pushSubscriptionRegistered).toBe(true);
  });

  it('D1 沒綁時照樣能答（配置全缺的時候正是最需要它的時候）', async () => {
    const data = await debug(undefined);
    expect(data.storage.reachable).toBe(false);
    expect(data.config.ok).toBe(false);
    expect(data.config.missing).toContain('DB');
    expect(data.tick).toBe('unknown');
  });

  it('查庫炸了只報錯誤類型，不把 SQL 片段漏出去', async () => {
    const data = await debug({
      prepare() { throw Object.assign(new Error('near "FROM scheduled_messages": syntax error'), { name: 'D1Error' }); },
    });
    expect(data.storage).toEqual({ reachable: false, error: 'D1Error' });
    expect(JSON.stringify(data)).not.toContain('syntax error');
  });
});

// ─── 即時對話（instant chat） ───
//
// 這條路和主動消息共用同一套 fire 管線，但語義完全相反：用戶剛把話說完、正盯著
// 「正在輸入…」等回覆。三道「到點還該不該發」的門（活躍租約、防穿幫閘、本次任務指令）
// 對它全都不適用，一道沒跳過就是「用戶發了消息但角色永遠不回」；而請求消息要是退回
// 主動消息模板，出來的東西驢唇不對馬嘴，用戶還看不出這是壞了。下面每條都對著一種。
describe('onBeforeFire — 即時對話分支', () => {
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在嗎' },
  ];

  const instantPack = (extra: Record<string, unknown> = {}) => firePackValue(null, {
    chat: { messages: CHAT_MESSAGES, builtAt: PACK_BUILT_AT },
    ...extra,
  });

  /** 即時對話任務：metadata 標 amsgInstantChat，沒有 amsgTaskInstruction。 */
  const instantCtx = (opts: {
    charRows?: Array<{ key: string; value: string }>;
    metadata?: Record<string, unknown>;
  } = {}) => makeCtx({
    charRows: opts.charRows ?? [
      { key: AMSG_FIRE_PACK_KEY, value: instantPack() },
      { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
    ],
    metadata: {
      amsgInstantChat: true,
      amsgMode: 'instant',
      amsgTaskInstruction: undefined,
      ...opts.metadata,
    },
  });

  it('請求消息 = 客戶端打的那串對話原樣 + 末尾追加一塊時效信息', async () => {
    const { ctx } = instantCtx();
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result.messages).toHaveLength(CHAT_MESSAGES.length + 1);
    expect(result.messages.slice(0, 2)).toEqual(CHAT_MESSAGES);
    const appended = result.messages[2];
    expect(appended.role).toBe('system');
    // 到點才知道的東西在這一塊裡：現在幾點
    expect(appended.content).toContain('現在是');
    // 迴歸守衛：走模板渲染的話這裡會出現主動消息那套措辭，用戶剛說的話反而沒人答
    expect(result.messages.map((m) => m.content).join('\n')).not.toContain('本次任務');
  });

  // 圖片消息本地是結構化分段，上游把 onBeforeFire 返回的 messages 整個丟進
  // /chat/completions 的請求體（amsg-shared 的 buildLlmRequestBody 只寫
  // `messages: llmMessages`，不看 content 的類型）。這裡但凡 String() 一下，
  // 模型收到的就是「[object Object]」——而它照樣會答，用戶只覺得角色答非所問。
  it('結構化 content（圖片）原樣進請求消息，一個字都不動', async () => {
    const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const structured = [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: [{ type: 'text', text: '08:00 [User sent an image]' }, imagePart] },
    ];
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(null, {
          chat: { messages: structured, builtAt: PACK_BUILT_AT },
        }) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    // 逐字相等：不是 [object Object]，也不是被拍平成文字段
    expect(result.messages.slice(0, 2)).toEqual(structured);
    const userMessage = result.messages[1] as unknown as { content: unknown[] };
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content[1]).toEqual(imagePart);
    // 追加的時效塊仍然照掛在最後
    expect(result.messages[2].role).toBe('system');
    expect(result.messages[2].content).toContain('現在是');
  });

  it('給足生成時間（庫默認 240s 對一輪帶工具的對話不夠，用戶會以為發失敗了）', async () => {
    const { ctx } = instantCtx();
    const result = await amsgHooks.onBeforeFire(ctx) as { totalTimeoutMs?: number };
    expect(result.totalTimeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  it('用戶正在熱聊也照答（活躍租約那道門是給主動消息讓路用的）', async () => {
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: instantPack() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
      metadata: { amsgExpirePolicy: 'expire' },
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages[0]).toEqual(CHAT_MESSAGES[0]);
  });

  it('防穿幫閘不攔它（「對話往前走了」正是它要回的那句話）', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor + 60_000, {
          chat: { messages: CHAT_MESSAGES, builtAt: PACK_BUILT_AT },
        }) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
      metadata: { amsgExpirePolicy: 'expire' },
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages).toHaveLength(CHAT_MESSAGES.length + 1);
  });

  it('沒有 amsgTaskInstruction 不算異常（即時對話沒有「本次任務」這回事）', async () => {
    const { ctx } = instantCtx();
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toHaveProperty('messages');
  });

  it('fire_pack 缺 chat 段 → 拋錯，絕不退回主動消息模板', async () => {
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },   // 只有模板、沒有 chat
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow('AMSG2_FIRE_STATE_MISSING');
  });

  it('照常給工具（角色在對話裡也能查東西、給自己排後續）', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: instantPack() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
      globalRows: [{ key: AMSG_TOOL_CONFIG_KEY, value: mcpToolConfigValue() }],
      metadata: { amsgInstantChat: true, amsgTaskInstruction: undefined },
    });
    // ctx.scheduleTask 存在才教「給自己排下一條」
    (ctx as any).scheduleTask = async () => ({ created: true, id: 1, uuid: 'u', nextSendAt: 'x' });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    const appended = result.messages[result.messages.length - 1].content;
    expect(appended).toContain('【外部工具');         // MCP 說明塊
    expect(appended).toContain('search_memory');
    expect(appended).toContain('給自己排下一條');      // 排程說明塊
    expect(result.tools?.map((t) => t.function.name)).toContain('mcp__search_memory');
  });

  it('定時任務照舊走模板渲染（沒被這個分支帶跑）', async () => {
    const { ctx } = makeCtx({});
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('問問對方吃了沒');
  });
});

// 角色 2.0 關著且無任務時，即時對話上傳的輕量包把 template 填成佔位串；欠著即時回覆
// 期間用戶新排的定時任務可能趕在真模板補傳之前到點——照渲就是給用戶發那句佔位自白。
describe('定時輪撞上即時輕量包的佔位模板', () => {
  const stubPackRows = (extra: Record<string, unknown> = {}) => [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue(null, { template: AMSG2_INSTANT_STUB_TEMPLATE, ...extra }) },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
  ];

  afterEach(() => configureInstantErrorPush(null));

  it('定時任務 → 拋可重試錯（不渲染佔位文本、不發 error push）', async () => {
    // 掛上直發通道才驗得出「沒發」：不掛的話 sendInstantErrorPush 本來就靜默跳過
    const sent: unknown[] = [];
    configureInstantErrorPush({
      webpush: { sendNotification: async (_s: unknown, body: string) => { sent.push(JSON.parse(body)); } },
      db: { prepare: () => ({ bind: () => ({ first: async () => null }), first: async () => null }) },
      masterKey: 'a'.repeat(64),
    } as any);

    const { ctx } = makeCtx({ charRows: stubPackRows() });
    const error = await amsgHooks.onBeforeFire(ctx).then(() => null, (e: unknown) => e);
    expect(error, '佔位模板不許被當系統提示詞渲染出去').toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain('AMSG2_FIRE_PACK_NOT_READY');
    // 可重試（不帶 permanent）：走上游重試梯子，客戶端銷帳後補傳真模板自然放行
    expect((error as { permanent?: boolean }).permanent).toBeUndefined();
    // 定時輪不佔即時失敗通道
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
  });

  it('即時對話不吃這道門：輕量包的 template 本來就是佔位串，照常按 chat 段生成', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgMode: 'instant', amsgInstantChat: true, amsgClientTaskId: 'ct-stub' },
      charRows: stubPackRows({ chat: { messages: [{ role: 'user', content: '在嗎' }], builtAt: PACK_BUILT_AT } }),
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages.length).toBeGreaterThan(0);
    // 佔位文本一個字都不進請求消息（即時輪不渲染模板）
    expect(JSON.stringify(result.messages)).not.toContain('AMSG2_INSTANT_STUB_TEMPLATE');
  });
});

// 用戶正盯著窗口等這條回覆時，鎖屏橫幅是純打擾（頁面自己會上屏）；窗口不可見時又
// 必須彈。SW 的 shouldRenderNotification 按 notification.show 分這兩種，worker 表態。
describe('即時對話的推送通知策略', () => {
  const CLIENT_TASK_ID = 'client-instant-1';
  const CHAT_MESSAGES = [{ role: 'user', content: '在嗎' }];

  const makeStore = (instant: boolean) => makeFireStore(instant ? CHAT_MESSAGES : undefined);

  /** 這一組只按「即時對話 / 定時任務」分兩種任務身份，別的都走模塊級那份 runFire。 */
  const fireMeta = (instant: boolean) => ({
    amsgClientTaskId: CLIENT_TASK_ID,
    amsgMode: instant ? 'instant' : 'auto',
    ...(instant ? { amsgInstantChat: true } : { amsgTaskInstruction: '想到什麼說什麼' }),
  });

  // 推了就得彈（訂閱按 userVisibleOnly 建的，不彈要被退訂/吊銷），打擾交給摺疊 + 靜音壓。
  it('即時對話的推送標 always + 摺疊 + 前台才靜音，一輪只響一聲', async () => {
    const store = makeStore(true);
    const { decision } = await runFire(store, { metadata: fireMeta(true), llmOutput: '在的。怎麼啦？' });
    expect(decision.decision).toBe('finish');
    decision.pushPayloads.forEach((push: any, index: number) => {
      expect(push.notification.show).toBe('always');
      // 靜不靜音交給 SW 按窗口可見性算：寫死 true 的話切後台收到回覆也不響
      expect(push.notification.silent).toBe('when-visible');
      // 多段回覆摺疊成一條，靠的是同 tag 互相覆蓋
      expect(push.notification.tag).toBe(`amsg-instant-${CHAR_ID}`);
      // 同 tag 默認靜默替換，所以這一輪的第一段得 renotify 才叫得到人，後面幾段安靜更新
      if (index === 0) expect(push.notification.renotify).toBe(true);
      else expect(push.notification).not.toHaveProperty('renotify');
      // 橫幅文案還在：策略只是加幾個字段，不是把 notification 換掉
      expect(push.notification.body).toBeTruthy();
    });
  });

  it('定時任務的推送不標 show（主動消息前台可見時更該彈）', async () => {
    const store = makeStore(false);
    const { decision } = await runFire(store, { metadata: fireMeta(false), llmOutput: '在的。' });
    for (const push of decision.pushPayloads) {
      expect(push.notification).toBeTruthy();
      expect((push.notification as any).show).toBeUndefined();
      // 摺疊 / 靜音 / 重新提醒都是即時對話專屬的，別順手把主動消息也一起壓安靜了
      expect((push.notification as any).silent).toBeUndefined();
      expect((push.notification as any).tag).toBeUndefined();
      expect((push.notification as any).renotify).toBeUndefined();
    }
  });
});

// 情緒評估從瀏覽器搬進 worker：用戶發完就能關頁面，情緒底色照樣更新。
//
// 兩條底線各佔一條用例：
//   ① 評估結果得隨最後一條 push 回到客戶端；而帶著副 API apiKey 的那份**評估配置**
//      一個字節都不許出現在任何一條 push 的 metadata 裡（push 出了這台 worker 就是
//      推送服務的事了，密鑰跟著走等於把用戶的副 API 送人）。
//   ② 評估掛了不能連累主回覆——用戶等的是那句話，情緒只是附贈。
describe('即時對話的雲端情緒評估', () => {
  const CLIENT_TASK_ID = 'client-instant-eval';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在嗎' },
  ];
  const EVAL_PROMPT = [
    '你是一個角色情緒分析系統。',
    '__EMOTION_EVAL_SYSTEM_PROMPT__',
    '__EMOTION_EVAL_HISTORY__',
  ].join('\n');
  const EVAL_SPEC = {
    prompt: EVAL_PROMPT,
    api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-secondary-KEYLEAK', model: 'eval-mini' },
  };
  /** 兩段正文 → 兩條 push，才能驗「只掛最後一條」。 */
  const TWO_SEGMENT_OUTPUT = '在的。\n怎麼啦？';

  afterEach(() => vi.unstubAllGlobals());

  const makeStore = () => makeFireStore(CHAT_MESSAGES);

  /** 這一組的任務身份是固定的即時對話，只有評估配置那部分按用例變。 */
  const evalFire = (
    store: ReturnType<typeof makeStore>,
    extraMeta: Record<string, unknown>,
    llmOutput = TWO_SEGMENT_OUTPUT,
  ) => runFire(store, {
    metadata: {
      amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant',
      amsgInstantChat: true,
      ...extraMeta,
    },
    llmOutput,
  });

  it('評估結果隨最後一條 push 回去，而副 API 憑據一條都不帶出門', async () => {
    const seen: Array<{ url: string; auth: string | null; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      seen.push({
        url: String(input),
        auth: new Headers(init.headers).get('Authorization'),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"changed":true,"buffs":[]} EVAL-RAW-MARKER' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const store = makeStore();
    const { decision, metadata } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);

    // 評估真的發出去了：打給副 API、帶副 API 的 key、佔位符已經被本次對話還原掉
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://eval.example.com/v1/chat/completions');
    expect(seen[0].auth).toBe('Bearer sk-secondary-KEYLEAK');
    const evalContent = String(seen[0].body.messages[0].content);
    expect(evalContent).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(evalContent).not.toContain('__EMOTION_EVAL_HISTORY__');
    expect(evalContent).toContain('你是 Nyah。');
    expect(evalContent).toContain('[用戶]: 在嗎');
    // 主生成看得到的時效塊，評估也得看到（不然它連現在幾點都不知道）
    expect(evalContent).toContain('現在是');

    // 結果只掛最後一條
    const last = payloads[payloads.length - 1];
    expect(last.metadata.amsgEmotionUpdate).toContain('EVAL-RAW-MARKER');
    expect(last.metadata.amsgEmotionDone).toBe(true);
    for (const payload of payloads.slice(0, -1)) {
      expect(payload.metadata.amsgEmotionUpdate).toBeUndefined();
      expect(payload.metadata.amsgEmotionDone).toBeUndefined();
    }

    // 紅線：任何一條 push 的 metadata 都不許帶評估配置（裡頭是副 API 的 apiKey）
    for (const payload of payloads) {
      expect(payload.metadata).not.toHaveProperty('amsgEmotionEval');
    }
    expect(JSON.stringify(payloads)).not.toContain('sk-secondary-KEYLEAK');

    // 縱深防禦第一道：onBeforeFire 在捕獲點就把這個鍵從**任務 metadata 對象本身**刪了。
    // 上游把同一個對象按引用餵給「hook 不接手時」那條模板路徑，那條路徑會 `push.metadata
    // = args.metadata` 直接掛上去——只要哪天 onBeforeFire 在某個分支返回了 undefined，
    // 整份憑據就隨每條推送出門。刪乾淨了，那條路徑也就無從可漏。
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
    expect(JSON.stringify(metadata)).not.toContain('sk-secondary-KEYLEAK');
  });

  it('評估掛了照發主回覆（一條 amsgEmotionUpdate 都不掛）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const store = makeStore();
    const { decision, metadata } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads.map((p) => p.message)).toEqual(['在的。', '怎麼啦？']);
    for (const payload of payloads) {
      expect(payload.metadata.amsgEmotionUpdate).toBeUndefined();
      expect(payload.metadata).not.toHaveProperty('amsgEmotionEval');
    }
    // 但「這一輪的評估有結論了」照樣要帶回去 —— 否則客戶端那盞「情緒更新中」
    // 要一直亮到十幾分鍾後才由安全網熄，用戶只看到情緒永遠不更新。
    const lastMeta = payloads[payloads.length - 1].metadata;
    expect(lastMeta.amsgEmotionDone).toBe(true);
    // 還捎一句短原因給客戶端照實說明白（用戶自己部署的 worker，「可查日誌」等於沒說）
    expect(lastMeta.amsgEmotionError).toContain('副 API HTTP 500');
    // 評估跑掛了也照刪不誤（憑據的去留跟評估成不成功無關）
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  // 迴歸守衛：評估以前是無條件 await 的，而它自己的超時是 120 秒（EMOTION_EVAL_TIMEOUT_MS）。
  // 副 API 一限流 / 掛起，寫好的回覆就被扣在這兒兩分鐘：用戶一直看著「正在輸入…」，
  // 同一句話走本地路徑十秒就上屏了（本地那條的情緒評估是 fire-and-forget，從不擋回復）。
  // 工具循環吃掉大半預算時，這兩分鐘還會把整輪 600 秒的預算頂穿 —— fire 失敗重跑，
  // 用戶拿到的是一句失敗說明，而不是那條已經生成好的回覆。
  it('副 API 掛起時不擋回復：等夠搭車窗口就先把話發出去', async () => {
    vi.useFakeTimers();
    try {
      // 永不回來的副 API（限流 / 掛起時就是這個樣子）
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

      const store = makeStore();
      const pending = evalFire(store, { amsgEmotionEval: EVAL_SPEC });
      // 先把 hook 鏈推到「等評估搭車」那一步（中間還有幾個 await），再撥表。
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      const { decision } = await pending;

      expect(decision.decision).toBe('finish');
      const payloads = decision.pushPayloads as Array<Record<string, any>>;
      // 正文一段不少地發出去了 —— 這才是用戶在等的東西
      expect(payloads.map((p) => p.message)).toEqual(['在的。', '怎麼啦？']);

      const lastMeta = payloads[payloads.length - 1].metadata;
      // 結果沒趕上就不搭這班車，但也不作廢：掛引用鍵 + pending 標記，客戶端對著鍵
      // 輪詢補落（燈繼續亮著，等 amsgFireSettled 把遲到的結果寫進旁路）。
      expect(lastMeta.amsgEmotionUpdate).toBeUndefined();
      expect(lastMeta.amsgEmotionRef).toBe(`emotion_update:${CLIENT_TASK_ID}`);
      expect(lastMeta.amsgEmotionPending).toBe(true);
      expect(lastMeta.amsgEmotionDone).toBeUndefined();
      expect(lastMeta.amsgEmotionError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // 晚投不丟：沒趕上順風車的評估，收尾（amsgFireSettled）等它出結果寫進旁路存儲，
  // 客戶端按 push 上的引用鍵輪詢補落。迴歸守衛——以前這一輪評估是直接作廢的。
  it('沒趕上的評估晚投不丟：收尾時寫進旁路存儲', async () => {
    vi.useFakeTimers();
    try {
      let resolveEval!: (r: Response) => void;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveEval = resolve; })));

      const store = makeStore();
      const pending = evalFire(store, { amsgEmotionEval: EVAL_SPEC });
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      const { decision, scratch } = await pending;
      const lastMeta = (decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
      expect(lastMeta.amsgEmotionPending).toBe(true);

      // 收尾開始後評估才回來 → 結果落進旁路鍵，客戶端輪詢取得到
      const settling = amsgFireSettled({
        status: 'sent', sentCount: 2, task: { retry_count: 0 },
        scratch, writeState: store.writeState,
      } as any);
      resolveEval(new Response(JSON.stringify({
        choices: [{ message: { content: '{"changed":true,"buffs":[]} LATE-EVAL-MARKER' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await settling;

      expect(store.rows.get(`emotion_update:${CLIENT_TASK_ID}`)).toContain('LATE-EVAL-MARKER');
    } finally {
      vi.useRealTimers();
    }
  });

  // 一段都沒送出去（推送全滅 → 任務整輪重跑）時不寫晚投：客戶端沒收到 pending 標記，
  // 沒人會來取這一份，重跑的那輪會帶著自己的評估重新走完整流程。評估一直沒跑出來時，
  // 失敗收尾那段「留給下一跳」的等待也是有界的（搭車窗口那麼久），等不到就空手收尾。
  it('推送沒送出去時收尾不寫晚投評估', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

      const store = makeStore();
      const pending = evalFire(store, { amsgEmotionEval: EVAL_SPEC });
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      const { scratch } = await pending;

      const settling = amsgFireSettled({
        status: 'failed', sentCount: 0, task: { retry_count: 0 },
        error: new Error('push send failed'),
        scratch, writeState: store.writeState,
      } as any);
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      // 失敗收尾那段有界等待（評估結果留給下一跳複用）也要撥過去
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      await settling;

      expect(store.rows.has(`emotion_update:${CLIENT_TASK_ID}`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // fire 重試白燒評估費的迴歸守衛：失敗那跳的收尾把已出的評估結果寫進旁路鍵
  // （amsgEmotionUpdateKey，重試跨 tick 唯一能帶過來的位置），下一跳 onBeforeFire
  // 讀到就直接複用——2/4/6 分鐘梯子打滿也只燒一次副 API。
  it('fire 失敗重試：第二跳複用上一跳的評估結果，副 API 只調 1 次', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"changed":true,"buffs":[]} RETRY-EVAL-MARKER' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);

    const store = makeStore();
    // 第一跳：生成完但這跳失敗（比如推送沒發出去），任務還會重試
    const first = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 0 },
      error: new Error('push send failed'),
      scratch: first.scratch, writeState: store.writeState,
    } as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.rows.get(`emotion_update:${CLIENT_TASK_ID}`), '失敗收尾該把結果留給下一跳')
      .toContain('RETRY-EVAL-MARKER');

    // 第二跳（重試）：評估一個請求都不再發，結果照常隨末條 push 回客戶端
    const second = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    expect(fetchSpy, '第二跳不許再燒一次副 API').toHaveBeenCalledTimes(1);
    const lastMeta = (second.decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
    expect(lastMeta.amsgEmotionUpdate).toContain('RETRY-EVAL-MARKER');
    expect(lastMeta.amsgEmotionDone).toBe(true);
  });

  // 正常情況下評估早就跑完了，搭車窗口一秒都用不上——不能因為加了窗口就變成「每輪都等」。
  it('評估已經跑完時立刻搭上車，不白等那個窗口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"changed":true,"buffs":[]} FAST-EVAL' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const startedAt = Date.now();
    const { decision } = await evalFire(makeStore(), { amsgEmotionEval: EVAL_SPEC });
    const lastMeta = (decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
    expect(lastMeta.amsgEmotionUpdate).toContain('FAST-EVAL');
    expect(Date.now() - startedAt).toBeLessThan(EMOTION_EVAL_RIDE_ALONG_MS);
  });

  // 報錯正文裡帶回一小段夠定位是限流還是鑑權就行，但**絕不能把 key 帶出來**：
  // 個別中轉會把整個請求（含 Authorization 頭）回顯在錯誤頁裡，而這句話要走 push 出門。
  it('失敗原因裡的憑據打碼（中轉把請求回顯在錯誤頁裡也不漏）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'Unauthorized for Bearer sk-secondary-KEYLEAK on model eval-mini', { status: 401 })));

    const store = makeStore();
    const { decision } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    const reason = String(payloads[payloads.length - 1].metadata.amsgEmotionError);

    expect(reason).toContain('副 API HTTP 401');
    expect(reason).toContain('***');
    expect(reason).not.toContain('sk-secondary-KEYLEAK');
    expect(JSON.stringify(payloads)).not.toContain('sk-secondary-KEYLEAK');
  });

  it('評估模型沒吐東西 → 原因說清是「沒輸出」，不是網絡問題', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const store = makeStore();
    const { decision } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    const lastMeta = (decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
    expect(lastMeta.amsgEmotionDone).toBe(true);
    expect(lastMeta.amsgEmotionUpdate).toBeUndefined();
    expect(lastMeta.amsgEmotionError).toContain('評估模型沒有輸出內容');
    expect(lastMeta.amsgEmotionError).toContain('length');
  });

  // 上游判「這次 hook 不接手」的依據就是 onBeforeFire 返回 null/undefined，那之後走的
  // 模板路徑會把整份解密 metadata 直接掛上每條推送。即時對話這條路絕不能落到那兒——
  // 一是憑據，二是那條路會拿主動消息的模板去答用戶剛說的話。
  it('即時對話永遠不返回 undefined（返回了就等於把整輪交給上游模板路徑）', async () => {
    // 評估會真發一個請求，這裡只關心返回值，隨便擋掉（不擋就去解真域名，慢且看網絡臉色）
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const store = makeStore();
    const scratch: Record<string, unknown> = {};
    const metadata = {
      charId: CHAR_ID, amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant', amsgInstantChat: true,
      amsgEmotionEval: EVAL_SPEC,
    };
    const result = await amsgHooks.onBeforeFire({
      task: {
        id: 42, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
        nextSendAt: '2026-07-25T12:00:00.000Z', metadata,
      },
      userId: 'u1', readState: store.readState, writeState: store.writeState,
      now: NOW, scratch,
    } as any);

    expect(result).not.toBeUndefined();
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('messages');
    // 就算哪天真漏出去了，憑據也已經不在那個對象上了（第一道防線的意義就在這兒）
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  // 只刪這一個鍵：別的字段（防穿幫閘的錨點、任務歸屬鍵、amsgMode…）後面還要用，
  // 順手刪多了會以靜默走樣的方式壞掉——比如 amsgMode 沒了，推送就成了 'auto'。
  it('只摘走評估配置，別的任務字段一個不動', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const store = makeStore();
    const { metadata } = await evalFire(store, {
      amsgEmotionEval: EVAL_SPEC,
    });
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
    expect(metadata).toMatchObject({
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant',
      amsgInstantChat: true,
    });
  });

  it('沒配評估就一個請求都不發（老配置 / 沒開情緒評估的角色）', async () => {
    const fetchSpy = vi.fn(async () => new Response('never', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const store = makeStore();
    const { decision } = await evalFire(store, {});
    expect(decision.decision).toBe('finish');
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgEmotionUpdate).toBeUndefined();
    }
  });
});

describe('即時對話的接線', () => {
  const fullEnv = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: { prepare: () => {} },
  } as any;

  const call = (url: string, init: RequestInit = {}, env: any = fullEnv) =>
    (worker as any).fetch(new Request(url, init), env, { waitUntil: () => {} });

  it('/config-check 帶包裝層能力標誌（設置頁拿它當唯一的版本門檻）', async () => {
    const response = await call('https://w.example/config-check');
    const body = await response.json();
    expect(body.data.instantChat).toBe(true);
  });

  /**
   * 迴歸守衛：「有這條路由」和「這條路真的能用」必須分開報。
   *
   * 自更新是由用戶那台 Worker 上的**舊代碼**執行的，而舊代碼不認識 Durable Object——
   * 它傳上去的新 bundle 不帶 INSTANT_TICK 綁定。於是有個中間態：代碼是新的、
   * workerVersion 也對上了，`/instant-chat` 卻只能回 503。只報 instantChat / 版本號的話，
   * 前端會一邊說「已經是最新版」一邊發一條掛一條。前端的能力門檻認的就是這個字段。
   */
  it('/config-check 單獨報起跳器接沒接上：沒綁定就是 false', async () => {
    const body = await (await call('https://w.example/config-check')).json();
    expect(body.data.instantTick).toBe(false);
    // 中間態的長相：路由在、版本號也是新的，唯獨這條路跑不動。
    expect(body.data.instantChat).toBe(true);
    expect(typeof body.data.workerVersion).toBe('string');
  });

  it('/config-check 綁定在就是 true', async () => {
    const withTick = { ...fullEnv, INSTANT_TICK: { idFromName: () => ({}), get: () => ({ kick: async () => {} }) } };
    const body = await (await call('https://w.example/config-check', {}, withTick)).json();
    expect(body.data.instantTick).toBe(true);
  });

  it('/instant-chat 的預檢要放行，否則帶自定義頭的正式請求根本發不出去', async () => {
    const response = await call('https://w.example/instant-chat', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('/instant-chat 只接受 POST', async () => {
    const response = await call('https://w.example/instant-chat', { method: 'GET' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('配置不全時 /instant-chat 也回 503（不進上游、不半路落狀態）', async () => {
    const response = await call(
      'https://w.example/instant-chat',
      { method: 'POST', body: '{}' },
      { AMSG_MASTER_KEY: '', DB: undefined } as any,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORKER_CONFIG_MISSING');
  });

  it('不再顯式配 claimLeaseMs：租約交給上游的心跳續租（30s 一跳滾動，isolate 死後 ~90s 接手）', () => {
    // 迴歸守衛：把 claimLeaseMs 加回來會關不掉心跳（上游按「配置了就用你的」處理的是
    // 無心跳分支的 TTL），isolate 死亡恢復窗又變回按最長 fire 定格的十幾分鍾。
    // 心跳自己會蓋住即時對話 600s 的 fire——fire 跑多久租約就滾多久。
    const cfg = buildWorkerConfig(fullEnv) as Record<string, unknown>;
    expect(cfg.claimLeaseMs).toBeUndefined();
  });
});

// 即時對話終態失敗的直發通知：判死那一刻推一條 messageKind:'error'，前台當場收尾、
// 後台彈橫幅，不用乾等 60s 點名。紅線是「還會重試的失敗絕不發」——報錯完回覆又到
// 是雙通道老教訓裡最傷的誤報。迴歸守衛：沒有直發通道時這些場合一條 push 都不會有。
describe('即時對話終態失敗的直發 error push', () => {
  const CLIENT_TASK_ID = 'client-task-errpush';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在嗎' },
  ];
  const INSTANT_META = {
    amsgClientTaskId: CLIENT_TASK_ID,
    amsgMode: 'instant',
    amsgInstantChat: true,
  };

  const makeErrorPushDeps = () => {
    const sent: Array<{ subscription: any; body: any }> = [];
    const row = {
      user_id: 'u1',
      // 明文兜底路徑：解密失敗 → 按明文 JSON 再試（老部署的訂閱行）
      subscription: JSON.stringify({ endpoint: 'https://push.example/e1', keys: {} }),
    };
    const first = vi.fn(async () => row);
    const deps = {
      webpush: {
        sendNotification: vi.fn(async (subscription: unknown, body: string) => {
          sent.push({ subscription, body: JSON.parse(body) });
        }),
      },
      db: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })), first })) },
      masterKey: 'a'.repeat(64),
    };
    return { deps, sent };
  };

  afterEach(() => configureInstantErrorPush(null));

  it('重試打光（retry_count >= 3）的失敗 → 直發 error push（always + 摺疊 + 靜音）', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    await amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 3, user_id: 'u1' },
      error: new Error('LLM 上游 502'),
      scratch, writeState: store.writeState,
    } as any);

    expect(sent).toHaveLength(1);
    const payload = sent[0].body;
    expect(payload.messageKind).toBe('error');
    expect(payload.metadata.taskUuid).toBe(TASK_UUID);
    expect(payload.metadata.charId).toBe(CHAR_ID);
    expect(payload.metadata.reason).toContain('LLM 上游 502');
    // 這條是繞過庫自己直發的 push，收了不彈就是白记一笔账，只能標 always
    expect(payload.notification.show).toBe('always');
    expect(payload.notification.silent).toBe('when-visible');
    expect(payload.notification.tag).toBe(`amsg-instant-${CHAR_ID}`);
    // 這一輪到此為止，橫幅是唯一會去叫人的東西：不帶 renotify 它會悄悄頂掉剛才那條回覆
    expect(payload.notification.renotify).toBe(true);
    expect(payload.messageId).toBe(`err_${TASK_UUID}`);
    // 訂閱行按 user_id 查、明文兜底解出來
    expect((sent[0].subscription as any).endpoint).toBe('https://push.example/e1');
  });

  // permanent 終態（fireStateError 那族）最典型的發生位置在掛 stash 之前：收尾那份因
  // 讀不到 stash 提前走人，一條通知都發不出——只能由 fail() 當場補發。迴歸守衛：
  // 這族失敗以前是零通知，用戶鎖屏乾等到超時。
  it('onBeforeFire 掛 stash 之前的 permanent 失敗 → 恰好 1 條 error push（收尾不雙發）', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    // 即時任務 + 雲端沒有 fire_pack：fail() 在掛 stash 之前拋 permanent 終態
    const { ctx, scratch } = makeCtx({
      metadata: { amsgMode: 'instant', amsgInstantChat: true, amsgClientTaskId: 'ct-err' },
      charRows: [],
    });
    const error = await amsgHooks.onBeforeFire(ctx).then(() => null, (e: unknown) => e);
    expect((error as { permanent?: boolean }).permanent).toBe(true);

    // fail() 的直發是 fire-and-forget，等它落地
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.messageKind).toBe('error');
    expect(sent[0].body.metadata.taskUuid).toBe(TASK_UUID);
    expect(sent[0].body.metadata.reason).toContain('fire_pack');
    expect(sent[0].body.messageId).toBe(`err_${TASK_UUID}`);

    // 上游隨後照常調收尾（status failed、scratch 上沒有 stash）→ 不雙發
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 0 }, error,
      scratch, writeState: vi.fn(async () => ({ upserted: 0, skipped: 0, deleted: 0 })),
    } as any);
    expect(sent).toHaveLength(1);
  });

  // 掛上 stash 之後才炸出的 permanent 也是終態（上游一跳就把行標 failed），
  // 不能拿「retry 還沒打光」當沒到終態——那樣這族失敗同樣零通知。
  it('掛上 stash 之後的 permanent 失敗 → 收尾直發，不用等重試打光', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    const error = Object.assign(new Error('狀態壞了，重試也沒用'), { permanent: true });
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 0, user_id: 'u1' }, error,
      scratch, writeState: store.writeState,
    } as any);

    expect(sent).toHaveLength(1);
    expect(sent[0].body.messageKind).toBe('error');
    expect(sent[0].body.metadata.reason).toContain('狀態壞了');
  });

  it('還會重試的失敗（retry_count < 3）絕不發——報錯完回覆又到是最傷的誤報', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    await amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 1, user_id: 'u1' },
      error: new Error('臨時抖動'),
      scratch, writeState: store.writeState,
    } as any);

    expect(sent).toHaveLength(0);
  });

  it('skip-push（空輸出，一錘定音）→ 直發，橫幅文案是人話', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { decision } = await runFire(store, { metadata: INSTANT_META, llmOutput: '' });
    expect((decision as any).decision).toBe('skip-push');

    expect(sent).toHaveLength(1);
    expect(sent[0].body.metadata.reason).toBe('empty-generation');
    expect(sent[0].body.notification.body).toContain('沒有生成內容');
  });

  it('stale 跳過（一錘定音）→ 直發', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgStaleSkip(
      { id: 1, uuid: TASK_UUID },
      {
        reason: 'stale', action: 'expired',
        metadata: { charId: CHAR_ID, amsgInstantChat: true },
        occurrenceMs: Date.now(), skippedCount: 1, nextSendAt: null,
        writeState,
      } as any,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].body.metadata.reason).toBe('stale');
  });

  it('直發通道沒配（deps 為 null）時靜默跳過，收尾不炸', async () => {
    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    await expect(amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 3, user_id: 'u1' },
      error: new Error('LLM 上游 502'),
      scratch, writeState: store.writeState,
    } as any)).resolves.toBeUndefined();
  });
});

// 迴歸守衛：「登記狀態全綠、到點一條都不來」的唯一出口。
//
// 瀏覽器有訂閱、庫裡也登記著同一條 endpoint，兩邊都自洽，但那條 endpoint 在推送服務
// 那側已經作廢——推過去只換回一個 410。這件事只有推送服務知道，所以事實由上游
// amsg-server 結構化寫進 last_error.pushStatus，這裡只負責讀出來。
//
// 關鍵約束：**只認 pushStatus 這個結構化字段，不去解析 reason 那句人話**。reason 是
// 給用戶看的自由文本，拿它當接口用的話，上游改個措辭這裡就靜默失效，而且不會有任何
// 測試掛——那正是「全綠但一條不來」重新長出來的方式。
describe('inspectPushDelivery — 推送有沒有真的送出去', () => {
  const REGISTERED_AT = Date.parse('2026-08-10T04:00:00.000Z');

  /** 一個只回 last_error 列的假 D1。 */
  const fakeDb = (rows: Array<{ last_error: string | null }>, explode = false) => ({
    prepare: () => ({
      all: async () => {
        if (explode) throw new Error('no such column: last_error');
        return { results: rows };
      },
      bind: () => ({ first: async () => null }),
      first: async () => null,
    }),
  }) as any;

  const failureRow = (at: string, extra: Record<string, unknown>) => ({
    last_error: JSON.stringify({ at, occurrence: at, reason: '隨便什麼人話摘要', ...extra }),
  });

  it('認結構化的 410，交出狀態碼和時刻', async () => {
    const result = await inspectPushDelivery(
      fakeDb([failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 410 })]),
      REGISTERED_AT,
    );
    expect(result).toEqual({
      gone: { status: 410, atMs: Date.parse('2026-08-10T05:06:00.000Z') },
      registeredAtMs: REGISTERED_AT,
    });
  });

  it('404（端點根本不存在）同樣算失效', async () => {
    const result = await inspectPushDelivery(
      fakeDb([failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 404 })]),
      REGISTERED_AT,
    );
    expect(result?.gone?.status).toBe(404);
  });

  it('reason 裡寫著 410 但沒有 pushStatus → 不認', async () => {
    // 這條就是「別把人話當接口」的守衛：上游給不出結構化字段時，寧可報「沒查到」，
    // 也不去正則匹配一句隨時會變的錯誤摘要。
    const result = await inspectPushDelivery(
      fakeDb([{
        last_error: JSON.stringify({
          at: '2026-08-10T05:06:00.000Z',
          reason: 'Web Push delivery failed: 410 Gone — push subscription has unsubscribed or expired.',
        }),
      }]),
      REGISTERED_AT,
    );
    expect(result).toEqual({ gone: null, registeredAtMs: REGISTERED_AT });
  });

  it('別的推送失敗（403 / 500）不算訂閱失效——重置訂閱治不了那些', async () => {
    const result = await inspectPushDelivery(
      fakeDb([
        failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 403 }),
        failureRow('2026-08-10T05:07:00.000Z', { pushStatus: 500 }),
      ]),
      REGISTERED_AT,
    );
    expect(result?.gone).toBeNull();
  });

  it('多條裡挑最近的那次——用戶要判斷的是「現在還壞不壞」', async () => {
    const result = await inspectPushDelivery(
      fakeDb([
        failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 410 }),
        failureRow('2026-08-10T06:30:00.000Z', { pushStatus: 410 }),
        failureRow('2026-08-10T02:00:00.000Z', { pushStatus: 410 }),
      ]),
      REGISTERED_AT,
    );
    expect(result?.gone?.atMs).toBe(Date.parse('2026-08-10T06:30:00.000Z'));
  });

  it('壞 JSON / 時刻解析不出來的行跳過，不帶崩整次自查', async () => {
    const result = await inspectPushDelivery(
      fakeDb([
        { last_error: '不是 JSON' },
        { last_error: null },
        failureRow('不是時間', { pushStatus: 410 }),
      ]),
      REGISTERED_AT,
    );
    expect(result).toEqual({ gone: null, registeredAtMs: REGISTERED_AT });
  });

  it('查詢本身掛了（老庫沒有 last_error 列）→ null = 這一項沒查出來', async () => {
    // 界面拿 null 顯示「沒查成」，不是綠燈——假綠燈正是這一整條鏈要治的病。
    expect(await inspectPushDelivery(fakeDb([], true), REGISTERED_AT)).toBeNull();
  });
});

// 交付順序守衛（這條掛著 = 這活還沒幹完，不是壞了）。
//
// 上面那段 inspectPushDelivery 讀的是上游寫進 last_error 的 pushStatus，而**上游從
// 2.6.0-next.20 才開始寫它**。依賴還鎖在更早的版本時打出來的 bundle 是最壞的組合：
// 「查了這一項」（probed: true）+「一次都沒被退回」（gone 永遠是 null）= 一個理直氣壯
// 的綠燈，而整條改動的存在意義就是幹掉這個綠燈。
//
// 所以這條測試就是發佈門禁：上游發版、這邊 pnpm up 到 next.20 之後它自己會變綠。
describe('打包進來的 amsg-server 得會寫 pushStatus', () => {
  it('依賴版本 >= 2.6.0-next.20（低於它 inspectPushDelivery 會一路綠燈說謊）', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf-8'),
    );
    const version = String(
      pkg.devDependencies?.['@rei-standard/amsg-server']
      ?? pkg.dependencies?.['@rei-standard/amsg-server'],
    );
    expect(
      isAmsgServerVersionAtLeast(version, '2.6.0-next.20'),
      `package.json 裡還鎖著 ${version}：那個版本的上游不寫 last_error.pushStatus，`
      + '打出來的 worker 會把「推送投遞」這一項一路報綠。等上游發版後升到 next.20 再打 bundle。',
    ).toBe(true);
  });
});
