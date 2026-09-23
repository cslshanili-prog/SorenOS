/**
 * 主動消息 2.0「滿血」fire_pack：前端拼好的 prompt 模板 + 時間槽位的渲染。
 *
 * prompt 不在排程時定稿，而是前端把「除時間性內容外的完整模板」同步到 worker 的
 * client_state（namespace `amsg:char:<id>`，key `fire_pack`），worker 到點用
 * renderFirePack 現算時間填槽——上下文永遠是最後一次聊天的狀態。這份模塊被兩邊共用：
 *   - 前端 activeMsgClient 的 buildFirePack（排程 / 每輪聊完同步時打包）
 *   - worker/amsg/src/index.ts 的 onBeforeFire（fire 時現場渲染）
 * 時間文案只此一份，兩邊的槽位定義保證一致。
 *
 * 多任務共用每角色一份 fire_pack：「本次任務」指令隨任務 metadata 走、到點填槽（v2 起）。
 *
 * 零運行時依賴（worker bundle 會打進這份代碼，別在這裡 import 前端環境的東西；類型引用
 * 編譯期擦除，不算）。除了壓縮那幾個函數用 CompressionStream / base64（瀏覽器和 Workers
 * 運行時都自帶），其餘都是純函數。
 */

import type { ActiveMsg2TaskRecord } from '../types';
import { renderFireSceneBlock, type AmsgFireScene } from './amsgFireScene';

export const AMSG_STATE_NAMESPACE_PREFIX = 'amsg:char:';
export const amsgStateNamespace = (charId: string) => `${AMSG_STATE_NAMESPACE_PREFIX}${charId}`;
export const AMSG_FIRE_PACK_KEY = 'fire_pack';

/**
 * 角色到點自己發出去的那幾條正文（每角色一份）。
 *
 * fire_pack 的【最近對話上下文】停在「用戶最後一次聊天」那一刻，而主動消息發出去之後
 * 那份不會變——用戶離線期間連著觸發兩次，第二次看到的上下文和第一次逐字一樣，角色不知道
 * 自己剛說過什麼，只能把同一句話換個說法再發一遍。worker 每次發完把正文追加到這裡，
 * 下次到點連同 fire_pack 一起讀回來，接在對話上下文後面。
 *
 * 用戶重新聊天后客戶端會傳一份新的 fire_pack（新歷史裡本來就含這些消息），那時這份日誌
 * 靠 basePackAt 對不上號自動作廢，下一次 fire 直接覆蓋成新的一份。
 */
export const AMSG_SELF_LOG_KEY = 'self_log';

/**
 * 大內容旁路：一條 push 塞不下的 XHS 會話數據（筆記詳情 + xsecToken）存這個 key，
 * push 裡只帶 `metadata.xhsSessionRef` 指過來，客戶端收到後按鍵取回、用完即刪。
 *
 * 每個任務固定一份、下次觸發直接覆蓋——所以就算客戶端一直沒來取，存量也有上限，
 * 不需要額外的過期清理。worker 寫（onLLMOutput）與客戶端讀（activeMsgRuntime）
 * 共用這一份鍵名，別在任何一側另起爐灶。
 */
export const amsgXhsSessionKey = (clientTaskId: string) => `xhs_session:${clientTaskId}`;

// ─── 即時對話輕量包的模板佔位 ───

/**
 * 即時對話輕量包的模板佔位（角色 2.0 關著且沒有任何任務時用）：定時任務那條路才渲染
 * 模板，這類角色的包正常沒人渲染，每次發送重建一整份系統提示詞 + 近史轉寫純屬白付
 * （主線程二次構建 + 手機上行幾十 KB，都發生在拿到 202 之前）。寫成一眼能認出來的
 * 標記，兩側共用這一份：客戶端（activeMsgClient）發輕量包時填進 template；worker
 * 跑定時任務前認出它，就知道真模板還沒補傳上來，這一跳先延後重試而不是照渲。
 */
export const AMSG2_INSTANT_STUB_TEMPLATE =
  'AMSG2_INSTANT_STUB_TEMPLATE（即时对话轻量包：该角色无定时任务，模板未随发送重建；看到这条正文说明有本不该渲染模板的 fire 在渲染它）';

// ─── 即時對話的失敗留痕（chat_fail） ───

/**
 * 即時對話整輪失敗時的原因留痕（每角色一份，新的覆蓋舊的）。
 *
 * 客戶端 60s 點名判到「任務行已出清」後要向用戶交代失敗原因，而 lastError 埋在任務行
 * 的加密 payload 裡——按角色掃全量任務列表（分頁 + 逐條解密）幾秒起步。worker 在
 * fire 收尾（amsgFireSettled，每次失敗嘗試覆蓋寫）和過期跳過（amsgStaleSkip）時順手
 * 在這裡留一份，客戶端一次點名讀回。記錄帶 uuid：讀到的不是自己等的那一輪就當沒有。
 */
export const AMSG_CHAT_FAIL_KEY = 'chat_fail';

export interface AmsgChatFailRecord {
  v: 1;
  /** 失敗的是哪一輪（任務行 uuid）；客戶端只認和待收記錄對得上的那份。 */
  uuid: string;
  /** 失敗原因（fire 拋錯的 message；過期跳過固定為 'stale'）。 */
  reason: string;
  /** 失敗那一跳時任務行上的重試計數。 */
  retryCount: number;
  /** 寫入時刻（epoch ms）。 */
  at: number;
  /**
   * 底層錯誤的穩定 code，取自 fire 拋出來那個錯誤對象上的 `code`
   * （`LLM_CALL_FAILED` / `AGENTIC_BAD_DECISION` / `PUSH_PAYLOAD_TOO_LARGE` …）。
   * 客戶端按它給「這次該怎麼辦」，不用去正則匹配 reason 那句人話。
   *
   * 沒有配對的 `pushStatus`：那個數只有上游發 push 的那一步知道（存在包內私有的
   * WeakMap 上），fire 收尾這裡拿到的錯誤對象上讀不到。要用它得讀上游寫在任務行
   * 上的那份 lastError，客戶端會把兩邊合起來看。
   */
  errorCode?: string;
}

