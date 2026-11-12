/**
 * 生圖畫風庫與 API 庫（plans/image-style-presets.md）。純邏輯，不碰網路、不碰儲存。
 *
 * - normalizeImageGenConfig：讀進來就跑（apiConfigNormalize 裡），冪等。舊的單組 API 變成庫裡第一組；
 *   舊的「補充提示詞」搬成一套畫風並設成全域，效果跟以前一樣；第一次放進內建畫風。
 *   頂層的 baseUrl／apiKey／model／size／quality 永遠同步成全域那組，舊的呼叫點照讀頂層。
 * - pickStyle／applyStyleToPrompt：決定這次用哪套、怎麼拼進提示詞（有人才加人像那段、負面提示詞寫成文字或欄位）。
 * - apiForStyle：畫風偏好的那組 API，和失敗時退回的全域那組。
 */
import type { CharacterProfile, ImageApiPreset, ImageFeature, ImageGenApiConfig, ImageStylePreset } from '../types';

export const LEGACY_STYLE_ID = 'style-legacy';
/** 「這次不套畫風」 */
export const STYLE_NONE = 'none';

/** 內建四套。群友提供的原文只拆成「每次都加」和「畫面有人時才加」，字面不改。 */
export const BUILTIN_STYLES: ImageStylePreset[] = [
    {
        id: 'style-builtin-cg',
        builtinKey: 'cg',
        name: '半寫實 CG',
        prompt: [
            '畫面風格： 3D半寫實CG。高級CG真人膚質，寫真感、皮膚紋理清晰。',
            '視覺質感： 頂級的 3D 數位渲染，畫面在「完美無瑕、瓷器般光滑的皮膚質感」與「極致逼真的服飾與物體材質細節」之間取得完美平衡。',
            '光影氛圍： 具備電影感的浪漫氛圍，利用冷調光影的魔幻光線，營造出柔和的逆光。',
            '鏡頭效果： 專業攝影構圖，具有極淺的景深、強烈的背景虛化（模糊）與夢幻的散景（Bokeh）。整體色調溫柔、寧靜，呈現出一種精緻、生活化且帶有偽偷拍感的美學風格。',
        ].join('\n'),
        portraitPrompt: [
            '皮膚白皙平整乾淨、薄透、不油膩反光；髮絲濃密、根根分明，有層次毛流感、蓬松空氣感；人物神態柔和、不誇張、不張揚，五官精緻、無皺紋，眼球有玻璃感。',
            '構圖：無論什麼視角，人物必須位於構圖主體，給臉部特寫。借鑒雜誌人像攝影構圖，有近景、遠景、遮擋物等細節。',
        ].join('\n'),
    },
    {
        id: 'style-builtin-anime',
        builtinKey: 'anime',
        name: '精緻二次元',
        prompt: [
            'Digital illustration, modern high-quality semi-realistic illustration. Smooth rendering style, clean aesthetic look. Canvas texture: digital but crisp. Color palette: stylish low saturation with soft pastel or cool muted undertones. Lighting: diffuse soft lighting with gentle bloom, a slight vignette effect for depth.',
            'Atmosphere: Imperfectly perfect, candid aesthetic but strictly in an art style. Avoid real-world imperfections.',
        ].join('\n'),
        portraitPrompt: [
            'Focus: Ultra refined facial features. Flawless, porcelain-like skin texture (matte finish). Highly detailed eyes: sharp, clear, intense with stylized anime-style highlights and shiny lashes. Glossy, translucent lip texture.',
            'Composition: Intimate close-up or first-person selfie view, shallow depth of field (strong bokeh). Messy, stylized hair with fine details. Modern casual clothing like loose hoodie or simple tee.',
        ].join('\n'),
        negativePrompt: '(Photorealistic, realistic skin texture, real person, raw photo, 8k uhd, dslr, cine, film grain), 3d render, cgi, realistic lighting, dramatic lighting, hard shadows, sweaty skin, wet skin, glossy skin, oily face, sweat on clothes, realistic fabric wrinkles, pores, freckles, scars, acne, dirt, blemishes, imperfect skin, bad teeth, physically accurate reflection, (Classical oil painting, heavy impasto, rough brush strokes), romanticism, medieval, old master style, vintage photo, sepia, (documentary style, vlog, go pro, surveillance camera, noise, jpeg artifacts, motion blur), low resolution, grainy, dirty, (background clutter: detailed keyboards, realistic computer monitors, detailed crowded stage lights), bad anatomy, unattractive, distorted face, moody, dark, harsh sunlight, hard edge lines, ugly, unappealing.',
    },
    {
        id: 'style-builtin-semi-impasto',
        builtinKey: 'semi-impasto',
        name: '偽厚塗 CG',
        prompt: [
            '風格：高級偽厚塗CG乙女質感，韓系細膩平滑偽厚塗、半寫實插畫風格，有雜誌報刊、插畫與攝影融合感，走韓國言情小說封面、乙游男主CG風格。',
            '半/偽厚塗筆觸：描邊線條清晰、過渡自然，畫面精細度高、有商業質感。',
            '光影：無光源，大面積極淺色氛圍感柔光，避免直射，明暗變化極低、過渡緩慢，啞光淺色高光，高光過渡較慢，整體色調無限趨近於白灰色',
            '氛圍：整體有鬆弛慵懶、乾淨清冷的韓系氛圍感，柔和、霧氣朦朧、有空氣感',
            '拍攝參數：柔焦鏡頭，輕微 bloom，淺景深，背景適當虛化，soft dark academia 氣質。色相跨度低，平均亮度約：53%，曝光+0.3~+0.7 EV，對比度40-55%，抬升黑位，白位不刺眼，總體飽和度15~25%，陰影Shadows: +35、Blacks: +25',
            '濾鏡：韓系冷白灰霧氣朦朧感',
        ].join('\n'),
        portraitPrompt: [
            '弱化人物個人故事背景和環境背景的影響，給人物以文藝安靜、克制高級感，以環境、肌肉等肌體氛圍細節側面體現人物個人風格。',
            '構圖：拍攝人物時借鑒雜誌人像攝影構圖，有近景、遠景、遮擋物等細節',
        ].join('\n'),
    },
    {
        id: 'style-builtin-korean-handdrawn',
        builtinKey: 'korean-handdrawn',
        name: '韓系手繪插畫',
        prompt: [
            '畫風：韓系手繪插畫，像韓國插畫師的繪本或 IG 插畫，看得出手繪痕跡。',
            '筆觸與質感：鉛筆／色鉛筆線稿可見，線條有粗細變化、略帶抖動；上色用水彩或不透明水彩平塗加輕微疊色，留白多，淡淡透出紙張紋理。',
            '色彩：溫暖柔和的低彩度色調，奶油白、霧粉、淺橄欖綠、淡藍；陰影用同色系加深，不加黑。',
            '光影：自然日光感，明暗層次少而清楚。',
            '氛圍：日常、溫柔，像隨手畫下的一個片刻。',
        ].join('\n'),
        portraitPrompt: '人物比例自然，帶插畫式的簡化；五官線條乾淨，眼睛不做動漫高光，臉頰淡淡腮紅。構圖留白，人物可以只佔畫面一部分。',
        negativePrompt: '3D render, photorealistic, glossy skin, bloom, heavy bokeh, anime eye highlights, thick impasto, hard black shadows',
    },
];

