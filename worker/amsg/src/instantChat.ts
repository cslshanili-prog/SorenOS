/**
 * 即時對話（instant chat）：把「用戶按下發送」這一輪聊天當成一條立刻執行的任務。
 *
 * 客戶端只發一個請求就自由了——切後台、殺進程都行，生成在這台 worker 裡跑完，
 * 結果走 Web Push 回去。這份模塊管三件事：
 *   1. `POST /instant-chat` 這條包裝層路由（鑑權 → 內部轉發 → 202 → 立刻起一跳）
 *   2. 即時對話那條 fire 用的「時效信息」塊（當前時間 / 實時世界 / 排程說明拼一起）
 *   3. 推送的通知策略（前台可見時不彈橫幅）
 *
 * 為什麼要在包裝層做而不是讓客戶端直接調上游的兩個端點：兩步有嚴格的先後和
 * 「前面失敗就不能落任務」的語義（雲端狀態沒傳上去，到點的 fire 讀到的還是上一輪的
 * 上下文，角色會對著舊對話回話）。放在客戶端串兩個請求的話，中間斷網就會留下一條
 * 註定答錯的任務；放在這裡，客戶端只有一次「成了 / 沒成」。
 *
 * 加密由客戶端做完，這裡只搬運：兩個信封原樣轉發給上游，上游照常解密和鑑權，
 * 它仍然是權威。包裝層不碰用戶密鑰，也解不開這兩個信封。
 *
 * 零瀏覽器依賴（這份代碼會被打進 worker bundle）。
 */

import {
  AMSG_FIRE_PACK_KEY,
  amsgStateNamespace,
  buildUserClockHint,
  formatFireTimeFull,
  type AmsgTzRef,
} from '../../../utils/amsgFirePack';
import { TIME_FRAMING_CONVERSATIONAL } from '../../../utils/timeFramingNote';

// ─── 時間參數 ───

/**
 * 即時對話這條 fire 的總時長上限（毫秒），由 onBeforeFire 單條返回、只對即時對話生效。
 *
 * 定時任務那條路仍用庫默認的 240s：它到點沒跑完還有下一分鐘的 cron 接著來，
 * 而用戶正盯著「正在輸入…」等回覆，多給點時間跑完工具循環比讓他重發一遍強。
 * 上限壓在執行它的那次 invocation 的牆鍾預算（DO alarm 和 cron 都是 15 分鐘）之內。
 */
export const INSTANT_TOTAL_TIMEOUT_MS = 600_000;

// ─── 任務身份 ───

/** 任務 metadata 裡標即時對話的那個鍵（客戶端排任務時寫、worker 到點讀）。 */
export const AMSG_INSTANT_CHAT_FLAG = 'amsgInstantChat';

/** 這條任務是不是即時對話（客戶端剛發完消息在等回覆）。 */
export const isInstantChatTask = (metadata: Record<string, unknown> | undefined | null): boolean =>
  !!metadata && metadata[AMSG_INSTANT_CHAT_FLAG] === true;

// ─── fire 時追加的「時效信息」塊 ───

/**
 * 即時對話的請求消息 = 客戶端打包的那串對話原樣 + 末尾追加這一塊。
 *
 * 追加而不是重渲染模板：這一輪要答的是用戶剛說的話，本地生成那條路發出去的是什麼，
 * 雲端就該發一模一樣的，不然同一句話在兩條路上會得到兩種口吻。時效內容（現在幾點、
 * 外面在下雨、還掛著哪些排程）只有到點才知道，所以留到這裡補。
 *
 * blocks 裡的每一塊自帶前導空行 / 分隔線（各自的渲染函數已經處理），空串直接跳過。
 */
