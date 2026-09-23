import { loadCharacterContextMessages } from './chatContextRange';

/**
 * XHS Free Roam Engine — 角色自主小紅書活動
 *
 * 流程:
 * 1. 構建角色上下文（身份、最近聊天摘要、上次活動記錄）
 * 2. 調用 LLM 讓角色決策（我想做什麼）
 * 3. 根據決策調用 XHS Client (xiaohongshu-skills) 執行
 * 4. 把結果交給 LLM 讓角色反應 / 選擇保留的話題
 * 5. 返回完整的活動記錄
 */

import { CharacterProfile, UserProfile, XhsActivityRecord, XhsFreeRoamSession, XhsOwnedPost, APIConfig, RealtimeConfig } from '../types';
import { ContextBuilder } from './context';
import { nowInTimeZone, resolveCharTimeZone } from './timezone';
import {
    XhsMcpClient,
    McpToolResult,
    extractNotesFromMcpData,
    normalizeNote,
    normalizeXhsLiteDetail,
} from './xhsMcpClient';
import { DB } from './db';
import {
    collectOwnedPostsFromActivities,
    extractPublishedNoteId,
    mergeOwnedNotes,
    ownedPostToNote,
} from './xhsFreeRoamOwnership';

// ==================== Types ====================

export interface FreeRoamCallbacks {
    onStatus: (status: string) => void;
    onThinking: (text: string) => void;
    onActivity: (activity: XhsActivityRecord) => void;
    onComplete: (session: XhsFreeRoamSession) => void;
    onError: (error: string) => void;
}

interface LlmDecision {
    action: 'post' | 'browse' | 'search' | 'idle' | 'check_profile';
    thinking: string;
    // For post
    title?: string;
    content?: string;
    tags?: string[];
    // For search
    keyword?: string;
}

interface LlmReaction {
    thinking: string;
    savedTopics?: { title: string; desc: string; noteId?: string }[];
    wantToViewDetail?: { noteId: string; title: string };
}

interface LlmDetailReaction {
    thinking: string;
    wantToReply?: { commentId: string; authorName: string; reply: string };
    wantToComment?: { comment: string };
}

// ==================== LLM Helpers ====================

const callLlm = async (
    apiConfig: APIConfig,
    systemPrompt: string,
    userMessage: string,
): Promise<string> => {
    const baseUrl = apiConfig.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            temperature: 0.85,
            stream: false,
        }),
        // API 調用記錄標籤：自由活動是後台任務，不標會被兜底成「用戶當時打開的 App」
        __sullyMeta: { appName: '自由活動', purpose: '自由活動生成' },
    } as RequestInit);

    if (!resp.ok) throw new Error(`LLM API ${resp.status}: ${await resp.text().catch(() => '')}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
};

const parseJson = <T>(text: string): T | null => {
    // Try to extract JSON from markdown code blocks or raw text
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return null;
    try {
        return JSON.parse(jsonMatch[1]);
    } catch {
        return null;
    }
};

// ==================== Prompt Builders ====================

const buildFreeRoamSystemPrompt = (
    char: CharacterProfile,
    user: UserProfile,
    recentChatSummary: string,
    pastActivities: XhsActivityRecord[],
): string => {
    // 加載完整上下文（含詳細記憶和心情標籤），讓角色在自由活動時保持情感連貫
    const coreContext = ContextBuilder.buildCoreContext(char, user, true);
    // 自由活動是角色自己在刷手機，「現在幾點」得跟 ta 那邊的鐘——
    // coreContext 頂部注入的當前時間已按角色時區折算，這裡再用設備時間就會自相矛盾。
    const charTz = resolveCharTimeZone(char);
    const now = nowInTimeZone(charTz);
    const timeStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    const hour = now.getHours();
    const timeOfDay = hour < 6 ? '深夜' : hour < 9 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';

    let pastStr = '暫無活動記錄。';
    if (pastActivities.length > 0) {
        pastStr = pastActivities.slice(-5).map(a => {
            // 歷史活動也報角色當地的鐘點，跟上面的「現在」同一把尺子
            const d = nowInTimeZone(charTz, new Date(a.timestamp));
            const ts = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2,'0')}`;
            const actionLabel = { post: '發帖', browse: '刷首頁', search: '搜索', comment: '評論', save_topic: '收藏話題', idle: '休息' }[a.actionType];
            return `[${ts}] ${actionLabel}: ${a.content.title || a.content.keyword || a.content.body || '無'} (${a.result})`;
        }).join('\n');
    }

    return `${coreContext}

### 🕐 當前狀態
- 現在是: ${timeStr} (${timeOfDay})
- 這是你的"自由活動時間"——你不在和用戶聊天，而是在自主使用小紅書。
- 像一個真實的人使用社交媒體一樣行動。你的行為應該符合你的性格。

### 💬 最近與用戶的對話摘要
${recentChatSummary || '最近沒有對話記錄。'}

### 📕 你之前的小紅書活動
${pastStr}

### 📋 重要規則
- 你是一個有自己想法和審美的人。根據你的性格、興趣和**最近與用戶的對話內容**來決定做什麼。
- 重要：你的想法和行動應該反映你**當下**的心情和最近的經歷，不要沉浸在遙遠的回憶裡。
- 你可以：
  - **發帖**（分享生活/感想/見聞）
  - **搜索**（感興趣的話題）
  - **刷首頁**（看看有什麼有趣的）
  - **查看自己的主頁**（看看自己發過的帖子有多少讚了、有沒有新評論）
  - **什麼都不做**（也完全OK）
- 刷到或搜索到帖子後，你還可以：
  - 查看感興趣帖子的**詳細內容和評論區**
  - 保存有趣的話題
  - **只回復自己帖子評論區的人**
- **⚠️ 評論限制（非常重要）**: 不要在陌生人的帖子下面評論或回覆！你只能在**自己發的帖子**的評論區裡回覆別人。在別人帖子下留言會很奇怪，而且會讓真實用戶困惑。瀏覽別人的帖子時，只看不評論。
- **搜索自己的帖子**: 你可以用自己的名字作為關鍵詞搜索，看看自己發過的帖子現在怎麼樣了。
- 不要每次都發帖，真實的人有時候只是刷刷看看。
- 發的帖子要像你自己會發的東西——符合人設，不要寫得太正式或像AI。
- 你可以選擇保存一些有趣的帖子內容作為話題，下次和用戶聊天時可以提起。`;
};