/** 看不見的字元（零寬、方向控制）：從群裡複製來的提示詞常夾著，送出去只會干擾 */
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
export const stripInvisible = (s: string): string => s.replace(INVISIBLE_RE, '');

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const newStyleId = () => newId('style');
export const newImageApiId = () => newId('img-api');

/** 讀進來就跑；冪等。 */
export function normalizeImageGenConfig(cfg: ImageGenApiConfig | undefined): ImageGenApiConfig | undefined {
    if (!cfg) return cfg;
    let next: ImageGenApiConfig = { ...cfg };

    // API 庫：舊的單組變成第一組
    let apis = (next.apiPresets || []).filter(a => a && a.id);
    if (!apis.length && (next.baseUrl || next.model || next.apiKey)) {
        apis = [{
            id: 'img-api-1', name: next.model?.trim() || '生圖 API',
            baseUrl: next.baseUrl || '', apiKey: next.apiKey || '', model: next.model || '',
            ...(next.size ? { size: next.size } : {}), ...(next.quality ? { quality: next.quality } : {}),
        }];
    }
    if (apis.length) {
        const active = apis.find(a => a.id === next.activeApiId) || apis[0];
        next = {
            ...next, apiPresets: apis, activeApiId: active.id,
            baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model,
            size: active.size || undefined, quality: active.quality || undefined,
        };
    }

    // 畫風庫：第一次放內建；舊的補充提示詞搬成一套並設成全域
    let styles = (next.stylePresets || []).filter(s => s && s.id);
    if (!next.builtinStylesSeeded) {
        styles = [...styles, ...BUILTIN_STYLES.filter(b => !styles.some(s => s.id === b.id)).map(b => ({ ...b }))];
        next.builtinStylesSeeded = true;
    }
    const legacy = next.extraPrompt?.trim();
    if (legacy) {
        if (!styles.some(s => s.id === LEGACY_STYLE_ID)) styles = [{ id: LEGACY_STYLE_ID, name: '我原本的補充提示詞', prompt: legacy }, ...styles];
        if (!next.globalStyleId) next.globalStyleId = LEGACY_STYLE_ID;
    }
    delete next.extraPrompt;
    next.stylePresets = styles;
    if (next.globalStyleId && !styles.some(s => s.id === next.globalStyleId)) delete next.globalStyleId;
    return next;
}

