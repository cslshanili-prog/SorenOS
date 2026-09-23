import { describe, expect, it } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';
import { assertTtsLanguageSupported } from './ttsRouter';
import { VOICE_LANGUAGE_OPTIONS, voiceLanguageAnalyticsValue, voiceLanguagePromptLabel } from './voiceLanguage';

const character = (fishModel?: string) => ({
  id: 'char-1',
  name: '測試角色',
  voiceProfile: { fishModel },
} as CharacterProfile);

const config = (overrides: Partial<APIConfig>): APIConfig => ({
  baseUrl: '', apiKey: '', model: '', ...overrides,
});

describe('Cantonese voice language', () => {
  it('is visible and asks the LLM for colloquial Cantonese rather than written Mandarin', () => {
    expect(VOICE_LANGUAGE_OPTIONS.some(option => option.value === 'yue')).toBe(true);
    expect(voiceLanguagePromptLabel('yue')).toContain('粵語口語');
    expect(voiceLanguagePromptLabel('yue')).toContain('不要寫成普通話');
  });

  it('only exposes fixed language enums to analytics', () => {
    expect(voiceLanguageAnalyticsValue('yue')).toBe('yue');
    expect(voiceLanguageAnalyticsValue('')).toBe('default');
    expect(voiceLanguageAnalyticsValue('用戶自己填的語種')).toBe('custom');
  });

  it('allows MiniMax, Fish S2 and Eleven v3', () => {
    expect(() => assertTtsLanguageSupported(character(), config({ ttsProvider: 'minimax' }), 'yue')).not.toThrow();
    expect(() => assertTtsLanguageSupported(character('s2.1-pro'), config({ ttsProvider: 'fishaudio' }), 'yue')).not.toThrow();
    expect(() => assertTtsLanguageSupported(character(), config({ ttsProvider: 'elevenlabs', elevenLabsModel: 'eleven_v3' }), 'yue')).not.toThrow();
  });

  it('rejects models whose official language list does not include Cantonese', () => {
    expect(() => assertTtsLanguageSupported(character('s1'), config({ ttsProvider: 'fishaudio' }), 'yue')).toThrow('S2');
    expect(() => assertTtsLanguageSupported(character(), config({ ttsProvider: 'elevenlabs', elevenLabsModel: 'eleven_flash_v2_5' }), 'yue')).toThrow('Eleven v3');
  });
});