export const buildInstantTimelyBlock = (args: {
  nowMs: number;
  tz: AmsgTzRef;
  userTzId: string;
  targetName: string;
  /**
   * 角色的「時間感知」開關（tool_pack.timeAwarenessEnabled）。關掉的角色在前台連今天
   * 幾號都讀不到，雲端這條路也一個鐘都不給——兩條路是同一個開關，不能各行其是。
   * 主動消息那條路的做法一樣（打包時時間行整段不進模板，見 activeMsgClient 的 timeAware）。
   */
  timeAwarenessEnabled: boolean;
  /** 其餘按順序拼上去的塊：實時世界、自述日誌、排程清單、MCP、給自己排下一條。 */
  blocks: string[];
}): string => {
  const blocks = args.blocks.filter((block) => block.trim());
  // 關了時間感知、其餘幾塊又都是空的（沒日程沒排程沒 MCP、實時世界也沒拉到）——
  // 這一塊就沒有任何內容可說了，整塊不要。空塊整塊跳過是這裡一貫的做法，只剩一行
  // 光禿禿的標題掛在對話末尾，模型只會當成沒說完的亂碼。
  if (!args.timeAwarenessEnabled && blocks.length === 0) return '';
  const head = args.timeAwarenessEnabled
    ? [
        '【此刻的系統信息·僅你可見】',
        `現在是 ${formatFireTimeFull(args.nowMs, args.tz)}。`,
        // 報時後面跟那句語境框定，跟前台聊天引的是同一份常量。這一輪是用戶剛按下發送、
        // 正等著回覆，所以「對方還在跟你說話」是真的；少了它，深夜的那行鍾就夠讓角色
        // 每輪都往「快睡吧、明天見」上收——本地那條路修好了、雲端沒修的話，同一個角色
        // 在兩條路上的分寸會不一樣。
        TIME_FRAMING_CONVERSATIONAL,
        // buildUserClockHint 自帶前導換行，沒時差時返回空串。
        buildUserClockHint(args.nowMs, args.tz, { tzId: args.userTzId }, args.targetName),
      ].join('\n')
    : '【此刻的系統信息·僅你可見】';
  return [head, ...blocks].join('\n');
};

// ─── 通知策略 ───

/**
 * 推了就一定彈（SW 的 shouldRenderNotification 認這個值）。
 *
 * 訂閱是按 `userVisibleOnly: true` 建的，等於跟瀏覽器約好每條 push 都給用戶一次可見
 * 反饋；收了 push 卻不彈是違約，Firefox 按配額把訂閱退掉，iOS 過了新訂閱那幾天寬限期
 * 一條就吊銷，而且兩邊都是靜默發生的——服務端只看得到後續推送返回 410。所以口徑只有
 * 兩檔：要推就一定彈，不想彈就壓根別推（內容落服務端收件箱，等客戶端上線補拉）。
 * 即時對話是用戶按下發送、正盯著「正在輸入…」等的那一輪，必須推，於是選「一定彈」。
 */
const NOTIFICATION_ALWAYS = 'always';

/**
 * 靜音只在用戶看得見頁面的那一刻生效（SW 的 resolveNotificationSilent 認這個值）。
 *
 * 用戶正盯著聊天窗口時頁面自己會把回覆畫上屏，橫幅再響一聲純屬打擾；切後台、鎖屏、
 * 關了標籤頁的那一刻則必須響，不然沒人來叫他。判定得等到 SW 收到這條 push 才做——
 * worker 在發推那一刻並不知道用戶此刻在不在前台，寫死 `silent: true` 的結果是切後台
 * 也不響。
 *
 * 老 SW 不認這個字符串，會按 `Boolean('when-visible')` 算成恆靜音，也就是退回這檔
 * 能力上線之前的行為，不會彈錯也不會漏彈。
 */
export const NOTIFICATION_SILENT_WHEN_VISIBLE = 'when-visible';

/**
 * 通知欄摺疊用的 tag：同一個角色永遠只留最新那一條。
 *
 * 一次回覆常常分成好幾段推，逐條彈會把通知欄刷滿；同 tag 的通知互相覆蓋，看到的就只有
 * 最新一條。即時對話的失敗通知也用這個 tag（見 index.ts 的 sendInstantErrorPush）：
 * 同一個角色的最新狀態本來就只該留一條，成功的回覆把之前那條「沒能生成」蓋掉正合適。
 */
export const instantNotificationTag = (charId: string) => `amsg-instant-${charId}`;

