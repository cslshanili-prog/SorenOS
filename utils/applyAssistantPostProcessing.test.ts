import { describe, it, expect, vi } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, splitSARChatSurfaceBubbles, XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';
import { createSARModuleSurfaceMeta, getSARModuleRuntimePlan, installSARModuleOnCharacter, parseSARModuleReply } from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';
import { sarStickerCanonical, sarStickerRawReply, sarStickerSurface } from '../test/fixtures/sar-module-sticker-reply';

// 鎖住 renderAndPersist normal path 的引用順延修復:
// 模型把 [[QUOTE:]] 單獨寫一行 (典型形態: 標籤後緊跟 [[SEND_EMOJI:]] / 換行 + 正文),
// chunkText 按換行拆分後引用標籤獨佔一個 chunk — 剝標籤後沒有正文不落庫,
// 修復前解析出的引用目標隨這個空 chunk 一起被丟棄, 表現為"引用被後處理吞掉"。
// 修復後引用目標順延掛到下一條真正落庫的文字氣泡。

const makeCtx = (charId: string, contextMsgs: any[], emojis: any[] = []): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char: { id: charId, name: '測試角色' } as any,
        userProfile: { name: '我' } as any,
        emojis,
        contextMsgs,
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: {
            setMessages: vi.fn(),
            addToast: vi.fn(),
        },
    };
};

const quotedUserMsg = {
    id: 101,
    charId: 'c-quote',
    role: 'user' as const,
    type: 'text' as const,
    content: '引用我說的話，還有後面一長串內容',
    timestamp: Date.now() - 1000,
};

describe('renderAndPersist 引用解析', () => {
    it('[[QUOTE:]] 單獨成行 (後跟 SEND_EMOJI + 正文) 時引用順延到第一條文字氣泡', async () => {
        const charId = `c-quote-${Date.now()}`;
        const raw = '[[QUOTE: 引用我說的話]]\n[[SEND_EMOJI: 有點生氣]]\n消失了整整三十六個小時';

        // 表情要真存在，否則走的是「名字對不上落降級文本氣泡」那條路，
        // 第一條 text 會變成降級氣泡，驗不到這裡要驗的「引用順延到正文」。
        await applyAssistantPostProcessing(raw, makeCtx(
            charId,
            [{ ...quotedUserMsg, charId }],
            [{ name: '有點生氣', url: 'blob:emoji-angry' }],
        ));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('消失了整整三十六個小時');
        // 修復前: replyTo 為 undefined (引用目標隨空 chunk 丟失)
        expect(texts[0].replyTo).toBeTruthy();
        expect(texts[0].replyTo!.id).toBe(101);
        expect(texts[0].replyTo!.name).toBe('我');
    }, 20000);

    it('[[QUOTE:]] 與正文同一行時引用仍掛在該氣泡 (既有行為不迴歸)', async () => {
        const charId = `c-quote-inline-${Date.now()}`;
        const raw = '[[QUOTE: 引用我說的話]]你幹嘛去了';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('你幹嘛去了');
        expect(texts[0].replyTo?.id).toBe(101);
    }, 20000);

    it('引用只掛一次: 順延目標落到首條氣泡後, 後續氣泡不帶 replyTo', async () => {
        const charId = `c-quote-once-${Date.now()}`;
        const raw = '[[QUOTE: 引用我說的話]]\n第一句話\n第二句話';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.map(m => m.content)).toEqual(['第一句話', '第二句話']);
        expect(texts[0].replyTo?.id).toBe(101);
        expect(texts[1].replyTo).toBeFalsy();
    }, 20000);
});

// 歷史裡引用消息被 buildMessageHistory 渲染成 [xx引用了xx說的「…」，並回復了 ↓]，
// 模型會模仿這個渲染格式而不是規範的 [[QUOTE:]]。修復前這種輸出既不被識別成引用、
// 整段方括號還會原樣漏進氣泡；修復後認作合法引用並剝乾淨。
describe('renderAndPersist 模仿歷史渲染格式的引用兜底', () => {
    it('[我引用了你說的「…」，並回復了 ↓] 單獨成行時解析為引用並順延到正文氣泡', async () => {
        const charId = `c-nlquote-${Date.now()}`;
        const raw = '[我引用了你說的「引用我說的話」，並回復了 ↓]\n你幹嘛去了';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('你幹嘛去了');
        expect(texts[0].replyTo?.id).toBe(101);
        expect(texts[0].replyTo!.name).toBe('我');
    }, 20000);

    it('引用摘要帶截斷省略號時仍能匹配到原消息', async () => {
        const charId = `c-nlquote-ellipsis-${Date.now()}`;
        const raw = '[用戶引用了你之前說的「引用我說的話，還有後面一長…」，並回復了 ↓]\n哈哈這個';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('哈哈這個');
        expect(texts[0].replyTo?.id).toBe(101);
    }, 20000);

    it('與正文同一行時引用掛在該氣泡且方括號頭不漏進正文', async () => {
        const charId = `c-nlquote-inline-${Date.now()}`;
        const raw = '[你引用了對方說的「引用我說的話」，並回復了 ↓] 這就解釋';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('這就解釋');
        expect(texts[0].content).not.toContain('引用了');
        expect(texts[0].replyTo?.id).toBe(101);
    }, 20000);

    it('正常含方括號但非引用格式的句子不被誤剝', async () => {
        const charId = `c-nlquote-fp-${Date.now()}`;
        const raw = '我看了[那本書]感覺一般';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('我看了[那本書]感覺一般');
        expect(texts[0].replyTo).toBeFalsy();
    }, 20000);
});

