import { describe, it, expect } from 'vitest';
import { ChatParser } from './chatParser';

// 鎖住「多段 <語音> 不被 chunkText 按換行切碎」的修復。
// 背景: 外語語音字幕對齊模式 (chatPrompts voiceActingGuide, commit c2ba85e) 要求模型
//   把 <語音> 內容按空行分成好幾段。chunkText 主切點是換行, 修復前會把一個多段語音塊
//   拆到好幾個氣泡裡 —— <語音> 開標籤落一條、</語音> 閉標籤落另一條, MessageItem 的
//   hasVoiceTag (要求開閉成對) 全部匹配失敗, 於是原始 <語音 emotion="…"> 標籤當純文字
//   漏給用戶看, 語音條和翻譯也都不渲染 (用戶報的「語音掉格式」)。
describe('chunkText: <語音> 原子塊保護', () => {
  it('多段語音 (含空行) → 整塊單 chunk, 開閉標籤不散落', () => {
    const input = '<語音 emotion="calm">第一段。\n\n第二段。\n\n第三段。</語音>';
    const chunks = ChatParser.chunkText(input);
    expect(chunks).toEqual([
      '<語音 emotion="calm">第一段。\n\n第二段。\n\n第三段。</語音>',
    ]);
  });

  it('前置文字 + 多段語音 → 文字成一條, 語音整塊成一條', () => {
    const input = '你聽我說\n<語音 emotion="sad">ねえ、聞いて。\n\n大丈夫だから。</語音>';
    const chunks = ChatParser.chunkText(input);
    expect(chunks).toEqual([
      '你聽我說',
      '<語音 emotion="sad">ねえ、聞いて。\n\n大丈夫だから。</語音>',
    ]);
  });

  it('語音塊後還有正文 → 語音整塊 + 正文各自成條', () => {
    const input = '<語音>Wait...\nare you serious?</語音>\n真的假的';
    const chunks = ChatParser.chunkText(input);
    expect(chunks).toEqual([
      '<語音>Wait...\nare you serious?</語音>',
      '真的假的',
    ]);
  });

  it('繁體 <語音> 同樣受保護', () => {
    const input = '<語音 emotion="happy">今日はいい天気。\n\n散歩しよう。</語音>';
    const chunks = ChatParser.chunkText(input);
    expect(chunks).toEqual([
      '<語音 emotion="happy">今日はいい天気。\n\n散歩しよう。</語音>',
    ]);
  });

  it('無語音標籤時只按顯式換行分氣泡，行內 CJK 空格保留', () => {
    expect(ChatParser.chunkText('第一句\n第二句')).toEqual(['第一句', '第二句']);
    expect(ChatParser.chunkText('你好 世界')).toEqual(['你好 世界']);
  });

  it('角色自定義的日中雙語長句不會在中文空格處被攔腰拆開', () => {
    const input = '「1日3個くらいなら死にはしないよ。卵より、キノコ以外の野菜がゼロなことの方を心配しろ（一天三個死不了人的。比起雞蛋 你還是多擔心一下除了菌菇以外蔬菜為零這件事吧）」';
    expect(ChatParser.chunkText(input)).toEqual([input]);
  });
});
