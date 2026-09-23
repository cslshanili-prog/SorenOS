import { beforeEach, describe, expect, it, vi } from 'vitest';
const share = vi.hoisted(() => vi.fn());
vi.mock('../shareExport', () => ({ shareOrDownloadBlob: share }));
import { saveMemoryPalaceExport } from './saveExport';
beforeEach(() => { share.mockReset(); });
describe('記憶導出複用全部備份分享流程', () => {
    it('發送完整 JSON，併為原生大文件啟用分片緩存寫入', async () => {
        share.mockResolvedValue('shared');
        expect(await saveMemoryPalaceExport('{"記憶":"中文"}', '記憶.json', '記憶宮殿')).toEqual({ kind: 'shared' });
        const options = share.mock.calls[0][0];
        expect(options).toMatchObject({ fileName: '記憶.json', shareTitle: '記憶宮殿', nativeChunked: true });
        expect(options.blob.type).toBe('application/json');
        expect(await options.blob.text()).toBe('{"記憶":"中文"}');
    });
    it('取消不報成功，分享失敗向上報告', async () => {
        share.mockResolvedValue('cancelled');
        expect(await saveMemoryPalaceExport('{}', '記憶.json', '導出')).toEqual({ kind: 'cancelled' });
        share.mockRejectedValue(new Error('分享不可用'));
        await expect(saveMemoryPalaceExport('{}', '記憶.json', '導出')).rejects.toThrow('分享不可用');
    });
});
