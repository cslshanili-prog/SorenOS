import { Message } from '../../types';
import { isBlobRef } from '../blobRef';

/**
 * 群聊日誌行裡一條消息的文本表示——非文本類型用佔位符。
 * image 的 content 是 base64（processImage 壓的 JPEG）、emoji 是圖床 URL，
 * 都不能內聯進 prompt：base64 會把上下文撐爆，URL 是純噪聲。
 */
export function messageLogText(m: Message, stickerName?: (url: string) => string): string {
    const rawText = typeof m.content === 'string' ? m.content : '';
    if (m.type === 'image') return '[圖片]';
    if (m.type === 'emoji') return `[表情包: ${stickerName ? stickerName(rawText.trim()) : '表情'}]`;
    if (m.type === 'transfer') {
        if (m.metadata?.packetReceipt) return m.metadata.packetReceipt === 'claimed' ? '[領取紅包]' : '[退回紅包]';
        if (m.metadata?.packet) return `[發紅包: ${m.metadata.totalAmount}]`;
        return `[發紅包: ${m.metadata?.amount ?? ''}]`;
    }
    // 令牌（blobref:）也算媒體：圖片二進制存在 blob_assets 裡，正文位置只留一個短引用，
    // 內聯進 prompt 同樣是純噪聲。跟 groupChat/prompts.ts 的同款兜底保持一個口徑。
    const trimmed = rawText.trim();
    if (/^(data:|https?:\/\/)/i.test(trimmed) || isBlobRef(trimmed)) return '[媒體]';
    return rawText;
}
