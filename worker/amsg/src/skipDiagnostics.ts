/**
 * 「這一輪沒發出去」時的診斷日誌。
 *
 * 模型回來卻沒有能發的正文時（skip-push），last_skip 裡只有一個 reason，而背後是好幾種
 * 完全不同的情況：content 是 null（只回了工具調用 / 被審核攔了）、content 是數組、思考把
 * token 燒光被截斷、正文全包在 <think> 裡、只寫了標籤，或者中轉站把報錯包在 HTTP 200 裡。
 * 跳過的那一刻把模型響應的**形狀**記一行，到 Workers Logs（Observability）裡搜
 * `[amsg:skip-diag]` 就能分清是哪一種。
 *
 * 默認只記形狀（有沒有、什麼類型、多長、token 數），不記聊天正文。要看原文片段時，給 Worker
 * 加一個明文變量 AMSG_DEBUG_LLM_RAW=1——wrangler 部署帶 keep_vars、應用內「更新 Worker」
 * 重建配置時也原樣保留普通變量，所以不會被沖掉。查完刪掉。
 */
import { redactCredentials, stripReasoningTags } from '@rei-standard/amsg-shared';

/** body 裡那句報錯最多留多少字：典型的「餘額不足 / 模型不存在」一句話裝得下。 */
const BODY_ERROR_MAX_CHARS = 200;
/** 以下三個只在打開原文開關時用。 */
const CONTENT_EXCERPT_CHARS = 300;
/** 思考鏈取末尾：被截斷時要看的是它停在哪兒。 */
const REASONING_TAIL_CHARS = 200;
const BODY_EXCERPT_CHARS = 500;

export interface LlmResponseShape {
  /** 響應裡自報的模型名（中轉站悄悄換了模型時看得出來）。 */
  model: string | null;
  /** 有沒有非空的 choices。沒有就不是正常的對話補全響應，多半是中轉站把報錯包在了 200 裡。 */
  hasChoices: boolean;
  /** stop / length / content_filter / tool_calls……length 說明被截斷了。 */
  finishReason: string | null;
  /** message.content 的形態。上游只認 string，其餘一律當空串。 */
  contentType: 'string' | 'array' | 'null' | 'missing' | 'other';
  /** content 原文字符數（數組時是各段 text 之和）。 */
  contentChars: number;
  /** content 是數組時有幾段。 */
  contentParts?: number;
  /** 上游交給鉤子的正文剝掉思考塊後還剩幾個字。contentChars 不為 0 而它為 0 = 正文全在 <think> 裡。 */
  visibleChars: number;
  /** 原生思考字段（reasoning_content / reasoning / thinking）的字符數。 */
  reasoningChars: number;
  toolCalls: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
  } | null;
  /** body 裡帶的報錯（error 字段，沒有 choices 時也認頂層 message / msg），截斷並脫敏。 */
  bodyError: string | null;
}

/** 原文片段：只在 AMSG_DEBUG_LLM_RAW 打開時出現，全部先脫敏再截斷。 */
export interface LlmResponseExcerpt {
  content?: string;
  reasoningTail?: string;
  toolCalls?: string;
  /** 沒有 choices 時整個 body 的開頭。 */
  body?: string;
}

type AnyRecord = Record<string, unknown>;

const asRecord = (value: unknown): AnyRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** 取第一個 choice 的 message；沒有 choices 時為 null。 */
const readFirstMessage = (body: AnyRecord | null): { choice: AnyRecord | null; message: AnyRecord | null } => {
  const choices = Array.isArray(body?.choices) ? (body!.choices as unknown[]) : [];
  const choice = asRecord(choices[0]);
  return { choice, message: asRecord(choice?.message) };
};

/** 字段名認三個，跟 onLLMOutput 裡抄思考鏈那處一樣寬。 */
const readReasoning = (message: AnyRecord | null): string => {
  const value = message?.reasoning_content ?? message?.reasoning ?? message?.thinking;
  return typeof value === 'string' ? value : '';
};

const readBodyError = (body: AnyRecord | null, hasChoices: boolean): string | null => {
  if (!body) return null;
  let text = '';
  const error = body.error;
  if (typeof error === 'string') {
    text = error;
  } else {
    const record = asRecord(error);
    if (record) {
      const code = typeof record.code === 'string' || typeof record.code === 'number'
        ? String(record.code)
        : typeof record.type === 'string' ? record.type : '';
      const message = typeof record.message === 'string' ? record.message : '';
      text = [code && `[${code}]`, message].filter(Boolean).join(' ') || safeStringify(record);
    }
  }
  // 頂層 message / msg 只在沒有 choices 時才算報錯：正常響應裡沒有這兩個字段，
  // 有 choices 時出現也不代表失敗。
  if (!text && !hasChoices) {
    const topLevel = body.message ?? body.msg;
    if (typeof topLevel === 'string') text = topLevel;
  }
  return text ? clip(redactCredentials(text), BODY_ERROR_MAX_CHARS) : null;
};

