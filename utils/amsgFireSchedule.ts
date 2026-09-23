/**
 * 角色在「到點生成主動消息」那一刻給自己排下一條的工具。
 *
 * 前台聊天裡角色已經有 schedule_active_message（見 amsg2ToolBridge），這裡用同一個名字、
 * 同一套參數把它開到 fire 側——角色不用學第二套東西，兩端說的是同一件事。差別只在執行：
 * 前台走客戶端 API，fire 側走 amsg-server 的 ctx.scheduleTask 直接在 D1 建行，用戶離線
 * 也照樣排得上（這正是整件事的意義：連著說兩句不需要用戶在線當中轉）。
 *
 * 零運行時依賴（worker bundle 會打進這份代碼）：只有純函數和常量。
 */

import type { ActiveMsg2ExpirePolicy, ActiveMsg2Mode, ActiveMsg2Recurrence, ActiveMsg2TaskRecord } from '../types';
import { currentOccurrenceMs, isPendingTask, shortTaskId } from './amsg2Tasks';
import { type AmsgTzRef, formatFireTimeShort, wallClockPartsInZone } from './amsgFirePack';
import { wallClockToTimestamp } from './timezone';

/** 與前台同名，故意的：見文件頭。 */
export const AMSG_FIRE_SCHEDULE_TOOL = 'schedule_active_message';

/** 取消 / 改期也開到 fire 側（amsg-server 2.6.0-next.15 的 ctx.cancelTask / renewTask）。 */
export const AMSG_FIRE_CANCEL_TOOL = 'cancel_active_message';
export const AMSG_FIRE_RENEW_TOOL = 'renew_active_message';

/**
 * 單次 fire 最多讓角色排幾條。
 *
 * 上游庫自己也有一道同名護欄（默認 2），這裡保持一致、不額外收緊：真排爆了是角色的問題，
 * 不是鏈路該替它兜的。留在這裡是為了在打回時能給出一句人話，而不是讓上游拋 RangeError
 * 把整條 fire 弄失敗——那樣用戶連本來能收到的那條消息都沒了。
 */
export const MAX_FIRE_SCHEDULES = 2;

/**
 * 防穿幫策略的說明，前台工具和 fire 側共用這一份。
 *
 * 分界線不是「誰提的」，是「到點要說的是一件具體的事，還是只是想找話說」：
 * 想找話說的，用戶人回來了就該讓路；許過的具體承諾（不管是用戶要求的還是角色自己說的），
 * 用戶中途回來聊過天也不影響它該響。早先這段只寫了「用戶明確要求的鬧鐘」，把角色自己
 * 許下的承諾擋在外面了——「湯燉上了兩小時後叫你」會被判成該讓路，然後再沒人提起。
 */
export const EXPIRE_POLICY_DESCRIPTION = [
  '防穿幫策略。',
  'expire（默認，大多數情況用它）：到點時如果排程之後對話已有新進展、或用戶此刻正在聊天，這條自動作廢——之後你會在排程現狀裡看到，由你決定自然帶出、續期還是放棄。',
  '挑話題、想找人聊天這類「想說點什麼」的排程一律用它：用戶人都回來了，你還照著幾小時前的想法開口，會很假。',
  'force：不管用戶在不在聊天都照發。用在「到那個點必須說這件具體的事」上，兩種來源都算——用戶明確要求的（如"8點叫我起床"），以及你自己許下的（如"湯燉上了，兩小時後好了叫你""你那個會我到點提醒你"）。',
  '這類兌現的是一個具體承諾，用戶中途回來聊過天也不影響它該響。',
].join('\n');

/** fire 側的工具描述：比前台那份多兩句「你現在正在發消息」的語境。 */
const FIRE_TOOL_DESCRIPTION = [
  '給自己排下一條主動消息：到指定時間後你會再根據那時的上下文生成一條推送給用戶。',
  '你現在正在發一條主動消息，這個工具讓你把話接著往下說——比如這條先說一半，過一兩個小時再接上去；或者你說了要去做某件事，做完的時間點回來告訴用戶。',
  '排下的這條到點時會知道你這次說了什麼，能接得上，不用在參數裡複述。',
  'send_at 是開始生成的時間，不是送達時間（生成有十幾秒延遲），且必須至少比現在晚 1 分鐘。',
  `一次最多排 ${MAX_FIRE_SCHEDULES} 條；每個角色同時掛的任務也有上限，排不下時會告訴你。`,
  '沒有「接著說」的必要就別排——為了排而排出來的後續，用戶讀起來就是沒話找話。',
].join('\n');

