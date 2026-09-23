// 群聊動作派發 —— 從 GroupChat.tsx triggerDirector 抽出的執行層（PRIVATE 側信道、
// 表情包、氣泡分段、打字延遲），導演模式與輪詢模式共用。
import { DB } from '../db';
import { CharacterProfile, EmojiCategory, Message, Toast } from '../../types';
import { DirectorAction } from './parse';
import {
    GroupPacketMeta,
    PacketReceiptMeta,
    PacketCommand,
    ClaimResult,
    claimPacket,
    effectivePacketStatus,
    extractPacketCommands,
    makePacketMeta,
} from './redpacket';
import { normalizeAssistantEmojiFormatting } from '../assistantActionFormat';
import { extractHtmlBlocks } from '../htmlPrompt';
import { equalsAnyScript } from '../scriptKey';

interface EmojiItem { name: string; url: string; categoryId?: string }

export interface DispatchContext {
    groupId: string;
    /** 群成員 id 列表——charId 不在其中的動作直接丟棄 */
    memberIds: string[];
    characters: CharacterProfile[];
    emojis: EmojiItem[];
    categories: EmojiCategory[];
    /** 每條氣泡落庫後刷新 UI（GroupChat 的 refreshMessages） */
    refresh: () => Promise<unknown>;
    addToast: (message: string, type?: Toast['type']) => void;
    /** 中途取消：每次延遲/落庫前檢查，aborted 後提前返回 */
    signal?: AbortSignal;
    /** [[QUOTE: 原話片段]] 解析：按片段找被引用消息，找不到返回 undefined（標記靜默剝除） */
    resolveQuote?: (snippet: string) => { id: number; content: string; name: string } | undefined;
    /** 用戶顯示名——紅包目標解析（direct:用戶名）與回執命名用 */
    userName: string;
    /** 群 HTML 模塊模式開啟時解析 [html] 塊為 html_card 消息 */
    htmlMode?: boolean;
    /**
     * [[ACTION:LEAVE_GROUP]] 退群命令的執行回調——只有調用方（GroupChat.tsx）在群開了
     * allowMemberLeave 時才會傳入；不傳時等於沒被教過這個語法，dispatch 只負責把標記從
     * 正文裡剝掉，不會發生任何退群副作用（雙重保險，不靠 AI 老實）。
     */
    onMemberLeave?: (charId: string, charName: string) => Promise<void>;
}

/**
 * 逐條執行成員動作：解析 [[PRIVATE:]] 進私聊頻道、[[SEND_EMOJI:]] 發表情、
 * 剩餘文本按換行分氣泡帶打字延遲落庫。邏輯逐字搬自 triggerDirector，
 * 僅把 `setMessages(await DB.getGroupMessages(...))` 換成 ctx.refresh()、加 signal 檢查。
 */
