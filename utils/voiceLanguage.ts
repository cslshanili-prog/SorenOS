export const VOICE_LANGUAGE_OPTIONS = [
  { value: '', label: '默認' },
  { value: 'yue', label: '粵語 / 廣東話' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ru', label: 'Русский' },
] as const;

export const CANTONESE_VOICE_SUPPORT_NOTE = 'MiniMax 與 Fish S2 系列可直接使用；ElevenLabs 需選擇 Eleven v3。';

export const voiceLanguageLabel = (value?: string): string => (
  VOICE_LANGUAGE_OPTIONS.find(option => option.value === (value || ''))?.label
  || value
  || '默認'
);

/**
 * 統計只允許發送源碼裡寫死的語種枚舉。角色數據可能來自舊備份或手工編輯，
 * 所以不能把未知值直接交給 Umami；空值也換成可讀的固定代號。
 */
export const voiceLanguageAnalyticsValue = (value?: string): string => {
  const normalized = value || '';
  return VOICE_LANGUAGE_OPTIONS.some(option => option.value === normalized)
    ? (normalized || 'default')
    : 'custom';
};

/**
 * 給 LLM 的目標語種說明要比界面標籤更精確。只寫“粵語”時，一些模型仍會產出
 * 普通書面中文，TTS 最後只能按普通話念；這裡明確要求粵語口語和粵語用字。
 */
export const voiceLanguagePromptLabel = (value?: string): string => {
  if ((value || '').trim().toLowerCase() === 'yue') {
    return '地道、自然的粵語口語（粵語／廣東話），使用繁體粵語用字，不要寫成普通話書面語';
  }
  return voiceLanguageLabel(value);
};
