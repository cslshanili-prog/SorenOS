/**
 * Safe API response parsing utilities.
 *
 * Prevents "Unexpected token <" crashes that happen when API proxies
 * return HTML error pages (CloudFlare, nginx 502/503, rate limits)
 * instead of JSON responses.
 */

// 同時掛兩套日誌：
//   - devDebug 的 api 類目（開發者勾「API」複製 / 下載導出）
//   - 全局 fetch 攔截器 + apiCallLog（用戶在「設置 → API 調用記錄」裡看）
// 後者的 meta 通過下面 safeFetchJson 的第 5 個參數掛到 __sullyMeta 上傳出去。
import { appendDevDebugApiLog, makeDebugLogger } from './devDebug';
import { getApiCallAmbientContext, recordApiCall, type ApiCallMeta } from './apiCallLog';
import { resolveBlobRefsInRequestBody } from './apiBlobRefs';

const log = makeDebugLogger('api', 'SafeAPI');

export function isChatCompletionUrl(url: string): boolean {
    return url.includes('/chat/completions');
}

/** Parse a fetch Response as JSON safely (text-first, then JSON.parse) */
export async function safeResponseJson(response: Response): Promise<any> {
    const text = await response.text();
    return parseRawBodyText(text, response.status, response.headers.get('content-type'));
}

