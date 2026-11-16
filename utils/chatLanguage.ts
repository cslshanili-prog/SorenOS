/**
 * 聊天語言（plans/chat-language.md）：角色說話語言、夾雜第二語言、翻譯成。
 *
 * - 設定存在角色卡 `chatLanguage`，這裡是唯一一份清單、解析與提示詞。
 * - 語言欄位存的是給模型看的名稱（English、繁體中文…），介面顯示用 `languageLabel`。
 * - 翻譯走聊天模型時，沿用原本的 <翻譯><原文>…</原文><譯文>…</譯文></翻譯> 格式，
 *   後處理存成 `原文\n%%BILINGUAL%%\n譯文`，氣泡、語音、引用都不用改。
 * - 舊版設定在 localStorage（chat_translate_*_<charId>），`migrateLegacyChatLanguage` 搬上角色卡。
 */
import type { ChatLanguageConfig, ChatLanguageMixLevel } from '../types';
import { normalizeTranslationLangLabel } from './translationLang';

export const CHAT_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'English', label: '英文' },
    { value: '繁體中文', label: '繁中' },
    { value: '简体中文', label: '簡中' },
    { value: '粵語', label: '粵語' },
    { value: '日本語', label: '日文' },
    { value: '한국어', label: '韓文' },
    { value: 'Français', label: '法文' },
];

export const MIX_LEVELS: ReadonlyArray<{ value: ChatLanguageMixLevel; label: string; hint: string }> = [
    { value: 'light', label: '偶爾冒幾個詞', hint: '大約一成' },
    { value: 'natural', label: '自然混用', hint: '大約兩到三成' },
    { value: 'half', label: '兩種差不多', hint: '三到四成，首要語言仍是主軸' },
];

/** 舊版「選／譯」的值換成新清單的值（舊的「中文」當繁中）。 */
const LEGACY_VALUE: Record<string, string> = { '中文': '繁體中文' };

export const normalizeLanguage = (raw: string | null | undefined): string => {
    const v = normalizeTranslationLangLabel(raw);
    return LEGACY_VALUE[v] || v;
};

export const isPresetLanguage = (v: string | undefined): boolean => !!v && CHAT_LANGUAGES.some(l => l.value === v);

/** 介面顯示用的短名字；自訂的照原樣。 */
export const languageLabel = (v: string | undefined): string => CHAT_LANGUAGES.find(l => l.value === v)?.label || v || '';

export interface ResolvedChatLanguage {
    speak?: string;
    mix?: string;
    mixLevel: ChatLanguageMixLevel;
    translateTo?: string;
    /** 有東西要翻：設了「翻譯成」，而且跟說話語言不一樣（或有夾雜）。 */
    translating: boolean;
    /** 誰來翻：chat＝聊天模型順便翻（提示詞帶雙語標籤）；api＝先寫再交給翻譯 API。 */
    translator: 'chat' | 'api';
    /** 聊天模型順便翻：提示詞要帶 <翻譯> 標籤。 */
    inlineTranslate: boolean;
    /** 先寫再翻：回覆存好後交給翻譯 API。 */
    postTranslate: boolean;
    /** 我的訊息自動譯出（要有說話語言才知道翻成什麼）。 */
    translateMine: boolean;
    expanded: boolean;
}

export const resolveChatLanguage = (cfg: ChatLanguageConfig | undefined): ResolvedChatLanguage => {
    const speak = normalizeLanguage(cfg?.speak) || undefined;
    const mixRaw = normalizeLanguage(cfg?.mix) || undefined;
    const mix = mixRaw && mixRaw !== speak ? mixRaw : undefined;
    const translateTo = normalizeLanguage(cfg?.translateTo) || undefined;
    const mixLevel: ChatLanguageMixLevel = cfg?.mixLevel && MIX_LEVELS.some(m => m.value === cfg.mixLevel) ? cfg.mixLevel : 'natural';
    const translating = !!translateTo && (translateTo !== speak || !!mix);
    const translator = cfg?.translator === 'api' ? 'api' : 'chat';
    return {
        speak, mix, mixLevel, translateTo, translating, translator,
        inlineTranslate: translating && translator === 'chat',
        postTranslate: translating && translator === 'api',
        translateMine: !!cfg?.translateMine && !!speak,
        expanded: !!cfg?.expanded,
    };
};

