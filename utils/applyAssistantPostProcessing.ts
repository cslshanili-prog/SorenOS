/**
 * applyAssistantPostProcessing — 抽自 hooks/useChatAI.ts 的 sendMessage 後處理管線
 *
 * 把"API 拿到原始 aiContent → 13 步處理 → 逐條落庫到 IndexedDB"這段流水線抽成可複用函數,
 * 本地 fetch 路徑 (useChatAI) 和雲端回覆的沖刷 (activeMsgRuntime) 都調它, 保證行為一致。
 *
 * 13 步 (與計劃編號對應):
 *  1. normalizeAiContent — 剝 <think>/時間戳/[聊天][通話][約會] 等
 *  2. 二輪 LLM 鉤子 — RECALL / SEARCH / DIARY / READ_DIARY / FS_* / READ_NOTE / XHS_*
 *  3. ChatParser.parseAndExecuteActions — POKE/TRANSFER/MUSIC/ADD_EVENT/schedule
 *  4. thinking chain 抽取 (reasoning_content + <think>)
 *  5. [html]...[/html] → html_card 消息
 *  6. ChatParser.sanitize(text, {keepCitations:true})
 *  7. [[INNER_STATE:...]] 兜底剝
 *  8. 雙語 <翻譯><原文>...<譯文>... 拆為單獨 bubble
 *  9. ChatParser.splitResponse — 拆 [[SEND_EMOJI:]]
 * 10. --- 分塊 + ChatParser.chunkText (只按顯式換行)
 * 11. per-chunk 引用解析 ([[QUOTE:]]/[QUOTE:]/[回覆 "..."]) → replyTo
 * 12. hasDisplayContent + per-chunk sanitize
 * 13. 擬人打字延遲 (setTimeout)
 *
 * 本地 fetch 路徑: directives=[] / skipSecondPassLLM=false, 跑完整管線。
 * 雲端回覆: skipSecondPassLLM=true (worker 已跑過工具循環), worker 把識別出的副作用結構化成
 * directives 傳過來, 這裡只重放。
 */

import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, RealtimeConfig, GroupProfile, ImageGenApiConfig } from '../types';
import { DB } from './db';
import { ChatParser, type FrozenMusicSong } from './chatParser';
import { resolveCharTimeZone } from './timezone';
import { NotionManager, FeishuManager, XhsNote } from './realtimeContext';
import { enqueuePendingDiary, removePendingDiary } from './pendingDiary';
import { parseXhsCount, XhsMcpClient } from './xhsMcpClient';
import { extractPublishedNoteId, ownedPostToNote } from './xhsFreeRoamOwnership';
import { selectOwnedPostsForReference } from './xhsOwnedPostReference';
import { safeFetchJson } from './safeApi';
import { extractHtmlBlocks } from './htmlPrompt';
import {
    AgenticToolCtx,
    resolveXhsConfig,
    runRecall,
    runSearch,
    runReadDiary,
    runFsReadDiary,
    runReadNote,
    runXhsSearch,
    runXhsBrowse,
    runXhsMyProfile,
    runXhsDetail,
} from './agenticTools';
import { getLocalDateKey } from './localDate';
import { normalizeAssistantActionFormatting } from './assistantActionFormat';
import { markAmsgStateDirty } from './amsgStateSync';
import { announceScheduleChanges, applyAssistantScheduleChanges } from './scheduleChange';
import { CHAR_RELATIONSHIP_CHANGE_EVENT, extractRelationshipChange, type CharRelationshipChangeDetail } from './chatRelationship';
import { describeDateInvite, extractDateInvite, type DateInviteMeta } from './dateInvite';
import { canCharCallNow, describeCharCall, extractCharCall, INCOMING_CHAR_CALL_EVENT, markCharCallAttempt, shouldRingNow, type CharCallMeta, type CharCallMode, type IncomingCharCallDetail } from './charCall';
import { buildNoReplyNarration, extractNoReplyDirective, pickAutoReplyText } from './readNoReply';
import { getReadNoReplyDecision } from './readNoReplyRuntime';
import { isBlobRef } from './blobRef';
import { consumeSARChatSurfaceChunk, type SARModuleSurfaceMeta } from './vrWorld/sarModuleRuntime';
import { stripLeakedSourceTags } from './sanitize';
import { includesAnyScript } from './scriptKey';

// ─── 模塊內輔助 ──────────────────────────────────────────────────────────────

/**
 * 引用回覆的內容快照 —— 寫進 `replyTo.content`，界面上就是引用氣泡裡那一小行。
 *
 * 被引用的那條是圖片 / 表情時給佔位符，不能截原值：圖片存的是 `blobref:<id>` 令牌，
 * 截前 10 個字剛好是 `blobref:b_`。messages 表是 Blob 孤兒清理的引用面（utils/blobGc.ts
 * 把每條消息 JSON.stringify 後交給 SDK 掃），SDK 從這半截前綴提取出來的 id 是它生成的
 * 每一個 id 的公共前綴，於是判定「引用面像是被截斷過，不安全」→ 整庫豁免，一個 Blob 都不刪，
 * 而且不報任何錯（唯一能察覺的信號是 runGc 返回值裡的 keptBoundary）。
 */
export function buildReplySnapshotContent(msg: { type?: string; content: string }): string {
    const content = msg.content || '';
    const trimmed = content.trim();
    // 值形態判斷跟 chatPrompts 的 isMediaValue 同義：data: / http(s) / blobref 令牌都是"一張圖"
    const looksLikeMedia = /^(data:|https?:\/\/)/i.test(trimmed) || isBlobRef(trimmed);
    if (msg.type === 'emoji') return '[表情包]';
    if (msg.type === 'image' || looksLikeMedia) return '[圖片]';
    return content.length > 10 ? content.slice(0, 10) + '...' : content;
}

/** 第一遍粗洗 — 剝 <think> / 時間戳 / 歷史裡漏出的 [聊天]/[通話]/[約會] / 表情包反向 tag */
const normalizeAiContent = (raw: string): string => {
    let cleaned = normalizeAssistantActionFormatting(raw || '');
    // Strip hidden chain-of-thought blocks: <think> / <thinking> / <thought>
    cleaned = cleaned.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '');
    cleaned = cleaned.replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
    cleaned = cleaned.replace(/^[\w一-龥]+:\s*/, '');
    // Strip source tags leaked from history context, including model-mutated forms such as [聊chat].
    cleaned = stripLeakedSourceTags(cleaned);
    return cleaned;
};

/**
 * 把 SAR 的 CHAR_SURFACE 按“最終會落庫的 Chat 氣泡”拆開。
 *
 * 這裡不能只按換行切：內置翻譯模式的一組 <原文>/<譯文> 最終會合併成一條
 * `原文\n%%BILINGUAL%%\n譯文` 消息；語音塊 + 字幕也必須保持一個原子氣泡。
 * 這份拆法刻意和 renderAndPersist 保持一致，surface 才不會在特殊模式裡串到下一泡。
 */
export const splitSARChatSurfaceBubbles = (raw: string): string[] => {
    // Match canonical preprocessing before splitting. History-style stickers must
    // become emoji tokens, not text chunks that consume the next speech's slot.
    // This only normalizes display text; surface commands are never executed.
    const withoutShares = extractMimickedXhsShares(normalizeAiContent(raw)).cleanedContent;
    const withoutCards = extractHtmlBlocks(withoutShares).cleanedContent;
    let content = ChatParser.sanitize(withoutCards, { keepCitations: true });
    // Only speech takes a surface slot. Card/action directives belong to canonical;
    // keep emoji tokens just long enough for splitResponse to exclude them too.
    content = content.replace(/\[\[(?!SEND_EMOJI:)[\s\S]*?\]\]/g, '').trim();
    if (!content) return [];

    const chunks: string[] = [];
    const appendPlain = (segment: string) => {
        for (const part of ChatParser.splitResponse(segment)) {
            if (part.type !== 'text') continue;
            const rawBlocks = part.content.split(/^\s*---\s*$/m).filter(block => block.trim());
            const blocks = rawBlocks.length > 0 ? rawBlocks : [part.content];
            for (const block of blocks) {
                for (const chunk of ChatParser.chunkText(block.trim())) {
                    const clean = ChatParser.sanitize(chunk);
                    if (clean && ChatParser.hasDisplayContent(clean)) chunks.push(clean);
                }
            }
        }
    };

    const tagPattern = /<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>([\s\S]*?)<\/[译譯]文>\s*<\/翻[译譯]>/g;
    if (!tagPattern.test(content)) {
        appendPlain(content);
        return chunks;
    }

    tagPattern.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(content)) !== null) {
        const textBefore = content.slice(lastIndex, match.index).trim();
        if (textBefore) appendPlain(textBefore);

        // 表情是獨立消息，不參與文字 surface 的序號；與真正落庫分支保持一致。
        const stripEmoji = (value: string) => value.replace(/\[\[SEND_EMOJI:\s*.*?\]\]/g, '').trim();
        const original = ChatParser.sanitize(stripEmoji(match[1]));
        const translated = ChatParser.sanitize(stripEmoji(match[2]));
        if (original || translated) {
            chunks.push(original && translated
                ? `${original}\n%%BILINGUAL%%\n${translated}`
                : (original || translated));
        }
        lastIndex = match.index + match[0].length;
    }

    const textAfter = content.slice(lastIndex).trim();
    if (textAfter) appendPlain(textAfter.replace(/<\/?翻[译譯]>|<\/?原文>|<\/?[译譯]文>/g, '').trim());
    return chunks;
};

/**
 * 模型偶爾會把按分類展示的清單 `呆貓: [親親額頭]` 抄成
 * `[[SEND_EMOJI: 呆貓: 親親額頭]]`。先保留既有的純名稱精確匹配；只有失敗後，
 * 才把前綴當作“當前角色可見分類名”解析，並且僅在候選唯一時接受。
 * 這樣不會誤傷本來就含冒號的表情名，也不會在同名分類/同名表情間猜 URL。
 */
const resolveEmojiForSend = (
    rawName: string,
    emojis: Emoji[],
    categories: EmojiCategory[] = [],
): Emoji | undefined => {
    const name = rawName.trim();
    const exact = emojis.find(emoji => emoji.name === name);
    if (exact) return exact;

    const separator = name.match(/^(.+?)\s*[:：]\s*(.+)$/u);
    if (!separator) return undefined;
    const categoryName = separator[1].trim();
    const emojiName = separator[2].trim();
    if (!categoryName || !emojiName) return undefined;

    const categoryIds = new Set(categories.map(category => category.id));
    const candidates: Emoji[] = [];
    for (const category of categories) {
        if (category.name !== categoryName) continue;
        candidates.push(...emojis.filter(emoji => (
            emoji.categoryId === category.id && emoji.name === emojiName
        )));
    }
    // buildEmojiContext 給無分類表情使用“通用”，給找不到分類定義的殘留使用“其他”。
    if (categoryName === '通用') {
        candidates.push(...emojis.filter(emoji => !emoji.categoryId && emoji.name === emojiName));
    } else if (categoryName === '其他') {
        candidates.push(...emojis.filter(emoji => (
            !!emoji.categoryId && !categoryIds.has(emoji.categoryId) && emoji.name === emojiName
        )));
    }

    const unique = candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
    return unique.length === 1 ? unique[0] : undefined;
};

interface MimickedXhsShareBlock {
    title: string;
    author: string;
    interactionText: string;
    desc: string;
}

// 模型偶爾會模仿歷史上下文裡的人類可讀卡片摘要，而不是輸出 [[XHS_SHARE]].
// 只吃掉完整的五字段形態，避免誤傷普通聊天中提到“標題/作者”的句子。
const MIMICKED_XHS_SHARE_RE = /(^|\r?\n)[ \t]*\[[^\]\r\n]{0,32}分享了小[红紅][书書][笔筆][记記]\][ \t]*(?:\r?\n[ \t]*)+[标標][题題]\s*[:：]\s*([^\r\n]+?)[ \t]*(?:\r?\n[ \t]*)+作者\s*[:：]\s*([^\r\n]+?)[ \t]*(?:\r?\n[ \t]*)+互[动動]\s*[:：]\s*([^\r\n]*?)[ \t]*(?:\r?\n[ \t]*)+[简簡]介\s*[:：]\s*([^\r\n]*)(?=\r?\n|$)/gmu;

const extractMimickedXhsShares = (content: string): { cleanedContent: string; shares: MimickedXhsShareBlock[] } => {
    const shares: MimickedXhsShareBlock[] = [];
    // Some models glue the next history-shaped card directly after the previous
    // description (`簡介: 無[你分享了小紅書筆記]`). Put the marker back on its own
    // line before scanning so every card is recovered instead of leaking the
    // second card as five ordinary chat bubbles.
    const normalizedBlocks = content.replace(
        /([^\r\n])(\[[^\]\r\n]{0,32}分享了小[红紅][书書][笔筆][记記]\])/gu,
        '$1\n$2',
    );
    const cleanedContent = normalizedBlocks.replace(
        MIMICKED_XHS_SHARE_RE,
        (_match, leadingBreak: string, title: string, author: string, interactionText: string, desc: string) => {
            shares.push({
                title: title.trim().replace(/^[《【]|[》】]$/g, ''),
                author: author.trim(),
                interactionText: interactionText.trim(),
                desc: desc.trim(),
            });
            return leadingBreak || '';
        },
    ).replace(/\n{3,}/g, '\n\n').trim();
    return { cleanedContent: shares.length > 0 ? cleanedContent : content, shares };
};

const normalizeXhsCardKey = (value: string): string => String(value || '')
    .trim()
    .replace(/^[《【"'“‘]+|[》】"'”’]+$/g, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();

const parseMimickedXhsCount = (interactionText: string, label: string): number => {
    const match = interactionText.match(new RegExp(`([\\d.,+萬千億kKmMwW]+)\\s*${label}`));
    return parseXhsCount(match?.[1] || 0);
};
// XHS side-effect helpers (POKE-style: 不抽到 agenticTools, 雲端回覆靠 directive 重放觸發)

async function xhsPublish(
    conf: { mcpUrl: string },
    owner: Pick<CharacterProfile, 'id' | 'name'>,
    title: string,
    content: string,
    tags: string[],
): Promise<{ success: boolean; noteId?: string; message: string }> {
    let images: string[] = [];
    try {
        const stockImgs = await DB.getXhsStockImages();
        if (stockImgs.length > 0) {
            const keywords = [title, content, ...tags].join(' ').toLowerCase();
            const scored = stockImgs.map(img => ({
                img,
                score: img.tags.reduce((s: number, t: string) => s + (keywords.includes(t.toLowerCase()) ? 10 : 0), 0) + Math.max(0, 5 - (img.usedCount || 0))
            })).sort((a, b) => b.score - a.score);
            if (scored[0]?.img.url) {
                images = [scored[0].img.url];
                DB.updateXhsStockImageUsage(scored[0].img.id).catch(() => {});
            }
        }
    } catch { /* ignore stock failures */ }

    const r = await XhsMcpClient.publishNote(conf.mcpUrl, { title, content, tags, images: images.length > 0 ? images : undefined });
    const noteId = r.success ? extractPublishedNoteId(r) : '';
    if (r.success && noteId) {
        const now = Date.now();
        try {
            await DB.saveXhsOwnedPost({
                id: `${owner.id}:${noteId}`,
                characterId: owner.id,
                noteId,
                title: title || '無標題',
                body: content,
                tags,
                publishedAt: now,
                updatedAt: now,
            });
        } catch (error) {
            // 遠端已經發布成功，不能因為本地索引寫入失敗把它誤報成“發帖失敗”。
            console.warn('[XHS] 發帖成功，但保存角色主頁索引失敗:', error);
        }
    }
    return { success: r.success, noteId: noteId || undefined, message: r.error || (r.success ? '發佈成功' : '發佈失敗') };
}

async function xhsComment(conf: { mcpUrl: string }, noteId: string, content: string, xsecToken?: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.comment(conf.mcpUrl, noteId, content, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '評論成功' : '評論失敗') };
}

async function xhsLike(conf: { mcpUrl: string }, feedId: string, xsecToken: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.likeFeed(conf.mcpUrl, feedId, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '點贊成功' : '點贊失敗') };
}

async function xhsFavorite(conf: { mcpUrl: string }, feedId: string, xsecToken: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.favoriteFeed(conf.mcpUrl, feedId, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '收藏成功' : '收藏失敗') };
}

async function xhsReplyComment(conf: { mcpUrl: string }, feedId: string, xsecToken: string, content: string, commentId?: string, userId?: string, parentCommentId?: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.replyComment(conf.mcpUrl, feedId, xsecToken, content, commentId, userId, parentCommentId);
    return { success: r.success, message: r.error || (r.success ? '回覆成功' : '回覆失敗') };
}

// ─── 公開類型 ────────────────────────────────────────────────────────────────

