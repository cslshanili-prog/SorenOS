import type { APIConfig, CharacterProfile, ImageGenApiConfig, MomentPost, NPCProfile, UserProfile } from '../types';
import { nowInTimeZone, resolveCharTimeZone } from './timezone';
import { isScheduleFeatureOn } from './scheduleFeature';
import { getDailyScheduleForChar } from './dailySchedule';
import { resolveScheduleSlots } from './scheduleInjection';
import { loadCharacterContextRange } from './chatContextRange';
import { formatChatHistoryForSchedule } from './scheduleGenerator';
import { resolveUserProfileForChar } from './userPersona';
import { resolveNpcApi } from './npcMemory';
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

/** 給朋友圈看的最近聊天，取最後幾則就好：要的是「最近發生了什麼」，不是整段對話 */
export const MOMENT_CHAT_TAIL = 16;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 發朋友圈前的「此刻」段（2026-10-06）：現在幾點（角色那邊的時間）、正在做什麼（今天日程的當前時段）、
 * 最近跟用戶聊了什麼。純拼字串，各段沒有就不寫；全空回傳空字串。
 */
export function buildMomentContextBlock(parts: { now?: Date; activity?: string; chatBlock?: string }): string {
    const lines: string[] = [];
    if (parts.now) {
        const d = parts.now;
        lines.push(`現在是 ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 星期${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（你所在地的時間）。`);
    }
    if (parts.activity) lines.push(`照你今天的日程，你這個時段正在：${parts.activity}。`);
    const chat = parts.chatBlock?.trim();
    if (!lines.length && !chat) return '';
    return ['', '## 此刻', ...lines, ...(chat ? ['', chat] : []), ''].join('\n');
}

/** 發朋友圈的「公開」提醒：最近的聊天是私下的，貼文是大家都看得到的。有給聊天記錄時才加。 */
export const MOMENT_PRIVACY_NOTE = '朋友圈是公開的，你的朋友、認識的人都看得到。可以呼應最近發生的事和你現在的狀態、心情，但只發你願意讓大家看到的那一面：不要引用你們私聊的原話，不要寫出對方的隱私或你們之間私密的事。';

async function loadMomentContext(char: CharacterProfile, userProfileBase?: UserProfile): Promise<{ block: string; hasChat: boolean }> {
    const timeAware = char.timeAwarenessEnabled !== false;
    const now = timeAware ? nowInTimeZone(resolveCharTimeZone(char)) : undefined;
    let activity: string | undefined;
    if (isScheduleFeatureOn(char)) {
        try {
            const schedule = await getDailyScheduleForChar(char);
            // 關掉時間感知的角色不給「現在」，但日程照樣有自己的總開關——拿用戶設備時間判斷當前時段
            activity = resolveScheduleSlots(schedule, now ?? new Date()).current?.activity;
        } catch (e) {
            console.warn('[Moments] 讀日程失敗，這次不帶', e);
        }
    }
    let chatBlock = '';
    if (userProfileBase) {
        try {
            const messages = (await loadCharacterContextRange(char)).messages.slice(-MOMENT_CHAT_TAIL);
            chatBlock = formatChatHistoryForSchedule(messages, char, resolveUserProfileForChar(userProfileBase, char));
        } catch (e) {
            console.warn('[Moments] 讀最近聊天失敗，這次不帶', e);
        }
    }
    return { block: buildMomentContextBlock({ now, activity, chatBlock }), hasChat: !!chatBlock.trim() };
}

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
    /** 給了就帶上最近跟（這個角色眼中的）用戶聊的幾則；不給就只帶時間和日程 */
    userProfileBase?: UserProfile;
}): Promise<MomentPost> {
    const { char, apiConfig, recent, requireImage, source = 'manual' } = params;
    const api = params.api?.baseUrl ? params.api : resolveCharacterChatApi(char, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('沒有可用的 API');
    const imageGenConfig = params.imageGenConfig ?? apiConfig.imageGenConfig;
    const withImage = canGenerateMomentImage(imageGenConfig);
    if (requireImage && !withImage) throw new Error('先在設置裡開啟並配置好生圖 API');

    // 2026-10-06：以前 skipMemories、也不給時間和聊天，發的朋友圈跟你們之間發生的事接不上。
    // 現在帶記憶摘要（月度＋當月日度）、角色那邊的現在時間、當前日程時段、最近幾則聊天。
    const roleSettingsBlock = ContextBuilder.buildRoleSettingsContext(char);
    const moment = await loadMomentContext(char, params.userProfileBase);
    const systemBlock = `${roleSettingsBlock}${moment.block}`;
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: systemBlock },
                { role: 'user', content: buildTrajectoryMomentsPrompt(systemBlock, recent, { privacyNote: moment.hasChat ? MOMENT_PRIVACY_NOTE : undefined }) },
            ],
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

/** NPC 發文的提示詞：NPC 沒有完整人設也沒有立繪，只發純文字。 */
export function buildNpcMomentPrompt(npc: Pick<NPCProfile, 'name' | 'description' | 'worldview' | 'memory'>, recent: Array<Pick<MomentPost, 'content'>>): string {
    const lines = [
        `你是「${npc.name}」，故事裡的一個配角。`,
        npc.description?.trim() ? `【你的設定】\n${npc.description.trim()}` : '',
        npc.worldview?.trim() ? `【世界觀】\n${npc.worldview.trim()}` : '',
        npc.memory?.trim() ? `【你記得的事】\n${npc.memory.trim()}` : '',
        recent.length ? `最近發過這些，這次換個不一樣的場景或心情：${recent.slice(0, 5).map(p => p.content.slice(0, 20)).join('、')}` : '',
        `現在用你的口吻發一條朋友圈動態：1～3 句，口語化，像真的在發朋友圈，可以帶點情緒。只輸出動態正文，不要加引號、不要解釋。`,
    ];
    return lines.filter(Boolean).join('\n\n');
}

/** 讓一個 NPC 發一篇純文字朋友圈。API 用 NPC 自己配的，沒配用全局。 */
export async function generateNpcMoment(params: {
    npc: NPCProfile;
    apiConfig: APIConfig;
    recent: Array<Pick<MomentPost, 'content'>>;
    source?: MomentPost['source'];
}): Promise<MomentPost> {
    const { npc, apiConfig, recent, source = 'auto' } = params;
    const api = resolveNpcApi(npc, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('沒有可用的 API');
    const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: buildNpcMomentPrompt(npc, recent) }], temperature: 0.95 }),
    });
    if (!response.ok) throw new Error(`API 返回 ${response.status}`);
    const content = (extractContent(await safeResponseJson(response)) || '').trim().replace(/^[「『"“]|[」』"”]$/g, '').trim().slice(0, 400);
    if (!content) throw new Error('NPC 發文沒有內容');
    return createMomentPost({ author: { kind: 'npc', id: npc.id, name: npc.name }, content, source });
}
