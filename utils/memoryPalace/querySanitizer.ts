/**
 * Memory Palace — 檢索查詢源消息清洗
 *
 * retrieveMemories 的 query 構建曾直接吃原始 Message.content。問題：
 * 聊天裡發的圖片 content 是整段 base64 data URI（Chat.tsx 的
 * processImage → handleSendText(base64, 'image')，動輒幾萬字符）——
 * pipeline 的 URL_RE 只剝 http(s) URL，`data:image/...;base64,...` 會
 * 原樣切進 spike / sub-spike / rerank / context 多路 query：
 *   - 語義上是純噪聲，稀釋真實意圖的召回
 *   - 體積上把 Embedding 批量請求的 token 總量頂爆——硅基流動等服務商
 *     直接 400 code 20015 "The parameter is invalid"（「測試連接」單條
 *     短文本正常、一給角色發消息就報錯的典型根因）
 *
 * 入庫管線早就用 isMessageSemanticallyRelevant 過濾了（pipeline.ts 的
 * processNewMessages），檢索管線是漏網的——這裡補齊。
 */

import type { Message } from '../../types';
import { isMessageSemanticallyRelevant, normalizeMessageContent } from '../messageFormat';

/**
 * data URI（base64 內嵌資源）。URL_RE 只剝 http(s)，這類要單獨剝——
 * 除了 image 消息本體，用戶在文本里粘貼、卡片 metadata 洩漏進 content
 * 的 data URI 也一併兜住。base64 體內無空白，\S* 能整段吃掉。
 */
const DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]\S*/gi;

/**
 * 把原始消息列表清洗成「可以安全參與檢索 query 構建」的列表：
 *
 * 1. 丟掉無語義消息（image/emoji、無轉寫的純音頻及空消息）—— 與入庫口徑一致
 *    有配套文字的 voice 會轉成「語音轉寫」繼續參與檢索
 * 2. 卡片/系統類消息經 normalizeMessageContent 翻成可讀文本
 *    （music_card 的 content 可能是佔位符、score_card 可能是 JSON）
 * 3. 剝離所有 data URI；剝完變空的消息一併丟掉
 *
 * 純函數，不碰 IDB / 網絡。text 消息內容不變時保留原對象引用。
 */
export function sanitizeQuerySourceMessages(
    messages: Message[],
    charName?: string,
    userName?: string,
): Message[] {
    const out: Message[] = [];
    for (const m of messages) {
        if (!isMessageSemanticallyRelevant(m)) continue;
        const type = m.type as string | undefined;
        const raw = (!type || type === 'text')
            ? (m.content || '')
            : normalizeMessageContent(m, charName || '', userName || 'TA');
        const cleaned = raw.replace(DATA_URI_RE, ' ');
        if (!cleaned.trim()) continue;
        out.push(cleaned === m.content ? m : { ...m, content: cleaned });
    }
    return out;
}
