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
