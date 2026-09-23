import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANNIVERSARY_DOWNLOAD_IMAGES, ANNIVERSARY_DOWNLOAD_NAME, createAnniversaryGiftArchive } from './anniversaryGiftDownload';

afterEach(() => vi.unstubAllGlobals());

describe('週年贈禮下載', () => {
  it('一個 ZIP 收齊三張未經修改的原圖，並附上署名和手動上傳說明', async () => {
    const originals = await Promise.all(ANNIVERSARY_DOWNLOAD_IMAGES.map(image =>
      readFile(new URL(`../public/${image.url.slice(2)}`, import.meta.url))));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const index = ANNIVERSARY_DOWNLOAD_IMAGES.findIndex(image => image.url === url);
      return new Response(new Uint8Array(originals[index]));
    }));

    const blob = await createAnniversaryGiftArchive();
    expect(blob.type).toBe('application/zip');
    expect(ANNIVERSARY_DOWNLOAD_NAME).toContain('哈基米欠我錢');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files)).toHaveLength(4);
    for (const [index, image] of ANNIVERSARY_DOWNLOAD_IMAGES.entries()) {
      expect(await zip.file(image.fileName)!.async('uint8array')).toEqual(new Uint8Array(originals[index]));
    }
    const instructions = await zip.file('作者與使用說明.txt')!.async('string');
    expect(instructions).toContain('壁紙與頭像框作者：哈基米欠我錢');
    expect(instructions).toContain('自行上傳');
    expect(instructions).toContain('縮放 1.6 倍；X 53.9%；Y 52.2%');
  });

  it.each([
    ['缺失的圖片', 404, 'not found'],
    ['靜態站點返回的 HTML', 200, '<!DOCTYPE html><html></html>'],
  ])('%s 不會生成缺圖或含錯誤文件的 ZIP', async (_, status, body) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === ANNIVERSARY_DOWNLOAD_IMAGES[1].url) return new Response(body, { status });
      const image = ANNIVERSARY_DOWNLOAD_IMAGES.find(image => image.url === url)!;
      return new Response(new Uint8Array([...image.signature, 0]));
    }));
    await expect(createAnniversaryGiftArchive()).rejects.toThrow();
  });
});
