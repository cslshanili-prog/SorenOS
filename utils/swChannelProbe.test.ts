import { describe, it, expect } from 'vitest';
import { summarizeChannelHealth } from './swChannelProbe';

/**
 * 這組測試守的是一件很容易被忽略的事：主動消息有實時和兜底兩條腿，實時那條斷了之後
 * **功能表面上仍然是好的**——消息照樣會到，只是每條都要白等最多一分鐘。所以判定不能
 * 看「消息到沒到」，只能看「有沒有過 SW 喊頁面這件事」。
 */
describe('summarizeChannelHealth（實時通道還活著沒有）', () => {
  it('收到過 SW 消息 → 判定正常，並給出最近那次的時刻', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start', ts: '2026-09-04T02:50:30.000Z', trigger: 'SW通知' },
      { event: 'runtime-sw-message', ts: '2026-09-04T02:50:29.000Z' },
    ]);

    expect(health.status).toBe('ok');
    expect(health.lastSwMessageAt).toBe('2026-09-04T02:50:29.000Z');
  });

  it('消息一直在到、但沒有一次是 SW 喊的 → 判定為只剩兜底', () => {
    // 這正是線上那台設備的形態：沖刷在跑、消息也上屏了，就是沒人實時喊過它。
    // 只看「有沒有沖刷」會把這種情況判成正常，那就永遠發現不了。
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start', ts: '2026-09-04T02:50:30.000Z', trigger: '輪詢補收' },
      { event: 'runtime-flush-start', ts: '2026-09-04T02:53:35.000Z', trigger: '輪詢補收' },
      { event: 'runtime-inbox-message', ts: '2026-09-04T02:53:36.000Z' },
    ]);

    expect(health.status).toBe('fallback-only');
    expect(health.lastSwMessageAt).toBeUndefined();
  });

  it('一次沖刷都沒有 → 不下結論（剛裝好、或這段時間根本沒消息）', () => {
    expect(summarizeChannelHealth([]).status).toBe('idle');
    expect(summarizeChannelHealth([{ event: 'runtime-emotion-done' }]).status).toBe('idle');
  });

  it('記錄亂序時取最新的那條 SW 消息，不是最後遇到的那條', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-sw-message', ts: '2026-09-04T02:50:29.000Z' },
      { event: 'runtime-sw-message', ts: '2026-09-04T01:00:00.000Z' },
    ]);

    expect(health.lastSwMessageAt).toBe('2026-09-04T02:50:29.000Z');
  });

  it('按觸發源分類計數，多的排前面', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start', trigger: '輪詢補收' },
      { event: 'runtime-flush-start', trigger: '輪詢補收' },
      { event: 'runtime-flush-start', trigger: '輪詢補收' },
      { event: 'runtime-flush-start', trigger: '回到前台' },
    ]);

    expect(health.flushByTrigger).toEqual([
      { trigger: '輪詢補收', count: 3 },
      { trigger: '回到前台', count: 1 },
    ]);
  });

  it('沒帶觸發源的沖刷不計數，免得湊出一個查不出所以然的分組', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start' },
      { event: 'runtime-flush-start', trigger: 'SW通知' },
    ]);

    expect(health.flushByTrigger).toEqual([{ trigger: 'SW通知', count: 1 }]);
  });
});
