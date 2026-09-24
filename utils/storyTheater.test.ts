import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, NPCProfile, StoryTheaterPreset, UserProfile } from '../types';
import { STORY_PRESET_SIMPLE_CHOICES } from '../components/date/story/StoryPresetMaker';
import {
    appendStoryAffinityInput,
    appendStoryAffinityInputs,
    appendStoryUserTurn,
    applyStoryPresetChoice,
    BUILTIN_NIGHT_SCREENING_PRESET,
    buildStoryMiniTheaterReminder,
    buildStoryActorMemoryEnvelope,
    buildStoryArchiveMemoryEnvelope,
    buildStoryAffinityAwarenessReminder,
    buildStoryBackstageAftermathReminder,
    buildStoryIdentityGuard,
    buildStoryPrefillInstruction,
    buildStoryMultiAffinityGuide,
    buildStoryWorldbookScanMessages,
    buildTheaterNpcContext,
    buildTheaterWorldbookSlots,
    compileStoryPreset,
    prepareStoryGenerationSettings,
    reconcileStoryAffinityScores,
    createBlankStoryPreset,
    createStoryTheaterDraft,
    dedupeTheaterWorldbooks,
    describeEmptyStoryCompletion,
    describeStoryApiError,
    getStoryPresetPromptGroups,
    getActiveStoryMiniTheaterPrompt,
    getPendingStoryRetryInput,
    isProtectedStoryPrompt,
    isStoryUserLastCompatibilityError,
    memoryTimestampForCharacter,
    parseStoryDisplayBlocks,
    parseStoryMiniTheater,
    parseStoryTheaterPreset,
    normalizeStoryTheater,
    REAL_COMPANION_MEMORY_GUARD,
    RELATIONSHIP_TEXTURE_GUIDE,
    resolveStoryPresetDocument,
    resolveStoryTheaterMask,
    selectStoryArchiveBatch,
    storyTheaterMemoryRecipientIds,
    formatActorRecentMessages,
    formatStoryTheaterExport,
    makeStoryPresetFileName,
    makeStoryTheaterFileName,
} from './storyTheater';

describe('劇情接口報錯診斷', () => {
    it('保留上游 400 的具體原因', () => {
        expect(describeStoryApiError(400, { error: { message: 'context_length_exceeded: maximum 32768' } }))
            .toBe('API Error 400：context_length_exceeded: maximum 32768');
        expect(describeStoryApiError(400, { error: '最後一條消息必須是 user' }))
            .toBe('API Error 400：最後一條消息必須是 user');
    });

    it('只在上游明確拒絕末條角色時建議 400 兼容模式', () => {
        expect(isStoryUserLastCompatibilityError('API Error 400: final message role must be user')).toBe(true);
        expect(isStoryUserLastCompatibilityError('API Error 400：最後一條消息必須是 user')).toBe(true);
        expect(isStoryUserLastCompatibilityError('API Error 400: context_length_exceeded')).toBe(false);
    });

    it('空正文會暴露 finish_reason，而不是統一叫用戶盲目重試', () => {
        expect(describeEmptyStoryCompletion({ choices: [{ finish_reason: 'length', message: { content: '' } }] }))
            .toContain('已用完輸出額度');
        expect(describeEmptyStoryCompletion({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }))
            .toContain('內容過濾');
        expect(describeEmptyStoryCompletion({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }))
            .toContain('finish_reason=stop');
    });
});

describe('劇情原文導出', () => {
    it('按原始樓層順序導出真實陪伴的完整推進與正文', () => {
        const output = formatStoryTheaterExport(
            { title: '雨夜', premise: '從車站開始', writesToCharacterMemory: true },
            '條條',
            ['林星', 'Noir'],
            [
                { id: 2, charId: 'story', role: 'assistant', type: 'text', content: '<story_text>他撐開傘。</story_text>', timestamp: 2 },
                { id: 1, charId: 'story', role: 'user', type: 'text', content: '走出車站。', timestamp: 1 },
            ] as Message[],
            new Date(2026, 7, 13, 20, 0, 0).getTime(),
        );

        expect(output).toContain('模式：真實時間陪伴');
        expect(output).toContain('角色：林星、Noir');
        expect(output.indexOf('走出車站。')).toBeLessThan(output.indexOf('<story_text>他撐開傘。</story_text>'));
        expect(makeStoryTheaterFileName('雨/夜', new Date(2026, 7, 13).getTime())).toBe('雨_夜_劇情記錄_2026-08-13.txt');
        expect(makeStoryPresetFileName('雨/夜：預設')).toBe('雨_夜：預設.json');
    });
});

describe('多人劇情記憶的人稱與歸屬', () => {
    it('把每位角色的召回包進具名專屬信封，並阻止把“你”重綁定到面具', () => {
        const result = buildStoryActorMemoryEnvelope('林星', '我記得你那天留下了傘。', '條條', 'Noir');

        expect(result).toContain('林星 的專屬既有記憶');
        expect(result).toContain('第一人稱“我/我的”，默認指「林星」');
        expect(result).toContain('第二人稱“你/你的”');
        expect(result).toContain('原互動對象「條條」');
        expect(result).toContain('不得因此把舊記憶裡的“你”從「條條」改綁到當前身份');
        expect(result).toContain('不得歸給、共享給或改寫成其他角色的親歷記憶');
    });

    it('近期原文顯式標出記憶中的你，不把 user 行偽裝成當前面具', () => {
        const actor = { id: 'lin', name: '林星' } as CharacterProfile;
        const messages = [
            { id: 1, charId: 'lin', role: 'user', type: 'text', content: '把傘遞給他。', timestamp: 1 },
            { id: 2, charId: 'lin', role: 'assistant', type: 'text', content: '我接住了。', timestamp: 2 },
        ] as Message[];

        const result = formatActorRecentMessages(actor, messages, '條條', 'Noir');
        expect(result).toContain('林星 最近攜帶的專屬原文上下文');
        expect(result).toContain('記憶中的你（條條）：把傘遞給他。');
        expect(result).toContain('林星：我接住了。');
        expect(result).toContain('不得把下列“記憶中的你”重新解釋成當前身份');
    });

    it('把獨立劇情向量召回標成共享檔案而不是某個角色的腦內記憶', () => {
        const result = buildStoryArchiveMemoryEnvelope('我在雨裡等你。');

        expect(result).toContain('本劇情共享檔案召回');
        expect(result).toContain('不屬於任何一位角色的個人記憶');
        expect(result).toContain('不得擅自把“我/你”歸給當前面具或任一角色');
    });
});

