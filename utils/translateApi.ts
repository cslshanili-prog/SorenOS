/**
 * 翻譯 API（plans/chat-language.md 第 2 批）：把一串句子翻成指定語言。
 *
 * - 用哪家看 `apiConfig.translationApi.provider`；沒設就用主 API 的聊天模型翻（llm）。
 * - llm 的網址／Key／模型沒填，也退回主 API。
 * - DeepL 不開 CORS，經用戶自己的主動消息 2.0 Worker（POST /deepl-translate）轉一手。
 * - 錯誤訊息一律過 scrubKeys，Key 不會出現在畫面或記錄裡。
 */
import type { APIConfig, TranslationApiConfig, TranslationProvider } from '../types';
import { extractContent, safeFetchJson } from './safeApi';
import { scrubKeys } from './assistant/client';

import type { ApiCallMeta } from './apiCallLog';
export const TRANSLATION_PROVIDERS: ReadonlyArray<{ value: TranslationProvider; label: string; hint: string }> = [
    { value: 'llm', label: '聊天模型', hint: '挑一組便宜的小模型；唯一能好好翻粵語、會照語氣翻的' },
    { value: 'deepl', label: 'DeepL', hint: '要經過你的主動消息 2.0 Worker；不支援粵語' },
    { value: 'google', label: 'Google', hint: 'Cloud Translation API Key；不支援粵語' },
    { value: 'azure', label: 'Azure', hint: 'Translator 的 Key 和區域' },
];

/** 各家的語言代碼；查不到（自訂語言、某家不支援的）回 null。 */
const CODES: Record<string, Partial<Record<Exclude<TranslationProvider, 'llm'>, string>>> = {
    'English': { deepl: 'EN-US', google: 'en', azure: 'en' },
    '繁體中文': { deepl: 'ZH-HANT', google: 'zh-TW', azure: 'zh-Hant' },
    '简体中文': { deepl: 'ZH-HANS', google: 'zh-CN', azure: 'zh-Hans' },
    '粵語': { azure: 'yue' },
    '日本語': { deepl: 'JA', google: 'ja', azure: 'ja' },
    '한국어': { deepl: 'KO', google: 'ko', azure: 'ko' },
    'Français': { deepl: 'FR', google: 'fr', azure: 'fr' },
};

export const providerLangCode = (provider: TranslationProvider, lang: string): string | null =>
    provider === 'llm' ? lang : (CODES[lang]?.[provider] ?? null);

export class TranslateError extends Error {}

const providerName = (p: TranslationProvider) => TRANSLATION_PROVIDERS.find(x => x.value === p)?.label || p;

/** 這組設定實際會用哪家、填齊了沒有（設定頁顯示用）。 */
export const translationReadiness = (apiConfig: APIConfig): { provider: TranslationProvider; ready: boolean; reason?: string } => {
    const cfg = apiConfig.translationApi;
    const provider = cfg?.provider || 'llm';
    if (provider === 'llm') {
        const base = (cfg?.baseUrl || apiConfig.baseUrl || '').trim();
        const key = (cfg?.apiKey || apiConfig.apiKey || '').trim();
        return base && key ? { provider, ready: true } : { provider, ready: false, reason: '主 API 還沒設好' };
    }
    if (provider === 'deepl') return cfg?.deeplKey?.trim() ? { provider, ready: true } : { provider, ready: false, reason: '還沒填 DeepL Key' };
    if (provider === 'google') return cfg?.googleKey?.trim() ? { provider, ready: true } : { provider, ready: false, reason: '還沒填 Google API Key' };
    return cfg?.azureKey?.trim() && cfg?.azureRegion?.trim() ? { provider, ready: true } : { provider, ready: false, reason: '還沒填 Azure Key 和區域' };
};

const secretsOf = (apiConfig: APIConfig): string[] => {
    const c = apiConfig.translationApi;
    return [apiConfig.apiKey, c?.apiKey, c?.deeplKey, c?.googleKey, c?.azureKey].filter((k): k is string => !!k);
};

const CANTONESE = /粵|粤|廣東話|广东话|cantonese/i;

export const buildLlmTranslatePrompt = (to: string): string => [
    `你是翻譯。把使用者給的 JSON 陣列裡的每一句都翻成${to}${CANTONESE.test(to) ? '（廣東話口語，例如「係」「唔」「嘅」）' : ''}。`,
    '- 保持原本的語氣、口吻、親疏、語助詞和表情符號；不要變正式，不要加解釋。',
    `- 原本就是${to}的部分照抄。`,
    '- 只輸出一個 JSON 字串陣列，句數跟輸入一樣、順序一樣。',
].join('\n');

