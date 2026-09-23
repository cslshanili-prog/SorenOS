/**
 * 採樣參數兼容層
 *
 * 背景：部分較新的模型已經廢棄了 temperature / top_p / top_k 採樣參數，請求裡帶上
 * 就直接 400。典型報錯（OpenRouter 透傳 Azure/Anthropic）：
 *   {"type":"invalid_request_error","message":"temperature is deprecated for this model."}
 *
 * 已知會因此 400 的模型：
 *   - Claude：Opus 4.7 / 4.8（及以上）、Sonnet 5（及以上）、Fable 5 / Mythos 5
 *   - OpenAI：gpt-5 系
 *   （o1/o3/o4 等推理模型也只接受默認 temperature，靠下面第 2 層兜底覆蓋）
 *
 * 關鍵點：OpenRouter 會把 `anthropic/claude-opus-4.8` 路由到 Azure / Anthropic，
 * 這些 provider 同樣拒收 temperature，所以「換 API / 換 OR」都沒用——根因是**模型本身
 * 不收這個參數**，跟 key、上文長度、格式都無關。
 *
 * 兼容策略（在 fetch 統一出口做，覆蓋全部 /chat/completions 調用點）：
 *   1) 發送前：識別到會廢棄採樣參數的模型，主動摘掉 temperature/top_p/top_k；
 *   2) 收到 400 且報文點名採樣參數「deprecated / not supported」時，摘掉後重試一次。
 * 第 2 層是兜底：即便模型名沒被第 1 層清單覆蓋，也能自愈。
 */

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k'] as const;

/**
 * 該模型是否已廢棄採樣參數（帶上會 400）。
 * model 為空 / 非字符串 / 未知時返回 false —— 默認保持原樣，不誤傷仍需要 temperature 的模型。
 */
export function modelRejectsSamplingParams(model: unknown): boolean {
    if (typeof model !== 'string' || !model) return false;
    const m = model.toLowerCase();

    // Claude 系：版本號裡的分隔符可能是 . 或 -（claude-opus-4.8 / claude-opus-4-8 都有）
    if (/opus[-.\s]?4[-.\s]?(7|8|9)\b/.test(m)) return true;   // Opus 4.7 / 4.8 / 4.9
    if (/opus[-.\s]?(?:[5-9]|\d\d)\b/.test(m)) return true;    // Opus 5 及以上
    if (/sonnet[-.\s]?(?:[5-9]|\d\d)\b/.test(m)) return true;  // Sonnet 5 及以上
    if (/\b(?:fable|mythos)[-.\s]?\d/.test(m)) return true;    // Fable / Mythos

    // OpenAI gpt-5 系（gpt-5 / gpt-5-mini / gpt5 等）
    if (/\bgpt-?5/.test(m)) return true;

    return false;
}

/**
 * 從請求體裡摘掉採樣參數（就地修改）；返回是否真的刪掉了東西。
 */
export function stripSamplingParams(body: Record<string, any>): boolean {
    if (!body || typeof body !== 'object') return false;
    let changed = false;
    for (const k of SAMPLING_KEYS) {
        if (k in body && body[k] !== undefined) {
            delete body[k];
            changed = true;
        }
    }
    return changed;
}

/**
 * Claude 的 temperature 合法範圍是 0..1。官方 OpenAI 兼容層會自動封頂，但不少
 * 第三方 /chat/completions 中轉直接轉發到 Messages API，1.1 之類的劇情預設會因此 400。
 */
export function clampClaudeTemperature(body: Record<string, any>): boolean {
    if (!body || typeof body !== 'object') return false;
    const model = typeof body.model === 'string' ? body.model.toLowerCase() : '';
    if (!/claude|anthropic/.test(model)) return false;
    const temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature <= 1) return false;
    body.temperature = 1;
    return true;
}

/**
 * 400 報文是否在抱怨採樣參數（temperature / top_p / top_k 被廢棄 / 不支持）。
 * 用來決定要不要摘掉採樣參數重試一次。
 */
export function isSamplingParamError(responseText: string): boolean {
    if (!responseText) return false;
    const t = responseText.toLowerCase();
    const mentionsParam = /temperature|top_p|top_k/.test(t);
    const mentionsReject = /deprecat|not supported|unsupported|no longer supported|not allowed|isn'?t supported|not permitted|unexpected/.test(t);
    return mentionsParam && mentionsReject;
}
