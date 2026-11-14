import { describe, expect, it } from 'vitest';
import type { AssistantPresetBinding, AssistantPresetProposal, StoryTheaterPreset } from '../../types';
import type { MeetingPresetDoc, MeetingPresetRecord } from '../meetingPreset/types';
import { applyGeneralOps, applyStoryOps, buildNewPreset, describePreset, describePresetList, findPreset, parseBindings, type PresetData, presetUsage } from './presetOps';
import { applyPresetProposal, presetChangedSinceApply, type PresetWriter, restorePresetProposal } from './applyProposal';
import { findSoreTool, type SoreToolContext } from './tools';
import { BUILTIN_NIGHT_SCREENING_PRESET } from '../storyTheater';

const doc = (): MeetingPresetDoc => ({
    schema: 'soren.meeting-preset', version: 1, name: '夜貓', generation: { temperature: 1 },
    prompts: [
        { id: 'main', name: '主提示', enabled: true, role: 'system', content: '你是{{char}}。' },
        { id: 'style', name: '文風', enabled: true, role: 'system', content: '寫得短一點。' },
        { id: 'emoji', name: '表情包', enabled: true, role: 'system', content: '', slot: 'chatEmoji' },
        { id: 'hist', name: '聊天記錄', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
    ],
    regexScripts: [{ id: 'r1', scriptName: '去星號', findRegex: '/\\*/g', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null }],
    groups: [{ id: 'g', name: '主要', promptIds: ['main', 'style'] }],
    globalVars: {}, scenes: ['chat'],
});

const record = (): MeetingPresetRecord => ({ id: 'mp1', name: '夜貓', doc: doc(), createdAt: 1, updatedAt: 1 });
const story = (): StoryTheaterPreset => ({ ...BUILTIN_NIGHT_SCREENING_PRESET, id: 'st1', name: '我的劇情', builtIn: false, document: { ...BUILTIN_NIGHT_SCREENING_PRESET.document, name: '我的劇情' } });

const makeData = (): PresetData => ({
    general: [record()],
    story: [story()],
    characters: [{ id: 'c1', name: '阿澈', chatPresetId: 'mp1' }, { id: 'c2', name: '小遙' }],
    groups: [{ id: 'g1', name: '週末群', presetId: 'mp1' }],
    storyTheaters: [{ id: 't1', title: '雨夜', presetId: 'st1' }],
    sceneDefaults: { chat: 'mp1' },
});

describe('找預設、誰在用、概況', () => {
    it('名字或 id；內建要先複製', () => {
        expect(findPreset('夜貓', makeData())).toMatchObject({ kind: 'general' });
        expect(findPreset('st1', makeData())).toMatchObject({ kind: 'story', builtIn: false });
        expect(findPreset(BUILTIN_NIGHT_SCREENING_PRESET.id, makeData())).toMatchObject({ builtIn: true });
        expect(findPreset('內建', makeData())).toHaveProperty('error');
    });
    it('誰在用', () => {
        expect(presetUsage('mp1', makeData())).toEqual(['私聊場景預設', '阿澈的私聊', '群「週末群」']);
        expect(presetUsage('st1', makeData())).toEqual(['劇情「雨夜」']);
    });
    it('概況不含全文、標出資料佔位和功能', () => {
        const text = describePreset(findPreset('mp1', makeData()) as any, makeData());
        expect(text).toContain('id=emoji「表情包」 Soren 功能');
        expect(text).toContain('資料佔位 · 聊天記錄');
        expect(text).not.toContain('寫得短一點');
        expect(text).toContain('正則（只在見面生效');
        expect(describePresetList(makeData())).toContain('在用：私聊場景預設、阿澈的私聊、群「週末群」');
    });
});

describe('套用操作', () => {
    it('改內容、關功能、加條目、刪、排、參數、正則', () => {
        const r = applyGeneralOps(doc(), [
            { op: 'edit', entry: '文風', content: '寫得更短。' },
            { op: 'edit', entry: 'emoji', enabled: false },
            { op: 'add', name: '禁詞', content: '不要說「然而」。', after: '文風' },
            { op: 'move', entry: '主提示', after: '禁詞' },
            { op: 'params', temperature: 0.8, maxTokens: '1200' },
            { op: 'addRegex', name: '去括號', find: '/（.*?）/g', placement: ['ai'] },
            { op: 'editRegex', regex: '去星號', disabled: true },
        ]);
        expect(r.errors).toEqual([]);
        expect(r.doc.prompts.map(p => p.name)).toEqual(['文風', '禁詞', '主提示', '表情包', '聊天記錄']);
        expect(r.doc.prompts.find(p => p.id === 'emoji')?.enabled).toBe(false);
        expect(r.doc.groups[0].promptIds).toEqual(['style', expect.stringMatching(/^sore_/), 'main']);
        expect(r.doc.generation).toMatchObject({ temperature: 0.8, maxTokens: 1200 });
        expect(r.doc.regexScripts).toHaveLength(2);
        expect(r.doc.regexScripts[0].disabled).toBe(true);
        expect(r.changes.find(c => c.label.includes('文風'))).toMatchObject({ before: '寫得短一點。', after: '寫得更短。' });
        expect(r.changes.some(c => c.label.includes('關掉「表情包」'))).toBe(true);
        expect(doc().prompts[1].content).toBe('寫得短一點。');
    });
    it('資料佔位不能改內容、不能刪；壞正則擋下', () => {
        expect(applyGeneralOps(doc(), [{ op: 'edit', entry: 'hist', content: 'x' }]).errors[0]).toContain('只能開關');
        expect(applyGeneralOps(doc(), [{ op: 'remove', entry: 'hist' }]).errors[0]).toContain('不能刪');
        expect(applyGeneralOps(doc(), [{ op: 'addRegex', name: 'x', find: '/(/g' }]).errors[0]).toContain('不是能用的正則');
        expect(applyGeneralOps(doc(), [{ op: 'nope' }]).errors[0]).toContain('不認得');
    });
    it('新條目沒給位置就放在聊天記錄前面', () => {
        const r = applyGeneralOps(doc(), [{ op: 'add', name: '新', content: 'x' }]);
        expect(r.doc.prompts.map(p => p.name)).toEqual(['主提示', '文風', '表情包', '新', '聊天記錄']);
    });
    it('劇情預設只能改內容和開關', () => {
        const s = story().document;
        const editable = s.prompts.find(p => !p.marker && !p.section)!;
        const ok = applyStoryOps(s, [{ op: 'edit', entry: editable.id, content: '新內容' }, { op: 'params', temperature: 0.5 }]);
        expect(ok.errors).toEqual([]);
        expect(ok.doc.prompts.find(p => p.id === editable.id)?.content).toBe('新內容');
        expect(applyStoryOps(s, [{ op: 'add', name: 'x', content: 'y' }]).errors[0]).toContain('劇情預設只能用');
        expect(applyStoryOps(s, [{ op: 'edit', entry: editable.id, name: 'x' }]).errors[0]).toContain('只能改內容和開關');
    });
    it('從內建複製', () => {
        const chat = buildNewPreset('私聊內建', '我的私聊', makeData());
        expect(chat).toMatchObject({ kind: 'general' });
        expect((chat as any).doc.name).toBe('我的私聊');
        expect(buildNewPreset('劇情內建', '', makeData())).toMatchObject({ kind: 'story' });
        expect(buildNewPreset('夜貓', '', makeData())).toMatchObject({ kind: 'general' });
        expect(buildNewPreset('不存在', '', makeData())).toHaveProperty('error');
    });
    it('綁定：劇情只能設劇情場景；角色同名要 id', () => {
        expect(parseBindings({ scenes: ['私聊'], chars: [{ name: '小遙', for: 'call' }], groups: ['週末群'] }, 'general', makeData()))
            .toMatchObject({ bindings: [{ kind: 'scene', scene: 'chat' }, { kind: 'char', charId: 'c2', field: 'call' }, { kind: 'group', groupId: 'g1' }] });
        expect(parseBindings({ scenes: ['story'] }, 'general', makeData())).toHaveProperty('error');
        expect(parseBindings({ chars: ['阿澈'] }, 'story', makeData())).toHaveProperty('error');
    });
});

describe('提案套用與還原', () => {
    const fakeWriter = (data: PresetData) => {
        const w: PresetWriter = {
            saveGeneral: r => { data.general = [...data.general.filter(x => x.id !== r.id), r]; },
            deleteGeneral: id => { data.general = data.general.filter(x => x.id !== id); },
            saveStory: p => { data.story = [...data.story.filter(x => x.id !== p.id), p]; },
            deleteStory: id => { data.story = data.story.filter(x => x.id !== id); },
            setBinding: (b: AssistantPresetBinding, v) => {
                if (b.kind === 'scene') data.sceneDefaults = { ...data.sceneDefaults, [b.scene]: v };
                else if (b.kind === 'group') data.groups = data.groups.map(g => (g.id === b.groupId ? { ...g, presetId: v } : g));
                else data.characters = data.characters.map(c => (c.id === b.charId ? { ...c, [b.field === 'chat' ? 'chatPresetId' : b.field === 'call' ? 'callPresetId' : 'dateMeetingPresetId']: v } : c));
            },
        };
        return w;
    };
    const ctxOf = (data: PresetData): SoreToolContext => ({
        settings: async () => { throw new Error('unused'); },
        testApi: async () => ({ ok: true, message: '' }),
        presetData: async () => data,
    });

    it('改預設：套用寫進去，還原整份寫回', async () => {
        const data = makeData();
        const result = await findSoreTool('改預設')!.run({ preset: '夜貓', ops: [{ op: 'edit', entry: '文風', content: '更短' }], summary: '文風改短' }, ctxOf(data));
        expect(result.ok).toBe(true);
        const proposal = { ...result.proposal!, id: 'p', status: 'pending' } as AssistantPresetProposal;
        expect(proposal.usage).toEqual(['私聊場景預設', '阿澈的私聊', '群「週末群」']);
        const applied = await applyPresetProposal(proposal, data, fakeWriter(data));
        expect(data.general[0].doc.prompts[1].content).toBe('更短');
        expect(presetChangedSinceApply(applied, data)).toBe(false);
        await restorePresetProposal(applied, data, fakeWriter(data));
        expect(data.general[0].doc.prompts[1].content).toBe('寫得短一點。');
    });
    it('新建＋設成群聊場景預設：適用場景自動勾上；還原刪掉、設回原本的', async () => {
        const data = makeData();
        const result = await findSoreTool('新建預設')!.run({ from: '群聊內建', name: '熱鬧群', use: { scenes: ['group'], chars: [{ name: '阿澈', for: 'call' }] } }, ctxOf(data));
        expect(result.ok).toBe(true);
        const proposal = { ...result.proposal!, id: 'p', status: 'pending' } as AssistantPresetProposal;
        expect(proposal.isNew).toBe(true);
        const applied = await applyPresetProposal(proposal, data, fakeWriter(data));
        const created = data.general.find(r => r.id === proposal.presetId)!;
        expect(created.name).toBe('熱鬧群');
        expect(data.sceneDefaults.group).toBe(proposal.presetId);
        expect(data.characters[0].callPresetId).toBe(proposal.presetId);
        await restorePresetProposal(applied, data, fakeWriter(data));
        expect(data.general.some(r => r.id === proposal.presetId)).toBe(false);
        expect(data.sceneDefaults.group).toBeUndefined();
        expect(data.characters[0].callPresetId).toBeUndefined();
    });
    it('設成通用預設時適用場景沒勾就補上', async () => {
        const data = makeData();
        const result = await findSoreTool('設定預設用途')!.run({ preset: '夜貓', use: { groups: ['週末群'], scenes: ['date'] } }, ctxOf(data));
        const proposal = result.proposal as AssistantPresetProposal;
        expect(proposal.changes.some(c => c.label.includes('適用場景加上：見面'))).toBe(true);
    });
    it('設定預設用途：內建', async () => {
        const data = makeData();
        const result = await findSoreTool('設定預設用途')!.run({ preset: '內建', use: { scenes: ['chat'], chars: [{ name: '阿澈', for: 'chat' }] } }, ctxOf(data));
        const proposal = { ...result.proposal!, id: 'p', status: 'pending' } as AssistantPresetProposal;
        await applyPresetProposal(proposal, data, fakeWriter(data));
        expect(data.sceneDefaults.chat).toBeUndefined();
        expect(data.characters[0].chatPresetId).toBe('builtin');
    });
    it('內建劇情預設不能直接改；操作出錯不出卡片', async () => {
        const data = makeData();
        expect((await findSoreTool('改預設')!.run({ preset: BUILTIN_NIGHT_SCREENING_PRESET.id, ops: [] }, ctxOf(data))).content).toContain('內建劇情預設不能直接改');
        const bad = await findSoreTool('改預設')!.run({ preset: '夜貓', ops: [{ op: 'remove', entry: 'hist' }] }, ctxOf(data));
        expect(bad.ok).toBe(false);
        expect(bad.proposal).toBeUndefined();
    });
});