// 鎖住雙語（翻譯模式）分支的表情包位置修復:
// 舊實現把所有 [[SEND_EMOJI:]] 先抽出、正文發完後統一追加在最後（且去重），
// 表現為"翻譯模式下角色永遠最後才發表情包"。修復後表情包按模型寫的位置原地插發。
describe('renderAndPersist 雙語分支表情包順序', () => {
    const testEmojis = [
        { id: 1, name: '開心', url: 'https://example.com/happy.png' },
        { id: 2, name: '疑惑', url: 'https://example.com/confused.png' },
    ] as any[];

    const makeBiCtx = (charId: string): PostProcessCtx => {
        const ctx = makeCtx(charId, []);
        ctx.emojis = testEmojis as any;
        ctx.instantRender = true;
        return ctx;
    };

    it('表情包按出現位置插發，不再統一挪到最後', async () => {
        const charId = `c-bi-emoji-${Date.now()}`;
        const raw = [
            '[[SEND_EMOJI: 開心]]',
            '<翻譯><原文>Hello there</原文><譯文>你好呀</譯文></翻譯>',
            '[[SEND_EMOJI: 疑惑]]',
            '<翻譯><原文>What happened</原文><譯文>發生什麼了</譯文></翻譯>',
        ].join('\n');

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['emoji', 'text', 'emoji', 'text']);
        expect(msgs[0].content).toBe('https://example.com/happy.png');
        expect(msgs[1].content).toBe('Hello there\n%%BILINGUAL%%\n你好呀');
        expect(msgs[2].content).toBe('https://example.com/confused.png');
        expect(msgs[3].content).toBe('What happened\n%%BILINGUAL%%\n發生什麼了');
    }, 20000);

    it('同一個表情包出現兩次時不去重，兩次都發', async () => {
        const charId = `c-bi-emoji-dup-${Date.now()}`;
        const raw = [
            '[[SEND_EMOJI: 開心]]',
            '<翻譯><原文>Nice</原文><譯文>好耶</譯文></翻譯>',
            '[[SEND_EMOJI: 開心]]',
        ].join('\n');

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['emoji', 'text', 'emoji']);
    }, 20000);

    it('混進 <原文>/<譯文> 裡的表情標籤剝出來緊跟該雙語氣泡發送', async () => {
        const charId = `c-bi-emoji-inline-${Date.now()}`;
        const raw = '<翻譯><原文>See you [[SEND_EMOJI: 開心]]</原文><譯文>回見</譯文></翻譯>\n尾巴一句';

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['text', 'emoji', 'text']);
        expect(msgs[0].content).toBe('See you\n%%BILINGUAL%%\n回見');
        expect(msgs[2].content).toBe('尾巴一句');
    }, 20000);

    it('表情包在最後時仍最後發（既有行為不迴歸）', async () => {
        const charId = `c-bi-emoji-tail-${Date.now()}`;
        const raw = '<翻譯><原文>Bye</原文><譯文>拜拜</譯文></翻譯>\n[[SEND_EMOJI: 疑惑]]';

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['text', 'emoji']);
    }, 20000);
});

