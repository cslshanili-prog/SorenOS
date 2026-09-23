import { describe, expect, it } from 'vitest';
import { buildQixiBridgePrompt, createQixiBridgeFallback, parseQixiBridge, prepareQixiBridge } from './qixiBridge';
import { QixiMemoryBundle, QIXI_MEMORY_BUNDLE_VERSION } from './qixiMemoryBundle';

const bundle = {
    version: QIXI_MEMORY_BUNDLE_VERSION,
    source: 'memory',
    openingChat: ['剛才回我了嗎？', '我這裡沒看到。'],
    charLayerColor: '#82D5B8',
    charPerformance: { tempo: 'measured', markStyle: 'soft', presence: 'careful' },
    evidence: [1, 2, 3, 4].map(index => ({ id: `e${index}`, fact: `第 ${index} 條可以核對的真實記憶。`, object: `物件${index}`, tags: ['日常'] })),
    artifacts: [1, 2, 3, 4].map(index => ({ id: `a${index}`, label: `物件${index}`, kind: 'object', evidenceIds: [`e${index}`] })),
    scenes: {} as QixiMemoryBundle['scenes'],
    personalizedSceneIds: [],
    generatedAt: 1,
    contextSignature: 'ctx',
} as QixiMemoryBundle;

describe('qixi bridge parser', () => {
    it('reuses the bridge embedded in Part 1b without making another model request', async () => {
        const embedded = parseQixiBridge(JSON.stringify({
            userMagpies: [{ evidenceId: 'e1', name: '物件一', memory: '第一條可以核對的真實記憶。', visualHint: '一粒暖色文字' }],
            charMagpies: [{ evidenceId: 'e2', name: '物件二', memory: '第二條可以核對的真實記憶。', visualHint: '一縷冷色細線' }],
            finalMagpie: { name: '條條', line: '總算讓我找到你了。', visualHint: '對岸亮起的名字' },
        }), bundle, '條條');
        expect(embedded).not.toBeNull();

        const prepared = await prepareQixiBridge(
            { name: '條條' } as any,
            { ...bundle, bridge: embedded! },
        );
        expect(prepared).toEqual(embedded);
    });

    it('keeps the model bridge intact instead of semantically filtering or rewriting it', () => {
        const parsed = parseQixiBridge(JSON.stringify({
            userMagpies: [
                { evidenceId: 'e1', name: '物件一', memory: '第一條真實記憶的極短說明。', visualHint: '一粒暖色文字' },
                { evidenceId: 'missing', name: '編造節點', memory: '這條不應進入鵲橋。', visualHint: '不存在的剪影' },
            ],
            charMagpies: [
                { evidenceId: 'e2', name: '物件二', memory: '第二條真實記憶的另一側說明。', visualHint: '一縷冷色細線' },
            ],
            finalMagpie: { name: '錯誤名字', line: '原來你在這裡。', visualHint: '對岸亮起的名字' },
        }), bundle, '條條');
        expect(parsed?.userMagpies.map(node => node.evidenceId)).toEqual(['e1', 'missing']);
        expect(parsed?.charMagpies.map(node => node.evidenceId)).toEqual(['e2']);
        expect(parsed?.nodes.some(node => node.evidenceId === 'missing')).toBe(true);
        expect(parsed?.finalMagpie.name).toBe('錯誤名字');
    });

    it('splits verified evidence across the two banks without inventing memories', () => {
        const fallback = createQixiBridgeFallback(bundle, '條條');
        expect(fallback.nodes).toHaveLength(4);
        expect(fallback.userMagpies).toHaveLength(2);
        expect(fallback.charMagpies).toHaveLength(2);
        expect(fallback.nodes.every(node => node.evidenceId?.startsWith('e'))).toBe(true);
        expect(fallback.nodes[0].memory).toBe(bundle.evidence[0].fact);
        expect(fallback.finalMagpie.name).toBe('條條');
    });

    it('makes the Part 2 contract explicit about both banks and the named final magpie', () => {
        const prompt = buildQixiBridgePrompt(bundle, [], '條條');
        expect(prompt).toContain('userMagpies');
        expect(prompt).toContain('charMagpies');
        expect(prompt).toContain('finalMagpie.name 固定為“條條”');
        expect(prompt).toContain('不重新發明事實');
        expect(prompt).toContain('尚未親眼確認');
        expect(prompt).toContain('身份確認留給最終見面');
    });
});
