import { describe, expect, it, vi } from 'vitest';
import type { GalleryImage } from '../types';
import { BATCH_DESCRIBE_MAX_CONSECUTIVE_FAILURES, pickUndescribedPhotos, runBatchDescribe } from './libraryDescribe';

const img = (id: string, patch: Partial<GalleryImage> = {}): GalleryImage => ({ id, charId: 'a', url: `blobref:${id}`, timestamp: 1, ...patch });

describe('資料庫 · 批次 AI 寫', () => {
    it('只挑還沒描述的照片：文件、空白描述以外的、沒圖的都不算；新的在前', () => {
        const list = [
            img('old', { timestamp: 1 }),
            img('blank', { description: '   ', timestamp: 3 }),
            img('done', { description: '陽台的咖啡杯' }),
            img('doc', { kind: 'file' }),
            img('nourl', { url: '' }),
            img('new', { timestamp: 5 }),
        ];
        expect(pickUndescribedPhotos(list).map(i => i.id)).toEqual(['new', 'blank', 'old']);
    });

    it('一張張寫、寫好就存；某張失敗記下來接著跑', async () => {
        const saved: string[] = [];
        const progress = vi.fn();
        const result = await runBatchDescribe([img('a'), img('b'), img('c')], {
            describe: async image => { if (image.id === 'b') throw new Error('逾時'); return `${image.id} 的描述`; },
            save: async (image, text) => { saved.push(`${image.id}:${text}`); },
            onProgress: progress,
        });
        expect(saved).toEqual(['a:a 的描述', 'c:c 的描述']);
        expect(result).toMatchObject({ stoppedBy: 'finished', done: 3, total: 3, succeeded: 2, failed: 1, lastError: '逾時' });
        expect(progress).toHaveBeenLastCalledWith({ done: 3, total: 3, succeeded: 2, failed: 1 });
    });

    it('連續失敗太多就停，別白花錢', async () => {
        const describeFn = vi.fn(async () => { throw new Error('模型不會看圖'); });
        const list = Array.from({ length: 10 }, (_, i) => img(`p${i}`));
        const result = await runBatchDescribe(list, { describe: describeFn, save: async () => {} });
        expect(describeFn).toHaveBeenCalledTimes(BATCH_DESCRIBE_MAX_CONSECUTIVE_FAILURES);
        expect(result).toMatchObject({ stoppedBy: 'failures', succeeded: 0, failed: BATCH_DESCRIBE_MAX_CONSECUTIVE_FAILURES });
    });

    it('中途停下：當前那張寫完就停', async () => {
        let cancel = false;
        const result = await runBatchDescribe([img('a'), img('b'), img('c')], {
            describe: async image => { if (image.id === 'a') cancel = true; return 'x'; },
            save: async () => {},
            isCancelled: () => cancel,
        });
        expect(result).toMatchObject({ stoppedBy: 'cancelled', done: 1, succeeded: 1 });
    });
});
