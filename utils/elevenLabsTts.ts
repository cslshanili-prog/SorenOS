/**
 * ElevenLabs TTS 適配器。
 *
 * 第一階段沿用 SullyOS 現有的「拿到完整 Blob 後播放 + IndexedDB 緩存」契約，
 * 因而聊天、見面、電話無需引入第二套 PCM 播放器。瀏覽器走同源 /api 或主代理
 * Worker，Capacitor 原生端直連官方接口；三條路徑的請求體完全一致。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig, CharacterProfile } from '../types';
import { normalizeApiKey } from './minimaxApiKey';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import type { TtsResult } from './minimaxTts';
import { normalizeVoiceTags } from './sanitize';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';

export const DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

export const ELEVENLABS_MODEL_OPTIONS = [
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 —— 低延遲，通話推薦' },
  { value: 'eleven_v3', label: 'Eleven v3 —— 情緒最豐富，支持 Audio Tags' },
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2 —— 長文本穩定、音質優先' },
] as const;

export const normalizeElevenLabsModel = (raw?: string | null): string => {
  const value = (raw || '').trim();
  return value || DEFAULT_ELEVENLABS_MODEL;
};

export const isElevenLabsV3Model = (raw?: string | null): boolean =>
  normalizeElevenLabsModel(raw) === 'eleven_v3';

export const ELEVENLABS_V3_VOICE_ACTING_GUIDE = `### ElevenLabs v3 語音表演規則

你寫的是馬上會被角色親口說出來的台詞，不是小說旁白。句子要口語化、有呼吸、有長短變化；不要寫“她輕聲說道”之類會被念出來的敘述。

Eleven v3 支持方括號 Audio Tags。只在情緒真正變化的位置少量使用：\`[laughs]\`、\`[chuckles]\`、\`[whispers]\`、\`[sighs]\`、\`[excited]\`、\`[curious]\`、\`[sarcastic]\`、\`[crying]\`、\`[hesitates]\`、\`[softly]\`、\`[pause]\`。標籤用半角英文方括號，通常一段 0–2 個；不要每句開頭都塞標籤，不要自造中文標籤。

停頓優先靠逗號、句號、省略號、破折號和自然換行；確實需要明顯沉默才用 \`[pause]\`。標籤是演出指令，不要在標籤外再複述動作。`;

export const ELEVENLABS_STANDARD_VOICE_ACTING_GUIDE = `### ElevenLabs 語音表演規則

你寫的是馬上會被角色親口說出來的台詞，不是小說旁白。只寫會說出口的話，保持口語化、自然、有長短句變化；不要寫“她輕聲說道”一類敘述。

當前模型不是 Eleven v3，**不要輸出方括號 Audio Tags、圓括號動作詞或 SSML**，否則它們可能被原樣念出來。情緒和停頓只靠措辭、語氣詞、逗號、句號、省略號、破折號與自然換行表達。強情緒也要克制，避免播音腔和每句同一種節奏。`;

export const getElevenLabsVoiceActingGuide = (model?: string | null): string =>
  isElevenLabsV3Model(model)
    ? ELEVENLABS_V3_VOICE_ACTING_GUIDE
    : ELEVENLABS_STANDARD_VOICE_ACTING_GUIDE;

const V3_CUE_ALIASES: Record<string, string> = {
  laugh: 'laughs', laughing: 'laughs', laughs: 'laughs', giggle: 'chuckles', giggles: 'chuckles',
  chuckle: 'chuckles', chuckling: 'chuckles', chuckles: 'chuckles',
  whisper: 'whispers', whispering: 'whispers', whispers: 'whispers',
  sigh: 'sighs', sighing: 'sighs', sighs: 'sighs', exhale: 'exhales', exhales: 'exhales',
  excited: 'excited', happy: 'excited', playful: 'mischievously', mischievous: 'mischievously',
  mischievously: 'mischievously', curious: 'curious', sarcastic: 'sarcastic',
  crying: 'crying', sobbing: 'crying', snort: 'snorts', snorts: 'snorts',
  pause: 'pause', 'short pause': 'pause', 'long pause': 'pause', break: 'pause',
  hesitate: 'hesitates', hesitates: 'hesitates', hesitant: 'hesitates',
  softly: 'softly', soft: 'softly', calm: 'softly', breathy: 'softly',
  angry: 'angry', sad: 'sad', nervous: 'nervously', nervously: 'nervously',
};

const normalizeV3Cue = (raw: string): string => {
  const key = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return V3_CUE_ALIASES[key] || '';
};

/** 支持粘貼純 ID，也支持從常見 ElevenLabs 頁面鏈接提取 voiceId。 */
export const normalizeElevenLabsVoiceId = (raw?: string | null): string => {
  const value = (raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const queryId = parsed.searchParams.get('voiceId') || parsed.searchParams.get('voice_id');
    if (queryId) return queryId.trim();
    const voicePath = parsed.pathname.match(/\/(?:voices?|voice-library)\/([A-Za-z0-9_-]{8,64})(?:\/|$)/i);
    if (voicePath) return voicePath[1];
    return '';
  } catch {
    // 純 ID 不是 URL，繼續走下面的容錯提取。
  }
  const embedded = value.match(/(?:voiceId|voice_id)[=/:]([A-Za-z0-9_-]{8,64})/i);
  if (embedded) return embedded[1];
  return value.split(/[?#\s]/)[0];
};

export const resolveElevenLabsApiKey = (apiConfig: APIConfig): string =>
  normalizeApiKey(apiConfig.elevenLabsApiKey || '');

export const resolveElevenLabsModel = (apiConfig: APIConfig): string =>
  normalizeElevenLabsModel(apiConfig.elevenLabsModel);

const extractVoiceBody = (raw: string): string => {
  const normalized = normalizeVoiceTags(raw || '');
  const voiceTag = normalized.match(/<[语語語]音[^>]*>([\s\S]*?)<\/\s*[语語語]音\s*>/);
  return voiceTag ? voiceTag[1] : normalized;
};

/**
 * ElevenLabs 專屬文本清洗：v3 保留一小組官方 Audio Tags；其餘模型剝掉演出標籤，
 * 防止把 [laughs] / (sighs) 當正文念出來。
 */
export const cleanTextForTtsElevenLabs = (raw: string, model?: string | null): string => {
  const isV3 = isElevenLabsV3Model(model);
  let text = extractVoiceBody(raw)
    .replace(/\[\[.*?\]\]/g, '')
    .replace(/%%BILINGUAL%%[\s\S]*/i, '')
    .replace(/<字幕>[\s\S]*?<\/字幕>/g, '')
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/（[^）]{0,80}）/g, '')
    .replace(/\(([^)]{1,60})\)/g, (_match, inner: string) => {
      const cue = normalizeV3Cue(inner);
      return isV3 && cue ? `[${cue}]` : '';
    })
    .replace(/\[([^\[\]]{1,60})\]/g, (_match, inner: string) => {
      const cue = normalizeV3Cue(inner);
      if (!cue) return /[A-Za-z]/.test(inner) || /[\u4e00-\u9fff]/.test(inner) ? '' : _match;
      return isV3 ? `[${cue}]` : '';
    });

  text = text
    .replace(/\n{2,}/g, isV3 ? ' [pause] ' : '……')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？、；：,.!?…])/g, '$1')
    .trim();
  return text;
};

