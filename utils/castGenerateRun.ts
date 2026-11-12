/**
 * AI 批量生成配角：打 API 的那一半（純邏輯在 utils/castGenerate.ts）。用全局 API，一次生成。
 */
import type { APIConfig } from '../types';
import { extractContent, safeResponseJson } from './safeApi';
import { buildCastGenPrompt, parseCastDrafts, type CastDraft } from './castGenerate';

export async function requestCastDrafts(args: Parameters<typeof buildCastGenPrompt>[0] & { apiConfig: APIConfig; signal?: AbortSignal }): Promise<CastDraft[]> {
    const { apiConfig, signal, ...promptArgs } = args;
    if (!apiConfig.baseUrl || !apiConfig.apiKey) throw new Error('請先配置 API');
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [{ role: 'user', content: buildCastGenPrompt(promptArgs) }],
            temperature: 0.9,
            max_tokens: 8000,
        }),
        signal,
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const drafts = parseCastDrafts(extractContent(await safeResponseJson(response)));
    if (!drafts.length) throw new Error('生成的內容沒看懂，再試一次');
    return drafts;
}
