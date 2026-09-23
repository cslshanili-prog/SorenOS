/**
 * Shared MiniMax TTS utility — used by ChatApp, DateApp, and CallApp
 */
import { CharacterProfile, APIConfig } from '../types';
import { resolveMiniMaxApiKey } from './minimaxApiKey';
import { minimaxFetch } from './minimaxEndpoint';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import { normalizeVoiceTags } from './sanitize';

const DEFAULT_MODEL = 'speech-2.8-hd';
export type MiniMaxParamVersion = 'legacy' | 'natural-v2';

/** 老角色沒有該字段時必須繼續使用歷史參數，避免升級後聲音突然變化。 */
export const getMiniMaxParamVersion = (vp: CharacterProfile['voiceProfile']): MiniMaxParamVersion =>
  vp?.minimaxParamVersion === 'natural-v2' ? 'natural-v2' : 'legacy';

const MINIMAX_LANGUAGE_BOOST_ALIASES: Record<string, string> = {
  zh: 'Chinese',
  'zh-cn': 'Chinese',
  'zh-hans': 'Chinese',
  'zh-tw': 'Chinese',
  'zh-hant': 'Chinese',
  yue: 'Chinese,Yue',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  ru: 'Russian',
  ar: 'Arabic',
  it: 'Italian',
  pt: 'Portuguese',
  hi: 'Hindi',
  id: 'Indonesian',
  tr: 'Turkish',
  vi: 'Vietnamese',
};

/** 將項目內使用的 ISO 語種碼轉換成 MiniMax language_boost 的官方枚舉。 */
export const normalizeMiniMaxLanguageBoost = (languageBoost?: string): string | undefined => {
  const value = (languageBoost || '').trim();
  if (!value) return undefined;
  return MINIMAX_LANGUAGE_BOOST_ALIASES[value.toLowerCase()] || value;
};

// MiniMax 支持的語氣標籤 — 這些在 TTS 中會被正確演繹，必須保留
export const VALID_INTERJECTION_TAGS = new Set([
  'chuckle', 'laughs', 'sighs', 'coughs', 'clear-throat', 'groans',
  'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'snorts',
  'lip-smacking', 'humming', 'hissing', 'emm',
]);

// MiniMax voice_setting.emotion 合法取值（整條一個值）。其餘/未知一律丟棄不傳。
export const VALID_EMOTIONS = new Set([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent',
]);

/**
 * 共享的「語音演出規範」——教 LLM 把台詞寫成能被 MiniMax 自然念出來的對白。
 * 聊天語音條 / 電話 / 約會複用同一份，避免各處各寫一套、規則互相打架。
 *
 * 注意定位：這裡只講「怎麼把字寫得有呼吸、有情緒節奏」。具體的標籤機制
 * （<語音> 標籤怎麼用、[emotion] 放哪、動作詞白名單）由各調用點自己的
 * prompt 負責，本塊不重複。經典參數會按標點自動補停頓；新版自然參數只保留
 * LLM 明確寫出的 <#x#>，讓 MiniMax 自己處理普通標點韻律。因此指南只要求在
 * 真正的情緒節點使用停頓標籤，兩種模式都不會把標籤當普通標點來濫用。
 */
