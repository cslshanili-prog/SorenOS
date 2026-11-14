/**
 * Sore 的工具（plans/ai-assistant.md 第 4 節）。「讀」的工具自動執行；「寫」的工具不寫，回一張提案卡片：
 * - 查看設定概況：有沒有設（不讀、不回 API Key）
 * - 測試API：打一次很小的請求
 * - 讀說明：給用戶看的專題說明
 * - 讀取CSS：各處美化有沒有設；給位置就回現在的內容＋可用選擇器＋規矩
 * - 寫CSS／清除CSS：檢查過了出提案卡片，用戶按「套用」才寫（第 2 批）
 * - 列出預設／讀取預設／讀取條目：讀；改預設／新建預設／設定預設用途：出提案（第 3 批，utils/assistant/presetOps.ts）
 */
import type { APIConfig, AssistantProposal, CharacterProfile, GroupProfile, StoryTheaterPresetDocument } from '../../types';
import { findGuide, SORE_GUIDES } from './knowledge';
import {
    CSS_LOCATIONS, type CssData, describeCssStatus, describeLocation, findCssLocation, newChatThemeId,
    readLocationCss, resolveCssTarget, validateLocationCss,
} from './cssLocations';
import {
    applyGeneralOps, applyStoryOps, buildNewPreset, describeEntry, describePreset, describePresetList, findPreset,
    newGeneralPresetId, newStoryPresetId, NEW_PRESET_SOURCES, parseBindings, type PresetChange, type PresetData,
    presetUsage, scenesNeededFor,
} from './presetOps';
import type { MeetingPresetDoc } from '../meetingPreset/types';
import { BUILTIN_PRESET, PRESET_SCENE_LABEL } from '../presetBinding';

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
    /** 預設的現況（第 3 批）；沒給就不能用預設工具 */
    presetData?: () => Promise<PresetData>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 寫的工具交回來的提案（engine 補上 id 和 status） */
export type SoreProposalDraft = DistributiveOmit<AssistantProposal, 'id' | 'status'>;

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

const PRESET_OPS_USAGE = `ops 是一串操作（照順序套）：
{"op":"edit","entry":"條目名或 id","content":"新全文","enabled":true,"name":"新名字","role":"system"}（content 是整段取代；資料佔位只能改 enabled）
{"op":"add","name":"名字","content":"內容","role":"system","after":"放在哪條後面"}（不給位置就放在聊天記錄前面）
{"op":"remove","entry":"…"}、{"op":"move","entry":"…","after":"…"}（或 before）
{"op":"params","temperature":0.9,"topP":1,"maxTokens":2000}、{"op":"rename","name":"…"}、{"op":"prefill","text":"…"}、{"op":"scenes","scenes":["chat","group"]}
正則（只在見面生效）：{"op":"addRegex","name":"名字","find":"/寫法/g","replace":"換成","placement":["ai"]}（placement：user、ai、worldinfo、reasoning；可加 "promptOnly":true 只改送出、"displayOnly":true 只改顯示、"trim":[…]、"minDepth"、"maxDepth"）；{"op":"editRegex","regex":"名字或 id",…要改的欄位}；{"op":"removeRegex","regex":"…"}
劇情預設只能用 edit（content、enabled）、params、rename、prefill。`;

const USE_USAGE = '"use": {"scenes": ["chat"], "chars": [{"name": "角色名", "for": "chat|call|date"}], "groups": ["群名"]}（可省略）';

const presetChangesNote = (changes: PresetChange[]) => changes.slice(0, 12).map(c => `- ${c.label}`).join('\n');

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
    ...PRESET_TOOLS(),
];

export const findSoreTool = (name: string) => SORE_TOOLS.find(t => t.name === name);

// ─── 預設（第 3 批） ───