/** 存檔前整理：全空就不寫這個欄位。 */
export const cleanChatLanguage = (cfg: ChatLanguageConfig): ChatLanguageConfig | undefined => {
    const speak = normalizeLanguage(cfg.speak) || undefined;
    const mix = normalizeLanguage(cfg.mix) || undefined;
    const translateTo = normalizeLanguage(cfg.translateTo) || undefined;
    const next: ChatLanguageConfig = {
        speak,
        mix,
        mixLevel: mix && cfg.mixLevel && cfg.mixLevel !== 'natural' ? cfg.mixLevel : undefined,
        translateTo,
        expanded: translateTo && cfg.expanded ? true : undefined,
        translator: translateTo && cfg.translator === 'api' ? 'api' : undefined,
        translateMine: speak && cfg.translateMine ? true : undefined,
    };
    return Object.values(next).some(v => v !== undefined) ? next : undefined;
};

const MIX_TEXT: Record<ChatLanguageMixLevel, string> = {
    light: '偶爾冒出幾個詞或短句，大約一成',
    natural: '自然混用，大約兩到三成',
    half: '兩種語言都常用，大約三到四成',
};
const MAIN_SHARE: Record<ChatLanguageMixLevel, string> = { light: '九成', natural: '七成', half: '六成' };

const CANTONESE = /粵|粤|廣東話|广东话|cantonese/i;
const cantoneseNote = (lang: string) => CANTONESE.test(lang)
    ? `（${lang}要寫成廣東話口語，例如「係」「唔」「嘅」「咗」「喺」，不要寫成書面中文）` : '';

/** 說話語言與夾雜的指令；兩個都沒設就是空字串。 */
const speakingRules = (r: ResolvedChatLanguage): string => {
    if (!r.speak && !r.mix) return '';
    const lines: string[] = [];
    if (r.speak) {
        lines.push(r.mix
            ? `- 你說話主要用${r.speak}${cantoneseNote(r.speak)}，至少${MAIN_SHARE[r.mixLevel]}的內容用它。`
            : `- 你說話用${r.speak}${cantoneseNote(r.speak)}。`);
    }
    if (r.mix) {
        lines.push(`- 你會夾雜${r.mix}${cantoneseNote(r.mix)}：${MIX_TEXT[r.mixLevel]}。`);
        lines.push('- 夾雜要像真的雙語者：在人設合理的地方自然換（口頭禪、情緒上來、某些習慣用那個語言講的詞），不要一句一句輪流換，也不要每句都硬塞。');
    }
    return `\n\n[語言設定]\n${lines.join('\n')}`;
};

/** 聊天模型順便翻：每句包 <翻譯> 標籤（格式與舊版一致，後處理照舊拆）。 */
const bilingualRules = (r: ResolvedChatLanguage, sarEnvelopeActive: boolean): string => {
    const source = r.speak
        ? (r.mix ? `${r.speak}（照上面的比例夾雜${r.mix}）` : r.speak)
        : '你平常說的語言';
    const target = r.translateTo as string;
    return `\n\n[CRITICAL: 雙語輸出模式 - 必須嚴格遵守]
你的每句話都必須用以下XML標籤格式輸出雙語內容：
<翻譯>
<原文>${source}內容</原文>
<譯文>${target}內容</譯文>
</翻譯>

規則：
- 每句話單獨包裹一個<翻譯>標籤
- 多句話就輸出多個<翻譯>標籤，一句一個
- ${sarEnvelopeActive
        ? 'SAR 模塊生效中：最外層必須是 <SAR_MODULE_OUTPUT>；在 CHAR_TRUE 與 CHAR_SURFACE 字段內部，各自用完整的 <翻譯> 標籤包裹每句話。除這個 SAR 容器與字段標籤外，不寫散落文字'
        : '<翻譯>標籤外不要寫任何文字'}
- 表情包命令 [[SEND_EMOJI: ...]] 放在所有<翻譯>標籤外面
- 引用命令 [[QUOTE: ...]] 也放在所有<翻譯>標籤外面；引用內容請原樣照抄用戶說過的原文（不要翻譯、不要包<翻譯>標籤）${r.mix ? `
- <譯文>整句都用${target}，原文裡夾雜的${r.mix}也要翻` : ''}

示例（日本語→中文）：
<翻譯>
<原文>こんにちは！</原文>
<譯文>你好！</譯文>
</翻譯>
<翻譯>
<原文>今日は何する？</原文>
<譯文>今天做什麼？</譯文>
</翻譯>`;
};

