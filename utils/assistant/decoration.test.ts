import { describe, expect, it } from 'vitest';
import type { AssistantDecorationProposal, CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import { applyDecorationProposal, buildDecorationProposal, describeDecorationTemplates, restoreDecorationProposal, decorationPreviewSim, type DecorationData, type DecorationWriter } from './decorationOps';
import { makeTemplate, characterPatchFromDraft, type DecorationTemplate } from '../decorationTemplates';

const milk = { id: 'milk', name: '奶茶', type: 'custom', user: { textColor: '#000', backgroundColor: '#fff', borderRadius: 18, opacity: 1 }, ai: { textColor: '#000', backgroundColor: '#eee', borderRadius: 18, opacity: 1 } } as ChatTheme;

const setup = () => {
    const tpl = makeTemplate('奶茶夜', { bubbleThemeId: 'milk', css: '.sully-chat-header{background:#000}' });
    const data: DecorationData = {
        theme: { chatAvatarShape: 'circle' } as OSTheme,
        characters: [
            { id: 'c1', name: '阿澈', ...characterPatchFromDraft(tpl, tpl.id) } as CharacterProfile,
            { id: 'c2', name: '小白' } as CharacterProfile,
        ],
        groups: [{ id: 'g1', name: '宿舍', members: [] } as unknown as GroupProfile],
        customThemes: [milk],
        templates: [tpl],
    };
    const log: Array<{ target: string; patch: Record<string, unknown> }> = [];
    const writer: DecorationWriter = {
        saveTemplates: list => { data.templates = list; },
        writeTarget: (target, patch) => {
            log.push({ target: target.kind === 'global' ? 'global' : target.id, patch: patch as Record<string, unknown> });
            if (target.kind === 'character') data.characters = data.characters.map(c => (c.id === target.id ? { ...c, ...patch } as CharacterProfile : c));
            if (target.kind === 'group') data.groups = data.groups.map(g => (g.id === target.id ? { ...g, ...patch } as GroupProfile : g));
            if (target.kind === 'global') data.theme = { ...data.theme, ...patch };
        },
    };
    return { tpl, data, writer, log };
};
const asProposal = (draft: object): AssistantDecorationProposal => ({ ...(draft as AssistantDecorationProposal), id: 'p1', status: 'pending' });

describe('Sore 改裝扮', () => {
    it('讀模板：清單與單份全文', () => {
        const { data } = setup();
        expect(describeDecorationTemplates(undefined, data).content).toContain('奶茶夜');
        const full = describeDecorationTemplates('奶茶夜', data).content;
        expect(full).toContain('誰在用：阿澈');
        expect(full).toContain('.sully-chat-header{background:#000}');
    });

    it('改模板：寫穿到用它的聊天，還原寫回去', async () => {
        const { data, writer, tpl } = setup();
        const built = buildDecorationProposal({ template: '奶茶夜', ops: [{ op: 'layout', set: { chatAvatarShape: 'square' } }, { op: 'sound', src: 'ding' }] }, data);
        if ('errors' in built) throw new Error(built.errors.join());
        expect(built.draft.usage).toEqual(['阿澈']);
        expect(built.draft.changes.map(c => c.label).join('\n')).toContain('頭像形狀');
        const applied = await applyDecorationProposal(asProposal(built.draft), data, writer);
        expect(data.templates[0].layout?.chatAvatarShape).toBe('square');
        expect(data.characters[0].chatAppearance?.chatAvatarShape).toBe('square');
        expect(data.characters[0].chatSound?.src).toBe('ding');
        await restoreDecorationProposal(applied, data, writer);
        expect(data.templates[0].layout).toBeUndefined();
        expect(data.characters[0].chatSound).toBeUndefined();
        expect(data.characters[0].decorationTemplateId).toBe(tpl.id);
    });

    it('新建模板（從某個聊天現在的樣子），還原就拿掉', async () => {
        const { data, writer } = setup();
        const built = buildDecorationProposal({ template: '只換底圖', create: true, from: '阿澈', ops: [{ op: 'background', style: 'mesh' }] }, data);
        if ('errors' in built) throw new Error(built.errors.join());
        const applied = await applyDecorationProposal(asProposal(built.draft), data, writer);
        const created = data.templates.find(t => t.name === '只換底圖')!;
        expect(created.bubbleThemeId).toBe('milk');
        expect(created.background?.style).toBe('mesh');
        await restoreDecorationProposal(applied, data, writer);
        expect(data.templates.some(t => t.name === '只換底圖')).toBe(false);
    });

    it('某個聊天換模板、跟著全局，還原回原本', async () => {
        const { data, writer, tpl } = setup();
        const use = buildDecorationProposal({ target: '小白', ops: [{ op: 'use_template', template: '奶茶夜' }] }, data);
        if ('errors' in use) throw new Error(use.errors.join());
        const applied = await applyDecorationProposal(asProposal(use.draft), data, writer);
        expect(data.characters[1].decorationTemplateId).toBe(tpl.id);
        await restoreDecorationProposal(applied, data, writer);
        expect(data.characters[1].decorationTemplateId).toBeUndefined();
        expect(data.characters[1].bubbleStyle).toBeUndefined();

        const follow = buildDecorationProposal({ target: '阿澈', ops: [{ op: 'follow' }] }, data);
        if ('errors' in follow) throw new Error(follow.errors.join());
        const a2 = await applyDecorationProposal(asProposal(follow.draft), data, writer);
        expect(data.characters[0].bubbleStyle).toBeUndefined();
        await restoreDecorationProposal(a2, data, writer);
        expect(data.characters[0].decorationTemplateId).toBe(tpl.id);
        expect(data.characters[0].bubbleStyle).toBe('milk');
    });

    it('直接改綁著模板的聊天：卡片說會變自訂，套用後脫離模板', async () => {
        const { data, writer } = setup();
        const built = buildDecorationProposal({ target: '阿澈', ops: [{ op: 'layout', set: { chatBubbleFontSize: 16 } }] }, data);
        if ('errors' in built) throw new Error(built.errors.join());
        expect(built.draft.changes.some(c => c.label.includes('變成自訂'))).toBe(true);
        await applyDecorationProposal(asProposal(built.draft), data, writer);
        expect(data.characters[0].decorationTemplateId).toBeUndefined();
        expect(data.characters[0].bubbleStyle).toBe('milk');
        expect(data.characters[0].chatAppearance?.chatBubbleFontSize).toBe(16);
    });

    it('擋掉不合理的', () => {
        const { data } = setup();
        const err = (args: Record<string, unknown>) => { const r = buildDecorationProposal(args, data); return 'errors' in r ? r.errors.join() : ''; };
        expect(err({ template: '奶茶夜', target: '阿澈', ops: [{ op: 'follow' }] })).toContain('給一個');
        expect(err({ target: '阿澈', ops: [{ op: 'css', css: '.x{}' }] })).toContain('寫CSS');
        expect(err({ target: '宿舍', ops: [{ op: 'layout', set: { chatAvatarShape: 'square' } }] })).toContain('群沒有');
        expect(err({ template: '奶茶夜', ops: [{ op: 'layout', set: { nope: 1 } }] })).toContain('nope');
        expect(err({ template: '奶茶夜', ops: [{ op: 'layout', set: { chatAvatarShape: 'hexagon' } }] })).toContain('無效');
        expect(err({ template: '奶茶夜', ops: [{ op: 'css', css: 'body{display:none}' }] })).toContain('CSS 有問題');
        expect(err({ target: '全局', ops: [{ op: 'follow' }] })).toContain('全局');
        expect(err({ target: '阿澈', ops: [{ op: 'use_template', template: '奶茶夜' }, { op: 'sound', src: 'ding' }] })).toContain('單獨');
        expect(err({ template: '奶茶夜', ops: [{ op: 'sound', src: 'https://x/a.mp3' }] })).toContain('內建');
    });

    it('預覽：套用後與原本', () => {
        const { data } = setup();
        const built = buildDecorationProposal({ target: '小白', ops: [{ op: 'use_template', template: '奶茶夜' }] }, data);
        if ('errors' in built) throw new Error(built.errors.join());
        const p = asProposal(built.draft);
        expect(decorationPreviewSim(p, data, 'after')?.simChar.bubbleStyle).toBe('milk');
        expect(decorationPreviewSim(p, data, 'before')?.simChar.bubbleStyle).toBeUndefined();
    });
});

export type { DecorationTemplate };