describe('SAR Chat 特殊格式氣泡對齊', () => {
    const surfaceCtx = (charId: string, surface: string, emojis: any[] = [{ name: '咬你', url: 'blob:qa-bite' }]) => {
        const ctx = makeCtx(charId, [], emojis);
        ctx.instantRender = true;
        const runtime = installSARModuleOnCharacter(SAR_MODULE_CATALOG[0], 1);
        ctx.sarModuleSurface = createSARModuleSurfaceMeta(runtime, surface);
        return ctx;
    };

    it('復現原始模塊信封：表情保持第九泡，最後兩句外顯與真言均完整對齊', async () => {
        const charId = 'sar-reported-sticker';
        const runtime = installSARModuleOnCharacter(SAR_MODULE_CATALOG[0], 1);
        const char = { id: charId, name: '測試角色', vrState: { enabled: true, sarModule: runtime } } as any;
        const parsed = parseSARModuleReply(sarStickerRawReply, getSARModuleRuntimePlan(char, { name: '我' } as any));
        expect(parsed.enveloped).toBe(true);
        const ctx = surfaceCtx(charId, parsed.assistantSurface!);
        ctx.char = char;
        await applyAssistantPostProcessing(parsed.canonical, ctx);
        const messages = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(messages.map(m => m.type)).toEqual(sarStickerCanonical.map((_, index) => index === 8 ? 'emoji' : 'text'));
        expect(messages.map(m => m.content)).toEqual(sarStickerCanonical.map((text, index) => index === 8 ? 'blob:qa-bite' : text));
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual(sarStickerSurface.map((text, index) => index === 1 || index === 8 ? undefined : text));
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface || m.content)).toEqual(sarStickerSurface.map((text, index) => index === 8 ? 'blob:qa-bite' : text));
    });

    it.each([
        '[[SEND_EMOJI: 咬你]]', '[SEND_EMOJI: 咬你]', '[表情：咬你]',
        '[表情包: 咬你]', '[你 發送了表情包: 咬你]', '',
    ])('SAR 外顯表情寫成 %s 或省略時不搶後一句的位置', async marker => {
        const charId = `sar-sticker-format-${marker || 'omitted'}`;
        const ctx = surfaceCtx(charId, ['別再笑啦。', marker, '快幫我解除。'].join('\n'));
        await applyAssistantPostProcessing('別笑了。\n[[SEND_EMOJI: 咬你]]\n快卸載。', ctx);
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        expect(messages.map(m => m.type)).toEqual(['text', 'emoji', 'text']);
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual(['別再笑啦。', undefined, '快幫我解除。']);
    });

    it.each(['[[SEND_EMOJI：咬你]]', '[[send_emoji: 咬你]]', '[凱恩 發送了表情包：咬你]'])('SAR 兩側同用變體 %s 時也發真實表情並保留尾句', async marker => {
        const charId = `sar-sticker-both-${marker}`;
        await applyAssistantPostProcessing(`前句。\n${marker}\n末句。`, surfaceCtx(charId, `前言。\n${marker}\n末言。`));
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        expect(messages.map(m => m.type)).toEqual(['text', 'emoji', 'text']);
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual(['前言。', undefined, '末言。']);
    });

    it('SAR 表情找不到時只降級原文表情，外顯不重複發送或執行命令', async () => {
        const charId = 'sar-sticker-missing';
        const ctx = surfaceCtx(charId, '[[ACTION:TRANSFER|520]]\n前言。\n[表情：咬你]\n[表情：外顯獨有]\n末言。', []);
        await applyAssistantPostProcessing('前句。\n[[SEND_EMOJI: 咬你]]\n末句。', ctx);
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        expect(messages.map(m => m.content)).toEqual(['前句。', '[表情：咬你]', '末句。']);
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual(['前言。', undefined, '末言。']);
    });

    it('SAR 雙語與語音之間的歷史表情不拆原子氣泡或截掉語音後的末句', async () => {
        const charId = 'sar-sticker-mixed';
        const canonical = '<翻譯><原文>Stop.</原文><譯文>別鬧。</譯文></翻譯>\n[你 發送了表情包: 咬你]\n<語音>Enough.</語音><字幕>夠了。</字幕>\n結束了。';
        const surface = '<翻譯><原文>Cease.</原文><譯文>住手。</譯文></翻譯>\n[你 發送了表情包: 咬你]\n<語音>No more.</語音><字幕>到此為止。</字幕>\n終了。';
        await applyAssistantPostProcessing(canonical, surfaceCtx(charId, surface));
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        expect(messages.map(m => m.type)).toEqual(['text', 'emoji', 'text', 'text']);
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual([
            'Cease.\n%%BILINGUAL%%\n住手。', undefined,
            '<語音>No more.</語音><字幕>到此為止。</字幕>', '終了。',
        ]);
    });

    it.each([true, false])('SAR HTML 卡片開關為 %s 時卡片不佔用台詞外顯序號', async htmlModeEnabled => {
        const charId = `sar-html-${htmlModeEnabled}`;
        const ctx = surfaceCtx(charId, '前言。\n[html]<div>外顯卡片\n<span>內容</span></div>[/html]\n末言。');
        ctx.char.htmlModeEnabled = htmlModeEnabled;
        await applyAssistantPostProcessing('前句。\n[html]<div>真實卡片</div>[/html]\n末句。', ctx);
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        const texts = messages.filter(m => m.type === 'text' && m.content !== '[HTML 卡片]');
        expect(texts.map(m => m.content)).toEqual(['前句。', '末句。']);
        expect(texts.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual(['前言。', '末言。']);
        const cards = messages.filter(m => m.type === 'html_card' || m.content === '[HTML 卡片]');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.sarModuleSurface).toBeUndefined();
        expect(cards[0].metadata?.htmlSource || cards[0].content).not.toContain('外顯卡片');
    });

    it('SAR 複製歷史分享卡片時只保存原文卡片，外顯正文不會串位', async () => {
        const charId = 'sar-history-share';
        const card = '[你分享了小紅書筆記]\n標題: 測試筆記\n作者: 測試作者\n互動: 1贊 0收藏\n簡介: 簡單記錄';
        const ctx = surfaceCtx(charId, `前言。\n${card}\n末言。`);
        ctx.skipSecondPassLLM = true;
        await applyAssistantPostProcessing(`前句。\n${card}\n末句。`, ctx);
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        expect(messages.filter(m => m.type === 'xhs_card')).toHaveLength(1);
        expect(messages.filter(m => m.type === 'text').map(m => m.metadata?.sarModuleSurface?.surface)).toEqual(['前言。', '末言。']);
    });

    it('SAR 外顯中的內聯控制標籤只剝除，既不漏出也不執行', async () => {
        const charId = 'sar-inline-controls';
        const ctx = surfaceCtx(charId, '[[LIFE:MED|測試藥物]]前言。\n[[XHS_SHARE:不存在的筆記]]末言。');
        await applyAssistantPostProcessing('前句。\n末句。', ctx);
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        expect(messages.map(m => m.type)).toEqual(['text', 'text']);
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual(['前言。', '末言。']);
    });

    it('SAR 引用獨佔一行、動作省略及連續表情不會吞掉後續台詞', async () => {
        const charId = 'sar-quote-action-stickers';
        const ctx = surfaceCtx(charId, '<think>這一段不應顯示</think>\n[[QUOTE: 引用我說的話]]\n前言。\n[表情：咬你]\n[你 發送了表情包: 咬你]\n末言。');
        ctx.contextMsgs = [{ ...quotedUserMsg, charId }];
        await applyAssistantPostProcessing('[[QUOTE: 引用我說的話]]\n（看著你。）\n前句。\n[[SEND_EMOJI: 咬你]]\n[[SEND_EMOJI: 咬你]]\n末句。', ctx);
        const messages = (await DB.getRecentMessagesByCharId(charId, 20)).filter(m => m.role === 'assistant');
        expect(messages.map(m => m.type)).toEqual(['text', 'text', 'emoji', 'emoji', 'text']);
        expect(messages.map(m => m.metadata?.sarModuleSurface?.surface)).toEqual([undefined, '前言。', undefined, undefined, '末言。']);
        expect(messages[0].replyTo?.id).toBe(quotedUserMsg.id);
    });

    it('把內置翻譯塊還原成最終落庫的一條雙語氣泡', () => {
        const raw = [
            '<翻譯><原文>もう知らない。</原文><譯文>不管你了。</譯文></翻譯>',
            '<翻譯><原文>勝手にして。</原文><譯文>隨你便。</譯文></翻譯>',
        ].join('\n');
        expect(splitSARChatSurfaceBubbles(raw)).toEqual([
            'もう知らない。\n%%BILINGUAL%%\n不管你了。',
            '勝手にして。\n%%BILINGUAL%%\n隨你便。',
        ]);
    });

    it('把語音與字幕保持為一個原子氣泡，也不拆同泡括號翻譯', () => {
        const raw = [
            '<語音 emotion="angry">Enough.\nDo not do that again.</語音><字幕>夠了。別再這樣。</字幕>',
            'もう知らない。（不管你了。）',
        ].join('\n');
        const chunks = splitSARChatSurfaceBubbles(raw);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toContain('<語音 emotion="angry">');
        expect(chunks[0]).toContain('<字幕>夠了。別再這樣。</字幕>');
        expect(chunks[1]).toBe('もう知らない。（不管你了。）');
    });

    it('雙語 canonical 與雙語 surface 按整泡寫入 metadata，不按 XML 換行串位', async () => {
        const charId = `c-sar-bi-${Date.now()}`;
        const canonical = [
            '<翻譯><原文>I did not mean that.</原文><譯文>我不是那個意思。</譯文></翻譯>',
            '<翻譯><原文>Stop laughing.</原文><譯文>別笑了。</譯文></翻譯>',
        ].join('\n');
        const surface = [
            '<翻譯><原文>Pray, mistake me not.</原文><譯文>還請閣下莫要誤會。</譯文></翻譯>',
            '<翻譯><原文>Cease thy laughter.</原文><譯文>休要再笑。</譯文></翻譯>',
        ].join('\n');
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;
        ctx.sarModuleSurface = {
            version: 1,
            runId: 'sar-test',
            moduleId: 'court',
            moduleTitle: '王庭貴族協議',
            target: 'character',
            phase: 'active',
            surface,
            canonicalField: 'content',
            surfaceField: 'metadata.sarModuleSurface.surface',
        };

        await applyAssistantPostProcessing(canonical, ctx);

        const texts = (await DB.getRecentMessagesByCharId(charId, 20))
            .filter(message => message.role === 'assistant' && message.type === 'text');
        expect(texts.map(message => message.content)).toEqual([
            'I did not mean that.\n%%BILINGUAL%%\n我不是那個意思。',
            'Stop laughing.\n%%BILINGUAL%%\n別笑了。',
        ]);
        expect(texts.map(message => message.metadata?.sarModuleSurface?.surface)).toEqual([
            'Pray, mistake me not.\n%%BILINGUAL%%\n還請閣下莫要誤會。',
            'Cease thy laughter.\n%%BILINGUAL%%\n休要再笑。',
        ]);
    }, 20000);
});

