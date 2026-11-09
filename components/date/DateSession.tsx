import React, { useState, useEffect, useRef, useMemo } from 'react';
import { CharacterProfile, Message, DateState, UserProfile } from '../../types';
import Modal from '../../components/os/Modal';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import DateSettings from './DateSettings';
import ChatApiSettingsPanel from '../chat/ChatApiSettingsPanel';
import { useBlobRefUrl } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';
import { clearDateResumeAttempt } from '../../utils/dateSessionRecovery';
import {
    canSynthesizeSpeech,
    cleanTextForTtsProvider,
    stripTtsMarkupForDisplay,
    synthesizeSpeech,
} from '../../utils/ttsRouter';
import { applyDateVoiceTags, parseDateBody } from '../../utils/dateVoiceTags';
import { planNovelLoadMore } from '../../utils/dateSessionHistory';
import { getPendingReplyText } from '../../utils/pendingReply';
import { fetchBlobForShare } from '../../utils/shareExport';
import VoiceFavoriteActionSheet from '../voice/VoiceFavoriteActionSheet';
import { getVoiceFavorite, removeVoiceFavorite, saveVoiceFavorite } from '../../utils/voiceFavorites';
import { MEETING_CONTINUE_DISPLAY_TEXT } from '../../utils/meetingContinue';
import { VOICE_LANGUAGE_OPTIONS, voiceLanguageAnalyticsValue, voiceLanguageLabel, voiceLanguagePromptLabel } from '../../utils/voiceLanguage';
import { trackEvent } from '../../utils/analytics';
import { SARSpeechSwitch } from '../sar/SARSpeechSwitch';
import DecorationFrame from './DecorationFrame';
import { DateLiveReply, DateReplyTags, DateRerollSheet } from './DateReplyTrace';
import EmotionStatusPanel from '../chat/EmotionStatusPanel';
import { liveBuffs } from '../../utils/emotionDecay';
import { describeMomentLock } from '../../utils/dateMoment';
import { buildDateAppearanceCss, resolveDateBackdrop, scopeDateCss } from '../../utils/dateAppearance';
import { applyRegexScripts, REGEX_PLACEMENT } from '../../utils/meetingPreset/regex';
import { cleanDisplayText, splitDisplaySegments, type DisplaySegment } from '../../utils/meetingPreset/display';
import type { MeetingRegexScript } from '../../utils/meetingPreset/types';
import type { EmotionState } from '../../utils/emotionApply';
import { extractObservation, hasObservation, isObserveActive } from '../../utils/dateObserve';
import ObserveHUD from './ObserveHUD';

// 用戶輸入的顯示：去掉方括號標記（跟以前一樣），其餘原樣
const cleanUserTextForDisplay = (text: string) => text.replace(/\[.*?\]/g, '').trim();