export interface FireScheduleToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 工具聲明 / 說明塊的時間上下文：示例按「明天這個點」現算，參照系跟 fire_pack 走。 */
export interface FireScheduleTimeOpts {
  nowMs: number;
  tz: AmsgTzRef;
}

const buildParameters = (example: string) => ({
  type: 'object',
  properties: {
    send_at: {
      type: 'string',
      description: `開始生成的時間，寫你本地的牆鍾時間、不帶時區後綴（如 ${example}），系統按你所在的時區理解。至少比當前時間晚 1 分鐘。排之前先想想對方那邊是幾點——你們之間可能有時差，別把消息排到對方的深夜。`,
    },
    mode: {
      type: 'string',
      enum: ['auto', 'prompted'],
      description: '生成模式。auto=到點根據那時的上下文自由發揮；prompted=圍繞 prompt_hint 的方向說。默認 auto。',
    },
    prompt_hint: {
      type: 'string',
      description: '給未來那條消息的方向，如"接著剛才那隻貓的話往下說""告訴他湯燉好了"。mode=prompted 時必填。',
    },
    recurrence: {
      type: 'string',
      enum: ['none', 'daily', 'weekly'],
      description: '重複類型。none=一次性（默認）；daily/weekly=每天/每週同一時間。',
    },
    expire_policy: {
      type: 'string',
      enum: ['expire', 'force'],
      description: EXPIRE_POLICY_DESCRIPTION,
    },
  },
  required: ['send_at'],
});

export const buildFireScheduleTool = (opts: FireScheduleTimeOpts): FireScheduleToolDef => ({
  type: 'function',
  function: {
    name: AMSG_FIRE_SCHEDULE_TOOL,
    description: FIRE_TOOL_DESCRIPTION,
    parameters: buildParameters(
      buildSendAtExample(opts.nowMs, opts.tz),
    ) as unknown as Record<string, unknown>,
  },
});

/**
 * fire 側的取消 / 改期工具聲明。參數語義與前台同名工具一致（task_id 短 id、
 * send_at 裸牆鍾），描述按 fire 語境（「你正在發消息」）微調。
 */
export const buildFireCancelTool = (): FireScheduleToolDef => ({
  type: 'function',
  function: {
    name: AMSG_FIRE_CANCEL_TOOL,
    description: [
      '取消你掛著的一個定時主動消息任務（排程清單裡列的那些）。',
      '比如剛才排的事已經在這條消息裡說掉了、或者情況變了那條不該再響。',
      '多個任務並存時必須用 task_id（排程清單裡的短 id）指定；只有一個待觸發任務時可省略。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要取消的任務短 id（8 位，見排程清單）。' },
      },
    } as unknown as Record<string, unknown>,
  },
});

export const buildFireRenewTool = (opts: FireScheduleTimeOpts): FireScheduleToolDef => ({
  type: 'function',
  function: {
    name: AMSG_FIRE_RENEW_TOOL,
    description: [
      '給你掛著的一個任務改觸發時間：只換時間，沿用原有模式與提示方向。',
      '一次性任務 = 整條改到新時間（編號不變）；循環任務 = 只給這一次補發一條一次性任務，原來的每天/每週節奏不動。',
      '想改的是循環任務本身的時間、或者想說的內容方向已經變了，改用 cancel_active_message + schedule_active_message 重新創建。',
      `send_at 至少比現在晚 1 分鐘（寫你本地的牆鍾時間，如 ${buildSendAtExample(opts.nowMs, opts.tz)}，不帶時區後綴）。`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        send_at: { type: 'string', description: '新的觸發時間，寫你本地的牆鍾時間、不帶時區後綴。至少比現在晚 1 分鐘。' },
        task_id: { type: 'string', description: '要改期的任務短 id（8 位，見排程清單）。只有一個任務時可省略。' },
      },
      required: ['send_at'],
    } as unknown as Record<string, unknown>,
  },
});

