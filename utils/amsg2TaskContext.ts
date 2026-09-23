// utils/amsg2TaskContext.ts
/**
 * 排程現狀塊（防穿幫閘·下輪告知，瀏覽器側編排；純判定在 amsg2ExpireGuard）。
 *
 * useChatAI 每輪組請求時調 collectAmsg2TaskContext：
 *   1. 檢出該角色回看期內已作廢的排程（每任務獨立判定）→ 落台帳去重；
 *   2. 把「常駐能力簡介 + 進行中任務 + 未告知的回執」拼成一段 system 背景塊。
 * 回執有兩種來源：閘自動作廢（這裡檢出）、用戶在面板手動取消 / 關掉 2.0
 * （面板調 buildUserCancelledNotices 寫進同一本台帳）。
 * 常駐簡介總在（角色得隨時知道自己能給未來排消息），進行中/回執兩段有料才出現。
 * 發送成功後調 ActiveMsgStore.markExpiredNoticesNotified 標記，失敗下輪重注（回執不丟）。
 */

import { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord, CharacterProfile } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { DB } from './db';
import { resolveCharTimeZone } from './timezone';
import { detectExpiredOccurrences, hasDeliveredProactiveNear } from './amsg2ExpireGuard';
import {
  AMSG2_SCHEDULE_NOT_YET_NOTE, AMSG2_SCHEDULE_SECRECY_NOTE, canExpire, currentOccurrenceMs, describeExpirePolicy,
  describeRecurrence, describeTaskMode, formatTaskTime, getPendingTasks, isPendingTask,
  shortTaskId,
} from './amsg2Tasks';

/**
 * 排程現狀塊回看多久內的觸發時刻。
 *
 * 必須**明確短於**作廢回執台帳的 TTL（48h）：兩者一樣長的話，邊界那天的觸發會在台帳
 * 剛清掉它的下一輪被重新檢出，同一件事再給角色說一遍。40h 留出的這 8 小時就是給
 * 「清帳」和「重檢」拉開距離用的。
 */
export const AMSG2_TASK_LOOKBACK_MS = 40 * 3600_000;

/** 每次向 DB 要多少條歷史；不夠覆蓋回看期就翻倍再要一次。 */
const MESSAGE_PAGE_SIZE = 200;
/** 單輪檢出最多讀這麼多條，兜住「一天幾千條」的極端聊天量。 */
const MESSAGE_FETCH_LIMIT = 2000;

/**
 * 取夠「覆蓋整個回看期」的近史。
 *
 * 按條數取是不行的：重度用戶 48 小時能聊出好幾百條，固定 200 條窗口會把已送達的
 * 那條主動消息擠到窗外——檢出側看不到送達證據，就把一條**已經發出去**的觸發判成
 * 作廢，角色於是把發過的事再來一遍。DB 只提供「最近 N 條」，所以這裡按需翻倍地要，
 * 直到最老一條早於回看起點（窗口蓋住了）或歷史見底為止。
 */
const loadMessagesCoveringLookback = async (charId: string, sinceMs: number) => {
  let limit = MESSAGE_PAGE_SIZE;
  let messages = await DB.getRecentMessagesByCharId(charId, limit);
  while (
    messages.length >= limit               // 要多少給多少 = 後面可能還有
    && limit < MESSAGE_FETCH_LIMIT
    && (messages[0]?.timestamp ?? 0) > sinceMs   // 最老一條還沒退到回看起點之前
  ) {
    limit = Math.min(limit * 2, MESSAGE_FETCH_LIMIT);
    messages = await DB.getRecentMessagesByCharId(charId, limit);
  }
  return messages;
};

/**
 * 用戶在面板裡手動取消任務 / 關掉 2.0 時，給角色留的交代。
 *
 * 不留的話，聊天裡那句「明早八點叫你～」就永遠停在承諾狀態：任務其實早沒了，角色
 * 下次還接著說「放心我叫你」。所以手動取消也走作廢回執那條路，角色下一輪就知道黃了。
 * 只給「還會響」的任務寫——已經發過的一次性任務沒有承諾可撤，寫了純屬噪音。
 */
export function buildUserCancelledNotices(
  charId: string,
  tasks: ActiveMsg2TaskRecord[],
  nowMs: number = Date.now(),
): Amsg2ExpiredNoticeRecord[] {
  return tasks
    .filter((t) => isPendingTask(t, nowMs))
    .map((t) => ({
      // 編號跟作廢回執分開：同一條任務可能先攢了一次作廢、之後才被手動取消，兩件事都得說。
      // 同一條任務重複取消只會命中同一個 id，台帳按 id 去重，天然冪等。
      id: `${t.taskUuid}:cancelled`,
      charId,
      occurrenceMs: currentOccurrenceMs(t, nowMs) ?? new Date(t.firstSendTime).getTime(),
      mode: t.mode,
      promptHint: t.promptHint,
      recurrenceType: t.recurrenceType,
      kind: 'user-cancelled' as const,
      createdAt: nowMs,
    }));
}

