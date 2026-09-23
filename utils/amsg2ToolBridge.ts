/**
 * amsg2ToolBridge — 把主動消息 2.0 的排程/取消/續期/查詢暴露為 OpenAI function-calling 工具，
 * 讓角色在對話中直接管理定時消息（"提醒我 8 點問好"→ LLM 調 schedule_active_message）。
 *
 * 工具定義注入 useChatAI 的 tools 數組；執行器在工具循環裡分發。
 * 多任務：一個角色可同時掛多個任務，用短 id（taskUuid 前 8 位）定位。
 *
 * 防打轉是這份文件的一部分職責：工具循環最多轉 6 輪，模型一旦每輪都重複同一個 schedule，
 * 每一輪都會在遠端實打實建一條任務。所以執行器自帶軟硬兩層——回話末尾明說這一步做完了，
 * 同名同參的第二次直接打回。口徑與 worker 的 fire 循環共用，見 utils/agenticToolFeedback.ts。
 */

import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { buildDuplicateToolMessage, toolCallFingerprint, type ToolCallRecord } from './agenticToolFeedback';
import { trackEvent } from './analytics';
import {
  applyScheduledTask, currentOccurrenceMs, describeExpirePolicy, describeRecurrence,
  describeTaskMode, describeTaskProgress, findTaskByShortId, formatTaskTime,
  getPendingTasks, isPendingTask, pruneStaleTasks, resolveExpirePolicy, shortTaskId,
} from './amsg2Tasks';
import { resolveMaxUnansweredSends } from './amsgFirePack';
import { EXPIRE_POLICY_DESCRIPTION } from './amsgFireSchedule';
import { resolveCharTimeZone } from './timezone';

// ─── OpenAI tools schema ───

interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, any> };
}