/**
 * 拼進 prompt 的說明塊。
 *
 * native 模式只說「有這麼個能力、什麼時候用」——工具簽名已隨請求聲明，再教一遍正文語法
 * 反而勾引模型往正文裡寫（與 buildMcpFireBlock 同一個判斷）。text 模式（用戶的中轉拒
 * tools）才教語法。
 */
export const buildFireScheduleBlock = (mode: 'native' | 'text', opts: FireScheduleTimeOpts): string => {
  const howTo = mode === 'native'
    ? `需要時通過系統的工具調用接口發起 ${AMSG_FIRE_SCHEDULE_TOOL}，不要把工具名和參數寫進正文。`
    : `需要時單獨輸出一行 ${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"${
      buildSendAtExample(opts.nowMs, opts.tz)
    }","prompt_hint":"接著說"})（send_at 寫你本地的牆鍾時間，不帶時區後綴），系統會代為安排並把結果告訴你。`;
  return [
    '',
    '---',
    '【你可以給自己排下一條】',
    '這條消息發完，如果還有話要在之後某個時間點說（把沒說完的接上去、或者去做的事做完了回來告訴他），',
    '可以現在就把那一條排好——不需要用戶在線，到點會自動發出去，而且那時你會知道自己這次說了什麼。',
    howTo,
    // 角色在 prompt 裡只看得到自己那邊的鐘，很容易把「晚上聊兩句」排到對方的凌晨三點。
    // 對方那邊此刻幾點寫在【當前時刻補充】裡（有時差時才有那一行）。
    '定時間之前先想想對方那邊是幾點：你們之間可能有時差，別把消息排到對方的深夜。',
    '沒必要就別排。為了排而排出來的後續，讀起來就是沒話找話。',
  ].join('\n');
};

/**
 * 把「模式 + 提示方向」拼成寫進任務 metadata 的那句指令，worker 到點填進 prompt 的
 * 【本次任務】槽位。
 *
 * 住在這裡而不是 activeMsgClient：排程有兩條路（用戶在面板上排 / 角色自己排，後者還分
 * 前台工具和 fire 裡的工具），三條路必須寫出一模一樣的指令，不然同一個 mode 在不同入口
 * 生成出來的消息方向會不一樣。activeMsgClient 帶一堆瀏覽器依賴，worker 引不動。
 */
export const buildTaskInstruction = (mode: ActiveMsg2Mode, promptHint?: string): string => {
  if (mode === 'prompted') {
    return [
      '這是一條需要 AI 參與生成的主動消息。',
      '請嚴格圍繞下面的額外提示發起私聊，但仍然保持像真人一樣自然，不要像系統任務彙報。',
      `額外提示：${promptHint?.trim() || '無'}`,
    ].join('\n');
  }
  return [
    '這是一條需要 AI 自主生成的主動消息。',
    '請結合角色設定、關係狀態、最近上下文與當前時間，自然地主動找用戶說一到三句私聊消息。',
    promptHint?.trim() ? `可選靈感補充：${promptHint.trim()}` : '可選靈感補充：無',
  ].join('\n');
};

// ─── send_at 的時間參照系 ───
//
// 角色在 prompt 裡看到的鐘是自己時區的（fire_pack 的 tzId），它寫出來的 send_at
// 也是那個參照系的牆鍾。worker 跑在 UTC，直接 new Date('2026-08-01T09:00:00')
// 會按 UTC 解析——「明早 9 點」實際差整整一個時差。規則：
//   - 帶 Z / ±hh:mm 後綴的照舊按標註的時區解析（模型硬要寫也不算錯）；
//   - 裸 datetime 按 tz 參照系的牆鍾解析（tzId 走 Intl 逆解，禁手搓偏移）。

const pad2 = (n: number) => n.toString().padStart(2, '0');

/** send_at 串尾帶沒帶顯式時區（Z 或 ±hh:mm / ±hhmm）。 */
const hasExplicitOffset = (s: string): boolean => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());

