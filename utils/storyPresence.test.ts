import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, StoryTheaterMask, UserProfile } from '../types';
import {
    defaultWriterKeys, joinPresentNames, lastRecordedPresent, messageWriters, normalizePresenceSelections, presenceChangeNote, presenceCharacterIds,
    presenceMetadata, resolveStoryPresence, resolveWriters, storyPresenceSelections, storyPromptIdentityName, storyYouLabel, togglePresenceSelection,
} from './storyPresence';
import {
    BUILTIN_NIGHT_SCREENING_PRESET, buildStoryIdentityGuard, buildTheaterPersona, buildTheaterPersonas, compileStoryPreset, formatStoryHistoryText,
    formatStoryTheaterExport, normalizeStoryTheater, createStoryTheaterDraft, resolveStoryTheaterMask, storyTheaterMemoryRecipientIds,
} from './storyTheater';
import { REAL_IDENTITY_PERSONA_ID } from './userPersona';

// 劇情裡好幾個「你」同場（plans/story-multi-persona.md 第 1 批）

const base = {
    name: 'Liora', avatar: 'real.png', bio: '真實的我',
    activePersonaId: 'sis',
    personas: [
        { id: 'sis', name: '妹妹', avatar: 'sis.png', bio: '大學生', customSetting: '怕冷', otherDetails: '住台北' },
        { id: 'elder', name: '姊姊', avatar: 'elder.png', bio: '上班族' },
    ],
} as unknown as UserProfile;
const characters = [
    { id: 'c1', name: '阿澈', avatar: 'c1.png', description: '男友', systemPrompt: '沉穩', worldview: '現代' },
    { id: 'c2', name: '小雨', avatar: 'c2.png', description: '同學', systemPrompt: '', worldview: '' },
] as unknown as CharacterProfile[];
const masks = [{ id: 'm1', name: '旅人', avatar: '', description: '路過的人', coreInstruction: '寡言', worldview: '', createdAt: 1, updatedAt: 1 }] as StoryTheaterMask[];
const names = (entry: Parameters<typeof resolveStoryPresence>[0]) => resolveStoryPresence(entry, base, characters, masks).map(p => p.name);
const userMsg = (id: number, metadata: Record<string, unknown> = {}): Message => ({ id, charId: 't', role: 'user', type: 'text', content: `第 ${id} 段`, timestamp: id, metadata: { source: 'story_theater', ...metadata } } as Message);

