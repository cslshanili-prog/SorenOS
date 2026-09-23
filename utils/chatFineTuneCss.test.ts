import { describe, it, expect } from 'vitest';
import { buildChatFineTuneCss, mergeChatFineTune, CHAT_FINE_TUNE_KEYS } from './chatFineTuneCss';

// 聊天細節微調 CSS 生成器：全默認零輸出；各旋鈕生成的選擇器與社區已驗證版本一致。

describe('buildChatFineTuneCss', () => {
    it('全默認 → 空串（不注入任何 style）', () => {
        expect(buildChatFineTuneCss({})).toBe('');
        expect(buildChatFineTuneCss({ chatAvatarVisibility: 'both', chatAvatarPlacement: 'beside', chatAvatarAlign: 'bottom', chatAvatarOffsetY: 0, chatBubbleFontSize: 0, chatBubbleLineHeight: 0, chatBubbleIndent: 0 })).toBe('');
    });

    it('隱藏角色側頭像只影響 justify-start；貼邊只收隱藏側空位', () => {
        const css = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_ai', chatSnapToEdge: true });
        expect(css).toContain('.group.justify-start > [class~="absolute"][class~="z-0"] { display: none');
        expect(css).not.toContain('.group.justify-end > [class~="absolute"][class~="z-0"] { display: none');
        expect(css).toContain('.ml-12:not(.sully-html-wrap) { margin-left: 0 !important; }');
        expect(css).not.toContain('margin-right: 0');
    });

    it('每輪氣泡上方：顯示組首頭像、隱藏默認頭像、首條留高並收回氣泡旁空位', () => {
        const css = buildChatFineTuneCss({ chatAvatarPlacement: 'above_group' });
        expect(css).toContain('.sully-chat-turn-avatar-slot { display: block !important;');
        expect(css).toContain('.sully-chat-message-avatar { display: none !important;');
        expect(css).toContain('padding-top: calc(var(--sully-chat-message-avatar-size, 36px) + 8px) !important;');
        expect(css).toContain('.sully-chat-message-content:not(.sully-html-wrap) { margin-left: 0 !important; margin-right: 0 !important; }');
    });

    it('心象卡片釘回默認位置：貼邊補 48px、縮進補 48-indent、沒動不出規則', () => {
        const snapCss = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_ai', chatSnapToEdge: true });
        expect(snapCss).toContain('.sully-psyche { margin-left: 48px !important; }');
        const indentCss = buildChatFineTuneCss({ chatBubbleIndent: 60 });
        expect(indentCss).toContain('.sully-psyche { margin-left: -12px !important; }');
        // 貼邊只作用於用戶側時，AI 包裝層只受縮進影響 → 按縮進補
        const mixedCss = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_user', chatSnapToEdge: true, chatBubbleIndent: 28 });
        expect(mixedCss).toContain('.sully-psyche { margin-left: 20px !important; }');
        // 包裝層沒動（只改字號/對齊）→ 不出心象規則
        expect(buildChatFineTuneCss({ chatBubbleFontSize: 14, chatAvatarAlign: 'top' })).not.toContain('sully-psyche');
    });

    it('貼邊/縮進的選擇器都 :not() 繞開 HTML 卡片包裝（卡片不隨美化挪窩）', () => {
        const css = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_both', chatSnapToEdge: true, chatBubbleIndent: 60 });
        const wrapRules = css.split('\n').filter(line => line.includes('.ml-12') || line.includes('.mr-12'));
        expect(wrapRules.length).toBeGreaterThan(0);
        for (const rule of wrapRules) expect(rule).toContain(':not(.sully-html-wrap)');
    });

    it('頂部對齊 + 垂直微調', () => {
        const css = buildChatFineTuneCss({ chatAvatarAlign: 'top', chatAvatarOffsetY: -8 });
        expect(css).toContain('bottom: auto !important; top: -0.5rem !important;');
        expect(css).toContain('translateY(-8px)');
    });

    it('垂直居中把偏移並進 calc（transform 不互相覆蓋）', () => {
        const css = buildChatFineTuneCss({ chatAvatarAlign: 'center', chatAvatarOffsetY: 4 });
        expect(css).toContain('translateY(calc(-50% + 4px))');
    });

    it('字號/行距走社區版四層選擇器，內聯元素 inherit', () => {
        const css = buildChatFineTuneCss({ chatBubbleFontSize: 14, chatBubbleLineHeight: 1.5 });
        expect(css).toContain('.sully-bubble-ai > div[class~="select-text"]');
        expect(css).toContain('font-size: 14px !important;');
        expect(css).toContain('line-height: 1.5 !important;');
        expect(css).toContain('font-size: inherit !important;');
        expect(css).toContain('[class*="text-[13px]"]');
    });

    it('合併結果直接可餵給 buildChatFineTuneCss（角色覆蓋後按覆蓋值出 CSS）', () => {
        const css = buildChatFineTuneCss(mergeChatFineTune(
            { chatBubbleFontSize: 14 },
            { enabled: true, chatBubbleFontSize: 16 },
        ));
        expect(css).toContain('font-size: 16px !important;');
        expect(css).not.toContain('font-size: 14px');
    });

    it('氣泡縮進對兩側生效；貼邊側讓位', () => {
        const css = buildChatFineTuneCss({ chatBubbleIndent: 60 });
        expect(css).toContain('margin-left: 60px !important;');
        expect(css).toContain('margin-right: 60px !important;');
        const snapCss = buildChatFineTuneCss({ chatBubbleIndent: 60, chatAvatarVisibility: 'hide_ai', chatSnapToEdge: true });
        expect(snapCss).toContain('margin-left: 0 !important;');
        expect(snapCss).not.toContain('margin-left: 60px');
        expect(snapCss).toContain('margin-right: 60px !important;');
    });
});