function PRESET_TOOLS(): SoreToolDef[] {
    const noData = { ok: false, content: '這裡不能讀預設。' };
    return [
        {
            name: '列出預設',
            usage: '參數 {}。列出所有預設（通用、劇情）、誰在用、各場景的場景預設。改預設前先看這個。',
            run: async (_args, ctx) => (ctx.presetData ? { ok: true, content: describePresetList(await ctx.presetData()) } : noData),
        },
        {
            name: '讀取預設',
            usage: '參數 {"preset": "名字或 id"}。一份預設的概況：每條的 id、名字、開關、字數、是不是資料佔位；生成參數；正則清單。不含條目全文。',
            run: async (args, ctx) => {
                if (!ctx.presetData) return noData;
                const data = await ctx.presetData();
                const found = findPreset(args.preset, data);
                return 'error' in found ? { ok: false, content: found.error } : { ok: true, content: describePreset(found, data) };
            },
        },
        {
            name: '讀取條目',
            usage: '參數 {"preset": "…", "entry": "條目名或 id"} 或 {"preset": "…", "regex": "正則名或 id"}。一條的全文。要改內容前先讀。',
            run: async (args, ctx) => {
                if (!ctx.presetData) return noData;
                const data = await ctx.presetData();
                const found = findPreset(args.preset, data);
                if ('error' in found) return { ok: false, content: found.error };
                return args.regex !== undefined ? describeEntry(found, args.regex, true) : describeEntry(found, args.entry);
            },
        },
        {
            name: '改預設',
            usage: `參數 {"preset": "…", "ops": [...], "summary": "一句話說改了什麼", ${USE_USAGE}}。出提案卡片，用戶按「套用」才寫；這份有人在用的話卡片會寫出來。${PRESET_OPS_USAGE}`,
            run: async (args, ctx) => {
                if (!ctx.presetData) return noData;
                const data = await ctx.presetData();
                const found = findPreset(args.preset, data);
                if ('error' in found) return { ok: false, content: found.error };
                if (found.kind === 'story' && found.builtIn) return { ok: false, content: '內建劇情預設不能直接改：用「新建預設」from=劇情內建 複製一份再改。' };
                const ops = Array.isArray(args.ops) ? args.ops : [];
                return buildPresetProposal({
                    kind: found.kind,
                    presetId: found.kind === 'general' ? found.record.id : found.preset.id,
                    baseDoc: found.kind === 'general' ? found.record.doc : found.preset.document,
                    isNew: false, ops, use: args.use, summary: args.summary, data,
                });
            },
        },
        {
            name: '新建預設',
            usage: `參數 {"from": "${NEW_PRESET_SOURCES.join('／')}／或一份既有預設的名字", "name": "新名字", "ops": [...可省略], "summary": "…", ${USE_USAGE}}。複製一份新的（原本的不動），可以同時改內容、設給誰用。一樣是提案卡片，還原＝刪掉這份。`,
            run: async (args, ctx) => {
                if (!ctx.presetData) return noData;
                const data = await ctx.presetData();
                const built = buildNewPreset(args.from, args.name, data);
                if ('error' in built) return { ok: false, content: built.error };
                return buildPresetProposal({
                    kind: built.kind,
                    presetId: built.kind === 'general' ? newGeneralPresetId() : newStoryPresetId(),
                    baseDoc: built.doc,
                    isNew: true, ops: Array.isArray(args.ops) ? args.ops : [], use: args.use, summary: args.summary, data,
                    newFrom: String(args.from ?? ''),
                });
            },
        },
        {
            name: '設定預設用途',
            usage: `參數 {"preset": "名字／內建／跟著場景預設", ${USE_USAGE.replace('（可省略）', '')}}。把場景預設、角色的私聊／電話／見面、群設成用這份。「內建」＝明確用內建；「跟著場景預設」＝角色、群不自己選（只能用在 chars、groups）。一樣是提案卡片，還原設回原本的。`,
            run: async (args, ctx) => {
                if (!ctx.presetData) return noData;
                const data = await ctx.presetData();
                const ref = typeof args.preset === 'string' ? args.preset.trim() : '';
                const use = (args.use && typeof args.use === 'object' ? args.use : {}) as Record<string, unknown>;
                if (ref === '內建' || ref === '跟著場景預設') {
                    const wantsStory = Array.isArray(use.scenes) && use.scenes.some(x => ['story', '劇情'].includes(String(x)));
                    const parsed = parseBindings(use, wantsStory ? 'story' : 'general', data);
                    if ('error' in parsed) return { ok: false, content: parsed.error };
                    if (!parsed.bindings.length) return { ok: false, content: '沒說要設給誰（use）。' };
                    if (ref === '跟著場景預設' && parsed.bindings.some(b => b.kind === 'scene')) return { ok: false, content: '場景預設沒有「跟著場景預設」；要用內建就填「內建」。' };
                    return {
                        ok: true,
                        content: PROPOSED_NOTE,
                        proposal: {
                            kind: 'preset', presetKind: wantsStory ? 'story' : 'general', presetId: '', presetName: ref, isNew: false,
                            changes: parsed.bindings.map(b => ({ label: `${b.label} → ${ref}` })), usage: [], bindings: parsed.bindings,
                            bindTo: ref === '內建' ? BUILTIN_PRESET : '', targetLabel: `預設用途 · ${ref}`,
                            summary: typeof args.summary === 'string' ? args.summary.slice(0, 200) : undefined,
                        },
                    };
                }
                const found = findPreset(ref, data);
                if ('error' in found) return { ok: false, content: found.error };
                return buildPresetProposal({
                    kind: found.kind,
                    presetId: found.kind === 'general' ? found.record.id : found.preset.id,
                    baseDoc: found.kind === 'general' ? found.record.doc : found.preset.document,
                    isNew: false, ops: [], use, summary: args.summary, data, bindOnly: true,
                });
            },
        },
    ];
}

