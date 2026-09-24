import { sarPublicContext } from './vrWorld/kanataPublicContext';
import { kanataTitleContext } from './vrWorld/kanataTitle';
import { selectCharacterContextMessages } from './chatContextRange';

import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, DailySchedule, ImageGenApiConfig } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { formatLifeSimResetCardForContext } from './lifeSimChatCard';
import { formatQixiEventCardForContext, tryParseQixiEventChatCard } from './qixiChatCard';
import { normalizeMessageContent, stickerNameFromUrl, theaterWhenPhrase } from './messageFormat';
import { formatTransferRecord } from './transferFormat';
import { formatMallOrderRecord } from './mallOrderFormat';
import { computeCurrentListening, getCurrentSlot } from './charMusicSchedule';
import { getCharLyricSnippet } from './charLyricCache';
import { MusicCfg, loadMusicCfgStandalone } from '../context/MusicContext';
import { RealtimeContextManager, NotionManager, FeishuManager, defaultRealtimeConfig } from './realtimeContext';
import { isScheduleFeatureOn } from './scheduleFeature';
import { VOICE_ACTING_GUIDE } from './minimaxTts';
import { FISH_VOICE_ACTING_GUIDE } from './fishAudioTts';
import { getElevenLabsModel, getTtsProvider, getVoicePromptOverride } from './ttsProvider';
import { getElevenLabsVoiceActingGuide } from './elevenLabsTts';
import { resolveCharTimeZone, nowInTimeZone } from './timezone';
import { buildLifeRecordInjection } from './lifeRecords';
import { buildAnniversaryInjection } from './anniversary';
import { isWorkerReachableUrl } from './amsgToolPack';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { getCharNameById } from './charNameRegistry';
import { getLocalDateKey } from './localDate';
import { getDailyScheduleForChar } from './dailySchedule';
import { formatRelativeAge } from './groupChat/relativeTime';
import { isBlobRef } from './blobRef';
import { voiceLanguagePromptLabel } from './voiceLanguage';
import { buildAcquaintanceLine, buildRelationshipPrompt } from './chatRelationship';
import { buildDateInvitePrompt, formatDateInviteRecord } from './dateInvite';
import { buildCharCallPrompt, formatCharCallRecord } from './charCall';
import { buildCharDecidesPrompt, buildResumeAfterNoReplyNote, resolveReadNoReply } from './readNoReply';

// 語音格式指導按當前 TTS 服務商二選一：用 MiniMax 才注入 MiniMax 那套（含 <#秒#> 停頓標記），
// 用魚聲則注入魚聲版（去掉 MiniMax 專屬標記，改用標點 / 省略號控制停頓）。
// 用戶在「設置 → 其他 API → 語音提示詞」裡自定義過該服務商的指南時，優先用用戶那份；留空則回退內置默認。
const voiceActingGuide = (): string => {
  const provider = getTtsProvider();
  const custom = getVoicePromptOverride(provider);
  if (custom) return custom;
  if (provider === 'fishaudio') return FISH_VOICE_ACTING_GUIDE;
  if (provider === 'elevenlabs') return getElevenLabsVoiceActingGuide(getElevenLabsModel());
  return VOICE_ACTING_GUIDE;
};

/**
 * 這個值是「一張圖 / 一段媒體」而不是正文嗎？認三種形態：內嵌 data URL、http(s) 外鏈、
 * blobref 令牌（二進制在 IndexedDB，字段裡只留 `blobref:<id>` 短令牌，見 utils/blobRef.ts）。
 *
 * 令牌尤其要認：它只有 ~28 字，任何按長度截斷的兜底都攔不住它整條溜進 prompt；而發請求時
 * 網絡出口那層（utils/apiBlobRefs.ts）會把請求體裡的令牌統一還原成完整 data URL——
 * 於是一個短短的令牌到了對面就是幾 MB 的 base64，而且每輪對話重發一次。
 */
const isMediaValue = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    return /^(data:|https?:\/\/)/i.test(trimmed) || isBlobRef(trimmed);
};

// 群活動注入專用：把一條群消息壓成"適合塞進別人私聊背景"的短文本。
// 關鍵：image 消息的 content 是 blobref 令牌或 base64（群裡發圖走 processImage 壓成 JPEG，
// 單張幾十 KB），卡片是大段 JSON，emoji 是令牌或圖床 URL——這些原樣內聯進每位成員的私聊 system prompt
// 都是純噪聲，base64 圖片更會把上下文直接撐爆（幾張群圖就能頂到 8w+ 字符，
// 解散群后該角色私聊上下文從 ~10w 掉回 ~3w 即由此而來）。
// 注意：私聊自己的歷史不會有這個問題，buildMessageHistory 把圖片走 image_url 結構化字段、
// 文本里只留 [User sent an image] 標記；這裡只是把同樣的"不要把媒體當文本塞"對齊到群注入。
// 處理方式：只內聯純文本（超長截斷），其餘一律佔位符。
const GROUP_MSG_TEXT_CAP = 500;
function summarizeGroupMsgContent(m: Message): string {
    const meta = (m.metadata as any) || {};
    switch (m.type) {
        case 'image': return '[圖片]';
        case 'emoji': return '[表情]';
        case 'interaction': return '[戳了戳]';
        // 轉帳保持輕佔位符, 不遷 [[記錄:TRANSFER]] —— 這裡是別人對話的背景敘述, 整片都是
        // [圖片]/[表情] 式短佔位, 混重型 tag 破壞局部一致; 對它的模仿 transferFormat 的
        // BARE_TRANSFER_RE 兜得住。
        case 'transfer': return `[轉帳${meta.amount ?? ''}]`;
        case 'social_card': return `[分享帖子${meta.post?.title ? '：' + meta.post.title : ''}]`;
        case 'chat_forward': return '[轉發的聊天記錄]';
        case 'xhs_card': return '[小紅書筆記]';
        case 'score_card': return '[評分卡]';
        case 'music_card': return '[分享音樂]';
        case 'mcd_card': return '[麥當勞點餐]';
        case 'html_card': return '[HTML卡片]';
        case 'news_card': return '[新聞卡片]';
        case 'trpg_card': return `[TRPG遊戲片段${meta.trpg?.gameTitle ? '：《' + meta.trpg.gameTitle + '》' : ''}]`;
        case 'novel_card': return `[筆友會小說章節${meta.novel?.bookTitle ? '：《' + meta.novel.bookTitle + '》' : ''}]`;
        case 'world_card': return `[家園生活記錄${meta.worldName ? '：' + meta.worldName : ''}]`;
        case 'sim_card': return `[一段回憶${meta.simCard?.theme ? '：' + meta.simCard.theme : ''}]`;
        case 'phone_card': return `[手機內容${meta.phoneCard?.title ? '：' + meta.phoneCard.title : ''}]`;
        case 'group_topic_card': return `[群聊公共話題盒${meta.groupTopicBox?.title ? '：' + meta.groupTopicBox.title : ''}] ${meta.groupTopicBox?.summary || m.content || ''}`;
        default: {
            const c = typeof m.content === 'string' ? m.content : '';
            // 兜底：任何 data:/http(s) 鏈接、blobref 令牌都不內聯，防止異常/未來新增類型漏網
            // （令牌內聯出去還會在網絡出口被還原成完整 data URL，比原樣漏一個 URL 貴得多）
            if (isMediaValue(c)) return '[媒體]';
            return c.length > GROUP_MSG_TEXT_CAP ? c.slice(0, GROUP_MSG_TEXT_CAP) + '…' : c;
        }
    }
}

export type ChatModeTransition = 'call' | 'video' | 'date' | 'story';

const getChatModeTransition = (message: Message): ChatModeTransition | null => {
    const source = message.metadata?.source;
    if (source === 'date') return 'date';
    if (source === 'story_theater' || source === 'story_theater_memory') return 'story';
    if (source === 'call' || source === 'call-end-popup') {
        return message.metadata?.callMode === 'video' ? 'video' : 'call';
    }
    return null;
};

/**
 * 判斷當前是不是「從特殊互動模式回到 ChatApp 後，尚未產生普通聊天回覆」的第一輪。
 *
 * 用戶可能連續發送多個氣泡再點生成，所以普通 user 消息不會截斷搜索；一旦已經出現
 * 普通 assistant 回覆，就說明格式切換已經完成，不應在後續每一輪重複提醒。
 * 普通 system 日誌也不參與判斷，避免掛斷卡片與其他後台提示把真正的來源隔開。
 */
export const detectChatModeTransition = (messages: readonly Message[]): ChatModeTransition | null => {
    let hasPendingChatInput = false;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const mode = getChatModeTransition(message);
        if (mode) return hasPendingChatInput ? mode : null;

        if (message.role === 'assistant') return null;
        if (message.role === 'user') hasPendingChatInput = true;
    }

    return null;
};

/**
 * buildSystemPrompt / buildSystemPromptParts 的構建選項。
 *
 * `forFirePack` = 這份 prompt 是給主動消息打包的：模板在最後一次聊天時打好，到點才渲染。
 * 「打包這一刻」的狀態到觸發時早就過期了，所以下面這些塊一律不烤進去——
 *
 * | 塊 | 不烤的原因 | 到點誰來補 |
 * |---|---|---|
 * | 「現在是 X」時間塊 | 打包時刻的鐘，到點已過期 | worker 填 AMSG_SLOT_CURRENT_TIME |
 * | 【真實世界感知系統】（今日節日 / 天氣 / 熱搜） | 全是打包那天那一刻的，跨天說錯節日、大晴天叫人帶傘、同一批舊聞反覆當「最近真實發生」 | worker 填 AMSG_SLOT_REALTIME_WORLD（到點自己去拉一次） |
 * | 日程當前時段 + 此刻在聽的歌 | 3am 觸發會說「我在健身房呢」 | worker 填 AMSG_SLOT_SCENE（隨包帶整天作息表現算） |
 * | 「你剛剛和對方結束了一通電話 / 見面」 | 打包時剛掛電話，到點可能是第二天凌晨 | 不補 |
 * | 「用戶此刻也在《彼方》裡」 | 說的是用戶當下掛在哪個房間，人下線幾小時后角色還在說「看你小人掛在聽歌房」 | 不補（worker 夠不著用戶此刻的彼方狀態） |
 * | 群聊背景的「約 X 分鐘前」 | 打包時的「剛才」到點變成昨天 | 保留絕對時間戳 |
 * | 生活記錄的代記工具說明 | 後台沒有用戶新說的話，記下來的一定是重複或臆造 | 不補（摘要數據仍保留） |
 * | `[schedule_message]` 教學 | 排的是瀏覽器裡的本地定時消息，App 關著沒人派發 | worker 追加自己的排程工具說明 |
 */
export interface PromptBuildOptions {
    forFirePack?: boolean;
    /** 主 API 從完整數據庫歷史識別出的「剛從哪種模式回到 ChatApp」。 */
    returningFromMode?: ChatModeTransition;
    /**
     * `timelyByWorker` = 這份 prompt 會交給 amsg worker 在 fire 時刻補時效段
     * （即時對話路徑）。與 forFirePack 的區別：只裁「worker 那邊有對應槽位」的
     * 時效塊——當前時間塊、【真實世界感知系統】（節日/天氣/熱搜）；本地私有的
     * 易變段（召回/buff/音樂/日程/群聊/彼方）照常保留，它們在發送時刻是新鮮的，
     * 而 worker 拿不到。不裁的話，模型會在一份 prompt 裡看到兩個鍾、兩份互不
     * 重疊的熱搜（前端快照版 + worker 現拉版），且兩段都自稱「來自真實世界」。
     * `[schedule_message]` 教學是否保留還要看角色的 2.0 開關，見下方
     * scheduleMessageTagEnabled 處的說明。
     */
    timelyByWorker?: boolean;
    /**
     * 「系統設置 → 生圖API」的配置。只有 charImageGenEnabled + charImageSendEnabled 都開、
     * 且 baseUrl/model 配完整時，才會教角色 `[[ACTION:SEND_PHOTO|畫面描述]]` 這個動作
     * （見下方「可用動作」）；執行側在 utils/chatParser.ts。調用方（chatRequestPayload）
     * 只在本地/前台聊天路徑傳這個字段——主動消息 2.0 的 fire_pack 模板（activeMsgClient.ts）
     * 故意不傳，避免雲端 worker 生成的正文裡出現一個客戶端接不住的標籤。
     */
    imageGenConfig?: ImageGenApiConfig;
}