/**
 * 給即時對話的推送載荷表態通知策略：一定彈，按角色摺疊，前台安靜、後台叫人。
 *
 * 打擾不靠「不彈」來壓，靠另外三個字段：
 *   - `tag`      同一個角色只在通知欄留最新一條；
 *   - `silent`   `when-visible`，用戶看著頁面時不響，切後台就照常響鈴震動；
 *   - `renotify` 只給這一輪的第一段。同 tag 的通知默認是靜默替換，上一輪的橫幅還
 *                躺在通知欄沒點掉時，新一輪的第一段就會被當成替換而不出聲——那正是
 *                用戶會說「有時候響有時候不響」的那種情況。一輪響一聲：第一段重新
 *                提醒，後面幾段安靜地把內容更新掉。
 *
 * 只給即時對話用——主動消息是「到點找人說話」，那條路要響鈴叫人，既不折疊也不靜音。
 *
 * 載荷本來就沒有 notification 時不憑空造一個：SW 拿不到 title / body 只能彈一條空白
 * 橫幅，而「沒有 notification」這件事本身在 SW 那邊有按 messageKind 的默認行為，
 * 替它做主只會把默認行為弄壞。
 *
 * 信封的其餘部分（messageId / sessionId / 時間戳 / 段號 / 任務身份）一律交給庫去補——
 * 客戶端補收現在讀的是服務端帳本，帳本里的那份就是庫發出去的那份，沒有第二處需要
 * 逐字對齊的副本了。
 */
export const applyInstantNotificationPolicy = (
  payload: Record<string, unknown>,
  charId?: string | null,
  isFirstSegment = false,
): Record<string, unknown> => {
  const notification = payload.notification;
  const hasNotification = !!notification && typeof notification === 'object' && !Array.isArray(notification);
  if (!hasNotification) return payload;
  const meta = payload.metadata;
  const metaCharId = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).charId
    : undefined;
  const target = charId || (typeof metaCharId === 'string' ? metaCharId : '');
  return {
    ...payload,
    notification: {
      ...(notification as Record<string, unknown>),
      show: NOTIFICATION_ALWAYS,
      silent: NOTIFICATION_SILENT_WHEN_VISIBLE,
      // 認不出是哪個角色時就不折疊：通知欄裡多幾條只是吵，兩個角色共用一個 tag 會
      // 互相頂掉，那是真的丟消息。renotify 跟著 tag 走——沒有 tag 時帶上它，
      // showNotification 會直接拋 TypeError。
      ...(target
        ? { tag: instantNotificationTag(target), ...(isFirstSegment ? { renotify: true } : {}) }
        : {}),
    },
  };
};

// ─── POST /instant-chat ───

/**
 * 上游 worker 裡這條路用得到的入口（注入進來只為單測能替身）。
 *
 * 只有 fetch：這條路做的是「轉發兩個加密信封」，跑任務是 DO 那邊的事
 * （`upstream.runTask`，見 index.ts 的 InstantTickDO）。
 */
export interface InstantChatUpstream {
  fetch(request: Request, env: unknown): Promise<Response>;
}

/**
 * 起跳用的 Durable Object namespace binding（`INSTANT_TICK`）。
 *
 * 只聲明這裡真正會調的兩個方法：包裝層不需要完整的 DO 類型，單測也就能拿個字面量當替身。
 */
export interface InstantTickNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { kick(uuid: string): Promise<unknown> };
}

interface InstantChatEnv {
  AMSG_SERVER_TOKEN?: string;
  /** 沒有它就沒法起跳；老版本 Worker 上是 undefined，見 kickInstantTick。 */
  INSTANT_TICK?: InstantTickNamespace;
}

export type InstantTickKickResult =
  | { ok: true }
  | { ok: false; reason: 'missing-binding' }
  | { ok: false; reason: 'kick-failed'; error: unknown };

/**
 * 叫醒 DO，讓它把剛落庫的這條立刻撿走。
 *
 * 這一跳過去掛在 `ctx.waitUntil` 上，而那個只有 30 秒——響應發出（或客戶端斷開）
 * 之後就開始倒計時，一輪帶工具循環的生成必被砍在半路，日誌裡只留一條
 * 「waitUntil() tasks did not complete」。DO 的 alarm 是獨立 invocation，
 * 拿滿 15 分鐘牆鍾，跟這個已經回了 202 的請求徹底脫鉤，才對得上
 * INSTANT_TOTAL_TIMEOUT_MS 一直以來的設計意圖。
 *
 * **一條任務一個 DO 實例**（實例名就是任務 uuid）：每個實例只跑自己那一條
 * （`upstream.runTask(uuid)`），所以幾條聊天同時在跑也互不排隊、更不會重複生成。
 * 這依賴上游 2.6.0-next.16 起的 runTask——在那之前只有「掃一遍所有到期任務」，
 * 多實例併發掃同一批會各生成一次，只能退回單實例串行。
 *
 * 兩種失敗分開報，因為要用戶做的事完全不同：binding 壓根不在 = Worker 是舊的，
 * 得去更新；叫醒失敗 = 臨時故障，任務已經在庫裡，下一分鐘的 cron 會撿。
 */