/** 讀回來的失敗留痕；形狀不對返回 null（這是提示通道不硬失敗，沒有就報籠統原因）。 */
export const parseChatFailRecord = (value: string | null | undefined): AmsgChatFailRecord | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AmsgChatFailRecord> | null;
    if (
      parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.uuid === 'string' && typeof parsed.reason === 'string'
      && typeof parsed.retryCount === 'number' && typeof parsed.at === 'number'
    ) {
      return parsed as AmsgChatFailRecord;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

// ─── client_state 的值壓縮 ───
//
// fire_pack 是「角色完整系統提示詞 + 最近 30 條對話」，一份 40KB 起步，排了任務的角色
// 每聊完一輪就整份重傳一次。壓縮必須發生在**交給上游加密之前**：上游 putClientState 是
// 先加密再發，密文近似隨機、gzip 壓不動（實測只能抵消 base64 那點膨脹，省 25%），
// 而在這裡先壓再交出去，同一份內容實測省 60%，D1 裡存的也跟著變小。

/**
 * 壓縮過的值的前綴。
 *
 * 不是版本兼容用的，是「這一份到底壓沒壓」的標記：內容太短時壓完反而更大，
 * packStateValue 會原樣返回，讀側靠這個前綴分辨該不該解壓。
 */
const GZIP_VALUE_PREFIX = 'gz1:';

/** 運行時有沒有壓縮能力（老 Safari 沒有 CompressionStream）。 */
const canCompress = (): boolean =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

// btoa/atob 只吃 latin1 字符串，二進制要一個字節一個字符地喂。整段 apply 展開會在大數據上
// 爆調用棧，按塊拼。
const CHUNK = 0x8000;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const streamThrough = async (data: Uint8Array, transform: TransformStream): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * 上傳前把值壓掉。壓不動或運行時不支持時原樣返回 —— 這個函數永遠不該讓同步失敗，
 * 雲端那份 fire_pack 是角色到點時唯一的上下文來源，為了省流量把它弄丟是本末倒置。
 */
export const packStateValue = async (json: string): Promise<string> => {
  if (!canCompress()) return json;
  try {
    const rawBytes = new TextEncoder().encode(json);
    const gz = await streamThrough(rawBytes, new CompressionStream('gzip'));
    const packed = `${GZIP_VALUE_PREFIX}${bytesToBase64(gz)}`;
    // 划算不划算按**字節**比，不能用 .length。fire_pack 幾乎全是中文，一個字符佔 3 個
    // UTF-8 字節，而壓完的 base64 全是 ASCII（1 字符 = 1 字節）——拿字符數比的話，
    // 明明省掉一半流量的結果會被判成「壓完更大」，於是一份都壓不動。
    return packed.length < rawBytes.length ? packed : json;
  } catch {
    return json;
  }
};

/**
 * 讀回來的值還原成 JSON 字符串。沒有前綴的就是沒壓過的，原樣返回。
 * 解壓失敗拋出去 —— 那說明數據真損壞了，不能當成正常內容往下走。
 */
export const unpackStateValue = async (value: string): Promise<string> => {
  if (!value.startsWith(GZIP_VALUE_PREFIX)) return value;
  const gz = base64ToBytes(value.slice(GZIP_VALUE_PREFIX.length));
  const raw = await streamThrough(gz, new DecompressionStream('gzip'));
  return new TextDecoder().decode(raw);
};

/**
 * 防穿幫閘最近一次攔下了哪次觸發（每角色一份，新的蓋舊的）。
 *
 * 閘是完全靜默工作的：worker 判定「該讓路」之後直接跳過這次 fire，一條 push 都不發。
 * 對用戶來說，「讓路了」和「發出去但沒收到」「功能壞了」長得一模一樣——遠端那行任務
 * 兩種情況下都會被消費掉，客戶端事後無從分辨。
 *
 * 所以讓 worker 在跳過時留一句話，客戶端讀回來照實說明。只留最近一次：這是給人看的
 * 「剛才為什麼沒響」，不是審計流水，攢著只會越積越多。
 */
export const AMSG_LAST_SKIP_KEY = 'last_skip';

/** last_skip 的原因枚舉（新增值時 describeLastSkip 的人話文案要一起補）。 */
const LAST_SKIP_REASONS = [
  'active-chat-presence',
  'conversation-moved-on',
  'empty-generation',
  'side-effects-only',
  'stale',
  'unanswered-limit',
] as const;

export interface AmsgLastSkip {
  v: 1;
  /** 被跳過的那條任務（uuid，拿不到時為 null）。 */
  taskUuid: string | null;
  /** 本該觸發的時刻。 */
  occurrenceMs: number;
  /**
   * active-chat-presence  到點時用戶正跟這個角色聊天
   * conversation-moved-on 排程之後對話已經往前走了，原本要說的話過時了
   * empty-generation      模型這次沒寫出任何能發的正文（空輸出 / 純拒答）
   * side-effects-only     模型這次只做了副作用（點贊、寫日記之類）卻沒說話，整條不發
   * stale                 到點時已經過期太久（服務停擺後恢復），不再補發
   * unanswered-limit      角色自排的任務到點時，用戶未回覆期間的連發條數已到用戶設的上限
   */
  reason: (typeof LAST_SKIP_REASONS)[number];
  skippedAt: number;
  /**
   * reason 為 stale 時補充這條任務的去向：
   *   expired        一次性任務，這一次永遠不會補發了
   *   fast_forwarded 循環任務，攢下的這幾次都跳過，排期已快進到 nextSendAtMs
   */
  staleAction?: 'expired' | 'fast_forwarded';
  /** 一併跳過了幾次（含名義那一次）。 */
  skippedCount?: number;
  /** 循環任務快進到的下一次觸發時刻；一次性任務沒有下一次，為 null。 */
  nextSendAtMs?: number | null;
}

export const parseLastSkip = (value: string): AmsgLastSkip | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.occurrenceMs === 'number'
      && (LAST_SKIP_REASONS as readonly string[]).includes(parsed.reason)
    ) {
      return parsed as AmsgLastSkip;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/** 給人看的一句話：為什麼那一次沒響。 */
export const describeLastSkip = (skip: AmsgLastSkip, formatTime: (ms: number) => string): string => {
  const when = formatTime(skip.occurrenceMs);
  switch (skip.reason) {
    case 'active-chat-presence':
      return `${when} 那次主動消息讓路了——到點時你正在和 ta 聊天。`;
    case 'conversation-moved-on':
      return `${when} 那次主動消息取消了——排程之後你們的對話已經聊到別處，原本要說的話過時了。`;
    case 'empty-generation':
      return `${when} 那次主動消息沒發出來——ta 到點想了想，這次沒寫出要說的話。`;
    case 'side-effects-only':
      return `${when} 那次主動消息沒發出來——ta 到點只顧著做事，一句話都沒說，就沒打擾你。`;
    case 'stale': {
      // 循環任務只是跳過了攢下的這幾次，下一次照常響；一次性任務是真的沒了。
      // 兩句話分開說，不然用戶會以為每日提醒已經死了。
      const times = skip.skippedCount && skip.skippedCount > 1 ? `連著 ${skip.skippedCount} 次` : '那次';
      if (skip.staleAction === 'fast_forwarded') {
        const next = skip.nextSendAtMs ? `，下一次 ${formatTime(skip.nextSendAtMs)} 照常` : '，下一次照常';
        return `${when} 起${times}主動消息沒發——中間服務中斷過，過期的就不補了${next}。`;
      }
      return `${when} 那次主動消息沒發——到點時已經過去太久（服務中斷過），過期的話就不補發了。`;
    }
    case 'unanswered-limit':
      // 照 stale 那支的口徑說實話：被閘攔下的那一次是**跳過**，不是排隊等著補發。
      // 上游把跳過當成功消費——一次性任務的行當場就刪了，循環任務只是快進到下一次。
      // 寫成「等你回覆後恢復」的話，用戶會一直等一條永遠不會來的消息。
      return `${when} 那次主動消息沒發——你未回覆期間 ta 的連發條數已到你設置的連發上限，`
        + `跳過的這次不會補發；等你回話之後，ta 自己排的後續才會重新開始發。`;
  }
};

export const AMSG_SLOT_CURRENT_TIME = '{{AMSG_CURRENT_TIME}}';
export const AMSG_SLOT_TIME_SINCE_USER = '{{AMSG_TIME_SINCE_USER}}';
export const AMSG_SLOT_AWAY_HINT = '{{AMSG_AWAY_HINT}}';
export const AMSG_SLOT_TASK_INSTRUCTION = '{{AMSG_TASK_INSTRUCTION}}';
/**
 * 「對方那邊現在幾點」的落點，緊跟在角色自己的當前時間後面。
 *
 * 角色的鐘按 tzId 走，用戶的鐘按 userTzId 走——異國戀角色排消息時只看得到自己那邊的
 * 時間，很容易把「晚上九點聊兩句」排到用戶的凌晨三點。這一行給它一個參照。
 *
 * 兩個時區一樣時 worker 填空串（絕大多數角色都是這種），槽位連帶消失：同一個鍾報兩遍
 * 只會讓模型以為 prompt 裡有兩個打架的時間。
 */
export const AMSG_SLOT_USER_CLOCK = '{{AMSG_USER_CLOCK}}';
/**
 * 「這份上下文之後，角色自己又發過什麼」的落點，緊跟在【最近對話上下文】後面。
 *
 * 槽位而不是把這段拼在整份 prompt 尾巴上：接在對話記錄後面讀起來才是一條時間線，
 * 掛在最後（本次任務指令之後）的話，角色多半會把它當成新指令的一部分。
 */
export const AMSG_SLOT_SELF_LOG = '{{AMSG_SELF_LOG}}';
/**
 * 「你現在還掛著哪些排程」的落點。
 *
 * 平時聊天時角色每輪都能看到這份清單（見 amsg2TaskContext 的排程現狀塊），到點生成時
 * 反而看不到——它因此不知道自己已經排了什麼，容易把同一件事再排一遍，也沒法在說話時
 * 避開「等下再跟你說 X」而 X 其實早就排在半小時後。這個槽位把同一份信息補到 fire 這邊。
 */
export const AMSG_SLOT_TASK_LIST = '{{AMSG_TASK_LIST}}';
/**
 * 「你此刻在做什麼」的落點：日程當前時段 + 由日程推出來的此刻在聽的歌。
 *
 * 這兩塊以前跟著角色設定一起烤進模板，說的是打包那一刻的事——凌晨三點觸發時角色
 * 會說「我在健身房呢」。改成隨包帶整天的作息表，worker 到點按角色時區現挑時段。
 */
export const AMSG_SLOT_SCENE = '{{AMSG_SCENE}}';
/**
 * 「外面的世界此刻什麼樣」的落點：今日節日 + 實時天氣 + 熱搜。
 *
 * 這一段前台每輪都有（見 realtimeWorldCore 的 renderRealtimeWorldBlock），到點生成
 * 也該有，但絕不能跟著模板一起烤進來——它抬頭就寫著「以下信息來自真實世界」，
 * 措辭比任何免責聲明都硬，照著打包那一刻的讀數說話就是大晴天叫人帶傘、第二天還在
 * 祝七夕快樂。所以留成槽位，worker 到點現拉現填；拉不到就填空串，這一段整個消失。
 *
 * 注意這段裡不帶「當前時間」那一行：時間由 AMSG_SLOT_CURRENT_TIME 給，
 * 兩處都出的話一份 prompt 裡就有了兩個鍾。
 */
export const AMSG_SLOT_REALTIME_WORLD = '{{AMSG_REALTIME_WORLD}}';

/**
 * 「即時對話」這一輪要發給模型的對話消息。
 *
 * 和 template 是兩條路，不混用：template 是「到點主動找人說話」的提示詞，
 * 這一份是「用戶剛說完話、等回覆」時本地生成會原樣 POST 出去的 fullMessages。
 * 即時對話的 fire 直接拿它當請求消息，只在末尾追加一塊時效內容（當前時間、
 * 實時世界等），不走 renderFirePack 的模板渲染。
 */
/**
 * 一條對話消息的正文：要麼是純文本，要麼是 chat API 那套結構化分段
 * （帶圖片的消息本地就長這樣：`[{type:'text',…},{type:'image_url',…}]`）。
 *
 * 分段裡除了 `type` 之外什麼樣，這一層不管也不該管——那是 chat API 的方言，
 * worker 只負責原樣搬到請求體裡。寫死字段的話，哪天多模態多出一種分段類型，
 * 卡住的會是這份「只負責搬運」的代碼。
 */
export type AmsgFirePackChatContent =
  | string
  | Array<{ type: string; [key: string]: unknown }>;

export interface AmsgFirePackChat {
  /** 本地生成會 POST 給 /chat/completions 的 fullMessages，原樣帶上來。 */
  messages: { role: string; content: AmsgFirePackChatContent }[];
  /** 這份對話消息打包的時刻（epoch ms）。 */
  builtAt: number;
}

export interface AmsgFirePack {
  v: typeof FIRE_PACK_VERSION;
  /** 完整 prompt 模板，時間性內容與本次任務指令留 AMSG_SLOT_* 槽位。 */
  template: string;
  /** 用戶上次真實主動發消息的時間（epoch ms）；沒有聊天記錄時為 null。 */
  lastUserMessageAt: number | null;
  /**
   * 角色的 IANA 時區 id（角色開了自定義時區用角色的，沒開用打包設備的）。
   * worker 渲染一切給角色看的時間都以它為參照系（Intl 處理夏令時）。必填：
   * 缺了整包按格式不對打回（parseFirePack → null，worker 拋 fire-state 錯）。
   */
  tzId: string;
  /**
   * 打包這台設備的 IANA 時區 id，也就是「用戶那邊」的鐘。
   *
   * 只用來渲染 AMSG_SLOT_USER_CLOCK 那一行參考——角色自己的一切時間仍按 tzId 走，
   * 這兩個絕不能混著用。必填：缺了整包按格式不對打回（跟 tzId 同一條規矩）。
   */
  userTzId: string;
  /** 用戶稱呼（userProfile.name || '對方'），awayHint 文案用。 */
  targetName: string;
  /**
   * 這份模板打包的時刻（epoch ms），self_log 的 tasks 段拿它當對齊錨點：日誌裡記的
   * basePackAt 和這個值不一樣，說明客戶端之後又傳了一份新模板，自排任務已隨
   * pendingTasks 回來，tasks 段作廢；連發記錄（entries）不看它，只認用戶有沒有開口
   * （見 reconcileSelfLogWithPack）。
   */
  builtAt: number;
  /**
   * 打包時該角色還掛著的排程（客戶端清單裡的原始記錄）。worker 到點渲染成
   * AMSG_SLOT_TASK_LIST 那一段，並把「正在發的這一條」摘掉。
   *
   * 和模板其餘部分一樣是「最後一次聊天時」的快照：用戶中途在面板上取消了任務，這份要等
   * 下次同步才更新。角色到點自己排下的那些不在這裡，由 worker 從 self_log 補上。
   */
  pendingTasks: ActiveMsg2TaskRecord[];
  /**
   * 「此刻在做什麼」的原始素材（作息表 + 歌單抽樣池），worker 到點渲染進
   * AMSG_SLOT_SCENE。沒日程的角色為 null，那個槽位被抹平。
   */
  scene: AmsgFireScene | null;
  /**
   * 即時對話用的對話消息（見 AmsgFirePackChat）。只有開了即時對話的角色才帶，
   * 定時任務那條路不讀它。標了 `amsgInstantChat` 的任務缺這一份 = 按失敗處理，
   * 絕不退回主動消息模板去答聊天。
   */
  chat?: AmsgFirePackChat;
  /**
   * 用戶設的「未回覆期間最多連發幾條」（角色級設置，見 ActiveMsg2CharacterConfig 同名字段）。
   * 0 = 不限；缺省 = worker 用 DEFAULT_MAX_UNANSWERED_SENDS。worker 拿它攔兩處：
   * 排程工具打回、以及角色自排任務到點時的兜底作廢（用戶面板排的任務不受它管）。
   */
  maxUnansweredSends?: number;
  /**
   * 角色級「主動消息 2.0」開關（打包時取 isAmsg2EnabledForChar）。false 時雲端 fire
   * 不注入排程說明塊 / 排程工具 / 任務清單——本地路徑的同名閘門是 useChatAI 的
   * amsg2ToolsInjected（角色級開關關掉的不注入，否則被用戶顯式關掉的功能會被角色
   * 一次工具調用重新打開），雲端不看這個字段的話正好把那道閘繞穿：全局即時對話開著、
   * 角色 2.0 關著，角色照樣能在雲端聊天輪裡排出真會觸發的任務。
   * 必填：v7 的唯一生產者（buildFirePack）無條件寫它。這是一道用戶主權閘，缺省放行
   * 的容錯方向是 fail-open（字段一丟開關就被靜默重新打開），寧可整包打回。
   */
  selfScheduleEnabled: boolean;
}

// ─── 按角色參照系渲染時間（②：worker 給角色看的一切時間只此一份） ───

/** 「角色活在哪個參照系」：fire_pack 的 tzId（IANA 時區 id，Intl 管夏令時）。 */
export interface AmsgTzRef {
  tzId: string;
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  /** 0=週日 … 6=週六。 */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * nowMs 在 tz 參照系下的牆鍾讀數。全程 Intl（Workers 運行時帶完整 ICU，
 * 嚴禁手搓時差加減——項目時區文檔的紅線）。tzId 非法直接拋錯：parseFirePack 已經
 * 保證它非空，還解析不了就是數據壞了，走 fire 失敗路徑留痕，不靜默給一個錯的時間。
 */
export const wallClockPartsInZone = (nowMs: number, tz: AmsgTzRef): WallClockParts => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz.tzId,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // 個別環境用 24:00 表示午夜
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    weekday: weekdayIdx >= 0 ? weekdayIdx : 0,
    hour,
    minute: parseInt(map.minute, 10),
  };
};

