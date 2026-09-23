import { describe, it, expect } from 'vitest';
import { normalizeVoiceTags, sanitizeIntoSegments, sanitizeForBubble } from './sanitize';
import { ChatParser } from './chatParser';
import { collectVoiceBatchSubtitle, isPoisonedVoiceSubtitle } from './voiceSubtitle';

// 語音標籤自愈：模型把 <語音> 寫歪的各種真實形態都要能修回規範，
// 否則 chunkText 原子塊保護 / hasVoiceTag 配對全失效 → 掉格式。
describe('normalizeVoiceTags', () => {
  it('規範輸入原樣保留', () => {
    const s = '<語音 emotion="calm">你好</語音>';
    expect(normalizeVoiceTags(s)).toBe(s);
    expect(normalizeVoiceTags('沒有語音標籤的普通文本')).toBe('沒有語音標籤的普通文本');
  });

  it('未閉合開標籤 → 末尾補閉合', () => {
    expect(normalizeVoiceTags('<語音 emotion="calm">うん、そのまま。'))
      .toBe('<語音 emotion="calm">うん、そのまま。</語音>');
  });

  it('未閉合繁體開標籤 → 補繁體閉合', () => {
    expect(normalizeVoiceTags('<語音>大丈夫。')).toBe('<語音>大丈夫。</語音>');
  });

  it('孤兒閉合標籤 → 刪除', () => {
    expect(normalizeVoiceTags('前半句</語音>後半句')).toBe('前半句後半句');
  });

  it('嵌套多餘開標籤 → 刪除，保持一對', () => {
    expect(normalizeVoiceTags('<語音>第一段<語音>第二段</語音>'))
      .toBe('<語音>第一段第二段</語音>');
  });

  it('全角尖括號 → 半角', () => {
    expect(normalizeVoiceTags('＜語音 emotion="sad"＞ごめん＜/語音＞'))
      .toBe('<語音 emotion="sad">ごめん</語音>');
  });

  it('閉合標籤內空格 / 全角斜槓 → 規範', () => {
    expect(normalizeVoiceTags('<語音>hi</ 語音 >')).toBe('<語音>hi</語音>');
    expect(normalizeVoiceTags('<語音>hi<／語音>')).toBe('<語音>hi</語音>');
  });

  it('屬性少空格 / 全角引號 / 全角等號 → 規範', () => {
    expect(normalizeVoiceTags('<語音emotion="happy">hi</語音>'))
      .toBe('<語音 emotion="happy">hi</語音>');
    expect(normalizeVoiceTags('<語音 emotion=“calm”>hi</語音>'))
      .toBe('<語音 emotion="calm">hi</語音>');
    expect(normalizeVoiceTags('<語音 emotion＝"calm">hi</語音>'))
      .toBe('<語音 emotion="calm">hi</語音>');
  });

  it('自閉合空標籤 <語音/> → 刪除，不吞後文', () => {
    expect(normalizeVoiceTags('<語音/>後面的正文')).toBe('後面的正文');
  });

  it('多對標籤依次配對，互不干擾', () => {
    const s = '<語音>一</語音>中間<語音>二</語音>';
    expect(normalizeVoiceTags(s)).toBe(s);
  });

  // ─── <字幕> 標籤（顯式翻譯格式）───
  it('規範的 語音+字幕 組合原樣保留', () => {
    const s = '<語音 emotion="calm">Take a rest.</語音>\n<字幕>好好休息。</字幕>';
    expect(normalizeVoiceTags(s)).toBe(s);
  });

  it('未閉合語音 + 完整字幕 → 語音閉合插在字幕之前，不吞字幕', () => {
    expect(normalizeVoiceTags('<語音>Take a rest.\n<字幕>好好休息。</字幕>'))
      .toBe('<語音>Take a rest.</語音>\n<字幕>好好休息。</字幕>');
  });

  it('未閉合字幕 → 末尾補閉合；孤兒字幕閉合 → 刪除', () => {
    expect(normalizeVoiceTags('<語音>hi</語音>\n<字幕>你好'))
      .toBe('<語音>hi</語音>\n<字幕>你好</字幕>');
    expect(normalizeVoiceTags('前面</字幕>後面')).toBe('前面後面');
  });

  it('全角字幕標籤 → 規範化', () => {
    expect(normalizeVoiceTags('<語音>hi</語音>＜字幕＞你好＜/字幕＞'))
      .toBe('<語音>hi</語音><字幕>你好</字幕>');
  });
});

