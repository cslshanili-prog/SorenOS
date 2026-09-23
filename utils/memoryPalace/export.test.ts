import { describe, it, expect } from 'vitest';
import { MemoryNodeDB, MemoryVectorDB, EventBoxDB, AnticipationDB, RoomPlateDB, plateId } from './db';
import { exportMemoryPalace, importMemoryPalace, isMemoryPalaceExportFile } from './export';
import type { MemoryNode, EventBox, Anticipation, MemoryVector, RoomPlate } from './types';
import { PLATE_ENTRY_CAPS } from './types';

// fake-indexeddb 已通過 test-setup.ts 注入。
// 這組用例鎖住記憶宮殿「導出 → 導入」往返：內容、向量、以及事件盒↔節點的內部引用
// 必須在重映射 ID 後依然自洽。

function makeNode(id: string, charId: string, over: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id, charId,
        content: `記憶 ${id}`,
        room: 'living_room',
        tags: ['t1', 't2'],
        importance: 5,
        mood: 'happy',
        embedded: false,
        createdAt: 1000,
        lastAccessedAt: 1000,
        accessCount: 0,
        ...over,
    };
}

async function seedChar(charId: string) {
    // 兩條節點 + 一個把它們裝在一起的事件盒（n1 是 summary，n2 是 live 成員）
    const n1 = makeNode('n1', charId, { embedded: true, content: '整合回憶', isBoxSummary: true });
    const n2 = makeNode('n2', charId, { eventBoxId: 'box1', sourceId: 'n1' });
    await MemoryNodeDB.saveMany([n1, n2]);

    // n1 帶向量（embedded=true）
    const vec: MemoryVector = {
        memoryId: 'n1', charId,
        vector: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        dimensions: 4, model: 'test-embed',
    };
    await MemoryVectorDB.save(vec);

    const box: EventBox = {
        id: 'box1', charId, name: '一次出遊', tags: ['trip'],
        summaryNodeId: 'n1', liveMemoryIds: ['n2'], archivedMemoryIds: [],
        compressionCount: 1, createdAt: 1000, updatedAt: 2000, lastCompressedAt: 2000,
    };
    await EventBoxDB.save(box);

    const ant: Anticipation = {
        id: 'ant1', charId, content: '想再去一次', status: 'active',
        createdAt: 1000, anchoredAt: null, resolvedAt: null,
    };
    await AnticipationDB.save(ant);
}