describe('在場的你：解析', () => {
    it('舊劇情沒有 presence：讀 mask 當成一個；舊的「本人」是全域當前那張卡', () => {
        expect(storyPresenceSelections({ mask: { type: 'custom', id: 'm1' } })).toEqual([{ type: 'custom', id: 'm1' }]);
        expect(storyPresenceSelections({})).toEqual([{ type: 'user' }]);
        const [you] = resolveStoryPresence({ mask: { type: 'user' } }, base, characters, masks);
        expect(you).toMatchObject({ key: 'persona:sis', kind: 'persona', personaKey: 'sis', name: '妹妹', description: '大學生', extra: '怕冷\n住台北' });
    });
    it('好幾個混著選：身份卡、你演的角色、面具；同一個人只算一次', () => {
        const entry = { presence: [{ type: 'user' }, { type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }, { type: 'character', id: 'c2' }, { type: 'custom', id: 'm1' }, { type: 'persona', key: REAL_IDENTITY_PERSONA_ID }] as any };
        expect(names(entry)).toEqual(['妹妹', '姊姊', '小雨', '旅人', 'Liora']);
        expect(resolveStoryPresence(entry, base, characters, masks).map(p => p.key)).toEqual(['persona:sis', 'persona:elder', 'char:c2', 'mask:m1', `persona:${REAL_IDENTITY_PERSONA_ID}`]);
        expect(presenceCharacterIds(entry)).toEqual(['c2']);
    });
    it('刪掉的卡、角色、面具濾掉；濾到一個都不剩就回到全域那張；本來就空的是旁觀', () => {
        expect(names({ presence: [{ type: 'persona', key: 'gone' }, { type: 'persona', key: 'elder' }] })).toEqual(['姊姊']);
        expect(names({ presence: [{ type: 'persona', key: 'gone' }, { type: 'character', id: 'x' }, { type: 'custom', id: 'x' }] })).toEqual(['妹妹']);
        expect(names({ presence: [] })).toEqual([]);
    });
    it('手改 JSON 的溫和補全：看不懂的丟掉、重複的去掉；不是陣列當沒設', () => {
        expect(normalizePresenceSelections([{ type: 'persona', key: 'a' }, { type: 'persona', key: 'a' }, { type: 'persona' }, null, { type: 'custom', id: 'm', extra: 1 }, { type: 'nope' }]))
            .toEqual([{ type: 'persona', key: 'a' }, { type: 'custom', id: 'm' }]);
        expect(normalizePresenceSelections(undefined)).toBeUndefined();
        expect(normalizePresenceSelections([])).toEqual([]);
    });
    it('劇情正規化：presence 留著、舊 mask 跟著是第一位；寫進角色記憶的還是只能本人', () => {
        const draft = createStoryTheaterDraft(1);
        const multi = normalizeStoryTheater({ ...draft, presence: [{ type: 'persona', key: 'elder' }, { type: 'character', id: 'c2' }] });
        expect(multi.presence).toEqual([{ type: 'persona', key: 'elder' }, { type: 'character', id: 'c2' }]);
        expect(multi.mask).toEqual({ type: 'persona', key: 'elder' });
        expect(storyTheaterMemoryRecipientIds({ ...multi, characterIds: ['c1'] })).toEqual(['c1', 'c2']);
        expect(normalizeStoryTheater({ ...draft, presence: [] })).toMatchObject({ presence: [], mask: { type: 'user' } });
        const real = normalizeStoryTheater({ ...draft, writesToCharacterMemory: true, presence: [{ type: 'persona', key: 'elder' }] });
        expect(real.presence).toBeUndefined();
        expect(real.mask).toEqual({ type: 'user' });
        expect(normalizeStoryTheater({ ...draft, mask: { type: 'custom', id: 'm1' } }).presence).toBeUndefined();
    });
});

describe('多選頁點一下', () => {
    it('有就拿掉、沒有就加上；舊的「本人」改寫成點名的卡，跟點同一張卡算同一個', () => {
        const added = togglePresenceSelection([{ type: 'user' }], { type: 'persona', key: 'elder' }, base);
        expect(added).toEqual([{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }]);
        expect(togglePresenceSelection(added, { type: 'persona', key: 'sis' }, base)).toEqual([{ type: 'persona', key: 'elder' }]);
        expect(togglePresenceSelection([{ type: 'user' }], { type: 'persona', key: 'sis' }, base)).toEqual([]);
        expect(togglePresenceSelection([], { type: 'custom', id: 'm1' }, base)).toEqual([{ type: 'custom', id: 'm1' }]);
    });
});

describe('稱呼', () => {
    const resolve = (presence: any[]) => resolveStoryPresence({ presence }, base, characters, masks);
    it('提示詞裡的名字：一位照舊、好幾位用頓號接、旁觀是作者', () => {
        expect(storyPromptIdentityName(resolve([{ type: 'persona', key: 'sis' }]))).toBe('妹妹');
        expect(storyPromptIdentityName([{ name: '你' }])).toBe('當前用戶側角色');
        expect(storyPromptIdentityName(resolve([{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }]))).toBe('妹妹、姊姊');
        expect(storyPromptIdentityName([])).toBe('作者');
        expect(joinPresentNames([' 甲 ', '', '乙'])).toBe('甲、乙');
    });
    it('畫面上「你」那格', () => {
        expect(storyYouLabel(resolveStoryPresence({ mask: { type: 'user' } }, base, characters, masks))).toBe('你');
        expect(storyYouLabel(resolve([{ type: 'persona', key: 'elder' }]))).toBe('你（姊姊）');
        expect(storyYouLabel(resolve([{ type: 'persona', key: 'sis' }, { type: 'custom', id: 'm1' }]))).toBe('你（妹妹、旅人）');
        expect(storyYouLabel([])).toBe('旁觀');
    });
});

