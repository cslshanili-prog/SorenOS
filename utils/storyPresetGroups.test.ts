import { describe, expect, it } from 'vitest';
import { addStoryPresetGroup, renameStoryPresetGroup, ungroupStoryPresetGroup, moveStoryPresetPromptToGroup, getStoryPresetPromptGroups, createBlankStoryPreset, parseStoryTheaterPreset, compileStoryPreset, BUILTIN_NIGHT_SCREENING_PRESET, duplicateStoryPreset } from './storyTheater';

describe('劇情自定義大區', () => {
    it('空分組可保存、改名、導出導入，移動條目後正文只發送一次', () => {
        let preset = createBlankStoryPreset();
        preset.document = addStoryPresetGroup(preset.document, '我的文風');
        const group = getStoryPresetPromptGroups(preset.document).at(-1)!;
        expect(group.label).toBe('我的文風');
        preset.document = moveStoryPresetPromptToGroup(preset.document, preset.document.prompts[0].id, group.key);
        preset.document = renameStoryPresetGroup(preset.document, group.customSectionId!, '寫作習慣');
        const imported = parseStoryTheaterPreset(JSON.stringify(preset.document), 'test.json');
        expect(getStoryPresetPromptGroups(imported.document).at(-1)?.label).toBe('寫作習慣');
        const compiled = compileStoryPreset({ preset: imported, userName: '用戶', characterNames: ['角色'], slots: { actors: '角色資料', persona: '', scenario: '', worldBefore: '', worldAfter: '', history: '' } });
        const text = JSON.stringify(compiled.messages);
        expect(text).not.toContain('寫作習慣');
        expect(text.match(/直接[续續][写寫][连連][续續]的第三人[称稱]故事/g)).toHaveLength(1);
        const ungrouped = ungroupStoryPresetGroup(imported.document, group.customSectionId!);
        expect(ungrouped.prompts).toHaveLength(6);
        expect(ungrouped.prompts.some(prompt => prompt.content.includes('直接續寫'))).toBe(true);
    });
    it('保留內置區的保護規則，不允許把系統連接位移出或將普通條目移入', () => {
        const doc = addStoryPresetGroup(duplicateStoryPreset(BUILTIN_NIGHT_SCREENING_PRESET).document, '自定義');
        const groups = getStoryPresetPromptGroups(doc);
        const protectedGroup = groups.find(group => group.protected)!;
        const custom = groups.at(-1)!;
        const protectedId = protectedGroup.promptIds[1];
        expect(moveStoryPresetPromptToGroup(doc, protectedId, custom.key)).toBe(doc);
        expect(moveStoryPresetPromptToGroup(doc, doc.prompts.find(prompt => prompt.content && !prompt.marker)!.id, protectedGroup.key)).toBe(doc);
    });
});