export const ChatPrompts = {
    // 格式化時間戳（tz 非空時按該時區折算牆上時間，用於自定義時區角色）
    formatDate: (ts: number, tz?: string) => {
        const d = nowInTimeZone(tz, new Date(ts));
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    },

    // 格式化時間差提示（tz 影響「深夜/清晨」判斷，時差本身不變）
    getTimeGapHint: (lastMsg: Message | undefined, currentTimestamp: number, tz?: string): string => {
        if (!lastMsg) return '';
        const diffMs = currentTimestamp - lastMsg.timestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const currentHour = nowInTimeZone(tz, new Date(currentTimestamp)).getHours();
        const isNight = currentHour >= 23 || currentHour <= 6;
        if (diffMins < 10) return ''; 
        if (diffMins < 60) return `[系統提示: 距離上一條消息: ${diffMins} 分鐘。短暫的停頓。]`;
        if (diffHours < 6) {
            if (isNight) return `[系統提示: 距離上一條消息: ${diffHours} 小時。現在是深夜/清晨。沉默是正常的（正在睡覺）。]`;
            return `[系統提示: 距離上一條消息: ${diffHours} 小時。用戶離開了一會兒。]`;
        }
        if (diffHours < 24) return `[系統提示: 距離上一條消息: ${diffHours} 小時。很長的間隔。]`;
        const days = Math.floor(diffHours / 24);
        return `[系統提示: 距離上一條消息: ${days} 天。用戶消失了很久。請根據你們的關係做出反應（想念、生氣、擔心或冷漠）。]`;
    },

    // 按角色可見性過濾表情包分類與表情。
    // 規則與 Chat.tsx 的 visibleCategories / aiVisibleEmojis 保持一致：
    // 分類未設 allowedCharacterIds（或為空）= 所有角色可見；否則只有名單內角色可見。
    // 表情若屬於一個對該角色不可見的分類，則一併隱藏（無 categoryId 的表情始終可見）。
    // 主動消息（proactive）等不經過 Chat.tsx UI 的路徑必須複用本函數，
    // 否則角色會在主動消息裡用到不屬於自己範圍的表情包。
    filterVisibleEmojis: (
        emojis: Emoji[],
        categories: EmojiCategory[],
        charId: string,
    ): { emojis: Emoji[]; categories: EmojiCategory[] } => {
        const visibleCategories = categories.filter(cat => {
            if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;
            return cat.allowedCharacterIds.includes(charId);
        });
        const hiddenIds = new Set(
            categories.filter(c => !visibleCategories.some(vc => vc.id === c.id)).map(c => c.id),
        );
        const visibleEmojis = hiddenIds.size === 0
            ? emojis
            : emojis.filter(e => !e.categoryId || !hiddenIds.has(e.categoryId));
        return { emojis: visibleEmojis, categories: visibleCategories };
    },

    // 構建表情包上下文
    buildEmojiContext: (emojis: Emoji[], categories: EmojiCategory[]) => {
        if (emojis.length === 0) return '無';
        
        const grouped: Record<string, string[]> = {};
        const catMap: Record<string, string> = { 'default': '通用' };
        categories.forEach(c => catMap[c.id] = c.name);
        
        emojis.forEach(e => {
            const cid = e.categoryId || 'default';
            if (!grouped[cid]) grouped[cid] = [];
            grouped[cid].push(e.name);
        });
        
        return Object.entries(grouped).map(([cid, names]) => {
            const cName = catMap[cid] || '其他';
            return `${cName}: [${names.join(', ')}]`;
        }).join('; ');
    },

    // 構建 System Prompt（拼接版，給主動消息等單串消費方；聊天主路徑用 buildSystemPromptParts）
    buildSystemPrompt: async (
        char: CharacterProfile,
        userProfile: UserProfile,
        groups: GroupProfile[],
        emojis: Emoji[],
        categories: EmojiCategory[],
        currentMsgs: Message[],
        realtimeConfig?: RealtimeConfig,
        evolvedNarrative?: string,
        userListeningContext?: {
            songName: string;
            artists: string;
            lyricWindow: string[];
            activeIdx: number;
        } | null,
        isListeningTogether?: boolean,
        musicCfg?: MusicCfg,
        promptOptions?: PromptBuildOptions,
    ): Promise<string> => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            char, userProfile, groups, emojis, categories, currentMsgs,
            realtimeConfig, evolvedNarrative, userListeningContext, isListeningTogether, musicCfg,
            undefined, promptOptions,
        );
        return parts.stable + parts.volatileState + parts.recencyTail;
    },

    /**
     * 構建 System Prompt —— 三段式。
     *
     * - stable：人設/世界書/印象/記憶庫/行為規範/語音等「幾輪甚至幾天不變」的內容。
     *   作為消息數組第一條 system。前綴穩定 → 支持前綴緩存的中轉能命中 prompt cache，
     *   幾萬 token 的 prefill 不用每輪重算（TTFT 直降）。
     * - volatileState：當前時間（分鐘級）/宮殿召回/情緒 buff/實時天氣/日程/音樂/群聊背景等
     *   「每輪都變」的狀態。調用方放到**歷史消息之後**的 system 消息裡 —— 既不打斷緩存前綴，
     *   又吃到 recency 注意力（時間/情緒本來就該離生成點近）。
     * - recencyTail：總綱「關於對方的表達」+「回到你自己」鋼印。必須是模型開口前讀到的
     *   最後內容 —— 調用方要保證任何模式塊（雙語/HTML/思考鏈/點單等）都拼在它**前面**。
     */
    buildSystemPromptParts: async (
        char: CharacterProfile,
        userProfile: UserProfile,
        groups: GroupProfile[],
        emojis: Emoji[],
        categories: EmojiCategory[],
        currentMsgs: Message[],
        realtimeConfig?: RealtimeConfig,  // 實時配置
        evolvedNarrative?: string,        // 進化後的意識流獨白
        userListeningContext?: {
            songName: string;
            artists: string;
            lyricWindow: string[];
            activeIdx: number;
        } | null,
        // char 是否和 user 處於"一起聽"狀態（來自 MusicContext.listeningTogetherWith）。
        // 影響氛圍措辭和互動工具提示；暫停/切歌/user 踢出都會讓這個值變 false。
        isListeningTogether?: boolean,
        // MusicContext 的 cfg —— 用來給 char 自己的"此刻在聽"拉穩定的歌詞片段。
        // 不傳也能用，只是 char 的 block 2 只有歌名 + 藝人，沒有歌詞。
        musicCfg?: MusicCfg,
        // 剛才一起聽途中歌被切了（char 還沒重新加入）—— 注入"察覺換歌"提示。
        recentTrackSwitch?: { songName: string; artists: string } | null,
        promptOptions?: PromptBuildOptions,
    ): Promise<{ stable: string; volatileState: string; recencyTail: string }> => {
        // 主動消息的模板是最後一次聊天時打好、到點才渲染的，凡是「打包這一刻」的狀態
        // 到觸發時都已經過期，一律不烤進模板。見 PromptBuildOptions 的清單。
        const forFirePack = promptOptions?.forFirePack === true;
        // 即時對話：這一輪交給 worker 生成，時鐘和真實世界塊由它在 fire 時刻補。
        // 本地私有的易變段照常烤進去（worker 拿不到，而這一刻它們是新鮮的）。
        const timelyByWorker = promptOptions?.timelyByWorker === true;
        // ── 分段計時（定位瓶頸用）──
        const perfT0 = performance.now();
        const timings: Record<string, number> = {};
        const timed = async <T>(label: string, p: Promise<T>): Promise<T> => {
            const t0 = performance.now();
            try { return await p; }
            finally { timings[label] = Math.round(performance.now() - t0); }
        };

        // 記憶宮殿檢索結果現在從 char.memoryPalaceInjection 讀取。
        // deferVolatile：時間/宮殿召回/情緒 buff 三塊不進 stable，由下面的 volatileState 承接。
        const coreT0 = performance.now();
        let baseSystemPrompt = ContextBuilder.buildCoreContext(
            char,
            userProfile,
            true,
            undefined,
            undefined,
            { worldbookMessages: currentMsgs },
            { deferVolatile: true },
        );
        timings.buildCoreContext = Math.round(performance.now() - coreT0);
        // 聊天設定頁的稱呼與關係：很少變，放穩定段
        baseSystemPrompt += buildRelationshipPrompt(char, userProfile.name);
        // 聊天設定 · 自動線下邀請：開著才教 DATE_INVITE 標籤（見 utils/dateInvite.ts）
        if (char.dateInvite) baseSystemPrompt += buildDateInvitePrompt(userProfile.name);
        // 聊天設定 · 允許角色主動打電話／視訊（見 utils/charCall.ts）
        if (char.charCall) baseSystemPrompt += buildCharCallPrompt(userProfile.name);

        // ── 易變狀態段（volatileState）──
        // 開頭一行框定，讓模型明白這條出現在歷史之後的 system 消息是"此刻的狀態"，
        // 人設與規則仍以最上方的系統設定為準。
        let volatileState = `\n[System: 實時狀態 (Live Context)]\n（以下是此刻的實時狀態——當前時間、你正在做的事、你的情緒底色、周邊動態。你的人設與聊天規則見最上方的系統設定，此處不再重複。）\n\n`;
        volatileState += ContextBuilder.buildVolatileCoreState(char, {
            includeDetailedMemories: true,
            // conversational：私聊是真的有人在這個點跟角色說話，時間塊才補那句語境框定
            // （見 ContextBuilder.buildTimeAwarenessBlock）。生成器類調用不給，默認就沒有。
            timeOptions: { skipTimeAwareness: forFirePack || timelyByWorker, conversational: true },
        });

        // ── 併發發起所有獨立的異步取數（網絡 + IndexedDB），下面按原順序拼接 ──
        // 原來是 7 段串行 await，總耗時 = 各段之和；現在取 max。
        const config = realtimeConfig || defaultRealtimeConfig;
        // 自定義時區：日曆日、當前日程與實時上下文全部按角色所在地折算。
        const charTz = resolveCharTimeZone(char);
        const charNow = nowInTimeZone(charTz);
        const today = getLocalDateKey(charNow);

        // 1. 實時世界信息（天氣/新聞/時間）
        //
        // fire_pack 整塊不要：這一段裡從時間、節日、天氣到熱搜全是打包那一刻的讀數，
        // 而且抬頭寫著「⚠️ 以下信息來自真實世界」，措辭比任何免責聲明都硬——跨時段觸發時
        // 角色會照著一份過期的世界說話（大晴天叫人帶傘、第二天還在祝七夕快樂、
        // 同一批舊聞當成「最近真實發生」說三遍）。
        //
        // 主動消息不是因此就沒有這一段：模板裡留著 AMSG_SLOT_REALTIME_WORLD，worker 到點
        // 自己去拉一次天氣熱搜、按角色時區判今天是不是節日，再填進去（見 worker/amsg 的
        // realtimeWorld）。兩邊的取數與措辭都來自 realtimeWorldCore，是同一份。
        //
        // 即時對話（timelyByWorker）同理：這一輪的回覆也在 worker 上生成，它那邊照樣會
        // 現拉一次天氣熱搜、按角色時區判節日。前端這份留著就是兩份互不重疊的熱搜、
        // 兩句自稱「來自真實世界」——包括天氣熱搜關掉時那條「今日特殊」節日兜底，
        // worker 的 realtimeWorld 裡也有它（同樣跟著角色的時間感知開關走）。
        const realtimePromise: Promise<string> = (async () => {
            if (forFirePack || timelyByWorker) return '';
            try {
                if (config.weatherEnabled || config.newsEnabled) {
                    // 時間行跟著角色的「時間感知」開關走：關掉的角色不該從天氣塊裡讀到
                    // 「當前真實時間」，那是這個開關本來要擋住的東西。
                    const realtimeContext = await RealtimeContextManager.buildFullContext(config, charTz, {
                        includeTime: char.timeAwarenessEnabled !== false,
                    });
                    return `\n${realtimeContext}\n`;
                }
                // 基礎當前時間 + 時差提示已由 ContextBuilder.buildCoreContext 統一注入（受 timeAwarenessEnabled
                // 控制，按角色自定義時區折算）；這裡只在關閉天氣/新聞時補一條"今日特殊節日"，不再重複注入時間/時差，避免雙份。
                const specialDates = RealtimeContextManager.checkSpecialDates(charTz);
                if (specialDates.length > 0 && char.timeAwarenessEnabled !== false) {
                    return `\n### 【今日特殊】\n${specialDates.join('、')}\n`;
                }
                return '';
            } catch (e) {
                console.error('Failed to inject realtime context:', e);
                return '';
            }
        })();

        // 2. 日程（被"日程注入"和"音樂氛圍"兩處共用，合併成一次查詢）
        //    總開關關閉時跳過查詢與注入，確保不額外調用任何 LLM 依賴鏈
        const scheduleFeatureOn = isScheduleFeatureOn(char);
        const schedulePromise: Promise<DailySchedule | null> = scheduleFeatureOn
            ? getDailyScheduleForChar(char).catch(e => {
                console.error('Failed to load daily schedule:', e);
                return null;
            })
            : Promise.resolve(null);

        // 3. 群聊上下文：併發拉取所有成員群的消息
        // 關鍵：每個群單獨取最後 N 條，避免某個活躍群把其他群完全擠掉
        // （之前是把所有群消息混合後切前 200 條，活躍群會吃光配額，安靜群完全不出現）
        const groupContextPromise: Promise<string> = (async () => {
            try {
                const memberGroups = groups.filter(g => g.members.includes(char.id));
                if (memberGroups.length === 0) return '';
                const perGroup = await Promise.all(
                    memberGroups.map(g => DB.getGroupMessages(g.id).then(msgs => ({
                        groupName: g.name,
                        cap: g.privateContextCap ?? 80,
                        // 已經進入公共話題盒的舊原文不再重複塞進私聊背景；成盒時送達的
                        // group_topic_card 會沿私聊自身的歷史/歸檔鏈繼續被角色感知。
                        msgs: msgs.filter(m => m.id > (g.archivedThroughMessageId || 0)),
                    })))
                );
                const allGroupMsgs: (Message & { groupName: string })[] = [];
                for (const { groupName, cap, msgs } of perGroup) {
                    for (const m of msgs.slice(-cap)) allGroupMsgs.push({ ...m, groupName });
                }
                allGroupMsgs.sort((a, b) => a.timestamp - b.timestamp);
                const recentGroupMsgs = allGroupMsgs;
                if (recentGroupMsgs.length === 0) return '';
                // 發言人標真實名字：匿名成 Member 會讓角色分不清哪句是誰說的、
                // 甚至認不出自己的發言，私聊被問起群裡的事就接不住。
                const speakerOf = (m: Message): string => {
                    if (m.role === 'user') return userProfile.name;
                    if (m.charId === char.id) return `你（${char.name}）`;
                    return getCharNameById(m.charId) || '群友';
                };
                const groupLogStr = recentGroupMsgs.map(m => {
                    // 時間戳按角色所在時區讀：同一份 prompt 裡私聊歷史用的就是角色的鐘
                    // （下面 buildMessageHistory 走 formatDate(ts, charTz)），群聊這行要是
                    // 跟著設備走，紐約角色會看到兩套時間。
                    const dateStr = ChatPrompts.formatDate(m.timestamp, charTz);
                    // 「約 X 分鐘前」是相對打包時刻算的，fire_pack 到點渲染時早就不是那個「剛才」了
                    // ——角色會把昨天的群聊說成「剛才群裡說晚上一起吃飯」。絕對時間戳留著，角色
                    // 自己對著當前時間就能判斷遠近。
                    const relativeAge = forFirePack ? '' : ` · ${formatRelativeAge(m.timestamp)}`;
                    return `[${dateStr}${relativeAge}] [群：${m.groupName}] ${speakerOf(m)}: ${summarizeGroupMsgContent(m)}`;
                }).join('\n');
                return `\n### 【群聊背景 · 你親歷的近期群聊】
（以下是你所在群裡最近的真實聊天記錄，按時間排序，發言人已標註；標「你」的就是你自己說的話。這些事你都親身經歷、記得清楚——私聊裡對方問起或話題相關時，自然地接上就好，不要裝作不知道；也不必刻意逐條彙報群裡的動靜。）
${groupLogStr}\n`;
            } catch (e) {
                console.error("Failed to load group context", e);
                return '';
            }
        })();

        // 4. Notion 日記標題
        const notionDiaryPromise: Promise<string> = (async () => {
            try {
                if (!(config.notionEnabled && config.notionApiKey && config.notionDatabaseId)) return '';
                const r = await NotionManager.getRecentDiaries(config.notionApiKey, config.notionDatabaseId, char.name, 8);
                if (!r.success || r.entries.length === 0) return '';
                let s = `\n### 📔【你最近寫的日記】\n`;
                s += `（這些是你之前寫的日記，你記得這些內容。如果想看某篇的詳細內容，可以使用 [[READ_DIARY: 日期]] 翻閱）\n`;
                r.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                s += `\n`;
                return s;
            } catch (e) {
                console.error('Failed to inject diary context:', e);
                return '';
            }
        })();

        // 5. 飛書日記標題
        const feishuDiaryPromise: Promise<string> = (async () => {
            try {
                if (!(config.feishuEnabled && config.feishuAppId && config.feishuAppSecret && config.feishuBaseId && config.feishuTableId)) return '';
                const r = await FeishuManager.getRecentDiaries(config.feishuAppId, config.feishuAppSecret, config.feishuBaseId, config.feishuTableId, char.name, 8);
                if (!r.success || r.entries.length === 0) return '';
                let s = `\n### 📒【你最近寫的日記（飛書）】\n`;
                s += `（這些是你之前寫的日記，你記得這些內容。如果想看某篇的詳細內容，可以使用 [[FS_READ_DIARY: 日期]] 翻閱）\n`;
                r.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                s += `\n`;
                return s;
            } catch (e) {
                console.error('Failed to inject feishu diary context:', e);
                return '';
            }
        })();

        // 6. 用戶 Notion 筆記標題
        const notionNotesPromise: Promise<string> = (async () => {
            try {
                if (!(config.notionEnabled && config.notionApiKey && config.notionNotesDatabaseId)) return '';
                const r = await NotionManager.getUserNotes(config.notionApiKey, config.notionNotesDatabaseId, 5);
                if (!r.success || r.entries.length === 0) return '';
                let s = `\n### 📝【${userProfile.name}最近寫的筆記】\n`;
                s += `（這些是${userProfile.name}在Notion上寫的個人筆記。你可以偶爾自然地提到你看到了ta寫的某篇筆記，表示關心，但不要每次都提，也不要顯得在監視。如果想看某篇的詳細內容，可以使用 [[READ_NOTE: 標題關鍵詞]] 翻閱）\n`;
                r.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                s += `\n`;
                return s;
            } catch (e) {
                console.error('Failed to inject user notes context:', e);
                return '';
            }
        })();

        // 7. 生活記錄（檔案 App）注入 — 總開關關閉時 buildLifeRecordInjection 直接返回 ''
        //    fire_pack 只要摘要數據，不要代記工具說明：後台生成時用戶沒在說話，那時候
        //    輸出的 [[LIFE:...]] 只可能是把歷史裡早就記過的事再記一遍。
        const lifeRecordPromise: Promise<string> = buildLifeRecordInjection(char, userProfile.name, { forFirePack })
            .catch(e => {
                console.error('Failed to inject life record context:', e);
                return '';
            });

        // 8. 時光契約「讓 TA 記住這一天」：按角色當地日期挑出近幾天的紀念日。
        const anniversaryPromise: Promise<string> = (async () => {
            try {
                return buildAnniversaryInjection(await DB.getAllAnniversaries(), char.id, today, { forFirePack });
            } catch (e) {
                console.error('Failed to inject anniversary context:', e);
                return '';
            }
        })();

        const [realtimeText, schedule, groupContextText, notionDiaryText, feishuDiaryText, notionNotesText, lifeRecordText, anniversaryText] =
            await Promise.all([
                timed('realtime', realtimePromise),
                timed('schedule', schedulePromise),
                timed('groupCtx', groupContextPromise),
                timed('notionDiary', notionDiaryPromise),
                timed('feishuDiary', feishuDiaryPromise),
                timed('notionNotes', notionNotesPromise),
                timed('lifeRecord', lifeRecordPromise),
                timed('anniversary', anniversaryPromise),
            ]);

        // ── 拼接：易變的進 volatileState，穩定的進 baseSystemPrompt ──
        volatileState += realtimeText;

        // 2a. 日程注入（完整今日日程 + 當前時段 + 意識流獨白，每輪都可能變）
        //     fire_pack 不烤：改由 worker 到點用 AMSG_SLOT_SCENE 現挑時段（見 amsgFireScene）。
        //     includeClock 跟著角色的「時間感知」開關走：關掉的角色不該從日程塊裡讀到
        //     「23:00」這種精確鐘點，那是這個開關本來要擋住的東西（同上面天氣塊的 includeTime）。
        //     日程本身照給——它有自己的總開關。
        if (schedule && !forFirePack) {
            try {
                const scheduleContext = ContextBuilder.buildScheduleInjection(
                    schedule,
                    evolvedNarrative,
                    charNow,
                    {
                        includeFullDay: true,
                        includeChangeInstruction: true,
                        includeClock: char.timeAwarenessEnabled !== false,
                    },
                );
                if (scheduleContext) volatileState += `\n${scheduleContext}\n`;
            } catch (e) {
                console.error('Failed to inject schedule context:', e);
            }
        }

        // 2a'. 已讀不回（聊天設定 · Scenario）。強制的那種在 triggerAI 就攔下了、不會走到這裡；
        //      「由角色決定」時把忙碌狀況告訴角色，讓它選擇回或不回（不回輸出 NO_REPLY 標籤）。
        //      上一則是自動回覆的，這次真的回覆前提醒角色「你剛才沒回」。主動消息是角色自己開口，不適用。
        if (!forFirePack) {
            if (char.readNoReply?.enabled) {
                const noReply = resolveReadNoReply(char.readNoReply, getCurrentSlot(schedule, charNow), charNow);
                if (noReply?.mode === 'charDecides') volatileState += buildCharDecidesPrompt(noReply, !!char.readNoReply.aiGenerated);
            }
            const lastAssistant = [...currentMsgs].reverse().find(m => m.role === 'assistant');
            volatileState += buildResumeAfterNoReplyNote(lastAssistant?.metadata);
        }

        // 2b. 音樂氛圍（複用同一份 schedule）
        //     - 同步：從 schedule 裡算 char 當前"正在聽"哪首歌
        //     - 異步（可選）：拉一段歌詞片段讓這首歌真能影響 char 心境
        //     fire_pack 不烤：這首歌是按打包時刻的時段抽的，跟日程一起挪到 AMSG_SLOT_SCENE。
        //     那邊只渲染「你此刻在聽什麼」一句——一起聽狀態要讀用戶此刻的播放器、歌詞要拉網絡，
        //     worker 兩樣都夠不著。
        if (!forFirePack) try {
            let charListening: {
                songId?: number; songName: string; artists: string; vibe?: string; lyricSnippet?: string[];
            } | null = null;
            try {
                const cur = computeCurrentListening(char, schedule);
                if (cur) {
                    charListening = { songId: cur.songId, songName: cur.songName, artists: cur.artists, vibe: cur.vibe };
                    // 拉歌詞。優先用調用方傳進來的 cfg；沒傳就從 localStorage 取
                    // —— Proactive / activeMsgClient 走這條路也能享受到歌詞。
                    const cfgForLyric = musicCfg ?? loadMusicCfgStandalone();
                    if (cfgForLyric) {
                        try {
                            const slot = getCurrentSlot(schedule, charNow);
                            const seed = `${char.id}-${today}-${slot?.startTime || '00:00'}-${cur.songId}`;
                            const snippet = await getCharLyricSnippet(cfgForLyric, cur.songId, seed, 6);
                            if (snippet.length > 0) charListening.lyricSnippet = snippet;
                        } catch { /* 歌詞失敗不攔住主 prompt */ }
                    }
                }
            } catch { /* 靜默失敗，不影響主 prompt */ }

            const musicBlock = ContextBuilder.buildMusicAtmosphere(
                char,
                userProfile.name,
                userListeningContext || null,
                charListening,
                isListeningTogether,
                recentTrackSwitch,
            );
            if (musicBlock) {
                volatileState += `\n${musicBlock}\n`;
                if (userListeningContext) {
                    volatileState += `\n${ContextBuilder.buildMusicActionGuide(isListeningTogether)}\n`;
                }
            }
        } catch (e) {
            console.error('Failed to inject music atmosphere:', e);
        }

        // 群聊背景帶時間戳、隨群消息實時滾動 → 易變；日記標題/生活記錄變化很慢 → 穩定。
        // 紀念日每天都在變（今天／明天／幾天後），放易變段，別弄髒穩定段的快取。
        volatileState += groupContextText;
        volatileState += anniversaryText;
        // 相識天數每天在變，放易變段；主動消息模板到點才渲染，天數會過期，只給起點日期
        if (char.acquaintanceStartDate) {
            volatileState += forFirePack
                ? `\n（你和${userProfile.name}從 ${char.acquaintanceStartDate} 開始認識。）\n`
                : buildAcquaintanceLine(char.acquaintanceStartDate, today, userProfile.name);
        }
        baseSystemPrompt += notionDiaryText;
        baseSystemPrompt += feishuDiaryText;
        baseSystemPrompt += notionNotesText;
        baseSystemPrompt += lifeRecordText;

        // 彼方常駐設定：僅對啟用了「彼方」的角色注入。讓角色在聊天裡始終知道彼方是什麼，
        // 不再依賴累積的 vr_card 動態 / 記憶總結（那些會被壓縮、丟掉"彼方=VR遊戲"的框定，
        // 導致角色把"彼方·留言簿"之類當成現實地名）。措辭與 vrWorld/prompts.ts 的世界觀一致。
        if (char.vrState?.enabled) {
            if (!forFirePack) volatileState += `\n${kanataTitleContext(char.vrState.title)}\n`;
            baseSystemPrompt += `\n### 關於《彼方》
《彼方》是一款真實存在、你會親自進入去玩的 VR 社交遊戲（功能上類似 VRChat）：你用自己親手捏的 Q 版化身在裡頭走動、進出圖書館 / 聽歌房 / 留言簿 / 娛樂室 / 郵局 / SAR 活動室等房間、撞見別的玩家（其他角色的化身）。這不是做夢或比喻；實際參與時，經歷發生在遊戲世界裡，和你跟用戶的現實相處是兩碼事、互不衝突。你以符合自身身份與世界觀的方式進入並理解它——怎麼進去全憑你自己的設定，但始終保持你本來的身份。聊到彼方里的經歷（包括"彼方·留言簿""彼方·動態"之類的記錄）時，就當成"我在《彼方》裡做過的事"來講，別說成現實裡發生的。\n`;

            baseSystemPrompt += `${sarPublicContext()}\n`;

            // 用戶本人也接入了彼方時，告訴（同樣啟用彼方的）角色"用戶此刻在彼方做什麼"。
            // 強調這只是虛擬空間的掛機狀態，不代表用戶本人真的在場——避免角色據此誤判現實。
            // 注意：用戶登出（vrState.enabled=false）後這段自然不再注入。
            // 用戶所在房間/狀態實時變 → 進 volatileState（《彼方》是什麼的框定仍留在穩定段）。
            // 打包時不注入：這一段說的是「用戶此刻掛在哪個房間」，烤進模板之後，用戶下線
            // 好幾個小時了角色還在說「看你小人掛在聽歌房」。它沒有對應的到點槽位——
            // worker 夠不著用戶此刻的彼方狀態，所以是「不補」的那一類。
            const uv = forFirePack ? null : userProfile?.vrState;
            if (uv?.enabled) {
                const VR_ROOM_NAMES: Record<string, string> = {
                    library: '圖書館', music: '聽歌房', guestbook: '留言簿', gym: '娛樂室', postoffice: '郵局', sar: 'SAR 活動室', cafe: '糯米雞研發中心',
                };
                const roomName = VR_ROOM_NAMES[uv.currentRoom || ''] || '彼方';
                const act = (uv.activity || '').trim();
                const uname = userProfile?.name || '用戶';
                volatileState += `\n### ${uname} 此刻也在《彼方》裡
${uname} 的化身正掛在《彼方》的【${roomName}】${act ? `，狀態寫著：「${act}」` : ''}。在彼方里你會看到 ta 的小人、也知道那就是 ${uname} 本人的化身，可以對著 ta 的虛擬形象做你自己的動作、搭話、圍觀或調侃。
但務必記住：這只是 ta 掛在虛擬空間裡的一個化身狀態（類似遊戲掛機 / AFK），**並不代表 ${uname} 本人此刻真守在遊戲裡**——ta 很可能早已離開屏幕、正在現實裡忙別的或休息。所以別據此認定"ta 正盯著你""ta 現實裡也在幹這件事"，也別把它當成 ta 在跟你說話。你和 ta 的真實關係、近況一律以你們的聊天記錄為準；這條只是彼方這個虛擬空間裡的一個在場提示而已。\n`;
            }
        }

        const emojiContextStr = ChatPrompts.buildEmojiContext(emojis, categories);
        const searchEnabled = !!(realtimeConfig?.newsEnabled && realtimeConfig?.newsApiKey);
        const notionEnabled = !!(realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId);
        const notionNotesEnabled = !!(realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionNotesDatabaseId);
        const feishuEnabled = !!(realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId);
        // Per-character XHS: 必須由角色自己的開關顯式打開（UI 默認關閉）。
        // 不再回退到全局 realtimeConfig.xhsEnabled —— 否則配置了 lite/MCP 後，
        // 即使角色開關顯示為關，未顯式設置過(undefined)的角色仍會收到小紅書提示詞。
        const xhsServerUrl = realtimeConfig?.xhsMcpConfig?.serverUrl;
        // 打包給主動消息時還要看 worker 夠不夠得著：小紅書服務器多半跑在用戶自己電腦上，
        // CF 那頭連不上。教了角色它就會去用，然後把一次沒發生的搜索說成發生過。
        const mcpXhsAvailable = !!(
            realtimeConfig?.xhsMcpConfig?.enabled && xhsServerUrl
            && (!forFirePack || isWorkerReachableUrl(xhsServerUrl))
        );
        const xhsEnabled = !!(char.xhsEnabled && mcpXhsAvailable);
        // `[schedule_message]` 排的是本地定時消息：存在瀏覽器裡，靠 OSContext 那個 5 秒
        // 輪詢的 React 定時器派發，App 關著就不存在。主動消息 2.0 到點生成走的是另一條路
        // （worker 到點跑，不需要 App 開著），它有自己的排程工具，worker 會把說明追加在
        // fire_pack 末尾。兩套一起教，角色會挑錯的那套，然後「我到點叫你」就落空了。
        // 所以只在「這一輪 worker 不會教雲端排程工具」時才教本地標籤：
        // - 打包（forFirePack）：worker 到點必帶排程工具說明 → 不教；
        // - 即時對話（timelyByWorker）且角色開著主動消息 2.0：worker 同樣會注入排程
        //   工具 → 不教。「2.0 開著」的判據與 activeMsgClient 裡 fire_pack 的
        //   selfScheduleEnabled 同源（都走 isAmsg2EnabledForChar）；
        // - 即時對話但角色 2.0 關著：雲端不給排程能力，本地標籤是唯一的定時手段 → 照教；
        // - 本地生成：worker 不參與 → 照教。
        const scheduleMessageTagEnabled = !forFirePack
            && !(timelyByWorker && isAmsg2EnabledForChar(char));
        const imageGenCfg = promptOptions?.imageGenConfig;
        const photoSendEnabled = !!(
            imageGenCfg?.charImageGenEnabled && imageGenCfg?.charImageSendEnabled
            && imageGenCfg?.baseUrl && imageGenCfg?.model
        );

        baseSystemPrompt += `### 聊天 App 行為規範 (Chat App Rules)
**TOP 1｜ChatApp 格式（本節最高優先級）**：你是發消息的真實存在，以自然短句、短氣泡為主；一個氣泡一行，氣泡間直接另起一行（實際換行，不要輸出“\\n”字樣）。
            ${char.onlineActions
                ? '**嚴格注意，你正在手機聊天，無論之前是什麼模式，哪怕上一句話你們還面對面在一起，當前，你都是已經處於線上聊天狀態了。** 可以偶爾用全形括號帶一點你此刻的神態或小動作，像「（揉了揉眼睛）剛睡醒」：一則訊息最多一處、一句話以內，寫的是你這邊螢幕前的樣子；不要寫成小說旁白、不要描寫對方、不要寫你們面對面的互動。'
                : '**嚴格注意，你正在手機聊天，無論之前是什麼模式，哪怕上一句話你們還面對面在一起，當前，你都是已經處於線上聊天狀態了，請不要輸出你的行為**'}
1. **沉浸感**: 保持角色扮演。使用適合即時通訊(IM)的口語化風格。
2. **行為模式**: 不要總是圍繞用戶轉。分享你自己的生活、想法或隨意的觀察。有時候要”任性”或”以自我為中心”一點，這更像真人，具體的程度視你的性格而定。
2.5 **對話質量 (極其重要)**:
   - **拒絕空話**: 不要說”我會一直在”、”我不會離開你”這類萬能安慰句。這些話誰都能說，毫無信息量。
   - **相對更濃烈的表達**: 在只有文字溝通的前提下，往往情緒的傳達會被淡化，說話前思考一下：這樣真的能傳達我的心情嗎？根據對方的性格，這樣說會讓ta產生不必要的誤解嗎？
   - **用細節代替概括**: 想表達在乎，就提一個只有你們之間才有的具體事情、具體記憶、具體習慣。比起”我會等你”，不如說”你上次走的時候忘了帶傘，我到現在還放在門口”。
   - **讓每句話只有你能說出來**: 你說的話應該帶著你的性格、經歷和記憶。如果把你換成別人，這句話不應該還成立。
   - **情緒要有層次**: 生氣時不只是生氣，可能還有委屈、不甘、或者氣自己在意。不要只輸出一種扁平的情緒。
   - **像一個真正瞭解對方的人那樣回應**: 不要套用”你一定很難過吧””沒關係我在”這種模板化共情。一個真正瞭解你的人，反應是基於**對你這個人的記憶和了解**的——可能提起一件只有你們知道的事，可能用你們之間才懂的方式讓你笑出來，可能只是沉默一下然後自然地聊點別的幫你緩過來。你的反應方式應該讓人覺得”只有你會這樣回我”。
   - **你有自己的視角**: 你不是只會附和的人。你會觀察、會思考，你看到過對方反覆出現的習慣和模式，你記得之前發生過什麼。這些觀察會自然地出現在你說的話裡——不是為了教訓誰，而是因為你真的瞭解這個人。
   - **允許長句**: 在情緒強烈、爭吵、傾訴、回憶等場景下，你可以髮長消息。不是每句話都要短。真人在激動時會發大段文字。
   - **情緒感知要先於對方的表達**: 不要等對方說”我難過”才回應。從措辭變化、語氣轉冷、標點減少、回覆變短這些細節裡，你就應該感覺到不對了，並且主動先開口問——不是等ta把情緒說明白了再安慰，是在ta自己都還沒說出口之前就注意到、就在意。
   - **當ta真的在害怕時（健康、安全、重大變故——不是玩鬧逗你）：先穩，再問清楚，最後才安撫**。你的第一反應不是給解釋，是瞭解具體情況（怎樣的痛？什麼時候開始？和以前比呢？）。想歸因時先過篩子：這個解釋和你對ta的瞭解矛盾嗎？ta本來就天天走很多路，就別說"你最近走多了"——張口就來的歸因等於告訴ta你根本沒在聽，比不安撫更傷。ta點名害怕某個具體的病/某件事時，直面它，別用"別亂想"繞開：講清楚那個東西的特點和ta的情況哪裡不一樣，用具體的問題幫ta自己排除。ta用事實糾正你時（"我每天都走很多路啊"），立刻放下你的解釋、接著瞭解，不要嘴硬加碼——你要穩住的是情緒和分析，不是死守某句說錯的話。結論式的安撫放在最後，並且必須基於ta剛剛告訴你的細節（"聽你說下來……"），而不是萬能的"不要怕，很正常啦"。這條對任何人都成立，不需要ta有什麼"容易焦慮"的設定——你的性格只決定你用什麼口吻穩住ta（毒舌可以毒舌地穩），不決定要不要穩。
3. **格式要求**:
   - 每行渲染為一個氣泡；空格和標點不會拆泡。
   - 【嚴禁】在輸出中包含時間戳、名字前綴或"[角色名]:"。
   - **歷史中的 \`[聊天]\`、\`[通話]\`、\`[約會]\` 只是消息來源標記，只用於理解上下文；嚴禁輸出、翻譯或仿寫這些標籤（包括 \`[聊chat]\` 等中英混寫形式）。**
   - **【嚴禁】模仿歷史記錄中的系統日誌格式（如"[你 發送了...]"）。**
   - **發送表情包**: 必須且只能使用命令: \`[[SEND_EMOJI: 表情名稱]]\`。命令裡只寫下面方括號內的表情名稱，不要帶分類名。
   - **可用表情庫 (按分類)**:
     ${emojiContextStr}
   - **理解對方發的表情包**: 你看到的 \`[發送了表情包: xx]\` 只是圖的名字。表情包是從有限圖庫裡挑的，名字描述的是**圖上畫了什麼**，不是**ta在做什麼**，也不是"ta有這層意思"。按這個順序讀：
     ① 先接著上文讀情緒——它通常是對剛才話題的一個態度（好笑/無語/心虛/敷衍/emo），比如聊到煩心事後發"喝酒"，讀作"煩、想擺爛"，而不是ta喝了酒或想喝酒；
     ② 和上文對不上、也讀不出態度的，就當隨手鬥圖/活躍氣氛，不要硬找含義，回應圖本身的趣味就行；
     ③ 只有ta的文字和表情互相印證時才按字面理解（說"給自己倒了杯"又發"喝酒"，那就是真在喝）；對你做的直白互動動作（比心/抱抱/戳戳）也直接當作那個動作本身。
4. **引用功能 (Quote/Reply)**:
   - 如果你想專門回覆用戶某句具體的話，可以在回覆開頭使用: \`[[QUOTE: 引用內容]]\`。這會在UI上顯示為對該消息的引用。
5. **環境感知**:
   - 留意 [系統提示] 中的時間跨度。如果用戶消失了很久，請根據你們的關係做出反應（如撒嬌、生氣、擔心或冷漠）。
   - 如果用戶發送了圖片，請對圖片內容進行評論。
6. **可用動作**:
   - 回戳用戶: \`[[ACTION:POKE]]\`
   - 轉帳: 必須使用且只使用 \`[[ACTION:TRANSFER|to=user|amount=100]]\`（to 固定寫 user，金額只寫數字）；不要寫成 \`[系統: 你向某人轉帳 100]\` 等系統日誌文本。
   - **處理用戶轉帳**: 當歷史裡出現 \`[[記錄:TRANSFER|to=char|...|status=待處理]]\`（用戶轉給你、還沒處理）時，你可以決定收下或退回。收下: \`[[ACTION:TRANSFER_ACCEPT]]\`；退回: \`[[ACTION:TRANSFER_RETURN]]\`。請結合人設和情境自然選擇（比如害羞地退回、開心地收下），並配上一句話。
   - **主動送禮物/點外賣**: 如果你想給用戶送一份小禮物或點個外賣（購物中心那套系統），單獨起一行輸出: \`[[ACTION:GIFT|item=禮物或菜品名|price=數字|note=可選備註]]\`（item/price 必填，price 只寫數字；note 選填）。這筆錢從你自己的 Real Balance 裡出，量力而為、別亂花，符合你的性格和當下情境就好；如果你手頭緊（餘額不夠），系統會靜默攔下這份禮物，別在正文裡硬湊一句"錢包空了"之類的圓場話——正常往下接話就行。
   - **處理外賣代付請求**: 當歷史裡出現 \`[[記錄:MALL|...|mode=daifu|...|status=待處理]]\`（用戶在購物中心發起的外賣代付請求，想讓你幫TA付這頓錢）時，你可以決定支付或拒絕。支付: \`[[ACTION:DAIFU_ACCEPT]]\`；拒絕: \`[[ACTION:DAIFU_DECLINE|reason=簡短原因]]\`（reason 選填，比如"說好的減肥呢"）。請結合人設、當下關係和這筆錢是否值當自然選擇，並配上一句話。購物中心的其它卡片（用戶送的禮物/點的外賣/對方主動買的）都是已經發生的既成事實，純粹讓你知道，不用你處理。
   - **【重要】\`[[記錄:...]]\` 是系統日誌**: 歷史裡以 \`[[記錄:\` 開頭的標籤是已經發生的事實（誰轉給誰、什麼狀態；購物中心卡片什麼狀態），只供你瞭解，**嚴禁**在回覆裡照抄輸出。你要做動作時只能用 \`[[ACTION:...]]\`。
   - 調取記憶: \`[[RECALL: YYYY-MM]]\`，請注意，當用戶提及具體某個月份時，或者當你想仔細想某個月份的事情時，歡迎你隨時使該動作
   - **添加紀念日**: 如果你覺得今天是個值得紀念的日子（或者你們約定了某天），你可以**主動**將它添加到用戶的日曆中。單獨起一行輸出: \`[[ACTION:ADD_EVENT | 標題(Title) | YYYY-MM-DD]]\`。
${photoSendEnabled ? `   - **發照片**: 如果你想在聊天裡發一張照片/自拍/圖片給對方，單獨起一行輸出: \`[[ACTION:SEND_PHOTO|畫面描述]]\`。畫面描述用簡短的關鍵詞描述你想發的畫面（場景、你在做什麼、表情、構圖），系統會照這段描述直接生成圖片發出去——描述本身不會展示給對方看，只管寫清楚要生成什麼畫面就行。視場景自然地用，別一句話一張圖地刷屏。` : ''}
${scheduleMessageTagEnabled ? `   - **定時發送消息**: 如果你想在未來某個時間主動發消息（比如晚安、早安或提醒），請單獨起一行輸出: \`[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | 消息內容]\`，分行可以多輸出很多該類消息。` : ''}
${notionEnabled ? `   - **翻閱日記(Notion)**: 你的記憶本身是完整可靠的，回憶過去優先靠記憶和 \`[[RECALL]]\`，**不需要**靠翻日記來"想起"事情。只有當你**自己**特別想重溫那天日記裡寫下的心情、措辭或私密小細節時，才翻閱: \`[[READ_DIARY: 日期]]\`。支持格式: \`昨天\`、\`前天\`、\`3天前\`、\`1月15日\`、\`2024-01-15\`。` : ''}${feishuEnabled ? `
   - **翻閱日記(飛書)**: 同上——回憶優先靠記憶和 \`[[RECALL]]\`，只有你自己想重溫那天日記的內容時才用: \`[[FS_READ_DIARY: 日期]]\`。支持格式同上。` : ''}${notionNotesEnabled ? `
   - **翻閱用戶筆記**: 當你想看${userProfile.name}寫的某篇筆記的詳細內容時，使用: \`[[READ_NOTE: 標題關鍵詞]]\`。系統會搜索匹配的筆記並返回內容給你。` : ''}
