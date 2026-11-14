/**
 * Sore 的工具（plans/ai-assistant.md 第 4 節）。「讀」的工具自動執行；「寫」的工具不寫，回一張提案卡片：
 * - 查看設定概況：有沒有設（不讀、不回 API Key）
 * - 測試API：打一次很小的請求
 * - 讀說明：給用戶看的專題說明
 * - 讀取CSS：各處美化有沒有設；給位置就回現在的內容＋可用選擇器＋規矩
 * - 寫CSS／清除CSS：檢查過了出提案卡片，用戶按「套用」才寫（第 2 批）
 */
import type { APIConfig, AssistantProposal, CharacterProfile, GroupProfile } from '../../types';
import { findGuide, SORE_GUIDES } from './knowledge';
import {
    CSS_LOCATIONS, type CssData, describeCssStatus, describeLocation, findCssLocation, newChatThemeId,
    readLocationCss, resolveCssTarget, validateLocationCss,
} from './cssLocations';

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
    /** 美化位置的現況（主題、角色、群、自訂氣泡主題）；沒給就不能用 CSS 工具 */
    cssData?: () => CssData;
}

/** 寫的工具交回來的提案（engine 補上 id 和 status） */
export type SoreProposalDraft = Omit<AssistantProposal, 'id' | 'status'>;

export interface SoreToolResult {
    ok: boolean;
    content: string;
    proposal?: SoreProposalDraft;
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

const LOCATION_IDS = CSS_LOCATIONS.map(l => `${l.id}（${l.label}）`).join('、');

const cssLocationAndTarget = (args: Record<string, unknown>, ctx: SoreToolContext, allowNew = false) => {
    if (!ctx.cssData) return { error: '這裡不能改美化。' } as const;
    const loc = findCssLocation(args.location);
    if (!loc) return { error: `沒有「${String(args.location ?? '')}」這個位置。能用的：${LOCATION_IDS}` } as const;
    const data = ctx.cssData();
    const target = resolveCssTarget(loc, args.target, data, { allowNew });
    if ('error' in target) return { error: target.error } as const;
    return { loc, data, target } as const;
};

const PROPOSED_NOTE = '提案卡片已經給用戶看了，要等用戶按「套用」才會寫進去。用一兩句話說你改了什麼就好，不要把 CSS 再貼一次。';

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
    {
        name: '讀取CSS',
        usage: `參數 {"location": "位置 id", "target": "角色／群／氣泡主題的名字"}。都不給＝列出各處美化有沒有設、有哪些角色和群。改 CSS 前一定先讀：拿到現在的內容、能用的選擇器和規矩。位置：${LOCATION_IDS}。`,
        run: async (args, ctx) => {
            if (!ctx.cssData) return { ok: false, content: '這裡不能讀美化。' };
            if (args.location === undefined || args.location === '') return { ok: true, content: describeCssStatus(ctx.cssData()) };
            const picked = cssLocationAndTarget(args, ctx);
            if ('error' in picked) return { ok: false, content: picked.error! };
            return { ok: true, content: describeLocation(picked.loc, picked.target, picked.data) };
        },
    },
    {
        name: '寫CSS',
        usage: '參數 {"location": "位置 id", "target": "名字", "css": "整段新的 CSS", "summary": "一句話說改了什麼"}。css 是整段取代、不是追加：要留原本的就一起寫進去。檢查過了會變成提案卡片給用戶，按「套用」才寫入；檢查不過會回錯誤，改好再送。氣泡主題的 target 是主題名字，不存在會新建。',
        run: async (args, ctx) => {
            const picked = cssLocationAndTarget(args, ctx, true);
            if ('error' in picked) return { ok: false, content: picked.error! };
            const { loc, data, target } = picked;
            const css = typeof args.css === 'string' ? args.css.trim() : '';
            if (!css) return { ok: false, content: '沒有 css。要清空請用「清除CSS」。' };
            const errors = validateLocationCss(loc, css);
            if (errors.length) return { ok: false, content: `檢查沒過，改好再送：\n${errors.slice(0, 8).map(e => `- ${e}`).join('\n')}` };
            const isNewTheme = loc.target === 'chatTheme' && !target.exists;
            return {
                ok: true,
                content: PROPOSED_NOTE,
                proposal: {
                    kind: 'css', location: loc.id,
                    targetId: isNewTheme ? newChatThemeId() : target.id,
                    targetLabel: target.label,
                    newThemeName: isNewTheme ? String(args.target).trim() : undefined,
                    css,
                    before: target.exists ? readLocationCss(loc, target.id, data) : '',
                    summary: typeof args.summary === 'string' ? args.summary.trim().slice(0, 200) || undefined : undefined,
                },
            };
        },
    },
    {
        name: '清除CSS',
        usage: '參數 {"location": "位置 id", "target": "名字"}。把那個位置的 CSS 清空（回到預設的樣子），一樣是提案卡片，用戶按「套用」才清。',
        run: async (args, ctx) => {
            const picked = cssLocationAndTarget(args, ctx);
            if ('error' in picked) return { ok: false, content: picked.error! };
            const { loc, data, target } = picked;
            const before = readLocationCss(loc, target.id, data);
            if (!before) return { ok: false, content: `${target.label}本來就是空的。` };
            return {
                ok: true,
                content: PROPOSED_NOTE,
                proposal: { kind: 'css', location: loc.id, targetId: target.id, targetLabel: target.label, css: '', before, summary: '清空' },
            };
        },
    },
];

export const findSoreTool = (name: string) => SORE_TOOLS.find(t => t.name === name);
