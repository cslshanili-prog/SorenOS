import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import type { EventBox, MemoryNode, ScoredMemory } from './types';
import { injectMemoryPalace } from './pipeline';
import {
    analyzeExplicitEntitySignals,
    lookupExplicitEntityCandidates,
    mergeExplicitEntityCandidates,
} from './explicitEntityRecall';

let nextMessageId = 1;
const message = (content: string): Message => ({
    id: nextMessageId++,
    charId: 'char-entity',
    role: 'user',
    type: 'text',
    content,
    timestamp: nextMessageId,
});

const node = (id: string, content: string, overrides: Partial<MemoryNode> = {}): MemoryNode => ({
    id,
    charId: 'char-entity',
    content,
    room: 'user_room',
    tags: [],
    importance: 5,
    mood: 'neutral',
    embedded: true,
    createdAt: 100,
    lastAccessedAt: 100,
    accessCount: 0,
    eventBoxId: null,
    ...overrides,
});

const box = (overrides: Partial<EventBox> = {}): EventBox => ({
    id: 'box-wulan',
    charId: 'char-entity',
    name: '和霧嵐的搬家事件',
    tags: ['霧嵐', '搬家'],
    summaryNodeId: 'summary-wulan',
    liveMemoryIds: [],
    archivedMemoryIds: ['archived-wulan'],
    compressionCount: 1,
    createdAt: 100,
    updatedAt: 100,
    lastCompressedAt: 100,
    ...overrides,
});

describe('Explicit Entity Recall M1.1.5', () => {
    beforeEach(() => {
        nextMessageId = 1;
        localStorage.clear();
    });

    it.each([
        ['你還記得霧嵐嗎', '霧嵐', 'remember'],
        ['之前那個叫小明的人呢', '小明', 'named'],
        ['sully.com那個域名還記得嗎', 'sully.com', 'domain'],
        ['小紅是不是以前也幹過這個', '小紅', 'leading_name'],
    ])('extracts an explicit lookup key from %s', (content, expected, source) => {
        const analysis = analyzeExplicitEntitySignals([message(content)]);

        expect(analysis.hasSignals).toBe(true);
        expect(analysis.signals).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: expected, source }),
        ]));
    });

    it.each([
        '好煩他又來了',
        '之前我們是不是聊過類似的事情',
        '我以前是不是有過類似經歷',
        '你還記得我嗎',
    ])('does not mistake a pronoun or semantic recollection for an entity: %s', (content) => {
        expect(analyzeExplicitEntitySignals([message(content)]).hasSignals).toBe(false);
    });

    it('does not use the current user or character name as a rare-entity key', () => {
        expect(analyzeExplicitEntitySignals([message('你還記得測試用戶嗎')], '測試角色', '測試用戶').hasSignals).toBe(false);
        expect(analyzeExplicitEntitySignals([message('你還記得測試角色嗎')], '測試角色', '測試用戶').hasSignals).toBe(false);
    });

    it('finds all rare-name memories through entities, tags, and legacy content', () => {
        const analysis = analyzeExplicitEntitySignals([message('你還記得霧嵐嗎')]);
        const nodes = [
            node('entity', '以前一起吃過飯', { entities: [{ name: '霧嵐', type: 'person' }] }),
            node('tag', '她當時幫忙搬過家', { tags: ['霧嵐', '搬家'] }),
            node('legacy', '之前和霧嵐聊到過換工作的事'),
            node('other', '和另一個朋友聊過工作', { importance: 10 }),
        ];

        const lookup = lookupExplicitEntityCandidates(analysis, nodes, []);

        expect(lookup.matchedMemoryCount).toBe(3);
        expect(lookup.candidates.map(candidate => candidate.node.id)).toEqual(['entity', 'tag', 'legacy']);
    });

    it('uses a stored alias but does not infer aliases on its own', () => {
        const analysis = analyzeExplicitEntitySignals([message('你還記得小嵐嗎')]);
        const nodes = [
            node('alias', '霧嵐說過那件事', { entities: [{ name: '霧嵐', type: 'person', aliases: ['小嵐'] }] }),
            node('canonical-only', '另一次談到霧嵐', { entities: [{ name: '霧嵐', type: 'person' }] }),
        ];

        const lookup = lookupExplicitEntityCandidates(analysis, nodes, []);

        expect(lookup.candidates.map(candidate => candidate.node.id)).toEqual(['alias']);
        expect(lookup.candidates[0].matchSource).toBe('entity_alias');
    });

    it('routes archived entity hits to their EventBox representative', () => {
        const analysis = analyzeExplicitEntitySignals([message('你還記得霧嵐嗎')]);
        const nodes = [
            node('archived-wulan', '霧嵐搬家時我們去幫忙了', { archived: true, eventBoxId: 'box-wulan' }),
            node('summary-wulan', '這是和霧嵐搬家有關的一整段回憶', {
                isBoxSummary: true,
                eventBoxId: 'box-wulan',
                importance: 8,
            }),
        ];

        const lookup = lookupExplicitEntityCandidates(analysis, nodes, [box()]);

        expect(lookup.matchedMemoryCount).toBe(2);
        expect(lookup.matchedEventBoxCount).toBe(1);
        expect(lookup.candidates).toHaveLength(1);
        expect(lookup.candidates[0].node.id).toBe('summary-wulan');
    });

    it('keeps exact Latin identifiers on token boundaries', () => {
        const analysis = analyzeExplicitEntitySignals([message('你還記得csy嗎')]);
        const nodes = [
            node('exact', 'csy之前提到過這個'),
            node('substring', 'abcsyx之前提到過這個'),
        ];

        expect(lookupExplicitEntityCandidates(analysis, nodes, []).candidates.map(hit => hit.node.id))
            .toEqual(['exact']);
    });

    it('guarantees explicit hits above a full semantic candidate list', () => {
        const semantic: ScoredMemory[] = Array.from({ length: 15 }, (_, index) => ({
            node: node(`semantic-${index}`, `普通候選 ${index}`),
            finalScore: 1 - index * 0.01,
            similarity: 1,
            bm25Score: 0,
            roomScore: 1 - index * 0.01,
        }));
        const explicitNodes = [node('wulan-1', '霧嵐記憶一'), node('wulan-2', '霧嵐記憶二')];

        const merged = mergeExplicitEntityCandidates(semantic, explicitNodes.map(item => ({
            node: item,
            matchSource: 'memory_content' as const,
            matchStrength: 0.86,
        })));

        expect(merged.slice(0, 2).map(result => result.node.id)).toEqual(['wulan-1', 'wulan-2']);
        // 精確實體是加法支路：兩條保底命中之外，舊 hybrid recall 的候選必須完整保留。
        expect(merged).toHaveLength(semantic.length + explicitNodes.length);
        expect(semantic.every(item => merged.some(result => result.node.id === item.node.id))).toBe(true);
    });

    it('records explicit_entity while the local analyzer remains observable', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { recallRouter: true },
        }));

        const trace = await injectMemoryPalace(
            { id: 'char-entity', memoryPalaceEnabled: false },
            [message('你還記得霧嵐嗎')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.recallIntent).toBe('explicit_entity');
        expect(trace.recallResolver).toEqual({ status: 'deferred' });
        expect(trace.contextAnalyzer?.signals.explicitEntity).toBe(1);
        expect(trace.explicitEntityRecall).toMatchObject({
            status: 'signaled',
            signalCount: 1,
            signalSources: ['remember'],
        });
        expect(trace.stages.some(stage => stage.name === 'explicit_signal')).toBe(true);
        expect(trace.stages.some(stage => stage.name === 'context_analyzer')).toBe(true);
    });
});
