/**
 * 羈絆主動產出在 worker 這一側（plans/bond-batch3.md 1.6、第 3d 批）。
 *
 * 標了 `amsgKind: 'bond-output'` 的循環任務：一段關係的一種（日記／問答／紙條／隨筆）一條，每天在那一種的投遞時段裡
 * 到點一次。到點把 standing job（`bond-output:<bondId>`）讀回來，照 utils/bond/outputCloudJob.ts 的
 * decideBondOutputFire 判斷該不該寫（大多數日子是「還沒到期」，安靜跳過、不叫 LLM）；該寫就拼提示詞、叫 LLM，
 * 原文送回客戶端（解析、落庫、同步私聊那句都在客戶端做，跟本機寫的同一套）。
 *
 * 角色想跟你說一聲（同步私聊）的那句，用當通知文字；沒有就不彈通知。
 * 寫了就記進 `bond-output-log`（雲端自己的帳：一天幾份、兩份隔多久、同一種多久再寫）。
 */

import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE } from '../../../utils/amsgTaskKinds';
import {
  BOND_OUTPUT_LLM_TIMEOUT_MS, BOND_OUTPUT_LOG_KEY, bondOutputJobKey, bondOutputLooksValid, buildBondOutputMessages, buildBondOutputResult,
  decideBondOutputFire, parseBondOutputJob, parseBondOutputJobId, parseBondOutputLog, parseBondOutputNotice, recordBondOutput,
  type BondOutputJob, type BondOutputLog,
} from '../../../utils/bond/outputCloudJob';
import type { BondOutputKind } from '../../../types';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import type { FireKindHandler } from './fireKinds';
import { logSkipDiagnostic } from './skipDiagnostics';

export interface BondOutputFireState {
  job: BondOutputJob;
  kind: BondOutputKind;
  day: string;
  dateKey: string;
  log: BondOutputLog | null;
}

const readValue = async (rows: Array<{ key: string; value: string }>, key: string): Promise<string | null> => {
  const row = rows.find((r) => r.key === key);
  if (!row?.value) return null;
  return unpackStateValue(row.value);
};

export const bondOutputHandler: FireKindHandler = {
  async beforeFire({ ctx, taskMeta }) {
    const ref = parseBondOutputJobId(taskMeta[AMSG_JOB_ID_KEY]);
    if (!ref) throw new Error(`羈絆主動產出任務的 metadata 裡沒有看得懂的 ${AMSG_JOB_ID_KEY}`);
    const rows = await ctx.readState(AMSG_JOB_NAMESPACE);
    let json: string | null;
    try {
      json = await readValue(rows, bondOutputJobKey(ref.bondId));
    } catch (error) {
      throw new Error(`羈絆主動產出 ${ref.bondId} 的輸入解壓失敗（數據損壞）：${String(error)}`);
    }
    if (!json) {
      // 客戶端關掉了（寫空）或三天沒上線被 TTL 清了：安靜跳過，任務由客戶端取消
      return { skip: true, reason: `羈絆主動產出 ${ref.bondId} 的輸入已不在（已關或客戶端太久沒上線）` };
    }
    const job = parseBondOutputJob(json);
    if (!job) throw new Error(`羈絆主動產出 ${ref.bondId} 的輸入解析失敗（數據損壞）`);
    if (job.bondId !== ref.bondId) throw new Error(`羈絆主動產出 ${ref.bondId} 的輸入 bondId 對不上`);
    let log: BondOutputLog | null = null;
    try {
      log = parseBondOutputLog(await readValue(rows, BOND_OUTPUT_LOG_KEY));
    } catch {
      log = null; // 帳壞了就當沒帳：頂多多寫一份，不該卡住
    }
    const taskUuid = typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null;
    const decision = decideBondOutputFire(job, ref.kind, taskUuid, ctx.now.getTime(), log);
    if (!decision.ok) return { skip: true, reason: `羈絆主動產出 ${ref.bondId} ${ref.kind}：${decision.reason}` };
    const messages = buildBondOutputMessages(job, ref.kind, decision.dateKey);
    if (!messages) return { skip: true, reason: `羈絆主動產出 ${ref.bondId} ${ref.kind}：輸入裡沒有這一種的提示詞` };
    return {
      messages,
      totalTimeoutMs: BOND_OUTPUT_LLM_TIMEOUT_MS,
      state: { job, kind: ref.kind, day: decision.day, dateKey: decision.dateKey, log } satisfies BondOutputFireState,
    };
  },

  async llmOutput({ ctx, state }) {
    const { job, kind, day, dateKey, log } = state as BondOutputFireState;
    const raw = (ctx.llmOutputText || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const k = job.kinds[kind];
    if (!bondOutputLooksValid(kind, raw, k?.tags || [])) {
      console.warn('[amsg:bond-output] LLM 沒寫出能用的內容，這次不送', job.bondId, kind);
      logSkipDiagnostic({ sessionId: ctx.sessionId, reason: 'bond-output-empty-generation', iteration: ctx.iteration, llmResponse: ctx.llmResponse, llmOutputText: ctx.llmOutputText });
      return { decision: 'skip-push', reason: 'bond-output-empty-generation' };
    }
    if (typeof ctx.emitResult !== 'function') {
      console.warn('[amsg:bond-output] 這台 worker 不支持 emitResult，送不回去', job.bondId);
      return { decision: 'skip-push', reason: 'bond-output-emit-result-unsupported' };
    }
    const notice = k?.withNotice ? parseBondOutputNotice(raw) : '';
    const now = Date.now();
    try {
      await ctx.emitResult({
        ...buildBondOutputResult({
          bondId: job.bondId, charId: job.charId, kind, dateKey, raw, jobRefreshedAt: job.refreshedAt, generatedAt: now,
          ...(k?.replyTo ? { replyTo: k.replyTo } : {}),
          ...(k?.tags?.length ? { tags: k.tags } : {}),
          ...(k?.candidateKeys?.length ? { candidateKeys: k.candidateKeys } : {}),
        }),
        notification: notice ? { title: job.charName, body: notice } : { show: false },
      });
    } catch (error) {
      console.warn('[amsg:bond-output] 結果送不進收件箱', job.bondId, error);
      return { decision: 'skip-push', reason: 'bond-output-emit-result-failed' };
    }
    if (typeof ctx.writeState === 'function') {
      try {
        const next = recordBondOutput(log, day, job.bondId, kind, now);
        await ctx.writeState(AMSG_JOB_NAMESPACE, [{ key: BOND_OUTPUT_LOG_KEY, value: JSON.stringify(next), updatedAt: now }]);
      } catch (error) {
        console.warn('[amsg:bond-output] 帳沒記上（下次可能多寫一份，客戶端會丟掉重複的）', error);
      }
    }
    console.log('[amsg:bond-output] 已送進收件箱', { bondId: job.bondId, kind, dateKey, notice: !!notice });
    return { decision: 'skip-push', reason: 'bond-output-result-emitted' };
  },
};