/** 判斷響應是否是 SSE；兼容 OpenRouter 在首個 data 事件前發送的 ": OPENROUTER PROCESSING" 註釋。 */
export function isSseResponseText(text: string, contentType?: string | null): boolean {
    const firstLine = text
        .split(/\r?\n/)
        .map(line => line.trimStart())
        .find(line => line.length > 0) || '';
    const hasSseField = firstLine.startsWith('data:')
        || firstLine.startsWith(':')
        || firstLine.startsWith('event:')
        || firstLine.startsWith('id:')
        || firstLine.startsWith('retry:');
    if (hasSseField) return true;
    // 個別代理會把整包 JSON 錯標成 text/event-stream；明確的 JSON/HTML 起始符優先。
    if (/^[{["<]/.test(firstLine)) return false;
    return contentType?.toLowerCase().includes('text/event-stream') === true;
}

/** safeResponseJson 的純文本內核：HTML/空響應/SSE/JSON 判定與解析（流式路徑複用） */
function parseRawBodyText(text: string, status: number, contentType?: string | null): any {
    // Detect HTML / XML responses
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<')) {
        // Extract useful info from HTML error pages
        const titleMatch = trimmed.match(/<title>(.*?)<\/title>/i);
        const hint = titleMatch ? titleMatch[1] : trimmed.slice(0, 120);
        throw new Error(
            `API返回了HTML而非JSON (HTTP ${status}): ${hint}`
        );
    }

    // Empty body
    if (!trimmed) {
        throw new Error(`API返回了空響應 (HTTP ${status})`);
    }

    // SSE / 流式響應（有些 OpenAI 兼容代理無視 stream:false 強行流式返回）：
    // 註釋/心跳行（以 ":" 開頭）由 SseAssembler 忽略，data 事件照常拼成完整 content。
    if (isSseResponseText(text, contentType)) {
        const assembled = parseSseToCompletion(text);
        if (assembled) return assembled;
        const preview = text.slice(0, 200);
        throw new Error(
            `API流式響應未返回有效數據 (HTTP ${status}): ${preview}`
        );
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        // Show a snippet of what we got for debugging
        const preview = text.slice(0, 200);
        throw new Error(
            `API返回了無效JSON (HTTP ${status}): ${preview}`
        );
    }
}

/**
 * 把 OpenAI 兼容的 SSE 流響應合成一個普通 chat/completion 響應對象。
 *
 * 支持兩種形態：
 *  1. delta 流：每個 chunk 的 choices[0].delta.content 是增量片段，拼接起來
 *  2. 一次性 SSE：choices[0].message.content 直接就是全部內容（少見）
 *
 * 返回 { choices: [{ message: { content, role }, finish_reason }], ... } 方便上游
 * 用現有的 data.choices[0].message.content 路徑消費，無需改調用點。
 */
export function parseSseToCompletion(raw: string): any | null {
    const asm = new SseAssembler();
    // 按行切，逐行找 "data: " 開頭（允許 \r\n、空行分隔）
    for (const line of raw.split(/\r?\n/)) asm.feedLine(line);
    return asm.finish();
}

/**
 * OpenAI 兼容 SSE 流的增量拼裝器。
 * feedLine 逐行喂入（分別返回本行的正文與思考增量），finish 合成完整 completion 對象。
 * parseSseToCompletion（整包路徑）和 readBodyWithStreaming（真流式路徑）共用這一份，
 * 保證兩條路對 delta / message / tool_calls 分片的處理完全一致。
 */
interface SseFeedDelta {
    content: string;
    reasoning: string;
    /** The provider has explicitly finished this completion. */
    done: boolean;
}

class SseAssembler {
    content = '';
    private role = 'assistant';
    private finishReason: string | null = null;
    private firstChunk: any = null;
    private usage: any = undefined;
    private gotAnyChunk = false;
    // tool_calls 流式分片: OpenAI 約定按 index 分組, id/name 在首片, arguments 逐片拼接。
    // 不拼的話開了 stream 的工具模式(瑞幸/MCP)會靜默丟掉全部工具調用。
    private toolCalls: any[] = [];
    // 思考通道: DeepSeek/Gemini 系走 delta.reasoning_content, OpenRouter 走 delta.reasoning,
    // 部分 Claude 官轉(CC 渠道)走 delta.thinking 或分塊 content(數組裡 type:'thinking')。
    // 丟掉它 = 開思考鏈的角色"不出思維鏈"(後處理從 message.reasoning_content 抽取),
    // 且 extractContent / extractAssistantText 的 reasoning 兜底全部失效(思考模型把全部
    // 輸出塞進 reasoning 時表現為空回覆→重試→巨慢)。2026-07 全局流式上線後被放大成必現。
    private reasoning = '';
    // 取證探針: 記錄本條流裡 delta 出現過的字段名。渠道的思考字段形狀五花八門,
    // 與其一輪一輪猜, 不如把名單打出來(finish() 附帶 + 控制台一行)一次看清。
    private deltaKeys = new Set<string>();

    /** 喂一行 SSE 文本，分別返回正文與思考增量（沒有則為空串）。 */
    feedLine(line: string): SseFeedDelta {
        if (!line.startsWith('data:')) return { content: '', reasoning: '', done: false };
        const payload = line.slice(5).trim();
        if (!payload) return { content: '', reasoning: '', done: false };
        if (payload === '[DONE]') return { content: '', reasoning: '', done: true };
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { return { content: '', reasoning: '', done: false }; }
        return this.feedChunk(chunk);
    }

    feedChunk(chunk: any): SseFeedDelta {
        this.gotAnyChunk = true;
        if (!this.firstChunk) this.firstChunk = chunk;
        // OpenAI 流式 usage 在最後一個 chunk（include_usage=true 時），也可能出現在中途；
        // 始終取最後一個非空的 usage，兼容各家代理。
        if (chunk.usage) this.usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return { content: '', reasoning: '', done: false };
        let delta = '';
        let reasoningDelta = '';
        // delta 路徑（OpenAI 流式常見）
        if (choice.delta) {
            for (const k of Object.keys(choice.delta)) this.deltaKeys.add(k);
            if (typeof choice.delta.content === 'string') {
                delta = choice.delta.content;
                this.content += delta;
            }
            // Anthropic 透傳形態: delta.content 是分塊數組 [{type:'text',text}|{type:'thinking',thinking}]
            else if (Array.isArray(choice.delta.content)) {
                for (const block of choice.delta.content) {
                    if (block?.type === 'text' && typeof block.text === 'string') {
                        delta += block.text;
                        this.content += block.text;
                    } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
                        this.reasoning += block.thinking;
                        reasoningDelta += block.thinking;
                    }
                }
            }
            const dr = choice.delta.reasoning_content ?? choice.delta.reasoning ?? choice.delta.thinking;
            if (typeof dr === 'string') {
                this.reasoning += dr;
                reasoningDelta += dr;
            }
            if (choice.delta.role) this.role = choice.delta.role;
            if (Array.isArray(choice.delta.tool_calls)) {
                for (const frag of choice.delta.tool_calls) {
                    const idx = frag.index ?? 0;
                    if (!this.toolCalls[idx]) this.toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (frag.id) this.toolCalls[idx].id = frag.id;
                    if (frag.type) this.toolCalls[idx].type = frag.type;
                    if (frag.function?.name) this.toolCalls[idx].function.name += frag.function.name;
                    if (frag.function?.arguments) this.toolCalls[idx].function.arguments += frag.function.arguments;
                }
            }
        }
        // message 路徑（一次性 SSE，不常見但兼容）
        else if (choice.message) {
            if (typeof choice.message.content === 'string') {
                delta = choice.message.content;
                this.content += delta;
            }
            const mr = choice.message.reasoning_content ?? choice.message.reasoning ?? choice.message.thinking;
            if (typeof mr === 'string') {
                this.reasoning += mr;
                reasoningDelta += mr;
            }
            if (choice.message.role) this.role = choice.message.role;
            if (Array.isArray(choice.message.tool_calls)) this.toolCalls.push(...choice.message.tool_calls);
        }
        if (choice.finish_reason) this.finishReason = choice.finish_reason;
        return { content: delta, reasoning: reasoningDelta, done: Boolean(choice.finish_reason) };
    }

    get reasoningContent(): string {
        return this.reasoning;
    }

    finish(): any | null {
        if (!this.gotAnyChunk) return null;
        // 取證探針: 思考沒抓到時把渠道實際用的 delta 字段名單打出來, 下一輪排查直接看名單。
        // (開思考的請求思考卻為空 = 大概率又是沒見過的字段形狀)
        if (!this.reasoning && this.deltaKeys.size > 0) {
            console.log(`🔎 [SSE] 本條流的 delta 字段: ${[...this.deltaKeys].join(', ')}${this.content ? '' : ' (且正文為空!)'}`);
        }
        // 合成兼容結構
        return {
            id: this.firstChunk?.id || 'sse-assembled',
            object: 'chat.completion',
            created: this.firstChunk?.created || Math.floor(Date.now() / 1000),
            model: this.firstChunk?.model || '',
            choices: [{
                index: 0,
                message: {
                    role: this.role,
                    content: this.content,
                    ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
                    ...(this.toolCalls.length ? {
                        tool_calls: this.toolCalls.filter(Boolean).map((tc, i) => ({ ...tc, id: tc.id || `call_sse_${i}` })),
                    } : {}),
                },
                finish_reason: this.finishReason,
            }],
            usage: this.usage || this.firstChunk?.usage,
        };
    }
}

/** safeFetchJson 的可選流式鉤子（只在響應確實是 SSE 流時觸發） */
export interface StreamHooks {
    /**
     * 每收到一段正文增量時回調。fullText 是**本次嘗試**累計的完整正文——
     * safeFetchJson 內部重試會重新開一條流，fullText 從空串重新累計，
     * 調用方每次都應基於 fullText 全量重算（天然處理重試重置）。
     */
    onDelta?: (delta: string, fullText: string) => void;
    /** 每收到一段原生 reasoning 增量時回調；渠道不發送 reasoning 時不會觸發。 */
    onReasoningDelta?: (delta: string, fullReasoning: string) => void;
    /** 收到第一個正文增量時回調一次（TTFT 參考點） */
    onFirstDelta?: () => void;
}

/**
 * 真·流式讀取響應體：邊到邊解析 SSE 行並回調 onDelta。
 * 支持 data 事件前先到達的 SSE 註釋/心跳；代理無視 stream:true 返回整包 JSON / HTML
 * 錯誤頁時，自動退化為累積全文後走 parseRawBodyText —— 與非流式路徑行為一致。
 */
async function readBodyWithStreaming(
    response: Response,
    hooks: StreamHooks,
    timing?: { firstDeltaMs?: number },
    startedAt?: number,
): Promise<any> {
    if (!response.body?.getReader) return safeResponseJson(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const asm = new SseAssembler();
    let raw = '';           // 全量原始文本（退化路徑 / SSE 解析失敗時兜底）
    let pending = '';       // SSE 模式下未消費完的半行緩衝
    let mode: 'undecided' | 'sse' | 'raw' = 'undecided';
    let sawFirstDelta = false;
    let sawTerminalEvent = false;
    const contentType = response.headers.get('content-type');

    const emit = (delta: SseFeedDelta) => {
        if (delta.done) sawTerminalEvent = true;
        if (delta.content) {
            if (!sawFirstDelta) {
                sawFirstDelta = true;
                if (timing && startedAt) timing.firstDeltaMs = Date.now() - startedAt;
                try { hooks.onFirstDelta?.(); } catch { /* 回調異常不攔截流 */ }
            }
            try { hooks.onDelta?.(delta.content, asm.content); } catch { /* 回調異常不攔截流 */ }
        }
        if (delta.reasoning) {
            try { hooks.onReasoningDelta?.(delta.reasoning, asm.reasoningContent); } catch { /* 回調異常不攔截流 */ }
        }
    };

    const consumeLines = () => {
        const lastNl = pending.lastIndexOf('\n');
        if (lastNl < 0) return;
        const complete = pending.slice(0, lastNl);
        pending = pending.slice(lastNl + 1);
        for (const line of complete.split(/\r?\n/)) emit(asm.feedLine(line));
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const textChunk = decoder.decode(value, { stream: true });
        raw += textChunk;
        if (mode === 'undecided') {
            const t = raw.trimStart();
            if (!t) continue;
            if (isSseResponseText(raw, contentType)) {
                mode = 'sse';
                pending = raw;
            } else if (/^[{["<]/.test(t) || /\r?\n/.test(t)) {
                // 明確是整包 JSON/HTML，或首行已經完整且不是 SSE。
                mode = 'raw';
            } else {
                // 首塊可能只含 "d"/"da" 等 SSE 字段名前綴，等下一塊再判斷。
                continue;
            }
        } else if (mode === 'sse') {
            pending += textChunk;
        }
        if (mode === 'sse') consumeLines();
        if (sawTerminalEvent) {
            // A few OpenAI-compatible Claude proxies send [DONE]/finish_reason but
            // keep the HTTP socket alive. The completion is already whole; waiting
            // for reader.done would leave the Qixi loader spinning forever.
            try { await reader.cancel(); } catch { /* completion is already assembled */ }
            break;
        }
    }
    const tail = decoder.decode();
    if (tail) {
        raw += tail;
        if (mode === 'sse') pending += tail;
    }
    if (mode === 'sse') {
        consumeLines();
        if (pending.trim()) emit(asm.feedLine(pending.trim()));
        const assembled = asm.finish();
        if (assembled) return assembled;
        // 一個 chunk 都沒解析出來 → 按原始文本兜底（保留原 preview 報錯行為）
    }
    return parseRawBodyText(raw, response.status, contentType);
}

/**
 * Fetch with automatic retry for transient errors on non-billable endpoints.
 * Chat completions never retry automatically: a timeout/network error does not
 * prove the upstream generation stopped, so retrying can charge the user twice.
 * Other endpoints retry on: 429, 500, 502, 503, 504 and network failures.
 * Returns the parsed JSON data directly.
 *
 * `timeoutMs`：每次嘗試的硬超時。如果調用方沒在 options.signal 裡自帶 AbortController，
 * 這裡會給每次 attempt 起一個內部 AbortController，超時就 abort，避免提供方 stall
 * 住整個頁面（用戶誤以為卡死，只能重新打開網頁）。0 / 未傳 = 不超時。
 */
export async function safeFetchJson(
    url: string,
    options: RequestInit,
    maxRetries: number = 2,
    timeoutMs: number = 0,
    /** 可選：補充「哪個 App / 哪個角色 / 用途」到 API 調用記錄（設置 → API 調用記錄）。 */
    meta?: ApiCallMeta,
    /** 可選：流式增量回調（請求體帶 stream:true 時傳入才有意義；響應不是 SSE 時靜默不觸發）。 */
    streamHooks?: StreamHooks,
): Promise<any> {
    const retryableStatuses = new Set([429, 500, 502, 503, 504]);
    let lastError: Error | null = null;
    const urlStr = String(url);
    const automaticRetryLimit = isChatCompletionUrl(urlStr)
        ? 0
        : Math.max(0, Math.floor(Number(maxRetries) || 0));
    let lastStatus: number | undefined;

    // 顯式 meta 掛到 RequestInit 給全局 fetch 兜底；同時快照環境標籤，避免長響應期間
    // 用戶切 App 後被錯標。safeFetchJson 與全局攔截器以 requestId 原子去重。
    const metaOptions: RequestInit = meta ? { ...options, __sullyMeta: meta } as RequestInit : options;
    const logMeta = meta || getApiCallAmbientContext();

    // 圖片在本機存成 `blobref:` 令牌，發出去對面讀不懂——在這裡統一還原成 data URL。
    // 各處構造請求的地方就不用各記一遍這件事了（詳見 utils/apiBlobRefs.ts）。
    // 循環外做一次：重試用的是同一份 body。
    const resolvedBody = await resolveBlobRefsInRequestBody(metaOptions.body);
    const sendOptions: RequestInit = resolvedBody === metaOptions.body
        ? metaOptions
        : { ...metaOptions, body: resolvedBody as BodyInit };

    for (let attempt = 0; attempt <= automaticRetryLimit; attempt++) {
        // 全局 fetch 攔截器和這裡的“已解析響應兜底”共享 ID。前者覆蓋裸 fetch，
        // 後者不依賴 Response.clone()，避免部分 iOS/WebView 克隆流不結束時漏記。
        const requestId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        // 每次 attempt 建一個獨立的 AbortController（僅用於 timeout）
        // 調用方自己的 options.signal 仍然有效，兩者任一觸發就 abort
        let attemptOptions = { ...sendOptions, __sullyApiCallId: requestId } as RequestInit;
        let timeoutHandle: any = null;
        if (timeoutMs > 0) {
            const ac = new AbortController();
            timeoutHandle = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
            if (options.signal) {
                // 串聯外部 signal：外部 abort 也觸發內部
                if (options.signal.aborted) {
                    clearTimeout(timeoutHandle);
                    throw new Error('aborted');
                }
                options.signal.addEventListener('abort', () => ac.abort(), { once: true });
            }
            attemptOptions = { ...attemptOptions, signal: ac.signal };
        }
        const attemptStartedAt = Date.now();
        try {
            const response = await fetch(url, attemptOptions);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            lastStatus = response.status;
            const headersMs = Date.now() - attemptStartedAt;

            if (!response.ok) {
                // For retryable status codes, retry before giving up
                if (retryableStatuses.has(response.status) && attempt < automaticRetryLimit) {
                    const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
                    log.warn('HTTP retry', { status: response.status, attempt: attempt + 1, maxRetries: automaticRetryLimit, delay });
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                // Non-retryable or last attempt: parse body for error details
                const data = await safeResponseJson(response);
                // If we somehow got valid JSON with error info, wrap it
                const errMsg = data?.error?.message || data?.error || `HTTP ${response.status}`;
                throw new Error(`API Error ${response.status}: ${errMsg}`);
            }

            const timing: { firstDeltaMs?: number } = {};
            const data = streamHooks
                ? await readBodyWithStreaming(response, streamHooks, timing, attemptStartedAt)
                : await safeResponseJson(response);
            if (isChatCompletionUrl(urlStr)) {
                // TTFT 拆分埋點：headers = 首包響應頭到達（≈排隊+prefill 起點），
                // firstDelta = 第一段正文增量（≈真正的 TTFT，僅流式路徑有），
                // total = 整包收完。定位「API 慢 20s」到底慢在 prefill 還是生成。
                const totalMs = Date.now() - attemptStartedAt;
                console.log(`⏱ [API timing] headers=${headersMs}ms${timing.firstDeltaMs != null ? ` firstDelta=${timing.firstDeltaMs}ms` : ''} total=${totalMs}ms${streamHooks ? ' streamed=1' : ''}`);
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: response.status,
                    requestBody: options.body,
                    response: data,
                    durationMs: totalMs,
                    headersMs,
                    firstDeltaMs: timing.firstDeltaMs,
                });
                // 已解析響應是最可靠的日誌來源：不再把記帳成敗押在異步
                // response.clone().text() 上。全局攔截器仍負責裸 fetch，並以 requestId 去重。
                recordApiCall({
                    requestId,
                    url: urlStr,
                    body: attemptOptions.body,
                    status: response.status,
                    ok: response.ok,
                    response: data,
                    meta: logMeta,
                    durationMs: totalMs,
                });
            }
            return data;
        } catch (e: any) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            lastError = e;

            // AbortError（含 timeout）：是否重試看上層策略，先按可重試處理（網絡層面）
            const isAbort = e?.name === 'AbortError' || /aborted|timeout/i.test(e?.message || '');

            // Network errors (fetch itself failed) are retryable
            if ((e?.name === 'TypeError' || isAbort) && attempt < automaticRetryLimit) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn(isAbort ? 'Timeout/Abort retry' : 'Network error retry', { attempt: attempt + 1, maxRetries: automaticRetryLimit, delay, message: e?.message });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            // For HTML/parse errors on non-ok responses during retry, continue
            if (attempt < automaticRetryLimit && e?.message?.includes('API返回了HTML')) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn('HTML response retry', { attempt: attempt + 1, maxRetries, delay });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            if (isChatCompletionUrl(urlStr)) {
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: lastStatus,
                    requestBody: options.body,
                    error: e,
                    durationMs: Date.now() - attemptStartedAt,
                });
            }
            throw e;
        }
    }

    throw lastError || new Error('API請求失敗');
}

/**
 * Safely extract the AI content string from an OpenAI-compatible response.
 * Returns '' instead of crashing when the structure is unexpected.
 *
 * Handles thinking models (DeepSeek-R1, GLM-4.5, QwQ, Qwen3, ...):
 *  - Falls back to `reasoning_content` when `content` is missing/empty
 *  - Strips hidden <think>...</think> chain-of-thought blocks
 */
export function extractContent(data: any): string {
    const msg = data?.choices?.[0]?.message;
    const contentToText = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            return value.map(part => {
                if (typeof part === 'string') return part;
                if (!part || typeof part !== 'object') return '';
                const record = part as Record<string, unknown>;
                return contentToText(record.text ?? record.content ?? record.value);
            }).filter(Boolean).join('');
        }
        if (value && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            return contentToText(record.text ?? record.content ?? record.value);
        }
        return '';
    };

    let text = contentToText(msg?.content);
    if (!text.trim()) text = contentToText(msg?.reasoning_content);
    // Strip hidden chain-of-thought blocks: <think> / <thinking> / <thought>
    text = text.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '');
    text = text.replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
    return text.trim();
}

