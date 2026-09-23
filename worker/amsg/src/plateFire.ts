/**
 * 門牌整理任務在 worker 這一側。
 *
 * 客戶端把「現有條目 + 新材料 + 身份上下文」裝成一份 job 寫進 client_state，再建一條
 * 標了 `amsgKind: 'plate-consolidate'` 的任務。到點這裡把 job 讀回來拼提示詞，LLM 跑完
 * 把整理結果原樣送回客戶端——合併語義（basedOn 繼承來歷、沒被重新輸出的條目淘汰）留在
 * 客戶端做，因為要合併進去的門牌本體在瀏覽器的 IndexedDB 裡，雲端夠不著。
 *
 * 結果走 `ctx.emitResult`：落進服務端收件箱，客戶端下次上線 `GET /outbox?since=` 一定
 * 拿得到。刻意**不彈通知**（`notification: { show: false }`）——門牌整理是背景工作，
 * 整理完了不該把人叫回來看；帶 `show: false` 的 payload 上游只落行不推送，也就不會
 * 白佔一次推送配額（訂閱是按 userVisibleOnly 建的，收了 push 不彈通知瀏覽器要記帳）。
 */

import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE } from '../../../utils/amsgTaskKinds';
import {
  PLATE_CONSOLIDATE_RESULT_KIND,
  type PlateJobInput,
  buildPlateConsolidateResult,
  buildPlateJobMessages,
  parsePlateJobInput,
  plateJobKey,
} from '../../../utils/amsgPlateJob';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import { PLATE_LLM_TIMEOUT_MS, parsePlateLlmReply } from '../../../utils/memoryPalace/roomPlateCore';
import type { FireKindHandler, KindFireCtx, KindSessionCtx, KindWriteState } from './fireKinds';
import { logSkipDiagnostic } from './skipDiagnostics';

/** 跨到 onLLMOutput 的上下文。 */
export interface PlateFireState {
  jobId: string;
  job: PlateJobInput;
}

/**
 * 把 job 那行刪掉：它是一次性輸入，走完這一輪就再沒人會讀它。
 *
 * 兩種時機要刪：
 *   - **LLM 已經跑過之後**，不管結果好壞。這一輪無論成沒成，上游都把這條
 *     `recurrenceType: 'none'` 的任務當辦完了（skip-push 在上游是 `status: 'skipped'`
 *     的成功態），再沒有第二次機會來讀這行。
 *   - **beforeFire 認定這份輸入壞了/不對版的時候**。那幾種失敗是確定性的（解壓不出來、
 *     形狀對不上、charId 對不上號），重試梯子再跑兩遍也是同樣的結果，行留著純粹是佔地方。
 *     注意別把「讀進來到 LLM 跑完之間」的失敗也算進去——那種還會重試，重試時得再讀一遍。
 *
 * 不刪的話每次失敗都留一行孤兒，一行裝著一個角色的整塊門牌原文 + 蒸餾材料 + 身份上下文，
 * 在同一個共用命名空間裡跨角色越攢越多，而 beforeFire 每次後台 fire 都要把這個命名空間
 * 整個讀出來解密（上游沒有按 key 點名的接口）。
 *
 * 刪失敗只記日誌：命名空間上配了 clientStateTtl，cron 每跳會兜底清過期的。
 */
const discardJob = async (writeState: KindWriteState | undefined, jobId: string): Promise<void> => {
  if (!writeState) return;
  try {
    await writeState(AMSG_JOB_NAMESPACE, [{ key: plateJobKey(jobId), value: null }]);
  } catch (error) {
    console.warn('[amsg:plate] job 行沒刪掉（等 TTL 兜底）', jobId, error);
  }
};