// 迴歸守衛：ctx.messageTimestamp 要一路透傳到每條 DB.saveMessage。
// 修復前 15 處落庫都不傳 timestamp、一律取寫庫當刻——主動消息離線補收時昨晚的消息
// 顯示成今天中午。修復後調用方（activeMsgRuntime）可以把 worker 發送時刻傳進來，
// 同一輪拆出的多條氣泡（文字 / 表情）共用同一個時間戳。
describe('messageTimestamp 落庫時間戳透傳', () => {
    const testEmojis = [
        { id: 1, name: '開心', url: 'https://example.com/happy.png' },
    ] as any[];

    it('傳了 messageTimestamp → 文字與表情多條氣泡全部落這個時間戳', async () => {
        const charId = `c-msgts-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.emojis = testEmojis as any;
        ctx.instantRender = true;
        const sentAt = Date.now() - 13 * 3_600_000; // 昨晚發的，今天才補收
        ctx.messageTimestamp = sentAt;
        const raw = '昨晚看到流星了\n[[SEND_EMOJI: 開心]]\n你猜我許了什麼願';

        await applyAssistantPostProcessing(raw, ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['text', 'emoji', 'text']);
        // 修復前這裡掛：timestamp 是寫庫當刻（≈ 現在），不是傳入的 sentAt
        for (const m of msgs) expect(m.timestamp).toBe(sentAt);
    }, 20000);

    it('不傳 messageTimestamp → 維持默認寫庫當刻（既有行為不迴歸）', async () => {
        const charId = `c-msgts-default-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;
        const before = Date.now();

        await applyAssistantPostProcessing('剛想起來跟你說個事', ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.length).toBeGreaterThan(0);
        for (const m of msgs) expect(m.timestamp).toBeGreaterThanOrEqual(before);
    }, 20000);
});

