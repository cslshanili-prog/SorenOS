import { describe, expect, it } from 'vitest';
import type { CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../types';
import { LAYOUT_DEFAULTS, resolveDecorationTheme } from './chatDecoration';
import { mergeChatFineTune } from './chatFineTuneCss';
import {
    characterPatchFromDraft, characterStatus, detachCharacterPatch, detachGroupPatch, detachThemePatch, duplicateTemplate,
    groupPatchFromDraft, makeTemplate, presetToTemplate, sanitizeTemplate, templateFromCharacter, templateFromGroup,
    templateBindings, templateFromTheme, templateToPresetDraft, templateUsage, themePatchFromDraft, themeStatus,
} from './decorationTemplates';

const theme = { chatAvatarShape: 'circle', chatChromeCustomCss: '.g{}', chatBackgroundStyle: 'grid' } as unknown as OSTheme;
const char = (patch: Partial<CharacterProfile> = {}) => ({ id: 'c1', name: '阿澈', ...patch }) as CharacterProfile;
const effective = (c: CharacterProfile, t: OSTheme) => { const base = resolveDecorationTheme(t, c); return { ...base, ...mergeChatFineTune(base, c.chatFineTune) }; };

describe('模板寫穿', () => {
    it('角色：先清回跟著全局，再寫模板有的；畫面算出來就是模板的佈局', () => {
        const tpl = makeTemplate('奶茶', { layout: { chatAvatarShape: 'square', chatBubbleFontSize: 16 }, bubbleThemeId: 'milk', background: { image: 'blobref:bg', style: 'paper' }, css: '.x{}', sound: { src: 'ding', volume: 0.5 } });
        const before = char({ chromeCustomCss: '.old{}', chatSound: { src: 'chime' }, bubbleStyle: 'old' });
        const after = { ...before, ...characterPatchFromDraft(tpl, tpl.id) };
        expect(after.decorationTemplateId).toBe(tpl.id);
        expect(after.bubbleStyle).toBe('milk');
        expect(after.chromeCustomCss).toBe('.x{}');
        expect(after.chatDecorationCssIsolated).toBe(true);
        expect(after.chatBackground).toBe('blobref:bg');
        const eff = effective(after, theme);
        expect(eff.chatAvatarShape).toBe('square');
        expect(eff.chatBubbleFontSize).toBe(16);
        expect(eff.chatBackgroundStyle).toBe('paper');
        expect(eff.chatChromeCustomCss).toBeUndefined(); // 取代全局
    });

    it('角色：模板沒填的項目＝跟著全局，舊的自己設定不會留著', () => {
        const tpl = makeTemplate('只換底圖', { background: { image: 'blobref:a', style: 'plain' } });
        const after = { ...char({ bubbleStyle: 'old', chromeCustomCss: '.old{}', chatAppearance: { chatAvatarShape: 'square' } }), ...characterPatchFromDraft(tpl, tpl.id) };
        expect(after.bubbleStyle).toBeUndefined();
        expect(after.chromeCustomCss).toBeUndefined();
        expect(effective(after, theme).chatAvatarShape).toBe('circle');
        expect(effective(after, theme).chatChromeCustomCss).toBe('.g{}');
    });

    it('CSS 可以選疊在全局上', () => {
        const after = { ...char(), ...characterPatchFromDraft({ css: '.x{}', cssStacksOnGlobal: true }) };
        expect(after.chatDecorationCssIsolated).toBe(false);
        expect(effective(after, theme).chatChromeCustomCss).toBe('.g{}');
    });

    it('全局：沒填的回系統默認', () => {
        const patch = themePatchFromDraft({ bubbleThemeId: 'milk' }, 't1');
        expect(patch.chatAvatarShape).toBe(LAYOUT_DEFAULTS.chatAvatarShape);
        expect(patch.chatDefaultBubbleStyle).toBe('milk');
        expect(patch.chatChromeCustomCss).toBeUndefined();
        expect(patch.chatBackgroundStyle).toBe('plain');
        expect(patch.decorationTemplateId).toBe('t1');
    });

    it('群：只寫 CSS、聲音、我的氣泡', () => {
        const patch = groupPatchFromDraft({ layout: { chatAvatarShape: 'square' }, bubbleThemeId: 'milk', css: '.x{}', sound: { src: 'none' } }, 't1');
        expect(patch).toMatchObject({ chromeCustomCss: '.x{}', userBubbleThemeId: 'milk', chatSound: { src: 'none' }, decorationTemplateId: 't1' });
        expect(patch).not.toHaveProperty('chatAppearance');
    });
});

describe('抽出現在的樣子（編輯自訂）', () => {
    it('角色：抽出來再寫回去，畫面一樣', () => {
        const c = char({ bubbleStyle: 'milk', chatAppearance: { chatAvatarShape: 'square', chatBackgroundStyle: 'mesh' }, chatFineTune: { enabled: true, chatBubbleFontSize: 15 }, chatBackground: 'blobref:x', chromeCustomCss: '/* @sully-sound {"src":"ding","volume":0.4} */\n.mine{}' });
        const draft = templateFromCharacter(c, theme);
        expect(draft.css).toBe('.mine{}');
        expect(draft.cssStacksOnGlobal).toBe(true);
        expect(draft.sound?.src).toBe('ding');
        const back = { ...c, ...characterPatchFromDraft(draft) };
        const a = effective(c, theme), b = effective(back, theme);
        for (const k of ['chatAvatarShape', 'chatBubbleFontSize', 'chatBackgroundStyle', 'chatChromeCustomCss'] as const) expect(b[k]).toEqual(a[k]);
        expect(back.bubbleStyle).toBe('milk');
        expect(back.chatBackground).toBe('blobref:x');
        expect(back.decorationTemplateId).toBeUndefined();
    });

    it('什麼都沒設的角色：草稿是空的，狀態是跟著全局', () => {
        expect(templateFromCharacter(char(), theme)).toEqual({});
        expect(characterStatus(char(), []).kind).toBe('follow');
        expect(characterStatus(char({ bubbleStyle: 'x' }), []).kind).toBe('custom');
    });

    it('全局、群也抽得出來', () => {
        const draft = templateFromTheme({ ...theme, chatDefaultBubbleStyle: 'milk' });
        expect(draft.layout?.chatAvatarShape).toBe('circle');
        expect(draft.css).toBe('.g{}');
        expect(draft.background?.style).toBe('grid');
        const g = templateFromGroup({ id: 'g', name: '群', members: [], userBubbleThemeId: 'milk', chromeCustomCss: '.y{}' } as unknown as GroupProfile);
        expect(g).toEqual({ bubbleThemeId: 'milk', css: '.y{}', cssStacksOnGlobal: true });
    });
});

describe('狀態、誰在用、複製', () => {
    it('綁了不存在的模板就當自訂；全局沒綁＝自訂', () => {
        const t = makeTemplate('A', {});
        expect(characterStatus(char({ decorationTemplateId: t.id }), [t]).kind).toBe('template');
        expect(characterStatus(char({ decorationTemplateId: 'gone', bubbleStyle: 'x' }), [t]).kind).toBe('custom');
        expect(themeStatus(theme, [t]).kind).toBe('custom');
    });

    it('誰在用：小號不算', () => {
        const usage = templateUsage('t', { theme: { ...theme, decorationTemplateId: 't' }, characters: [char({ decorationTemplateId: 't' }), char({ id: 'alt', altOf: 'c1', decorationTemplateId: 't' })], groups: [{ id: 'g', decorationTemplateId: 't' } as GroupProfile] });
        expect(usage).toEqual([{ kind: 'global' }, { kind: 'character', id: 'c1' }, { kind: 'group', id: 'g' }]);
    });

    it('寫穿對象：小號、非主線也算進去', () => {
        const chars = [char({ decorationTemplateId: 't', lines: { pB: { decorationTemplateId: 't' }, pC: { bubbleStyle: 'x' } } } as Partial<CharacterProfile>), char({ id: 'alt', altOf: 'c1', decorationTemplateId: 't' })];
        expect(templateBindings('t', { theme, characters: chars, groups: [] })).toEqual([
            { kind: 'character', id: 'c1' }, { kind: 'character', id: 'c1', line: 'pB' }, { kind: 'character', id: 'alt' },
        ]);
    });

    it('複製一份：新 id、名字加副本、內容一樣', () => {
        const t = makeTemplate('奶茶', { css: '.x{}' });
        const copy = duplicateTemplate(t, [t]);
        expect(copy.id).not.toBe(t.id);
        expect(copy.name).toBe('奶茶（副本）');
        expect(copy.css).toBe('.x{}');
        expect(duplicateTemplate(t, [t, copy]).name).toBe('奶茶（副本） 2');
    });
});

describe('別處改了就解除綁定', () => {
    it('角色：動到裝扮欄位解除，沒動到或模板自己寫的不解除', () => {
        const c = char({ decorationTemplateId: 't', bubbleStyle: 'a' });
        expect(detachCharacterPatch(c, { bubbleStyle: 'b' })).toHaveProperty('decorationTemplateId', undefined);
        expect(detachCharacterPatch(c, { bubbleStyle: 'a' })).not.toHaveProperty('decorationTemplateId');
        expect(detachCharacterPatch(c, { name: '新名字' })).not.toHaveProperty('decorationTemplateId');
        expect(detachCharacterPatch(c, { bubbleStyle: 'b', decorationTemplateId: 't' })).toHaveProperty('decorationTemplateId', 't');
    });
    it('全局、群一樣', () => {
        expect(detachThemePatch({ ...theme, decorationTemplateId: 't' }, { chatAvatarShape: 'square' })).toHaveProperty('decorationTemplateId', undefined);
        expect(detachThemePatch({ ...theme, decorationTemplateId: 't' }, { wallpaper: 'x' } as Partial<OSTheme>)).not.toHaveProperty('decorationTemplateId');
        expect(detachGroupPatch({ id: 'g', decorationTemplateId: 't' } as GroupProfile, { chromeCustomCss: '.z{}' })).toHaveProperty('decorationTemplateId', undefined);
    });
});

describe('舊預設、匯入匯出', () => {
    const bubble = { id: 'milk', name: '奶茶', type: 'custom', user: { textColor: '#000', backgroundColor: '#fff', borderRadius: 20, opacity: 1 }, ai: { textColor: '#111', backgroundColor: '#eee', borderRadius: 20, opacity: 1 } } as ChatTheme;
    const deps = { migrateImage: async (s: string) => `blobref:${s.length}`, migrateBubble: async (b: ChatTheme) => b, newBubbleId: () => 'new-bubble' };

    it('一樣的氣泡沿用，不一樣的多存一套；圖片轉 blobref', async () => {
        const preset = { format: 'sullyos-chat-decoration', version: 1, name: '舊的', parts: { bubbles: { ...bubble, id: 'whatever' }, background: { image: 'data:image/png;base64,AAAA', style: 'paper' }, css: '.x{}', sound: null } } as any;
        const same = await presetToTemplate(preset, [bubble], deps);
        expect(same.newBubble).toBeUndefined();
        expect(same.template.bubbleThemeId).toBe('milk');
        expect(same.template.background?.image).toMatch(/^blobref:/);
        expect(same.template.sound).toEqual({ src: 'none' });
        const diff = await presetToTemplate({ ...preset, parts: { bubbles: { ...bubble, user: { ...bubble.user, backgroundColor: '#f00' } } } }, [bubble], deps);
        expect(diff.newBubble?.id).toBe('new-bubble');
        expect(diff.template.bubbleThemeId).toBe('new-bubble');
    });

    it('匯出把氣泡內嵌回去', () => {
        const t = makeTemplate('奶茶', { bubbleThemeId: 'milk', css: '.x{}', sound: { src: 'none' } });
        const out = templateToPresetDraft(t, [bubble]);
        expect(out.parts.bubbles?.name).toBe('奶茶');
        expect(out.parts.sound).toBeNull();
        expect(out.parts.css).toBe('.x{}');
    });

    it('讀回來時壞的模板丟掉', () => {
        expect(sanitizeTemplate({ id: 'a', name: 'A', layout: { chatAvatarShape: 'hexagon' } })).toBeNull();
        expect(sanitizeTemplate({ id: 'a', name: 'A', css: '.x{}' })?.css).toBe('.x{}');
        expect(sanitizeTemplate('x')).toBeNull();
    });
});

import { uniqueTemplateName } from './decorationTemplates';
describe('模板名字', () => {
    it('撞名加編號', () => {
        expect(uniqueTemplateName('奶茶', [])).toBe('奶茶');
        expect(uniqueTemplateName('我的裝扮', [{ name: '我的裝扮' }, { name: '我的裝扮 2' }])).toBe('我的裝扮 3');
        expect(uniqueTemplateName('  ', [])).toBe('我的裝扮');
    });
});