export const AMSG2_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'schedule_active_message',
      description: [
        '創建定時主動消息：到指定時間後，你（角色）會根據最新聊天上下文自動生成並推送一條消息給用戶。',
        '重要：send_at 是 worker 開始生成消息的請求時間，不是最終送達時間（中間有推理延遲，通常 10-30 秒）。',
        '如果要"卡點"送達（比如整點），建議提前 1 分鐘。',
        '推薦使用 mode=auto：角色根據最新聊天內容自動決定說什麼，後續聊天會自動同步至上下文。',
        'mode=prompted：給角色一個提示方向（如"問問對方吃了沒"），角色圍繞這個方向生成。',
        '每個角色最多同時掛 5 個任務；到點作廢與否由 expire_policy 決定。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          send_at: {
            type: 'string',
            // 只教裸牆鍾：角色照著自己那邊的鐘寫，系統按角色時區還原成絕對時刻
            // （跟 worker 到點解析 send_at 同一份規則）。教它寫 +08:00 這種偏移的話，
            // 紐約角色會照抄示例裡的東八區，說出來的「明早九點」實際差一個時差。
            description: '開始生成消息的時間，寫你本地的牆鍾時間，格式 YYYY-MM-DDTHH:mm:ss（如 2026-07-20T20:00:00），不要帶時區後綴。必須晚於當前時間。',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'prompted'],
            description: '生成模式。auto=根據最新聊天自動生成（推薦）；prompted=圍繞 prompt_hint 方向生成。默認 auto。',
          },
          prompt_hint: {
            type: 'string',
            description: '僅 mode=prompted 時有效。給角色的提示方向，如"問問對方晚飯吃了沒"。',
          },
          recurrence: {
            type: 'string',
            enum: ['none', 'daily', 'weekly'],
            description: '重複類型。none=一次性（默認）；daily=每天同一時間；weekly=每週同一天同一時間。',
          },
          expire_policy: {
            type: 'string',
            enum: ['expire', 'force'],
            // 與 fire 側共用一份：同一個策略在兩個入口說兩套話，角色的選擇會跟著入口漂。
            description: EXPIRE_POLICY_DESCRIPTION,
          },
        },
        required: ['send_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_active_message',
      description: '取消當前角色的一個定時主動消息任務。多個任務並存時必須用 task_id（排程現狀/任務列表裡的短 id）指定；只有一個待觸發任務時可省略。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '要取消的任務短 id（8 位）。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'renew_active_message',
      description: [
        '給一個任務續期：只換觸發時間，沿用原有模式與提示方向（含已作廢的任務）。',
        '一次性任務 = 整條改到新時間；循環任務 = 只給這一次補發一條一次性任務，原來的每天/每週節奏和編號都不動。',
        '想改的是循環任務本身的時間，或者想說的內容、方向已經變了，都不要用 renew，改用 cancel_active_message + schedule_active_message 重新創建。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          send_at: { type: 'string', description: '新的觸發時間，寫你本地的牆鍾時間，格式 YYYY-MM-DDTHH:mm:ss，不帶時區後綴。必須晚於當前時間。' },
          task_id: { type: 'string', description: '要續期的任務短 id（8 位）。只有一個任務時可省略。' },
        },
        required: ['send_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_active_messages',
      description: '查看當前角色的定時主動消息任務列表（短 id、時間、模式、狀態）。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const AMSG2_TOOL_NAMES = new Set(AMSG2_TOOLS.map((t) => t.function.name));

// ─── 執行器 ───

export interface Amsg2ToolDeps {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  apiConfig: APIConfig;
  /** 讀本輪最新的任務清單配置。只由 createAmsg2ToolSession 提供，別自己拼。 */
  getConfig: () => ActiveMsg2CharacterConfig | undefined;
  /** 寫回任務清單：刷新 getConfig 的來源，同時落 React state / DB。 */
  setConfig: (config: ActiveMsg2CharacterConfig) => void;
  /** 本輪已經真跑過的調用（同名同參）。executeAmsg2Tool 自己維護，調用方只管傳下去。 */
  seenCalls: ToolCallRecord[];
}

/**
 * 建一輪工具循環要用的 deps，一輪生成建一次、放在工具循環外面。
 *
 * 任務清單不從 char 上讀寫：char 是生成開始時的那份快照，updateCharacter 只更 React
 * state、不回寫它。所以角色一輪裡連建兩條任務時，第二次會讀著空清單把第一條覆蓋掉
 * （「建倆只顯示一個」）。這裡用一個本輪局部變量兜住最新 config，schedule / cancel /
 * renew / list 全部只經 getConfig / setConfig 走，累加就一定對——也不用去就地改
 * React state 裡的角色對象。
 */
export const createAmsg2ToolSession = (base: {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  apiConfig: APIConfig;
  updateCharacter: (charId: string, updates: Partial<CharacterProfile>) => void;
}): Amsg2ToolDeps => {
  let liveConfig = base.char.activeMsg2Config;
  return {
    char: base.char,
    userProfile: base.userProfile,
    groups: base.groups,
    realtimeConfig: base.realtimeConfig,
    apiConfig: base.apiConfig,
    seenCalls: [],
    getConfig: () => liveConfig,
    setConfig: (config) => {
      liveConfig = config;
      base.updateCharacter(base.char.id, { activeMsg2Config: config });
    },
  };
};

/**
 * 會改動任務清單的那幾個工具：跑一次就是遠端多一條 / 少一條任務，所以要防打轉。
 *
 * list 不在裡面——同一輪裡排完再查，清單本來就該變，攔掉的話角色拿到的是「結果就在
 * 上面」但上面那份已經過時了。
 */
const MUTATING_TOOLS = new Set([
  'schedule_active_message',
  'cancel_active_message',
  'renew_active_message',
]);

/**
 * 每次工具跑完都補的收尾話（軟的那層，硬的那層是下面的指紋攔截）。
 *
 * 只回一句「已創建 [xxx]」的話，模型看不出這一步已經結束了：工具循環最多轉 6 輪，
 * 常駐提示詞裡但凡有一句「需要時直接調工具」，它每輪都會照做，一路把同一條任務排到
 * 撞上限為止（現場：一句「等會找我」排出 5 條一模一樣的）。措辭跟 worker 的 fire
 * 循環共用一套口徑，見 utils/agenticToolFeedback.ts。
 */
const TOOL_FOLLOW_UP = [
  '[系統: 這一次調用已經處理完了，結果就在上面。同樣的調用不要再來一遍——',
  '現在把要對用戶說的話寫出來，或者用一個還沒用過的工具。',
  '前面已經說出去的內容不要重寫，接著往下寫就行。]',
].join('\n');

export const executeAmsg2Tool = async (
  toolName: string,
  args: Record<string, any>,
  deps: Amsg2ToolDeps,
): Promise<string> => {
  const mutating = MUTATING_TOOLS.has(toolName);
  // 同名同參第二次直接打回，一次網絡請求都不發。上面那段軟提示擋不住時靠它兜底，
  // 與 worker 的 fire 循環同一道閘。只攔**完全一樣**的調用——換時間、換方向照常放行，
  // 多輪能力一點不減。
  const fingerprint = mutating ? toolCallFingerprint(toolName, args) : '';
  if (mutating && deps.seenCalls.some((r) => r.fingerprint === fingerprint)) {
    return buildDuplicateToolMessage(toolName);
  }
  try {
    const result = await (() => {
      switch (toolName) {
        case 'schedule_active_message':
          return handleSchedule(args, deps);
        case 'cancel_active_message':
          return handleCancel(args, deps);
        case 'renew_active_message':
          return handleRenew(args, deps);
        case 'list_active_messages':
          return handleList(deps);
        default:
          return Promise.resolve(`未知工具 ${toolName}。`);
      }
    })();
    // 記帳放在跑完之後：拋錯的那次等於沒跑成（遠端沒建出東西），把它記下來的話，
    // 角色連一次原樣重試的機會都沒有。
    if (mutating) deps.seenCalls.push({ name: toolName, fingerprint });
    return mutating ? `${result}\n${TOOL_FOLLOW_UP}` : result;
  } catch (e: any) {
    return `操作失敗：${e?.message || String(e)}`;
  }
};

/** tasks 已歸一化成數組的 config，下面的 handler 直接 `config.tasks` 即可。 */
type LoadedConfig = ActiveMsg2CharacterConfig & { tasks: ActiveMsg2TaskRecord[] };

/** 讀本輪最新 config（含本輪前面幾次工具調用剛寫進去的任務）。 */
const readConfig = (deps: Amsg2ToolDeps): LoadedConfig => {
  const config = deps.getConfig();
  return { enabled: true, ...config, tasks: config?.tasks ?? [] };
};

/** 任務清單落盤：順手清過點 48h 的一次性任務。 */
const persistTasks = (
  deps: Amsg2ToolDeps,
  config: ActiveMsg2CharacterConfig,
  tasks: ActiveMsg2TaskRecord[],
) => {
  // enabled 原樣保留：工具只在角色開著 2.0 時才注入（見 isAmsg2EnabledForChar），
  // 這裡再強寫 true 就成了「一次工具調用替用戶把關掉的功能重新打開」。
  deps.setConfig({
    ...config,
    tasks: pruneStaleTasks(tasks, Date.now()),
    lastSyncedAt: Date.now(),
    lastError: undefined,
  });
};

async function handleSchedule(args: Record<string, any>, deps: Amsg2ToolDeps): Promise<string> {
  const { char, userProfile, groups, realtimeConfig, apiConfig } = deps;
  const config = readConfig(deps);
  // 連發上限·本地排程閘（與 worker fire 側 runFireScheduleTool 的 unanswered_limit
  // 對齊）：掛著的自排任務到點各消耗一條連發額度，本地排到超限的那幾條會被到點兜底閘
  // 靜默 skip——角色在正文裡承諾了「等下再來找你」，到點卻憑空蒸發。在這裡帶回喂打回，
  // 讓模型當場改口。本地輪次用戶剛開口（連發計數已清零），所以只數還沒響的自排任務；
  // 面板裡用戶親手排的（source!=='character'）不佔額度，與 worker 側同一口徑。
  // 改期/補當次（__replaceTaskUuid / __makeupForTaskUuid）不新佔額度，放行。
  if (!args.__replaceTaskUuid && !args.__makeupForTaskUuid) {
    const unansweredLimit = resolveMaxUnansweredSends(char.activeMsg2Config?.maxUnansweredSends);
    const plannedSelfSends = config.tasks
      .filter((t) => t.source === 'character' && isPendingTask(t, Date.now()))
      .length;
    if (plannedSelfSends + 1 > unansweredLimit) {
      return `對方還沒回復，這期間你已經排了 ${plannedSelfSends} 條後續，用戶設置的連發上限是 ${unansweredLimit} 條——這次別排了，等 ta 回覆再說。`;
    }
  }
  // 回話裡的時間按角色的鐘寫：到點 worker 渲染排程清單用的也是角色時區，兩邊對不上的話
  // 紐約角色剛排的那條，在下一輪的排程現狀裡會顯示成差一個時差的另一個時刻。
  const charTz = resolveCharTimeZone(char);
  const mode = (args.mode === 'prompted' ? 'prompted' : 'auto') as 'auto' | 'prompted';
  const recurrence = (['daily', 'weekly'].includes(args.recurrence) ? args.recurrence : 'none') as 'none' | 'daily' | 'weekly';
  const expirePolicy = resolveExpirePolicy(mode, args.expire_policy === 'force' ? 'force' : 'expire');
  const taskInput = {
    mode, firstSendTime: args.send_at, recurrenceType: recurrence,
    promptHint: args.prompt_hint || undefined,
    expirePolicy,
  };

  const result = await ActiveMsgClient.scheduleCharacterTask({
    // selfScheduled：角色自己排的要帶標記進任務 metadata——連發上限的到點兜底閘只攔
    // 帶它的任務，用戶在面板裡親手排的不帶、不受限（面板走的是同一個入口但不傳這個）。
    char, config, task: { ...taskInput, selfScheduled: true },
    replaceTaskUuid: args.__replaceTaskUuid,   // renew 內部複用，LLM 不感知
    userProfile, groups, realtimeConfig, apiConfig,
  });

  const record: ActiveMsg2TaskRecord = {
    taskUuid: result.uuid,
    clientTaskId: result.clientTaskId,
    ...taskInput,
    // send_at 是角色那邊的牆鍾，落盤存排程接口摺好的絕對時刻。存原串的話，本地讀它的地方
    // （面板卡片、待觸發判定、下面這句回話）一律 new Date() 按設備時區解析，異國角色差一個時差。
    firstSendTime: result.firstSendAt,
    source: 'character',
    status: 'scheduled',
    createdAt: Date.now(),
  };
  // 並清單的規則（替換成功才移除舊記錄；遠端取消失敗則保留舊記錄並標錯，短 id 還在、
  // 角色和用戶都還能再取消一次）與設置面板共用 applyScheduledTask。
  persistTasks(deps, config, applyScheduledTask(
    config.tasks,
    record,
    { replaceTaskUuid: args.__replaceTaskUuid, replacedCancelFailed: result.replacedCancelFailed },
    Date.now(),
  ));

  // 只報枚舉構成（模式/頻率都是寫死的取值集合）。內容、時間、編號一概不帶。
  // 這份文件只在瀏覽器聊天側運行（不進 amsg worker bundle），引 analytics 安全。
  trackEvent('排程定时消息', {
    mode,
    recurrence,
    source: 'character',
    isEdit: args.__replaceTaskUuid ? 'yes' : 'no',
  });

  const recurrenceDesc = recurrence === 'none' ? '' : `（${describeRecurrence(recurrence)}重複）`;
  // 續期/替換走的是「先建新的再取消舊的」，編號必然換一個。不說清楚的話，角色剛用
  // 舊編號續了期，卻收到一句「已創建 [另一個編號]」，下一輪還會拿舊編號來操作。
  const oldShortId = args.__replaceTaskUuid ? shortTaskId(args.__replaceTaskUuid) : '';
  // 循環任務的續期是「補當次」，原序列一條沒動——不點明的話，角色會以為自己剛把
  // 每天的早安整體挪走了，下一輪又去把「原來那條」取消一遍。
  const makeupForShortId = args.__makeupForTaskUuid ? shortTaskId(args.__makeupForTaskUuid) : '';
  const head = makeupForShortId
    ? `已為 [${makeupForShortId}] 的這一次補上一條一次性任務 [${shortTaskId(result.uuid)}]，[${makeupForShortId}] 原來的重複節奏不變。`
    : !oldShortId
      ? `定時主動消息已創建 [${shortTaskId(result.uuid)}]。`
      : result.replacedCancelFailed
        ? `新任務 [${shortTaskId(result.uuid)}] 已創建，但原任務 [${oldShortId}] 遠端取消失敗、可能仍會觸發，請再取消一次。`
        : `原任務 [${oldShortId}] 已換成 [${shortTaskId(result.uuid)}]（改期是重建，編號會變）。`;
  // 回話裡的時間用摺好的絕對時刻按角色時區渲染。拿 args.send_at 原串渲染會折兩次
  // （先被 new Date 按設備解析，再換算到角色時區），角色剛排完就把時間說錯。
  return `${head}將在 ${formatTaskTime(result.firstSendAt, charTz)} 開始生成${recurrenceDesc}。`
    + `模式：${describeTaskMode(record)}，策略：${describeExpirePolicy(expirePolicy)}。`;
}

/** 按 task_id 參數（或"只有一個就選它"）解出目標任務；解不出返回給 LLM 的提示文案。 */
const resolveTargetTask = (
  config: LoadedConfig,
  taskIdArg: unknown,
): { task?: ActiveMsg2TaskRecord; error?: string } => {
  const tasks = config.tasks;
  if (typeof taskIdArg === 'string' && taskIdArg.trim()) {
    const task = findTaskByShortId(tasks, taskIdArg.trim());
    return task ? { task } : { error: `沒有找到短 id 為 ${taskIdArg} 的任務，請先用 list_active_messages 查看。` };
  }
  const pending = getPendingTasks(config, Date.now());
  if (pending.length === 1) return { task: pending[0] };
  if (pending.length === 0 && tasks.length === 1) return { task: tasks[0] };
  return { error: '當前有多個任務，請帶 task_id（短 id）指定要操作哪一個。' };
};

async function handleCancel(args: Record<string, any>, deps: Amsg2ToolDeps): Promise<string> {
  const config = readConfig(deps);
  if (!config.tasks.length) return '當前角色沒有排程中的主動消息任務。';
  const { task, error } = resolveTargetTask(config, args.task_id);
  if (!task) return error!;

  try {
    await ActiveMsgClient.cancelTask(task.taskUuid);
  } catch (e) {
    // 遠端取消失敗絕不靜默移除本地記錄（Codex #4）——否則遠端 recurring 照發、
    // 本地卻沒了短 id，用戶再也無法通過工具取消。
    console.warn('[amsg2ToolBridge] cancel remote task failed（保留本地記錄待重試）', e);
    persistTasks(deps, config, config.tasks.map((t) =>
      t.taskUuid === task.taskUuid ? { ...t, lastError: '遠端取消失敗，任務可能仍會觸發' } : t));
    return `取消任務 [${shortTaskId(task.taskUuid)}] 失敗（遠端未確認），稍後可重試。`;
  }
  persistTasks(deps, config, config.tasks.filter((t) => t.taskUuid !== task.taskUuid));
  return `已取消任務 [${shortTaskId(task.taskUuid)}]。`;
}

async function handleRenew(args: Record<string, any>, deps: Amsg2ToolDeps): Promise<string> {
  const config = readConfig(deps);
  if (!config.tasks.length) return '當前角色沒有可續期的任務，請用 schedule_active_message 新建。';
  const { task, error } = resolveTargetTask(config, args.task_id);
  if (!task) return error!;
  if (task.mode === 'fixed') return '固定消息任務請在設置面板調整。';
  // 循環任務的續期只補當次：整條改期的話，一條「每天 9:00 的早安」被角色順手續到
  // 11:00「晚點補上」，從明天起就永久變成 11:00 了，編號還跟著換一個。所以這裡改成
  // 建一條一次性的補發任務，原序列原樣留著繼續按自己的節奏響。
  const isRecurring = task.recurrenceType !== 'none';
  // 一次性任務照舊複用 schedule 的替換語義（舊任務已被 worker 刪掉時 cancel 失敗只 warn）。
  // 內容/方向要變就不該走這裡——工具描述已引導 cancel + 重建。
  return handleSchedule({
    send_at: args.send_at,
    mode: task.mode,
    prompt_hint: task.promptHint,
    recurrence: isRecurring ? 'none' : task.recurrenceType,
    expire_policy: task.expirePolicy,
    ...(isRecurring
      ? { __makeupForTaskUuid: task.taskUuid }
      : { __replaceTaskUuid: task.taskUuid }),
  }, deps);
}

async function handleList(deps: Amsg2ToolDeps): Promise<string> {
  const config = readConfig(deps);
  const charTz = resolveCharTimeZone(deps.char);
  const tasks = config.tasks;
  if (!tasks.length) return '當前角色沒有任何定時主動消息任務。';
  const now = Date.now();
  const lines = tasks.map((t) => {
    // 工具側沒有遠端底帳，進度只能給中性的那檔；時間按週期推到「下一次」，
    // 否則角色查到一條每天的任務顯示的是好幾天前，會當成已經過去的。
    const state = describeTaskProgress(t, null, now);
    return `- [${shortTaskId(t.taskUuid)}] ${formatTaskTime(currentOccurrenceMs(t, now) ?? t.firstSendTime, charTz)} ${describeRecurrence(t.recurrenceType)}`
      + ` · ${describeTaskMode(t)} · ${describeExpirePolicy(t.expirePolicy)} · ${state}`
      + `${t.lastError ? ` · ⚠ ${t.lastError}` : ''}`;
  });
  return `當前角色的任務列表：\n${lines.join('\n')}`;
}

export const isAmsg2GlobalReady = async (): Promise<boolean> => {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    return !!config.workerUrl?.trim();
  } catch {
    return false;
  }
};
