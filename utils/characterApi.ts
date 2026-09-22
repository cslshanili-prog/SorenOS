import { CharacterProfile } from '../types';

export interface ResolvedChatApi {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 角色专属 chatApi（聊天设置里的「对话模型」）> 全局 apiConfig。 */
export function resolveCharacterChatApi(char: CharacterProfile, apiConfig: ResolvedChatApi): ResolvedChatApi {
  return char.chatApi?.baseUrl ? char.chatApi : apiConfig;
}

/**
 * 「日程/情绪」面板里心声/好感度生成用的 API：情绪/意识流 API（emotionConfig.api）> 全局
 * apiConfig。故意不跟 resolveCharacterChatApi 一样落到角色专属 chatApi——那通常配的是主
 * 对话用的贵模型，情绪/意识流 API 才是用户专门配来跑这类辅助生成的便宜模型，两笔账不能混。
 */
export function resolveCharacterMeterApi(char: CharacterProfile, apiConfig: ResolvedChatApi): ResolvedChatApi {
  return char.emotionConfig?.api?.baseUrl ? char.emotionConfig.api : apiConfig;
}
