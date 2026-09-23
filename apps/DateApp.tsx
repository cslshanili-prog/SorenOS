import { loadCharacterContextMessages } from '../utils/chatContextRange';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, Message, DateState, AppID } from '../types';
import { DatePrompts, ApiMessage } from '../utils/datePrompts';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import type { PipelineResult } from '../utils/memoryPalace/pipeline';
import { incrementDigestRound, runCognitiveDigestion } from '../utils/memoryPalace';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import DateSession from '../components/date/DateSession';
import DateSettings from '../components/date/DateSettings';
import { armDateResumeAttempt, clearDateResumeAttempt, takeCrashedDateResume } from '../utils/dateSessionRecovery';
import { BookOpen, Sparkle, CaretLeft, GearSix } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trimHistoryThrough } from '../utils/dateSessionHistory';
import { trackEvent } from '../utils/analytics';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import StoryTheater from '../components/date/story/StoryTheater';
import { dateLaunch } from '../utils/dateLaunch';
import { materializeVisionDescriptions } from '../utils/visionApi';
import { shareOrDownloadFile } from '../utils/shareExport';
import { buildInPersonContinueInstruction } from '../utils/meetingContinue';
import { resolveUserProfileForChar } from '../utils/userPersona';
import {
    advanceSARModuleAfterReply,
    createSARModuleEventMeta,
    createSARModuleSurfaceMeta,
    getSARModuleRuntimePlan,
    parseSARModuleReply,
} from '../utils/vrWorld/sarModuleRuntime';
import {
    buildDateHistoryGroups,
    formatDateHistoryDate,
    formatDateHistoryExport,
    formatDateHistoryTime,
    makeDateHistoryFileName,
    type DateHistoryGroup,
    type DateHistorySortOrder,
    type DateHistoryView,
} from '../utils/dateHistory';

