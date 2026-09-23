/**
 * 即時對話的雲端情緒評估。
 *
 * 用戶按下發送那一刻，前端把「評估提示詞模板 + 副 API 憑據」一起交給雲端；這一輪的
 * 主回覆在 worker 裡生成，情緒評估也在這裡跑完，結果隨最後一條推送回去。發完就能關
 * 頁面——過去評估是在瀏覽器裡 fire-and-forget 跑的，頁面一關情緒底色就停更了。
 *
 * 模板是前端用 `buildEmotionEvalPrompt(..., includeContext=false, ...)` 生成的：兩段
 * 大文本（角色的 system prompt、完整對話歷史）留成佔位符，由本次請求已有的 chat 段
 * 還原回原位。這樣上下文不必在請求體裡重複發一份，輸出又與本地逐字對齊。
 *
 * 還原規則必須與前端生成模板時的約定**逐字同款**——格式一漂輸出就變味。內核放在
 * utils/emotionEvalCore.ts 這份零依賴葉子裡；這裡只留 amsg 側特有的部分（評估配置的
 * 摘取與紅線處理、旁路存儲鍵）。
 *
 * 失敗絕不連累主回覆——用戶等的是那句話，情緒只是附贈；跑掛了就帶一句短原因回去，
 * 讓客戶端能照實說明白，而不是丟一句「可查 worker 日誌」。
 *
 * 零瀏覽器依賴（這份代碼會被打進 worker bundle）。
 */

import {
  EMOTION_EVAL_TIMEOUT_MS,
  requestEmotionEval,
  restoreEvalPrompt as coreRestoreEvalPrompt,
  type EmotionEvalOutcome,
} from '../../../utils/emotionEvalCore';