describe('糯米機原生劇情預設邊界', () => {
    it('內置 V6.27 已經是精簡的原生文檔', () => {
        const document = BUILTIN_NIGHT_SCREENING_PRESET.document;
        expect(document.schema).toBe('sullyos.story-preset');
        expect(document.version).toBe(1);
        expect(document.name).toContain('V6.27');
        expect(document.prompts).toHaveLength(130);
        expect(document.prompts.filter(prompt => prompt.enabled)).toHaveLength(53);
        const serialized = JSON.stringify(document);
        expect(serialized).not.toContain('prompt_order');
        expect(serialized).not.toContain('extensions');
        expect(serialized).not.toContain('openai_max_context');
        expect(serialized).not.toContain('{{setvar::');
        expect(serialized).not.toContain('{{getvar::');
    });

    it('默認開啟項都有真實發送內容或原生插槽，且關係與組合輸出協議沒有舊結構衝突', () => {
        const document = BUILTIN_NIGHT_SCREENING_PRESET.document;
        const enabled = document.prompts.filter(prompt => prompt.enabled);
        expect(new Set(document.prompts.map(prompt => prompt.id)).size).toBe(document.prompts.length);
        expect(enabled.every(prompt => Boolean(prompt.marker || prompt.content.trim()))).toBe(true);
        const affinity = document.prompts.find(prompt => prompt.id === 'nmj-v65-affinity-control')!;
        expect(affinity.content).toContain('<affinity_person>');
        expect(affinity.content).toContain('<character_id>');
        expect(affinity.content).toContain('<c_to_u_score>');
        expect(affinity.content).toContain('<trust>');
        expect(affinity.content).toContain('<repair_will>');
        expect(affinity.content).not.toContain('<c_score>');
        expect(affinity.content).not.toContain('<u_score>');
        const scene = document.prompts.find(prompt => prompt.id === 'nmj-v3-scene-header')!;
        expect(scene.content).toContain('幕後與餘波”（幕後暗格後緊接鏡頭債）');
        expect(scene.content).not.toContain('幕後暗格、世界線、鏡頭債');
        const exit = document.prompts.find(prompt => prompt.id === 'nmj-v3-exit-check')!;
        expect(exit.content).toContain('按 character_id 獨立續接 C→U、U→C 與五維狀態');
        expect(exit.content).toContain('幕後與餘波（幕後暗格 → 鏡頭債）');
        expect(exit.content).not.toContain('單一“當前 C”');
        expect(exit.content).not.toContain('幕後暗格 → 世界線 → 鏡頭債');
        const preflight = document.prompts.find(prompt => prompt.id === 'nmj-v616-silent-preflight')!;
        expect(preflight.content).toContain('按 character_id 逐人續接 C→U、U→C 與五維關係混音');
        expect(preflight.content).not.toContain('由酒館摺疊顯示');
    });

    it('舊 V6.14 快捷覆蓋只繼承開關，正文與新增層升級到 V6.27', () => {
        const legacyOverride = {
            ...BUILTIN_NIGHT_SCREENING_PRESET.document,
            name: '糯米雞｜夜班放映室 V6.14',
            prompts: BUILTIN_NIGHT_SCREENING_PRESET.document.prompts
                .filter(prompt => prompt.id !== 'nmj-v616-silent-preflight')
                .map(prompt => prompt.id === 'nmj-v3-pov-second' ? { ...prompt, enabled: false, content: '舊第二人稱正文' }
                    : prompt.id === 'nmj-v3-pov-third' ? { ...prompt, enabled: true, content: '舊第三人稱正文' }
                        : prompt),
        };
        const resolved = resolveStoryPresetDocument(BUILTIN_NIGHT_SCREENING_PRESET, legacyOverride);
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v3-pov-second')).toMatchObject({ enabled: false });
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v3-pov-third')).toMatchObject({ enabled: true });
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v3-pov-third')?.content).toContain('本條與“第二人稱”誤同時開啟時，本條優先');
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v616-silent-preflight')?.enabled).toBe(true);
    });

    it('拒絕其它應用的 prompt/completion JSON', () => {
        expect(() => parseStoryTheaterPreset(JSON.stringify({ prompts: [], prompt_order: [] }), 'foreign.json')).toThrow('只接受糯米機劇情預設');
        expect(() => parseStoryTheaterPreset(JSON.stringify({ model: 'x', messages: [] }), 'completion.json')).toThrow('只接受糯米機劇情預設');
    });

    it('內置小劇場對外只使用“你”和“角色”的稱呼', () => {
        const miniTheaterLabels = STORY_PRESET_SIMPLE_CHOICES.find(choice => choice.label === '小劇場')?.options.map(option => option.label).join(' ') || '';
        expect(miniTheaterLabels).toContain('角色與你');
        expect(miniTheaterLabels).toContain('你和角色們');
        expect(miniTheaterLabels).not.toMatch(/\bAI\b|用[户戶]|演[员員]/);
        for (const id of ['nmj-v3-theater-ai', 'nmj-v3-theater-user-sim', 'nmj-v3-theater-group']) {
            const prompt = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(item => item.id === id);
            expect(prompt?.name).not.toMatch(/\bAI\b|用[户戶]|演[员員]/);
            expect(prompt?.content).not.toMatch(/\bAI\b|用[户戶]|演[员員]/);
        }
    });

    it('只導入 sullyos.story-preset 並歸一化參數', () => {
        const imported = parseStoryTheaterPreset(JSON.stringify({
            schema: 'sullyos.story-preset',
            version: 1,
            name: '雨夜',
            generation: { temperature: 9, topP: -1, maxTokens: 10 },
            prompts: [{ id: 'p1', name: '規則', enabled: true, role: 'system', content: '你好 {{user}}' }],
        }), 'rain.json', 42);
        expect(imported.format).toBe('sullyos-story-preset');
        expect(imported.document.generation.temperature).toBe(2);
        expect(imported.document.generation.topP).toBe(0);
        expect(imported.document.generation.maxTokens).toBe(256);
        expect(imported.createdAt).toBe(42);
    });
});