describe('這段是誰、在場有沒有換', () => {
    const two = resolveStoryPresence({ presence: [{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }] }, base, characters, masks);
    const [sis, elder] = two;
    it('預設照上一段寫的那幾位（還在場的）；第一段、或他們都走了就是全部', () => {
        expect(defaultWriterKeys(two, [])).toEqual(['persona:sis', 'persona:elder']);
        const msgs = [userMsg(1, presenceMetadata(two, [elder])), userMsg(2, { theaterContinue: true })];
        expect(defaultWriterKeys(two, msgs)).toEqual(['persona:elder']);
        expect(defaultWriterKeys([sis], msgs)).toEqual(['persona:sis']);
        expect(resolveWriters(two, ['persona:elder', 'persona:gone']).map(p => p.name)).toEqual(['姊姊']);
        expect(resolveWriters(two, []).map(p => p.name)).toEqual(['妹妹', '姊姊']);
    });
    it('記在訊息上的在場與執筆者讀得回來；舊訊息沒記是 undefined，旁觀時記的是空的', () => {
        expect(messageWriters(userMsg(1, presenceMetadata(two, [sis])))).toEqual([{ key: 'persona:sis', name: '妹妹' }]);
        expect(messageWriters(userMsg(1))).toBeUndefined();
        expect(messageWriters(userMsg(1, presenceMetadata([], [])))).toEqual([]);
        expect(lastRecordedPresent([userMsg(1, presenceMetadata(two, two)), { role: 'assistant', metadata: {} } as any])).toHaveLength(2);
    });
    it('在場換了才提醒，而且說清楚誰走了誰來了；沒記過不提醒', () => {
        const before = presenceMetadata(two, two).theaterPresent;
        expect(presenceChangeNote(before, two)).toBe('');
        expect(presenceChangeNote(undefined, [sis])).toBe('');
        const left = presenceChangeNote(before, [sis]);
        expect(left).toContain('「姊姊」這一輪起不在場');
        expect(left).not.toContain('起在場');
        const joined = presenceChangeNote(presenceMetadata([sis], [sis]).theaterPresent, two);
        expect(joined).toContain('「姊姊」這一輪起在場');
        expect(presenceChangeNote(before, [])).toContain('現在沒有用戶側的人物在場');
    });
});

