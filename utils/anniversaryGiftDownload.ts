import { ANNIVERSARY_ARTIST, ANNIVERSARY_FRAME_STYLE, ANNIVERSARY_FRAME_URL, ANNIVERSARY_WALLPAPERS } from './anniversaryGifts';

export const ANNIVERSARY_DOWNLOAD_NAME = `SullyOS-一週年贈禮-${ANNIVERSARY_ARTIST}.zip`;
export const ANNIVERSARY_DOWNLOAD_IMAGES = [
  ...ANNIVERSARY_WALLPAPERS.map(image => ({ url: image.url, fileName: `壁紙-${image.name}.jpg`, signature: [0xff, 0xd8, 0xff] })),
  { url: ANNIVERSARY_FRAME_URL, fileName: '頭像框-尊貴貓貓.png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/** Fetch every original before creating a ZIP, so a missing image never produces a partial gift. */
export async function createAnniversaryGiftArchive(): Promise<Blob> {
  const images = await Promise.all(ANNIVERSARY_DOWNLOAD_IMAGES.map(async image => {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`無法讀取${image.fileName}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Some static hosts return index.html with status 200 for a missing asset.
    if (bytes.length <= image.signature.length || !image.signature.every((byte, i) => bytes[i] === byte)) {
      throw new Error(`${image.fileName}不是有效的原圖`);
    }
    return { ...image, bytes };
  }));
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const image of images) zip.file(image.fileName, image.bytes);
  zip.file('作者與使用說明.txt', [
    'Soren 一週年贈禮',
    `壁紙與頭像框作者：${ANNIVERSARY_ARTIST}`,
    '',
    '內含兩張壁紙與一枚透明 PNG 頭像框，均為未經裁切、重繪或重新壓縮的原圖。',
    '解壓後，可在手機壁紙、聊天背景或氣泡工坊的頭像掛件設置中自行上傳。',
    '',
    '頭像框位置參考（先把聊天頭像設為圓形）：',
    `縮放 ${ANNIVERSARY_FRAME_STYLE.avatarDecorationScale} 倍；X ${ANNIVERSARY_FRAME_STYLE.avatarDecorationX}%；Y ${ANNIVERSARY_FRAME_STYLE.avatarDecorationY}%；旋轉 0°。`,
  ].join('\n'));
  return new Blob([await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })], { type: 'application/zip' });
}
