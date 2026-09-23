// 圖標柵格化：把任意圖片源渲染成固定邊長的正方形 PNG data URL。
//
// 為什麼必須轉 PNG：iOS 的 apple-touch-icon 只穩定支持 PNG。上傳管線
// （utils/file.ts 的 processImageToBlob）默認吐 JPEG，圖床拉下來的還可能是 WebP，
// 直接拿去當圖標 iOS 會靜默忽略、繼續用舊圖標。
//
// 為什麼必須定尺寸：apple-touch-icon 標準邊長 180；源圖 512 轉出來的 data URI
// 動輒幾百 KB，塞進 <link href> 又慢又容易踩到實現上限。

/** 等比縮放並居中裁切（cover），鋪滿整個正方形——圖標不該留白邊。 */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number): void {
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

/**
 * 把圖片源渲染成 `size × size` 的 PNG data URL。
 *
 * 遠程 URL 會汙染 canvas 導致 toDataURL 拋 SecurityError，所以調用方應先 fetch 成
 * Blob 再傳進來（AppIconEditor 的「填入鏈接」就是這麼做的）。
 */
export function toSquarePngDataUrl(src: Blob | string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = src instanceof Blob ? URL.createObjectURL(src) : null;
    const href = objectUrl ?? (src as string);

    const cleanup = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };

    const img = new Image();
    // 遠程圖需要 CORS 頭才能不汙染畫布；圖床一般都給。拿不到就走 onerror。
    if (!objectUrl) img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context 拿不到');

        ctx.clearRect(0, 0, size, size);
        drawCover(ctx, img, size);

        // 固定 PNG：iOS apple-touch-icon 只穩定認這個格式
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('圖片加載失敗'));
    };

    img.src = href;
  });
}