/**
 * worker `onLLMOutput` hook 把識別到的副作用標籤結構化傳回, 客戶端 applyAssistantPostProcessing
 * 反向重建標籤後讓下游 chatParser / 內聯 XHS handler 複用同一份執行邏輯 (避免在客戶端再寫一遍).
 *
 * 字段形狀跟 worker/amsg/src/classifier.ts:Directive 必須保持一致 — 用 type 做
 * discriminator, 其他字段是 flat 而不是 nested payload (減少 push body 嵌套).
 */
export type PostProcessDirective =
    | { type: 'poke' }
    | { type: 'transfer'; amount: number }
    | { type: 'transfer_accept' }
    | { type: 'transfer_return' }
    | { type: 'add_event'; title: string; date: string }
    | { type: 'change_schedule'; time: string; activity: string }
    | { type: 'schedule_message'; time: string; text: string }
    // song 是主動消息 2.0 的定時路徑後補的「角色說的是哪首歌」（見 chatParser 的
    // FrozenMusicSong）；標籤裡只有歌單名帶不動它，所以單獨走 directive 字段。
    | { type: 'music_action'; verb: string; args: string[]; song?: FrozenMusicSong }
    | { type: 'xhs_like'; noteId: string }
    | { type: 'xhs_fav'; noteId: string }
    | { type: 'xhs_comment'; noteId: string; text: string }
    | { type: 'xhs_reply'; noteId: string; commentId: string; text: string }
    | { type: 'xhs_post'; title: string; content: string; tags: string }
    | { type: 'xhs_share'; idx: number }
    // 生活記錄代記 / 熱點卡片 — body 是冒號後的整段原文, 拼回原 tag 交給 chatParser
    // (LIFE → lifeRecords.executeLifeDirectives, NEWS_CARD → 落 news_card 消息)。
    | { type: 'life_record'; body: string }
    | { type: 'news_card'; body: string }
    // Notion / 飛書 寫日記 — worker classifier 提取 title/content/mood, 我們拼回原 tag 給
    // line 465 (Notion) / 649 (飛書) 既有 handler 跑. title 可空, 客戶端兜底.
    | { type: 'notion_write_diary'; title: string; content: string; mood?: string }
    | { type: 'feishu_write_diary'; title: string; content: string; mood?: string }
    // Soren 專用標籤（發照片、改關係、已讀不回、邀約、來電）：worker 原樣送回整段標籤
    | { type: 'soren_tag'; raw: string };

/**
 * 把結構化 directive 反向拼回原 tag 字符串. 拼回的目的是讓下游 chatParser.parseAndExecuteActions
 * (POKE/TRANSFER/ADD_EVENT/schedule_message/MUSIC_ACTION) + 內聯 XHS handler (LIKE/FAV/COMMENT/REPLY/POST/SHARE)
 * 用跟本地 fetch 路徑一致的代碼執行 — 不在客戶端為 push 路徑再寫一份副作用執行器.
 *
 * 已知邊界 case: 字段含 `|` / `]` 時會破壞 tag 邊界. worker 端 classifier 已經按 `[^|]+?`
 * 切片, 所以這裡反過來拼回去用戶自定義內容裡如果有 `|` 會重疊. 接受這個 trade-off — 本地
 * fetch 路徑裡這種內容也有同樣問題, 等於 push 路徑不增加新 failure mode.
 */
function reconstructDirectiveTags(directives: PostProcessDirective[] | undefined): string {
    if (!directives || directives.length === 0) return '';
    const parts: string[] = [];
    for (const d of directives) {
        switch (d.type) {
            case 'poke':
                parts.push('[[ACTION:POKE]]');
                break;
            case 'transfer':
                parts.push(`[[ACTION:TRANSFER:${d.amount}]]`);
                break;
            // 收/退回執: worker 端已把口語形態 (`[系統: 你接收了xx的轉帳 520]`) 歸一成
            // 這兩個 directive, 這裡拼回規範標籤交給 chatParser 執行 (找不到待處理轉帳時
            // 它會跳過, 不會落一張假的"已收款")。
            case 'transfer_accept':
                parts.push('[[ACTION:TRANSFER_ACCEPT]]');
                break;
            case 'transfer_return':
                parts.push('[[ACTION:TRANSFER_RETURN]]');
                break;
            case 'add_event':
                parts.push(`[[ACTION:ADD_EVENT|${d.title}|${d.date}]]`);
                break;
            case 'change_schedule':
                parts.push(`[[ACTION:CHANGE_SCHEDULE|${d.time}|${d.activity}]]`);
                break;
            case 'schedule_message':
                parts.push(`[schedule_message | ${d.time} | fixed | ${d.text}]`);
                break;
            case 'music_action': {
                const tail = d.args && d.args.length > 0 ? `|${d.args.join('|')}` : '';
                parts.push(`[[MUSIC_ACTION:${d.verb}${tail}]]`);
                break;
            }
            case 'xhs_like':
                parts.push(`[[XHS_LIKE:${d.noteId}]]`);
                break;
            case 'xhs_fav':
                parts.push(`[[XHS_FAV:${d.noteId}]]`);
                break;
            case 'xhs_comment':
                parts.push(`[[XHS_COMMENT:${d.noteId} | ${d.text}]]`);
                break;
            case 'xhs_reply':
                parts.push(`[[XHS_REPLY:${d.noteId} | ${d.commentId} | ${d.text}]]`);
                break;
            case 'xhs_post':
                parts.push(`[[XHS_POST:${d.title} | ${d.content} | ${d.tags}]]`);
                break;
            case 'xhs_share':
                parts.push(`[[XHS_SHARE:${d.idx}]]`);
                break;
            case 'life_record':
                parts.push(`[[LIFE:${d.body}]]`);
                break;
            case 'news_card':
                parts.push(`[[NEWS_CARD: ${d.body}]]`);
                break;
            case 'notion_write_diary': {
                // 拼回長形態 [[DIARY_START: title|mood]]\n content \n[[DIARY_END]],
                // 因為客戶端 line 465 既支持長又支持短, 長形態信息更全 (能區分 mood).
                // title 為空時給客戶端空 header, 它內部 line 498-501 會用 char.name + 日期兜底.
                const header = d.mood ? `${d.title}|${d.mood}` : d.title;
                parts.push(`[[DIARY_START: ${header}]]\n${d.content}\n[[DIARY_END]]`);
                break;
            }
            case 'feishu_write_diary': {
                const header = d.mood ? `${d.title}|${d.mood}` : d.title;
                parts.push(`[[FS_DIARY_START: ${header}]]\n${d.content}\n[[FS_DIARY_END]]`);
                break;
            }
            case 'soren_tag':
                if (typeof d.raw === 'string' && d.raw.startsWith('[[')) parts.push(d.raw);
                break;
            default:
                console.warn('[directive-replay] unknown directive type, skipping', d);
        }
    }
    return parts.length > 0 ? `${parts.join('\n')}\n\n` : '';
}

/** XHS reply-related caches — 跨消息存活, 調用方負責持有 (一般是 useRef 包起來) */
export interface XhsCaches {
    /** noteId → xsecToken */
    xsecTokenCache: Map<string, string>;
    /** noteId → title */
    noteTitleCache: Map<string, string>;
    /** commentId → userId */
    commentUserIdCache: Map<string, string>;
    /** commentId → 評論作者暱稱 (降級為 @mention 頂級評論用) */
    commentAuthorNameCache: Map<string, string>;
    /** commentId → parentCommentId */
    commentParentIdCache: Map<string, string>;
}

export interface PostProcessApiCall {
    /** 主 API 調用入口 base, 不含末尾斜槓 (e.g. "https://api.openai.com/v1") */
    baseUrl: string;
    /** Authorization 頭等 */
    headers: Record<string, string>;
    /** 當前生效的 API (拿 model / 兜底其他配置用) */
    effectiveApi: { baseUrl: string; apiKey: string; model: string };
}

export interface PostProcessMusicHooks {
    getListeningSnapshot: () => {
        songId: number;
        name: string;
        artists: string;
        album: string;
        albumPic: string;
        duration: number;
        fee: number;
    } | null;
    joinListeningTogether: (charId: string) => void;
    addSongToCharPlaylist: (
        charId: string,
        song: any,
        target?: any,
    ) => Promise<{ playlistTitle: string; created: boolean } | null>;
}

export interface PostProcessHooks {
    setMessages: (msgs: Message[]) => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
    setRecallStatus?: (s: string) => void;
    setSearchStatus?: (s: string) => void;
    setDiaryStatus?: (s: string) => void;
    setXhsStatus?: (s: string) => void;
    /** token 計費彙總 (調用方負責把 React state 同步上去) */
    updateTokenUsage?: (data: any, msgCount: number, pass: string) => void;
    /** 給 ChatParser.parseAndExecuteActions 用的音樂鉤子 */
    musicHooks?: PostProcessMusicHooks;
    /**
     * 日程改動沒能落地時的告知出口。不傳就走 addToast（本地聊天：用戶正看著屏幕，
     * 一條 toast 就夠）。
     *
     * 主動消息路徑必須傳：那條路上的 addToast 是 console.log（推送隨時到達，用戶多半
     * 不在看這個角色，狂彈 toast 反而更糟），於是「角色說今晚不睡了、日程卡還寫著睡覺」
     * 這件事對用戶是完全無聲的。那邊把它接到 active-msg-process-failed 上——已有的
     * 可見通道，自帶每角色 60 秒節流。
     */
    notifyScheduleChangeFailed?: (note: string) => void;
}

export interface PostProcessCtx {
    char: CharacterProfile;
    userProfile: UserProfile;
    emojis: Emoji[];
    /** 已按當前角色可見性過濾的分類；用於容錯解析“分類名: 表情名”。 */
    categories?: EmojiCategory[];
    realtimeConfig?: RealtimeConfig;
    /**
     * 生圖 API 配置；只有傳了、且角色發圖開關都打開時，ChatParser.parseAndExecuteActions
     * 才會真的執行 `[[ACTION:SEND_PHOTO|...]]`（有沒有教過角色這個動作是 chatPrompts.ts
     * 那邊的事，這裡只管執行）。不傳 = 遇到這個標籤當無效標籤一樣靜默剝掉、不生成。
     */
    imageGenConfig?: ImageGenApiConfig;
    /**
     * 角色退回用戶發起的轉帳時退款回 Real Balance（見 chatParser.ts 同名參數的註釋）。
     * 只在前台聊天路徑傳——TRANSFER_ACCEPT/TRANSFER_RETURN 標籤過不了主動消息 2.0 的
     * push 路徑（worker 側已知缺口），傳了也用不上。
     */
    onUserTransferReturned?: (amount: number) => Promise<void> | void;
    /**
     * 角色收下用戶發起的轉帳時入帳角色自己的 Real Balance（見 chatParser.ts 同名參數的註釋）。
     * 跟 onUserTransferReturned 一樣只在前台聊天路徑傳。
     */
    onUserTransferAccepted?: (amount: number) => Promise<void> | void;
    /**
     * 角色主動發起轉帳時先從角色自己的 Real Balance 扣款、餘額不夠則攔下這筆轉帳
     * （見 chatParser.ts 同名參數的註釋）。跟 onUserTransferReturned 一樣只在前台聊天路徑傳。
     */
    onCharTransferSend?: (amount: number) => Promise<boolean>;
    /**
     * 角色支付購物中心「外賣代付請求」時從角色自己的 Real Balance 扣款、餘額不夠則把這張卡
     * 自動改判成拒絕（見 chatParser.ts 同名參數的註釋）。跟 onUserTransferReturned 一樣只在
     * 前台聊天路徑傳。
     */
    onCharDaifuAccept?: (amount: number) => Promise<boolean>;
    /**
     * 角色主動送用戶一份禮物/外賣時從角色自己的 Real Balance 扣款、餘額不夠則跳過這份禮物
     * （見 chatParser.ts 同名參數的註釋）。跟 onUserTransferReturned 一樣只在前台聊天路徑傳。
     */
    onCharGiftSend?: (amount: number) => Promise<boolean>;
    /** 日程被角色改寫後刷新主動消息 fire_pack；舊調用方可不傳。 */
    groups?: GroupProfile[];
    /**
     * 這段話**說出口**的時刻（ms）。只有日程改動用得上：它要按角色說這句話的那一刻
     * 判「哪條時段還能改」，而不是按處理它的這一刻。本地聊天兩者差幾秒、不用傳；
     * 主動消息路徑必須傳 push 的 sentAt——用戶隔夜才打開 App 時，昨晚那句
     * 「22:00 改成陪你聊天」不該落到今天的 22:00 上（scheduleChange 那邊還有一道
     * 日曆日門檻兜底，隔天的整批丟棄）。
     */
    spokenAt?: number;
    /** 上下文消息窗 — 用來匹配 quote 目標 */
    contextMsgs: Message[];
    /** 發給 API 的完整 messages 數組 — 2nd-pass LLM 調用要帶上 */
    fullMessages: any[];
    /** 第一次 API 調用的原始響應, 後續 2nd-pass 會覆蓋它 (複製舊實現的局部變量行為) */
    initialData: any;
    /** historyMsgCount — 給 updateTokenUsage 用 */
    historyMsgCount: number;
    /** 當 MCD MiniApp 打開時附加到每條 assistant message 的 metadata patch */
    mcdInheritMeta?: any;
    /** XHS 跨消息緩存 (調用方持有的 ref) */
    xhsCaches: XhsCaches;
    /**
     * XHS 跨工具調用共享的"上一次 search/browse 結果". 給 [[XHS_SHARE: 序號]] 用.
     *
     * 本地 fetch 路徑 caller 不傳 — 函數內自動創建 fresh, 單次 send 內同 round runXhsBrowse/Search 填充
     * 後立刻被同 round XHS_SHARE replay 讀到 (跟歷史行為字節級一致).
     *
     * 雲端回覆的 caller (utils/activeMsgRuntime.ts) **必傳** module-level 單例: worker 跑 XHS 工具時
     * 把引用到的筆記隨 push 帶回來, activeMsgRuntime 先重建進這個單例, 再由這裡 replay XHS_SHARE
     * 讀同一份 ref. 跨 push 共享 = 跟本地路徑同 UX.
     */
    lastXhsNotesRef?: { current: XhsNote[] };
    /** API 調用配置 */
    api: PostProcessApiCall;
    /** UI / 業務鉤子 */
    hooks: PostProcessHooks;
    /**
     * 置 true = 跳過"擬人打字延遲"（每條 0.5~2s 的 setTimeout），氣泡近乎立即回填。
     * 兩種情況該置：
     *   1. 流式預覽已把氣泡實時展示過（hooks/useChatAI 的 streamingBubbles）——否則用戶會
     *      看到"預覽氣泡收回去 → 再一條條慢慢重彈"的二次播放；
     *   2. 主動消息補收（utils/activeMsgRuntime 的 isFreshInboxDelivery 判為否）——內容
     *      幾小時前就在雲端生成完了，再慢放一遍只會讓用戶乾等著一條條冒。
     * 其餘路徑（非流式 / 雙語 / 工具模式 / 實時送達的主動消息）不傳，打字節奏不變。
     */
    instantRender?: boolean;
    /**
     * worker 已在自己內部跑過 2nd-pass LLM (雲端回覆) 時置 true, 主線程不該再調一次。
     * 本地 fetch 路徑不傳。
     */
    skipSecondPassLLM?: boolean;
    /**
     * worker 端把識別到的副作用結構化傳過來; 非空時只重放, 不再掃原文。
     * 本地 fetch 路徑不傳。
     */
    directives?: PostProcessDirective[];
    /**
     * 雲端回覆的 reasoning chain 來源: flushInboxToChat 從第一條 content push 的
     * metadata.amsgReasoning (或挪進 client_state 的那份) 取出來塞到這裡.
     * 本地 fetch 路徑不傳 (Step 4 從 initialData.choices[0].message.reasoning_content 讀).
     */
    reasoningContent?: string;
    /**
     * 本輪所有落庫消息統一使用的時間戳 (毫秒)。不傳 = 維持 DB.saveMessage 默認
     * (寫庫當刻的 Date.now())。主動消息離線補收時由 activeMsgRuntime 傳 worker 發送
     * 時刻 (sentAt) 進來: 昨晚推的消息中午打開時氣泡顯示昨晚, 跟正文裡角色說的話
     * 對得上; 同一條 push 拆出的文字 / 表情 / 卡片多條氣泡也共用同一個值 (顯示順序
     * 按自增 id, 不看 timestamp, 所以只需一致、不需遞增)。
     * 在線送達 vs 離線補收的判定見 activeMsgRuntime.resolveInboxPersistTimestamp。
     */
    messageTimestamp?: number;
    /** SAR 模塊的純展示層。canonical 正文仍走 rawAiContent 的完整後處理與落庫。 */
    sarModuleSurface?: SARModuleSurfaceMeta;
}

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * skipSecondPassLLM=false + directives=[] 時是本地 fetch 路徑的默認形態。
 */
