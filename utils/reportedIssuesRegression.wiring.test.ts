import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    'utf8',
).replace(/\r\n?/g, '\n');

describe('用戶反饋迴歸保護', () => {
    it('見面輸入欄允許 Firefox 在窄屏收縮 textarea，並固定保留發送按鈕', () => {
        const source = read('../components/date/DateSession.tsx');
        const inputLayer = source.slice(source.indexOf('{/* Input Layer */}'), source.indexOf('{/* Settings Overlay */}'));

        expect(inputLayer).toContain('w-[90%] min-w-0 max-w-lg');
        expect(inputLayer).toContain('className={`min-w-0 flex-1');
        expect(inputLayer).toContain('className="shrink-0 px-4 sm:px-6');
    });

    it('劇情重試會在再次生成前先嘗試歸檔，避免超長上下文把後置歸檔永久卡死', () => {
        const source = read('../components/date/story/StoryTheaterSession.tsx');
        const send = source.slice(source.indexOf('const send = useCallback'), source.indexOf('const archivedCount ='));
        const preflight = send.indexOf('const promptEntry = await archiveIfNeeded() || entry;');
        const completion = send.indexOf('const generated = await callCompletion');

        expect(preflight).toBeGreaterThanOrEqual(0);
        expect(completion).toBeGreaterThan(preflight);
        expect(send).toContain('mirrorArchived(message, promptEntry)');
        expect(send).toContain('promptEntry.archives.filter');
    });

    it('劇情預算裡的預設只統計啟用項，不把關閉的提示詞算進總量', () => {
        const editor = read('../components/date/story/StoryTheaterEditor.tsx');

        expect(editor).toContain('document.prompts.filter(prompt => prompt.enabled).map(prompt => prompt.content)');
    });

    it('默認版預設設置直接提供帶人話說明的續寫參數', () => {
        const maker = read('../components/date/story/StoryPresetMaker.tsx');

        expect(maker).toContain("['temperature', '溫度', 'Temperature'");
        expect(maker).toContain("['topP', '候選範圍', 'Top P'");
        expect(maker).toContain("['frequencyPenalty', '重複懲罰', 'Frequency penalty'");
        expect(maker).toContain("['presencePenalty', '話題懲罰', 'Presence penalty'");
        expect(maker).toContain("['maxTokens', '最大輸出', 'Max tokens'");
        expect(maker).toContain('使用 Claude 時會自動按 1.0 發送');
        expect(maker).toContain("<h2 className='text-sm font-bold'>續寫參數</h2>");
    });

    it('劇情預設導出複用原生分享鏈路，不依賴 Android WebView 的 a.download', () => {
        const storyTheater = read('./storyTheater.ts');

        expect(storyTheater).toContain("import { shareOrDownloadFile } from './shareExport'");
        expect(storyTheater).toContain('shareOrDownloadFile({');
        expect(storyTheater).not.toContain("anchor.download = `${preset.name");
    });

    it('統一請求出口會在發送前修正 Claude 超範圍溫度', () => {
        const osContext = read('../context/OSContext.tsx');

        expect(osContext).toContain('clampClaudeTemperature(parsed)');
        expect(osContext.indexOf('clampClaudeTemperature(parsed)')).toBeLessThan(osContext.indexOf('await originalFetch(...sendArgs)'));
    });

    it('靜態 PNG 觸摸反饋不再按情緒 key 重掛載圖片或重播閃白動畫', () => {
        const portrait = read('../components/os/StaticCompanionPortrait.tsx');
        const home = read('../components/os/CompanionHome.tsx');

        expect(portrait).not.toContain('key={`${value}-${expressionKey}`}');
        expect(portrait).not.toContain('companion-static-expression-in');
        expect(home).not.toContain('staticExpressionKey');
    });

    it('聊天翻譯支持按角色保存直接展開模式，並在氣泡內同時渲染原文和譯文', () => {
        const chat = read('../apps/Chat.tsx');
        const modals = read('../components/chat/ChatModals.tsx');
        const item = read('../components/chat/MessageItem.tsx');

        expect(chat).toContain('chat_translate_expanded_${activeCharacterId}');
        expect(modals).toContain('原文與譯文同時展開');
        expect(item).toContain('showExpandedTranslation');
        expect(item).toContain('{renderContent(langBContent)}');
    });
});
