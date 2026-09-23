import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBox, MemoryNode } from './types';

const mocks = vi.hoisted(() => ({
    boxes: new Map<string, any>(),
    nodes: new Map<string, any>(),
    responses: [] as any[],
    safeFetchJson: vi.fn(),
    vectorizeAndStore: vi.fn(),
}));

vi.mock('./db', () => ({
    EventBoxDB: {
        getById: vi.fn(async (id: string) => mocks.boxes.get(id)),
        save: vi.fn(async (box: EventBox) => { mocks.boxes.set(box.id, { ...box }); }),
    },
    MemoryNodeDB: {
        getById: vi.fn(async (id: string) => mocks.nodes.get(id)),
        save: vi.fn(async (node: MemoryNode) => { mocks.nodes.set(node.id, { ...node }); }),
    },
}));

vi.mock('./vectorStore', () => ({
    vectorizeAndStore: mocks.vectorizeAndStore,
}));

vi.mock('./supabaseVector', () => ({
    bulkSetArchived: vi.fn(async () => true),
}));

vi.mock('./roomPlates', () => ({
    isPlateRoom: vi.fn(() => false),
    updatePlateFromBoxSummary: vi.fn(async () => {}),
}));

vi.mock('../safeApi', () => ({
    safeFetchJson: mocks.safeFetchJson,
    extractContent: (data: any) => data?.choices?.[0]?.message?.content || '',
    extractJson: (raw: string) => {
        try { return JSON.parse(raw); } catch { return null; }
    },
}));

import {
    hasSummaryReasoningLeak,
    regenerateEventBoxSummary,
} from './eventBoxCompression';

const llmConfig = { baseUrl: 'https://llm.example/v1', apiKey: 'key', model: 'flash' };
const embeddingConfig = {
    baseUrl: 'https://embedding.example/v1', apiKey: 'emb-key', model: 'embed', dimensions: 3,
};

function memory(id: string, content: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        charId: 'char-1',
        content,
        room: 'living_room',
        tags: [id],
        importance: 6,
        mood: 'neutral',
        embedded: true,
        createdAt: id === 'archived-1' ? 100 : 200,
        lastAccessedAt: 200,
        accessCount: 0,
        eventBoxId: 'box-1',
        archived: id.startsWith('archived'),
        ...overrides,
    };
}

function box(): EventBox {
    return {
        id: 'box-1',
        charId: 'char-1',
        name: '舊盒名',
        tags: ['舊標籤'],
        summaryNodeId: 'summary-1',
        liveMemoryIds: ['live-1'],
        archivedMemoryIds: ['archived-1'],
        compressionCount: 3,
        createdAt: 1,
        updatedAt: 2,
        lastCompressedAt: 2,
        sealed: true,
    };
}

function completion(content: string) {
    return {
        choices: [{
            message: {
                content: JSON.stringify({
                    content,
                    name: '乾淨盒名',
                    tags: ['人物甲', '地點乙'],
                    room: 'living_room',
                    importance: 8,
                    mood: 'tender',
                }),
            },
        }],
    };
}

beforeEach(() => {
    mocks.boxes.clear();
    mocks.nodes.clear();
    mocks.responses.length = 0;
    mocks.safeFetchJson.mockReset();
    mocks.safeFetchJson.mockImplementation(async () => mocks.responses.shift());
    mocks.vectorizeAndStore.mockReset();
    mocks.vectorizeAndStore.mockImplementation(async (nodes: MemoryNode[]) => {
        const node = { ...nodes[0], embedded: true };
        mocks.nodes.set(node.id, node);
        return { stored: 1, skipped: 0 };
    });

    mocks.boxes.set('box-1', box());
    mocks.nodes.set('summary-1', memory('summary-1', 'Wait, let’s count...舊壞總結', {
        isBoxSummary: true,
        archived: false,
    }));
    mocks.nodes.set('archived-1', memory('archived-1', '第一條歸檔原始記憶'));
    mocks.nodes.set('live-1', memory('live-1', '第二條活躍原始記憶', { archived: false }));
});

describe('hasSummaryReasoningLeak', () => {
    it('識別截圖中的字數計算過程，但不誤傷單個普通英文短語', () => {
        expect(hasSummaryReasoningLeak(
            "Wait, let's count: Paragraph 1: 31 chars. Still too long. Need to get under 700.",
        )).toBe(true);
        expect(hasSummaryReasoningLeak('那天他說「Let’s count together」，我笑了。')).toBe(false);
    });
});

describe('regenerateEventBoxSummary', () => {
    it('用全部 archived + live 原文重做，覆蓋同一 summary 並強制重新向量化', async () => {
        mocks.responses.push(completion('這是重新整合後的乾淨回憶。'));

        const result = await regenerateEventBoxSummary(
            'box-1', llmConfig, embeddingConfig, '角色甲', '用戶乙',
        );

        expect(result.sourceCount).toBe(2);
        expect(result.summary.id).toBe('summary-1');
        expect(result.summary.content).toBe('這是重新整合後的乾淨回憶。');
        expect(result.summary.embedded).toBe(true);
        expect(mocks.vectorizeAndStore).toHaveBeenCalledTimes(1);
        expect(mocks.vectorizeAndStore.mock.calls[0][0][0]).toMatchObject({
            id: 'summary-1',
            content: '這是重新整合後的乾淨回憶。',
            embedded: false,
        });

        const requestBody = JSON.parse(mocks.safeFetchJson.mock.calls[0][1].body);
        const sourcePrompt = requestBody.messages[1].content as string;
        expect(sourcePrompt).toContain('第一條歸檔原始記憶');
        expect(sourcePrompt).toContain('第二條活躍原始記憶');
        expect(sourcePrompt).not.toContain('舊壞總結');

        const savedBox = mocks.boxes.get('box-1') as EventBox;
        expect(savedBox.sealed).toBe(true);
        expect(savedBox.compressionCount).toBe(3);
        expect(savedBox.liveMemoryIds).toEqual(['live-1']);
        expect(savedBox.archivedMemoryIds).toEqual(['archived-1']);
        expect(savedBox.name).toBe('乾淨盒名');
        expect(savedBox.tags).toEqual(['人物甲', '地點乙']);
    });

    it('拒絕推理洩漏並自動重試一次，只向量化乾淨結果', async () => {
        mocks.responses.push(
            completion("Wait, let's count: Paragraph 1: 31 chars. Still too long."),
            completion('第二次返回的乾淨回憶。'),
        );

        const result = await regenerateEventBoxSummary(
            'box-1', llmConfig, embeddingConfig, '角色甲', '用戶乙',
        );

        expect(mocks.safeFetchJson).toHaveBeenCalledTimes(2);
        expect(mocks.vectorizeAndStore).toHaveBeenCalledTimes(1);
        expect(result.summary.content).toBe('第二次返回的乾淨回憶。');
    });

    it('Embedding 失敗時不覆蓋舊 summary 和事件盒元數據', async () => {
        mocks.responses.push(completion('本來準備寫入的新回憶。'));
        mocks.vectorizeAndStore.mockRejectedValueOnce(new Error('embedding unavailable'));

        await expect(regenerateEventBoxSummary(
            'box-1', llmConfig, embeddingConfig, '角色甲', '用戶乙',
        )).rejects.toThrow('embedding unavailable');

        expect(mocks.nodes.get('summary-1').content).toBe('Wait, let’s count...舊壞總結');
        expect(mocks.boxes.get('box-1').name).toBe('舊盒名');
    });
});
