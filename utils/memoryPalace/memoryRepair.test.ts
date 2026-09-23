import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../../types';
import { EventBoxDB, MemoryNodeDB } from './db';
import {
    buildMemoryRepairCoreContext,
    filterEditableMemoryNodes,
    formatRepairMemoryDate,
    getMemoryGuideCopy,
    loadRecallRepairSnapshot,
    naturalizeMemoryRepairLanguage,
} from './memoryRepair';
import { clearReceipts, getLatestRecallReceipt, recordRecallReceipt } from './recallReceipts';
import type { EventBox, MemoryNode } from './types';

function node(id: string, charId: string, content: string, extra: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        charId,
        content,
        room: 'living_room',
        tags: [],
        importance: 5,
        mood: 'neutral',
        embedded: true,
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        ...extra,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('本輪召回記憶修補', () => {
    it('只拿時間點之後最近一次回執，不會誤用上一輪', () => {
        const charId = 'repair_receipt_latest';
        clearReceipts(charId);
        vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
        recordRecallReceipt(charId, ['old']);
        recordRecallReceipt(charId, ['current']);

        expect(getLatestRecallReceipt(charId, 1500)).toEqual({ ts: 2000, ids: ['current'] });
        expect(getLatestRecallReceipt(charId, 2500)).toBeNull();
    });

    it('命中事件盒任一節點後，展開摘要、活節點和歸檔節點供原地修改', async () => {
        const charId = 'repair_box_complete';
        const summary = node('repair_summary', charId, '錯誤的盒摘要', { isBoxSummary: true });
        const live = node('repair_live', charId, '本輪實際經過的活節點', { eventBoxId: 'repair_box' });
        const archived = node('repair_archived', charId, '已經歸檔但仍可修補', {
            eventBoxId: 'repair_box',
            archived: true,
        });
        const standalone = node('repair_standalone', charId, '散落的獨立記憶');
        await MemoryNodeDB.saveMany([summary, live, archived, standalone]);
        const box: EventBox = {
            id: 'repair_box',
            charId,
            name: '那次旅行',
            tags: [],
            summaryNodeId: summary.id,
            liveMemoryIds: [live.id],
            archivedMemoryIds: [archived.id],
            compressionCount: 1,
            createdAt: 1,
            updatedAt: 1,
            lastCompressedAt: 1,
        };
        await EventBoxDB.save(box);
        clearReceipts(charId);
        recordRecallReceipt(charId, [live.id, standalone.id]);

        const snapshot = await loadRecallRepairSnapshot(charId, 0);
        expect(snapshot.standalone.map(item => item.node.id)).toEqual([standalone.id]);
        expect(snapshot.boxes).toHaveLength(1);
        expect(snapshot.boxes[0].nodes.map(item => [item.node.id, item.kind])).toEqual([
            [summary.id, 'summary'],
            [live.id, 'live'],
            [archived.id, 'archived'],
        ]);
        expect(snapshot.boxes[0].recalledNodeIds).toEqual([live.id]);
    });

    it('修補現場使用真實記憶日期，不把中午佔位偽裝成精確時分', () => {
        const timestamp = new Date(2026, 6, 28, 12, 0, 0).getTime();
        expect(formatRepairMemoryDate(timestamp, timestamp)).toBe('2026年7月28日（今天）');
    });

    it('面向用戶的診斷不殘留“用戶/角色”分析術語', () => {
        expect(naturalizeMemoryRepairLanguage(
            '該用戶指出這個角色記錯了，角色本人需要核對。',
            '阿寧',
            '小滿',
        )).toBe('小滿指出阿寧記錯了，阿寧需要核對。');
    });

    it('診斷上下文按約定走 false，並隔離持久記憶和運行時向量注入', () => {
        const char = {
            id: 'repair_context',
            name: '阿寧',
            avatar: '',
            description: '',
            systemPrompt: '說話簡潔。',
            memories: [{ id: 'legacy', date: '2026-01-01', summary: 'LEGACY_MEMORY_MARKER' }],
            refinedMemories: { '2026-01': 'REFINED_MEMORY_MARKER' },
            activeMemoryMonths: ['2026-01'],
            memoryPalaceEnabled: true,
            memoryPalaceInjection: 'VECTOR_MEMORY_MARKER',
            roomPlatesInjection: 'ROOM_PLATE_MARKER',
            buffInjection: 'BUFF_MARKER',
        } as CharacterProfile;
        const user = { name: '小滿' } as UserProfile;

        const context = buildMemoryRepairCoreContext(char, user);
        expect(context).toContain('阿寧');
        expect(context).not.toContain('LEGACY_MEMORY_MARKER');
        expect(context).not.toContain('REFINED_MEMORY_MARKER');
        expect(context).not.toContain('VECTOR_MEMORY_MARKER');
        expect(context).not.toContain('ROOM_PLATE_MARKER');
        expect(context).not.toContain('BUFF_MARKER');
    });

    it('引路者問候由角色風格穩定選擇，不調用模型生成', () => {
        const char = {
            id: 'guide_style',
            name: '阿寧',
            personalityStyle: 'imagery',
        } as CharacterProfile;
        const first = getMemoryGuideCopy(char, '小滿');
        const second = getMemoryGuideCopy(char, '小滿');

        expect(first).toEqual(second);
        expect(first.greeting).toContain('小滿');
        expect(first.trail.length).toBeGreaterThan(4);
    });

    it('用戶可用不完整關鍵詞和日期模糊找到可修改記憶，包含歸檔節點', () => {
        const nodes = [
            node('beach', 'search_char', '去年在海邊一起過了生日', {
                tags: ['旅行', '禮物'],
                createdAt: new Date(2026, 6, 3, 12, 0, 0).getTime(),
            }),
            node('archived', 'search_char', '舊車站告別', {
                archived: true,
                eventBoxId: 'box_1',
            }),
            node('other', 'search_char', '在家看了一整天電影'),
        ];

        expect(filterEditableMemoryNodes(nodes, '海 生').map(item => item.node.id))
            .toEqual(['beach']);
        expect(filterEditableMemoryNodes(nodes, '海生').map(item => item.node.id))
            .toEqual(['beach']);
        expect(filterEditableMemoryNodes(nodes, '2026-07').map(item => item.node.id))
            .toEqual(['beach']);
        expect(filterEditableMemoryNodes(nodes, '車站')[0]).toMatchObject({
            node: { id: 'archived' },
            kind: 'archived',
        });
    });
});
