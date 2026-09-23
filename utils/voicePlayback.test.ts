import { describe, it, expect } from 'vitest';
import { shouldAutoGenerateVoice, shouldAutoPlayGeneratedVoice } from './voicePlayback';

// 關著「收到就自動播放」時不該偷偷合成：合出來也不響，白花一次 TTS 調用。
describe('shouldAutoGenerateVoice', () => {
  it('沒開「收到就自動播放」→ 不自動合成，留空語音條等用戶點', () => {
    expect(shouldAutoGenerateVoice({})).toBe(false);
    expect(shouldAutoGenerateVoice({ autoPlayEnabled: false })).toBe(false);
    expect(shouldAutoGenerateVoice({ autoPlayEnabled: undefined })).toBe(false);
  });

  it('開了「收到就自動播放」→ 收到消息就合成', () => {
    expect(shouldAutoGenerateVoice({ autoPlayEnabled: true })).toBe(true);
  });
});

// 語音條合成完的播放時機。以前是無條件播（收到 AI 語音就直接響），
// 用戶「有時候不想聽」沒有出口 —— 這裡把兩條規則釘住：
// 自動來的默認不響、用戶自己點的一定響。
describe('shouldAutoPlayGeneratedVoice', () => {
  it('AI 自動發來的語音：沒開開關 → 不播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true })).toBe(false);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: false })).toBe(false);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: undefined })).toBe(false);
  });

  it('AI 自動發來的語音：開了「收到就自動播放」→ 播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: true })).toBe(true);
  });

  it('用戶主動點的（轉換語音 / 點空語音條）：不管開關都播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false })).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false, autoPlayEnabled: false })).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false, autoPlayEnabled: true })).toBe(true);
  });
});
