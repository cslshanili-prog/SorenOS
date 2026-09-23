/**
 * Memory Palace — 導出
 *
 * 把某個角色（或全部角色）的記憶宮殿數據打包成可讀 + 可機讀的 JSON，
 * 方便用戶接入自己的外置記憶庫。
 *
 * 導出內容：記憶節點（content/room/importance/mood/tags/時間…）、事件盒、期盼。
 *
 * 向量（includeVectors）：可選。
 *   - 關掉：文件小，但目標側需自行重新向量化。
 *   - 打開：連 embedding 向量一起導出。**只要繼續用同一個 embedding 模型 +
 *     維度**，向量可直接複用，省掉重新向量化的錢和時間、檢索結果完全一致；
 *     換了模型則向量作廢（vector.model / dimensions 已隨每條一起導出，便於核對）。
 */

import { MemoryNodeDB, AnticipationDB, EventBoxDB, MemoryVectorDB, RoomPlateDB, plateId } from './db';
import type { MemoryNode, Anticipation, EventBox, MemoryVector, RoomPlate, PlateRoom } from './types';
import { getRoomLabel, PLATE_ROOMS, PLATE_ENTRY_CAPS } from './types';
import { memoryContentWithDates, relativeTimeEnabled } from './relativeTime';

type ReadableExportNode = MemoryNode & { relativeTimeExport?: { version: 1; originalContent: string } };

/** 導出時隨向量一起帶上的元信息（便於接入方判斷能否複用） */
export interface ExportedVector {
    memoryId: string;
    /** 普通 number[]，長度 = dimensions */
    vector: number[];
    dimensions: number;
    /** 生成該向量的 embedding 模型；與目標側模型一致才可直接複用 */
    model?: string;
}

/** 單個角色的導出結構 */
export interface CharacterMemoryPalaceExport {
    charId: string;
    charName: string;
    counts: { nodes: number; eventBoxes: number; anticipations: number; vectors: number; roomPlateEntries?: number };
    /** 該角色向量統一用的 embedding 模型/維度（多數情況下整庫一致，便於接入方一眼確認） */
    embeddingModels: string[];
    nodes: MemoryNode[];
    eventBoxes: EventBox[];
    anticipations: Anticipation[];
    /** 房間門牌（常駐語義層）。舊導出文件沒有此字段，導入端按可選處理 */
    roomPlates?: RoomPlate[];
    /** includeVectors=false 時為 undefined */
    vectors?: ExportedVector[];
}

/** 頂層導出文件結構 */
export interface MemoryPalaceExportFile {
    type: 'sully_memory_palace_export';
    version: 1;
    exportedAt: number;
    exportedAtISO: string;
    includeVectors: boolean;
    note: string;
    characters: CharacterMemoryPalaceExport[];
}

const NOTE_WITH_VECTORS =
    'nodes 即每一條記憶，content 為正文，room 為所屬房間（含義見 roomLabel）；eventBoxes 為事件盒（summaryNodeId 指向整合回憶節點）。' +
    'vectors 為 embedding 向量，按 memoryId 與 nodes 對應：只要接入方繼續用同一個 embedding 模型 + 維度即可直接複用，無需重新向量化；換模型則向量作廢（每條帶 model/dimensions 便於核對）。';

const NOTE_NO_VECTORS =
    'nodes 即每一條記憶，content 為正文，room 為所屬房間（含義見 roomLabel）；eventBoxes 為事件盒（summaryNodeId 指向整合回憶節點）。' +
    '本次未導出向量（僅文本結構），接入方需要語義檢索時請在目標側自行重新向量化。';

/** 收集單個角色的記憶宮殿數據 */
async function collectCharacter(
    charId: string,
    charName: string,
    includeVectors: boolean,
): Promise<CharacterMemoryPalaceExport> {
    const [nodes, eventBoxes, anticipations, roomPlates] = await Promise.all([
        MemoryNodeDB.getByCharId(charId),
        EventBoxDB.getByCharId(charId),
        AnticipationDB.getByCharId(charId),
        RoomPlateDB.getByCharId(charId),
    ]);

    let vectors: ExportedVector[] | undefined;
    const modelSet = new Set<string>();
    if (includeVectors) {
        // getAllByCharId 出 DB 層後向量一律是 Float32Array，轉成普通 number[] 才能進 JSON
        const raw = await MemoryVectorDB.getAllByCharId(charId);
        vectors = raw.map(v => {
            if (v.model) modelSet.add(`${v.model}@${v.dimensions}d`);
            return {
                memoryId: v.memoryId,
                vector: Array.from(v.vector as Float32Array),
                dimensions: v.dimensions,
                model: v.model,
            };
        });
    }

    // 給每條記憶補一個人類可讀的房間名，外置庫無需自己映射枚舉
    const annotate = relativeTimeEnabled();
    const enrichedNodes = nodes.map(n => {
        const content = memoryContentWithDates(n, annotate);
        return { ...n, content, roomLabel: getRoomLabel(n.room),
            ...(content !== n.content ? { relativeTimeExport: { version: 1, originalContent: n.content } } : {}),
        };
    });
    return {
        charId,
        charName,
        counts: {
            nodes: nodes.length,
            eventBoxes: eventBoxes.length,
            anticipations: anticipations.length,
            vectors: vectors?.length ?? 0,
            roomPlateEntries: roomPlates.reduce((s, p) => s + p.entries.length, 0),
        },
        embeddingModels: [...modelSet],
        nodes: enrichedNodes as MemoryNode[],
        eventBoxes,
        anticipations,
        roomPlates,
        vectors,
    };
}