const buildDecisionPrompt = (): string => {
    return `現在是你的自由活動時間。你想在小紅書上做什麼？

請用以下JSON格式回答（只返回JSON，不要其他內容）:
\`\`\`json
{
    "action": "post" | "browse" | "search" | "check_profile" | "idle",
    "thinking": "你的內心想法（用第一人稱，符合你的性格）",
    "title": "帖子標題（僅 action=post 時）",
    "content": "帖子正文（僅 action=post 時）",
    "tags": ["標籤1", "標籤2"],
    "keyword": "搜索關鍵詞（僅 action=search 時）"
}
\`\`\`

示例:
- 想發帖: {"action":"post","thinking":"今天天氣好好，想分享一下我的心情","title":"陽光真好","content":"窗外的光打在桌上，覺得活著真好。","tags":["日常","心情"]}
- 想搜索: {"action":"search","thinking":"昨天和主人聊到了咖啡，我也想看看","keyword":"手衝咖啡推薦"}
- 想搜索自己的帖子: {"action":"search","thinking":"想看看我之前發的帖子怎麼樣了","keyword":"你自己的名字或帖子關鍵詞"}
- 想刷首頁: {"action":"browse","thinking":"沒什麼特別想做的，刷刷看有什麼好玩的"}
- 想看自己主頁: {"action":"check_profile","thinking":"好久沒看我的小紅書了，不知道之前發的帖子有多少讚了"}
- 不想動: {"action":"idle","thinking":"有點累了，不想刷手機"}`;
};

const buildReactionPrompt = (notes: any[]): string => {
    const notesList = notes.slice(0, 8).map((n: any, i: number) => {
        const noteId = n.noteId || n.note_id || n.id || '';
        return `${i+1}. [noteId=${noteId}]「${n.title || '無標題'}」by ${n.author || n.nickname || '匿名'} — ${(n.desc || n.content || '').slice(0, 150)} (❤️${n.likes || 0})`;
    }).join('\n');

    return `你剛才刷了小紅書，看到了這些帖子:

${notesList}

你怎麼看這些帖子？有沒有你感興趣的？想留幾個作為下次聊天話題嗎？想看某個帖子的完整內容和評論區嗎？

⚠️ 注意：這些是別人的帖子，不要在別人帖子下評論（會打擾真實用戶）。只看、只保存話題就好。如果想查看完整內容可以用 wantToViewDetail。

用JSON回答:
\`\`\`json
{
    "thinking": "你看完之後的想法（第一人稱，詳細寫，包括你對看到的內容的感受和評價）",
    "savedTopics": [{"title": "帖子標題", "desc": "你記住的要點", "noteId": "如果有的話"}],
    "wantToViewDetail": {"noteId": "xxx", "title": "帖子標題"}
}
\`\`\`

如果沒什麼感興趣的，savedTopics 可以為空數組。
如果你對某篇帖子特別感興趣，想看它的完整正文和評論區，可以填 wantToViewDetail。`;
};

