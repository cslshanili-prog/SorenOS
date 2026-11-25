import { buildZip } from './zipStream/factory';
import type { Emoji } from '../types';
import { getBlobForRef, isBlobRef } from './blobRef';
import { fetchBlobForShare } from './shareExport';

const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '表情';

export async function emojiExtension(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const header = String.fromCharCode(...bytes);
    if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif';
    if (bytes[0] === 137 && header.slice(1, 4) === 'PNG') return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'webp';
    const extension = ({ 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico' } as Record<string, string>)[blob.type.split(';')[0]];
    if (!extension) throw new Error('無法識別圖片原始格式');
    return extension;
}

/** Keep original bytes, including animation; never re-encode through canvas. */
export async function prepareEmojiExport(emojis: Pick<Emoji, 'name' | 'url'>[], title = '表情包') {
    if (!emojis.length) throw new Error('沒有可下載的表情');

    /** 一張一張取出來：原檔、不重複的檔名 */
    const each = async (onEmoji: (blob: Blob, fileName: string) => Promise<void> | void) => {
        const used = new Set<string>();
        for (const emoji of emojis) {
            const blob = isBlobRef(emoji.url) ? await getBlobForRef(emoji.url) : await fetchBlobForShare(emoji.url);
            if (!blob?.size) throw new Error(`表情「${emoji.name}」的原文件已丟失`);
            const ext = await emojiExtension(blob);
            const base = safeName(emoji.name).replace(/\.(png|gif|jpe?g|webp|avif|svg|bmp|ico)$/i, '');
            let fileName = `${base}.${ext}`, suffix = 2;
            while (used.has(fileName.toLowerCase())) fileName = `${base}_${suffix++}.${ext}`;
            used.add(fileName.toLowerCase());
            await onEmoji(blob, fileName);
        }
    };

    if (emojis.length === 1) {
        let single: { blob: Blob; fileName: string } | undefined;
        await each((blob, fileName) => { single = { blob, fileName }; });
        return single!;
    }

    // 一張寫出去就放、再讀下一張（plans/backup-streaming.md 第 4 批）；以前是全部讀進記憶體、最後一次打包
    const blob = await buildZip({ tmpPrefix: 'emoji' }, async (zip) => {
        await each(async (emojiBlob, fileName) => {
            zip.file(fileName, emojiBlob, { compression: 'STORE' });
            await zip.drain();
        });
    });
    return { blob, fileName: `${safeName(title)}.zip` };
}
