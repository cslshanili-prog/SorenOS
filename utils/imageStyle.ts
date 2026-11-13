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

/** 內建四套（2026-11-14 Liora 換成三套英文的＋韓系手繪）。原文照給的放，字面不改；第一行是「這套優先什麼」。 */
export const BUILTIN_STYLES: ImageStylePreset[] = [
    {
        id: 'style-builtin-photo',
        builtinKey: 'photo',
        name: 'Photographic Realism',
        prompt: [
            'Prioritize authentic photographic realism over digital stylization.',
            'High-end professional photography with a natural, believable, real-world appearance. Authentic surface textures, realistic material properties, delicate microdetails, natural color variation, subtle imperfections, and physically plausible reflections.',
            'Soft natural lighting or professionally diffused studio lighting, realistic highlights and shadow transitions, natural light falloff, and subtle atmospheric depth.',
            'Clean, elegant color grading with balanced neutral tones, restrained saturation, gentle contrast, and natural color reproduction.',
            'Authentic optical depth of field, realistic lens behavior, soft background bokeh, and subtle professional retouching without excessive smoothing.',
            'The final image must look convincingly photographic rather than digitally illustrated or rendered.',
        ].join('\n'),
        negativePrompt: 'CGI, 3D render, digital human render, game rendering, unreal engine look, sculpted surfaces, doll-like skin, overly smooth texture, synthetic facial structure, artificial lighting, plastic material response, stylized CG aesthetics',
    },
    {
        id: 'style-builtin-digital-human',
        builtinKey: 'digital-human',
        name: 'Digital Human Render',
        prompt: [
            'Prioritize premium 3D rendering, not photography.',
            'Create a polished semi-realistic 3D render with a clearly digital, three-dimensional appearance. The image should visibly feel computer-rendered rather than camera-captured. Emphasize sculpted forms, clean dimensional contours, idealized facial or subject structure, smooth refined surfaces, uniform skin or fur texture, controlled material response, and subtle subsurface scattering. Lighting should feel studio-rendered and precisely controlled, with soft global illumination, clean form separation, gentle rim shaping, and a luminous digital finish. The image should look polished, dimensional, and aesthetically rendered, with elegant muted tones. The final result must not be mistaken for a real photograph.',
        ].join('\n'),
        negativePrompt: 'real photo, documentary photography, natural camera texture, realistic skin pores, casual photographic look, lens-based realism, authentic raw material texture, real-world micro-imperfections, painterly illustration, hand-drawn style',
    },
    {
        id: 'style-builtin-illustrated-cg',
        builtinKey: 'illustrated-cg',
        name: 'Illustrated CG Artwork',
        prompt: [
            'Prioritize illustrated CG aesthetics over 3D rendering and photography.',
            'Create a premium semi-realistic CG illustration with a distinctly digital-art feel. The image should look like polished commercial character artwork rather than a real photo or a 3D render. Emphasize softly painted surfaces, gentle tonal blending, selectively softened edges, slightly simplified material detail, and an idealized, refined finish. Forms should be shaped through color and value design rather than physically realistic rendering. Lighting should be diffuse, hazy, and atmospheric, with soft bloom, low contrast, lifted shadows, and a calm misty glow. Use a cool, desaturated palette with gray, smoky violet, pale lavender, muted blue-gray, or similar subdued tones. Fine detail should be concentrated in the focal area, while peripheral areas remain softly blended and artistically simplified. The final image must clearly read as high-end stylized CG artwork, not as photography and not as realistic 3D rendering.',
        ].join('\n'),
        negativePrompt: 'photorealistic, real-photo look, realistic camera texture, physically based 3D rendering, digital human render, unreal engine look, hyperreal material response, realistic skin pores, strong subsurface scattering, sculpted 3D facial structure, hard CGI reflections, overly realistic lighting, raw photography, documentary realism, plastic doll realism, cel shading, cartoon line art, rough painterly brush strokes, high contrast, oversaturated colors',
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

/**
 * 退役的三套（2026-11-14 之前的內建）。讀到沒改過的就拿掉、改過的留著變成自己的；
 * 角色、世界、各處、全域指著舊 id 的，照 RETIRED_STYLE_ALIASES 換到最接近的新內建。
 */
export const RETIRED_BUILTIN_STYLES: ImageStylePreset[] = [
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
];

export const RETIRED_STYLE_ALIASES: Record<string, string> = {
    'style-builtin-cg': 'style-builtin-digital-human',
    'style-builtin-anime': 'style-builtin-illustrated-cg',
    'style-builtin-semi-impasto': 'style-builtin-illustrated-cg',
};

/** 看不見的字元（零寬、方向控制）：從群裡複製來的提示詞常夾著，送出去只會干擾 */
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
export const stripInvisible = (s: string): string => s.replace(INVISIBLE_RE, '');

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const newStyleId = () => newId('style');

const sameStyleText = (a: ImageStylePreset, b: ImageStylePreset) => ['prompt', 'portraitPrompt', 'negativePrompt'].every(k =>
    stripInvisible(((a as any)[k] || '') as string).trim() === stripInvisible(((b as any)[k] || '') as string).trim());

/**
 * 這個 id 現在指的是哪一套：找得到就是它；找不到但是退役的舊內建，就換成接手的那套
 * （角色卡、世界存的舊 id 不用回頭改資料庫）。都沒有回 undefined。
 */
export function liveStyleId(cfg: Pick<ImageGenApiConfig, 'stylePresets'> | undefined, id: string | undefined | null): string | undefined {
    if (!id) return undefined;
    const styles = cfg?.stylePresets || [];
    if (styles.some(s => s.id === id)) return id;
    const alias = RETIRED_STYLE_ALIASES[id];
    return alias && styles.some(s => s.id === alias) ? alias : undefined;
}
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
        next.builtinStylesV2 = true;
    } else if (!next.builtinStylesV2) {
        // 換內建：舊的三套沒改過就拿掉，改過的留著變成自己的（拿掉 builtinKey）；新的補上；指著舊 id 的換過去
        const removed = new Set<string>();
        styles = styles.flatMap(st => {
            const old = RETIRED_BUILTIN_STYLES.find(r => r.builtinKey && r.builtinKey === st.builtinKey);
            if (!old) return [st];
            if (sameStyleText(st, old)) { removed.add(st.id); return []; }
            const { builtinKey: _drop, ...own } = st;
            return [own];
        });
        styles = [...styles, ...BUILTIN_STYLES.filter(b => !styles.some(s => s.id === b.id || s.builtinKey === b.builtinKey)).map(b => ({ ...b }))];
        const remap = (id: string | undefined) => (id && removed.has(id) ? RETIRED_STYLE_ALIASES[id] : id);
        if (next.globalStyleId) next.globalStyleId = remap(next.globalStyleId);
        if (next.featureStyles) next.featureStyles = Object.fromEntries(Object.entries(next.featureStyles).map(([k, v]) => [k, remap(v)])) as typeof next.featureStyles;
        if (next.genPresets) next.genPresets = next.genPresets.map(g => (g.styleId ? { ...g, styleId: remap(g.styleId) } : g));
        next.builtinStylesV2 = true;
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
    const want = override ? liveStyleId(cfg, override) : undefined;
    return (want && styles.find(s => s.id === want)) || styles.find(s => s.id === cfg.globalStyleId);
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
    return liveStyleId(cfg, id);
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
    const live = liveStyleId(cfg, id);
    return cfg?.stylePresets?.find(s => s.id === live)?.name || fallback;
}

/** 「照設定」那個選項要寫的：不給這一次時，會用到哪一套（名字），哪一組 API */
export function describeDefaultPick(cfg: ImageGenApiConfig | undefined, args: Omit<Parameters<typeof resolveImageStyle>[1], 'override'>): { styleName: string; apiName?: string; off: boolean } {
    const r = resolveImageStyle(cfg, args);
    if (r.off) return { styleName: '關閉', off: true };
    const style = pickStyle(cfg, r.styleId);
    const { preferred, global } = apiForStyle(cfg, style);
    const api = preferred || global;
    return { styleName: style?.name || '不套畫風', off: false, ...(api ? { apiName: api.name || api.model } : {}) };
}