const DateApp: React.FC = () => {
    const { closeApp, openApp, characters, activeCharacterId, setActiveCharacterId, apiConfig, addToast, updateCharacter, updateUserProfile, virtualTime, userProfile, userProfileBase, memoryPalaceConfig, dateAutoStartCharId, consumeDateAutoStart, characterGroups, groups, realtimeConfig } = useOS();

    // 是否由聊天「見面」按鈕進入：為真時，退出見面流程回到聊天而非見面選擇頁/桌面。
    // 用本地 state（而非 context）承載：DateApp 切走即卸載，標記隨之消失，不會洩漏到
    // 之後從桌面直接打開的見面會話裡。
    const [cameFromChat, setCameFromChat] = useState(false);
    const [meetSurface, setMeetSurface] = useState<'companion' | 'story'>(() => dateLaunch.peek()?.surface ?? 'companion');

    // 記憶宮殿（與聊天側共用同一套上下文：同 charId、同高水位線）
    // 見面流也需要在 AI 回覆後跑一次緩衝區檢查 + 自動歸檔，否則只有"讀"沒有"寫"。
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [memoryPalaceResult, setMemoryPalaceResult] = useState<PipelineResult | null>(null);
    const memoryPalaceStatusRef = useRef(memoryPalaceStatus);
    memoryPalaceStatusRef.current = memoryPalaceStatus;

    // characters ref：見面 hook 跑完後用戶可能已經在 MemoryPalaceApp 裡關掉了宮殿，
    // 直接閉包裡的 charForHook 是回覆開始時捕獲的，會讀到 stale memoryPalaceEnabled=true。
    const charactersRef = useRef(characters);
    charactersRef.current = characters;
    
    // Modes: 'select' -> 'peek' -> 'session' | 'settings' | 'history'
    const [mode, setMode] = useState<'select' | 'peek' | 'session' | 'settings' | 'history'>('select');
    // Track previous mode for Settings back navigation
    const [previousMode, setPreviousMode] = useState<'select' | 'peek'>('select');

    // 全局更新彈窗等入口可直接落到「劇情」。peek 讓首次渲染就顯示目標頁，
    // subscribe 則覆蓋 DateApp 已經打開的情況；應用後立即消費，絕不汙染下次普通打開。
    useEffect(() => {
        const applyLaunchIntent = (intent: { surface: 'companion' | 'story' }) => {
            setCameFromChat(false);
            setMode('select');
            setMeetSurface(intent.surface);
            dateLaunch.consume();
        };

        const initialIntent = dateLaunch.peek();
        if (initialIntent) applyLaunchIntent(initialIntent);
        return dateLaunch.subscribe(applyLaunchIntent);
    }, []);

    // 選擇頁分頁（6 個角色一頁，橫向翻頁）
    const SELECT_PAGE_SIZE = 6;
    const DATE_SESSION_MESSAGE_LIMIT = 220;
    const DATE_HISTORY_MESSAGE_LIMIT = 500;
    const pagerRef = useRef<HTMLDivElement>(null);
    const [selectPage, setSelectPage] = useState(0);
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // 選擇頁的分組篩選
    const onPagerScroll = () => {
        const el = pagerRef.current;
        if (!el || el.clientWidth === 0) return;
        const p = Math.round(el.scrollLeft / el.clientWidth);
        setSelectPage(prev => (prev === p ? prev : p));
    };
    const goSelectPage = (pi: number) => {
        const el = pagerRef.current;
        if (!el) return;
        el.scrollTo({ left: pi * el.clientWidth, behavior: 'smooth' });
    };

    const [peekStatus, setPeekStatus] = useState<string>('');
    const [peekLoading, setPeekLoading] = useState(false);
    
    // History State
    const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
    const [historyView, setHistoryView] = useState<DateHistoryView>('encounter');
    const [historySortOrder, setHistorySortOrder] = useState<DateHistorySortOrder>('newest');
    const [historyLoadLimit, setHistoryLoadLimit] = useState(DATE_HISTORY_MESSAGE_LIMIT);
    const [historyReachedEnd, setHistoryReachedEnd] = useState(false);
    const [historyBusy, setHistoryBusy] = useState(false);
    // History long-press context menu
    const [historyMenuMsg, setHistoryMenuMsg] = useState<Message | null>(null);
    const [historyMenuPos, setHistoryMenuPos] = useState<{x: number, y: number}>({x: 0, y: 0});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // History edit modal
    const [historyEditMsg, setHistoryEditMsg] = useState<Message | null>(null);
    const [historyEditContent, setHistoryEditContent] = useState('');
    
    // Resume Logic State
    const [pendingSessionChar, setPendingSessionChar] = useState<CharacterProfile | null>(null);

    // --- NEW: Editing State lifted to here for DB sync ---
    const [dateMessages, setDateMessages] = useState<Message[]>([]);
    // 閱讀模式「加載更早」用：當前查詢 limit 與「庫裡已經沒有更早的了」。
    const [dateLoadLimit, setDateLoadLimit] = useState(DATE_SESSION_MESSAGE_LIMIT);
    const [dateHistoryReachedEnd, setDateHistoryReachedEnd] = useState(false);
    const [hasSavedOpening, setHasSavedOpening] = useState(false);

    // Edit Modal State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editTargetMsg, setEditTargetMsg] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');

    const char = characters.find(c => c.id === activeCharacterId);
    // 見面跟隨「個人檔案 → 分角色身份指定」——見面跟私聊/查手機/記憶宮殿是同一種
    // "你與這個角色的關係"，不單獨開一套指定入口，避免同一個角色在不同場景裡認出不同的你。
    const dateUserProfile = useMemo(
        () => char ? resolveUserProfileForChar(userProfileBase, char.id) : userProfile,
        [char, userProfileBase, userProfile],
    );
    const historyGroups = useMemo(
        () => buildDateHistoryGroups(historyMessages, historyView, historySortOrder),
        [historyMessages, historyView, historySortOrder],
    );

    // 見面消息和普通聊天共用同一份歷史，也就是主動消息 2.0 雲端快照（fire_pack）的素材。
    // 每次落庫 / 刪改後打一次髒：中途殺 App 時這一場見面就不會在雲端整個丟掉，刪改過的
    // 內容也不會被角色到點又提一遍。快照裡的消息在上傳時從 DB 重讀，打髒本身很便宜。
    const markDateTurnDirty = (target = char) => {
        if (!target) return;
        markAmsgStateDirty({ char: target, userProfile: resolveUserProfileForChar(userProfileBase, target.id), groups, realtimeConfig });
    };

    const loadRecentDateMessages = async (charId: string, limit = DATE_SESSION_MESSAGE_LIMIT) => {
        return (await DB.getRecentMessagesByCharIdAndSource(charId, 'date', limit))
            .sort((a, b) => a.timestamp - b.timestamp);
    };

    // --- Data Loading ---
    const loadDateMessages = async (limit = dateLoadLimit) => {
        if (char) {
            // 見面記錄只取最近窗口，不再把該角色全部聊天 getAll 進內存。
            // TODO(date-assets): 後續把角色立繪/背景本體遷到 assets store 後，這裡還能再把 limit 放寬。
            const filtered = await loadRecentDateMessages(char.id, limit);
            setDateMessages(filtered);
            // 拿回來的比要的少 = 庫裡的見面記錄已經取完，閱讀模式不用再往前翻了。
            setDateHistoryReachedEnd(filtered.length < limit);
            
            // 檢查數據庫中是否已經包含當前的 peekStatus（通過內容比對），避免重複保存
            if (peekStatus && filtered.some(m => m.content === peekStatus && m.role === 'assistant')) {
                setHasSavedOpening(true);
            }
        }
    };

    useEffect(() => {
        if (char && mode === 'session') {
            // 進會話 / 換角色都從初始窗口重來。limit 必須顯式傳：setState 是異步的，
            // 靠 dateLoadLimit 閉包會讀到上一個角色翻開的深度，和重置後的 state 對不上。
            setDateLoadLimit(DATE_SESSION_MESSAGE_LIMIT);
            setDateHistoryReachedEnd(false);
            loadDateMessages(DATE_SESSION_MESSAGE_LIMIT);
        }
    }, [char, mode]);


    /** 閱讀模式要更早的記錄：limit 遞增重取（反向游標，limit 越大夠得越遠）。 */
    const handleLoadMoreDateHistory = async (nextLimit: number) => {
        setDateLoadLimit(nextLimit);
        await loadDateMessages(nextLimit);
    };

    // 見面「繼續上次」崩潰自愈：若上次恢復會話時把 iOS WebKit 內容進程撐崩了
    // (表現為反覆灰屏/白屏「此網頁反覆出現問題」，非可捕獲的 JS 異常)，那份重快照
    // 的哨兵會殘留到本次進見面。這裡檢出後丟棄有毒的 savedDateState（僅清恢復快照，
    // 消息歷史不動），避免用戶永久卡在閃退死循環裡。只在 DateApp 掛載時跑一次。
    useEffect(() => {
        const crashedCharId = takeCrashedDateResume();
        if (!crashedCharId) return;
        const crashed = characters.find(c => c.id === crashedCharId);
        trackEvent('检出见面存档崩溃并清理', { 处理结果: crashed?.savedDateState ? '已清理存档' : '无存档可清' });
        if (crashed?.savedDateState) {
            updateCharacter(crashedCharId, { savedDateState: undefined });
            addToast('上次見面異常退出，已清理存檔，可重新開始', 'info');
        }
    }, []); // 僅掛載時檢查一次

    // --- Navigation Helpers ---
    const handleBack = () => {
        if (mode === 'peek') {
            // 來自聊天：從感知頁退出直接回聊天，不落在見面選擇頁
            if (cameFromChat) { returnToChat(); return; }
            setMode('select');
            setPeekStatus('');
        } else if (mode === 'history') {
            setMode('select');
        } else closeApp();
    };

    const formatTime = () => `${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}`;

    // peek / send / reroll 共用的 LLM 調用（提示詞構建統一在 utils/datePrompts.ts）
    const callLLM = async (messages: ApiMessage[], temperature: number): Promise<string> => {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages,
                temperature,
                // max_tokens 是 Claude 原生 API 的必填字段；缺了它，糯米機/Csy 等
                // OpenAI→Claude 中轉會被上游打回，再包成 502 / bad_response_status_code。
                // 與私聊 (useChatAI.ts) 對齊，統一帶 8000。
                max_tokens: 8000,
                stream: apiConfig.stream ?? false,
            })
        });
        if (!response.ok) throw new Error(`API Error ${response.status}`);
        const data = await safeResponseJson(response);
        // 思考型渠道會把正文塞進 reasoning_content、content 留空——直接取 content
        // 會拿到空串且不報錯：感知頁黑屏卡死（無按鈕可退），會話裡則落庫空消息。
        const content = extractContent(data);
        if (!content) throw new Error('模型返回了空回覆，請重試或檢查渠道/模型設置');
        return content;
    };

    // --- Resume / Start Logic ---
    const handleCharClick = (c: CharacterProfile) => {
        if (c.savedDateState) {
            setPendingSessionChar(c);
        } else {
            startPeek(c);
        }
    };

    // 從聊天「見面」按鈕跳進來：等同於在選擇頁點擊該角色（有存檔則彈繼續/新開，否則直接感知）
    // 並記住「來自聊天」，退出見面時回到聊天。
    useEffect(() => {
        if (!dateAutoStartCharId) return;
        const target = characters.find(c => c.id === dateAutoStartCharId);
        consumeDateAutoStart();
        setCameFromChat(true);
        setMeetSurface('companion');
        if (target) handleCharClick(target);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dateAutoStartCharId]);

    // 退出見面流程：來自聊天則回聊天，否則回見面選擇頁/桌面（由調用方決定）
    const returnToChat = () => {
        setCameFromChat(false);
        openApp(AppID.Chat);
    };

    const handleResumeSession = () => {
        if (!pendingSessionChar) return;
        // 恢復嘗試開始前先武裝崩潰哨兵：若這份重快照在 iOS 上把內容進程撐崩，
        // 哨兵會殘留到下次進見面被檢出並清理（見掛載時的自愈 effect）。
        armDateResumeAttempt(pendingSessionChar.id);
        setActiveCharacterId(pendingSessionChar.id);
        setMode('session');
        setPendingSessionChar(null);
        addToast('已恢復上次進度', 'success');
        trackEvent('选择见面存档处理方式', { choice: 'resume' });
        trackEvent('恢复上次见面进度');
    };

    const handleStartNewSession = () => {
        if (!pendingSessionChar) return;
        // 新會話沒有恢復快照可重放，撤銷任何殘留哨兵。
        clearDateResumeAttempt();
        updateCharacter(pendingSessionChar.id, { savedDateState: undefined });
        trackEvent('选择见面存档处理方式', { choice: 'new' });
        trackEvent('见面存档选重新开始');
        startPeek(pendingSessionChar);
        setPendingSessionChar(null);
    };

    // --- 關鍵修復: 進入 Session 時立即歸檔開場白 ---
    const handleEnterSession = async () => {
        if (!char) return;

        // 1. 如果有開場白且未保存，立即保存到數據庫
        // 這確保了 user 發送第一句話時，AI 能在歷史記錄裡讀到這個開場
        // UPDATE: 添加 isOpening 標記，用於區分新會話
        if (peekStatus && !hasSavedOpening) {
            try {
                await DB.saveMessage({
                    charId: char.id,
                    role: 'assistant',
                    type: 'text',
                    content: peekStatus,
                    metadata: { source: 'date', isOpening: true } // Added Flag
                });
                setHasSavedOpening(true);
            } catch (e) {
                console.error("Failed to save opening", e);
                // 落庫失敗不能靜默：開場白進不了 DB，閱讀模式/見面記錄會缺這次開場，
                // 表現和「閱讀模式播舊劇情」一樣，讓用戶知道出了什麼事
                addToast('開場白保存失敗，本次開場可能不會出現在閱讀模式', 'error');
            }
        }

        // 2. 切換模式並刷新數據
        setMode('session');
        trackEvent('走过去开始见面会话');
        await loadDateMessages(DATE_SESSION_MESSAGE_LIMIT);
    };

    // --- Peek (Generation) Logic ---
    const startPeek = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setMode('peek');
        setPeekLoading(true);
        setPeekStatus('');
        setHasSavedOpening(false);
        trackEvent('进入见面感知页');

        try {
            const msgs = await loadCharacterContextMessages(c);
            const preparedMsgs = await materializeVisionDescriptions(msgs, apiConfig.visionApi);
            const emojis = await DB.getEmojis();
            const { messages } = DatePrompts.buildPeekPayload({
                char: c,
                // 這裡不能用上面的 dateUserProfile：c 是剛傳入的目標角色，setActiveCharacterId(c.id)
                // 還沒被 React 提交，char/dateUserProfile 這一輪渲染仍是切換前的舊值。
                userProfile: resolveUserProfileForChar(userProfileBase, c.id),
                allMsgs: preparedMsgs,
                emojis,
                useVisionDescriptions: apiConfig.visionApi?.enabled === true,
            });
            const content = await callLLM(messages, apiConfig.temperature ?? 0.85);
            setPeekStatus(content);

        } catch (e: any) {
            setPeekStatus(`(無法感知狀態: ${e.message})`);
        } finally {
            setPeekLoading(false);
        }
    };

    // 與聊天側 useChatAI 完全一致的 Memory Palace 後台流程：
    // 觸發緩衝區處理 + 自動歸檔（如開啟） + 50 輪認知消化。
    const runMemoryPalacePostHook = useCallback(async (charForHook: CharacterProfile) => {
        // 用 charactersRef 讀最新狀態，避免見面流程中用戶去 MemoryPalaceApp 關掉宮殿後
        // 這裡仍然按 charForHook 閉包裡的舊 enabled 觸發一次 LLM 總結
        const liveBefore = charactersRef.current.find(c => c.id === charForHook.id) || null;
        if (!liveBefore?.memoryPalaceEnabled) return;
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
        const mpLLM = (mpLLMConfigured?.baseUrl)
            ? mpLLMConfigured
            : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM.baseUrl) return;

        // charForHook 未必等於當前渲染的 char（回調可能在切換角色後才跑完），按它自己的 id 單獨解析
        const hookUserName = resolveUserProfileForChar(userProfileBase, charForHook.id).name;
        const recentMsgs = await DB.getRecentMessagesByCharId(charForHook.id, 50);
        try {
            const pipelineResult = await processNewMessagesWithAutoArchive(
                recentMsgs,
                charForHook.id,
                charForHook.name,
                mpEmb,
                mpLLM,
                hookUserName || '',
                false,
                (stage) => setMemoryPalaceStatus(stage),
            );

            // pipeline 跑的過程中用戶可能又關了宮殿，再 check 一次
            const liveAfter = charactersRef.current.find(c => c.id === charForHook.id) || null;
            if (!liveAfter?.memoryPalaceEnabled) return;

            if (pipelineResult && pipelineResult.stored > 0) {
                setMemoryPalaceResult(pipelineResult);
            }

            // 50 輪自動認知消化（與聊天側共享計數器，按 charId 持久化）
            const shouldAutoDigest = incrementDigestRound(charForHook.id);
            if (shouldAutoDigest) {
                setMemoryPalaceStatus(`${charForHook.name}閉上眼睛，開始整理內心…`);
                const persona = [liveAfter.systemPrompt || '', liveAfter.worldview || ''].filter(Boolean).join('\n');
                await runCognitiveDigestion(charForHook.id, charForHook.name, persona, mpLLM, false, hookUserName, mpEmb);
            }
        } catch (e: any) {
            console.error('❌ [DateApp MemoryPalace] 後台處理異常:', e?.message || e);
            addToast('記憶整理失敗', 'error');
        } finally {
            const current = memoryPalaceStatusRef.current;
            if (current && current.includes('完成')) {
                addToast(current, 'success');
            }
            setMemoryPalaceStatus('');
        }
    }, [memoryPalaceConfig, apiConfig, userProfileBase, updateCharacter, addToast]);

    // --- Session API Logic ---
    const handleSendMessage = async (text: string, kind?: 'continue'): Promise<string> => {
        if (!char) throw new Error("No char");
        const sarModulePlan = getSARModuleRuntimePlan(char, dateUserProfile);

        // 重發場景：如果 DB 裡最後一條已經是這條 user 消息（上一輪發送後 API 失敗 / 網絡抖動等），
        // 就跳過重複落庫，直接走 API。與 chat app 行為對齊，讓用戶按發送鍵即可重新觸發 LLM。
        const recentCheck = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', 1);
        const isRetry = recentCheck.length > 0
            && recentCheck[0].role === 'user'
            && recentCheck[0].content === text
            && recentCheck[0].metadata?.source === 'date';
        // API 中斷後的重試只會帶回顯示文本；從已落庫標記恢復“繼續”的完整語義。
        const isContinueTurn = kind === 'continue'
            || (isRetry && recentCheck[0].metadata?.meetingContinue === true);

        let userMessageId = isRetry ? recentCheck[0]?.id : undefined;
        if (!isRetry) {
            // 1. Save User Msg
            userMessageId = await DB.saveMessage({
                charId: char.id,
                role: 'user',
                type: 'text',
                content: text,
                metadata: { source: 'date', ...(isContinueTurn ? { meetingContinue: true } : {}) },
            });
            markDateTurnDirty(char);
        }

        // 2. Prepare Context
        // Re-fetch messages. Since we saved the opening in handleEnterSession,
        // 'allMsgs' will now correctly contain: [History..., Opening, UserMsg]
        const allMsgs = await loadCharacterContextMessages(char);
        const preparedAllMsgs = await materializeVisionDescriptions(allMsgs, apiConfig.visionApi);

        // Update local state for display
        setDateMessages(await loadRecentDateMessages(char.id));

        const emojis = await DB.getEmojis();
        const modelText = isContinueTurn
            ? buildInPersonContinueInstruction(dateUserProfile?.name, char.name)
            : text;
        const { messages } = await DatePrompts.buildSessionPayload({
            char,
            userProfile: dateUserProfile,
            allMsgs: preparedAllMsgs,
            emojis,
            userText: modelText,
            variant: 'send',
            useVisionDescriptions: apiConfig.visionApi?.enabled === true,
        });
        const rawContent = await callLLM(messages, apiConfig.temperature ?? 0.85);
        const parsed = parseSARModuleReply(rawContent, sarModulePlan);
        const sarModuleEvents = createSARModuleEventMeta(sarModulePlan);
        const userSurface = sarModulePlan.user?.phase === 'active' && parsed.userSurface
            ? createSARModuleSurfaceMeta(sarModulePlan.user, parsed.userSurface)
            : undefined;
        if (userMessageId && (sarModuleEvents.length > 0 || userSurface)) {
            await DB.updateMessageMetadata(userMessageId, previous => ({
                ...(previous || {}),
                ...(userSurface ? { sarModuleSurface: userSurface } : {}),
                ...(sarModuleEvents.length > 0 ? { sarModuleEvents } : {}),
            }));
        }
        const assistantSurface = sarModulePlan.character?.phase === 'active' && parsed.assistantSurface
            ? createSARModuleSurfaceMeta(sarModulePlan.character, parsed.assistantSurface)
            : undefined;

        // 3. Save AI Response
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: parsed.canonical, metadata: { source: 'date', ...(assistantSurface ? { sarModuleSurface: assistantSurface } : {}) } });
        if (sarModulePlan.character) {
            updateCharacter(char.id, previous => ({
                vrState: { ...(previous.vrState || { enabled: false, intervalMinutes: 120 }), sarModule: advanceSARModuleAfterReply(previous.vrState?.sarModule, sarModulePlan.character) },
            }));
        }
        if (sarModulePlan.user) {
            updateUserProfile(previous => ({
                vrState: { ...(previous.vrState || { enabled: false }), sarModule: advanceSARModuleAfterReply(previous.vrState?.sarModule, sarModulePlan.user) },
            }));
        }
        markDateTurnDirty(char);

        // Refresh local state
        setDateMessages(await loadRecentDateMessages(char.id));

        // Memory Palace 後台流程（不阻塞返回，與聊天側一致）
        runMemoryPalacePostHook(char);

        return parsed.assistantSurface || parsed.canonical;
    };

    const handleReroll = async (): Promise<string> => {
        if (!char || dateMessages.length === 0) throw new Error("No context");

        const lastMsg = dateMessages[dateMessages.length - 1];
        if (lastMsg.role !== 'assistant') throw new Error("Cannot reroll user message");

        // Keep the old reply until the replacement request succeeds.
        const allMsgs = await loadCharacterContextMessages(char);
        const validMsgs = allMsgs.filter(m => m.id !== lastMsg.id);
        const preparedValidMsgs = await materializeVisionDescriptions(validMsgs, apiConfig.visionApi);
        const emojis = await DB.getEmojis();

        // 重擲的是開場白（isOpening 錨點消息）：走感知同款 payload 重新生成開場。
        // 不能走下面的普通 reroll 路徑——開場白前面沒有觸發它的 user 消息。舊邏輯會
        // 先刪消息再報 "Context lost"（開場白被吞），即使上一條恰好是 user 僥倖續上，
        // 新消息也不帶 isOpening，閱讀模式會從上一次見面的開場開始切片，表現為
        // 「新見面只有立繪模式是新劇情，閱讀模式全是舊劇情」。
        if (lastMsg.metadata?.isOpening === true) {
            const { messages } = DatePrompts.buildPeekPayload({
                char,
                userProfile: dateUserProfile,
                allMsgs: preparedValidMsgs,
                emojis,
                useVisionDescriptions: apiConfig.visionApi?.enabled === true,
            });
            const content = await callLLM(messages, Math.max(apiConfig.temperature ?? 0.85, 0.9));
            // 生成成功後才動庫：先刪舊開場、再帶 isOpening 落新開場，請求失敗時原劇情不丟
            await DB.deleteMessage(lastMsg.id);
            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content, metadata: { source: 'date', isOpening: true } });
            markDateTurnDirty(char);
            trackEvent('重掷见面回复', { 目标: '开场白' });
            // 閱讀模式空會話時頂部渲染的開場 & 退出快照裡的 peekStatus 同步成新開場
            setPeekStatus(content);

            const freshMsgs = await DB.getMessagesByCharId(char.id, true);
            setDateMessages(freshMsgs.filter(m => m.metadata?.source === 'date').sort((a,b) => a.timestamp - b.timestamp));
            return content;
        }

        const validDateMsgs = preparedValidMsgs.filter(m => m.metadata?.source === 'date');
        const lastUserMsg = validDateMsgs[validDateMsgs.length - 1];
        if (!lastUserMsg || lastUserMsg.role !== 'user') throw new Error("Context lost");

        // Call API logic（與 handleSendMessage 共用 buildSessionPayload，只差 variant）
        // 歷史裁到被重擲的那一輪為止：見面回覆之後用戶又在普通聊天裡發過消息時，
        // validMsgs（全來源）的尾巴不是這條 date user，直接傳進去會把那條聊天消息當成
        // 「待重發的最後一條」砍掉，同時 date user 又被追加一次（丟一條、重一條）。
        const { messages } = await DatePrompts.buildSessionPayload({
            char,
            userProfile: dateUserProfile,
            allMsgs: trimHistoryThrough(preparedValidMsgs, lastUserMsg.id),
            emojis,
            userText: lastUserMsg.content,
            variant: 'reroll',
            useVisionDescriptions: apiConfig.visionApi?.enabled === true,
        });
        // Reroll 略調高溫度求多樣性，但絕不低於用戶配置的基線。
        const rawContent = await callLLM(messages, Math.max(apiConfig.temperature ?? 0.85, 0.9));
        const sarPlan = getSARModuleRuntimePlan(char, dateUserProfile);
        const parsed = parseSARModuleReply(rawContent, sarPlan);
        const sarModuleEvents = createSARModuleEventMeta(sarPlan);
        const userSurface = sarPlan.user?.phase === 'active' && parsed.userSurface
            ? createSARModuleSurfaceMeta(sarPlan.user, parsed.userSurface)
            : undefined;
        if (sarModuleEvents.length > 0 || userSurface) {
            await DB.updateMessageMetadata(lastUserMsg.id, previous => ({
                ...(previous || {}),
                ...(userSurface ? { sarModuleSurface: userSurface } : {}),
                ...(sarModuleEvents.length > 0 ? { sarModuleEvents } : {}),
            }));
        }
        const assistantSurface = sarPlan.character?.phase === 'active' && parsed.assistantSurface
            ? createSARModuleSurfaceMeta(sarPlan.character, parsed.assistantSurface)
            : undefined;

        // 生成成功後才刪舊回覆：以前先刪後調 API，請求一失敗上一條劇情就永久消失
        await DB.deleteMessage(lastMsg.id);
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: parsed.canonical, metadata: { source: 'date', ...(assistantSurface ? { sarModuleSurface: assistantSurface } : {}) } });
        markDateTurnDirty(char);
        trackEvent('重掷见面回复', { 目标: '回复' });

        // Sync
        setDateMessages(await loadRecentDateMessages(char.id));

        // Memory Palace 後台流程（Reroll 也算一輪新輸出）
        runMemoryPalacePostHook(char);

        return parsed.assistantSurface || parsed.canonical;
    };

    // --- Editing & Deletion ---
    // 刪改同樣要打髒（對齊 Chat.tsx 的同款處理器）：雲端快照裡帶著最近對話原文，
    // 不刷的話角色到點還會提起這條已經被刪掉 / 已經改過的消息。
    const handleDeleteMessage = async (msg: Message) => {
        await DB.deleteMessage(msg.id);
        setDateMessages(prev => prev.filter(m => m.id !== msg.id));
        markDateTurnDirty();
        trackEvent('删除一条见面消息');
    };

    const handleDeleteMessages = async (ids: number[]) => {
        if (ids.length === 0) return;
        await Promise.all(ids.map(id => DB.deleteMessage(id)));
        setDateMessages(prev => prev.filter(m => !ids.includes(m.id)));
        markDateTurnDirty();
        addToast(`已刪除 ${ids.length} 條記錄`, 'success');
        trackEvent('批量删除见面消息');
    };

    const confirmEditMessage = async () => {
        if (!editTargetMsg) return;
        await DB.updateMessage(editTargetMsg.id, editContent);
        setDateMessages(prev => prev.map(m => m.id === editTargetMsg.id ? { ...m, content: editContent } : m));
        markDateTurnDirty();
        setIsEditModalOpen(false);
        setEditTargetMsg(null);
        addToast('已修改', 'success');
        trackEvent('编辑一条见面消息');
    };

    // --- History Long Press ---
    const handleHistoryLongPressStart = useCallback((msg: Message, e: React.TouchEvent | React.MouseEvent) => {
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
        longPressTimer.current = setTimeout(() => {
            setHistoryMenuMsg(msg);
            setHistoryMenuPos({ x: clientX, y: clientY });
        }, 500);
    }, []);

    const handleHistoryLongPressEnd = useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);

    const handleHistoryDelete = async (msg: Message) => {
        await DB.deleteMessage(msg.id);
        setHistoryMessages(prev => prev.filter(m => m.id !== msg.id));
        markDateTurnDirty();
        setHistoryMenuMsg(null);
        addToast('已刪除', 'success');
        trackEvent('删除见面记录里的一条消息');
    };

    const handleHistoryEditOpen = (msg: Message) => {
        setHistoryEditMsg(msg);
        setHistoryEditContent(msg.content);
        setHistoryMenuMsg(null);
    };

    const handleHistoryEditConfirm = async () => {
        if (!historyEditMsg) return;
        await DB.updateMessage(historyEditMsg.id, historyEditContent);
        setHistoryMessages(prev => prev.map(m => (
            m.id === historyEditMsg.id ? { ...m, content: historyEditContent } : m
        )));
        markDateTurnDirty();
        setHistoryEditMsg(null);
        addToast('已修改', 'success');
        trackEvent('编辑见面记录里的一条消息');
    };

    const onExitSession = (finalState: DateState) => {
        // 用戶主動保存並退出 = 乾淨退出，撤銷恢復哨兵。
        clearDateResumeAttempt();
        if (char) {
            updateCharacter(char.id, { savedDateState: finalState });
            addToast('進度已保存', 'success');
        }
        // 來自聊天：退出見面回聊天
        if (cameFromChat) { returnToChat(); return; }
        setMode('select');
        setPeekStatus('');
        setHasSavedOpening(false);
    };

    // 從選擇頁直接進設置（不用先進見面再點菜單），改完立繪/觀測等即時生效
    const openSettings = (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setPreviousMode('select');
        setMode('settings');
        trackEvent('打开见面设置面板', { from: 'select' });
    };

    const openHistory = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        // 見面歷史按 source=date 獨立讀取，不受聊天側記憶宮殿高水位影響。
        const msgs = await DB.getRecentMessagesByCharIdAndSource(c.id, 'date', DATE_HISTORY_MESSAGE_LIMIT);
        setHistoryMessages(msgs);
        setHistoryView('encounter');
        setHistorySortOrder('newest');
        setHistoryLoadLimit(DATE_HISTORY_MESSAGE_LIMIT);
        setHistoryReachedEnd(msgs.length < DATE_HISTORY_MESSAGE_LIMIT);
        setMode('history');
        trackEvent('打开见面记录');
    };

    const handleLoadMoreHistory = async () => {
        if (!char || historyBusy || historyReachedEnd) return;
        const nextLimit = historyLoadLimit + DATE_HISTORY_MESSAGE_LIMIT;
        setHistoryBusy(true);
        try {
            const msgs = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', nextLimit);
            setHistoryMessages(msgs);
            setHistoryLoadLimit(nextLimit);
            setHistoryReachedEnd(msgs.length < nextLimit);
        } catch (error) {
            console.error('Load Earlier Date History Error', error);
            addToast('更早的見面記錄加載失敗', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    const exportHistoryGroups = async (groups: DateHistoryGroup[], scope: string) => {
        if (!char || groups.length === 0 || historyBusy) return;
        setHistoryBusy(true);
        try {
            const result = await shareOrDownloadFile({
                content: formatDateHistoryExport(char.name, groups, historyView),
                fileName: makeDateHistoryFileName(char.name, scope),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${char.name}的見面記錄`,
            });
            addToast(result === 'shared' ? '已打開分享面板' : '見面記錄已導出', 'success');
            trackEvent('导出见面记录', { 范围: scope, 整理方式: historyView === 'encounter' ? '按次' : '按日期' });
        } catch (error) {
            console.error('Export Date History Error', error);
            addToast('見面記錄導出失敗', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    const handleExportAllHistory = async () => {
        if (!char || historyBusy) return;
        setHistoryBusy(true);
        try {
            // 導出屬於用戶主動操作，可以完整掃描該角色消息索引；只收集 source=date，避免把圖片聊天讀進內存。
            const allDateMessages = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', Number.MAX_SAFE_INTEGER);
            const allGroups = buildDateHistoryGroups(allDateMessages, historyView, historySortOrder);
            if (allGroups.length === 0) {
                addToast('暫無可導出的見面記錄', 'info');
                return;
            }
            const result = await shareOrDownloadFile({
                content: formatDateHistoryExport(char.name, allGroups, historyView),
                fileName: makeDateHistoryFileName(char.name, `全部_${historyView === 'encounter' ? '按次' : '按日期'}`),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${char.name}的全部見面記錄`,
            });
            addToast(result === 'shared' ? '已打開分享面板' : '全部見面記錄已導出', 'success');
            trackEvent('导出全部见面记录', { 整理方式: historyView === 'encounter' ? '按次' : '按日期' });
        } catch (error) {
            console.error('Export All Date History Error', error);
            addToast('全部見面記錄導出失敗', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    // --- Render ---

    if (meetSurface === 'story' && mode === 'select' && !cameFromChat) {
        return <StoryTheater onSwitchCompanion={() => setMeetSurface('companion')} onClose={closeApp} />;
    }

    if (mode === 'select' || !char) {
        // 6 個角色一頁，橫向翻頁（先按分組篩選，再切頁）
        const selectChars = filterCharactersByGroup(characters, characterGroups, selectGroupId);
        const pages: CharacterProfile[][] = [];
        for (let i = 0; i < selectChars.length; i += SELECT_PAGE_SIZE) pages.push(selectChars.slice(i, i + SELECT_PAGE_SIZE));
        if (pages.length === 0) pages.push([]);
        // 淺色主題（參考「小屋 · 小小窩」房間）：薰衣草淺背景 + 柔星點 + 襯線標題 + 羅盤環角色卡
        const th = {
            pageBg: 'linear-gradient(180deg,#efe9f7 0%,#f4eff9 45%,#f7f2fb 100%)',
            stars: 'radial-gradient(1.5px 1.5px at 14% 16%,rgba(190,160,225,.45),transparent),radial-gradient(1px 1px at 80% 12%,rgba(220,190,235,.5),transparent),radial-gradient(1.5px 1.5px at 42% 28%,rgba(180,200,240,.4),transparent),radial-gradient(1px 1px at 86% 42%,rgba(200,175,230,.4),transparent),radial-gradient(1px 1px at 22% 66%,rgba(210,185,235,.35),transparent),radial-gradient(1px 1px at 66% 80%,rgba(200,210,240,.35),transparent)',
            title: '#6a5790', titleShadow: 'rgba(170,150,220,.4)', line: 'rgba(150,120,190,.5)',
            cardBorder: 'rgba(170,140,210,.3)', cardShadow: '0 8px 22px rgba(150,120,200,.18)',
            inner: 'rgba(170,140,210,.22)', gem: 'rgba(190,160,220,.85)',
            tick: 'rgba(170,140,210,.16)', halo: 'rgba(200,175,235,.3)',
            ring1: 'rgba(180,150,215,.5)', ring2: 'rgba(180,150,215,.25)', avGlow: 'rgba(190,160,235,.4)',
        };
        // 每張卡片按序循環的柔色底——粉/薰衣草/淺藍漸變（同小小窩淺色卡）
        const CARD_TINTS = [
            'linear-gradient(180deg,rgba(250,212,228,.85),rgba(242,228,246,.8))',
            'linear-gradient(180deg,rgba(232,228,248,.85),rgba(242,238,250,.8))',
            'linear-gradient(180deg,rgba(226,216,246,.85),rgba(238,230,249,.8))',
            'linear-gradient(180deg,rgba(212,230,247,.85),rgba(234,240,250,.8))',
            'linear-gradient(180deg,rgba(226,212,245,.85),rgba(238,228,249,.8))',
            'linear-gradient(180deg,rgba(234,231,242,.88),rgba(242,240,247,.82))',
        ];
        return (
            <div className="h-full w-full relative overflow-hidden flex flex-col font-light" style={{ background: th.pageBg }}>
                {/* 柔星點氛圍 */}
                <div className="absolute inset-0 pointer-events-none opacity-70" style={{ backgroundImage: th.stars }} />

                {/* 頂欄 + 標題 */}
                <div className="relative z-10 shrink-0" style={{ paddingTop: 'max(1.25rem, var(--safe-top))' }}>
                    <div className="relative flex items-center justify-center px-5 pt-2">
                        <button onClick={() => { if (cameFromChat) { returnToChat(); } else { closeApp(); } }}
                                className="absolute left-4 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all"
                                style={{ color: '#8f7bb5', background: 'rgba(255,255,255,0.6)', boxShadow: '0 2px 8px rgba(150,120,200,0.15)' }}>
                            <CaretLeft size={19} weight="bold" />
                        </button>
                        <div className="text-center">
                            <h1 className="text-[26px] tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: th.title, textShadow: `0 2px 18px ${th.titleShadow}` }}>選擇見面對象</h1>
                            <div className="flex items-center justify-center gap-2 mt-1.5">
                                <span className="h-px w-10" style={{ background: `linear-gradient(90deg,transparent,${th.line})` }} />
                                <span className="text-[9px] tracking-[0.4em] font-bold" style={{ color: 'rgba(150,120,190,0.75)' }}>✦ CHOOSE CHARACTER ✦</span>
                                <span className="h-px w-10" style={{ background: `linear-gradient(270deg,transparent,${th.line})` }} />
                            </div>
                        </div>
                    </div>
                    <div className='mx-auto mt-4 mb-3 grid w-[min(18rem,calc(100%-2.5rem))] grid-cols-2 rounded-xl bg-white/45 p-1 shadow-sm'>
                        <button className='rounded-lg bg-white py-2 text-xs font-bold text-[#715d99] shadow-sm'>陪伴</button>
                        <button onClick={() => setMeetSurface('story')} className='rounded-lg py-2 text-xs font-bold text-[#8f7bb5]'>劇情</button>
                    </div>
                    {/* 分組篩選（沒建分組時不渲染）。切組後回到第一頁 */}
                    <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                        value={selectGroupId}
                        onChange={(id) => { setSelectGroupId(id); setSelectPage(0); pagerRef.current?.scrollTo({ left: 0 }); }}
                        className="px-4 mb-3" />
                </div>

                {/* 分頁卡片區 */}
                {selectChars.length === 0 ? (
                    <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'rgba(150,120,190,0.7)' }}>
                        <Sparkle size={40} weight="light" />
                        <span className="text-xs tracking-wider">{characters.length ? '該分組下沒有角色' : '還沒有可見面的角色'}</span>
                    </div>
                ) : (
                    <div ref={pagerRef} onScroll={onPagerScroll}
                         className="relative z-10 flex-1 min-h-0 flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
                         style={{ scrollSnapType: 'x mandatory' }}>
                        {pages.map((page, pi) => (
                            <div key={pi} className="w-full shrink-0 snap-start h-full overflow-y-auto no-scrollbar px-5 pt-4">
                                <div className="grid grid-cols-2 gap-4 pb-6">
                                    {page.map((c, idx) => {
                                        const tint = CARD_TINTS[(pi * SELECT_PAGE_SIZE + idx) % CARD_TINTS.length];
                                        return (
                                        <div key={c.id} onClick={() => handleCharClick(c)}
                                             className="group relative rounded-2xl px-3 pt-8 pb-5 flex flex-col items-center active:scale-95 transition-all overflow-hidden"
                                             style={{ background: tint, border: `1px solid ${th.cardBorder}`, boxShadow: th.cardShadow }}>
                                            {/* 內描框 + 四角寶石 */}
                                            <div className="absolute inset-[7px] rounded-xl pointer-events-none" style={{ border: `1px solid ${th.inner}` }} />
                                            <span className="absolute top-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute top-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute bottom-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute bottom-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            {/* 在線徽標 */}
                                            <div className="absolute top-2.5 left-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full z-10"
                                                 style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid rgba(120,200,160,0.4)', boxShadow: '0 1px 4px rgba(120,90,170,0.12)' }}>
                                                <span className="relative flex h-1.5 w-1.5">
                                                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                                                </span>
                                                <span className="text-[8px] font-bold text-emerald-600 tracking-wider">在線</span>
                                            </div>
                                            {/* 設置 / 記錄（豎排） */}
                                            <div className="absolute top-2 right-2 flex flex-col gap-1 z-20">
                                                <button onClick={(e) => { e.stopPropagation(); openSettings(c); }} title="佈置場景 / 設定立繪 / 觀測"
                                                        className="w-7 h-7 rounded-lg text-purple-500 flex items-center justify-center active:scale-90 transition-all"
                                                        style={{ background: 'rgba(255,255,255,0.88)', boxShadow: '0 1px 5px rgba(120,90,170,0.2)' }}>
                                                    <GearSix size={15} weight="fill" />
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); openHistory(c); }} title="見面記錄"
                                                        className="w-7 h-7 rounded-lg text-purple-500 flex items-center justify-center active:scale-90 transition-all"
                                                        style={{ background: 'rgba(255,255,255,0.88)', boxShadow: '0 1px 5px rgba(120,90,170,0.2)' }}>
                                                    <BookOpen size={15} weight="fill" />
                                                </button>
                                            </div>
                                            {/* 頭像 + 羅盤環 + 雙層環 + 光暈 */}
                                            <div className="relative w-[92px] h-[92px] flex items-center justify-center mt-1">
                                                <div className="absolute w-[124px] h-[124px] rounded-full" style={{ background: `repeating-conic-gradient(from 0deg, ${th.tick} 0deg 2.4deg, transparent 2.4deg 9deg)`, WebkitMaskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)', maskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)' }} />
                                                <div className="absolute w-[110px] h-[110px] rounded-full" style={{ background: `radial-gradient(circle, ${th.halo}, transparent 62%)` }} />
                                                <div className="absolute inset-[8px] rounded-full" style={{ border: `1px solid ${th.ring1}` }} />
                                                <div className="absolute inset-[12px] rounded-full" style={{ border: `1px solid ${th.ring2}` }} />
                                                <div className="w-[70px] h-[70px] rounded-full overflow-hidden" style={{ boxShadow: `0 0 18px ${th.avGlow}` }}>
                                                    <TokenImg value={c.avatar} className="w-full h-full object-cover" alt={c.name} />
                                                </div>
                                                {c.savedDateState && (
                                                    <div title="有存檔" className="absolute bottom-0 right-1.5 w-[22px] h-[22px] rounded-full flex items-center justify-center" style={{ background: '#fbbf24', boxShadow: '0 1px 5px rgba(180,120,20,0.4)' }}>
                                                        <Sparkle size={12} weight="fill" className="text-white" />
                                                    </div>
                                                )}
                                            </div>
                                            {/* 名字 + 簡介 */}
                                            <span className="mt-3 text-[14px] font-semibold tracking-wide truncate max-w-full" style={{ color: '#4b3b6b', fontFamily: `'Noto Serif SC',serif` }}>{c.name}</span>
                                            <span className="mt-0.5 text-[10px] truncate max-w-full" style={{ color: c.description ? 'rgba(120,95,160,0.78)' : 'rgba(150,130,185,0.6)' }}>{c.description || '走過去見 ta'}</span>
                                        </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* 頁碼點 */}
                {pages.length > 1 && (
                    <div className="relative z-10 shrink-0 flex justify-center items-center gap-2 py-3">
                        {pages.map((_, pi) => (
                            <button key={pi} onClick={() => goSelectPage(pi)} aria-label={`第 ${pi + 1} 頁`}
                                    className="h-2 rounded-full transition-all"
                                    style={{ width: pi === selectPage ? 24 : 8, background: pi === selectPage ? '#a78bd6' : 'rgba(170,140,210,0.35)' }} />
                        ))}
                    </div>
                )}

                <Modal isOpen={!!pendingSessionChar} title="發現進度" onClose={() => { setPendingSessionChar(null); if (cameFromChat) returnToChat(); }} footer={<div className="flex gap-3 w-full"><button onClick={handleStartNewSession} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">新的見面</button><button onClick={handleResumeSession} className="flex-1 py-3 bg-green-500 text-white rounded-2xl font-bold shadow-lg shadow-green-200">繼續上次</button></div>}>
                    <div className="text-center text-slate-500 text-sm py-4">檢測到 {pendingSessionChar?.name} 有未結束的見面。<br/><span className="text-xs text-slate-400 mt-2 block">(存檔時間: {pendingSessionChar?.savedDateState?.timestamp ? new Date(pendingSessionChar.savedDateState.timestamp).toLocaleString() : 'Unknown'})</span></div>
                </Modal>
            </div>
        );
    }

    if (mode === 'history') {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light" onClick={() => historyMenuMsg && setHistoryMenuMsg(null)}>
                <div className="border-b border-slate-200 bg-white sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-16 flex items-center justify-between px-4">
                        <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-slate-100"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                        <div className="text-center min-w-0">
                            <div className="font-bold text-slate-700">見面記錄</div>
                            <div className="text-[10px] text-slate-400 truncate max-w-36">{char.name}</div>
                        </div>
                        <button
                            onClick={(event) => { event.stopPropagation(); handleExportAllHistory(); }}
                            disabled={historyBusy || historyMessages.length === 0}
                            className="text-xs font-bold text-blue-500 px-2 py-2 -mr-2 rounded-lg hover:bg-blue-50 disabled:opacity-40"
                        >
                            導出全部
                        </button>
                    </div>
                    <div className="px-4 pb-3 flex items-center gap-2">
                        <div className="flex-1 p-1 rounded-xl bg-slate-100 flex">
                            <button
                                onClick={() => setHistoryView('encounter')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${historyView === 'encounter' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
                            >按次</button>
                            <button
                                onClick={() => setHistoryView('date')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${historyView === 'date' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
                            >按日期</button>
                        </div>
                        <button
                            onClick={() => setHistorySortOrder(order => order === 'newest' ? 'oldest' : 'newest')}
                            className="h-9 px-3 rounded-xl border border-slate-200 bg-white text-[11px] font-bold text-slate-500 whitespace-nowrap"
                            title="切換排序方向"
                        >
                            {historySortOrder === 'newest' ? '新 → 舊' : '舊 → 新'}
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-20">
                    {historyGroups.length === 0 ? <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2"><BookOpen size={48} className="opacity-50" /><span className="text-xs">暫無見面記錄</span></div> : historyGroups.map((group) => (
                        <div key={group.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                            <div className="bg-slate-50 px-4 py-3 border-b border-slate-100 flex gap-3 justify-between items-center">
                                <div className="min-w-0">
                                    <div className="text-xs font-bold text-slate-600 tracking-wide truncate">
                                        {historyView === 'encounter' ? formatDateHistoryTime(group.startAt, true) : formatDateHistoryDate(group.startAt)}
                                    </div>
                                    <div className="text-[10px] text-slate-400 mt-1">
                                        {historyView === 'encounter'
                                            ? (group.hasOpeningAnchor ? '一次完整見面' : '舊記錄 · 按日期兼容整理')
                                            : (group.encounterCount > 0 ? `${group.encounterCount} 次開場` : '舊記錄')}
                                        {' · '}{group.messages.length} 句
                                    </div>
                                </div>
                                <button
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        exportHistoryGroups([group], `${historyView === 'encounter' ? '本次' : '當天'}_${group.dateKey}`);
                                    }}
                                    disabled={historyBusy}
                                    className="shrink-0 text-[11px] font-bold text-blue-500 bg-blue-50 px-3 py-1.5 rounded-full disabled:opacity-40"
                                >導出{historyView === 'encounter' ? '本次' : '當天'}</button>
                            </div>
                            <div className="p-4 space-y-4">
                                {group.messages.map(m => {
                                    const text = (m.content || '').replace(/\[.*?\]/g, '').trim();
                                    return (
                                        <div
                                            key={m.id}
                                            className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} select-none`}
                                            onTouchStart={(e) => handleHistoryLongPressStart(m, e)}
                                            onTouchEnd={handleHistoryLongPressEnd}
                                            onTouchMove={handleHistoryLongPressEnd}
                                            onMouseDown={(e) => handleHistoryLongPressStart(m, e)}
                                            onMouseUp={handleHistoryLongPressEnd}
                                            onMouseLeave={handleHistoryLongPressEnd}
                                            onContextMenu={(e) => { e.preventDefault(); setHistoryMenuMsg(m); setHistoryMenuPos({ x: e.clientX, y: e.clientY }); }}
                                        >
                                            <div className={`max-w-[90%] text-sm leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'text-slate-500 text-right italic' : 'text-slate-800'}`}>
                                                {m.role === 'user' ? <span className="bg-slate-100 px-3 py-2 rounded-xl rounded-tr-none inline-block">{text}</span> : <span>{text || '(無內容)'}</span>}
                                            </div>
                                            <div className="text-[9px] text-slate-300 mt-1 px-1">{formatDateHistoryTime(m.timestamp)}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                    {!historyReachedEnd && historyMessages.length > 0 && (
                        <button
                            onClick={handleLoadMoreHistory}
                            disabled={historyBusy}
                            className="w-full py-3 rounded-2xl border border-slate-200 bg-white text-xs font-bold text-slate-500 disabled:opacity-50"
                        >
                            {historyBusy ? '正在加載…' : '加載更早的見面記錄'}
                        </button>
                    )}
                </div>

                {/* Long-press context menu */}
                {historyMenuMsg && (
                    <div
                        className="fixed z-50 bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden animate-fade-in"
                        style={{ top: Math.min(historyMenuPos.y, window.innerHeight - 120), left: Math.min(historyMenuPos.x, window.innerWidth - 140) }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => handleHistoryEditOpen(historyMenuMsg)}
                            className="w-full px-5 py-3 text-sm text-left text-slate-700 hover:bg-slate-50 active:bg-slate-100 flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" /></svg>
                            編輯
                        </button>
                        <div className="border-t border-slate-100" />
                        <button
                            onClick={() => handleHistoryDelete(historyMenuMsg)}
                            className="w-full px-5 py-3 text-sm text-left text-red-500 hover:bg-red-50 active:bg-red-100 flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                            刪除
                        </button>
                    </div>
                )}

                {/* History edit modal */}
                <Modal isOpen={!!historyEditMsg} title="編輯消息" onClose={() => setHistoryEditMsg(null)} footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setHistoryEditMsg(null)} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">取消</button>
                        <button onClick={handleHistoryEditConfirm} className="flex-1 py-3 bg-blue-500 text-white rounded-2xl font-bold shadow-lg shadow-blue-200">保存</button>
                    </div>
                }>
                    <textarea
                        value={historyEditContent}
                        onChange={(e) => setHistoryEditContent(e.target.value)}
                        className="w-full h-48 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-300"
                    />
                </Modal>
            </div>
        );
    }

    if (mode === 'peek') {
        return (
            <div className="h-full w-full bg-black relative flex flex-col font-sans overflow-hidden">
                <div className="pt-24 flex flex-col items-center z-10 shrink-0">
                     <div className="text-xs font-mono text-neutral-500 mb-2 tracking-[0.2em] font-medium">{virtualTime.day.toUpperCase()} {formatTime()}</div>
                     <h2 className="text-4xl font-light text-white tracking-[0.3em] uppercase">{char.name}</h2>
                </div>
                {peekLoading && (
                    <div className="flex-1 flex flex-col items-center justify-center -mt-20 z-10"><div className="w-12 h-[1px] bg-neutral-800 mb-12"></div><div className="w-[1px] h-12 bg-gradient-to-b from-transparent via-white to-transparent animate-pulse mb-6"></div><p className="text-sm font-light text-neutral-500 italic tracking-widest">正在感知...</p></div>
                )}
                {!peekLoading && peekStatus && (
                    <div className="flex-1 min-h-0 flex flex-col px-8 pb-10 z-10 animate-fade-in">
                        <div className="flex-1 overflow-y-auto no-scrollbar mb-8 mask-image-gradient pt-8"><div className="min-h-full flex flex-col justify-center"><p className="text-neutral-300 text-[15px] leading-8 tracking-wide text-justify font-light select-none whitespace-pre-wrap">{peekStatus}</p></div></div>
                        <div className="shrink-0 flex flex-col items-center gap-6">
                             <div className="w-full flex gap-3">
                                 {/* 修改這裡：調用 handleEnterSession 確保開場白被保存 */}
                                 <button onClick={handleEnterSession} className="flex-1 h-14 bg-white text-black rounded-full font-bold tracking-[0.1em] text-sm shadow-[0_0_20px_rgba(255,255,255,0.1)] active:scale-95 transition-transform hover:bg-neutral-200">走過去 (Approach)</button>
                                 <button onClick={() => { trackEvent('重新感知一次角色状态'); startPeek(char); }} className="w-14 h-14 bg-neutral-800 text-white rounded-full flex items-center justify-center border border-neutral-700 shadow-lg active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg></button>
                             </div>
                             <div className="flex flex-col items-center gap-3 text-[10px] text-neutral-600 font-medium tracking-wider"><button onClick={() => { setPreviousMode('peek'); setMode('settings'); trackEvent('打开见面设置面板', { from: 'peek' }); }} className="hover:text-neutral-400 transition-colors">佈置場景 / 設定立繪</button><button onClick={handleBack} className="hover:text-neutral-400 transition-colors">悄悄離開</button></div>
                        </div>
                    </div>
                )}
                {/* 兜底：感知結束但 peekStatus 為空（歷史上模型空回覆會走到這）——
                    以前這裡什麼都不渲染，頁面只剩角色名的純黑屏，連退出按鈕都沒有 */}
                {!peekLoading && !peekStatus && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-8 -mt-20 z-10 animate-fade-in">
                        <p className="text-sm font-light text-neutral-500 italic tracking-widest">未能感知到 {char.name} 的狀態</p>
                        <button onClick={() => { trackEvent('重新感知一次角色状态'); startPeek(char); }} className="h-12 px-10 bg-white text-black rounded-full font-bold tracking-[0.1em] text-sm active:scale-95 transition-transform hover:bg-neutral-200">重新感知</button>
                        <button onClick={handleBack} className="text-[10px] text-neutral-600 font-medium tracking-wider hover:text-neutral-400 transition-colors">悄悄離開</button>
                    </div>
                )}
            </div>
        );
    }

    if (mode === 'settings') {
        return <DateSettings char={char} onBack={() => setMode(previousMode)} />;
    }

    if (mode === 'session') {
        return (
            <>
                <DateSession
                    char={char}
                    userProfile={dateUserProfile}
                    messages={dateMessages}
                    peekStatus={peekStatus}
                    initialState={char.savedDateState}
                    onSendMessage={handleSendMessage}
                    onReroll={handleReroll}
                    onExit={onExitSession}
                    onEditMessage={(msg) => { setEditTargetMsg(msg); setEditContent(msg.content); setIsEditModalOpen(true); }}
                    onDeleteMessage={handleDeleteMessage}
                    onDeleteMessages={handleDeleteMessages}
                    onSettings={() => {}} // Removed parent state change, DateSession handles it internally now
                    onLoadMoreHistory={handleLoadMoreDateHistory}
                    historyLoadLimit={dateLoadLimit}
                    historyReachedEnd={dateHistoryReachedEnd}
                />

                {/* 記憶整理中 — 頂部浮動膠囊（與聊天側外觀一致） */}
                {memoryPalaceStatus && (
                    <div
                        className="absolute top-[76px] left-1/2 z-[150] animate-fade-in"
                        style={{ transform: 'translateX(-50%)', pointerEvents: 'none', willChange: 'transform, opacity' }}
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
                                {char.name}正在沉思
                            </span>
                            <span className="text-[10px] text-slate-400 truncate">{memoryPalaceStatus}</span>
                        </div>
                    </div>
                )}

                {/* 記憶整理結果 — 彈窗 */}
                {memoryPalaceResult && (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                        style={{ pointerEvents: 'all', background: 'rgba(15,23,42,0.55)' }}
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
                                        {memoryPalaceResult.batches.filter(b => !b.ok).map(b => `第 ${b.index} 批失敗`).join(', ')}
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
                                    const roomLabel = getRoomLabel(m.room as any, dateUserProfile?.name) || meta.label;
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

                {/* Global Message Edit Modal for Session Mode */}
                <Modal isOpen={isEditModalOpen} title="編輯內容" onClose={() => setIsEditModalOpen(false)} footer={<><button onClick={() => setIsEditModalOpen(false)} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={confirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">保存</button></>}>
                    <textarea value={editContent} onChange={e => setEditContent(e.target.value)} className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed" />
                </Modal>
            </>
        );
    }

    return null;
};

export default DateApp;