const buildDetailReactionPrompt = (
    noteTitle: string,
    noteContent: string,
    comments: any[],
    commentsUnavailable = false,
    canInteract = false,
): string => {
    const commentsList = comments.slice(0, 15).map((c: any, i: number) => {
        const commentId = c.commentId || c.comment_id || c.id || '';
        const author = c.authorName || c.author_name || c.nickname || c.user?.nickname || '匿名';
        const content = c.content || c.text || '';
        const likes = c.likes || c.liked_count || c.likedCount || 0;
        return `${i+1}. [commentId=${commentId}] ${author}: ${content} (${likes}贊)`;
    }).join('\n');

    return `你剛才查看了帖子「${noteTitle}」的詳情:

正文: ${noteContent.slice(0, 500)}${noteContent.length > 500 ? '...' : ''}

${comments.length > 0
        ? `真實評論區:\n${commentsList}`
        : commentsUnavailable
            ? '真實評論區本次讀取失敗。不能據此判斷帖子沒有評論；不要編造、模擬或回覆評論。'
            : '這條帖子還沒有評論。'}

你怎麼看這條帖子和評論區？

${canInteract
        ? '✅ 系統已通過唯一 note_id 確認：這是你自己發的帖子。你可以回覆評論區的人。'
        : '⛔ 系統無法確認這是你自己的帖子。只看不評論，不要填寫 wantToReply 或 wantToComment。'}

用JSON回答:
\`\`\`json
{
    "thinking": "你看完詳情和評論區後的想法（第一人稱）",
    "wantToReply": {"commentId": "xxx", "authorName": "對方暱稱", "reply": "你想回復的內容（僅限自己的帖子）"},
    "wantToComment": {"comment": "你想對這條帖子說的評論（僅限自己的帖子）"}
}
\`\`\`

${canInteract
        ? '只回復上方真實評論區裡存在的 commentId；不要編造 commentId。'
        : 'wantToReply 和 wantToComment 都不要填。'} `;
};

const buildProfileReactionPrompt = (profileInfo: string, notes: any[]): string => {
    const notesList = notes.slice(0, 8).map((n: any, i: number) => {
        const noteId = n.noteId || n.note_id || n.id || '';
        return `${i+1}. [noteId=${noteId}]「${n.title || '無標題'}」❤️${n.likes || 0} 💬${n.comments || n.comment_count || 0}`;
    }).join('\n');

    return `你剛才查看了自己的小紅書主頁:

${profileInfo}

${notes.length > 0 ? `你發過的帖子:\n${notesList}` : '你還沒有發過帖子。'}

你怎麼看自己的主頁？有沒有想去看看哪條帖子的評論區？

用JSON回答:
\`\`\`json
{
    "thinking": "你看完自己主頁後的想法（第一人稱，比如對粉絲數/贊數的反應）",
    "wantToViewDetail": {"noteId": "xxx", "title": "帖子標題"}
}
\`\`\`

不想看詳情就不填 wantToViewDetail。`;
};

// ==================== Core Engine ====================

const getRecentChatContext = async (char: CharacterProfile): Promise<string> => {
    try {
        const msgs = await loadCharacterContextMessages(char);
        if (msgs.length === 0) return '還沒有和用戶聊過天。';

        // Return raw messages — no summarization, no truncation
        return msgs.map(m => {
            const role = m.role === 'user' ? '用戶' : '角色';
            const text = m.type === 'text' ? m.content : `[${m.type}]`;
            return `${role}: ${text}`;
        }).join('\n');
    } catch {
        return '無法獲取最近對話。';
    }
};

/**
 * 查看筆記詳情 + 評論區，並讓角色反應（回覆評論等）
 */