/** 私聊提示詞的語言段（`chatRequestPayload` 第 4 段）。沒設任何東西時回空字串。 */
export const buildChatLanguagePrompt = (r: ResolvedChatLanguage, opts: { sarEnvelopeActive?: boolean } = {}): string =>
    speakingRules(r) + (r.inlineTranslate ? bilingualRules(r, !!opts.sarEnvelopeActive) : '');

/** 只有說話語言與夾雜的指令（雲端主動消息 fire_pack 用：雲端一律不帶雙語標籤，收件後在本機補譯文）。 */
export const buildSpeakingRulesPrompt = (r: ResolvedChatLanguage): string => speakingRules(r).trim();

/** 雲端即時對話用的設定：有翻譯就改成「先寫再翻」，提示詞不帶標籤，譯文收件後在本機補。 */
export const chatLanguageForCloud = (cfg: ChatLanguageConfig | undefined): ChatLanguageConfig | undefined =>
    cfg && resolveChatLanguage(cfg).translating ? { ...cfg, translator: 'api' } : cfg;

/** 先寫再翻：存好的氣泡內容要不要補譯文（已經是雙語、空的、純表情標記就不用）。 */
export const needsPostTranslation = (content: string): boolean => {
    const t = content.trim();
    return !!t && !t.includes('%%BILINGUAL%%') && !/^\[\[[A-Z_]+[:|]/.test(t);
};

/** 拆開雙語格式（`原文\n%%BILINGUAL%%\n譯文`）；不是雙語回 null。 */
export const splitBilingual = (content: string): { original: string; translated: string } | null => {
    const i = content.toLowerCase().indexOf('%%bilingual%%');
    if (i < 0) return null;
    return { original: content.slice(0, i).trim(), translated: content.slice(i + '%%BILINGUAL%%'.length).trim() };
};

/** 把譯文接成氣泡認得的雙語格式。 */
export const joinBilingual = (original: string, translated: string): string => `${original.trim()}\n%%BILINGUAL%%\n${translated.trim()}`;

// ─── 電話（plans/chat-language.md 第 4 批）───

/** 說話語言對到 TTS 的語種代碼（跟 utils/voiceLanguage.ts 同一組）；中文與自訂語言回空字串＝照預設念。 */
export const ttsLangCode = (lang: string | undefined): string => {
    if (!lang) return '';
    if (CANTONESE.test(lang)) return 'yue';
    return ({ 'English': 'en', '日本語': 'ja', '한국어': 'ko', 'Français': 'fr' } as Record<string, string>)[lang] || '';
};

export interface CallLanguagePlan {
    /** 電話裡念出來的語言（說話語言） */
    spoken: string;
    /** 字幕語言（翻譯成）；沒設就是字幕照說話語言寫 */
    subtitle?: string;
    /** 夾雜第二語言的規矩（沒夾雜是空的） */
    mixRule?: string;
    /** TTS 語種代碼 */
    ttsCode: string;
}

/** 電話跟著聊天語言：沒設說話語言就回 undefined（照舊）。 */
export const callLanguagePlan = (cfg: ChatLanguageConfig | undefined): CallLanguagePlan | undefined => {
    const r = resolveChatLanguage(cfg);
    if (!r.speak) return undefined;
    return {
        spoken: r.speak + cantoneseNote(r.speak),
        subtitle: r.translating ? r.translateTo + cantoneseNote(r.translateTo as string) : undefined,
        mixRule: r.mix ? `你會夾雜${r.mix}：${MIX_TEXT[r.mixLevel]}；像真的雙語者那樣自然換，不要一句一句輪流換。` : undefined,
        ttsCode: ttsLangCode(r.speak),
    };
};

/** 通話語種選單上「跟著聊天語言」那顆的說明。 */
export const callLanguageFollowHint = (cfg: ChatLanguageConfig | undefined): string => {
    const r = resolveChatLanguage(cfg);
    if (!r.speak) return '「跟著聊天語言」：這個角色的聊天語言沒指定說話語言，照預設。';
    return r.translating
        ? `「跟著聊天語言」：說${languageLabel(r.speak)}、字幕是${languageLabel(r.translateTo)}。`
        : `「跟著聊天語言」：說${languageLabel(r.speak)}，字幕也是${languageLabel(r.speak)}。`;
};

// ─── 見面（plans/chat-language.md 第 4 批，定案 A）───

/**
 * 見面的語言規則：台詞（引號裡的話）用說話語言（含夾雜），有翻譯就在引號後面括號附譯文；
 * 旁白、動作、心理描寫用你讀的語言。沒設說話語言回空字串（照舊）。
 */
export const buildDateLanguageRule = (cfg: ChatLanguageConfig | undefined): string => {
    const r = resolveChatLanguage(cfg);
    if (!r.speak) return '';
    const lines = [
        `- ${'{{char}}'}說出口的台詞（引號裡的話）用${r.speak}${cantoneseNote(r.speak)}。`,
        ...(r.mix ? [`- 台詞會夾雜${r.mix}：${MIX_TEXT[r.mixLevel]}；像真的雙語者那樣自然換，不要一句一句輪流換。`] : []),
        ...(r.translating ? [
            `- 每句台詞的引號後面，緊接著用全形括號附上${r.translateTo}翻譯，例如：「……」（${r.translateTo}譯文）。翻譯只放在括號裡，不另起一行，也不放進引號裡。`,
            `- 旁白、動作、心理描寫用${r.translateTo}寫。`,
        ] : [
            '- 旁白、動作、心理描寫照你平常寫故事的語言。',
        ]),
    ];
    return `### 說話語言\n${lines.join('\n')}`;
};

// ─── 舊版設定搬遷 ───

export const legacyChatLanguageKeys = (charId: string): string[] => [
    `chat_translate_enabled_${charId}`,
    `chat_translate_source_lang_${charId}`,
    `chat_translate_lang_${charId}`,
    `chat_translate_expanded_${charId}`,
];

const parseBool = (raw: string | null): boolean => {
    try { return JSON.parse(raw || 'false') === true; } catch { return false; }
};

/**
 * 舊版只在「消息翻譯」開著時才有作用，所以只搬開著的：選→說話語言、譯→翻譯成、展開照搬。
 * 沒開的回 undefined（角色卡不寫這個欄位）。
 */
export const legacyChatLanguage = (charId: string, getItem: (key: string) => string | null): ChatLanguageConfig | undefined => {
    if (!parseBool(getItem(`chat_translate_enabled_${charId}`))) return undefined;
    const speak = normalizeLanguage(getItem(`chat_translate_source_lang_${charId}`) || getItem('chat_translate_source_lang') || '日本語');
    const translateTo = normalizeLanguage(getItem(`chat_translate_lang_${charId}`) || getItem('chat_translate_lang') || '中文');
    return cleanChatLanguage({ speak, translateTo, expanded: parseBool(getItem(`chat_translate_expanded_${charId}`)) });
};