/** 內建畫風補回來：刪掉的補上，改過的照舊留著（要回原文用 resetBuiltinStyle） */
export function restoreBuiltinStyles(styles: ImageStylePreset[]): ImageStylePreset[] {
    return [...styles, ...BUILTIN_STYLES.filter(b => !styles.some(s => s.builtinKey === b.builtinKey)).map(b => ({ ...b }))];
}

export function resetBuiltinStyle(style: ImageStylePreset): ImageStylePreset {
    const original = BUILTIN_STYLES.find(b => b.builtinKey === style.builtinKey);
    return original ? { ...original, id: style.id, ...(style.apiId ? { apiId: style.apiId } : {}) } : style;
}

/**
 * 這次用哪套。override：undefined＝跟全域；STYLE_NONE＝不套；其他＝那一套（找不到就跟全域）。
 * 第 b 步會在前面多接角色、世界、功能那格（plans/image-style-presets.md 第 5 節）。
 */
export function pickStyle(cfg: Pick<ImageGenApiConfig, 'stylePresets' | 'globalStyleId'> | undefined, override?: string | null): ImageStylePreset | undefined {
    if (!cfg) return undefined;
    if (override === STYLE_NONE) return undefined;
    const styles = cfg.stylePresets || [];
    return (override && styles.find(s => s.id === override)) || styles.find(s => s.id === cfg.globalStyleId);
}

/** 把畫風拼進提示詞。負面提示詞：asField 時另外回傳（送 negative_prompt 欄位），不然寫成「避免：…」接在後面。 */
export function applyStyleToPrompt(prompt: string, style: ImageStylePreset | undefined, opts: { hasPerson: boolean; negativeAsField?: boolean }): { prompt: string; negativePrompt?: string } {
    if (!style) return { prompt };
    const parts = [prompt.trim()];
    const body = stripInvisible(style.prompt || '').trim();
    const portrait = stripInvisible(style.portraitPrompt || '').trim();
    const negative = stripInvisible(style.negativePrompt || '').trim();
    if (body) parts.push(body);
    if (opts.hasPerson && portrait) parts.push(portrait);
    if (negative && !opts.negativeAsField) parts.push(`避免（Negative）：${negative}`);
    return { prompt: parts.filter(Boolean).join('\n\n'), ...(negative && opts.negativeAsField ? { negativePrompt: negative } : {}) };
}

/** 這次打哪組 API：畫風偏好的那組（跟全域不同才算），和退回用的全域那組 */
export function apiForStyle(cfg: Pick<ImageGenApiConfig, 'apiPresets' | 'activeApiId'> | undefined, style: ImageStylePreset | undefined): { preferred?: ImageApiPreset; global?: ImageApiPreset } {
    const apis = cfg?.apiPresets || [];
    const global = apis.find(a => a.id === cfg?.activeApiId) || apis[0];
    const preferred = style?.apiId ? apis.find(a => a.id === style.apiId) : undefined;
    return { global, ...(preferred && preferred.id !== global?.id ? { preferred } : {}) };
}