describe('劇情預設發送器', () => {
    const preset: StoryTheaterPreset = {
        id: 'native',
        name: '順序測試',
        format: 'sullyos-story-preset',
        createdAt: 1,
        updatedAt: 1,
        document: {
            schema: 'sullyos.story-preset',
            version: 1,
            name: '順序測試',
            generation: { temperature: 0.7, topP: 0.8, frequencyPenalty: 0.1, presencePenalty: 0.2, maxTokens: 2048 },
            assistantPrefill: '正文：',
            prompts: [
                { id: 'a', name: '開頭', enabled: true, role: 'system', content: '為 {{user}} 寫 {{group}} 的故事' },
                { id: 'b', name: '演員', enabled: true, role: 'user', content: '', marker: 'characters' },
                { id: 'c', name: '重複演員', enabled: true, role: 'assistant', content: '', marker: 'characters' },
                { id: 'd', name: '關閉', enabled: false, role: 'system', content: '不應發送' },
                { id: 'e', name: '歷史', enabled: true, role: 'system', content: '', marker: 'history' },
            ],
        },
    };

    it('默認完整發送預設參數，只有顯式兼容開關才省略三項', () => {
        const settings = {
            temperature: 0.9,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
            max_tokens: 8000,
        };
        expect(prepareStoryGenerationSettings(settings)).toEqual(settings);
        expect(prepareStoryGenerationSettings(settings, true)).toEqual({ temperature: 0.9, max_tokens: 8000 });

        expect(prepareStoryGenerationSettings({
            temperature: 0.7,
            top_p: 0.8,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            max_tokens: 2048,
        }, true)).toEqual({ temperature: 0.7, max_tokens: 2048 });
    });

    it('遵守順序、enabled、role、marker 去重、宏和 prefill', () => {
        const result = compileStoryPreset({
            preset,
            userName: '條條',
            characterNames: ['蘇利', '糯糯'],
            slots: { actors: 'ACTOR_BLOCK', persona: '', scenario: '', worldBefore: '', worldAfter: '', history: 'HISTORY_BLOCK' },
        });
        const joined = result.messages.map(message => `${message.role}:${message.content}`).join('\n');
        expect(joined).toContain('system:為 條條 寫 蘇利、糯糯 的故事');
        expect(joined.match(/ACTOR_BLOCK/g)).toHaveLength(1);
        expect(joined).toContain('system:HISTORY_BLOCK');
        expect(joined).not.toContain('不應發送');
        expect(result.assistantPrefill).toEqual({ role: 'assistant', content: '正文：' });
        expect(result.settings).toMatchObject({ temperature: 0.7, top_p: 0.8, max_tokens: 2048 });
    });

    it('把角色設定前世界書放在角色資料前，併兼容缺少槽位的舊預設', () => {
        const result = compileStoryPreset({
            preset,
            userName: '條條',
            characterNames: ['蘇利'],
            slots: {
                actors: 'ACTOR_BLOCK',
                persona: '',
                scenario: '',
                worldBefore: 'WORLD_BEFORE_BLOCK',
                worldAfter: '',
                history: '',
            },
        });
        const contents = result.messages.map(message => message.content);
        expect(contents.indexOf('WORLD_BEFORE_BLOCK')).toBeGreaterThanOrEqual(0);
        expect(contents.indexOf('WORLD_BEFORE_BLOCK')).toBeLessThan(contents.indexOf('ACTOR_BLOCK'));

        const blank = createBlankStoryPreset('空白', 1);
        const beforeIndex = blank.document.prompts.findIndex(prompt => prompt.marker === 'world_before');
        const characterIndex = blank.document.prompts.findIndex(prompt => prompt.marker === 'characters');
        expect(beforeIndex).toBeGreaterThanOrEqual(0);
        expect(beforeIndex).toBeLessThan(characterIndex);

        const builtInBeforeIndex = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.findIndex(prompt => prompt.marker === 'world_before');
        const builtInCharacterIndex = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.findIndex(prompt => prompt.marker === 'characters');
        expect(builtInBeforeIndex).toBeLessThan(builtInCharacterIndex);
    });

    it('會把舊預設中放錯位置的角色設定前槽位糾正到角色資料之前', () => {
        const misplacedPreset: StoryTheaterPreset = {
            ...preset,
            document: {
                ...preset.document,
                prompts: [
                    { id: 'actor', name: '演員', enabled: true, role: 'user', content: '', marker: 'characters' },
                    { id: 'before', name: '設定前', enabled: true, role: 'user', content: '', marker: 'world_before' },
                ],
            },
        };
        const result = compileStoryPreset({
            preset: misplacedPreset,
            userName: '條條',
            characterNames: ['Noir'],
            slots: { actors: 'ACTOR_BLOCK', persona: '', scenario: '', worldBefore: 'WORLD_BEFORE_BLOCK', worldAfter: '', history: '' },
        });
        const contents = result.messages.map(message => message.content);
        expect(contents.indexOf('WORLD_BEFORE_BLOCK')).toBeLessThan(contents.indexOf('ACTOR_BLOCK'));
        expect(contents.filter(content => content === 'WORLD_BEFORE_BLOCK')).toHaveLength(1);
    });

    it('默認保留原生 assistant prefill，只有顯式兼容時才由 user 收尾', () => {
        const prefill = { role: 'assistant' as const, content: '<scene_header>\n' };
        const nativePayload = appendStoryUserTurn([{ role: 'system', content: '規則' }], '繼續', prefill);
        expect(nativePayload[nativePayload.length - 1]).toEqual(prefill);

        const compatiblePayload = appendStoryUserTurn([{ role: 'system', content: '規則' }], '繼續', prefill, true);
        expect(compatiblePayload[compatiblePayload.length - 1]).toEqual({ role: 'user', content: '繼續' });
        expect(compatiblePayload[compatiblePayload.length - 2]).toMatchObject({ role: 'system', content: expect.stringContaining('<scene_header>') });
        expect(buildStoryPrefillInstruction({ role: 'assistant', content: '<scene_header>\n' })).toEqual({
            role: 'system',
            content: expect.stringContaining('<scene_header>'),
        });
        expect(buildStoryPrefillInstruction(undefined)).toBeUndefined();
    });

    it('內置幕後與餘波已合為同一發送條目並確實進入最終消息', () => {
        const backstage = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(prompt => prompt.id === 'nmj-v48-backstage');
        const legacyDebts = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(prompt => prompt.id === 'nmj-v61-shot-debts');
        expect(backstage?.enabled).toBe(true);
        expect(backstage?.name).toContain('幕後與餘波');
        expect(backstage?.content).toContain('<backstage>');
        expect(backstage?.content).toContain('<shot_debts>');
        expect(legacyDebts?.enabled).toBe(false);
        const result = compileStoryPreset({
            preset: BUILTIN_NIGHT_SCREENING_PRESET,
            userName: '條條',
            characterNames: ['Noir'],
            slots: { actors: '演員', persona: '用戶', scenario: '劇情', worldBefore: '', worldAfter: '', history: '' },
        });
        const payload = result.messages.map(message => message.content).join('\n');
        const preflight = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(prompt => prompt.id === 'nmj-v616-silent-preflight')!;
        expect(preflight.enabled).toBe(true);
        expect(payload).toContain('正文前靜默完成一次排片檢查');
        expect(payload).toContain('呈現合同：人稱、條條 執筆權');
        expect(payload).toContain('依照當前啟用的人稱模式書寫的故事正文');
        expect(payload).toContain('true_monologue 只在人物自我解釋產生真正裂口時稀有掉落');
        expect(payload).toContain('緊接 </backstage> 後，收錄一至三筆');
        expect(payload).toContain('本輪沒有真實鏡頭債時，僅保留空標題並閉合');
        expect(buildStoryBackstageAftermathReminder(BUILTIN_NIGHT_SCREENING_PRESET.document)).toContain('界面只顯示一個“幕後與餘波”摺疊區');
    });
});