const getSARSurface = (message: Message): string | undefined => {
    const value = message.metadata?.sarModuleSurface?.surface;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

interface DateSessionProps {
    char: CharacterProfile;
    userProfile: UserProfile;
    messages: Message[]; // The DB messages for the reading view
    peekStatus: string;  // Initial text from the Peek phase
    initialState?: DateState; // Resume state
    onSendMessage: (text: string, kind?: 'continue') => Promise<string>; // Returns AI content
    /** note：使用者寫的重新生成說明（附說明重 Roll） */
    onReroll: (note?: string) => Promise<string>;
    /** 生成中的那一則（開了串流才有） */
    liveReply?: { text: string; reasoning: string } | null;
    /** 這個角色現在用的自訂預設（沒用就是內建規則） */
    presetName?: string;
    onExit: (currentState: DateState) => void;
    onEditMessage: (msg: Message) => void;
    onDeleteMessage: (msg: Message) => void;
    onDeleteMessages: (ids: number[]) => Promise<void>;
    onSettings: () => void;
    /** 閱讀視圖「加載更早」鋪滿已加載部分後，回庫裡取下一批（limit 遞增式重取）。 */
    onLoadMoreHistory?: (nextLimit: number) => Promise<void>;
    /** 當前查詢用的 limit（配合 onLoadMoreHistory 遞增）。 */
    historyLoadLimit?: number;
    /** 庫裡的見面記錄是否已經取完。 */
    historyReachedEnd?: boolean;
    /** 用自訂預設時，預設的正則：顯示前跑「只改顯示」的那些，HTML 結果放進沙盒 iframe */
    presetRegex?: MeetingRegexScript[];
    /** 有進行中的故事才給：選單多一顆「完結故事」 */
    onFinishStory?: () => void;
    /** 線下情緒獨立時這場故事的情緒（utils/dateEmotion.ts）；沒給就讀角色身上私聊那份 */
    emotion?: EmotionState | null;
    /** 面板裡刪條、改總結、重置寫回故事那份；沒給就寫角色 */
    onEmotionChange?: (patch: Partial<EmotionState>) => void;
    /** 設成 true 就不再自動存檔：故事完結後離開會話，別把舊的角色資料（含存檔、進行中的故事）寫回去 */
    suppressAutoSaveRef?: React.MutableRefObject<boolean>;
    /** 拍下這一刻（utils/dateMoment.ts） */
    onCaptureMoment?: () => void;
    capturingMoment?: boolean;
}

// Long replies can expand into many DOM lines. Keeping a smaller reading window
// materially reduces iOS WebKit content-process crashes while older entries
// remain available through the existing "加載更早" button.
const NOVEL_MESSAGE_WINDOW_SIZE = 40;
/** 鋪滿已加載部分後，每次回庫多取多少條見面消息。 */
const NOVEL_HISTORY_FETCH_STEP = 220;
const NOVEL_MESSAGE_LOAD_STEP = 40;

type DateSpeechResult = { url: string; spokenText: string };
type DateVoiceFavoriteTarget = {
    sourceKey: string;
    originalText: string;
    sourceTimestamp: number;
    voiceTags: string[];
};

/** 語音快取鍵：同一句台詞換了語氣標籤，合成出來的就不是同一段 */
const voiceCacheKey = (text: string, tags: string[]) => `${tags.join(',')}|${text}`;

const ReadingAvatar: React.FC<{ src?: string; name: string; light: boolean }> = ({ src, name, light }) => {
    const [imageFailed, setImageFailed] = useState(false);
    useEffect(() => setImageFailed(false), [src]);

    // TokenImg 會把 blobref 令牌解析成可用 url，這裡只判「有沒有頭像」和「加載失敗沒」
    const canShowImage = !!src && !imageFailed;
    return (
        <div
            className={`mt-1 h-9 w-9 shrink-0 overflow-hidden rounded-full ring-1 shadow-sm ${
                light ? 'bg-stone-200 text-stone-500 ring-stone-300/70' : 'bg-white/10 text-white/70 ring-white/15'
            }`}
            aria-hidden="true"
        >
            {canShowImage ? (
                <TokenImg
                    value={src}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <span className="flex h-full w-full items-center justify-center text-xs font-bold">
                    {(name || '·').trim().slice(0, 1) || '·'}
                </span>
            )}
        </div>
    );
};

const DateSession: React.FC<DateSessionProps> = ({
    onLoadMoreHistory,
    historyLoadLimit = 0,
    historyReachedEnd = true,
    char,
    userProfile,
    messages,
    peekStatus,
    onSendMessage,
    onReroll,
    liveReply,
    presetName,
    onExit,
    onEditMessage,
    onDeleteMessage,
    onDeleteMessages,
    presetRegex,
    onFinishStory,
    emotion,
    onEmotionChange,
    suppressAutoSaveRef,
    onCaptureMoment,
    capturingMoment,
}) => {
    const { addToast, registerBackHandler, apiConfig, updateCharacter, apiPresets } = useOS();

    // 背景字段存的是原始值（令牌 / data: / 外鏈），渲染這一刻才解析成能喂 CSS 的 url
    const bgImageUrl = useBlobRefUrl(char.dateBackground || '');
    const light = !!char.dateLightReading;
    const appearance = char.dateAppearance;
    const backdrop = resolveDateBackdrop(appearance, light);
    // 字級／字色在前、用戶自訂 CSS 在後，用戶寫的能蓋過去
    const appearanceCss = useMemo(
        () => [buildDateAppearanceCss(appearance, light), scopeDateCss(appearance?.customCss)].filter(Boolean).join('\n'),
        [appearance, light],
    );
    const decorationDarkCard = light && appearance?.decorationDarkCard === true;
    const [showEmotion, setShowEmotion] = useState(false);
    const emotionChar = emotion ? { ...char, ...emotion } : char;
    const emotionNow = liveBuffs(emotionChar.activeBuffs);

    // Interaction State
    const [input, setInput] = useState('');
    // 輸入框跟著字數長高：先歸零量 scrollHeight，再設回去；上限交給 max-h-36，超過就在框裡捲
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [input]);
    const [showInputBox, setShowInputBox] = useState(false);
    const [isTyping, setIsTyping] = useState(false); // Waiting for API
    const [showExitModal, setShowExitModal] = useState(false);
    // API 失敗時本地記住本輪輸入，不依賴父組件的 DB 刷新是否已經完成；用戶可直接點重試。
    const [pendingRetryText, setPendingRetryText] = useState('');
    const [sarTruthMessageIds, setSarTruthMessageIds] = useState<Set<number>>(new Set());

    useEffect(() => {
        if (!getPendingReplyText(messages)) setPendingRetryText('');
    }, [messages]);

    // Settings Overlay State (Internal)
    const [showSettings, setShowSettings] = useState(false);
    // 換模型：見面跟私聊用同一個「對話模型」（char.chatApi），API 掛了或想換不用先存檔退出
    const [showApiPanel, setShowApiPanel] = useState(false);

    // 頂欄摺疊菜單：常駐只留「輸入」+「菜單」兩鈕，低頻操作全收進來
    const [showMenu, setShowMenu] = useState(false);

    // Edit Msg Logic
    const [modalType, setModalType] = useState<'none' | 'options'>('none');
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [isBatchSelectMode, setIsBatchSelectMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const touchStartRef = useRef<{x: number, y: number} | null>(null);
    const novelScrollRef = useRef<HTMLDivElement>(null);

    // Voice TTS
    const [showVoiceLangPicker, setShowVoiceLangPicker] = useState(false);
    const voiceCacheRef = useRef<Record<string, DateSpeechResult>>({});
    const [novelVoiceLoading, setNovelVoiceLoading] = useState<Set<string>>(new Set());
    const [novelPlayingId, setNovelPlayingId] = useState<string | null>(null);
    const [novelVisibleCount, setNovelVisibleCount] = useState(NOVEL_MESSAGE_WINDOW_SIZE);
    const dateAudioRef = useRef<HTMLAudioElement | null>(null);
    const voiceEnabled = !!char.dateVoiceEnabled;
    const voiceLang = char.dateVoiceLang || '';
    const [voiceFavoriteTarget, setVoiceFavoriteTarget] = useState<DateVoiceFavoriteTarget | null>(null);
    const [voiceFavoriteSaved, setVoiceFavoriteSaved] = useState(false);
    const [voiceFavoriteBusy, setVoiceFavoriteBusy] = useState(false);
    const voiceFavoriteLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const voiceFavoriteLongPressTriggered = useRef(false);

    // 語氣標籤在翻譯之後才按服務商放回去（utils/dateVoiceTags.ts），翻譯模型看不到也改不壞它們
    const translateAndSpeak = async (text: string, tags: string[]): Promise<DateSpeechResult | null> => {
        if (!canSynthesizeSpeech(char, apiConfig)) return null;
        try {
            let ttsText = cleanTextForTtsProvider(text, apiConfig);
            if (!ttsText || ttsText.length < 2) return null;
            if (voiceLang) {
                const langLabel = voiceLanguagePromptLabel(voiceLang);
                try {
                    const transRes = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                        body: JSON.stringify({
                            model: apiConfig.model,
                            messages: [{ role: 'system', content: `Translate the following text to ${langLabel}. Output ONLY the translation, nothing else.` }, { role: 'user', content: ttsText }],
                            temperature: 0.3,
                        }),
                    });
                    const transData = await transRes.json();
                    const translated = transData?.choices?.[0]?.message?.content?.trim();
                    if (translated) ttsText = translated;
                } catch { /* use original */ }
            }
            const voiced = applyDateVoiceTags(ttsText, tags, apiConfig);
            const url = await synthesizeSpeech(voiced.text, char, apiConfig, {
                languageBoost: voiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
                emotion: voiced.emotion,
            });
            return {
                url,
                spokenText: stripTtsMarkupForDisplay(ttsText, apiConfig),
            };
        } catch (err: any) {
            console.warn('Date TTS failed:', err?.message);
            return null;
        }
    };

    const playAudio = (url: string, lineKey: string) => {
        if (!dateAudioRef.current) dateAudioRef.current = new Audio();
        dateAudioRef.current.src = url;
        dateAudioRef.current.onended = () => setNovelPlayingId(null);
        dateAudioRef.current.play().catch(() => {});
        setNovelPlayingId(lineKey);
    };

    // 逐句播放：同一句（連同語氣標籤）合成過就走快取，也會命中 ttsCache 的持久快取
    const handleNovelLinePlay = async (lineKey: string, dialogueText: string, tags: string[]) => {
        if (novelPlayingId === lineKey && dateAudioRef.current) {
            dateAudioRef.current.pause();
            setNovelPlayingId(null);
            return;
        }
        const key = voiceCacheKey(dialogueText, tags);
        const cached = voiceCacheRef.current[key];
        if (cached) { playAudio(cached.url, lineKey); return; }
        setNovelVoiceLoading(prev => new Set(prev).add(lineKey));
        const speech = await translateAndSpeak(dialogueText, tags);
        setNovelVoiceLoading(prev => { const n = new Set(prev); n.delete(lineKey); return n; });
        if (!speech) { addToast('語音合成失敗，請稍後重試', 'error'); return; }
        voiceCacheRef.current[key] = speech;
        playAudio(speech.url, lineKey);
    };

    const openDateVoiceFavorite = async (target: DateVoiceFavoriteTarget | null) => {
        if (!target) return;
        setVoiceFavoriteTarget(target);
        setVoiceFavoriteBusy(false);
        setVoiceFavoriteSaved(!!await getVoiceFavorite('date', target.sourceKey).catch(() => null));
    };

    const startDateVoiceLongPress = (event: React.TouchEvent, target: DateVoiceFavoriteTarget | null) => {
        event.stopPropagation();
        if (!target) return;
        voiceFavoriteLongPressTriggered.current = false;
        if (voiceFavoriteLongPressTimer.current) clearTimeout(voiceFavoriteLongPressTimer.current);
        voiceFavoriteLongPressTimer.current = setTimeout(() => {
            voiceFavoriteLongPressTriggered.current = true;
            void openDateVoiceFavorite(target);
        }, 450);
    };

    const endDateVoiceLongPress = (event: React.SyntheticEvent) => {
        event.stopPropagation();
        if (voiceFavoriteLongPressTimer.current) clearTimeout(voiceFavoriteLongPressTimer.current);
        voiceFavoriteLongPressTimer.current = null;
    };

    const toggleDateVoiceFavorite = async () => {
        const target = voiceFavoriteTarget;
        if (!target || voiceFavoriteBusy) return;
        setVoiceFavoriteBusy(true);
        try {
            if (voiceFavoriteSaved) {
                await removeVoiceFavorite('date', target.sourceKey);
                setVoiceFavoriteSaved(false);
                addToast('已取消收藏語音', 'info');
                return;
            }
            const key = voiceCacheKey(target.originalText, target.voiceTags);
            let speech: DateSpeechResult | undefined = voiceCacheRef.current[key];
            if (!speech) {
                speech = await translateAndSpeak(target.originalText, target.voiceTags) || undefined;
                if (speech) voiceCacheRef.current[key] = speech;
            }
            if (!speech) throw new Error('語音合成失敗，請稍後重試');
            const blob = await fetchBlobForShare(speech.url, 'audio/mpeg');
            await saveVoiceFavorite({
                source: 'date',
                sourceKey: target.sourceKey,
                charId: char.id,
                charName: char.name,
                sourceTimestamp: target.sourceTimestamp,
                originalText: target.originalText,
                spokenText: speech.spokenText !== target.originalText ? speech.spokenText : undefined,
                language: voiceLang || undefined,
                blob,
            });
            setVoiceFavoriteSaved(true);
            addToast('已收藏見面語音', 'success');
        } catch (error: any) {
            addToast(error?.message || '收藏失敗，請檢查瀏覽器存儲空間', 'error');
        } finally {
            setVoiceFavoriteBusy(false);
        }
    };

    // Back Handler
    useEffect(() => {
        const unregister = registerBackHandler(() => {
            if (voiceFavoriteTarget) {
                if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null);
                return true;
            }
            if (showSettings) {
                setShowSettings(false);
                return true;
            }
            if (showApiPanel) {
                setShowApiPanel(false);
                return true;
            }
            if (showMenu) {
                setShowMenu(false);
                setShowVoiceLangPicker(false);
                return true;
            }
            if (showExitModal) {
                setShowExitModal(false);
                return true;
            }
            setShowExitModal(true);
            return true;
        });
        return unregister;
    }, [voiceFavoriteTarget, voiceFavoriteBusy, showSettings, showApiPanel, showMenu, showExitModal, registerBackHandler]);

    // Show only the current session: from the LAST message with `isOpening: true` onwards.
    const sessionMessages = React.useMemo(() => {
        const openingIndex = messages.map(m => m.metadata?.isOpening).lastIndexOf(true);
        if (openingIndex !== -1) {
            return messages.slice(openingIndex);
        }
        // Fallback: If no opening found (legacy data), show all
        return messages;
    }, [messages]);

    // 正則的 depth 從最後一則往回數，最後一則是 0
    const depthById = React.useMemo(
        () => new Map(sessionMessages.map((m, i) => [m.id, sessionMessages.length - 1 - i])),
        [sessionMessages],
    );
    const displayEnv = { charName: char.name, userName: userProfile.name, vars: {}, globalVars: {} };
    // 觀測協議（utils/dateObserve.ts）：只在內建規則下顯示卡片；不管開不開，正文裡的觀測塊都先剝掉
    const observeActive = isObserveActive(char, !!presetName);
    const splitObserve = (text: string) => extractObservation(text || '', { lenient: observeActive, custom: char.dateObserve?.custom });
    const observeCard = (observation: ReturnType<typeof splitObserve>['observation']) => (observeActive && hasObservation(observation)
        ? <div className="date-observe-card mb-3"><ObserveHUD observation={observation} variant="card" charName={char.name} config={char.dateObserve} /></div>
        : null);
    const presetDisplay = (text: string, placement: number, msgId: number): string => (presetRegex?.length
        ? applyRegexScripts(text, presetRegex, { placement, stage: 'display', depth: depthById.get(msgId), env: displayEnv })
        : text);

    const visibleSessionMessages = React.useMemo(() => {
        return sessionMessages.slice(-novelVisibleCount);
    }, [sessionMessages, novelVisibleCount]);
    const hiddenNovelMessageCount = Math.max(0, sessionMessages.length - visibleSessionMessages.length);
    // 每則是這段見面記錄的第幾則（標籤列的 #）
    const messageOrdinal = React.useMemo(() => new Map(sessionMessages.map((m, i) => [m.id, i] as const)), [sessionMessages]);

    useEffect(() => {
        setNovelVisibleCount(NOVEL_MESSAGE_WINDOW_SIZE);
    }, [char.id]);

    // Scroll to bottom on new content
    useEffect(() => {
        if (novelScrollRef.current) {
            novelScrollRef.current.scrollTop = novelScrollRef.current.scrollHeight;
        }
    }, [visibleSessionMessages.length, showInputBox]);

    // 串流中：使用者沒往上翻的話跟著捲到底，看得到正在寫的那段
    const liveLength = (liveReply?.text.length || 0) + (liveReply?.reasoning.length || 0);
    useEffect(() => {
        const el = novelScrollRef.current;
        if (!el || !liveLength) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
    }, [liveLength]);

    const closeMenu = () => { setShowMenu(false); setShowVoiceLangPicker(false); };

    const submitTurn = async (kind?: 'continue') => {
        if (isTyping) return;
        const inputText = input.trim();
        // 本地失敗輸入優先，DB 時間線兜底。這樣即使父組件刷新尚未落到這一幀，重試鍵也不會失效。
        const retryText = pendingRetryText || getPendingReplyText(messages);
        if (kind !== 'continue' && !inputText && !retryText) return;
        const text = kind === 'continue' ? MEETING_CONTINUE_DISPLAY_TEXT : (inputText || retryText);
        if (kind !== 'continue' && inputText) {
            setInput('');
            setShowInputBox(false);
        }
        setIsTyping(true);

        try {
            await onSendMessage(text, kind);
            setPendingRetryText('');
        } catch (e: any) {
            // onSendMessage 內部含 API 調用 + 回覆後處理, 拋錯不一定是網絡。用中性文案, 不誤導成"連接中斷"。
            setPendingRetryText(text);
            addToast(`出錯了：${e?.message || '未知錯誤'}`, 'error');
            setShowInputBox(true);
        } finally {
            setIsTyping(false);
        }
    };

    const handleSend = () => { void submitTurn(); };
    const handleContinue = () => { void submitTurn('continue'); };

    const [showRerollSheet, setShowRerollSheet] = useState(false);
    const handleRerollClick = async (note?: string) => {
        if (isTyping) return;
        setShowRerollSheet(false);
        setIsTyping(true);
        try {
            await onReroll(note);
        } catch(e: any) {
            // 父級 handleReroll 只拋不提示；這裡不給反饋的話，點了「重新生成」沒動靜用戶會以為沒點上
            addToast(`重新生成失敗: ${e?.message || '未知錯誤'}`, 'error');
        } finally {
            setIsTyping(false);
        }
    };

    const buildCurrentState = (): DateState => ({
        timestamp: Date.now(),
        peekStatus,
    });

    const handleExitClick = () => {
        onExit(buildCurrentState());
    };

    // Auto-save: persist date state so refresh/close doesn't lose progress
    const stateRef = useRef<() => DateState>(buildCurrentState);
    stateRef.current = buildCurrentState;
    const charRef = useRef(char);
    charRef.current = char;

    useEffect(() => {
        // Direct DB save — works during beforeunload when React state updates are useless
        const saveStateToDB = () => {
            if (suppressAutoSaveRef?.current) return;
            try {
                const state = stateRef.current();
                DB.saveCharacter({ ...charRef.current, savedDateState: state });
            } catch (e) { /* best-effort */ }
        };

        // beforeunload: catch page refresh / tab close
        const handleBeforeUnload = () => { saveStateToDB(); };
        // visibilitychange: catch tab switch / app background (more reliable on mobile)
        const handleVisibilityChange = () => { if (document.visibilityState === 'hidden') saveStateToDB(); };
        window.addEventListener('beforeunload', handleBeforeUnload);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Periodic auto-save every 30s
        const interval = setInterval(saveStateToDB, 30000);

        // 見面「繼續上次」崩潰自愈：只要會話穩定掛載並渲染了一小段時間沒崩，
        // 就撤銷 DateApp 在恢復前武裝的哨兵——證明這份快照能安全加載。若 iOS WebKit
        // 在此之前把內容進程撐崩（進程級崩潰，不會跑下面的卸載 cleanup），哨兵留存，
        // 下次進見面即被檢出並丟棄這份有毒快照。新會話（無 initialState）無哨兵，clear 為空操作。
        const settleTimer = setTimeout(() => clearDateResumeAttempt(), 2500);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            clearInterval(interval);
            clearTimeout(settleTimer);
            // 乾淨卸載（SPA 內導航離開會話）= 非崩潰，撤銷哨兵。
            clearDateResumeAttempt();
            // 卸載時只把進度直接落庫，絕不調用 onExit。onExit 會執行「用戶主動退出」的
            // 導航（setMode('select') + 彈「進度已保存」），而卸載在很多非用戶意圖的場景
            // 都會發生 —— 尤其 React.StrictMode (dev) 的「掛載→卸載→重掛載」探測：
            // 一進正式見面就被自己的卸載副作用導航回選擇頁，並彈兩次「進度已保存」。
            // 直接 DB 持久化與其它自動保存路徑（beforeunload / visibilitychange / 定時）一致。
            saveStateToDB();
        };
    }, []);

    // Message Touch Logic (Robust version for scrollable lists)
    const handleMsgTouchStart = (e: React.TouchEvent | React.MouseEvent, msg: Message) => {
        // If already in batch select mode, don't start a new long press timer
        if (isBatchSelectMode) return;
        if ('touches' in e) {
            touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else {
            touchStartRef.current = { x: e.clientX, y: e.clientY };
        }

        longPressTimer.current = setTimeout(() => {
            setSelectedMessage(msg);
            setModalType('options');
        }, 600);
    };

    const handleMsgTouchMove = (e: React.TouchEvent | React.MouseEvent) => {
        if (!longPressTimer.current || !touchStartRef.current) return;

        let clientX, clientY;
        if ('touches' in e) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        const dx = Math.abs(clientX - touchStartRef.current.x);
        const dy = Math.abs(clientY - touchStartRef.current.y);

        // If moved more than 10px, assume scrolling and cancel long press
        if (dx > 10 || dy > 10) {
            if (longPressTimer.current) clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };

    const handleMsgTouchEnd = () => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const toggleSelectedMsg = (id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const exitBatchMode = () => {
        setIsBatchSelectMode(false);
        setSelectedMsgIds(new Set());
    };

    const handleBatchDelete = async () => {
        if (selectedMsgIds.size === 0) return;
        await onDeleteMessages(Array.from(selectedMsgIds));
        exitBatchMode();
    };

    // Determine if we can reroll (last message is assistant)
    const canReroll = messages.length > 0 && messages[messages.length - 1].role === 'assistant';

    const menuButton = 'h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all bg-black/40 backdrop-blur-md border-white/15 text-white hover:bg-white/20';

    return (
        <div className={`h-full w-full relative overflow-hidden font-sans select-none ${light ? 'bg-[#faf8f5]' : 'bg-black'}`} onClick={() => { if (showMenu) closeMenu(); }}>
            {appearanceCss && <style>{appearanceCss}</style>}
            {/* .date-root 只包見面畫面本身；設定、換模型、彈窗放在外面，用戶自訂 CSS 碰不到 */}
            <div className={`date-root ${light ? 'date-theme-light' : 'date-theme-dark'} absolute inset-0 overflow-hidden ${light ? 'bg-[#faf8f5]' : 'bg-black'}`}>

            {/* Background Layer */}
            <div
                className={`date-background absolute inset-0 bg-cover bg-center ${backdrop.backgroundBlur ? 'blur-xl' : ''}`}
                style={{ backgroundImage: bgImageUrl ? `url(${bgImageUrl})` : 'none', opacity: backdrop.backgroundOpacity }}
            ></div>

            {/* 當下情緒：一行小字，點開看完整列表（情緒會褪色，見 utils/emotionDecay.ts） */}
            {char.emotionConfig?.enabled && emotionNow.length > 0 && (
                <button
                    onClick={(e) => { e.stopPropagation(); setShowEmotion(true); }}
                    className={`date-emotion-line absolute top-0 left-0 z-[90] mt-14 ml-4 max-w-[45%] truncate rounded-full px-3 py-1 text-[11px] backdrop-blur-md border ${light ? 'bg-white/70 border-stone-200 text-stone-500' : 'bg-black/30 border-white/15 text-white/70'}`}
                    aria-label="看當下情緒"
                >
                    {emotionNow.slice(0, 3).map(buff => `${buff.emoji || ''}${buff.label}`).join(' · ')}
                </button>
            )}

            {/* Menu Layer — 繼續按鈕單獨在左；菜單 / 輸入上下疊在最右列。
                這樣第二行的輸入按鈕貼右，不會壓住批量操作欄的中間區域。 */}
            <div className="absolute top-0 right-0 p-4 pt-12 z-[100] flex flex-col items-end gap-2 pointer-events-auto">
                <div className="flex items-start gap-3">
                    <button
                        onClick={(e) => { e.stopPropagation(); closeMenu(); handleContinue(); }}
                        disabled={isTyping}
                        className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center border bg-black/30 backdrop-blur-md border-white/20 text-white shadow-lg active:scale-95 transition-all hover:bg-white/20 disabled:opacity-40"
                        title={`本輪不主動行動，讓${char.name}繼續陪伴並推進見面`}
                        aria-label="繼續當前見面"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z" clipRule="evenodd" /></svg>
                    </button>
                    <div className="flex flex-col gap-2">
                        <button aria-label={showMenu ? '收起見面菜單' : '打開見面菜單'} onClick={(e) => { e.stopPropagation(); setShowMenu(prev => !prev); setShowVoiceLangPicker(false); }} className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all shadow-lg active:scale-95 ${showMenu ? 'bg-white text-black border-white' : 'bg-black/30 backdrop-blur-md border-white/20 text-white hover:bg-white/20'}`}>
                            {showMenu ? (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" /></svg>
                            )}
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); setShowInputBox(!showInputBox); closeMenu(); }}
                            className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all shadow-lg active:scale-95 ${showInputBox ? 'bg-primary border-primary text-white' : 'bg-black/30 backdrop-blur-md border-white/20 text-white hover:bg-white/20'}`}
                            title={showInputBox ? '收起輸入框' : '展示輸入框'}
                            aria-label={showInputBox ? '收起輸入框' : '展示輸入框'}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
                        </button>
                    </div>
                </div>

                {showMenu && (
                    <div className="flex flex-col items-end gap-1.5 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                        <div className="date-preset-label max-w-[14rem] truncate rounded-full bg-black/40 px-3 py-1 text-[10px] font-bold text-white/80 backdrop-blur-md" title={presetName || '內建規則'}>
                            預設：{presetName || '內建規則'}
                        </div>
                        {!isTyping && canReroll && (
                            <button onClick={() => { closeMenu(); setShowRerollSheet(true); }} className={menuButton}>
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                                重新生成
                            </button>
                        )}

                        {/* 語音：未開啟時點擊直接開啟並展開語種；開啟時點擊展開/收起語種選擇（含關閉項） */}
                        <button onClick={() => {
                                if (voiceEnabled) {
                                    setShowVoiceLangPicker(prev => !prev);
                                } else {
                                    updateCharacter(char.id, { dateVoiceEnabled: true });
                                    addToast('語音已開啟', 'info');
                                    setShowVoiceLangPicker(true);
                                }
                            }}
                            className={`h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all backdrop-blur-md ${voiceEnabled ? 'bg-emerald-600/70 border-emerald-300/40 text-white' : 'bg-black/40 border-white/15 text-white/60 hover:bg-white/20'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                {voiceEnabled
                                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                                    : <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />}
                            </svg>
                            語音{voiceEnabled ? (voiceLang ? ` · ${voiceLanguageLabel(voiceLang)}` : ' · 開') : ' · 關'}
                        </button>
                        {voiceEnabled && showVoiceLangPicker && (
                            <div className="flex flex-wrap justify-end gap-1 max-w-[200px] animate-fade-in">
                                {VOICE_LANGUAGE_OPTIONS.map(opt => (
                                    <button key={opt.value} onClick={() => { updateCharacter(char.id, { dateVoiceLang: opt.value }); trackEvent('设置见面语音语种', { 语种: voiceLanguageAnalyticsValue(opt.value) }); setShowVoiceLangPicker(false); }}
                                        className={`h-7 px-2.5 rounded-full text-[10px] font-bold transition-all active:scale-95 whitespace-nowrap ${voiceLang === opt.value ? 'bg-white/30 text-white shadow-md' : 'bg-black/30 backdrop-blur-md text-white/60 border border-white/10'}`}>
                                        {opt.label}
                                    </button>
                                ))}
                                <button onClick={() => { updateCharacter(char.id, { dateVoiceEnabled: false }); setShowVoiceLangPicker(false); addToast('語音已關閉', 'info'); }}
                                    className="h-7 px-2.5 rounded-full text-[10px] font-bold transition-all active:scale-95 whitespace-nowrap bg-red-500/50 text-white border border-red-300/40 shadow-md">
                                    關閉語音
                                </button>
                            </div>
                        )}

                        {!isBatchSelectMode && (
                            <button onClick={() => { setIsBatchSelectMode(true); closeMenu(); }} className={menuButton}>
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                                多選刪除
                            </button>
                        )}

                        <button onClick={() => { setShowApiPanel(true); closeMenu(); }} className={menuButton}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z" /></svg>
                            模型
                        </button>

                        <button onClick={() => { setShowSettings(true); closeMenu(); }} className={menuButton}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 2.555c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.212 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-2.555c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                            見面設定
                        </button>

                        {onCaptureMoment && (
                            <button onClick={() => { closeMenu(); onCaptureMoment(); }} disabled={capturingMoment} className={`${menuButton} disabled:opacity-50`}>
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z" /></svg>
                                {capturingMoment ? '洗照片中…' : '拍下這一刻'}
                            </button>
                        )}

                        {onFinishStory && (
                            <button onClick={() => { closeMenu(); onFinishStory(); }} className={menuButton}>
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></svg>
                                完結故事
                            </button>
                        )}

                        <button onClick={() => { closeMenu(); setShowExitModal(true); }} className="h-9 px-3.5 rounded-full flex items-center gap-2 text-xs font-bold border shadow-lg active:scale-95 transition-all bg-red-500/70 backdrop-blur-md border-white/20 text-white hover:bg-red-600">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75" /></svg>
                            離開
                        </button>
                    </div>
                )}
            </div>

            {/* Reading View */}
            <div ref={novelScrollRef} className={`date-reading absolute inset-0 z-20 overflow-y-auto no-scrollbar pt-24 pb-32 px-8 mask-image-gradient overscroll-contain ${backdrop.overlayColor ? '' : light ? 'bg-[#faf8f5]/90' : 'bg-black/80 backdrop-blur-sm'}`} style={backdrop.overlayColor ? { backgroundColor: backdrop.overlayColor } : undefined} onClick={(e) => { e.stopPropagation(); if (showMenu) { closeMenu(); return; } setShowInputBox(true); }}>
                <div className="min-h-full flex flex-col justify-end">
                    <div className="max-w-2xl mx-auto w-full animate-fade-in space-y-6">
                        {isBatchSelectMode && (
                            <div className="sticky top-0 z-20 flex items-center justify-between bg-white/90 border border-stone-200 rounded-xl px-3 py-2 text-xs text-stone-700">
                                <span>已選 {selectedMsgIds.size} 條</span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={(e) => { e.stopPropagation(); exitBatchMode(); }}
                                        className="px-3 py-1 rounded-full bg-stone-200 text-stone-600"
                                    >完成</button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleBatchDelete(); }}
                                        disabled={selectedMsgIds.size === 0}
                                        className="px-3 py-1 rounded-full bg-red-500 text-white disabled:opacity-40"
                                    >刪除</button>
                                </div>
                            </div>
                        )}
                        {sessionMessages.length === 0 && peekStatus && (() => {
                            const { observation, rest } = splitObserve(peekStatus);
                            return (
                                <div className={`date-opening italic text-center text-sm mb-8 px-4 ${light ? 'text-stone-400' : 'text-slate-200/50'}`}>
                                    {observeCard(observation)}
                                    {parseDateBody(presetRegex ? cleanDisplayText(rest) : rest).map((line, idx) => <p key={idx} className="whitespace-pre-wrap leading-relaxed tracking-wide my-2">{line.text}</p>)}
                                </div>
                            );
                        })()}
                        {(hiddenNovelMessageCount > 0 || !historyReachedEnd) && (
                            <div className="flex justify-center">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        // 本地還有沒顯示的就只開窗；已經鋪滿則回庫裡取更早的一批，
                                        // 否則初始窗口以外的見面記錄在閱讀視圖裡永遠夠不著。
                                        const plan = planNovelLoadMore({
                                            loadedCount: sessionMessages.length,
                                            visibleCount: novelVisibleCount,
                                            windowStep: NOVEL_MESSAGE_LOAD_STEP,
                                            loadLimit: historyLoadLimit,
                                            loadStep: NOVEL_HISTORY_FETCH_STEP,
                                            reachedDbEnd: historyReachedEnd,
                                        });
                                        setNovelVisibleCount(plan.nextVisibleCount);
                                        if (plan.nextLoadLimit !== null) void onLoadMoreHistory?.(plan.nextLoadLimit);
                                    }}
                                    className={`px-4 py-2 rounded-full text-xs font-bold border active:scale-95 transition-transform ${
                                        light
                                            ? 'bg-stone-100 text-stone-500 border-stone-200'
                                            : 'bg-white/10 text-white/60 border-white/10'
                                    }`}
                                >
                                    加載更早見面記錄{hiddenNovelMessageCount > 0 ? ` (${hiddenNovelMessageCount})` : ''}
                                </button>
                            </div>
                        )}
                        {visibleSessionMessages.map((msg) => (
                            <div
                                key={msg.id}
                                className={`date-message ${msg.role === 'user' ? 'date-message-user' : 'date-message-ai'} group relative rounded-xl transition-colors -mx-4 px-4 py-2 ${isBatchSelectMode ? 'pl-10' : ''} ${light ? 'active:bg-stone-100' : 'active:bg-white/5'}`}
                                onClick={(e) => {
                                    if (!isBatchSelectMode) return;
                                    e.stopPropagation();
                                    toggleSelectedMsg(msg.id);
                                }}
                                onTouchStart={(e) => handleMsgTouchStart(e, msg)}
                                onTouchEnd={handleMsgTouchEnd}
                                onTouchMove={handleMsgTouchMove}
                                onMouseDown={(e) => handleMsgTouchStart(e, msg)}
                                onMouseUp={handleMsgTouchEnd}
                                onMouseMove={handleMsgTouchMove}
                                onMouseLeave={handleMsgTouchEnd}
                                onContextMenu={(e) => { e.preventDefault(); if (!isBatchSelectMode) { setSelectedMessage(msg); setModalType('options'); } }}
                            >
                                {isBatchSelectMode && (
                                    <div className={`absolute left-0 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selectedMsgIds.has(msg.id) ? 'bg-primary border-primary' : 'bg-white border-stone-300'}`}>
                                        {selectedMsgIds.has(msg.id) && <span className="text-white text-[10px]">✓</span>}
                                    </div>
                                )}
                                {msg.role === 'user' ? (() => {
                                    const sarSurface = getSARSurface(msg);
                                    const sarRevealed = sarTruthMessageIds.has(msg.id);
                                    const shown = sarSurface && !sarRevealed ? sarSurface : msg.content;
                                    return (
                                    <div className="flex min-w-0 items-start justify-end gap-3">
                                        <p
                                            className={`date-line-user min-w-0 flex-1 whitespace-pre-wrap font-serif text-[16px] text-right leading-loose tracking-wide italic pr-4 ${light ? 'text-stone-400 border-r-2 border-stone-300/50' : 'text-slate-400 border-r-2 border-slate-600/50'}`}
                                        >{cleanUserTextForDisplay(presetRegex ? cleanDisplayText(presetDisplay(shown, REGEX_PLACEMENT.userInput, msg.id)) : shown)} <span className="date-line-name text-[10px] uppercase font-sans not-italic ml-2 opacity-50">{userProfile.name}</span></p>
                                        {char.dateReadingShowAvatars && (
                                            <ReadingAvatar
                                                // userProfile 傳進來時已經按角色分身份卡解析過（resolveUserProfileForChar），
                                                // .avatar 已經是該疊的都疊好的最終結果——這裡不能再疊一次 perCharAvatars，
                                                // 否則指定了具體身份卡時會被原始整體頭像覆蓋回去。
                                                src={userProfile.avatar}
                                                name={userProfile.name}
                                                light={light}
                                            />
                                        )}
                                    </div>
                                    ); })() : msg.type === 'image' ? (
                                    // 拍下這一刻的照片（utils/dateMoment.ts）：不算一輪回覆，不給重擲／語音
                                    <figure className="date-photo my-2">
                                        <TokenImg value={msg.content} alt="拍下這一刻" className={`w-full rounded-xl object-cover shadow-lg ${light ? 'ring-1 ring-stone-200' : 'ring-1 ring-white/10'}`} />
                                        {msg.metadata?.dateMoment && (
                                            <figcaption className={`mt-1.5 text-[10px] text-center ${light ? 'text-stone-400' : 'text-white/40'}`}>
                                                {describeMomentLock(msg.metadata.momentLock, msg.metadata.momentLockError)}
                                            </figcaption>
                                        )}
                                    </figure>
                                    ) : (() => {
                                    const sarSurface = getSARSurface(msg);
                                    const sarRevealed = sarTruthMessageIds.has(msg.id);
                                    const { observation, rest: shown } = splitObserve(sarSurface && !sarRevealed ? sarSurface : msg.content);
                                    const isOpeningMsg = msg.metadata?.isOpening === true;
                                    const parts: DisplaySegment[] = presetRegex
                                        ? splitDisplaySegments(presetDisplay(shown || '', REGEX_PLACEMENT.aiOutput, msg.id))
                                        : [{ type: 'text', text: shown || '' }];
                                    return (
                                    <div className="flex min-w-0 items-start gap-3">
                                        {char.dateReadingShowAvatars && (
                                            <ReadingAvatar src={char.avatar} name={char.name} light={light} />
                                        )}
                                        <div className="min-w-0 flex-1">
                                            <DateReplyTags msg={msg} index={(messageOrdinal.get(msg.id) ?? 0) + 1} light={light} />
                                            {observeCard(observation)}
                                            {parts.map((part, partIdx) => part.type === 'html'
                                                ? (
                                                    <div key={`html-${partIdx}`} className={`date-decoration-card ${decorationDarkCard ? 'rounded-2xl bg-[#1c1b22] px-3 py-px my-3' : ''}`}>
                                                        <DecorationFrame html={part.html} light={light && !decorationDarkCard} />
                                                    </div>
                                                )
                                                : parseDateBody(presetRegex ? cleanDisplayText(part.text) : part.text).map((line, idx) => {
                                            const lineKey = partIdx === 0 ? `${msg.id}-${idx}` : `${msg.id}-${partIdx}-${idx}`;
                                            const canVoice = voiceEnabled && line.isDialogue && !!line.spoken && !isOpeningMsg;
                                            const voiceTarget: DateVoiceFavoriteTarget = {
                                                sourceKey: `${char.id}:${lineKey}`,
                                                originalText: line.spoken,
                                                sourceTimestamp: msg.timestamp,
                                                voiceTags: line.tags,
                                            };
                                            return (
                                                <div
                                                    key={`${partIdx}-${idx}`}
                                                    className="flex items-start gap-1 mb-4 last:mb-0"
                                                    onClick={(e) => {
                                                        if (!voiceFavoriteLongPressTriggered.current) return;
                                                        e.stopPropagation();
                                                        voiceFavoriteLongPressTriggered.current = false;
                                                    }}
                                                    onTouchStart={canVoice ? (e) => startDateVoiceLongPress(e, voiceTarget) : undefined}
                                                    onTouchMove={canVoice ? endDateVoiceLongPress : undefined}
                                                    onTouchEnd={canVoice ? endDateVoiceLongPress : undefined}
                                                    onMouseDown={canVoice ? (e) => e.stopPropagation() : undefined}
                                                    onContextMenu={canVoice ? (e) => { e.preventDefault(); e.stopPropagation(); void openDateVoiceFavorite(voiceTarget); } : undefined}
                                                >
                                                    <p
                                                        // 台詞深、旁白淺一階，一眼分得出誰在說話；class 名是之後畫面美化自訂 CSS 的鉤子
                                                        className={`date-line ${line.isDialogue ? 'date-line-dialogue' : 'date-line-narration'} flex-1 whitespace-pre-wrap font-serif text-[18px] text-justify leading-loose tracking-wide pl-4 border-l-2 ${light
                                                            ? `border-stone-200 ${line.isDialogue ? 'text-stone-800' : 'text-stone-500'}`
                                                            : `drop-shadow-md border-white/10 ${line.isDialogue ? 'text-slate-100' : 'text-slate-400'}`}`}
                                                    >{line.text}</p>
                                                    {/* Voice button: only for dialogue lines, not opening */}
                                                    {canVoice && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (voiceFavoriteLongPressTriggered.current) { voiceFavoriteLongPressTriggered.current = false; return; }
                                                                handleNovelLinePlay(lineKey, line.spoken, line.tags);
                                                            }}
                                                            onTouchStart={(e) => startDateVoiceLongPress(e, voiceTarget)}
                                                            onTouchMove={endDateVoiceLongPress}
                                                            onTouchEnd={endDateVoiceLongPress}
                                                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); void openDateVoiceFavorite(voiceTarget); }}
                                                            title="播放；長按可收藏"
                                                            className={`shrink-0 mt-2 w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 select-none ${
                                                                novelPlayingId === lineKey
                                                                    ? (light ? 'bg-emerald-100 text-emerald-600' : 'bg-emerald-500/20 text-emerald-300')
                                                                    : (light ? 'bg-stone-100 text-stone-400 hover:bg-stone-200' : 'bg-white/5 text-white/40 hover:bg-white/10')
                                                            }`}
                                                        >
                                                            {novelVoiceLoading.has(lineKey) ? (
                                                                <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                                            ) : novelPlayingId === lineKey ? (
                                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M5.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75A.75.75 0 0 0 7.25 3h-1.5ZM12.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75a.75.75 0 0 0-.75-.75h-1.5Z" /></svg>
                                                            ) : (
                                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                            }))}
                                        </div>
                                    </div>
                                    ); })()}
                                {getSARSurface(msg) && (
                                    <div className="sar-date-speech-control" style={{ color: light ? '#57534e' : '#cbd5e1' }}>
                                        <SARSpeechSwitch truth={sarTruthMessageIds.has(msg.id)} moduleTitle={msg.metadata?.sarModuleSurface?.moduleTitle}
                                            onToggle={() => setSarTruthMessageIds(previous => {
                                                const next = new Set(previous);
                                                if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                                                return next;
                                            })} />
                                    </div>
                                )}
                            </div>
                        ))}
                        {isTyping && liveReply && (liveReply.text || liveReply.reasoning) && <DateLiveReply live={liveReply} light={light} />}
                    </div>
                </div>
            </div>

            {showRerollSheet && <DateRerollSheet onCancel={() => setShowRerollSheet(false)} onReroll={note => void handleRerollClick(note)} />}

            {/* Input Layer */}
            <div className={`absolute inset-x-0 bottom-0 z-40 flex justify-center pointer-events-none transition-all duration-300 ${isTyping || showInputBox ? 'opacity-100' : 'opacity-0'}`}>
                {isTyping && !(liveReply && (liveReply.text || liveReply.reasoning)) && (
                    <div className="absolute bottom-1/2 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-auto">
                        <div className="bg-black/80 backdrop-blur-md px-6 py-3 rounded-full border border-white/20 shadow-2xl animate-pulse flex items-center gap-3">
                             <div className="flex gap-1.5"><div className="w-2 h-2 bg-white rounded-full animate-bounce"></div><div className="w-2 h-2 bg-white rounded-full animate-bounce delay-75"></div><div className="w-2 h-2 bg-white rounded-full animate-bounce delay-150"></div></div>
                             <span className="text-xs text-white font-bold tracking-widest uppercase">Typing...</span>
                        </div>
                    </div>
                )}
                {showInputBox && (
                    <div className={`date-input-bar w-[90%] min-w-0 max-w-lg backdrop-blur-xl rounded-2xl p-2 flex items-end gap-2 shadow-2xl animate-fade-in mb-8 pointer-events-auto ${light ? 'bg-stone-100 border border-stone-300' : 'bg-white/10 border border-white/20'}`} onClick={(e) => e.stopPropagation()}>
                        <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder={isTyping ? "等待回應..." : "輸入對話..."} disabled={isTyping} rows={1} className={`date-input min-w-0 flex-1 bg-transparent px-3 sm:px-4 py-3 outline-none font-light resize-none min-h-[3.5rem] max-h-36 overflow-y-auto overscroll-contain no-scrollbar leading-tight select-text ${light ? 'text-stone-800 placeholder:text-stone-400' : 'text-white placeholder:text-white/30'}`} autoFocus />
                        {(() => {
                            const retryText = pendingRetryText || getPendingReplyText(messages);
                            const canRetry = !input.trim() && !isTyping && !!retryText;
                            return (
                                <button
                                    onClick={handleSend}
                                    disabled={(!input.trim() && !canRetry) || isTyping}
                                    className="shrink-0 px-4 sm:px-6 bg-white text-black rounded-xl font-bold text-sm hover:bg-slate-200 disabled:opacity-50 transition-colors h-14 flex items-center justify-center"
                                >
                                    {canRetry ? '重試' : '發送'}
                                </button>
                            );
                        })()}
                    </div>
                )}
            </div>
            </div>

            {/* 換模型：跟聊天設定的「對話模型」同一個面板、同一個欄位，存了下一句就用新的 */}
            {showApiPanel && (
                <div className="absolute inset-0 z-[200] animate-slide-up bg-white flex flex-col">
                    <div className="shrink-0 flex items-center gap-3 px-4 pb-3 border-b border-slate-100" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                        <button onClick={() => setShowApiPanel(false)} aria-label="返回" className="p-2 -ml-2 text-slate-500 active:scale-95">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <div className="min-w-0">
                            <div className="text-sm font-bold text-slate-700">對話模型</div>
                            <div className="text-[11px] text-slate-400">見面跟私聊共用，存了下一句就生效</div>
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4" style={{ paddingBottom: 'calc(var(--safe-bottom) + 1rem)' }}>
                        <ChatApiSettingsPanel
                            char={char}
                            apiPresets={apiPresets || []}
                            onSave={(chatApi) => {
                                updateCharacter(char.id, { chatApi });
                                addToast(chatApi?.baseUrl ? `已換成 ${chatApi.model || '自訂模型'}` : '已改回跟隨全域 API', 'success');
                            }}
                        />
                    </div>
                </div>
            )}

            {/* Settings Overlay */}
            {showSettings && (
                <div className="absolute inset-0 z-[200] animate-slide-up bg-white">
                    <DateSettings char={char} onBack={() => setShowSettings(false)} />
                </div>
            )}

            <VoiceFavoriteActionSheet
                open={!!voiceFavoriteTarget}
                favorited={voiceFavoriteSaved}
                busy={voiceFavoriteBusy}
                title="見面語音"
                preview={voiceFavoriteTarget?.originalText}
                onToggle={() => void toggleDateVoiceFavorite()}
                onClose={() => { if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null); }}
            />

            <Modal isOpen={showEmotion} title={`${char.name}此刻的情緒${emotion ? '（這場故事）' : ''}`} onClose={() => setShowEmotion(false)}>
                <EmotionStatusPanel char={emotionChar} alwaysShow onUpdate={onEmotionChange} onClearBuffs={() => {
                    const cleared = { activeBuffs: [], buffInjection: '' };
                    if (onEmotionChange) onEmotionChange(cleared); else updateCharacter(char.id, cleared);
                    setShowEmotion(false);
                    addToast('情緒狀態已重置', 'info');
                }} />
            </Modal>

            {/* Exit Modal */}
            <Modal isOpen={showExitModal} title="暫時離開?" onClose={() => setShowExitModal(false)} footer={<div className="flex gap-3 w-full"><button onClick={() => setShowExitModal(false)} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">留在這裡</button><button onClick={handleExitClick} className="flex-1 py-3 bg-slate-800 text-white rounded-2xl font-bold">保存並退出</button></div>}>
                <div className="text-center text-slate-500 text-sm py-2 leading-relaxed">選擇“保存並退出”將保留當前對話進度。<br/>下次見面時，你可以選擇繼續話題。</div>
            </Modal>

            {/* Message Options Modal */}
            <Modal isOpen={modalType === 'options'} title="操作" onClose={() => setModalType('none')}>
                <div className="space-y-3">
                    <button onClick={() => {
                        if (selectedMessage) {
                            setIsBatchSelectMode(true);
                            setSelectedMsgIds(new Set([selectedMessage.id]));
                        }
                        setModalType('none');
                    }} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl">多選</button>
                    <button onClick={() => {
                        if (selectedMessage) {
                            const clean = selectedMessage.role === 'user'
                                ? cleanUserTextForDisplay(selectedMessage.content || '')
                                : parseDateBody(splitObserve(selectedMessage.content || '').rest).map(line => line.text).join('\n');
                            navigator.clipboard.writeText(clean).then(() => addToast('已複製', 'success')).catch(() => addToast('複製失敗', 'error'));
                        }
                        setModalType('none');
                    }} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl">複製文本</button>
                    <button onClick={() => { onEditMessage(selectedMessage!); setModalType('none'); }} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl">編輯內容</button>
                    <button onClick={() => { onDeleteMessage(selectedMessage!); setModalType('none'); }} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl">刪除記錄</button>
                </div>
            </Modal>
        </div>
    );
};

export default DateSession;