export async function dispatchMemberActions(actions: DirectorAction[], ctx: DispatchContext): Promise<void> {
    const { groupId, memberIds, characters, emojis, categories, refresh, addToast, signal, resolveQuote } = ctx;

    for (const action of actions) {
        if (signal?.aborted) return;
        const targetId = memberIds.find(id => id === action.charId);
        if (!targetId) continue;
        const charName = characters.find(c => c.id === targetId)?.name || '成員';

        // -0.1 退群命令：[[ACTION:LEAVE_GROUP]]。剝標記這一步始終執行（哪怕 onMemberLeave
        // 沒傳，AI 也不該看到裸標記留在正文裡）；真正的移除副作用只在 ctx.onMemberLeave 存在
        // 時才觸發——這是唯一的開關判斷點，prompts.ts 那邊只是不教這個語法，不是安全邊界。
        let publicContent = action.content;
        let wantsToLeave = false;
        const leaveMatch = publicContent.match(/\[\[\s*ACTION\s*[:：]\s*LEAVE_GROUP\s*\]\]/i);
        if (leaveMatch) {
            wantsToLeave = true;
            publicContent = publicContent.replace(leaveMatch[0], '').trim();
        }
        const fireLeaveIfWanted = async () => {
            if (wantsToLeave && ctx.onMemberLeave) {
                await ctx.onMemberLeave(targetId, charName);
                wantsToLeave = false; // 防止同一條 action 的多個 continue 出口重複觸發
            }
        };

        // 0. Check for Private Message Command (Regex updated for robustness)
        const privateMatches: RegExpExecArray[] = [];
        // Handle multiple private messages in one block or mixed content
        const privateRegex = /\[\[PRIVATE\s*[:：]\s*([\s\S]*?)\]\]/g;
        let match;
        while ((match = privateRegex.exec(publicContent)) !== null) {
            privateMatches.push(match);
        }

        if (privateMatches.length > 0) {
            for (const m of privateMatches) {
                const privateContent = m[1].trim();
                if (privateContent) {
                    // Save to private chat (no groupId)
                    await DB.saveMessage({
                        charId: targetId,
                        role: 'assistant',
                        type: 'text',
                        content: privateContent
                    });
                    addToast(`${charName} 悄悄對你說: ${privateContent.substring(0, 15)}...`, 'info');
                }
                // Strip the private command from the public content
                publicContent = publicContent.replace(m[0], '');
            }
            publicContent = publicContent.trim();

            // If content is empty after stripping (pure private message), skip public rendering
            if (!publicContent) { await fireLeaveIfWanted(); continue; }
        }

        // 0.5 [[QUOTE: 原話片段]]：AI 想針對某條具體發言回覆。兩層容錯精神——
        // 匹配不到目標就靜默剝除標記，絕不因引用失敗丟正文
        let quoteReplyTo: { id: number; content: string; name: string } | undefined;
        const quoteMatch = publicContent.match(/\[\[\s*QUOTE\s*[:：]\s*([\s\S]*?)\]\]/i);
        if (quoteMatch) {
            publicContent = publicContent.replace(quoteMatch[0], '').trim();
            quoteReplyTo = resolveQuote?.(quoteMatch[1].trim());
        }

        // 0.7 紅包命令：[[GRAB_PACKET]] / [[RETURN_PACKET]] / [[SEND_PACKET: …]]。
        // 找不到適用包 / 目標名解析失敗 → 靜默剝標記保正文
        const packetExtract = extractPacketCommands(publicContent);
        publicContent = packetExtract.text;
        for (const cmd of packetExtract.commands) {
            if (signal?.aborted) return;
            await executePacketCommand(cmd, targetId, charName, ctx);
        }

        if (!publicContent) { await fireLeaveIfWanted(); continue; }

        publicContent = normalizeAssistantEmojiFormatting(publicContent);

        // 1. Check for Emoji Commands (handle multiple emojis)
        // Filter emojis by character visibility to prevent using hidden emoji packs
        const charVisibleEmojis = (() => {
            const visibleCats = categories.filter(c => {
                if (!c.allowedCharacterIds || c.allowedCharacterIds.length === 0) return true;
                return c.allowedCharacterIds.includes(targetId);
            });
            const hiddenCatIds = new Set(categories.filter(c => !visibleCats.some(vc => vc.id === c.id)).map(c => c.id));
            if (hiddenCatIds.size === 0) return emojis;
            return emojis.filter(e => !e.categoryId || !hiddenCatIds.has(e.categoryId));
        })();
        const emojiRegex = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
        let emojiMatch;
        while ((emojiMatch = emojiRegex.exec(publicContent)) !== null) {
            if (signal?.aborted) return;
            const emojiName = emojiMatch[1].trim();
            const foundEmoji = charVisibleEmojis.find(e => e.name === emojiName);
            if (foundEmoji) {
                await DB.saveMessage({
                    charId: targetId,
                    groupId,
                    role: 'assistant',
                    type: 'emoji',
                    content: foundEmoji.url
                });
                await refresh();
                await new Promise(r => setTimeout(r, 800)); // Delay after emoji
            }
        }

        // 1.5 HTML 卡片（群 HTML 模式開啟時）：[html]...[/html] 塊抽成 html_card 消息，
        // 剩餘文本繼續走分氣泡（字段對齊私聊 applyAssistantPostProcessing 的落庫格式）
        let contentForText = publicContent;
        if (ctx.htmlMode && /\[html\]/i.test(contentForText)) {
            const { blocks, cleanedContent } = extractHtmlBlocks(contentForText);
            contentForText = cleanedContent;
            for (const block of blocks) {
                if (signal?.aborted) return;
                await DB.saveMessage({
                    charId: targetId,
                    groupId,
                    role: 'assistant',
                    type: 'html_card',
                    content: `[HTML卡片] ${block.textPreview}`,
                    metadata: { htmlSource: block.html, htmlTextPreview: block.textPreview },
                });
                await refresh();
                await new Promise(r => setTimeout(r, 300));
            }
        }

        // 2. Text Splitting (Standard Chat Logic)
        // Remove the emoji tag if it was processed, or just clean up
        const textContent = contentForText.replace(/\[\[SEND_EMOJI:.*?\]\]/g, '').trim();

        if (textContent) {
            // 只認顯式換行；行內空格屬於正文，不能把混合語言的一句話拆成多條氣泡。
            const chunks = textContent.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
                .map(c => c.trim())
                .filter(c => c.length > 0);

            for (const chunk of chunks) {
                if (signal?.aborted) return;
                // Typing delay
                const delay = Math.max(500, chunk.length * 50 + Math.random() * 200);
                await new Promise(r => setTimeout(r, delay));
                if (signal?.aborted) return;

                await DB.saveMessage({
                    charId: targetId,
                    groupId,
                    role: 'assistant',
                    type: 'text',
                    content: chunk,
                    // 引用只掛第一條文字氣泡
                    ...(quoteReplyTo ? { replyTo: quoteReplyTo } : {}),
                });
                quoteReplyTo = undefined;
                await refresh();
            }
        }

        // 退群副作用放最後——告別的話（如果有）先落成氣泡，退群公告消息再跟上，順序才讀得通。
        await fireLeaveIfWanted();
    }
}

