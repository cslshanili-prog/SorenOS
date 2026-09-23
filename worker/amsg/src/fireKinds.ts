/**
 * 按任務種類分派的註冊表。
 *
 * 到點觸發只有 `onBeforeFire` 一個入口，所有任務都從那兒進——聊天要發的、後台要整理的，
 * 全擠在同一個函數里。這裡立一張 `kind → handler` 的表把非聊天的那些接走，加一種新任務
 * 就是加一個文件 + 在表裡加一行，不用去動那條已經很長的聊天主幹。
 *
 * 分派點刻意排在聊天那四道門**之前**：那四道門問的都是「主動消息到點還該不該發」
 * （用戶正在聊天所以讓路 / 對話已經往前走所以作廢 / 這次任務的方向是什麼），對
 * 「後台整理一份數據」全都不適用；而且它們要的 fire_pack / tool_pack 是聊天專用的
 * 雲端狀態，後台任務根本沒傳過。
 *
 * 這裡只做業務分派，不該放上游——上游只需要知道「有個 hook」，不需要知道「有種任務
 * 叫門牌整理」。
 */

import { readTaskKind } from '../../../utils/amsgTaskKinds';
import { PLATE_CONSOLIDATE_KIND } from '../../../utils/amsgPlateJob';
import { plateConsolidateHandler } from './plateFire';

/** client_state 的寫入口（value 傳 null 即刪除該 key）。 */
export type KindWriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<{ upserted: number; skipped: number; deleted: number }>;

/**
 * handler 用得上的那部分 fire ctx。
 *
 * 結構化取一份而不是從 index.ts import FireCtx：那邊要 import 這裡的註冊表，
 * 反過來再 import 類型就成了循環。字段是 FireCtx 的子集，結構上天然兼容。
 */
export interface KindFireCtx {
  task: {
    id?: string | number | null;
    uuid?: string | null;
    metadata?: Record<string, unknown>;
  };
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  writeState?: KindWriteState;
  now: Date;
  scratch: Record<string, unknown>;
}

/** handler 用得上的那部分每輪 session ctx。 */
export interface KindSessionCtx {
  llmOutputText: string;
  /** 以下三項只給跳過診斷用（見 ./skipDiagnostics），上游每輪都會給。 */
  sessionId?: string;
  iteration?: number;
  llmResponse?: unknown;
  scratch?: Record<string, unknown>;
  writeState?: KindWriteState;
  /**
   * 往客戶端送一條**不是聊天內容**的結果（amsg-server 2.6.0-next.21+）。
   * 一條結果落進服務端收件箱（到達的保證）+ 視通知策略發一條 Web Push（及時性）。
   * 老部署上這個方法不存在——handler 自己判，別假設它在。
   */
  emitResult?: (payload: Record<string, unknown>) => Promise<{ messageId: string; pushed: boolean }>;
}

/** 到點這一步的結論：要麼安靜跳過，要麼給出這次要問 LLM 的話。 */
export type KindFirePlan =
  | { skip: true; reason: string }
  | {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      /** 跨到 onLLMOutput 的上下文，庫把它原樣掛在 scratch 上帶過去 */
      state: unknown;
      /** 這一次 fire 單獨放寬超時（要同步調 claimLeaseMs 的那個值，庫自己管） */
      totalTimeoutMs?: number;
    };

/** LLM 回來這一步的結論。非聊天任務不發聊天正文，所以只用得上 skip-push。 */
export type KindDecision = { decision: 'skip-push'; reason: string };

export interface FireKindHandler {
  /**
   * 到點：讀雲端狀態、拼這次要問 LLM 的話。
   * 出了「這條任務的數據壞了」這種硬失敗就拋——調用方會用統一那套 detail 包一層。
   */
  beforeFire(args: {
    ctx: KindFireCtx;
    charId: string;
    taskMeta: Record<string, unknown>;
  }): Promise<KindFirePlan>;

  /** LLM 回來：解析、把結果送回客戶端。 */
  llmOutput(args: { ctx: KindSessionCtx; state: unknown }): Promise<KindDecision>;
}

/**
 * `metadata.amsgKind` → handler。沒標 kind 的任務不查這張表，照舊走聊天主幹。
 * 表裡沒有的 kind 是硬失敗：客戶端建了一種 worker 還不認識的任務，多半是 worker bundle
 * 比前端舊，寧可讓這條任務終態失敗，也別當聊天任務跑出一條驢唇不對馬嘴的消息。
 *
 * 這類失敗在用戶那邊是**靜默**的：後台任務行按 messageSubtype 擋在主動消息清單之外
 * （那是有意的，它們不是用戶排的消息，進了清單還會被「取消全部」順手掐掉），所以
 * lastError 沒有露臉的地方，只能在 `wrangler tail` 裡看到。判定「這一輪活兒要不要交
 * 雲端」的責任因此落在客戶端那道探測門上（`GET /config-check` 的 `backgroundJobs`）：
 * 它認的是「這份 bundle 裡有沒有這張表」，認不出來就留在本地跑，壓根不建這條任務。
 * 走到這裡的失敗一律是「白跑一輪」量級——下一輪消化會重新提交一份。
 *
 * 表用**沒有原型的對象**建：kind 是從任務 metadata 上讀出來的字符串，普通對象字面量
 * 會把 `constructor` / `toString` / `valueOf` 這些原型鏈上的鍵解析成一個真值，繞過下面
 * 那句「表裡沒有這個 kind」的判斷，最後炸在 `handler.beforeFire is not a function` 上——
 * 而那句報錯跟真正的原因（這台 worker 不認識這種任務）毫無關係，排障要多繞一大圈。
 */
export const FIRE_KIND_HANDLERS: Record<string, FireKindHandler> = Object.assign(
  Object.create(null) as Record<string, FireKindHandler>,
  { [PLATE_CONSOLIDATE_KIND]: plateConsolidateHandler },
);

/** 掛在 scratch 上跨 hook 傳遞的鍵。 */
const KIND_FIRE_SCRATCH_KEY = 'kindFire';

interface KindFireStash {
  kind: string;
  state: unknown;
}

export const putKindFireStash = (scratch: Record<string, unknown>, kind: string, state: unknown): void => {
  scratch[KIND_FIRE_SCRATCH_KEY] = { kind, state } satisfies KindFireStash;
};

/** onLLMOutput 用它判「這一輪是不是非聊天任務」；不是就返回 null，照舊走聊天主幹。 */
export const getKindFireStash = (scratch: Record<string, unknown> | undefined): KindFireStash | null => {
  const raw = scratch?.[KIND_FIRE_SCRATCH_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const stash = raw as Partial<KindFireStash>;
  return typeof stash.kind === 'string' ? { kind: stash.kind, state: stash.state } : null;
};

export { readTaskKind };