describe('劇情沙盒輔助邏輯', () => {
    it('新虛構劇場默認不讀取記憶，真實陪伴強制摘下面具', () => {
        expect(createStoryTheaterDraft(1)).toMatchObject({ openingMode: 'user', writesToCharacterMemory: false, carryCharacterMemory: false, forceUserLastMessage: false, omitSamplingParams: false });
        const normalized = normalizeStoryTheater({
            ...createStoryTheaterDraft(1),
            openingMode: 'assistant',
            mask: { type: 'character', id: 'a' },
            writesToCharacterMemory: true,
            carryCharacterMemory: false,
        });
        expect(normalized.openingMode).toBe('assistant');
        expect(normalized.omitSamplingParams).toBe(false);
        expect(normalized.mask).toEqual({ type: 'user' });
        expect(normalized.carryCharacterMemory).toBe(true);
        expect(REAL_COMPANION_MEMORY_GUARD).toContain('不得捏造兩人曾經發生過的經歷');
        expect(REAL_COMPANION_MEMORY_GUARD).toContain('不得添油加醋');
    });

    it('新劇情草稿自帶空的客串 NPC 列表；老數據（沒有 npcIds 字段）歸一化後也補成空數組', () => {
        expect(createStoryTheaterDraft(1).npcIds).toEqual([]);
        const legacyEntry = { ...createStoryTheaterDraft(1) } as any;
        delete legacyEntry.npcIds;
        expect(normalizeStoryTheater(legacyEntry).npcIds).toEqual([]);
        expect(normalizeStoryTheater({ ...createStoryTheaterDraft(1), npcIds: ['n1', '', 'n2'] as any }).npcIds).toEqual(['n1', 'n2']);
    });

    it('按世界書 id 去重且不修改角色掛載', () => {
        const first = { id: 'a', title: 'A', content: '一', category: '共同' };
        const duplicate = { id: 'a', title: 'A copy', content: '二', category: '共同' };
        const chars = [
            { id: 'c1', name: '一', mountedWorldbooks: [first] },
            { id: 'c2', name: '二', mountedWorldbooks: [duplicate, { id: 'b', title: 'B', content: '三', category: '共同' }] },
        ] as CharacterProfile[];
        const result = dedupeTheaterWorldbooks(chars);
        expect(result.map(book => book.id)).toEqual(['a', 'b']);
        expect(chars[1].mountedWorldbooks).toHaveLength(2);
    });

    it('不會把不同世界書文件裡 sourceUid 相同的條目誤判成同一本', () => {
        const chars = [
            { id: 'c1', name: '一', mountedWorldbooks: [{ id: 'a', title: 'A', content: '一', category: '甲', sourceUid: 0 }] },
            { id: 'c2', name: '二', mountedWorldbooks: [{ id: 'b', title: 'B', content: '二', category: '乙', sourceUid: 0 }] },
        ] as CharacterProfile[];

        expect(dedupeTheaterWorldbooks(chars).map(book => book.id).sort()).toEqual(['a', 'b']);
    });

    it('用當前輪輸入立即觸發關鍵詞世界書，並保持最多二十條掃描窗口', () => {
        const history = Array.from({ length: 25 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `舊消息 ${index}` }));
        const scanMessages = buildStoryWorldbookScanMessages(history, '我現在肘擊他');
        const slots = buildTheaterWorldbookSlots([{
            id: 'elbow',
            title: '肘擊規則',
            content: '觸發成功',
            category: '測試',
            key: ['肘擊'],
            constant: false,
            position: 1,
        }], scanMessages, '條條', ['蘇利']);

        expect(scanMessages).toHaveLength(20);
        expect(scanMessages.at(-1)).toEqual({ role: 'user', content: '我現在肘擊他' });
        expect(slots.worldAfter).toContain('觸發成功');
    });

    it('把同一正文映射到每位角色自己的時間錨點', () => {
        const createdAt = new Date('2026-08-01T10:00:00Z').getTime();
        const output = memoryTimestampForCharacter({
            id: 's', title: 't', premise: '', characterIds: ['a'], writesToCharacterMemory: true,
            characterMemoryDates: { a: '2020-01-02T03:04' }, carryCharacterMemory: true,
            characterContextLimits: {}, archiveAfter: 40, archiveStrategy: 'summary', archives: [],
            selectedWorldbookIds: [], createdAt, updatedAt: createdAt,
        }, 'a', createdAt + 5000);
        expect(output).toBe(new Date('2020-01-02T03:04').getTime() + 5000);
    });

    it('角色面具不會重複出演，但會加入共享記憶接收者', () => {
        const entry = {
            id: 's', title: 't', premise: '', mask: { type: 'character' as const, id: 'a' }, characterIds: ['b'],
            writesToCharacterMemory: true, characterMemoryDates: {}, carryCharacterMemory: true,
            characterContextLimits: {}, archiveAfter: 40, archiveStrategy: 'summary' as const, archives: [],
            selectedWorldbookIds: [], createdAt: 1, updatedAt: 1,
        };
        expect(storyTheaterMemoryRecipientIds(entry)).toEqual(['b', 'a']);
        const mask = resolveStoryTheaterMask(entry.mask, { name: '用戶' } as UserProfile, [{ id: 'a', name: '林星', systemPrompt: '冷靜', worldview: '雨城' } as CharacterProfile], []);
        expect(mask).toMatchObject({ name: '林星', characterId: 'a', coreInstruction: '冷靜', worldview: '雨城' });
    });

    it('僅在最後一條是用戶推進時提供中斷續跑輸入', () => {
        const userMessage = { id: 1, charId: 'story', role: 'user', type: 'text', content: '推開那扇門', timestamp: 1, metadata: { source: 'story_theater' } } as any;
        const assistantMessage = { ...userMessage, id: 2, role: 'assistant', content: '門後亮起燈。' } as any;
        expect(getPendingStoryRetryInput([userMessage])).toBe('推開那扇門');
        expect(getPendingStoryRetryInput([userMessage, assistantMessage])).toBe('');
        expect(getPendingStoryRetryInput([{ ...userMessage, metadata: { ...userMessage.metadata, theaterArchived: true } }])).toBe('');
    });

    it('舊劇情默認保留最近五層，並按歸檔閾值約束用戶設置', () => {
        const legacy = { ...createStoryTheaterDraft(1), archiveAfter: 40, archiveKeepRecent: undefined };
        expect(normalizeStoryTheater(legacy).archiveKeepRecent).toBe(5);
        expect(normalizeStoryTheater({ ...legacy, archiveAfter: 4, archiveKeepRecent: 99 }).archiveKeepRecent).toBe(3);
    });

    it('回覆落地後只歸檔最舊部分，並且不會拆散一輪對話', () => {
        const rows = Array.from({ length: 40 }, (_, index) => ({
            id: index + 1,
            charId: 'story',
            role: index % 2 === 0 ? 'user' : 'assistant',
            type: 'text',
            content: String(index + 1),
            timestamp: index + 1,
            metadata: { source: 'story_theater' },
        } as Message));
        const batch = selectStoryArchiveBatch(rows, 40, 5);
        expect(batch).toHaveLength(34);
        expect(batch.at(-1)?.role).toBe('assistant');
        expect(rows.slice(batch.length)).toHaveLength(6);
        expect(selectStoryArchiveBatch(rows.slice(0, 39), 40, 5)).toEqual([]);
    });
});