describe('renderAndPersist XHS mimicked-card fallback', () => {
    it('restores the five-line history format as xhs_card and preserves surrounding text', async () => {
        const charId = `c-xhs-mimic-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        const title = '\u5ba0\u7269\u6c34\u6bcd\u53ef\u4ee5\u6478\u5417\uff1f';
        const author = '\u6eba\u6c34\u6d77\u8707\u76ae';
        ctx.instantRender = true;
        ctx.lastXhsNotesRef = {
            current: [{
                noteId: 'note-jellyfish',
                title,
                desc: '\u7f13\u5b58\u91cc\u7684\u5b8c\u6574\u7b80\u4ecb',
                likes: 2156,
                collects: 488,
                commentCount: 55,
                shareCount: 175,
                author,
                authorId: 'author-1',
                xsecToken: 'token-1',
                coverUrl: 'https://example.test/jellyfish.jpg',
            }],
        };
        const raw = [
            '\u8fd9\u4e2a\u8fd8\u633a\u6709\u610f\u601d',
            '[\u4f60\u5206\u4eab\u4e86\u5c0f\u7ea2\u4e66\u7b14\u8bb0]',
            `\u6807\u9898: ${title}`,
            `\u4f5c\u8005: ${author}`,
            '\u4e92\u52a8: 2156\u8d5e 488\u6536\u85cf 55\u8bc4\u8bba 175\u5206\u4eab',
            '\u7b80\u4ecb: \u4eba\u5de5\u7e41\u6b96\u7684\u5ba0\u7269\u6c34\u6bcd\u5927\u90e8\u5206\u65e0\u6bd2',
            '\u4f60\u770b\u8fd9\u53ea\u662f\u4e0d\u662f\u5f88\u79bb\u8c31',
        ].join('\n');

        await applyAssistantPostProcessing(raw, ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'xhs_card');
        const text = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.xhsNote).toMatchObject({
            noteId: 'note-jellyfish',
            title,
            author,
            xsecToken: 'token-1',
            coverUrl: 'https://example.test/jellyfish.jpg',
        });
        expect(text).toContain('\u8fd9\u4e2a\u8fd8\u633a\u6709\u610f\u601d');
        expect(text).toContain('\u4f60\u770b\u8fd9\u53ea\u662f\u4e0d\u662f\u5f88\u79bb\u8c31');
        expect(text).not.toContain('\u4f60\u5206\u4eab\u4e86\u5c0f\u7ea2\u4e66\u7b14\u8bb0');
        expect(text).not.toContain('\u6807\u9898:');
        expect(text).not.toContain('\u4e92\u52a8:');
    }, 20000);

    it('recovers consecutive cards when the next marker is glued to the previous description', async () => {
        const charId = `c-xhs-mimic-glued-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;
        ctx.lastXhsNotesRef = {
            current: [
                {
                    noteId: 'note-doll',
                    title: '只需發照片定製人偶可撕拉盲盒',
                    desc: '完整盲盒簡介',
                    likes: 11,
                    collects: 0,
                    commentCount: 0,
                    shareCount: 0,
                    author: 'StoyTuned小鋪',
                    authorId: 'author-doll',
                    coverUrl: 'https://example.test/doll.jpg',
                },
                {
                    noteId: 'note-couple-app',
                    title: '情侶必備的治癒系app',
                    desc: '完整應用簡介',
                    likes: 991,
                    collects: 0,
                    commentCount: 0,
                    shareCount: 0,
                    author: '小貓女士',
                    authorId: 'author-cat',
                    coverUrl: 'https://example.test/couple.jpg',
                },
            ],
        };
        const raw = [
            '[你分享了小紅書筆記]',
            '標題: 只需發照片定製人偶可撕拉盲盒',
            '作者: StoyTuned小鋪',
            '互動: 11贊 0收藏 0評論 0分享',
            '簡介: 無[你分享了小紅書筆記]',
            '標題: 情侶必備的治癒系app',
            '作者: 小貓女士',
            '互動: 991贊 0收藏 0評論 0分享',
            '簡介: 無',
        ].join('\n');

        await applyAssistantPostProcessing(raw, ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'xhs_card');
        const leakedText = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(cards).toHaveLength(2);
        expect(cards.map(card => card.metadata?.xhsNote?.noteId)).toEqual(['note-doll', 'note-couple-app']);
        expect(cards.map(card => card.metadata?.xhsNote?.coverUrl)).toEqual([
            'https://example.test/doll.jpg',
            'https://example.test/couple.jpg',
        ]);
        expect(leakedText).not.toContain('分享了小紅書筆記');
        expect(leakedText).not.toContain('991贊');
    }, 20000);
});