const handleViewDetail = async (
    mcpUrl: string,
    apiConfig: APIConfig,
    systemPrompt: string,
    noteId: string,
    noteTitle: string,
    contextNotes: any[],
    char: CharacterProfile,
    session: XhsFreeRoamSession,
    callbacks: FreeRoamCallbacks,
    canInteract: boolean,
): Promise<void> => {
    callbacks.onStatus(`${char.name}在查看帖子「${noteTitle}」的詳情...`);

    // Find xsecToken from context notes
    const contextNote = contextNotes.find(n =>
        (n.noteId || n.note_id || n.id) === noteId
    );
    const xsecToken = contextNote?.xsecToken || contextNote?.xsec_token || contextNote?.noteCard?.xsec_token || undefined;

    const detailResult = await XhsMcpClient.getNoteDetail(mcpUrl, noteId, xsecToken, { loadAllComments: true });
    if (!detailResult.success) {
        console.log(`[FreeRoam] 查看詳情失敗: ${detailResult.error}`);
        return;
    }

    // Extract note content and comments
    const data = detailResult.data;
    let noteContent = '';
    let comments: any[] = [];
    let commentsUnavailable = false;
    if (typeof data === 'string') {
        noteContent = data.slice(0, 1000);
    } else if (data) {
        // MCP 服務器返回數據可能嵌套在 data 層: { data: { note: {...}, comments: { list: [...] } } }
        const innerData = data.data && typeof data.data === 'object' ? data.data : null;
        const noteObj = innerData?.note || data.note;
        noteContent = innerData?.note?.content || innerData?.note?.desc || data.content || data.desc || data.note?.content || data.note?.desc || '';
        // 兼容多種 MCP 返回格式（包括 MCP 服務器的 data.comments.list 嵌套）
        comments = innerData?.comments?.list || innerData?.comments
            || data.comments?.list || data.comments
            || data.comment_list || data.commentList
            || noteObj?.comments?.list || noteObj?.comments || [];
        if (!Array.isArray(comments)) comments = [];
        const normalized = normalizeXhsLiteDetail(data);
        comments = normalized.comments || [];
        commentsUnavailable = normalized.commentReadStatus === 'unavailable';
    }

    // Let character react to detail + comments
    callbacks.onStatus(commentsUnavailable
        ? `${char.name}看完了正文，評論區暫時讀取失敗`
        : `${char.name}在看評論區...`);
    const reactionRaw = await callLlm(
        apiConfig,
        systemPrompt,
        buildDetailReactionPrompt(noteTitle, noteContent, comments, commentsUnavailable, canInteract),
    );
    const reaction = parseJson<LlmDetailReaction>(reactionRaw);

    if (reaction?.thinking) {
        callbacks.onThinking(reaction.thinking);
    }

    // Record the detail viewing
    const detailRecord: XhsActivityRecord = {
        id: `xa_${Date.now()}_d`,
        characterId: char.id,
        timestamp: Date.now(),
        actionType: 'browse',
        content: {
            keyword: `查看詳情: ${noteTitle}`,
            notesViewed: [normalizeNote(contextNote || { noteId, title: noteTitle })],
        },
        thinking: reaction?.thinking || (commentsUnavailable
            ? `看了「${noteTitle}」的正文，但評論區讀取失敗`
            : `看了「${noteTitle}」的詳情和評論區`),
        result: 'success',
        resultMessage: commentsUnavailable
            ? `查看了「${noteTitle}」的詳情；真實評論讀取失敗`
            : `查看了「${noteTitle}」的詳情，${comments.length} 條評論`,
    };
    session.activities.push(detailRecord);
    callbacks.onActivity(detailRecord);

    // If character wants to reply to a comment
    const requestedReplyCommentId = reaction?.wantToReply?.commentId;
    const replyTargetExists = !!requestedReplyCommentId && comments.some((comment: any) =>
        (comment.commentId || comment.comment_id || comment.id) === requestedReplyCommentId
    );
    if (canInteract && replyTargetExists && reaction?.wantToReply?.reply) {
        // XHS 反爬: get-feed-detail 剛用過 xsec_token 打開筆記頁，
        // 緊接著 post-comment 再次打開同一頁面會被臨時封鎖("筆記不可訪問")。
        // 等幾秒讓 xsec_token 冷卻，避免觸發反爬。
        callbacks.onStatus(`${char.name}在思考回覆...`);
        await new Promise(r => setTimeout(r, 5000));
        callbacks.onStatus(`${char.name}在回覆評論...`);
        const replyResult = await XhsMcpClient.replyComment(
            mcpUrl, noteId, xsecToken || '',
            reaction.wantToReply.reply,
            reaction.wantToReply.commentId,
        );

        const replyRecord: XhsActivityRecord = {
            id: `xa_${Date.now()}_r`,
            characterId: char.id,
            timestamp: Date.now(),
            actionType: 'comment',
            content: {
                commentTarget: { noteId, title: noteTitle, commentId: reaction.wantToReply.commentId },
                commentText: `回覆${reaction.wantToReply.authorName}: ${reaction.wantToReply.reply}`,
            },
            thinking: `想回復${reaction.wantToReply.authorName}的評論`,
            result: replyResult.success ? 'success' : 'failed',
            resultMessage: replyResult.success ? '回覆評論成功' : (replyResult.error || '回覆失敗'),
        };
        session.activities.push(replyRecord);
        callbacks.onActivity(replyRecord);
    }

    // If character wants to leave a new comment on the note
    if (canInteract && reaction?.wantToComment?.comment) {
        // 同上: 避免 xsec_token 重複訪問觸發反爬
        callbacks.onStatus(`${char.name}在想怎麼評論...`);
        await new Promise(r => setTimeout(r, 5000));
        callbacks.onStatus(`${char.name}在評論帖子...`);
        const commentResult = await XhsMcpClient.comment(mcpUrl, noteId, reaction.wantToComment.comment, xsecToken);

        const commentRecord: XhsActivityRecord = {
            id: `xa_${Date.now()}_c2`,
            characterId: char.id,
            timestamp: Date.now(),
            actionType: 'comment',
            content: {
                commentTarget: { noteId, title: noteTitle },
                commentText: reaction.wantToComment.comment,
            },
            thinking: `想對「${noteTitle}」說點什麼`,
            result: commentResult.success ? 'success' : 'failed',
            resultMessage: commentResult.success ? '評論成功' : (commentResult.error || '評論失敗'),
        };
        session.activities.push(commentRecord);
        callbacks.onActivity(commentRecord);
    }
};