/** 導出一個或多個角色的記憶宮殿數據為 JSON 文件結構 */
export async function exportMemoryPalace(
    chars: { id: string; name: string }[],
    options: { includeVectors?: boolean } = {},
): Promise<MemoryPalaceExportFile> {
    const includeVectors = options.includeVectors ?? false;
    const characters: CharacterMemoryPalaceExport[] = [];
    for (const c of chars) {
        characters.push(await collectCharacter(c.id, c.name, includeVectors));
    }
    const now = Date.now();
    return {
        type: 'sully_memory_palace_export',
        version: 1,
        exportedAt: now,
        exportedAtISO: new Date(now).toISOString(),
        includeVectors,
        note: (includeVectors ? NOTE_WITH_VECTORS : NOTE_NO_VECTORS) + (relativeTimeEnabled()
            ? '相對時間補註已開啟：content 包含可讀日期；relativeTimeExport.originalContent 保留原文，向量對應原文。重新導入時恢復原文和日期來源，避免重複補註。' : ''),
        characters,
    };
}

// ─── 導入 ─────────────────────────────────────────────
//
// 把一份導出 JSON 灌回某個目標角色的記憶宮殿（合併，不清空已有數據）。
// 所有節點/事件盒/期盼都會重新生成 ID 並改掛到目標角色，內部引用
// （事件盒↔節點、summary、predecessor、sourceId）按 ID 映射表同步重寫，
// 因此同一份文件導入兩次會得到兩份獨立副本，不會互相覆蓋。

/** 導入結果統計 */
export interface ImportResult {
    nodes: number;
    eventBoxes: number;
    anticipations: number;
    vectors: number;
    /** 併入目標角色門牌的條目數（受各門牌容量上限約束，同文本去重） */
    roomPlateEntries: number;
    /** 文件裡帶了向量但本次因模型不符等原因未啟用語義檢索時的提示（保留字段，當前恆空） */
    warning?: string;
}