/** 副 API 憑據的兩種長相：任務裡內聯的 { baseUrl, apiKey, model }，或憑據表裡的三件套。 */
export interface AmsgEmotionEvalApi {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 前端塞進任務 metadata.amsgEmotionEval 的那份評估配置。 */
export interface AmsgEmotionEvalSpec {
  /** 帶兩個佔位符的評估提示詞模板。 */
  prompt: string;
  /**
   * 副 API 憑據（沒單獨配就是主 API 那一份）。
   *
   * 支持憑據表的 Worker 上這裡是空的——憑據存在 `llm_credentials` 裡，任務只帶
   * `credRefs.emotion` 這個名字，到點由 `ctx.resolveLlmCredential` 現讀（見
   * resolveEmotionEvalApi）。換 Key 只要覆蓋那一行，任務一個字都不用改。
   * 還帶著它的是老 Worker 建的任務，或舊版前端排的存量任務，照舊直接用。
   */
  api?: AmsgEmotionEvalApi;
}

/** fire 時按名字取一行憑據（上游 amsg-server 2.6.0-next.17+ 掛在 hook ctx 上）。 */
export type ResolveLlmCredential = (
  credId: string,
) => Promise<{ apiUrl: string; apiKey: string; primaryModel: string } | null>;

/**
 * 這一輪評估用哪份副 API 憑據。
 *
 * 順序：任務裡內聯的那份優先（存量任務只有這一份），沒有才按 `credRefs.emotion` 去表裡現讀。
 * 兩條都取不到就返回 null——調用方據此跳過評估，主回覆照發（評估從來不連累正文）。
 *
 * 憑據表裡存的是 `apiUrl`（已經是 /chat/completions 那個終點地址），而評估請求走的是
 * requestEmotionEval 那套 `{ baseUrl }` 口徑——它自己會補 /chat/completions，所以這裡
 * 把末尾那一段摘掉再交出去，兩條路發出去的地址才一模一樣。
 */
export const resolveEmotionEvalApi = async (
  spec: AmsgEmotionEvalSpec,
  credRefs: Record<string, unknown> | undefined | null,
  resolveLlmCredential: ResolveLlmCredential | undefined,
): Promise<AmsgEmotionEvalApi | null> => {
  if (spec.api?.baseUrl && spec.api.model) return spec.api;
  const credId = credRefs && typeof credRefs === 'object' && !Array.isArray(credRefs)
    ? (credRefs as Record<string, unknown>).emotion
    : undefined;
  if (typeof credId !== 'string' || !credId || typeof resolveLlmCredential !== 'function') return null;
  let resolved: Awaited<ReturnType<ResolveLlmCredential>> = null;
  try {
    resolved = await resolveLlmCredential(credId);
  } catch (error) {
    console.warn('[amsg:emotion] 憑據讀不出來，這一輪不評估（主回覆不受影響）', error);
    return null;
  }
  if (!resolved?.apiUrl || !resolved.primaryModel) return null;
  return {
    baseUrl: resolved.apiUrl.replace(/\/chat\/completions\/*$/i, ''),
    apiKey: resolved.apiKey || '',
    model: resolved.primaryModel,
  };
};


/**
 * 評估結果太大、一條 push 裝不下時的旁路存儲鍵（同 XHS 那套，見 amsgXhsSessionKey）。
 * push 裡只留 `metadata.amsgEmotionRef` 指過來，客戶端按鍵取回、用完即刪。
 * 每任務固定一份、下次觸發覆蓋，所以沒人來取也有上限，不需要額外的過期清理。
 */
export const amsgEmotionUpdateKey = (clientTaskId: string) => `emotion_update:${clientTaskId}`;

/**
 * 這份配置能不能用來發請求。
 *
 * 提示詞是硬要求；憑據兩種給法認一種就行——內聯三件套（存量任務 / 老 Worker），
 * 或者整個不帶 api、由 `credRefs.emotion` 到點現讀（見 resolveEmotionEvalApi）。
 * 帶了 api 卻配不齊的那種一律判不可用（那份發不出去），和以前一樣。
 */
const isUsableEvalSpec = (spec: unknown): spec is AmsgEmotionEvalSpec => {
  const s = spec as AmsgEmotionEvalSpec | undefined;
  if (!s || typeof s.prompt !== 'string' || !s.prompt) return false;
  if (s.api === undefined || s.api === null) return true;
  return typeof s.api.baseUrl === 'string' && !!s.api.baseUrl
    && typeof s.api.model === 'string' && !!s.api.model;
};

/**
 * 從要交給推送的 metadata 裡摘掉評估配置。**紅線**：它裡頭是用戶副 API 的 apiKey。
 *
 * 任務 metadata 走的是端到端加密的信封，放在那兒是安全的；而推送 payload 出了這台
 * worker 就歸推送服務管了，憑據跟著走等於把用戶的副 API 送人。組 push 的那一層
 * （agentic 的 buildScheduledPush）把 metadata 整個攤開帶走，所以只能在喂進去之前摘。
 */
export const stripEmotionEvalSpec = (
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> => {
  const { amsgEmotionEval: _secret, ...rest } = (metadata ?? {}) as Record<string, unknown>;
  return rest;
};

/**
 * 取出任務 metadata 裡那份評估配置，**並就地從這個對象上刪掉**（沒有 / 不完整時返回 null，
 * 鍵照刪——不完整的那份同樣帶著 apiKey）。
 *
 * 為什麼是「取完就刪」而不是只讀：上游把解密後的 payload.metadata 按引用一路傳下去——
 * `buildHookTask` 只做淺拷貝（`Object.freeze` 也只凍最外層），`onLLMOutput` 的
 * `ctx.metadata`、以及**沒有 hook 接手時那條模板路徑**讀的都是同一個對象，而模板路徑
 * 裡 `push.metadata = args.metadata` 是直接引用賦值。也就是說，只要 `onBeforeFire`
 * 哪天在某個分支返回了 undefined（上游據此判「這次 hook 不接」），整份解密 metadata
 * 連副 API 的 apiKey 一起就會被塞進每一條推送。
 *
 * 在捕獲點就地刪掉，那條路徑便無從可漏：這一跳的內存對象里根本沒有這個鍵了。
 * D1 裡的 encrypted_payload 一個字節沒動，投遞失敗重跑時會重新解密出完整的一份，
 * 所以重試那一輪照樣評估得了。
 *
 * 組 push 之前還有第二道 `stripEmotionEvalSpec`——兩道都留著，別因為「上面已經刪過」
 * 把哪一道拆了。
 */
export const takeEmotionEvalSpec = (
  metadata: Record<string, unknown> | undefined | null,
): AmsgEmotionEvalSpec | null => {
  const bag = metadata as Record<string, unknown> | undefined | null;
  if (!bag || typeof bag !== 'object') return null;
  const spec = bag.amsgEmotionEval;
  if (spec === undefined) return null;
  try {
    delete bag.amsgEmotionEval;
  } catch (error) {
    // 上游哪天把 metadata 也凍上了（嚴格模式下 delete 凍結屬性會拋）。縱深防禦的這一層
    // 自己絕不能變成故障源——記一筆就走，組 push 之前那道 strip 仍然攔得住。
    console.warn('[amsg:emotion] 評估配置刪不掉（metadata 被凍結？），只剩組 push 前那道防線', error);
  }
  return isUsableEvalSpec(spec) ? spec : null;
};

// 佔位符還原 / 打碼 / 請求內核在 utils/emotionEvalCore.ts。
// re-export 保住既有導入點（本文件歷史上就是它們的家）。
export { restoreEvalPrompt } from '../../../utils/emotionEvalCore';

/** 一次評估的結局：拿到原文，或者一句能給用戶看的短失敗原因。 */
export type AmsgEmotionEvalOutcome = EmotionEvalOutcome;

/**
 * 正文寫完之後，最多再給情緒評估這麼久搭上這班車。用在 index.ts 的 raceEmotionEval。
 *
 * 評估在 onBeforeFire 就跟主生成並行起跑了，正常情況下走到收尾時早就回來了，這個窗口
 * 一秒都用不上；它管的是副 API 限流 / 掛起的那種時候。評估自己的超時是 120 秒
 * （EMOTION_EVAL_TIMEOUT_MS），死等的話用戶會對著「正在輸入…」多看兩分鐘——同一句話走
 * 本地路徑十秒就上屏了；工具循環吃掉大半預算時，這兩分鐘還會把整輪 600 秒的預算頂穿，
 * fire 失敗重跑，用戶拿到的是一句失敗說明而不是那條已經寫好的回覆。
 *
 * 取捨：回覆優先，情緒讓路。沒趕上的評估不作廢：push 上掛引用鍵 + pending 標記
 * （客戶端那盞「情緒更新中」繼續亮著），收尾 hook（amsgFireSettled，上游會 await 它）
 * 接著等評估出結果，寫進旁路存儲（amsgEmotionUpdateKey），客戶端對著引用鍵輪詢補落
 * ——對齊本地路徑「評估慢是晚到，不是丟棄」的語義。評估自帶 EMOTION_EVAL_TIMEOUT_MS，
 * 這段續等是有界的。
 *
 * 放在這個文件而不是 index.ts：Worker 入口模塊的具名導出會被 workerd 當成「命名入口點」
 * （Durable Object / WorkerEntrypoint 類就是靠這個認的），只接受函數和類。從入口導出一個
 * 數字，整個 Worker 起不來——報的是 `Incorrect type for map entry '<導出名>'`。
 * 入口只能導出函數，常量一律住在別的模塊裡。見 index.test.ts 的同名迴歸守衛。
 */
export const EMOTION_EVAL_RIDE_ALONG_MS = 10_000;

/**
 * 跑一次評估。成功給原文（解析交給客戶端的 applyEmotionEvalRaw，與本地路徑共用同一套
 * 容錯），失敗給一句短原因——它會跟著「評估有結論了」的信號回到客戶端，替掉過去那句
 * 「可查 worker 日誌」。用戶自己部署的 worker，日誌不是人人都會看。
 *
 * `chatMessages` 要傳**主生成真正看到的那一串**（含末尾追加的時效塊），
 * 少了那一塊評估模型連現在幾點都不知道，判出來的情緒會對不上角色剛說的話。
 */
export const runAmsgEmotionEval = async (
  spec: AmsgEmotionEvalSpec,
  /** 這一輪用哪份副 API——由 resolveEmotionEvalApi 從內聯憑據或憑據表裡取好再傳進來。 */
  api: AmsgEmotionEvalApi,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
  timeoutMs: number = EMOTION_EVAL_TIMEOUT_MS,
): Promise<AmsgEmotionEvalOutcome> =>
  requestEmotionEval(api, coreRestoreEvalPrompt(spec.prompt, chatMessages, charName), timeoutMs);
