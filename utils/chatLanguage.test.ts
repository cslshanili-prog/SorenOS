import { describe, expect, it } from 'vitest';
import { buildChatLanguagePrompt, cleanChatLanguage, languageLabel, legacyChatLanguage, normalizeLanguage, resolveChatLanguage } from './chatLanguage';

describe('resolveChatLanguage', () => {
    it('沒設任何東西：不翻、沒有語言段', () => {
        const r = resolveChatLanguage(undefined);
        expect(r.translating).toBe(false);
        expect(buildChatLanguagePrompt(r)).toBe('');
    });

    it('翻譯成跟說話語言一樣、又沒夾雜：不翻', () => {
        expect(resolveChatLanguage({ speak: 'English', translateTo: 'English' }).translating).toBe(false);
    });

    it('有夾雜時就算翻譯成跟說話語言一樣也要翻（夾雜的部分看不懂）', () => {
        expect(resolveChatLanguage({ speak: '繁體中文', mix: 'English', translateTo: '繁體中文' }).translating).toBe(true);
    });

    it('夾雜跟說話語言一樣當作沒夾雜；比例預設自然混用', () => {
        const r = resolveChatLanguage({ speak: 'English', mix: 'English' });
        expect(r.mix).toBeUndefined();
        expect(resolveChatLanguage({ speak: 'English', mix: '日本語' }).mixLevel).toBe('natural');
    });

    it('舊的「中文」當繁中', () => {
        expect(normalizeLanguage('中文')).toBe('繁體中文');
        expect(languageLabel('繁體中文')).toBe('繁中');
        expect(languageLabel('Español')).toBe('Español');
    });
});

describe('buildChatLanguagePrompt', () => {
    it('只設說話語言：只有語言段，沒有雙語標籤', () => {
        const p = buildChatLanguagePrompt(resolveChatLanguage({ speak: 'English' }));
        expect(p).toContain('你說話用English');
        expect(p).not.toContain('<翻譯>');
    });

    it('夾雜：寫出比例和自然混用的規矩', () => {
        const p = buildChatLanguagePrompt(resolveChatLanguage({ speak: 'English', mix: '繁體中文', mixLevel: 'light' }));
        expect(p).toContain('主要用English，至少九成');
        expect(p).toContain('夾雜繁體中文：偶爾冒出幾個詞或短句');
        expect(p).toContain('不要一句一句輪流換');
    });

    it('翻譯：雙語標籤的原文是說話語言（加夾雜），譯文整句翻', () => {
        const p = buildChatLanguagePrompt(resolveChatLanguage({ speak: '日本語', mix: 'English', translateTo: '繁體中文' }));
        expect(p).toContain('<原文>日本語（照上面的比例夾雜English）內容</原文>');
        expect(p).toContain('<譯文>繁體中文內容</譯文>');
        expect(p).toContain('原文裡夾雜的English也要翻');
    });

    it('粵語提醒寫口語', () => {
        expect(buildChatLanguagePrompt(resolveChatLanguage({ speak: '粵語' }))).toContain('廣東話口語');
    });

    it('SAR 生效時改成 SAR 容器的說法', () => {
        const p = buildChatLanguagePrompt(resolveChatLanguage({ speak: '日本語', translateTo: '繁體中文' }), { sarEnvelopeActive: true });
        expect(p).toContain('最外層必須是 <SAR_MODULE_OUTPUT>');
    });
});

describe('cleanChatLanguage', () => {
    it('全空不寫；比例只在有夾雜、而且不是預設時才存；展開只在有翻譯時存', () => {
        expect(cleanChatLanguage({})).toBeUndefined();
        expect(cleanChatLanguage({ speak: 'English', mixLevel: 'half', expanded: true })).toEqual({ speak: 'English' });
        expect(cleanChatLanguage({ speak: 'English', mix: '日本語', mixLevel: 'half', translateTo: '繁體中文', expanded: true }))
            .toEqual({ speak: 'English', mix: '日本語', mixLevel: 'half', translateTo: '繁體中文', expanded: true });
    });
});

describe('legacyChatLanguage', () => {
    const store = (o: Record<string, string>) => (k: string) => (k in o ? o[k] : null);

    it('只搬開著的；選→說話語言、譯→翻譯成（中文→繁中）、展開照搬', () => {
        expect(legacyChatLanguage('c1', store({ 'chat_translate_source_lang_c1': 'English' }))).toBeUndefined();
        expect(legacyChatLanguage('c1', store({
            'chat_translate_enabled_c1': 'true',
            'chat_translate_source_lang_c1': 'English',
            'chat_translate_lang_c1': '中文',
            'chat_translate_expanded_c1': 'true',
        }))).toEqual({ speak: 'English', translateTo: '繁體中文', expanded: true });
    });

    it('沒有角色自己的值時讀舊的全域鍵，再沒有就用舊預設（日本語→中文）', () => {
        expect(legacyChatLanguage('c1', store({ 'chat_translate_enabled_c1': 'true', 'chat_translate_lang': 'English' })))
            .toEqual({ speak: '日本語', translateTo: 'English' });
        expect(legacyChatLanguage('c1', store({ 'chat_translate_enabled_c1': 'true' })))
            .toEqual({ speak: '日本語', translateTo: '繁體中文' });
    });
});

