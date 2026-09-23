/**
 * 流式回覆的「預覽氣泡」計算 —— 純函數，無副作用。
 *
 * 主聊天路徑開啟 stream 後，邊收流邊把已完成行和安全的未完成尾句渲染成臨時預覽氣泡
 * （utils/safeApi.ts StreamHooks.onDelta → hooks/useChatAI.ts → apps/Chat.tsx）。
 * 流結束後仍由既有後處理管線 (applyAssistantPostProcessing) 負責真正的解析、
 * 落庫與渲染，預覽氣泡隨即被清掉 —— 預覽只影響體感延遲，不改變任何持久化行為。
 *
 * 因此這裡的過濾策略是「寧缺毋濫」：拿不準的行（指令、語音/翻譯/思考/日記/HTML 塊、
 * 未閉合標籤）一律不預覽，等最終管線處理。漏顯示只損失一點預覽完整度；
 * 錯顯示（把 [[DIARY_START]] 的日記正文當聊天氣泡彈出來）才是事故。
 *
 * 每次 onDelta 都基於累計全文全量重算（冪等）——safeFetchJson 內部重試會重開一條流、
 * 全文從頭累計，全量重算天然處理這種重置。
 */

import { ChatParser } from './chatParser';
import type { Message } from '../types';

/** 跨行塊規則：open 命中進入抑制態，直到 close 命中（含閉合行本身）。 */
const BLOCK_RULES: Array<{ open: RegExp; close: RegExp }> = [
    // Notion / 飛書日記多行塊 —— 正文是日記內容，不是聊天氣泡
    { open: /\[\[(?:FS_)?DIARY_START/i, close: /\[\[(?:FS_)?DIARY_END\]\]/i },
    // HTML 卡片塊
    { open: /\[html\]/i, close: /\[\/html\]/i },
    // 思考鏈（content 內嵌形態；reasoning_content 通道根本不進正文）
    { open: /<(?:think|thinking|thought)>/i, close: /<\/(?:think|thinking|thought)>/i },
    // 語音 / 字幕 / 雙語翻譯標籤 —— 由最終管線成對解析渲染，預覽一律不碰
    { open: /<[语語語]音[^>]*>/, close: /<\/\s*[语語語]音\s*>/ },
    { open: /<字幕>/, close: /<\/字幕>/ },
    { open: /<翻[译譯]>/, close: /<\/翻[译譯]>/ },
];

/** 單行級排除：含任何 [[...]] 指令、日程指令、雙語標記的行不預覽。 */
function isLinePreviewable(line: string): boolean {
    if (!line) return false;
    if (line.includes('[[')) return false;                    // SEND_EMOJI / QUOTE / ACTION / RECALL / XHS_* …
    if (/^\[schedule_message\s*\|/i.test(line)) return false; // 定時消息指令
    if (/%%BILINGUAL%%|%%TRANS%%/i.test(line)) return false;
    if (/<\/?(?:[语語語]音|字幕|翻[译譯]|原文|[译譯]文|think|thinking|thought)\b/i.test(line)) return false;
    return true;
}

/**
 * 從「累計到目前為止的原始流文本」計算當前可展示的預覽氣泡。
 *
 * 已完成行按既有規則過濾；未完成尾句也會持續增長，但在 `[`, `<`, `%%`
 * 這類控制標記前截斷，避免半截指令或標籤洩漏到聊天氣泡。
 */
export function computeStreamPreviewBubbles(fullText: string): string[] {
    if (!fullText) return [];
    const lastNl = fullText.lastIndexOf('\n');
    const completed = lastNl < 0 ? '' : fullText.slice(0, lastNl);
    const trailing = lastNl < 0 ? fullText : fullText.slice(lastNl + 1);

    const kept: string[] = [];
    let inBlockClose: RegExp | null = null;
    for (const rawLine of completed.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (inBlockClose) {
            // 抑制態：只找閉合，閉合行本身也不展示
            if (inBlockClose.test(line)) inBlockClose = null;
            continue;
        }
        const opened = BLOCK_RULES.find(r => r.open.test(line));
        if (opened) {
            // 同行開閉（如單行 <語音>…</語音>）→ 該行整體跳過；否則進入抑制態
            const closeIdx = line.search(opened.close);
            const openIdx = line.search(opened.open);
            if (closeIdx < 0 || closeIdx <= openIdx) inBlockClose = opened.close;
            continue;
        }
        if (!isLinePreviewable(line)) continue;
        kept.push(line);
    }

    // Stream the unfinished tail too, but stop before a possible control/tag prefix.
    // This keeps ordinary one-paragraph replies live without flashing partial directives.
    if (!inBlockClose && trailing.trim()) {
        const markerIndexes = [trailing.indexOf('['), trailing.indexOf('<'), trailing.indexOf('%%')]
            .filter(index => index >= 0);
        const safeEnd = markerIndexes.length > 0 ? Math.min(...markerIndexes) : trailing.length;
        const safeTrailing = trailing.slice(0, safeEnd).trim();
        if (safeTrailing && isLinePreviewable(safeTrailing)) kept.push(safeTrailing);
    }
    if (kept.length === 0) return [];

    // 與最終管線同一套氣泡切分（只認顯式換行），再逐條 sanitize + 有效內容校驗，
    // 讓預覽氣泡的邊界和內容儘量貼近最終落庫的樣子。
    const bubbles: string[] = [];
    for (const chunk of ChatParser.chunkText(kept.join('\n'))) {
        const clean = ChatParser.sanitize(chunk).trim();
        if (clean && ChatParser.hasDisplayContent(clean)) bubbles.push(clean);
    }
    return bubbles;
}

/** 提取普通 content 通道里已閉合或仍在增長的內嵌思考塊。 */
export function extractStreamingEmbeddedThinking(fullText: string): string {
    if (!fullText) return '';
    const blocks: string[] = [];
    const closed = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
    let match: RegExpExecArray | null;
    let lastClosedEnd = 0;
    while ((match = closed.exec(fullText)) !== null) {
        const text = match[2].trim();
        if (text) blocks.push(text);
        lastClosedEnd = closed.lastIndex;
    }

    const tail = fullText.slice(lastClosedEnd);
    const open = tail.match(/<(?:think|thinking|thought)>([\s\S]*)$/i);
    if (open?.[1].trim()) blocks.push(open[1].trim());
    return blocks.join('\n\n').trim();
}

/**
 * 找出本輪真正由流式預覽展示過、隨後才落庫的消息。
 *
 * 後處理可能還會追加二次 LLM 回覆、表情或功能卡片；這些內容沒有在預覽裡出現，
 * 不能一併禁用入場動畫。因此按「基線後的 assistant 文本 + 預覽正文順序」精確匹配。
 * claimedIds 讓多次 setMessages（A -> A+B -> A+B+C）只上報新接棒的 id。
 */
export function findNewStreamPreviewHandoverIds(
    messages: Message[],
    previewBubbles: readonly string[],
    baselineMaxId: number,
    claimedIds: ReadonlySet<number>,
): number[] {
    if (previewBubbles.length === 0) return [];

    const found: number[] = [];
    let previewIndex = 0;
    for (const message of messages) {
        if (
            message.id <= baselineMaxId
            || message.role !== 'assistant'
            || message.type !== 'text'
        ) continue;

        if (previewIndex >= previewBubbles.length) break;
        const persistedText = ChatParser.sanitize(message.content).trim();
        if (persistedText !== previewBubbles[previewIndex]) continue;

        if (!claimedIds.has(message.id)) found.push(message.id);
        previewIndex++;
    }
    return found;
}