/**
 * 常駐能力簡介：平時聊天時就讓角色把「未來會再想起對方」當成自己的念頭。
 *
 * 只靠 schedule_active_message 的工具 description，角色基本只在用戶明說「八點叫我」
 * 時才想起排程；「聊著聊著自己想到給稍後排一條」得有人在正文裡先說一聲——fire 側的
 * 【你可以給自己排下一條】（amsgFireSchedule.buildFireScheduleBlock）就是同一件事
 * 在到點側的那半，這裡補的是平時聊天這半。判斷口徑：聯繫來自未來那個自己的
 * 真實念頭，內容不只圍著對方、也從自己的日程和生活里長出來；嘴上許了就排成真任務，
 * 人設優先不硬排，也尊重「別打擾」。語法不在這裡教：工具簽名已隨請求聲明，
 * 正文再教一遍反而勾引模型往正文裡寫（與 fire 側 native 模式同一個判斷）。
 */
const buildAmsg2ChatScheduleBrief = (targetName?: string): string => {
  const target = targetName?.trim() || '對方';
  return [
    `你和${target}的聯繫不只發生在正在聊天的時候。你就是那個在各自生活繼續往前時，仍會再次想起${target}的人。當你能預見：到了未來某個時刻，你會因為惦記、想分享、兌現承諾，或自己的生活有了新進展而自然想聯繫${target}，就用 schedule_active_message 把那次聯繫排下來。到點後你會帶著最新上下文，以那一刻的自己重新開口，不是照著預寫台詞完成提醒。`,
    `- ${target}接下來顧不上手機時——睡覺、上課、上班、打遊戲、洗澡、出門，或任何你瞭解的原因——你可以在途中想到ta，也可以估著ta回來時再聯繫。`,
    `- 內容不必總圍著${target}轉。結合剛才的聊天氛圍、你自己的日程和正在經歷的事、剛看到的細節和突然冒出的後續念頭；分享自己的生活，往往比機械問候更像你。`,
    '- 「到點叫你」「等你忙完跟你說」「回頭告訴你結果」這類話一說出口，就當場排成真任務，不要只在正文裡答應；沒排成，就別把承諾說死。',
    `- 只問自己：那個時刻的你會真的想聯繫${target}嗎？會就排；只是隨口一想、到時候未必真有話說的，就算了。也別為了顯得貼心硬排。`,
    `- 時間貼著${target}的生活估；一局遊戲和睡到天亮不是一個時長，有時差就按ta那邊的鐘算。`,
    `- ${target}明確說別打擾時就安靜等；已經排著相近的一條，也別重複排。`,
  ].join('\n');
};

/** 回執條目那一行（自動作廢和手動取消長一個樣，只是所在的段落不同）。 */
const describeNoticeLine = (r: Amsg2ExpiredNoticeRecord, charTz: string | undefined): string => {
  const recurrence = r.recurrenceType === 'daily' ? '（每日循環的當次）'
    : r.recurrenceType === 'weekly' ? '（每週循環的當次）' : '';
  return `- [${shortTaskId(r.id)}] 原定 ${formatTaskTime(r.occurrenceMs, charTz)}，${describeTaskMode(r)}${recurrence}`;
};

/**
 * 回執的兩個段落（閘自動作廢 / 用戶手動取消）。給角色的交代完全不同（前者可以續期
 * 補上，後者是用戶不要了），分成兩段說；沒有 kind 的老記錄按自動作廢處理。
 * 完整排程現狀塊和「回執單獨成塊」（即時對話雲端路徑）共用這一份文案。
 */
const buildNoticeSections = (
  expired: Amsg2ExpiredNoticeRecord[],
  charTz: string | undefined,
): string[] => {
  const parts: string[] = [];
  const autoExpired = expired.filter((r) => r.kind !== 'user-cancelled');
  const userCancelled = expired.filter((r) => r.kind === 'user-cancelled');

  if (autoExpired.length) {
    parts.push('已作廢（到點時對話正在進行，為避免撞車自動取消）：');
    for (const r of autoExpired) {
      parts.push(describeNoticeLine(r, charTz));
    }
    parts.push([
      '作廢條目的處理由你判斷，三選一：',
      '1. 就地消化：只在當前時間與話題都合適時自然帶進對話——先想「現在提這個還合不合適」（早安任務拖到晚上就別再道早安），不要因為看到這份回執就強行轉移當前話題。',
      '2. 續期：還想之後專門說，用 renew_active_message 換個時間（循環任務續期只補當次，原來的節奏照舊）；內容或方向變了，改用 cancel_active_message + schedule_active_message 重新創建。',
      '3. 放棄：已經沒意義就隻字不提。',
    ].join('\n'));
  }

  if (userCancelled.length) {
    parts.push('已被手動取消：');
    for (const r of userCancelled) {
      parts.push(describeNoticeLine(r, charTz));
    }
    parts.push('這幾條是用戶直接取消的，相關約定不再生效，自然接受即可、不必向用戶求證，也別再拿它們許諾。還想在別的時間說的話，用 schedule_active_message 重新排一條。');
  }

  return parts;
};