describe('统计：聊天语言用到哪一层', async () => {
    const { chatLanguageUsage } = await import('./analyticsSnapshot');
    const ch = (chatLanguage?: object) => ({ id: 'x', name: 'x', chatLanguage } as any);
    it('取全部角色里最深的那層', () => {
        expect(chatLanguageUsage([ch()])).toBe('没设');
        expect(chatLanguageUsage([ch(), ch({ speak: 'English' })])).toBe('指定语言');
        expect(chatLanguageUsage([ch({ speak: 'English', mix: '日本語' })])).toBe('夹杂');
        expect(chatLanguageUsage([ch({ speak: 'English', translateTo: '繁體中文' })])).toBe('翻译');
        expect(chatLanguageUsage([ch({ speak: 'English', mix: '日本語' }), ch({ speak: 'English', translateTo: '繁體中文' })])).toBe('翻译+夹杂');
    });
});

describe('誰來翻與我的訊息自動譯出', () => {
    it('先寫再翻：不帶雙語標籤，只有語言段', () => {
        const r = resolveChatLanguage({ speak: 'English', translateTo: '繁體中文', translator: 'api' });
        expect(r.postTranslate).toBe(true);
        expect(r.inlineTranslate).toBe(false);
        const p = buildChatLanguagePrompt(r);
        expect(p).toContain('你說話用English');
        expect(p).not.toContain('<翻譯>');
    });

    it('我的訊息自動譯出要有說話語言才算數；沒翻譯時不存 translator', () => {
        expect(resolveChatLanguage({ translateMine: true }).translateMine).toBe(false);
        expect(resolveChatLanguage({ speak: 'English', translateMine: true }).translateMine).toBe(true);
        expect(cleanChatLanguage({ speak: 'English', translator: 'api', translateMine: true })).toEqual({ speak: 'English', translateMine: true });
    });
});

describe('雲端', async () => {
    const { chatLanguageForCloud, buildSpeakingRulesPrompt } = await import('./chatLanguage');
    it('有翻譯就改成先寫再翻（不帶標籤）；沒翻譯原樣', () => {
        expect(chatLanguageForCloud({ speak: 'English', translateTo: '繁體中文' })).toMatchObject({ translator: 'api' });
        expect(chatLanguageForCloud({ speak: 'English' })).toEqual({ speak: 'English' });
        expect(chatLanguageForCloud(undefined)).toBeUndefined();
    });
    it('fire_pack 只帶說話語言與夾雜', () => {
        const p = buildSpeakingRulesPrompt(resolveChatLanguage({ speak: 'English', mix: '日本語', translateTo: '繁體中文' }));
        expect(p.startsWith('[語言設定]')).toBe(true);
        expect(p).toContain('夾雜日本語');
        expect(p).not.toContain('<翻譯>');
    });
});

describe('見面與群聊（第 4 批）', async () => {
    const { buildDateLanguageRule, splitBilingual } = await import('./chatLanguage');
    const { messageLogText } = await import('./groupChat/format');
    it('見面：台詞用說話語言、括號附譯文、旁白用你讀的語言', () => {
        const rule = buildDateLanguageRule({ speak: 'English', mix: '繁體中文', translateTo: '繁體中文' });
        expect(rule).toContain('台詞（引號裡的話）用English');
        expect(rule).toContain('全形括號附上繁體中文翻譯');
        expect(rule).toContain('旁白、動作、心理描寫用繁體中文寫');
        expect(rule).toContain('夾雜繁體中文');
    });
    it('見面：沒翻譯就不附括號；沒說話語言就整段沒有', () => {
        const rule = buildDateLanguageRule({ speak: '日本語' });
        expect(rule).not.toContain('括號');
        expect(rule).toContain('照你平常寫故事的語言');
        expect(buildDateLanguageRule({ translateTo: '繁體中文' })).toBe('');
    });
    it('群聊歷史：雙語訊息給成員只看原文', () => {
        expect(splitBilingual('Hey\n%%BILINGUAL%%\n嘿')).toEqual({ original: 'Hey', translated: '嘿' });
        expect(splitBilingual('普通訊息')).toBeNull();
        expect(messageLogText({ type: 'text', content: 'Hey\n%%BILINGUAL%%\n嘿' } as any)).toBe('Hey');
    });
});
