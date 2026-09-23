import { CharacterProfile } from '../types';

export interface ResolvedChatApi {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 角色專屬 chatApi（聊天設置裡的「對話模型」）> 全局 apiConfig。 */
export function resolveCharacterChatApi(char: CharacterProfile, apiConfig: ResolvedChatApi): ResolvedChatApi {
  return char.chatApi?.baseUrl ? char.chatApi : apiConfig;
}

/**
 * 「日程/情緒」面板裡心聲/好感度生成用的 API：情緒/意識流 API（emotionConfig.api）> 全局
 * apiConfig。故意不跟 resolveCharacterChatApi 一樣落到角色專屬 chatApi——那通常配的是主
 * 對話用的貴模型，情緒/意識流 API 才是用戶專門配來跑這類輔助生成的便宜模型，兩筆帳不能混。
 */
export function resolveCharacterMeterApi(char: CharacterProfile, apiConfig: ResolvedChatApi): ResolvedChatApi {
  return char.emotionConfig?.api?.baseUrl ? char.emotionConfig.api : apiConfig;
}