/**
 * 作廢回執單獨成塊（即時對話雲端路徑用）。
 *
 * 雲端到點會自己渲染排程清單和「給自己排下一條」（instant timely block），chat 段裡
 * 只欠回執這一樣——所以這裡不帶常駐簡介、不帶進行中清單，避免和到點渲染的那份撞車。
 * 沒有回執時返回 null，整塊不出現（與本地「有料才出現」同一個做法）。
 */
export function buildAmsg2NoticesText(
  expired: Amsg2ExpiredNoticeRecord[],
  charTz: string | undefined,
  targetName?: string,
): string | null {
  if (!expired.length) return null;
  const target = targetName?.trim() || '對方';
  return [
    '【你的主動消息排程·僅你可見】',
    ...buildNoticeSections(expired, charTz),
    AMSG2_SCHEDULE_SECRECY_NOTE.replace('用戶', target),
  ].join('\n');
}

/** 純拼文案，方便單測。常駐簡介總在，進行中/回執兩段有料才各自出現。 */
export function buildAmsg2TaskContextText(
  pending: ActiveMsg2TaskRecord[],
  expired: Amsg2ExpiredNoticeRecord[],
  nowMs: number = Date.now(),
  /**
   * 角色的時間參照系（沒開自定義時區時為 undefined，跟著設備走）。
   * 位置參數不設默認值：這一段是給角色看的，調用方必須顯式想過時間該按誰的鐘寫。
   */
  charTz: string | undefined,
  /**
   * 本輪工具循環裡剛排出來的任務 uuid。
   *
   * 工具循環第二輪起這份清單是現算的，裡面混著「本來就有的」和「角色剛排的」。不點名
   * 的話角色分不清，容易當成別人排的、再排一條一樣的——現場那次「一句『等會找我』排出
   * 5 條」就有這一份。空集合等於沒傳：首輪那份是排程前的快照，不該憑空長出提醒。
   */
  createdThisTurn?: ReadonlySet<string>,
  /** ChatApp 當前用戶名；空值回退為「對方」。 */
  targetName?: string,
  /** 「用戶給你定的規矩」（amsgLimits.buildLimitsBrief），緊跟常駐簡介。 */
  limitsBrief?: string,
): string {
  const target = targetName?.trim() || '對方';
  const isNewThisTurn = (taskUuid: string) => !!createdThisTurn?.has(taskUuid);
  const hasNewThisTurn = pending.some((t) => isNewThisTurn(t.taskUuid));
  const parts: string[] = ['【你的主動消息排程·僅你可見】', buildAmsg2ChatScheduleBrief(target)];
  if (limitsBrief) parts.push(limitsBrief);

  if (pending.length) {
    parts.push('進行中：');
    for (const t of pending) {
      // 循環任務寫「下一次」的時間。寫 firstSendTime 的話，一條每天的任務在角色眼裡
      // 是個好幾天前的時刻，它會當成已經過去的排程，然後在對話裡說漏嘴或重複排一條。
      const occurrenceMs = currentOccurrenceMs(t, nowMs);
      parts.push(`- [${shortTaskId(t.taskUuid)}] ${formatTaskTime(occurrenceMs ?? t.firstSendTime, charTz)} ${describeRecurrence(t.recurrenceType)}`
        + ` · ${describeTaskMode(t)} · ${describeExpirePolicy(t.expirePolicy)}`
        + (isNewThisTurn(t.taskUuid) ? ' · 本輪剛排的' : ''));
    }
    parts.push('（想調整就用 schedule/cancel/renew 工具；內容方向變了用 cancel + schedule 重建。'
      + (hasNewThisTurn ? '標著「本輪剛排的」是你這次回覆裡已經排好的，別再排一條一樣的。' : '')
      + '）');
    // 只在有任務時說：一條都沒排的時候沒有可催的事，白佔一行還提醒模型「催」這件事存在。
    parts.push(AMSG2_SCHEDULE_NOT_YET_NOTE);
  }

  parts.push(...buildNoticeSections(expired, charTz));

  // 約束放在塊尾，管住上面每一種形態。掛在某一段裡的話，只有進行中任務的那次就是裸奔的：
  // 短 id、「遇忙作廢」這些系統腔會被角色當成可以複述的內容念出來。
  parts.push(AMSG2_SCHEDULE_SECRECY_NOTE.replace('用戶', target));

  return parts.join('\n');
}

