import { describe, it, expect } from 'vitest';
import { buildCallPromptParts, CALL_STYLE_TALK } from './callPrompt';

// 電話提示詞拆段（plans/preset-library.md 第 3a 批）：段只是同一串字的切法。
// 改之前拿舊版 buildCallPrompt 做過 A/B（語音／視訊 × 語種翻譯 × 有無角色塊）一字不差。

describe('電話提示詞分段', () => {
    for (const mode of ['voice', 'video'] as const) for (const lang of [undefined, 'ja']) {
        it(`${mode}${lang ? `＋${lang}` : ''}：段接回去就是內建那串`, () => {
            const { text, segments: s } = buildCallPromptParts('小星', '阿澈', 'CORE', lang, mode, 'Asia/Taipei');
            const callPrompt = s.scene + s.talk + s.voiceActing + s.format;
            expect(['CORE', s.time, callPrompt, s.voiceLang].filter(Boolean).join('\n\n')).toBe(text);
            expect(s.scene.startsWith(mode === 'video' ? '你是阿澈，視頻通話的另一頭是小星。' : '你是阿澈，電話那頭是小星。')).toBe(true);
            expect(s.talk).toBe(CALL_STYLE_TALK);
            expect(s.voiceActing.startsWith('### 讓聲音有情緒')).toBe(true);
            expect(s.format.startsWith('### 歷史消息的來源標記')).toBe(true);
            expect(!!s.voiceLang).toBe(!!lang);
        });
    }
});