const WEEKDAY_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 時段詞分桶照抄 buildTimeAwarenessBlock（utils/context.ts），兩邊說同一套話。 */
const timeOfDayWord = (h: number): string =>
  h < 5 ? '凌晨' : h < 9 ? '早晨' : h < 12 ? '上午' : h < 14 ? '中午'
  : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 22 ? '晚上' : '深夜';

const pad2 = (n: number) => n.toString().padStart(2, '0');

/** 當前時間槽用的自然中文全格式：`2026年8月1日 週六 早晨 08:00`（與 buildCoreContext 同款）。 */
export const formatFireTimeFull = (nowMs: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(nowMs, tz);
  return `${p.year}年${p.month}月${p.day}日 ${WEEKDAY_NAMES[p.weekday]} ${timeOfDayWord(p.hour)} ${pad2(p.hour)}:${pad2(p.minute)}`;
};

/** self_log 時間戳 / 排程清單用的短格式：`8月1日 08:00`（同一參照系，只是省地方）。 */
export const formatFireTimeShort = (nowMs: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(nowMs, tz);
  return `${p.month}月${p.day}日 ${pad2(p.hour)}:${pad2(p.minute)}`;
};

/**
 * 「對方那邊現在幾點」那一行（填進 AMSG_SLOT_USER_CLOCK）。
 *
 * 一份 prompt 裡出現兩個時間是很危險的，所以這一行把主語寫死：上面那行是角色自己的
 * 當前時間，這一行明說是對方那邊的。兩個時區相同時返回空串——同一個鍾報兩遍，模型
 * 只會覺得這兩個時間在打架。
 */
