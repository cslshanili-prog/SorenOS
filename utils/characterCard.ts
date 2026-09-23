import { CharacterProfile } from '../types';

/**
 * 角色卡分享時必須剝離的字段清單。
 *
 * 角色卡是拿來分享「角色」本身的（人設、世界觀、立繪、世界書……），
 * 不該把發卡人自己的私密憑據、界面美化、本地偏好和運行時殘留一起帶出去。
 * 歷史上導出走的是「黑名單隻剔 6 個字段、其餘 ...cardProps 全導出」的寫法，
 * 導致下面這些東西全被打包進卡里，別人一導入就整套接管——尤其是 API 密鑰，
 * 屬於災難級洩漏。這裡改成一份顯式清單，**導出時不寫出、導入時也不讀入**，
 * 雙向都過一遍：即便別人給你一張老版本（已經把密鑰打進去的）卡，導入這側也會剝掉。
 *
 * 分四類：
 *  1) 憑據：任何內嵌 API key 的配置對象，整體剔除（emotion buff / 向量 / 主動消息副 API）。
 *  2) 美化：主題、白框 CSS、氣泡、背景、提示音、思考鏈樣式——接收方用自己的。
 *  3) 語言：各處語音語言 / 開關偏好——接收方的本地偏好，不該被卡覆蓋。
 *  4) 運行時狀態：buff、宮殿注入、見面/小屋存檔、查手機數據等發卡人當下狀態殘留。
 */
export const CARD_STRIPPED_FIELDS = [
  // 1) 憑據（含 apiKey，災難級洩漏）
  'chatApi',
  'emotionConfig',
  'embeddingConfig',
  'proactiveConfig',
  'activeMsg2Config',

  // 2) 美化
  'embeddedTheme',           // CharacterExportData 上的內嵌主題（導入側一併剝離）
  'bubbleStyle',
  'chatFineTune',            // 聊天裝扮（細節微調的角色級覆蓋）：發卡人的界面偏好，接收方用自己的
  'chromeCustomCss',
  'chatSound',
  'chatSoundBound',
  'chatBackground',
  'dateBackground',
  'thinkingChainStyle',
  'thinkingChainCustomColors',
  'thinkingChainCustomPrompt',
  'thinkingChainCustomCss',
  'chatCollaborationEnabled', // 用戶在本機選擇的日常聊天注意力模式

  // 3) 語言 / 語音 / 組織類本地偏好
  'groupId',                 // 角色分組是發卡人自己的整理方式，指向的分組 id 在接收方本地也不存在
  'chatVoiceLang',
  'dateVoiceLang',
  'callVoiceLang',
  'chatVoiceEnabled',
  'chatVoiceAutoPlay',
  'dateVoiceEnabled',
  'memoryPalaceWaterline', // 發卡人的使用節奏；接收方按自己的聊天習慣選擇

  // 4) 運行時狀態殘留
  'activeBuffs',
  'buffInjection',
  'memoryPalaceInjection',
  'videoCallPerformancePersona',
  'videoCallPerformancePersonaGeneratedAt',
  'companionTouchSettings',
  'companionAvatar',
  'savedDateState',
  'savedRoomState',
  'lastRoomDate',
  'phoneState',
  'dreamLogs',
  'specialMomentRecords',
  'vrState',
  'chibiStudio',
] as const;

/**
 * 從一份角色卡數據裡剔除所有敏感 / 私密 / 運行時字段，返回淺拷貝。
 * 導出（生成分享文件）和導入（落庫前）都調用它，保證兩個方向一致。
 */
export function stripSensitiveCardFields<T extends Record<string, any>>(data: T): T {
  const clone: Record<string, any> = { ...data };
  for (const key of CARD_STRIPPED_FIELDS) {
    delete clone[key];
  }
  return clone as T;
}

/** 供類型收窄用：CharacterProfile 上被剝離掉的鍵。 */
export type StrippedCardField = Extract<keyof CharacterProfile, typeof CARD_STRIPPED_FIELDS[number]>;
