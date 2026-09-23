/**
 * 非聊天任務的通用約定（環境無關葉子模塊）
 *
 * 主動消息 2.0 的調度器本來只跑一種任務：到點給用戶說句話。現在還要跑一批**不說話**的
 * 後台活兒——整理一份數據、跑一次總結、算一份報告。它們跟聊天任務共用同一套調度
 * （cron 每分鐘 + 租約 + 心跳 + 分組串行 + 重試退避 + 時區感知的循環），只是到點之後
 * 做的事不一樣。
 *
 * 這份文件定的是「怎麼把這兩類任務分開」：任務上怎麼標種類、一次性輸入放在雲端哪個
 * 抽屜、以及這些任務在用戶的任務清單裡怎麼不露臉。具體某一種任務長什麼樣，各自另開
 * 一份契約（第一個是 amsgPlateJob.ts）。
 *
 * 往這裡加代碼前先確認：不 import 任何帶瀏覽器依賴的模塊（db / safeApi / context 等）。
 * `pnpm build:workers` 會把這份打進 amsg worker bundle，帶進瀏覽器依賴會在構建期直接暴露。
 */

// ─── 任務種類 ─────────────────────────────────────────

/**
 * 任務 metadata 上標業務種類的鍵。
 *
 * 到點觸發只有 `onBeforeFire` 一個入口，所有任務都從那兒進；worker 靠這個鍵把
 * 「後台整理一份數據」和「到點給用戶說句話」分開，各走各的 handler
 * （見 worker/amsg/src/fireKinds.ts）。沒有這個鍵的就是聊天任務，照舊走原來那條路
 * ——所有存量任務都落在這一檔。
 *
 * 跟 amsgMode / amsgExpirePolicy 這些一樣帶 amsg 前綴：metadata 是各方共用的口袋，
 * 光叫 kind 太容易跟別人撞名。
 */
export const AMSG_TASK_KIND_KEY = 'amsgKind';

/** 讀出任務的業務種類；沒標就是 null（= 聊天任務）。 */
export const readTaskKind = (metadata: Record<string, unknown> | null | undefined): string | null => {
  const raw = metadata?.[AMSG_TASK_KIND_KEY];
  return typeof raw === 'string' && raw ? raw : null;
};

/**
 * 後台任務行的 `messageSubtype`。
 *
 * 任務清單跟遠端對帳時靠它把這些行擋在外面：它們不是用戶排的主動消息，進了清單會顯示
 * 成「待觸發的任務」，還可能被「取消全部」順手掐掉。跟即時對話那個 subtype 一個道理。
 */
export const AMSG_BACKGROUND_JOB_SUBTYPE = 'job';

// ─── 一次性輸入的雲端抽屜 ─────────────────────────────

/**
 * 後台任務的一次性輸入存放的 client_state 命名空間。
 *
 * 跟角色狀態（`amsg:char:<id>` 裡的 fire_pack / tool_pack）分開放，因為這裡的東西是
 * **一次性**的：跑完就沒人再回來看，也沒人回來刪。worker 的 config 給這個命名空間配了
 * `clientStateTtl`，cron 每跳順手把過期的清掉——角色狀態那邊是要長期留著的，不能跟它
 * 共用一個命名空間，否則 TTL 會把 fire_pack 一起清了。
 */
export const AMSG_JOB_NAMESPACE = 'amsg:job';

/** 一次性輸入在雲端留幾天。夠重試幾輪，又不至於攢著白佔庫。 */
export const AMSG_JOB_TTL_DAYS = 3;

/** 任務 metadata 上放 job 編號的鍵（handler 靠它去抽屜裡取自己那份輸入）。 */
export const AMSG_JOB_ID_KEY = 'amsgJobId';
