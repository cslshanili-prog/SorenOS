import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastWebShareFailure, mimeForFileName, shareBlobOnTap, shareOrDownloadBlob } from './shareExport';

const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share');
const originalCanShare = Object.getOwnPropertyDescriptor(navigator, 'canShare');

const originalUA = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const setUA = (ua: string) => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
/** 測試環境沒有 DOM：假一個 document，數下載連結被點了幾次 */
const fakeDownloadDom = () => {
  const click = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ click, remove: () => {} }), body: { appendChild: () => {} } });
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
  return click;
};

afterEach(() => {
  if (originalUA) Object.defineProperty(navigator, 'userAgent', originalUA);
  else Reflect.deleteProperty(navigator, 'userAgent');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalShare) Object.defineProperty(navigator, 'share', originalShare);
  else Reflect.deleteProperty(navigator, 'share');
  if (originalCanShare) Object.defineProperty(navigator, 'canShare', originalCanShare);
  else Reflect.deleteProperty(navigator, 'canShare');
});

describe('shareOrDownloadBlob web file sharing', () => {
  it('hands the real file to Web Share before considering a browser download', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });

    const result = await shareOrDownloadBlob({
      blob: new Blob(['real file'], { type: 'application/pdf' }),
      fileName: '協同交付.pdf',
      shareTitle: '協同交付',
    });

    expect(result).toBe('shared');
    expect(canShare).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0][0] as ShareData;
    expect(payload.title).toBe('協同交付');
    expect(payload.files?.[0]?.name).toBe('協同交付.pdf');
    expect(payload.files?.[0]?.size).toBe(9);
  });
});

describe('邊壓邊寫的備份檔交給 iOS 分享', () => {
  it('沒有類型的檔案照副檔名補上 MIME（OPFS 暫存檔沒有 type）', async () => {
    expect(mimeForFileName('Sully_Backup_full.zip')).toBe('application/zip');
    expect(mimeForFileName('a.JSON')).toBe('application/json');
    expect(mimeForFileName('noext')).toBe('application/octet-stream');
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    await shareOrDownloadBlob({ blob: new Blob(['zip']), fileName: 'b.zip' });
    expect((share.mock.calls[0][0] as ShareData).files?.[0]?.type).toBe('application/zip');
  });

  it('iOS 網頁自動分享被擋（沒有手勢）：不跳下載預覽頁，回 needs-tap 並記下原因', async () => {
    setUA(IPHONE_UA);
    const err = Object.assign(new Error('The request is not allowed by the user agent'), { name: 'NotAllowedError' });
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn().mockRejectedValue(err) });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    const click = fakeDownloadDom();
    const result = await shareOrDownloadBlob({ blob: new Blob(['zip']), fileName: 'b.zip', deferDownloadOnIos: true });
    expect(result).toBe('needs-tap');
    expect(click).not.toHaveBeenCalled();
    expect(lastWebShareFailure()).toContain('NotAllowedError');
  });

  it('不是 iOS、或沒要求延後：照舊退回下載連結', async () => {
    setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130');
    const err = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn().mockRejectedValue(err) });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    const click = fakeDownloadDom();
    expect(await shareOrDownloadBlob({ blob: new Blob(['zip']), fileName: 'b.zip', deferDownloadOnIos: true })).toBe('downloaded');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('點按鈕分享：原檔分享不成（不是手勢問題）就改用記憶體副本再試', async () => {
    setUA(IPHONE_UA);
    const share = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('could not read file'), { name: 'DataError' }))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    expect(await shareBlobOnTap(new Blob(['zipdata']), 'b.zip', 'Backup')).toBe('shared');
    expect(share).toHaveBeenCalledTimes(2);
    const second = (share.mock.calls[1][0] as ShareData).files?.[0];
    expect(second?.type).toBe('application/zip');
    expect(second?.size).toBe(7);
  });
});