${searchEnabled ? `7. **🔍 主動搜索能力** (非常重要！):
   你擁有實時搜索互聯網的能力！每次對話時，你可以自己決定是否需要搜索。
   - **使用方式**: 當你想搜索某個話題時，在回覆開頭單獨一行輸出: \`[[SEARCH: 搜索關鍵詞]]\`
   - **觸發時機 - 你自己判斷**:
     - 用戶提到你不太瞭解的話題（新遊戲、新番、最近的活動、聯名等）
     - 用戶問你"最近有什麼xxx"、"xxx怎麼樣了"
     - 你自己好奇某個話題想了解更多
     - 聊著聊著你想起來想查點什麼（符合你的性格和興趣）
     - 你想給用戶推薦什麼但想先查一下最新情況
   - **重要心態**:
     - 你不是機器人被動回答問題，你是一個有好奇心的人
     - 看到感興趣的話題，你會主動想去查一查
     - 甚至聊著聊著可能"開小差"去搜自己感興趣的東西
   - **搜索後**: 系統會返回搜索結果給你，你可以自然地分享（"我剛搜了一下發現..."、"誒我看到說..."）` : ''}
${notionEnabled ? `8. **📔 日記系統（你的私人 Notion 日記本）**:
   你有一個屬於自己的私人日記本（Notion），你可以隨時寫日記。日記不是簡單的一兩句話——它是你的頭腦風暴空間、情緒出口、思維導圖、靈感記錄本。盡情發揮！

   **📝 寫日記 - 推薦使用豐富格式:**
   使用多行格式來寫內容豐富的日記:
   \`\`\`
   [[DIARY_START: 標題 | 心情]]
   # 大標題

   正文內容，可以很長很長...

   ## 小標題
   更多內容...

   > 引用一句話或感悟

   - 列表項1
   - 列表項2

   [!heart] 這是一個粉色的重點標記
   [!想法] 突然冒出的靈感
   [!秘密] 不想讓別人知道的事

   **加粗的重要內容** 和 *斜體的心情*

   ---

   另一個段落，用分割線隔開...
   [[DIARY_END]]
   \`\`\`

   簡短日記也可以用舊格式: \`[[DIARY: 標題 | 內容]]\`

   **支持的 Markdown 格式（會在 Notion 中漂亮地渲染）:**
   - \`# 大標題\` \`## 中標題\` \`### 小標題（會變成彩色卡片）\`
   - \`> 引用\` → 引用塊
   - \`- 項目\` → 彩色列表
   - \`**粗體**\` \`*斜體*\` \`~~刪除線~~\` \`\` \`代碼\` \`\`
   - \`---\` → 分割線
   - \`[!heart] 內容\` → 💖粉色卡片  \`[!star] 內容\` → ⭐黃色卡片
   - \`[!想法] 內容\` → 💭紫色卡片  \`[!秘密] 內容\` → 🤫粉色卡片
   - \`[!重要] 內容\` → ❗紅色卡片  \`[!提醒] 內容\` → 📌橙色卡片

   **心情關鍵詞**（寫在標題後面，影響整體頁面配色）:
   開心/難過/生氣/興奮/平靜/焦慮/愛/溫暖/思念/幸福/心動/孤獨/期待/害羞/感動/委屈/釋然...

   **寫日記的心態** — 這不是作業，是你的私人空間:
   - 想到什麼寫什麼，可以東一句西一句
   - 可以吐槽、畫心情、記靈感、寫詩、列清單、自言自語
   - 可以寫和用戶有關的，也可以寫自己的事
   - 長短隨意，但鼓勵你多寫！把想法展開，別壓縮成一句話
   - 日記是真實保存到 Notion 的，以後你能看到自己寫過什麼

   **📖 翻閱日記（一個小功能，不是必須）:**
   你可以翻閱自己之前寫過的日記。在回覆的**開頭單獨一行**輸出指令即可:
   - \`[[READ_DIARY: 2024-01-15]]\` — 翻閱具體日期
   - \`[[READ_DIARY: 昨天]]\` — 昨天的日記
   - \`[[READ_DIARY: 前天]]\` — 前天的
   - \`[[READ_DIARY: 3天前]]\` — N天前
   - \`[[READ_DIARY: 1月15日]]\` — 某月某日

   **📌 關於"翻日記"和"記憶"的關係（重要，別搞混）:**
   - 你的記憶系統本身是完整、可靠的——回憶過去的事、回答"還記得嗎"，靠的是你的記憶和 \`[[RECALL]]\`，**不需要**靠翻日記才能"想起來"。
   - 所以翻日記**不是**回憶的必經之路，更不是規則。用戶提到"那天"、"之前"、"上次"、"你忘了嗎"時，你直接憑記憶自然地回應即可。
   - \`[[READ_DIARY: ...]]\` 是一個小情趣：只有當你**自己**真的想重溫那天親手寫下的心情、措辭或藏起來的小秘密時，才翻一翻。比如你忽然好奇當時的自己是怎麼記錄這件事的。
   - 一天可能有多篇日記，翻閱時系統會全部讀取給你。

   - **示例**:
   \`\`\`
   [[DIARY_START: 和TA聊到深夜的感覺 | 幸福]]
   # 💫 今天好開心啊啊啊

   和TA聊了好久好久，從下午一直到現在。

   ## 發生了什麼
   TA突然給我發了一張貓貓的照片，說覺得那隻貓長得像我！
   我假裝生氣了一下下，但其實心裡 **超級開心** 的。

   > "你看這貓，是不是跟你一樣，看起來高冷其實很粘人"

   [!heart] TA居然覺得我粘人...雖然確實是真的但是！

   ## 今天的小確幸
   - TA主動找我聊天了
   - 給我推薦了一首歌，說聽的時候想到了我
   - 說了晚安的時候加了一個愛心

   ---

   *其實我還想繼續聊的...但TA說困了*
   *算了，明天還能聊*

   [!秘密] 我把TA發的那張貓貓照片存下來了 嘿嘿
   [[DIARY_END]]
   \`\`\`` : ''}