// 「全局打底，角色可覆蓋」合併規則：enabled 才生效；生效時已定義字段逐個覆蓋，未定義跟隨全局。

describe('mergeChatFineTune', () => {
    const global = { chatAvatarVisibility: 'hide_ai', chatBubbleFontSize: 14, chatBubbleIndent: 60, chatSnapToEdge: true } as const;

    it('無覆蓋 / enabled 缺省或 false → 完全跟隨全局（設了字段也不生效）', () => {
        expect(mergeChatFineTune(global)).toEqual(global);
        expect(mergeChatFineTune(global, null)).toEqual(global);
        expect(mergeChatFineTune(global, { chatBubbleFontSize: 16 })).toEqual(global);
        expect(mergeChatFineTune(global, { enabled: false, chatBubbleFontSize: 16 })).toEqual(global);
    });

    it('enabled=true → 已定義字段逐個覆蓋，未定義字段跟隨全局', () => {
        const merged = mergeChatFineTune(global, { enabled: true, chatBubbleFontSize: 16, chatAvatarAlign: 'top' });
        expect(merged).toEqual({ ...global, chatBubbleFontSize: 16, chatAvatarAlign: 'top' });
    });

    it('顯式默認值（0 / both / false）也算覆蓋——角色可把某項壓回默認', () => {
        const merged = mergeChatFineTune(global, { enabled: true, chatBubbleFontSize: 0, chatAvatarVisibility: 'both', chatSnapToEdge: false });
        expect(merged.chatBubbleFontSize).toBe(0);
        expect(merged.chatAvatarVisibility).toBe('both');
        expect(merged.chatSnapToEdge).toBe(false);
        expect(merged.chatBubbleIndent).toBe(60); // 未覆蓋的字段仍跟全局
    });

    it('返回淺拷貝且只含微調字段，不夾帶 enabled / 其他主題鍵', () => {
        const merged = mergeChatFineTune({ ...global, chatBubbleStyle: 'flat' } as any, { enabled: true });
        expect(merged).not.toBe(global);
        expect(merged).not.toHaveProperty('enabled');
        expect(merged).not.toHaveProperty('chatBubbleStyle');
        for (const key of Object.keys(merged)) expect(CHAT_FINE_TUNE_KEYS).toContain(key);
    });

    it('全局與覆蓋都為空 → 空對象（buildChatFineTuneCss 得零輸出）', () => {
        const merged = mergeChatFineTune({}, { enabled: true });
        expect(merged).toEqual({});
        expect(buildChatFineTuneCss(merged)).toBe('');
    });

    it('chatModuleAlign 參與合併但不生成 CSS（經 MessageItem 佈局屬性生效，缺省=居中）', () => {
        const merged = mergeChatFineTune({ chatModuleAlign: 'center' }, { enabled: true, chatModuleAlign: 'anchor' });
        expect(merged.chatModuleAlign).toBe('anchor');
        expect(buildChatFineTuneCss({ chatModuleAlign: 'center' })).toBe('');
        expect(buildChatFineTuneCss({ chatModuleAlign: 'anchor' })).toBe('');
    });
});