export const kickInstantTick = async (env: unknown, uuid: string): Promise<InstantTickKickResult> => {
  const namespace = (env as InstantChatEnv | null | undefined)?.INSTANT_TICK;
  if (!namespace || typeof namespace.get !== 'function' || typeof namespace.idFromName !== 'function') {
    return { ok: false, reason: 'missing-binding' };
  }
  try {
    await namespace.get(namespace.idFromName(uuid)).kick(uuid);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'kick-failed', error };
  }
};

/** 上游的 UUID v4 判定（照抄它的正則，前端拿同一個 X-User-Id 跑兩邊）。 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 常時比較（照抄上游 constantTimeEqual 的做法）：兩邊各做一次隨機密鑰的 HMAC 再逐字節比，
 * 長度和內容都不會從耗時上漏出來。
 */
export const constantTimeEqual = async (a: string, b: string): Promise<boolean> => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const da = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= da[i] ^ db[i];
  return diff === 0;
};

// ─── 上游那句「服務器內部錯誤」背後到底出了什麼事 ───

/**
 * 從上游的錯誤響應體裡取出真實原因，拼成一行給用戶看的話。
 *
 * 上游 catch 到異常後回的是一句寫死的「服務器內部錯誤」，光憑它用戶既不知道哪兒壞了、
 * 也不知道該點哪裡。真因（`D1_ERROR: no such table: message_outbox`、
 * `D1 DB storage operation exceeded timeout` 之類）由 amsg-server 2.6.0-next.16 起
 * 放在 `error.cause` 裡一併回來，取出來原樣端到用戶面前。
 *
 * 只在 5xx 上取：4xx 是「你請求不對」，上游的 message 本身就說清楚了，再綴一段
 * 內部細節只會讓人更迷惑。
 *
 * 拼進 `upstreamLog` 而不是新起一個字段：這條鏈路的消費方（activeMsgClient 組裝
 * 用戶可見報錯時）讀的就是它。
 */
const readUpstreamCause = (status: number, body: unknown): string | null => {
  if (status < 500) return null;
  const cause = (body as { error?: { cause?: { name?: unknown; message?: unknown; code?: unknown } } } | null)
    ?.error?.cause;
  if (!cause) return null;
  const name = typeof cause.name === 'string' ? cause.name : '';
  const message = typeof cause.message === 'string' ? cause.message : '';
  const code = typeof cause.code === 'string' ? cause.code : '';
  // 前綴只在能多說明一點事情的時候才加：
  //   code 常常就是 message 的開頭（`D1_ERROR: no such table …`），再綴一遍是噪音；
  //   沒有 code 時退回 name，但光禿禿的 'Error' 誰都知道，不如不寫。
  const head = code
    ? (message.startsWith(code) ? '' : code)
    : (name && name !== 'Error' ? name : '');
  return [head, message].filter(Boolean).join(': ') || null;
};

// ─── 雲端狀態那一步的重試 ───

