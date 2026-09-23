// 「點預設 = 立刻切過去」的口徑守衛。
//
// 為什麼值得釘：這塊出過的問題全是靜默的——界面高亮著 B、請求發去 A，或者切了一下
// 溫度被順手重置。都不報錯，只有對著帳單或輸出風格才看得出來。
import { describe, expect, it } from 'vitest';

import type { APIConfig, ApiPreset } from '../types';
import { configFromPreset, findActivePresetId, presetMatchesConfig } from './apiPresetSwitch';

const preset = (id: string, config: Partial<APIConfig>): ApiPreset => ({
  id,
  name: `preset-${id}`,
  config: { baseUrl: '', apiKey: '', model: '', ...config } as APIConfig,
});

describe('configFromPreset', () => {
  it('帶上三件套並歸一化（末尾斜槓、粘貼帶進來的空格）', () => {
    const patch = configFromPreset(preset('a', {
      baseUrl: ' https://api.example.com/v1/ ',
      apiKey: ' sk-abc ',
      model: ' gpt-x ',
    }));

    expect(patch).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-abc',
      model: 'gpt-x',
    });
  });

  it('預設沒存 stream / temperature 時一個字都不帶（老預設不許重置用戶調過的溫度）', () => {
    // 聊天面板存的預設只有三件套。舊實現在這裡補 stream:false + temperature:0.85，
    // 切一次預設就把用戶手調的溫度打回默認。
    const patch = configFromPreset(preset('a', { baseUrl: 'https://x', model: 'm' }));

    expect('stream' in patch).toBe(false);
    expect('temperature' in patch).toBe(false);
  });

  it('預設存了就照搬，包括 false / 0 這種容易被 falsy 判定吃掉的值', () => {
    const patch = configFromPreset(preset('a', {
      baseUrl: 'https://x',
      model: 'm',
      stream: false,
      temperature: 0,
    }));

    expect(patch.stream).toBe(false);
    expect(patch.temperature).toBe(0);
  });
});

describe('findActivePresetId', () => {
  const presets = [
    preset('main', { baseUrl: 'https://a.example.com/v1', apiKey: 'sk-1', model: 'm1' }),
    // 同站同模型、只換了令牌的副號：Key 也參與比對，兩條不能混為一條
    preset('backup', { baseUrl: 'https://a.example.com/v1', apiKey: 'sk-2', model: 'm1' }),
  ];

  it('認出當前生效的那條', () => {
    expect(findActivePresetId(presets, { baseUrl: 'https://a.example.com/v1', apiKey: 'sk-2', model: 'm1' }))
      .toBe('backup');
  });

  it('末尾斜槓不同不算換了一條', () => {
    expect(findActivePresetId(presets, { baseUrl: 'https://a.example.com/v1/', apiKey: 'sk-1', model: 'm1' }))
      .toBe('main');
  });

  it('手填的配置不打勾', () => {
    expect(findActivePresetId(presets, { baseUrl: 'https://other.example.com', apiKey: 'sk-1', model: 'm1' }))
      .toBeNull();
  });

  it('還沒配過 API 時不打勾（別跟同樣空著的預設撞上）', () => {
    expect(findActivePresetId([preset('empty', {})], { baseUrl: '', apiKey: '', model: '' })).toBeNull();
  });
});

describe('presetMatchesConfig', () => {
  it('只看三件套，溫度 / 流式不參與判定', () => {
    const p = preset('a', { baseUrl: 'https://x', apiKey: 'k', model: 'm', temperature: 0.85 });

    expect(presetMatchesConfig(p, { baseUrl: 'https://x', apiKey: 'k', model: 'm' })).toBe(true);
  });
});