/**
 * Robustly extract a JSON object from AI-generated text.
 *
 * Handles common Claude format instabilities:
 *  - JSON wrapped in ```json ... ``` code blocks
 *  - Extra prose before/after the JSON ("Here is the result: { ... }")
 *  - Trailing commas in arrays/objects  (common Claude habit)
 *  - Single-quoted strings
 *  - Unquoted keys
 *
 * Returns parsed object on success, null on total failure.
 */
/**
 * Walk through a JSON-ish string and re-escape `"` characters that appear inside
 * string values but weren't escaped by the LLM.
 *
 * Common with Claude when the content quotes a phrase ("還不夠好" / "我愛你"等)
 * inside a string value — the inner quotes break JSON.parse because they look
 * like closing delimiters.
 *
 * Heuristic for distinguishing "real closing quote" vs "unescaped inner quote":
 *   A `"` is treated as closing iff the next non-whitespace char is one of
 *   , } ] : end-of-input. Otherwise it's an inner quote and gets \-escaped.
 */
function escapeUnescapedInnerQuotes(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\' && inString) { result += ch; escaped = true; continue; }

        if (ch === '"') {
            if (!inString) {
                inString = true;
                result += ch;
                continue;
            }
            // We're inside a string. Look ahead to decide: closing or inner?
            let j = i + 1;
            while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;
            const next = j < text.length ? text[j] : '';
            // Closing iff next meaningful char is one of , } ] : or EOF
            if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
                inString = false;
                result += ch;
            } else {
                // Inner unescaped quote → escape it
                result += '\\"';
            }
            continue;
        }

        result += ch;
    }

    return result;
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * Handles the common case where LLM output is cut off mid-string.
 */