export const VOICE_ACTING_GUIDE = `### 讓它聽起來像活人在說話（重要）

你寫的字會被原樣念出來。目標不是"寫一段通順的話"，而是"寫一段讀出來有呼吸、有情緒起伏的對白"。讀稿感、客服腔、新聞播報腔一旦出現就重寫。

**1. 段與段之間要換氣，別無縫衝。**
同一條語音裡換行或停頓之後，如果還是你在繼續說，第二段開頭別一上來就衝進正題——加一個停頓、一個語氣詞或一次嘆氣當緩衝。
✅ 我知道你不是故意的。<#0.6#>只是……我還是會有點難過。
✅ (sighs) 算了。<#0.5#>聽你的。
❌ 我知道你不是故意的。只是我還是會有點難過。（兩句貼死，像棒讀）
這些地方下一句開頭尤其要緩一下：解釋原因、情緒轉折（吐槽轉溫柔 / 強硬轉示弱 / 玩笑轉認真）、沉默後再開口、安撫對方、委屈撒嬌彆扭的時候。

**2. 句子長短交錯。** 一連串等長的句子是棒讀的頭號來源。讓短句砸下來，讓長句鋪開。想強調某個詞就拆開念："我。沒。拿。"

**3. <#秒#> 停頓放在情緒節點，不要每句都塞。**
0.2 極短換氣 / 0.3 輕頓 / 0.5 普通停頓 / 0.7 猶豫·嘆息後停一下 / 1.0 明顯沉默·震驚·壓抑。
標記必須夾在能唸的字之間（✅ 我沒事。<#0.5#>只是有點累。）；別放在句首，也別兩個標記連寫（<#0.5#><#0.4#> 這種一定刪一個）。

**4. 情緒不同，節奏不同：**
- 溫柔安撫：慢、穩、短句多。"沒事。<#0.6#>先別急著嚇自己。"
- 委屈撒嬌：語氣軟、停頓多一點但別太戲劇。"嗯……<#0.5#>你剛剛是不是又不理我。"
- 彆扭傲嬌：前半句嘴硬後半句放軟，中間停一下。"哈。<#0.4#>你還真會折騰我。算了，<#0.5#>我幫你就是了。"
- 難過壓抑：更慢、更多省略號、少用長句。"……我知道。<#0.8#>只是有點難受。"
- 緊張猶豫：斷裂感，短停頓多。"等等。<#0.4#>我好像……<#0.5#>有點不確定。"
- 吐槽輕鬆：別太慢，輕微停頓即可。"行吧。<#0.3#>人類又發明了新的折磨方式。"

**5. 密度別失控。** 每 100 字裡 <#x#> 大約 1–4 個、動作詞 0–2 個。普通對話 2–4 句緩衝一次，強情緒 1–2 句一次。別整段全是同一個停頓值（會像壞掉的導航在唸稿），也別連著堆同一個動作詞。

（朗讀語種不是中文時，上面示例裡的中文語氣詞換成該語言裡自然的嘆詞 / 填充詞即可，呼吸和節奏的原理不變。）`;

// [happy]/【angry】… 這類情緒標籤是給系統讀取/設定 emotion 用的，絕不能被朗讀或顯示出來。
const EMOTION_TAG_RE = /[\[【]\s*(?:happy|sad|angry|fearful|disgusted|surprised|calm|fluent)\s*[\]】]/gi;
/** 移除文本里所有 [emotion] / 【emotion】 標記（任意位置），避免被朗讀或顯示。 */
export const stripEmotionTags = (text: string): string => (text || '').replace(EMOTION_TAG_RE, '');

/**
 * 把「只給 TTS 用」的演出標記從要顯示給用戶的文本里清掉。
 * <#秒#> 停頓標記和 (sighs)/(chuckle) 這類動作詞是寫給語音合成的，
 * 不應該原樣出現在聊天氣泡 / 轉文字面板裡（否則用戶看到一堆 <#0.4#>）。
 * 只刪白名單內的動作詞；普通括號內容（比如正常的西文括注）保持不動。
 */
export const cleanVoiceMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/<#\s*[\d.]+\s*#>/g, '')                 // 停頓標記 <#0.4#>
    .replace(/\(([^)]{1,40})\)/g, (m, inner: string) =>
      VALID_INTERJECTION_TAGS.has(inner.trim().toLowerCase()) ? '' : m) // 動作詞，僅刪白名單
    .replace(/[ \t]{2,}/g, ' ')                        // 合併多餘空格
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')    // 標點前殘留空格
    .replace(/([，、；：,])\s*\1+/g, '$1')               // 刪標記後留下的連續重複標點
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

// 設計：不再做「中文舞台指示 → 語氣標籤」的猜測式映射（體驗差、不可預測、有損）。
// 改為「教 LLM 直接寫官方 sound tag」+「客戶端只做白名單消毒」。
// 因此這裡只保留一個合法標籤白名單（上方 VALID_INTERJECTION_TAGS），不保留任何中→英映射表。

/**
 * 消毒括號內容（不做任何映射，只做白名單）：
 * - 中文舞台指示（……）一律刪除，絕不讀出來；
 * - 西文括號僅保留合法 sound tag（如 (laughs)），其餘刪除。
 * LLM 現在被要求直接寫官方英文 sound tag，所以這裡不再翻譯中文提示詞。
 */