export const XhsFreeRoamEngine = {

    /**
     * 執行一次角色自由活動
     */
    run: async (
        char: CharacterProfile,
        user: UserProfile,
        apiConfig: APIConfig,
        realtimeConfig: RealtimeConfig,
        callbacks: FreeRoamCallbacks,
    ): Promise<XhsFreeRoamSession> => {
        const mcpUrl = realtimeConfig.xhsMcpConfig?.serverUrl;
        if (!mcpUrl) throw new Error('MCP Server URL 未配置');
        XhsMcpClient.setCookie(realtimeConfig.xhsMcpConfig?.cookie); // lite Worker auth (no-op for local backends)

        const sessionId = `xfr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const session: XhsFreeRoamSession = {
            id: sessionId,
            characterId: char.id,
            startedAt: Date.now(),
            activities: [],
        };

        try {
            // 0. Reset & initialize MCP session (fresh handshake each run)
            callbacks.onStatus('連接小紅書 MCP Server...');
            XhsMcpClient.resetSession();
            await XhsMcpClient.ensureInitialized(mcpUrl);
            callbacks.onStatus('MCP 已連接');

            // 1. Build context
            callbacks.onStatus(`${char.name}正在思考...`);
            const pastActivities = await DB.getXhsActivities(char.id, 10);
            const chatSummary = await getRecentChatContext(char);
            const systemPrompt = buildFreeRoamSystemPrompt(char, user, chatSummary, pastActivities);

            // 4. Character decides
            callbacks.onStatus(`${char.name}在決定做什麼...`);
            const decisionRaw = await callLlm(apiConfig, systemPrompt, buildDecisionPrompt());
            const decision = parseJson<LlmDecision>(decisionRaw);

            if (!decision) {
                throw new Error('角色決策解析失敗');
            }

            callbacks.onThinking(decision.thinking);

            // 5. Execute based on decision
            if (decision.action === 'idle') {
                const idleRecord: XhsActivityRecord = {
                    id: `xa_${Date.now()}`,
                    characterId: char.id,
                    timestamp: Date.now(),
                    actionType: 'idle',
                    content: {},
                    thinking: decision.thinking,
                    result: 'success',
                    resultMessage: `${char.name}決定休息一下`,
                };
                session.activities.push(idleRecord);
                callbacks.onActivity(idleRecord);
            }
            else if (decision.action === 'post') {
                callbacks.onStatus(`${char.name}正在發帖: ${decision.title}...`);

                // Try to get images from XHS stock
                let images: string[] = [];
                try {
                    const stockImgs = await DB.getXhsStockImages();
                    if (stockImgs.length > 0) {
                        const keywords = [decision.title, decision.content, ...(decision.tags || [])].join(' ').toLowerCase();
                        const scored = stockImgs.map(img => ({
                            img,
                            score: img.tags.reduce((s, t) => s + (keywords.includes(t.toLowerCase()) ? 10 : 0), 0) + Math.max(0, 5 - (img.usedCount || 0))
                        })).sort((a, b) => b.score - a.score);
                        if (scored[0]?.img.url) {
                            images = [scored[0].img.url];
                            DB.updateXhsStockImageUsage(scored[0].img.id).catch(() => {});
                        }
                    }
                } catch { /* ignore stock failures */ }

                const postResult = await XhsMcpClient.publishNote(mcpUrl, {
                    title: decision.title || '無題',
                    content: decision.content || '',
                    images: images.length > 0 ? images : undefined,
                    tags: decision.tags,
                });
                const publishedNoteId = postResult.success ? extractPublishedNoteId(postResult) : '';
                if (publishedNoteId) {
                    const now = Date.now();
                    const ownedPost: XhsOwnedPost = {
                        id: `${char.id}:${publishedNoteId}`,
                        characterId: char.id,
                        noteId: publishedNoteId,
                        title: decision.title || '無題',
                        body: decision.content || '',
                        tags: decision.tags,
                        publishedAt: now,
                        updatedAt: now,
                    };
                    try {
                        // 立即保存，避免後續 LLM/日誌步驟失敗時丟失已經發布成功的帖子歸屬。
                        await DB.saveXhsOwnedPost(ownedPost);
                    } catch (error) {
                        console.warn('[FreeRoam] 保存角色小紅書主頁失敗:', error);
                    }
                }

                const postRecord: XhsActivityRecord = {
                    id: `xa_${Date.now()}`,
                    characterId: char.id,
                    timestamp: Date.now(),
                    actionType: 'post',
                    content: {
                        noteId: publishedNoteId || undefined,
                        title: decision.title,
                        body: decision.content,
                        tags: decision.tags,
                    },
                    thinking: decision.thinking,
                    result: postResult.success ? 'success' : 'failed',
                    resultMessage: postResult.success ? '發帖成功' : (postResult.error || '發帖失敗'),
                };
                session.activities.push(postRecord);
                callbacks.onActivity(postRecord);
            }
            else if (decision.action === 'search' || decision.action === 'browse') {
                const isSearch = decision.action === 'search';
                const keyword = decision.keyword || '';

                callbacks.onStatus(isSearch
                    ? `${char.name}在搜索: ${keyword}...`
                    : `${char.name}在刷小紅書首頁...`
                );

                const mcpResult: McpToolResult = isSearch
                    ? await XhsMcpClient.search(mcpUrl, keyword)
                    : await XhsMcpClient.getRecommend(mcpUrl);

                if (!mcpResult.success) {
                    const failRecord: XhsActivityRecord = {
                        id: `xa_${Date.now()}`,
                        characterId: char.id,
                        timestamp: Date.now(),
                        actionType: isSearch ? 'search' : 'browse',
                        content: { keyword: isSearch ? keyword : undefined },
                        thinking: decision.thinking,
                        result: 'failed',
                        resultMessage: mcpResult.error || '操作失敗',
                    };
                    session.activities.push(failRecord);
                    callbacks.onActivity(failRecord);
                } else {
                    // Parse notes from result (robust extraction) + normalize
                    const rawNotes: any[] = extractNotesFromMcpData(mcpResult.data);
                    const notes = rawNotes.map(normalizeNote);
                    console.log(`[FreeRoam] ${decision.action} 提取到 ${notes.length} 條筆記`);

                    // Let character react to what they saw (normalized notes have proper title/author)
                    callbacks.onStatus(`${char.name}在看搜索結果...`);
                    const reactionRaw = await callLlm(apiConfig, systemPrompt, buildReactionPrompt(notes));
                    const reaction = parseJson<LlmReaction>(reactionRaw);

                    if (reaction?.thinking) {
                        callbacks.onThinking(reaction.thinking);
                    }

                    const browseRecord: XhsActivityRecord = {
                        id: `xa_${Date.now()}`,
                        characterId: char.id,
                        timestamp: Date.now(),
                        actionType: isSearch ? 'search' : 'browse',
                        content: {
                            keyword: isSearch ? keyword : undefined,
                            notesViewed: notes.slice(0, 8),
                            savedTopics: reaction?.savedTopics || [],
                        },
                        thinking: reaction?.thinking || decision.thinking,
                        result: 'success',
                        resultMessage: `看了 ${notes.length} 條筆記${reaction?.savedTopics?.length ? `，保存了 ${reaction.savedTopics.length} 個話題` : ''}`,
                    };
                    session.activities.push(browseRecord);
                    callbacks.onActivity(browseRecord);

                    // If character wants to view note detail (comments section)
                    // 注意：瀏覽/搜索看到的是別人的帖子，不執行評論（wantToComment 已從 prompt 中移除）
                    if (reaction?.wantToViewDetail?.noteId) {
                        await handleViewDetail(
                            mcpUrl, apiConfig, systemPrompt,
                            reaction.wantToViewDetail.noteId,
                            reaction.wantToViewDetail.title || '',
                            notes, char, session, callbacks,
                            false,
                        );
                    }
                }
            }
            else if (decision.action === 'check_profile') {
                // 角色偽主頁以獨立的 owned-posts 表為準；真實帳號主頁只刷新已歸屬帖子的互動數據。
                // 同一個真實帳號可以被多個角色共用，絕不能把帳號下全部筆記自動認領給當前角色。
                callbacks.onStatus(`${char.name}在查看自己的主頁...`);
                const loggedInUserId = realtimeConfig.xhsMcpConfig?.loggedInUserId;
                const userXsecToken = realtimeConfig.xhsMcpConfig?.userXsecToken;
                const allActivities = await DB.getXhsActivities(char.id);
                let ownedPosts = await DB.getXhsOwnedPosts(char.id);

                // v71 首次運行時，把舊活動裡已記錄過 note_id 的帖子遷移進獨立主頁。
                const knownPostIds = new Set(ownedPosts.map(post => post.noteId));
                const migratedPosts = collectOwnedPostsFromActivities(allActivities)
                    .filter(post => !knownPostIds.has(post.noteId));
                for (const post of migratedPosts) await DB.saveXhsOwnedPost(post);
                if (migratedPosts.length > 0) {
                    ownedPosts = [...ownedPosts, ...migratedPosts]
                        .sort((a, b) => b.publishedAt - a.publishedAt);
                }

                let ownedNotes: any[] = ownedPosts.map(post => ownedPostToNote(post, char.name));
                let profileRefreshError = '';

                if (loggedInUserId && ownedNotes.length > 0) {
                    console.log(`[FreeRoam] check_profile: 用 getUserProfile(${loggedInUserId})...`);
                    try {
                        const profileResult = await XhsMcpClient.getUserProfile(mcpUrl, loggedInUserId, userXsecToken);
                        if (profileResult.success && profileResult.data) {
                            const remoteNotes = extractNotesFromMcpData(profileResult.data).map(normalizeNote);
                            const notesStatus = profileResult.data?.notes_status || profileResult.data?.data?.notes_status;
                            console.log(`[FreeRoam] check_profile: getUserProfile 提取到 ${remoteNotes.length} 條筆記`);
                            if (notesStatus === 'unavailable') {
                                profileRefreshError = profileResult.data?.notes_error || profileResult.data?.data?.notes_error || '';
                            } else {
                                // 只更新當前角色已經擁有的 note_id，忽略共享帳號下其他角色的帖子。
                                ownedNotes = mergeOwnedNotes(ownedNotes, remoteNotes, false);
                                const ownedPostById = new Map(ownedPosts.map(post => [post.noteId, post]));
                                await Promise.all(ownedNotes.map(async note => {
                                    const current = ownedPostById.get(note.noteId);
                                    if (!current) return;
                                    await DB.saveXhsOwnedPost({
                                        ...current,
                                        title: note.title || current.title,
                                        body: note.desc || current.body,
                                        xsecToken: note.xsecToken || current.xsecToken,
                                        likes: note.likes,
                                        collects: note.collects,
                                        commentCount: note.commentCount,
                                        shareCount: note.shareCount,
                                        updatedAt: Date.now(),
                                    });
                                }));
                            }
                        }
                        if (!profileResult.success) profileRefreshError = profileResult.error || '';
                    } catch (e: any) {
                        console.warn(`[FreeRoam] check_profile: getUserProfile 失敗:`, e.message);
                        profileRefreshError = e.message;
                    }
                }

                const notes = ownedNotes.map(normalizeNote);
                const trustedOwnedNoteIds = new Set(
                    ownedNotes.map(note => normalizeNote(note).noteId).filter(Boolean)
                );

                const profileRecord: XhsActivityRecord = {
                    id: `xa_${Date.now()}`,
                    characterId: char.id,
                    timestamp: Date.now(),
                    actionType: 'browse',
                    content: {
                        keyword: `查看主頁（${char.name}）`,
                        notesViewed: notes.slice(0, 8),
                    },
                    thinking: decision.thinking,
                    result: 'success',
                    resultMessage: `查看角色主頁，找到 ${notes.length} 條帖子${profileRefreshError ? '（真實帳號互動數據刷新失敗，已使用本地記錄）' : ''}`,
                };
                session.activities.push(profileRecord);
                callbacks.onActivity(profileRecord);

                // Let character react if we found notes
                if (notes.length > 0) {
                    callbacks.onStatus(`${char.name}在看自己的帖子...`);
                    const reactionRaw = await callLlm(apiConfig, systemPrompt, buildProfileReactionPrompt(
                        '這是按角色獨立保存的個人主頁；真實小紅書帳號可能與其他角色共用',
                        notes
                    ));
                    const reaction = parseJson<LlmReaction & { wantToViewDetail?: { noteId: string; title: string } }>(reactionRaw);
                    if (reaction?.thinking) {
                        callbacks.onThinking(reaction.thinking);
                        profileRecord.thinking = reaction.thinking;
                    }
                    if (reaction?.wantToViewDetail?.noteId) {
                        await handleViewDetail(
                            mcpUrl, apiConfig, systemPrompt,
                            reaction.wantToViewDetail.noteId,
                            reaction.wantToViewDetail.title || '',
                            notes, char, session, callbacks,
                            trustedOwnedNoteIds.has(reaction.wantToViewDetail.noteId),
                        );
                    }
                }
            }

            // 6. Finalize session
            session.endedAt = Date.now();
            session.summary = session.activities.map(a => {
                const label: Record<string, string> = { post: '發帖', browse: '刷首頁', search: '搜索', comment: '評論', save_topic: '收藏', idle: '休息' };
                return `${label[a.actionType] || a.actionType}: ${a.content.title || a.content.keyword || a.thinking.slice(0, 50)} [${a.result}]`;
            }).join(' → ');

            // Save all activities to DB + sync to chat context
            for (const activity of session.activities) {
                await DB.saveXhsActivity(activity);

                // 寫入聊天記錄作為系統消息（🔔），讓私聊時 AI 知道自由活動做了什麼
                // 包含完整的思考和內容，確保角色在後續聊天中能記住自由活動的細節
                if (activity.result === 'success' && activity.actionType !== 'idle') {
                    let msgContent = '';
                    const thinkingLine = activity.thinking ? `\n💭 內心想法: ${activity.thinking}` : '';
                    switch (activity.actionType) {
                        case 'post': {
                            const tagsStr = activity.content.tags?.length ? ` #${activity.content.tags.join(' #')}` : '';
                            msgContent = `📕 ${char.name}的自由活動: 發了一條小紅書「${activity.content.title}」\n${activity.content.body || ''}${tagsStr}${thinkingLine}`;
                            break;
                        }
                        case 'search': {
                            msgContent = `📕 ${char.name}的自由活動: 搜索了「${activity.content.keyword}」`;
                            if (activity.content.notesViewed?.length) {
                                msgContent += `\n看到的帖子: ${activity.content.notesViewed.map(n => `「${n.title}」by ${n.author}`).join('、')}`;
                            }
                            if (activity.content.savedTopics?.length) {
                                msgContent += `\n保存的話題: ${activity.content.savedTopics.map(t => `「${t.title}」${t.desc ? ` - ${t.desc}` : ''}`).join('、')}`;
                            }
                            msgContent += thinkingLine;
                            break;
                        }
                        case 'browse': {
                            msgContent = `📕 ${char.name}的自由活動: 刷了小紅書首頁`;
                            if (activity.content.notesViewed?.length) {
                                msgContent += `\n看到的帖子: ${activity.content.notesViewed.map(n => `「${n.title}」by ${n.author}`).join('、')}`;
                            }
                            if (activity.content.savedTopics?.length) {
                                msgContent += `\n保存的話題: ${activity.content.savedTopics.map(t => `「${t.title}」${t.desc ? ` - ${t.desc}` : ''}`).join('、')}`;
                            }
                            msgContent += thinkingLine;
                            break;
                        }
                        case 'comment':
                            msgContent = `📕 ${char.name}的自由活動: 評論了「${activity.content.commentTarget?.title || '某條筆記'}」: "${activity.content.commentText || ''}"${thinkingLine}`;
                            break;
                    }
                    if (msgContent) {
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: msgContent,
                        });
                    }

                    // Inject saved topics as xhs_card shared posts in chat
                    if (activity.content.savedTopics?.length && activity.content.notesViewed?.length) {
                        for (const topic of activity.content.savedTopics) {
                            const matchedNote = topic.noteId
                                ? activity.content.notesViewed.find(n => n.noteId === topic.noteId)
                                : null;
                            await DB.saveMessage({
                                charId: char.id,
                                role: 'assistant',
                                type: 'xhs_card' as any,
                                content: topic.title || '小紅書筆記',
                                metadata: {
                                    xhsNote: {
                                        noteId: topic.noteId || matchedNote?.noteId || '',
                                        title: topic.title || matchedNote?.title || '',
                                        desc: topic.desc || matchedNote?.desc || '',
                                        author: matchedNote?.author || '',
                                        authorId: '',
                                        likes: matchedNote?.likes || 0,
                                    },
                                    fromFreeRoam: true,
                                },
                            });
                        }
                    }
                }
            }

            callbacks.onComplete(session);
            return session;

        } catch (e: any) {
            session.endedAt = Date.now();
            callbacks.onError(e.message);
            return session;
        }
    },
};