function repairTruncatedJson(text: string): string | null {
    // If it already ends with } or ], it's probably not truncated in a way we can fix
    const trimmed = text.trim();
    if (trimmed.endsWith('}') || trimmed.endsWith(']')) return null; // let other steps handle it

    // Walk through the string tracking state
    let inString = false;
    let escaped = false;
    const stack: ('{' | '[')[] = [];
    let lastKeyValueEnd = 0; // position after last complete key:value pair

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') stack.push('{');
        else if (ch === '[') stack.push('[');
        else if (ch === '}') { if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop(); }
        else if (ch === ']') { if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop(); }

        // Track positions after complete values at object level
        if (stack.length === 1 && stack[0] === '{' && (ch === ',' || ch === '}')) {
            lastKeyValueEnd = i + 1;
        }
    }

    if (stack.length === 0) return null; // balanced, nothing to repair

    // Strategy: truncate to last complete key:value, then close brackets
    let repaired = '';
    if (lastKeyValueEnd > 0) {
        repaired = trimmed.slice(0, lastKeyValueEnd).replace(/,\s*$/, '');
    } else {
        // No complete key:value found at top level, try closing from current position
        repaired = trimmed;
        // If we're in an open string, close it
        if (inString) repaired += '"';
    }

    // Close remaining open brackets in reverse order
    for (let i = stack.length - 1; i >= 0; i--) {
        repaired += stack[i] === '{' ? '}' : ']';
    }

    return repaired;
}