export const plateConsolidateHandler: FireKindHandler = {
  async beforeFire({ ctx, charId, taskMeta }) {
    const jobId = taskMeta[AMSG_JOB_ID_KEY];
    if (typeof jobId !== 'string' || !jobId) {
      throw new Error(`門牌整理任務的 metadata 裡沒有 ${AMSG_JOB_ID_KEY}`);
    }

    // 只能整個命名空間讀回來再挑：`readState` 按 namespace 取，上游沒有按 key 點名的
    // 接口。同一角色同時只許一份整理在飛、跑完立刻刪行，所以這裡通常只有個位數條。
    const rows = await ctx.readState(AMSG_JOB_NAMESPACE);
    const row = rows.find((r) => r.key === plateJobKey(jobId));
    if (!row?.value) {
      // 行不在了 = 躺太久被 TTL 清了；行在但值是空的 = 客戶端主動撤了這份輸入（刪角色
      // 時會把它寫成空殼——HTTP 那側沒有刪除語義）。兩種都不是「壞了」，重試也不會長
      // 出來：安靜跳過，該重來的下一輪消化會重新提交一份。
      return { skip: true, reason: `門牌整理 job ${jobId} 的輸入已不在（過期或已撤銷）` };
    }

    // 下面這幾種失敗都是確定性的：重試再讀一遍還是同一份壞數據。所以認定的同時就把行
    // 刪掉，別讓它在共用命名空間裡躺滿 TTL——每一份都是一個角色的整塊門牌原文，而每次
    // 後台 fire 都要把整個命名空間讀出來解密才能挑出自己那一行。
    const discardAndFail = async (message: string): Promise<never> => {
      await discardJob(ctx.writeState, jobId);
      throw new Error(message);
    };

    // 上傳時壓過（gz1: 前綴），跟 fire_pack 同一套；沒壓過的原樣穿過去。
    let json: string;
    try {
      json = await unpackStateValue(row.value);
    } catch (error) {
      return discardAndFail(`門牌整理 job ${jobId} 的輸入解壓失敗（數據損壞）：${String(error)}`);
    }

    const job = parsePlateJobInput(json);
    if (!job) return discardAndFail(`門牌整理 job ${jobId} 的輸入解析失敗（數據損壞）`);
    if (job.charId !== charId) {
      return discardAndFail(`門牌整理 job ${jobId} 的 charId 與任務對不上`);
    }
    if (job.rooms.length === 0) {
      await discardJob(ctx.writeState, jobId);
      return { skip: true, reason: `門牌整理 job ${jobId} 沒有要整理的房間` };
    }

    return {
      messages: buildPlateJobMessages(job),
      // 跟瀏覽器那條路同一個超時（葉子裡那個常量）。不顯式交上去的話這一次 fire 會落到
      // 庫自己的默認值（四分鐘），同一件活兒兩條路的耐心不一樣，而且改那個常量對雲端
      // 毫無影響——「本地什麼樣雲端就什麼樣」這條線得自己拉齊。
      totalTimeoutMs: PLATE_LLM_TIMEOUT_MS,
      state: { jobId, job } satisfies PlateFireState,
    };
  },

  async llmOutput({ ctx, state }) {
    const { jobId, job } = state as PlateFireState;
    const items = parsePlateLlmReply(ctx.llmOutputText || '');

    if (items.length === 0) {
      // 一條都沒解析出來（模型跑偏 / 輸出被截斷）。不送空結果——客戶端收到空列表會
      // 按「LLM 決定清空」處理，把整塊門牌抹掉。什麼都不送，門牌保持不動，
      // 下一輪消化會重新提交一份新的 job 再整理。
      console.warn('[amsg:plate] LLM 沒返回有效條目，門牌保持不動', jobId);
      logSkipDiagnostic({
        sessionId: ctx.sessionId,
        reason: 'plate-empty-generation',
        iteration: ctx.iteration,
        llmResponse: ctx.llmResponse,
        llmOutputText: ctx.llmOutputText,
      });
      await discardJob(ctx.writeState, jobId);
      return { decision: 'skip-push', reason: 'plate-empty-generation' };
    }

    if (typeof ctx.emitResult !== 'function') {
      // 老部署（amsg-server < 2.6.0-next.21）沒有這個能力。整理白跑了，但說清楚原因，
      // 否則用戶只會看到「門牌一直不更新」而面板上一片正常。
      console.warn('[amsg:plate] 這台 worker 不支持 emitResult，整理結果送不回去', jobId);
      await discardJob(ctx.writeState, jobId);
      return { decision: 'skip-push', reason: 'plate-emit-result-unsupported' };
    }

    try {
      await ctx.emitResult({
        ...buildPlateConsolidateResult({ jobId, charId: job.charId, items, rooms: job.rooms }),
        // 背景工作，整理完不該把人叫回來看。show:false 的 payload 上游只落收件箱、
        // 不發推送，客戶端下次上線補收。
        notification: { show: false },
      });
    } catch (error) {
      // 方法在、調用卻炸了：收件箱那張表缺列/缺表（升級 worker 後不跑 init-tenant 就是
      // 這個樣子），或者上游自己判定不支持。拋出去的話這一輪算失敗，重試梯子會**再跑
      // 兩次完整生成**——LLM 已經燒過一次了，而下兩次註定同樣送不回來。所以就地收成
      // 跳過：這一輪整理白跑，但只白跑一次，門牌保持不動等下輪消化重來。
      console.warn('[amsg:plate] 整理結果送不進收件箱（多半是收件箱表沒建全，去設置頁點一次「重新連接並驗證」）', jobId, error);
      await discardJob(ctx.writeState, jobId);
      return { decision: 'skip-push', reason: 'plate-emit-result-failed' };
    }
    console.log('[amsg:plate] 整理結果已送進收件箱', {
      jobId, charId: job.charId, items: items.length, resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
    });

    await discardJob(ctx.writeState, jobId);
    return { decision: 'skip-push', reason: 'plate-result-emitted' };
  },
};

/** 只為單測導出：讓測試能不經 index.ts 直接喂一份 ctx。 */
export type { KindFireCtx, KindSessionCtx };
