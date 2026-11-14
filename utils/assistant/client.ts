/**
 * Sore 打 API 的地方（plans/ai-assistant.md 第 4 節）。
 * - makeSoreCall：一般的 /chat/completions，回覆剝掉 <think> 區塊。
 *   不用 stripLeakedReasoning：那是給角色台詞用的，會把 Sore 正常說的「我先看一下」當成外洩的思考剝掉
 * - testApiConnection：「測試API」工具用，打一次很小的請求
 * 錯誤訊息一律過 scrubSecret：中轉有時把 Key 原樣塞進錯誤訊息，不能讓它進到 Sore 的上下文。
 */
import { safeFetchJson } from '../safeApi';
import type { ChatCall } from './engine';

export interface SoreEndpoint {
    baseUrl: string;
    apiKey: string;
    model: string;
}

const endpoint = (baseUrl: string) => `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;

/** 把錯誤訊息裡的 Key（整串或前後一段）換掉 */
export const scrubSecret = (message: string, apiKey?: string): string => {
    let text = String(message || '');
    const key = (apiKey || '').trim();
    if (key.length >= 6) {
        text = text.split(key).join('[Key]');
        // 中轉常只印前幾碼或後幾碼
        if (key.length >= 16) {
            text = text.split(key.slice(0, 12)).join('[Key]').split(key.slice(-12)).join('[Key]');
        }
    }
    return text.replace(/\b(sk|ak|key)-[A-Za-z0-9_\-]{12,}/g, '[Key]').slice(0, 400);
};

/** 只剝有標籤的思考區塊；也收「只有結尾 </think>」那種（前面整段都是思考） */
export const stripThinkTags = (text: string): string => {
    let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    const close = out.search(/<\/(think|thinking|reasoning)>/i);
    if (close !== -1) out = out.slice(close).replace(/^<\/(think|thinking|reasoning)>/i, '');
    return out.trim();
};

const readContent = (data: any): string => {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part: any) => (typeof part === 'string' ? part : part?.text || '')).join('');
    return '';
};

export const makeSoreCall = (api: SoreEndpoint, signal?: AbortSignal): ChatCall => async messages => {
    try {
        const data = await safeFetchJson(endpoint(api.baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
            body: JSON.stringify({ model: api.model, messages, temperature: 0.7, max_tokens: 1500 }),
            signal,
        }, 0, 120000, { appId: 'assistant', appName: '助手', purpose: 'Sore 答疑' });
        const raw = readContent(data);
        if (!raw.trim()) throw new Error('模型回了空白');
        return stripThinkTags(raw);
    } catch (error: any) {
        if (error?.name === 'AbortError') throw error;
        throw new Error(scrubSecret(error?.message || String(error), api.apiKey));
    }
};

/** 「測試API」：沒設就直接說沒設，不打請求 */
export const testApiConnection = async (api: Partial<SoreEndpoint> | undefined): Promise<{ ok: boolean; message: string }> => {
    if (!api?.baseUrl?.trim()) return { ok: false, message: '網址沒填' };
    if (!api.model?.trim()) return { ok: false, message: '模型沒填' };
    const started = Date.now();
    try {
        const data = await safeFetchJson(endpoint(api.baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || ''}` },
            body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
        }, 0, 30000, { appId: 'assistant', appName: '助手', purpose: 'Sore 測試連線' });
        const reply = readContent(data);
        return { ok: true, message: `成功（${((Date.now() - started) / 1000).toFixed(1)} 秒，模型 ${api.model}${reply ? '' : '，但回了空白'}）` };
    } catch (error: any) {
        return { ok: false, message: `失敗：${scrubSecret(error?.message || String(error), api.apiKey)}` };
    }
};
