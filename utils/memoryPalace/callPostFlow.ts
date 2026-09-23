/**
 * 通話（CallApp）的記憶宮殿後置流程。
 *
 * 聊天（useChatAI）與見面（DateApp.runMemoryPalacePostHook）在每輪回復後都會
 * 觸發緩衝區處理——通話消息與它們同存一條消息流、同受一條水位線統計，卻一直
 * 沒有自己的觸發器：長通話攢下的緩衝區只能等用戶下次去別的 App 才被整理。
 * 這裡把 DateApp 的鉤子提煉成可注入依賴的獨立函數，行為保持一致：
 *   緩衝區處理（水位線推進）→ 自動歸檔合併 + hide 追平 → 50 輪認知消化。
 *
 * 全局「xx正在整理記憶」提示不在這裡做——pipeline 真正開始處理時會廣播
 * `memory-palace-processing` 事件，由 OSContext 統一彈 toast（三個入口共享）。
 */
import type { CharacterProfile } from '../../types';
import { DB } from '../db';
import {
    getMemoryPalaceHighWaterMark,
    mergePalaceFragmentsIntoMemories,
    processNewMessages,
} from './pipeline';
import { incrementDigestRound, runCognitiveDigestion } from './digestion';

export interface CallPalacePostFlowInput {
    char: CharacterProfile;
    /** 讀取角色的最新狀態（流程是異步的，用戶中途可能關掉宮殿/改設置）。 */
    getLiveChar: () => CharacterProfile | null | undefined;
    memoryPalaceConfig?: { embedding?: any; lightLLM?: any } | null;
    apiConfig: { baseUrl?: string; apiKey?: string; model?: string };
    userName?: string;
    updateCharacter: (id: string, patch: Partial<CharacterProfile>) => void;
    onStatus?: (text: string) => void;
}

export async function runCallMemoryPalacePostFlow(input: CallPalacePostFlowInput): Promise<void> {
    const liveBefore = input.getLiveChar();
    if (!liveBefore?.memoryPalaceEnabled) return;

    const mpEmb = input.memoryPalaceConfig?.embedding;
    const mpLLMConfigured = input.memoryPalaceConfig?.lightLLM;
    const mpLLM = mpLLMConfigured?.baseUrl
        ? mpLLMConfigured
        : { baseUrl: input.apiConfig.baseUrl, apiKey: input.apiConfig.apiKey, model: input.apiConfig.model };
    if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM.baseUrl) return;

    const recentMsgs = await DB.getRecentMessagesByCharId(input.char.id, 50);
    const pipelineResult = await processNewMessages(
        recentMsgs,
        input.char.id,
        input.char.name,
        mpEmb,
        mpLLM,
        input.userName || '',
        false,
        stage => input.onStatus?.(stage),
    );

    // pipeline 跑的過程中用戶可能關掉了宮殿，後續動作前都要再核對一次。
    const liveAfter = input.getLiveChar();
    if (!liveAfter?.memoryPalaceEnabled) return;

    if ((liveAfter as any).autoArchiveEnabled) {
        try {
            const patch: Partial<CharacterProfile> = {};
            if (pipelineResult?.autoArchive) {
                patch.memories = mergePalaceFragmentsIntoMemories(
                    liveAfter.memories || [],
                    pipelineResult.autoArchive.fragments,
                );
            }
            // 隱藏線追平到向量高水位，與聊天/見面側同一邏輯。
            const hwm = getMemoryPalaceHighWaterMark(input.char.id);
            const curHide = ((liveAfter as any).hideBeforeMessageId as number) || 0;
            if (hwm > curHide) (patch as any).hideBeforeMessageId = hwm;
            if (Object.keys(patch).length > 0) input.updateCharacter(input.char.id, patch);
        } catch (e: any) {
            console.warn(`📚 [CallApp AutoArchive] 失敗（不影響 palace）: ${e?.message || e}`);
        }
    }

    // 50 輪自動認知消化（與聊天/見面共享同一個按 charId 持久化的計數器）
    const shouldAutoDigest = incrementDigestRound(input.char.id);
    if (shouldAutoDigest) {
        input.onStatus?.(`${input.char.name}閉上眼睛，開始整理內心…`);
        const persona = [liveAfter.systemPrompt || '', liveAfter.worldview || ''].filter(Boolean).join('\n');
        await runCognitiveDigestion(input.char.id, input.char.name, persona, mpLLM, false, input.userName, mpEmb);
    }
}