describe('提示詞', () => {
    const one = (selection: any) => resolveStoryPresence({ presence: [selection] }, base, characters, masks);
    it('只有一位、沒填補充設定：跟以前一字不差（三種身份都是）', () => {
        const plain = { ...base, personas: base.personas!.map(p => ({ ...p, customSetting: undefined, otherDetails: undefined })) } as UserProfile;
        const applied = { ...plain, name: '妹妹', avatar: 'sis.png', bio: '大學生' } as UserProfile;
        expect(buildTheaterPersonas(resolveStoryPresence({ mask: { type: 'user' } }, plain, characters, masks)))
            .toBe(buildTheaterPersona(resolveStoryTheaterMask({ type: 'user' }, applied, characters, masks)));
        for (const selection of [{ type: 'character', id: 'c1' }, { type: 'custom', id: 'm1' }] as const) {
            expect(buildTheaterPersonas(one(selection))).toBe(buildTheaterPersona(resolveStoryTheaterMask(selection, applied, characters, masks)));
        }
    });
    it('填了補充設定才多一行', () => {
        const text = buildTheaterPersonas(one({ type: 'persona', key: 'sis' }));
        expect(text).toContain('- 身份/外在設定：大學生\n- 補充設定：\n怕冷\n住台北\n');
    });
    it('好幾位：每位一塊，不准代寫改成複數；旁觀：沒有用戶側的人物', () => {
        const text = buildTheaterPersonas(resolveStoryPresence({ presence: [{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }, { type: 'custom', id: 'm1' }] }, base, characters, masks));
        expect(text).toContain('### 當前用戶側執筆身份（共 3 位，是不同的人）');
        expect(text).toContain('#### 「妹妹」\n- 身份/外在設定：大學生\n- 補充設定：\n怕冷\n住台北\n#### 「姊姊」\n- 身份/外在設定：上班族\n#### 「旅人」\n- 身份/外在設定：路過的人\n- 核心性格與行動邊界：\n寡言\n');
        expect(text).toContain('續寫不得把其中任何一位當作普通角色擅自決定重大選擇');
        expect(text).not.toMatch(/\n\n/);
        const lurking = buildTheaterPersonas([]);
        expect(lurking).toContain('沒有用戶側的人物在場');
        expect(lurking).not.toContain('- 名字：');
    });
    it('身份守門：一位照舊；好幾位、旁觀各有自己的寫法', () => {
        const doc = BUILTIN_NIGHT_SCREENING_PRESET.document;
        expect(buildStoryIdentityGuard(doc, '妹妹', ['阿澈'], ['妹妹'])).toBe(buildStoryIdentityGuard(doc, '妹妹', ['阿澈']));
        const multi = buildStoryIdentityGuard(doc, '妹妹、姊姊', ['阿澈'], ['妹妹', '姊姊']);
        expect(multi).toContain('用戶側劇情身份共 2 位：「妹妹」「姊姊」，是不同的人');
        expect(multi).toContain('不得用未點名的“你／你的”籠統指代');
        const lurking = buildStoryIdentityGuard(doc, '作者', ['阿澈'], []);
        expect(lurking).toContain('沒有用戶側的劇情身份在場');
        expect(lurking).toContain('關係協議中的 U 這一輪不存在');
    });
    it('巨集：{{user}}／{{users}} 是在場的名字，{{user_count}} 是幾位；不給就是 1', () => {
        const preset = { ...BUILTIN_NIGHT_SCREENING_PRESET, document: { ...BUILTIN_NIGHT_SCREENING_PRESET.document, prompts: [{ id: 'x', name: 'x', role: 'system', enabled: true, content: '在場：{{users}}（{{user_count}} 位），不得替{{user}}做決定' }] } } as any;
        const slots = { actors: '', persona: '', scenario: '', worldBefore: '', worldAfter: '', history: '' };
        const text = (count?: number) => compileStoryPreset({ preset, slots, userName: '妹妹、姊姊', characterNames: ['阿澈'], ...(count === undefined ? {} : { userCount: count }) }).messages.map(m => m.content).join('\n');
        expect(text(2)).toContain('在場：妹妹、姊姊（2 位），不得替妹妹、姊姊做決定');
        expect(text()).toContain('（1 位）');
    });
    it('歷史：舊訊息照現在的稱呼（跟以前一樣）；記了執筆者的寫名字；旁觀時寫的標作者', () => {
        const two = resolveStoryPresence({ presence: [{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }] }, base, characters, masks);
        const history = formatStoryHistoryText([
            userMsg(1),
            { ...userMsg(2), role: 'assistant', content: '正文' } as Message,
            userMsg(3, presenceMetadata(two, [two[1]])),
            userMsg(4, presenceMetadata(two, two)),
            userMsg(5, presenceMetadata([], [])),
            userMsg(6, { theaterArchived: true }),
        ], '妹妹');
        expect(history).toBe([
            '[妹妹給出的推進（用戶側）]\n第 1 段',
            '[上一層劇場正文]\n正文',
            '[姊姊給出的推進（用戶側）]\n第 3 段',
            '[妹妹、姊姊給出的推進（用戶側）]\n第 4 段',
            '[作者給出的推進（旁白與導演指示，不是故事裡的人）]\n第 5 段',
        ].join('\n\n'));
    });
    it('匯出：每段照執筆者標名字', () => {
        const two = resolveStoryPresence({ presence: [{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }] }, base, characters, masks);
        const text = formatStoryTheaterExport({ title: '出門', premise: '', writesToCharacterMemory: false }, '妹妹、姊姊', ['阿澈'], [userMsg(1), userMsg(2, presenceMetadata(two, [two[1]]))], 0);
        expect(text).toContain('你：妹妹、姊姊');
        expect(text).toMatch(/\] 妹妹、姊姊\n第 1 段/);
        expect(text).toMatch(/\] 姊姊\n第 2 段/);
    });
});