export const buildUserClockHint = (
  nowMs: number,
  charTz: AmsgTzRef,
  userTz: AmsgTzRef,
  targetName: string,
): string => {
  if (!userTz.tzId || userTz.tzId === charTz.tzId) return '';
  const p = wallClockPartsInZone(nowMs, userTz);
  const target = targetName || '對方';
  return `\n（對方所在時區參考：${target}那邊現在是 ${p.month}月${p.day}日 ${timeOfDayWord(p.hour)} ${pad2(p.hour)}:${pad2(p.minute)}。`
    + `你們之間有時差，別拿自己這邊的鐘去推斷 ${target} 此刻醒著還是睡著。）`;
};

/** 「距離用戶上次主動發消息……」三檔文案；diffMinutes 為 null 表示沒有聊天記錄。 */
export const formatTimeSinceUser = (diffMinutes: number | null): string => {
  if (diffMinutes == null) {
    return '你們最近沒有新的聊天記錄。';
  }
  const minutesTotal = Math.max(0, diffMinutes);
  if (minutesTotal < 60) {
    return `距離用戶上次主動發消息大約 ${minutesTotal} 分鐘。`;
  }
  if (minutesTotal < 1440) {
    const hours = Math.floor(minutesTotal / 60);
    const minutes = minutesTotal % 60;
    return `距離用戶上次主動發消息大約 ${hours} 小時${minutes ? ` ${minutes} 分鐘` : ''}。`;
  }
  const days = Math.floor(minutesTotal / 1440);
  const hours = Math.floor((minutesTotal % 1440) / 60);
  return `距離用戶上次主動發消息大約 ${days} 天${hours ? ` ${hours} 小時` : ''}。`;
};

