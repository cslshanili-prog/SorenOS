import { describe, expect, it } from 'vitest';
import {
    buildQixiMemoryBundlePhasePrompt,
    buildQixiMemoryBundlePrompt,
    normalizeQixiPhaseChunk,
    parseQixiMemoryBundle,
    parseQixiProgressiveMemoryBundle,
    QIXI_MEMORY_BUNDLE_VERSION,
    QIXI_PART1_FIRST_SCENE_IDS,
    QIXI_PART1_SECOND_SCENE_IDS,
    QIXI_PART1_THIRD_SCENE_IDS,
    QIXI_PART1_TIMEOUT_MS,
    QIXI_RECALL_MAX_OUTPUT_ITEMS,
    QIXI_SCENE_IDS,
} from './qixiMemoryBundle';

const evidence = Array.from({ length: 20 }, (_, index) => ({
    id: `e${index + 1}`,
    fact: `第 ${index + 1} 條真實聊天記憶。`,
    object: `物件${index + 1}`,
    tags: ['日常'],
}));

const artifacts = Array.from({ length: 16 }, (_, index) => ({
    id: `a${index + 1}`,
    label: `性格詞${index + 1}`,
    kind: 'trait',
    evidenceIds: [`e${index + 1}`],
}));

const makeScene = (sceneId: string, index: number) => ({
    transitionLines: [`第${index + 1}站直接接住上一站的動作。`],
    sharedObject: `第${index + 1}站物件`,
    memoryLine: `第${index + 1}站由模型直接生成的最終演出。`,
    options: sceneId === 'wordCloud' ? [] : [0, 1, 2].map(optionIndex => ({
        id: `${sceneId}-${optionIndex + 1}`,
        label: `模型選項 ${optionIndex + 1}`,
        result: `模型結果 ${optionIndex + 1}`,
        ...(sceneId === 'lostLayer' ? { charReply: `模型回覆 ${optionIndex + 1}` } : {}),
        evidenceIds: [`e${index + 1}`],
    })),
    charAction: `模型為第${index + 1}站寫下的角色動作。`,
    charVisibleText: sceneId === 'lostLayer' ? '別擋路。' : sceneId === 'doubleWish' ? '這是我自己的願望。' : '',
    charMutter: sceneId === 'lostLayer' ? '嘖。' : undefined,
    charContribution: sceneId === 'offerings' ? '一顆糖' : undefined,
    charQuips: sceneId === 'wordCloud' ? ['第一句', '第二句', '第三句'] : ['模型碎碎念'],
    reveal: `模型為第${index + 1}站寫下的結果。`,
    artifactIds: sceneId === 'wordCloud' ? artifacts.map(item => item.id) : [`a${index + 1}`],
    charSelectionIds: sceneId === 'wordCloud' ? ['a1', 'a3', 'a5'] : [],
});

const validBundle = {
    openingChat: ['第一句正常聊天。', '第二句正常聊天。'],
    charLayerColor: '#82D5B8',
    charPerformance: { tempo: 'brisk', markStyle: 'precise', presence: 'direct' },
    evidence,
    artifacts,
    scenes: Object.fromEntries(QIXI_SCENE_IDS.map((sceneId, index) => [sceneId, makeScene(sceneId, index)])),
};

