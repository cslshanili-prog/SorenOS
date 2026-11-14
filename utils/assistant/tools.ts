/**
 * Sore 的工具（plans/ai-assistant.md 第 4 節）。第 1 批只有答疑用的「讀」工具，全部自動執行：
 * - 查看設定概況：有沒有設（不讀、不回 API Key）
 * - 測試API：打一次很小的請求
 * - 讀說明：給用戶看的專題說明
 * 寫的工具（第 2 批起）不在這裡執行，會變成提案卡片。
 */
import type { APIConfig, CharacterProfile, GroupProfile } from '../../types';
import { findGuide, SORE_GUIDES } from './knowledge';

export interface SoreSettingsInput {
    apiConfig: APIConfig;
    lightLLM?: Partial<APIConfig>;
    apiPresetCount: number;
    characters: Pick<CharacterProfile, 'id' | 'name' | 'activeMsg2Config' | 'chatPresetId' | 'altOf'>[];
    groups: Pick<GroupProfile, 'id'>[];
    presetSceneDefaults?: Record<string, string | undefined>;
    /** 主動消息 2.0 的 Worker 網址（只看有沒有） */
    amsgWorkerUrl?: string;
    /** 這次 Sore 自己用的是哪組 API */
    soreApiLabel?: string;
}

export interface SoreToolContext {
    settings: () => Promise<SoreSettingsInput>;
    /** 打一次很小的請求；target：main 全域、light 副 API */
    testApi: (target: 'main' | 'light') => Promise<{ ok: boolean; message: string }>;
}

export interface SoreToolResult {
    ok: boolean;
    content: string;
}

export interface SoreToolDef {
    name: string;
    /** 給模型看的用法 */
    usage: string;
    run: (args: Record<string, unknown>, ctx: SoreToolContext) => Promise<SoreToolResult>;
}

const has = (v?: string) => (v && v.trim() ? '有' : '沒有');

/** 設定概況：只說有沒有設、模型名；Key 一律只回「有／沒有」 */
export const describeSettings = (s: SoreSettingsInput): string => {
    const a = s.apiConfig;
    const img = a.imageGenConfig;
    const visibleChars = s.characters.filter(c => !c.altOf);
    const amsgOn = visibleChars.filter(c => c.activeMsg2Config?.enabled).length;
    const presetUse = visibleChars.filter(c => c.chatPresetId && c.chatPresetId !== 'builtin').length;
    const defaults = Object.entries(s.presetSceneDefaults || {}).filter(([, v]) => v).map(([k]) => k);
    return [
        `全域 API：網址${has(a.baseUrl)}、Key ${has(a.apiKey)}、模型 ${a.model?.trim() || '（沒填）'}`,
        `副 API（記憶宮殿）：${s.lightLLM?.baseUrl?.trim() && s.lightLLM?.model?.trim() ? `有設，模型 ${s.lightLLM.model}` : '沒設（背景活兒會用全域）'}`,
        `API 庫：${s.apiPresetCount} 組`,
        `識圖中轉：${a.visionApi?.enabled ? '開' : '關'}`,
        `生圖：${img?.charImageGenEnabled ? `開（網址${has(img.baseUrl)}、模型 ${img.model?.trim() || '沒填'}）` : '關'}；角色在聊天裡發照片：${img?.charImageSendEnabled ? '開' : '關'}`,
        `語音：${a.ttsProvider || 'minimax'}（MiniMax Key ${has(a.minimaxApiKey)}、Fish Key ${has(a.fishAudioApiKey)}、ElevenLabs Key ${has(a.elevenLabsApiKey)}）`,
        `主動消息 2.0 Worker 網址：${has(s.amsgWorkerUrl)}；開了 2.0 的角色 ${amsgOn} 個`,
        `角色 ${visibleChars.length} 個、群 ${s.groups.length} 個；私聊自己選了自訂預設的角色 ${presetUse} 個；有設場景預設的場景：${defaults.join('、') || '沒有'}`,
        s.soreApiLabel ? `Sore 現在用的是：${s.soreApiLabel}` : '',
    ].filter(Boolean).join('\n');
};

export const SORE_TOOLS: SoreToolDef[] = [
    {
        name: '查看設定概況',
        usage: '參數 {}。看 API、副 API、生圖、語音、主動消息有沒有設、模型名（不會給你 Key）。答「為什麼不能用」之前先看這個。',
        run: async (_args, ctx) => ({ ok: true, content: describeSettings(await ctx.settings()) }),
    },
    {
        name: '測試API',
        usage: '參數 {"target": "main" 或 "light"}。main＝全域 API，light＝副 API。真的打一次很小的請求，回成功或錯誤訊息。用戶說角色不回、報錯時用。',
        run: async (args, ctx) => {
            const target = args.target === 'light' ? 'light' : 'main';
            const result = await ctx.testApi(target);
            return { ok: result.ok, content: `${target === 'main' ? '全域 API' : '副 API'}：${result.message}` };
        },
    },
    {
        name: '讀說明',
        usage: `參數 {"topic": "題目 id"}。不給 topic 會列出全部題目。題目：${SORE_GUIDES.map(g => `${g.id}（${g.title}）`).join('、')}。`,
        run: async (args) => {
            const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
            if (!topic) return { ok: true, content: SORE_GUIDES.map(g => `- ${g.id}：${g.title}`).join('\n') };
            const guide = findGuide(topic);
            return guide
                ? { ok: true, content: `# ${guide.title}\n${guide.content}` }
                : { ok: false, content: `沒有「${topic}」這篇。可以讀的：${SORE_GUIDES.map(g => g.id).join('、')}` };
        },
    },
];

export const findSoreTool = (name: string) => SORE_TOOLS.find(t => t.name === name);
