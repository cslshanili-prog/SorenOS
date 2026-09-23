/**
 * API 預設的「切過去」和「現在用的是哪條」。
 *
 * 預設點一下就直接生效——不存在「載入了但還沒保存」的中間狀態，所以這裡只做兩件
 * 純粹的事，Settings 面板和測試共用同一份口徑：
 *
 *   1. configFromPreset  切到這條預設時，要寫進全局配置的字段
 *   2. findActivePresetId 反過來，認出當前生效的配置對應哪條預設（界面上打勾用）
 *
 * 不碰 React、不碰存儲。
 */

import type { APIConfig, ApiPreset } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';

/**
 * 切換預設時覆蓋的字段。
 *
 * stream / temperature 是**可選**的：從聊天面板存下來的預設只有 URL / Key / Model
 * 三件套（見 EmotionSettingsPanel），預設裡沒存的字段一律保持原樣，不能拿默認值
 * 把用戶手調過的溫度、流式開關順手重置掉。
 */
export type PresetSwitchPatch =
  Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'> & Partial<Pick<APIConfig, 'stream' | 'temperature'>>;

export function configFromPreset(preset: ApiPreset): PresetSwitchPatch {
  const patch: PresetSwitchPatch = {
    baseUrl: normalizeApiBaseUrl(preset.config.baseUrl),
    apiKey: normalizeApiCredential(preset.config.apiKey),
    model: normalizeApiModel(preset.config.model),
  };
  if (typeof preset.config.stream === 'boolean') patch.stream = preset.config.stream;
  if (typeof preset.config.temperature === 'number') patch.temperature = preset.config.temperature;
  return patch;
}

/** 三件套一致才算「就是這條預設」。都歸一化後比，免得末尾斜槓 / 空格造成假不一致。 */
export function presetMatchesConfig(
  preset: ApiPreset,
  config: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
): boolean {
  return normalizeApiBaseUrl(preset.config.baseUrl) === normalizeApiBaseUrl(config.baseUrl)
    && normalizeApiCredential(preset.config.apiKey) === normalizeApiCredential(config.apiKey)
    && normalizeApiModel(preset.config.model) === normalizeApiModel(config.model);
}

/**
 * 當前生效的是哪條預設；手填的配置（不等於任何一條）返回 null。
 *
 * 用值比對而不是記一個「上次點的是誰」：刷新、手改表單、導入備份之後它都不會說謊，
 * 界面上的高亮永遠等於「請求真的會發去哪」。URL 和 Model 都空 = 還沒配過，不打勾。
 */
export function findActivePresetId(
  presets: ApiPreset[],
  config: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
): string | null {
  if (!normalizeApiBaseUrl(config.baseUrl) && !normalizeApiModel(config.model)) return null;
  return presets.find(preset => presetMatchesConfig(preset, config))?.id ?? null;
}
