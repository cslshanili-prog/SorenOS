import { describe, expect, it } from 'vitest';
import { encodeVectorsForBackup, encodeVectorsForBackupChunked } from './db';

const makeRows = () => [
    { memoryId: 'm1', charId: 'c1', model: 'e1', vector: [0.1, 0.2, 0.3, 0.4] },
    { memoryId: 'm2', charId: 'c1', model: 'e1', vector: new Float32Array([1, 2, 3, 4]) },
    { memoryId: 'm3', charId: 'c2', vector: new Uint8Array(new Float32Array([-1, -2, -3, -4]).buffer) },
    { memoryId: 'm4', charId: 'c2', vector: [9, 8, 7, 6] },
    { memoryId: 'm5', charId: 'c3', vector: new Float32Array([0.5, 0.25, 0.125, 0.0625]) },
];

describe('記憶向量低內存備份編碼', () => {
    it('分批兩遍掃描與整表編碼字節、索引完全一致', async () => {
        const rows = makeRows();
        let scans = 0;
        let largestBatch = 0;
        const chunked = await encodeVectorsForBackupChunked(async (onBatch) => {
            scans++;
            for (let i = 0; i < rows.length; i += 2) {
                const batch = rows.slice(i, i + 2);
                largestBatch = Math.max(largestBatch, batch.length);
                await onBatch(batch);
            }
        });
        const whole = encodeVectorsForBackup(rows);

        expect(scans).toBe(2);
        expect(largestBatch).toBe(2);
        expect(chunked.index).toEqual(whole.index);
        expect(Array.from(chunked.bin)).toEqual(Array.from(whole.bin));
    });

    it('4500 條向量可只按 25 條批次生成，不要求調用方持有整表', async () => {
        const count = 4500;
        const dimensions = 1024;
        let scans = 0;
        let largestBatch = 0;
        const payload = await encodeVectorsForBackupChunked(async (onBatch) => {
            scans++;
            for (let start = 0; start < count; start += 25) {
                const size = Math.min(25, count - start);
                const batch = Array.from({ length: size }, (_, offset) => {
                    const row = start + offset;
                    return {
                        memoryId: `memory_${row}`,
                        charId: `char_${row % 3}`,
                        vector: new Float32Array(dimensions).fill(row / count),
                    };
                });
                largestBatch = Math.max(largestBatch, batch.length);
                await onBatch(batch);
            }
        });

        expect(scans).toBe(2);
        expect(largestBatch).toBe(25);
        expect(payload.index).toHaveLength(count);
        expect(payload.bin.byteLength).toBe(count * dimensions * 4);
        expect(payload.index.at(-1)).toMatchObject({
            memoryId: 'memory_4499',
            byteOffset: (count - 1) * dimensions * 4,
            byteLength: dimensions * 4,
        });
    });

    it('兩遍掃描之間記錄順序或內容變化會中止，不生成錯位備份', async () => {
        const rows = makeRows();
        let scan = 0;
        await expect(encodeVectorsForBackupChunked(async (onBatch) => {
            scan++;
            const current = scan === 1 ? rows : [...rows].reverse();
            await onBatch(current.slice(0, 3));
            await onBatch(current.slice(3));
        })).rejects.toThrow(/[备備]份期[间間][记記][忆憶]向量[发發]生[变變]化/);
    });
});
