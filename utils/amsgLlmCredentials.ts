/**
 * 主動消息 2.0 的「LLM 憑據引用」（credRefs）：本地這一側的命名、取值與變更偵測。
 *
 * 過去每條排程任務的載荷裡都凍結一份 apiUrl / apiKey / primaryModel。換一次 Key 就得
 * 把待觸發的任務逐條 PUT 回去，漏一條到點就是 401；角色在 fire 裡給自己排的任務客戶端
 * 根本夠不著，舊 Key 順著自排鏈一直傳下去。
 *
 * 現在憑據單獨存一張表（worker 的 `llm_credentials`），任務只帶一個名字（credId）。
 * 到點由 worker 按名字現讀，所以**換 Key 只要覆蓋那一行**，已排的任務——包括角色自排的
 * 那些——下一次觸發用的就是新憑據，任務行一個字都不用改。
 *
 * 這份文件只做三件不聯網的事：
 *   1. 起名（credId 的唯一出處，見下面三種用途）；
 *   2. 按當前配置算出每一行該是什麼值；
 *   3. 記一份「上次傳上去的是什麼」的指紋底帳，好讓上傳只在真的變了的時候發生。
 *
 * 聯網那半截在 activeMsgClient（排程 / 即時對話前的確保上傳）和 amsgStateSync
 * （改配置後的後台補傳，退避 + 底帳那一套跟 tool_config 共用同一個套路）。
 */

import type { APIConfig, ActiveMsg2CharacterConfig, CharacterProfile } from '../types';

/** 憑據行的值：三個字段全必填，服務端只查非空、不做格式校驗。 */
export interface LlmCredentialValue {
  apiUrl: string;
  apiKey: string;
  primaryModel: string;
}

/** 一行憑據 = 名字 + 值。 */
export interface LlmCredentialRow {
  credId: string;
  value: LlmCredentialValue;
}

/**
 * worker 支持「憑據存表、任務帶引用」這件事的能力位（GET /capabilities 的 features）。
 * 名字由上游 amsg-server 定義，這裡只認它。
 */
export const LLM_CREDENTIALS_FEATURE = 'llm-credentials';

/**
 * 這台 worker 走不走 credRefs 這條路——**整個前端只在這裡判一次**。
 *
 * 探不到 / 老 worker 一律 false，那一檔原樣走「憑據內聯進任務」的老路。主動消息 2.0
 * 已經對所有人開放，舊 worker 是真實存在的運行時狀態，不是開發期的兼容債。
 */
export const supportsLlmCredentials = (features: string[] | null | undefined): boolean =>
  Array.isArray(features) && features.includes(LLM_CREDENTIALS_FEATURE);

/**
 * 聊天補全的完整地址。任務行裡存的是這個終點地址，不是用戶填的 baseUrl。
 * 排程、即時對話、憑據行三處必須同一份算法，所以放在這裡當唯一出處。
 */
export const normalizeChatApiUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

/**
 * 一個角色名下的三種憑據。**引用一經寫進任務就不再改**，配置變了只覆蓋行的值。
 *
 *   chat     定時主動消息用的那份（角色開了「單獨 API」就是單獨那份，否則是全局聊天 API）
 *   instant  即時對話用的那份（= 本地生成那一輪真正會用的憑據，含 -thinking 後綴之類的
 *            當輪終值）。和 chat 分開是因為兩者本來就可能不是同一個模型：開了單獨 API
 *            的角色，主動消息走單獨 API，而用戶按下發送的這一句必須還由聊天那個模型來答。
 *   emotion  即時對話那一輪的情緒評估（副 API；沒單獨配就回落到全局聊天 API）
 *   memory   記憶宮殿的後台活兒（門牌整理這類）。用的是記憶宮殿副 API
 *            （memoryPalaceConfig.lightLLM），跟上面三份都不是同一個——它現在是全局
 *            一份配置，但照舊按角色存一行：刪角色時跟著一起清，將來真做成分角色也不用動。
 */
export type LlmCredentialPurpose = 'chat' | 'instant' | 'emotion' | 'memory';

export const ALL_CREDENTIAL_PURPOSES: readonly LlmCredentialPurpose[] = ['chat', 'instant', 'emotion', 'memory'];

