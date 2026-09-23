import EmojiExportDialog from '../components/chat/EmojiExportDialog';
import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { isVisibleChatMessage } from '../utils/chatMessageVisibility';
import { chatReturnTarget } from '../utils/chatReturnTarget';
import { AppID, Message, MessageType, MemoryFragment, Emoji, EmojiCategory, DailySchedule, ScheduleSlot } from '../types';
import { processImage, processImageToBlob } from '../utils/file';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import { buildChatFineTuneCss, mergeChatFineTune } from '../utils/chatFineTuneCss';
import TokenImg from '../components/os/TokenImg';
import { generateDailyScheduleForChar, isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { generateInnerVoiceContent, generateAffinityValue, checkCustomMeterAutoUpdate } from '../utils/customMeterGenerator';
import { resolveCharacterMeterApi } from '../utils/characterApi';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { useLocalDateKey } from '../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../utils/timezone';
import { generateSlotTheater } from '../utils/theaterGenerator';
import TheaterPlayer from '../components/schedule/TheaterPlayer';
import { buildSARMemoryBoundaryInstruction, formatMessageWithTime, normalizeMessageContent } from '../utils/messageFormat';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { XhsMcpClient, extractNotesFromMcpData, normalizeXhsLiteDetail } from '../utils/xhsMcpClient';
import { extractWebpageContent, detectFirstUrl, detectXhsShortUrl, extractXhsShareTitle, isXhsUrl, extractXhsNoteLink, expandShortUrl, type ExtractedWebpage } from '../utils/webpageExtractor';
import { isVideoShareUrl, parseVideoShareUrl } from '../utils/videoParser';
import { isDevDebugAvailable } from '../utils/devDebug';
import { isImageValue, migrateDataUrlToRef, putImageBlob, useBlobRefUrl, getBlobForRef, deleteBlobRefIfUnreferenced } from '../utils/blobRef';
import { generateImage, buildCharacterImagePrompt, resolveCharacterReferenceImage } from '../utils/imageGeneration';
import { resolveUserProfileForChar } from '../utils/userPersona';
import { ensureRealBalanceState, applyRealBalanceDelta } from '../utils/realBalance';
import { buildReplySnapshotContent } from '../utils/applyAssistantPostProcessing';
import { resolveLifeRecordCard } from '../utils/lifeRecords';
import { isMcdConfigured } from '../utils/mcdMcpClient';
import { isMcdActivatedInMessages, MCD_ACTIVATE_TRIGGER, MCD_DEACTIVATE_TRIGGER } from '../utils/mcdToolBridge';
import { isLuckinConfigured } from '../utils/luckinMcpClient';
import { isLuckinActivatedInMessages, LUCKIN_ACTIVATE_TRIGGER, LUCKIN_DEACTIVATE_TRIGGER } from '../utils/luckinToolBridge';
import MessageItem, { ThinkingChainBlock } from '../components/chat/MessageItem';
import McdMiniApp from '../components/mcd/McdMiniApp';
import LuckinMiniApp from '../components/luckin/LuckinMiniApp';
import ShoppingMallMiniApp from '../components/mall/ShoppingMallMiniApp';
import LuckinLocationModal from '../components/luckin/LuckinLocationModal';
import LuckinHelpModal from '../components/luckin/LuckinHelpModal';
import { PRESET_THEMES, DEFAULT_ARCHIVE_PROMPTS } from '../components/chat/ChatConstants';
import { resolveChatTheme } from '../utils/groupChat/theme';
import ChatHeader from '../components/chat/ChatHeaderShell';
import CharacterEntryTransition from '../components/chat/CharacterEntryTransition';
import {resolveDecorationTheme} from '../utils/chatDecoration';
import ChatDecorationAnnouncement from '../components/chat/ChatDecorationAnnouncement';
import ChatDecorationPanel, {DecorationTab} from '../components/chat/ChatDecorationPanel';
import ChatInputArea from '../components/chat/ChatInputArea';
import { loadChatInputPreferences, saveChatInputPreferences } from '../utils/chatInputPreferences';
import InstantChatRouteNotice from '../components/chat/InstantChatRouteNotice';
import MemoryRepairPortal from '../components/chat/MemoryRepairPortal';
import FavoritesPortal from '../components/chat/VoiceFavoritesPortal';
import ChatModals from '../components/chat/ChatModals';
import type { ChatSettingsPatch } from '../components/chat/ChatSettingsPage';
import ChatHistoryCleanupModal from '../components/chat/ChatHistoryCleanupModal';
import type { ChatCleanupPlan } from '../utils/chatHistoryCleanup';
import Modal from '../components/os/Modal';
import ProactiveSettingsModal from '../components/chat/ProactiveSettingsModal';
import ActiveMsg2SettingsModal from '../components/chat/ActiveMsg2SettingsModal';
import ThinkingChainSettingsModal from '../components/chat/ThinkingChainSettingsModal';
import ScheduleChangeNotice from '../components/chat/ScheduleChangeNotice';
import { useChatAI } from '../hooks/useChatAI';
import { useChatAutoReply } from '../hooks/useChatAutoReply';
import { cleanTextForTts, parseVoiceOutput } from '../utils/minimaxTts';
import { collectVoiceBatchSubtitle, isPoisonedVoiceSubtitle } from '../utils/voiceSubtitle';
import {
    canSynthesizeSpeech,
    characterHasVoice,
    cleanTextForTtsProvider,
    providerUsesRawVoiceMarkup,
    stripTtsMarkupForDisplay,
    synthesizeSpeechDetailed,
} from '../utils/ttsRouter';
import { playVoiceAudio, primeVoiceAudio, stopVoiceAudio, voicePlaybackErrorMessage, shouldAutoGenerateVoice, shouldAutoPlayGeneratedVoice } from '../utils/voicePlayback';
import { voiceLanguageAnalyticsValue, voiceLanguagePromptLabel } from '../utils/voiceLanguage';
import { fetchBlobForShare, shareOrDownloadBlob } from '../utils/shareExport';
import { CollaborationStore } from '../features/collaboration/store';
import { resolveTtsProvider } from '../utils/ttsProvider';
import { resolveActiveSound, playWhiteboxSound, unlockWhiteboxAudio } from '../utils/whiteboxSound';
import { normalizeTranslationLangLabel, isTranslationLangPreset } from '../utils/translationLang';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent, noteMessageSent, presetOrCustom } from '../utils/analytics';
import { markAmsgStateDirty, markAmsgStateDirtyForAll } from '../utils/amsgStateSync';
import { AMSG_INSTANT_CHAT_PENDING_EVENT, AMSG_INSTANT_CHAT_PENDING_LS_KEY, getInstantChatPending } from '../utils/amsgInstantChat';
import { formatAmsgToolTrace } from '../utils/amsgToolTrace';
import { formatHours } from '../utils/format';
import { resolveSARModuleSpeechSource } from '../utils/vrWorld/sarModuleRuntime';
import {
    VOICE_FAVORITES_CHANGED_EVENT,
    getVoiceFavorite,
    listVoiceFavorites,
    removeVoiceFavorite,
    saveVoiceFavorite,
} from '../utils/voiceFavorites';
import {
    CONTENT_FAVORITES_CHANGED_EVENT,
    contentFavoriteIdForMessage,
    listContentFavorites,
    removeContentFavoriteById,
    saveMessageContentFavorite,
} from '../utils/contentFavorites';
import { SCHEDULE_CHANGE_EVENT, type ScheduleChangeEventDetail } from '../utils/scheduleChange';
import { DELAYED_REPLY_DUE_EVENT } from '../utils/delayedReply';
import { scheduleDelayedReplyFor } from '../utils/delayedReplyRuntime';
import { cancelDelayedReplyEverywhere, handoffDelayedReplyToCloud } from '../utils/delayedReplyCloud';
import {
    CONTEXT_RANGE_POLICY_VERSION,
    computeContextRangeSnapshot,
    countMessagesFrom,
    getMemoryPalaceHighWaterMarkForContext,
    loadCharacterContextRange,
    resolveContextRangeMode,
    type ContextRangeMode,
} from '../utils/chatContextRange';
import {
    createChatHistoryWindow,
    expandChatHistoryWindow,
    type ChatHistoryWindowRange,
} from '../utils/chatHistoryWindow';
import type { CollaborationTransferMessage } from '../features/collaboration/types';
import type { CollaborationInstallableArtifact } from '../features/collaboration/types';
import {
    installableToCharacterPatch,
    installableToChatTheme,
    installableToThemePatch,
    installableToWorldbooks,
    validateInstallableArtifact,
} from '../features/collaboration/makers';
import { upsertMountedWorldbooks } from '../utils/worldbook';
import { equalsAnyScript } from '../utils/scriptKey';

const CollaborationWindow = React.lazy(() => import('../features/collaboration/CollaborationWindow'));

const HISTORY_WINDOW_RADIUS = 25;
const HISTORY_WINDOW_BATCH_SIZE = 30;

/** 即時對話那一輪回復「推送陸續到齊」的寬限時間，也就是自動合成的補掃窗口有多長（見下面的 auto-TTS effect）。 */
const INSTANT_VOICE_SCAN_WINDOW_MS = 30_000;

