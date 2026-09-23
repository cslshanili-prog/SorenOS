import type { UserImpression } from '../types';
import { normalizeUserImpression } from './impression';
import { extractContent, extractJson } from './safeApi';

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Tolerate presentation/quoting errors, but never save a truncated or empty replacement. */
export function parseGeneratedImpression(completion: any): UserImpression {
    const reason = completion?.choices?.[0]?.finish_reason;
    if (reason === 'length' || reason === 'max_tokens') {
        throw new Error('印象輸出達到長度上限，未生成完整檔案；原有印象未修改。請調整模型輸出設置後再試。');
    }
    if (reason === 'content_filter') {
        throw new Error('模型未返回完整印象（內容被服務商攔截）；原有印象未修改。');
    }
    // Reasoning is not a final answer: never persist a draft schema from the thinking channel.
    const message = completion?.choices?.[0]?.message;
    const content = extractContent({ choices: [{ message: { content: message?.content } }] });
    if (!content) throw new Error('模型沒有返回印象正文；原有印象未修改。');
    const raw = extractJson(content, { allowTruncated: false, silent: true });
    const candidate = isRecord(raw) && !raw.personality_core
        ? raw.impression ?? raw.result ?? raw.data
        : raw;
    const complete = isRecord(candidate)
        && ['value_map', 'behavior_profile', 'emotion_schema', 'personality_core', 'mbti_analysis'].every(key => isRecord(candidate[key]))
        && Array.isArray(candidate.observed_changes)
        && typeof candidate.personality_core.summary === 'string' && candidate.personality_core.summary.trim()
        && typeof candidate.value_map.core_values === 'string' && candidate.value_map.core_values.trim()
        && typeof candidate.behavior_profile.tone_style === 'string' && candidate.behavior_profile.tone_style.trim()
        && isRecord(candidate.emotion_schema.triggers)
        && isRecord(candidate.mbti_analysis.dimensions);
    const normalized = complete ? normalizeUserImpression(candidate) : undefined;
    if (!normalized) {
        throw new Error('模型返回的印象 JSON 不完整或格式異常，無法安全恢復；原有印象未修改。請保留本次 API 響應用於排查。');
    }
    return normalized;
}
