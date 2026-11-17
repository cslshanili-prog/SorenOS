/**
 * 日程自動生成在 worker 這一側（plans/calendar.md 第 5 批）。
 *
 * 標了 `amsgKind: 'schedule-generate'` 的循環任務（每天一次，角色那邊 20:00 或 00:30）。到點把
 * standing job（`schedule:<charId>`）讀回來、算目標日、挑那天的段拼提示詞，LLM 跑完把 JSON 原樣送回客戶端
 * （落庫在客戶端做：日程表和約定層都在 IndexedDB）。跟門牌不同，job 行**不刪**——它是每天都要用的。
 *
 * 結果走 `ctx.emitResult`，不彈通知：排好明天的日程不該把人叫回來看。
 */

import { AMSG_JOB_NAMESPACE } from '../../../utils/amsgTaskKinds';
import {
  SCHEDULE_GENERATE_RESULT_KIND, type ScheduleJobInput,
  buildScheduleGenerateResult, buildScheduleJobMessages, extractScheduleJson, parseScheduleJobInput, scheduleJobKey, scheduleJobTargetDay,
} from '../../../utils/amsgScheduleJob';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import { SCHEDULE_LLM_TIMEOUT_MS } from '../../../utils/schedulePromptCore';
import type { FireKindHandler } from './fireKinds';
import { logSkipDiagnostic } from './skipDiagnostics';

/** standing job 太久沒刷新就不排：客戶端幾天沒上線，裡面的約定和待辦早過時了 */
const JOB_STALE_MS = 10 * 24 * 60 * 60 * 1000;

export interface ScheduleFireState {
  job: ScheduleJobInput;
  dateKey: string;
}

export const scheduleGenerateHandler: FireKindHandler = {
  async beforeFire({ ctx, charId }) {
    const rows = await ctx.readState(AMSG_JOB_NAMESPACE);
    const row = rows.find((r) => r.key === scheduleJobKey(charId));
    if (!row?.value) {
      // 客戶端關掉了自動生成（會把行寫空）或 TTL 清了：安靜跳過，任務本身由客戶端取消
      return { skip: true, reason: `日程自動生成 ${charId} 的輸入已不在（已關或過期）` };
    }
    let json: string;
    try {
      json = await unpackStateValue(row.value);
    } catch (error) {
      throw new Error(`日程自動生成 ${charId} 的輸入解壓失敗（數據損壞）：${String(error)}`);
    }
    const job = parseScheduleJobInput(json);
    if (!job) throw new Error(`日程自動生成 ${charId} 的輸入解析失敗（數據損壞）`);
    if (job.charId !== charId) throw new Error(`日程自動生成 ${charId} 的輸入 charId 對不上`);
    if (job.refreshedAt && ctx.now.getTime() - job.refreshedAt > JOB_STALE_MS) {
      return { skip: true, reason: `日程自動生成 ${charId} 的輸入太久沒刷新（客戶端沒上線），這輪不排` };
    }
    const dateKey = scheduleJobTargetDay(job, ctx.now.getTime());
    const messages = buildScheduleJobMessages(job, dateKey);
    if (!messages) {
      return { skip: true, reason: `日程自動生成 ${charId}：輸入裡沒有 ${dateKey} 那天的段（客戶端還沒刷到）` };
    }
    return { messages, totalTimeoutMs: SCHEDULE_LLM_TIMEOUT_MS, state: { job, dateKey } satisfies ScheduleFireState };
  },

  async llmOutput({ ctx, state }) {
    const { job, dateKey } = state as ScheduleFireState;
    const parsed = extractScheduleJson(ctx.llmOutputText || '');
    const slots = parsed && Array.isArray(parsed.slots) ? parsed.slots : [];
    if (!parsed || slots.length === 0) {
      console.warn('[amsg:schedule] LLM 沒回出有效的日程 JSON，這天不排', job.charId, dateKey);
      logSkipDiagnostic({ sessionId: ctx.sessionId, reason: 'schedule-empty-generation', iteration: ctx.iteration, llmResponse: ctx.llmResponse, llmOutputText: ctx.llmOutputText });
      return { decision: 'skip-push', reason: 'schedule-empty-generation' };
    }
    if (typeof ctx.emitResult !== 'function') {
      console.warn('[amsg:schedule] 這台 worker 不支持 emitResult，日程送不回去', job.charId);
      return { decision: 'skip-push', reason: 'schedule-emit-result-unsupported' };
    }
    try {
      await ctx.emitResult({
        ...buildScheduleGenerateResult({ charId: job.charId, dateKey, parsed, generatedAt: Date.now() }),
        notification: { show: false },
      });
    } catch (error) {
      console.warn('[amsg:schedule] 日程送不進收件箱（收件箱表沒建全？）', job.charId, error);
      return { decision: 'skip-push', reason: 'schedule-emit-result-failed' };
    }
    console.log('[amsg:schedule] 日程已送進收件箱', { charId: job.charId, dateKey, slots: slots.length, resultKind: SCHEDULE_GENERATE_RESULT_KIND });
    return { decision: 'skip-push', reason: 'schedule-result-emitted' };
  },
};