/**
 * `PUT /client-state` 每次重試前等多久（數組長度即總嘗試次數，首次不等）。
 *
 * 為什麼這一步要重試：D1 偶爾會把一次寫直接判超時（`D1 DB storage operation exceeded
 * timeout which caused object to be reset`），這一步又是整條鏈上最大的一次寫（三十多 KB
 * 的 fire_pack），撞上的機會最多。用戶側的表現是好端端一句話發不出去，還得自己重發。
 *
 * 什麼時候會來，2026-08-09 查過一次，沒找出規律。兩次失敗都是「隔了幾小時的第一句話」，
 * 看著像庫涼了，但當時量到的兩個數都不支持這個說法：
 *
 *   1. 庫那會兒不涼。cron 是 `* * * * *`，每一跳都在查 D1。失敗發生在 00:50:07，
 *      而 00:49:57 那一跳**剛查過庫，隔了 10 秒**。
 *   2. 也不像是包太大。失敗那輪的 fire_pack 是 34 KB，當天 09:13 成功那輪反而是 36 KB。
 *
 * 就這兩個數看，「提前讀一下把庫焐熱」沒有著力點，所以先按瞬時錯誤處理、當場重試。樣本只有
 * 兩次，D1 那邊的行為以後也可能變——要是以後又出現「隔久了必掛」的規律，照著上面兩條重新
 * 量一遍（失敗前最近一次 cron 隔了多久、失敗與成功兩輪的包各多大），結論可能就不一樣了。
 *
 * **當場重試，不是等下一跳 cron**：這一步失敗時任務行還沒落庫，cron 那邊什麼都撿不到
 * （「狀態沒落地就不落任務」是這條兩步串行存在的意義）。所以只有這把梯子，走完還不成
 * 就明確告訴用戶這條沒發出去、讓他重發。最壞多花 1.6 秒，正常一次就過、一點不等。
 *
 * 客戶端本來有一模一樣的一把梯子（activeMsgClient 的 CLIENT_STATE_BACKOFF_MS），
 * 但它護的是常規狀態同步；即時對話這條路上客戶端只 POST 一次 /instant-chat，那把梯子
 * 就夠不著裡面這一跳了。補在這兒，兩條路才一樣穩。
 *
 * 只重這一步：它是按 (namespace, key) 的 upsert，重跑一次等於把同樣的值再寫一遍，
 * 沒有副作用。下一步的建任務不重——那一步失敗重跑可能建出兩條任務。
 */
const STATE_FORWARD_BACKOFF_MS = [0, 400, 1200];

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** gzip 流的頭兩個字節（RFC 1952）。壓沒壓過看這個，不看那個頭。 */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * 把請求正文讀成字符串，`Content-Encoding: gzip` 的在這一步還原。
 *
 * 跟上游 `readRequestBody` 認同一個頭（客戶端只有一個請求出口，兩邊端點得收同一種
 * 東西），但這份是自己寫的：上游那個函數住在 `@rei-standard/amsg-server` 包根，而包根
 * 頂層 import 了 Node 的 `crypto`，這個 worker 是明確不開 `nodejs_compat` 的。
 *
 * 判據是**魔數不是頭**。`Content-Encoding` 是標準頭，鏈路上的邊緣節點會替你把請求體
 * 解開卻把頭留著（SullyOS 實測遇到過）——只看頭的話，這種時候會拿明文去喂解壓器，報出來是一句讓人找不著北的
 * 「請求體不是合法的 JSON」。看魔數則三種情形都對：沒解過的解開、替我們解過的原樣讀、
 * 壓根沒壓的原樣讀。
 */
const readMaybeGzippedBody = async (request: Request): Promise<string> => {
  if ((request.headers.get('content-encoding') ?? '').toLowerCase() !== 'gzip') {
    return request.text();
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length < 2 || raw[0] !== GZIP_MAGIC[0] || raw[1] !== GZIP_MAGIC[1]) {
    return new TextDecoder().decode(raw);
  }
  const stream = new Response(raw).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
};

/** 客戶端預加密的信封形狀（上游 parseEncryptedBody 認的就是這三個字段）。 */
const isEncryptedEnvelope = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = value as Record<string, unknown>;
  return typeof env.iv === 'string'
    && typeof env.authTag === 'string'
    && typeof env.encryptedData === 'string';
};

/**
 * `POST /instant-chat` 的處理：鑑權 → 嚴格順序轉發 → 202 → 立刻起一跳。
 *
 * 順序不能換：雲端狀態先落地，任務才允許存在。反過來的話，狀態那一步失敗時 D1 裡
 * 已經躺著一條註定拿舊上下文答話的任務，而且沒人攔得住它。
 *
 * 任務體帶 `immediate: true`（客戶端 sendInstantChat 固定寫）：上游落庫即到期，
 * 202 之後的那一跳直接就能撿走；頂替上一條也在任務體裡（`supersedesUuid`，
 * 上游在建新任務的同一事務裡取消舊的），包裝層不再有第二條取消請求。
 */