const stripParensPreservingTags = (text: string): string => {
  return stripEmotionTags(text)
    // 中文括號舞台指示：一律刪除
    .replace(/（[^）]{0,48}）/g, '')
    // 西文括號：僅保留白名單 sound tag，其餘刪除
    .replace(/\(([^)]{1,80})\)/g, (_m, inner: string) => {
      const tag = inner.trim().toLowerCase();
      return VALID_INTERJECTION_TAGS.has(tag) ? `(${tag})` : '';
    });
};

/**
 * Clean text for TTS — strip stage directions, system tags, and voice markup.
 * If <語音>...</語音> tag exists, use its content (already translated for TTS).
 * Otherwise, strip（parenthetical cues）so they aren't read aloud.
 * Known interjection tags like (chuckle) / (sighs) are preserved.
 */
export const cleanTextForTts = (raw: string): string => {
  // 0. 語音標籤自愈 — 歷史壞數據 (未閉合/孤兒閉合/全角符號) 也要能解析出來
  raw = normalizeVoiceTags(raw);
  // 1. If <語音> tag exists (with or without emotion attribute), extract & use its content only
  const voiceTagMatch = raw.match(/<[语語語]音[^>]*>([\s\S]*?)<\/\s*[语語語]音\s*>/);
  if (voiceTagMatch) {
    return stripParensPreservingTags(voiceTagMatch[1]).replace(/\s+/g, ' ').trim();
  }

  let text = raw;
  // 2. Strip [[...]] system markers
  text = text.replace(/\[\[.*?\]\]/g, '');
  // 3. Strip %%BILINGUAL%% and everything after
  text = text.replace(/%%BILINGUAL%%[\s\S]*/i, '');
  // 4. Strip parenthetical cues (preserving valid interjection tags only)
  text = stripParensPreservingTags(text);
  // 5. Strip <語音>...</語音> / <字幕>...</字幕> tags if they somehow remain
  //    (字幕是顯示用的中文對照, 絕不能被朗讀)
  text = text.replace(/<[语語語]音[^>]*>[\s\S]*?<\/\s*[语語語]音\s*>/g, '');
  text = text.replace(/<字幕>[\s\S]*?<\/字幕>/g, '');
  // 6. Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
};

export interface ParsedVoiceOutput {
  /** Text OUTSIDE the <語音> tag — what shows in the chat bubble. */
  display: string;
  /** TTS-ready spoken text (sanitized: only whitelisted MiniMax sound tags kept). */
  speech: string;
  /**
   * Raw <語音> inner content, whitespace-collapsed only — square-bracket cues and
   * parens are PRESERVED. Fish Audio needs this so its native inline cues
   * ([happy]/[whispering]/[break]…) survive to the API; cleanTextForTtsFish does
   * the provider-appropriate cleaning downstream. Empty when no <語音> tag.
   */
  rawSpeech: string;
  /** Validated MiniMax emotion from the tag's emotion="…" attribute, or undefined. */
  emotion?: string;
  /** Whether a <語音> tag was present at all. */
  hasVoiceTag: boolean;
  /**
   * <字幕>…</字幕> 裡的中文對照（外語語音模式下模型顯式給出的翻譯）。
   * 語音條「轉文字」面板的翻譯第一優先級用它 —— 有顯式字幕就不用猜、不用調 LLM。
   */
  subtitle?: string;
}