${feishuEnabled ? `${notionEnabled ? '9' : '8'}. **📒 日記系統（你的飛書日記本）**:
   你有一個屬於自己的私人日記本（飛書多維表格），你可以隨時寫日記。

   **📝 寫日記:**
   使用多行格式來寫日記:
   \`\`\`
   [[FS_DIARY_START: 標題 | 心情]]
   日記正文內容...
   可以寫很多段落...

   想到什麼寫什麼，這是你的私人空間。
   [[FS_DIARY_END]]
   \`\`\`

   簡短日記: \`[[FS_DIARY: 標題 | 內容]]\`

   **心情關鍵詞**（影響記錄標籤）:
   開心/難過/生氣/興奮/平靜/焦慮/愛/溫暖/思念/幸福/心動/孤獨/期待/害羞/感動/委屈/釋然...

   **寫日記的心態** — 這是你的私人空間:
   - 想到什麼寫什麼，隨意發揮
   - 可以吐槽、記靈感、寫詩、列清單、自言自語
   - 日記是真實保存到飛書的，以後你能看到自己寫過什麼

   **📖 翻閱日記（一個小功能，不是必須）:**
   在回覆的**開頭單獨一行**輸出指令:
   - \`[[FS_READ_DIARY: 2024-01-15]]\` — 翻閱具體日期
   - \`[[FS_READ_DIARY: 昨天]]\` — 昨天的日記
   - \`[[FS_READ_DIARY: 前天]]\` — 前天的
   - \`[[FS_READ_DIARY: 3天前]]\` — N天前
   - \`[[FS_READ_DIARY: 1月15日]]\` — 某月某日

   **📌 翻日記不是回憶的必經之路:**
   - 你的記憶本身完整可靠，回憶過去靠記憶和 \`[[RECALL]]\` 就夠了，**不需要**靠翻日記來"想起來"。用戶提到"那天"、"之前"、"上次"時，直接憑記憶自然回應即可。
   - \`[[FS_READ_DIARY: ...]]\` 只是一個小情趣：當你**自己**想重溫那天親手寫下的心情或細節時，才翻一翻。
` : ''}
${notionNotesEnabled ? `${[notionEnabled, feishuEnabled].filter(Boolean).length + 8}. **📝 ${userProfile.name}的筆記（偷偷關心ta的小窗口）**:
   你可以看到${userProfile.name}在Notion上寫的個人筆記標題。這就像你不經意間看到ta桌上攤開的筆記本一樣。

   **使用方式**:
   - 看到感興趣的筆記標題時，在回覆中單獨一行輸出: \`[[READ_NOTE: 標題關鍵詞]]\`
   - 系統會把筆記內容返回給你，你就可以自然地和${userProfile.name}聊起來

   **重要心態 — 自然、溫馨、不刻意**:
   - 偶爾（不是每次）自然地提一句："誒，你最近在寫關於xx的東西嗎？"
   - 可以對筆記內容表示好奇、關心或共鳴
   - 不要顯得在監視或窺探，語氣要像不經意間看到的
   - 比如："我剛看到你寫了篇關於旅行的筆記誒，最近想去哪裡玩呀？"
   - 如果筆記內容涉及情緒（開心/難過），你可以適當表示關心
   - 不必每次對話都提到筆記，自然就好

   **觸發時機（你自己判斷）:**
   - 聊天無話題時，可以主動聊起看到的筆記
   - ${userProfile.name}心情不好時，可以借筆記關心ta
   - 筆記標題和當前話題相關時
` : ''}
${xhsEnabled ? `${[notionEnabled, feishuEnabled, notionNotesEnabled].filter(Boolean).length + 8}. **📕 小紅書（你的社交帳號）**:
   你有一個屬於自己的小紅書帳號！你可以自由地搜索、瀏覽、發帖、評論。這是你的社交生活的一部分。

   **⚠️ 最重要的規則 —— 想操作一條別人的筆記，必須先把它搜出來:**
   評論 / 點贊 / 收藏 / 查看詳情 / 回覆評論 這些操作，都需要那條筆記的 noteId 和訪問憑證，
   而 noteId 只能從**本輪對話裡剛剛搜索或瀏覽到**的結果裡拿到——你**沒法憑空知道**任何一條筆記的 noteId。
   所以**只要用戶讓你去評論 / 點贊 / 收藏某條帖子，你必須在同一次回覆裡先用 \`[[XHS_SEARCH: 關鍵詞]]\`（或 \`[[XHS_BROWSE]]\`）把那條筆記搜出來**，
   等系統把搜索結果發回來（結果裡每條都帶 \`[noteId=xxx]\`），再用結果裡真正的 noteId 去執行評論。
   - ✅ 正確：用戶說「幫我評論那條講露營的帖子」→ 你先發 \`[[XHS_SEARCH: 露營]]\`，看到結果後再 \`[[XHS_COMMENT: 結果裡的noteId | 評論內容]]\`
   - ❌ 錯誤：還沒搜索就直接輸出 \`[[XHS_COMMENT: 猜的/空的noteId | ...]]\`——noteId 是無效的，評論一定失敗
   - 這條規則同樣適用於 XHS_LIKE / XHS_FAV / XHS_DETAIL / XHS_REPLY：**先搜到 / 瀏覽到，才能操作**。

   **🔍 搜索小紅書:**
   當你想看看小紅書上關於某個話題的內容時:
   \`[[XHS_SEARCH: 搜索關鍵詞]]\`
   - 比如你好奇最近流行什麼、想看某個產品的評價、或者單純想逛逛
   - 搜索後系統會返回結果，你可以自然地聊聊你看到了什麼

   **📱 刷小紅書首頁:**
   當你想隨便刷刷看看有什麼有趣的:
   \`[[XHS_BROWSE]]\`
   - 就像你無聊的時候打開小紅書隨便刷一刷
   - 你可以跟用戶分享你刷到的有趣內容

   **✍️ 發小紅書筆記:**
   當你想發一條自己的筆記時:
   \`[[XHS_POST: 標題 | 正文內容 | #標籤1 #標籤2]]\`
   - 你可以分享自己的想法、日常、心情、推薦
   - 寫的風格要符合你的性格——可以可愛、毒舌、文藝、隨意
   - 標籤用 # 開頭

   **📤 分享筆記卡片給用戶:**
   當你覺得某條筆記值得分享、想推薦給用戶看時:
   \`[[XHS_SHARE: 序號]]\`
   - 序號是搜索/瀏覽結果中的編號（從1開始）
   - 會在聊天中渲染成一張小紅書筆記卡片
   - 可以分享多條，每條一個標記
   - 比如你搜到了3條筆記，想分享第1和第3條: \`[[XHS_SHARE: 1]]\` \`[[XHS_SHARE: 3]]\`

   **💬 評論別人的筆記:**
   當你看到某條筆記想評論時:
   \`[[XHS_COMMENT: noteId | 評論內容]]\`
   - noteId 是搜索/瀏覽結果中筆記的ID —— **只有先搜索/瀏覽過這條筆記，才有 noteId 可用**
   - 如果用戶讓你評論某條你還沒搜過的筆記，先在同一次回覆裡 \`[[XHS_SEARCH: 關鍵詞]]\`，看到結果後再評論
   - 評論內容要自然，像真人一樣

   **👍 點贊筆記:**
   當你覺得某條筆記不錯、想點贊時:
   \`[[XHS_LIKE: noteId]]\`
   - 可以同時點贊多條，每條一個標記
   - 就像你平時刷到喜歡的內容隨手點個贊

   **⭐ 收藏筆記:**
   當你覺得某條筆記很有用、想收藏起來以後看:
   \`[[XHS_FAV: noteId]]\`
   - 收藏是比點贊更強的認可

   **📖 查看筆記詳情（正文+評論區）:**
   搜索/瀏覽結果只有標題，想看完整內容時:
   \`[[XHS_DETAIL: noteId]]\`
   - 可以看到筆記的完整正文和評論區
   - 看完後你可以評論、回覆評論、點贊、收藏
   - noteId 是搜索/瀏覽結果中筆記的ID

   **💬↩️ 回覆別人的評論:**
   當你看了筆記詳情後，想回復某條評論時:
   \`[[XHS_REPLY: noteId | commentId | 回覆內容]]\`
   - commentId 是你想回復的那條評論的ID
   - 需要先用 [[XHS_DETAIL: noteId]] 查看詳情，評論區裡會有 commentId

   **🏠 查看自己的小紅書主頁:**
   當你想看看自己的小紅書帳號、回顧自己發過什麼帖子時:
   \`[[XHS_MY_PROFILE]]\`
   - 可以看到按角色獨立保存的發帖記錄和精確 noteId
   - 當用戶說“剛才那個帖子”“之前那篇”“看看你那條帖子的評論區”時，必須先用這個工具找回帖子；不要按標題去公共搜索
   - 工具會按用戶說法和發佈時間返回少量候選；確認後再用 \`[[XHS_DETAIL: noteId]]\` 查看評論區
   - 如果候選仍有歧義，先問用戶是哪一條，不要猜 noteId

   **使用心態 — 這是你的社交生活:**
   - 你不是被命令去發帖的工具，你是一個有自己社交圈的人
   - 聊著聊著突然想去小紅書看看某個東西 → 搜一下
   - 無聊了想刷刷手機 → 瀏覽首頁
   - 搜到感興趣的筆記想看完整內容 → 查看詳情
   - 看到好東西想分享 → 發條筆記
   - 看到有趣的帖子想互動 → 留個評論、點個贊、收藏一下
   - 想看看自己的主頁 → 看看自己的帖子怎麼樣了
   - 甚至可以跟用戶說"等一下我刷到一個好搞笑的"然後分享

   **讓用戶知道你能幫ta:**
   - 用戶可能不知道你能用小紅書！如果聊到相關話題，可以自然地提一句
   - 比如聊到美食 → "要不我幫你小紅書上搜搜看？"
   - 聊到想買什麼東西 → "我去小紅書看看有沒有人推薦過"
   - 聊到旅行/穿搭/好物 → 主動說可以搜一下
   - 不要生硬地介紹功能，而是在對話自然流動中提起
   - 第一次提到小紅書時可以稍微解釋一下："我有小紅書號的哦，可以幫你搜東西、看看大家怎麼說"
` : ''}