/** 角色名下某個用途的 credId。上游只當它是不透明字符串（1–128 字符、不含控制字符）。 */
export const charCredId = (charId: string, purpose: LlmCredentialPurpose): string =>
  `char:${charId}/${purpose}`;

/** 這個角色名下全部可能的 credId（刪角色時按它清雲端那幾行）。 */
export const charCredIds = (charId: string): string[] =>
  ALL_CREDENTIAL_PURPOSES.map((purpose) => charCredId(charId, purpose));

/** 把 credId 拆回「哪個角色、什麼用途」；不認識的形狀返回 null。 */
export const parseCharCredId = (
  credId: string,
): { charId: string; purpose: LlmCredentialPurpose } | null => {
  const m = /^char:(.+)\/(chat|instant|emotion|memory)$/.exec(credId || '');
  return m ? { charId: m[1], purpose: m[2] as LlmCredentialPurpose } : null;
};

/** 三件套齊了才是一行能用的憑據（缺一樣 worker 到點也發不出請求）。 */
export const isUsableCredentialValue = (
  value: Partial<LlmCredentialValue> | null | undefined,
): value is LlmCredentialValue =>
  !!value && !!value.apiUrl && !!value.apiKey && !!value.primaryModel;

/** 用戶填的 { baseUrl, apiKey, model } → 憑據行的值。缺字段時返回 null，由調用方決定怎麼辦。 */
export const toCredentialValue = (
  api: { baseUrl?: string; apiKey?: string; model?: string } | null | undefined,
): LlmCredentialValue | null => {
  if (!api?.baseUrl || !api.model) return null;
  const value = {
    apiUrl: normalizeChatApiUrl(api.baseUrl),
    apiKey: api.apiKey || '',
    primaryModel: api.model,
  };
  return isUsableCredentialValue(value) ? value : null;
};

/**
 * 定時主動消息那一行的值：角色開了「單獨 API」就用單獨那份，否則用全局聊天 API。
 * 算法與排程時的 resolveApiConfig 同一份口徑——憑據行絕不能把單獨 API 的角色寫成全局憑據。
 * 配不齊（多半是單獨 API 缺字段）返回 null。
 */
export const buildCharChatCredRow = (
  char: Pick<CharacterProfile, 'id'>,
  config: ActiveMsg2CharacterConfig | undefined,
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
): LlmCredentialRow | null => {
  const useSecondary = !!(config?.useSecondaryApi && config.secondaryApi?.baseUrl);
  const source = useSecondary ? config!.secondaryApi! : apiConfig;
  const value = toCredentialValue(source);
  return value ? { credId: charCredId(char.id, 'chat'), value } : null;
};

/**
 * 即時對話那一行的值：調用方給的就是本地生成這一輪真正會發出去的那份
 * （baseUrl / apiKey 取 effectiveApi，model 取請求體終值——claude 系開思考時會帶 -thinking 後綴）。
 */
export const buildCharInstantCredRow = (
  charId: string,
  api: { baseUrl?: string; apiKey?: string; model?: string },
): LlmCredentialRow | null => {
  const value = toCredentialValue(api);
  return value ? { credId: charCredId(charId, 'instant'), value } : null;
};

/**
 * 情緒評估那一行的值：角色單獨配了情緒 API 就用它，否則回落到全局聊天 API
 * ——回落口徑與本地評估那條路（useChatAI 的 emotionApi）一致。
 */
export const buildCharEmotionCredRow = (
  charId: string,
  emotionApi: { baseUrl?: string; apiKey?: string; model?: string } | null | undefined,
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
): LlmCredentialRow | null => {
  const source = emotionApi?.baseUrl ? emotionApi : apiConfig;
  const value = toCredentialValue(source);
  return value ? { credId: charCredId(charId, 'emotion'), value } : null;
};

/**
 * 記憶宮殿後台活兒那一行的值：記憶宮殿副 API（memoryPalaceConfig.lightLLM）。
 *
 * **不回落到全局聊天 API**——本地那條路也不回落（記憶宮殿 App 的手動按鈕在副 API 沒配時
 * 直接報錯），拿主 API 悄悄跑一遍後台整理會把用戶的主 API 額度花在他沒同意的地方。
 * 沒配就返回 null，調用方據此不走雲端、留在本地按原來的規矩處理。
 */