export const stripElevenLabsMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/\[([^\[\]]{1,60})\]/g, (match, inner: string) => normalizeV3Cue(inner) ? '' : match)
    .replace(/\(([^)]{1,60})\)/g, (match, inner: string) => normalizeV3Cue(inner) ? '' : match)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
};

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
};

const EMOTION_TO_V3_CUE: Record<string, string> = {
  happy: 'excited', sad: 'sad', angry: 'angry', fearful: 'nervously',
  disgusted: 'sarcastic', surprised: 'curious', calm: 'softly', fluent: 'softly',
};

export interface ElevenLabsRequestBody {
  text: string;
  model_id: string;
  language_code?: string;
  voice_settings: {
    stability: number;
    similarity_boost: number;
    style: number;
    speed: number;
    use_speaker_boost: boolean;
  };
}

export const buildElevenLabsRequestBody = (
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; emotion?: string },
): ElevenLabsRequestBody => {
  const model = resolveElevenLabsModel(apiConfig);
  const rawStability = clamp(apiConfig.elevenLabsStability, 0.5, 0, 1);
  // Eleven v3 官方只定義 Creative / Natural / Robust 三檔穩定度。
  const stability = isElevenLabsV3Model(model)
    ? [0, 0.5, 1].reduce((nearest, candidate) =>
        Math.abs(candidate - rawStability) < Math.abs(nearest - rawStability) ? candidate : nearest, 0.5)
    : rawStability;
  const languageCode = (options?.languageBoost || '').trim().toLowerCase();
  let spoken = cleanTextForTtsElevenLabs(text, model);
  const emotionCue = options?.emotion ? EMOTION_TO_V3_CUE[options.emotion.toLowerCase()] : '';
  if (isElevenLabsV3Model(model) && emotionCue && !/\[[^\]]+\]/.test(spoken)) {
    spoken = `[${emotionCue}] ${spoken}`;
  }
  return {
    text: spoken,
    model_id: model,
    ...(/^[a-z]{2}$/.test(languageCode) ? { language_code: languageCode } : {}),
    voice_settings: {
      stability,
      similarity_boost: clamp(apiConfig.elevenLabsSimilarityBoost, 0.8, 0, 1),
      style: clamp(apiConfig.elevenLabsStyle, 0, 0, 1),
      speed: clamp(char.voiceProfile?.speed, 1, 0.7, 1.2),
      use_speaker_boost: apiConfig.elevenLabsUseSpeakerBoost === true,
    },
  };
};

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