describe('劇場輸出展示解析', () => {
    it('隱藏協議標籤並拆成可讀區塊', () => {
        const blocks = parseStoryDisplayBlocks([
            '<scene_header><time>深夜</time><place>客廳</place></scene_header>',
            '<story_text>林星把手機扣在桌上。</story_text>',
            '<backstage><mind_weather><owner>林星</owner><surface>鬆了一口氣</surface><undertow>仍在緊張</undertow></mind_weather></backstage>',
            '<world_line><world_line_title>小喇叭</world_line_title><world_event>冰箱響了一聲。</world_event></world_line>',
            '<shot_debts><debt><origin>遲疑</origin><unpaid>真相未說</unpaid><trigger>下次見面</trigger></debt></shot_debts>',
        ].join('\n'));
        expect(blocks.map(block => block.kind)).toEqual(['scene', 'story', 'backstage', 'worldline', 'debts']);
        const visible = blocks.map(block => block.text).join('\n');
        expect(visible).toContain('表層反應：鬆了一口氣');
        expect(visible).toContain('尚未償還：真相未說');
        expect(visible).not.toMatch(/<\/?[a-z_]+/i);
    });

    it('未知或未閉合標籤也不會原樣暴露', () => {
        const visible = parseStoryDisplayBlocks('<odd_box>正文<broken>餘波 &lt;surface&gt;編碼標籤&lt;/surface&gt;').map(block => block.text).join('\n');
        expect(visible).toContain('正文');
        expect(visible).toContain('餘波');
        expect(visible).not.toContain('<');
    });

    it('舊版關係溫度仍只展示原先允許的角色側記錄', () => {
        const visible = parseStoryDisplayBlocks('<affinity_panel><c_score>62</c_score><c_delta>+2</c_delta><c_note>他主動留下</c_note><u_score>77</u_score><u_delta>-3</u_delta><u_note>用戶自己的說明</u_note><relation_note>仍有餘溫</relation_note><relation_fragment>他把門留了一條縫。</relation_fragment></affinity_panel>')
            .map(block => block.text)
            .join('\n');
        expect(visible).toContain('關係溫度：62');
        expect(visible).toContain('本輪變化：+2');
        expect(visible).toContain('關係天氣：仍有餘溫');
        expect(visible).toContain('關係碎片：他把門留了一條縫。');
        expect(visible).not.toContain('77');
        expect(visible).not.toContain('-3');
        expect(visible).not.toContain('用戶自己的說明');
        expect(visible).not.toContain('面具');
    });

    it('新版多人關係面板把雙向溫度與五個維度轉換為前端可讀字段', () => {
        const visible = parseStoryDisplayBlocks('<affinity_panel><affinity_person><character_id>lin</character_id><character_name>林星</character_name><c_to_u_score>68</c_to_u_score><c_to_u_delta>+2</c_to_u_delta><c_to_u_note>她留下來聽完了</c_to_u_note><u_to_c_score>74</u_to_c_score><u_to_c_delta>-1</u_to_c_delta><u_to_c_note>他仍在迴避</u_to_c_note><awareness_state>未察覺</awareness_state><trust>71</trust><security>62</security><possessive_pull>55</possessive_pull><emotional_pressure>66</emotional_pressure><repair_will>80</repair_will><state_note>想靠近，又決定先把話說明白</state_note><relation_note>有餘溫，也有裂口</relation_note></affinity_person></affinity_panel>')
            .map(block => block.text)
            .join('\n');
        expect(visible).toContain('人物：林星');
        expect(visible).toContain('角色對你的溫度：68');
        expect(visible).toContain('你對角色的溫度：74');
        expect(visible).toContain('信任：71');
        expect(visible).toContain('安全感：62');
        expect(visible).toContain('佔有拉力：55');
        expect(visible).toContain('情緒壓強：66');
        expect(visible).toContain('修復意願：80');
        expect(visible).not.toContain('<affinity_person>');
    });

    it('把小劇場的嵌套 name/text 合併為連續消息，而不是逐標籤拆卡', () => {
        const block = parseStoryDisplayBlocks('<mini_theater><mt_title>內存粉碎機</mt_title><mt_system>系統後台：進程活躍</mt_system><mt_ai><name>系統合規模塊</name><text>檢測到異常。</text></mt_ai><mt_user><name>Noir</name><text>閉嘴。</text></mt_user></mini_theater>')[0];
        expect(block.kind).toBe('theater');
        expect(block.theater).toEqual({
            title: '內存粉碎機',
            system: '系統後台：進程活躍',
            messages: [
                { side: 'left', name: '系統合規模塊', text: '檢測到異常。' },
                { side: 'right', name: 'Noir', text: '閉嘴。' },
            ],
        });
        expect(block.text).not.toContain('人物：');
        expect(block.text).not.toContain('右側：');
    });

    it('容忍缺失消息閉合標籤和未閉合的 mini_theater 外層', () => {
        const direct = parseStoryMiniTheater('<mt_title>故障頻道</mt_title><mt_ai><name>AI</name><text>仍在運行</text><mt_user><name>Noir</name><text>停止。</text>');
        expect(direct.messages).toHaveLength(2);
        expect(direct.messages[1]).toMatchObject({ side: 'right', name: 'Noir', text: '停止。' });
        const block = parseStoryDisplayBlocks('正文。<mini_theater><mt_title>未閉合頻道</mt_title><mt_ai><name>AI</name><text>收到</text>');
        expect(block.map(item => item.kind)).toEqual(['story', 'theater']);
        expect(block[1].theater?.messages[0].text).toBe('收到');
    });
});