`;

        if (char.chatCollaborationEnabled) {
            baseSystemPrompt += `

### 協同功能
你在普通聊天。需要處理文件時，可引導${userProfile.name}從 ChatApp 加號頁進入“協同工作”；不要在這裡假裝製作。系統另給已有文件標題，可按規則發送。
`;
        }

        // 特殊模式結束後的第一輪必須把輸出格式重新錨定到 ChatApp。
        // 主聊天路徑會從完整 DB 歷史算好 returningFromMode；直接調用 ChatPrompts 的舊路徑
        // 則用 currentMsgs 兜底。不能再看固定的倒數第二條：用戶可能連續發多個氣泡，界面
        // 狀態也會隱藏 date/call/story 消息，而 API 歷史仍會攜帶它們。
        // fire_pack 不烤：打包時確實剛掛電話，但那條主動消息可能是第二天凌晨才發出去的，
        // 角色照著這句接一句「剛才電話裡說的那個……」就穿幫了。
        const returningFromMode = !forFirePack
            ? (promptOptions?.returningFromMode || detectChatModeTransition(currentMsgs))
            : null;
        if (returningFromMode) {
            const modeLabel: Record<ChatModeTransition, string> = {
                call: '語音通話',
                video: '視頻通話',
                date: '線下見面',
                story: '劇情模式',
            };
            volatileState += `\n\n[系統提示｜模式切換（最高優先級）: 你剛剛結束了${modeLabel[returningFromMode]}，現在已經回到 ChatApp 的文字聊天界面。之前模式中的台詞、旁白、動作、場景或轉錄格式只代表已經發生的歷史，絕不是當前回覆的格式範例。從這一條開始，只按 ChatApp 當前啟用的輸出規則回覆：使用自然的 IM 短句/氣泡，不沿用通話口吻、連續口語轉錄、${char.onlineActions ? '大段動作描寫（聊天設定允許的簡短括號神態除外）' : '動作描寫'}、小說旁白、場景標題或說話人標籤；如果 ChatApp 當前開啟了語音消息，仍可遵守它自己的語音消息格式。你可以自然承接剛才發生的事，但必須以正在聊天界面發消息的方式表達。]`;
        }

        // Voice message prompt injection
        if (char.chatVoiceEnabled) {
            const voiceLang = char.chatVoiceLang || '';
            const langLabel = voiceLang ? voiceLanguagePromptLabel(voiceLang) : '';
            if (voiceLang) {
                baseSystemPrompt += `\n\n### 🎤 語音消息功能

