/**
 * TTS 服務商路由：按 apiConfig.ttsProvider 分發到 MiniMax、魚聲 Fish Audio 或 ElevenLabs。
 *
 * 聊天語音條（Chat）、約會（DateSession）直接用這裡的 synthesizeSpeech(Detailed)，
 * 不必關心底層是哪家。CallApp 因為要做分句流式 + 緩存鍵對齊，單獨在自己內部分支。
 */
import { CharacterProfile, APIConfig } from '../types';
import {
  synthesizeSpeechDetailed as minimaxSynthesizeDetailed,
  type TtsResult,
} from './minimaxTts';
import { synthesizeSpeechFishDetailed } from './fishAudioTts';
import { resolveTtsProvider } from './ttsProvider';
import {
  cleanTextForTtsElevenLabs,
  normalizeElevenLabsVoiceId,
  resolveElevenLabsApiKey,
  resolveElevenLabsModel,
  stripElevenLabsMarkupForDisplay,
  synthesizeSpeechElevenLabsDetailed,
} from './elevenLabsTts';
import { cleanTextForTts, cleanVoiceMarkupForDisplay } from './minimaxTts';
import { cleanTextForTtsFish, resolveFishAudioApiKey, stripFishMarkupForDisplay } from './fishAudioTts';
import { resolveMiniMaxApiKey } from './minimaxApiKey';

export type { TtsResult };

type SynthOptions = { languageBoost?: string; groupId?: string; emotion?: string };

/** 粵語並非三家所有模型都支持；在發起計費請求前給出明確錯誤。 */
export const assertTtsLanguageSupported = (
  char: CharacterProfile,
  apiConfig: APIConfig,
  languageBoost?: string,
): void => {
  if ((languageBoost || '').trim().toLowerCase() !== 'yue') return;
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'elevenlabs' && resolveElevenLabsModel(apiConfig) !== 'eleven_v3') {
    throw new Error('ElevenLabs 粵語需要 Eleven v3，請先在「設置 → 其他 API」切換模型');
  }
  const fishModel = (char.voiceProfile?.fishModel || apiConfig.fishAudioModel || 's2.1-pro').trim().toLowerCase();
  if (provider === 'fishaudio' && fishModel === 's1') {
    throw new Error('魚聲粵語需要 S2 系列，請先在「設置 → 其他 API」切換到 S2.1 Pro 或 S2 Pro');
  }
};

export async function synthesizeSpeechDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<TtsResult> {
  assertTtsLanguageSupported(char, apiConfig, options?.languageBoost);
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') {
    return synthesizeSpeechFishDetailed(text, char, apiConfig, options);
  }
  if (provider === 'elevenlabs') {
    return synthesizeSpeechElevenLabsDetailed(text, char, apiConfig, options);
  }
  return minimaxSynthesizeDetailed(text, char, apiConfig, options);
}

export async function synthesizeSpeech(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<string> {
  const { url } = await synthesizeSpeechDetailed(text, char, apiConfig, options);
  return url;
}

/**
 * 當前 TTS 服務商下，這個角色是否已配好可用音色。
 * 魚聲看 fishReferenceId；MiniMax 看 voiceId / timberWeights。
 * 各處「要不要顯示語音按鈕 / 要不要觸發自動 TTS」的判斷統一用它，避免漏掉魚聲分支。
 */
export const characterHasVoice = (char: CharacterProfile, apiConfig: APIConfig): boolean => {
  const vp = char.voiceProfile;
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') {
    return !!vp?.fishReferenceId;
  }
  if (provider === 'elevenlabs') return !!normalizeElevenLabsVoiceId(vp?.elevenLabsVoiceId);
  return !!(vp?.voiceId || (vp?.timberWeights && vp.timberWeights.length > 0));
};

/** 當前服務商的 Key + 當前角色音色是否都已配置。 */
export const canSynthesizeSpeech = (char: CharacterProfile, apiConfig: APIConfig): boolean => {
  if (!characterHasVoice(char, apiConfig)) return false;
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') return !!resolveFishAudioApiKey(apiConfig);
  if (provider === 'elevenlabs') return !!resolveElevenLabsApiKey(apiConfig);
  return !!resolveMiniMaxApiKey(apiConfig);
};

/** 按服務商清洗待朗讀文本，調用方不應再自己猜哪種標籤該保留。 */
export const cleanTextForTtsProvider = (text: string, apiConfig: APIConfig): string => {
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') return cleanTextForTtsFish(text);
  if (provider === 'elevenlabs') return cleanTextForTtsElevenLabs(text, resolveElevenLabsModel(apiConfig));
  return cleanTextForTts(text);
};

export const stripTtsMarkupForDisplay = (text: string, apiConfig: APIConfig): string => {
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') return stripFishMarkupForDisplay(text);
  if (provider === 'elevenlabs') return stripElevenLabsMarkupForDisplay(text);
  return cleanVoiceMarkupForDisplay(text);
};

/** Fish / ElevenLabs 的清洗器需要看到原始 inline cue；MiniMax 使用已消毒的 speech。 */
export const providerUsesRawVoiceMarkup = (apiConfig: APIConfig): boolean =>
  resolveTtsProvider(apiConfig) !== 'minimax';