// ─── 第 b 步：誰用哪一套 ───

/** 各處畫風表的「關閉」 */
export const FEATURE_OFF = 'off';

export const IMAGE_FEATURES: Array<{ key: ImageFeature; label: string; hint: string; charScoped: boolean }> = [
    { key: 'chatPhoto', label: '聊天照片', hint: '角色在私聊傳的照片、你按重新生成', charScoped: true },
    { key: 'moments', label: '朋友圈配圖', hint: '角色發的朋友圈、軌跡裡的動態', charScoped: true },
    { key: 'ootd', label: '穿搭', hint: '軌跡的今日穿搭', charScoped: true },
    { key: 'dateMoment', label: '見面拍照', hint: '見面「拍下這一刻」', charScoped: true },
    { key: 'avatar', label: '頭像', hint: 'AI 生成配角、小號頭像', charScoped: true },
    { key: 'library', label: '資料庫生圖', hint: '資料庫裡你叫 AI 生的圖（不看角色、世界）', charScoped: false },
];

const validStyle = (cfg: Pick<ImageGenApiConfig, 'stylePresets'> | undefined, id: string | undefined | null): string | undefined => {
    if (!id) return undefined;
    if (id === STYLE_NONE) return id;
    return cfg?.stylePresets?.some(s => s.id === id) ? id : undefined;
};

export function isImageFeatureOff(cfg: Pick<ImageGenApiConfig, 'featureStyles'> | undefined, feature: ImageFeature | undefined): boolean {
    return !!feature && cfg?.featureStyles?.[feature] === FEATURE_OFF;
}

/** 生圖總開關、API 配好、這一處沒關 */
export function canGenerateFor(cfg: ImageGenApiConfig | undefined, feature: ImageFeature): cfg is ImageGenApiConfig {
    return !!(cfg?.charImageGenEnabled && cfg?.baseUrl && cfg?.model) && !isImageFeatureOff(cfg, feature);
}

type StyleChar = Pick<CharacterProfile, 'groupId' | 'altOf'> & { imageGenCharConfig?: Pick<NonNullable<CharacterProfile['imageGenCharConfig']>, 'styleId'> };

/**
 * 這次用哪套（plans/image-style-presets.md 第 5 節）：這一次 > 角色 > 世界 > 功能那格 > 全域；那一處「關閉」誰也蓋不過。
 * 回傳的 styleId 給 pickStyle：undefined＝全域、STYLE_NONE＝不套。指到已刪掉的畫風就往下一層找。
 * owner：小號的本人（小號跟本人的畫風與世界）。worldStyleOf：世界 id → 畫風（預設讀 OSProvider 登記的那份）。
 */
export function resolveImageStyle(cfg: Pick<ImageGenApiConfig, 'stylePresets' | 'featureStyles'> | undefined, args: {
    feature?: ImageFeature;
    char?: StyleChar | null;
    owner?: StyleChar | null;
    override?: string | null;
    worldStyleOf?: (groupId: string | undefined) => string | undefined;
}): { off: boolean; styleId?: string } {
    const featureValue = args.feature ? cfg?.featureStyles?.[args.feature] : undefined;
    if (featureValue === FEATURE_OFF) return { off: true };
    const scoped = args.feature ? IMAGE_FEATURES.find(f => f.key === args.feature)?.charScoped !== false : true;
    const who = args.char?.altOf && args.owner ? args.owner : args.char;
    const chain = [
        args.override,
        scoped ? who?.imageGenCharConfig?.styleId : undefined,
        scoped && who?.groupId ? args.worldStyleOf?.(who.groupId) : undefined,
        featureValue,
    ];
    for (const id of chain) {
        const v = validStyle(cfg, id);
        if (v) return { off: false, styleId: v };
    }
    return { off: false };
}

/** 下拉選單用：某一層現在選的是什麼字 */
export function styleLabel(cfg: Pick<ImageGenApiConfig, 'stylePresets'> | undefined, id: string | undefined, fallback: string): string {
    if (!id) return fallback;
    if (id === STYLE_NONE) return '不套畫風';
    if (id === FEATURE_OFF) return '關閉';
    return cfg?.stylePresets?.find(s => s.id === id)?.name || fallback;
}