/**
 * 把排程塊插進本輪要發的消息數組：緊挨易變尾段**之前**，而不是貼數組尾巴。
 *
 * 「回到你自己」鋼印焊在 volatileTail 末尾，靠 recency 搶模型開口前的最後一眼
 * （chatRequestPayload 的 volatileTailIndex 就是給這種塊定位用的）。這一塊貼在它後面
 * 的那陣子，模型最後讀到的是一份帶 promptHint 原文的待辦清單，於是把排在今晚的任務
 * 當成本輪就該辦的事——用戶側的表現是「說了今天要看書，之後每輪結尾都問看到哪了」。
 *
 * 插入點落在本輪用戶消息之後，而前綴緩存的斷點比它更靠前，所以命中率一個 token 都不動。
 * volatileTailIndex 為 -1（prompt build 跳過 / dev 的 system 合併開關）時退回貼尾：
 * 位置不理想，但塊本身不能丟——角色得知道自己名下有哪些任務，否則會重複排。
 */
export function insertAmsg2TaskContextBlock<T>(
  messages: T[],
  block: T,
  volatileTailIndex: number,
): T[] {
  if (volatileTailIndex < 0 || volatileTailIndex > messages.length) return [...messages, block];
  return [...messages.slice(0, volatileTailIndex), block, ...messages.slice(volatileTailIndex)];
}

export interface Amsg2TaskContextResult {
  text: string;
  /** 本輪注入的回執 id（閘作廢的 + 用戶手動取消的），發送成功後 markExpiredNoticesNotified。 */
  expiredIds: string[];
  /**
   * 本輪要告知的回執原始記錄。
   *
   * 工具循環裡每發一次請求都要按最新任務清單重渲染這一塊，但回執這半邊是「檢出 + 落台帳」
   * 的結果、帶副作用，一輪只該算一次。把記錄交出去，後續輪次直接拿它配上新的 pending 調
   * buildAmsg2TaskContextText 就行，不用再碰 DB 和台帳。
   */
  notices: Amsg2ExpiredNoticeRecord[];
}

export async function collectAmsg2TaskContext(
  char: CharacterProfile,
  targetName?: string,
): Promise<Amsg2TaskContextResult> {
  const config = char.activeMsg2Config;
  const tasks = config?.tasks ?? [];
  const now = Date.now();

  // 逐任務檢出作廢（AI 任務且 expire 策略才判；force / fixed 不作廢）。
  if (config?.enabled && tasks.length) {
    // 取夠整個回看期的歷史再判：證據（那條已送達的主動消息）落在窗外的話，
    // 檢出側會把一條發過的觸發當成作廢，角色接著把同一件事再說一遍。
    const messages = await loadMessagesCoveringLookback(char.id, now - AMSG2_TASK_LOOKBACK_MS);
    const candidates = tasks
      .filter(canExpire)
      .flatMap((t) => detectExpiredOccurrences({
        taskUuid: t.taskUuid,
        policy: t.expirePolicy,
        recurrenceType: t.recurrenceType,
        firstSendTime: t.firstSendTime,
        messages,
        nowMs: now,
        lookbackMs: AMSG2_TASK_LOOKBACK_MS,
      }).filter((c) => !hasDeliveredProactiveNear(messages, c.occurrenceMs, t.clientTaskId))
        .map((c) => ({
          id: c.id, charId: char.id, occurrenceMs: c.occurrenceMs,
          mode: t.mode, promptHint: t.promptHint, recurrenceType: t.recurrenceType,
          kind: 'expired', createdAt: now,
        } satisfies Amsg2ExpiredNoticeRecord)));
    if (candidates.length) await ActiveMsgStore.upsertExpiredNotices(char.id, candidates);
  }

  const unnotified = (await ActiveMsgStore.getExpiredNotices(char.id)).filter((r) => !r.notifiedAt);
  const pending = getPendingTasks(config, now);
  return {
    // 時間按角色的鐘寫：這一段是給角色看的，到點 worker 渲染的那份也是角色時區，
    // 兩邊對不上的話，紐約角色會在同一輪裡讀到差一個時差的兩個「同一條任務」。
    text: buildAmsg2TaskContextText(
      pending, unnotified, now, resolveCharTimeZone(char), undefined, targetName,
    ),
    expiredIds: unnotified.map((r) => r.id),
    notices: unnotified,
  };
}