// push 路徑上 LIFE / NEWS_CARD 的副作用改走 worker classifier 的 directive 通道
// (life_record / news_card)。這裡釘的是重放這一段: directive → 拼回原 tag →
// ChatParser.parseAndExecuteActions 執行, 跟本地 fetch 路徑同一份代碼。
describe('directive 重放: life_record / news_card', () => {
    it('news_card directive → 落一張 news_card 消息, 正文不留標籤', async () => {
        const charId = `c-newscard-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.skipSecondPassLLM = true;
        ctx.directives = [{ type: 'news_card', body: '微博|某某官宣' }];

        await applyAssistantPostProcessing('刷到條新聞，你看過沒', ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'news_card');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.title).toBe('某某官宣');
        expect(cards[0].metadata?.source).toBe('微博');
        const text = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(text).toContain('刷到條新聞，你看過沒');
        expect(text).not.toContain('NEWS_CARD');
    }, 20000);

    it('life_record directive → 落一張 life_card, 正文不留標籤', async () => {
        const charId = `c-liferecord-${Date.now()}`;
        await DB.saveCharacter({
            id: charId,
            name: '測試角色',
            lifeRecordEnabled: true,
        } as any);

        const ctx = makeCtx(charId, []);
        ctx.skipSecondPassLLM = true;
        ctx.directives = [{ type: 'life_record', body: 'MED|布洛芬' }];

        await applyAssistantPostProcessing('記得吃藥哦', ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'life_card');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.module).toBe('med');
        const text = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(text).toContain('記得吃藥哦');
        expect(text).not.toContain('LIFE');
    }, 20000);
});

// 表情名對不上時不能靜默丟：後台主動消息會把每個 [[SEND_EMOJI]] 切成獨立一條 push，
// 丟了就是整條 0 氣泡 —— 而系統橫幅（[表情：x]）和未讀數照常，用戶點進去是空的。
describe('SEND_EMOJI 名字對不上', () => {
    it('落一條降級文本氣泡，文案與橫幅一致', async () => {
        const charId = `c-emoji-miss-${Date.now()}`;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 查無此表情]]', makeCtx(charId, []));

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('text');
        expect(bubbles[0].content).toBe('[表情：查無此表情]');
    }, 20000);

    it('名字對得上時照常落表情氣泡', async () => {
        const charId = `c-emoji-hit-${Date.now()}`;

        await applyAssistantPostProcessing(
            '[[SEND_EMOJI: 笑死]]',
            makeCtx(charId, [], [{ name: '笑死', url: 'blob:emoji-lol' }]),
        );

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-lol');
    }, 20000);

    it('模型誤寫“分類名: 表情名”時恢復為當前可見分類裡的真實表情', async () => {
        const charId = `c-emoji-category-prefix-${Date.now()}`;
        const ctx = makeCtx(charId, [], [{
            name: '親親額頭',
            url: 'blob:emoji-kiss-forehead',
            categoryId: 'cat-dull-cat',
        }]);
        ctx.categories = [{ id: 'cat-dull-cat', name: '呆貓' }];
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 呆貓: 親親額頭]]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-kiss-forehead');
    }, 20000);

    it('純名稱精確匹配優先，不誤傷本來就包含冒號的表情名', async () => {
        const charId = `c-emoji-colon-name-${Date.now()}`;
        const ctx = makeCtx(charId, [], [
            { name: '呆貓: 親親額頭', url: 'blob:emoji-exact-colon', categoryId: 'cat-other' },
            { name: '親親額頭', url: 'blob:emoji-prefixed-fallback', categoryId: 'cat-dull-cat' },
        ]);
        ctx.categories = [
            { id: 'cat-other', name: '其他貓' },
            { id: 'cat-dull-cat', name: '呆貓' },
        ];
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 呆貓: 親親額頭]]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-exact-colon');
    }, 20000);

    it('分類前綴存在歧義時不猜 URL，仍保留降級文本', async () => {
        const charId = `c-emoji-category-ambiguous-${Date.now()}`;
        const ctx = makeCtx(charId, [], [
            { name: '揮手', url: 'blob:emoji-wave-a', categoryId: 'cat-a' },
            { name: '揮手', url: 'blob:emoji-wave-b', categoryId: 'cat-b' },
        ]);
        ctx.categories = [
            { id: 'cat-a', name: '小貓' },
            { id: 'cat-b', name: '小貓' },
        ];
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 小貓: 揮手]]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('text');
        expect(bubbles[0].content).toBe('[表情：小貓: 揮手]');
    }, 20000);
});

// 模型偶爾會照抄歷史/UI 裡的人類可讀單括號摘要，而不是 prompt 要求的雙括號機器指令。
// 這三條鎖住真實後處理結果，保證普通聊天與主動消息共用的管線都能自愈。
describe('動作指令單括號掉格式兜底', () => {
    it('[表情：name] 恢復為真實表情氣泡', async () => {
        const charId = `c-emoji-single-${Date.now()}`;
        const ctx = makeCtx(charId, [], [{ name: '小狗淚喪', url: 'blob:emoji-dog-cry' }]);
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[表情：小狗淚喪]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-dog-cry');
    }, 20000);

    it('[ACTION:TRANSFER|...] 恢復為轉帳卡，正文不留標籤', async () => {
        const charId = `c-transfer-single-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[ACTION:TRANSFER|to=user|amount=13]\n給你買西瓜汁', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = bubbles.filter(m => m.type === 'transfer');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.amount).toBe('13');
        expect(bubbles.filter(m => m.type === 'text').map(m => m.content)).toEqual(['給你買西瓜汁']);
    }, 20000);

    it('[生活記錄：支出 ...] 恢復為生活記錄卡並寫入支出', async () => {
        const charId = `c-life-summary-${Date.now()}`;
        await DB.saveCharacter({ id: charId, name: '測試角色', lifeRecordEnabled: true } as any);
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[生活記錄：支出 13（西瓜汁-單括號迴歸）]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = bubbles.filter(m => m.type === 'life_card');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.module).toBe('expense');
        expect(cards[0].metadata?.summary).toBe('支出 13（西瓜汁-單括號迴歸）');
        expect(bubbles.filter(m => m.type === 'text')).toHaveLength(0);
    }, 20000);
});