/** 紅包目標名 → claimantId：精確成員名 → 模糊 → 用戶；失敗 undefined（調用方丟命令保正文） */
function resolvePacketTarget(name: string, ctx: DispatchContext): string | undefined {
    const n = name.trim();
    if (!n) return undefined;
    if (n === ctx.userName || equalsAnyScript(n, '用戶')) return 'user';
    const members = ctx.characters.filter(c => ctx.memberIds.includes(c.id));
    const exact = members.find(c => c.name === n);
    if (exact) return exact.id;
    const fuzzy = members.find(c => c.name.includes(n) || n.includes(c.name));
    if (fuzzy) return fuzzy.id;
    if (ctx.userName && (ctx.userName.includes(n) || n.includes(ctx.userName))) return 'user';
    return undefined;
}

/**
 * 執行角色的紅包命令。
 * - send：發新紅包（direct 目標解析失敗則丟棄命令）
 * - grab/return：從新到舊找適用包（發給自己的 direct 優先，其次可搶的 lucky），
 *   通過 updateMessageMetadata 事務內重跑 claimPacket 防併發雙寫，
 *   成功後落回執消息。任何失敗都靜默返回（正文已在調用方保住）。
 */
async function executePacketCommand(
    cmd: PacketCommand,
    actorId: string,
    actorName: string,
    ctx: DispatchContext,
): Promise<void> {
    const { groupId, characters, userName, refresh } = ctx;
    const nameOf = (id: string) => (id === 'user' ? userName : characters.find(c => c.id === id)?.name || '成員');

    if (cmd.kind === 'send') {
        if (!cmd.send) return;
        let packetTargetId: string | undefined;
        if (cmd.send.packetType === 'direct') {
            packetTargetId = resolvePacketTarget(cmd.send.targetName || '', ctx);
            if (!packetTargetId) return; // 名字解析不出來，不落半成品紅包
        }
        const meta = makePacketMeta({
            packetType: cmd.send.packetType,
            totalAmount: cmd.send.totalAmount,
            shares: cmd.send.shares,
            targetId: packetTargetId,
            note: cmd.send.note,
            now: Date.now(),
        });
        await DB.saveMessage({ charId: actorId, groupId, role: 'assistant', type: 'transfer', content: '[紅包]', metadata: meta });
        await refresh();
        return;
    }

    // grab / return
    const msgs = await DB.getGroupMessages(groupId);
    const now = Date.now();
    const packets = msgs.filter(m => m.type === 'transfer' && (m.metadata as GroupPacketMeta | undefined)?.packet);
    const newestFirst = [...packets].reverse();
    // 發給自己的 direct 優先；其次（僅 grab）還沒搶過的 lucky
    const directTargeted = newestFirst.find(m => {
        const meta = m.metadata as GroupPacketMeta;
        return meta.packetType === 'direct' && meta.targetId === actorId && effectivePacketStatus(meta, now) === 'pending';
    });
    const luckyOpen = cmd.kind === 'grab'
        ? newestFirst.find(m => {
            const meta = m.metadata as GroupPacketMeta;
            return meta.packetType === 'lucky'
                && effectivePacketStatus(meta, now) === 'pending'
                && !meta.claims.some(c => c.claimantId === actorId);
        })
        : undefined;
    const targetMsg: Message | undefined = directTargeted || luckyOpen;
    if (!targetMsg) return;

    const action = cmd.kind === 'return' ? 'return' : 'claim';
    // `as ClaimResult` 保住聯合類型：賦值發生在回調裡，TS 流分析追不到，
    // 不 cast 會把 outcome 窄化成 {ok:false} 分支導致下方 .action 報 never
    let outcome = { ok: false, reason: 'not_pending' } as ClaimResult;
    await DB.updateMessageMetadata(targetMsg.id, (prev) => {
        // updater 內重跑狀態機：以庫內最新 claims 判重，防止與用戶點「搶」併發雙寫
        outcome = claimPacket(prev as GroupPacketMeta, actorId, now, action);
        return outcome.ok ? outcome.meta : prev;
    }).catch(() => { /* 消息被刪等——靜默 */ });
    if (!outcome.ok) return;

    const senderName = targetMsg.role === 'user' ? userName : nameOf(targetMsg.charId);
    const receipt: PacketReceiptMeta = {
        packetReceipt: outcome.action,
        ref: targetMsg.id,
        amount: outcome.action === 'claimed' ? outcome.amount : undefined,
        claimantName: actorName,
        senderName,
    };
    await DB.saveMessage({
        charId: actorId,
        groupId,
        role: 'assistant',
        type: 'transfer',
        content: outcome.action === 'claimed' ? '[領取紅包]' : '[退回紅包]',
        metadata: receipt,
    });
    await refresh();
}