describe('自愈後整條管線聯動', () => {
  it('sanitizeForBubble: 未閉合多段語音 → 修好後 chunkText 保護成單 chunk', () => {
    // 模型忘寫閉合 + 內容多段：修復前保護正則配不上，語音塊會被切碎
    const raw = '<語音 emotion="calm">第一段。\n\n第二段。';
    const cleaned = sanitizeForBubble(raw);
    const chunks = ChatParser.chunkText(cleaned);
    expect(chunks).toEqual(['<語音 emotion="calm">第一段。\n\n第二段。</語音>']);
  });

  it('sanitizeIntoSegments (worker): 未閉合語音 → 單 segment，banner 取內部文字', () => {
    const segs = sanitizeIntoSegments('<語音 emotion="sad">ごめんね。\n\n本當に。');
    expect(segs).toEqual([
      { raw: '<語音 emotion="sad">ごめんね。\n\n本當に。</語音>', sanitized: 'ごめんね。\n\n本當に。' },
    ]);
  });

  it('sanitizeIntoSegments: 簡繁互換閉合 (<語音>…</語音>) 也整塊保護', () => {
    const segs = sanitizeIntoSegments('<語音>hi\n\nthere</語音>');
    expect(segs).toHaveLength(1);
    expect(segs[0].sanitized).toBe('hi\n\nthere');
  });

  it('sanitizeIntoSegments: 語音+字幕組合整塊單 segment, banner 用中文字幕', () => {
    const segs = sanitizeIntoSegments('閒聊一句\n<語音 emotion="calm">Take a rest, okay?</語音>\n<字幕>好好休息，好嗎？</字幕>');
    expect(segs).toEqual([
      { raw: '閒聊一句', sanitized: '閒聊一句' },
      {
        raw: '<語音 emotion="calm">Take a rest, okay?</語音>\n<字幕>好好休息，好嗎？</字幕>',
        sanitized: '好好休息，好嗎？',
      },
    ]);
  });

  it('chunkText: 語音+字幕組合是一個原子 chunk, 不被換行拆開', () => {
    const chunks = ChatParser.chunkText('打字的話\n<語音>Sleep well.\n\nGood night.</語音>\n<字幕>睡個好覺。\n\n晚安。</字幕>\n又一句');
    expect(chunks).toEqual([
      '打字的話',
      '<語音>Sleep well.\n\nGood night.</語音>\n<字幕>睡個好覺。\n\n晚安。</字幕>',
      '又一句',
    ]);
  });
});