// 主動消息把「角色說出口」和「客戶端落庫」拉開了距離：一條 push 可以在收件箱裡躺一夜。
// 日程改動必須按說出口那一刻判，所以 ctx 上有個 spokenAt，由 activeMsgRuntime 傳
// push 的 sentAt。這條釘的是**接線**（ctx 字段真的被日程那一步讀到了），
// 判定規則本身在 scheduleChange.test.ts 裡釘。
describe('ctx.spokenAt — 日程改動按說出口那一刻判', () => {
    const dateKeyOf = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const seedSchedule = async (charId: string, when: Date) => {
        const key = dateKeyOf(when);
        await DB.saveDailySchedule({
            id: `${charId}_${key}`,
            charId,
            date: key,
            generatedAt: new Date(when.getFullYear(), when.getMonth(), when.getDate(), 8).getTime(),
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '睡覺' },
            ],
        } as any);
        return key;
    };

    const tag = '[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]';

    it('傳了昨天的 spokenAt → 今天的表不動（隔夜 push 補收）', async () => {
        const charId = 'c-spoken-at-stale';
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const todayKey = await seedSchedule(charId, new Date());
        await seedSchedule(charId, yesterday);

        const ctx = makeCtx(charId, []);
        await applyAssistantPostProcessing(`睡不著，陪你聊會兒。\n${tag}`, {
            ...ctx,
            spokenAt: yesterday.getTime(),
        });

        const today = await DB.getDailySchedule(charId, todayKey);
        expect(today?.slots[1].activity).toBe('睡覺');
    });

    it('不傳 spokenAt（本地聊天）→ 按現在判，照常落庫', async () => {
        const charId = 'c-spoken-at-live';
        const now = new Date();
        const todayKey = await seedSchedule(charId, now);

        const ctx = makeCtx(charId, []);
        await applyAssistantPostProcessing(`那今晚不睡了。\n${tag}`, ctx);

        const today = await DB.getDailySchedule(charId, todayKey);
        // 22:00 之前跑：那條是未來，可改；22:00 之後跑：那條是當前時段，也可改。
        expect(today?.slots[1].activity).toBe('陪你聊天');
    });

    // 隔夜補收整批不落，是日曆日門檻按設計工作，不是失敗。走告知通道的話，用戶會收到
    // 一條紅色的「沒能改上」，而送達其實成功了；主動消息那側還會把它記進「送達失敗」，
    // 指標從此混著一堆正常結果。
    it('隔夜那批不落地時不走告知通道（那不是失敗）', async () => {
        const charId = 'c-spoken-at-crossday-silent';
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await seedSchedule(charId, new Date());
        await seedSchedule(charId, yesterday);

        const ctx = makeCtx(charId, []);
        const notifyScheduleChangeFailed = vi.fn();
        await applyAssistantPostProcessing(`睡不著，陪你聊會兒。\n${tag}`, {
            ...ctx,
            spokenAt: yesterday.getTime(),
            hooks: { ...ctx.hooks, notifyScheduleChangeFailed },
        });

        expect(notifyScheduleChangeFailed).not.toHaveBeenCalled();
        expect(ctx.hooks.addToast).not.toHaveBeenCalled();
    });

    // 反向守衛：真沒落地（今天的表裡沒有對得上的時段）照舊要說，而且要把具體原因
    // 帶出去——那個 note 是界面上那句話的來源，吞掉的話三種原因會塌成同一句。
    it('今天的表裡沒有對得上的時段時，帶著原因走告知通道', async () => {
        const charId = 'c-spoken-at-noslot';
        await seedSchedule(charId, new Date());

        const ctx = makeCtx(charId, []);
        const notifyScheduleChangeFailed = vi.fn();
        await applyAssistantPostProcessing(
            '換個時間。\n[[ACTION:CHANGE_SCHEDULE | 03:15 | 陪你聊天]]',
            { ...ctx, hooks: { ...ctx.hooks, notifyScheduleChangeFailed } },
        );

        expect(notifyScheduleChangeFailed).toHaveBeenCalledTimes(1);
        expect(notifyScheduleChangeFailed.mock.calls[0][0]).toContain('沒有找到對得上的時段');
    });
});


describe('double-bracket sticker history output', () => {
    it.each(['[[你發送了表情包：開心]]', '【你發送了表情包: 開心】'])('persists %s as an image and preserves neighboring text', async raw => {
        const charId = 'c-sticker-history-' + raw;
        const ctx = makeCtx(charId, [], [{ id:'emoji-happy', name:'開心', url:'https://example.com/happy.png' }]);
        ctx.instantRender = true;
        await applyAssistantPostProcessing('前一句\n' + raw + '\n後一句', ctx);
        const messages = await DB.getMessagesByCharId(charId, true);
        expect(messages.map(m => [m.type, m.content])).toEqual([
            ['text','前一句'], ['emoji','https://example.com/happy.png'], ['text','後一句'],
        ]);
    });
});