/** 改預設／新建預設／設定預設用途共用：套操作、算綁定、補適用場景、組提案 */
function buildPresetProposal(input: {
    kind: 'general' | 'story';
    presetId: string;
    baseDoc: MeetingPresetDoc | StoryTheaterPresetDocument;
    isNew: boolean;
    ops: unknown[];
    use: unknown;
    summary: unknown;
    data: PresetData;
    newFrom?: string;
    bindOnly?: boolean;
}): SoreToolResult {
    const { kind, data } = input;
    const applied = kind === 'general'
        ? applyGeneralOps(input.baseDoc as MeetingPresetDoc, input.ops)
        : applyStoryOps(input.baseDoc as StoryTheaterPresetDocument, input.ops);
    if (applied.errors.length) return { ok: false, content: `沒辦法照做，改好再送：\n${applied.errors.slice(0, 8).map(e => `- ${e}`).join('\n')}` };
    const parsed = parseBindings(input.use, kind, data);
    if ('error' in parsed) return { ok: false, content: parsed.error };
    let doc = applied.doc;
    const changes = [...applied.changes];
    // 設給私聊／群聊…用，但這份的適用場景沒勾那個場景：選單裡會看不到，順便勾上
    if (kind === 'general' && parsed.bindings.length) {
        const g = doc as MeetingPresetDoc;
        const current = g.scenes?.length ? g.scenes : ['date' as const];
        const missing = scenesNeededFor(parsed.bindings).filter(s => !current.includes(s));
        if (missing.length) {
            doc = { ...g, scenes: [...current, ...missing] };
            changes.push({ label: `適用場景加上：${missing.map(s => PRESET_SCENE_LABEL[s]).join('、')}` });
        }
    }
    const docChanged = input.isNew || changes.length > 0;
    if (!docChanged && !parsed.bindings.length) return { ok: false, content: input.bindOnly ? '沒說要設給誰（use）。' : '沒有任何改動（ops 是空的，也沒有 use）。' };
    const name = (doc as { name: string }).name;
    if (input.isNew) changes.unshift({ label: `新建「${name}」（從${input.newFrom || '既有預設'}複製）` });
    parsed.bindings.forEach(b => changes.push({ label: `設成 ${b.label} 用這份` }));
    const usage = input.isNew ? [] : presetUsage(input.presetId, data);
    return {
        ok: true,
        content: `${PROPOSED_NOTE}\n改動：\n${presetChangesNote(changes)}${kind === 'general' && changes.some(c => c.label.includes('正則')) ? '\n（提醒用戶：正則現在只在見面會跑。）' : ''}`,
        proposal: {
            kind: 'preset', presetKind: kind, presetId: input.presetId, presetName: name, isNew: input.isNew,
            ...(docChanged ? { doc } : {}),
            changes, usage,
            ...(parsed.bindings.length ? { bindings: parsed.bindings, bindTo: input.presetId } : {}),
            targetLabel: `${kind === 'general' ? '通用預設' : '劇情預設'} · ${name}${input.isNew ? '（新的）' : ''}`,
            summary: typeof input.summary === 'string' ? input.summary.trim().slice(0, 200) || undefined : undefined,
        },
    };
}