describe('手機端預設分層', () => {
    it('默認版包含可關閉的小劇場區間', () => {
        const theater = STORY_PRESET_SIMPLE_CHOICES.find(choice => choice.label === '小劇場');
        expect(theater?.options[0]).toEqual({ label: '關閉' });
        expect(theater?.ids).toContain('nmj-v3-theater-ai');
        expect(theater?.ids).toContain('nmj-v6-side-channel-wrong-reel');
    });

    it('把 V6.27 合併為九個大區並鎖定角色與世界', () => {
        const groups = getStoryPresetPromptGroups(BUILTIN_NIGHT_SCREENING_PRESET.document);
        expect(groups.map(group => group.key)).toEqual(['startup', 'input', 'sources', 'story', 'tone', 'camera', 'output', 'extras', 'exit']);
        expect(groups.find(group => group.key === 'sources')?.protected).toBe(true);
        const sourcePrompts = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.filter(prompt => groups.find(group => group.key === 'sources')?.promptIds.includes(prompt.id));
        expect(sourcePrompts.every(isProtectedStoryPrompt)).toBe(true);
    });

    it('默認選項會互斥切換且不觸碰其它條目', () => {
        const document = BUILTIN_NIGHT_SCREENING_PRESET.document;
        const ids = ['nmj-v3-pov-second', 'nmj-v3-pov-third'];
        const next = applyStoryPresetChoice(document, ids, 'nmj-v3-pov-third');
        expect(next.prompts.find(prompt => prompt.id === 'nmj-v3-pov-second')?.enabled).toBe(false);
        expect(next.prompts.find(prompt => prompt.id === 'nmj-v3-pov-third')?.enabled).toBe(true);
        expect(next.prompts.find(prompt => prompt.id === 'nmj-v3-house-rules')?.enabled).toBe(true);
    });

    it('應用小劇場後會生成臨近本輪輸入的強制執行提示', () => {
        const choice = STORY_PRESET_SIMPLE_CHOICES.find(item => item.label === '小劇場')!;
        const document = applyStoryPresetChoice(BUILTIN_NIGHT_SCREENING_PRESET.document, choice.ids, 'nmj-v3-theater-ai');
        expect(getActiveStoryMiniTheaterPrompt(document)?.id).toBe('nmj-v3-theater-ai');
        const reminder = buildStoryMiniTheaterReminder(document, '條條', ['林星']);
        expect(reminder).toContain('本輪結尾模塊');
        expect(reminder).toContain('不得因其它輸出規則而省略');
        expect(reminder).toContain('不得把“… / ...');
        expect(reminder).toContain('<mt_ai><name>左側顯示名</name><text>完整消息</text></mt_ai>');
        expect(reminder).toContain('</mini_theater>');
        expect(reminder).not.toContain('{{user}}');
    });

    it('默認版暴露的每一種小劇場都能落到同一個可渲染協議', () => {
        const choice = STORY_PRESET_SIMPLE_CHOICES.find(item => item.label === '小劇場')!;
        for (const id of choice.ids) {
            const document = applyStoryPresetChoice(BUILTIN_NIGHT_SCREENING_PRESET.document, choice.ids, id);
            expect(getActiveStoryMiniTheaterPrompt(document)?.id).toBe(id);
            const reminder = buildStoryMiniTheaterReminder(document, '條條', ['林星', 'Noir']);
            expect(reminder).toContain('<mini_theater>');
            expect(reminder).toContain('<mt_title>');
            expect(reminder).toContain('<name>左側顯示名</name><text>完整消息</text>');
            expect(reminder).toContain('</mini_theater>');
        }
    });
});