const useStaticWorker = (): boolean => {
  if (typeof window === 'undefined') return false;
  return isStaticWebDeployment(window.location.protocol, window.location.hostname);
};

const base64ToBlob = (base64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

const friendlyElevenLabsError = (status: number, detail: string): string => {
  const normalized = detail.toLowerCase();
  if (status === 401 || normalized.includes('invalid api key')) return 'ElevenLabs API Key 無效或已過期';
  if (status === 402 || normalized.includes('quota') || normalized.includes('credits')) return 'ElevenLabs 額度不足';
  if (status === 403) return 'ElevenLabs 拒絕訪問，請檢查 Key 權限或 IP 限制';
  if (status === 404) return 'ElevenLabs Voice ID 或模型不存在';
  if (status === 429) return 'ElevenLabs 請求過於頻繁，請稍後再試';
  return `ElevenLabs TTS 失敗 (HTTP ${status})${detail ? `：${detail.slice(0, 240)}` : ''}`;
};

const elevenLabsFetchAudio = async (
  voiceId: string,
  apiKey: string,
  payload: ElevenLabsRequestBody,
): Promise<Blob> => {
  const query = `voice_id=${encodeURIComponent(voiceId)}&output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`;
  if (isNative()) {
    const response = await CapacitorHttp.request({
      url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      data: payload,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(friendlyElevenLabsError(response.status, String(response.data || '')));
    }
    const blob = base64ToBlob(String(response.data || ''));
    if (!blob.size) throw new Error('ElevenLabs 返回了空音頻');
    return blob;
  }

  const url = useStaticWorker()
    ? `${getProxyWorkerUrl()}/elevenlabs/tts?${query}`
    : `/api/elevenlabs/tts?${query}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(friendlyElevenLabsError(response.status, detail));
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('ElevenLabs 返回了空音頻');
  return blob;
};

export async function synthesizeSpeechElevenLabsDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = resolveElevenLabsApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少 ElevenLabs API Key');
  const voiceId = normalizeElevenLabsVoiceId(char.voiceProfile?.elevenLabsVoiceId);
  if (!voiceId) throw new Error('角色未配置 ElevenLabs Voice ID');

  const payload = buildElevenLabsRequestBody(text, char, apiConfig, options);
  if (!payload.text) throw new Error('ElevenLabs TTS 文本為空');

  const cacheKey = hashTtsParams({
    kind: 'elevenlabs-tts',
    voice_id: voiceId,
    output_format: ELEVENLABS_OUTPUT_FORMAT,
    ...payload,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) return { url: URL.createObjectURL(cached), blob: cached };

  console.log('[elevenlabs] TTS', {
    model: payload.model_id,
    voice_id_suffix: voiceId.slice(-4),
    text_length: payload.text.length,
    language_code: payload.language_code || 'auto',
  });
  const blob = await elevenLabsFetchAudio(voiceId, apiKey, payload);
  saveCachedTts(cacheKey, blob).catch(() => { /* cache failure must not block playback */ });
  return { url: URL.createObjectURL(blob), blob };
}

export async function synthesizeSpeechElevenLabs(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  const { url } = await synthesizeSpeechElevenLabsDetailed(text, char, apiConfig, options);
  return url;
}
