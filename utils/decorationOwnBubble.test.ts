import { describe, it, expect } from 'vitest';
import {
    characterPatchFromDraft,
    detachCharacterPatch,
    followTemplateBubblePatch,
    keepOwnBubble,
    ownBubblePatch,
} from './decorationTemplates';
import { lineView, linePatchForChar } from './chatLine';

const tpl = { id: 't1', bubbleThemeId: 'tpl-bubble', css: '.x{}' } as any;
const bound = { id: 'c1', name: 'A', decorationTemplateId: 't1', bubbleStyle: 'tpl-bubble', chromeCustomCss: '.x{}' } as any;

describe('角色自己的氣泡蓋在模板上', () => {
    it('綁模板時換氣泡：只換氣泡、模板留著', () => {
        const patch = detachCharacterPatch(bound, ownBubblePatch(bound, 'mine'));
        expect(patch).toEqual({ bubbleStyle: 'mine', bubbleOwn: true });
    });

    it('沒綁模板時換氣泡：就是自訂，不記 bubbleOwn', () => {
        expect(ownBubblePatch({}, 'mine')).toEqual({ bubbleStyle: 'mine', bubbleOwn: undefined });
    });

    it('舊的寫法（只給 bubbleStyle）照舊解除綁定', () => {
        expect(detachCharacterPatch(bound, { bubbleStyle: 'other' })).toEqual({ bubbleStyle: 'other', decorationTemplateId: undefined });
    });

    it('改寫或重套模板時，自己挑的氣泡留著', () => {
        const own = { ...bound, bubbleStyle: 'mine', bubbleOwn: true };
        const patch = detachCharacterPatch(own, characterPatchFromDraft(tpl, 't1'));
        expect(patch.bubbleStyle).toBe('mine');
        expect(patch.bubbleOwn).toBe(true);
        expect(patch.decorationTemplateId).toBe('t1');
        expect(patch.chromeCustomCss).toBe('.x{}');
    });

    it('換成別份模板：跟新模板的氣泡走', () => {
        const own = { ...bound, bubbleStyle: 'mine', bubbleOwn: true };
        const patch = detachCharacterPatch(own, characterPatchFromDraft({ bubbleThemeId: 't2-bubble' } as any, 't2'));
        expect(patch.bubbleStyle).toBe('t2-bubble');
        expect(patch.bubbleOwn).toBeUndefined();
    });

    it('沒自己挑氣泡的照模板寫', () => {
        const patch = detachCharacterPatch(bound, characterPatchFromDraft({ ...tpl, bubbleThemeId: 'new' }, 't1'));
        expect(patch.bubbleStyle).toBe('new');
        expect(patch.bubbleOwn).toBeUndefined();
    });

    it('存成自訂（沒有模板 id）：氣泡是草稿裡的，bubbleOwn 清掉', () => {
        const own = { ...bound, bubbleStyle: 'mine', bubbleOwn: true };
        const patch = detachCharacterPatch(own, characterPatchFromDraft({ bubbleThemeId: 'mine' }));
        expect(patch.bubbleStyle).toBe('mine');
        expect(patch.bubbleOwn).toBeUndefined();
        expect(patch.decorationTemplateId).toBeUndefined();
    });

    it('回到跟著模板：氣泡換回模板的、模板留著', () => {
        const own = { ...bound, bubbleStyle: 'mine', bubbleOwn: true };
        expect(detachCharacterPatch(own, followTemplateBubblePatch(tpl))).toEqual({ bubbleStyle: 'tpl-bubble', bubbleOwn: undefined });
    });

    it('非主線也有自己的氣泡，模板寫穿時留著', () => {
        const char = { ...bound, lines: { pB: { decorationTemplateId: 't1', bubbleStyle: 'line-mine', bubbleOwn: true } } } as any;
        const line = { charId: 'c1', personaKey: 'pB' };
        const view = lineView(char, line);
        const patch = linePatchForChar(char, line, keepOwnBubble(view, characterPatchFromDraft(tpl, 't1')));
        expect((patch.lines as any).pB.bubbleStyle).toBe('line-mine');
        expect((patch.lines as any).pB.bubbleOwn).toBe(true);
    });
});
