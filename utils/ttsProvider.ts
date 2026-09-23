/**
 * 全局 TTS 服務商選擇（MiniMax / 魚聲 Fish Audio / ElevenLabs）。
 *
 * 大多數語音合成入口都能拿到 apiConfig，直接用 `resolveTtsProvider(apiConfig)` 即可。
 * 但少數地方（如 chatPrompts.buildSystemPrompt 拼語音格式指導時）拿不到 apiConfig，
 * 所以這裡額外維護一個模塊級單例：OSContext 在 apiConfig.ttsProvider 變化時
 * 調 setTtsProvider() 同步，prompt 側用 getTtsProvider() 讀最新值。
 * （與 minimaxEndpoint 裡的 region 單例同一套思路。）
 */
import type { APIConfig, TtsProvider } from '../types';

export const normalizeTtsProvider = (raw: unknown): TtsProvider =>
  raw === 'fishaudio' ? 'fishaudio' : raw === 'elevenlabs' ? 'elevenlabs' : 'minimax';

let currentProvider: TtsProvider = 'minimax';

export function setTtsProvider(provider: TtsProvider | string | undefined | null): void {
  currentProvider = normalizeTtsProvider(provider);
}

export function getTtsProvider(): TtsProvider {
  return currentProvider;
}

const DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';
let currentElevenLabsModel = DEFAULT_ELEVENLABS_MODEL;

/** 同步當前 ElevenLabs 模型，供拿不到 apiConfig 的 prompt 構建器做模型感知。 */
export function setElevenLabsModel(model: string | undefined | null): void {
  currentElevenLabsModel = typeof model === 'string' && model.trim()
    ? model.trim()
    : DEFAULT_ELEVENLABS_MODEL;
}

export function getElevenLabsModel(): string {
  return currentElevenLabsModel;
}

/** 從 apiConfig 解析當前 TTS 服務商（缺省 → minimax）。 */
export const resolveTtsProvider = (apiConfig?: Pick<APIConfig, 'ttsProvider'> | null): TtsProvider =>
  normalizeTtsProvider(apiConfig?.ttsProvider);

/**
 * 用戶自定義「語音表演指南」覆蓋。
 * 與 ttsProvider 單例同一套思路：chatPrompts / datePrompts 拼語音格式指導時拿不到 apiConfig，
 * 所以 OSContext 在 apiConfig.voicePrompts 變化時調 setVoicePromptOverrides() 同步，
 * prompt 側用 getVoicePromptOverride() 讀最新值。某項留空 → 返回 undefined → 調用方回退內置默認。
 *
 * 三個鍵：
 *   - 'minimax' / 'fishaudio' / 'elevenlabs'：聊天 + 電話共用，按當前服務商注入。
 *   - 'dateVoice'：見面（DateApp）專用的 [v:xxx] 語音情緒規則，與服務商無關、單獨一份。
 */
export type VoicePromptKey = TtsProvider | 'dateVoice';

let voicePromptOverrides: Partial<Record<VoicePromptKey, string>> = {};

export function setVoicePromptOverrides(overrides: APIConfig['voicePrompts'] | undefined | null): void {
  voicePromptOverrides = {
    minimax: typeof overrides?.minimax === 'string' ? overrides.minimax : undefined,
    fishaudio: typeof overrides?.fishaudio === 'string' ? overrides.fishaudio : undefined,
    elevenlabs: typeof overrides?.elevenlabs === 'string' ? overrides.elevenlabs : undefined,
    dateVoice: typeof overrides?.dateVoice === 'string' ? overrides.dateVoice : undefined,
  };
}

/** 取某項的自定義語音指南；空白 / 未設 → undefined（調用方用內置默認兜底）。 */
export function getVoicePromptOverride(key: VoicePromptKey): string | undefined {
  const v = voicePromptOverrides[key];
  return v && v.trim() ? v : undefined;
}