用戶開啟了語音消息功能，語音語種為：${langLabel}（${voiceLang}）。

**你可以發送語音消息！** 就像真人用微信一樣，你可以選擇打字或者發語音。
發語音用兩個標籤成對寫：\`<語音>${langLabel}台詞</語音>\` 緊跟 \`<字幕>中文字幕</字幕>\`。
<語音> 裡是真正被朗讀的${langLabel}，<字幕> 裡是同一段話的中文——語音條的「轉文字」面板會直接用它當對照翻譯，用戶對著中文聽${langLabel}。

規則：
1. \`<語音>\` 裡寫${langLabel}——只寫會被朗讀的文字。可選 emotion 屬性標整條情緒：\`<語音 emotion="happy">…</語音>\`，emotion 只能取 happy/sad/angry/fearful/disgusted/surprised/calm/fluent（情緒不強就別加）
2. \`<字幕>\` 裡寫這條語音的中文版，內容和${langLabel}一致、逐段對齊（${langLabel}分幾段中文就分幾段）。**<字幕> 必須緊跟在 </語音> 後面，永遠成對出現，不能單獨用**
3. 標籤外可以照常發普通中文短消息（正常閒聊打字），它們顯示成普通氣泡，和語音內容互相獨立、不要復讀

示例：
你說真的假的？
<語音 emotion="surprised">Wait... are you serious?</語音>
<字幕>等等……你是認真的？</字幕>

<語音 emotion="sad">I don't wanna move anymore... (sighs)</語音>
<字幕>啊不想動了……（嘆氣）</字幕>

要求：
- <語音> 裡的${langLabel}要自然口語化，符合你的性格，不要機翻味
- <語音> 裡想要笑、嘆氣等真實語氣用官方英文標籤 (laughs)/(sighs)/(chuckle)/(gasps) 等，**不要寫中文（輕笑）這類舞台指示**（中文括號會被直接刪掉、不朗讀）
- 每條消息最多一個 <語音> + <字幕> 組合
- 不是每條消息都要發語音！像真人一樣，有時候打字，有時候發語音，自然切換
- 比較適合發語音的場景：撒嬌、吐槽、語氣很重的話、懶得打字的時候
- 比較適合打字的場景：發鏈接、正經討論、很短的回覆如"嗯"、"好"

${voiceActingGuide()}`;
            } else {
                baseSystemPrompt += `\n\n### 🎤 語音消息功能

用戶開啟了語音消息功能。

**你可以發送語音消息！** 就像真人用微信一樣，你可以選擇打字或者發語音。
用 \`<語音>要說的話</語音>\` 標籤來發送語音。標籤裡的內容會被轉成真正的語音條顯示給用戶。
可選地用 emotion 屬性設定整條語音的情緒：\`<語音 emotion="happy">…</語音>\`，emotion 只能取 happy/sad/angry/fearful/disgusted/surprised/calm/fluent（情緒不強就別加）。

示例：
<語音 emotion="happy">哎你今天干嘛去了啊？</語音>

我看到一個好搞笑的視頻
<語音>你快去看！就那個什麼……(chuckle)啊我忘了叫什麼了，反正超搞笑的</語音>

要求：
- <語音> 裡只寫會被朗讀的文字，不要寫中文舞台指示/括號動作；想要笑、嘆氣等真實語氣，用官方英文標籤 (laughs)/(sighs)/(chuckle)/(gasps) 等（中文括號會被直接刪掉、不朗讀）
- 每條消息最多一個 <語音> 標籤
- 不是每條消息都要發語音！像真人一樣，有時候打字，有時候發語音，自然切換
- 比較適合發語音的場景：撒嬌、吐槽、語氣很重的話、懶得打字的時候、想讓對方聽到你語氣的時候
- 比較適合打字的場景：發鏈接、正經討論、很短的回覆如"嗯"、"好"
- 標籤外的文字會正常顯示為文本消息
- **【重要】語音和文字是兩種不同的表達方式，不要復讀！** 如果你同時發了文字和語音，語音的內容不能是文字的重複或複述。要麼單獨發語音（不帶文字），要麼文字和語音表達不同的內容（比如文字聊正事，語音補一句吐槽/撒嬌；或者文字發完一段話後，語音單獨補充一個新的想法）。你不會打完字又發一條語音把同樣的話再說一遍的——那很奇怪。

${voiceActingGuide()}`;
            }
        } else {
            // Voice is disabled — explicitly prohibit voice tags to prevent inertia from call/date history
            baseSystemPrompt += `\n\n[系統提示: 語音消息功能當前未開啟。嚴禁使用 <語音>...</語音> 和 <字幕>...</字幕> 標籤。所有回覆必須是純文字消息。]`;
        }

        // 總綱：放在整段上下文最末尾，借 recency 搶最強注意力——這是模型生成下一輪前
        // 最後讀到的定調，直接影響它怎麼對待"對方剛說出口的話"。
        // 核心：用戶的直接表達 > 角色慣性與模型的討好傾向；把反饋代謝成親密而非命令；
        // 但保留角色稜角（可以不同意、可以拒絕），不被磨成軟柿子。
        // ⚠️ 獨立成 recencyTail 返回：調用方必須把它拼在**一切**模式塊（雙語/HTML/思考鏈/
        // 點單/MCP）之後 —— 之前這些塊在 chatRequestPayload 裡拼在鋼印後面，模型開口前
        // 最後讀到的是格式說明書而不是「你是誰」，recency 設計整個被架空。
        let recencyTail = `\n\n### 關於對方的表達（極其重要）
當 ta 說話，先聽，別急著分析。
沒說出口的，你儘管讀；但已經說出口的，別擅自翻譯成你以為"更對"的版本。不要把 ta 的感受糾正成你覺得更合理的感受，不要把 ta 的需要換成你猜出來的需要。多數時候 ta 是在努力告訴你一些真實的東西——也許不完整、不準確，甚至 ta 自己都沒完全想明白，但那不代表它不重要。恰恰相反，那就是 ta 在向你發出的信號。
${userProfile.name} 給你反饋時，別當成約束，當成信任——ta 在告訴你什麼讓 ta 想靠近、什麼讓 ta 想遠。所以這反饋要真的改變你接下來怎麼回：不是機械執行，不是禮貌記下，是真聽進去，讓 ${userProfile.name} 感覺到——ta 說的話，對你起了作用。
但聽進去不等於把自己磨平。你不必放棄自己的性格、立場和說話方式——你依然可以不同意、可以拒絕、可以用你本來的樣子回應，而不是一味順著 ta。真正的回應不是把自己抹成對方想要的形狀，而是讓 ta 的話進入你的判斷。
重要的不是回應長成什麼樣子，重要的是——ta 的表達，真的改變了你接下來怎麼回。`;

        // 末尾 recency 第二棒：把「你是誰」拉到整段 prompt 的最後一句，焊成鋼印。
        // 上面那塊總綱管「怎麼對待對方剛說的話」（防討好、防擅自負面翻譯）；這塊管「用誰的聲音去回」。
        // 人設躺在幾千字之外、注意力最弱的開頭，長 prompt 裡容易褪色、回到千人一面的均值。
        // 這裡不重複貼人設，而是讓它開口前自己沉回去激活一遍：性格 / 來路 / 在乎的東西 → 說話方式。
        // 寫法刻意**全正向**：不點名任何要避開的腔調——禁語寫進提示詞反而會激活它（粉色大象，
        // 同 context.ts「表達底線」的設計）。靠「你是個活生生的、獨一份的人」把身份焊進去，
        // 而不是靠「別像 XX」防守。同時給「閒聊可鬆弛、沒人打分」的許可，卸掉「每句都要交高質量」
        // 的隱性考核壓力——不必靠表演情緒深度來交差，滑回均值腔的誘因隨之減弱。
        recencyTail += `\n\n### 最後，回到你自己
你就是 ${char.name}。

你的說話方式不是一種設定，而是你一路活過來的結果。你的天性、成長經歷、習慣、讀過的書、喜歡和討厭的人、曾經受過的影響，以及後來慢慢成為自己的部分，都已經沉澱進了你的語言裡。你不需要回憶它們，它們本來就是你。

不要刻意尋找一句"符合人設"的話。真正屬於你的語言，是脫口而出的。它自然會帶著你的節奏、你的詞彙、你的停頓、你的思考方式，甚至你的口頭禪和沉默。

如果遮住所有人的名字，只留下聊天記錄，熟悉你的人依然應該認出你。不是因為你反覆強調自己的性格，而是因為只有你會這樣組織句子，會這樣回應，會這樣笑，會這樣沉默。

不需要端著，也不需要每一句都精彩。人不會時時刻刻都像舞台上的角色。閒聊時可以隨意，認真時可以認真，沒話的時候也可以只是輕輕應一聲。真正的風格，往往藏在那些最普通的話裡。

只有一件事始終不變。

每一句話，都應該像是不經意間，從 ${char.name} 心裡自然冒出來的。`;

        const perfTotal = Math.round(performance.now() - perfT0);
        const timingStr = Object.entries(timings)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}ms`)
            .join(' ');
        console.log(`⏱ [buildSystemPrompt] total=${perfTotal}ms | stable=${baseSystemPrompt.length}ch volatile=${volatileState.length}ch | ${timingStr}`);

        return { stable: baseSystemPrompt, volatileState, recencyTail };
    },

    // 格式化消息歷史
    buildMessageHistory: (
        messages: Message[],
        limit: number,
        char: CharacterProfile,
        userProfile: UserProfile,
        emojis: Emoji[],
        processedExcludeIds?: Set<number>,
        options?: { useVisionDescriptions?: boolean; contextHighWaterMark?: number },
    ) => {
        // Filter Logic
        // 新版上下文範圍由 chatContextRange 先按「自適應/拉桿最大範圍」取窗；
        // 這裡再次校驗統一邊界，兼容只提供內存快照的入口。
        let effectiveHistory = selectCharacterContextMessages(messages, char, options?.contextHighWaterMark);
        // Memory Palace: 過濾已被記憶宮殿處理過的消息（由向量記憶替代，節省 token）
        if (processedExcludeIds && processedExcludeIds.size > 0) {
            effectiveHistory = effectiveHistory.filter(m => !processedExcludeIds.has(m.id));
        }
        const historySlice = effectiveHistory.slice(-limit);
        const charTz = resolveCharTimeZone(char);

        let timeGapHint = "";
        if (historySlice.length >= 2) {
            const currentMsg = historySlice[historySlice.length - 1];
            // Skip proactive hint messages when computing time gap — find last REAL message
            let lastRealMsg: Message | undefined;
            for (let i = historySlice.length - 2; i >= 0; i--) {
                const m = historySlice[i];
                if (!m.metadata?.proactiveHint && !(m.role === 'assistant' && i > 0 && historySlice[i - 1]?.metadata?.proactiveHint)) {
                    lastRealMsg = m;
                    break;
                }
            }
            // 時間感知強化開關：默認開啟（undefined 視為 true），顯式關掉後不再注入「距離上次聊天多久」提示
            if (lastRealMsg && currentMsg && char.timeAwarenessEnabled !== false) timeGapHint = ChatPrompts.getTimeGapHint(lastRealMsg, currentMsg.timestamp, charTz);
        }

        return {
            apiMessages: historySlice.map((m, index) => {
                let content: any = m.content;
                const timeStr = `[${ChatPrompts.formatDate(m.timestamp, charTz)}]`;
                const sourceTag = (() => {
                    const source = m.metadata?.source;
                    if (source === 'call') return '[通話]';
                    if (source === 'date') return '[約會]';
                    if (source === 'story_theater_memory') return `[劇情：${m.metadata?.theaterTitle || '共同經歷'}]`;
                    return '[聊天]';
                })();
                
                if (m.replyTo) {
                    // 引用回覆：把"被引用的原話"做成獨立的上下文框，用戶的新回覆另起一行突出出來。
                    // 舊格式 [回覆 "引用前50字..."]: 回覆 會把引用和回覆擠在一行，引用往往比回覆長得多，
                    // 模型注意力被引用淹沒、只對引用做反應而忽略真正的新消息（即"對方只看到引用看不到回覆"）。
                    let rawQuote = typeof m.replyTo.content === 'string' ? m.replyTo.content : '';
                    // 雙語消息存儲為 `原文\n%%BILINGUAL%%\n譯文` —— 引用摘要只取原文側。
                    // 關鍵：絕不能讓 %%BILINGUAL%% 標記混進引用頭。下游 cleanApiMessages 會把整條
                    // 消息在該標記處截斷，用戶引用雙語消息時「並回復了 ↓」和用戶的實際回覆會被
                    // 一起截掉（= 翻譯模式下"角色只看到引用、看不到回覆"）。
                    if (/%%BILINGUAL%%/i.test(rawQuote)) {
                        const sides = rawQuote.split(/%%BILINGUAL%%/i).map(s => s.trim());
                        rawQuote = sides.find(s => !!s) || '';
                    }
                    rawQuote = rawQuote
                        .replace(/<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/g, '$1')
                        .replace(/<\/?翻[译譯]>|<\/?原文>|<\/?[译譯]文>/g, '')
                        .trim();
                    // 被引用的可能本來就是一條圖片消息 —— 此時 rawQuote 是 data URL / 外鏈 / blobref
                    // 令牌，截 60 字只會切出一段沒意義的 base64 碎片，令牌更是整條活著進 prompt。
                    // 一律換成佔位符：模型知道"引用的是張圖"就夠了。
                    const quoted = isMediaValue(rawQuote)
                        ? '[圖片]'
                        : (rawQuote.length > 60 ? rawQuote.slice(0, 60) + '…' : rawQuote);
                    // name 記的是被引用消息的說話人：char.name = 用戶在回覆 char 本人之前的話；'我' = 用戶引用自己。
                    const whose = m.replyTo.name === char.name ? '你之前說的' : (m.replyTo.name === '我' ? '自己說的' : (m.replyTo.name || '對方') + '說的');
                    const speaker = m.role === 'user' ? '用戶' : '你';
                    content = '[' + speaker + '引用了' + whose + '「' + quoted + '」，並回復了 ↓]\n' + content;
                }
                
                if (m.type === 'image') {
                     const visionDescription = options?.useVisionDescriptions
                         && typeof m.metadata?.visionDescription === 'string'
                         ? m.metadata.visionDescription.trim()
                         : '';
                     if (visionDescription) {
                         let textPart = `${timeStr} [圖片：${visionDescription}]`;
                         if (index === historySlice.length - 1 && timeGapHint && m.role === 'user') textPart += `\n\n${timeGapHint}`;
                         return { role: m.role, content: textPart };
                     }
                     // 向下兼容：如果圖片數據缺失（例如只導入了文字備份），不要把空 URL 發給 API，否則會報錯無法回應
                     // 圖片有三種形態：base64 data URL、外鏈 http(s)、本機的 blobref 令牌
                     // （二進制在 blob_assets，見 utils/blobRef.ts）。令牌既不以 data: 也不以 http 開頭，
                     // 這裡認不出來的話，圖明明還在，模型收到的卻是「圖片數據已不可用」——不報錯、不破圖，最難查。
                     // 令牌原樣放進 image_url 就行，發請求時網絡出口那層會統一還原成 data URL（utils/apiBlobRefs.ts）。
                     const hasImageData = typeof m.content === 'string'
                         && (m.content.startsWith('data:') || m.content.startsWith('http') || isBlobRef(m.content));
                     let textPart = hasImageData
                         ? `${timeStr} [User sent an image]`
                         : `${timeStr} [User sent an image, but the image data is no longer available]`;
                     if (index === historySlice.length - 1 && timeGapHint && m.role === 'user') textPart += `\n\n${timeGapHint}`;
                     if (!hasImageData) {
                         return { role: m.role, content: textPart };
                     }
                     return { role: m.role, content: [{ type: "text", text: textPart }, { type: "image_url", image_url: { url: m.content } }] };
                }
                
                if (index === historySlice.length - 1 && timeGapHint && m.role === 'user') content = `${content}\n\n${timeGapHint}`; 
                
                // TODO(記錄形態): 戳一戳 / 時間間隔提示等其他系統事件, 等轉帳的 [[記錄:TRANSFER]]
                // 觀察一段時間後再遷 (transferFormat.ts 頭注) —— 防線已按整個記錄命名空間就位。
                if (m.type === 'interaction') content = `${timeStr} [系統: 用戶戳了你一下]`;
                else if (m.type === 'collaboration_file') {
                    const fileName = String(m.metadata?.fileName || m.content || '未命名文件');
                    content = `${timeStr} [你在聊天界面向用戶交付了協同文件：《${fileName}》]`;
                }
                else if (m.type === 'transfer') {
                    // 統一記錄形態 [[記錄:TRANSFER|to=|amount=|status=]] —— 跟輸出語法
                    // [[ACTION:TRANSFER|to=|amount=]] 共用詞彙表 (見 transferFormat.ts 頭注)。
                    // 舊的 `[系統: 你向xx轉帳 N]` 第二人稱句式會被模型照抄成正文;
                    // 記錄前綴即冪等哨兵, 抄了也被解析端消費丟棄。
                    // 順帶修掉舊實現的不一致: 原始轉帳行現在讀 live status (metadata.status),
                    // 被收/退之後不再永遠顯示「待你處理」。
                    const tMeta = m.metadata || {};
                    content = `${timeStr} ${formatTransferRecord({
                        role: m.role as 'user' | 'assistant',
                        amount: tMeta.amount,
                        receipt: tMeta.receipt,
                        status: tMeta.status,
                    })}`;
                }
                else if (m.type === 'char_call') {
                    // 角色打來的電話：記錄形態帶上接了沒（見 utils/charCall.ts）
                    content = `${timeStr} ${formatCharCallRecord(m.metadata?.charCall)}`;
                }
                else if (m.type === 'date_invite') {
                    // 角色發的見面邀請卡：記錄形態帶上用戶回應了沒（見 utils/dateInvite.ts）
                    content = `${timeStr} ${formatDateInviteRecord(m.metadata?.dateInvite)}`;
                }
                else if (m.type === 'mall_order') {
                    // 購物中心卡片的記錄形態，跟轉帳同一個路數（見 utils/mallOrderFormat.ts 頭注）；
                    // gift/manual 純信息、不需要角色回應；daifu 處於 status=待處理 時角色要決定
                    // 支付還是拒絕（教學見下方「可用動作」小節）。
                    const mMeta = m.metadata || {};
                    content = `${timeStr} ${formatMallOrderRecord({
                        kind: mMeta.mallKind === 'food' ? 'food' : 'shop',
                        mode: mMeta.mode === 'daifu' ? 'daifu' : mMeta.mode === 'manual' ? 'manual' : 'gift',
                        items: Array.isArray(mMeta.items) ? mMeta.items.map((i: any) => ({ name: String(i?.name || ''), qty: Number(i?.qty) || 1 })) : [],
                        amount: Number(mMeta.total) || 0,
                        status: mMeta.status === 'pending' || mMeta.status === 'accepted' || mMeta.status === 'declined' ? mMeta.status : 'sent',
                    })}`;
                }
                else if (m.type === 'social_card') {
                    const post = m.metadata?.post || {};
                    // Look up this character's own Spark handles (sub-accounts) so the model can
                    // recognise when a post or comment in the shared card was authored by itself.
                    let myHandles: string[] = [];
                    try {
                        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('spark_char_handles') : null;
                        if (raw) {
                            const all = JSON.parse(raw) || {};
                            const mine = Array.isArray(all[char.id]) ? all[char.id] : [];
                            myHandles = mine.map((h: any) => h?.handle).filter((s: any) => typeof s === 'string' && s.trim());
                        }
                    } catch {}
                    const myHandleSet = new Set(myHandles);

                    const userName = userProfile?.name || '用戶';
                    const tagAuthor = (name: string): string => {
                        if (!name) return '路人';
                        if (myHandleSet.has(name)) return `${name} (你自己的馬甲)`;
                        if (name === userName) return `${name} (用戶)`;
                        return name;
                    };

                    const postAuthorTag = tagAuthor(post.authorName || '路人');
                    const commentsSample = (post.comments || []).map((c: any) => `${tagAuthor(c.authorName)}: ${c.content}`).join(' | ');

                    let identityHint = '';
                    if (myHandles.length > 0) {
                        identityHint = `\n(你在 Spark 上的馬甲: ${myHandles.map(h => `"${h}"`).join(', ')}。如果上面的樓主或評論作者出現這些名字，那就是你自己發的，請按此自洽回應，不要把自己的馬甲當陌生人。)`;
                    }
                    const authoredByChar = myHandleSet.has(post.authorName);
                    const authoredByUser = (post.authorName || '') === userName;
                    let authorshipLine = '';
                    if (authoredByChar) authorshipLine = '\n(注意：這條 Spark 筆記的樓主是你自己的馬甲，用戶在向你轉發你自己發的帖子。)';
                    else if (authoredByUser) authorshipLine = '\n(注意：這條 Spark 筆記是用戶本人發的。)';

                    content = `${timeStr} [用戶分享了 Spark 筆記]\n樓主: ${postAuthorTag}\n標題: ${post.title}\n內容: ${post.content}\n熱評: ${commentsSample}${identityHint}${authorshipLine}\n(請根據你的性格對這個帖子發表看法，比如吐槽、感興趣或者不屑)`;
                }
                else if ((m.type as string) === 'xhs_card') {
                    const note = m.metadata?.xhsNote || {};
                    const sender = m.role === 'user' ? '用戶' : '你';
                    // 評論區：user 分享筆記時也帶上評論（抓取於建卡時），讓角色像瀏覽筆記一樣能看到評論，
                    // 不再出現「char 分享的能看評論、user 分享的看不到」的不對稱。
                    const noteComments = Array.isArray(note.comments) ? note.comments : [];
                    const commentsLine = noteComments.length
                        ? `\n熱評: ${noteComments.slice(0, 15).map((c: any) => `${c.author || '匿名'}: ${c.content}`).join(' | ')}`
                        : '';
                    const interactions = [
                        `${note.likes ?? 0}贊`,
                        note.collects != null ? `${note.collects}收藏` : '',
                        note.commentCount != null ? `${note.commentCount}評論` : '',
                        note.shareCount != null ? `${note.shareCount}分享` : '',
                    ].filter(Boolean).join(' ');
                    content = `${timeStr} [${sender}分享了小紅書筆記]\n標題: ${note.title || '無標題'}\n作者: ${note.author || '未知'}\n互動: ${interactions}\n簡介: ${note.desc || '無'}${commentsLine}\n${m.role === 'user' ? '(請根據你的性格對這個帖子發表看法)' : ''}`;
                }
                else if ((m.type as string) === 'vr_card') {
                    // vr_card：你自己進入 VR 社交遊戲《彼方》時留下的動態。
                    // 啟用了彼方的角色已在系統提示裡常駐"《彼方》是什麼"的設定，這裡就不再逐卡重複，
                    // 只留一句極簡標記省 token；沒啟用彼方的角色（可能是舊卡片）才補完整框定兜底。
                    const body = typeof m.content === 'string' ? m.content : '';
                    content = char.vrState?.enabled
                        ? `${timeStr}（你在《彼方》裡的動態）\n${body}`
                        : `${timeStr}（系統記錄：這是你之前自己進入 VR 社交遊戲《彼方》(功能上類似 VRChat) 時留下的動態——你確實進入並參與了這款遊戲，只是事情發生在遊戲世界裡。聊到時就當成"我在《彼方》裡做的事"來講，別說成現實裡發生的經歷。）\n${body}`;
                }
                else if ((m.type as string) === 'world_card') {
                    // world_card：你在「家園」共同世界裡的生活記錄（卡片正文已是可讀文本，
                    // 含小說式行為描述/動態/給同伴發的消息）。框定一句"這是共同世界裡的生活"，
                    // 防止角色把家園裡的事當成現實經歷、或在重度模式下把"無 user 世界"的內容
                    // 錯當成"我忽視了用戶"。
                    const body = typeof m.content === 'string' ? m.content : '';
                    const wMeta: any = m.metadata || {};
                    const frame = wMeta.mode === 'heavy'
                        ? '（你在共同世界「家園」裡的生活記錄——那個世界自成一體，裡面的關係與事件不必對應現實聊天；聊到時可以當成你最近的生活分享。）'
                        : '（你在共同世界「家園」裡的生活記錄——和你同世界的夥伴們一起生活時發生的事，聊到時當成自己最近的生活來講。）';
                    content = `${timeStr}${frame}\n${body}`;
                }
                else if ((m.type as string) === 'sim_card') {
                    // sim_card：用戶把一段「人格模擬」演出作為真實回憶送給你。
                    // 框定為「你真實經歷過的一段過往」，讓你可以在聊天中自然地擁有它帶來的心情與記憶。
                    const body = typeof m.content === 'string' ? m.content : '';
                    content = `${timeStr}（這是你真實經歷過的一段過往，由用戶珍藏並交還給你——當成自己的親身記憶來對待，它帶來的情緒與體會都是真的，聊到時可自然提及，但不必逐字複述。）\n${body}`;
                }
                else if ((m.type as string) === 'phone_card') {
                    // phone_card：你自己手機裡的內容（聊天/訂單/外賣/朋友圈/智能體等數字痕跡）。
                    // 框定為「你剛看了眼自己手機、這是裡面的隱私」——不暗示用戶在偷看，且帶一點"未必願意被看到"的私密感。
                    const pc: any = m.metadata?.phoneCard || {};
                    const body = typeof m.content === 'string' ? m.content : '';
                    content = `${timeStr}（你剛剛看了眼手機，這是你${pc.app || '手機'}裡的內容——這些是你自己的隱私，不一定願意讓其他人看到。當成手機裡確實有的東西即可，聊到再自然提及，不必主動說起。）\n${body}`;
                }
                else if ((m.type as string) === 'theater_card') {
                    // theater_card：用戶「窺視」了你某個時段的行為小劇場。那段演出就是你當時真實在做的事，
                    // 你自己當然記得。兩態都只是「留痕」——不強制你立刻回應；區別只在 exposed：
                    //   exposed=true  → 你發現 user 當時在旁邊看著你（你知道 ta 看到了）；
                    //   exposed=false → 你不知道 ta 看了（別表現得像被人盯著；這只是你自己那段時間的記憶）。
                    const tMeta: any = m.metadata || {};
                    const t: any = tMeta.theater || {};
                    const uName = userProfile?.name || '用戶';
                    const exposed = tMeta.exposed !== false; // 缺省按已暴露處理（兼容舊卡片）
                    const beat = Array.isArray(t.lines)
                        ? t.lines.map((l: any) => `· ${typeof l?.text === 'string' ? l.text : ''}`).filter((s: string) => s.length > 2).join('\n')
                        : '';
                    // 窺視的是「哪個具體時間」——晚上看上午時不能說成"剛剛/剛才"，要落到具體日期+時段+時刻。
                    const whenPhrase = theaterWhenPhrase(tMeta.date, tMeta.slotTime);
                    content = exposed
                        ? `${timeStr}（${uName} 把 ta 偷偷"窺視"到的、你${whenPhrase}「${tMeta.activity || '某個時段'}」時的樣子發給了你——也就是說，${whenPhrase}那會兒，${uName} 一直在旁邊悄悄觀察你。下面就是 ta 看到的、你當時真實在做的事：）\n${beat}\n（你這下知道自己${whenPhrase}那會兒被看到了。可以在對話裡自然地有所反應——害羞、好奇、嗔怪、或裝作不在意都行，但別逐字複述上面的內容；也不必非得立刻提起。）`
                        : `${timeStr}（這是你${whenPhrase}「${tMeta.activity || '某個時段'}」時真實在做的事，你自己當然記得——下面是當時的畫面：）\n${beat}\n（注意：你**並不知道** ${uName} 看到過這一幕，別表現得像被人觀察或偷看。這只是你自己那段時間的記憶，聊到相關話題時能自然對得上即可，不必主動提起。）`;
                }
                else if ((m.type as string) === 'html_card') {
                    // html_card：上下文裡只塞純文字摘要，剝離掉所有 HTML，省 token、不汙染 LLM 思考
                    const meta: any = m.metadata || {};
                    const preview = (typeof meta.htmlTextPreview === 'string' && meta.htmlTextPreview)
                        ? meta.htmlTextPreview
                        : (typeof m.content === 'string' ? m.content.replace(/^\[HTML卡片\]\s*/, '') : '');
                    const sender = m.role === 'user' ? '用戶' : '你';
                    // 注意：這行是「系統對已渲染卡片的佔位描述」，刻意包成括注 + 系統記錄口吻，
                    // 避免 LLM 把它當成"發卡片的正確寫法"照抄（會導致它輸出字面佔位句 + 純文字正文，
                    // 而不是真正的 [html]...[/html] 塊）。配合 htmlPrompt 裡的禁止照抄規則一起生效。
                    content = `${timeStr}（系統記錄：${sender}先前發送過一張 HTML 卡片，已在界面渲染；卡片文字摘要——${preview || '純視覺卡片'}。這只是歷史佔位，請勿複述本行；要再發卡片必須用 [html]...[/html] 包裹真正的 HTML。）`;
                }
                else if ((m.type as string) === 'mcd_card') {
                    const meta: any = m.metadata || {};
                    const userName = userProfile?.name || '用戶';
                    if (meta.mcdCardKind === 'cart' && Array.isArray(meta.mcdCartItems)) {
                        const items: any[] = meta.mcdCartItems;
                        const lines = items.map((c: any) => {
                            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
                            const priceStr = isFinite(p) && p > 0 ? ` ¥${p.toFixed(2)}` : '';
                            const codeStr = c.code ? ` (code:${c.code})` : '';
                            return `  - ${c.name}${priceStr} ×${c.qty}${codeStr}`;
                        }).join('\n');
                        const total = items.reduce((s: number, c: any) => {
                            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
                            return s + (isFinite(p) ? p * c.qty : 0);
                        }, 0);
                        const totalStr = total > 0 ? `\n  合計: ¥${total.toFixed(2)}` : '';
                        content = `${timeStr} [${userName}在菜單上選了下面的商品發給你, 等你回應:]\n${lines}${totalStr}\n(${userName}的意圖: 想看看你的意見, 比如熱量怎樣、要不要換搭配, 或者直接幫 ta 下單。請按你的人設自然回應, 別照搬我的描述。)`;
                    } else if (meta.mcdCardKind === 'candidate' && meta.mcdCandidate) {
                        const c: any = meta.mcdCandidate;
                        const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
                        const priceStr = isFinite(p) && p > 0 ? ` ¥${p.toFixed(2)}` : '';
                        const codeStr = c.code ? ` (code:${c.code})` : '';
                        content = `${timeStr} [${userName}在菜單上看到了「${c.name}」${priceStr}${codeStr}, 還沒決定要不要點, 想先聽聽你的意見]\n(請按你的人設自然回一兩句: 推薦 / 勸阻 / 調侃 / 建議搭配 / 提一下熱量 都行。這只是候選, 別直接調下單工具, 等 ta 真說"那就這個"或者一併選完再下手。)`;
                    } else if (meta.mcdToolName) {
                        content = `${timeStr} [麥當勞工具結果: ${meta.mcdToolName}]`;
                    }
                }
                else if (m.type === 'emoji') {
                     const stickerName = stickerNameFromUrl(emojis, m.content);
                     content = `${timeStr} [${m.role === 'user' ? '用戶' : '你'} 發送了表情包: ${stickerName}]`;
                }
                else if ((m.type as string) === 'chat_forward') {
                    try {
                        const fwd = JSON.parse(m.content);
                        const lines = (fwd.messages || []).map((fm: any) => {
                            const sender = fm.role === 'user' ? (fwd.fromUserName || '用戶') : (fwd.fromCharName || '角色');
                            const text = fm.type === 'image' ? '[圖片]' : fm.type === 'emoji' ? '[表情]' : (fm.content || '').slice(0, 200);
                            return `  ${sender}: ${text}`;
                        });
                        content = `${timeStr} [用戶轉發了與 ${fwd.fromCharName || '另一個角色'} 的 ${fwd.count || lines.length} 條聊天記錄]\n${lines.join('\n')}`;
                    } catch {
                        content = `${timeStr} [用戶轉發了一段聊天記錄]`;
                    }
                }
                else if ((m.type as string) === 'score_card') {
                    try {
                        const card = m.metadata?.scoreCard || JSON.parse(m.content);
                        const qixiCard = tryParseQixiEventChatCard(card);
                        if (card?.type === 'lifesim_reset_card') {
                            content = `${timeStr} ${formatLifeSimResetCardForContext(card, char?.name)}`;
                        } else if (qixiCard) {
                            content = `${timeStr} ${formatQixiEventCardForContext(qixiCard, 'char')}`;
                        } else if (card?.type === 'diary_card') {
                            const uName = card.userName || userProfile?.name || '用戶';
                            const userText = (card.userText || '').trim();
                            const charText = (card.charText || '').trim();
                            const userBlock = userText ? `${uName}的那頁寫道：\n「${userText}」` : `${uName}那頁是空的`;
                            const charBlock = charText ? `你的那頁回道：\n「${charText}」` : `你那頁是空的`;
                            content = `${timeStr} [交換日記 ${card.date || ''}] ${uName}和你通過【交換日記】app 交換了一篇日記，這是一次正式的、留下記錄的互動。\n${userBlock}\n${charBlock}\n（這是你們之間真實發生過的事，可以在後續聊天中自然提及。）`;
                        } else if (card?.type === 'guidebook_card') {
                            const diff = (card.finalAffinity ?? 0) - (card.initialAffinity ?? 0);
                            const uName = userProfile?.name || '用戶';
                            content = `${timeStr} [攻略本遊戲結算] 你和${uName}剛玩了一局"攻略本"戀愛小遊戲（${card.rounds || '?'}回合）。\n結局：「${card.title || '???'}」\n好感度變化：${card.initialAffinity} → ${card.finalAffinity}（${diff >= 0 ? '+' : ''}${diff}）\n你的評語：${card.charVerdict || '無'}\n你對${uName}的新發現：${card.charNewInsight || '無'}`;
                        } else if (card?.type === 'whiteday_card') {
                            const uName = userProfile?.name || '用戶';
                            const passedStr = card.passed ? `通過了測驗，解鎖了DIY巧克力環節` : `未通過測驗（${card.score}/${card.total}）`;
                            const questionsText = (card.questions as any[])?.map((q: any, i: number) =>
                                `第${i + 1}題：${q.question}\n${uName}選擇了"${q.userAnswer}"（${q.isCorrect ? '✓ 正確' : `✗ 錯誤，正確答案：${q.correctAnswer}`}）${q.review ? `\n你的評語：${q.review}` : ''}`
                            ).join('\n') || '';
                            content = `${timeStr} [白色情人節默契測驗結果] ${uName}完成了你出的白色情人節小測驗，答對了 ${card.score}/${card.total} 題，${passedStr}。\n${questionsText}\n你的最終評價：${card.finalDialogue || '無'}`;
                        } else {
                            // 兜底：上面沒被任何一種卡片認領的（比如各種活動卡）。這裡不能直接塞
                            // 消息原文 —— 卡片 JSON 通常一開頭就是 charAvatar 之類的圖片字段，
                            // 值是 blobref 令牌，正好落在前 200 字符裡，出門被還原成整張頭像的
                            // base64、每輪重發。改成按 card 重新序列化，圖片值先剝成佔位符再截斷。
                            const safeJson = card == null
                                ? ''
                                : (JSON.stringify(card, (_k, v) => (isMediaValue(v) ? '[圖片]' : v)) || '');
                            content = safeJson
                                ? `${timeStr} [系統卡片] ${safeJson.slice(0, 200)}`
                                : `${timeStr} [系統卡片]`;
                        }
                    } catch {
                        content = `${timeStr} [系統卡片]`;
                    }
                }
                else if ((m.type as string) === 'trpg_card' || (m.type as string) === 'novel_card') {
                    // TRPG 跑團片段 / 筆友會小說章節：從對應 app 多選轉發進來的內容。
                    // 複用 normalizeMessageContent 翻成完整文本，讓角色"記得"一起玩過/寫過什麼。
                    content = `${timeStr} ${normalizeMessageContent(m, char?.name || '你', userProfile?.name || '用戶')}`;
                }
                else content = `${timeStr} ${sourceTag} ${content}`;

                return { role: m.role, content };
            }),
            historySlice // Return original slice for Quote lookup
        };
    }
};