export const buildCharMemoryCredRow = (
  charId: string,
  lightLLM: { baseUrl?: string; apiKey?: string; model?: string } | null | undefined,
): LlmCredentialRow | null => {
  if (!lightLLM?.baseUrl || !lightLLM.apiKey) return null;
  const value = toCredentialValue(lightLLM);
  return value ? { credId: charCredId(charId, 'memory'), value } : null;
};

// ─── 「傳過沒有、變了沒有」的指紋底帳 ───
//
// 憑據本體絕不落 localStorage（那等於把 apiKey 又抄一份到別的地方）。這裡只記一個
// 指紋：值沒變就不重傳，省掉每次排程 / 每條消息一次多餘的 PUT。指紋只用來比對相等，
// 不做任何安全用途，所以一個普通的字符串散列就夠。

export const AMSG2_CRED_FINGERPRINT_LS_KEY = 'amsg2_llm_cred_fingerprints';

/** FNV-1a 32 位 + 長度後綴。夠區分「換了 Key / 換了模型」，不用於任何安全判定。 */
export const fingerprintCredentialValue = (value: LlmCredentialValue): string => {
  const text = `${value.apiUrl}\0${value.apiKey}\0${value.primaryModel}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}.${text.length.toString(36)}`;
};

type FingerprintLedger = Record<string, string>;

export const readCredFingerprints = (): FingerprintLedger => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG2_CRED_FINGERPRINT_LS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FingerprintLedger = {};
    for (const [credId, fp] of Object.entries(parsed)) {
      if (typeof fp === 'string') out[credId] = fp;
    }
    return out;
  } catch {
    // 讀不出來就當「一行都沒傳過」：多傳一次是冪等的，比漏傳安全。
    return {};
  }
};

const writeCredFingerprints = (ledger: FingerprintLedger) => {
  // 存儲滿 / 隱私模式寫不進去就算了：底帳只是省請求的，寫不進去頂多每次都重傳。
  try {
    if (Object.keys(ledger).length === 0) localStorage.removeItem(AMSG2_CRED_FINGERPRINT_LS_KEY);
    else localStorage.setItem(AMSG2_CRED_FINGERPRINT_LS_KEY, JSON.stringify(ledger));
  } catch { /* 見上 */ }
};

/** 這幾行裡，雲端那份跟現在算出來的不一樣（或者壓根沒傳過）的那些。 */
export const pickChangedCredRows = (
  rows: LlmCredentialRow[],
  ledger: FingerprintLedger = readCredFingerprints(),
): LlmCredentialRow[] =>
  rows.filter((row) => ledger[row.credId] !== fingerprintCredentialValue(row.value));

/** 記下「這幾行已經傳上去了」。 */
export const rememberCredRows = (rows: LlmCredentialRow[]): void => {
  if (rows.length === 0) return;
  const ledger = readCredFingerprints();
  for (const row of rows) ledger[row.credId] = fingerprintCredentialValue(row.value);
  writeCredFingerprints(ledger);
};

/** 把這幾行從底帳裡劃掉（雲端刪了 / 傳出去的那份作廢了，下次必須重傳）。 */
export const forgetCredIds = (credIds: string[]): void => {
  if (credIds.length === 0) return;
  const ledger = readCredFingerprints();
  let changed = false;
  for (const credId of credIds) {
    if (credId in ledger) { delete ledger[credId]; changed = true; }
  }
  if (changed) writeCredFingerprints(ledger);
};

/** 整本底帳清掉（清空雲端數據之後雲端一行都不剩，本地這份帳也就作廢了）。 */
export const forgetAllCredIds = (): void => writeCredFingerprints({});

/** 底帳裡現在記著哪些 credId（後台補傳按它決定要重算哪幾行）。 */
export const knownCredIds = (): string[] => Object.keys(readCredFingerprints());

/** 上游單批 PUT 的上限，超了要自己切片。 */
export const CRED_PUT_BATCH_MAX = 100;

export const chunkCredRows = (rows: LlmCredentialRow[], size = CRED_PUT_BATCH_MAX): LlmCredentialRow[][] => {
  const out: LlmCredentialRow[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};