// 「外語語音沒翻譯」修復：字幕從同批次兄弟氣泡直接收回來。
// 但只有模型真的守了字幕對齊格式才收（結構校驗），否則返回 '' 走 LLM 翻譯 ——
// 真實翻車報告：模型標籤外寫的是獨立閒聊短句，轉文字面板卻把它們當翻譯展示。
describe('collectVoiceBatchSubtitle', () => {
  const mk = (id: number, role: 'user' | 'assistant', content: string, type: 'text' | 'emoji' = 'text') =>
    ({ id, role, type, content }) as any;

  it('對齊的字幕（氣泡數 == 語音段數）→ 按序拼接', () => {
    const msgs = [
      mk(1, 'user', '你在嗎'),
      mk(2, 'assistant', '別怕，我在這裡陪著你。'),
      mk(3, 'assistant', '閉上眼睛好好休息吧。'),
      mk(4, 'assistant', '<語音 emotion="calm">怖がらないで、俺がここにいる。\n\n目を閉じてゆっくり休んで。</語音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 4)).toBe('別怕，我在這裡陪著你。\n閉上眼睛好好休息吧。');
  });

  it('翻車場景迴歸：閒聊短句 ≠ 字幕（氣泡數對不上語音段數）→ 空串走 LLM', () => {
    // 模型沒守字幕對齊：4 條獨立中文短句 + 一整段英文獨白
    const msgs = [
      mk(1, 'assistant', '？？'),
      mk(2, 'assistant', '寶寶你六點半就醒了'),
      mk(3, 'assistant', '等我一下'),
      mk(4, 'assistant', '剛睜眼嗓子還是啞的'),
      mk(5, 'assistant', "<語音>Morning, baby. I just opened my eyes and... you weren't next to me, so. That's already annoying. Anyway. Good morning. I love you. Come back to bed.</語音>"),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 5)).toBe('');
  });

  it('段數碰巧一致但長度懸殊 → 空串走 LLM', () => {
    const msgs = [
      mk(1, 'assistant', '等我一下'),
      mk(2, 'assistant', "<語音>Morning, baby. I just opened my eyes and you weren't next to me. That's already annoying. I had this dream where you were feeding me cake and then took it away.</語音>"),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('');
  });

  it('批次邊界：不越過 user 消息去收上一輪的文字', () => {
    const msgs = [
      mk(1, 'assistant', '上一輪說的完全不相干的話'),
      mk(2, 'user', '嗯'),
      mk(3, 'assistant', '這一輪的中文字幕在這裡。'),
      mk(4, 'assistant', '<語音>ここが今回の字幕のはずだよ。</語音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 4)).toBe('這一輪的中文字幕在這裡。');
  });

  it('同批次有第二條語音 → 歸屬含糊，返回空串走 LLM 兜底', () => {
    const msgs = [
      mk(1, 'assistant', '一條字幕'),
      mk(2, 'assistant', '<語音>ひとつめ</語音>'),
      mk(3, 'assistant', '<語音>ふたつめ</語音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 3)).toBe('');
  });

  it('雙語氣泡只取 %%BILINGUAL%% 前的半邊', () => {
    const msgs = [
      mk(1, 'assistant', '今天的中文字幕。\n%%BILINGUAL%%\ntranslated half'),
      mk(2, 'assistant', '<語音>今日の字幕だよ。</語音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('今天的中文字幕。');
  });

  it('emoji 氣泡跳過；純語音回合返回空串', () => {
    const msgs = [
      mk(1, 'assistant', 'https://emoji.example/a.png', 'emoji'),
      mk(2, 'assistant', '<語音>voice only</語音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('');
  });

  it('消息不存在 → 空串', () => {
    expect(collectVoiceBatchSubtitle([], 99)).toBe('');
  });
});

// 存量毒數據自檢：舊版本（無對齊校驗）把閒聊短句當翻譯持久化了，回灌時要認出來清掉
describe('isPoisonedVoiceSubtitle', () => {
  const mk = (id: number, role: 'user' | 'assistant', content: string, type: 'text' | 'emoji' = 'text') =>
    ({ id, role, type, content }) as any;
  const misfireBatch = [
    mk(1, 'assistant', '？？'),
    mk(2, 'assistant', '寶寶你六點半就醒了'),
    mk(3, 'assistant', '等我一下'),
    mk(4, 'assistant', '剛睜眼嗓子還是啞的'),
    mk(5, 'assistant', "<語音>Morning, baby. I just opened my eyes and... you weren't next to me. Anyway. Good morning. I love you. Come back to bed.</語音>"),
  ];

  it('存的值 == 舊邏輯產物 且 新校驗不認 → 毒數據', () => {
    const legacy = '？？\n寶寶你六點半就醒了\n等我一下\n剛睜眼嗓子還是啞的';
    expect(isPoisonedVoiceSubtitle(misfireBatch, 5, legacy)).toBe(true);
  });

  it('LLM 翻譯出來的正經譯文（≠ 舊邏輯產物）→ 不動', () => {
    expect(isPoisonedVoiceSubtitle(misfireBatch, 5, '早安寶貝，我剛睜眼你就不在身邊。總之早安，我愛你，回床上來。')).toBe(false);
  });

  it('對齊字幕的存量數據（新校驗也認可）→ 不動', () => {
    const alignedBatch = [
      mk(1, 'assistant', '別怕，我在這裡陪著你。'),
      mk(2, 'assistant', '閉上眼睛好好休息吧。'),
      mk(3, 'assistant', '<語音>怖がらないで、俺がここにいる。\n\n目を閉じてゆっくり休んで。</語音>'),
    ];
    expect(isPoisonedVoiceSubtitle(alignedBatch, 3, '別怕，我在這裡陪著你。\n閉上眼睛好好休息吧。')).toBe(false);
  });

  it('空翻譯 → 不動', () => {
    expect(isPoisonedVoiceSubtitle(misfireBatch, 5, '')).toBe(false);
  });
});