/** legacyHint 裡的「對方已經多久沒來」變體，從 timeSinceUser 文案變換而來。 */
export const buildAwayHint = (targetName: string, timeSinceUser: string): string => {
  const target = targetName || '對方';
  if (timeSinceUser.includes('沒有新的聊天記錄')) return `${target}最近沒有主動來找你說話。`;
  // 只借用裡面那段時長，句子重新拼——照搬原句換個開頭會讀成「小明同學已經上次主動發消息大約 9 小時」。
  const span = timeSinceUser.match(/大[约約] (.+?)。?$/)?.[1];
  return span
    ? `${target}已經大約 ${span} 沒主動來找你了。`
    : `${target}最近沒有主動來找你說話。`;
};

// ─── self_log：角色自己發出去的那幾條 ───

export interface AmsgSelfLogEntry {
  /**
   * 這條正文屬於哪一次觸發（`<clientTaskId>@<觸發時刻>`）。
   *
   * 有它才能區分「同一次觸發重跑」和「真的又發了一條」：fire 拋錯會整條重跑
   * （worker 那邊重試三次），追加式記錄會把同一條消息記好幾遍，角色下次讀回來
   * 以為自己連發了三條。同 id 覆蓋，重跑多少次都只留一條。
   */
  id: string;
  /** 發出去的時刻（epoch ms）。 */
  at: number;
  /** 正文（多段消息拼成一條記，超長截斷）。 */
  text: string;
  /**
   * 即時對話的回覆（用戶剛說了話、這條是在答它）。列進自述塊保持連續性，
   * 但不算「主動連發」——帶這個標記的條目不會讓 unansweredSends 加一。
   */
  reply?: boolean;
}

export interface AmsgSelfLog {
  v: 4;
  /** 寫這份日誌時雲端 fire_pack 的 builtAt，見 AmsgFirePack.builtAt。 */
  basePackAt: number;
  /**
   * 連發記錄的錨：entries 與 unansweredSends 記的都是「用戶這次開口之後」的事。
   * fire 時發現 lastUserMessageAt 比它新 → 用戶開口過 → 兩樣一起清、錨前進
   * （見 reconcileSelfLogWithPack）。刻意不跟 basePackAt 掛鉤：客戶端每認領一條
   * 推送就會重傳 fire_pack，掛那上面的話計數會被角色自己發的消息洗回零，
   * 連發提醒和上限在用戶在線時全部失效——2026-08 炸屏事故的成因之一。
   */
  anchorUserMsgAt: number | null;
  entries: AmsgSelfLogEntry[];
  /**
   * 用戶未回覆期間角色主動發出的條數（即時對話的回覆不算）。
   *
   * 獨立成字段，不從 entries 數著數：entries 是給 prompt 看的上下文，只留最近
   * SELF_LOG_MAX_ENTRIES 條，拿它當計數器的話計數永遠不會超過那個上限——用戶把
   * 連發上限設成 9 或 10 時，「到點兜底閘」的 `計數 >= 上限` 恆為 false，那道專門
   * 為自排鏈炸屏加的硬閘整個失效。兩件事分開記，各自的上限互不干擾。
   */
  unansweredSends: number;
  /**
   * 角色在這幾次 fire 裡給自己排下的任務（客戶端還不知道它們存在）。
   *
   * 用途是讓下一次 fire 的排程清單完整：fire_pack.pendingTasks 是打包那一刻的快照，
   * 之後角色自己排的都不在裡面。沒有這份的話，角色排完一條、下次到點又看不見它，
   * 很容易把同一件事再排一遍。
   *
   * 客戶端上線重放 directive 之後，這些任務會進它的本地清單，下次同步就隨
   * fire_pack.pendingTasks 一起上來——那時 tasks 段作廢（basePackAt 對不上，
   * 見 reconcileSelfLogWithPack），不會兩邊各記一份。
   */
  tasks: ActiveMsg2TaskRecord[];
}