describe('Qixi direct LLM script pipeline', () => {
    it('asks the model for final playable content while keeping the four-call contract', () => {
        const prompt = buildQixiMemoryBundlePrompt({ name: 'Char' } as any, { name: 'User' } as any);
        expect(QIXI_MEMORY_BUNDLE_VERSION).toBe(19);
        expect(QIXI_PART1_TIMEOUT_MS).toBe(600_000);
        expect(QIXI_RECALL_MAX_OUTPUT_ITEMS).toBe(20);
        expect(prompt).toContain('直接生成玩家最終會看見、點擊和經歷的完整劇本');
        expect(prompt).toContain('不要輸出供本地代碼二次創作的素材或摘要');
        expect(prompt).toContain('前六站必須各提供恰好 3 個完整 options');
        expect(prompt).toContain('敘事視角必須分開');
        expect(prompt).toContain('面向玩家時，用第二人稱“你 / 你的”');
        expect(prompt).toContain('禁止寫“User / 用戶 / 玩家 / 該用戶');
        expect(prompt).toContain('對 Char 本人有意義');
        expect(prompt).toContain('具體【私物】');
        expect(prompt).toContain('不要求來自共同記憶，不要求與 User 有關');
        expect(prompt).toContain('絕不能默認寫成特意送給 User 的禮物');
        expect(prompt).toContain('還被迫完成一連串莫名其妙的小遊戲');
        expect(prompt).toContain('第七站結束也只到強烈懷疑');
        expect(prompt).toContain('Part 1 中 Char 絕不能說出');
        expect(prompt).toContain('純粹自己想買的 charContribution');
        expect(prompt).toContain('默認禁止吃醋、嫉妒、情敵、佔有慾宣言');
    });

    it('keeps Part 1 serially split into 2 + 3 + 2 rooms', () => {
        const first = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'first');
        const second = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'second', '{"completedScenes":{}}');
        const third = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'third', '{"completedScenes":{}}');
        expect(QIXI_PART1_FIRST_SCENE_IDS).toEqual(['lostLayer', 'doubleWish']);
        expect(QIXI_PART1_SECOND_SCENE_IDS).toEqual(['threadNeedle', 'offerings', 'reflection']);
        expect(QIXI_PART1_THIRD_SCENE_IDS).toEqual(['nightMarket', 'wordCloud']);
        expect(first).toContain('最終可播放內容');
        expect(second).toContain('threadNeedle、offerings、reflection');
        expect(third).toContain('nightMarket、wordCloud');
    });

    it('delivers generated rooms progressively without filling future rooms with local copy', () => {
        const common = {
            openingChat: validBundle.openingChat,
            charLayerColor: validBundle.charLayerColor,
            charPerformance: validBundle.charPerformance,
            evidence,
            artifacts,
        };
        const firstScenes = Object.fromEntries(QIXI_PART1_FIRST_SCENE_IDS.map(id => [id, validBundle.scenes[id]]));
        const firstReady = parseQixiProgressiveMemoryBundle(common, firstScenes, 'ctx');
        expect(firstReady?.personalizedSceneIds).toEqual(QIXI_PART1_FIRST_SCENE_IDS);
        expect(firstReady?.scenes.lostLayer.sharedObject).toBe('第1站物件');
        expect(firstReady?.scenes.threadNeedle.sharedObject).toBe('');
        expect(firstReady?.scenes.threadNeedle.options).toEqual([]);
    });

    it('accepts middle-room scripts wrapped, arrayed, aliased, or returned without a scenes envelope', () => {
        const middleScenes = QIXI_PART1_SECOND_SCENE_IDS.map((id, index) => makeScene(id, index + 2));
        const arrayWrapped = normalizeQixiPhaseChunk({
            result: { rooms: middleScenes },
        }, QIXI_PART1_SECOND_SCENE_IDS);
        expect(Object.keys(arrayWrapped.scenes)).toEqual(QIXI_PART1_SECOND_SCENE_IDS);
        expect(arrayWrapped.scenes.threadNeedle.sharedObject).toBe('第3站物件');

        const aliased = normalizeQixiPhaseChunk({
            part2: {
                scene_3: middleScenes[0],
                供果: middleScenes[1],
                reflection_room: middleScenes[2],
            },
        }, QIXI_PART1_SECOND_SCENE_IDS);
        expect(aliased.scenes.threadNeedle.charAction).toContain('第3站');
        expect(aliased.scenes.offerings.charAction).toContain('第4站');
        expect(aliased.scenes.reflection.charAction).toContain('第5站');

        const third = normalizeQixiPhaseChunk({
            rooms: [makeScene('nightMarket', 5), makeScene('wordCloud', 6)],
            bridgeData: {
                userBirds: [{ name: '用戶側' }],
                charNodes: [{ name: '角色側' }],
                finalBird: { name: 'User' },
            },
        }, QIXI_PART1_THIRD_SCENE_IDS);
        expect(third.bridge.userMagpies[0].name).toBe('用戶側');
        expect(third.bridge.charMagpies[0].name).toBe('角色側');
        expect(third.bridge.finalMagpie.name).toBe('User');
    });

    it('preserves model prose and all three choices without semantic filtering or local replacement', () => {
        const raw = structuredClone(validBundle);
        raw.scenes.lostLayer.charAction = '這是一段完全由角色自由決定的古怪動作。';
        raw.scenes.lostLayer.options[0].evidenceIds = ['missing-evidence'];
        raw.scenes.doubleWish.options[0].label = '只祝你今天開心';
        raw.scenes.doubleWish.charVisibleText = '希望我自己變勇敢。';
        raw.scenes.doubleWish.charQuips = ['系統提示也可以是這個角色故意說的話。'];
        const parsed = parseQixiMemoryBundle(JSON.stringify(raw));
        expect(parsed?.scenes.lostLayer.charAction).toBe(raw.scenes.lostLayer.charAction);
        expect(parsed?.scenes.lostLayer.options).toHaveLength(3);
        expect(parsed?.scenes.lostLayer.options[0].evidenceIds).toEqual(['missing-evidence']);
        expect(parsed?.scenes.doubleWish.options[0].label).toBe('只祝你今天開心');
        expect(parsed?.scenes.doubleWish.charVisibleText).toBe('希望我自己變勇敢。');
        expect(parsed?.scenes.doubleWish.charQuips).toEqual(['系統提示也可以是這個角色故意說的話。']);
        expect(parsed?.repairNotes).toBeUndefined();
    });

    it('tolerates harmless shape drift without inventing visible content', () => {
        const raw: any = structuredClone(validBundle);
        raw.openingChat = '第一句正常聊天。\n第二句正常聊天。';
        raw.scenes.lostLayer.transitionLines = '上一句。\n下一句。';
        raw.scenes.lostLayer.charQuips = '碎碎念一。\n碎碎念二。';
        raw.scenes.lostLayer.options = Object.fromEntries(raw.scenes.lostLayer.options.map((item: any, index: number) => [`choice${index}`, item]));
        const parsed = parseQixiMemoryBundle(`\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``);
        expect(parsed?.openingChat).toEqual(['第一句正常聊天。', '第二句正常聊天。']);
        expect(parsed?.scenes.lostLayer.transitionLines).toEqual(['上一句。', '下一句。']);
        expect(parsed?.scenes.lostLayer.charQuips).toEqual(['碎碎念一。', '碎碎念二。']);
        expect(parsed?.scenes.lostLayer.options).toHaveLength(3);
    });

    it('parses the bridge as generated content without rewriting its character line', () => {
        const parsed = parseQixiMemoryBundle(JSON.stringify({
            ...validBundle,
            bridge: {
                userMagpies: [{ evidenceId: 'e1', name: '別針', memory: '那一回的別針。', visualHint: '銀色細線' }],
                charMagpies: [{ evidenceId: 'e2', name: '夜燈', memory: '那盞沒有關的燈。', visualHint: '暖色光點' }],
                finalMagpie: { name: '條條', line: '原來跑到這裡了。', visualHint: '名字發亮' },
            },
        }), '', undefined, '條條');
        expect(parsed?.bridge?.finalMagpie.line).toBe('原來跑到這裡了。');
        expect(parsed?.bridge?.finalMagpie.name).toBe('條條');
    });

    it('only fails when the response is not structurally readable at all', () => {
        expect(parseQixiMemoryBundle('這不是 JSON')).toBeNull();
        expect(parseQixiMemoryBundle(JSON.stringify({ openingChat: ['有內容但沒有 scenes'] }))).toBeNull();
    });
});
