import type { APIConfig, CharacterProfile, ImageGenApiConfig, MomentPost } from '../types';
import { ContextBuilder } from './context';
import { resolveCharacterChatApi } from './characterApi';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { buildTrajectoryMomentsPrompt, parseTrajectoryMomentDraft } from './trajectory';
import { generateImage, buildCharacterImagePrompt, resolveCharacterReferenceImage } from './imageGeneration';
import { migrateDataUrlToRef } from './blobRef';
import { createMomentPost } from './momentsStore';

/**
 * 讓一個角色發一篇朋友圈（寫進單一貼文池）：軌跡 Moments 的「✦ 生成一條」和朋友圈頁的「↻ 重整」共用。
 * 文案用角色自己的模型（resolveCharacterChatApi）；生圖設定開著才配圖，沒開就發純文字。
 */

export const canGenerateMomentImage = (config: ImageGenApiConfig | undefined): config is ImageGenApiConfig =>
    !!(config?.charImageGenEnabled && config?.baseUrl && config?.model);

export async function generateCharacterMoment(params: {
    char: CharacterProfile;
    apiConfig: APIConfig;
    /** 指定用哪組 API（查手機用它自己的共用設定）；不給就用角色自己的模型，沒配再退回全局 */
    api?: { baseUrl: string; apiKey: string; model: string } | null;
    /** 不給就用 apiConfig.imageGenConfig */
    imageGenConfig?: ImageGenApiConfig;
    /** 這個角色最近發過的（避免重複同一個場景） */
    recent: Array<Pick<MomentPost, 'content'>>;
    /** 一定要配圖（軌跡 Moments 的生成）；不要求時生圖沒設定就發純文字 */
    requireImage?: boolean;
    source?: MomentPost['source'];
}): Promise<MomentPost> {
    const { char, apiConfig, recent, requireImage, source = 'manual' } = params;
    const api = params.api?.baseUrl ? params.api : resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('沒有可用的 API');
    const imageGenConfig = params.imageGenConfig ?? apiConfig.imageGenConfig;
    const withImage = canGenerateMomentImage(imageGenConfig);
    if (requireImage && !withImage) throw new Error('先在設置裡開啟並配置好生圖 API');

    const roleSettingsBlock = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'system', content: roleSettingsBlock }, { role: 'user', content: buildTrajectoryMomentsPrompt(roleSettingsBlock, recent) }],
            temperature: 0.95,
        }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const draft = parseTrajectoryMomentDraft(extractJson(extractContent(await safeResponseJson(response))));
    if (!draft) throw new Error('這次沒解析出動態內容');

    let images: string[] = [];
    if (withImage) {
        try {
            const imagePrompt = buildCharacterImagePrompt(char, draft.imagePrompt);
            const referenceBlob = await resolveCharacterReferenceImage(char, { description: draft.content });
            const { dataUrl } = await generateImage(imageGenConfig, imagePrompt, referenceBlob || undefined);
            images = [await migrateDataUrlToRef(dataUrl)];
        } catch (e) {
            // 軌跡那邊一定要圖；重整時生圖失敗就發純文字，別整篇丟掉
            if (requireImage) throw e;
            console.warn(`[Moments] ${char.name} 的配圖生成失敗，改發純文字`, e);
        }
    }

    return createMomentPost({
        author: { kind: 'character', id: char.id, name: char.name },
        content: draft.content,
        images,
        imagePrompt: draft.imagePrompt,
        source,
    });
}

/** 重整時挑誰發：可以發的角色裡隨機挑 1～3 位（人少就全發）。 */
export function pickRefreshPosters<T extends { id: string }>(candidates: T[], random: () => number = Math.random): T[] {
    if (candidates.length <= 1) return [...candidates];
    const count = Math.min(candidates.length, 1 + Math.floor(random() * 3));
    const pool = [...candidates];
    const picked: T[] = [];
    while (picked.length < count && pool.length) {
        picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    }
    return picked;
}