describe('本輪關係備註', () => {
    it('只把填寫內容附在模型輸入裡並轉義用戶文本', () => {
        const modelInput = appendStoryAffinityInput('推開門。', { delta: 4, reason: '因為他 <留下> & 等我' });
        expect(modelInput).toContain('<delta>+4</delta>');
        expect(modelInput).toContain('<reason>因為他 &lt;留下&gt; &amp; 等我</reason>');
        expect(modelInput).toContain('<awareness>unnoticed</awareness>');
        expect(appendStoryAffinityInput('推開門。', { delta: 0, reason: '' })).toBe('推開門。');
    });

    it('多人關係備註按角色分別發送並要求逐人輸出雙向五維面板', () => {
        const modelInput = appendStoryAffinityInputs('繼續。', [
            { characterId: 'lin', characterName: '林星', delta: 2, reason: '他接住了話', awareness: 'noticed' },
            { characterId: 'noir', characterName: 'Noir', delta: -1, reason: '他又在迴避', awareness: 'unnoticed' },
        ]);
        expect(modelInput).toContain('<u_affinity_updates>');
        expect(modelInput).toContain('<character_id>lin</character_id>');
        expect(modelInput).toContain('<character_id>noir</character_id>');
        expect(modelInput.match(/<u_affinity>/g)).toHaveLength(2);
        const guide = buildStoryMultiAffinityGuide([{ id: 'lin', name: '林星' }, { id: 'noir', name: 'Noir' }]);
        expect(guide).toContain('禁止共享數值');
        expect(guide).toContain('<affinity_person>');
        expect(guide).toContain('<character_name>角色名</character_name>');
        expect(guide).toContain('<c_to_u_score>50</c_to_u_score>');
        expect(guide).toContain('<trust>50</trust>');
        expect(guide).toContain('<repair_will>50</repair_will>');
        expect(guide).toContain('不得用某個角色的變化影響另一位角色');
    });

    it('第三人稱最終錨點明確“你”屬於用戶側，而不是生成回覆的一方', () => {
        const thirdPerson = applyStoryPresetChoice(
            BUILTIN_NIGHT_SCREENING_PRESET.document,
            ['nmj-v3-pov-second', 'nmj-v3-pov-third'],
            'nmj-v3-pov-third',
        );
        const guard = buildStoryIdentityGuard(thirdPerson, '條條', ['林星', 'Noir']);
        expect(guard).toContain('用戶側劇情身份：條條');
        expect(guard).toContain('關係協議中的 U 只指「條條」');
        expect(guard).toContain('生成回覆的一方不屬於故事人物');
        expect(guard).toContain('旁白中的“你／你的”必須改掉');
        expect(guard).toContain('角色對白裡對「條條」說“你”是正常稱呼');
    });

    it('已察覺要求角色在當幕自然反應，未察覺只保留氛圍', () => {
        const noticed = buildStoryAffinityAwarenessReminder({ delta: 3, reason: '他留下來了', awareness: 'noticed' }, 'Noir');
        expect(noticed).toContain('角色完全透視');
        expect(noticed).toContain('Noir明確知道');
        expect(noticed).toContain('準確幅度');
        expect(noticed).toContain('必須給出一次');
        const unnoticed = buildStoryAffinityAwarenessReminder({ delta: -2, reason: '感到失望', awareness: 'unnoticed' }, 'Noir');
        expect(unnoticed).toContain('角色未察覺');
        expect(unnoticed).toContain('敘事氛圍');
        expect(unnoticed).toContain('不覆蓋用戶對其他角色單獨設置的察覺狀態');
    });

    it('滿值後保持數值底座，允許關係質地繼續變化', () => {
        expect(RELATIONSHIP_TEXTURE_GUIDE).toContain('95—100');
        expect(RELATIONSHIP_TEXTURE_GUIDE).toContain('<relation_fragment>');
        expect(RELATIONSHIP_TEXTURE_GUIDE).toContain('不寫散亂 Markdown');
    });

    it('絕對關係值由前端按上一輪加減 delta，糾正模型把 41 - 1 算成 42', () => {
        const previous = '<affinity_panel><affinity_person><character_id>lin</character_id><character_name>林星</character_name><c_to_u_score>60</c_to_u_score><u_to_c_score>41</u_to_c_score></affinity_person></affinity_panel>';
        const generated = '<affinity_panel><affinity_person><character_id>lin</character_id><character_name>林星</character_name><c_to_u_score>64</c_to_u_score><c_to_u_delta>+2</c_to_u_delta><u_to_c_score>42</u_to_c_score><u_to_c_delta>-1</u_to_c_delta></affinity_person></affinity_panel>';
        const reconciled = reconcileStoryAffinityScores(
            generated,
            previous,
            [{ characterId: 'lin', characterName: '林星', delta: -1, reason: '有些失望' }],
            [{ id: 'lin', name: '林星' }],
        );
        expect(reconciled).toContain('<c_to_u_score>62</c_to_u_score>');
        expect(reconciled).toContain('<u_to_c_score>40</u_to_c_score>');
        expect(reconciled).toContain('<u_to_c_delta>-1</u_to_c_delta>');
        expect(reconciled).not.toContain('<u_to_c_score>42</u_to_c_score>');
    });

    it('多人關係分別復算，未填寫的角色保持上一輪 U→C', () => {
        const previous = '<affinity_panel><affinity_person><character_id>a</character_id><character_name>A</character_name><c_to_u_score>50</c_to_u_score><u_to_c_score>31</u_to_c_score></affinity_person><affinity_person><character_id>b</character_id><character_name>B</character_name><c_to_u_score>70</c_to_u_score><u_to_c_score>80</u_to_c_score></affinity_person></affinity_panel>';
        const generated = '<affinity_panel><affinity_person><character_id>a</character_id><character_name>A</character_name><c_to_u_score>49</c_to_u_score><c_to_u_delta>-2</c_to_u_delta><u_to_c_score>34</u_to_c_score><u_to_c_delta>+3</u_to_c_delta></affinity_person><affinity_person><character_id>b</character_id><character_name>B</character_name><c_to_u_score>72</c_to_u_score><c_to_u_delta>+1</c_to_u_delta><u_to_c_score>79</u_to_c_score><u_to_c_delta>-1</u_to_c_delta></affinity_person></affinity_panel>';
        const reconciled = reconcileStoryAffinityScores(
            generated,
            previous,
            [{ characterId: 'a', characterName: 'A', delta: 3, reason: '更信任了' }],
            [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        );
        expect(reconciled).toContain('<c_to_u_score>48</c_to_u_score>');
        expect(reconciled).toContain('<u_to_c_score>34</u_to_c_score>');
        expect(reconciled).toContain('<c_to_u_score>71</c_to_u_score>');
        expect(reconciled).toContain('<u_to_c_score>80</u_to_c_score>');
        expect(reconciled).toContain('<u_to_c_delta>+0</u_to_c_delta>');
    });
});

describe('劇情客串 NPC', () => {
    const npc = (overrides: Partial<NPCProfile> = {}): NPCProfile => ({
        id: 'npc-1', name: '阿宅', avatar: '', description: '樓下便利店店員，嘴硬心軟。',
        relationships: [], worldview: '', createdAt: 0, updatedAt: 0, ...overrides,
    });

    it('客串標題跟正式演員的 `### 劇情角色：` 區分開，且帶上設定/世界觀', () => {
        const context = buildTheaterNpcContext(npc({ worldview: '本劇發生在同一個小鎮上。' }), '林夕', []);
        expect(context).toContain('### 劇情客串角色：阿宅');
        expect(context).not.toContain('### 劇情角色：阿宅');
        expect(context).toContain('樓下便利店店員，嘴硬心軟。');
        expect(context).toContain('本劇發生在同一個小鎮上。');
        expect(context).toContain('不追蹤好感度');
        expect(context).not.toContain('記得的事（');
    });

    it('NPC 有輕量記憶時帶進客串上下文', () => {
        const context = buildTheaterNpcContext(npc({ memory: '- 林夕上週幫我搬過貨' }), '林夕', []);
        expect(context).toContain('阿宅 記得的事');
        expect(context).toContain('林夕上週幫我搬過貨');
    });

    it('只帶上對用戶和「本場在場角色」的關係，濾掉不在場的關係對象', () => {
        const withRelationships = npc({
            relationships: [
                { id: 'r1', targetId: 'user', description: '常客，認識好幾年了' },
                { id: 'r2', targetId: 'c-onstage', description: '同班同學' },
                { id: 'r3', targetId: 'c-offstage', description: '不喜歡這個人' },
            ],
        });
        const context = buildTheaterNpcContext(withRelationships, '林夕', [{ id: 'c-onstage', name: '小滿' }]);
        expect(context).toContain('對「林夕」：常客，認識好幾年了');
        expect(context).toContain('對「小滿」：同班同學');
        expect(context).not.toContain('不喜歡這個人');
    });

    it('沒有設定/世界觀/關係時仍能生成一個乾淨的最小上下文', () => {
        const context = buildTheaterNpcContext(npc({ description: '', worldview: '' }), '林夕', []);
        expect(context).toContain('### 劇情客串角色：阿宅');
        expect(context).toContain('- 名字：阿宅');
        expect(context).not.toContain('undefined');
    });
});
