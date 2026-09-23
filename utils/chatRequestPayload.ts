import { getMemoryPalaceHighWaterMarkForContext, selectCharacterContextMessages } from './chatContextRange';
/**
 * 聊天請求載荷統一構造器
 *
 * 設計目標：讓"正常聊天"、"主動消息"、"emotion 副 API 評估"三條路徑吃到的
 * 上下文材料完全一致——區別只在末尾各自追加的"現在你要做什麼"指令。
 *
 * 三條路徑過去各拼一遍 system prompt + 消息歷史，導致主動消息缺音樂共聽 /
 * HTML 模式 / 雙語模式 / 麥當勞小程序等塊；emotion eval 也容易跟主路徑分叉。
 * 現在統一從這裡走，避免再分叉。
 *
 * 順序嚴格對齊 useChatAI.ts 的現有實現（line 629–793），保證現有行為字節級
 * 等價。新增 caller（runProactive）只是補齊了過去缺的字段。
 */

import type { CharacterProfile, UserProfile, GroupProfile, Emoji, EmojiCategory, Message, RealtimeConfig, TranslationConfig, VisionApiConfig, ImageGenApiConfig } from '../types';
import { ChatPrompts, detectChatModeTransition } from './chatPrompts';
import { ContextBuilder } from './context';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { renderLocalContextGuidance } from './memoryPalace/recallRouter';
import { renderInteractionAdaptationGuidance } from './memoryPalace/interactionAdaptation';
import { renderDeepEngagementGuidance } from './memoryPalace/deepEngagement';
import { renderConversationEngagementGuidance } from './memoryPalace/conversationEngagement';
import type { ConversationEngagementAnalysis } from './memoryPalace/conversationEngagement';
import type { DeepEngagementAnalysis } from './memoryPalace/deepEngagement';
import { buildHtmlPrompt } from './htmlPrompt';
import { buildThinkingChainPrompt } from './thinkingChainPrompt';
import { buildMcdMiniAppContextBlock } from './mcdToolBridge';
import type { McdMiniAppSnapshot } from './mcdToolBridge';
import { buildLuckinMiniAppContextBlock, buildLuckinChatSystemBlock } from './luckinToolBridge';
import type { LuckinMiniAppSnapshot, LuckinChatState } from './luckinToolBridge';
import { isMcpChatAvailable } from './mcpClient';
import { buildMcpSystemBlock, MCP_TAIL_REMINDER } from './mcpToolBridge';
import type { MusicCfg, Song, LyricLine, MusicPlaybackSnapshot, RecentTrackChange } from '../context/MusicContext';
import { isPromptBuildSkipped, isSystemMessageMergeEnabled } from './devDebug';
import { mergeSystemMessages } from './systemMessageMerge';
import { injectWorldbookDepthEntries, resolveWorldbookEntries } from './worldbook';
import { normalizeTranslationLangLabel } from './translationLang';
import { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';
import { materializeVisionDescriptions } from './visionApi';
import type { RecallEntryPoint, RecallTrace } from './memoryPalace/trace';
import { loadCollaborationFileCabinetBlock } from '../features/collaboration/chatLibrary';
import { buildSARUserSurfaceRequest, selectSARUserSurfaceTargets } from './vrWorld/sarUserSurface';
import { getSARModuleRuntimePlan } from './vrWorld/sarModuleRuntime';

export { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';

export interface UserListeningContext {
    songName: string;
    artists: string;
    lyricWindow: string[];
    activeIdx: number;
}

export interface BuildChatPayloadInput {
    char: CharacterProfile;
    userProfile: UserProfile;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    /** 給 buildMessageHistory 用的完整歷史（≤ contextLimit） */
    historyMsgs: Message[];
    /**
     * 給 buildSystemPrompt + memoryPalace 召回用的"較短近窗"。不傳則等於 historyMsgs。
     * useChatAI 主路徑裡 React state 上限 200 條，DB 歷史可能更長——保留這個區分。
     */
    recentMsgsHint?: Message[];
    contextLimit: number;
    /** 本輪加載原文時的歸檔水位快照，避免異步構建期間再次讀取變化中的水位。 */
    contextHighWaterMark?: number;
    /**
     * 額外的記憶召回提示詞（拼進向量/BM25 檢索的 context query）。
     * 用途：彼方等場景下，把"此刻在場的其他玩家名字 / 房間上下文"塞進召回 query，
     * 讓角色能回憶起自己跟對面這些人的關係，而不是只按聊天歷史召回。
     */
    recallQueryHint?: string;
    /** 只用於 Trace 和後續功能的作用域判斷，不參與當前召回排序。 */
    recallEntryPoint?: RecallEntryPoint;

    // 實時世界 / 角色情緒
    realtimeConfig?: RealtimeConfig;
    /** 上一輪 emotion eval 產出的內心獨白 */
    innerState?: string;

    // user 共聽上下文（非 React 調用方可傳 musicSnapshot 讓 helper 自動算）
    userListeningContext?: UserListeningContext | null;
    isListeningTogether?: boolean;
    musicCfg?: MusicCfg;
    /** 備選：傳一份原始播放快照，helper 內部按主路徑同樣的邏輯算 listening 三件套 */
    musicSnapshot?: MusicPlaybackSnapshot | null;
    /** 最近一次一起聽途中換歌的記錄（React 主路徑顯式傳；snapshot 路徑從快照裡取） */
    recentTrackChange?: RecentTrackChange | null;

    // 模式開關
    translationConfig?: TranslationConfig | { enabled: boolean; sourceLang: string; targetLang: string };
    htmlMode?: { enabled: boolean; customPrompt?: string };
    thinkingChain?: { enabled: boolean; customPrompt?: string };
    /** 可選識圖 API：開啟後先把圖片持久化轉寫為 [圖片：描述]，主模型只接收文字。 */
    visionApiConfig?: VisionApiConfig;
    /** 生圖 API 配置；開著角色自主發圖時才會教 [[ACTION:SEND_PHOTO|...]]，見 chatPrompts.ts PromptBuildOptions。 */
    imageGenConfig?: ImageGenApiConfig;
    mcdMiniSnap?: McdMiniAppSnapshot;
    luckinMiniSnap?: LuckinMiniAppSnapshot;
    /** 瑞幸聊天點單模式 (點"瑞一杯"激活, 角色直接調真實工具) */
    luckinChat?: LuckinChatState;
    /**
     * 把歷史裡的多模態圖片消息（content 數組 + image_url）壓平成純文本佔位。
     * 彼方/小小窩等複用聊天歷史、但配了獨立 API 的場景必須開：目標模型可能不支持
     * 視覺輸入（DeepSeek 等對 image_url 直接 400），且這些純文本情景裡 base64 圖片
     * 只是把上下文撐爆的噪聲（與群聊注入"不要把媒體當文本塞"同一約定）。
     */
    stripImages?: boolean;
    /**
     * 這一輪交給 amsg worker 在 fire 時刻生成（即時對話）。時鐘 / 真實世界塊 /
     * MCP 說明由 worker 那邊獨家供給，前端這份就不再烤進去，免得一份 prompt 裡
     * 出現兩個鍾、兩份熱搜、兩套工具名。
     */
    timelyByWorker?: boolean;
}

export interface BuildChatPayloadResult {
    /** 完整 system prompt（含所有可選塊） */
    systemPrompt: string;
    /** 已剝離雙語標籤的歷史消息（emotion eval 也吃這份） */
    cleanedApiMessages: Array<{ role: string; content: any }>;
    /** [system, ...cleanedApiMessages, 末尾 bilingual reminder?] —— 主 API 直接發這個 */
    fullMessages: Array<{ role: string; content: any }>;
    /**
     * fullMessages 裡易變尾段那條 system 的下標；想插在鋼印**之前**的塊按它定位。
     *
     * 「回到你自己」焊在 volatileTail 末尾，靠 recency 搶模型開口前的最後一眼。後來
     * 貼數組尾巴的塊（amsg2 排程清單）會把那一眼搶走——一份帶具體內容的待辦清單
     * 擺在最後，模型會當成本輪該辦的事。插在這個下標前，鋼印就還是最後一句。
     * -1 = 沒有可插的尾段（prompt build 被跳過，或 dev 的 system 合併開關把多條併成了一條）。
     */
    volatileTailIndex: number;
    /** 本輪記憶召回的脫敏 Trace；Prompt Build 被整體跳過時不存在。 */
    recallTrace?: RecallTrace;
    /** 調試用：bilingual / mcd 是否實際注入 */
    flags: {
        bilingualActive: boolean;
        mcdActive: boolean;
        luckinActive: boolean;
        luckinChatActive: boolean;
        mcpChatActive: boolean;
        htmlActive: boolean;
        thinkingActive: boolean;
        sarModuleActive: boolean;
        promptBuildSkipped: boolean;
    };
}

/**
 * 用 MusicPlaybackSnapshot 算 user 共聽上下文 —— 與 useChatAI.ts:636–666 行為一致。
 */
function deriveListeningFromSnapshot(
    snap: MusicPlaybackSnapshot | null | undefined,
    charId: string,
): { userListeningContext: UserListeningContext | null; isListeningTogether: boolean; musicCfg?: MusicCfg } {
    if (!snap) return { userListeningContext: null, isListeningTogether: false };
    const { current, playing, lyric, activeLyricIdx, listeningTogetherWith, cfg } = snap;
    let userListeningContext: UserListeningContext | null = null;
    if (current && playing && lyric.length > 0) {
        const idx = activeLyricIdx;
        if (idx >= 0) {
            const from = Math.max(0, idx - 2);
            const to = Math.min(lyric.length, idx + 2 + 1);
            const window = lyric.slice(from, to).map((l: LyricLine) => l.text);
            const activeIdx = idx - from;
            userListeningContext = {
                songName: current.name,
                artists: current.artists,
                lyricWindow: window,
                activeIdx,
            };
        }
    } else if (current && playing) {
        userListeningContext = {
            songName: current.name,
            artists: current.artists,
            lyricWindow: [],
            activeIdx: -1,
        };
    }
    const isListeningTogether = !!(userListeningContext && listeningTogetherWith.includes(charId));
    return { userListeningContext, isListeningTogether, musicCfg: cfg };
}

/** 換歌記錄多久內算"剛剛"——超過就不再向 char 提起（一首歌的量級） */
const TRACK_CHANGE_FRESH_MS = 10 * 60 * 1000;

/**
 * 把原始換歌記錄折算成"該 char 這一輪是否需要察覺換歌"。
 * 命中條件：char 換歌那刻在一起聽名單裡、還沒重新加入、且換歌發生在剛才。
 * 導出僅為單測。
 */
export function deriveRecentTrackSwitchForChar(
    record: RecentTrackChange | null | undefined,
    charId: string,
    isListeningTogether: boolean,
): { songName: string; artists: string } | null {
    if (!record || isListeningTogether) return null;
    if (!record.charIds.includes(charId)) return null;
    if (Date.now() - record.at > TRACK_CHANGE_FRESH_MS) return null;
    return { songName: record.previousSong.name, artists: record.previousSong.artists };
}

/**
 * 構造完整 chat 請求載荷。三段式結構（穩定前綴 / 歷史 / 易變尾段）：
 *
 *   1. injectMemoryPalace（向量召回掛到 char.memoryPalaceInjection）
 *   2. ChatPrompts.buildSystemPromptParts → { stable, volatileState, recencyTail }
 *   3. stable += 雙語指令 / HTML 模式 / 思考鏈（按角色配置，變化慢）
 *   4. ChatPrompts.buildMessageHistory → apiMessages → 剝離舊雙語標籤 → cleanedApiMessages
 *   5. volatileTail = volatileState + 麥當勞/瑞幸/瑞一杯實時快照塊
 *   6. stable += 通用 MCP 工具塊（工具清單持久化，變化慢）
 *   7. volatileTail += recencyTail（總綱+「回到你自己」鋼印，永遠最後）
 *   8. fullMessages = [stable system, ...cleanedApiMessages, volatileTail system]
 *   9. fullMessages.push（末尾雙語 reminder / MCP reminder）
 *
 * 設計動機：穩定前綴不含分鐘級時間戳/召回/buff → 中轉的 prompt 前綴緩存能跨輪命中
 * （TTFT 直降）；易變狀態貼著生成點，時間/情緒拿到最強 recency 注意力。
 *
 * emotion eval 吃 (systemPrompt=stable+volatileTail 拼接, cleanedApiMessages) ——
 * 信息與主 API 完全一致，僅易變段的位置不同（主 API 在歷史後，eval 拼在 system 文本里）。
 */
export async function buildChatRequestPayload(input: BuildChatPayloadInput): Promise<BuildChatPayloadResult> {
    const {
        char, userProfile, groups, historyMsgs, contextLimit,
        realtimeConfig, innerState,
        translationConfig, htmlMode, thinkingChain, mcdMiniSnap, luckinMiniSnap, luckinChat,
    } = input;
    // 角色可見性必須在統一載荷層再次收口。UI 聊天、1.0 本地主動消息、2.0 推送、
    // 彼方/小小窩等調用方各自維護篩選很容易漏掉一條路徑；一旦把全量表情傳進來，
    // 模型既會看到其他角色的專屬表情，歷史裡的同名表情也可能反查到錯誤 URL。
    // 即使調用方已經過濾過，重複過濾仍是冪等的。
    const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
        input.emojis,
        input.categories,
        char.id,
    );
    // 正文、召回、世界書掃描和識圖共用可見範圍；UI 近窗可能仍緩存著範圍外舊消息。
    const contextHighWaterMark = input.contextHighWaterMark ?? getMemoryPalaceHighWaterMarkForContext(char.id);
    const selectedHistory = selectCharacterContextMessages(historyMsgs, char, contextHighWaterMark);
    const visibleIds = new Set(selectedHistory.map(message => message.id));
    const rawRecentMsgsHint = input.recentMsgsHint
        ? input.recentMsgsHint.filter(message => visibleIds.has(message.id))
        : selectedHistory;
    const useVisionDescriptions = input.visionApiConfig?.enabled === true;
    let historyMsgsForPrompt = selectedHistory;
    let recentMsgsHint = rawRecentMsgsHint;

    if (useVisionDescriptions) {
        // historyMsgs 通常來自 DB、recentMsgsHint 通常來自 React state；按 id 合併後只識別一次，
        // 再把寫回 metadata 的新快照映射回兩套窗口，避免同一輪的 system/history 各跑一次識圖。
        const uniqueMessages = new Map<number, Message>();
        for (const message of rawRecentMsgsHint) uniqueMessages.set(message.id, message);
        for (const message of selectedHistory) uniqueMessages.set(message.id, message);
        const prepared = await materializeVisionDescriptions(
            [...uniqueMessages.values()],
            input.visionApiConfig,
        );
        const preparedById = new Map(prepared.map(message => [message.id, message]));
        historyMsgsForPrompt = selectedHistory.map(message => preparedById.get(message.id) || message);
        recentMsgsHint = rawRecentMsgsHint.map(message => preparedById.get(message.id) || message);
    }

    if (isPromptBuildSkipped()) {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            historyMsgsForPrompt,
            contextLimit,
            char,
            userProfile,
            emojis,
            undefined,
            { useVisionDescriptions, contextHighWaterMark },
        );
        const cleanedApiMessages = cleanApiMessages(input.stripImages ? flattenImageContentParts(apiMessages) : apiMessages);
        console.warn('[DevDebug] Prompt Build skipped: sending chat history without system prompt injection.');
        return {
            systemPrompt: '',
            cleanedApiMessages,
            fullMessages: [...cleanedApiMessages],
            volatileTailIndex: -1,
            flags: {
                bilingualActive: false,
                mcdActive: false,
                luckinActive: false,
                luckinChatActive: false,
                mcpChatActive: false,
                htmlActive: false,
                thinkingActive: false,
                sarModuleActive: false,
                promptBuildSkipped: true,
            },
        };
    }

    // ── 1. Memory Palace 向量召回 ─────────────────────────
    const recallTrace = await injectMemoryPalace(
        char,
        recentMsgsHint,
        input.recallQueryHint,
        userProfile?.name,
        { entryPoint: input.recallEntryPoint ?? 'chat_payload' },
    );

    // ── 2. 解析音樂共聽（如果 caller 沒顯式給，就從 snapshot 推） ──
    let userListeningContext = input.userListeningContext;
    let isListeningTogether = input.isListeningTogether;
    let musicCfg = input.musicCfg;
    let recentTrackChange = input.recentTrackChange;
    if (userListeningContext === undefined && input.musicSnapshot !== undefined) {
        const derived = deriveListeningFromSnapshot(input.musicSnapshot, char.id);
        userListeningContext = derived.userListeningContext;
        isListeningTogether = derived.isListeningTogether;
        musicCfg = derived.musicCfg ?? musicCfg;
        if (recentTrackChange === undefined) recentTrackChange = input.musicSnapshot?.recentTrackChange ?? null;
    }
    // 換歌察覺：char 換歌那刻在一起聽、還沒重新加入 → 下一輪回復裡注入"歌切了"的提示
    const recentTrackSwitch = deriveRecentTrackSwitchForChar(recentTrackChange, char.id, !!isListeningTogether);

    // ── 3. buildSystemPromptParts 核心（三段式） ──────────
    // stable → 消息數組第一條 system（前綴穩定，吃 prompt cache）；
    // volatileTail → 歷史消息之後的 system（時間/召回/buff/日程/音樂等實時狀態 + 點單類模式塊）；
    // recencyTail（總綱+「回到你自己」鋼印）最後拼進 volatileTail 末尾，保證它是模型
    // 開口前讀到的最後內容 —— 雙語/HTML/思考鏈等格式塊都只能拼在 stable 裡、排它前面。
    // UI 為了不把通話/見面/劇情正文畫進 ChatApp，會把這些 source 從 React state 過濾掉；
    // 但主 API 的 historyMsgsForPrompt 來自完整 DB，仍然會看到它們。模式切換必須以 API
    // 真正要發送的歷史為準，否則模型會收到特殊模式正文，卻收不到「切回聊天格式」的提示。
    const returningFromMode = detectChatModeTransition(historyMsgsForPrompt);
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, groups, emojis, categories, recentMsgsHint,
        realtimeConfig, innerState || undefined,
        userListeningContext ?? null,
        !!isListeningTogether,
        musicCfg,
        recentTrackSwitch,
        (input.timelyByWorker || returningFromMode || input.imageGenConfig) ? {
            timelyByWorker: input.timelyByWorker === true,
            returningFromMode: returningFromMode || undefined,
            imageGenConfig: input.imageGenConfig,
        } : undefined,
    );
    let systemPrompt = parts.stable;
    let volatileTail = parts.volatileState;
    const sarModulePlan = input.recallEntryPoint === 'chat_app'
        ? getSARModuleRuntimePlan(char, userProfile)
        : undefined;
    const sarModuleBlock = input.recallEntryPoint === 'chat_app'
        ? ContextBuilder.buildSARModuleContext(char, userProfile, 'chat')
        : '';
    const sarEnvelopeActive = sarModulePlan?.requiresEnvelope === true;

    // ── 4. 雙語指令注入 ───────────────────────────────────
    const sourceLang = normalizeTranslationLangLabel(translationConfig?.sourceLang);
    const targetLang = normalizeTranslationLangLabel(translationConfig?.targetLang);
    const bilingualActive = !!(translationConfig?.enabled && sourceLang && targetLang);
    if (bilingualActive && translationConfig) {
        systemPrompt += `\n\n[CRITICAL: 雙語輸出模式 - 必須嚴格遵守]
你的每句話都必須用以下XML標籤格式輸出雙語內容：
<翻譯>
<原文>${sourceLang}內容</原文>
<譯文>${targetLang}內容</譯文>
</翻譯>

規則：
- 每句話單獨包裹一個<翻譯>標籤
- 多句話就輸出多個<翻譯>標籤，一句一個
- ${sarEnvelopeActive
            ? 'SAR 模塊生效中：最外層必須是 <SAR_MODULE_OUTPUT>；在 CHAR_TRUE 與 CHAR_SURFACE 字段內部，各自用完整的 <翻譯> 標籤包裹每句話。除這個 SAR 容器與字段標籤外，不寫散落文字'
            : '<翻譯>標籤外不要寫任何文字'}
- 表情包命令 [[SEND_EMOJI: ...]] 放在所有<翻譯>標籤外面
- 引用命令 [[QUOTE: ...]] 也放在所有<翻譯>標籤外面；引用內容請原樣照抄用戶說過的原文（不要翻譯、不要包<翻譯>標籤）

示例（${sourceLang}→${targetLang}）：
<翻譯>
<原文>こんにちは！</原文>
<譯文>你好！</譯文>
</翻譯>
<翻譯>
<原文>今日は何する？</原文>
<譯文>今天做什麼？</譯文>
</翻譯>`;
    }

    // ── 5. HTML 卡片模式 ─────────────────────────────────
    const htmlActive = !!htmlMode?.enabled;
    if (htmlActive) {
        systemPrompt += `\n\n${buildHtmlPrompt(htmlMode?.customPrompt)}`;
    }

    // ── 6. 思考鏈提示詞 ───────────────────────────────────
    const thinkingActive = !!thinkingChain?.enabled;
    if (thinkingActive) {
        const userName = (userProfile?.name && userProfile.name.trim()) || '用戶';
        systemPrompt += `\n\n${buildThinkingChainPrompt(char.name, userName)}`;
        const extra = (thinkingChain?.customPrompt || '').trim();
        if (extra) {
            systemPrompt += `\n\n## 用戶對內心獨白的額外要求\n${extra}`;
        }
    }

    // ── 7. 歷史消息構造 ───────────────────────────────────
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        historyMsgsForPrompt,
        contextLimit,
        char,
        userProfile,
        emojis,
        undefined,
        { useVisionDescriptions, contextHighWaterMark },
    );

    // ── 8. 剝離歷史裡舊的雙語標籤（stripImages 時先壓平 image_url → 純文本佔位） ──
    const cleanedApiMessages = cleanApiMessages(input.stripImages ? flattenImageContentParts(apiMessages) : apiMessages);
    const resolvedWorldbookEntries = resolveWorldbookEntries(
        char.mountedWorldbooks || [],
        cleanedApiMessages,
        char.name,
        userProfile.name,
    );
    const messagesWithWorldbookDepth = injectWorldbookDepthEntries(
        cleanedApiMessages,
        resolvedWorldbookEntries.filter(entry => entry.position === 4),
    );

    // ── 9. 麥當勞小程序上下文（購物車/菜單實時快照 → 易變尾段） ──
    const mcdActive = !!mcdMiniSnap?.open;
    if (mcdActive) {
        const block = buildMcdMiniAppContextBlock(mcdMiniSnap, userProfile?.name || '用戶');
        if (block) {
            volatileTail += block;
        }
    }

    // ── 9b. 瑞幸小程序上下文（同上，易變尾段） ──
    const luckinActive = !!luckinMiniSnap?.open;
    if (luckinActive) {
        const block = buildLuckinMiniAppContextBlock(luckinMiniSnap, userProfile?.name || '用戶');
        if (block) {
            volatileTail += block;
        }
    }

    // ── 9c. 瑞幸聊天點單模式 (角色直接調真實工具；含實時定位/會話狀態 → 易變尾段) ──
    const luckinChatActive = !!luckinChat?.active;
    if (luckinChatActive) {
        const block = buildLuckinChatSystemBlock(luckinChat, recentMsgsHint, userProfile?.name || '用戶');
        if (block) {
            volatileTail += block;
        }
    }

    // ── 9d. 通用 MCP 工具模式 (用戶自配的遠程 MCP 服務器, 見 docs/mcp-client.md) ──
    // 工具清單來自持久化的發現結果，變化很慢 → 穩定段。
    //
    // 即時對話路徑：MCP 說明由 worker 的 buildMcpFireBlock 獨家供給（與憑據同源同拍），
    // 前端這份不注入——兩份工具說明兩套工具名，模型會兩種都寫一遍。
    // mcpChatActive 的取值不受影響：它還要告訴上層「這一輪算不算 MCP 模式」。
    const mcpChatActive = isMcpChatAvailable(char.id);
    if (mcpChatActive && !input.timelyByWorker) {
        const block = buildMcpSystemBlock(userProfile?.name || '用戶', char.id);
        if (block) {
            systemPrompt += block;
        }
    }

    // ── 10. recency 鋼印歸位 + 組裝 fullMessages ─────────
    // 本地語境分析只在 ChatApp 主回覆使用：它告訴主模型“這句話此刻在做什麼”，
    // 不指定具體記憶答案、不改變角色人格，也不進入其他 App 的專屬寫作提示。
    if (input.recallEntryPoint === 'chat_app') {
        volatileTail += renderLocalContextGuidance(recallTrace.contextAnalyzer);
        volatileTail += renderInteractionAdaptationGuidance(recallTrace.interactionAdaptation?.analysis);
        const engagementTrace = recallTrace.deepEngagement;
        if (engagementTrace?.engine === 'legacy_depth') {
            volatileTail += renderDeepEngagementGuidance(engagementTrace.analysis as DeepEngagementAnalysis | undefined);
        } else if (engagementTrace?.engine === 'conversation_v2') {
            // M3 核心原則常駐；分析結果只決定是否在後面追加當輪狀態策略。
            volatileTail += renderConversationEngagementGuidance(
                engagementTrace.analysis as ConversationEngagementAnalysis | undefined,
            );
        }
        if (char.chatCollaborationEnabled) {
            volatileTail += await loadCollaborationFileCabinetBlock(
                char.id,
                historyMsgsForPrompt,
                userProfile?.name || '用戶',
            );
        }
    }

    // 「關於對方的表達」+「回到你自己」必須是易變尾段的最後內容：修復舊版把雙語/HTML/
    // 思考鏈/點單塊拼在鋼印之後、模型開口前最後讀到的是格式說明書的問題。
    volatileTail += parts.recencyTail;
    if (sarModuleBlock) volatileTail += sarModuleBlock;

    // 結構：[穩定 system] + [歷史消息] + [易變狀態 system] (+ 末尾 reminder)。
    // 穩定前綴不再包含分鐘級時間戳等易變內容 → 支持前綴緩存的中轉能跨輪命中；
    // 易變狀態貼著生成點注入，時間/情緒/日程反而拿到最強 recency 注意力。
    // 注意：即時對話的 worker 端情緒評估把 messages[0] 當 system、messages[1..]
    // 展平為對話歷史 —— 易變尾段會以「[系統]: …」行出現在歷史末尾，信息不丟。
    const fullMessages: Array<{ role: string; content: any }> = [
        { role: 'system', content: systemPrompt },
        ...messagesWithWorldbookDepth,
        { role: 'system', content: volatileTail },
    ];
    if (bilingualActive) {
        fullMessages.push({
            role: 'system',
            content: sarEnvelopeActive
                ? `[Reminder: 最外層輸出 <SAR_MODULE_OUTPUT>；CHAR_TRUE 和 CHAR_SURFACE 內的每個氣泡都分別使用完整的 <翻譯><原文>...</原文><譯文>...</譯文></翻譯>，原文/譯文語義一致，一句一個標籤。]`
                : `[Reminder: 每句話必須用 <翻譯><原文>...</原文><譯文>...</譯文></翻譯> 標籤包裹。一句一個標籤。絕對不能省略。]`,
        });
    }
    if (mcpChatActive && !input.timelyByWorker) {
        fullMessages.push({ role: 'system', content: MCP_TAIL_REMINDER });
    }
    if (sarModuleBlock) {
        fullMessages.push({
            role: 'system',
            content: '[SAR MODULE REMINDER: 模塊是角色在彼方能感知、能記得的外來裝置，不是幕後文風要求；CHAR_TRUE 必須包含角色對異常的當下反應，不能若無其事。生效時最終只輸出 <SAR_MODULE_OUTPUT> 容器。聊天的 CHAR_TRUE / CHAR_SURFACE 必須逐氣泡對齊；純括號動作原位逐字複製，禁止刪泡、合併或新增氣泡。內置翻譯要在兩字段中分別保留完整翻譯標籤；語音要保留 <語音>/<字幕> 結構並同步改寫口播與字幕；“日文（中文翻譯）”一類同泡格式不可把括號譯文誤判成動作。真實語義寫 CHAR_TRUE，臨時外顯寫 CHAR_SURFACE，用戶外顯寫 USER_SURFACE，不得把外顯當作內心。]',
        });
    }

    if (sarModulePlan?.user?.phase === 'active') {
        fullMessages.push({ role: 'system', content: buildSARUserSurfaceRequest(
            selectSARUserSurfaceTargets(input.historyMsgs, char.id, sarModulePlan.user),
        ) });
    }

    // Dev 開關：多條 system 合併成開頭一條，A/B 對照中轉適配層對多 system 的計量行為。
    let finalMessages = fullMessages;
    if (isSystemMessageMergeEnabled()) {
        finalMessages = mergeSystemMessages(fullMessages);
        console.warn(`[DevDebug] Merge system messages: ${fullMessages.length} → ${finalMessages.length} messages (system ${fullMessages.length - finalMessages.length + 1} → 1).`);
    }

    return {
        // 返回給情緒評估 / 調試查看器的仍是"完整拼接"——信息與主 API 完全一致，
        // 只是主 API 的實際消息結構把易變尾段放在歷史之後（見上）。
        systemPrompt: systemPrompt + volatileTail,
        cleanedApiMessages: messagesWithWorldbookDepth,
        fullMessages: finalMessages,
        // 合併開關開著時多條 system 被並進開頭一條，下標失去意義 → 交出 -1，調用方退回貼尾。
        volatileTailIndex: finalMessages === fullMessages ? 1 + messagesWithWorldbookDepth.length : -1,
        recallTrace,
        flags: { bilingualActive, mcdActive, luckinActive, luckinChatActive, mcpChatActive, htmlActive, thinkingActive, sarModuleActive: !!sarModuleBlock, promptBuildSkipped: false },
    };
}