/** 從模型回覆裡挖出 JSON 字串陣列（容許包在 ``` 裡、前後有廢話）。 */
export const parseLlmTranslation = (raw: string, expected: number): string[] => {
    const text = raw.replace(/```(?:json)?/gi, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
        try {
            const arr = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(arr) && arr.length === expected && arr.every(x => typeof x === 'string')) return arr.map(s => s.trim());
        } catch { /* fall through */ }
    }
    // 只翻一句時，模型常常直接回譯文本身
    if (expected === 1 && text && !text.startsWith('[')) return [text];
    throw new TranslateError('翻譯模型回的格式不對');
};

async function translateWithLlm(texts: string[], to: string, apiConfig: APIConfig, meta?: ApiCallMeta): Promise<string[]> {
    const c = apiConfig.translationApi;
    const baseUrl = (c?.baseUrl || apiConfig.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = (c?.apiKey || apiConfig.apiKey || '').trim();
    const model = c?.model?.trim() || apiConfig.model || '';
    if (!baseUrl || !apiKey) throw new TranslateError('主 API 還沒設好，沒辦法用聊天模型翻');
    const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model.trim(),
            messages: [
                { role: 'system', content: buildLlmTranslatePrompt(to) },
                { role: 'user', content: JSON.stringify(texts) },
            ],
            temperature: 0.2,
            stream: false,
        }),
    }, 1, 60_000, { appName: '消息', purpose: '翻譯', ...meta });
    return parseLlmTranslation(extractContent(data), texts.length);
}

async function translateWithDeepl(texts: string[], to: string, cfg: TranslationApiConfig): Promise<string[]> {
    const target = providerLangCode('deepl', to);
    if (!target) throw new TranslateError(`DeepL 不支援「${to}」，換成用聊天模型翻`);
    const { ActiveMsgStore } = await import('./activeMsgStore');
    const g = await ActiveMsgStore.getGlobalConfig().catch(() => null);
    const workerUrl = (g?.workerUrl || '').trim().replace(/\/+$/, '');
    if (!workerUrl) throw new TranslateError('DeepL 要經過主動消息 2.0 的 Worker，先到系統設置填好 Worker');
    const res = await fetch(`${workerUrl}/deepl-translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(g?.serverToken ? { 'X-Client-Token': g.serverToken } : {}) },
        body: JSON.stringify({ authKey: cfg.deeplKey?.trim(), text: texts, target_lang: target }),
    });
    if (res.status === 404) throw new TranslateError('Worker 還是舊版，沒有 DeepL 轉發；到系統設置更新 Worker');
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body?.success) throw new TranslateError(`DeepL 翻譯失敗：${body?.error?.message || `HTTP ${res.status}`}`);
    const out: unknown = body?.data?.translations;
    if (!Array.isArray(out) || out.length !== texts.length) throw new TranslateError('DeepL 回的句數不對');
    return out.map((t: any) => String(t?.text ?? ''));
}

async function translateWithGoogle(texts: string[], to: string, cfg: TranslationApiConfig): Promise<string[]> {
    const target = providerLangCode('google', to);
    if (!target) throw new TranslateError(`Google 不支援「${to}」，換成用聊天模型翻`);
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(cfg.googleKey?.trim() || '')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: texts, target, format: 'text' }),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new TranslateError(`Google 翻譯失敗：${body?.error?.message || `HTTP ${res.status}`}`);
    const out: unknown = body?.data?.translations;
    if (!Array.isArray(out) || out.length !== texts.length) throw new TranslateError('Google 回的句數不對');
    return out.map((t: any) => String(t?.translatedText ?? ''));
}

async function translateWithAzure(texts: string[], to: string, cfg: TranslationApiConfig): Promise<string[]> {
    const target = providerLangCode('azure', to);
    if (!target) throw new TranslateError(`Azure 不支援「${to}」，換成用聊天模型翻`);
    const res = await fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(target)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': cfg.azureKey?.trim() || '',
            'Ocp-Apim-Subscription-Region': cfg.azureRegion?.trim() || '',
        },
        body: JSON.stringify(texts.map(Text => ({ Text }))),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new TranslateError(`Azure 翻譯失敗：${body?.error?.message || `HTTP ${res.status}`}`);
    if (!Array.isArray(body) || body.length !== texts.length) throw new TranslateError('Azure 回的句數不對');
    return body.map((r: any) => String(r?.translations?.[0]?.text ?? ''));
}

/**
 * 把 texts 一句一句翻成 `to`（給模型看的語言名，例如「繁體中文」）。
 * 回傳跟 texts 等長；失敗丟 TranslateError（訊息已拿掉 Key）。
 */
/** meta：API 調用記錄上這一批是替誰翻的（不給就只標「翻譯」） */
export async function translateTexts(texts: string[], to: string, apiConfig: APIConfig, meta?: ApiCallMeta): Promise<string[]> {
    const items = texts.map(t => t.trim());
    if (!items.length) return [];
    const cfg = apiConfig.translationApi;
    const provider = cfg?.provider || 'llm';
    try {
        if (provider === 'deepl') return await translateWithDeepl(items, to, cfg!);
        if (provider === 'google') return await translateWithGoogle(items, to, cfg!);
        if (provider === 'azure') return await translateWithAzure(items, to, cfg!);
        return await translateWithLlm(items, to, apiConfig, meta);
    } catch (e: any) {
        const msg = scrubKeys(String(e?.message || e), secretsOf(apiConfig)).slice(0, 200);
        throw new TranslateError(e instanceof TranslateError ? msg : `${providerName(provider)} 翻譯失敗：${msg}`);
    }
}