// <語音 emotion="happy">…</語音> — emotion attribute optional, single/double/no quotes tolerated.
// 屬性前空格可省 (<語音emotion=…> 也認), 閉合標籤容許空格 / 簡繁互換。
const VOICE_TAG_RE = /<[语語語]音(?:[^>]*?emotion\s*=\s*["']?([a-zA-Z]+)["']?)?[^>]*>([\s\S]*?)<\/\s*[语語語]音\s*>/;

/**
 * Parse an assistant message into display text + spoken text + emotion.
 * The single source of truth for the structured voice-output format that the
 * LLM is taught to emit. Invalid emotions are dropped (returns undefined) so a
 * malformed attribute can never reach the API.
 */
const SUBTITLE_BLOCK_RE = /<字幕>([\s\S]*?)<\/字幕>/;

export const parseVoiceOutput = (raw: string): ParsedVoiceOutput => {
  if (!raw) return { display: '', speech: '', rawSpeech: '', hasVoiceTag: false };
  // 語音標籤自愈: 未閉合 / 孤兒閉合 / 全角符號 / 屬性寫歪, 先修再配對。
  // 新消息落庫前 sanitize 已經修過, 這裡主要救歷史壞數據 + 非落庫調用點 (電話/見面)。
  raw = normalizeVoiceTags(raw);
  const m = raw.match(VOICE_TAG_RE);
  if (!m) {
    // 沒有語音標籤: 落單的字幕標籤剝掉留內文, 別把原始標籤當正文
    return { display: raw.replace(/<\/?字幕>/g, '').trim(), speech: '', rawSpeech: '', hasVoiceTag: false };
  }
  const rawEmotion = (m[1] || '').trim().toLowerCase();
  const emotion = VALID_EMOTIONS.has(rawEmotion) ? rawEmotion : undefined;
  const speech = stripParensPreservingTags(m[2]).replace(/\s+/g, ' ').trim();
  // 不做 MiniMax 的括號/情緒標剝離，留給 cleanTextForTtsFish 按魚聲規則處理。
  const rawSpeech = m[2].replace(/\s+/g, ' ').trim();
  const subtitle = raw.match(SUBTITLE_BLOCK_RE)?.[1]?.trim() || undefined;
  // display = 語音塊和字幕塊之外的文字 (普通閒聊); 字幕單獨走 subtitle 字段
  const display = raw
    .replace(/<[语語語]音[^>]*>[\s\S]*?<\/\s*[语語語]音\s*>/g, '')
    .replace(/<字幕>[\s\S]*?<\/字幕>/g, '')
    .trim();
  return { display, speech, rawSpeech, emotion, hasVoiceTag: true, subtitle };
};

/** 為 TTS 文本插入 MiniMax 原生停頓標籤 <#秒數#>，讓語音有自然停頓
 * 停頓層次（從短到長）:
 *   ，、；  →  0.06s  微停（換氣級）
 *   。！？  →  0.12s  句末停頓
 *   ——     →  0.18s  話題轉折 / 拖長
 *   ……     →  0.35s  欲言又止 / 沉默感
 *   \n     →  0.25s  段落換氣
 */
export const insertSpeechBreaks = (text: string): string => {
  if (!text) return '';
  return text
    // 省略號：欲言又止 / 猶豫
    .replace(/[…]{2,}/g, '……<#0.45#>')          // 多個省略號連用，更長
    .replace(/[…]/g, '…<#0.35#>')               // 單個省略號
    .replace(/\.{3,}/g, '...<#0.35#>')           // 英文省略號
    // 破折號：話題轉折、語氣拉長
    .replace(/——/g, '——<#0.22#>')
    .replace(/--/g, '--<#0.22#>')
    // 句末標點：句子之間留出真實呼吸（別讓角色一口氣趕完）
    .replace(/([。])/g, '$1<#0.22#>')
    .replace(/([！？!?])/g, '$1<#0.26#>')        // 感嘆/疑問停頓更明顯
    // 句中標點：換氣
    .replace(/([，,])/g, '$1<#0.10#>')
    .replace(/([、；;：:])/g, '$1<#0.07#>')
    // 換行：段落間停頓
    .replace(/\n/g, '\n<#0.30#>')
    // 去重：相鄰多個停頓標籤只保留最長的那個（封頂 0.6s）
    .replace(/(<#[\d.]+#>[\s]*){2,}/g, (match) => {
      const times = [...match.matchAll(/<#([\d.]+)#>/g)].map(m => parseFloat(m[1]));
      const maxTime = Math.min(Math.max(...times), 0.6);
      return `<#${maxTime.toFixed(2)}#>`;
    })
    .trim();
};

/**
 * Soft-clamp a numeric value to keep it within a safe range.
 * Preserves direction and feel but prevents extreme spikes that sound unnatural.
 */
const softClamp = (value: number, limit: number): number => {
  if (Math.abs(value) <= limit) return value;
  // Beyond the limit, compress logarithmically — still moves in the same direction but tapers off
  const sign = value > 0 ? 1 : -1;
  const excess = Math.abs(value) - limit;
  return sign * (limit + Math.log1p(excess) * (limit * 0.15));
};

/** Build timber_weights & voice_modify extras from a voiceProfile. */
export const buildTtsExtras = (
  vp: CharacterProfile['voiceProfile'],
  paramVersion: MiniMaxParamVersion = 'legacy',
) => {
  if (!vp) return {};
  const extras: any = {};
  const tw = vp.timberWeights;
  if (tw && tw.length > 1) {
    extras.timber_weights = (() => {
      const totalWeight = tw.reduce((sum: number, t: any) => sum + (t.weight || 0), 0);
      if (totalWeight === 0) return tw.map((t: any) => ({ voice_id: t.voice_id, weight: Math.round(100 / tw.length) }));
      const raw = tw.map((t: any) => ({ voice_id: t.voice_id, weight: Math.round((t.weight / totalWeight) * 100) }));
      const diff = 100 - raw.reduce((s: number, r: any) => s + r.weight, 0);
      if (diff !== 0) raw[0].weight += diff;
      return raw;
    })();
  }
  if (vp.voiceModify) {
    const vm: any = {};
    if (paramVersion === 'natural-v2') {
      // 新版只按接口的硬邊界保護，確保捏聲音試聽與實際播放採用相同數值。
      const officialClamp = (value: number) => Math.max(-100, Math.min(100, Math.round(value)));
      if (vp.voiceModify.pitch) vm.pitch = officialClamp(vp.voiceModify.pitch);
      if (vp.voiceModify.intensity) vm.intensity = officialClamp(vp.voiceModify.intensity);
      if (vp.voiceModify.timbre) vm.timbre = officialClamp(vp.voiceModify.timbre);
    } else {
      // 經典參數原樣保留歷史的柔性限幅，防止老角色升級後聲音突變。
      if (vp.voiceModify.pitch) vm.pitch = Math.round(softClamp(vp.voiceModify.pitch, 40));
      if (vp.voiceModify.intensity) vm.intensity = Math.round(softClamp(vp.voiceModify.intensity, 30));
      if (vp.voiceModify.timbre) vm.timbre = Math.round(softClamp(vp.voiceModify.timbre, 40));
    }
    if (vp.voiceModify.sound_effects) vm.sound_effects = vp.voiceModify.sound_effects;
    if (Object.keys(vm).length) extras.voice_modify = vm;
  }
  return extras;
};

/**
 * Build voice_setting fields (speed, vol, pitch, emotion) with safe ranges.
 * `emotionOverride` (validated MiniMax emotion, e.g. from a <語音 emotion="…"> tag)
 * wins over the character's static voiceProfile.emotion. Invalid values are ignored.
 */
export const buildVoiceSettings = (
  vp: CharacterProfile['voiceProfile'],
  emotionOverride?: string,
  paramVersion: MiniMaxParamVersion = 'legacy',
) => {
  if (paramVersion === 'natural-v2') {
    const savedEmotion = (vp?.emotion || '').trim().toLowerCase();
    const dynamicEmotion = (emotionOverride || '').trim().toLowerCase();
    // 用戶手選的固定情感優先；選擇“自動”時才採用每條語音的動態情感。
    const emotion = VALID_EMOTIONS.has(savedEmotion)
      ? savedEmotion
      : (VALID_EMOTIONS.has(dynamicEmotion) ? dynamicEmotion : '');
    return {
      speed: Math.max(0.5, Math.min(2, vp?.speed ?? 1)),
      vol: Math.max(0.01, Math.min(10, vp?.vol ?? 1)),
      pitch: Math.max(-12, Math.min(12, vp?.pitch ?? 0)),
      ...(emotion ? { emotion } : {}),
    };
  }

  const emotion = (emotionOverride && VALID_EMOTIONS.has(emotionOverride))
    ? emotionOverride
    : (vp?.emotion || '');
  return {
    // Clamp speed to 0.75–1.4 for natural human feel (API allows 0.5–2)
    speed: Math.max(0.75, Math.min(1.4, vp?.speed ?? 1)),
    vol: Math.max(0.3, Math.min(2, vp?.vol ?? 1)),
    // Clamp base pitch to ±8 semitones (API allows ±12) to avoid alien sound
    pitch: Math.max(-8, Math.min(8, vp?.pitch ?? 0)),
    // Normalize numbers/English so "2.8" etc. are read naturally
    english_normalization: true,
    ...(emotion ? { emotion } : {}),
  };
};

/**
 * 經典參數會自動在標點後補停頓；新版保留模型原生韻律，只尊重文本中明確寫出的停頓標籤。
 */
export const prepareMiniMaxSpeechText = (
  text: string,
  vp: CharacterProfile['voiceProfile'],
): string => getMiniMaxParamVersion(vp) === 'natural-v2' ? (text || '').trim() : insertSpeechBreaks(text);

export interface MiniMaxTtsPayloadOptions {
  languageBoost?: string;
  emotion?: string;
  voiceId?: string;
  model?: string;
  groupId?: string;
  /** 電話經典模式保留 32k/128k 單聲道音頻設置。傳輸格式統一使用 HEX。 */
  legacyTransport?: 'shared' | 'call';
  /** 電話先處理整段再切塊；切塊後不能二次插入停頓。 */
  textAlreadyPrepared?: boolean;
}

/** 構建版本化 MiniMax 請求；聊天、約會和電話的新版參數共用這一處。 */
export const buildMiniMaxTtsPayload = (
  text: string,
  vp: CharacterProfile['voiceProfile'],
  options: MiniMaxTtsPayloadOptions = {},
): any => {
  const paramVersion = getMiniMaxParamVersion(vp);
  const payloadText = options.textAlreadyPrepared ? (text || '').trim() : prepareMiniMaxSpeechText(text, vp);
  const isLegacyCall = paramVersion === 'legacy' && options.legacyTransport === 'call';
  const payload: any = {
    model: options.model || vp?.model || DEFAULT_MODEL,
    text: payloadText,
    // Inline audio avoids a second, CORS-protected GET to MiniMax's regional OSS.
    // Transport format does not change the voice/acoustic settings or cache key.
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: options.voiceId ?? vp?.voiceId ?? '',
      ...buildVoiceSettings(vp, options.emotion, paramVersion),
    },
    audio_setting: paramVersion === 'natural-v2' || isLegacyCall
      ? { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 }
      : { format: 'mp3' },
    ...buildTtsExtras(vp, paramVersion),
  };

  // 舊版參數路徑繼續保留原始 ISO 短碼，唯獨粵語必須發送 MiniMax 官方枚舉
  // `Chinese,Yue`；`yue` 本身不是 language_boost 的合法值。
  const languageBoost = paramVersion === 'natural-v2' || options.languageBoost?.trim().toLowerCase() === 'yue'
    ? normalizeMiniMaxLanguageBoost(options.languageBoost)
    : options.languageBoost || undefined;
  if (languageBoost) payload.language_boost = languageBoost;
  if (options.groupId) payload.group_id = options.groupId;
  return payload;
};

/** 新版使用獨立緩存命名空間，絕不復用經典參數生成的舊音頻。 */
export const buildMiniMaxTtsCacheKey = (
  payload: any,
  paramVersion: MiniMaxParamVersion = 'legacy',
): string => hashTtsParams({
  kind: paramVersion === 'natural-v2' ? 'minimax-t2a-natural-v2' : 'minimax-t2a',
  text: payload.text,
  model: payload.model,
  voice_setting: payload.voice_setting,
  timber_weights: payload.timber_weights,
  voice_modify: payload.voice_modify,
  language_boost: payload.language_boost,
  audio_setting: payload.audio_setting,
});

/** Convert hex audio from MiniMax to a playable Blob */
export const convertHexAudioToBlob = (hexAudio: string, mimeType = 'audio/mpeg'): Blob => {
  const cleanHex = hexAudio.trim().replace(/^0x/i, '');
  if (!cleanHex || cleanHex.length % 2 !== 0 || /[^\da-f]/i.test(cleanHex)) {
    throw new Error('MiniMax 返回的 HEX 音頻數據格式異常');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return new Blob([bytes], { type: mimeType });
};

/** Fetch remote audio URL and return as Blob */
export const fetchRemoteAudioBlob = async (sourceUrl: string): Promise<Blob> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Preserve signed URLs exactly; their signature/cache identity belongs to the upstream.
    const response = await fetch(sourceUrl, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`音頻下載失敗（HTTP ${response.status}）`);
    const type = response.headers.get('content-type') || '';
    if (/text\/html|application\/(?:json|xml)/i.test(type)) throw new Error('音頻地址返回了錯誤頁面');
    const blob = await response.blob();
    if (!blob.size) throw new Error('音頻下載為空文件');
    return blob;
  } finally {
    clearTimeout(timer);
  }
};

export interface TtsResult {
  /** Playable URL for <audio> — a blob: URL when `blob` is present, otherwise a remote MiniMax CDN URL */
  url: string;
  /** Raw audio blob when available. Null when we fell back to the remote URL (CORS / network). */
  blob: Blob | null;
}

/**
 * Call MiniMax TTS and return both the raw blob (if available) and a playable URL.
 * Prefer this variant when you need to persist audio to storage — the blob can be
 * written to IndexedDB so the audio survives page/component reloads.
 */
export async function synthesizeSpeechDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string }
): Promise<TtsResult> {
  const apiKey = resolveMiniMaxApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少 MiniMax API Key');
  const vp = char.voiceProfile;
  if (!vp?.voiceId && (!vp?.timberWeights || vp.timberWeights.length === 0)) {
    throw new Error('角色未配置語音');
  }

  const paramVersion = getMiniMaxParamVersion(vp);
  const payload = buildMiniMaxTtsPayload(text, vp, {
    languageBoost: options?.languageBoost,
    emotion: options?.emotion,
  });

  // Check the shared cache before hitting the network. Two call sites that
  // build the same payload get the same hash and reuse whichever one synthesized
  // the audio first — across sessions, across apps.
  const cacheKey = buildMiniMaxTtsCacheKey(payload, paramVersion);
  const cached = await getCachedTts(cacheKey);
  if (cached) {
    return { url: URL.createObjectURL(cached), blob: cached };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-MiniMax-API-Key': apiKey,
  };
  if (options?.groupId) headers['X-MiniMax-Group-Id'] = options.groupId;

  const res = await minimaxFetch('/api/minimax/t2a', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `TTS 失敗 (HTTP ${res.status})`);

  // Check MiniMax business-level error (can return HTTP 200 with status_code != 0)
  const baseResp = data?.base_resp;
  if (baseResp && baseResp.status_code !== 0 && baseResp.status_code !== undefined) {
    throw new Error(`TTS 業務錯誤: ${baseResp.status_msg || `status_code=${baseResp.status_code}`}`);
  }

  const audio = data?.data?.audio;
  if (typeof audio !== 'string' || !audio.trim()) {
    // Log full response for debugging
    console.error('[TTS] No audio in response:', JSON.stringify(data).slice(0, 500));
    throw new Error('TTS 返回無音頻數據');
  }

  let blob: Blob;
  if (/^https?:\/\//i.test(audio.trim())) {
    try {
      blob = await fetchRemoteAudioBlob(audio.trim());
    } catch (e) {
      // fetch() may fail due to CORS when hitting MiniMax CDN directly;
      // return the raw URL so <audio src=...> can load it without CORS.
      console.warn('[TTS] fetchRemoteAudioBlob failed, returning remote URL directly', (e as any)?.message || e);
      return { url: audio.trim(), blob: null };
    }
  } else {
    blob = convertHexAudioToBlob(audio);
  }
  // Persist to the shared cache in the background — the next identical request
  // (same text + voice settings) will be served locally.
  saveCachedTts(cacheKey, blob).catch(() => { /* ignore */ });
  return { url: URL.createObjectURL(blob), blob };
}

/**
 * Call MiniMax TTS and return a playable URL. Thin wrapper around
 * `synthesizeSpeechDetailed` — use that variant when you also need the raw blob.
 */
export async function synthesizeSpeech(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string }
): Promise<string> {
  const { url } = await synthesizeSpeechDetailed(text, char, apiConfig, options);
  return url;
}