/** ms 在 tz 參照系下的裸牆鍾 ISO（無時區後綴），工具描述裡的示例 / 打回文案用。 */
export const wallClockIso = (ms: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(ms, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:00`;
};

/** 給模型看的 send_at 示例：明天這個點的裸牆鍾——別再教它寫 +08:00 之類的 offset。 */
export const buildSendAtExample = (nowMs: number, tz: AmsgTzRef): string =>
  wallClockIso(nowMs + 24 * 3600_000, tz);

/** send_at 串 → epoch ms（解析不出 NaN）。規則見上面這段註釋。 */
export const resolveSendAtMs = (raw: string, tz: AmsgTzRef): number => {
  const text = raw.trim();
  if (hasExplicitOffset(text)) return new Date(text).getTime();
  return wallClockToTimestamp(text, tz.tzId);
};

// ─── 參數校驗 ───

export interface FireScheduleRequest {
  sendAt: string;
  mode: ActiveMsg2Mode;
  promptHint?: string;
  recurrence: ActiveMsg2Recurrence;
  expirePolicy: ActiveMsg2ExpirePolicy;
}

/** 校驗失敗時回給模型的形狀（與內置工具的失敗語義一致：ok:false + 一句能照做的話）。 */
export interface FireScheduleReject {
  ok: false;
  reason: string;
  message: string;
}

/** 上游要求至少提前 60 秒（cron 一分鐘一跳）。這裡留同樣的線，好在打回時說人話。 */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

const MODES: ActiveMsg2Mode[] = ['auto', 'prompted'];
const RECURRENCES: ActiveMsg2Recurrence[] = ['none', 'daily', 'weekly'];

/**
 * 把模型給的參數收成一份能用的請求，或者給出一句「你哪裡寫得不對、該怎麼改」。
 *
 * 一律不拋錯：這是模型寫出來的東西，寫歪很正常，回喂讓它改比讓整條 fire 失敗強得多
 * （fire 失敗 = 任務重跑 = 用戶這一次一個字都收不到）。
 *
 * tz 是角色的時間參照系（fire_pack 的 tzId）：裸 send_at 按它的牆鍾解析，
 * 打回文案裡的時間也用它說人話。
 */
export const parseFireScheduleArgs = (
  args: Record<string, unknown>,
  nowMs: number,
  tz: AmsgTzRef,
): FireScheduleRequest | FireScheduleReject => {
  const example = buildSendAtExample(nowMs, tz);
  const sendAtRaw = args?.send_at;
  if (typeof sendAtRaw !== 'string' || !sendAtRaw.trim()) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at 必填，寫你本地的牆鍾時間（如 ${example}）。` };
  }
  const sendAtMs = resolveSendAtMs(sendAtRaw, tz);
  if (!Number.isFinite(sendAtMs)) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at「${sendAtRaw}」解析不出時間，寫你本地的牆鍾時間（如 ${example}）。` };
  }
  if (sendAtMs < nowMs + MIN_SCHEDULE_LEAD_MS) {
    return {
      ok: false,
      reason: 'send_at_too_soon',
      message: `send_at 至少要比現在晚 1 分鐘（你那邊現在是 ${formatFireTimeShort(nowMs, tz)}）。想馬上說的話直接寫進這條消息裡，不用排。`,
    };
  }

  const mode = args?.mode == null ? 'auto' : args.mode;
  if (typeof mode !== 'string' || !MODES.includes(mode as ActiveMsg2Mode)) {
    return { ok: false, reason: 'invalid_mode', message: 'mode 只能是 auto 或 prompted。' };
  }
  const promptHintRaw = args?.prompt_hint;
  const promptHint = typeof promptHintRaw === 'string' ? promptHintRaw.trim() : '';
  if (mode === 'prompted' && !promptHint) {
    return { ok: false, reason: 'missing_prompt_hint', message: 'mode=prompted 時要給 prompt_hint，說清那條消息該往哪個方向說。' };
  }

  const recurrence = args?.recurrence == null ? 'none' : args.recurrence;
  if (typeof recurrence !== 'string' || !RECURRENCES.includes(recurrence as ActiveMsg2Recurrence)) {
    return { ok: false, reason: 'invalid_recurrence', message: 'recurrence 只能是 none / daily / weekly。' };
  }

  const expirePolicy = args?.expire_policy == null ? 'expire' : args.expire_policy;
  if (expirePolicy !== 'expire' && expirePolicy !== 'force') {
    return { ok: false, reason: 'invalid_expire_policy', message: 'expire_policy 只能是 expire 或 force。' };
  }

  return {
    sendAt: new Date(sendAtMs).toISOString(),
    mode: mode as ActiveMsg2Mode,
    ...(promptHint ? { promptHint } : {}),
    recurrence: recurrence as ActiveMsg2Recurrence,
    expirePolicy,
  };
};

// ─── 自排任務的 uuid ───

/**
 * 一個字符串的 32 位 FNV-1a 摘要（8 位十六進制）。純函數、無依賴，同樣的輸入永遠
 * 得到同樣的輸出——自排任務的 uuid 要靠這一點在 fire 重跑時對得上號。
 */
const fnv1a32Hex = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * 角色在 fire 裡給自己排下的那條任務的 uuid：`<8 位摘要>-amsgself-<charId>-<觸發時刻>-<序號>`。
 *
 * 摘要放在最前面是有意的：排程清單裡印給角色看的那個短 id 取的是 uuid 前 8 個字符
 * （amsg2Tasks.shortTaskId）。前 8 位要是寫死成 `amsgself`，同一次 fire 排下的兩條在
 * 清單裡就印成一模一樣的 `[amsgself]`，角色說「取消晚上那條」時隨便點一條都算命中，
 * 刪掉的很可能是早上那條，而且兩邊都以為成功了。
 *
 * 摘要只由 (charId, occurrenceMs, seq) 算出，不摻隨機數：fire 拋錯整條重跑時算出的是
 * 同一個 uuid，上游據此認出撞車、不會每重試一次多排一條。
 */
export const buildSelfScheduleUuid = (
  charId: string,
  occurrenceMs: number,
  seq: number,
): string =>
  `${fnv1a32Hex(`${charId}|${occurrenceMs}|${seq}`)}-amsgself-${charId}-${occurrenceMs}-${seq}`;

// ─── 取消 / 改期的目標解析（fire 側） ───

/** 這個 task_id 在清單裡命中了哪幾條：全 uuid 精確匹配優先，否則按短 id 收全部命中。 */
const matchTasksByTaskId = (
  tasks: ActiveMsg2TaskRecord[],
  taskId: string,
): ActiveMsg2TaskRecord[] => {
  const exact = tasks.find((t) => t.taskUuid === taskId);
  if (exact) return [exact];
  return tasks.filter((t) => shortTaskId(t.taskUuid) === taskId);
};

/** 打回文案裡指認一條任務用的時間：當前該盯的那一次觸發。 */
const describeTaskWhen = (
  task: ActiveMsg2TaskRecord,
  nowMs: number,
  tz: AmsgTzRef,
): string =>
  formatFireTimeShort(
    currentOccurrenceMs(task, nowMs) ?? new Date(task.firstSendTime).getTime(),
    tz,
  );

/**
 * 按 task_id（或「唯一即選」）從 fire 時刻的活任務清單裡解出目標。
 * 語義與前台 resolveTargetTask 對齊：短 id / 全 uuid 都認；不帶 task_id 時先按
 * fire 時刻復篩 pending（快照裡可能混著已過點變陳舊的一次性任務——pack 只在打包
 * 那一刻篩過一次），唯一 pending 就選它，沒有 pending 而清單恰好一條也選它。
 * 不對齊的話，同一句 cancel_active_message 本地能成、雲端卻被打回 ambiguous_task。
 * 找不到就回一句能照做的話（不拋錯，見 parseFireScheduleArgs）。
 *
 * 一個短 id 同時命中好幾條時**絕不靜默取第一條**：取消 / 改期是會真的動 D1 行的，
 * 猜錯了就是刪掉另一條任務，而角色和用戶都只會看到一句 ok。這種時候打回
 * ambiguous_task，並把候選連同各自的觸發時間和完整 task_id 一起報出去，
 * 角色下一輪帶完整 id 重來一次就能指準。
 */
export const resolveFireTargetTask = (
  tasks: ActiveMsg2TaskRecord[],
  taskIdArg: unknown,
  nowMs: number,
  tz: AmsgTzRef,
): { task: ActiveMsg2TaskRecord } | FireScheduleReject => {
  if (tasks.length === 0) {
    return { ok: false, reason: 'no_tasks', message: '你現在沒有掛著任何排程任務。' };
  }
  if (typeof taskIdArg === 'string' && taskIdArg.trim()) {
    const taskId = taskIdArg.trim();
    const hits = matchTasksByTaskId(tasks, taskId);
    if (hits.length === 1) return { task: hits[0] };
    if (hits.length === 0) {
      return { ok: false, reason: 'task_not_found', message: `沒有找到短 id 為 ${taskId} 的任務——短 id 在排程清單裡，照著那裡的寫。` };
    }
    const candidates = hits
      .map((t) => `${describeTaskWhen(t, nowMs, tz)} 那條的完整 id 是 ${t.taskUuid}`)
      .join('；');
    return {
      ok: false,
      reason: 'ambiguous_task',
      message: `短 id ${taskId} 同時對應 ${hits.length} 個任務，這麼寫會動錯人。`
        + `挑一個，把完整 id 填進 task_id 再來一次：${candidates}。`,
    };
  }
  const pending = tasks.filter((t) => isPendingTask(t, nowMs));
  if (pending.length === 1) return { task: pending[0] };
  if (pending.length === 0 && tasks.length === 1) return { task: tasks[0] };
  return { ok: false, reason: 'ambiguous_task', message: '你掛著不止一個任務，帶 task_id（排程清單裡的短 id）指定要動哪一個。' };
};

/** renew 的 send_at 校驗：與排程共用同一套解析（裸牆鍾按角色時區）和 60s 提前線。 */
export const parseFireRenewSendAt = (
  raw: unknown,
  nowMs: number,
  tz: AmsgTzRef,
): { sendAt: string } | FireScheduleReject => {
  const example = buildSendAtExample(nowMs, tz);
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at 必填，寫你本地的牆鍾時間（如 ${example}）。` };
  }
  const sendAtMs = resolveSendAtMs(raw, tz);
  if (!Number.isFinite(sendAtMs)) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at「${raw}」解析不出時間，寫你本地的牆鍾時間（如 ${example}）。` };
  }
  if (sendAtMs < nowMs + MIN_SCHEDULE_LEAD_MS) {
    return {
      ok: false,
      reason: 'send_at_too_soon',
      message: `send_at 至少要比現在晚 1 分鐘（你那邊現在是 ${formatFireTimeShort(nowMs, tz)}）。想馬上說的話直接寫進這條消息裡。`,
    };
  }
  return { sendAt: new Date(sendAtMs).toISOString() };
};

// ─── 正文協議兜底（用戶的中轉拒 tools 時） ───

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export interface FireScheduleTextCall {
  args: Record<string, unknown>;
  /** 原始匹配串，剝語法時用。 */
  matched: string;
}

/**
 * 從正文裡摳出 `schedule_active_message({...})` 形態的調用。
 *
 * 只認括號帶 JSON 這一種寫法——排程參數是結構化的（時間 + 方向 + 策略），MCP 那邊
 * 「行首 name: 值」的單參數形態在這裡表達不了，認了反而會把「我等下用
 * schedule_active_message: 提醒你」這種敘述當成真調用。
 */
export const extractFireScheduleTextCalls = (content: string): FireScheduleTextCall[] => {
  if (!content) return [];
  const re = new RegExp(`(^|[^\\w./])${escapeRegExp(AMSG_FIRE_SCHEDULE_TOOL)}\\s*\\(([^)]*)\\)`, 'g');
  const calls: FireScheduleTextCall[] = [];
  for (const m of content.matchAll(re)) {
    const matched = m[0].slice(m[1].length);
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse((m[2] || '').trim() || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch {
      // 參數寫壞了也算一次調用：交給 parseFireScheduleArgs 回一句「該怎麼寫」，
      // 比把這行當正文推給用戶強（用戶會看到一串工具語法）。
    }
    calls.push({ args, matched });
  }
  return calls;
};
