/**
 * 迴歸測試：第三方 TTS / 語速相關設置經「導出 → 導入」是否完整還原。
 *  - APIConfig：Fish 與 ElevenLabs 全局配置
 *  - voiceProfile：Fish reference_id、ElevenLabs Voice ID 與共用語速
 *
 * 思路：apiConfig 走的是「整對象導出 + 合併導入（updateApiConfig）」，角色走的是
 * 「整 store 導出 + DB.importFullData 還原」。這裡分別用真實 DB 往返 + 合併邏輯斷言。
 */
import { describe, it, expect } from 'vitest';
import { DB } from './db';
import type { APIConfig } from '../types';

describe('第三方 TTS / 語速設置 導出→導入 round-trip', () => {
  it('角色 voiceProfile 的 Fish / ElevenLabs 音色與 speed 經真實 DB 導入還原', async () => {
    const char: any = {
      id: 'test-fish-char',
      name: '測試角色',
      voiceProfile: {
        provider: 'minimax',
        voiceId: 'mm-voice-1',          // 舊字段，確認不被影響
        minimaxParamVersion: 'natural-v2',
        fishReferenceId: '7f92f8afb8ec43bf81429cc1c9199cb1',
        fishModel: 's2-pro',
        elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
        speed: 0.85,
      },
    };

    // 模擬導入：DB.importFullData 會清空並寫入 characters store（與 OSContext 導入同路徑）
    await DB.importFullData({ characters: [char] } as any);

    const all = await DB.getAllCharacters();
    const got = all.find((c) => c.id === 'test-fish-char');
    expect(got).toBeTruthy();
    expect(got!.voiceProfile?.fishReferenceId).toBe('7f92f8afb8ec43bf81429cc1c9199cb1');
    expect(got!.voiceProfile?.fishModel).toBe('s2-pro');
    expect(got!.voiceProfile?.elevenLabsVoiceId).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(got!.voiceProfile?.speed).toBe(0.85);
    expect(got!.voiceProfile?.voiceId).toBe('mm-voice-1'); // 舊字段一併保留
    expect(got!.voiceProfile?.minimaxParamVersion).toBe('natural-v2');
  });

  it('APIConfig 的 Fish / ElevenLabs 字段經導出→序列化→合併導入還原', () => {
    // 導出：OSContext 把整個 apiConfig 對象塞進 backupData（無字段白名單）
    const exported: APIConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'llm-key',
      model: 'gpt-4o-mini',
      minimaxApiKey: 'mm-key',
      ttsProvider: 'fishaudio',
      fishAudioApiKey: 'fish-key-abc',
      fishAudioModel: 's2.1-pro',
      elevenLabsApiKey: 'eleven-key-abc',
      elevenLabsModel: 'eleven_v3',
      elevenLabsStability: 0.5,
      elevenLabsSimilarityBoost: 0.8,
      elevenLabsStyle: 0.2,
      elevenLabsUseSpeakerBoost: true,
      voicePrompts: { elevenlabs: 'custom eleven prompt' },
    };
    // 寫盤 / 讀盤的 JSON 往返
    const backup = JSON.parse(JSON.stringify({ apiConfig: exported }));

    // 導入：updateApiConfig(data.apiConfig) === { ...現有, ...導入 }（OSContext.tsx:2055）
    const current = { baseUrl: '', apiKey: '', model: 'gpt-4o-mini' } as APIConfig;
    const merged = { ...current, ...backup.apiConfig } as APIConfig;

    expect(merged.ttsProvider).toBe('fishaudio');
    expect(merged.fishAudioApiKey).toBe('fish-key-abc');
    expect(merged.fishAudioModel).toBe('s2.1-pro');
    expect(merged.elevenLabsApiKey).toBe('eleven-key-abc');
    expect(merged.elevenLabsModel).toBe('eleven_v3');
    expect(merged.elevenLabsStyle).toBe(0.2);
    expect(merged.voicePrompts?.elevenlabs).toBe('custom eleven prompt');
    expect(merged.minimaxApiKey).toBe('mm-key'); // 舊字段也在

    // localStorage 持久化往返（updateApiConfig 會 setItem('os_api_config', ...)）
    localStorage.setItem('os_api_config', JSON.stringify(merged));
    const reloaded = JSON.parse(localStorage.getItem('os_api_config')!);
    expect(reloaded.fishAudioApiKey).toBe('fish-key-abc');
    expect(reloaded.ttsProvider).toBe('fishaudio');
    expect(reloaded.fishAudioModel).toBe('s2.1-pro');
    expect(reloaded.elevenLabsApiKey).toBe('eleven-key-abc');
    expect(reloaded.elevenLabsModel).toBe('eleven_v3');
    expect(reloaded.elevenLabsUseSpeakerBoost).toBe(true);
  });
});