/**
 * entries 最多留幾條。再往前的對角色接話沒幫助，只是白佔 prompt。
 *
 * 這個上限**只管 prompt 上下文**：連發條數記在 unansweredSends 上，不受它壓。
 */
export const SELF_LOG_MAX_ENTRIES = 8;
/** 單條正文留多長。主動消息本來就一兩句，超出的部分基本是標籤和長引用。 */
export const SELF_LOG_TEXT_MAX = 200;

export const createSelfLog = (basePackAt: number, anchorUserMsgAt: number | null = null): AmsgSelfLog => ({
  v: 4,
  basePackAt,
  anchorUserMsgAt,
  entries: [],
  unansweredSends: 0,
  tasks: [],
});

/** 未回覆期間連發上限的缺省值（用戶沒設時 worker 用它）。 */
export const DEFAULT_MAX_UNANSWERED_SENDS = 3;

/** 用戶設置 → 生效上限：0 = 不限（Infinity），沒設/壞值 = 默認，其餘取正整數。 */
export const resolveMaxUnansweredSends = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_UNANSWERED_SENDS;
  if (value === 0) return Infinity;
  if (value < 1) return DEFAULT_MAX_UNANSWERED_SENDS;
  return Math.min(99, Math.floor(value));
};

/**
 * 連發計數：用戶未回覆期間角色主動發出的條數（即時對話的回覆不算）。
 *
 * 讀的是 unansweredSends 這個獨立計數器，不數 entries——entries 只留最近 8 條，
 * 數它的話計數封頂在 8，用戶設的 9 / 10 兩檔就等於「不限」（見 AmsgSelfLog）。
 */
export const countUnansweredSends = (log: AmsgSelfLog | null): number =>
  log ? log.unansweredSends : 0;

/**
 * fire 開場把雲端存的自述日誌對齊到本次的 fire_pack 與用戶發言狀態。兩段各管各的生死：
 *
 * - entries + unansweredSends（連發記錄）只認「用戶開口了」：lastUserMessageAt 比錨新
 *   就一起清零、錨前進。fire_pack 換代**不**清它們——換代多半隻是客戶端認領了角色自己
 *   發的推送（打髒重傳），計數要是跟著清，連發提醒和上限在用戶在線時就永遠不會生效。
 * - tasks（自排任務備帳）只認「fire_pack 換代」：客戶端認領後這些任務已隨
 *   pack.pendingTasks 回來，再留一份就會被記成兩條。
 */
export const reconcileSelfLogWithPack = (
  stored: AmsgSelfLog | null,
  pack: AmsgFirePack,
  lastUserMessageAt: number | null,
): AmsgSelfLog => {
  let log = stored ?? createSelfLog(pack.builtAt, lastUserMessageAt);
  if (lastUserMessageAt != null
    && (log.anchorUserMsgAt == null || lastUserMessageAt > log.anchorUserMsgAt)) {
    log = { ...log, anchorUserMsgAt: lastUserMessageAt, entries: [], unansweredSends: 0 };
  }
  if (log.basePackAt !== pack.builtAt) {
    log = { ...log, basePackAt: pack.builtAt, tasks: [] };
  }
  return log;
};

/** 記下角色剛給自己排的任務（同 uuid 覆蓋，fire 重跑不會記重）。 */
export const appendSelfLogTask = (log: AmsgSelfLog, task: ActiveMsg2TaskRecord): AmsgSelfLog => ({
  ...log,
  tasks: [...log.tasks.filter((t) => t.taskUuid !== task.taskUuid), task],
});

/**
 * 追加一條（同 id 覆蓋、正文截斷、entries 只留最近 SELF_LOG_MAX_ENTRIES 條）。
 * 空正文原樣返回。
 *
 * 連發計數在這裡 +1，但兩種情況不算：即時對話的回覆（reply，是在答用戶剛說的話），
 * 以及同 id 的重複追加（fire 拋錯整條重跑時同一條消息會再記一次，不能算成又發了一條）。
 */
export const appendSelfLogEntry = (log: AmsgSelfLog, entry: AmsgSelfLogEntry): AmsgSelfLog => {
  const text = entry.text.trim().slice(0, SELF_LOG_TEXT_MAX);
  if (!text) return log;
  const alreadyLogged = log.entries.some((e) => e.id === entry.id);
  const kept = log.entries.filter((e) => e.id !== entry.id);
  return {
    ...log,
    entries: [...kept, { ...entry, text }].slice(-SELF_LOG_MAX_ENTRIES),
    unansweredSends: log.unansweredSends + (entry.reply || alreadyLogged ? 0 : 1),
  };
};

