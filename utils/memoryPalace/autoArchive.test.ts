import { describe, expect, it } from 'vitest';
import type { CharacterProfile, MemoryFragment } from '../../types';
import { DB } from '../db';
import type { MemoryNode } from './types';
import { buildConservativeRepairFragments, persistAutoArchiveResult } from './autoArchive';

const noon = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12).getTime();

function node(
    id: string,
    year: number,
    month: number,
    day: number,
    overrides: Partial<MemoryNode> = {},
): MemoryNode {
    const createdAt = noon(year, month, day);
    return {
        id,
        charId: 'char-1',
        content: `記憶-${id}`,
        room: 'living_room',
        tags: [],
        importance: 5,
        mood: 'neutral',
        embedded: true,
        createdAt,
        lastAccessedAt: createdAt,
        accessCount: 0,
        origin: 'extraction',
        ...overrides,
    };
}

describe('全自動記憶雙寫缺口修復', () => {
    it('統一持久化入口會寫入神經鏈接，並在開關關閉後停止寫入', async () => {
        const enabled = {
            id: 'auto-archive-enabled',
            name: '已開啟角色',
            memories: [],
            memoryPalaceEnabled: true,
            autoArchiveEnabled: true,
        } as unknown as CharacterProfile;
        const disabled = {
            ...enabled,
            id: 'auto-archive-disabled',
            name: '已關閉角色',
            autoArchiveEnabled: false,
        } as CharacterProfile;
        await DB.saveCharacter(enabled);
        await DB.saveCharacter(disabled);

        const result = {
            stored: 1,
            skipped: 0,
            processedMessages: 20,
            memories: [],
            batches: [],
            autoArchive: {
                fragments: [{ id: 'fragment-1', date: '2026-07-22', summary: '- 已雙寫', mood: 'palace' }],
                hideBeforeMessageId: 123,
            },
        };
        await persistAutoArchiveResult(enabled.id, result);
        await persistAutoArchiveResult(disabled.id, result);

        const characters = await DB.getAllCharacters();
        const savedEnabled = characters.find(character => character.id === enabled.id)!;
        const savedDisabled = characters.find(character => character.id === disabled.id)!;
        expect(savedEnabled.memories).toEqual(result.autoArchive.fragments);
        expect(savedEnabled.hideBeforeMessageId).toBe(123);
        expect(savedDisabled.memories).toEqual([]);
        expect(savedDisabled.hideBeforeMessageId).toBeUndefined();
    });

    it('只補最後一條 palace 日誌之後、神經鏈接整天為空的聊天提取節點', () => {
        const existing: MemoryFragment[] = [
            { id: 'old', date: '2026-07-21', mood: 'palace', summary: '- 已同步' },
            { id: 'manual', date: '2026-07-26', mood: 'calm', summary: '用戶手動寫過的記憶' },
        ];
        const nodes = [
            node('before', 2026, 7, 20),
            node('missing-a', 2026, 7, 22),
            node('missing-b', 2026, 7, 22),
            node('digestion', 2026, 7, 23, { origin: 'digestion' }),
            node('group', 2026, 7, 24, { groupId: 'group-1' }),
            node('box-summary', 2026, 7, 25, { isBoxSummary: true }),
            node('occupied-day', 2026, 7, 26),
        ];

        const repaired = buildConservativeRepairFragments(existing, nodes);

        expect(repaired).toHaveLength(1);
        expect(repaired[0].date).toBe('2026-07-22');
        expect(repaired[0].mood).toBe('palace');
        expect(repaired[0].summary).toContain('記憶-missing-a');
        expect(repaired[0].summary).toContain('記憶-missing-b');
        expect(repaired[0].summary).not.toContain('digestion');
        expect(repaired[0].summary).not.toContain('occupied-day');
    });

    it('沒有歷史 palace 雙寫證據時不猜測回填', () => {
        const repaired = buildConservativeRepairFragments(
            [{ id: 'manual', date: '2026-07-21', mood: 'calm', summary: '手動記憶' }],
            [node('later', 2026, 7, 22)],
        );
        expect(repaired).toEqual([]);
    });
});
