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

describe('電話跟著聊天語言（plans/chat-language.md 第 4 批）', async () => {
    const { callLanguagePlan, ttsLangCode } = await import('./chatLanguage');
    it('有字幕語言：先字幕再 <語音>；段接回去仍是內建那串', () => {
        const plan = callLanguagePlan({ speak: 'English', mix: '繁體中文', translateTo: '繁體中文' })!;
        expect(plan.ttsCode).toBe('en');
        const { text, segments: s } = buildCallPromptParts('小星', '阿澈', 'CORE', undefined, 'voice', 'Asia/Taipei', plan);
        expect(s.voiceLang).toContain('你在電話裡說English；對方看的字幕是繁體中文');
        expect(s.voiceLang).toContain('夾雜繁體中文');
        expect(s.voiceLang).toContain('<語音>');
        const callPrompt = s.scene + s.talk + s.voiceActing + s.format;
        expect(['CORE', s.time, callPrompt, s.voiceLang].filter(Boolean).join('\n\n')).toBe(text);
    });
    it('沒設翻譯：直接說，不拆 <語音>', () => {
        const plan = callLanguagePlan({ speak: '日本語' })!;
        const { segments: s } = buildCallPromptParts('小星', '阿澈', 'CORE', undefined, 'voice', 'Asia/Taipei', plan);
        expect(s.voiceLang).toContain('你在電話裡說日本語');
        expect(s.voiceLang).not.toContain('<語音>');
    });
    it('通話另外指定語種時照舊，不吃聊天語言', () => {
        const plan = callLanguagePlan({ speak: 'English', translateTo: '繁體中文' })!;
        const { segments: s } = buildCallPromptParts('小星', '阿澈', 'CORE', 'ja', 'voice', 'Asia/Taipei', plan);
        expect(s.voiceLang).toContain('語音語種翻譯');
        expect(s.voiceLang).not.toContain('對方看的字幕');
    });
    it('沒設說話語言：沒有計畫；TTS 代碼對照', () => {
        expect(callLanguagePlan({ translateTo: '繁體中文' })).toBeUndefined();
        expect(ttsLangCode('粵語')).toBe('yue');
        expect(ttsLangCode('繁體中文')).toBe('');
        expect(ttsLangCode('Español')).toBe('');
    });
});