describe('記憶宮殿導出 / 導入', () => {
    it('帶向量導出後再導入到新角色：內容、向量、事件盒引用都自洽', async () => {
        const src = 'char_src_1';
        await seedChar(src);

        const file = await exportMemoryPalace([{ id: src, name: '糯米機' }], { includeVectors: true });
        expect(isMemoryPalaceExportFile(file)).toBe(true);
        expect(file.includeVectors).toBe(true);
        expect(file.characters[0].counts).toMatchObject({ nodes: 2, eventBoxes: 1, anticipations: 1, vectors: 1 });
        // 導出節點帶人類可讀房間名
        expect((file.characters[0].nodes[0] as any).roomLabel).toBeTruthy();

        const dst = 'char_dst_1';
        const result = await importMemoryPalace(file, dst);
        expect(result).toMatchObject({ nodes: 2, eventBoxes: 1, anticipations: 1, vectors: 1 });

        const nodes = await MemoryNodeDB.getByCharId(dst);
        expect(nodes).toHaveLength(2);
        // ID 全部重生成（不再是 n1/n2），且 charId 改掛到目標角色
        expect(nodes.every(n => n.id !== 'n1' && n.id !== 'n2')).toBe(true);
        expect(nodes.every(n => n.charId === dst)).toBe(true);
        // roomLabel 這種導出附加字段不應落庫
        expect(nodes.every(n => !('roomLabel' in n))).toBe(true);

        const boxes = await EventBoxDB.getByCharId(dst);
        expect(boxes).toHaveLength(1);
        const box = boxes[0];
        // 事件盒的 summary / live 引用指向的是導入後新生成的節點 ID，且確實存在
        const ids = new Set(nodes.map(n => n.id));
        expect(box.summaryNodeId && ids.has(box.summaryNodeId)).toBe(true);
        expect(box.liveMemoryIds.every(id => ids.has(id))).toBe(true);
        // 節點反向指回新盒
        const summaryNode = nodes.find(n => n.id === box.summaryNodeId)!;
        const liveNode = nodes.find(n => n.id === box.liveMemoryIds[0])!;
        expect(liveNode.eventBoxId).toBe(box.id);
        // sourceId 也按映射重寫到 summary 節點
        expect(liveNode.sourceId).toBe(summaryNode.id);

        // 向量隨 summary 節點一起遷移、改掛目標角色、內容不變
        const vecs = await MemoryVectorDB.getAllByCharId(dst);
        expect(vecs).toHaveLength(1);
        expect(vecs[0].memoryId).toBe(summaryNode.id);
        expect(Array.from(vecs[0].vector as Float32Array)).toEqual([
            expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5), expect.closeTo(0.4, 5),
        ]);
        // 帶向量的節點 embedded=true，另一條未帶向量的 embedded=false
        expect(summaryNode.embedded).toBe(true);
        expect(liveNode.embedded).toBe(false);
    });

    it('不帶向量導出：vectors 字段省略，導入後節點 embedded=false', async () => {
        const src = 'char_src_2';
        await seedChar(src);

        const file = await exportMemoryPalace([{ id: src, name: '糯米機' }], { includeVectors: false });
        expect(file.includeVectors).toBe(false);
        expect(file.characters[0].vectors).toBeUndefined();
        expect(file.characters[0].counts.vectors).toBe(0);

        const dst = 'char_dst_2';
        const result = await importMemoryPalace(file, dst);
        expect(result.vectors).toBe(0);

        const nodes = await MemoryNodeDB.getByCharId(dst);
        expect(nodes.every(n => n.embedded === false)).toBe(true);
        const vecs = await MemoryVectorDB.getAllByCharId(dst);
        expect(vecs).toHaveLength(0);
    });

    it('同一文件導入兩次得到兩份獨立副本，不互相覆蓋', async () => {
        const src = 'char_src_3';
        await seedChar(src);
        const file = await exportMemoryPalace([{ id: src, name: '糯米機' }], { includeVectors: true });

        const dst = 'char_dst_3';
        await importMemoryPalace(file, dst);
        await importMemoryPalace(file, dst);

        const nodes = await MemoryNodeDB.getByCharId(dst);
        expect(nodes).toHaveLength(4);
        const boxes = await EventBoxDB.getByCharId(dst);
        expect(boxes).toHaveLength(2);
        // 兩個盒子的成員集合互不相交（各自指向自己那批新節點）
        const [b0, b1] = boxes;
        const members = (b: typeof b0) => [b.summaryNodeId, ...b.liveMemoryIds].filter(Boolean) as string[];
        const overlap = members(b0).filter(id => members(b1).includes(id));
        expect(overlap).toHaveLength(0);
    });

    it('房間門牌隨導出走、導入按合併語義併入目標角色（去重 + 容量上限 + 重生成條目 ID）', async () => {
        const src = 'char_src_plate';
        await seedChar(src);
        const srcPlate: RoomPlate = {
            id: plateId(src, 'user_room'), charId: src, room: 'user_room',
            entries: [
                { id: 'pe_a', text: '父母離異，和男友同居', tag: '家庭', firstLearnedAt: 500, updatedAt: 900, sourceCount: 3 },
                { id: 'pe_b', text: '做設計相關的工作', tag: '工作', firstLearnedAt: 600, updatedAt: 900, sourceCount: 1 },
            ],
            updatedAt: 900, version: 2,
        };
        await RoomPlateDB.save(srcPlate);

        const file = await exportMemoryPalace([{ id: src, name: '糯米機' }], { includeVectors: false });
        expect(file.characters[0].counts.roomPlateEntries).toBe(2);
        expect(file.characters[0].roomPlates).toHaveLength(1);

        // 目標角色已有一塊門牌：一條與導入重複、一條獨有
        const dst = 'char_dst_plate';
        await RoomPlateDB.save({
            id: plateId(dst, 'user_room'), charId: dst, room: 'user_room',
            entries: [
                { id: 'pe_x', text: '父母離異，和男友同居', tag: '家庭', firstLearnedAt: 100, updatedAt: 100, sourceCount: 5 },
                { id: 'pe_y', text: '養了兩隻貓', firstLearnedAt: 200, updatedAt: 200, sourceCount: 2 },
            ],
            updatedAt: 200, version: 1,
        });

        const result = await importMemoryPalace(file, dst);
        expect(result.roomPlateEntries).toBe(1); // 只有"工作"那條是新的

        const merged = (await RoomPlateDB.get(dst, 'user_room'))!;
        expect(merged.entries).toHaveLength(3);
        expect(merged.entries.length).toBeLessThanOrEqual(PLATE_ENTRY_CAPS.user_room);
        // 原有條目原樣保留（重複文本沒被導入覆蓋，sourceCount 還是目標側的 5）
        const dup = merged.entries.find(e => e.text === '父母離異，和男友同居')!;
        expect(dup.id).toBe('pe_x');
        expect(dup.sourceCount).toBe(5);
        // 新併入的條目重生成了 ID，但 firstLearnedAt/sourceCount/tag 原樣帶過來
        const added = merged.entries.find(e => e.text === '做設計相關的工作')!;
        expect(added.id).not.toBe('pe_b');
        expect(added.firstLearnedAt).toBe(600);
        expect(added.tag).toBe('工作');
    });

    it('舊版導出文件（無 roomPlates 字段）導入不報錯', async () => {
        const src = 'char_src_legacy';
        await seedChar(src);
        const file = await exportMemoryPalace([{ id: src, name: '糯米機' }], { includeVectors: false });
        delete (file.characters[0] as any).roomPlates; // 模擬舊文件
        const result = await importMemoryPalace(file, 'char_dst_legacy');
        expect(result.roomPlateEntries).toBe(0);
        expect(result.nodes).toBe(2);
    });

    it('非法文件被 isMemoryPalaceExportFile 拒絕，importMemoryPalace 拋錯', async () => {
        expect(isMemoryPalaceExportFile({ foo: 'bar' })).toBe(false);
        expect(isMemoryPalaceExportFile(null)).toBe(false);
        await expect(importMemoryPalace({ type: 'nope' } as any, 'whatever')).rejects.toThrow();
    });
});

describe('窗台期盼人工糾錯', () => {
    it('可修改正文並刪除，不影響期盼的生命週期字段', async () => {
        const ant: Anticipation = {
            id: 'ant_crud_1',
            charId: 'char_ant_crud',
            content: '原來的期盼',
            status: 'anchor',
            createdAt: 1000,
            anchoredAt: 2000,
            resolvedAt: null,
        };
        await AnticipationDB.save(ant);
        await AnticipationDB.save({ ...ant, content: '修改後的期盼' });

        expect(await AnticipationDB.getById(ant.id)).toMatchObject({
            content: '修改後的期盼',
            status: 'anchor',
            createdAt: 1000,
            anchoredAt: 2000,
        });

        await AnticipationDB.delete(ant.id);
        expect(await AnticipationDB.getById(ant.id)).toBeUndefined();
    });
});
