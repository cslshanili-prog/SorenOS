/**
 * 見面總結送進記憶宮殿（utils/dateSummary.ts 的另一半，分開是因為這裡會拉進整個記憶宮殿管線）。
 * 跟見面每輪的記憶整理用同一套設定：角色開了記憶宮殿、設了 Embedding 才送；
 * 副 API 沒設就用主 API（同 DateApp 的 runMemoryPalacePostHook）。
 */

import type { CharacterProfile, DateStory, DateStorySummary } from '../types';
import type { EmbeddingConfig } from './memoryPalace/types';
import { importDateStorySummary, type LightLLMConfig } from './memoryPalace/pipeline';
import { updateDateSummary } from './dateSummary';
import { dateStoryLabel } from './dateStory';

export interface DatePalaceConfig { embedding: EmbeddingConfig; llm: LightLLMConfig }

export const resolveDatePalaceConfig = (
    char: CharacterProfile,
    memoryPalaceConfig: { embedding?: EmbeddingConfig; lightLLM?: LightLLMConfig } | undefined,
    apiConfig: { baseUrl: string; apiKey: string; model: string },
): DatePalaceConfig | null => {
    if (!char.memoryPalaceEnabled) return null;
    const embedding = memoryPalaceConfig?.embedding;
    if (!embedding?.baseUrl || !embedding?.apiKey) return null;
    const light = memoryPalaceConfig?.lightLLM;
    const llm = light?.baseUrl ? light : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
    if (!llm.baseUrl) return null;
    return { embedding, llm };
};

/** 送一段總結進宮殿；成功就在總結上記下送進去的時間。回傳要給用戶看的結果 */
export const sendDateSummaryToPalace = async (input: {
    char: CharacterProfile;
    story: DateStory;
    summary: DateStorySummary;
    happenedAt: number;
    config: DatePalaceConfig;
    final?: boolean;
}): Promise<'stored' | 'duplicate' | 'busy' | 'error'> => {
    const result = await importDateStorySummary({
        charId: input.char.id,
        content: input.summary.text,
        happenedAt: input.happenedAt,
        final: input.final,
        tags: [dateStoryLabel(input.story)],
    }, input.config.embedding, input.config.llm);
    if (result.error === 'lock') return 'busy';
    if (result.error) return 'error';
    // 跟已有記憶太像被去重跳過，也當送過了（宮殿裡已經有這件事）
    await updateDateSummary(input.story.id, input.summary.id, { palaceAt: Date.now() });
    return result.stored > 0 ? 'stored' : 'duplicate';
};