/** Repair formatting outside strings; preserve apostrophes and literal `, }` in prose. */
function repairJsonPresentation(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { result += ch; escaped = false; continue; }
        if (inString && ch === '\\') { result += ch; escaped = true; continue; }
        if (ch === '"') inString = !inString;
        if (inString && ch.charCodeAt(0) < 32) {
            result += JSON.stringify(ch).slice(1, -1);
        } else if (!inString && ch === ',' && /^[\s]*[}\]]/.test(text.slice(i + 1))) {
            continue;
        } else result += ch;
    }
    return result;
}

export function extractJson(raw: string, options: { allowTruncated?: boolean; silent?: boolean } = {}): any | null {
    if (!raw) return null;

    // 1. Strip markdown code fences
    let text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();

    // 2. Try direct parse first (fast path)
    try { return JSON.parse(text); } catch {}

    // 3. Extract the outermost { ... } or [ ... ]
    const objMatch = text.match(/(\{[\s\S]*\})/);
    const arrMatch = text.match(/(\[[\s\S]*\])/);
    // Prefer whichever starts earlier in the text
    let jsonStr = '';
    if (objMatch && arrMatch) {
        jsonStr = (text.indexOf(objMatch[1]) <= text.indexOf(arrMatch[1]))
            ? objMatch[1] : arrMatch[1];
    } else {
        jsonStr = objMatch?.[1] || arrMatch?.[1] || '';
    }

    if (!jsonStr) return null;

    // 4. Try parsing the extracted substring
    try { return JSON.parse(jsonStr); } catch {}
    try { return JSON.parse(repairJsonPresentation(jsonStr)); } catch {}

    // 5. Fix common AI formatting issues and retry
    let fixed = jsonStr
        // Trailing commas: ,} or ,]
        .replace(/,\s*([}\]])/g, '$1')
        // Single quotes → double quotes (careful with apostrophes in text)
        // Only replace quotes that look like JSON string delimiters
        .replace(/'/g, '"')
        // Unquoted keys:  { foo: "bar" } → { "foo": "bar" }
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    try { return JSON.parse(fixed); } catch {}

    // 6. Try to repair unescaped inner quotes (LLM writes naked " inside a string value).
    // Common with Claude when the content quotes a phrase like 「埋一句"我愛你"」
    // — the inner " breaks JSON parsing because they're not \-escaped.
    const innerQuoteFixed = escapeUnescapedInnerQuotes(jsonStr);
    if (innerQuoteFixed && innerQuoteFixed !== jsonStr) {
        try { return JSON.parse(repairJsonPresentation(innerQuoteFixed)); } catch {}
        try { return JSON.parse(innerQuoteFixed); } catch {}
        try {
            return JSON.parse(innerQuoteFixed
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch {}
    }

    // 7. Try to repair truncated JSON (LLM hit max_tokens)
    // Find the first { and attempt to close any open strings/brackets
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0 && options.allowTruncated !== false) {
        let truncated = text.slice(firstBrace);
        const repaired = repairTruncatedJson(truncated);
        if (repaired) {
            try { return JSON.parse(repaired); } catch {}
            // Also try with common fixes applied
            try {
                return JSON.parse(repaired
                    .replace(/,\s*([}\]])/g, '$1')
                    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
            } catch {}
            // Also try escaping inner quotes on the truncated-repaired version
            const repairedInnerFixed = escapeUnescapedInnerQuotes(repaired);
            if (repairedInnerFixed !== repaired) {
                try { return JSON.parse(repairedInnerFixed); } catch {}
            }
        }
    }

    // 8. Last resort: try to extract individual JSON objects if there are multiple
    // (AI sometimes outputs two JSON blocks, take the larger one)
    const allObjects = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (allObjects.length > 0) {
        // Sort by length, try the longest first (most likely the full response)
        const sorted = allObjects.sort((a, b) => b[0].length - a[0].length);
        for (const m of sorted) {
            try {
                return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            } catch {}
            try {
                const fixedInner = escapeUnescapedInnerQuotes(m[0]);
                return JSON.parse(fixedInner.replace(/,\s*([}\]])/g, '$1'));
            } catch {}
        }
    }

    // 9. AI sometimes wraps the expected JSON in a wrapper object like {"result": {...}}
    // Try to find the first nested object value and return it
    for (const m of allObjects) {
        try {
            const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            const vals = Object.values(parsed);
            if (vals.length === 1 && typeof vals[0] === 'object' && vals[0] !== null) return vals[0];
        } catch {}
    }

    if (!options.silent) console.error('[extractJson] All attempts failed. Raw:', raw.slice(0, 300));
    return null;
}