function genNodeId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function genBoxId(): string {
    return `eb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function genAntId(): string {
    return `ant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 運行時校驗：是不是一份記憶宮殿導出文件 */
export function isMemoryPalaceExportFile(data: any): data is MemoryPalaceExportFile {
    return !!data
        && data.type === 'sully_memory_palace_export'
        && Array.isArray(data.characters);
}

/**
 * 把導出文件導入到目標角色（合併）。文件裡可能含多個角色，全部併入同一個
 * 目標角色。已有數據不動，新數據以全新 ID 追加。
 */
export async function importMemoryPalace(
    file: MemoryPalaceExportFile,
    targetCharId: string,
): Promise<ImportResult> {
    if (!isMemoryPalaceExportFile(file)) {
        throw new Error('文件格式不對：不是 Soren 記憶宮殿導出文件');
    }

    // 跨全部角色收集老 ID → 新 ID 映射（節點 / 事件盒）
    const nodeIdMap = new Map<string, string>();
    const boxIdMap = new Map<string, string>();
    // 老 memoryId → 導出的向量，用於判斷節點是否帶向量
    const vectorByOldId = new Map<string, ExportedVector>();

    for (const c of file.characters) {
        for (const n of c.nodes || []) {
            if (!nodeIdMap.has(n.id)) nodeIdMap.set(n.id, genNodeId());
        }
        for (const b of c.eventBoxes || []) {
            if (!boxIdMap.has(b.id)) boxIdMap.set(b.id, genBoxId());
        }
        for (const v of c.vectors || []) {
            vectorByOldId.set(v.memoryId, v);
        }
    }

    const nodesToSave: MemoryNode[] = [];
    const vectorsToSave: MemoryVector[] = [];
    const boxesToSave: EventBox[] = [];
    const antsToSave: Anticipation[] = [];

    const remapId = (map: Map<string, string>, old?: string | null): string | undefined =>
        (old && map.has(old)) ? map.get(old)! : undefined;

    for (const c of file.characters) {
        // 節點
        for (const n of c.nodes || []) {
            const newId = nodeIdMap.get(n.id)!;
            let hasVector = vectorByOldId.has(n.id);
            // 去掉導出時附加的 roomLabel 字段，只保留 MemoryNode 自身的字段
            const { roomLabel, relativeTimeExport, ...rest } = n as ReadableExportNode & { roomLabel?: string };
            if (relativeTimeExport) {
                const original = relativeTimeExport.originalContent;
                if (relativeTimeExport.version === 1 && typeof original === 'string'
                    && memoryContentWithDates({ ...rest, content: original }, true) === n.content) {
                    rest.content = original;
                } else {
                    // The exported readable text was edited: preserve it, never silently replace it or reuse stale vectors.
                    delete rest.relativeTimeAnchor;
                    vectorByOldId.delete(n.id);
                    hasVector = false;
                }
            }
            nodesToSave.push({
                ...rest,
                id: newId,
                charId: targetCharId,
                eventBoxId: remapId(boxIdMap, n.eventBoxId),
                sourceId: remapId(nodeIdMap, n.sourceId),
                // 帶向量才算已嵌入；不帶向量的節點標記未嵌入，等後續重建向量
                embedded: hasVector,
            });

            if (hasVector) {
                const v = vectorByOldId.get(n.id)!;
                vectorsToSave.push({
                    memoryId: newId,
                    charId: targetCharId,
                    vector: Float32Array.from(v.vector),
                    dimensions: v.dimensions,
                    model: v.model,
                });
            }
        }

        // 事件盒
        for (const b of c.eventBoxes || []) {
            const newBoxId = boxIdMap.get(b.id)!;
            boxesToSave.push({
                ...b,
                id: newBoxId,
                charId: targetCharId,
                summaryNodeId: remapId(nodeIdMap, b.summaryNodeId) ?? null,
                liveMemoryIds: (b.liveMemoryIds || []).map(id => nodeIdMap.get(id)).filter(Boolean) as string[],
                archivedMemoryIds: (b.archivedMemoryIds || []).map(id => nodeIdMap.get(id)).filter(Boolean) as string[],
                predecessorBoxId: remapId(boxIdMap, b.predecessorBoxId),
            });
        }

        // 期盼
        for (const a of c.anticipations || []) {
            antsToSave.push({ ...a, id: genAntId(), charId: targetCharId });
        }
    }

    // 批量寫入（MemoryNodeDB.saveMany 會順帶建 BM25 倒排索引）
    if (nodesToSave.length) await MemoryNodeDB.saveMany(nodesToSave);
    if (vectorsToSave.length) await MemoryVectorDB.saveMany(vectorsToSave);
    if (boxesToSave.length) await EventBoxDB.saveMany(boxesToSave);
    for (const a of antsToSave) await AnticipationDB.save(a);

    // 房間門牌：併入目標角色對應房間的門牌（合併語義——同文本去重、
    // 尊重各門牌容量上限、條目重新生成 ID；firstLearnedAt/sourceCount 原樣保留）
    let plateEntriesImported = 0;
    for (const c of file.characters) {
        for (const p of c.roomPlates || []) {
            if (!(PLATE_ROOMS as string[]).includes(p.room)) continue;
            const room = p.room as PlateRoom;
            const target: RoomPlate = (await RoomPlateDB.get(targetCharId, room)) || {
                id: plateId(targetCharId, room),
                charId: targetCharId,
                room,
                entries: [],
                updatedAt: Date.now(),
                version: 0,
            };
            const seenTexts = new Set(target.entries.map(e => e.text));
            const cap = PLATE_ENTRY_CAPS[room];
            let added = 0;
            for (const entry of p.entries || []) {
                if (target.entries.length >= cap) break;
                const text = (entry.text || '').trim();
                if (!text || seenTexts.has(text)) continue;
                seenTexts.add(text);
                target.entries.push({
                    ...entry,
                    text,
                    id: `pe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                });
                added++;
            }
            if (added > 0) {
                target.updatedAt = Date.now();
                target.version += 1;
                await RoomPlateDB.save(target);
                plateEntriesImported += added;
            }
        }
    }

    return {
        nodes: nodesToSave.length,
        eventBoxes: boxesToSave.length,
        anticipations: antsToSave.length,
        vectors: vectorsToSave.length,
        roomPlateEntries: plateEntriesImported,
    };
}