export const parseSelfLog = (value: string): AmsgSelfLog | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' && parsed.v === 4
      && typeof parsed.basePackAt === 'number'
      && (parsed.anchorUserMsgAt === null || typeof parsed.anchorUserMsgAt === 'number')
      && typeof parsed.unansweredSends === 'number'
      && Array.isArray(parsed.tasks)
      && Array.isArray(parsed.entries)
      && parsed.entries.every((e: unknown) => {
        const entry = e as Partial<AmsgSelfLogEntry> | null;
        return !!entry && typeof entry.id === 'string'
          && typeof entry.at === 'number' && typeof entry.text === 'string';
      })
    ) {
      return parsed as AmsgSelfLog;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/**
 * 「多久之前」的自然寫法。一天之內用相對口徑——「3分鐘前」比「13:05」更能讓模型
 * 看見發送頻率本身（連發提醒的主要信息量就在這）；更久的退回按角色時區的絕對時刻。
 */
const formatAgo = (atMs: number, nowMs: number, tz: AmsgTzRef): string => {
  const diff = nowMs - atMs;
  if (diff < 60_000) return '剛剛';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}分鐘前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}小時前`;
  return formatFireTimeShort(atMs, tz);
};

/**
 * 渲染進 AMSG_SLOT_SELF_LOG 的那一段。沒有可寫的就返回空串（槽位被抹掉，模板跟沒這回事一樣）。
 *
 * 開頭兩個空行是刻意的：槽位緊接在對話記錄最後一行後面，不空開的話這段會黏成聊天記錄的續行。
 *
 * 結尾那行連發計數是軟提醒的主體：把「已連發幾條 / 上限幾條」擺在幾條相對時間戳的正下方，
 * 模型看到的是頻率事實而不是一句抽象勸告。硬攔不在這（見 worker 的排程工具閘與到點兜底閘）。
 */
export const renderSelfLogBlock = (
  log: AmsgSelfLog | null,
  nowMs: number,
  tz: AmsgTzRef,
  maxUnanswered: number = DEFAULT_MAX_UNANSWERED_SENDS,
): string => {
  if (!log || log.entries.length === 0) return '';
  // 正文只渲染還沒進【最近對話上下文】的那些（發出時刻晚於本次 fire_pack 打包時刻）；
  // 更早的條目客戶端已經寫進聊天記錄、隨新轉寫回來了，這裡再抄一遍就是同一段話出現兩次。
  // 計數不跟著過濾——連發額度問的是「用戶沒回期間總共發了幾條」，跟正文在哪無關。
  const fresh = log.entries.filter((e) => e.at > log.basePackAt);
  const sends = countUnansweredSends(log);
  const limitHalf = Number.isFinite(maxUnanswered)
    ? `，上限 ${maxUnanswered} 條，到上限後你自己排的後續會暫停、等對方回覆才恢復`
    : '';
  if (fresh.length === 0) {
    if (sends === 0) return '';
    // 正文都在轉寫裡了，這裡只補頻率事實。
    return [
      '',
      '',
      `（對方未回應期間你已連發 ${sends} 條主動消息${limitHalf}。別把已經說過的話換個說法再講一遍。）`,
    ].join('\n');
  }
  const countLine = sends >= 1
    ? `（對方一直沒回應，其中主動發起的你已連發 ${sends} 條${limitHalf}。往下接著說，別把已經說過的話換個說法再講一遍，也別假裝這些沒發生過。）`
    : '（這幾條是你發出去的，對方還沒回應。往下接著說，別把已經說過的話換個說法再講一遍，也別假裝這些沒發生過。）';
  return [
    '',
    '',
    '【這之後你又發過（對方還沒回）】',
    ...fresh.map((e) => `- ${formatAgo(e.at, nowMs, tz)}　${e.text}`),
    countLine,
  ].join('\n');
};

const fillSlot = (text: string, slot: string, value: string) => text.split(slot).join(value);

/**
 * 用 nowMs 時刻的時間信息填掉模板裡的全部槽位，得到最終可發給 LLM 的 prompt。
 * taskInstruction 由排程時寫進任務 metadata（見 activeMsgClient.buildTaskInstruction），
 * worker 讀不到就先拋錯，所以這裡按必填收。
 *
 * 另外兩塊由調用方現算好傳進來（都不傳時對應槽位被抹平，輸出與沒有這回事時一致）：
 *   selfLog       這份上下文之後角色自己發過什麼，先用 reconcileSelfLogWithPack 對齊過；
 *   taskListBlock 「你現在還掛著哪些排程」那一段，見 amsg2Tasks.buildFireTaskListBlock。
 *   文案住在 amsg2Tasks 而不是這裡：那邊已經有一整套給人看的任務描述（面板、
 *   排程現狀塊、list 工具共用），同一件事不該有第二套說法。
 *   realtimeWorldBlock 到點現拉的節日 / 天氣 / 熱搜，見 realtimeWorldCore.renderRealtimeWorldBlock。
 *
 * extras.includeClock 不是一塊內容而是個渲染開關：角色的「時間感知」關掉時傳 false，
 * 「此刻在做什麼」那段就不報鐘點（見 renderFireSceneBlock）。取值與今日節日同源，
 * 都來自 tool_pack.timeAwarenessEnabled。
 *
 * 連發提醒長在自述塊裡（renderSelfLogBlock 的計數行），上限取 pack.maxUnansweredSends。
 */
export const renderFirePack = (
  pack: AmsgFirePack,
  nowMs: number,
  taskInstruction: string,
  extras?: {
    selfLog?: AmsgSelfLog | null;
    taskListBlock?: string;
    realtimeWorldBlock?: string;
    includeClock?: boolean;
  },
): string => {
  const tz: AmsgTzRef = { tzId: pack.tzId };
  const currentTime = formatFireTimeFull(nowMs, tz);
  const diffMinutes = pack.lastUserMessageAt == null
    ? null
    : Math.max(0, Math.floor((nowMs - pack.lastUserMessageAt) / 60_000));
  const timeSinceUser = formatTimeSinceUser(diffMinutes);
  const awayHint = buildAwayHint(pack.targetName, timeSinceUser);

  let out = pack.template;
  out = fillSlot(out, AMSG_SLOT_CURRENT_TIME, currentTime);
  // 對方那邊的鐘：跟上面那行是兩個主體各自的時間，文案裡各自寫清主語（見 buildUserClockHint）。
  out = fillSlot(out, AMSG_SLOT_USER_CLOCK, buildUserClockHint(nowMs, tz, { tzId: pack.userTzId }, pack.targetName));
  out = fillSlot(out, AMSG_SLOT_TIME_SINCE_USER, timeSinceUser);
  out = fillSlot(out, AMSG_SLOT_AWAY_HINT, awayHint);
  out = fillSlot(out, AMSG_SLOT_TASK_INSTRUCTION, taskInstruction);
  out = fillSlot(out, AMSG_SLOT_SELF_LOG, renderSelfLogBlock(
    extras?.selfLog ?? null, nowMs, tz, resolveMaxUnansweredSends(pack.maxUnansweredSends),
  ));
  out = fillSlot(out, AMSG_SLOT_TASK_LIST, extras?.taskListBlock ?? '');
  out = fillSlot(out, AMSG_SLOT_SCENE, renderFireSceneBlock(pack.scene, nowMs, tz, {
    includeClock: extras?.includeClock !== false,
  }));
  // 實時世界那一段是獨立的一整塊，前導空行在這裡補：拉到東西才隔開成段，
  // 沒拉到（或功能沒開）填空串，輸出跟沒有這個槽位時一模一樣。
  const realtimeWorld = extras?.realtimeWorldBlock?.trim();
  out = fillSlot(out, AMSG_SLOT_REALTIME_WORLD, realtimeWorld ? `\n\n${realtimeWorld}` : '');
  return out;
};

/**
 * 當前 fire_pack 的版本號。前端打包寫它，worker 只認它。
 *
 * 版本不匹配一律整包打回，不做任何形狀兼容——兩邊永遠同一次發佈上線。
 * 唯一的例外是「說清楚為什麼」：見 describeFirePackVersion，worker 拿它拼失敗原因，
 * 面板的 lastError 才能直接告訴用戶該重貼 bundle 還是該刷新前端。
 */
export const FIRE_PACK_VERSION = 7;

/**
 * 即時對話任務行的 messageSubtype 標籤。上游只當自由文本原樣透傳；客戶端兩處都認它：
 * 排程時寫（activeMsgClient.sendInstantChat）、面板對帳時濾（amsg2Tasks 的
 * reconcileTasksWithRemote——即時對話的行不補進任務清單，不然用戶正等著的一輪會顯示
 * 成「待觸發」，還可能被「取消全部」順手掐掉）。寫讀兩側靠這一個常量綁死：它是
 * GET /messages 明文投影裡唯一可查的即時對話標記，producer 改個說法 filter 就瞎了。
 */
export const AMSG_INSTANT_CHAT_SUBTYPE = 'instant-chat';

/**
 * 解析失敗時給人看的一句原因。
 *
 * 存在的理由：升 fire_pack 版本需要 worker bundle 和前端一起動，而設置頁的版本門檻讀的是
 * **上游 amsg-server 庫**的版本號——只改 SullyOS 自己的 worker 代碼時那個號不動，門檻不會亮。
 * 沒有這句話的話，用戶忘了重貼 bundle 時看到的只有「格式不對或數據損壞」，完全不知道該做什麼。
 */
export const describeFirePackVersion = (value: string): string => {
  let v: unknown;
  try { v = JSON.parse(value)?.v; } catch { return '不是合法 JSON（數據損壞）'; }
  if (v === FIRE_PACK_VERSION) return '版本號對得上，是別的字段不合格式（數據損壞）';
  if (typeof v === 'number' && v < FIRE_PACK_VERSION) {
    return `包是 v${v}、worker 要 v${FIRE_PACK_VERSION} —— 前端比 worker 舊，打開一次網頁讓它重新上傳`;
  }
  if (typeof v === 'number') {
    return `包是 v${v}、worker 只認 v${FIRE_PACK_VERSION} —— worker bundle 是舊的，去設置頁重新粘貼部署`;
  }
  return '包裡沒有版本號（數據損壞）';
};

/**
 * 一條消息的正文合不合格：純文本，或者非空的分段數組、每段帶一個字符串 `type`。
 *
 * 只查到 `type` 為止：再往裡查就是在這邊復刻 chat API 的方言，而這份代碼對分段
 * 的內容沒有任何主張——它只保證「搬過去的東西還是個消息」。
 */
const chatContentOk = (content: unknown): boolean => {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => !!part && typeof part === 'object' && !Array.isArray(part)
    && typeof (part as { type?: unknown }).type === 'string');
};

/** chat 字段：不帶就是沒開即時對話（合法）；帶了就必須是完整形狀。 */
const chatFieldOk = (chat: unknown): boolean => {
  if (chat === undefined) return true;
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return false;
  const { messages, builtAt } = chat as Partial<AmsgFirePackChat>;
  return typeof builtAt === 'number'
    && Array.isArray(messages) && messages.length > 0
    && messages.every((m) => !!m && typeof m === 'object'
      && typeof (m as { role?: unknown }).role === 'string'
      && chatContentOk((m as { content?: unknown }).content));
};

/** worker 側從 client_state 讀回的 value 解析成 fire_pack；形狀不對返回 null（調用方拋錯）。 */
export const parseFirePack = (value: string): AmsgFirePack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' &&
      parsed.v === FIRE_PACK_VERSION &&
      chatFieldOk(parsed.chat) &&
      typeof parsed.template === 'string' && parsed.template.length > 0 &&
      (parsed.lastUserMessageAt === null || typeof parsed.lastUserMessageAt === 'number') &&
      typeof parsed.tzId === 'string' && parsed.tzId.length > 0 &&
      typeof parsed.userTzId === 'string' && parsed.userTzId.length > 0 &&
      typeof parsed.targetName === 'string' &&
      typeof parsed.builtAt === 'number' &&
      Array.isArray(parsed.pendingTasks) &&
      (parsed.scene === null || typeof parsed.scene === 'object') &&
      (parsed.maxUnansweredSends === undefined
        || (typeof parsed.maxUnansweredSends === 'number'
          && Number.isFinite(parsed.maxUnansweredSends)
          && parsed.maxUnansweredSends >= 0)) &&
      typeof parsed.selfScheduleEnabled === 'boolean'
    ) {
      return parsed as AmsgFirePack;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};
