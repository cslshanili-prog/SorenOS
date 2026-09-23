import { describe, it, expect } from 'vitest';
import { stripEmotionTags, cleanTextForTts, parseVoiceOutput, insertSpeechBreaks, cleanVoiceMarkupForDisplay } from './minimaxTts';

describe('stripEmotionTags', () => {
  it('removes [emotion] / 【emotion】 tags anywhere, leaves prose', () => {
    expect(stripEmotionTags('[angry] 你怎麼還不睡')).toBe(' 你怎麼還不睡');
    expect(stripEmotionTags('喂？【calm】快去睡覺')).toBe('喂？快去睡覺');
    expect(stripEmotionTags('開頭[happy]中間[sad]結尾')).toBe('開頭中間結尾');
  });
  it('does not touch non-emotion brackets', () => {
    expect(stripEmotionTags('[備註] 還在')).toBe('[備註] 還在');
  });
});

describe('cleanTextForTts', () => {
  it('strips emotion tags and Chinese stage cues, keeps whitelisted sound tags', () => {
    const out = cleanTextForTts('[angry] 說話呀笨蛋(sighs)（嘆氣）');
    expect(out).not.toMatch(/\[angry\]/);
    expect(out).not.toContain('（嘆氣）');
    expect(out).toContain('(sighs)');
  });
  it('uses <語音> content (with attribute) when present', () => {
    expect(cleanTextForTts('顯示文字<語音 emotion="happy">spoken (chuckle)</語音>')).toBe('spoken (chuckle)');
  });
});

describe('parseVoiceOutput', () => {
  it('extracts display, speech and a valid emotion attribute', () => {
    const r = parseVoiceOutput('外面的話<語音 emotion="sad">裡面的話</語音>');
    expect(r.hasVoiceTag).toBe(true);
    expect(r.display).toBe('外面的話');
    expect(r.speech).toBe('裡面的話');
    expect(r.emotion).toBe('sad');
  });
  it('drops an invalid emotion value', () => {
    expect(parseVoiceOutput('<語音 emotion="excited">嗨</語音>').emotion).toBeUndefined();
  });
  it('handles plain messages with no tag', () => {
    const r = parseVoiceOutput('就是一句話');
    expect(r.hasVoiceTag).toBe(false);
    expect(r.display).toBe('就是一句話');
  });

  // ─── 掉格式自愈 (normalizeVoiceTags 集成) ───
  it('salvages an unclosed <語音> tag (model forgot the close)', () => {
    const r = parseVoiceOutput('外面的話\n<語音 emotion="calm">うん、そのままでいい。');
    expect(r.hasVoiceTag).toBe(true);
    expect(r.display).toBe('外面的話');
    expect(r.speech).toBe('うん、そのままでいい。');
    expect(r.emotion).toBe('calm');
  });
  it('tolerates missing space before emotion attribute', () => {
    const r = parseVoiceOutput('<語音emotion="happy">hi there</語音>');
    expect(r.hasVoiceTag).toBe(true);
    expect(r.speech).toBe('hi there');
    expect(r.emotion).toBe('happy');
  });
  it('tolerates full-width quotes in the emotion attribute', () => {
    const r = parseVoiceOutput('<語音 emotion=“sad”>ごめんね</語音>');
    expect(r.hasVoiceTag).toBe(true);
    expect(r.emotion).toBe('sad');
    expect(r.speech).toBe('ごめんね');
  });
  it('tolerates spaced / cross-variant closing tags', () => {
    expect(parseVoiceOutput('<語音>你好</ 語音 >').speech).toBe('你好');
    expect(parseVoiceOutput('<語音>你好</語音>').speech).toBe('你好');
  });
  it('tolerates full-width angle brackets', () => {
    const r = parseVoiceOutput('＜語音 emotion="calm"＞落ち著いて＜/語音＞');
    expect(r.hasVoiceTag).toBe(true);
    expect(r.speech).toBe('落ち著いて');
    expect(r.emotion).toBe('calm');
  });
  it('strips an orphan closing tag instead of leaking it', () => {
    const r = parseVoiceOutput('前半句話</語音>後半句話');
    expect(r.hasVoiceTag).toBe(false);
    expect(r.display).toBe('前半句話後半句話');
  });

  // ─── <字幕> 顯式翻譯標籤 ───
  it('extracts <字幕> as subtitle; display excludes both tags', () => {
    const r = parseVoiceOutput('隨口聊一句\n<語音 emotion="calm">Take a rest, okay?</語音>\n<字幕>好好休息，好嗎？</字幕>');
    expect(r.hasVoiceTag).toBe(true);
    expect(r.subtitle).toBe('好好休息，好嗎？');
    expect(r.speech).toBe('Take a rest, okay?');
    expect(r.display).toBe('隨口聊一句');
    expect(r.emotion).toBe('calm');
  });
  it('subtitle absent → undefined (老格式兼容)', () => {
    expect(parseVoiceOutput('<語音>hi</語音>').subtitle).toBeUndefined();
  });
  it('unclosed voice followed by subtitle → subtitle not swallowed into speech', () => {
    const r = parseVoiceOutput('<語音>Take a rest.\n<字幕>好好休息。</字幕>');
    expect(r.speech).toBe('Take a rest.');
    expect(r.subtitle).toBe('好好休息。');
  });
  it('cleanTextForTts never reads subtitle aloud', () => {
    expect(cleanTextForTts('<語音>spoken</語音><字幕>字幕文字</字幕>')).toBe('spoken');
    expect(cleanTextForTts('沒有語音標籤<字幕>字幕文字</字幕>')).toBe('沒有語音標籤');
  });
});

describe('cleanVoiceMarkupForDisplay', () => {
  it('strips <#x#> pause markers and whitelisted action tags for display', () => {
    const out = cleanVoiceMarkupForDisplay('(sighs) 唉，<#0.4#> 真是的。<#0.5#> (chuckle) 算了。');
    expect(out).not.toContain('<#');
    expect(out).not.toContain('(sighs)');
    expect(out).not.toContain('(chuckle)');
    expect(out).toContain('唉');
    expect(out).toContain('算了');
  });
  it('leaves non-whitelisted parentheses untouched', () => {
    expect(cleanVoiceMarkupForDisplay('備註(2026) 還在')).toBe('備註(2026) 還在');
  });
  it('handles empty / undefined input', () => {
    expect(cleanVoiceMarkupForDisplay('')).toBe('');
    expect(cleanVoiceMarkupForDisplay(undefined)).toBe('');
  });
});

describe('insertSpeechBreaks', () => {
  it('caps pause length at 0.6s and inserts pause markers', () => {
    const out = insertSpeechBreaks('真的嗎……好吧。');
    expect(out).toMatch(/<#0\.\d+#>/);
    const maxPause = Math.max(...[...out.matchAll(/<#([\d.]+)#>/g)].map(m => parseFloat(m[1])));
    expect(maxPause).toBeLessThanOrEqual(0.6);
  });
});
