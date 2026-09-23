import { describe, expect, it } from 'vitest';
import { extractAvatarPerformance, inferAvatarPerformanceFromText, resolveAvatarPerformance } from './avatarPerformance';
import { parseCallAssistantMessage, stripCallTextFormatting } from './callReplyFormat';

describe('視頻通話回覆分流', () => {
  it('把原生 reasoning_content 存為思維鏈，不混進台詞', () => {
    expect(parseCallAssistantMessage({ content: '喂，聽得到嗎？', reasoning_content: '剛接起來，先確認信號。' }, true)).toEqual({
      text: '喂，聽得到嗎？',
      thinkingChain: '剛接起來，先確認信號。',
    });
  });

  it('剝掉閉合和未閉合 think 標籤，且只在開關開啟時返回思維鏈', () => {
    const raw = '<think>先別笑得太明顯。</think>\n[[AVATAR: emotion=happy; gesture=wave; camera=push-in; gaze=viewer; intensity=0.85]]\n(chuckle) 你來啦。';
    const parsed = parseCallAssistantMessage({ content: raw }, true);
    expect(parsed.text).toBe('(chuckle) 你來啦。');
    expect(parsed.thinkingChain).toBe('先別笑得太明顯。');
    expect(parsed.performance).toMatchObject({ emotion: 'happy', gesture: 'wave', camera: 'push-in', gaze: 'viewer', intensity: 0.85 });
    expect(parseCallAssistantMessage({ content: '<think>秘密</think>正文' }, false)).toEqual({ text: '正文' });
  });

  it('兼容 content 分塊與 reasoning-only 中轉', () => {
    expect(parseCallAssistantMessage({ content: [{ type: 'text', text: '分塊正文' }] }, true).text).toBe('分塊正文');
    expect(parseCallAssistantMessage({ content: '', reasoning_content: '代理塞錯位置的最終台詞' }, true)).toEqual({ text: '代理塞錯位置的最終台詞' });
  });

  it('演出參數做枚舉歸一與強度限幅', () => {
    const out = extractAvatarPerformance('[[PERFORMANCE: expression=joy action=agree shot=close-up look=camera energy=2]]\n好。');
    expect(out.text).toBe('好。');
    expect(out.direction).toEqual({ emotion: 'happy', gesture: 'nod', camera: 'close', gaze: 'viewer', intensity: 1 });
    expect(resolveAvatarPerformance(undefined, 'surprised').emotion).toBe('surprised');
    expect(extractAvatarPerformance('[[AVATAR: emotion=happy; model_action=motion-3]]\n好。').direction?.modelAction).toBe('motion-3');
  });

  it('朗讀前去掉 Markdown 外殼但保留正文和語音標籤', () => {
    expect(stripCallTextFormatting('## **別怕**\n- 我在。\n<語音 emotion="calm">I am here.</語音>'))
      .toBe('別怕\n我在。\n<語音 emotion="calm">I am here.</語音>');
  });

  it('模型漏演出標籤時可從台詞做本地動作兜底', () => {
    expect(inferAvatarPerformanceFromText('喂，你終於來啦。')).toMatchObject({ emotion: 'happy', gesture: 'wave' });
    expect(inferAvatarPerformanceFromText('啊？你說真的？')).toMatchObject({ emotion: 'surprised', gesture: 'tilt', camera: 'push-in' });
    expect(inferAvatarPerformanceFromText('……對不起，我今天有點難過。')).toMatchObject({ emotion: 'sad', gesture: 'shy', gaze: 'down' });
  });
});