export const describeLlmResponseShape = (llmResponse: unknown, llmOutputText: string): LlmResponseShape => {
  const body = asRecord(llmResponse);
  const hasChoices = Array.isArray(body?.choices) && (body!.choices as unknown[]).length > 0;
  const { choice, message } = readFirstMessage(body);
  const content = message?.content;
  const contentType: LlmResponseShape['contentType'] =
    content === undefined ? 'missing'
      : content === null ? 'null'
        : typeof content === 'string' ? 'string'
          : Array.isArray(content) ? 'array'
            : 'other';
  const contentChars = typeof content === 'string'
    ? content.length
    : Array.isArray(content)
      ? content.reduce((sum: number, part) => {
          const text = asRecord(part)?.text;
          return sum + (typeof text === 'string' ? text.length : 0);
        }, 0)
      : 0;
  const usage = asRecord(body?.usage);
  const usageDetails = asRecord(usage?.completion_tokens_details);

  return {
    model: typeof body?.model === 'string' ? body.model : null,
    hasChoices,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    contentType,
    contentChars,
    ...(Array.isArray(content) ? { contentParts: content.length } : {}),
    visibleChars: stripReasoningTags(llmOutputText || '').trim().length,
    reasoningChars: readReasoning(message).length,
    toolCalls: Array.isArray(message?.tool_calls) ? (message!.tool_calls as unknown[]).length : 0,
    usage: usage
      ? {
          promptTokens: numberOrNull(usage.prompt_tokens),
          completionTokens: numberOrNull(usage.completion_tokens),
          reasoningTokens: numberOrNull(usageDetails?.reasoning_tokens),
        }
      : null,
    bodyError: readBodyError(body, hasChoices),
  };
};

export const excerptLlmResponse = (llmResponse: unknown): LlmResponseExcerpt => {
  const body = asRecord(llmResponse);
  const hasChoices = Array.isArray(body?.choices) && (body!.choices as unknown[]).length > 0;
  if (!hasChoices) {
    return { body: clip(redactCredentials(safeStringify(llmResponse)), BODY_EXCERPT_CHARS) };
  }
  const { message } = readFirstMessage(body);
  const excerpt: LlmResponseExcerpt = {};
  const content = message?.content;
  if (typeof content === 'string') {
    if (content) excerpt.content = clip(redactCredentials(content), CONTENT_EXCERPT_CHARS);
  } else if (content != null) {
    excerpt.content = clip(redactCredentials(safeStringify(content)), CONTENT_EXCERPT_CHARS);
  }
  const reasoning = readReasoning(message);
  if (reasoning) {
    const tail = reasoning.length > REASONING_TAIL_CHARS ? `…${reasoning.slice(-REASONING_TAIL_CHARS)}` : reasoning;
    excerpt.reasoningTail = redactCredentials(tail);
  }
  if (Array.isArray(message?.tool_calls) && (message!.tool_calls as unknown[]).length > 0) {
    excerpt.toolCalls = clip(redactCredentials(safeStringify(message!.tool_calls)), CONTENT_EXCERPT_CHARS);
  }
  return excerpt;
};

let rawExcerptEnabled = false;

/** buildWorkerConfig 的寫入口（isolate 級全局，同 configureInstantErrorPush 的先例）；export 也給單測用。 */
export const configureSkipDiagnostics = (options: { rawExcerpt: boolean }): void => {
  rawExcerptEnabled = options.rawExcerpt;
};

/** 面板上填的明文變量：1 / true 算開，其餘（包括沒配）都算關。 */
export const isDebugFlagOn = (value: unknown): boolean =>
  typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase());

export interface SkipDiagnosticInput {
  sessionId: string | undefined;
  reason: string;
  /** 第幾輪（0 起）。大於 0 說明前面幾輪在調工具，空的是收尾那一輪。 */
  iteration: number | undefined;
  llmResponse: unknown;
  llmOutputText: string | undefined;
}

export const logSkipDiagnostic = (input: SkipDiagnosticInput): void => {
  try {
    console.warn('[amsg:skip-diag]', {
      sessionId: input.sessionId ?? null,
      reason: input.reason,
      iteration: input.iteration ?? null,
      ...describeLlmResponseShape(input.llmResponse, input.llmOutputText ?? ''),
      ...(rawExcerptEnabled ? { raw: excerptLlmResponse(input.llmResponse) } : {}),
    });
  } catch (error) {
    // 診斷是錦上添花，碰上奇形怪狀的響應也不能把跳過本身弄掛。
    console.warn('[amsg:skip-diag] 診斷日誌沒記下來（跳過照常生效）', error);
  }
};
