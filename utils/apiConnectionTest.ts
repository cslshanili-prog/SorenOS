import { safeResponseJson, extractContent } from './safeApi';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';

/**
 * 所有「🧪 測試連接」共用的測法（2026-10-11）：真的用選的模型發一句 Hi，看它有沒有回。
 *
 * 以前有幾處只去 GET /models：網址和 Key 對了就報成功，根本沒碰到選的那個模型，
 * 模型掛了、名字打錯照樣「連接成功」（Liora 回報：每次都 OK，實際用起來是掛的）。
 * 這裡另外把幾種「HTTP 200 但其實沒成」也算失敗：回應裡帶 error、沒有 choices、回覆是空的。
 * 中轉偷換模型（回應裡的 model 跟選的不一樣）不算失敗，但會寫出來。
 */

export interface ApiTestTarget {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface ApiTestResult {
    ok: boolean;
    /** 給人看的一行：✅／❌ 開頭 */
    message: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;

/** 比對模型名時忽略大小寫和常見的供應商前綴（openai/gpt-4o 與 gpt-4o 算同一個）。 */
const sameModel = (a: string, b: string) => {
    const norm = (s: string) => s.trim().toLowerCase().replace(/^[\w.-]+\//, '');
    return norm(a) === norm(b) || norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
};

export async function testChatModel(
    target: ApiTestTarget,
    opts: { stream?: boolean; fetchImpl?: FetchLike } = {},
): Promise<ApiTestResult> {
    const baseUrl = normalizeApiBaseUrl(target.baseUrl);
    const apiKey = normalizeApiCredential(target.apiKey);
    const model = normalizeApiModel(target.model);
    if (!baseUrl) return { ok: false, message: '❌ 還沒填 API 網址' };
    if (!model) return { ok: false, message: '❌ 還沒選模型——測試要用選好的模型實際說一句話' };

    const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    const signal = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function'
        ? (AbortSignal as any).timeout(TIMEOUT_MS) as AbortSignal
        : undefined;
    try {
        const res = await doFetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 16,
                stream: !!opts.stream,
            }),
            signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, message: `❌ HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}` };
        }
        const data = await safeResponseJson(res);
        if (data?.error) {
            const msg = typeof data.error === 'string' ? data.error : data.error?.message || JSON.stringify(data.error);
            return { ok: false, message: `❌ 模型回報錯誤：${String(msg).slice(0, 120)}` };
        }
        const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
        if (!choice) return { ok: false, message: '❌ 連得上，但回應裡沒有模型的回覆（格式不對，可能是中轉或模型出問題）' };
        const reply = (extractContent(data) || '').trim();
        const returned = typeof data?.model === 'string' ? data.model : '';
        const swapped = returned && !sameModel(returned, model) ? `（實際回覆的模型是 ${returned}）` : '';
        if (!reply) {
            // 推理模型 16 個 token 全花在思考上時正文是空的，但它確實回應了
            if (choice.finish_reason === 'length' || choice.message?.reasoning_content) {
                return { ok: true, message: `✅ 模型有回應（回覆被長度截斷，正文是空的）${swapped}` };
            }
            return { ok: false, message: `❌ 連得上，但模型回了空白——模型可能掛了或名字不對${swapped}` };
        }
        return { ok: true, message: `✅ 模型回覆：「${reply.slice(0, 30)}」${swapped}` };
    } catch (err: any) {
        const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
        return { ok: false, message: aborted ? `❌ ${TIMEOUT_MS / 1000} 秒沒回應，模型可能掛了` : `❌ 連接失敗：${err?.message || err}` };
    }
}
