import { describe, expect, it } from 'vitest';
import type { AssistantMessage, CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import {
    buildCssWrite, type CssData, type CssWrite, describeCssStatus, findCssLocation, readLocationCss,
    resolveCssTarget, validateLocationCss,
} from './cssLocations';
import { applyCssProposal, changedSinceApply, restoreCssProposal } from './applyProposal';
import { findSoreTool, type SoreToolContext } from './tools';
import { runSoreTurn, toModelMessages } from './engine';

const SOUND = '/* @sully-sound {"src":"chime","volume":0.6} */';

const makeData = (): CssData => ({
    theme: { chatChromeCustomCss: `${SOUND}\n.sully-chat-header{color:red}`, journalAppearance: { preset: 'sakura' } } as unknown as OSTheme,
    characters: [
        { id: 'c1', name: '阿澈', chromeCustomCss: '.sully-chat-name{color:blue}', dateAppearance: { fontSize: 20 } },
        { id: 'c2', name: '小遙' },
        { id: 'c3', name: '小遙' },
    ] as unknown as CharacterProfile[],
    groups: [{ id: 'g1', name: '週末群' }] as unknown as GroupProfile[],
    customThemes: [{ id: 't1', name: '奶油', type: 'custom', user: {}, ai: {}, customCss: '.sully-bubble-user{color:pink}' }] as unknown as ChatTheme[],
});

/** 假的寫入：照 CssWrite 改 data，模擬 OSContext */
const fakeWriter = (data: CssData) => async (w: CssWrite) => {
    if (w.kind === 'theme') data.theme = { ...data.theme, ...w.patch };
    else if (w.kind === 'character') data.characters = data.characters.map(c => (c.id === w.id ? { ...c, ...w.patch } : c));
    else if (w.kind === 'group') data.groups = data.groups.map(g => (g.id === w.id ? { ...g, ...w.patch } : g));
    else if (w.kind === 'chatTheme') data.customThemes = [...data.customThemes.filter(t => t.id !== w.theme.id), w.theme];
    else data.customThemes = data.customThemes.filter(t => t.id !== w.id);
};

describe('美化位置', () => {
    it('白框讀的時候拿掉提示音指令，寫的時候接回去', () => {
        const data = makeData();
        const loc = findCssLocation('chat_chrome_global')!;
        expect(readLocationCss(loc, '', data)).toBe('.sully-chat-header{color:red}');
        const write = buildCssWrite(loc, '', '.sully-chat-root{background:#000}', data);
        expect(write.kind).toBe('theme');
        const css = (write as any).patch.chatChromeCustomCss as string;
        expect(css).toContain('@sully-sound');
        expect(css).toContain('.sully-chat-root{background:#000}');
        expect(css).not.toContain('color:red');
    });
    it('選擇器超出範圍會被擋；見面不查選擇器但有長度上限', () => {
        expect(validateLocationCss(findCssLocation('chat_chrome_global')!, 'body{color:red}').length).toBeGreaterThan(0);
        expect(validateLocationCss(findCssLocation('chat_chrome_global')!, '.sully-chat-header{color:red}')).toEqual([]);
        expect(validateLocationCss(findCssLocation('thinking_chain')!, '.sully-chat-header{color:red}').length).toBeGreaterThan(0);
        expect(validateLocationCss(findCssLocation('date')!, '.date-line{color:red}')).toEqual([]);
        expect(validateLocationCss(findCssLocation('date')!, `.date-line{color:red}${' '.repeat(60000)}`).length).toBeGreaterThan(0);
        expect(validateLocationCss(findCssLocation('journal')!, '.sully-journal-root{color:red')).not.toEqual([]);
    });
    it('目標：名字、id、同名要用 id、氣泡主題可以新建', () => {
        const data = makeData();
        const charLoc = findCssLocation('chat_chrome_char')!;
        expect(resolveCssTarget(charLoc, '阿澈', data)).toMatchObject({ id: 'c1', exists: true });
        expect(resolveCssTarget(charLoc, 'c2', data)).toMatchObject({ id: 'c2' });
        expect(resolveCssTarget(charLoc, '小遙', data)).toHaveProperty('error');
        expect(resolveCssTarget(charLoc, '', data)).toHaveProperty('error');
        expect(resolveCssTarget(findCssLocation('journal')!, undefined, data)).toMatchObject({ exists: true });
        expect(resolveCssTarget(findCssLocation('bubble_theme')!, '新的', data, { allowNew: true })).toMatchObject({ exists: false });
        expect(resolveCssTarget(findCssLocation('bubble_theme')!, '新的', data)).toHaveProperty('error');
    });
    it('見面、日記寫的時候留著其他外觀欄位', () => {
        const data = makeData();
        const date = buildCssWrite(findCssLocation('date')!, 'c1', '.date-line{color:red}', data) as any;
        expect(date.patch.dateAppearance).toEqual({ fontSize: 20, customCss: '.date-line{color:red}' });
        const journal = buildCssWrite(findCssLocation('journal')!, '', '', data) as any;
        expect(journal.patch.journalAppearance).toEqual({ preset: 'sakura', customCss: undefined });
    });
    it('概況列出有設的地方', () => {
        const text = describeCssStatus(makeData());
        expect(text).toContain('chat_chrome_global（聊天白框 · 全域）：有');
        expect(text).toContain('有設的角色 阿澈');
        expect(text).toContain('奶油（有 CSS）');
    });
});

describe('套用與還原', () => {
    it('套用前留快照，還原寫回去', async () => {
        const data = makeData();
        const write = fakeWriter(data);
        const proposal = { id: 'p', kind: 'css' as const, location: 'chat_chrome_char', targetId: 'c1', targetLabel: 'x', css: '.sully-chat-root{color:red}', before: '', status: 'pending' as const };
        const applied = await applyCssProposal(proposal, data, write);
        expect(applied.status).toBe('applied');
        expect(applied.snapshot).toMatchObject({ css: '.sully-chat-name{color:blue}', existed: true });
        expect(data.characters[0].chromeCustomCss).toBe('.sully-chat-root{color:red}');
        expect(changedSinceApply(applied, data)).toBe(false);
        data.characters[0] = { ...data.characters[0], chromeCustomCss: '.sully-chat-root{color:green}' };
        expect(changedSinceApply(applied, data)).toBe(true);
        const restored = await restoreCssProposal(applied, data, write);
        expect(restored.status).toBe('restored');
        expect(data.characters[0].chromeCustomCss).toBe('.sully-chat-name{color:blue}');
    });
    it('新建的氣泡主題：套用＝新增，還原＝刪掉', async () => {
        const data = makeData();
        const write = fakeWriter(data);
        const proposal = { id: 'p', kind: 'css' as const, location: 'bubble_theme', targetId: 'sore_theme_x', targetLabel: 'x', newThemeName: '海鹽', css: '.sully-bubble-ai{color:teal}', before: '', status: 'pending' as const };
        const applied = await applyCssProposal(proposal, data, write);
        expect(data.customThemes.find(t => t.id === 'sore_theme_x')).toMatchObject({ name: '海鹽', type: 'custom', customCss: '.sully-bubble-ai{color:teal}' });
        expect(applied.snapshot?.existed).toBe(false);
        await restoreCssProposal(applied, data, write);
        expect(data.customThemes.some(t => t.id === 'sore_theme_x')).toBe(false);
    });
    it('角色被刪了就不套用', async () => {
        const data = makeData();
        const proposal = { id: 'p', kind: 'css' as const, location: 'thinking_chain', targetId: 'gone', targetLabel: 'x', css: '.sully-psyche-card{color:red}', before: '', status: 'pending' as const };
        await expect(applyCssProposal(proposal, data, fakeWriter(data))).rejects.toThrow(/不在了/);
    });
});

describe('CSS 工具', () => {
    const ctxOf = (data: CssData): SoreToolContext => ({
        settings: async () => { throw new Error('unused'); },
        testApi: async () => ({ ok: true, message: '' }),
        cssData: () => data,
    });
    it('寫CSS：檢查沒過回錯誤、不出卡片', async () => {
        const result = await findSoreTool('寫CSS')!.run({ location: 'chat_chrome_global', css: 'body{color:red}' }, ctxOf(makeData()));
        expect(result.ok).toBe(false);
        expect(result.proposal).toBeUndefined();
        expect(result.content).toContain('超出限定範圍');
    });
    it('寫CSS：檢查過了出卡片，before 是現在的內容', async () => {
        const result = await findSoreTool('寫CSS')!.run({ location: 'chat_chrome_char', target: '阿澈', css: '.sully-chat-root{color:red}', summary: '換底色' }, ctxOf(makeData()));
        expect(result.ok).toBe(true);
        expect(result.proposal).toMatchObject({ location: 'chat_chrome_char', targetId: 'c1', before: '.sully-chat-name{color:blue}', summary: '換底色' });
    });
    it('寫CSS：新氣泡主題先產 id', async () => {
        const result = await findSoreTool('寫CSS')!.run({ location: 'bubble_theme', target: '海鹽', css: '.sully-bubble-ai{color:teal}' }, ctxOf(makeData()));
        expect(result.proposal?.targetId).toMatch(/^sore_theme_/);
        expect(result.proposal?.newThemeName).toBe('海鹽');
    });
    it('清除CSS：空的就不出卡片', async () => {
        const empty = await findSoreTool('清除CSS')!.run({ location: 'schedule' }, ctxOf(makeData()));
        expect(empty.ok).toBe(false);
        const clear = await findSoreTool('清除CSS')!.run({ location: 'chat_chrome_global' }, ctxOf(makeData()));
        expect(clear.proposal).toMatchObject({ css: '', before: '.sully-chat-header{color:red}' });
    });
    it('讀取CSS：不給位置是概況，給位置帶選擇器', async () => {
        const status = await findSoreTool('讀取CSS')!.run({}, ctxOf(makeData()));
        expect(status.content).toContain('chat_chrome_global');
        const one = await findSoreTool('讀取CSS')!.run({ location: 'thinking_chain', target: '阿澈' }, ctxOf(makeData()));
        expect(one.content).toContain('.sully-psyche-card');
        expect(one.content).toContain('（空的）');
    });
});

describe('引擎接提案', () => {
    it('工具出的提案掛在工具訊息上，狀態會帶給模型', async () => {
        const data = makeData();
        const replies = ['<tool name="寫CSS">{"location":"journal","css":".sully-journal-root{color:red}"}</tool>', '好了，按套用看看'];
        const added: AssistantMessage[] = [];
        await runSoreTurn({
            history: [{ id: 'u', role: 'user', text: '日記弄成紅的', at: 1 }],
            call: async () => replies.shift()!,
            ctx: { settings: async () => { throw new Error('unused'); }, testApi: async () => ({ ok: true, message: '' }), cssData: () => data },
            onMessage: m => { added.push(m); },
        });
        const tool = added.find(m => m.role === 'tool')!;
        expect(tool.proposal).toMatchObject({ status: 'pending', location: 'journal' });
        const msgs = toModelMessages([...added.slice(0, 1), { ...tool, proposal: { ...tool.proposal!, status: 'applied' } }]);
        expect(msgs[1].content).toContain('[提案狀態：用戶已套用]');
    });
});
