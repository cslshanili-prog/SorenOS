import { describe, it, expect } from 'vitest';
import { stripSensitiveCardFields, CARD_STRIPPED_FIELDS } from './characterCard';

describe('stripSensitiveCardFields', () => {
  it('剝離所有內嵌 API 密鑰（導出絕不洩漏憑據）', () => {
    const card = {
      name: '小明',
      systemPrompt: '你是小明',
      emotionConfig: { enabled: true, api: { baseUrl: 'https://x', apiKey: 'sk-SECRET', model: 'gpt' } },
      embeddingConfig: { baseUrl: 'https://x', apiKey: 'sk-SECRET2', model: 'emb', dimensions: 1024 },
      proactiveConfig: { enabled: true, intervalMinutes: 60, secondaryApi: { baseUrl: 'https://x', apiKey: 'sk-SECRET3', model: 'gpt' } },
      activeMsg2Config: { enabled: true, secondaryApi: { apiKey: 'sk-SECRET4' } },
    };

    const out = stripSensitiveCardFields(card);
    const json = JSON.stringify(out);

    expect(out.name).toBe('小明');
    expect(out.systemPrompt).toBe('你是小明');
    expect(json).not.toContain('sk-SECRET');
    expect(out).not.toHaveProperty('emotionConfig');
    expect(out).not.toHaveProperty('embeddingConfig');
    expect(out).not.toHaveProperty('proactiveConfig');
    expect(out).not.toHaveProperty('activeMsg2Config');
  });

  it('剝離美化 / 語言 / 運行時狀態，保留角色本身', () => {
    const card = {
      name: '小紅',
      systemPrompt: 'sp',
      worldview: '世界觀',
      sprites: { happy: 'data:img' },
      // 美化
      bubbleStyle: 'theme-1',
      chatFineTune: { enabled: true, chatBubbleFontSize: 14 },
      chromeCustomCss: '.x{}',
      embeddedTheme: { id: 't1' },
      chatBackground: 'bg',
      // 語言
      chatVoiceLang: 'ja',
      dateVoiceLang: 'en',
      memoryPalaceWaterline: { preset: 'offline' },
      // 運行時狀態
      activeBuffs: [{ id: 'b1' }],
      buffInjection: '（開心）',
      phoneState: { records: [] },
      savedDateState: { foo: 1 },
      videoCallPerformancePersona: '只在本機使用的表演人格摘要',
      videoCallPerformancePersonaGeneratedAt: 123456,
      companionTouchSettings: { enabledZones: ['head'], reactions: { head: [{ id: 'head-1', text: '私人台詞', performance: {} }] } },
    };

    const out = stripSensitiveCardFields(card);

    // 角色本身保留
    expect(out.name).toBe('小紅');
    expect(out.worldview).toBe('世界觀');
    expect(out.sprites).toEqual({ happy: 'data:img' });

    // 全部被剝離
    for (const key of ['bubbleStyle', 'chatFineTune', 'chromeCustomCss', 'embeddedTheme', 'chatBackground',
      'chatVoiceLang', 'dateVoiceLang', 'activeBuffs', 'buffInjection', 'phoneState', 'savedDateState',
      'videoCallPerformancePersona', 'videoCallPerformancePersonaGeneratedAt', 'companionTouchSettings']) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('不修改原對象（返回淺拷貝）', () => {
    const card = { name: 'x', emotionConfig: { enabled: true, api: { apiKey: 'sk' } } };
    stripSensitiveCardFields(card);
    expect(card).toHaveProperty('emotionConfig');
  });

  it('對缺失字段安全（不會拋錯）', () => {
    expect(() => stripSensitiveCardFields({ name: 'x' })).not.toThrow();
    expect(stripSensitiveCardFields({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('清單覆蓋四類敏感字段', () => {
    for (const k of ['emotionConfig', 'embeddingConfig', 'bubbleStyle', 'chatVoiceLang', 'memoryPalaceWaterline', 'activeBuffs', 'phoneState']) {
      expect(CARD_STRIPPED_FIELDS).toContain(k);
    }
  });
});
