import { describe, expect, it } from 'vitest';
import { adaptiveMouthLevel, shouldKeepNativeCallAudio, vowelFromBands } from './callAudioFeed';

describe('adaptiveMouthLevel', () => {
  it('小音量語音也能張到接近滿口型（相對峰值歸一）', () => {
    let peak = 0.05;
    // 連續多幀 0.04 的小聲說話：峰值收斂到 ~0.05，口型應接近全開
    let level = 0;
    for (let i = 0; i < 60; i += 1) {
      const out = adaptiveMouthLevel(0.045, peak);
      peak = out.peak;
      level = out.level;
    }
    expect(level).toBeGreaterThan(0.85);
  });

  it('靜音/底噪幀直接閉嘴，不殘留抖動', () => {
    const out = adaptiveMouthLevel(0.002, 0.3);
    expect(out.level).toBe(0);
  });

  it('峰值跟隨更響的輸入立即抬升，避免爆音頂滿', () => {
    const out = adaptiveMouthLevel(0.6, 0.1);
    expect(out.peak).toBe(0.6);
    expect(out.level).toBeLessThanOrEqual(1);
  });

  it('峰值緩慢回落，切到小聲片段後能恢復動態範圍', () => {
    let peak = 0.8;
    for (let i = 0; i < 400; i += 1) peak = adaptiveMouthLevel(0.01, peak).peak;
    expect(peak).toBeLessThan(0.25);
  });
});

describe('vowelFromBands', () => {
  it('低頻佔優（あ/お類元音）趨近 0', () => {
    expect(vowelFromBands(0.8, 0.1)).toBeLessThan(0.2);
  });
  it('高頻佔優（い/え類元音）趨近 1', () => {
    expect(vowelFromBands(0.1, 0.7)).toBeGreaterThan(0.8);
  });
  it('近乎無聲時回中位，不產生 NaN', () => {
    expect(vowelFromBands(0, 0)).toBe(0.5);
  });
});

describe('iOS call audio routing', () => {
  it('keeps iPhone and iPad audio on the native media element path', () => {
    expect(shouldKeepNativeCallAudio({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    })).toBe(true);
    expect(shouldKeepNativeCallAudio({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBe(true);
  });

  it('allows desktop browsers to use the analyser graph', () => {
    expect(shouldKeepNativeCallAudio({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      platform: 'Win32',
      maxTouchPoints: 0,
    })).toBe(false);
  });
});