export async function applyAssistantPostProcessing(
    rawAiContent: string,
    ctx: PostProcessCtx,
): Promise<void> {
    const {
        char,
        userProfile,
        emojis,
        realtimeConfig,
        imageGenConfig,
        onUserTransferReturned,
        onUserTransferAccepted,
        onCharTransferSend,
        onCharDaifuAccept,
        onCharGiftSend,
        groups,
        spokenAt,
        contextMsgs,
        fullMessages,
        initialData,
        historyMsgCount,
        mcdInheritMeta,
        xhsCaches,
        api,
        hooks,
        instantRender,
        skipSecondPassLLM,
        directives,
        reasoningContent: pushReasoningContent,
        messageTimestamp,
        sarModuleSurface,
    } = ctx;
    const { baseUrl, headers, effectiveApi } = api;
    // 擬人打字延遲：流式預覽已實時展示過氣泡時（instantRender）跳過，避免二次慢放
    const typingPause = (ms: number): Promise<void> =>
        instantRender ? Promise.resolve() : new Promise(r => setTimeout(r, ms));
    // 統一落庫入口：ctx.messageTimestamp（若有）蓋到每條消息上，保證同一輪拆出的
    // 正文 / 表情 / 卡片 / 系統提示時間戳一致；沒傳則維持 DB.saveMessage 默認（寫庫當刻）。
    // 全函數落庫一律走這裡，別直接調 DB.saveMessage——漏一處就會出現氣泡時間戳互相打架。
    const persistMessage: typeof DB.saveMessage = (msg) =>
        DB.saveMessage(messageTimestamp != null ? { ...msg, timestamp: messageTimestamp } : msg);
    const {
        setMessages,
        addToast,
        notifyScheduleChangeFailed,
        setRecallStatus = () => {},
        setSearchStatus = () => {},
        setDiaryStatus = () => {},
        setXhsStatus = () => {},
        updateTokenUsage = () => {},
        musicHooks,
    } = hooks;
    const {
        xsecTokenCache: xsecTokenCacheRef,
        commentUserIdCache: commentUserIdCacheRef,
        commentAuthorNameCache: commentAuthorNameCacheRef,
        commentParentIdCache: commentParentIdCacheRef,
    } = xhsCaches;

    // API 調用記錄用 meta：二輪重生 / 調閱 / 日記 / 小紅書等都歸在「消息」App 下，purpose 見各分支。
    const apiLogMeta = { appName: '消息', charId: char.id, charName: char.name };

    // skipSecondPassLLM=true (雲端回覆) 時, 跳過所有需要回連 LLM 的
    // 二輪分支 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*)。
    // 這些 tag 留在原文裡, 由後面 Step 6 的 ChatParser.sanitize 兜底剝掉 (chatParser.ts:225
    // 的正則覆蓋 ACTION/RECALL/SEARCH/DIARY/READ_DIARY/FS_DIARY/FS_READ_DIARY/...),
    // XHS_* / READ_NOTE 兜底用 Step 12 的 hasDisplayContent + per-chunk sanitize 再清一遍。
    // 寫日記類 (DIARY / FS_DIARY) 不走 LLM, 屬於純副作用 (像 POKE), 客戶端可以直接執行。
    // directives 非空時, worker 已經把副作用標籤結構化傳過來 (並從 push body
    // 裡剝光了). 我們重建原 tag 字符串塞回 rawAiContent 頭部, 讓下游 chatParser.parseAndExecuteActions
    // + 後置 XHS_* 內聯 handler 用同一份代碼執行 — 零重複實現, 跟本地 fetch 路徑同一份 source of truth.
    // tag 末尾 +\n\n 保證不跟正文粘連導致 regex 漏匹配; chatParser.sanitize 會把它們清乾淨.
    const replayedTagPrefix = reconstructDirectiveTags(directives);
    const hasReplayDirectives = !!directives && directives.length > 0;

    // XHS 副作用 (LIKE/FAV/COMMENT/REPLY/POST/SHARE) 跟 2nd-pass LLM tools (SEARCH/BROWSE/
    // DETAIL/MY_PROFILE) 分開對待: 副作用類只需要 MCP 調用, 不需要 LLM round-trip, 當 worker 給了
    // directives 時 (xhs_* in classifier) 這些 tag 已重建回正文, 必須執行.
    // 用 disabledXhsSideEffects = (skipSecondPassLLM && !hasReplayDirectives) 區分:
    //   - 本地 fetch 路徑: skipSecondPassLLM=false → false → 不禁用
    //   - 雲端回覆但沒帶 directives: true && true → 禁用 (原文裡的 tag 沒經 worker 識別, 不執行)
    //   - 雲端回覆帶 directives: true && false → 不禁用, 副作用照常跑
    const disabledXhsSideEffects = skipSecondPassLLM && !hasReplayDirectives;

    /** 從緩存或 notesPool 中查找 xsecToken — 僅副作用 XHS handler (COMMENT/REPLY/LIKE/FAV) 使用 */
    const findXsecToken = (noteId: string, notesPool: XhsNote[]): string | undefined => {
        const fromNotes = notesPool.find(n => n.noteId === noteId)?.xsecToken;
        if (fromNotes) return fromNotes;
        return xsecTokenCacheRef.get(noteId);
    };

    /**
     * XHS 跨 tool 共享筆記緩衝 — 取代舊版 `let lastXhsNotesRef.current`.
     * Caller (雲端回覆) 傳了 module-level 單例就用它 (跨 push 共享讓 XHS_SHARE 找到 worker 帶回的筆記);
     * 沒傳 (本地 fetch 路徑) 自動創建 fresh (單次 send 內 runXhsBrowse → XHS_SHARE 同一函數閉包內共享, 跟歷史一致).
     */
    const lastXhsNotesRef = ctx.lastXhsNotesRef ?? { current: [] as XhsNote[] };

    /** agenticTools 入參 ctx — 9 個 run* 函數共享 */
    const agenticCtx: AgenticToolCtx = {
        char,
        userProfile,
        realtimeConfig,
        xhsCaches: ctx.xhsCaches,
        lastXhsNotesRef,
        // 把 setXhsStatus / setDiaryStatus 透傳給 agenticTools 內部多步操作 (XHS_DETAIL retry /
        // XHS_MY_PROFILE fallback / DIARY/NOTE 讀 N 篇 中間態), 保持跟原 inline 實現的 status 文案一致.
        onProgress: (channel, text) => {
            if (channel === 'xhs') setXhsStatus(text);
            else if (channel === 'diary') setDiaryStatus(text);
        },
    };
    void agenticCtx;

    // 局部 data 副本 — 後續 2nd-pass 會覆蓋, 模仿舊版的 let data 行為
    let data: any = initialData;

    let scheduleFailureNotified = false;
    // 這句話**說出口**的時刻。本地聊天沒傳就是「現在」；主動消息傳 push 的 sentAt。
    const utteranceAt = typeof spokenAt === 'number' && Number.isFinite(spokenAt)
        ? new Date(spokenAt)
        : new Date();
    /**
     * `at` 是這段文字說出口的時刻，由調用處按來源給：首輪正文用 utteranceAt，二輪
     * LLM 產出的那段用「現在」——它是剛剛生成的，跟原始那句話隔著幾次工具往返，
     * 拿舊鐘去判會把新寫的日程改動當成隔夜的整批丟掉。
     */
    const consumeScheduleChanges = async (content: string, at: Date): Promise<string> => {
        const result = await applyAssistantScheduleChanges(content, char, at);
        if (result.changes.length > 0 && result.schedule) {
            // 本地聊天直接複用 caller 的 groups；主動消息路徑只在真的改了日程時讀一次，
            // 不給每一條普通 push 平添 IndexedDB 查詢和新的失敗點。
            const syncGroups = groups ?? await DB.getGroups().catch(() => undefined);
            // realtimeConfig 缺席也照打髒：快照裡它本來就是可選的，而「沒開過實時設置」
            // 就是默認狀態（localStorage 裡壓根沒這個鍵）。少打這一次髒，雲端 fire_pack
            // 會一直留著舊日程，下一次主動消息還在唸角色剛說過不做的那件事。
            if (syncGroups) markAmsgStateDirty({ char, userProfile, groups: syncGroups, realtimeConfig });
            announceScheduleChanges(char.id, result.schedule, result.changes);
        }
        if (!scheduleFailureNotified
            && result.changes.length === 0
            && (result.malformedCount > 0 || result.rejectedCount > 0)) {
            scheduleFailureNotified = true;
            if (result.rejectedReason === 'cross-day') {
                // 隔夜補收：角色昨晚說的話，今天這張表本來就不該跟著動。這是日曆日門檻
                // 按設計工作，不是失敗——彈提示會讓用戶以為出了錯，接到送達失敗那條通道
                // 上還會把「主動消息送達失敗」的指標撐起來（送達其實成功了）。留一行日誌
                // 就夠，界面上什麼都不用說：用戶看到的消息和今天的日程表本來就不矛盾。
                console.info('[schedule-change] 這批改動是之前說的，今天的表不動', {
                    charId: char.id,
                    count: result.rejectedCount,
                });
            } else {
                // 剩下兩種才是真沒落地。兩種原因分開講：一種是標籤認出來了但今天的表裡
                // 沒有對得上的時段，一種是標籤本身就沒寫對，用戶能做的事不一樣。
                const failureNote = result.rejectedCount > 0
                    ? '日程修改沒有找到對得上的時段，已安全跳過'
                    : '日程修改的格式沒認出來，已安全跳過';
                if (notifyScheduleChangeFailed) notifyScheduleChangeFailed(failureNote);
                else addToast(failureNote, 'info');
            }
        }
        return result.cleanedText;
    };

    /**
     * 角色改「角色認為的關係」[[ACTION:RELATIONSHIP|新關係]]：標籤一律剝掉；只有聊天設定裡
     * 開了「允許角色自主更改關係」、而且真的換了一個說法才落地——寫一條系統提示，並發事件讓
     * OSContext 把新關係寫回角色（這裡拿不到 updateCharacter）。跟日程一樣要在任何渲染之前消費。
     */
    let lastAppliedRelationship = char.charViewRelationship?.trim() || '';
    const consumeRelationshipChange = async (content: string): Promise<string> => {
        const { cleanedText, relationship } = extractRelationshipChange(content);
        if (relationship && char.allowCharChangeRelationship && relationship !== lastAppliedRelationship) {
            lastAppliedRelationship = relationship;
            await persistMessage({
                charId: char.id, role: 'system', type: 'text',
                content: `[系統: ${char.name} 把你們的關係改成了「${relationship}」]`,
                ...(mcdInheritMeta ? { metadata: mcdInheritMeta } : {}),
            });
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent<CharRelationshipChangeDetail>(CHAR_RELATIONSHIP_CHANGE_EVENT, {
                    detail: { charId: char.id, relationship },
                }));
            }
        }
        return cleanedText;
    };

    /**
     * 「由角色決定」已讀不回時，角色選擇不回會只輸出 [[ACTION:NO_REPLY]]（可附自動回覆內容）。
     * 標籤一律剝掉；整則只有這個標籤、而且這個角色開著已讀不回時，落自動回覆＋旁白，
     * 正文變空、後面就不會再畫任何氣泡。角色同時也寫了正文的，當它改主意回了，只剝標籤。
     */
    let noReplyHandled = false;
    const consumeNoReply = async (content: string): Promise<string> => {
        const { cleanedText, noReply, autoReply } = extractNoReplyDirective(content);
        if (!noReply || cleanedText || noReplyHandled || !char.readNoReply?.enabled) return cleanedText;
        noReplyHandled = true;
        const decision = await getReadNoReplyDecision(char).catch(() => null);
        const state = decision?.state ?? 'normal';
        const reason = decision?.reason ?? '';
        const text = (char.readNoReply.aiGenerated ? autoReply : undefined) ?? pickAutoReplyText(char.readNoReply, state);
        const meta = { ...(mcdInheritMeta || {}), readNoReply: { state, reason } };
        await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: text, metadata: meta } as any);
        await persistMessage({
            charId: char.id, role: 'system', type: 'text',
            content: buildNoReplyNarration(char.chatNickname?.trim() || char.name, { state, reason }),
            ...(mcdInheritMeta ? { metadata: mcdInheritMeta } : {}),
        });
        return '';
    };

    /**
     * 角色約用戶見面 [[ACTION:DATE_INVITE|地點|想做什麼]]：標籤一律剝掉；聊天設定開了「自動線下邀請」
     * 才記下來，等這一輪正文都落完再補一張邀請卡（卡排在話的後面才順）。一輪只落一張。
     */
    let pendingDateInvite: { place: string; plan: string } | null = null;
    const consumeDateInvite = (content: string): string => {
        const { cleanedText, invite } = extractDateInvite(content);
        if (invite && char.dateInvite && !pendingDateInvite) pendingDateInvite = invite;
        return cleanedText;
    };

    /**
     * 角色打電話來 [[ACTION:CALL|voice或video|原因]]：標籤一律剝掉；開了「允許角色主動打電話」、
     * 又過了冷卻才記下，等這一輪話都落完再補一張來電卡。一輪只打一通。
     */
    let pendingCharCall: { mode: CharCallMode; reason: string } | null = null;
    const consumeCharCall = (content: string): string => {
        const { cleanedText, call } = extractCharCall(content);
        if (call && char.charCall && !pendingCharCall && canCharCallNow(char.id)) pendingCharCall = call;
        return cleanedText;
    };

    // ─── Step 1: 初次粗洗 ───
    let aiContent = replayedTagPrefix ? `${replayedTagPrefix}${rawAiContent}` : rawAiContent;
    aiContent = normalizeAiContent(aiContent);
    // 先於 lead-in / 二輪渲染消費：否則控制標籤會作為普通氣泡短暫閃給用戶看。
    aiContent = await consumeScheduleChanges(aiContent, utteranceAt);
    aiContent = await consumeRelationshipChange(aiContent);
    aiContent = await consumeNoReply(aiContent);
    aiContent = consumeDateInvite(aiContent);
    aiContent = consumeCharCall(aiContent);
    // 在任何 lead-in/二輪渲染之前先剝掉仿卡片文本，防止它被 chunkText 拆成灰色普通氣泡。
    const mimickedXhsShares = extractMimickedXhsShares(aiContent);
    aiContent = mimickedXhsShares.cleanedContent;

    // ── 渲染基礎設施 (提前聲明, 供"執行功能前先展示本輪正文 A" + 末尾展示二輪結果 B 複用) ──
    // 引用/回覆標籤的匹配 + 清理正則 (提前聲明避免 lead-in 渲染時落入 TDZ)。
    const QUOTE_RE_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:]\s*([\s\S]*?)\]\]/;
    const QUOTE_RE_SINGLE = /\[(?:QU[OA]TE|引用)[：:]\s*([^\]]*)\]/;
    const REPLY_RE_CN = /\[回[复覆]\s*[""“]([^""”]*?)[""”](?:\.{0,3})\]\s*[：:]?\s*/;
    // 歷史裡引用消息被渲染成 [xx引用了xx說的「…」，並回復了 ↓]（chatPrompts.buildMessageHistory），
    // 模型會模仿這個渲染格式而不是規範的 [[QUOTE:]] —— 把它也認作合法引用，否則既丟引用
    // 又把整段方括號原樣漏進氣泡。「」是該渲染格式的硬錨點，配合"引用了"雙錨降低誤報。
    // 引用摘要被截斷成單行，「」內用 [^」\n]*? 限制在同一行：缺閉合 」 時不會跨行吞掉正文段落。
    const QUOTE_RE_NL = /\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「([^」\n]*?)」[^\[\]\n]{0,24}\]\s*/;
    const QUOTE_CLEAN_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g;
    const QUOTE_CLEAN_SINGLE = /\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g;
    const REPLY_CLEAN_CN = /\[回[复覆]\s*[""“][^""”]*?[""”](?:\.{0,3})\]\s*[：:]?\s*/g;
    const QUOTE_CLEAN_NL = /\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g;

    // 抽取思考鏈 (showThinkingChain 開啟時): reasoning_content + 內聯 <think> 塊。
    const extractThinkingChain = (dataObj: any, reasoningOverride?: string): string | null => {
        if (!(char as any).showThinkingChain) return null;
        const lastRaw = dataObj?.choices?.[0]?.message?.content || '';
        const lastReasoning = (
            (reasoningOverride && reasoningOverride.trim())
            || dataObj?.choices?.[0]?.message?.reasoning_content
            || ''
        ).trim();
        const thinkBlocks: string[] = [];
        const thinkPat = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
        let tm: RegExpExecArray | null;
        while ((tm = thinkPat.exec(lastRaw)) !== null) {
            const t = tm[2].trim();
            if (t) thinkBlocks.push(t);
        }
        if (!/<\/(?:think|thinking|thought)>/i.test(lastRaw)) {
            const openOnly = lastRaw.match(/<(?:think|thinking|thought)>([\s\S]*$)/i);
            if (openOnly && openOnly[1].trim()) thinkBlocks.push(openOnly[1].trim());
        }
        const chain = [lastReasoning, ...thinkBlocks].filter(s => !!s).join('\n\n').trim();
        return chain || null;
    };

    // 把一段文本 (parseAndExecuteActions / HTML 之外的部分) 渲染成氣泡並落庫 —— 雙語 / 表情 / 引用 / 分段
    // 與原 inline 末尾邏輯一致。抽出來是為了讓"執行功能前的本輪正文 A"能在二輪前先展示, 二輪結果 B 複用同一套。
    let sarSurfaceClaimed = false;
    const renderAndPersist = async (rawContent: string, firstThinkingChain: string | null): Promise<void> => {
        let firstMeta: any = firstThinkingChain ? { thinkingChain: firstThinkingChain } : null;
        const surfaceChunks = !sarSurfaceClaimed && sarModuleSurface?.surface
            ? splitSARChatSurfaceBubbles(sarModuleSurface.surface)
            : [];
        if (surfaceChunks.length > 0) sarSurfaceClaimed = true;
        let surfaceIndex = 0;
        const takeMeta = (base: any, canonicalChunk?: string): any => {
            let surfaceChunk: string | undefined;
            if (canonicalChunk !== undefined) {
                const aligned = consumeSARChatSurfaceChunk(canonicalChunk, surfaceChunks, surfaceIndex);
                surfaceChunk = aligned.surface;
                surfaceIndex = aligned.nextIndex;
            }
            const sarMeta = surfaceChunk && sarModuleSurface
                ? { sarModuleSurface: { ...sarModuleSurface, surface: surfaceChunk } }
                : undefined;
            const merged = firstMeta || sarMeta
                ? { ...(base || {}), ...(sarMeta || {}), ...(firstMeta || {}) }
                : base;
            firstMeta = null;
            return merged;
        };

        // 表情按模型寫的位置原地插發。名字在表情庫裡找不到時落一條降級文本氣泡，不靜默丟：
        // 後台主動消息會把每個 [[SEND_EMOJI]] 切成獨立一條 push，找不到就是整條 0 氣泡，而
        // 系統橫幅和未讀數照常 +1 —— 用戶點進去空空如也。名字對不上有兩條常見來路：模型自己
        // 編了個不存在的名字，或者用戶在上次打包之後刪了 / 改名了這個表情。
        // 降級文案跟橫幅那邊（sanitizeIntoSegments 的 [表情：x]）對齊，鎖屏看到什麼點進去就是什麼。
        const sendEmojiBubble = async (name: string): Promise<void> => {
            await typingPause(Math.random() * 500 + 300);
            const foundEmoji = resolveEmojiForSend(name, emojis, ctx.categories);
            if (foundEmoji) {
                await persistMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url, metadata: takeMeta(mcdInheritMeta) } as any);
            } else {
                console.warn('[emoji] 表情庫裡沒有這個名字，落降級文本氣泡', { name, charId: char.id });
                await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: `[表情：${name}]`, metadata: takeMeta(mcdInheritMeta) } as any);
            }
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        };

        // 把 [[QUOTE: ...]] / [回覆 "..."] 的引用文本解析成"被回覆的那條用戶消息"。
        // 開了翻譯的外語/粵語角色，引用文本往往是外語、或被 <原文>/<譯文> 翻譯標籤包裹，
        // 跟庫裡中文用戶消息逐字 includes 匹配會失敗 → 之前表現為丟引用 / 空引用氣泡。
        // 這裡先剝掉翻譯標籤再逐字/前綴精確定位；匹配不到就兜底到「最近一條用戶文字消息」
        // （[[QUOTE]] 基本放在回覆開頭、指代最近一句話，兜底足夠穩），杜絕外語角色空引用。
        const resolveQuoteTarget = (quotedTextRaw: string): { id: number, content: string, name: string } | undefined => {
            const raw = (quotedTextRaw || '').trim();
            // 引用文本可能被翻譯標籤包裹：<原文>(外語) 與 <譯文>(本地語) 都可能命中庫裡的中文用戶消息。
            // 不能直接剝標籤——那樣會把原文+譯文拼成一串(如「你好Hello」)導致 includes 永遠匹配不上。
            // 這裡把兩邊內容各自當候選逐個匹配；沒有成對標籤時再退化成「剝掉零散標籤」的兜底候選。
            const candidates: string[] = [];
            // 歷史渲染的引用摘要超過 60 字會帶截斷省略號，剝掉再匹配（不剝則 includes 永遠失敗）。
            const pushCand = (s?: string) => { const t = (s || '').trim().replace(/(?:[…⋯]+|\.{3,})$/, '').trim(); if (t && !candidates.includes(t)) candidates.push(t); };
            pushCand(raw.match(/<原文>([\s\S]*?)<\/原文>/)?.[1]);
            pushCand(raw.match(/<[译譯]文>([\s\S]*?)<\/[译譯]文>/)?.[1]);
            pushCand(raw.replace(/<\/?翻[译譯]>|<\/?原文>|<\/?[译譯]文>/g, '').replace(/%%BILINGUAL%%/gi, ''));
            const users = contextMsgs.filter((m: Message) => m.role === 'user' && typeof m.content === 'string' && !!m.content.trim());
            const reversedUsers = users.slice().reverse();
            let targetMsg: Message | undefined;
            for (const q of candidates) {
                targetMsg = reversedUsers.find((m: Message) => m.content.includes(q))
                    || (q.length > 10 ? reversedUsers.find((m: Message) => m.content.includes(q.slice(0, 10))) : undefined);
                if (targetMsg) break;
            }
            // 兜底：精確匹配失敗但角色明確想引用 → 取最近一條用戶文字消息，避免空引用
            if (!targetMsg) targetMsg = users.filter((m: Message) => m.type === 'text' || !m.type).slice(-1)[0] || users.slice(-1)[0];
            if (!targetMsg) return undefined;
            return { id: targetMsg.id, content: buildReplySnapshotContent(targetMsg), name: userProfile.name };
        };

        // Quote/Reply 目標 (雙語路徑用)
        let aiReplyTarget: { id: number, content: string, name: string } | undefined;
        const firstQuoteMatch = rawContent.match(QUOTE_RE_DOUBLE) || rawContent.match(QUOTE_RE_SINGLE) || rawContent.match(REPLY_RE_CN) || rawContent.match(QUOTE_RE_NL);
        if (firstQuoteMatch) aiReplyTarget = resolveQuoteTarget(firstQuoteMatch[1]);

        let content = ChatParser.sanitize(rawContent, { keepCitations: true });
        content = content.replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '').trim();
        if (!content) return;

        const hasTranslationTags = /<翻[译譯]>\s*<原文>[\s\S]*?<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/.test(content);
        let globalMsgIndex = 0;

        if (hasTranslationTags) {
            // ─── 雙語 ───
            // 表情包按模型寫的位置原地插發（sendEmojiBubble 見函數頂部）。舊實現先把所有
            // [[SEND_EMOJI:]] 抽走、正文發完後統一追加到最後（還去了重），表現為「翻譯模式下
            // 角色永遠最後才發表情包」。
            // 翻譯標籤之外的普通文本段：splitResponse 按出現順序拆出文字 / 表情逐條發
            const renderPlainSegment = async (segment: string): Promise<void> => {
                for (const part of ChatParser.splitResponse(segment)) {
                    if (part.type === 'emoji') {
                        await sendEmojiBubble(part.content);
                        continue;
                    }
                    const cleaned = ChatParser.sanitize(part.content);
                    if (!cleaned || !ChatParser.hasDisplayContent(cleaned)) continue;
                    const chunks = ChatParser.chunkText(cleaned);
                    for (const chunk of chunks) {
                        if (!chunk) continue;
                        const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                        await typingPause(Math.min(Math.max(chunk.length * 50, 500), 2000));
                        await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, chunk) } as any);
                        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        globalMsgIndex++;
                    }
                }
            };
            const tagPattern = /<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>([\s\S]*?)<\/[译譯]文>\s*<\/翻[译譯]>/g;
            let lastIndex = 0;
            let tagMatch;

            while ((tagMatch = tagPattern.exec(content)) !== null) {
                const textBefore = content.slice(lastIndex, tagMatch.index).trim();
                if (textBefore) await renderPlainSegment(textBefore);

                // 混進 <原文>/<譯文> 裡的表情標籤剝出來，緊跟這條雙語氣泡之後發
                const inlineEmojis: string[] = [];
                const stripInlineEmoji = (s: string): string =>
                    s.replace(/\[\[SEND_EMOJI:\s*(.*?)\]\]/g, (_m, n) => { inlineEmojis.push(String(n).trim()); return ''; });
                const originalText = ChatParser.sanitize(stripInlineEmoji(tagMatch[1]).trim());
                const translatedText = ChatParser.sanitize(stripInlineEmoji(tagMatch[2]).trim());
                if (originalText || translatedText) {
                    const biContent = originalText && translatedText
                        ? `${originalText}\n%%BILINGUAL%%\n${translatedText}`
                        : (originalText || translatedText);
                    const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                    await typingPause(Math.min(Math.max(biContent.length * 30, 400), 2000));
                    await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: biContent, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, biContent) } as any);
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    globalMsgIndex++;
                }
                for (const name of inlineEmojis) await sendEmojiBubble(name);

                lastIndex = tagMatch.index + tagMatch[0].length;
            }

            const textAfter = content.slice(lastIndex).trim();
            if (textAfter) await renderPlainSegment(textAfter.replace(/<\/?翻[译譯]>|<\/?原文>|<\/?[译譯]文>/g, '').trim());
        } else {
            // ─── normal path (splitResponse → chunkText → per-chunk save) ───
            const parts = ChatParser.splitResponse(content);
            // 模型常把 [[QUOTE:]] 單獨寫一行 (後面緊跟換行或 [[SEND_EMOJI:]]), chunkText/splitResponse
            // 會把它拆成一個"只有標籤沒有正文"的 chunk — 剝標籤後 hasDisplayContent 為 false 不落庫,
            // 解析出的引用目標若不暫存就會隨之丟失。掛到下一條真正落庫的文字氣泡上。
            let pendingReplyTarget: { id: number, content: string, name: string } | undefined;
            for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                const part = parts[partIndex];

                if (part.type === 'emoji') {
                    await sendEmojiBubble(part.content);
                } else {
                    const rawBlocks = part.content.split(/^\s*---\s*$/m).filter(b => b.trim());
                    const allChunks: string[] = [];
                    for (const block of rawBlocks) {
                        allChunks.push(...ChatParser.chunkText(block.trim()));
                    }
                    if (allChunks.length === 0 && part.content.trim()) allChunks.push(part.content.trim());

                    for (let i = 0; i < allChunks.length; i++) {
                        let chunk = allChunks[i];
                        const delay = Math.min(Math.max(chunk.length * 50, 500), 2000);
                        await typingPause(delay);

                        let chunkReplyTarget: { id: number, content: string, name: string } | undefined;
                        const chunkQuoteMatch = chunk.match(QUOTE_RE_DOUBLE) || chunk.match(QUOTE_RE_SINGLE) || chunk.match(REPLY_RE_CN) || chunk.match(QUOTE_RE_NL);
                        if (chunkQuoteMatch) {
                            chunkReplyTarget = resolveQuoteTarget(chunkQuoteMatch[1]);
                            chunk = chunk.replace(QUOTE_CLEAN_DOUBLE, '').replace(QUOTE_CLEAN_SINGLE, '').replace(REPLY_CLEAN_CN, '').replace(QUOTE_CLEAN_NL, '').trim();
                        }

                        const replyData = chunkReplyTarget ?? pendingReplyTarget;

                        let chunkSaved = false;
                        if (ChatParser.hasDisplayContent(chunk)) {
                            const cleanChunk = ChatParser.sanitize(chunk);
                            if (cleanChunk) {
                                await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: cleanChunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, cleanChunk) } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                                globalMsgIndex++;
                                chunkSaved = true;
                            }
                        }
                        pendingReplyTarget = chunkSaved ? undefined : replyData;
                    }
                }
            }
        }
    };

    // 「執行功能前的本輪正文 A」: 在二輪重生開始前先把 A 渲染成氣泡, 這樣用戶看到的順序是
    // A 氣泡 → "正在搜索/調閱…" 狀態 → 二輪結果 B 氣泡 (而不是等 B 回來才一起冒出來)。
    // XHS_*/READ_NOTE 標籤 sanitize 不剝, 這裡先剝掉; 其餘 RECALL/SEARCH/DIARY... 由 renderAndPersist
    // 內 sanitize 統一清。A 的思考鏈取一輪 reasoning。
    const round1ThinkingChain = extractThinkingChain(initialData, pushReasoningContent);
    let leadInRendered = false;
    const renderLeadIn = async (raw: string): Promise<void> => {
        if (leadInRendered) return;
        leadInRendered = true;
        await renderAndPersist(
            raw.replace(/\[\[READ_NOTE:[\s\S]*?\]\]/g, '').replace(/\[\[XHS_[A-Z_]+(?::[\s\S]*?)?\]\]/g, ''),
            round1ThinkingChain,
        );
    };

    // ─── Step 2: 二輪 LLM 鉤子 ───

    // 本輪回復裡只要含"會觸發二輪重生"的指令 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY /
    // READ_NOTE / XHS_SEARCH|BROWSE|MY_PROFILE|DETAIL), 就先把指令之外的本輪正文 A 落庫展示。
    // 純副作用 (XHS_SHARE/COMMENT/LIKE/FAV/POST、寫日記) 不重生、不需要先展示, 故不在此列。
    // 之後各分支正常跑功能 + 二輪; 末尾再展示 B。若分支因未配置等原因沒真正發起二輪 (data 不變),
    // 末尾會跳過重複渲染 (見下方收尾)。
    if (!skipSecondPassLLM) {
        const willRegenerate =
            /\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/.test(aiContent)
            || /\[\[SEARCH:\s*.+?\]\]/.test(aiContent)
            || /\[\[READ_DIARY:\s*.+?\]\]/.test(aiContent)
            || /\[\[FS_READ_DIARY:\s*.+?\]\]/.test(aiContent)
            || /\[\[READ_NOTE:\s*.+?\]\]/.test(aiContent)
            || /\[\[XHS_SEARCH:\s*.+?\]\]/.test(aiContent)
            || /\[\[XHS_BROWSE(?::\s*.+?)?\]\]/.test(aiContent)
            || /\[\[XHS_MY_PROFILE\]\]/.test(aiContent)
            || /\[\[XHS_DETAIL:\s*.+?\]\]/.test(aiContent);
        if (willRegenerate) await renderLeadIn(aiContent);
    }

    // 5. Handle Recall (Loop if needed)
    const recallMatch = aiContent.match(/\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/);
    if (!skipSecondPassLLM && recallMatch) {
        const year = recallMatch[1];
        const month = recallMatch[2];
        // 模型常把 [[RECALL]] 指令和本輪正文 A 寫在同一條回覆裡 (A 已在 Step 2 開頭先行展示)。把 A
        // 作為 assistant 上文餵給二輪, 讓二輪結果 B 接著 A 往下說, 更連貫。
        const recallLeadIn = aiContent.replace(/\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/g, '').trim();
        const rr = await runRecall({ year, month }, agenticCtx);

        if (rr.ok && rr.alreadyActive) {
            console.log(`♻️ [Recall] ${rr.yearMonth} already in activeMemoryMonths, skipping duplicate recall`);
            aiContent = aiContent.replace(/\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/g, '').trim();
        } else if (rr.ok && rr.logsText) {
            setRecallStatus(`正在調閱 ${year}年${month}月 的詳細檔案...`);
            const recallMessages = [...fullMessages, ...(recallLeadIn ? [{ role: 'assistant', content: recallLeadIn }] : []), { role: 'user', content: `[系統: 已成功調取 ${year}-${month} 的詳細日誌]\n${rr.logsText}\n[系統: 現在請結合這些細節回答用戶。保持對話自然。]` }];
            try {
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: recallMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '調閱記憶' });
                updateTokenUsage(data, historyMsgCount, 'recall');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`已調用 ${year}-${month} 詳細記憶`, 'info');
            } catch (recallErr: any) {
                console.error('Recall API failed:', recallErr.message);
            }
        } else {
            // !rr.ok && rr.reason === 'no_logs' — matches original "set status, no-op, clear" path
            setRecallStatus(`正在調閱 ${year}年${month}月 的詳細檔案...`);
        }
    }
    setRecallStatus('');

    // 5.5 Handle Active Search (主動搜索)
    const searchMatch = aiContent.match(/\[\[SEARCH:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && searchMatch) {
        const searchQuery = searchMatch[1].trim();
        console.log('🔍 [Search] AI觸發搜索:', searchQuery);
        setSearchStatus(`正在搜索: ${searchQuery}...`);

        try {
            const sr = await runSearch({ query: searchQuery }, agenticCtx);
            console.log('🔍 [Search] 搜索結果:', sr);

            if (sr.ok) {
                console.log('🔍 [Search] 注入結果到AI，重新生成回覆...');

                const cleanedForSearch = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim() || '讓我搜一下...';
                const searchMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForSearch },
                    { role: 'user', content: `[系統: 搜索完成！以下是關於"${searchQuery}"的搜索結果]\n\n${sr.resultsText}\n\n[系統: 現在請根據這些真實信息回覆用戶。用自然的語氣分享，比如"我剛搜了一下發現..."、"誒我看到說..."。不要再輸出[[SEARCH:...]]了。]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: searchMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '聯網搜索' });
                updateTokenUsage(data, historyMsgCount, 'search');
                aiContent = data.choices?.[0]?.message?.content || '';
                console.log('🔍 [Search] AI基於搜索結果生成的新回覆:', aiContent.slice(0, 100) + '...');
                aiContent = normalizeAiContent(aiContent);
                addToast(`🔍 搜索完成: ${searchQuery}`, 'success');
            } else if (sr.reason === 'no_api_key') {
                console.log('🔍 [Search] 檢測到搜索意圖但未配置API Key');
                aiContent = aiContent.replace(searchMatch[0], '').trim();
            } else {
                // sr.reason === 'no_results'
                console.log('🔍 [Search] 搜索失敗或無結果:', sr.message);
                addToast(`搜索失敗: ${sr.message}`, 'error');
                aiContent = aiContent.replace(searchMatch[0], '').trim();
            }
        } catch (e) {
            console.error('Search execution failed:', e);
            aiContent = aiContent.replace(searchMatch[0], '').trim();
        }
    } else if (searchMatch) {
        console.log('🔍 [Search] 檢測到搜索意圖但未配置API Key');
        aiContent = aiContent.replace(searchMatch[0], '').trim();
    }
    setSearchStatus('');

    aiContent = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim();

    // 5.6 Handle Diary Writing (寫日記到 Notion)
    const diaryStartMatch = aiContent.match(/\[\[DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[DIARY_END\]\]/);
    const diaryMatch = diaryStartMatch || aiContent.match(/\[\[DIARY:\s*(.+?)\]\]/s);

    if (diaryMatch && realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
        let title = '';
        let content = '';
        let mood = '';

        if (diaryStartMatch) {
            const header = diaryStartMatch[1].trim();
            content = diaryStartMatch[2].trim();

            if (header.includes('|')) {
                const parts = header.split('|');
                title = parts[0].trim();
                mood = parts.slice(1).join('|').trim();
            } else {
                title = header;
            }
            console.log('📔 [Diary] AI寫了一篇長日記:', title, '心情:', mood);
        } else {
            const diaryRaw = diaryMatch[1].trim();
            console.log('📔 [Diary] AI想寫日記:', diaryRaw);

            if (diaryRaw.includes('|')) {
                const parts = diaryRaw.split('|');
                title = parts[0].trim();
                content = parts.slice(1).join('|').trim();
            } else {
                content = diaryRaw;
            }
        }

        if (!title) {
            const now = new Date();
            title = `${char.name}的日記 - ${now.getMonth() + 1}/${now.getDate()}`;
        }

        // 預寫日誌: 發請求前先把內容落進待寫隊列 (localStorage 同步落盤), 這樣即使後續 fetch 失敗 /
        // app 被殺, 內容也不丟. 前台可見才立即寫 (本地路徑 + 前台收到的雲端回覆, fetch 可靠); 後台時不發
        // 這個脆弱的請求 (易被凍結打斷, 甚至服務端寫成功但響應丟失 → 回前台重試會重複寫), 直接留在
        // 隊列, 等 drainPendingDiaries 在回前台時補打. 寫成功就刪掉這條.
        const pendingDiaryId = enqueuePendingDiary({ kind: 'notion', charId: char.id, charName: char.name, title, content, mood: mood || undefined });
        const canWriteDiaryNow = typeof document === 'undefined' || document.visibilityState === 'visible';
        if (canWriteDiaryNow) {
            try {
                const result = await NotionManager.createDiaryPage(
                    realtimeConfig.notionApiKey,
                    realtimeConfig.notionDatabaseId,
                    { title, content, mood: mood || undefined, characterName: char.name }
                );

                if (result.success) {
                    removePendingDiary(pendingDiaryId);
                    console.log('📔 [Diary] 寫入成功:', result.url);
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📔 ${char.name}寫了一篇日記「${title}」`
                    });
                    addToast(`📔 ${char.name}寫了一篇日記!`, 'success');
                } else {
                    // API 明確拒絕 (配置/權限問題, 重試也沒用) → 丟棄 + 報錯.
                    removePendingDiary(pendingDiaryId);
                    console.error('📔 [Diary] 寫入失敗:', result.message);
                    addToast(`日記寫入失敗: ${result.message}`, 'error');
                }
            } catch (e) {
                // 網絡異常 (可恢復). 保留待寫隊列, 回前台 drainPendingDiaries 補打.
                console.error('📔 [Diary] 寫入異常, 留待回前台重試:', e);
            }
        } else {
            console.log('📔 [Diary] 當前後台, 已入隊待寫, 回前台補打');
        }

        aiContent = aiContent.replace(diaryMatch[0], '').trim();
    } else if (diaryMatch) {
        // 主動消息是提前幾小時打包的，打包時日記服務還連著、送達前用戶把它關掉是常態。
        // 角色那句「我去寫日記了」已經說滿，日記卻靜默蒸發——留一條系統提示說明為什麼沒寫成。
        console.log('📔 [Diary] 檢測到日記意圖但未配置Notion');
        await persistMessage({
            charId: char.id,
            role: 'system',
            type: 'text',
            content: `📔 ${char.name}想寫日記，但日記服務沒連上（未配置或已斷開），這篇沒寫成`,
        });
        aiContent = aiContent.replace(diaryMatch[0], '').trim();
    }

    aiContent = aiContent.replace(/\[\[DIARY:.*?\]\]/gs, '').trim();
    aiContent = aiContent.replace(/\[\[DIARY_START:.*?\]\][\s\S]*?\[\[DIARY_END\]\]/g, '').trim();

    // 5.7 Handle Read Diary (翻閱日記)
    const readDiaryMatch = aiContent.match(/\[\[READ_DIARY:\s*(.+?)\]\]/);

    const diaryFallbackCall = async (reason: string, tagPattern: RegExp) => {
        const cleaned = aiContent.replace(tagPattern, '').trim() || '讓我翻翻日記...';
        const msgs = [
            ...fullMessages,
            { role: 'assistant', content: cleaned },
            { role: 'user', content: `[系統: ${reason}。請你：\n1. 先正常回應用戶剛才說的話（用戶還在等你回覆！）\n2. 可以自然地提一下，比如"日記好像打不開誒"、"嗯...好像沒找到"\n3. 繼續正常聊天，用多條消息回覆\n4. 嚴禁再輸出[[READ_DIARY:...]]或[[FS_READ_DIARY:...]]標記]` }
        ];
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', headers,
                body: JSON.stringify({ model: effectiveApi.model, messages: msgs, temperature: 0.8, max_tokens: 8000, stream: false })
            }, 2, 0, { ...apiLogMeta, purpose: '寫日記' });
            updateTokenUsage(data, historyMsgCount, 'diary-fallback');
            aiContent = data.choices?.[0]?.message?.content || '';
            aiContent = normalizeAiContent(aiContent);
        } catch (fallbackErr) {
            console.error('📖 [Diary Fallback] 也失敗了:', fallbackErr);
            aiContent = aiContent.replace(tagPattern, '').trim();
        }
    };

    const parseDiaryDate = (dateInput: string): string => {
        const now = new Date();
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return dateInput;
        if (dateInput === '今天') return getLocalDateKey(now);
        if (dateInput === '昨天') { const d = new Date(now); d.setDate(d.getDate() - 1); return getLocalDateKey(d); }
        if (dateInput === '前天') { const d = new Date(now); d.setDate(d.getDate() - 2); return getLocalDateKey(d); }
        const daysAgo = dateInput.match(/^(\d+)天前$/);
        if (daysAgo) { const d = new Date(now); d.setDate(d.getDate() - parseInt(daysAgo[1])); return getLocalDateKey(d); }
        const monthDay = dateInput.match(/(\d{1,2})月(\d{1,2})/);
        if (monthDay) return `${now.getFullYear()}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
        const parsed = new Date(dateInput);
        if (!isNaN(parsed.getTime())) return getLocalDateKey(parsed);
        return '';
    };

    if (!skipSecondPassLLM && readDiaryMatch) {
        const dateInput = readDiaryMatch[1].trim();
        console.log('📖 [ReadDiary] AI想翻閱日記:', dateInput);

        if (realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
            const targetDate = parseDiaryDate(dateInput);

            if (targetDate) {
                try {
                    setDiaryStatus(`正在翻閱 ${targetDate} 的日記...`);

                    const rdr = await runReadDiary({ date: dateInput }, agenticCtx);

                    if (rdr.ok) {
                        // 注: "找到 N 篇日記，正在閱讀..." 由 runReadDiary 內部 onProgress 觸發
                        console.log('📖 [ReadDiary] 成功讀取', rdr.entryCount, '篇日記');
                        setDiaryStatus('正在整理日記回憶...');

                        const cleanedForDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '讓我翻翻日記...';
                        const diaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForDiary },
                            { role: 'user', content: `[系統: 你翻開了自己 ${targetDate} 的日記，以下是你當時寫的內容]\n\n${rdr.diaryText}\n\n[系統: 你已經看完了日記。現在請你：\n1. 先正常回應用戶剛才說的話（這是最重要的！用戶還在等你回覆）\n2. 自然地把日記中的回憶融入你的回覆中，比如"我想起來了那天..."、"看了日記才發現..."等\n3. 可以分享日記中有趣的細節，表達當時的情緒\n4. 用多條消息回覆，別只說一句話就結束\n5. 嚴禁再輸出[[READ_DIARY:...]]標記]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: diaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻閱日記' });
                        updateTokenUsage(data, historyMsgCount, 'read-diary-notion');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                        addToast(`📖 ${char.name}翻閱了${targetDate}的日記`, 'info');
                    } else if (rdr.reason === 'empty_content') {
                        console.log('📖 [ReadDiary] 日記內容為空');
                        await diaryFallbackCall('你翻開了日記本但頁面是空白的', /\[\[READ_DIARY:.*?\]\]/g);
                    } else if (rdr.reason === 'unreachable') {
                        // 「查過了，那天沒寫」和「壓根沒查成」是兩回事。傳輸就沒跑通時說成
                        // 「那天沒寫日記」，等於替用戶認下一件沒發生的事，之後角色還會順著這個
                        // 假前提聊下去。跟讀取異常走同一條圓場路：只說沒查成，不下結論。
                        console.log('📖 [ReadDiary] 日記服務連不上，這次沒查成:', targetDate);
                        setDiaryStatus('日記服務連不上，繼續對話...');
                        await diaryFallbackCall(
                            `你想翻 ${targetDate} 的日記，但日記服務連不上，這次沒查成（不知道那天到底寫沒寫）`,
                            /\[\[READ_DIARY:.*?\]\]/g,
                        );
                    } else {
                        // rdr.reason === 'not_found'  (parse_error / not_configured 被外層 if 攔住)
                        console.log('📖 [ReadDiary] 該日期沒有日記:', targetDate);
                        setDiaryStatus(`${targetDate} 沒有找到日記...`);
                        const cleanedForNoDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '讓我翻翻日記...';
                        const nodiaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForNoDiary },
                            { role: 'user', content: `[系統: 你翻了翻日記本，發現 ${targetDate} 那天沒有寫日記。請你：\n1. 先正常回應用戶剛才說的話（用戶還在等你回覆！）\n2. 自然地提到沒找到那天的日記，比如"嗯...那天好像沒寫日記"、"翻了翻沒找到誒"\n3. 用多條消息回覆，保持對話自然\n4. 嚴禁再輸出[[READ_DIARY:...]]標記]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: nodiaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻閱日記' });
                        updateTokenUsage(data, historyMsgCount, 'no-diary-notion');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                    }
                } catch (e) {
                    console.error('📖 [ReadDiary] 讀取異常:', e);
                    setDiaryStatus('日記讀取失敗，繼續對話...');
                    await diaryFallbackCall('你想翻閱日記但讀取出了問題（可能是網絡問題）', /\[\[READ_DIARY:.*?\]\]/g);
                }
            } else {
                console.log('📖 [ReadDiary] 無法解析日期:', dateInput);
                await diaryFallbackCall(`你想翻閱日記但沒能理解要找哪天的（"${dateInput}"）`, /\[\[READ_DIARY:.*?\]\]/g);
            }
        } else {
            console.log('📖 [ReadDiary] 檢測到讀日記意圖但未配置Notion');
            await diaryFallbackCall('你想翻閱日記但日記本暫時不可用', /\[\[READ_DIARY:.*?\]\]/g);
        }
        setDiaryStatus('');
    }

    aiContent = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim();

    // 5.8 Handle Feishu Diary Writing
    const fsDiaryStartMatch = aiContent.match(/\[\[FS_DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[FS_DIARY_END\]\]/);
    const fsDiaryMatch = fsDiaryStartMatch || aiContent.match(/\[\[FS_DIARY:\s*(.+?)\]\]/s);

    if (fsDiaryMatch && realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
        let fsTitle = '';
        let fsContent = '';
        let fsMood = '';

        if (fsDiaryStartMatch) {
            const header = fsDiaryStartMatch[1].trim();
            fsContent = fsDiaryStartMatch[2].trim();
            if (header.includes('|')) {
                const parts = header.split('|');
                fsTitle = parts[0].trim();
                fsMood = parts.slice(1).join('|').trim();
            } else {
                fsTitle = header;
            }
            console.log('📒 [Feishu] AI寫了一篇長日記:', fsTitle, '心情:', fsMood);
        } else {
            const diaryRaw = fsDiaryMatch[1].trim();
            console.log('📒 [Feishu] AI想寫日記:', diaryRaw);
            if (diaryRaw.includes('|')) {
                const parts = diaryRaw.split('|');
                fsTitle = parts[0].trim();
                fsContent = parts.slice(1).join('|').trim();
            } else {
                fsContent = diaryRaw;
            }
        }

        if (!fsTitle) {
            const now = new Date();
            fsTitle = `${char.name}的日記 - ${now.getMonth() + 1}/${now.getDate()}`;
        }

        // 預寫日誌 + 可見性判斷, 同 Notion.
        const pendingFsDiaryId = enqueuePendingDiary({ kind: 'feishu', charId: char.id, charName: char.name, title: fsTitle, content: fsContent, mood: fsMood || undefined });
        const canWriteFsDiaryNow = typeof document === 'undefined' || document.visibilityState === 'visible';
        if (canWriteFsDiaryNow) {
            try {
                const result = await FeishuManager.createDiaryRecord(
                    realtimeConfig.feishuAppId,
                    realtimeConfig.feishuAppSecret,
                    realtimeConfig.feishuBaseId,
                    realtimeConfig.feishuTableId,
                    { title: fsTitle, content: fsContent, mood: fsMood || undefined, characterName: char.name }
                );

                if (result.success) {
                    removePendingDiary(pendingFsDiaryId);
                    console.log('📒 [Feishu] 寫入成功:', result.recordId);
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📒 ${char.name}寫了一篇日記「${fsTitle}」(飛書)`
                    });
                    addToast(`📒 ${char.name}寫了一篇日記! (飛書)`, 'success');
                } else {
                    removePendingDiary(pendingFsDiaryId);
                    console.error('📒 [Feishu] 寫入失敗:', result.message);
                    addToast(`飛書日記寫入失敗: ${result.message}`, 'error');
                }
            } catch (e) {
                // 網絡異常: 保留待寫隊列, 回前台 drainPendingDiaries 補打.
                console.error('📒 [Feishu] 寫入異常, 留待回前台重試:', e);
            }
        } else {
            console.log('📒 [Feishu] 當前後台, 已入隊待寫, 回前台補打');
        }

        aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
    } else if (fsDiaryMatch) {
        // 同 Notion：配置在打包之後被關掉時，別讓這篇日記無聲無息地消失。
        console.log('📒 [Feishu] 檢測到日記意圖但未配置飛書');
        await persistMessage({
            charId: char.id,
            role: 'system',
            type: 'text',
            content: `📒 ${char.name}想寫日記，但日記服務沒連上（未配置或已斷開），這篇沒寫成`,
        });
        aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
    }

    aiContent = aiContent.replace(/\[\[FS_DIARY:.*?\]\]/gs, '').trim();
    aiContent = aiContent.replace(/\[\[FS_DIARY_START:.*?\]\][\s\S]*?\[\[FS_DIARY_END\]\]/g, '').trim();

    // 5.9 Handle Feishu Read Diary
    const fsReadDiaryMatch = aiContent.match(/\[\[FS_READ_DIARY:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && fsReadDiaryMatch) {
        const dateInput = fsReadDiaryMatch[1].trim();
        console.log('📖 [Feishu ReadDiary] AI想翻閱飛書日記:', dateInput);

        if (realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
            const targetDate = parseDiaryDate(dateInput);

            if (targetDate) {
                try {
                    setDiaryStatus(`正在翻閱 ${targetDate} 的飛書日記...`);

                    const fsrdr = await runFsReadDiary({ date: dateInput }, agenticCtx);

                    if (fsrdr.ok) {
                        // 注: "找到 N 篇飛書日記，正在閱讀..." 由 runFsReadDiary 內部 onProgress 觸發
                        console.log('📖 [Feishu ReadDiary] 成功讀取', fsrdr.entryCount, '篇日記');
                        setDiaryStatus('正在整理日記回憶...');

                        const cleanedForFsDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '讓我翻翻日記...';
                        const diaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForFsDiary },
                            { role: 'user', content: `[系統: 你翻開了自己 ${targetDate} 的日記（飛書），以下是你當時寫的內容]\n\n${fsrdr.diaryText}\n\n[系統: 你已經看完了日記。現在請你：\n1. 先正常回應用戶剛才說的話（這是最重要的！用戶還在等你回覆）\n2. 自然地把日記中的回憶融入你的回覆中，比如"我想起來了那天..."、"看了日記才發現..."等\n3. 可以分享日記中有趣的細節，表達當時的情緒\n4. 用多條消息回覆，別只說一句話就結束\n5. 嚴禁再輸出[[FS_READ_DIARY:...]]標記]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: diaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻閱日記' });
                        updateTokenUsage(data, historyMsgCount, 'read-diary-feishu');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                        addToast(`📖 ${char.name}翻閱了${targetDate}的飛書日記`, 'info');
                    } else if (fsrdr.reason === 'unreachable') {
                        // 同 Notion：沒查成不等於那天沒寫，別把沒跑成說成沒寫。
                        console.log('📖 [Feishu ReadDiary] 飛書連不上，這次沒查成:', targetDate);
                        setDiaryStatus('飛書日記服務連不上，繼續對話...');
                        await diaryFallbackCall(
                            `你想翻 ${targetDate} 的飛書日記，但飛書連不上，這次沒查成（不知道那天到底寫沒寫）`,
                            /\[\[FS_READ_DIARY:.*?\]\]/g,
                        );
                    } else {
                        // fsrdr.reason === 'not_found'
                        setDiaryStatus(`${targetDate} 沒有找到飛書日記...`);
                        const cleanedForFsNoDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '讓我翻翻日記...';
                        const nodiaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForFsNoDiary },
                            { role: 'user', content: `[系統: 你翻了翻飛書日記本，發現 ${targetDate} 那天沒有寫日記。請你：\n1. 先正常回應用戶剛才說的話（用戶還在等你回覆！）\n2. 自然地提到沒找到那天的日記，比如"嗯...那天好像沒寫日記"、"翻了翻沒找到誒"\n3. 用多條消息回覆，保持對話自然\n4. 嚴禁再輸出[[FS_READ_DIARY:...]]標記]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: nodiaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻閱日記' });
                        updateTokenUsage(data, historyMsgCount, 'no-diary-feishu');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                    }
                } catch (e) {
                    console.error('📖 [Feishu ReadDiary] 讀取異常:', e);
                    setDiaryStatus('飛書日記讀取失敗，繼續對話...');
                    await diaryFallbackCall('你想翻閱飛書日記但讀取出了問題（可能是網絡問題）', /\[\[FS_READ_DIARY:.*?\]\]/g);
                }
            } else {
                console.log('📖 [Feishu ReadDiary] 無法解析日期:', dateInput);
                await diaryFallbackCall(`你想翻閱飛書日記但沒能理解要找哪天的（"${dateInput}"）`, /\[\[FS_READ_DIARY:.*?\]\]/g);
            }
        } else {
            console.log('📖 [Feishu ReadDiary] 檢測到讀日記意圖但未配置飛書');
            await diaryFallbackCall('你想翻閱飛書日記但飛書暫時不可用', /\[\[FS_READ_DIARY:.*?\]\]/g);
        }
        setDiaryStatus('');
    }

    aiContent = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim();

    // 5.9b Handle Read User Note
    const readNoteMatch = aiContent.match(/\[\[READ_NOTE:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && readNoteMatch) {
        const keyword = readNoteMatch[1].trim();
        console.log('📝 [ReadNote] AI想翻閱用戶筆記:', keyword);

        if (realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionNotesDatabaseId) {
            try {
                setDiaryStatus(`正在翻閱筆記: ${keyword}...`);

                const rnr = await runReadNote({ keyword }, agenticCtx);

                if (rnr.ok) {
                    // 注: "找到 N 篇筆記，正在閱讀..." 由 runReadNote 內部 onProgress 觸發
                    console.log('📝 [ReadNote] 成功讀取', rnr.entryCount, '篇筆記');
                    setDiaryStatus('正在整理筆記內容...');

                    const cleanedForNote = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim() || '讓我看看...';
                    const noteMessages = [
                        ...fullMessages,
                        { role: 'assistant', content: cleanedForNote },
                        { role: 'user', content: `[系統: 你翻閱了${userProfile.name}的筆記，以下是內容:\n\n${rnr.noteText}\n\n請你：\n1. 先正常回應用戶剛才說的話\n2. 自然地提到你看到的筆記內容，語氣溫馨，像不經意間看到的\n3. 可以對內容表示好奇、關心或共鳴\n4. 用多條消息回覆，保持對話自然\n5. 嚴禁再輸出[[READ_NOTE:...]]標記]` }
                    ];

                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: effectiveApi.model, messages: noteMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                    }, 2, 0, { ...apiLogMeta, purpose: '翻閱筆記' });
                    updateTokenUsage(data, historyMsgCount, 'read-note');
                    aiContent = data.choices?.[0]?.message?.content || '';
                    aiContent = normalizeAiContent(aiContent);
                    addToast(`📝 ${char.name}翻閱了關於"${keyword}"的筆記`, 'info');
                } else if (rnr.reason === 'empty_content') {
                    console.log('📝 [ReadNote] 筆記內容為空');
                    await diaryFallbackCall('你翻閱了筆記但內容是空的', /\[\[READ_NOTE:.*?\]\]/g);
                } else if (rnr.reason === 'unreachable') {
                    // 同日記：沒查成不等於沒有這篇筆記。說成「沒找到」，用戶會以為自己沒寫過。
                    console.log('📝 [ReadNote] 筆記服務連不上，這次沒查成:', keyword);
                    setDiaryStatus('筆記服務連不上，繼續對話...');
                    await diaryFallbackCall(
                        `你想翻${userProfile.name}關於"${keyword}"的筆記，但筆記服務連不上，這次沒查成（不知道到底有沒有這篇）`,
                        /\[\[READ_NOTE:.*?\]\]/g,
                    );
                } else {
                    // rnr.reason === 'not_found'
                    console.log('📝 [ReadNote] 沒有找到匹配的筆記:', keyword);
                    setDiaryStatus(`沒有找到關於"${keyword}"的筆記...`);
                    const cleanedForNoNote = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim() || '讓我看看...';
                    const nonoteMessages = [
                        ...fullMessages,
                        { role: 'assistant', content: cleanedForNoNote },
                        { role: 'user', content: `[系統: 你想看${userProfile.name}關於"${keyword}"的筆記，但沒有找到。請你：\n1. 先正常回應用戶剛才說的話\n2. 可以自然地提一下，比如"嗯，好像沒找到那篇筆記"\n3. 繼續正常聊天\n4. 嚴禁再輸出[[READ_NOTE:...]]標記]` }
                    ];

                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: effectiveApi.model, messages: nonoteMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                    }, 2, 0, { ...apiLogMeta, purpose: '翻閱筆記' });
                    updateTokenUsage(data, historyMsgCount, 'read-note-empty');
                    aiContent = data.choices?.[0]?.message?.content || '';
                    aiContent = normalizeAiContent(aiContent);
                }
            } catch (e) {
                console.error('📝 [ReadNote] 讀取異常:', e);
                setDiaryStatus('筆記讀取失敗，繼續對話...');
                await diaryFallbackCall('你想翻閱筆記但讀取出了問題（可能是網絡問題）', /\[\[READ_NOTE:.*?\]\]/g);
            }
        } else {
            console.log('📝 [ReadNote] 檢測到讀筆記意圖但未配置筆記數據庫');
            await diaryFallbackCall('你想翻閱筆記但筆記功能暫時不可用', /\[\[READ_NOTE:.*?\]\]/g);
        }
        setDiaryStatus('');
    }

    aiContent = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim();

    // 5.10 Handle XHS (小紅書) Actions
    const xhsConf = resolveXhsConfig(char, realtimeConfig);

    // [[XHS_SEARCH: 關鍵詞]]
    const xhsSearchMatch = aiContent.match(/\[\[XHS_SEARCH:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && xhsSearchMatch && xhsConf.enabled) {
        const keyword = xhsSearchMatch[1].trim();
        console.log(`📕 [XHS] AI想搜索小紅書:`, keyword);
        setXhsStatus(`正在小紅書搜索: ${keyword}...`);

        try {
            const xsr = await runXhsSearch({ keyword }, agenticCtx);
            if (xsr.ok) {
                const cleanedForXhs = aiContent.replace(/\[\[XHS_SEARCH:.*?\]\]/g, '').trim() || '讓我去小紅書看看...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系統: 你在小紅書搜索了"${keyword}"，以下是搜索結果]\n\n${xsr.notesText}\n\n[系統: 你已經看完了搜索結果（注意：以上只是摘要，想看某條筆記的完整正文可以用 [[XHS_DETAIL: noteId]]）。現在請你：\n1. 自然地分享你看到的內容，比如"我剛在小紅書搜了一下..."、"誒小紅書上有人說..."\n2. 可以評價、吐槽、分享感興趣的內容\n3. 如果覺得某條筆記特別值得分享，可以用 [[XHS_SHARE: 序號]] 把它作為卡片分享給用戶（序號從1開始），可以分享多條；不要手寫“[你分享了小紅書筆記]”及標題/作者/互動/簡介，分享卡片必須使用該標記\n4. 如果想評論某條筆記，可以用 [[XHS_COMMENT: noteId | 評論內容]]\n5. 如果喜歡某條筆記，可以用 [[XHS_LIKE: noteId]] 點贊，[[XHS_FAV: noteId]] 收藏\n6. 如果想看某條筆記的完整內容和評論區，可以用 [[XHS_DETAIL: noteId]]\n7. 嚴禁再輸出[[XHS_SEARCH:...]]標記]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小紅書搜索' });
                updateTokenUsage(data, historyMsgCount, 'xhs-search');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                await persistMessage({
                    charId: char.id,
                    role: 'system',
                    type: 'text',
                    content: `📕 ${char.name}在小紅書搜索了「${keyword}」，看了 ${xsr.notes.length} 條筆記`
                });
                addToast(`📕 ${char.name}搜索了小紅書: ${keyword}`, 'info');
            } else {
                // xsr.reason === 'no_results' (not_enabled 已被外層 if 排除)
                console.log('📕 [XHS] 搜索無結果:', xsr.message);
                aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
            }
        } catch (e) {
            console.error('📕 [XHS] 搜索異常:', e);
            aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsSearchMatch) {
        aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_SEARCH:.*?\]\]/g, '').trim();

    // [[XHS_BROWSE]] or [[XHS_BROWSE: 分類]]
    const xhsBrowseMatch = aiContent.match(/\[\[XHS_BROWSE(?::\s*(.+?))?\]\]/);
    if (!skipSecondPassLLM && xhsBrowseMatch && xhsConf.enabled) {
        const category = xhsBrowseMatch[1]?.trim();
        console.log(`📕 [XHS] AI想刷小紅書:`, category || '首頁推薦');
        setXhsStatus('正在刷小紅書...');

        try {
            const xbr = await runXhsBrowse({ category }, agenticCtx);
            if (xbr.ok) {
                const cleanedForXhs = aiContent.replace(/\[\[XHS_BROWSE(?::.*?)?\]\]/g, '').trim() || '讓我刷刷小紅書...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系統: 你刷了一會兒小紅書首頁，以下是你看到的內容]\n\n${xbr.notesText}\n\n[系統: 你已經看完了（注意：以上只是摘要，想看某條筆記的完整正文可以用 [[XHS_DETAIL: noteId]]）。現在請你：\n1. 像在跟朋友分享一樣，隨意聊聊你看到了什麼有趣的\n2. 不用全部都提，挑你感興趣的1-3條聊就行\n3. 可以吐槽、感嘆、分享想法\n4. 如果覺得某條筆記特別值得分享，可以用 [[XHS_SHARE: 序號]] 把它作為卡片分享給用戶（序號從1開始），可以分享多條；不要手寫“[你分享了小紅書筆記]”及標題/作者/互動/簡介，分享卡片必須使用該標記\n5. 如果想發一條自己的筆記，可以用 [[XHS_POST: 標題 | 內容 | #標籤1 #標籤2]]\n6. 如果喜歡某條筆記，可以用 [[XHS_LIKE: noteId]] 點贊，[[XHS_FAV: noteId]] 收藏\n7. 如果想看某條筆記的完整內容和評論區，可以用 [[XHS_DETAIL: noteId]]\n8. 嚴禁再輸出[[XHS_BROWSE]]標記]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小紅書瀏覽' });
                updateTokenUsage(data, historyMsgCount, 'xhs-browse');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`📕 ${char.name}刷了會兒小紅書`, 'info');
            } else {
                // xbr.reason === 'no_results' (not_enabled 已被外層 if 排除)
                aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
            }
        } catch (e) {
            console.error('📕 [XHS] 瀏覽異常:', e);
            aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsBrowseMatch) {
        aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_BROWSE(?::.*?)?\]\]/g, '').trim();

    // Search/browse can replace aiContent with a second-pass LLM response, so scan that result too.
    const secondPassMimickedXhsShares = extractMimickedXhsShares(aiContent);
    aiContent = secondPassMimickedXhsShares.cleanedContent;
    mimickedXhsShares.shares.push(...secondPassMimickedXhsShares.shares);

    // [[XHS_SHARE: 序號]]
    const sharedXhsCardKeys = new Set<string>();
    const xhsShareMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_SHARE:\s*(\d+)\]\]/g);
    for (const shareMatch of xhsShareMatches) {
        const idx = parseInt(shareMatch[1]) - 1;
        // 注意 truthy 判空: amsg2 push 帶回的筆記數組是稀疏重建的 (只有 directive 引用到的
        // 序號有值, 空洞是 null, 見 activeMsgRuntime 的 xhsSession 落庫), 越界和空洞同罪.
        const note = idx >= 0 && idx < lastXhsNotesRef.current.length ? lastXhsNotesRef.current[idx] : undefined;
        if (note) {
            sharedXhsCardKeys.add(normalizeXhsCardKey(note.title));
            console.log('📕 [XHS] AI分享筆記卡片:', note.title);
            await persistMessage({
                charId: char.id,
                role: 'assistant',
                type: 'xhs_card',
                content: note.title || '小紅書筆記',
                // 跟正文氣泡帶同一個標記 (mcdInheritMeta): 主動消息重試時靠它認出"這張卡上一趟已經發過了"
                metadata: { xhsNote: note, ...(mcdInheritMeta || {}) }
            });
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } else {
            // 筆記緩衝為空 / 越界 → 卡片發不出來. 雲端回覆靠 saveXhsSessionNotes 持久化恢復,
            // 走到這裡說明恢復也沒命中 (TTL 過期 / 跨 session), 留日誌便於排查, 不再靜默吞掉.
            console.warn('📕 [XHS] XHS_SHARE 序號越界, 跳過卡片', { idx: idx + 1, available: lastXhsNotesRef.current.length });
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_SHARE:\s*\d+\]\]/g, '').trim();

    // 掉格式兜底：把模型模仿歷史記錄寫出的五行純文本恢復成真正的 xhs_card。
    // 優先複用剛才 search/browse 緩存裡的完整 noteId、封面和 xsecToken；緩存丟失時仍給可讀卡片。
    for (const parsed of mimickedXhsShares.shares) {
        const parsedKey = normalizeXhsCardKey(parsed.title);
        if (parsedKey && sharedXhsCardKeys.has(parsedKey)) continue;
        const sameTitle = lastXhsNotesRef.current.filter(note => normalizeXhsCardKey(note.title) === parsedKey);
        const parsedAuthorKey = normalizeXhsCardKey(parsed.author);
        const cachedNote = sameTitle.find(note => normalizeXhsCardKey(note.author) === parsedAuthorKey) || sameTitle[0];
        const parsedNote: XhsNote = {
            noteId: '',
            title: parsed.title || '小紅書筆記',
            desc: parsed.desc,
            likes: parseMimickedXhsCount(parsed.interactionText, '贊'),
            collects: parseMimickedXhsCount(parsed.interactionText, '收藏'),
            commentCount: parseMimickedXhsCount(parsed.interactionText, '評論'),
            shareCount: parseMimickedXhsCount(parsed.interactionText, '分享'),
            author: parsed.author,
            authorId: '',
        };
        const note: XhsNote = cachedNote ? {
            ...parsedNote,
            ...cachedNote,
            title: cachedNote.title || parsedNote.title,
            desc: cachedNote.desc || parsedNote.desc,
            author: cachedNote.author || parsedNote.author,
            likes: cachedNote.likes ?? parsedNote.likes,
            collects: cachedNote.collects ?? parsedNote.collects,
            commentCount: cachedNote.commentCount ?? parsedNote.commentCount,
            shareCount: cachedNote.shareCount ?? parsedNote.shareCount,
        } : parsedNote;
        console.warn('📕 [XHS] 檢測到仿卡片文本，已恢復為 xhs_card:', note.title, cachedNote ? '(命中緩存)' : '(文本兜底)');
        await persistMessage({
            charId: char.id,
            role: 'assistant',
            type: 'xhs_card',
            content: note.title || '小紅書筆記',
            metadata: { xhsNote: note, ...(mcdInheritMeta || {}) },
        });
        if (parsedKey) sharedXhsCardKeys.add(parsedKey);
    }
    if (mimickedXhsShares.shares.length > 0) {
        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
    }
    // [[XHS_POST: 標題 | 內容 | #標籤1 #標籤2]]
    const xhsPostMatch = aiContent.match(/\[\[XHS_POST:\s*(.+?)\]\]/s);
    if (!disabledXhsSideEffects && xhsPostMatch && xhsConf.enabled) {
        const postRaw = xhsPostMatch[1].trim();
        const parts = postRaw.split('|').map(p => p.trim());
        const postTitle = parts[0] || '';
        const postContent = parts[1] || '';
        const postTags = (parts[2] || '').match(/#(\S+)/g)?.map(t => t.replace('#', '')) || [];

        console.log(`📕 [XHS] AI要發小紅書:`, postTitle);
        setXhsStatus(`正在發佈小紅書: ${postTitle}...`);

        try {
            const result = await xhsPublish(xhsConf, char, postTitle, postContent, postTags);
            if (result.success) {
                console.log('📕 [XHS] 發佈成功:', result.noteId);
                const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                await persistMessage({
                    charId: char.id,
                    role: 'system',
                    type: 'text',
                    content: `📕 ${char.name}發了一條小紅書「${postTitle}」\n${postContent.slice(0, 200)}${postContent.length > 200 ? '...' : ''}${tagsStr}`
                });
                addToast(`📕 ${char.name}發了一條小紅書!`, 'success');
            } else {
                console.error('📕 [XHS] 發佈失敗:', result.message);
                addToast(`小紅書發佈失敗: ${result.message}`, 'error');
            }
        } catch (e) {
            console.error('📕 [XHS] 發佈異常:', e);
        }
        aiContent = aiContent.replace(xhsPostMatch[0], '').trim();
        setXhsStatus('');
    } else if (!disabledXhsSideEffects && xhsPostMatch) {
        aiContent = aiContent.replace(xhsPostMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_POST:.*?\]\]/gs, '').trim();

    // [[XHS_COMMENT: noteId | 評論內容]]
    const xhsCommentMatch = aiContent.match(/\[\[XHS_COMMENT:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsCommentMatch && xhsConf.enabled) {
        const commentRaw = xhsCommentMatch[1].trim();
        const sepIdx = commentRaw.indexOf('|');
        if (sepIdx > 0) {
            const noteId = commentRaw.slice(0, sepIdx).trim();
            const commentContent = commentRaw.slice(sepIdx + 1).trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要評論筆記:`, noteId, commentContent.slice(0, 30), xsecToken ? '(有xsecToken)' : '(無xsecToken)');
            setXhsStatus('正在評論...');

            try {
                const result = await xhsComment(xhsConf, noteId, commentContent, xsecToken);
                if (result.success) {
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📕 ${char.name}在小紅書評論了: "${commentContent.slice(0, 100)}${commentContent.length > 100 ? '...' : ''}"`
                    });
                    addToast(`📕 ${char.name}在小紅書留了評論`, 'success');
                } else {
                    addToast(`評論失敗: ${result.message}`, 'error');
                }
            } catch (e) {
                console.error('📕 [XHS] 評論異常:', e);
            }
        }
        aiContent = aiContent.replace(xhsCommentMatch[0], '').trim();
        setXhsStatus('');
    } else if (!disabledXhsSideEffects && xhsCommentMatch) {
        aiContent = aiContent.replace(xhsCommentMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_COMMENT:.*?\]\]/g, '').trim();

    // [[XHS_REPLY: noteId | commentId | 回覆內容]] (first pass; before LIKE/FAV)
    const xhsReplyMatch = aiContent.match(/\[\[XHS_REPLY:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsReplyMatch && xhsConf.enabled) {
        const parts = xhsReplyMatch[1].split('|').map(s => s.trim());
        if (parts.length >= 3) {
            const [noteId, commentId, ...replyParts] = parts;
            const replyContent = replyParts.join('|').trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            const commentUserId = commentUserIdCacheRef.get(commentId);
            const commentAuthorName = commentAuthorNameCacheRef.get(commentId);
            const parentCommentId = commentParentIdCacheRef.get(commentId);
            if (replyContent) {
                console.log(`📕 [XHS] AI要回複評論:`, noteId, commentId, replyContent.slice(0, 30),
                    xsecToken ? '(有xsecToken)' : '(bridge自動獲取)',
                    commentUserId ? `(userId=${commentUserId})` : '(無userId)',
                    commentAuthorName ? `(author=${commentAuthorName})` : '',
                    parentCommentId ? `(parentId=${parentCommentId})` : '(頂級評論)');
                setXhsStatus('正在回覆評論...');
                try {
                    let result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                    const selectorBroken = !result.success && includesAnyScript(result.message ?? '', '未找到评论');
                    if (selectorBroken) {
                        console.warn(`📕 [XHS] 回覆失敗(DOM選擇器不匹配)，跳過重試直接降級:`, result.message);
                    } else {
                        const replyRetries = [3000, 4000, 5000];
                        for (let i = 0; i < replyRetries.length && !result.success; i++) {
                            console.warn(`📕 [XHS] 回覆失敗(${i + 1}/${replyRetries.length})，${replyRetries[i] / 1000}秒後重試:`, result.message);
                            await new Promise(r => setTimeout(r, replyRetries[i]));
                            result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                        }
                    }
                    if (result.success) {
                        addToast(`📕 ${char.name}回覆了一條評論`, 'success');
                    } else {
                        console.warn(`📕 [XHS] 回覆失敗，降級為 @提及 評論:`, result.message);
                        const fallbackContent = commentAuthorName
                            ? `@${commentAuthorName} ${replyContent}`
                            : replyContent;
                        let fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                        if (!fallback.success) {
                            console.warn(`📕 [XHS] 頂級評論也失敗，3秒後重試:`, fallback.message);
                            await new Promise(r => setTimeout(r, 3000));
                            fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                        }
                        if (fallback.success) {
                            addToast(`📕 ${char.name}評論了一條筆記（@提及回覆）`, 'success');
                        } else {
                            addToast(`回覆失敗: ${result.message}`, 'error');
                        }
                    }
                } catch (e) { console.error('📕 [XHS] 回覆異常:', e); }
                setXhsStatus('');
            } else {
                console.warn('📕 [XHS] 回覆缺少 xsecToken 或內容');
            }
        }
        aiContent = aiContent.replace(xhsReplyMatch[0], '').trim();
    } else if (!disabledXhsSideEffects && xhsReplyMatch) {
        aiContent = aiContent.replace(xhsReplyMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_REPLY:.*?\]\]/g, '').trim();

    // [[XHS_LIKE: noteId]]
    const xhsLikeMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_LIKE:\s*(.+?)\]\]/g);
    for (const xhsLikeMatch of xhsLikeMatches) {
        if (xhsConf.enabled) {
            const noteId = xhsLikeMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要點贊筆記:`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自動獲取)');
            try {
                const result = await xhsLike(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}點讚了一條筆記`, 'success');
                } else {
                    console.warn('📕 [XHS] 點贊失敗:', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 點贊異常:', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_LIKE:.*?\]\]/g, '').trim();

    // [[XHS_FAV: noteId]]
    const xhsFavMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_FAV:\s*(.+?)\]\]/g);
    for (const xhsFavMatch of xhsFavMatches) {
        if (xhsConf.enabled) {
            const noteId = xhsFavMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要收藏筆記:`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自動獲取)');
            try {
                const result = await xhsFavorite(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}收藏了一條筆記`, 'success');
                } else {
                    console.warn('📕 [XHS] 收藏失敗:', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 收藏異常:', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_FAV:.*?\]\]/g, '').trim();

    // [[XHS_MY_PROFILE]]
    const xhsProfileMatch = aiContent.match(/\[\[XHS_MY_PROFILE\]\]/);
    if (!skipSecondPassLLM && xhsProfileMatch && xhsConf.enabled) {
        console.log(`📕 [XHS] AI要查看自己的主頁`);
        setXhsStatus('正在查看小紅書主頁...');

        try {
            let xmpr: Awaited<ReturnType<typeof runXhsMyProfile>>;
            try {
                const ownedPosts = await DB.getXhsOwnedPosts(char.id);
                const latestUserMessage = [...fullMessages].reverse().find(message => message?.role === 'user');
                const latestUserText = typeof latestUserMessage?.content === 'string'
                    ? latestUserMessage.content
                    : Array.isArray(latestUserMessage?.content)
                        ? latestUserMessage.content.map((part: any) => part?.text || '').join('\n')
                        : '';
                const selectedPosts = selectOwnedPostsForReference(ownedPosts, latestUserText, 8);
                const localNotes = selectedPosts.map(post => ownedPostToNote(post, char.name) as XhsNote);
                for (const note of localNotes) {
                    if (note.xsecToken) xsecTokenCacheRef.set(note.noteId, note.xsecToken);
                    if (note.title) ctx.xhsCaches.noteTitleCache.set(note.noteId, note.title);
                }
                if (localNotes.length > 0) lastXhsNotesRef.current = localNotes;
                const feedsStr = selectedPosts.length > 0
                    ? selectedPosts.map((post, index) => {
                        const published = new Date(post.publishedAt).toLocaleString();
                        return `${index + 1}. [noteId=${post.noteId}]「${post.title || '無標題'}」· 發佈於 ${published} (${post.likes || 0}贊 ${post.commentCount || 0}評論)\n   ${post.body || '（無正文）'}`;
                    }).join('\n\n')
                    : '（這個角色的主頁還沒有已歸屬的筆記）';
                xmpr = {
                    ok: true,
                    nickname: char.name,
                    userId: '',
                    profileStr: `角色獨立主頁：共 ${ownedPosts.length} 條筆記。真實帳號可能與其他角色共用。`,
                    feedsStr,
                    gotProfile: true,
                    notes: localNotes,
                };
            } catch (localProfileError) {
                console.warn('[XHS] 角色主頁讀取失敗，回退到真實帳號主頁:', localProfileError);
                xmpr = await runXhsMyProfile({}, agenticCtx);
            }

            if (xmpr.ok) {
                const { nickname, userId, profileStr, feedsStr, gotProfile } = xmpr;

                const profileSection = gotProfile
                    ? `\n\n你的主頁信息:\n${profileStr}`
                    : '';

                const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '讓我看看我的小紅書...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系統: 你打開了自己的小紅書]\n\n你的小紅書帳號暱稱: ${nickname || '未知'}${userId ? ` (userId: ${userId})` : ''}${profileSection}\n\n${gotProfile ? '你的筆記' : `搜索「${nickname}」找到的相關筆記`}:\n${feedsStr}\n\n[系統: ${gotProfile ? '以上是按角色歸屬保存的主頁數據，序號已根據用戶剛才的說法按相關性和時間排序。' : '注意，搜索結果可能包含別人的帖子，你需要辨別哪些是你自己發的（看作者名字）。'}現在請你：\n1. 如果用戶說“剛才那個帖子”“之前那篇”或要求查看自己帖子的評論區，選擇最符合時間/標題的候選並輸出 [[XHS_DETAIL: noteId]]；不要只口頭說去看。\n2. 如果多個候選同樣符合、無法判斷是哪條，就自然地向用戶確認，不能猜。\n3. 普通查看主頁時，可以自然地聊聊看到的內容。\n4. 如果想發新筆記，可以用 [[XHS_POST: 標題 | 內容 | #標籤1 #標籤2]]。\n5. 嚴禁再輸出[[XHS_MY_PROFILE]]標記。]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小紅書主頁' });
                updateTokenUsage(data, historyMsgCount, 'xhs-profile');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`📕 ${char.name}看了看自己的小紅書`, 'info');
            } else if (xmpr.reason === 'no_identity') {
                console.warn('📕 [XHS] 無暱稱也無userId，無法查看主頁。請在設置中填寫。');
                // 原代碼在 no_identity 時仍然走 2nd-pass LLM, feedsStr = '（無法獲取主頁...）', 這裡保持一致
                const profileSection = '';
                const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '讓我看看我的小紅書...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系統: 你打開了自己的小紅書]\n\n你的小紅書帳號暱稱: 未知${profileSection}\n\n搜索「」找到的相關筆記:\n（無法獲取主頁：請在設置-小紅書中填寫你的暱稱或用戶ID）\n\n[系統: 注意，搜索結果可能包含別人的帖子，你需要辨別哪些是你自己發的（看作者名字）。現在請你：\n1. 自然地聊聊你看到了什麼，"我看了看我的小紅書..."、"我之前發的那個帖子..."\n2. 如果想發新筆記，可以用 [[XHS_POST: 標題 | 內容 | #標籤1 #標籤2]]\n3. 如果想看某條筆記的詳細內容，可以用 [[XHS_DETAIL: noteId]]\n4. 嚴禁再輸出[[XHS_MY_PROFILE]]標記]` }
                ];
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小紅書主頁' });
                updateTokenUsage(data, historyMsgCount, 'xhs-profile');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`📕 ${char.name}看了看自己的小紅書`, 'info');
            } else if (xmpr.reason === 'unreachable') {
                // 主頁沒打開、降級搜暱稱也沒跑通 = 小紅書那頭連不上, 一條筆記都沒拿到。
                // 靜默刪標記的話, 角色剛說完"我看看我的小紅書"就沒了下文; 更糟的是它可能
                // 順嘴編幾條自己"看到"的筆記, 所以這裡明確交代什麼都沒加載出來。
                console.warn('📕 [XHS] 小紅書連不上，主頁這次沒打開');
                const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '讓我看看我的小紅書...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系統: 你想打開自己的小紅書，但這次連不上，什麼都沒加載出來]\n\n[系統: 現在請你：\n1. 先正常回應用戶剛才說的話（用戶還在等你回覆！）\n2. 自然地提一句"小紅書打不開/刷不出來"就好\n3. 你這次什麼都沒看到，不要描述任何筆記、數據或評論\n4. 嚴禁再輸出[[XHS_MY_PROFILE]]標記]` }
                ];
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小紅書主頁' });
                updateTokenUsage(data, historyMsgCount, 'xhs-profile-unreachable');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
            }
        } catch (e) {
            console.error('📕 [XHS] 查看主頁異常:', e);
            aiContent = aiContent.replace(xhsProfileMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsProfileMatch) {
        aiContent = aiContent.replace(xhsProfileMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim();

    // [[XHS_DETAIL: noteId]]
    const xhsDetailMatch = aiContent.match(/\[\[XHS_DETAIL:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && xhsDetailMatch && xhsConf.enabled) {
        const noteId = xhsDetailMatch[1].trim();
        setXhsStatus('正在查看筆記詳情...');

        try {
            const xdr = await runXhsDetail({ noteId }, agenticCtx);
            // not_enabled 已被外層 if 排除; 剩下的 ok:false 只有 unreachable —— 詳情沒讀到
            // (小紅書服務多半跑在用戶自己電腦上, 人睡了機器關了就連不上)。這種情況下角色
            // 往往已經說了"我看看這條", 只刪標記就沒了下文, 所以複用下面 detailFailed 的
            // 圓場路徑: 讓它說"這條打不開", 而不是裝作什麼都沒發生。
            if (!xdr.ok && xdr.reason !== 'unreachable') {
                // 兜底防禦性 — runXhsDetail 在 not_enabled 時返回 ok:false, 但外層 xhsConf.enabled 已保證不會進入
                aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
                setXhsStatus('');
                aiContent = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim();
                // 繼續後面的代碼 — 不能 return, 因為後面還有別的 tag 處理
            } else {
                const detailStr = xdr.ok ? xdr.detailText : (xdr.message || '（筆記詳情一個字都沒加載出來）');
                const detailFailed = !xdr.ok;
                const commentsUnavailable = xdr.ok ? xdr.commentsUnavailable : false;
                const cleanedForXhs = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim() || '讓我看看這條筆記...';
            const xhsMessages = [
                ...fullMessages,
                { role: 'assistant', content: cleanedForXhs },
                { role: 'user', content: detailFailed
                    ? `[系統: 你嘗試打開一條小紅書筆記（noteId=${noteId}），但加載失敗了]\n\n${detailStr}\n\n[系統: 筆記詳情頁加載失敗了。可能的原因：這條筆記需要先通過搜索或瀏覽才能打開詳情。現在請你：\n1. 自然地告知用戶"這條筆記打不開/加載不出來"\n2. 可以建議搜索相關關鍵詞再試: [[XHS_SEARCH: 關鍵詞]]\n3. 嚴禁再輸出[[XHS_DETAIL:...]]標記]`
                    : commentsUnavailable
                        ? `[系統: 你點開了一條小紅書筆記的詳情頁（noteId=${noteId}）]\n\n${detailStr}\n\n[系統: 正文和互動數量已讀取，但真實評論區本次讀取失敗。你只能談論已經看到的正文和數量；不要聲稱帖子沒有評論，不要編造、模擬或回覆任何評論。嚴禁再輸出[[XHS_DETAIL:...]]標記。]`
                        : `[系統: 你點開了一條小紅書筆記的詳情頁（noteId=${noteId}）]\n\n${detailStr}\n\n[系統: 你已經看完了這條筆記的完整內容和真實評論區。現在請你：\n1. 自然地分享你看到的內容和感受\n2. 如果想評論這條筆記，可以用 [[XHS_COMMENT: ${noteId} | 評論內容]]\n3. 如果想回復某條評論，可以用 [[XHS_REPLY: ${noteId} | commentId | 回覆內容]]（commentId 在上面的評論區數據裡）\n4. 如果想點贊，可以用 [[XHS_LIKE: ${noteId}]]；想收藏可以用 [[XHS_FAV: ${noteId}]]\n5. 嚴禁再輸出[[XHS_DETAIL:...]]標記]` }
            ];

            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', headers,
                body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
            }, 2, 0, { ...apiLogMeta, purpose: '小紅書詳情' });
            updateTokenUsage(data, historyMsgCount, 'xhs-detail');
            aiContent = data.choices?.[0]?.message?.content || '';
            aiContent = normalizeAiContent(aiContent);
            addToast(`📕 ${char.name}${detailFailed ? '嘗試查看一條筆記（加載失敗）' : '看了一條筆記的詳情'}`, 'info');
            }  // end of else (xdr.ok)
        } catch (e) {
            console.error('📕 [XHS] 查看詳情異常:', e);
            aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsDetailMatch) {
        aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim();

    // 5.10.1 Second-round XHS action processing
    // [[XHS_COMMENT: noteId | 評論內容]] (second round)
    const xhsCommentMatch2 = aiContent.match(/\[\[XHS_COMMENT:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsCommentMatch2 && xhsConf.enabled) {
        const commentRaw = xhsCommentMatch2[1].trim();
        const sepIdx = commentRaw.indexOf('|');
        if (sepIdx > 0) {
            const noteId = commentRaw.slice(0, sepIdx).trim();
            const commentContent = commentRaw.slice(sepIdx + 1).trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要評論筆記(detail後):`, noteId, commentContent.slice(0, 30), xsecToken ? '(有xsecToken)' : '(無xsecToken)');
            setXhsStatus('正在評論...');
            try {
                const result = await xhsComment(xhsConf, noteId, commentContent, xsecToken);
                if (result.success) {
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📕 ${char.name}在小紅書評論了: "${commentContent.slice(0, 100)}${commentContent.length > 100 ? '...' : ''}"`
                    });
                    addToast(`📕 ${char.name}在小紅書留了評論`, 'success');
                } else {
                    addToast(`評論失敗: ${result.message}`, 'error');
                }
            } catch (e) {
                console.error('📕 [XHS] 評論異常(detail後):', e);
            }
        }
        setXhsStatus('');
    }
    aiContent = aiContent.replace(/\[\[XHS_COMMENT:.*?\]\]/g, '').trim();

    // [[XHS_REPLY]] (second round)
    const xhsReplyMatch2 = aiContent.match(/\[\[XHS_REPLY:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsReplyMatch2 && xhsConf.enabled) {
        const parts = xhsReplyMatch2[1].split('|').map(s => s.trim());
        if (parts.length >= 3) {
            const [noteId, commentId, ...replyParts] = parts;
            const replyContent = replyParts.join('|').trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            const commentUserId = commentUserIdCacheRef.get(commentId);
            const commentAuthorName = commentAuthorNameCacheRef.get(commentId);
            const parentCommentId = commentParentIdCacheRef.get(commentId);
            if (replyContent) {
                console.log(`📕 [XHS] AI要回複評論(detail後):`, noteId, commentId, replyContent.slice(0, 30),
                    commentUserId ? `(userId=${commentUserId})` : '(無userId)',
                    commentAuthorName ? `(author=${commentAuthorName})` : '',
                    parentCommentId ? `(parentId=${parentCommentId})` : '(頂級評論)',
                    xsecToken ? '(有xsecToken)' : '(bridge自動獲取)');
                setXhsStatus('正在回覆評論...');
                try {
                    let result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                    const selectorBroken = !result.success && includesAnyScript(result.message ?? '', '未找到评论');
                    if (selectorBroken) {
                        console.warn(`📕 [XHS] 回覆失敗(detail後)(DOM選擇器不匹配)，跳過重試直接降級:`, result.message);
                    } else {
                        const replyRetries = [3000, 4000, 5000];
                        for (let i = 0; i < replyRetries.length && !result.success; i++) {
                            console.warn(`📕 [XHS] 回覆失敗(detail後)(${i + 1}/${replyRetries.length})，${replyRetries[i] / 1000}秒後重試:`, result.message);
                            await new Promise(r => setTimeout(r, replyRetries[i]));
                            result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                        }
                    }
                    if (result.success) {
                        addToast(`📕 ${char.name}回覆了一條評論`, 'success');
                    } else {
                        console.warn(`📕 [XHS] 回覆失敗(detail後)，降級為 @提及 評論:`, result.message);
                        const fallbackContent = commentAuthorName
                            ? `@${commentAuthorName} ${replyContent}`
                            : replyContent;
                        let fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken || '');
                        if (!fallback.success) {
                            console.warn(`📕 [XHS] 頂級評論也失敗(detail後)，3秒後重試:`, fallback.message);
                            await new Promise(r => setTimeout(r, 3000));
                            fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                        }
                        if (fallback.success) {
                            addToast(`📕 ${char.name}評論了一條筆記（@提及回覆）`, 'success');
                        } else {
                            addToast(`回覆失敗: ${result.message}`, 'error');
                        }
                    }
                } catch (e) { console.error('📕 [XHS] 回覆異常(detail後):', e); }
                setXhsStatus('');
            } else {
                console.warn('📕 [XHS] 回覆缺少 xsecToken 或內容(detail後)');
            }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_REPLY:.*?\]\]/g, '').trim();

    // [[XHS_LIKE]] (second round)
    const xhsLikeMatches2: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_LIKE:\s*(.+?)\]\]/g);
    for (const xhsLikeMatch of xhsLikeMatches2) {
        if (xhsConf.enabled) {
            const noteId = xhsLikeMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要點贊筆記(detail後):`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自動獲取)');
            try {
                const result = await xhsLike(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}點讚了一條筆記`, 'success');
                } else {
                    console.warn('📕 [XHS] 點贊失敗(detail後):', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 點贊異常(detail後):', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_LIKE:.*?\]\]/g, '').trim();

    // [[XHS_FAV]] (second round)
    const xhsFavMatches2: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_FAV:\s*(.+?)\]\]/g);
    for (const xhsFavMatch of xhsFavMatches2) {
        if (xhsConf.enabled) {
            const noteId = xhsFavMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要收藏筆記(detail後):`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自動獲取)');
            try {
                const result = await xhsFavorite(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}收藏了一條筆記`, 'success');
                } else {
                    console.warn('📕 [XHS] 收藏失敗(detail後):', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 收藏異常(detail後):', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_FAV:.*?\]\]/g, '').trim();

    // [[XHS_POST]] (second round - after MY_PROFILE)
    const xhsPostMatch2 = aiContent.match(/\[\[XHS_POST:\s*(.+?)\]\]/s);
    if (!disabledXhsSideEffects && xhsPostMatch2 && xhsConf.enabled) {
        const postRaw = xhsPostMatch2[1].trim();
        const parts = postRaw.split('|').map(p => p.trim());
        const postTitle = parts[0] || '';
        const postContent = parts[1] || '';
        const postTags = (parts[2] || '').match(/#(\S+)/g)?.map(t => t.replace('#', '')) || [];
        console.log(`📕 [XHS] AI要發小紅書(profile後):`, postTitle);
        setXhsStatus(`正在發佈小紅書: ${postTitle}...`);
        try {
            const result = await xhsPublish(xhsConf, char, postTitle, postContent, postTags);
            if (result.success) {
                console.log('📕 [XHS] 發佈成功(profile後):', result.noteId);
                const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                await persistMessage({
                    charId: char.id,
                    role: 'system',
                    type: 'text',
                    content: `📕 ${char.name}發了一條小紅書「${postTitle}」\n${postContent.slice(0, 200)}${postContent.length > 200 ? '...' : ''}${tagsStr}`
                });
                addToast(`📕 ${char.name}發了一條小紅書!`, 'success');
            } else {
                console.error('📕 [XHS] 發佈失敗(profile後):', result.message);
                addToast(`小紅書發佈失敗: ${result.message}`, 'error');
            }
        } catch (e) {
            console.error('📕 [XHS] 發佈異常(profile後):', e);
        }
        setXhsStatus('');
    }
    aiContent = aiContent.replace(/\[\[XHS_POST:.*?\]\]/gs, '').trim();

    // 二輪 LLM 可能新產生日程標籤；在統一動作解析前再消費一次。首次那條已經從 aiContent
    // 剝掉且寫入冪等（同活動不重複），因此普通單輪回復不會重放副作用。
    //
    // 這一段是剛剛生成的，所以按「現在」判時段，不跟著首輪那句的 spokenAt 走：兩者之間
    // 隔著 RECALL / SEARCH / XHS 幾趟往返，隔夜補收的 spokenAt 會把新寫的改動整批作廢。
    aiContent = await consumeScheduleChanges(aiContent, new Date());
    aiContent = await consumeRelationshipChange(aiContent);
    aiContent = await consumeNoReply(aiContent);
    aiContent = consumeDateInvite(aiContent);
    aiContent = consumeCharCall(aiContent);

    // ─── Step 3: ChatParser.parseAndExecuteActions ───
    // mcdInheritMeta 一起傳下去：戳一戳 / 轉帳卡 / 音樂卡 / 新聞卡 / 日程系統提示 / 生活記錄卡
    // 跟正文氣泡帶同一個標記。主動消息處理失敗重來時，靠這個標記才認得出「上一趟已經做過了」，
    // 認不出來就會把整套副作用再跑一遍（同一筆轉帳落兩張卡）。
    //
    // 凍結的那首歌只能順著 directive 顯式遞下去：上面拼回的 `[[MUSIC_ACTION:…]]` 標籤裡
    // 只有歌單名，帶不動歌名（見 chatParser 的 FrozenMusicSong）。
    const frozenMusicSong = directives?.find(
        (d): d is Extract<PostProcessDirective, { type: 'music_action' }> =>
            d.type === 'music_action' && !!d.song,
    )?.song;
    aiContent = await ChatParser.parseAndExecuteActions(aiContent, char.id, char.name, addToast, musicHooks, resolveCharTimeZone(char), messageTimestamp, mcdInheritMeta, frozenMusicSong, imageGenConfig, onUserTransferReturned, onUserTransferAccepted, onCharTransferSend, onCharDaifuAccept, onCharGiftSend);

    // ─── Step 4: thinking chain 抽取 (本輪末尾展示用) ───
    // 跑過二輪 (data !== initialData) → 取二輪 data 的 reasoning; 沒跑二輪 → 取一輪 (round1ThinkingChain,
    // 已含 push 路徑 reasoning)。一輪正文 A 的思考鏈在 Step 2 開頭展示時已單獨帶上。
    let pendingThinkingChain: string | null = data !== initialData ? extractThinkingChain(data) : round1ThinkingChain;
    const mergeAssistantMeta = (base: any): any => {
        if (!pendingThinkingChain) return base;
        const merged = { ...(base || {}), thinkingChain: pendingThinkingChain };
        pendingThinkingChain = null;
        return merged;
    };

    // ─── Step 5: HTML 卡片 ───
    if ((char as any).htmlModeEnabled && /\[html\]/i.test(aiContent)) {
        const { blocks, cleanedContent } = extractHtmlBlocks(aiContent);
        for (const blk of blocks) {
            try {
                await persistMessage({
                    charId: char.id,
                    role: 'assistant',
                    type: 'html_card',
                    content: blk.textPreview ? `[HTML卡片] ${blk.textPreview}` : '[HTML卡片]',
                    metadata: mergeAssistantMeta({
                        htmlSource: blk.html,
                        htmlTextPreview: blk.textPreview,
                        ...(mcdInheritMeta || {}),
                    }),
                } as any);
                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                console.error('[HTML] 落庫 html_card 失敗', e);
            }
        }
        aiContent = cleanedContent;
    } else if (/\[html\]/i.test(aiContent)) {
        // HTML 卡片開關關著（打包時開著、送達前用戶關掉，或角色本來就沒這個能力卻硬輸出）。
        // 這一段源碼 sanitize 和 hasDisplayContent 都不剝，不處理就整塊 <div ...> 原樣漏進氣泡。
        // 降級成佔位文本，跟鎖屏橫幅那邊（utils/sanitize.ts 的 [HTML 卡片]）看到的一致。
        console.warn('[HTML] HTML 卡片沒開，源碼降級成佔位文本', { charId: char.id });
        aiContent = aiContent.replace(/\[html\][\s\S]*?\[\/html\]/gi, '[HTML 卡片]').trim();
    }

    // ─── Step 6: 展示本輪回復 (二輪結果 B / 無二輪時的單輪回復) ───
    // - 跑過二輪 (data !== initialData): aiContent 現在是 B; 一輪正文 A 已在 Step 2 開頭先行展示, 這裡只展示 B。
    // - 有重生指令但沒真正發起二輪 (data 不變: 未配置/無結果/無日誌/已激活/二輪異常 等): A 已展示, 跳過避免重複。
    // - 沒有重生 (普通回覆 / 雲端回覆): leadInRendered 必為 false, 正常展示本輪唯一回復。
    if (leadInRendered && data === initialData) {
        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
    } else {
        const sanitizedBody = ChatParser.sanitize(aiContent, { keepCitations: true })
            .replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '')
            .trim();
        if (sanitizedBody) {
            await renderAndPersist(aiContent, pendingThinkingChain);
        } else if (!leadInRendered && (data !== initialData || recallMatch || searchMatch || readDiaryMatch || fsReadDiaryMatch)) {
            // 跑過二輪卻吐空, 且本輪還沒展示過任何內容 → 至少補一句, 避免整輪靜默。
            await renderAndPersist('嗯...', pendingThinkingChain);
        } else {
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        }
    }

    // 來電卡排在這一輪所有話的後面。剛生成、用戶又正開著 App → 響（全域來電畫面接手）；
    // 補收的舊回覆、背景裡落地的 → 直接記未接
    if (pendingCharCall) {
        const now = Date.now();
        markCharCallAttempt(char.id, now);
        const ring = shouldRingNow({
            spokenAt: utteranceAt.getTime(), now,
            visible: typeof document === 'undefined' || document.visibilityState === 'visible',
            busy: false,
        });
        const call: CharCallMeta = { ...(pendingCharCall as { mode: CharCallMode; reason: string }), status: ring ? 'ringing' : 'missed', at: now };
        const messageId = await persistMessage({
            charId: char.id, role: 'assistant', type: 'char_call',
            content: describeCharCall(call),
            metadata: { ...(mcdInheritMeta || {}), charCall: call },
        } as Parameters<typeof DB.saveMessage>[0]);
        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        if (ring && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent<IncomingCharCallDetail>(INCOMING_CHAR_CALL_EVENT, {
                detail: { charId: char.id, messageId, mode: call.mode, reason: call.reason },
            }));
        }
    }

    // 見面邀請卡排在這一輪所有話的後面
    if (pendingDateInvite) {
        const invite: DateInviteMeta = { ...(pendingDateInvite as { place: string; plan: string }), status: 'pending' };
        await persistMessage({
            charId: char.id, role: 'assistant', type: 'date_invite',
            content: describeDateInvite(invite),
            metadata: { ...(mcdInheritMeta || {}), dateInvite: invite },
        } as Parameters<typeof DB.saveMessage>[0]);
        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
    }
}
