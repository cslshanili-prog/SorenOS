/**
 * 雲端 client_state 的「刪行」：特性探測、旁路存儲的鍵前綴、存量空殼的判定與切批。
 *
 * worker 把一條 push 裝不下的大內容（思考鏈 / 情緒評估 / 小紅書會話）旁路存進角色的
 * client_state 命名空間，客戶端取回後把那一行清掉。amsg-server 2.6.0-next.27 起
 * `PUT /client-state` 認 `value: null` 表示刪掉這個 key（連大值的切片行一起），
 * 特性位是 `client-state-delete`；更老的 worker 收到 null 會按 INVALID_STATE_VALUE
 * 逐條拒掉，只能寫空串留一個幾字節的空殼。
 *
 * 這份文件只做不聯網的判斷，聯網那半截在 activeMsgClient（clearClientStateValue /
 * clearNamespaceValuesOrThrow / 存量空殼清理）。
 */

/** worker 認 `value: null` 刪行的能力位（GET /capabilities 的 features）。名字由上游定義，這裡只認它。 */
export const CLIENT_STATE_DELETE_FEATURE = 'client-state-delete';

/**
 * 這台 worker 認不認刪行。探不到 / 老 worker 一律 false，那一檔照舊寫空串。
 * 前端只在握手時判一次，之後讀全局配置裡的存量（見 activeMsgClient 的 isClientStateDeleteReady）。
 */
export const supportsClientStateDelete = (features: string[] | null | undefined): boolean =>
  Array.isArray(features) && features.includes(CLIENT_STATE_DELETE_FEATURE);

/**
 * 旁路存儲的三個鍵前綴。鍵名由各自的工廠函數拼出來（`<前綴><uuid>`），其中兩個在
 * worker 側、前端 import 不到，這裡抄一份字面量：
 *   reasoning:      思考鏈      worker/amsg/src/index.ts 的 amsgReasoningKey
 *   emotion_update: 情緒評估    worker/amsg/src/emotionEval.ts 的 amsgEmotionUpdateKey
 *   xhs_session:    小紅書會話  utils/amsgFirePack.ts 的 amsgXhsSessionKey
 * 那三處改了這裡要跟著改。
 */
export const AMSG_SIDECHANNEL_KEY_PREFIXES = ['reasoning:', 'emotion_update:', 'xhs_session:'] as const;

/** 這個鍵是不是旁路存儲的（按上面的前綴認）。 */
export const isSidechannelKey = (key: string): boolean =>
  AMSG_SIDECHANNEL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * 從一個命名空間讀回來的條目裡挑出旁路存儲的空殼：鍵帶上面的前綴、值是空串
 * （worker 認刪行之前，取回內容後寫空留下的那種）。
 *
 * 別的鍵一律不碰——fire_pack / self_log 這類長期狀態就算是空的也不歸這裡管，
 * 它們各有各的寫入時機，刪掉反而要等下一輪同步才補得回來。
 */
export const pickSidechannelShellKeys = (
  entries: ReadonlyArray<{ key?: unknown; value?: unknown }> | null | undefined,
): string[] => {
  const keys: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry?.key !== 'string') continue;
    if (!isSidechannelKey(entry.key) || entry.value !== '') continue;
    keys.push(entry.key);
  }
  return keys;
};

/** 上游一次 PUT /client-state 最多收的條目數（amsg-server 的 MAX_STATE_ENTRIES_PER_BATCH），超了要自己切片。 */
export const CLIENT_STATE_PUT_BATCH_MAX = 200;

/** 按單批上限把條目切成若干批（空數組切出來就是零批）。 */
export const chunkClientStateEntries = <T>(items: readonly T[], size = CLIENT_STATE_PUT_BATCH_MAX): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
};