export const handleInstantChat = async (args: {
  request: Request;
  env: InstantChatEnv;
  upstream: InstantChatUpstream;
  /** 帶 CORS 頭的 JSON 響應器（CORS 頭只在 index.ts 存一份）。 */
  json: (status: number, body: unknown) => Response;
  /** 雲端狀態那步的重試梯子（單測傳全零，別真等）。 */
  stateBackoffMs?: number[];
}): Promise<Response> => {
  const { request, env, upstream, json } = args;
  const stateBackoffMs = args.stateBackoffMs ?? STATE_FORWARD_BACKOFF_MS;

  const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
    json(status, { success: false, error: { code, message, ...(extra ?? {}) } });

  // ── 鑑權：跟上游同一套判據。上游轉發時還會再驗一次（它才是權威），
  //    這裡先擋一道是為了「口令不對」時一個字節的雲端狀態都別寫進去。
  const token = (env.AMSG_SERVER_TOKEN ?? '').trim();
  const clientToken = request.headers.get('X-Client-Token') ?? '';
  if (token) {
    if (!clientToken || !(await constantTimeEqual(clientToken, token))) {
      return fail(401, 'INVALID_CLIENT_TOKEN', '共享密鑰無效或缺失');
    }
  }
  const userId = request.headers.get('X-User-Id') ?? '';
  if (!userId) return fail(400, 'USER_ID_REQUIRED', '缺少用戶標識符');
  if (!UUID_V4_RE.test(userId)) return fail(400, 'INVALID_USER_ID_FORMAT', 'X-User-Id 必須是 UUID v4 格式');

  // ── 外殼是明文 JSON，裡頭兩個信封是客戶端加密好的，包裝層只搬不看。
  //    body 超閾值時客戶端會先 gzip 再發（這條路上的正文是整輪聊天，最大的一份），
  //    所以讀之前先過一道解壓。
  let body: Record<string, unknown>;
  try {
    const text = await readMaybeGzippedBody(request);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'INVALID_JSON', '請求體不是合法的 JSON 對象');
  }
  if (!isEncryptedEnvelope(body.statePayload)) {
    return fail(400, 'INVALID_STATE_PAYLOAD', 'statePayload 必須是加密信封（iv / authTag / encryptedData）');
  }
  if (!isEncryptedEnvelope(body.taskPayload)) {
    return fail(400, 'INVALID_TASK_PAYLOAD', 'taskPayload 必須是加密信封（iv / authTag / encryptedData）');
  }

  // ── 內部轉發：路徑跟著本次請求的掛載點走（上游按後綴匹配，worker 可能掛在子路徑下）。
  const requestUrl = new URL(request.url);
  const mountPath = requestUrl.pathname.replace(/\/+$/, '').replace(/\/instant-chat$/, '');
  const internalUrl = (path: string): string => {
    const url = new URL(request.url);
    url.pathname = `${mountPath}${path}`;
    url.search = '';
    return url.toString();
  };
  // 上游自己的頭約定原樣帶上（含客戶端給的口令），它會再驗一遍。
  const encryptedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': userId,
    'X-Payload-Encrypted': 'true',
    'X-Encryption-Version': '1',
    ...(clientToken ? { 'X-Client-Token': clientToken } : {}),
  };

  const readBody = async (response: Response): Promise<unknown> => {
    try { return await response.json(); } catch { return null; }
  };

  // ① 雲端狀態必須先落地：這一步失敗就絕不落任務（否則任務到點會拿舊上下文答話）。
  //    5xx 是 D1 冷啟動那類瞬時錯誤的典型長相，按梯子重試幾次（見 STATE_FORWARD_BACKOFF_MS）；
  //    4xx 是上游判出來的業務錯（體積超限、時間戳不合法……），重試多少次都是同一個答案，立刻打回。
  let stateResponse!: Response;
  let stateBody: unknown = null;
  let stateCause: string | null = null;
  for (let attempt = 0; attempt < stateBackoffMs.length; attempt += 1) {
    if (attempt > 0) {
      console.warn(`[amsg:instant-chat] 雲端狀態第 ${attempt} 次沒寫進去（${stateCause ?? stateResponse.status}），重試`);
      await sleep(stateBackoffMs[attempt]);
    }
    stateResponse = await upstream.fetch(
      new Request(internalUrl('/client-state'), {
        method: 'PUT',
        headers: encryptedHeaders,
        body: JSON.stringify(body.statePayload),
      }),
      env,
    );
    // 響應體只能讀一次，這裡讀完存著：失敗分支要拿它報原因，成功分支要拿它查 skippedEntries。
    stateBody = await readBody(stateResponse);
    stateCause = readUpstreamCause(stateResponse.status, stateBody);
    if (stateResponse.status < 500) break;
  }
  if (!stateResponse.ok) {
    return json(stateResponse.status, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_FAILED',
        message: '雲端狀態沒傳上去，這條沒發出去',
        step: 'client-state',
        upstream: stateBody,
        ...(stateCause ? { upstreamLog: stateCause } : {}),
      },
    });
  }
  // HTTP ok ≠ 都寫進去了：上游按 updatedAt 做條件寫（舊不蓋新），被攔的條目在成功體的
  // skippedEntries 裡點名。fire_pack 被攔（典型成因：設備時鐘在兩次發送之間被回撥，
  // 這次的 updatedAt 反而比雲端存量舊）時絕不能落任務——到點的 fire 讀到的是上一輪的
  // chat 段，要麼對舊消息答非所問、要麼硬失敗，用戶卻已經拿到 202 在等「正在輸入」。
  // 「狀態沒落地就不落任務」正是這條兩步串行存在的意義，這裡把它守完整。
  const skippedEntries = (stateBody as {
    data?: { skippedEntries?: Array<{ namespace?: unknown; key?: unknown }> };
  } | null)?.data?.skippedEntries;
  if (Array.isArray(skippedEntries) && skippedEntries.some((entry) => entry?.key === AMSG_FIRE_PACK_KEY)) {
    return json(409, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_STALE',
        message: '雲端拒收了這輪的最新狀態（雲端已有更新的一份）——設備時鐘可能被回撥過，檢查系統時間後再發一次',
        step: 'client-state',
      },
    });
  }

  // ② 任務落庫 = 受理（頂替上一條也在這一步裡：任務體的 supersedesUuid 由上游在
  //    同一事務裡處理）。到這一步返回 202 之前，行已經在 D1 裡了，
  //    下面那一跳只是讓它快點跑起來，跑不成還有每分鐘的 cron。
  const taskResponse = await upstream.fetch(
    new Request(internalUrl('/schedule-message'), {
      method: 'POST',
      headers: encryptedHeaders,
      body: JSON.stringify(body.taskPayload),
    }),
    env,
  );
  const taskBody = await readBody(taskResponse);
  if (!taskResponse.ok) {
    const taskCause = readUpstreamCause(taskResponse.status, taskBody);
    return json(taskResponse.status, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_TASK_FAILED',
        message: '任務沒建起來，這條沒發出去',
        step: 'schedule-message',
        upstream: taskBody,
        ...(taskCause ? { upstreamLog: taskCause } : {}),
      },
    });
  }
  const uuid = (taskBody as { data?: { uuid?: unknown } } | null)?.data?.uuid;
  if (typeof uuid !== 'string' || !uuid) {
    return fail(502, 'INSTANT_CHAT_TASK_UUID_MISSING', '上游沒有回任務 uuid，無法跟蹤這一輪', {
      step: 'schedule-message',
    });
  }

  // ③ 叫醒 DO，讓它立刻把這條撿走（immediate 任務落庫即到期）。
  //    生成跑在它的 alarm 裡 —— 獨立 invocation、15 分鐘牆鍾，見 kickInstantTick。
  const kicked = await kickInstantTick(env, uuid);
  if (!kicked.ok && kicked.reason === 'missing-binding') {
    // 任務已經在庫裡了，所以這不是「沒發出去」，而是「這台 Worker 跑不動它」：
    // 每分鐘的 cron 仍會把它撿走，但那條路上沒有為即時對話放寬的超時，用戶會等很久
    // 甚至等不到。與其讓他對著「正在輸入」乾等，不如現在就說清楚該去點哪裡。
    console.error('[amsg:instant-chat] 沒有 INSTANT_TICK 綁定：這台 Worker 是舊版本，需要更新');
    return json(503, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_WORKER_OUTDATED',
        message: '即時對話需要更新 Worker：打開「系統設置 → 主動消息 2.0 → 配置」，點「更新 Worker」。',
        step: 'instant-tick',
        uuid,
      },
    });
  }
  if (!kicked.ok) {
    // 叫醒失敗但綁定在 = 臨時故障。任務已落庫，下一分鐘的 cron 會撿起來，
    // 不該把已經受理的這一輪報成失敗。
    console.warn('[amsg:instant-chat] 叫醒 DO 失敗（等 cron 兜底）', kicked.error);
  }

  return json(202, { status: 'accepted', uuid });
};