const Chat: React.FC = () => {
    const { activeApp, openApp, characters, activeCharacterId, setActiveCharacterId, addCharacter, updateCharacter, updateUserProfile, apiConfig, apiPresets, availableModels, addApiPreset, closeApp, customThemes, addCustomTheme, removeCustomTheme, addWorldbook, updateTheme, saveAppearancePreset, addToast, showError, userProfile, userProfileBase, lastMsgTimestamp, groups, characterGroups, clearUnread, unreadMessages, realtimeConfig, memoryPalaceConfig, updateMemoryPalaceConfig, remoteVectorConfig, syncEmotionApiToAllCharacters, theme: baseOsTheme, proactiveComposingChars, openDateWithChar } = useOS();
    const osTheme = useMemo(()=>resolveDecorationTheme(baseOsTheme,characters.find(c=>c.id===activeCharacterId)||characters[0]),[baseOsTheme,characters,activeCharacterId]);
    // 從 Chat 主頁（消息/聯繫人 tab）點進來的私聊，返回鍵回 Chat 主頁而不是無腦回桌面；
    // 別的入口（角色卡「發消息」、伴侶桌面皮膚的「對話」按鈕等）沒設這個，行為不變。
    const handleChatClose = useCallback(() => {
        const target = chatReturnTarget.consume();
        if (target) openApp(target); else closeApp();
    }, [openApp, closeApp]);
    const isProactiveComposing = !!(activeCharacterId && proactiveComposingChars[activeCharacterId]);
    const localDateKey = useLocalDateKey();

    // 記憶宮殿高水位（用於清空聊天時的安全檢查）
    const getMemoryPalaceHWM = useCallback(async (charId: string): Promise<number> => {
        try {
            const { getMemoryPalaceHighWaterMark } = await import('../utils/memoryPalace/pipeline');
            return getMemoryPalaceHighWaterMark(charId);
        } catch { return 0; }
    }, []);
    const [messages, setMessages] = useState<Message[]>([]);
    // 即時對話：這一輪已經交給雲端、還沒等到回覆。它跟 isTyping 不一樣——生成不在這台
    // 設備上跑，所以要扛得住關頁面重開（記錄落在 localStorage，見 amsgInstantChat）。
    const [instantChatPending, setInstantChatPending] = useState(false);
    const [totalMsgCount, setTotalMsgCount] = useState(0);
    const [visibleCount, setVisibleCount] = useState(30);
    const [windowedFocusMsgId, setWindowedFocusMsgId] = useState<number | null>(null);
    const [historyWindowRange, setHistoryWindowRange] = useState<ChatHistoryWindowRange | null>(null);
    const [flashMsgId, setFlashMsgId] = useState<number | null>(null);
    // 角色切換/進入時的緩入開關：先 false（透明），下一幀轉 true，靠 CSS transition 平滑淡入。
    // 初值 false 讓首次打開也是淡入、且不會有"先顯示再變透明"的閃爍。
    // 角色切換「登場」過場是否顯示。切換/進入角色時由 useLayoutEffect 在繪製前置真，覆蓋住加載、避免閃到新聊天。
    const [showEntry, setShowEntry] = useState(false);
    const [input, setInput] = useState('');
    const [isInputFocused, setIsInputFocused] = useState(false);
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const [collaborationOpen, setCollaborationOpen] = useState(false);
    const [collaborationPreviewAssetId, setCollaborationPreviewAssetId] = useState<string | null>(null);
    const [memoryRepairOpen, setMemoryRepairOpen] = useState(false);
    const [favoritesOpen, setFavoritesOpen] = useState(false);
    
    // Emoji State
    const [emojis, setEmojis] = useState<Emoji[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]);
    const [activeCategory, setActiveCategory] = useState<string>('default');
    const [newCategoryName, setNewCategoryName] = useState('');
    const [emojiExport, setEmojiExport] = useState<{ emojis: Emoji[]; title: string } | null>(null);
    const [newEmojiName, setNewEmojiName] = useState(''); // 表情包重命名輸入框

    const scrollRef = useRef<HTMLDivElement>(null);
    const lastMsgIdRef = useRef<number | null>(null);
    // 最新圖片在移動端異步解碼後會把消息列表繼續向下撐開。記錄這一條，等真實高度
    // 確定後再補一次貼底；用戶一旦主動向上翻，就清掉它，絕不搶滾動位置。
    const pendingMediaAutoScrollIdRef = useRef<number | null>(null);
    const scrollThrottleRef = useRef(0);
    const visibleCountRef = useRef(30);
    const pendingFavoriteJumpRef = useRef<{ charId: string; messageId: number } | null>(null);
    const historyWindowRangeRef = useRef<ChatHistoryWindowRange | null>(null);
    const historyWindowTotalRef = useRef(0);
    const historyWindowLoadingRef = useRef(false);
    const historyPrependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const historyJumpUnlockTimerRef = useRef<number | null>(null);
    const historyWindowScrollEnabledRef = useRef(false);
    const activeCharIdRef = useRef(activeCharacterId);
    // 流式預覽接棒過的正式消息在當前會話內始終跳過入場動畫，避免後續 DB 刷新時動畫類又被加回來。
    const streamPreviewHandoverIdsRef = useRef<Set<number>>(new Set());
    const registerStreamPreviewHandover = useCallback((charId: string, messageIds: number[]) => {
        if (activeCharIdRef.current !== charId) return;
        messageIds.forEach(id => streamPreviewHandoverIdsRef.current.add(id));
    }, []);
    const charRef = useRef<typeof char>(null as any);
    // 白框提示音：記錄當前角色"見過的最大消息 ID" + "上一條氣泡到達時刻"，一輪回復只在首條氣泡響一次。
    // 用 max-id 基線天然免疫：切角色/進入(先記基線不播)、翻舊歷史(末尾 ID 變小不響)、自己發消息(role≠assistant 不響)。
    // lastAt 做回合去重：ta 一輪回復拆成多條氣泡逐條下發（間隔 ≤2s），距上一條氣泡 >3s 才算新回合、才響。
    const soundSyncRef = useRef<{ charId: string | null; maxId: number | null; lastAt: number | null }>({ charId: null, maxId: null, lastAt: null });
    // 回合去重閾值：氣泡間最大間隔 = clamp(字數×50,500,2000)=2s，取 3s 安全合併同一輪，跨輪(LLM 延遲)一般遠大於此。
    const SOUND_ROUND_GAP_MS = 3000;

    // Reply Logic
    const [replyTarget, setReplyTarget] = useState<Message | null>(null);

    const [modalType, setModalType] = useState<'none' | 'transfer' | 'emoji-import' | 'chat-settings' | 'message-options' | 'edit-message' | 'delete-emoji' | 'delete-category' | 'add-category' | 'history-manager' | 'archive-settings' | 'prompt-editor' | 'category-options' | 'category-visibility' | 'emoji-options' | 'rename-emoji' | 'rename-category' | 'schedule' | 'chrome-css' | 'chrome-sound' | 'memory-vectorize-confirm' | 'memory-vectorize-result' | 'image-zoom'>('none');
    // 「聊天裝扮」懸浮態：不走全屏 modal——圓氣泡掛在聊天上，點開小面板邊看真聊天邊調。
    const [decorationTab, setDecorationTab] = useState<DecorationTab>('layout');
    // 切換角色時收掉裝扮氣泡：定製是 per-character 的，避免誤改到下一個角色
    const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
    const [scheduleChangeNotice, setScheduleChangeNotice] = useState<ScheduleChangeEventDetail | null>(null);
    const dismissScheduleChangeNotice = useCallback(() => setScheduleChangeNotice(null), []);
    // 小劇場（窺視演出）：正在播放的時段索引（null = 未打開），以及生成中標誌
    const [theaterSlotIdx, setTheaterSlotIdx] = useState<number | null>(null);
    const [isTheaterGenerating, setIsTheaterGenerating] = useState(false);
    const [isScheduleGenerating, setIsScheduleGenerating] = useState(false);
    const [allHistoryMessages, setAllHistoryMessages] = useState<Message[]>([]);
    const [transferAmt, setTransferAmt] = useState('');
    const [transferNote, setTransferNote] = useState('');
    const [emojiImportText, setEmojiImportText] = useState('');
    const [settingsContextLimit, setSettingsContextLimit] = useState(500);
    const [settingsContextRangeMode, setSettingsContextRangeMode] = useState<ContextRangeMode>('manual');
    const [settingsHideSysLogs, setSettingsHideSysLogs] = useState(false);
    const [inputPreferences, setInputPreferences] = useState(loadChatInputPreferences);
    const [settingsInputPreferences, setSettingsInputPreferences] = useState(loadChatInputPreferences);
    const [settingsHtmlModeCustomPrompt, setSettingsHtmlModeCustomPrompt] = useState('');
    const contextSuiteAnyEnabled = memoryPalaceConfig.featureFlags?.recallRouter === true
        || memoryPalaceConfig.featureFlags?.interactionAdaptation === true
        || memoryPalaceConfig.featureFlags?.deepEngagement === true;
    const contextSuiteAllEnabled = memoryPalaceConfig.featureFlags?.recallRouter === true
        && memoryPalaceConfig.featureFlags?.interactionAdaptation === true
        && memoryPalaceConfig.featureFlags?.deepEngagement === true;
    const [isVectorizing, setIsVectorizing] = useState(false);
    // 記憶宮殿「一鍵存入」：打開設置彈窗時算出待處理條數（排除熱區的真實口徑），處理中顯示逐輪進度
    const [vectorizePendingCount, setVectorizePendingCount] = useState<number | null>(null);
    const [vectorizeProgress, setVectorizeProgress] = useState('');
    const [retainRecentForVectorize, setRetainRecentForVectorize] = useState(false);
    const [vectorizeResult, setVectorizeResult] = useState<{
        processedMessages: number;
        storedMemories: number;
        retainedMessages: number;
        waterlineAlreadyAhead: boolean;
    } | null>(null);
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [selectedEmoji, setSelectedEmoji] = useState<Emoji | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<EmojiCategory | null>(null); // For deletion modal
    const [editContent, setEditContent] = useState('');
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [archiveProgress, setArchiveProgress] = useState('');
    const [showProactiveModal, setShowProactiveModal] = useState(false);
    const [showActiveMsg2Modal, setShowActiveMsg2Modal] = useState(false);
    const [showThinkingChainModal, setShowThinkingChainModal] = useState(false);

    // Archive Prompts State
    const [archivePrompts, setArchivePrompts] = useState<{id: string, name: string, content: string}[]>(DEFAULT_ARCHIVE_PROMPTS);
    const [selectedPromptId, setSelectedPromptId] = useState<string>('preset_rational');
    const [editingPrompt, setEditingPrompt] = useState<{id: string, name: string, content: string} | null>(null);

    // --- Multi-Select State ---
    const [selectionMode, setSelectionMode] = useState(false);
    const [showHistoryCleanup, setShowHistoryCleanup] = useState(false);
    useEffect(() => setShowHistoryCleanup(false), [activeCharacterId]);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());
    // 思維鏈是 metadata.thinkingChain，沒有獨立 id，所以用宿主消息 id 作為鍵，
    // 與 selectedMsgIds 並行存在 —— 只勾思維鏈時只清 metadata，宿主消息保留。
    const [selectedThinkingMsgIds, setSelectedThinkingMsgIds] = useState<Set<number>>(new Set());

    // --- Translation State (per-character) ---
    const [translationEnabled, setTranslationEnabled] = useState(() => {
        try { return JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'); } catch { return false; }
    });
    const [translateSourceLang, setTranslateSourceLang] = useState(() => {
        // Fallback to legacy global key so existing users don't lose their setting on upgrade.
        return normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_source_lang_${activeCharacterId}`)
            || localStorage.getItem('chat_translate_source_lang')
            || '日本語') || '日本語';
    });
    const [translateTargetLang, setTranslateTargetLang] = useState(() => {
        return normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_lang_${activeCharacterId}`)
            || localStorage.getItem('chat_translate_lang')
            || '中文') || '中文';
    });
    const [translationExpanded, setTranslationExpanded] = useState(() => {
        try { return JSON.parse(localStorage.getItem(`chat_translate_expanded_${activeCharacterId}`) || 'false'); } catch { return false; }
    });
    // Which messages are currently showing "譯" version (toggle state only, no API calls)
    const [showingTargetIds, setShowingTargetIds] = useState<Set<number>>(new Set());

    const char = characters.find(c => c.id === activeCharacterId) || characters[0];
    // 分角色身份指定：這個私聊裡「你」該是哪張身份卡，按 char.id 單獨解析——不看全域默認，
    // 除非這個角色沒有單獨指定。下面所有原本讀 userProfile 的地方（AI 提示詞/氣泡頭像/
    // 主動消息打髒快照……）只要是「這個聊天窗口裡的你」，都改吃這份，而不是全域 userProfile。
    const chatUserProfile = useMemo(
        () => (char ? resolveUserProfileForChar(userProfileBase, char.id) : userProfile),
        [char, userProfileBase, userProfile],
    );
    const memoryRepairRound = useMemo(() => {
        let assistantIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                assistantIndex = i;
                break;
            }
        }
        if (assistantIndex < 0) {
            return { sinceTs: Date.now(), userMessage: '', assistantReply: '' };
        }
        let userIndex = -1;
        for (let i = assistantIndex - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                userIndex = i;
                break;
            }
        }
        const assistantReply = messages
            .slice(userIndex + 1)
            .filter(message => message.role === 'assistant')
            .map(message => message.content)
            .join('\n');
        return {
            // receipt 在用戶消息落庫之後、助手回覆落庫之前產生；留 1 秒時鐘誤差容差。
            sinceTs: userIndex >= 0 ? Math.max(0, messages[userIndex].timestamp - 1000) : messages[assistantIndex].timestamp - 60_000,
            userMessage: userIndex >= 0 ? messages[userIndex].content : '',
            assistantReply,
        };
    }, [messages]);
    const charDateKey = useLocalDateKey(resolveCharTimeZone(char));
    charRef.current = char; // Keep ref in sync for async callbacks
    const historyContextRange = useMemo(() => {
        if (!char) return undefined;
        return computeContextRangeSnapshot(
            allHistoryMessages,
            {
                ...char,
                contextRangeMode: settingsContextRangeMode,
                contextLimit: settingsContextLimit,
            },
            getMemoryPalaceHighWaterMarkForContext(char.id),
        );
    }, [
        allHistoryMessages,
        char,
        settingsContextLimit,
        settingsContextRangeMode,
    ]);
    useEffect(() => {
        if (
            modalType !== 'history-manager'
            || allHistoryMessages.length === 0
            || !char?.contextUserStartMessageId
            || !historyContextRange?.userBreakpointExpired
        ) return;
        // 最大範圍已經向前越過用戶斷點：立即清掉持久化斷點，防止以後拉大時舊斷點復活。
        updateCharacter(char.id, { contextUserStartMessageId: undefined });
    }, [
        modalType,
        allHistoryMessages.length,
        char?.id,
        char?.contextUserStartMessageId,
        historyContextRange?.userBreakpointExpired,
        updateCharacter,
    ]);
    const currentThemeId = char?.bubbleStyle || osTheme.chatDefaultBubbleStyle || 'default';
    // 解析邏輯抽到 utils/groupChat/theme.ts（群聊共用），行為不變
    const activeTheme = useMemo(
        () => resolveChatTheme(currentThemeId, customThemes, PRESET_THEMES),
        [currentThemeId, customThemes],
    );
    const draftKey = `chat_draft_${activeCharacterId}`;

    // Filter categories and emojis by active character's visibility (used for both AI prompt and UI)
    const visibleCategories = useMemo(() => categories.filter(cat => {
        if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;
        return cat.allowedCharacterIds.includes(activeCharacterId);
    }), [categories, activeCharacterId]);

    const aiVisibleEmojis = useMemo(() => {
        const hiddenIds = new Set(categories.filter(c => !visibleCategories.some(vc => vc.id === c.id)).map(c => c.id));
        if (hiddenIds.size === 0) return emojis;
        return emojis.filter(e => !e.categoryId || !hiddenIds.has(e.categoryId));
    }, [emojis, categories, visibleCategories]);




    // 小程序快照 ref: MiniApp 狀態變化時塞進來, useChatAI 在 build system prompt 時讀取並注入
    const mcdMiniAppRef = useRef<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>(undefined);
    const luckinMiniAppRef = useRef<import('../utils/luckinToolBridge').LuckinMiniAppSnapshot | undefined>(undefined);
    // 瑞幸聊天點單模式 (點"瑞一杯"激活: 角色直接調真實工具, 注入定位)
    const luckinChatRef = useRef<import('../utils/luckinToolBridge').LuckinChatState | undefined>(undefined);

    // 生成閉包的回落守衛：triggerAI 的異步閉包在用戶切到別的角色後才完成時（Chat 內
    // 切角色不卸載組件），遲到的 setMessages 會把舊角色的消息灌進當前會話視圖。
    // 按消息 charId 丟棄不屬於當前會話的回落——DB 已落庫，且 OSContext 會因
    // chat-gen-reply-arrived bump lastMsgTimestamp，切回該角色時自然取回。
    const setMessagesFromGen = useCallback((msgs: Message[]) => {
        if (msgs.some(m => m.charId && m.charId !== activeCharIdRef.current)) return;
        setMessages(msgs);
    }, []);

    // 即時對話的「正在輸入…」：受理 / 收到回覆 / 超時判失敗都會廣播一次，界面跟著它亮滅。
    // 進這個角色時先讀一次落盤記錄——上一輪的回覆可能是在應用關著的時候還沒回來。
    // 這個 CustomEvent 只在本標籤頁內派發；別的標籤頁銷帳走下面那個 storage 監聽
    //（搜 AMSG_INSTANT_CHAT_PENDING_LS_KEY）。
    useEffect(() => {
        const sync = () => setInstantChatPending(!!activeCharacterId && !!getInstantChatPending(activeCharacterId));
        sync();
        window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, sync);
        return () => window.removeEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, sync);
    }, [activeCharacterId]);

    // --- Initialize Hook ---
    const { isTyping, streamingBubbles, streamingThinking, streamingHandoverIds, recallStatus, searchStatus, diaryStatus, emotionStatus, memoryPalaceStatus, memoryPalaceResult, setMemoryPalaceResult, lastDigestResult, setLastDigestResult, lastTokenUsage, tokenBreakdown, setLastTokenUsage, triggerAI, startProactiveChat, stopProactiveChat, isProactiveActive } = useChatAI({
        char,
        userProfile: chatUserProfile,
        apiConfig,
        groups,
        emojis: aiVisibleEmojis,
        categories: visibleCategories,
        addToast,
        showError,
        setMessages: setMessagesFromGen,
        onStreamPreviewHandover: registerStreamPreviewHandover,
        realtimeConfig,
        translationConfig: translationEnabled
            ? { enabled: true, sourceLang: translateSourceLang, targetLang: translateTargetLang }
            : undefined,
        memoryPalaceConfig,
        mcdMiniAppRef,
        luckinMiniAppRef,
        luckinChatRef,
        updateCharacter,
        updateUserProfile,
    });

    // --- Voice TTS for chat messages ---
    interface VoiceData { url: string; originalText: string; spokenText?: string; lang?: string; favorite?: boolean; }
    // Persisted shape (IndexedDB assets store). `blob` is the raw audio;
    // `remoteUrl` is the fallback when fetching the MiniMax CDN blob was blocked by CORS.
    interface StoredVoice {
        blob?: Blob;
        remoteUrl?: string;
        favorite?: boolean;
        originalText: string;
        spokenText?: string;
        lang?: string;
    }
    type GeneratedVoiceData = VoiceData & { blob: Blob | null };
    const voiceAssetKey = (msgId: number) => `voice_msg_${msgId}`;
    const chatFavoriteSourceKey = (msg: Pick<Message, 'charId' | 'id'>) => `${msg.charId}:${msg.id}`;
    const [voiceDataMap, setVoiceDataMap] = useState<Record<number, VoiceData>>({});
    const [chatFavoriteKeys, setChatFavoriteKeys] = useState<Set<string>>(new Set());
    const [contentFavoriteIds, setContentFavoriteIds] = useState<Set<string>>(new Set());
    const [voiceLoading, setVoiceLoading] = useState<Set<number>>(new Set());
    const [playingMsgId, setPlayingMsgId] = useState<number | null>(null);
    const chatAudioRef = useRef<HTMLAudioElement | null>(null);
    const voiceRequestsRef = useRef(new Set<number>());
    const voiceMountedRef = useRef(true);
    const prevIsTypingRef = useRef(false);
    // 即時對話那條路的自動合成掃描窗（用法見下面那個 auto-TTS 的 effect）：
    // 「正在輸入」燈滅的那一下開窗，窗口內每次消息變化都補掃一遍；角色不對就整個作廢。
    const prevInstantPendingRef = useRef(false);
    const instantVoiceScanUntilRef = useRef(0);
    const instantVoiceScanCharRef = useRef<string | undefined>(undefined);
    // 自動合成失敗過的消息 id。掃描窗裡每來一條新消息都會重掃一遍，不記下來的話同一條失敗的
    // 消息會被反覆重試、每次再彈一個「語音生成失敗」。只擋自動那條路：用戶自己點「轉換語音」
    // 照樣能重試（換了網絡/補了 key 之後就該能成）。換角色時清空。
    const voiceFailedRef = useRef<Set<number>>(new Set());
    // Track blob: URLs we created so we can revoke them on character switch / unmount.
    const voiceBlobUrlsRef = useRef<Set<string>>(new Set());
    // We warn the user at most once (per character) that the active TTS provider isn't configured —
    // a character can produce many <語音> messages and we don't want to spam toasts.
    const ttsWarnedRef = useRef(false);

    /** Whether this character can synthesize real voice under the active TTS provider (key + a voice profile). */
    const isTtsReady = useCallback(() => canSynthesizeSpeech(char, apiConfig), [char, apiConfig]);

    const persistVoice = async (msgId: number, url: string, blob: Blob | null, originalText: string, spokenText: string | undefined, lang: string | undefined) => {
        try {
            const stored: StoredVoice = blob
                ? { blob, originalText, spokenText, lang, favorite: false }
                : { remoteUrl: url, originalText, spokenText, lang, favorite: false };
            await DB.saveAssetRaw(voiceAssetKey(msgId), stored);
        } catch (e) {
            console.warn('[Chat] persist voice failed', e);
        }
    };

    /** Drop in-memory + on-disk voice data for the given message ids. */
    const discardVoiceForMessages = (ids: Iterable<number>, deletePersisted = true) => {
        const idList = Array.from(ids);
        if (!idList.length) return;
        setVoiceDataMap(prev => {
            let changed = false;
            const next = { ...prev };
            for (const id of idList) {
                const entry = next[id];
                if (!entry) continue;
                if (entry.url && entry.url.startsWith('blob:')) {
                    try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
                    voiceBlobUrlsRef.current.delete(entry.url);
                }
                delete next[id];
                changed = true;
            }
            return changed ? next : prev;
        });
        if (!deletePersisted) return; // 區間清理已在同一事務中刪掉磁盤語音。
        // Best-effort: remove persisted entries so they don't reappear on next load.
        for (const id of idList) {
            DB.deleteAsset(voiceAssetKey(id)).catch(() => { /* ignore */ });
        }
    };

    const prepareChatAudio = () => {
        if (!chatAudioRef.current) chatAudioRef.current = new Audio();
        return chatAudioRef.current;
    };
    const playChatVoice = (msgId: number, url: string) => {
        void playVoiceAudio(prepareChatAudio(), url, {
            onPlaying: () => setPlayingMsgId(msgId),
            onStopped: () => setPlayingMsgId(null),
            onError: error => addToast(voicePlaybackErrorMessage(error), 'info'),
        });
    };

    const handlePlayVoice = (msgId: number) => {
        const data = voiceDataMap[msgId];
        if (!data) {
            // No voice data yet — trigger TTS generation (e.g. placeholder voice bar clicked)
            const msg = messages.find(m => m.id === msgId);
            if (msg) handleManualTts(msg, false);
            return;
        }
        const audio = prepareChatAudio();
        if (playingMsgId === msgId) {
            stopVoiceAudio(audio);
            setPlayingMsgId(null);
            return;
        }
        playChatVoice(msgId, data.url);
    };

    // 穩定的播放回調：用 ref 持有最新閉包，引用永不變 —— 避免每條消息每次渲染都新建箭頭函數，
    // 否則 MessageItem 的 React.memo 會被擊穿（30 條重組件每次都全量重渲染 = 進入聊天卡頓主因之一）。
    const handlePlayVoiceRef = useRef(handlePlayVoice);
    handlePlayVoiceRef.current = handlePlayVoice;
    const onPlayVoiceStable = useCallback((id: number) => handlePlayVoiceRef.current(id), []);

    // LLM 翻譯兜底（語音條中外對照用）。查 res.ok + 失敗重試一次 ——
    // 以前不查狀態碼、失敗靜默吞掉，翻譯一次拿不到就永遠空著（「外語語音沒翻譯」主因）。
    const llmTranslate = async (systemPrompt: string, text: string): Promise<string> => {
        const attempt = async (): Promise<string> => {
            const res = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
                    temperature: 0.3,
                }),
            });
            if (!res.ok) throw new Error(`translate http ${res.status}`);
            const data = await res.json();
            return data?.choices?.[0]?.message?.content?.trim() || '';
        };
        try { return await attempt(); }
        catch { try { return await attempt(); } catch { return ''; } }
    };

    const handleManualTts = async (msg: Message, autoTriggered = false): Promise<GeneratedVoiceData | null> => {
        if (voiceRequestsRef.current.has(msg.id)) return null;
        if (voiceDataMap[msg.id]) {
            if (autoTriggered) return null;
            // 手動點「轉換語音」= 用戶要求重新生成（典型場景：編輯了消息內容後）。
            // 丟掉這條舊語音再走正常合成；文本沒變時會命中共享 TTS 緩存，不會重複請求 API。
            discardVoiceForMessages([msg.id]);
        }

        // SAR 模塊改變的是角色真正“發到外面/念出來”的表達。content 仍保存真意供上下文與
        // 總結讀取，但 TTS 必須優先讀 surface；否則會出現氣泡是古風、耳朵聽到原台詞的穿幫。
        const voiceSourceContent = resolveSARModuleSpeechSource(msg);
        const sarVoiceSurface = voiceSourceContent !== msg.content;
        // Parse the structured voice output: spoken text (sanitized) + per-message emotion.
        const parsedVoice = parseVoiceOutput(voiceSourceContent);
        // Fish / ElevenLabs 的適配器需要看到原始 inline cue；MiniMax 使用已消毒的 speech。
        const ttsProvider = resolveTtsProvider(apiConfig);
        const preserveRawMarkup = providerUsesRawVoiceMarkup(apiConfig);
        const voiceTagContent = parsedVoice.hasVoiceTag ? (preserveRawMarkup ? parsedVoice.rawSpeech : parsedVoice.speech) : '';
        const voiceEmotion = parsedVoice.emotion;

        // Auto-TTS: only generate voice when AI explicitly used <語音> tag
        if (autoTriggered && !parsedVoice.hasVoiceTag) return null;
        // F12 調試：打印 LLM 這條消息的帶標籤原文，方便核對語音標籤寫法是否正確。
        // 放在上面那道門之後：即時對話的掃描窗裡每來一條消息都要重掃一遍，
        // 擱在門前的話沒有語音標籤的普通消息會被反覆打印，控制台直接刷屏。
        console.log('[voice] LLM 原文(帶標籤):', { provider: ttsProvider, content: voiceSourceContent, voiceTagContent, emotion: voiceEmotion, sarSurface: sarVoiceSurface });

        // 當前 TTS 引擎未配齊時不嘗試合成（否則每條語音、每次點擊都會拋錯刷屏）。
        // 只提醒一次；<語音> 氣泡仍保留「轉文字」入口，所以台詞不會丟。
        // The <語音> bubble still shows its 轉文字 button so the
        // text stays readable, matching real voice messages.
        if (!isTtsReady()) {
            if (!autoTriggered && !ttsWarnedRef.current) {
                ttsWarnedRef.current = true;
                const tip = ttsProvider === 'fishaudio'
                    ? '該角色未配置魚聲音色或缺少 Fish API Key，無法播放真實語音，可點「轉文字」查看內容'
                    : ttsProvider === 'elevenlabs'
                        ? '該角色未配置 ElevenLabs Voice ID 或缺少 ElevenLabs Key，無法播放真實語音，可點「轉文字」查看內容'
                        : '該角色未配置 MiniMax 語音，無法播放真實語音，可點「轉文字」查看內容';
                addToast(tip, 'info');
            }
            return null;
        }

        if (!autoTriggered) primeVoiceAudio(prepareChatAudio());
        voiceRequestsRef.current.add(msg.id);
        setVoiceLoading(prev => new Set(prev).add(msg.id));
        try {
            let spokenText: string;
            let originalText: string;
            const voiceLang = char.chatVoiceLang || '';

            if (voiceTagContent) {
                // AI already provided the spoken text (possibly translated) in <語音> tag.
                // parseVoiceOutput already sanitized it (whitelisted sound tags only).
                spokenText = voiceTagContent;
                // 翻譯第一優先級: 模型顯式給的 <字幕> 標籤 —— 確定性, 不用猜也不用調 LLM。
                // 其次是標籤外的文字 (老格式 / 模型沒寫字幕時的兜底)。
                // parseVoiceOutput 已做標籤自愈 + 提取, 別再自己 replace 一遍。
                originalText = parsedVoice.subtitle
                    || (parsedVoice.display ? cleanTextForTts(parsedVoice.display) : '');
                // 字幕對齊模式下中文字幕通常被 chunk 成同批次的獨立氣泡, 語音消息標籤外沒字。
                // 先從兄弟氣泡把字幕收回來當翻譯 —— 確定性、零成本、跟用戶看到的字幕逐字一致。
                // (內部有結構對齊校驗: 模型沒守字幕格式、標籤外是閒聊短句時返回空, 走下面 LLM)
                if (voiceLang && !originalText) {
                    originalText = collectVoiceBatchSubtitle(messages, msg.id);
                }
                // 收不到 (純語音回合 / 字幕對不齊) 再讓 LLM 把外語翻回中文, 帶 ok 檢查 + 重試。
                if (voiceLang && !originalText && spokenText) {
                    originalText = await llmTranslate('把以下內容翻譯成中文。只輸出翻譯結果，不要任何解釋。', spokenText);
                }
            } else {
                // Manual TTS (long-press): no <語音> tag.
                // Bilingual messages already contain both a target-language side (before
                // %%BILINGUAL%%) and a Chinese side (after). When the char's voice language
                // matches the message's target language we reuse those halves directly —
                // translating again would just echo the target language back and produce
                // two identical foreign-language lines in the expanded voice bar.
                const bilingualIdx = voiceSourceContent.toLowerCase().indexOf('%%bilingual%%');
                const hasBilingual = bilingualIdx !== -1;
                if (hasBilingual && voiceLang) {
                    const langAText = cleanTextForTtsProvider(voiceSourceContent.substring(0, bilingualIdx), apiConfig);
                    const langBText = stripTtsMarkupForDisplay(voiceSourceContent.substring(bilingualIdx + '%%BILINGUAL%%'.length), apiConfig);
                    if (!langAText || langAText.length < 2) return null;
                    spokenText = langAText;
                    originalText = langBText || '';
                } else {
                    spokenText = cleanTextForTtsProvider(voiceSourceContent, apiConfig);
                    if (!spokenText || spokenText.length < 2) return null;
                    originalText = stripTtsMarkupForDisplay(spokenText, apiConfig) || spokenText;
                    if (voiceLang) {
                        const langLabel = voiceLanguagePromptLabel(voiceLang);
                        const translated = await llmTranslate(`Translate the following text to ${langLabel}. Output ONLY the translation, nothing else.`, originalText);
                        if (translated) spokenText = translated;
                    }
                }
            }

            if (!spokenText || spokenText.length < 2) return null;

            const { url: blobUrl, blob } = await synthesizeSpeechDetailed(spokenText, char, apiConfig, {
                languageBoost: voiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
                emotion: voiceEmotion,
            });
            // 轉文字面板只展示實際台詞，不展示當前引擎的停頓 / 表演標記。
            const displaySpoken = stripTtsMarkupForDisplay(spokenText, apiConfig);
            const storedSpokenText = voiceTagContent ? displaySpoken : (voiceLang ? displaySpoken : undefined);
            const storedLang = voiceLang || undefined;
            // Persist so the voice bar survives leaving and re-entering the chat.
            persistVoice(msg.id, blobUrl, blob, originalText, storedSpokenText, storedLang);
            if (!voiceMountedRef.current || activeCharIdRef.current !== msg.charId) {
                if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
                return null;
            }
            if (blobUrl.startsWith('blob:')) voiceBlobUrlsRef.current.add(blobUrl);
            setVoiceDataMap(prev => ({ ...prev, [msg.id]: { url: blobUrl, originalText, spokenText: storedSpokenText, lang: storedLang } }));
            // 合成完是否立刻播（規則和來由見 shouldAutoPlayGeneratedVoice）：
            // AI 自動發來的默認不響、等用戶點；用戶自己點著要的一定響。
            if (shouldAutoPlayGeneratedVoice({ autoTriggered, autoPlayEnabled: char.chatVoiceAutoPlay })) {
                playChatVoice(msg.id, blobUrl);
            }
            return { url: blobUrl, originalText, spokenText: storedSpokenText, lang: storedLang, blob };
        } catch (err: any) {
            // 記一筆失敗：自動那條路下次掃到就跳過（見 voiceFailedRef 的說明）。
            voiceFailedRef.current.add(msg.id);
            addToast(`語音生成失敗: ${err?.message || '未知錯誤'}`, 'error');
            return null;
        } finally {
            voiceRequestsRef.current.delete(msg.id);
            setVoiceLoading(prev => { const next = new Set(prev); next.delete(msg.id); return next; });
        }
    };

    // 長按語音菜單裡的「下載」：移動端優先調系統分享/保存，桌面端才走瀏覽器下載。
    const handleDownloadVoice = async (msg: Message) => {
        if (!msg?.id) return;
        try {
            const stored = await DB.getAssetRaw(voiceAssetKey(msg.id)) as StoredVoice | null;
            let blob: Blob | null = stored?.blob instanceof Blob ? stored.blob : null;
            if (!blob && stored?.remoteUrl) {
                try { blob = await fetchBlobForShare(stored.remoteUrl, 'audio/mpeg'); } catch { /* 下面給出明確提示 */ }
            }
            const fname = `${(char?.name || '語音').replace(/[\\/:*?"<>|]/g, '_')}_語音_${msg.id}.mp3`;
            if (!blob) {
                addToast('這條還沒有可下載的語音', 'error');
                return;
            }
            const result = await shareOrDownloadBlob({ blob, fileName: fname, shareTitle: `${char?.name || '角色'}的語音` });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? '已打開系統保存/分享' : '語音已開始下載', 'success');
            trackEvent('下载语音条');
        } catch {
            addToast('語音下載失敗', 'error');
        }
    };

    const handleToggleVoiceFavorite = async (msg: Message) => {
        if (!msg?.id) return;
        try {
            const sourceKey = chatFavoriteSourceKey(msg);
            if (await getVoiceFavorite('chat', sourceKey)) {
                await removeVoiceFavorite('chat', sourceKey);
                setChatFavoriteKeys(prev => { const next = new Set(prev); next.delete(sourceKey); return next; });
                setVoiceDataMap(prev => prev[msg.id] ? ({ ...prev, [msg.id]: { ...prev[msg.id], favorite: false } }) : prev);
                addToast('已取消收藏語音', 'info');
                return;
            }
            let current: GeneratedVoiceData | VoiceData | undefined = voiceDataMap[msg.id];
            if (!current) current = await handleManualTts(msg, false) || undefined;
            if (!current) return;
            const stored = await DB.getAssetRaw(voiceAssetKey(msg.id)) as StoredVoice | null;

            let blob: Blob | null = 'blob' in current && current.blob instanceof Blob
                ? current.blob
                : stored?.blob instanceof Blob ? stored.blob : null;
            if (!blob) {
                try { blob = await fetchBlobForShare(current.url, 'audio/mpeg'); } catch { /* handled below */ }
            }
            if (!blob) {
                addToast('暫時拿不到這條語音的音頻文件，無法收藏', 'error');
                return;
            }
            await saveVoiceFavorite({
                source: 'chat',
                sourceKey,
                charId: msg.charId,
                charName: char?.name || '未知角色',
                sourceTimestamp: msg.timestamp,
                originalText: current.originalText,
                spokenText: current.spokenText,
                language: current.lang,
                blob,
            });
            setChatFavoriteKeys(prev => new Set(prev).add(sourceKey));
            setVoiceDataMap(prev => ({ ...prev, [msg.id]: { ...prev[msg.id], favorite: true } }));
            addToast('已收藏語音，可在“收藏”裡查看', 'success');
            trackEvent('收藏语音条');
        } catch (e) {
            console.warn('[Chat] favorite voice failed', e);
            addToast('收藏失敗，請檢查瀏覽器存儲空間', 'error');
        }
    };

    // --- Auto-TTS: when chatVoiceEnabled, auto-generate voice when AI uses <語音> tag ---
    // Scans ALL recent assistant messages (not just the last one) because chunkText
    // may split a single AI response into multiple messages, and the <語音> tag could
    // end up in any chunk — not necessarily the final one.
    //
    // 兩個觸發源：
    //   · 本機生成：打字結束的那一下（wasTyping → !isTyping）。
    //   · 即時對話：回覆在雲端生成、靠推送落庫，本機的 isTyping 在 POST 完就滅了，永遠等不到
    //     那一下，開了自動播放的角色會一路靜音。改看「正在輸入」指示燈熄滅（instantChatPending
    //     由真變假），熄滅時開一個 30 秒的掃描窗——一輪回復常被拆成好幾條推送陸續到，第一條到
    //     就熄燈，後面幾條得靠窗口內每次 messages 變化補掃。只掃窗口內，冷啟動和翻歷史不會把
    //     舊消息整批合成一遍。
    useEffect(() => {
        const wasTyping = prevIsTypingRef.current;
        prevIsTypingRef.current = isTyping;
        const wasPending = prevInstantPendingRef.current;
        prevInstantPendingRef.current = instantChatPending;
        // 換角色先把窗清零：Chat 裡切角色不卸載組件，這幾個 ref 會跨角色留著。甲還欠著回覆時
        // 切到乙，instantChatPending 會跟著乙的記錄變假——那不是「乙的回覆到了」，不能拿它開窗，
        // 更不能拿甲的窗去掃乙的歷史消息。兩個觸發源都要先有一次「變化前」才成立，所以這裡直接
        // 走人不會漏掉任何一次真的觸發。
        if (instantVoiceScanCharRef.current !== char?.id) {
            instantVoiceScanCharRef.current = char?.id;
            instantVoiceScanUntilRef.current = 0;
            return;
        }
        // 覆蓋範圍就到這兒：銷帳是在頁面裡發生的，推送落地時人不在這個聊天頁的話沒有這次
        // 真→假的轉換，那條回覆就保持靜音（跟「不批量合成歷史」是同一個取捨）。
        if (wasPending && !instantChatPending) {
            instantVoiceScanUntilRef.current = Date.now() + INSTANT_VOICE_SCAN_WINDOW_MS;
        }
        // Only trigger when AI just finished typing (wasTyping → !isTyping)，或者還在即時對話的掃描窗裡。
        // 這道門也是 messages 進依賴之後本機那條路的保險：不在窗裡就仍然只在打字結束那一下掃，
        // 平時每來一條消息不會重掃。
        const typingJustEnded = wasTyping && !isTyping;
        const inInstantWindow = Date.now() < instantVoiceScanUntilRef.current;
        if (!typingJustEnded && !inInstantWindow) return;
        if (!char.chatVoiceEnabled) return;
        // 關著「收到就自動播放」就別提前合成（理由見 shouldAutoGenerateVoice）：
        // 空語音條照常出現，用戶點了才合成、合成完直接播。
        if (!shouldAutoGenerateVoice({ autoPlayEnabled: char.chatVoiceAutoPlay })) return;
        if (!characterHasVoice(char, apiConfig)) return;
        // Scan recent assistant messages for unprocessed <語音> tags
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            // Stop scanning once we hit a non-assistant message (end of current AI response batch)
            if (msg.role !== 'assistant') break;
            if (msg.type !== 'text') continue;
            if (voiceDataMap[msg.id] || voiceLoading.has(msg.id)) continue;
            // 合成失敗過就別再自動重試了：掃描窗裡每來一條消息都重掃一遍，
            // 同一條會一路重試到窗口關閉，還每次彈一個失敗提示。用戶手點不受影響。
            if (voiceFailedRef.current.has(msg.id)) continue;
            handleManualTts(msg, true);
        }
    }, [isTyping, instantChatPending, messages]); // eslint-disable-line react-hooks/exhaustive-deps

    const canReroll = !isTyping && messages.length > 0 && messages[messages.length - 1].role === 'assistant';

    // --- Translation: pure frontend toggle (no API calls, bilingual data is already in message content) ---
    const handleTranslateToggle = useCallback((msgId: number) => {
        setShowingTargetIds(prev => {
            const next = new Set(prev);
            if (next.has(msgId)) next.delete(msgId);
            else next.add(msgId);
            return next;
        });
    }, []);

    const loadEmojiData = async () => {
        await DB.initializeEmojiData();
        const [es, cats] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
        setEmojis(es);
        setCategories(cats);
        if (activeCategory !== 'default' && !cats.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    };

    // Hydrate voice data from IndexedDB for currently visible messages.
    // Voice URLs are stored as blob: URLs that become invalid whenever the
    // component unmounts — persisting the raw blob and rebuilding the URL on
    // mount is what keeps previously-generated voice bars alive across
    // chat entries.
    useEffect(() => {
        if (!messages.length) return;
        const map = voiceDataMap;
        const toFetch = messages.filter(m => m.id && m.type === 'text' && m.role !== 'user' && !map[m.id]);
        if (!toFetch.length) return;
        let cancelled = false;
        (async () => {
            const updates: Record<number, VoiceData> = {};
            const favoriteKeys = new Set(
                (await listVoiceFavorites().catch(() => []))
                    .filter(item => item.source === 'chat')
                    .map(item => item.sourceKey),
            );
            if (!cancelled) setChatFavoriteKeys(favoriteKeys);
            for (const m of toFetch) {
                try {
                    const stored = await DB.getAssetRaw(voiceAssetKey(m.id)) as StoredVoice | null;
                    if (!stored) continue;
                    let url: string | null = null;
                    if (stored.blob instanceof Blob) {
                        url = URL.createObjectURL(stored.blob);
                        voiceBlobUrlsRef.current.add(url);
                    } else if (stored.remoteUrl) {
                        url = stored.remoteUrl;
                    }
                    if (!url) continue;
                    let originalText = stored.originalText || '';
                    // 存量毒數據自愈: 07-02~07-04 的版本曾把同回合的閒聊短句當翻譯存進來
                    // (收字幕沒做對齊校驗)。認出來就清掉並回寫, 別讓錯翻譯一直掛在面板上。
                    if (stored.lang && originalText && isPoisonedVoiceSubtitle(messages, m.id, originalText)) {
                        originalText = '';
                        DB.saveAssetRaw(voiceAssetKey(m.id), { ...stored, originalText: '' })
                            .catch(() => { /* 回寫失敗下次進聊天再試 */ });
                    }
                    let favorited = favoriteKeys.has(chatFavoriteSourceKey(m));
                    // One-time migration for the short-lived per-message favorite shape.
                    // The dedicated archive survives message deletion and is shared by all three apps.
                    if (!favorited && stored.favorite === true && stored.blob instanceof Blob) {
                        try {
                            await saveVoiceFavorite({
                                source: 'chat',
                                sourceKey: chatFavoriteSourceKey(m),
                                charId: m.charId,
                                charName: char?.name || '未知角色',
                                sourceTimestamp: m.timestamp,
                                originalText,
                                spokenText: stored.spokenText,
                                language: stored.lang,
                                blob: stored.blob,
                            });
                            favorited = true;
                            DB.saveAssetRaw(voiceAssetKey(m.id), { ...stored, favorite: undefined }).catch(() => undefined);
                        } catch { /* keep the legacy marker and retry next entry */ }
                    }
                    updates[m.id] = { url, originalText, spokenText: stored.spokenText, lang: stored.lang, favorite: favorited };
                } catch { /* ignore single-message hydration errors */ }
            }
            if (cancelled || !Object.keys(updates).length) return;
            setVoiceDataMap(prev => ({ ...updates, ...prev }));
        })();
        return () => { cancelled = true; };
    }, [messages]);

    // The archive can remove an item while this chat stays mounted. Keep the
    // long-press menu's 收藏/取消收藏 label in sync without touching audio data.
    useEffect(() => {
        const syncFavoriteFlags = async () => {
            const keys = new Set(
                (await listVoiceFavorites().catch(() => []))
                    .filter(item => item.source === 'chat')
                    .map(item => item.sourceKey),
            );
            setChatFavoriteKeys(keys);
            setVoiceDataMap(prev => {
                let changed = false;
                const next = { ...prev };
                for (const message of messages) {
                    const voice = next[message.id];
                    if (!voice) continue;
                    const favorite = keys.has(chatFavoriteSourceKey(message));
                    if (!!voice.favorite !== favorite) {
                        next[message.id] = { ...voice, favorite };
                        changed = true;
                    }
                }
                return changed ? next : prev;
            });
        };
        window.addEventListener(VOICE_FAVORITES_CHANGED_EVENT, syncFavoriteFlags);
        return () => window.removeEventListener(VOICE_FAVORITES_CHANGED_EVENT, syncFavoriteFlags);
    }, [messages]);

    // Revoke blob URLs when switching characters / unmounting to avoid leaks.
    useEffect(() => {
        voiceMountedRef.current = true;
        // Reset the "active TTS not configured" warning so each character gets one reminder.
        ttsWarnedRef.current = false;
        // 自動合成的失敗記錄也跟著換角色清空：這一位的失敗不該攔著下一位。
        voiceFailedRef.current.clear();
        const urls = voiceBlobUrlsRef.current;
        return () => {
            voiceMountedRef.current = false;
            if (chatAudioRef.current) stopVoiceAudio(chatAudioRef.current);
            urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
            urls.clear();
        };
    }, [activeCharacterId]);

    // How many messages to load per batch (initial load + each "load more" click)
    const LOAD_BATCH_SIZE = 30;

    const reloadMessages = useCallback(async (requestedVisibleCount: number) => {
        if (!activeCharacterId) return;

        const charIdAtStart = activeCharacterId;
        // 倒序游標先過濾展示範圍再取最近 N 條。緩衝只用於判斷是否還有歷史，
        // 不能靠固定緩衝抵消見面/通話記錄：它們可能連續幾百條，擠掉真正的私聊。
        const fetchLimit = requestedVisibleCount >= 100000 ? requestedVisibleCount : requestedVisibleCount + 16;
        const accept = (message: Message) => isVisibleChatMessage(message, !!charRef.current?.hideSystemLogs);
        const applyResult = (recent: Message[], totalCount: number) => {
            // 用 ref 取當前 char（避免閉包過期）
            const currentChar = charRef.current;
            // 不在視覺層過濾 hideBeforeMessageId —— 用戶能往上滾回看，
            // 上下文截斷僅作用於發給 LLM 的 prompt（在 chatPrompts.ts 裡處理）。
            const chatScopeMsgs = recent.filter(m => isVisibleChatMessage(m, !!currentChar?.hideSystemLogs));
            // totalCount 走 charId 索引全量計數，包含群聊消息（以及上面被過濾的約會/通話
            // 消息）——它們永遠不會出現在單聊列表裡。直接拿它算「加載歷史消息」會出現
            // 有計數、點擊卻加載不出任何東西的幽靈按鈕。倒序游標沒取滿 fetchLimit 條
            // 即說明該角色的單聊消息已全部在手，此時把總數鉗到實際可展示的條數。
            const exhausted = recent.length < fetchLimit;
            setTotalMsgCount(exhausted ? chatScopeMsgs.length : totalCount);
            setMessages(chatScopeMsgs.slice(-requestedVisibleCount));
        };
        try {
            const { messages: recent, totalCount } = await DB.getRecentMessagesWithCount(activeCharacterId, fetchLimit, accept);
            // Guard against stale async results: if the user switched characters
            // while the DB query was in flight, discard this result.
            if (activeCharIdRef.current !== charIdAtStart) return;
            applyResult(recent, totalCount);
        } catch (e) {
            // DB read failed — retry once after a short delay
            if (activeCharIdRef.current !== charIdAtStart) return;
            await new Promise(r => setTimeout(r, 200));
            if (activeCharIdRef.current !== charIdAtStart) return;
            try {
                const { messages: recent, totalCount } = await DB.getRecentMessagesWithCount(activeCharacterId, fetchLimit, accept);
                if (activeCharIdRef.current !== charIdAtStart) return;
                applyResult(recent, totalCount);
            } catch { /* give up silently */ }
        }
    }, [activeCharacterId]);

    useEffect(() => {
        if (activeCharacterId) {
            // Update ref BEFORE any async work so stale reloadMessages calls
            // from a previous character can detect the switch and bail out.
            activeCharIdRef.current = activeCharacterId;

            // Clear messages immediately to prevent showing stale chat from previous character
            setMessages([]);
            setAllHistoryMessages([]);
            setTotalMsgCount(0);
            // Reset voice map — stale blob: URLs from the previous char are revoked
            // by the cleanup effect and must not be reused against new messages.
            setVoiceDataMap({});
            setPlayingMsgId(null);
            if (chatAudioRef.current) { try { stopVoiceAudio(chatAudioRef.current); } catch { /* ignore */ } }

            reloadMessages(LOAD_BATCH_SIZE);
            loadEmojiData();
            const savedDraft = localStorage.getItem(draftKey);
            setInput(savedDraft || '');
            if (char) {
                setSettingsContextLimit(char.contextLimit || 500);
                setSettingsContextRangeMode(resolveContextRangeMode(char));
                setSettingsHideSysLogs(char.hideSystemLogs || false);
                setSettingsHtmlModeCustomPrompt((char as any).htmlModeCustomPrompt || '');
                clearUnread(char.id);
            }
            // Per-character translation toggle + language pair
            try {
                setTranslationEnabled(JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'));
            } catch { setTranslationEnabled(false); }
            setTranslateSourceLang(
                normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_source_lang_${activeCharacterId}`)
                || localStorage.getItem('chat_translate_source_lang')
                || '日本語') || '日本語'
            );
            setTranslateTargetLang(
                normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_lang_${activeCharacterId}`)
                || localStorage.getItem('chat_translate_lang')
                || '中文') || '中文'
            );
            try {
                setTranslationExpanded(JSON.parse(localStorage.getItem(`chat_translate_expanded_${activeCharacterId}`) || 'false'));
            } catch { setTranslationExpanded(false); }
            setVisibleCount(30);
            visibleCountRef.current = 30;
            lastMsgIdRef.current = null;
            scrollThrottleRef.current = 0;
            setLastTokenUsage(null);
            setReplyTarget(null);
            setSelectionMode(false);
            setSelectedMsgIds(new Set());
            setRetainRecentForVectorize(false);
            setVectorizeResult(null);
            setShowingTargetIds(new Set());
            setWindowedFocusMsgId(null);
            setHistoryWindowRange(null);
            historyWindowRangeRef.current = null;
            historyWindowTotalRef.current = 0;
            historyWindowLoadingRef.current = false;
            historyPrependAnchorRef.current = null;
            historyWindowScrollEnabledRef.current = false;
            if (historyJumpUnlockTimerRef.current) {
                window.clearTimeout(historyJumpUnlockTimerRef.current);
                historyJumpUnlockTimerRef.current = null;
            }
            setFlashMsgId(null);
        }
    }, [activeCharacterId, reloadMessages]);

    // 進入/切換角色時觸發「登場」過場。useLayoutEffect 在瀏覽器繪製前置真，
    // 讓過場層先蓋住，避免一幀閃到新角色的空聊天界面。
    useLayoutEffect(() => {
        if (!activeCharacterId || osTheme.chatCharacterSwitchAnimationEnabled === false) {
            setShowEntry(false);
            return;
        }
        setShowEntry(true);
    }, [activeCharacterId, osTheme.chatCharacterSwitchAnimationEnabled]);

    useEffect(() => {
        const onScheduleChange = (event: Event) => {
            const detail = (event as CustomEvent<ScheduleChangeEventDetail>).detail;
            if (!detail || detail.charId !== activeCharIdRef.current) return;
            setScheduleData(detail.schedule);
            setScheduleChangeNotice(detail);
        };
        window.addEventListener(SCHEDULE_CHANGE_EVENT, onScheduleChange);
        return () => window.removeEventListener(SCHEDULE_CHANGE_EVENT, onScheduleChange);
    }, []);

    useEffect(() => setScheduleChangeNotice(null), [activeCharacterId]);

    // 延遲自動回覆到點、用戶正看著這個角色：走完整的聊天管線回覆（OSContext 只在這種情況發這個事件）
    const manualTriggerRef = useRef<() => void>(() => {});
    useEffect(() => {
        const onDue = (event: Event) => {
            const charId = (event as CustomEvent<{ charId: string }>).detail?.charId;
            if (charId && charId === activeCharIdRef.current) manualTriggerRef.current();
        };
        window.addEventListener(DELAYED_REPLY_DUE_EVENT, onDue);
        return () => window.removeEventListener(DELAYED_REPLY_DUE_EVENT, onDue);
    }, []);

    // Auto-generate daily schedule (fire-and-forget on chat load)
    // 總開關關閉時完全跳過：不查詢 DB、不調用副 API、不跑兜底
    useEffect(() => {
        if (!char || !apiConfig.apiKey) return;
        if (!isScheduleFeatureOn(char)) {
            setScheduleData(null);
            return;
        }
        getDailyScheduleForChar(char).then(existing => {
            if (!existing) {
                // Generate in background, don't block chat
                generateDailySchedule(char, false);
            } else {
                setScheduleData(existing);
            }
        }).catch(() => {});
    }, [activeCharacterId, char?.scheduleFeatureEnabled, char?.customTimezoneEnabled, char?.customTimezone, charDateKey]);

    // 心聲/好感度裡設了「每隔 N 小時」節奏的條目，進聊天時順手檢查一遍是否到期——
    // 跟日程同一個觸發時機；到期的在後台重新生成，不阻塞聊天。turns 節奏另外在每輪發消息時推進
    // （見 useChatAI 裡 checkCustomMeterAutoUpdate 的調用點），這裡不傳 tickTurns。
    useEffect(() => {
        if (!char || !apiConfig.apiKey) return;
        const meterApi = resolveCharacterMeterApi(char, apiConfig);
        checkCustomMeterAutoUpdate('text', char, chatUserProfile, meterApi, char.innerVoices || [])
            .then(next => { if (next) updateCharacter(char.id, { innerVoices: next }); })
            .catch(e => console.warn('[CustomMeter] 心聲按小時自動更新失敗:', e));
        checkCustomMeterAutoUpdate('number', char, chatUserProfile, meterApi, char.affinities || [])
            .then(next => { if (next) updateCharacter(char.id, { affinities: next }); })
            .catch(e => console.warn('[CustomMeter] 好感度按小時自動更新失敗:', e));
    }, [activeCharacterId]);

    // 每次真正打開聊天設置時從角色持久化值重新初始化；避免用戶在記憶宮殿頁
    // 切換全自動模式後，隱藏著的 Chat 組件仍帶著舊拉桿狀態。
    useEffect(() => {
        if (modalType !== 'chat-settings' || !char) return;
        setSettingsContextLimit(char.contextLimit || 500);
        setSettingsContextRangeMode(resolveContextRangeMode(char));
        setSettingsHideSysLogs(char.hideSystemLogs || false);
        setSettingsHtmlModeCustomPrompt((char as any).htmlModeCustomPrompt || '');
        setSettingsInputPreferences(inputPreferences);
    }, [modalType, char?.id]);

    // Load all messages when history-manager modal opens
    useEffect(() => {
        if (modalType === 'history-manager' && activeCharacterId) {
            DB.getMessagesByCharId(activeCharacterId, true).then(allMsgs => {
                // 範圍管理必須使用 AI 可能讀取的完整私聊序列，不能先按聊天界面顯示偏好
                // 隱掉系統/約會/通話消息，否則「最近 N 條」起點會與真實 prompt 發生偏移。
                setAllHistoryMessages(allMsgs);
            });
        }
    }, [modalType, activeCharacterId]);

    useEffect(() => {
        const savedPrompts = localStorage.getItem('chat_archive_prompts');
        if (savedPrompts) {
            try {
                const parsed = JSON.parse(savedPrompts);
                const merged = [...DEFAULT_ARCHIVE_PROMPTS, ...parsed.filter((p: any) => !p.id.startsWith('preset_'))];
                setArchivePrompts(merged);
            } catch(e) {}
        }
        const savedId = localStorage.getItem('chat_active_archive_prompt_id');
        if (savedId && archivePrompts.some(p => p.id === savedId)) setSelectedPromptId(savedId);
    }, []);

    useEffect(() => {
        if (activeCharacterId) {
            reloadMessages(visibleCountRef.current);
            clearUnread(activeCharacterId);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearUnread is stable (useCallback with []), omit to prevent stale-dep lint noise
    }, [lastMsgTimestamp, activeCharacterId, char?.hideSystemLogs, reloadMessages, clearUnread]);

    // 即時對話待收記錄的跨標籤頁補聽。同一聊天開兩個標籤頁時，回覆推送到達後 SW 把
    // 廣播發給所有 client，後台標籤頁的 flush 可能先搶到並落庫——銷帳的 CustomEvent
    // 只在它自己那邊派發，這邊收不到，「正在輸入…」就會無限常亮、回覆也不上屏。
    // 待收記錄本來就落在 localStorage，而 storage 事件恰好只在「其他」標籤頁觸發，
    // 正好補上這條縫：這個 key 一變，就照上面 CustomEvent 那套處理走——刷新指示燈，
    // 並重載消息把對方標籤頁落的庫帶上屏。同標籤頁內的 CustomEvent 機制保持不動。
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            // 嚴格按 key 過濾，別的 localStorage 變動（草稿、翻譯開關等）一概不理。
            if (e.key !== AMSG_INSTANT_CHAT_PENDING_LS_KEY) return;
            const charId = activeCharIdRef.current;
            setInstantChatPending(!!charId && !!getInstantChatPending(charId));
            if (charId) reloadMessages(visibleCountRef.current);
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [reloadMessages]);

    useEffect(() => {
        visibleCountRef.current = visibleCount;
    }, [visibleCount]);

    // （舊的"首次自動歸檔 banner"已移除，自動歸檔改為用戶在神經鏈接裡顯式 opt-in）

    // buff 同步已上移到 OSContext 的 App 級 'emotion-updated' 監聽 (無條件按事件 charId 更新內存,
    // 不再受"當前是否開著該角色聊天頁"限制). 之前這裡有個 `charId === activeCharacterId` 守衛的
    // handler, 導致雲端回覆時用戶不在該角色頁的話 buff 回不到前端 (只落 DB), 故移除, 同時
    // 避免和 OSContext 雙寫.

    const handleInputChange = (val: string) => {
        setInput(val);
        if (val.trim()) localStorage.setItem(draftKey, val);
        else localStorage.removeItem(draftKey);
    };

    useLayoutEffect(() => {
        if (!scrollRef.current || selectionMode) return;
        const currentLastId = messages.length > 0 ? messages[messages.length - 1].id : null;
        // Only auto-scroll when a new message is appended (ID changes),
        // not when loading older history or updating existing messages in-place.
        // windowed 模式下用戶在翻舊消息，不要被新消息打斷滾走。
        if (currentLastId !== lastMsgIdRef.current) {
            if (windowedFocusMsgId === null) {
                pendingMediaAutoScrollIdRef.current = currentLastId;
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            } else {
                pendingMediaAutoScrollIdRef.current = null;
            }
            lastMsgIdRef.current = currentLastId;
        }
    }, [messages, activeCharacterId, selectionMode, windowedFocusMsgId]);

    const extendHistoryWindow = useCallback((direction: 'older' | 'newer') => {
        const scroller = scrollRef.current;
        const range = historyWindowRangeRef.current;
        if (!scroller || !range || historyWindowLoadingRef.current) return;

        const nextRange = expandChatHistoryWindow(
            range,
            historyWindowTotalRef.current,
            direction,
            HISTORY_WINDOW_BATCH_SIZE,
        );
        if (nextRange.start === range.start && nextRange.end === range.end) return;

        historyWindowLoadingRef.current = true;
        if (direction === 'older') {
            // 前插消息會把當前內容整體向下頂；記錄原高度，提交 DOM 後補償差值，
            // 用戶看到的位置就不會突然跳走。
            historyPrependAnchorRef.current = {
                scrollHeight: scroller.scrollHeight,
                scrollTop: scroller.scrollTop,
            };
        }
        historyWindowRangeRef.current = nextRange;
        setHistoryWindowRange(nextRange);
    }, []);

    useLayoutEffect(() => {
        if (!historyWindowRange) return;
        const anchor = historyPrependAnchorRef.current;
        const scroller = scrollRef.current;
        if (anchor && scroller) {
            scroller.scrollTop = anchor.scrollTop + (scroller.scrollHeight - anchor.scrollHeight);
        }
        historyPrependAnchorRef.current = null;
        historyWindowLoadingRef.current = false;
    }, [historyWindowRange]);

    const handleChatScroll = useCallback(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (distanceFromBottom > 96) pendingMediaAutoScrollIdRef.current = null;

        if (historyWindowScrollEnabledRef.current && historyWindowRangeRef.current) {
            if (scroller.scrollTop <= 96) extendHistoryWindow('older');
            else if (distanceFromBottom <= 96) extendHistoryWindow('newer');
        }
    }, [extendHistoryWindow]);

    const handleMessageMediaLoad = useCallback((messageId: number) => {
        if (windowedFocusMsgId !== null || pendingMediaAutoScrollIdRef.current !== messageId) return;
        requestAnimationFrame(() => {
            if (pendingMediaAutoScrollIdRef.current !== messageId) return;
            const scroller = scrollRef.current;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            pendingMediaAutoScrollIdRef.current = null;
        });
    }, [windowedFocusMsgId]);

    useEffect(() => {
        if (isTyping && scrollRef.current && !selectionMode && windowedFocusMsgId === null) {
            const now = Date.now();
            if (now - scrollThrottleRef.current > 150) {
                scrollThrottleRef.current = now;
                scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
            }
        }
    }, [messages, isTyping, streamingBubbles, streamingThinking, recallStatus, searchStatus, diaryStatus, selectionMode, windowedFocusMsgId]);

    // 白框提示音：當 char 新發的消息成為會話最後一條時播放一次（用戶自己/歷史/翻舊消息都不響）。
    // 聲音配置編碼在白框 CSS 註釋裡（角色 chromeCustomCss 覆蓋全局 chatChromeCustomCss），隨白框分享一起走。
    useEffect(() => {
        const sync = soundSyncRef.current;
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        const lastId = last ? last.id : null;
        // 切角色 / 首次進入：只記錄基線，不播（避免一打開聊天就響）；回合計時清零。
        if (sync.charId !== activeCharacterId) {
            sync.charId = activeCharacterId ?? null;
            sync.maxId = lastId;
            sync.lastAt = null;
            return;
        }
        if (lastId == null) return;
        const isNew = sync.maxId == null || lastId > sync.maxId;
        if (isNew) {
            // 僅"char 發送的、落到底部的最新一條"才觸發：assistant 且非見面/通話等旁路消息。
            const src = last?.metadata?.source;
            if (last?.role === 'assistant' && src !== 'date' && src !== 'call') {
                // 回合首條即響：距上一條氣泡 >3s 視為新回合，立刻響一次；同一輪後續氣泡只刷新計時、不再響。
                const now = Date.now();
                if (sync.lastAt == null || now - sync.lastAt > SOUND_ROUND_GAP_MS) {
                    playWhiteboxSound(resolveActiveSound(char?.chromeCustomCss, char?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound));
                }
                sync.lastAt = now;
            }
        }
        // 基線只增不減：翻舊歷史讓末尾 ID 變小時不下調，返回底部也不會重複觸發。
        sync.maxId = sync.maxId == null ? lastId : Math.max(sync.maxId, lastId);
    }, [messages, activeCharacterId, osTheme.chatChromeCustomCss, osTheme.chatSound, char?.chromeCustomCss, char?.chatSound]);

    const formatTime = (ts: number) => {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    // --- Actions ---

    const sendText = async (customContent?: string, customType?: MessageType, metadata?: any) => {
        if (!char || (!input.trim() && !customContent)) return;
        // 只累加內存裡的計數，這裡不發任何請求；頁面切走時才按區間報一次。見 utils/analytics.ts
        noteMessageSent();
        // 借用戶"發送"這個手勢解鎖音頻上下文，好讓稍後 AI 回覆時的白框提示音能順利播放（移動端自動播放策略）。
        unlockWhiteboxAudio();
        if (char.chatVoiceEnabled && char.chatVoiceAutoPlay && isTtsReady()) primeVoiceAudio(prepareChatAudio());
        const text = customContent || input.trim();
        const type = customType || 'text';

        // 發消息隱含"回到當前聊天"——退出 windowed 舊消息瀏覽模式
        if (windowedFocusMsgId !== null) {
            setWindowedFocusMsgId(null);
            setHistoryWindowRange(null);
            historyWindowRangeRef.current = null;
            historyWindowTotalRef.current = 0;
            historyWindowScrollEnabledRef.current = false;
            visibleCountRef.current = LOAD_BATCH_SIZE;
            setVisibleCount(LOAD_BATCH_SIZE);
            setFlashMsgId(null);
        }

        // 用戶手打"麥請求"三個字 → 等價於點擊麥克風按鈕 (拉起麥當勞菜單)
        // 不落庫, 跟按鈕點擊行為完全一致, 避免出現"banner 在但菜單沒拉起"的詭異狀態
        if (!customContent && type === 'text' && equalsAnyScript(text, MCD_ACTIVATE_TRIGGER)) {
            setInput(''); localStorage.removeItem(draftKey);
            if (!isMcdConfigured()) {
                addToast('請先到設置 → 麥當勞 啟用並填入 MCP Token', 'info');
                return;
            }
            setMcdAppOpen(true);
            trackEvent('打开麦当劳点单小程序');
            setShowPanel('none');
            return;
        }

        // 用戶手打"瑞一杯" → 激活角色瑞幸點單模式 (注入提示詞+工具+定位, 角色自己點)
        if (!customContent && type === 'text' && equalsAnyScript(text, LUCKIN_ACTIVATE_TRIGGER)) {
            setInput(''); localStorage.removeItem(draftKey);
            activateLuckin();
            return;
        }
        if (!customContent && type === 'text' && equalsAnyScript(text, LUCKIN_DEACTIVATE_TRIGGER)) {
            setInput(''); localStorage.removeItem(draftKey);
            deactivateLuckin();
            return;
        }

        if (!customContent) { setInput(''); localStorage.removeItem(draftKey); }
        
        // 圖片 / 表情消息存的是短令牌，圖片二進制單獨躺在 blob_assets 裡，省掉 base64 那 ~33%
        // 的膨脹。同一張圖之前存過就直接複用它的令牌；轉不動時原樣還回這條 data URL，圖不會丟。
        // http 外鏈（網絡表情）和已經是令牌的值都原樣通過。
        // 注意：這條消息和下面存進相冊的那條共用同一個令牌（按內容哈希認人，只存一份 Blob），
        // 所以刪消息時絕不能順手刪 Blob——那會把相冊裡的同一張圖一起刪破。失去引用的 Blob
        // 交給孤兒 GC 收（見 utils/blobGc.ts）。
        const storedContent = (type === 'image' || type === 'emoji') && text.startsWith('data:')
            ? await migrateDataUrlToRef(text)
            : text;

        const imageChatContext = type === 'image'
            ? messages.slice(-10).map(m => {
                const sender = m.role === 'user' ? chatUserProfile.name : char.name;
                const isMedia = m.type === 'image' || m.type === 'emoji' || isImageValue(m.content);
                const preview = isMedia
                    ? buildReplySnapshotContent(m)
                    : m.content.substring(0, 100);
                return `${sender}: ${preview}`;
            })
            : null;

        const msgPayload: any = { charId: char.id, role: 'user', type, content: storedContent, metadata };
        
        if (replyTarget) {
            msgPayload.replyTo = {
                // 引用圖片 / 表情時快照存 '[圖片]' 之類的佔位符，不把令牌原樣帶進這條消息
                // （跟角色側的引用快照同一個函數，口徑一致）
                id: replyTarget.id,
                content: buildReplySnapshotContent(replyTarget),
                name: replyTarget.role === 'user' ? '我' : char.name
            };
            setReplyTarget(null);
        }

        const savedUserMsgId = await DB.saveMessage(msgPayload);

        if (type === 'image') {
            // 相冊是消息的附帶記錄：保留來源消息引用供收藏/去重使用，但相冊寫入失敗
            // 不能阻斷已經落庫的聊天消息。
            try {
                await DB.saveGalleryImage({
                    id: `img-${Date.now()}-${Math.random()}`,
                    charId: char.id,
                    url: storedContent,
                    timestamp: Date.now(),
                    sourceMessageId: savedUserMsgId,
                    savedDate: localDateKey,
                    chatContext: imageChatContext || undefined,
                });
                addToast('圖片已保存至相冊', 'info');
            } catch (err) {
                console.warn('[Chat] 圖片存相冊失敗，消息照常發送', err);
                addToast('圖片沒能存進相冊，消息照常發送', 'error');
            }
        }

        // 小紅書鏈接 → xhs_card。主路徑不依賴任何後端：小紅書分享文案自帶標題（【標題】）
        // 和筆記 id/token，直接解析就能建卡，讓「沒部署小紅書 MCP」的用戶也能讓角色看到分享了哪篇筆記。
        // 配了 MCP 的話再抓詳情補正文/封面/作者（錦上添花，抓失敗也不影響基礎卡）。
        if (type === 'text') {
            let xhsCardCreated = false;
            let webpageCardCreated = false;
            const xhsFullNote = extractXhsNoteLink(text);
            const xhsFullNoteId = xhsFullNote?.noteId;
            // 同時識別桌面/舊版 xhslink.com 與手機版新版 xhslink.cn。
            const xhsShortUrl = detectXhsShortUrl(text);
            if (xhsFullNoteId || xhsShortUrl) {
                let noteId = xhsFullNoteId || '';
                let xsecToken = xhsFullNote?.xsecToken;
                let shortLinkError = '';
                // 短鏈（xhslink.com / xhslink.cn）不含 id/token —— 先經 sfworker 展開成真實鏈接再提取。
                if (!noteId && xhsShortUrl) {
                    try {
                        const finalUrl = await expandShortUrl(xhsShortUrl);
                        const expandedNote = extractXhsNoteLink(finalUrl);
                        noteId = expandedNote?.noteId || '';
                        xsecToken = expandedNote?.xsecToken;
                        if (!noteId) shortLinkError = '短鏈返回的頁面中未找到筆記地址';
                        if (isDevDebugAvailable()) console.log('[卡片調試] 小紅書短鏈展開 →', finalUrl, '| noteId =', noteId);
                    } catch (e) {
                        console.warn('xhslink 短鏈展開失敗:', e);
                        shortLinkError = e instanceof Error ? e.message : '短鏈展開失敗';
                    }
                }
                // 兼容舊版「【標題 | 小紅書】」和新版「標題 ... 短鏈 打開【小紅書】」。
                // 不能直接取第一個【】塊：新版唯一的括號內容是應用名，會把卡片標題錯誤寫成“小紅書”。
                const titleFromText = extractXhsShareTitle(text);

                // 拿不到 noteId（短鏈展開失敗/被擋）就不建空卡，保留原文給用戶，並明確
                // 告訴用戶如何排查。此前這裡完全靜默，表現就是“角色能分享、用戶分享不了”。
                if (noteId) {
                    // 基礎卡數據來自分享文案，零後端依賴。
                    let note: any = {
                        noteId, title: titleFromText || '', desc: '', author: '',
                        authorId: '', likes: 0, xsecToken,
                    };

                    // 有小紅書 MCP/Lite 才抓詳情補全（正文/封面/作者/贊數）。
                    const mcpUrl = realtimeConfig?.xhsMcpConfig?.serverUrl;
                    if (mcpUrl && realtimeConfig?.xhsMcpConfig?.enabled) {
                        try {
                            const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_share` : ''}`;
                            // loadAllComments：和角色自己瀏覽筆記 (XHS_DETAIL) 一致地把評論區也抓回來，
                            // 否則 user 分享的筆記只有標題/正文，角色讀不到評論（char 分享給 user 的卻能看到）。
                            const result = await XhsMcpClient.getNoteDetail(mcpUrl, noteUrl, xsecToken, { loadAllComments: true });
                            if (isDevDebugAvailable()) console.log('[卡片調試] 小紅書抓取 result =', result);
                            if (result.success && result.data) {
                                const fetched = normalizeXhsLiteDetail(result.data);
                                // 抓到的字段補全基礎卡；id/標題/token 保底，標題優先文案標題（更完整可讀）。
                                note = { ...note, ...fetched, noteId: fetched.noteId || note.noteId, title: titleFromText || fetched.title || note.title, xsecToken: fetched.xsecToken || xsecToken };
                            } else if (!result.success) {
                                // 基礎卡仍然可以發送，只提示詳情讀取失敗，避免誤以為整次分享失敗。
                                addToast(`小紅書正文讀取失敗，已發送基礎卡片。請嘗試開啟/關閉科學上網、切換 Wi‑Fi/流量，或檢查 Lite 配置。${result.error ? `（${result.error}）` : ''}`, 'info');
                            }
                        } catch (e) {
                            console.warn('XHS link fetch via MCP failed (已用文案兜底):', e);
                            addToast('小紅書正文讀取失敗，已發送基礎卡片。請嘗試開啟/關閉科學上網、切換 Wi‑Fi/流量，或檢查 Lite 配置。', 'info');
                        }
                    }

                    await DB.saveMessage({
                        charId: char.id,
                        role: 'user',
                        type: 'xhs_card',
                        content: note.title || '小紅書筆記',
                        metadata: { xhsNote: note }
                    });
                    // F12 調試（僅開發分支）：打印卡片存了啥 + 角色實際會讀到的文本。
                    if (isDevDebugAvailable()) {
                        console.log('[卡片調試] 小紅書卡片·metadata =', note);
                        console.log('[卡片調試] 小紅書卡片·角色將讀到 =\n' + normalizeMessageContent(
                            { type: 'xhs_card', role: 'user', content: note.title || '小紅書筆記', metadata: { xhsNote: note } } as any,
                            char.name, chatUserProfile.name,
                        ));
                    }
                    xhsCardCreated = true;
                } else {
                    addToast(`小紅書鏈接解析失敗，原消息已保留。通常是網絡或代理導致短鏈無法展開：請嘗試開啟/關閉科學上網、切換 Wi‑Fi/流量，並檢查網絡代理與小紅書 Lite 配置。${shortLinkError ? `（${shortLinkError}）` : ''}`, 'error');
                }
            }

            // 通用網頁分享：檢測到普通 http(s) 鏈接 → 抓取正文存成 webpage_card，
            // 讓角色"看見"網頁內容。跳過 XHS 鏈接（上面已有專門的 MCP 卡片路徑）。
            // 視頻平台鏈接（抖音/B站/快手…）Jina 基本抓不到東西（SPA+登錄牆），
            // 優先走 apizero 視頻解析拿標題/作者/封面/熱度；失敗降級回通用網頁抓取。
            const sharedUrl = detectFirstUrl(text);
            if (sharedUrl && !isXhsUrl(sharedUrl) && !(xhsFullNoteId || xhsShortUrl)) {
                let webpage: ExtractedWebpage | null = null;
                if (isVideoShareUrl(sharedUrl)) {
                    try {
                        addToast('正在解析視頻鏈接…', 'info');
                        webpage = await parseVideoShareUrl(sharedUrl);
                    } catch (e) {
                        console.warn('Video parse failed, fallback to webpage fetch:', e);
                    }
                }
                if (!webpage) {
                    try {
                        addToast('正在讀取網頁內容…', 'info');
                        webpage = await extractWebpageContent(sharedUrl);
                    } catch (e: any) {
                        console.warn('Webpage fetch failed:', e);
                        addToast(`網頁抓取失敗：${e?.message || '可能被這個站點攔截了，換個鏈接或稍後再試。'}`, 'error');
                    }
                }
                if (webpage) {
                    await DB.saveMessage({
                        charId: char.id,
                        role: 'user',
                        type: 'webpage_card',
                        content: webpage.title,
                        metadata: { webpage },
                    });
                    // F12 調試（僅開發分支）：打印卡片存了啥 + 角色實際會讀到的文本。
                    if (isDevDebugAvailable()) {
                        console.log('[卡片調試] 網頁卡片·metadata =', webpage);
                        console.log('[卡片調試] 網頁卡片·角色將讀到 =\n' + normalizeMessageContent(
                            { type: 'webpage_card', role: 'user', content: webpage.title, metadata: { webpage } } as any,
                            char.name, chatUserProfile.name,
                        ));
                    }
                    webpageCardCreated = true;
                }
            }

            // 一段話裡出現鏈接 = 整條就是分享（符合用戶習慣）→ 建卡成功就刪原文，只留卡片。
            if ((xhsCardCreated || webpageCardCreated) && savedUserMsgId) {
                await DB.deleteMessage(savedUserMsgId);
            }
        }

        await reloadMessages(visibleCountRef.current);
        // 自動回覆模式下允許連續挑表情，用戶主動收起加號等面板後才計時。
        if (!inputPreferences.autoReply) setShowPanel('none');

        return true;
    };

    const handleSendText = async (customContent?: string, customType?: MessageType, metadata?: any) => {
        const finish = autoReply.beginSend(char?.id || null);
        try {
            const sent = await sendText(customContent, customType, metadata);
            const replyable = sent === true && (!customType || ['text', 'image', 'emoji'].includes(customType));
            finish(replyable);
            // 延遲自動回覆：排好這個角色什麼時候回（已經排著的不動），到點由下面的監聽或 OSContext 背景生成接手
            // 開了主動消息 2.0 的角色再交一份給雲端，App 關著也回得來（見 utils/delayedReplyCloud.ts）
            // 戳一下不算進全域自動回覆，但延遲回覆要算：被戳了、晚點看到再回一句，像真人
            const pokeForDelayed = sent === true && customType === 'interaction';
            if ((replyable || pokeForDelayed) && char?.delayedReply?.enabled) {
                void scheduleDelayedReplyFor(char)
                    .then(entry => entry && handoffDelayedReplyToCloud({
                        char, entry, userProfile: chatUserProfile, groups, realtimeConfig, apiConfig,
                    }))
                    .catch(e => console.warn('[延遲自動回覆] 排程失敗', e));
            }
        } catch (error) {
            finish(false);
            throw error;
        }
    };

    // 用戶點開「收到的轉帳」卡（角色發來、待處理）選擇接收 / 退回：
    // 標記原轉帳狀態 + 補一張回執小卡（role=user，角色側 prompt 會看到 [[記錄:TRANSFER|to=user|...|status=已收下/已退回]]）。
    const handleResolveTransfer = useCallback(async (msg: Message, action: 'accepted' | 'returned') => {
        if (!char) return;
        // 只處理仍待處理的轉帳，避免重複點擊造成多張回執。
        if (msg.metadata?.receipt) return;
        if (msg.metadata?.status && msg.metadata.status !== 'pending') return;
        await DB.updateMessageMetadata(msg.id, (prev) => ({ ...(prev || {}), status: action, resolvedAt: Date.now() }));
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'transfer',
            content: action === 'accepted' ? '[已收款]' : '[已退回]',
            metadata: { receipt: action, amount: msg.metadata?.amount, ref: msg.id },
        });
        // 角色發起轉帳走「發送即結清」：錢在角色說出口那一刻就已經從角色 Real Balance 扣走了
        // （chatParser.ts 的 onCharTransferSend）。收下才真的到用戶帳戶；退回等於這筆錢從沒
        // 到手，得還回角色帳戶——不是不動餘額，是把它退回發起方，跟用戶側轉帳被角色退回時
        // 退回用戶帳戶（onUserTransferReturned）對稱。
        const amount = Number(msg.metadata?.amount);
        if (Number.isFinite(amount) && amount > 0) {
            if (action === 'accepted') {
                updateUserProfile(prev => {
                    const result = applyRealBalanceDelta(ensureRealBalanceState(prev.realBalance), amount, `收到 ${char.name} 的轉帳`);
                    return result.ok ? { realBalance: result.state } : {};
                });
            } else {
                updateCharacter(char.id, previous => {
                    const result = applyRealBalanceDelta(ensureRealBalanceState(previous.phoneState?.realBalance), amount, `${chatUserProfile.name}退回了轉帳`);
                    if (!result.ok) return {};
                    return { phoneState: { ...previous.phoneState, records: previous.phoneState?.records || [], realBalance: result.state } };
                });
            }
        }
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages, updateUserProfile, updateCharacter, chatUserProfile]);

    // 用戶主動發起轉帳：先扣 Real Balance 再落待處理轉帳卡——在發送這一刻結清，
    // 而不是等角色事後「收下」才扣（那樣等於允許承諾一筆當下就已經不存在的錢，
    // 角色收下時才發現餘額不夠會造成帳目和聊天記錄對不上）。餘額不夠直接攔下，不發。
    // 角色之後「退回」這筆錢走 utils/chatParser.ts 的 onUserTransferReturned 退款回來。
    // 跟原來的內聯 onTransfer 一樣不用 useCallback：handleSendText 每次渲染都重新定義，
    // 記成 memo 反而會捕到一份過期的它。
    const handleSendTransfer = () => {
        if (!char || !transferAmt) return;
        const amount = Number(transferAmt);
        if (!Number.isFinite(amount) || amount <= 0) { addToast('請輸入有效金額', 'error'); return; }
        const current = ensureRealBalanceState(userProfileBase.realBalance);
        const result = applyRealBalanceDelta(current, -amount, `轉帳給 ${char.name}`);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        updateUserProfile({ realBalance: result.state });
        handleSendText(`[轉帳]`, 'transfer', { amount: transferAmt, note: transferNote.trim() || undefined, status: 'pending' });
        setTransferNote('');
        setModalType('none');
    };

    // 購物中心 mini-app 送出訂單卡片：
    // - gift（送給TA / 為TA點單 / 發小票）：跟轉帳一樣發送即結清，先扣用戶 Real Balance，
    //   再走 handleSendText 正常觸發角色的一輪回復（角色收到禮物/外賣該有反應）。
    // - daifu（外賣代付請求）：先不動餘額——真正付不付款要看角色收到請求後的選擇，那條走
    //   utils/chatParser.ts 的 AI 收發（跟 TRANSFER_ACCEPT/RETURN 同一個位置，還沒接，接了才會
    //   真的扣角色的 Real Balance），這裡只負責把待處理卡片發出去、觸發角色這輪回復。
    // - manual（「TA主動給我買/點外賣」手動模擬卡）：純擺設，角色沒有真的做這件事、也不用回覆，
    //   直接落庫成 role:'assistant' 的既成事實，不走 handleSendText（不觸發 AI 生成）。
    const handleSendMallOrder = async (order: import('../components/mall/ShoppingMallMiniApp').MallSendOrderInput) => {
        if (!char) return;
        const metadata = {
            mallKind: order.mallKind, mode: order.mode, items: order.items, note: order.note,
            total: order.total, title: order.title,
            status: order.mode === 'daifu' ? 'pending' as const : 'sent' as const,
        };
        if (order.mode === 'manual') {
            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'mall_order', content: '[購物中心卡片]', metadata });
            await reloadMessages(visibleCountRef.current);
            trackEvent('购物中心手动模拟卡', { mallKind: order.mallKind });
            return;
        }
        if (order.mode === 'gift') {
            const current = ensureRealBalanceState(userProfileBase.realBalance);
            const result = applyRealBalanceDelta(current, -order.total, order.title || (order.mallKind === 'food' ? `為${char.name}點了外賣` : `送給${char.name}的購物禮物`));
            if (!result.ok) { addToast(result.reason, 'error'); return; }
            updateUserProfile({ realBalance: result.state });
        }
        handleSendText('[購物中心卡片]', 'mall_order', metadata);
        trackEvent('购物中心发送订单卡片', { mallKind: order.mallKind, mode: order.mode });
    };

    // 用戶點「生活記錄」代記卡選擇確認 / 否決：
    // 否決 → 記錄標記 rejected（不再計入注入摘要）+ 回滾銀行流水（expense）+
    // 給代記角色掛一條一次性反饋，下一輪 system prompt 會告訴角色它弄錯了。
    const handleResolveLifeRecord = useCallback(async (msg: Message, action: 'confirmed' | 'rejected') => {
        if (!char) return;
        // 只處理仍待複核的卡片，避免重複點擊。
        if (msg.metadata?.reviewStatus && msg.metadata.reviewStatus !== 'active') return;
        try {
            await resolveLifeRecordCard(msg, action);
            // 否決會把這條記錄踢出注入摘要、回滾銀行流水，生活記錄是注入給所有開了開關的
            // 角色的共享素材，所以逐個打髒（同表情庫）。
            markAmsgStateDirtyForAll({ characters, userProfileBase, groups, realtimeConfig });
            addToast(action === 'confirmed' ? '已確認記錄' : '已否決，記錄撤銷', action === 'confirmed' ? 'success' : 'info');
        } catch (e) {
            console.error('[LifeRecord] resolve failed:', e);
        }
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages, addToast, characters, userProfileBase, groups, realtimeConfig]);

    // 頂欄 ⚡ 手動觸發（也是「發完後自動生成」到點時調的那一下）。
    const handleManualTrigger = () => {
        autoReply.cancel();
        if (isTyping) return;
        triggerAI(messages);
    };
    manualTriggerRef.current = handleManualTrigger;

    const handleReroll = async () => {
        if (isTyping || messages.length === 0) return;
        autoReply.cancel();

        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role !== 'assistant') return;

        const toDeleteIds: number[] = [];
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role === 'assistant') {
            toDeleteIds.push(messages[index].id);
            index--;
        }

        if (toDeleteIds.length === 0) return;

        await DB.deleteMessages(toDeleteIds);
        discardVoiceForMessages(toDeleteIds);
        // 重 roll 也刪了消息：正常路徑下這輪生成結束會再打髒一次，這裡先打是兜住
        // 「觸發失敗沒走到生成收尾」的路徑，雲端 fire_pack 不能停在刪除前。
        markAmsgStateDirty({ char, userProfile: chatUserProfile, groups, realtimeConfig });
        const newHistory = messages.slice(0, index + 1);
        setMessages(newHistory);
        addToast('回溯對話中...', 'info');
        trackEvent('重新生成回复');

        // 重 roll：不注入上一輪殘留的情緒 buff 與意識流（innerState），兩邊獨立重新生成。
        triggerAI(newHistory, undefined, { skipEmotionInjection: true });
    };

    const handleImageSelect = async (file: File) => {
        const finishImage = autoReply.beginSend(char?.id || null);
        try {
            const base64 = await processImage(file, { maxWidth: 600, quality: 0.6, forceJpeg: true });
            if (!inputPreferences.autoReply) setShowPanel('none');
            await handleSendText(base64, 'image');
        } catch (err: any) {
            addToast(err.message || '圖片處理失敗', 'error');
        } finally {
            // 是否真正發出由 handleSendText 標記；這裡僅解除圖片處理期間的暫停。
            finishImage(false);
        }
    };

    const handlePanelAction = (type: string, payload?: any) => {
        // 只統計「打開某個面板 / 開關某個能力」這幾個固定入口，名單寫死在這裡；
        // 選表情、選分類之類的動作不上報。
        if ([
            'transfer', 'archive', 'settings', 'fine-tune',
            'meetup', 'proactive', 'active-msg-2', 'schedule', 'mcd-request', 'luckin-request', 'mall-open',
            'html-mode-toggle', 'html-mode-settings', 'thinking-settings', 'favorites', 'collaboration',
            // 獨立小功能：點一下就是用了一次，跟「打開某個面板」同一性質。
            // send-emoji / select-category 這些是「挑哪一個」，不進名單。
            'poke', 'emoji-import', 'add-category', 'mcd-end', 'luckin-end',
        ].includes(type)) {
            trackEvent('打开聊天功能面板项', { action: type });
        }
        switch (type) {
            case 'collaboration': setShowPanel('none'); setCollaborationOpen(true); break;
            case 'memory-link': setShowPanel('none'); setMemoryRepairOpen(true); break;
            case 'favorites': setShowPanel('none'); setFavoritesOpen(true); break;
            case 'transfer': setModalType('transfer'); break;
            case 'poke': handleSendText('[戳一戳]', 'interaction'); break;
            case 'archive': setModalType('archive-settings'); break;
            case 'settings': setModalType('chat-settings'); break;
            case 'fine-tune': setShowPanel('none'); setDecorationTab('layout'); setModalType('chrome-css'); break;
            case 'emoji-import': setModalType('emoji-import'); break;
            case 'send-emoji': if (payload) handleSendText(payload.url, 'emoji'); break;
            case 'delete-emoji-req': setSelectedEmoji(payload); setModalType('delete-emoji'); break;
            case 'emoji-options': setSelectedEmoji(payload); setModalType('emoji-options'); break;
            case 'add-category': setModalType('add-category'); break;
            case 'select-category': setActiveCategory(payload); break;
            case 'category-options': setSelectedCategory(payload); setModalType('category-options'); break;
            case 'delete-category-req': setSelectedCategory(payload); setModalType('delete-category'); break;
            case 'meetup': if (char) { setShowPanel('none'); openDateWithChar(char.id); } break;
            case 'proactive': setShowProactiveModal(true); break;
            case 'active-msg-2': setShowActiveMsg2Modal(true); break;
            case 'emotion': setModalType('schedule'); break; // 情緒已併入日程，打開同一 modal
            case 'schedule': setModalType('schedule'); break;
            case 'mcd-not-configured':
                addToast('請先到設置 → 麥當勞 啟用並填入 MCP Token', 'info');
                break;
            case 'mcd-request':
                setMcdAppOpen(true);
                trackEvent('打开麦当劳点单小程序');
                break;
            case 'mcd-end':
                handleSendText(MCD_DEACTIVATE_TRIGGER, 'text', { mcdDeactivate: true });
                break;
            case 'luckin-not-configured':
                addToast('請先到設置 → 瑞幸 啟用並填入 MCP Token', 'info');
                break;
            case 'luckin-request':
                activateLuckin();
                break;
            case 'luckin-end':
                deactivateLuckin();
                break;
            case 'html-mode-toggle': {
                if (!char) break;
                const next = !((char as any).htmlModeEnabled);
                updateCharacter(char.id, { htmlModeEnabled: next } as any);
                addToast(next ? 'HTML 模式已開啟' : 'HTML 模式已關閉', next ? 'success' : 'info');
                break;
            }
            case 'html-mode-settings': {
                // 長按 → 跳進聊天設置 modal 的 HTML 模塊板塊 (順便確保開關已打開, 不然滾下去看不見 textarea)
                if (!char) break;
                if (!(char as any).htmlModeEnabled) {
                    updateCharacter(char.id, { htmlModeEnabled: true } as any);
                }
                setModalType('chat-settings');
                break;
            }
            case 'thinking-settings': {
                // 「展示思考」按鈕 → 打開思考鏈設置 modal（開關 / 卡片風格 / 配色 / 追加提示詞）
                if (!char) break;
                setShowThinkingChainModal(true);
                break;
            }
            case 'mall-open':
                setMallOpen(true);
                break;
        }
    };

    // 當前會話麥請求是否激活 (從消息歷史推導, 無新存儲)
    const mcdActivated = useMemo(() => isMcdActivatedInMessages(messages), [messages]);
    const [mcdAppOpen, setMcdAppOpen] = useState(false);
    // 購物中心 mini-app：跟麥當勞小程序同構的本地 mini-app 殼，見 components/mall/ShoppingMallMiniApp.tsx
    const [mallOpen, setMallOpen] = useState(false);
    // mcdMiniAppRef 聲明在文件靠前 (傳給 useChatAI), 這裡僅佔位
    const mcdConfiguredFlag = useMemo(() => isMcdConfigured(), [showPanel, mcdActivated]);

    // 瑞幸聊天點單模式: 激活態用 React state (臨時會話態, 不落庫)
    const [luckinMode, setLuckinMode] = useState(false);
    const [showLuckinLoc, setShowLuckinLoc] = useState(false); // 瑞一杯定位選擇彈窗
    const [showLuckinHelp, setShowLuckinHelp] = useState(false); // 瑞一杯使用說明
    const luckinActivated = luckinMode;
    const [luckinAppOpen, setLuckinAppOpen] = useState(false); // 舊小程序殼, 現已不主動開
    const luckinConfiguredFlag = useMemo(() => isLuckinConfigured(), [showPanel, luckinActivated]);

    const activateLuckin = useCallback(() => {
        if (!isLuckinConfigured()) { addToast('請先到設置 → 瑞幸 啟用並填入 MCP Token', 'info'); return; }
        setShowPanel('none');
        setShowLuckinLoc(true); // 先選定位 (GPS 常抓到機房位置, 讓用戶選城市)
    }, [addToast]);

    // 選完定位 → 正式激活角色瑞幸模式, 把座標注入給角色
    const onLuckinLocationPick = useCallback((lng: number, lat: number, cityName?: string) => {
        luckinChatRef.current = { active: true, longitude: lng, latitude: lat, cityName };
        setLuckinMode(true);
        setShowLuckinLoc(false);
        trackEvent('开启瑞一杯聊天点单');
        addToast(`瑞一杯已開啟 ☕ 定位: ${cityName || '已設置'}`, 'info');
        // 首次啟動: 自動彈一次使用說明 (之後收在 banner 的 ? 裡)
        try {
            if (localStorage.getItem('aetheros.luckin.helpSeen') !== '1') {
                setShowLuckinHelp(true);
                localStorage.setItem('aetheros.luckin.helpSeen', '1');
            }
        } catch { /* ignore */ }
    }, [addToast]);

    const deactivateLuckin = useCallback(() => {
        luckinChatRef.current = { active: false };
        setLuckinMode(false);
    }, []);

    // 用戶在菜單卡里點"發送給角色"時, 把購物車作為 user 消息插入
    const handleMcdSendCart = useCallback(async (items: import('../components/chat/McdCard').McdCartItem[]) => {
        if (!char || !items.length) return;
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const content = `想要下單：${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: { mcdCardKind: 'cart', mcdCartItems: items },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // 用戶在菜單卡某條單品上點 💭 → 立即把這條扔給角色讓 ta 評價 (候選狀態, 不進購物車)
    const handleMcdCandidate = useCallback(async (item: import('../components/chat/McdCard').McdCartItem) => {
        if (!char || !item) return;
        const priceStr = typeof item.price === 'number' ? ` ¥${item.price}` : (typeof item.price === 'string' && item.price ? ` ¥${item.price}` : '');
        const content = `「${item.name}」${priceStr}—— 這個怎麼樣？`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: { mcdCardKind: 'candidate', mcdCandidate: item },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // 小程序內輸入 → 直接保存 user 消息 + 立即觸發 AI (主聊天 handleSendText 不自動觸發,
    // 那是設計上的"手動 ⚡ 觸發"流程, 但小程序裡用戶預期發完就有回覆, 跳過那個步驟)。
    // 走完整 pipeline: useChatAI 在 build prompt 時會讀 mcdMiniAppRef 注入小程序狀態。
    const handleMcdMiniAppSend = useCallback(async (text: string) => {
        if (!char || !text.trim() || isTyping) return;
        const trimmed = text.trim();
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'text',
            content: trimmed,
            metadata: { fromMcdMiniApp: true },
        } as any);
        const recent = await DB.getRecentMessagesByCharId(char.id, 200);
        setMessages(recent);
        triggerAI(recent);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char, isTyping, triggerAI]);

    // 小程序狀態實時同步到 ref, 讓下次 send 走主 pipeline 時能注入到 system prompt
    const handleMcdMiniAppStateChange = useCallback((state: import('../utils/mcdToolBridge').McdMiniAppSnapshot) => {
        mcdMiniAppRef.current = state;
    }, []);

    // 小程序裡"敲定"購物車 → 把購物車轉成 cart 卡 (複用現有渲染), 之後 Phase 2
    // 會在這裡掛 calculate-price + create-order。當前先讓 char 看到購物車評論。
    const handleMcdAppConfirm = useCallback(async (
        cart: import('../components/mcd/McdMiniApp').CartLine[],
        ctx: import('../components/mcd/McdMiniApp').OrderContext,
    ) => {
        if (!char || !cart.length) return;
        const items: import('../components/chat/McdCard').McdCartItem[] = cart.map(l => ({
            code: l.code,
            name: l.name,
            price: l.price,
            qty: l.qty,
        }));
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const where = ctx.orderType === 2
            ? `外送至 ${ctx.addressLabel || ctx.addressId}`
            : `到店取餐 (${ctx.storeName || ctx.storeCode})`;
        const content = `${where} · ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: {
                mcdCardKind: 'cart',
                mcdCartItems: items,
                mcdOrderContext: ctx,
            },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // ─── 瑞幸 handlers (與麥當勞同構) ───
    const handleLuckinSendCart = useCallback(async (items: import('../components/chat/LuckinCard').LuckinCartItem[]) => {
        if (!char || !items.length) return;
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const content = `想要下單：${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: { luckinCardKind: 'cart', luckinCartItems: items },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    const handleLuckinCandidate = useCallback(async (item: import('../components/chat/LuckinCard').LuckinCartItem) => {
        if (!char || !item) return;
        const priceStr = (typeof item.price === 'number' || (typeof item.price === 'string' && item.price)) ? ` ¥${item.price}` : '';
        const content = `「${item.name}」${priceStr}—— 這個怎麼樣？`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: { luckinCardKind: 'candidate', luckinCandidate: item },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    const handleLuckinMiniAppSend = useCallback(async (text: string) => {
        if (!char || !text.trim() || isTyping) return;
        const trimmed = text.trim();
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'text',
            content: trimmed,
            metadata: { fromLuckinMiniApp: true },
        } as any);
        const recent = await DB.getRecentMessagesByCharId(char.id, 200);
        setMessages(recent);
        triggerAI(recent);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char, isTyping, triggerAI]);

    const handleLuckinMiniAppStateChange = useCallback((state: import('../utils/luckinToolBridge').LuckinMiniAppSnapshot) => {
        luckinMiniAppRef.current = state;
    }, []);

    const handleLuckinAppConfirm = useCallback(async (
        cart: import('../components/luckin/LuckinMiniApp').CartLine[],
        ctx: import('../components/luckin/LuckinMiniApp').OrderContext,
    ) => {
        if (!char || !cart.length) return;
        const items: import('../components/chat/LuckinCard').LuckinCartItem[] = cart.map(l => ({
            code: l.code,
            name: l.name,
            price: l.price,
            qty: l.qty,
            spec: l.spec,
        }));
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const content = `到店自提 (${ctx.storeName || ctx.deptId}) · ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: {
                luckinCardKind: 'cart',
                luckinCartItems: items,
                luckinOrderContext: ctx,
            },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // --- Schedule Handlers ---
    const loadSchedule = async () => {
        if (!char) return;
        if (!isScheduleFeatureOn(char)) { setScheduleData(null); return; }
        const s = await getDailyScheduleForChar(char);
        setScheduleData(s);
    };

    // Load schedule when modal opens
    React.useEffect(() => {
        if (modalType === 'schedule') loadSchedule();
    }, [modalType]);

    // 日程表隨 fire_pack 一起上雲（角色到點按它說自己在幹嘛），改完要讓雲端那份跟上：
    // 用戶把「健身」改成「在家養病」，角色晚上還說「剛從健身房回來」就穿幫了。
    const handleScheduleEdit = async (index: number, slot: ScheduleSlot) => {
        if (!scheduleData) return;
        const newSlots = [...scheduleData.slots];
        newSlots[index] = slot;
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
        markAmsgStateDirty({ char, userProfile: chatUserProfile, groups, realtimeConfig });
    };

    const handleScheduleDelete = async (index: number) => {
        if (!scheduleData) return;
        const newSlots = scheduleData.slots.filter((_, i) => i !== index);
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
        markAmsgStateDirty({ char, userProfile: chatUserProfile, groups, realtimeConfig });
    };

    const handleScheduleCoverChange = async (dataUrl: string) => {
        if (!scheduleData) return;
        const updated = { ...scheduleData, coverImage: dataUrl };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
    };

    // 小劇場：點某個時段的播放按鈕。有緩存直接放；沒有則先生成再放（forceRegenerate=重演）。
    const runTheater = async (index: number, forceRegenerate: boolean) => {
        if (!char || !scheduleData) return;
        const slot = scheduleData.slots[index];
        if (!slot) return;
        trackEvent('打开日程小剧场', { mode: forceRegenerate ? 'replay' : 'play' });
        // 命中緩存且非重演：直接打開，不燒 token
        if (!forceRegenerate && slot.theater && slot.theater.lines.length > 0) {
            setTheaterSlotIdx(index);
            return;
        }
        setTheaterSlotIdx(index);
        setIsTheaterGenerating(true);
        try {
            const updated = await generateSlotTheater(char, chatUserProfile, scheduleData, index, apiConfig, forceRegenerate);
            if (updated) {
                setScheduleData(updated);
            } else {
                addToast('小劇場生成失敗，稍後再試', 'error');
                setTheaterSlotIdx(null);
            }
        } catch (e) {
            console.error('[Theater] play failed:', e);
            addToast('小劇場生成失敗，稍後再試', 'error');
            setTheaterSlotIdx(null);
        } finally {
            setIsTheaterGenerating(false);
        }
    };

    const handlePlayTheater = (index: number) => { runTheater(index, false); };

    // 把這段小劇場作為卡片發到聊天。兩態都「留痕」——角色都知道自己當時幹了啥，
    // 區別只在 exposed：是否知道「user 看到了」。
    //   exposed=true  → TA 會發現你在偷看
    //   exposed=false → TA 不知道你看了（但照樣記得自己幹了啥）
    // 發卡片本身不再自動觸發對話——只留痕，下次聊天角色自然帶著這份記憶。
    const handleSendTheaterCard = async (index: number, exposed: boolean) => {
        if (!char || !scheduleData) return;
        const slot = scheduleData.slots[index];
        if (!slot?.theater || slot.theater.lines.length === 0) return;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'theater_card',
            content: `${slot.startTime} · ${slot.activity}`,
            metadata: {
                theater: slot.theater,
                slotTime: slot.startTime,
                activity: slot.activity,
                emoji: slot.emoji,
                date: scheduleData.date,
                exposed,
            },
        });
        // 關掉播放器 + 日程 modal，回到聊天看到卡片（但不強行觸發回覆）
        setTheaterSlotIdx(null);
        setModalType('none');
        await reloadMessages(visibleCountRef.current);
        addToast(exposed ? '已讓 TA 發現你在看 👀' : '已悄悄記下 · TA 不知道你看了 🙈', 'info');
    };

    const generateDailySchedule = async (targetChar: typeof char, forceRegenerate: boolean = false) => {
        if (!targetChar || isScheduleGenerating) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(targetChar, chatUserProfile, apiConfig, forceRegenerate);
            if (result) {
                setScheduleData(result);
                // 跨天后台重新生成也要刷雲端：不刷的話角色到點照著昨天的作息表說話
                markAmsgStateDirty({ char: targetChar, userProfile: chatUserProfile, groups, realtimeConfig });
            }
        } catch (e) {
            console.error('[Schedule] Generation error:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    const handleScheduleStyleChange = async (style: 'lifestyle' | 'mindful') => {
        if (!char) return;
        // 與情緒/意識流強制同步：啟用日程時自動啟用情緒感知
        const prevEmotion = char.emotionConfig;
        const nextEmotion = { ...(prevEmotion || {}), enabled: true };
        updateCharacter(char.id, { scheduleStyle: style, emotionConfig: nextEmotion });
        // Force regenerate with new style — use updated char object
        const updatedChar = { ...char, scheduleStyle: style, emotionConfig: nextEmotion };
        if (!isScheduleFeatureOn(updatedChar)) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(updatedChar, chatUserProfile, apiConfig, true);
            if (result) setScheduleData(result);
        } catch (e) {
            console.error('[Schedule] Regeneration after style change failed:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    // 日程 / 情緒 buff 總開關
    // 關閉：清空前台 scheduleData，同時清空可能已緩存的 buff 注入（防止繼續汙染下一輪 prompt）
    // 打開：若還沒生成今日日程，立即生成一次
    const handleToggleScheduleFeature = async () => {
        if (!char) return;
        const nextEnabled = !isScheduleFeatureOn(char);
        const patch: any = { scheduleFeatureEnabled: nextEnabled };
        if (nextEnabled) {
            // 與 handleScheduleStyleChange 對齊：開日程 = 同步開情緒/意識流。
            // 舊邏輯下，新角色的 emotionConfig 從未初始化（undefined），
            // 僅切總開關而不點風格時，emotionConfig?.enabled 始終落 false，
            // 副 API 閘門 (isScheduleFeatureOn && emotionConfig?.enabled) 永遠過不去。
            patch.emotionConfig = { ...(char.emotionConfig || {}), enabled: true };
        } else {
            // 關閉時順手把 buff 注入清空，避免上一輪殘留繼續注入
            patch.buffInjection = '';
            patch.activeBuffs = [];
        }
        updateCharacter(char.id, patch);
        if (!nextEnabled) {
            setScheduleData(null);
            addToast('日程與情緒已關閉', 'info');
            return;
        }
        addToast('日程與情緒已開啟', 'success');
        // 打開後立刻嘗試生成（若今日未生成且已選風格）
        const updatedChar = { ...char, ...patch };
        if (updatedChar.scheduleStyle) {
            const existing = await getDailyScheduleForChar(updatedChar).catch(() => null);
            if (existing) {
                setScheduleData(existing);
            } else {
                generateDailySchedule(updatedChar, false);
            }
        }
    };

    // --- Modal Handlers ---

    /**
     * 表情庫是全局的：增刪改名、刪分類、改分類可見範圍，都會讓每個角色雲端 fire_pack 裡
     * 那份表情清單過期。角色到點照舊清單發 [[SEND_EMOJI]]，客戶端反查不到就只能落降級
     * 文本氣泡——所以這幾個入口都要重新打包。
     */
    const markEmojiLibraryChanged = () => markAmsgStateDirtyForAll({ characters, userProfileBase, groups, realtimeConfig });

    const handleAddCategory = async () => {
        if (!newCategoryName.trim()) {
             addToast('請輸入分類名稱', 'error');
             return;
        }
        const newCat = { id: `cat-${Date.now()}`, name: newCategoryName.trim() };
        await DB.saveEmojiCategory(newCat);
        await loadEmojiData();
        setActiveCategory(newCat.id);
        setModalType('none');
        setNewCategoryName('');
        addToast('分類創建成功', 'success');
    };

    const handleImportEmoji = async () => {
        if (!emojiImportText.trim()) return;
        const lines = emojiImportText.split('\n');
        const targetCatId = activeCategory === 'default' ? undefined : activeCategory;

        for (const line of lines) {
            const parts = line.split('--');
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const url = parts.slice(1).join('--').trim();
                if (name && url) {
                    // 粘進來的可能是 data: 圖（複製粘貼的圖片），也可能是圖床外鏈。
                    // 前者轉成令牌只留二進制，後者是別人服務器上的地址，原樣存。
                    const stored = url.startsWith('data:') ? await migrateDataUrlToRef(url) : url;
                    await DB.saveEmoji(name, stored, targetCatId);
                }
            }
        }
        await loadEmojiData();
        markEmojiLibraryChanged();
        setModalType('none');
        setEmojiImportText('');
        addToast('表情包導入成功', 'success');
    };

    const handleRenameCategory = async () => {
        if (!selectedCategory || selectedCategory.isSystem || selectedCategory.id === 'default') return;
        const name = newCategoryName.trim();
        if (!name) { addToast('分類名稱不能為空', 'error'); return; }
        try {
            await DB.saveEmojiCategory({ ...selectedCategory, name });
            await loadEmojiData();
            markEmojiLibraryChanged();
            setModalType('none'); setSelectedCategory(null); setNewCategoryName('');
            addToast('分類已重命名', 'success');
        } catch { addToast('分類重命名失敗', 'error'); }
    };
    const handleDownloadCategory = () => {
        if (!selectedCategory) return;
        const items = emojis.filter(e => selectedCategory.id === 'default' ? !e.categoryId || e.categoryId === 'default' : e.categoryId === selectedCategory.id);
        setEmojiExport({ emojis: items, title: selectedCategory.name });
        setModalType('none');
    };

    const handleDeleteCategory = async () => {
        if (!selectedCategory) return;
        await DB.deleteEmojiCategory(selectedCategory.id);
        await loadEmojiData();
        markEmojiLibraryChanged();
        setActiveCategory('default');
        setModalType('none');
        setSelectedCategory(null);
        addToast('分類及包含表情已刪除', 'success');
    };

    const handleSaveCategoryVisibility = async (categoryId: string, allowedCharacterIds: string[] | undefined) => {
        const cat = categories.find(c => c.id === categoryId);
        if (!cat) return;
        await DB.saveEmojiCategory({ ...cat, allowedCharacterIds });
        await loadEmojiData();
        markEmojiLibraryChanged();
        setSelectedCategory(null);
        addToast(allowedCharacterIds ? `已設置 ${allowedCharacterIds.length} 個角色可見` : '已設為所有角色可見', 'success');
    };

    const handleSavePrompt = () => {
        if (!editingPrompt || !editingPrompt.name.trim() || !editingPrompt.content.trim()) {
            addToast('請填寫完整', 'error');
            return;
        }
        setArchivePrompts(prev => {
            let next;
            if (prev.some(p => p.id === editingPrompt.id)) {
                next = prev.map(p => p.id === editingPrompt.id ? editingPrompt : p);
            } else {
                next = [...prev, editingPrompt];
            }
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        setSelectedPromptId(editingPrompt.id);
        setModalType('archive-settings');
        setEditingPrompt(null);
    };

    const handleDeletePrompt = (id: string) => {
        if (id.startsWith('preset_')) {
            addToast('默認預設不可刪除', 'error');
            return;
        }
        setArchivePrompts(prev => {
            const next = prev.filter(p => p.id !== id);
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        if (selectedPromptId === id) setSelectedPromptId('preset_rational');
        addToast('預設已刪除', 'success');
    };

    const createNewPrompt = () => {
        setEditingPrompt({ id: `custom_${Date.now()}`, name: '新預設', content: DEFAULT_ARCHIVE_PROMPTS[0].content });
        setModalType('prompt-editor');
    };

    const editSelectedPrompt = () => {
        const p = archivePrompts.find(a => a.id === selectedPromptId);
        if (!p) return;
        if (p.id.startsWith('preset_')) {
            setEditingPrompt({ id: `custom_${Date.now()}`, name: `${p.name} (Copy)`, content: p.content });
        } else {
            setEditingPrompt({ ...p });
        }
        setModalType('prompt-editor');
    };

    const handleBgUpload = async (file: File) => {
        try {
            // 改存 Blob：原畫質不重繪，二進制進 blob_assets，字段只存 blobref 令牌
            // （省掉 base64 的 ~33% 膨脹，也不再把整張圖常駐在角色行裡）。
            const blob = await processImageToBlob(file, { skipCompression: true });
            const ref = await putImageBlob(blob);
            updateCharacter(char.id, { chatBackground: ref });
            addToast('聊天背景已更新', 'success');
        } catch(err: any) {
            addToast(err.message, 'error');
        }
    };

    const saveSettings = async (pagePatch?: ChatSettingsPatch) => {
        const canUseAdaptiveRange = !!(char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm);
        const nextMode: ContextRangeMode = canUseAdaptiveRange
            ? settingsContextRangeMode
            : 'manual';
        const nextFollowsOneShotWaterline = nextMode === 'adaptive'
            && !!char.contextFollowsMemoryPalaceHwm;
        const candidate = {
            ...char,
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: nextMode,
            contextLimit: settingsContextLimit,
            contextFollowsMemoryPalaceHwm: nextFollowsOneShotWaterline,
        };
        let nextUserStart = char.contextUserStartMessageId;
        try {
            const range = await loadCharacterContextRange(candidate);
            if (range.userBreakpointExpired) nextUserStart = undefined;
        } catch {
            // 保存其它設置不應被一次範圍檢查失敗阻斷；AI 請求時還會再次做同樣的安全鉗制。
        }
        updateCharacter(char.id, {
            contextLimit: settingsContextLimit,
            contextRangeMode: nextMode,
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextFollowsMemoryPalaceHwm: nextFollowsOneShotWaterline,
            contextUserStartMessageId: nextUserStart,
            hideSystemLogs: settingsHideSysLogs,
            htmlModeCustomPrompt: settingsHtmlModeCustomPrompt,
            ...(pagePatch || {}),
        } as any);
        // 關掉延遲自動回覆：排著的那筆（連同交給雲端的）一起作廢，不然到點還是會回
        if (pagePatch?.delayedReply && !pagePatch.delayedReply.enabled) cancelDelayedReplyEverywhere(char.id);
        setInputPreferences(settingsInputPreferences);
        saveChatInputPreferences(settingsInputPreferences);
        setModalType('none');
        addToast('設置已保存', 'success');
    };

    const handleToggleContextSuite = () => {
        const enabled = !contextSuiteAnyEnabled;
        trackEvent('切换智能语境', {
            状态: enabled ? '开' : '关',
            此前: contextSuiteAllEnabled ? '全开' : contextSuiteAnyEnabled ? '部分开' : '全关',
        });
        updateMemoryPalaceConfig({
            featureFlags: {
                ...memoryPalaceConfig.featureFlags,
                recallRouter: enabled,
                interactionAdaptation: enabled,
                deepEngagement: enabled,
            },
        });
        addToast(enabled ? '已開啟智能語境' : '已關閉智能語境，回覆恢復舊流程', 'success');
    };

    const restoreAdaptiveContext = () => {
        if (!char.autoArchiveEnabled && !char.contextFollowsMemoryPalaceHwm) return;
        trackEvent('恢复自适应上下文', {
            来源: char.autoArchiveEnabled ? '全自动记忆' : '记忆水位线',
        });
        setSettingsContextRangeMode('adaptive');
        setSettingsContextLimit(500);
        updateCharacter(char.id, {
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: 'adaptive',
            contextLimit: 500,
            contextFollowsMemoryPalaceHwm: !!char.contextFollowsMemoryPalaceHwm,
            contextUserStartMessageId: undefined,
        });
        addToast(
            char.autoArchiveEnabled
                ? '已恢復全自動記憶的自適應上下文'
                : '已恢復跟隨記憶水位線',
            'success',
        );
    };

    const handleHistoryCleanupDone = async (plan: ChatCleanupPlan) => {
        trackEvent('清空聊天记录');
        markAmsgStateDirty({ char, userProfile: chatUserProfile, groups, realtimeConfig });
        if (activeCharIdRef.current !== plan.charId) return;
        discardVoiceForMessages(plan.ids, false);
        setAllHistoryMessages([]);
        setSelectedMessage(null);
        setSelectedMsgIds(new Set());
        setSelectedThinkingMsgIds(new Set());
        setHistoryWindowRange(null);
        historyWindowRangeRef.current = null;
        setVisibleCount(LOAD_BATCH_SIZE);
        visibleCountRef.current = LOAD_BATCH_SIZE;
        await reloadMessages(LOAD_BATCH_SIZE);
    };

    // 只在打開聊天設置時計算一鍵存入的待處理量；不開彈窗的用戶沒有額外 DB 掃描。
    // 這裡按按鈕的真實語義統計：默認處理到當前末尾，勾選後精確保留最後 10 條原文。
    useEffect(() => {
        if (modalType !== 'chat-settings' || !char?.memoryPalaceEnabled) {
            setVectorizePendingCount(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const { getMemoryPalaceOneShotPendingCount } = await import('../utils/memoryPalace/pipeline');
                const n = await getMemoryPalaceOneShotPendingCount(
                    char.id,
                    retainRecentForVectorize ? 10 : 0,
                );
                if (!cancelled) setVectorizePendingCount(n);
            } catch {
                // 算不出就不顯示條數，不影響按鈕可用
            }
        })();
        return () => { cancelled = true; };
    }, [modalType, char?.id, char?.memoryPalaceEnabled, retainRecentForVectorize]);

    const handleForceVectorize = async () => {
        if (!char || !char.memoryPalaceEnabled || isVectorizing) return;
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLM = memoryPalaceConfig?.lightLLM;
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM?.baseUrl) {
            addToast('請先在記憶宮殿設置中配置 API', 'error');
            return;
        }

        const retainedCount = retainRecentForVectorize ? 10 : 0;
        const charIdAtStart = char.id;
        setIsVectorizing(true);
        setVectorizeProgress('準備中...');
        addToast(
            retainedCount === 10
                ? '🏰 開始整理聊天，保留最近 10 條原文...'
                : '🏰 開始整理全部聊天記錄...',
            'info',
        );

        try {
            const {
                processNewMessages,
                getMemoryPalaceHighWaterMark,
                getMemoryPalaceOneShotPendingCount,
                mergePalaceFragmentsIntoMemories,
            } = await import('../utils/memoryPalace/pipeline');
            const pendingBefore = await getMemoryPalaceOneShotPendingCount(char.id, retainedCount);
            const hwmBefore = getMemoryPalaceHighWaterMark(char.id);
            setVectorizePendingCount(pendingBefore);
            setVectorizeProgress(pendingBefore > 0 ? `待處理 ${pendingBefore} 條` : '正在同步原文邊界...');

            const pipelineResult = await processNewMessages(
                [],
                char.id,
                char.name,
                mpEmb,
                mpLLM,
                chatUserProfile?.name || '',
                true,
                setVectorizeProgress,
                {
                    drainBuffer: true,
                    retainRecentMessages: retainedCount,
                    requireAllBatches: true,
                },
            );

            if (charIdAtStart !== activeCharIdRef.current) return;
            if (!pipelineResult) throw new Error('記憶處理沒有完成，請檢查副 API 與網絡');
            if (pipelineResult.skipReason === 'lock') throw new Error('這個角色已有記憶任務在運行，請稍後再試');
            const failedBatches = pipelineResult.batches.filter(batch => !batch.ok);
            if (failedBatches.length > 0) {
                throw new Error(`第 ${failedBatches.map(batch => batch.index).join('、')} 批處理失敗，水位線未移動`);
            }

            const rangeMessages = (await DB.getMessagesByCharId(char.id, true))
                .filter(message => !message.groupId)
                .sort((a, b) => a.id - b.id);
            const expectedRetained = Math.min(retainedCount, rangeMessages.length);
            const targetBoundaryIndex = rangeMessages.length - expectedRetained - 1;
            const targetBoundaryId = targetBoundaryIndex >= 0 ? rangeMessages[targetBoundaryIndex].id : 0;
            const hwmAfter = getMemoryPalaceHighWaterMark(char.id);
            if (targetBoundaryId > hwmBefore && hwmAfter < targetBoundaryId) {
                throw new Error('處理未到達預定邊界，原文範圍保持不變，請重試');
            }

            // 水位線只前進不回退。極少數情況下用戶先“保留 0 條”又改選保留 10 條，
            // 這 10 條此前已處理；此時用手動 10 條保證原文仍可讀，同時避免重複向量化。
            const waterlineAlreadyAhead = expectedRetained > 0 && hwmBefore > targetBoundaryId;
            const nextMode: ContextRangeMode = waterlineAlreadyAhead ? 'manual' : 'adaptive';
            const nextLimit = expectedRetained > 0 ? 10 : (char.contextLimit || 500);
            const updates: Record<string, any> = {
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
                contextRangeMode: nextMode,
                contextLimit: nextLimit,
                contextFollowsMemoryPalaceHwm: !waterlineAlreadyAhead,
                contextUserStartMessageId: undefined,
            };

            if (char.autoArchiveEnabled) {
                updates.hideBeforeMessageId = Math.max(char.hideBeforeMessageId || 0, hwmAfter);
                if (pipelineResult.autoArchive) {
                    updates.memories = mergePalaceFragmentsIntoMemories(
                        char.memories ? [...char.memories] : [],
                        pipelineResult.autoArchive.fragments,
                    );
                }
            }
            updateCharacter(char.id, updates);
            setAllHistoryMessages(rangeMessages);
            setSettingsContextRangeMode(nextMode);
            setSettingsContextLimit(nextLimit);
            setVectorizePendingCount(await getMemoryPalaceOneShotPendingCount(char.id, retainedCount));
            setVectorizeResult({
                processedMessages: pipelineResult.processedMessages || pendingBefore,
                storedMemories: pipelineResult.stored,
                retainedMessages: expectedRetained,
                waterlineAlreadyAhead,
            });
            setModalType('memory-vectorize-result');
            addToast('✅ 記憶處理完成，原文範圍已同步', 'success');
        } catch (e: any) {
            addToast(`❌ 向量化失敗：${e.message}`, 'error');
            if (charIdAtStart === activeCharIdRef.current) setModalType('chat-settings');
        } finally {
            setIsVectorizing(false);
            setVectorizeProgress('');
        }
    };

    const handleSetHistoryStart = (messageId: number | undefined) => {
        if (!messageId) {
            updateCharacter(char.id, {
                contextUserStartMessageId: undefined,
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            });
            setModalType('none');
            addToast('已清除用戶斷點，原文範圍重新跟隨拉桿上限', 'success');
            return;
        }

        const range = historyContextRange;
        const maxStart = range?.maxRangeStartMessageId;
        // 不用 Array.prototype.at：tsconfig 的 lib 沒開 es2022，tsc 會報錯
        const rangeMessages = range?.messages ?? [];
        const latestId = rangeMessages[rangeMessages.length - 1]?.id
            || allHistoryMessages[allHistoryMessages.length - 1]?.id;
        if (maxStart === undefined || latestId === undefined || messageId < maxStart || messageId > latestId) {
            const required = countMessagesFrom(allHistoryMessages, messageId);
            const hint = settingsContextRangeMode === 'adaptive'
                ? `該消息在全自動記憶當前原文範圍之外。請先切換為自定義範圍，並將拉桿調至至少 ${required} 條。`
                : required > 5000
                    ? '該消息超出上下文拉桿的 5000 條上限，無法設為用戶斷點。'
                    : `該消息超出當前拉桿範圍，請先將上下文調至至少 ${required} 條。`;
            addToast(hint, 'error');
            return;
        }

        updateCharacter(char.id, {
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: (char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm)
                ? settingsContextRangeMode
                : 'manual',
            contextLimit: settingsContextLimit,
            contextFollowsMemoryPalaceHwm: settingsContextRangeMode === 'adaptive'
                && !!char.contextFollowsMemoryPalaceHwm,
            contextUserStartMessageId: messageId,
        });
        setModalType('none');
        addToast('已設置 AI 原文讀取斷點', 'success');
    };

    // 跳轉到舊消息：先定位到目標周圍的小窗口，再在用戶滑到窗口邊緣時按批次
    // 向前/向後擴展。這樣既不會首次掛載整段超長 DOM，也不會把用戶鎖死在 51 條裡。
    const handleJumpToMessageInChat = async (messageId: number) => {
        if (!activeCharacterId) return;
        setModalType('none');
        const requestCharId = activeCharacterId;
        const LARGE = 999999;
        visibleCountRef.current = LARGE;
        setVisibleCount(LARGE);
        const allMsgs = await DB.getMessagesByCharId(requestCharId, true);
        if (activeCharIdRef.current !== requestCharId) return;
        const browseableMessages = allMsgs.filter(message => isVisibleChatMessage(message, !!char?.hideSystemLogs));
        const targetIndex = browseableMessages.findIndex(message => message.id === messageId);
        if (targetIndex < 0) {
            visibleCountRef.current = LOAD_BATCH_SIZE;
            setVisibleCount(LOAD_BATCH_SIZE);
            addToast('這條記錄當前未顯示在聊天界面中', 'info');
            await reloadMessages(LOAD_BATCH_SIZE);
            return;
        }

        const nextRange = createChatHistoryWindow(
            browseableMessages.length,
            targetIndex,
            HISTORY_WINDOW_RADIUS,
        );
        setMessages(allMsgs);
        setTotalMsgCount(browseableMessages.length);
        historyWindowTotalRef.current = browseableMessages.length;
        historyWindowRangeRef.current = nextRange;
        historyWindowScrollEnabledRef.current = false;
        setHistoryWindowRange(nextRange);
        setWindowedFocusMsgId(messageId);
        setFlashMsgId(messageId);
        // 等窗口節點掛上 DOM 再定位；定位動畫結束後才開放邊緣續載，避免滾動動畫
        // 自己觸發 onScroll，提前改動窗口。
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const el = document.getElementById(`chat-msg-${messageId}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (historyJumpUnlockTimerRef.current) window.clearTimeout(historyJumpUnlockTimerRef.current);
            historyJumpUnlockTimerRef.current = window.setTimeout(() => {
                historyWindowScrollEnabledRef.current = true;
                historyJumpUnlockTimerRef.current = null;
            }, 450);
        }));
        window.setTimeout(() => setFlashMsgId(null), 2200);
    };

    const refreshContentFavoriteIds = useCallback(async () => {
        const items = await listContentFavorites().catch(() => []);
        setContentFavoriteIds(new Set(items.map(item => item.id)));
    }, []);

    useEffect(() => {
        void refreshContentFavoriteIds();
        window.addEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshContentFavoriteIds);
        return () => window.removeEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshContentFavoriteIds);
    }, [refreshContentFavoriteIds]);

    const handleToggleContentFavorite = async (msg: Message) => {
        if (!msg?.id) return;
        const favoriteId = contentFavoriteIdForMessage(msg);
        try {
            if (contentFavoriteIds.has(favoriteId)) {
                await removeContentFavoriteById(favoriteId);
                setContentFavoriteIds(previous => {
                    const next = new Set(previous);
                    next.delete(favoriteId);
                    return next;
                });
                addToast(msg.type === 'image' ? '已取消收藏圖片' : '已取消收藏聊天消息', 'info');
                return;
            }
            await saveMessageContentFavorite(msg, char?.name || '未知角色');
            setContentFavoriteIds(previous => new Set(previous).add(favoriteId));
            addToast(msg.type === 'image' ? '已收藏圖片（僅保存引用）' : '已收藏聊天消息', 'success');
            trackEvent(msg.type === 'image' ? '收藏聊天图片' : '收藏聊天消息');
        } catch (error) {
            console.warn('[Chat] favorite content failed', error);
            addToast('收藏失敗，請稍後重試', 'error');
        }
    };

    // 點圖片本身（非長按菜單）→ 全屏放大預覽，支持下載/重新生成（見 ChatModals 的 'image-zoom'）。
    const handleImageClick = (msg: Message) => {
        setSelectedMessage(msg);
        setModalType('image-zoom');
    };

    const handleDownloadImage = async (msg: Message) => {
        if (!msg.content) { addToast('圖片已丟失，無法保存', 'error'); return; }
        try {
            const blob = (await getBlobForRef(msg.content)) || (await fetchBlobForShare(msg.content).catch(() => null));
            if (!blob) { addToast('圖片已丟失，無法保存', 'error'); return; }
            const result = await shareOrDownloadBlob({ blob, fileName: `chat-image-${msg.id}.png`, shareTitle: `${char?.name || '角色'}的圖片` });
            if (result !== 'cancelled') addToast(result === 'shared' ? '已打開保存面板' : '已保存到本地', 'success');
        } catch (error) {
            console.warn('[Chat] 圖片保存失敗', error);
            addToast('保存失敗，稍後再試', 'error');
        }
    };

    const [regeneratingImageId, setRegeneratingImageId] = useState<number | null>(null);

    // 只對角色自己生成的圖（SEND_PHOTO 落的 metadata.imagePrompt）有意義——用戶自己發的照片沒有
    // 畫面描述可重跑。複用當時存下的 imagePrompt，保證新圖還是同一個場景描述，不會圖文不符。
    const handleRegenerateImage = async (msg: Message) => {
        if (!char) return;
        const description = typeof msg.metadata?.imagePrompt === 'string' ? msg.metadata.imagePrompt : '';
        if (!description) { addToast('這張圖片沒有可重新生成的描述', 'error'); return; }
        const imageGenConfig = apiConfig.imageGenConfig;
        if (!imageGenConfig?.charImageGenEnabled || !imageGenConfig?.baseUrl || !imageGenConfig?.model) {
            addToast('先在設置裡開啟並配置好生圖 API', 'info');
            return;
        }
        setRegeneratingImageId(msg.id);
        try {
            const prompt = buildCharacterImagePrompt(char, description);
            const referenceBlob = await resolveCharacterReferenceImage(char, { description });
            const { dataUrl } = await generateImage(imageGenConfig, prompt, referenceBlob || undefined);
            const nextContent = await migrateDataUrlToRef(dataUrl);
            const oldContent = msg.content;
            await DB.updateMessage(msg.id, nextContent);
            setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, content: nextContent } : m));
            setSelectedMessage(prev => prev && prev.id === msg.id ? { ...prev, content: nextContent } : prev);
            void deleteBlobRefIfUnreferenced(oldContent);
            addToast('圖片已重新生成', 'success');
        } catch (error) {
            console.warn('[Chat] 圖片重新生成失敗', error);
            addToast('生成失敗，稍後再試', 'error');
        } finally {
            setRegeneratingImageId(null);
        }
    };

    const handleOpenFavoriteMessage = (charId: string, messageId: number) => {
        setFavoritesOpen(false);
        if (activeCharIdRef.current === charId) {
            void handleJumpToMessageInChat(messageId);
            return;
        }
        pendingFavoriteJumpRef.current = { charId, messageId };
        setActiveCharacterId(charId);
    };

    useEffect(() => {
        const pending = pendingFavoriteJumpRef.current;
        if (!pending || pending.charId !== activeCharacterId) return;
        pendingFavoriteJumpRef.current = null;
        const timer = window.setTimeout(() => void handleJumpToMessageInChat(pending.messageId), 0);
        return () => window.clearTimeout(timer);
    // handleJumpToMessageInChat intentionally uses the freshly rendered character state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCharacterId]);

    const handleBackToCurrent = async () => {
        setWindowedFocusMsgId(null);
        setHistoryWindowRange(null);
        historyWindowRangeRef.current = null;
        historyWindowTotalRef.current = 0;
        historyWindowLoadingRef.current = false;
        historyPrependAnchorRef.current = null;
        historyWindowScrollEnabledRef.current = false;
        if (historyJumpUnlockTimerRef.current) {
            window.clearTimeout(historyJumpUnlockTimerRef.current);
            historyJumpUnlockTimerRef.current = null;
        }
        setFlashMsgId(null);
        visibleCountRef.current = LOAD_BATCH_SIZE;
        setVisibleCount(LOAD_BATCH_SIZE);
        await reloadMessages(LOAD_BATCH_SIZE);
        requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        });
    };

    const handleFullArchive = async () => {
        if (!apiConfig.apiKey || !char) {
            addToast('請先配置 API Key', 'error');
            return;
        }
        const allMessages = await DB.getMessagesByCharId(char.id, true);
        const msgsByDate: Record<string, Message[]> = {};
        allMessages
        .filter(m => !char.hideBeforeMessageId || m.id >= char.hideBeforeMessageId)
        .forEach(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (!msgsByDate[dateStr]) msgsByDate[dateStr] = [];
            msgsByDate[dateStr].push(m);
        });

        const datesToProcess = Object.keys(msgsByDate).sort();
        if (datesToProcess.length === 0) {
            addToast('聊天記錄為空，無法歸檔', 'info');
            return;
        }

        setIsSummarizing(true);
        setShowPanel('none');
        setArchiveProgress(`準備歸檔 ${datesToProcess.length} 天...`);
        addToast(`開始歸檔 ${datesToProcess.length} 天聊天記錄`, 'info');
        trackEvent('归档聊天记录');

        try {
            let processedCount = 0;
            const newMemories: MemoryFragment[] = [];
            const templateObj = archivePrompts.find(p => p.id === selectedPromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
            const template = templateObj.content;

            for (let idx = 0; idx < datesToProcess.length; idx++) {
                const dateStr = datesToProcess[idx];
                setArchiveProgress(`歸檔中 ${dateStr} (${idx + 1}/${datesToProcess.length})`);
                const dayMsgs = msgsByDate[dateStr];
                const rawLog = dayMsgs
                    .map(m => formatMessageWithTime(m, char.name, chatUserProfile.name, formatTime))
                    .join('\n');

                let prompt = template;
                const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(rawLog);
                if (sarMemoryBoundary) prompt = `${sarMemoryBoundary}\n\n${prompt}`;
                prompt = prompt.replace(/\$\{dateStr\}/g, dateStr);
                prompt = prompt.replace(/\$\{char\.name\}/g, char.name);
                prompt = prompt.replace(/\$\{userProfile\.name\}/g, chatUserProfile.name);
                prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

                const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [{ role: "user", content: prompt }],
                        temperature: 0.5,
                        max_tokens: 8000 
                    })
                });

                if (!response.ok) throw new Error(`API Error on ${dateStr}`);
                const data = await safeResponseJson(response);
                let summary = extractContent(data);
                summary = summary.replace(/^["']|["']$/g, '').trim();

                if (summary) {
                    newMemories.push({ id: `mem-${Date.now()}-${idx}`, date: dateStr, summary: summary, mood: 'archive' });
                    processedCount++;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            const total = datesToProcess.length;

            if (processedCount === 0) {
                addToast(`歸檔失敗：${total} 天均未生成摘要（請檢查 API/模型）`, 'error');
                setModalType('none');
            } else {
                const finalMemories = [...(char.memories || []), ...newMemories];

                // 關鍵修復：全量歸檔成功後把 hideBeforeMessageId 推到"倒數第 reserve 條"的位置。
                // 不推的話下次再點歸檔，hideBefore 過濾沒作用，之前已歸檔的幾天會被重總結一遍，
                // 往 char.memories 裡堆重複條目。保留最近 max(100, 15%) 條不隱藏（和 palace
                // auto-archive 的 hot-zone 概念對齊），這樣聊天 UI 不會突然空掉。
                //
                // 部分失敗時不推 hideBefore —— 那幾天的原消息沒寫進 MemoryFragment，推了
                // 就真的讀不到了。用戶下次重試歸檔會把失敗的那幾天補上。
                let newHideBefore = char.hideBeforeMessageId;
                let reservedCount = 0;
                let hiddenCount = 0;
                if (processedCount === total) {
                    const allArchivedMsgs: Message[] = [];
                    for (const d of datesToProcess) allArchivedMsgs.push(...msgsByDate[d]);
                    allArchivedMsgs.sort((a, b) => a.id - b.id);
                    const RESERVE = Math.max(100, Math.ceil(allArchivedMsgs.length * 0.15));
                    if (allArchivedMsgs.length > RESERVE) {
                        const candidate = allArchivedMsgs[allArchivedMsgs.length - RESERVE].id;
                        // 只前進不後退
                        if (!char.hideBeforeMessageId || candidate > char.hideBeforeMessageId) {
                            newHideBefore = candidate;
                            reservedCount = RESERVE;
                            hiddenCount = allArchivedMsgs.length - RESERVE;
                        }
                    }
                }

                const updates: Partial<typeof char> = { memories: finalMemories };
                if (newHideBefore !== char.hideBeforeMessageId) {
                    (updates as any).hideBeforeMessageId = newHideBefore;
                }
                updateCharacter(char.id, updates as any);

                const hideStr = hiddenCount > 0
                    ? `（已隱藏 ${hiddenCount} 條舊消息，保留最近 ${reservedCount} 條可見）`
                    : '';
                if (processedCount < total) {
                    addToast(`歸檔完成：${processedCount}/${total} 天成功（部分失敗，下次再點會補上）`, 'info');
                } else {
                    addToast(`歸檔完成：成功歸檔 ${processedCount} 天${hideStr}`, 'success');
                }
                setModalType('none');
            }

        } catch (e: any) {
            addToast(`歸檔中斷: ${e.message}`, 'error');
        } finally {
            setIsSummarizing(false);
            setArchiveProgress('');
        }
    };

    // --- Message Management ---
    const handleDeleteMessage = async () => {
        if (!selectedMessage) return;
        const deletedId = selectedMessage.id;
        await DB.deleteMessage(deletedId);
        discardVoiceForMessages([deletedId]);
        // 滿血主動消息：雲端 fire_pack 裡帶最近對話原文，刪了消息不打髒的話，角色到點
        // 還會提起這條已經不存在的消息（快照的消息在 flush 時從 DB 重讀，這裡只管打髒）。
        markAmsgStateDirty({ char, userProfile: chatUserProfile, groups, realtimeConfig });
        setMessages(prev => prev.filter(m => m.id !== deletedId));
        setTotalMsgCount(prev => Math.max(0, prev - 1));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已刪除', 'success');
        trackEvent('删除一条消息');
    };

    const confirmEditMessage = async () => {
        if (!selectedMessage) return;
        const contentChanged = editContent !== selectedMessage.content;
        await DB.updateMessage(selectedMessage.id, editContent);
        // 內容變了舊語音就作廢，否則語音條仍會播放編輯前的音頻。
        if (contentChanged) discardVoiceForMessages([selectedMessage.id]);
        // 同 handleDeleteMessage：正文改了要讓雲端 fire_pack 跟上。
        if (contentChanged) markAmsgStateDirty({ char, userProfile: chatUserProfile, groups, realtimeConfig });
        setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, content: editContent } : m));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已修改', 'success');
        trackEvent('编辑一条消息');
    };

    const handleQuickReply = useCallback((message: Message) => {
        setReplyTarget({
            ...message,
            metadata: { ...message.metadata, senderName: message.role === 'user' ? '我' : char.name }
        });
        trackEvent('引用回复一条消息');
    }, [char.name]);

    const handleReplyMessage = () => {
        if (!selectedMessage) return;
        handleQuickReply(selectedMessage);
        setModalType('none');
    };

    const handleCopyMessage = () => {
        if (!selectedMessage) return;
        navigator.clipboard.writeText(selectedMessage.content);
        setModalType('none');
        setSelectedMessage(null);
        addToast('已複製到剪貼板', 'success');
        trackEvent('复制一条消息');
    };

    const handleDeleteEmoji = async () => {
        if (!selectedEmoji) return;
        const emojisToDelete = Array.isArray(selectedEmoji) ? selectedEmoji : [selectedEmoji];
        try {
            await Promise.all(emojisToDelete.map(emoji => DB.deleteEmoji(emoji.name)));
            addToast(Array.isArray(selectedEmoji) ? `已刪除 ${selectedEmoji.length} 個表情包` : '表情包已刪除', 'success');
        } catch (err) {
            console.error('Failed to delete emojis:', err);
            addToast('刪除表情包失敗', 'error');
        } finally {
            await loadEmojiData();
            // 放 finally：Promise.all 部分失敗時也已經刪掉了幾個，雲端那份照樣過期了。
            markEmojiLibraryChanged();
            setModalType('none');
            setSelectedEmoji(null);
        }
    };

    const handleRenameEmoji = async () => {
        if (!selectedEmoji || Array.isArray(selectedEmoji)) return;
        const newName = newEmojiName.trim();
        if (!newName) { addToast('表情包名稱不能為空', 'error'); return; }
        if (newName === selectedEmoji.name) { setModalType('none'); setSelectedEmoji(null); return; }
        try {
            await DB.renameEmoji(selectedEmoji.name, newName);
            addToast('表情包名稱已修改', 'success');
            await loadEmojiData();
            markEmojiLibraryChanged();
            setModalType('none');
            setSelectedEmoji(null);
            setNewEmojiName('');
        } catch (err: any) {
            console.error('Failed to rename emoji:', err);
            addToast(err?.message || '修改名稱失敗', 'error');
        }
    };

    // --- Batch Selection ---
    const handleEnterSelectionMode = () => {
        if (selectedMessage) {
            setSelectedMsgIds(new Set([selectedMessage.id]));
            setSelectionMode(true);
            setModalType('none');
            setSelectedMessage(null);
        }
    };

    const toggleMessageSelection = useCallback((id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleThinkingSelection = useCallback((id: number) => {
        setSelectedThinkingMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // Memoized callbacks for MessageItem to avoid busting React.memo
    const handleMessageLongPress = useCallback((msg: Message) => {
        setSelectedMessage(msg);
        setModalType('message-options');
    }, []);

    const handleBatchDelete = async () => {
        const msgIdsToDelete = new Set<number>(selectedMsgIds);
        // 思維鏈單獨勾選、但宿主消息沒選 -> 只清 metadata.thinkingChain，保留消息
        const thinkingIdsToClear = new Set<number>();
        selectedThinkingMsgIds.forEach(id => {
            if (!msgIdsToDelete.has(id)) thinkingIdsToClear.add(id);
        });
        if (msgIdsToDelete.size === 0 && thinkingIdsToClear.size === 0) return;

        // 刪消息時，如果它身上的思維鏈沒被勾選，就嘗試遷移到同一輪裡下一條 assistant 消息上，
        // 讓"只想刪第一條輸出，但想留思維鏈"成立
        const sorted = [...messages].sort((a, b) => a.id - b.id);
        const idxById = new Map<number, number>();
        sorted.forEach((m, i) => idxById.set(m.id, i));
        const migrations: { targetId: number; chain: string }[] = [];
        msgIdsToDelete.forEach(id => {
            const msg = messages.find(x => x.id === id);
            const chain = msg?.metadata?.thinkingChain;
            if (!msg || !chain) return;
            if (selectedThinkingMsgIds.has(id)) return; // 用戶主動連思維鏈一起刪
            const startIdx = idxById.get(id);
            if (startIdx == null) return;
            for (let i = startIdx + 1; i < sorted.length; i++) {
                const next = sorted[i];
                if (next.role !== 'assistant') break; // 出了這一輪，沒法掛靠了
                if (msgIdsToDelete.has(next.id)) continue;
                migrations.push({ targetId: next.id, chain: String(chain) });
                break;
            }
        });

        for (const mig of migrations) {
            await DB.updateMessageMetadata(mig.targetId, (prev) => ({ ...(prev || {}), thinkingChain: mig.chain }));
        }
        for (const id of thinkingIdsToClear) {
            await DB.updateMessageMetadata(id, (prev) => {
                if (!prev || !('thinkingChain' in prev)) return prev;
                const { thinkingChain, ...rest } = prev;
                return rest;
            });
        }
        const ids = Array.from(msgIdsToDelete);
        if (ids.length > 0) {
            await DB.deleteMessages(ids);
            discardVoiceForMessages(ids);
        }

        const migMap = new Map(migrations.map(m => [m.targetId, m.chain]));
        setMessages(prev => prev
            .filter(m => !msgIdsToDelete.has(m.id))
            .map(m => {
                if (migMap.has(m.id)) {
                    return { ...m, metadata: { ...(m.metadata || {}), thinkingChain: migMap.get(m.id) } };
                }
                if (thinkingIdsToClear.has(m.id) && m.metadata?.thinkingChain) {
                    const { thinkingChain, ...rest } = m.metadata;
                    return { ...m, metadata: rest };
                }
                return m;
            })
        );
        setTotalMsgCount(prev => Math.max(0, prev - msgIdsToDelete.size));

        const parts: string[] = [];
        if (msgIdsToDelete.size > 0) parts.push(`已刪除 ${msgIdsToDelete.size} 條消息`);
        if (thinkingIdsToClear.size > 0) parts.push(`已清除 ${thinkingIdsToClear.size} 條思維鏈`);
        addToast(parts.join('，'), 'success');

        setSelectionMode(false);
        setSelectedMsgIds(new Set());
        setSelectedThinkingMsgIds(new Set());
    };

    // --- Forward Chat Records ---
    const [showForwardModal, setShowForwardModal] = useState(false);
    const [forwardGroupId, setForwardGroupId] = useState(GROUP_FILTER_ALL); // 轉發彈窗的角色分組篩選

    const handleForwardSelected = () => {
        if (selectedMsgIds.size === 0) return;
        setShowForwardModal(true);
    };

    const handleForwardToCharacter = async (targetCharId: string) => {
        if (!char) return;
        const selectedMsgs = messages
            .filter(m => selectedMsgIds.has(m.id))
            .sort((a, b) => a.id - b.id);

        if (selectedMsgs.length === 0) return;

        // Build preview text (first few messages)
        const previewLines = selectedMsgs.slice(0, 4).map(m => {
            const sender = m.role === 'user' ? chatUserProfile.name : char.name;
            const text = m.type === 'text' ? m.content.slice(0, 30) : `[${m.type === 'image' ? '圖片' : m.type === 'emoji' ? '表情' : m.type}]`;
            return `${sender}: ${text}`;
        });
        if (selectedMsgs.length > 4) previewLines.push(`... 共 ${selectedMsgs.length} 條消息`);

        const forwardData = {
            fromUserName: chatUserProfile.name,
            fromCharName: char.name,
            count: selectedMsgs.length,
            preview: previewLines,
            messages: selectedMsgs.map(m => ({
                role: m.role,
                type: m.type,
                content: m.content,
                timestamp: m.timestamp || Date.now()
            }))
        };

        // Save forward card to target character's chat
        await DB.saveMessage({
            charId: targetCharId,
            role: 'user',
            type: 'chat_forward' as MessageType,
            content: JSON.stringify(forwardData),
        });

        // Also save a copy in the current chat so the user can see what they forwarded
        const targetChar = characters.find(c => c.id === targetCharId);
        if (char.id !== targetCharId) {
            await DB.saveMessage({
                charId: char.id,
                role: 'system',
                type: 'text' as MessageType,
                content: `[轉發了 ${selectedMsgs.length} 條聊天記錄給 ${targetChar?.name || ''}]`,
            });
            // Refresh messages to show the forwarding system message
            reloadMessages(visibleCountRef.current);
        }

        addToast(`已轉發 ${selectedMsgs.length} 條記錄給 ${targetChar?.name || ''}`, 'success');
        setShowForwardModal(false);
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
    };

    const handleOpenCollaborationFile = useCallback(async (msg: Message) => {
        const assetId = String(msg.metadata?.collaborationAssetId || '');
        const fileName = String(msg.metadata?.fileName || '協同文件');
        if (!assetId) {
            addToast('這條文件消息缺少原始文件引用', 'error');
            return;
        }
        const isInstallable = msg.metadata?.collaborationAttachmentKind === 'installable'
            || String(msg.metadata?.mimeType || '').includes('vnd.sullyos.installable');
        if (isInstallable) {
            setCollaborationPreviewAssetId(assetId);
            setCollaborationOpen(true);
            return;
        }
        try {
            const blob = await CollaborationStore.getAsset(assetId);
            if (!blob) {
                addToast('原始文件已不存在，無法打開', 'error');
                return;
            }
            const result = await shareOrDownloadBlob({
                blob,
                fileName,
                shareTitle: `${char?.name || '角色'}發來的文件`,
                preferDownloadOnWeb: true,
            });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? '已打開系統保存/分享' : '文件已開始下載', 'success');
        } catch (error: any) {
            addToast(error?.message || '文件打開失敗', 'error');
        }
    }, [addToast, char?.name]);

    const handleCollaborationPreviewHandled = useCallback(() => {
        setCollaborationPreviewAssetId(null);
    }, []);

    // 協同工作是獨立 sidecar：只有用戶點「發送給 ChatApp」時才通過這個窄橋寫入主消息表。
    // 其它協同會話、提示詞、API 與文件都留在獨立數據庫，不進入主聊天 pipeline。
    const handleCollaborationTransfer = useCallback(async (
        sessionTitle: string,
        transferredMessages: CollaborationTransferMessage[],
    ) => {
        if (!char || transferredMessages.length === 0) return;
        const preview = transferredMessages.slice(0, 4).map(message => {
            const sender = message.role === 'user' ? chatUserProfile.name : char.name;
            return `${sender}: ${message.content.replace(/\s+/g, ' ').slice(0, 36)}`;
        });
        if (transferredMessages.length > 4) preview.push(`… 共 ${transferredMessages.length} 條消息`);
        const forwardData = {
            fromUserName: chatUserProfile.name,
            fromCharName: `${char.name} · 協同工作`,
            count: transferredMessages.length,
            preview,
            messages: transferredMessages,
            collaborationTitle: sessionTitle,
        };
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'chat_forward' as MessageType,
            content: JSON.stringify(forwardData),
            metadata: {
                source: 'collaboration_transfer',
                collaborationTitle: sessionTitle,
            },
        });
        markAmsgStateDirty({ char, userProfile: chatUserProfile, groups, realtimeConfig });
        await reloadMessages(visibleCountRef.current);
    }, [char, chatUserProfile, groups, realtimeConfig, reloadMessages]);

    const handleCollaborationNotify = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
        addToast(message, type);
    }, [addToast]);

    const handleCollaborationArchiveToMemory = useCallback(async (
        summary: string,
        occurredAt: number,
        sourceId: string,
    ): Promise<string> => {
        if (!char) throw new Error('當前角色不存在');
        const occurred = new Date(occurredAt);
        const date = `${occurred.getFullYear()}-${String(occurred.getMonth() + 1).padStart(2, '0')}-${String(occurred.getDate()).padStart(2, '0')}`;
        const fragmentId = `collab_archive_${sourceId}`;

        if (char.memoryPalaceEnabled) {
            const embedding = memoryPalaceConfig.embedding;
            const lightLLM = memoryPalaceConfig.lightLLM;
            if (!embedding?.baseUrl || !embedding?.apiKey || !embedding?.model || !lightLLM?.baseUrl || !lightLLM?.model) {
                throw new Error('角色已開啟記憶宮殿，但宮殿的向量 API 或副 LLM 還沒有配置完整');
            }
            const { importExternalMemoryText, mergePalaceFragmentsIntoMemories } = await import('../utils/memoryPalace/pipeline');
            const imported = await importExternalMemoryText(
                summary,
                char.id,
                char.name,
                embedding,
                lightLLM,
                chatUserProfile.name,
            );
            if (imported.error && imported.error !== 'no_memories') {
                throw new Error(`記憶宮殿沒有存好：${imported.error}`);
            }
            if (imported.stored === 0 && imported.skipped === 0) {
                throw new Error('記憶宮殿沒有提取出可保存的經歷');
            }
            const palaceFragment: { id: string; date: string; summary: string; mood: string } = {
                id: fragmentId,
                date,
                summary: `- ${summary}`,
                mood: 'palace',
            };
            await updateCharacter(char.id, current => ({
                memories: (current.memories || []).some(memory => memory.id === fragmentId)
                    ? current.memories
                    : mergePalaceFragmentsIntoMemories(current.memories || [], [palaceFragment]),
            }));
            return `已把這次協作的一條總結同時存入 ${char.name} 的記憶宮殿和神經鏈接`;
        }

        const archiveFragment: MemoryFragment = {
            id: fragmentId,
            date,
            summary,
            mood: 'collaboration',
        };
        await updateCharacter(char.id, current => ({
            memories: (current.memories || []).some(memory => memory.id === fragmentId)
                ? current.memories
                : [...(current.memories || []), archiveFragment],
        }));
        return `已把這次協作的一條總結存入 ${char.name} 的神經鏈接`;
    }, [char, memoryPalaceConfig.embedding, memoryPalaceConfig.lightLLM, updateCharacter, chatUserProfile.name]);

    const handleCollaborationInstall = useCallback(async (
        artifact: CollaborationInstallableArtifact,
        targetCharacterId?: string,
    ): Promise<string> => {
        const errors = validateInstallableArtifact(artifact);
        if (errors.length > 0) throw new Error(errors[0]);

        if (artifact.kind === 'bubble-theme') {
            const nextTheme = installableToChatTheme(artifact);
            await addCustomTheme(nextTheme);
            if (targetCharacterId) await updateCharacter(targetCharacterId, { bubbleStyle: nextTheme.id });
            const target = characters.find(item => item.id === targetCharacterId);
            return target ? `氣泡主題已保存，並給 ${target.name} 穿上` : '氣泡主題已保存到氣泡工坊';
        }

        if (artifact.kind === 'whitebox-css') {
            const css = String(artifact.payload.css || '');
            const stored = await DB.getAssetRaw('chrome_css_presets').catch(() => null);
            const presets = Array.isArray(stored) ? stored.filter(item => item && typeof item === 'object') : [];
            const nextPreset = { name: artifact.title.slice(0, 50), code: css, swatch: '#e2e8f0' };
            await DB.saveAssetRaw('chrome_css_presets', [nextPreset, ...presets.filter((item: any) => item.name !== nextPreset.name)].slice(0, 60));
            if (targetCharacterId) await updateCharacter(targetCharacterId, { chromeCustomCss: css });
            const target = characters.find(item => item.id === targetCharacterId);
            return target ? `白框已存入預設，並應用給 ${target.name}` : '白框已保存到預設';
        }

        if (artifact.kind === 'journal-css') {
            await updateTheme({ journalAppearance: { preset: 'original', customCss: String(artifact.payload.css || '') } });
            return '交換日記美化已保存並啟用';
        }

        if (artifact.kind === 'schedule-css') {
            await updateTheme({
                scheduleCardAppearance: {
                    ...(osTheme.scheduleCardAppearance || {}),
                    customCss: String(artifact.payload.css || ''),
                },
            });
            return '日程卡美化已保存並啟用';
        }

        if (artifact.kind === 'psyche-css') {
            if (!targetCharacterId) throw new Error('請選擇使用心象卡美化的角色');
            await updateCharacter(targetCharacterId, { thinkingChainCustomCss: String(artifact.payload.css || '') });
            const target = characters.find(item => item.id === targetCharacterId);
            return `心象卡美化已應用給 ${target?.name || '所選角色'}`;
        }

        if (artifact.kind === 'appearance-preset') {
            const patch = installableToThemePatch(artifact);
            const presetTheme = { ...osTheme, ...patch };
            await saveAppearancePreset(artifact.title.slice(0, 50), presetTheme);
            await updateTheme(patch);
            return '整套界面已存入外觀預設並啟用';
        }

        if (artifact.kind === 'character-card') {
            const created = await addCharacter();
            await updateCharacter(created.id, installableToCharacterPatch(artifact));
            return `角色「${String(artifact.payload.name || artifact.title)}」已創建`;
        }

        const books = installableToWorldbooks(artifact);
        for (const book of books) await addWorldbook(book);
        if (targetCharacterId) {
            await updateCharacter(targetCharacterId, current => ({
                mountedWorldbooks: upsertMountedWorldbooks(current.mountedWorldbooks || [], books),
            }));
        }
        const target = characters.find(item => item.id === targetCharacterId);
        return target
            ? `世界書「${String(artifact.payload.category || artifact.title)}」的 ${books.length} 條內容已保存並掛載給 ${target.name}`
            : `世界書已保存到世界書庫，共 ${books.length} 條`;
    }, [addCharacter, addCustomTheme, addWorldbook, characters, osTheme, saveAppearancePreset, updateCharacter, updateTheme]);

    // hideBeforeMessageId 不在視覺層過濾：用戶依舊能往上翻到舊消息，只是 LLM 拉不到。
    // 真正想從聊天記錄裡抹掉，應該走"刪除"。
    // 舊消息定位模式仍然維護一個有限 DOM 窗口，但窗口會隨著上下滾動持續擴展。
    const chatDisplayMessages = useMemo(
        () => messages.filter(message => isVisibleChatMessage(message, !!char?.hideSystemLogs)),
        [messages, char?.id, char?.hideSystemLogs],
    );

    useEffect(() => {
        if (windowedFocusMsgId !== null) historyWindowTotalRef.current = chatDisplayMessages.length;
    }, [chatDisplayMessages.length, windowedFocusMsgId]);

    const displayMessages = useMemo(() => {
        if (windowedFocusMsgId !== null) {
            if (historyWindowRange) {
                return chatDisplayMessages.slice(
                    Math.max(0, historyWindowRange.start),
                    Math.min(chatDisplayMessages.length, historyWindowRange.end),
                );
            }
            const idx = chatDisplayMessages.findIndex(m => m.id === windowedFocusMsgId);
            if (idx >= 0) {
                return chatDisplayMessages.slice(
                    Math.max(0, idx - HISTORY_WINDOW_RADIUS),
                    Math.min(chatDisplayMessages.length, idx + HISTORY_WINDOW_RADIUS + 1),
                );
            }
        }
        return chatDisplayMessages.slice(-visibleCount);
    }, [chatDisplayMessages, visibleCount, windowedFocusMsgId, historyWindowRange]);

    // 預覽整組交接前，不把同一批逐條落庫的正式氣泡再畫一遍。
    // 僅處理本輪已匹配的 ID；舊回覆、未預覽的卡片和二次回覆仍正常顯示。
    const renderedMessages = useMemo(() => {
        if (selectionMode || (!streamingBubbles.length && !streamingThinking)) return displayMessages;
        const pending = new Set(streamingHandoverIds);
        return displayMessages.filter(message => !pending.has(message.id));
    }, [displayMessages, streamingBubbles, streamingThinking, streamingHandoverIds, selectionMode]);

    const collapsedCount = Math.max(0, totalMsgCount - displayMessages.length);
    const hasOlderHistoryWindow = windowedFocusMsgId !== null && !!historyWindowRange && historyWindowRange.start > 0;
    const hasNewerHistoryWindow = windowedFocusMsgId !== null && !!historyWindowRange && historyWindowRange.end < chatDisplayMessages.length;

    // ── 新消息進入動畫 ──────────────────────────────────────────────
    // 只讓「剛追加的最新消息」（自己發的 / AI 回的）整條淡入一次。
    // 進聊天首幀、切角色、翻歷史（老消息 id 更小）都不播，避免滿屏一起閃。
    const animSeenMaxIdRef = useRef<number | null>(null);
    const [animatingIds, setAnimatingIds] = useState<Set<number>>(() => new Set());
    // 切角色 / 首次進入：清基線，下一輪 detect 只記錄不播
    useEffect(() => {
        animSeenMaxIdRef.current = null;
        streamPreviewHandoverIdsRef.current.clear();
        setAnimatingIds(new Set());
    }, [activeCharacterId]);
    // 檢測新增：id 超過基線的才淡入；首幀只記基線不播
    useEffect(() => {
        if (displayMessages.length === 0) return;
        let maxId = -Infinity;
        for (const m of displayMessages) if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
        if (animSeenMaxIdRef.current === null) { animSeenMaxIdRef.current = maxId; return; }
        const baseline = animSeenMaxIdRef.current;
        const fresh = displayMessages
            .filter(m => typeof m.id === 'number' && m.id > baseline && !streamPreviewHandoverIdsRef.current.has(m.id))
            .map(m => m.id);
        if (fresh.length > 0) {
            setAnimatingIds(prev => { const next = new Set(prev); fresh.forEach(id => next.add(id)); return next; });
            animSeenMaxIdRef.current = maxId;
        }
    }, [displayMessages]);

    // 穩定的思維鏈配置對象：只在角色/樣式變化時重建，避免每次渲染新建對象擊穿 MessageItem.memo。
    const thinkingChainOptions = useMemo(() => ({
        styleId: (char as any)?.thinkingChainStyle || 'echo',
        customColors: (char as any)?.thinkingChainCustomColors,
        onOpenSettings: () => setShowThinkingChainModal(true),
    }), [(char as any)?.thinkingChainStyle, (char as any)?.thinkingChainCustomColors]);

    // 工具痕跡那行灰字要貼著氣泡走，所以把氣泡自帶的組間距（MessageItem 裡那組
    // mb-3 / mb-6 / mb-8）抵掉大半。組內的氣泡本來就挨著，不用抵。
    const toolTracePullClass = osTheme.chatMessageSpacing === 'compact' ? '-mt-2'
        : osTheme.chatMessageSpacing === 'spacious' ? '-mt-6' : '-mt-5';

    // Reset active category if it becomes invisible for the current character
    useEffect(() => {
        if (activeCategory !== 'default' && visibleCategories.length > 0 && !visibleCategories.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    }, [visibleCategories, activeCategory]);

    // Suggestions span all visible categories; the picker still uses its selected tab.
    const filteredEmojis = useMemo(() => aiVisibleEmojis.filter(e => {
        if (activeCategory === 'default') return !e.categoryId || e.categoryId === 'default';
        return e.categoryId === activeCategory;
    }), [aiVisibleEmojis, activeCategory]);

    // Memoize ChatInputArea callbacks
    const handleSendCallback = useCallback(() => handleSendText(), [char, input, replyTarget, inputPreferences]);
    const handleCharSelectCallback = useCallback((id: string) => { setActiveCharacterId(id); setShowPanel('none'); }, []);
    const autoReply = useChatAutoReply({
        // 開了「延遲自動回覆」的角色改走那一套（幾分鐘內自己回），不再疊加全域的 2 秒自動回覆
        enabled: inputPreferences.autoReply && !char?.delayedReply?.enabled,
        conversationId: activeCharacterId || null,
        active: activeApp === AppID.Chat && !!char,
        blocked: isInputFocused || !!input.trim() || showPanel !== 'none' || modalType !== 'none'
            || selectionMode || isSummarizing || collaborationOpen || memoryRepairOpen || favoritesOpen
            || showProactiveModal || showActiveMsg2Modal || showThinkingChainModal
            || mcdAppOpen || luckinAppOpen || showForwardModal || mallOpen,
        generating: isTyping || instantChatPending || isProactiveComposing,
        onGenerate: handleManualTrigger,
    });
    // 角色自定義聊天背景：字段值可能是 blobref 令牌（二進制在 IndexedDB），這裡解析成能直接
    // 喂進 CSS url() 的地址；data: / http(s) 之類的非令牌值渲染期原樣透傳。
    // hook 必須在下面的空態早退之前調用，所以用可選鏈讀 char。
    const resolvedChatBackground = useBlobRefUrl(char?.chatBackground ?? osTheme.chatBackground);
    // 兜底：正常情況下 OSContext 啟動時一定會保底一個角色，char 不該為空。
    // 但若 init 期間某個 store 讀取失敗（數據其實還在 IndexedDB 裡），characters 可能暫時為空，
    // 此時下面讀 char 上的字段會直接拋 "undefined is not an object" 把整個 App 崩到錯誤頁。
    // 這裡給個溫和空態，避免硬崩，也好讓用戶能退回桌面/重啟恢復。
    if (!char) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[#f1f5f9] text-center px-8 gap-3">
                <ChatDecorationAnnouncement surface="chat"/>
                <div className="text-4xl">💤</div>
                <div className="text-slate-600 text-sm font-medium">暫時沒有可用的角色</div>
                <div className="text-slate-400 text-xs leading-relaxed">數據可能未加載完成。請退回桌面後重新進入；若仍為空，重啟應用即可恢復。</div>
                <button onClick={closeApp} className="mt-2 px-4 py-2 rounded-full bg-slate-800 text-white text-xs">返回桌面</button>
            </div>
        );
    }

    // 動森彩蛋模式（受「聊天聯動」開關控制：關掉則聊天保持原樣式）
    const acnh = osTheme.skin === 'animalcrossing' && osTheme.acnhChatSync !== false;
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const chatRootClass =
        chatChromeStyle === 'pixel'
            ? 'flex flex-col h-full bg-[#efe1cf] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
            : chatChromeStyle === 'flat'
              ? 'flex flex-col h-full bg-white overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
              : chatChromeStyle === 'floating'
                ? 'flex flex-col h-full bg-[#eef2ff] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
                : 'flex flex-col h-full bg-[#f1f5f9] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500';
    // 令牌還在讀盤、或者圖已經丟了時 resolvedChatBackground 是 undefined，這一幀按「沒設背景」
    // 的樣式走，免得渲染出一個 url("undefined")。
    const chatRootStyle: React.CSSProperties = resolvedChatBackground
        ? {
            backgroundImage: `url("${resolvedChatBackground}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
        }
        : chatBackgroundStyle === 'grid'
          ? {
              backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
              backgroundImage:
                  'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }
          : chatBackgroundStyle === 'paper'
            ? {
                backgroundColor: chatChromeStyle === 'pixel' ? '#f4e8d9' : '#f9f7f2',
                backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
                backgroundSize: '16px 16px',
              }
            : chatBackgroundStyle === 'mesh'
              ? {
                  backgroundColor: '#f8fafc',
                  backgroundImage:
                      'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                }
              : {
                  backgroundImage: 'none',
                };
    // 動森彩蛋：淺奶油米黃中心（上下綠條由 header/輸入欄負責），配色參考 Pocket Camp。
    const acnhRootClass = 'flex flex-col h-full overflow-hidden relative font-sans transition-[background-color] duration-500';
    const acnhRootStyle: React.CSSProperties = {
        backgroundColor: '#F6F0D8',
        backgroundImage: 'none',
    };
    const finalRootClass = acnh ? acnhRootClass : chatRootClass;
    // 動森下強制覆蓋角色自定義聊天背景，保證整機一致的彩蛋觀感
    // 進入/切換的過場由 CharacterEntryTransition 覆蓋層負責，根容器不再自己做淡入。
    const finalRootStyle = acnh ? acnhRootStyle : chatRootStyle;
    // 聊天細節微調（外觀 → 聊天細節，全局打底；角色開了「聊天裝扮」時逐字段覆蓋）：
    // CSS 全默認時為空串不注入；chatModuleAlign 不走 CSS，作為佈局屬性傳給 MessageItem。
    const mergedFineTune = useMemo(() => mergeChatFineTune(osTheme, char?.chatFineTune), [osTheme, char?.chatFineTune]);
    const chatFineTuneCss = useMemo(() => buildChatFineTuneCss(mergedFineTune), [mergedFineTune]);
    const chatAvatarSizeClass = osTheme.chatAvatarSize === 'small' ? 'w-7 h-7' : osTheme.chatAvatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const chatAvatarRadiusClass = osTheme.chatAvatarShape === 'square' ? 'rounded-sm' : osTheme.chatAvatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const chatPendingAvatarClass = `${chatAvatarSizeClass} ${chatAvatarRadiusClass} object-cover`;

    return (
        <div
            className={`sully-chat-root ${finalRootClass}`}
            style={finalRootStyle}
        >
             <ChatDecorationAnnouncement surface="chat"/>
             {/* 聊天細節微調（外觀 App 可視化設置生成）：排在用戶自定義 CSS 之前——
                 同為 !important 時後寫的勝，手寫美化代碼永遠可覆蓋可視化設置。 */}
             {chatFineTuneCss && <style>{chatFineTuneCss}</style>}
             {char.chatAppearance?.chatEmojiSize && char.chatFineTune?.enabled !== false && <style>{`.sully-chat-root { --sully-emoji-size: ${{small:96,medium:128,large:160}[osTheme.chatEmojiSize || 'small']}px; }`}</style>}
             {/* 白框自定義 CSS：全局默認在前、角色專屬在後（後者疊加覆蓋）。作用於 .sully-chat-* 各零件。
                 守護樣式統一放在氣泡主題 customCss 之後（見下），保證對所有用戶 CSS 都能兜底。 */}
             {osTheme.chatChromeCustomCss && <style>{osTheme.chatChromeCustomCss}</style>}
             {char.chromeCustomCss && <style>{char.chromeCustomCss}</style>}
             {scheduleChangeNotice && (
               <ScheduleChangeNotice
                 key={scheduleChangeNotice.eventId}
                 detail={scheduleChangeNotice}
                 onDone={dismissScheduleChangeNotice}
               />
             )}
             {/* 角色「登場」過場：切換/進入時以 ta 的頭像氛圍鋪底登場，再推進穿過進入聊天。key 切換即重放。 */}
             {showEntry && char && (
               <CharacterEntryTransition
                 key={activeCharacterId}
                 name={char.name}
                 avatar={char.avatar}
                 onDone={() => setShowEntry(false)}
               />
             )}

             {activeTheme.customCss && <style>{activeTheme.customCss}</style>}
             {/* 氣泡工坊的尾巴頻率依賴直接掛在氣泡上的穩定類。用戶 CSS 即使給
                 ::before/::after 寫了 !important，中間氣泡仍會按“僅組末/隱藏”設置收起尾巴。 */}
             <style>{`
               .sully-bubble-tail-hidden::before,
               .sully-bubble-tail-hidden::after { content: none !important; display: none !important; }
             `}</style>

             {/* 心象卡片自定義 CSS（per-character）：作用於 .sully-psyche-* 各零件，編輯入口在心象設置彈窗 */}
             {(char as any).thinkingChainCustomCss && <style>{(char as any).thinkingChainCustomCss}</style>}

             {/* 守護樣式（注在所有用戶 CSS —— 白框全局/角色、氣泡主題 customCss、心象卡片 CSS —— 之後）：
                 保證返回鍵和輸入欄永遠可見可點。壞 CSS（常隨備份/分享導入）把它們隱藏/變透明/
                 pointer-events:none 時，用戶會遇到「點輸入框沒反應、鍵盤喚不起來」或退不出聊天，
                 且重啟、重新導入備份都無解。有了兜底，至少能退出去「外觀→聊天界面→還原白框」清掉壞 CSS。
                 不鎖位置與配色，正常美化不受影響。 */}
             {(osTheme.chatChromeCustomCss || char.chromeCustomCss || activeTheme.customCss || (char as any).thinkingChainCustomCss) && (
               <style>{`
                 .sully-chat-back{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                 .sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                 .sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important;}
               `}</style>
             )}

             {/* 動森彩蛋：作用域 CSS 覆蓋氣泡——奶油 AI 氣泡 + 蜜桃用戶氣泡，暖棕文字，繞開 MessageItem 複雜邏輯 */}
             {acnh && <style>{`
                .sully-bubble-ai {
                    background: #FBF4DE !important;
                    color: #6b5a3e !important;
                    border: 1.5px solid #efe6c8 !important;
                    border-radius: 24px !important;
                    box-shadow: 0 4px 10px -5px rgba(120,95,45,0.28) !important;
                }
                .sully-bubble-user {
                    background: #F5C896 !important;
                    color: #6b4a2f !important;
                    border: 1.5px solid #eeb87f !important;
                    border-radius: 24px !important;
                    box-shadow: 0 4px 10px -5px rgba(150,100,55,0.32) !important;
                }
                /* 僅動森：聊天正文放大一點 */
                .sully-bubble-ai .text-\\[15px\\], .sully-bubble-user .text-\\[15px\\] {
                    font-size: 16.5px !important;
                    line-height: 1.7 !important;
                }
             `}</style>}

             {/* 記憶整理中 — 頂部浮動膠囊（不阻塞交互，輕量無 backdrop-filter） */}
             {memoryPalaceStatus && (
                 <div
                     className="absolute top-[76px] left-1/2 z-[150] animate-fade-in"
                     style={{
                         transform: 'translateX(-50%)',
                         pointerEvents: 'none',
                         willChange: 'transform, opacity',
                     }}
                 >
                     <div
                         className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[18rem]"
                         style={{
                             background: 'rgba(255,255,255,0.88)',
                             borderRadius: 999,
                             border: '1px solid rgba(99,102,241,0.18)',
                             boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                         }}
                     >
                         <span
                             className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                             style={{ borderTopColor: '#6366f1', animationDuration: '0.9s' }}
                         />
                         <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                             {char?.name || '角色'}正在沉思
                         </span>
                         <span className="text-[10px] text-slate-400 truncate">{memoryPalaceStatus}</span>
                     </div>
                 </div>
             )}


             {/* 記憶整理結果 — 彈窗（高級感） */}
             {memoryPalaceResult && (
                 <div
                     className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                     style={{
                         pointerEvents: 'all',
                         background: 'rgba(15,23,42,0.55)',
                     }}
                     onClick={() => setMemoryPalaceResult(null)}
                 >
                     <div
                         className="w-full max-w-sm max-h-[82vh] overflow-hidden flex flex-col relative"
                         style={{
                             background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 100%)',
                             borderRadius: 28,
                             border: '1px solid rgba(148,163,184,0.18)',
                             boxShadow: '0 20px 50px -20px rgba(15,23,42,0.35)',
                         }}
                         onClick={(e) => e.stopPropagation()}
                     >
                         <div
                             className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
                             style={{ background: 'linear-gradient(90deg, transparent, #6366f1, #a5b4fc, #6366f1, transparent)' }}
                         />
                         <div className="px-6 pt-7 pb-4 text-center">
                             <div
                                 className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                 style={{
                                     background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(129,140,248,0.06))',
                                     border: '1px solid rgba(99,102,241,0.15)',
                                 }}
                             >
                                 <span style={{ fontSize: 26 }}>🗂️</span>
                             </div>
                             <div className="text-[10px] tracking-[0.25em] uppercase font-semibold" style={{ color: '#6366f1' }}>Memory Palace</div>
                             <p className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>記憶整理完成</p>
                             <p className="text-[11px] text-slate-400 mt-1">
                                 新增 {memoryPalaceResult.stored} 條 · 去重跳過 {memoryPalaceResult.skipped} 條
                                 {memoryPalaceResult.batches.length > 1 && ` · ${memoryPalaceResult.batches.length} 批`}
                             </p>
                             {memoryPalaceResult.batches.some(b => !b.ok) && (
                                 <p className="text-[10px] text-red-500 mt-1">
                                     {memoryPalaceResult.batches.filter(b => !b.ok).map(b => `batch ${b.index} 失敗`).join(', ')}
                                 </p>
                             )}
                         </div>
                         <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-2 no-scrollbar">
                             {memoryPalaceResult.memories.map((m, i) => {
                                 const roomMeta: Record<string, { label: string; color: string }> = {
                                     living_room: { label: '客廳', color: '#f59e0b' },
                                     bedroom: { label: '臥室', color: '#8b5cf6' },
                                     study: { label: '書房', color: '#0ea5e9' },
                                     user_room: { label: '用戶房間', color: '#ec4899' },
                                     self_room: { label: '自我房間', color: '#10b981' },
                                     attic: { label: '閣樓', color: '#6366f1' },
                                     windowsill: { label: '窗台', color: '#14b8a6' },
                                 };
                                 const meta = roomMeta[m.room] || { label: m.room, color: '#64748b' };
                                 const roomLabel = getRoomLabel(m.room as any, chatUserProfile?.name) || meta.label;
                                 return (
                                     <div
                                         key={i}
                                         className="p-3 rounded-2xl"
                                         style={{
                                             background: 'rgba(255,255,255,0.75)',
                                             border: `1px solid ${meta.color}22`,
                                             boxShadow: `0 2px 8px ${meta.color}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                         }}
                                     >
                                         <div className="flex items-center gap-2 mb-1.5">
                                             <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                                                 style={{ background: `${meta.color}18`, color: meta.color }}
                                             >
                                                 {roomLabel}
                                             </span>
                                             <span className="text-[10px] text-slate-400">{m.mood}</span>
                                             <span className="text-[10px] font-bold ml-auto" style={{ color: '#f59e0b' }}>{'★'.repeat(Math.min(m.importance, 5))}</span>
                                         </div>
                                         <p className="text-[12px] text-slate-700 leading-relaxed">{m.content}</p>
                                         {m.tags.length > 0 && (
                                             <div className="flex gap-1 mt-2 flex-wrap">
                                                 {m.tags.map((t, j) => (
                                                     <span key={j} className="text-[9px] px-1.5 py-0.5 rounded-full"
                                                         style={{ background: 'rgba(148,163,184,0.15)', color: '#64748b' }}
                                                     >{t}</span>
                                                 ))}
                                             </div>
                                         )}
                                     </div>
                                 );
                             })}
                             {memoryPalaceResult.memories.length === 0 && (
                                 <p className="text-center text-xs text-slate-400 py-4">本次未提取到新記憶</p>
                             )}
                         </div>
                         <div className="px-6 pb-6 pt-2">
                             <button
                                 onClick={() => setMemoryPalaceResult(null)}
                                 className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                 style={{
                                     background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                     boxShadow: '0 6px 18px -6px rgba(79,70,229,0.5)',
                                 }}
                             >
                                 確認
                             </button>
                         </div>
                     </div>
                 </div>
             )}

             {showHistoryCleanup && <ChatHistoryCleanupModal key={char.id} character={char} onClose={() => setShowHistoryCleanup(false)} onDeleted={handleHistoryCleanupDone} />}
             {emojiExport && <EmojiExportDialog {...emojiExport} onClose={() => setEmojiExport(null)} />}
            <ChatModals
                modalType={modalType} setModalType={setModalType}
                transferAmt={transferAmt} setTransferAmt={setTransferAmt}
                transferNote={transferNote} setTransferNote={setTransferNote}
                emojiImportText={emojiImportText} setEmojiImportText={setEmojiImportText}
                settingsContextLimit={settingsContextLimit} setSettingsContextLimit={setSettingsContextLimit}
                settingsContextRangeMode={settingsContextRangeMode} setSettingsContextRangeMode={setSettingsContextRangeMode}
                settingsHideSysLogs={settingsHideSysLogs} setSettingsHideSysLogs={setSettingsHideSysLogs}
                settingsInputPreferences={settingsInputPreferences} setSettingsInputPreferences={setSettingsInputPreferences}
                contextSuiteAnyEnabled={contextSuiteAnyEnabled}
                contextSuiteAllEnabled={contextSuiteAllEnabled}
                onToggleContextSuite={handleToggleContextSuite}
                editContent={editContent} setEditContent={setEditContent}
                archivePrompts={archivePrompts} selectedPromptId={selectedPromptId} setSelectedPromptId={(id: string) => {
                    setSelectedPromptId(id);
                    // 同步寫 localStorage，讓 palace extraction 的風格追加能讀到最新選擇
                    try { localStorage.setItem('chat_active_archive_prompt_id', id); } catch {}
                }}
                editingPrompt={editingPrompt} setEditingPrompt={setEditingPrompt} isSummarizing={isSummarizing} archiveProgress={archiveProgress}
                selectedMessage={selectedMessage} selectedEmoji={selectedEmoji} activeCharacter={char} messages={messages}
                allHistoryMessages={allHistoryMessages}
                contextRangeSnapshot={historyContextRange}
                
                newCategoryName={newCategoryName} setNewCategoryName={setNewCategoryName} onAddCategory={handleAddCategory}
                newEmojiName={newEmojiName} setNewEmojiName={setNewEmojiName} onRenameEmoji={handleRenameEmoji}
                selectedCategory={selectedCategory}

                onTransfer={handleSendTransfer}
                onImportEmoji={handleImportEmoji}
                onSaveSettings={saveSettings}
                chatUser={{ name: chatUserProfile.name, avatar: chatUserProfile.avatar }}
                onOpenHistoryCleanup={() => { setModalType('none'); setShowHistoryCleanup(true); }} onArchive={handleFullArchive}
                onCreatePrompt={createNewPrompt} onEditPrompt={editSelectedPrompt} onSavePrompt={handleSavePrompt} onDeletePrompt={handleDeletePrompt}
                onSetHistoryStart={handleSetHistoryStart} onRestoreAdaptiveContext={restoreAdaptiveContext} onJumpToMessageInChat={handleJumpToMessageInChat} onEnterSelectionMode={handleEnterSelectionMode}
                onReplyMessage={handleReplyMessage} onEditMessageStart={() => { if (selectedMessage) { setEditContent(selectedMessage.content); setModalType('edit-message'); } }}
                onConfirmEditMessage={confirmEditMessage} onDeleteMessage={handleDeleteMessage} onCopyMessage={handleCopyMessage}
                messageFavorited={!!(selectedMessage && contentFavoriteIds.has(contentFavoriteIdForMessage(selectedMessage)))}
                onToggleMessageFavorite={selectedMessage ? () => handleToggleContentFavorite(selectedMessage) : undefined}
                onDownloadImage={handleDownloadImage}
                onRegenerateImage={handleRegenerateImage}
                regeneratingImageId={regeneratingImageId}
                onDeleteEmoji={handleDeleteEmoji} onDeleteCategory={handleDeleteCategory} onRenameCategory={handleRenameCategory} onDownloadCategory={handleDownloadCategory}
                allCharacters={characters} onSaveCategoryVisibility={handleSaveCategoryVisibility}
                translationEnabled={translationEnabled}
                onToggleTranslation={() => { const next = !translationEnabled; setTranslationEnabled(next); localStorage.setItem(`chat_translate_enabled_${activeCharacterId}`, JSON.stringify(next)); if (next) { trackEvent('开启聊天翻译', { targetLang: isTranslationLangPreset(translateTargetLang) ? translateTargetLang : 'custom' }); } if (!next) { setShowingTargetIds(new Set()); } }}
                translateSourceLang={translateSourceLang}
                translateTargetLang={translateTargetLang}
                translationExpanded={translationExpanded}
                onToggleTranslationExpanded={() => {
                    const next = !translationExpanded;
                    setTranslationExpanded(next);
                    localStorage.setItem(`chat_translate_expanded_${activeCharacterId}`, JSON.stringify(next));
                    setShowingTargetIds(new Set());
                    trackEvent('切换翻译展开模式', { enabled: next ? 'on' : 'off' });
                }}
                onSetTranslateSourceLang={(lang: string) => { const next = normalizeTranslationLangLabel(lang); if (!next) return; setTranslateSourceLang(next); localStorage.setItem(`chat_translate_source_lang_${activeCharacterId}`, next); setShowingTargetIds(new Set()); }}
                onSetTranslateLang={(lang: string) => { const next = normalizeTranslationLangLabel(lang); if (!next) return; setTranslateTargetLang(next); localStorage.setItem(`chat_translate_lang_${activeCharacterId}`, next); setShowingTargetIds(new Set()); }}
                xhsEnabled={!!char.xhsEnabled}
                onToggleXhs={() => updateCharacter(char.id, { xhsEnabled: !char.xhsEnabled })}
                htmlModeEnabled={!!(char as any).htmlModeEnabled}
                onToggleHtmlMode={() => updateCharacter(char.id, { htmlModeEnabled: !((char as any).htmlModeEnabled) } as any)}
                htmlModeCustomPrompt={settingsHtmlModeCustomPrompt}
                setHtmlModeCustomPrompt={setSettingsHtmlModeCustomPrompt}
                chatVoiceEnabled={!!char.chatVoiceEnabled}
                onToggleChatVoice={() => updateCharacter(char.id, { chatVoiceEnabled: !char.chatVoiceEnabled })}
                chatVoiceAutoPlay={!!char.chatVoiceAutoPlay}
                onToggleChatVoiceAutoPlay={() => updateCharacter(char.id, { chatVoiceAutoPlay: !char.chatVoiceAutoPlay })}
                chatVoiceLang={char.chatVoiceLang || ''}
                onSetChatVoiceLang={(lang: string) => {
                    updateCharacter(char.id, { chatVoiceLang: lang });
                    trackEvent('设置聊天语音语种', { 语种: voiceLanguageAnalyticsValue(lang) });
                }}
                voiceAvailable={characterHasVoice(char, apiConfig)}
                onGenerateVoice={selectedMessage ? () => handleManualTts(selectedMessage) : undefined}
                voiceDownloadable={!!(selectedMessage?.id && voiceDataMap[selectedMessage.id])}
                voiceCollectable={!!(selectedMessage?.id && (voiceDataMap[selectedMessage.id] || parseVoiceOutput(selectedMessage.content || '').hasVoiceTag))}
                onDownloadVoice={selectedMessage ? () => handleDownloadVoice(selectedMessage) : undefined}
                voiceFavorited={!!(selectedMessage?.id && chatFavoriteKeys.has(chatFavoriteSourceKey(selectedMessage)))}
                onToggleVoiceFavorite={selectedMessage ? () => handleToggleVoiceFavorite(selectedMessage) : undefined}
                scheduleData={scheduleData}
                isScheduleGenerating={isScheduleGenerating}
                onScheduleEdit={handleScheduleEdit}
                onScheduleDelete={handleScheduleDelete}
                onScheduleReroll={() => generateDailySchedule(char, true)}
                onScheduleCoverChange={handleScheduleCoverChange}
                onScheduleStyleChange={handleScheduleStyleChange}
                onPlayTheater={handlePlayTheater}
                isScheduleFeatureEnabled={isScheduleFeatureOn(char)}
                onToggleScheduleFeature={handleToggleScheduleFeature}
                isMemoryPalaceEnabled={!!char.memoryPalaceEnabled}
                isVectorizing={isVectorizing}
                vectorizePendingCount={vectorizePendingCount}
                vectorizeProgress={vectorizeProgress}
                retainRecentForVectorize={retainRecentForVectorize}
                setRetainRecentForVectorize={setRetainRecentForVectorize}
                vectorizeResult={vectorizeResult}
                onForceVectorize={handleForceVectorize}
                apiPresets={apiPresets}
                onAddApiPreset={addApiPreset}
                onSaveEmotion={(config) => {
                    // API 同步到所有角色，enabled 僅寫到當前角色
                    syncEmotionApiToAllCharacters(config.api);
                    updateCharacter(char.id, {
                        emotionConfig: {
                            enabled: config.enabled,
                            ...(config.api && config.api.baseUrl ? { api: config.api } : {}),
                        },
                    });
                }}
                onClearBuffs={() => {
                    updateCharacter(char.id, { activeBuffs: [], buffInjection: '' });
                    addToast('情緒狀態已清除', 'info');
                }}
                onSaveChatApi={(chatApi) => {
                    updateCharacter(char.id, { chatApi });
                    addToast('對話模型設置已保存', 'success');
                }}
                onSaveInnerVoices={(innerVoices) => updateCharacter(char.id, { innerVoices })}
                onGenerateInnerVoice={(entry) => generateInnerVoiceContent(char, chatUserProfile, resolveCharacterMeterApi(char, apiConfig), entry)
                    .then(content => content === null ? null : { content })}
                onSaveAffinities={(affinities) => updateCharacter(char.id, { affinities })}
                onGenerateAffinity={(entry) => generateAffinityValue(char, chatUserProfile, resolveCharacterMeterApi(char, apiConfig), entry)
                    .then(result => result === null ? null : { value: result.value, statusNote: result.note })}
             />

             {/* 小劇場播放器：窺視某個日程時段的角色行為演出 */}
             {theaterSlotIdx !== null && scheduleData && createPortal(
                <TheaterPlayer
                    character={char}
                    slot={scheduleData.slots[theaterSlotIdx] || null}
                    lines={scheduleData.slots[theaterSlotIdx]?.theater?.lines || null}
                    isGenerating={isTheaterGenerating}
                    onReplay={() => runTheater(theaterSlotIdx, true)}
                    onSendCard={(exposed) => handleSendTheaterCard(theaterSlotIdx, exposed)}
                    onClose={() => setTheaterSlotIdx(null)}
                />,
                document.body,
             )}

             <ChatHeader
                selectionMode={selectionMode}
                selectedCount={selectedMsgIds.size + Array.from(selectedThinkingMsgIds).filter(id => !selectedMsgIds.has(id)).length}
                onCancelSelection={() => { setSelectionMode(false); setSelectedMsgIds(new Set()); setSelectedThinkingMsgIds(new Set()); }}
                activeCharacter={char}
                isTyping={isTyping}
                isSummarizing={isSummarizing}
                isEmotionEvaluating={emotionStatus === 'evaluating'}
                isMemoryPalaceProcessing={!!memoryPalaceStatus}
                memoryPalaceStatusText={memoryPalaceStatus}
                lastTokenUsage={lastTokenUsage}
                tokenBreakdown={tokenBreakdown}
                onClose={handleChatClose}
                onTriggerAI={handleManualTrigger}
                hideTrigger={inputPreferences.sendButtonGenerates}
                onShowCharsPanel={() => setShowPanel('chars')}
                onDeleteBuff={(buffId) => {
                    const currentBuffs = char.activeBuffs || [];
                    const newBuffs = currentBuffs.filter(b => b.id !== buffId);
                    const newInjection = '';
                    updateCharacter(char.id, { activeBuffs: newBuffs, buffInjection: newInjection });
                    addToast('已刪除該情緒狀態', 'info');
                }}
                headerStyle={osTheme.chatHeaderStyle}
                avatarShape={osTheme.chatAvatarShape}
                headerAlign={osTheme.chatHeaderAlign}
                headerDensity={osTheme.chatHeaderDensity}
                statusStyle={osTheme.chatStatusStyle}
                chromeStyle={osTheme.chatChromeStyle}
                hideBuffs={osTheme.chatHideHeaderBuffs}
                acnh={acnh}
             />

            {/* 認知消化結果彈窗 — 全屏玻璃擬態 */}
            {lastDigestResult && (() => {
                const r = lastDigestResult;
                const groups: Array<{
                    key: string;
                    label: string;
                    icon: string;
                    accent: string;       // base hue for chip/dot
                    items: Array<{ content: string; sub?: string }>;
                }> = [];
                if (r.resolved.length) groups.push({ key: 'resolved', label: '困惑化解', icon: '🕊️', accent: '#10b981', items: r.resolved.map(e => ({ content: e.content })) });
                if (r.deepened.length) groups.push({ key: 'deepened', label: '創傷加深', icon: '💢', accent: '#f43f5e', items: r.deepened.map(e => ({ content: e.content })) });
                if (r.internalized.length) groups.push({ key: 'internalized', label: '知識內化', icon: '🪞', accent: '#8b5cf6', items: r.internalized.map(e => ({ content: e.content })) });
                if (r.selfInsights.length) groups.push({ key: 'insights', label: '自我領悟', icon: '💡', accent: '#f59e0b', items: r.selfInsights.map(t => ({ content: t })) });
                if (r.selfConfused.length) groups.push({ key: 'confused', label: '新的自我困惑', icon: '🌀', accent: '#6366f1', items: r.selfConfused.map(e => ({ content: e.content })) });
                if (r.synthesizedUser.length) groups.push({ key: 'synth', label: '用戶認知整合', icon: '👤', accent: '#0ea5e9', items: r.synthesizedUser.map(e => ({ content: e.content, sub: e.category })) });
                if (r.worries?.length) groups.push({ key: 'worries', label: '回看引發的擔憂', icon: '😟', accent: '#f97316', items: r.worries.map(e => ({ content: e.content })) });
                if (r.aspirations?.length) groups.push({ key: 'aspirations', label: '新的期盼', icon: '🌟', accent: '#eab308', items: r.aspirations.map(e => ({ content: e.content })) });
                if (r.distilled?.length) groups.push({ key: 'distilled', label: '沉澱到門牌', icon: '🚪', accent: '#a855f7', items: r.distilled.map(e => ({ content: e.content })) });
                if (r.fulfilled.length) groups.push({ key: 'fulfilled', label: '期盼實現', icon: '✨', accent: '#22c55e', items: r.fulfilled.map(e => ({ content: e.content })) });
                if (r.disappointed.length) groups.push({ key: 'disappointed', label: '期盼落空', icon: '🍂', accent: '#94a3b8', items: r.disappointed.map(e => ({ content: e.content })) });
                if (r.faded.length) groups.push({ key: 'faded', label: '淡忘', icon: '🌫️', accent: '#cbd5e1', items: r.faded.map(e => ({ content: e.content })) });
                if (groups.length === 0) return null;
                return (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                        style={{
                            background: 'radial-gradient(ellipse at top, rgba(16,185,129,0.18), rgba(0,0,0,0.55))',
                            backdropFilter: 'blur(10px)',
                            WebkitBackdropFilter: 'blur(10px)',
                        }}
                        onClick={() => setLastDigestResult(null)}
                    >
                        <div
                            className="w-full max-w-sm max-h-[85vh] overflow-hidden flex flex-col relative"
                            style={{
                                background: 'linear-gradient(160deg, rgba(255,255,255,0.98) 0%, rgba(240,253,250,0.96) 100%)',
                                borderRadius: 28,
                                border: '1px solid rgba(255,255,255,0.7)',
                                boxShadow: '0 30px 80px -20px rgba(16,185,129,0.35), 0 10px 40px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* 頂部光暈條 */}
                            <div
                                className="absolute top-0 left-0 right-0 h-1 pointer-events-none"
                                style={{ background: 'linear-gradient(90deg, transparent, #10b981, #6ee7b7, #10b981, transparent)' }}
                            />
                            {/* 頭部 */}
                            <div className="px-6 pt-7 pb-4 text-center">
                                <div
                                    className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(52,211,153,0.08))',
                                        boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.9), 0 4px 16px rgba(16,185,129,0.2)',
                                    }}
                                >
                                    <span style={{ fontSize: 28 }}>🧠</span>
                                </div>
                                <div className="text-[11px] tracking-[0.2em] uppercase font-semibold" style={{ color: '#059669' }}>Cognitive Digest</div>
                                <div className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>{char.name} 完成了一次認知消化</div>
                                <div className="text-[11px] text-slate-400 mt-1">內心整理 · {groups.reduce((s, g) => s + g.items.length, 0)} 項變化</div>
                            </div>

                            {/* 內容列表 */}
                            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-3 no-scrollbar">
                                {groups.map(g => (
                                    <div key={g.key}
                                        className="rounded-2xl overflow-hidden"
                                        style={{
                                            background: 'rgba(255,255,255,0.7)',
                                            border: `1px solid ${g.accent}22`,
                                            boxShadow: `0 2px 8px ${g.accent}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                        }}
                                    >
                                        <div className="px-4 py-2.5 flex items-center gap-2"
                                            style={{ background: `linear-gradient(90deg, ${g.accent}18, transparent)` }}
                                        >
                                            <span style={{ fontSize: 14 }}>{g.icon}</span>
                                            <span className="text-[12px] font-bold" style={{ color: g.accent }}>{g.label}</span>
                                            <span className="text-[10px] font-bold ml-auto px-1.5 py-0.5 rounded-full"
                                                style={{ background: `${g.accent}22`, color: g.accent }}
                                            >{g.items.length}</span>
                                        </div>
                                        <div className="px-4 py-2 space-y-1.5">
                                            {g.items.slice(0, 3).map((it, i) => (
                                                <div key={i} className="text-[12px] leading-relaxed text-slate-700 flex gap-2">
                                                    <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: g.accent }} />
                                                    <span className="flex-1">
                                                        {it.sub && <span className="text-[10px] font-semibold mr-1.5 px-1.5 py-0.5 rounded" style={{ background: `${g.accent}18`, color: g.accent }}>{it.sub}</span>}
                                                        <span>{it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content}</span>
                                                    </span>
                                                </div>
                                            ))}
                                            {g.items.length > 3 && (
                                                <div className="text-[10px] text-slate-400 pl-3">還有 {g.items.length - 3} 條…</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* 確認按鈕 */}
                            <div className="px-6 pb-6 pt-2">
                                <button
                                    onClick={() => setLastDigestResult(null)}
                                    className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                    style={{
                                        background: 'linear-gradient(135deg, #10b981, #059669)',
                                        boxShadow: '0 8px 24px -4px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
                                    }}
                                >
                                    放入心裡
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            <div ref={scrollRef} onScroll={handleChatScroll} onClick={() => { if (inputPreferences.autoReply) setShowPanel('none'); }} className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar" style={{ backgroundImage: activeTheme.type === 'custom' && activeTheme.user.backgroundImage ? 'none' : undefined }}>
                {windowedFocusMsgId !== null && (
                    <div className="sticky top-0 z-20 flex justify-center pb-2 pointer-events-none">
                        <button onClick={handleBackToCurrent} className="pointer-events-auto px-4 py-2 bg-primary text-white rounded-full text-xs font-bold shadow-lg active:scale-95 transition-transform flex items-center gap-1.5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" /></svg>
                            回到當前聊天
                        </button>
                    </div>
                )}
                {collapsedCount > 0 && windowedFocusMsgId === null && (
                    <div className="flex justify-center mb-6">
                        <button onClick={async () => {
                            const nextVisibleCount = visibleCount + LOAD_BATCH_SIZE;
                            visibleCountRef.current = nextVisibleCount;
                            setVisibleCount(nextVisibleCount);
                            await reloadMessages(nextVisibleCount);
                        }} className="px-4 py-2 bg-white/50 backdrop-blur-sm rounded-full text-xs text-slate-500 shadow-sm border border-white hover:bg-white transition-colors">加載歷史消息 ({collapsedCount})</button>
                    </div>
                )}
                {windowedFocusMsgId !== null && (
                    <div className="flex justify-center mb-4 px-4">
                        {hasOlderHistoryWindow ? (
                            <button
                                onClick={() => extendHistoryWindow('older')}
                                className="px-3 py-1.5 bg-white/60 backdrop-blur-sm rounded-full text-[11px] text-slate-500 shadow-sm border border-white hover:bg-white transition-colors"
                            >
                                向上滑繼續看更早消息
                            </button>
                        ) : (
                            <span className="text-[11px] text-slate-400">已到最早一條消息</span>
                        )}
                    </div>
                )}

                {renderedMessages.map((m, i) => {
                    const prevMessage = i > 0 ? renderedMessages[i - 1] : null;
                    const nextMessage = i < renderedMessages.length - 1 ? renderedMessages[i + 1] : null;
                    const messageGroupGapMs = 30 * 60 * 1000;
                    const breaksWithPrevious =
                        !prevMessage ||
                        prevMessage.role !== m.role ||
                        Math.abs(m.timestamp - prevMessage.timestamp) > messageGroupGapMs;
                    const breaksWithNext =
                        !nextMessage ||
                        nextMessage.role !== m.role ||
                        Math.abs(nextMessage.timestamp - m.timestamp) > messageGroupGapMs;
                    const suppressEntranceAnimation = streamPreviewHandoverIdsRef.current.has(m.id);
                    // 這一輪在雲端跑過哪些工具（即時對話才有，worker 掛在最後一條推送上）。
                    // 一條推送拆出的每條氣泡都繼承了同一份（metadata 是整份往下鋪的，見
                    // activeMsgRuntime 的 mcdInheritMeta），所以只在這條推送的最後一條底下畫，
                    // 不然一句回覆底下能排出三行一模一樣的字。
                    // 多選狀態下不畫：跟旁邊那兩塊浮層一樣，讓位給選擇框。
                    const toolTraceText = selectionMode
                        ? '' : formatAmsgToolTrace((m.metadata as any)?.amsgToolTrace);
                    const pushMessageId = (m.metadata as any)?.activeMsg2?.messageId;
                    const showToolTrace = !!toolTraceText
                        && !(pushMessageId && (nextMessage?.metadata as any)?.activeMsg2?.messageId === pushMessageId);
                    return (
                        <div
                            key={m.id || i}
                            id={`chat-msg-${m.id}`}
                            className={[
                                flashMsgId === m.id ? 'ring-2 ring-yellow-300 bg-yellow-50/40 rounded-2xl mx-2' : '',
                                animatingIds.has(m.id) && !suppressEntranceAnimation ? 'animate-fade-in' : '',
                                'transition-all duration-300',
                            ].filter(Boolean).join(' ')}
                            onAnimationEnd={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (animatingIds.has(m.id)) setAnimatingIds(prev => { const next = new Set(prev); next.delete(m.id); return next; });
                            }}
                        >
                        <MessageItem
                            msg={m}
                            isFirstInGroup={breaksWithPrevious}
                            isLastInGroup={breaksWithNext}
                            activeTheme={activeTheme}
                            charAvatar={char.avatar}
                            charName={char.name}
                            userAvatar={chatUserProfile.avatar}
                            isLatestMessage={!nextMessage}
                            onMediaLoad={handleMessageMediaLoad}
                            onImageClick={handleImageClick}
                            moduleAlign={mergedFineTune.chatModuleAlign || 'center'}
                            onLongPress={handleMessageLongPress}
                            onReply={handleQuickReply}
                            selectionMode={selectionMode}
                            isSelected={selectedMsgIds.has(m.id)}
                            onToggleSelect={toggleMessageSelection}
                            isThinkingSelected={selectedThinkingMsgIds.has(m.id)}
                            onToggleThinkingSelect={toggleThinkingSelection}
                            translationEnabled={translationEnabled && m.type === 'text' && m.role === 'assistant'}
                            translationExpanded={translationExpanded}
                            isShowingTarget={showingTargetIds.has(m.id)}
                            onTranslateToggle={handleTranslateToggle}
                            voiceData={voiceDataMap[m.id]}
                            voiceLoading={voiceLoading.has(m.id)}
                            isVoicePlaying={playingMsgId === m.id}
                            onPlayVoice={onPlayVoiceStable}
                            avatarShape={osTheme.chatAvatarShape}
                            avatarSize={osTheme.chatAvatarSize}
                            avatarMode={osTheme.chatAvatarMode}
                            bubbleVariant={osTheme.chatBubbleStyle}
                            messageSpacing={osTheme.chatMessageSpacing}
                            showTimestamp={osTheme.chatShowTimestamp}
                            suppressEntranceAnimation={suppressEntranceAnimation}
                            onMcdSendCart={handleMcdSendCart}
                            onMcdCandidate={handleMcdCandidate}
                            onResolveTransfer={handleResolveTransfer}
                            onResolveLifeRecord={handleResolveLifeRecord}
                            onOpenCollaborationFile={handleOpenCollaborationFile}
                            thinkingChainOptions={thinkingChainOptions}
                        />
                        {showToolTrace && (
                            <div className={`px-3 mb-4 ${breaksWithNext ? toolTracePullClass : ''}`}>
                                <div className="ml-12 text-[10px] leading-relaxed text-slate-400">
                                    調用了工具：{toolTraceText}
                                </div>
                            </div>
                        )}
                        </div>
                    );
                })}
                {windowedFocusMsgId !== null && (
                    <div className="flex justify-center mt-2 mb-4 px-4">
                        {hasNewerHistoryWindow ? (
                            <button
                                onClick={() => extendHistoryWindow('newer')}
                                className="px-3 py-1.5 bg-white/60 backdrop-blur-sm rounded-full text-[11px] text-slate-500 shadow-sm border border-white hover:bg-white transition-colors"
                            >
                                向下滑繼續看較新消息
                            </button>
                        ) : (
                            <span className="text-[11px] text-slate-400">已到當前最新消息</span>
                        )}
                    </div>
                )}

                {/* 渠道確實發送 reasoning 增量時，先用正式心象卡實時展示；落庫後同幀交給正式消息。 */}
                {streamingThinking && !selectionMode && (
                    <div className="group flex items-end justify-start relative px-3 mb-1.5 animate-fade-in">
                        <div className="relative max-w-[72%] min-w-0 ml-12">
                            <ThinkingChainBlock
                                chain={streamingThinking}
                                styleId={thinkingChainOptions.styleId}
                                customColors={thinkingChainOptions.customColors}
                                onOpenSettings={thinkingChainOptions.onOpenSettings}
                            />
                        </div>
                    </div>
                )}

                {/* 流式預覽直接複用正式 MessageItem：氣泡變體、主題背景圖/裝飾、頭像框、
                    grouped/every_message、消息間距、時間戳、Markdown 與所有自定義 CSS 天然一致。
                    整輪落庫完成後一起交接，已登記接棒 id 的正式消息首幀不再重播 fade-in。 */}
                {streamingBubbles.length > 0 && !selectionMode && (
                    <>
                        {streamingBubbles.map((bubble, i) => (
                            <div key={`stream-preview-${i}`} data-stream-preview={i} className="transition-all duration-300">
                                <MessageItem
                                    msg={{
                                        id: -(i + 1),
                                        charId: char.id,
                                        role: 'assistant',
                                        type: 'text',
                                        content: bubble,
                                        timestamp: Date.now(),
                                    }}
                                    isFirstInGroup={i === 0}
                                    isLastInGroup={i === streamingBubbles.length - 1}
                                    activeTheme={activeTheme}
                                    charAvatar={char.avatar}
                                    charName={char.name}
                                    userAvatar={chatUserProfile.avatar}
                                    onLongPress={() => {}}
                                    onReply={() => {}}
                                    selectionMode={false}
                                    isSelected={false}
                                    onToggleSelect={() => {}}
                                    avatarShape={osTheme.chatAvatarShape}
                                    avatarSize={osTheme.chatAvatarSize}
                                    avatarMode={osTheme.chatAvatarMode}
                                    bubbleVariant={osTheme.chatBubbleStyle}
                                    messageSpacing={osTheme.chatMessageSpacing}
                                    showTimestamp={osTheme.chatShowTimestamp}
                                    thinkingChainOptions={thinkingChainOptions}
                                />
                            </div>
                        ))}
                    </>
                )}
                {/* instantChatPending：這一輪在雲端跑，本機可以關頁面，指示燈靠落盤記錄活著。 */}
                {(isTyping || instantChatPending || recallStatus || searchStatus || diaryStatus || isProactiveComposing) && !selectionMode && (
                    <div className="flex items-end gap-3 px-3 mb-6 animate-fade-in">
                        <TokenImg value={char.avatar} className={chatPendingAvatarClass} />
                        <div className="bg-white px-4 py-3 rounded-2xl shadow-sm">
                            {isProactiveComposing && !isTyping && !recallStatus && !searchStatus && !diaryStatus ? (
                                <div className="flex items-center gap-2 text-xs text-teal-600 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    {char.name} 在給你寫消息…
                                </div>
                            ) : searchStatus ? (
                                <div className="flex items-center gap-2 text-xs text-emerald-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    🔍 {searchStatus}
                                </div>
                            ) : recallStatus ? (
                                <div className="flex items-center gap-2 text-xs text-indigo-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    {recallStatus}
                                </div>
                            ) : diaryStatus ? (
                                <div className="flex items-center gap-2 text-xs text-amber-600 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    📖 {diaryStatus}
                                </div>
                            ) : (
                                <div className="flex gap-1"><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-75"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-150"></div></div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="relative z-40">
                {mcdActivated && (
                    <div className="flex items-center justify-between px-4 py-1.5 bg-yellow-50 border-b border-yellow-200 text-xs">
                        <div className="flex items-center gap-1.5 text-yellow-700 font-bold">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"/>
                            🍔 麥請求進行中
                        </div>
                        <button
                          onClick={() => handleSendText(MCD_DEACTIVATE_TRIGGER, 'text', { mcdDeactivate: true })}
                          className="px-2.5 py-0.5 bg-yellow-200/80 text-yellow-800 rounded-full text-[11px] font-bold active:scale-95"
                        >
                          結束
                        </button>
                    </div>
                )}
                {luckinActivated && (
                    <div className="flex items-center justify-between px-4 py-1.5 bg-[#0B1F3A]/5 border-b border-[#0B1F3A]/15 text-xs">
                        <div className="flex items-center gap-1.5 text-[#0B1F3A] font-bold">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#C6A15B] animate-pulse"/>
                            🦌 瑞一杯進行中
                            {luckinChatRef.current?.cityName && <span className="font-normal text-[#0B1F3A]/60">· {luckinChatRef.current.cityName}</span>}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => setShowLuckinHelp(true)}
                              title="瑞一杯怎麼用"
                              className="w-5 h-5 flex items-center justify-center bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              ?
                            </button>
                            <button
                              onClick={() => setShowLuckinLoc(true)}
                              className="px-2.5 py-0.5 bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              📍 改定位
                            </button>
                            <button
                              onClick={deactivateLuckin}
                              className="px-2.5 py-0.5 bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              結束
                            </button>
                        </div>
                    </div>
                )}
                {replyTarget && (
                    <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                        {/* 引用的是圖片 / 表情時這裡顯示佔位符，跟落庫的快照同一口徑 */}
                        <div className="flex items-center gap-2 truncate"><span className="font-bold text-slate-700">正在回覆:</span><span className="truncate max-w-[200px]">{buildReplySnapshotContent(replyTarget)}</span></div>
                        <button onClick={() => setReplyTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">×</button>
                    </div>
                )}

                {/* 開關寫著「已開啟」、這一輪卻在本地生成時，把原因說給用戶聽 */}
                <InstantChatRouteNotice charId={activeCharacterId} />

                <ChatInputArea
                    input={input} setInput={handleInputChange}
                    isTyping={isTyping} selectionMode={selectionMode}
                    showPanel={showPanel} setShowPanel={setShowPanel}
                    onSend={handleSendCallback}
                    onGenerate={handleManualTrigger}
                    sendButtonGenerates={inputPreferences.sendButtonGenerates}
                    enterToSend={inputPreferences.enterToSend}
                    autoReplyEnabled={inputPreferences.autoReply}
                    autoReplySeconds={autoReply.seconds}
                    onCancelAutoReply={autoReply.cancel}
                    onInputFocusChange={setIsInputFocused}
                    onDeleteSelected={handleBatchDelete}
                    onForwardSelected={handleForwardSelected}
                    selectedCount={selectedMsgIds.size + Array.from(selectedThinkingMsgIds).filter(id => !selectedMsgIds.has(id)).length}
                    emojis={filteredEmojis}
                    emojiSuggestionsEnabled={inputPreferences.emojiSuggestions}
                    suggestionEmojis={aiVisibleEmojis}
                    characters={characters} activeCharacterId={activeCharacterId}
                    onCharSelect={handleCharSelectCallback}
                    unreadMessages={unreadMessages}
                    customThemes={customThemes} onUpdateTheme={(id) => updateCharacter(char.id, { bubbleStyle: id })}
                    onRemoveTheme={removeCustomTheme} activeThemeId={currentThemeId}
                    onPanelAction={handlePanelAction}
                    onImageSelect={handleImageSelect}
                    isSummarizing={isSummarizing}
                    categories={visibleCategories}
                    activeCategory={activeCategory}
                    onReroll={handleReroll}
                    canReroll={canReroll}
                    isProactiveActive={isProactiveActive}
                    mcdConfigured={mcdConfiguredFlag}
                    mcdActivated={mcdActivated}
                    luckinConfigured={luckinConfiguredFlag}
                    luckinActivated={luckinActivated}
                    htmlModeEnabled={!!(char as any).htmlModeEnabled}
                    showThinkingChain={!!(char as any).showThinkingChain}
                    inputStyle={osTheme.chatInputStyle}
                    sendButtonStyle={osTheme.chatSendButtonStyle}
                    chromeStyle={osTheme.chatChromeStyle}
                    acnh={acnh}
                />
            </div>


            {/* Proactive Settings Modal */}
            {char && (
                <ProactiveSettingsModal
                    isOpen={showProactiveModal}
                    onClose={() => setShowProactiveModal(false)}
                    char={char}
                    isProactiveActive={isProactiveActive}
                    apiPresets={apiPresets}
                    onAddApiPreset={addApiPreset}
                    onSave={(config) => {
                        updateCharacter(char.id, { proactiveConfig: config });
                        if (config.enabled) {
                            startProactiveChat(config.intervalMinutes);
                            // 界面只給 7 個檔，但這個值是從持久化狀態讀回來的——導入的備份、
                            // 老版本寫進去的都可能是任意整數。收斂到寫死的檔位，其餘歸 custom。
                            trackEvent('启动主动消息', {
                                intervalMinutes: presetOrCustom(
                                    String(config.intervalMinutes),
                                    ['30', '60', '120', '240', '480', '720', '1440'],
                                    '没设',
                                ),
                            });
                            addToast(`已啟動主動消息，每 ${config.intervalMinutes >= 60 ? formatHours(config.intervalMinutes) + ' 小時' : config.intervalMinutes + ' 分鐘'}發送一次`, 'success');
                        } else {
                            stopProactiveChat();
                            addToast('已關閉主動消息', 'info');
                        }
                    }}
                    onStop={() => {
                        stopProactiveChat();
                        updateCharacter(char.id, { proactiveConfig: { ...char.proactiveConfig!, enabled: false } });
                        addToast('已停止主動消息', 'info');
                    }}
                />
            )}

            {/* 主動消息 2.0（雲端 worker 定時任務）Settings Modal */}
            {char && (
                <ActiveMsg2SettingsModal
                    isOpen={showActiveMsg2Modal}
                    onClose={() => setShowActiveMsg2Modal(false)}
                    char={char}
                    apiConfig={apiConfig}
                    userProfile={chatUserProfile}
                    groups={groups}
                    realtimeConfig={realtimeConfig}
                    apiPresets={apiPresets}
                    onAddApiPreset={addApiPreset}
                    // updater 形態：merge 在 setCharacters 的函數式 updater 裡發生，
                    // 拿到的 prev 是最新排隊後的狀態，不會被面板的渲染時快照蓋掉
                    // （角色在聊天裡用工具排的任務就是這麼丟的）。
                    onSave={(updater) => updateCharacter(char.id, (prev) => ({
                        activeMsg2Config: updater(prev.activeMsg2Config),
                    }))}
                    addToast={addToast}
                />
            )}

            {/* 思考鏈設置 Modal — 入口：聊天加號面板「展示思考」按鈕長按 / 思考鏈卡片右上齒輪 */}
            {char && (
                <ThinkingChainSettingsModal
                    isOpen={showThinkingChainModal}
                    onClose={() => setShowThinkingChainModal(false)}
                    value={{
                        enabled: !!(char as any).showThinkingChain,
                        styleId: ((char as any).thinkingChainStyle as any) || 'echo',
                        customColors: {
                            bg: (char as any).thinkingChainCustomColors?.bg || '#1f2937',
                            accent: (char as any).thinkingChainCustomColors?.accent || '#fbbf24',
                            text: (char as any).thinkingChainCustomColors?.text || '#f1f5f9',
                        },
                        customPrompt: (char as any).thinkingChainCustomPrompt || '',
                        customCss: (char as any).thinkingChainCustomCss || '',
                    }}
                    onChange={(next) => {
                        const patch: any = {};
                        if (next.enabled !== undefined) patch.showThinkingChain = next.enabled;
                        if (next.styleId !== undefined) patch.thinkingChainStyle = next.styleId;
                        if (next.customColors !== undefined) patch.thinkingChainCustomColors = next.customColors;
                        if (next.customPrompt !== undefined) patch.thinkingChainCustomPrompt = next.customPrompt;
                        if (next.customCss !== undefined) patch.thinkingChainCustomCss = next.customCss;
                        if (Object.keys(patch).length) updateCharacter(char.id, patch as any);
                    }}
                />
            )}

            {char && modalType === 'chrome-css' && <ChatDecorationPanel
                key={char.id}
                character={char} theme={baseOsTheme} onSaveBubble={addCustomTheme} themes={[...Object.values(PRESET_THEMES), ...customThemes]}
                initialTab={decorationTab} updateCharacter={patch=>updateCharacter(char.id,patch)}
                updateTheme={updateTheme} onBgUpload={handleBgUpload} backgroundUrl={resolvedChatBackground}
                onOpenWorkshop={()=>{setModalType('none');openApp(AppID.ThemeMaker);}}
                onClose={()=>setModalType('none')}
            />}

            {/* 情緒設置已嵌入日程 Modal（與日程強制同步開/關），不再單獨渲染 */}

            {/* 🍔 麥當勞小程序 - MCP 數據流按鈕驅動, 協同聊天走主 pipeline (完整人設/記憶/日程) */}
            {memoryRepairOpen && char && (
                <MemoryRepairPortal
                    char={char}
                    user={chatUserProfile}
                    apiConfig={apiConfig}
                    embeddingConfig={memoryPalaceConfig.embedding}
                    remoteVectorConfig={remoteVectorConfig}
                    sinceTs={memoryRepairRound.sinceTs}
                    userMessage={memoryRepairRound.userMessage}
                    assistantReply={memoryRepairRound.assistantReply}
                    onClose={() => {
                        setMemoryRepairOpen(false);
                        setShowPanel('none');
                    }}
                />
            )}

            {favoritesOpen && (
                <FavoritesPortal
                    onClose={() => setFavoritesOpen(false)}
                    onJumpToMessage={handleOpenFavoriteMessage}
                />
            )}

            {char && (
                <React.Suspense fallback={collaborationOpen ? <div className="absolute inset-0 z-[120] grid place-items-center bg-slate-50 text-xs text-slate-400">正在打開協同工作…</div> : null}>
                    <CollaborationWindow
                        open={collaborationOpen}
                        character={char}
                        user={chatUserProfile}
                        theme={activeTheme}
                        backgroundUrl={resolvedChatBackground}
                        chatApi={apiConfig}
                        apiPresets={apiPresets}
                        availableModels={availableModels}
                        characters={characters}
                        groups={groups}
                        emojis={emojis}
                        emojiCategories={categories}
                        recentChatMessages={messages}
                        realtimeConfig={realtimeConfig}
                        chatCollaborationEnabled={!!char.chatCollaborationEnabled}
                        requestedPreviewAssetId={collaborationPreviewAssetId}
                        onRequestedPreviewHandled={handleCollaborationPreviewHandled}
                        onClose={() => { setCollaborationOpen(false); setCollaborationPreviewAssetId(null); }}
                        onSendToChat={handleCollaborationTransfer}
                        onInstallArtifact={handleCollaborationInstall}
                        onArchiveToMemory={handleCollaborationArchiveToMemory}
                        onToggleChatCollaboration={enabled => updateCharacter(char.id, { chatCollaborationEnabled: enabled })}
                        notify={handleCollaborationNotify}
                    />
                </React.Suspense>
            )}

            <McdMiniApp
                open={mcdAppOpen}
                onClose={() => setMcdAppOpen(false)}
                char={char}
                userProfile={chatUserProfile}
                messages={messages}
                isTyping={isTyping}
                onSendMessage={handleMcdMiniAppSend}
                onStateChange={handleMcdMiniAppStateChange}
                onConfirmOrder={handleMcdAppConfirm}
            />

            {/* 購物中心 mini-app */}
            <ShoppingMallMiniApp
                open={mallOpen}
                onClose={() => setMallOpen(false)}
                charName={char?.name || ''}
                onSendOrder={handleSendMallOrder}
                addToast={addToast}
                apiConfig={apiConfig}
                apiPresets={apiPresets}
            />

            {/* 🦌 瑞幸小程序 - 與麥當勞同構 */}
            <LuckinMiniApp
                open={luckinAppOpen}
                onClose={() => setLuckinAppOpen(false)}
                char={char}
                userProfile={chatUserProfile}
                messages={messages}
                isTyping={isTyping}
                onSendMessage={handleLuckinMiniAppSend}
                onStateChange={handleLuckinMiniAppStateChange}
                onConfirmOrder={handleLuckinAppConfirm}
            />

            {/* 🦌 瑞一杯定位選擇 */}
            <LuckinLocationModal
                open={showLuckinLoc}
                onClose={() => setShowLuckinLoc(false)}
                onPick={onLuckinLocationPick}
            />

            {/* 🦌 瑞一杯使用說明 (首次自動彈 + banner ? 調出) */}
            <LuckinHelpModal
                open={showLuckinHelp}
                onClose={() => setShowLuckinHelp(false)}
            />


            {/* Forward Modal */}
            <Modal isOpen={showForwardModal} title="轉發聊天記錄" onClose={() => setShowForwardModal(false)}>
                {(() => {
                    const forwardCandidates = characters.filter(c => c.id !== activeCharacterId);
                    const forwardChars = filterCharactersByGroup(forwardCandidates, characterGroups, forwardGroupId);
                    return (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                            <p className="text-xs text-slate-400 mb-3">選擇要轉發給的角色 (已選 {selectedMsgIds.size} 條消息)</p>
                            <CharacterGroupFilterBar characters={forwardCandidates} groups={characterGroups} value={forwardGroupId} onChange={setForwardGroupId} className="mb-2 -mx-1 px-1" />
                            {forwardChars.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => handleForwardToCharacter(c.id)}
                                    className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 active:scale-[0.98] transition-all border border-slate-100"
                                >
                                    <TokenImg value={c.avatar} className="w-10 h-10 rounded-xl object-cover" />
                                    <div className="flex-1 text-left">
                                        <div className="font-bold text-sm text-slate-700">{c.name}</div>
                                        <div className="text-[10px] text-slate-400 truncate">{c.description}</div>
                                    </div>
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                                </button>
                            ))}
                            {forwardChars.length === 0 && (
                                <div className="text-center text-xs text-slate-400 py-8">{forwardCandidates.length === 0 ? '沒有其他角色可以轉發' : '該分組下沒有角色'}</div>
                            )}
                        </div>
                    );
                })()}
            </Modal>
        </div>
    );
};

export default Chat;
