import { SAR_NPC_PREFERENCE_EVENT } from '../utils/vrWorld/sarNpcPreference';
import { closeSARFacilityGuide } from '../utils/vrWorld/sarFacilityGuides';
import { sarLaunch } from '../utils/sarUpdate';
import { trackSARFeature } from '../utils/sarAnalytics';
import { SARFamiliarityDialog } from './vrWorld/SARFamiliarityDialog';
import { flushFishingDeliveries } from '../utils/vrWorld/fishingDelivery';
import { flushMarketReceipts } from '../utils/vrWorld/fishingCharacter';
import { loadCharacterContextMessages } from '../utils/chatContextRange';
import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft, Plus, Trash, BookOpen, Planet, Clock, Play, CaretRight, X,
    UploadSimple, PencilSimple, FlipHorizontal, CaretLeft, Sparkle,
    CircleNotch, TextAa, Palette, Pause, MusicNotes, Queue, Question, Check, Gear, Package, Eye, EyeSlash,
    SpeakerHigh, SpeakerSlash, MagnifyingGlass, ShieldCheck, MagicWand,
} from '@phosphor-icons/react';
import TheaterPanel from './theater/TheaterPanel';
import { SARCaianDialogue, SARClubStage, SARUpdateModal } from './vrWorld/SARClubEvent';
import { SARGachaOverlay } from './vrWorld/SARGacha';
import { SARAssemblyCabinetOverlay } from './vrWorld/SARAssemblyCabinet';
import { SARModuleShopOverlay } from './vrWorld/SARModuleShop';
import { FishingMarketOverlay } from './vrWorld/FishingMarketOverlay';
import { SARHubPanels, type SARHubPanel } from './vrWorld/SARHubPanels';
const DinosaurGarden = React.lazy(() => import('./vrWorld/dinosaur/DinosaurGarden').then(m=>({default:m.DinosaurGarden})));
import { CreatorIframe, type ChibiResult } from '../components/Like520Event';
import { useMusic, type Song } from '../context/MusicContext';
import { DB } from '../utils/db';
import { LibraryView, NovelPreferenceModal } from './vrWorld/VRLibrary';
import { VRActivityPicker, VRActivityRestrictions } from './vrWorld/VRActivityPicker';
import type { VRSARActivity } from '../types';
import { gardenResidents } from '../utils/vrWorld/dinosaurGarden';
import { readFishingMarketState } from '../utils/vrWorld/fishingMarket';
import { readableNovels, readingPreferenceLabel } from '../utils/vrWorld/library';
import type { VRLibraryCategory } from '../types';
import { useResilientAssetUrl, attachAudioMirrorFallback } from '../utils/assetUrl';
import { VRScheduler, VR_FAIL_LIMIT } from '../utils/vrWorld/scheduler';
import { allowsAutomaticVR, joinVRState, isSARActivityOccupant } from '../utils/vrWorld/participation';
import { collectVRDiagnostics } from '../utils/vrWorld/diagnostics';
import { VR_ROOMS, getRoom, VR_DEFAULT_INTERVAL_MIN, SIGNAL_EPIGRAPH, signalActFor, signalActRanges, SIGNAL_POEMS_PER_BOOKLET, SIGNAL_EVENT_ENDED, SIGNAL_MEMORIAL_CLOSING } from '../utils/vrWorld/constants';
import { buildNovelAsync, groupAnnotationsBySeg, getBookmark } from '../utils/vrWorld/novel';
import { decodeBytes } from '../utils/vrWorld/decodeText';
import { extractPdfText, isPdfFile } from '../utils/pdfText';
import { stripLeakedAttrs } from '../utils/vrWorld/prompts';
import { PostOffice, MAX_LETTER_CHARS, exportIdentity, importIdentity, getAdminToken, setAdminToken, type RemoteReply, type RemoteLetterStat, type RemoteAdminLetter } from '../utils/vrWorld/postOffice';
import { Signal, getMyAuthorship, setSignalWhisper, hasSignalNoticeAck, ackSignalNotice, type SignalState } from '../utils/vrWorld/signal';
import type { SignalPoem, SignalBooklet } from '../types';
import { getVRApi, setVRApi, getVRApiLog, clearVRApiLog, type VRApiCall } from '../utils/vrWorld/vrApi';
import { safeResponseJson } from '../utils/safeApi';
import {
    patchSARClubState,
    readSARClubState,
    rewindSARIntro,
    SAR_CLUB_UPDATE_VERSION,
    sarRoomView, nextSARRoomView, SAR_ROOM_VIEW_ACTIONS,
    type SARRoomView,
    type SARClubState,
    type SARIntroReaction,
    type SARNpcPreference,
} from '../utils/vrWorld/sarClub';

const genLocalId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// 安全區單一來源：index.html :root 定義 --safe-top/--safe-bottom/--chrome-top，
// 由 utils/iosStandalone.ts 喂入 JS 探測值（iOS 全屏 PWA 下原生 env 偶發返回 0 時兜底）。
// 全屏浮層背景鋪滿屏幕，只用這些變量給頂/底「控件」讓位。
const VR_TOP = 'var(--chrome-top)';                            // 安全區 + SullyOS 狀態欄：全屏面板頂欄統一用它
const VR_SAFE_BOTTOM = 'var(--safe-bottom)';
const VR_ROOM_PANEL_TOP = 'calc(var(--chrome-top) + 3.75rem)'; // 房間內浮層從頂欄下方開始
// 底部額外留一點手勢餘量；iOS 全屏隱藏 home 條時也不讓交互區貼著物理底邊。
const VR_BOTTOM_TOUCH_GAP = '0.75rem';
// 底部內邊距 / 貼底定位統一用它：base + 安全區 + 手勢餘量。
const vrBottomPad = (base: string) => `calc(${base} + ${VR_SAFE_BOTTOM} + ${VR_BOTTOM_TOUCH_GAP})`;

// ── 郵局寄信「日額度」：純前端軟計數，給後端減負（不追求精準，清數據會重置）──
// 從首封開始計時的滾動窗口，窗口內封頂、過期自動歸零。兩個額度各自獨立。
// 投信：與後端對齊——5 封 / 5 小時（後端 PO_RATE_LETTERS=5、LETTERS_WINDOW_MS=5h，且按封數扣額度）。
const PO_SEND_QUOTA = { key: 'vr_po_send_quota', limit: 5, windowMs: 5 * 3600_000 };
// 回信：前端自定日額度（後端無每日上限，僅 60/分鐘防刷；前端更嚴是安全方向）。
const PO_REPLY_QUOTA = { key: 'vr_po_reply_quota', limit: 20, windowMs: 24 * 3600_000 };
type QuotaCfg = { key: string; limit: number; windowMs: number };
const charLen = (s: string) => [...(s || '')].length;
const readQuota = (q: QuotaCfg): { windowStart: number; count: number } => {
    try {
        const raw = JSON.parse(localStorage.getItem(q.key) || 'null');
        if (raw && typeof raw.windowStart === 'number' && typeof raw.count === 'number'
            && Date.now() - raw.windowStart < q.windowMs) return raw;
    } catch { /* ignore */ }
    return { windowStart: 0, count: 0 };
};
const bumpQuota = (q: QuotaCfg, n: number) => {
    const cur = readQuota(q);
    const windowStart = cur.windowStart || Date.now();
    try { localStorage.setItem(q.key, JSON.stringify({ windowStart, count: cur.count + n })); } catch { /* ignore */ }
};
const quotaResetHours = (windowStart: number, windowMs: number) =>
    windowStart ? Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 3600_000)) : Math.ceil(windowMs / 3600_000);

/** 氣泡/動態裡去掉開頭多餘的"自己名字"主語（角色播報本就該省略主語）。 */
const stripSelfName = (text: string | undefined, name: string | undefined): string => {
    if (!text) return '';
    if (!name) return text;
    const t = text.replace(/^\s+/, '');
    if (t.startsWith(name)) {
        const rest = t.slice(name.length).replace(/^[\s，,、：:·\-—]*/, '');
        if (rest) return rest;
    }
    return text;
};
import type { CharacterProfile, UserProfile, VRWorldNovel, VRNovelAnnotation, VRCardMeta, VRRoomId, VRMusicRoomState, CharPlaylistSong, VRGuestbookState, VRGuestbookMessage, VRLetter, ApiPreset, APIConfig } from '../types';

// ============ chibi 形象解析（vrState.chibi → 立繪 → 頭像） ============
import { getChibi } from '../utils/vrWorld/chibi';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';
import { formatHours } from '../utils/format';
import TokenImg from '../components/os/TokenImg';

type Tab = 'world' | 'sar' | 'library' | 'settings' | 'api';

interface FeedItem {
    msgId: number; charId: string; charName: string; avatar: string;
    timestamp: number; meta: VRCardMeta; content: string;
    hidden: boolean; // 對 AI 上下文不可見（歸檔隱藏起點之前 / 記憶宮殿高水位之前）
}

// 每個房間的 chibi 站位（百分比座標，底對齊）
const ROOM_SLOTS: Record<VRRoomId, { x: number; y: number }[]> = {
    library:   [{ x: 24, y: 72 }, { x: 50, y: 78 }, { x: 74, y: 70 }, { x: 38, y: 64 }, { x: 62, y: 64 }],
    music:     [{ x: 30, y: 74 }, { x: 55, y: 78 }, { x: 72, y: 70 }, { x: 45, y: 66 }],
    guestbook: [{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 73, y: 74 }, { x: 40, y: 68 }],
    gym:       [{ x: 26, y: 74 }, { x: 50, y: 80 }, { x: 74, y: 74 }, { x: 38, y: 66 }, { x: 62, y: 66 }],
    postoffice:[{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 72, y: 72 }, { x: 42, y: 68 }],
    theater:   [{ x: 30, y: 80 }, { x: 70, y: 80 }, { x: 50, y: 84 }, { x: 40, y: 72 }, { x: 60, y: 72 }],
    signal:    [{ x: 26, y: 78 }, { x: 52, y: 80 }, { x: 74, y: 76 }, { x: 40, y: 70 }, { x: 62, y: 70 }],
    sar:       [{ x: 24, y: 76 }, { x: 50, y: 80 }, { x: 74, y: 74 }, { x: 38, y: 68 }, { x: 62, y: 68 }],
    cafe:      [{ x: 30, y: 74 }, { x: 54, y: 78 }, { x: 70, y: 72 }],
};

const IDLE_QUIPS: Record<VRRoomId, string[]> = {
    library: ['翻著書頁…', '這本還挺好看', '噓，安靜', '又是看書的一天'],
    music: ['隨節奏輕晃', '這首單曲循環', '戴上耳機', '調一下音量'],
    guestbook: ['寫點什麼呢', '路過留個名', '看看牆上的話', '嗯…'],
    gym: ['活動一下', '再來一組！', '伸個懶腰', '熱身中'],
    postoffice: ['給誰寫封信呢', '封口、寄出', '翻翻信格', '寫點心裡話'],
    theater: ['對台詞…', '再走一遍', '背詞中', '候場'],
    signal: ['接一句…', '在想下一句', '讀牆上的詩', '滋啦——信號'],
    sar: ['看看推演機', '模塊說明書…', '去釣魚嗎', '活動記錄中'],
    cafe: ['', '', '', ''],
};

const VRWorldApp: React.FC = () => {
    const { closeApp, characters, characterGroups, updateCharacter, addToast, registerBackHandler, userProfile, updateUserProfile, apiPresets, apiConfig, groups, realtimeConfig, memoryPalaceConfig } = useOS();
    useEffect(() => {
        const flush = () => { void flushFishingDeliveries(characters).then(() => flushMarketReceipts(characters)).catch(() => {}); };
        flush();
        window.addEventListener('vr-fishing-market-updated', flush);
        return () => window.removeEventListener('vr-fishing-market-updated', flush);
    }, [characters]);

    const userName = userProfile?.name || '我';
    const [tab, setTab] = useState<Tab>(() => sarLaunch.peek() ? 'sar' : 'world');
    useEffect(() => { sarLaunch.consume(); }, []);
    const [novels, setNovels] = useState<VRWorldNovel[]>([]);
    const [feed, setFeed] = useState<FeedItem[]>([]);
    const [poBadge, setPoBadge] = useState<{ toSend: number; toCollect: number }>({ toSend: 0, toCollect: 0 });
    const [loading, setLoading] = useState(true);

    // 郵局徽標：本地待寄出/待發送 + 後端待收取的回信（best-effort 探測）
    const refreshPoBadge = useCallback(async () => {
        try {
            const letters = await DB.getVRLetters();
            const toSend = letters.filter(l =>
                (l.box === 'outbox' && l.status === 'queued') ||
                (l.box === 'inbox' && l.replyStatus === 'queued')
            ).length;
            let toCollect = 0;
            const sentIds = new Set(letters.filter(l => l.box === 'outbox' && l.status === 'sent' && l.remoteId).map(l => l.remoteId!));
            if (sentIds.size > 0) {
                try {
                    const replies = await PostOffice.fetchReplies();
                    toCollect = new Set(replies.filter(r => sentIds.has(r.letter_id)).map(r => r.letter_id)).size;
                } catch { /* 離線/未配置：忽略，只顯示本地待辦 */ }
            }
            setPoBadge({ toSend, toCollect });
        } catch { /* ignore */ }
    }, []);

    const [enterRoom, setEnterRoom] = useState<VRRoomId | null>(null);
    const [readerNovel, setReaderNovel] = useState<VRWorldNovel | null>(null);
    const [readerJump, setReaderJump] = useState<{ novel: VRWorldNovel; seg: number } | null>(null);
    const [showUpload, setShowUpload] = useState(false);
    const [chibiEditChar, setChibiEditChar] = useState<CharacterProfile | null>(null);
    const [chibiEditUser, setChibiEditUser] = useState(false); // 用戶本人捏 chibi
    const [showHelp, setShowHelp] = useState(false);
    const [sarState, setSarState] = useState<SARClubState>(() => readSARClubState());
    useEffect(() => {
        const sync = () => { const next = readSARClubState(); setSarState(next); if (next.npcPreference === 'hide') { setFamiliarity(null); setShowSarDialogue(false); setShowSarRewindConfirm(false); } };
        const storage = (event: StorageEvent) => { if (!event.key || event.key === 'vr_sar_club_state_v1') sync(); };
        window.addEventListener(SAR_NPC_PREFERENCE_EVENT, sync); window.addEventListener('storage', storage);
        return () => { window.removeEventListener(SAR_NPC_PREFERENCE_EVENT, sync); window.removeEventListener('storage', storage); };
    }, []);
    const [sarPromptStep, setSarPromptStep] = useState<'update' | 'preference' | null>(() =>
        readSARClubState().npcPreference ? null : 'update');
    const [worldPage, setWorldPage] = useState<0 | 1>(0);
    const [showSarDialogue, setShowSarDialogue] = useState(false);
    const [familiarity, setFamiliarity] = useState<{npc:'caian'|'aiven';sceneId?:string}|null>(null);
    const [showSarGacha, setShowSarGacha] = useState(false);
    const [showSarCabinet, setShowSarCabinet] = useState(false);
    const [showSarModuleShop, setShowSarModuleShop] = useState(false);
    const [sarHubPanel, setSarHubPanel] = useState<SARHubPanel | null>(null);
    const sarHubBack = useRef<(() => boolean) | null>(null);
    const [showFishingMarket, setShowFishingMarket] = useState<'water' | 'board' | 'garden' | 'sell' | null>(null);
    const [sarModuleTargetCharId, setSarModuleTargetCharId] = useState<string | null>(null);
    const [showSarRewindConfirm, setShowSarRewindConfirm] = useState(false);
    const [incomingSarModule, setIncomingSarModule] = useState<{ charId: string; charName: string; moduleTitle: string } | null>(null);
    const sarHandledThisSession = useRef(false);
    useEffect(() => { if (tab === 'sar') trackSARFeature('room'); }, [tab]);
    useEffect(() => { if (showSarDialogue || familiarity) trackSARFeature(familiarity?.sceneId ? 'replay' : 'dialogue'); }, [showSarDialogue, familiarity]);
    useEffect(() => { if (showSarGacha) trackSARFeature('gacha'); }, [showSarGacha]);
    useEffect(() => { if (showSarCabinet) trackSARFeature('cabinet'); }, [showSarCabinet]);
    useEffect(() => { if (showSarModuleShop) trackSARFeature('modules'); }, [showSarModuleShop]);
    useEffect(() => { if (sarHubPanel) trackSARFeature(sarHubPanel); }, [sarHubPanel]);
    useEffect(() => { if (showFishingMarket) trackSARFeature(showFishingMarket === 'sell' ? 'water' : showFishingMarket); }, [showFishingMarket]);
    // 啟用流程：設定 chibi 後回調啟用
    const [pendingEnable, setPendingEnable] = useState<string | null>(null);
    const [libraryCategories, setLibraryCategories] = useState<VRLibraryCategory[]>([]);
    const [uploadCategoryId, setUploadCategoryId] = useState<string | undefined>();
    const [readingPreferenceCharId, setReadingPreferenceCharId] = useState<string | null>(null);
    const readingPreferenceChar = useMemo(
        () => characters.find(char => char.id === readingPreferenceCharId) || null,
        [characters, readingPreferenceCharId],
    );

    useEffect(() => {
        const onInstalled = (event: Event) => {
            const detail = (event as CustomEvent<{ charId?: string; charName?: string; moduleTitle?: string }>).detail;
            if (!detail?.charId || !detail.charName || !detail.moduleTitle) return;
            setIncomingSarModule({ charId: detail.charId, charName: detail.charName, moduleTitle: detail.moduleTitle });
        };
        window.addEventListener('sar-module-installed-on-user', onInstalled);
        return () => window.removeEventListener('sar-module-installed-on-user', onInstalled);
    }, []);

    // 初次進入彼方：自動彈出玩法說明（看過一次後不再自動彈）
    useEffect(() => {
        // 新版 SAR 選擇優先展示；本次選完先讓用戶進入 SAR，通用玩法說明留到下次進入。
        if (sarPromptStep || sarHandledThisSession.current) return;
        try {
            if (!localStorage.getItem('vr_help_seen')) {
                setShowHelp(true);
                localStorage.setItem('vr_help_seen', '1');
            }
        } catch { /* ignore */ }
    }, [sarPromptStep]);

    const chooseSarNpcPreference = useCallback((preference: SARNpcPreference) => {
        sarHandledThisSession.current = true;
        const next = patchSARClubState({
            npcPreference: preference,
            updateSeenVersion: SAR_CLUB_UPDATE_VERSION,
        });
        setSarState(next);
        setSarPromptStep(null);
        trackEvent('选择彼方活动室NPC', { preference });
        if (preference === 'show') {
            setTab('sar');
        }
    }, []);

    const changeSarNpcPreference = useCallback((preference: SARNpcPreference) => {
        const next = patchSARClubState({ npcPreference: preference, updateSeenVersion: SAR_CLUB_UPDATE_VERSION });
        setSarState(next);
        trackEvent('切换彼方活动室NPC', { preference });
        if (preference === 'show') {
            setTab('sar');
            addToast?.('凱恩與艾文已來到活動室', 'success');
        } else {
            setShowSarDialogue(false);
            addToast?.('NPC 與相關內容已關閉，進度已保留', 'success');
        }
    }, [addToast]);

    const completeSarIntro = useCallback((reaction?: SARIntroReaction) => {
        const next = patchSARClubState({ caianMet: true, introReaction: reaction });
        setSarState(next);
        setShowSarDialogue(false);
        trackEvent('完成凯恩初次见面', { reaction: reaction || 'unknown' });
    }, []);

    const rewindSarIntro = useCallback(() => {
        const next = rewindSARIntro();
        setSarState(next);
        setShowSarDialogue(false);
        setShowSarRewindConfirm(false);
        trackEvent('回档凯恩初次见面');
        if (next.npcPreference === 'show') {
            setTab('sar');
            addToast?.('已回檔至與凱恩初次見面前', 'success');
        } else {
            addToast?.('劇情已回檔；重新顯示 NPC 後即可重看', 'success');
        }
    }, [addToast]);

    // 網頁遊戲驗證鉤子：彼方是 DOM 場景而非 canvas，仍暴露當前可交互狀態供自動化讀取。
    useEffect(() => {
        if (showFishingMarket || sarHubPanel || familiarity) return; // 子水域擁有自己的遊戲時鐘與驗證狀態。
        const target = window as Window & {
            render_game_to_text?: () => string;
            advanceTime?: (ms: number) => void;
        };
        const renderState = () => JSON.stringify({
            mode: 'vr-world',
            coordinateSystem: 'DOM viewport; origin top-left; x right; y down',
            tab,
            loading,
            room: enterRoom,
            overlays: {
                sarUpdate: sarPromptStep,
                caianDialogue: showSarDialogue,
                sarGacha: showSarGacha,
                sarCabinet: showSarCabinet,
                sarModuleShop: showSarModuleShop,
                fishingMarket: showFishingMarket,
                help: showHelp,
            },
            sar: {
                npcPreference: sarState.npcPreference,
                caianMet: sarState.caianMet,
                labelsHidden: !!sarState.labelsHidden,
                roomView: sarRoomView(sarState),
                worldPage,
            },
        });
        const advanceTime = (_ms: number) => { /* DOM 事件沒有獨立遊戲時鐘 */ };
        target.render_game_to_text = renderState;
        target.advanceTime = advanceTime;
        return () => {
            if (target.render_game_to_text === renderState) delete target.render_game_to_text;
            if (target.advanceTime === advanceTime) delete target.advanceTime;
        };
    }, [familiarity, sarHubPanel, tab, loading, enterRoom, sarPromptStep, showSarDialogue, showSarGacha, showSarCabinet, showSarModuleShop, showFishingMarket, showHelp, sarState, worldPage]);

    const loadNovels = useCallback(async () => {
        const [books, categories] = await Promise.all([DB.getVRNovels(), DB.getVRLibraryCategories()]);
        setNovels(books); setLibraryCategories(categories);
    }, []);
    const loadFeed = useCallback(async () => {
        const items: FeedItem[] = [];
        for (const c of characters) {
            // 彼方動態取數走 getVRCardsByCharId：全量撈該角色的 vr_card，不受"最近 N 條窗口"、
            // 記憶宮殿高水位線（mp_lastMsgId_<charId>）、歸檔隱藏起點（hideBeforeMessageId）影響。
            // 這些機制只管「LLM 上下文能不能看到」——而彼方動態是用戶自己的瀏覽界面，
            // 只要消息還在 IndexedDB 裡就該一直能看到：
            //   · 記憶宮殿後台向量化推高水位 → 動態不該突然清零；
            //   · 角色記憶歸檔把舊聊天標記為"對 AI 隱藏" → 這些動態依舊存在，用戶仍要能回看；
            //   · 聊天攢多了把舊 vr_card 擠出最近窗口 → 不該因此從動態流消失。
            // （清空聊天會真刪消息，刪掉就沒了——那是預期行為，邏輯不變。）
            const msgs = await DB.getVRCardsByCharId(c.id);
            // 可見性與實際發送的自適應/手動範圍保持一致。
            const visibleIds = new Set((await loadCharacterContextMessages(c)).map(message => message.id));
            for (const m of msgs) {
                // 用戶在留言簿的發言會廣播進每個角色的 vr_card（供 LLM 上下文用），
                // 但它不是"角色自己的動態"——不進動態流，也不當作 chibi 氣泡。
                if (!m.metadata?.userBoardPost) {
                    items.push({ msgId: m.id, charId: c.id, charName: c.name, avatar: c.avatar, timestamp: m.timestamp, meta: m.metadata as VRCardMeta, content: m.content, hidden: !visibleIds.has(m.id) });
                }
            }
        }
        items.sort((a, b) => b.timestamp - a.timestamp);
        setFeed(items.slice(0, 50));
    }, [characters]);

    const reloadAll = useCallback(async () => {
        // Background refresh must not unmount the library and reset its filter/selection.
        // Initial loading is already true until the first load finishes.
        await Promise.all([loadNovels(), loadFeed()]);
        setLoading(false);
    }, [loadNovels, loadFeed]);

    useEffect(() => { void reloadAll(); void refreshPoBadge(); }, [reloadAll, refreshPoBadge]);
    useEffect(() => {
        const handler = () => { void reloadAll(); void refreshPoBadge(); };
        window.addEventListener('vr-session-done', handler);
        return () => window.removeEventListener('vr-session-done', handler);
    }, [reloadAll, refreshPoBadge]);
    // 離開房間（可能在郵局操作過）後刷新徽標
    useEffect(() => { if (enterRoom === null) void refreshPoBadge(); }, [enterRoom, refreshPoBadge]);

    // 最近一條動態（按角色）
    const latestByChar = useMemo(() => {
        const map: Record<string, FeedItem> = {};
        for (const f of feed) if (!map[f.charId]) map[f.charId] = f;
        return map;
    }, [feed]);

    const occupantsByRoom = useMemo(() => {
        const map: Record<string, CharacterProfile[]> = {};
        for (const c of characters) {
            if (c.vrState?.enabled) {
                const room = c.vrState.currentRoom || 'library';
                if(room!=='sar'||isSARActivityOccupant(c))(map[room] ||= []).push(c);
            }
        }
        // 用戶本人接入彼方且設了 chibi → 作為偽 occupant 站進自己掛著的房間
        const uv = userProfile?.vrState;
        if (uv?.enabled && uv.chibi?.img) {
            const room = uv.currentRoom || 'guestbook';
            const pseudo = { id: 'user', name: userName, avatar: userProfile?.avatar || '', vrState: { enabled: true, intervalMinutes: 0, currentRoom: room, sarActivity:/[钓釣][鱼魚]|垂[钓釣]/.test(uv.activity||'')?'fishing':undefined, chibi: uv.chibi, title: uv.title } } as unknown as CharacterProfile;
            (map[room] ||= []).push(pseudo);
        }
        return map;
    }, [characters, userProfile, userName]);

    const enabledCount = characters.filter(c => c.vrState?.enabled).length;

    // 返回鍵：有彈層先關彈層（閱讀器/房間/上傳/捏人），而不是直接退回桌面
    useEffect(() => registerBackHandler(() => {
        if (closeSARFacilityGuide()) return true;
        if (showSarRewindConfirm) { setShowSarRewindConfirm(false); return true; }
        if (familiarity && chibiEditUser) { setChibiEditUser(false); return true; }
        if (familiarity) { setFamiliarity(null); return true; }
        if (sarHubPanel) { if (!sarHubBack.current?.()) setSarHubPanel(null); return true; }
        if (showFishingMarket) { setShowFishingMarket(null); return true; }
        if (showSarModuleShop) { setShowSarModuleShop(false); setSarModuleTargetCharId(null); return true; }
        if (showSarCabinet) { setShowSarCabinet(false); return true; }
        if (showSarGacha) { setShowSarGacha(false); return true; }
        if (showSarDialogue) { setShowSarDialogue(false); return true; }
        if (readingPreferenceCharId) { setReadingPreferenceCharId(null); return true; }
        if (chibiEditChar) { setChibiEditChar(null); setPendingEnable(null); return true; }
        if (chibiEditUser) { setChibiEditUser(false); return true; }
        if (showUpload) { setShowUpload(false); return true; }
        if (readerJump) { setReaderJump(null); return true; }
        if (readerNovel) { setReaderNovel(null); return true; }
        if (enterRoom) { setEnterRoom(null); return true; }
        if (tab === 'sar') { setTab('world'); return true; }
        return false; // 無彈層 → 交回默認（關閉 App）
    }), [registerBackHandler, tab, familiarity, sarHubPanel, showFishingMarket, showSarModuleShop, showSarCabinet, showSarGacha, showSarRewindConfirm, showSarDialogue, readingPreferenceCharId, chibiEditChar, chibiEditUser, showUpload, readerJump, readerNovel, enterRoom]);

    // 從動態/批註點回原文：peek 模式打開閱讀器跳到該段，不動用戶書籤
    const jumpToAnnotation = useCallback((novelId: string | undefined, segIdx: number) => {
        if (!novelId) return;
        const n = novels.find(x => x.id === novelId);
        if (n) setReaderJump({ novel: n, seg: segIdx });
    }, [novels]);

    // 用戶在留言簿發言：落牆 + 以小卡片廣播給所有接入彼方的角色私聊
    const onUserBoardPost = useCallback(async (content: string, replyTo?: VRGuestbookMessage) => {
        const t = content.trim();
        if (!t) return;
        const id = `gb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        await DB.appendVRGuestbookMessages([{
            id,
            authorId: 'user',
            authorName: userName,
            content: t,
            replyToId: replyTo?.id,
            replyToName: replyTo?.authorName,
            createdAt: Date.now(),
        }]);
        const activity = replyTo
            ? `${userName} 在留言牆上回復 ${replyTo.authorName}：${t}`
            : `${userName} 在留言牆上發了：${t}`;
        const enabled = characters.filter(c => c.vrState?.enabled);
        for (const c of enabled) {
            await DB.saveMessage({
                charId: c.id, role: 'user', type: 'vr_card',
                content: `「彼方 · 留言簿」${activity}`,
                metadata: {
                    vrCard: true,
                    room: 'guestbook',
                    userBoardPost: true,
                    activity,
                    boardPost: t,
                    boardReplyToName: replyTo?.authorName,
                },
            } as any);
        }
        const action = replyTo ? `已回覆 ${replyTo.authorName}` : '已留言';
        addToast?.(enabled.length > 0 ? `${action}，並廣播給 ${enabled.length} 位接入角色` : action, 'success');
    }, [characters, userName, addToast]);

    // 用戶更新自己的彼方狀態：以行為卡片廣播給所有接入彼方的角色（機制同留言簿發言）
    const onUserVRBroadcast = useCallback(async (room: VRRoomId, activity: string) => {
        const roomName = VR_ROOMS.find(r => r.id === room)?.name || '彼方';
        const act = (activity || '').trim() || '在彼方里掛機放空';
        const line = `${userName} 現在在「彼方 · ${roomName}」：${act}`;
        const enabled = characters.filter(c => c.vrState?.enabled);
        for (const c of enabled) {
            await DB.saveMessage({
                charId: c.id, role: 'user', type: 'vr_card',
                content: `「彼方 · ${roomName}」${line}`,
                metadata: { vrCard: true, room, userBoardPost: true, activity: line },
            } as any);
        }
        addToast?.(enabled.length > 0 ? `已更新狀態，並廣播給 ${enabled.length} 位接入角色` : '已更新彼方狀態', 'success');
    }, [characters, userName, addToast]);

    const onDeleteFeed = useCallback(async (msgId: number) => {
        await DB.deleteMessage(msgId);
        setFeed(prev => prev.filter(f => f.msgId !== msgId));
    }, []);
    const onDeleteFeedMany = useCallback(async (ids: number[]) => {
        if (ids.length === 0) return;
        await DB.deleteMessages(ids);
        const idSet = new Set(ids);
        setFeed(prev => prev.filter(f => !idSet.has(f.msgId)));
        addToast?.(`已刪除 ${ids.length} 條彼方動態`, 'success');
    }, [addToast]);

    // 啟用某角色（帶 chibi 設定門檻）
    const enableChar = (char: CharacterProfile) => {
        const vrState = joinVRState(char.vrState);
        updateCharacter(char.id, { vrState });
        if (allowsAutomaticVR(vrState)) VRScheduler.start(char.id, vrState.intervalMinutes);
        else VRScheduler.stop(char.id);
        trackEvent('开启角色接入彼方', { action: 'enable' });
    };
    const requestEnable = (char: CharacterProfile) => {
        // 沒設過專屬 chibi → 先要求設定形象
        if (!char.vrState?.chibi?.img) {
            setPendingEnable(char.id);
            setChibiEditChar(char);
        } else {
            enableChar(char);
        }
    };

    return (
        <div className={`h-full w-full flex flex-col text-white relative overflow-hidden ${tab === 'sar' ? 'vr-sar-light' : ''}`}
            style={{ background: 'radial-gradient(130% 90% at 50% -15%, #20283f 0%, #141a2c 38%, #0a0d18 72%, #05060d 100%)' }}>
            <VRStyleTag />
            {/* 極光輝光 */}
            <div className="vr-aurora pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -top-1/4 -left-1/4 w-[80%] h-[60%] rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(120,150,230,.20), transparent 70%)', filter: 'blur(44px)', animation: 'vraurora 15s ease-in-out infinite' }} />
                <div className="absolute top-1/3 -right-1/4 w-[72%] h-[56%] rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(130,212,200,.15), transparent 70%)', filter: 'blur(50px)', animation: 'vraurora 19s ease-in-out infinite reverse' }} />
            </div>
            {/* 星塵 */}
            <div className="vr-stars pointer-events-none absolute inset-0"
                style={{ backgroundImage: 'radial-gradient(1px 1px at 18% 28%, rgba(255,255,255,.7), transparent), radial-gradient(1px 1px at 68% 18%, rgba(200,215,255,.6), transparent), radial-gradient(1px 1px at 82% 58%, rgba(230,220,255,.5), transparent), radial-gradient(1px 1px at 38% 72%, rgba(210,225,255,.5), transparent), radial-gradient(1.5px 1.5px at 52% 42%, rgba(255,255,255,.55), transparent)', animation: 'vrtwinkle 7s ease-in-out infinite' }} />

            {/* 頂欄 —— 外殼不再統一加 safe-area padding，這裡用 --chrome-top 讓開
                安全區 + SullyOS 狀態欄（時間/電量），退出鍵落在其下方，不再懟到時鐘上面。 */}
            {tab !== 'sar' && <>
            <div className="vr-topbar relative flex items-center gap-2.5 px-5 pb-2.5 shrink-0 z-10" style={{ paddingTop: VR_TOP }}>
                <button onClick={closeApp} className="p-1.5 -ml-1.5 rounded-full text-white/65 active:bg-white/10"><ArrowLeft size={21} weight="regular" /></button>
                <div className="flex items-center gap-2">
                    <Planet size={17} weight="light" className="text-indigo-100/90" style={{ filter: 'drop-shadow(0 0 7px rgba(165,185,255,.7))' }} />
                    <span className="vr-brand text-[22px] tracking-[0.42em] pl-1"
                        style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 300, background: 'linear-gradient(100deg,#dcd4ff,#fff,#c2ece6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', filter: 'drop-shadow(0 0 10px rgba(185,185,255,.35))' }}>彼方</span>
                </div>
                <span className="ml-auto text-[10.5px] tracking-[0.12em] text-white/45 font-light">
                    {enabledCount > 0 ? `${enabledCount} 位已接入` : '尚無人接入'}
                </span>
                <button onClick={() => setShowHelp(true)} aria-label="玩法說明"
                    className="ml-2.5 h-7 w-7 rounded-full flex items-center justify-center text-white/70 active:bg-white/10 shrink-0"
                    style={{ border: '1px solid rgba(255,255,255,.22)' }}>
                    <Question size={14} weight="bold" />
                </button>
            </div>

            {/* Tab — 髮絲下劃線 */}
            <div className="vr-tabs relative flex px-4 gap-3 sm:px-5 sm:gap-5 shrink-0 z-10 pb-px">
                {([['world', '世界'], ['sar', 'SAR'], ['library', '書庫'], ['settings', '角色接入'], ['api', 'API']] as [Tab, string][]).map(([t, label]) => (
                    <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => { setTab(t); if (t === 'sar' && userProfile?.vrState?.enabled) updateUserProfile({vrState:{...userProfile.vrState,currentRoom:'sar',activity:userProfile.vrState.activity || '在 SAR 活動室閒逛',updatedAt:Date.now()}}); trackEvent('切换彼方顶部标签', { tab: t }); }} className="relative shrink-0 whitespace-nowrap pb-2 text-[13.5px] tracking-[0.12em] sm:tracking-[0.22em] transition-colors"
                        style={{ fontFamily: `'Noto Serif SC',serif`, color: tab === t ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.38)' }}>
                        {label}
                        {tab === t && <span className="absolute -bottom-px left-1/2 -translate-x-1/2 w-5 h-px"
                            style={{ background: 'linear-gradient(90deg,transparent,rgba(205,205,255,.95),transparent)', boxShadow: '0 0 8px rgba(185,185,255,.85)' }} />}
                    </button>
                ))}
                <div className="absolute bottom-0 left-5 right-5 h-px" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.09),transparent)' }} />
            </div>

            </>}

            {/* 滾動容器不同於浮動 dock：滾到底時最後一條內容貼 viewport bottom = 屏幕底，必須 + safe-bottom 讓位 home 條，否則翻頁按鈕被壓（即原 #158 報的問題）。 */}
            <div className="vr-world-scroll relative flex-1 overflow-y-auto vr-reader-scroll px-4 z-10" style={{ paddingTop: '1rem', paddingBottom: `calc(1rem + ${VR_SAFE_BOTTOM})` }}>
                {loading ? (
                    <div className="text-center text-white/40 text-[13px] tracking-[0.2em] py-12" style={{ fontFamily: `'Noto Serif SC',serif` }}>載入彼方…</div>
                ) : tab === 'sar' ? (
                    <SARWorldPage occupants={occupantsByRoom.sar || []} npcEnabled={sarState.npcPreference === 'show'} caianMet={sarState.caianMet}
                        roomView={sarRoomView(sarState)} onToggleLabels={() => {const view=nextSARRoomView(sarRoomView(sarState));setSarState(patchSARClubState({roomView:view,labelsHidden:view==='text-hidden'}));}}
                        onTalkToCaian={() => sarState.caianMet ? setFamiliarity({npc:'caian'}) : setShowSarDialogue(true)} onTalkToAiven={() => setFamiliarity({npc:'aiven'})}
                        onSelectCharacter={char => { setSarModuleTargetCharId(char.id); setShowSarModuleShop(true); }}
                        onOpenGacha={() => setShowSarGacha(true)} onOpenCabinet={() => setShowSarCabinet(true)}
                        onOpenModuleShop={() => setShowSarModuleShop(true)} onOpenFishingMarket={setShowFishingMarket}
                        onOpenSarSettings={() => setSarHubPanel('settings')} onOpenSarWarehouse={() => setSarHubPanel('warehouse')}
                        onBackPage={() => setTab('world')}/>
                ) : tab === 'world' ? (
                    <WorldView occupantsByRoom={occupantsByRoom} feed={feed} novelCount={novels.length} poBadge={poBadge}
                        onEnterRoom={setEnterRoom} onGoLibrary={() => setTab('library')} onJump={jumpToAnnotation}
                        onDeleteFeed={onDeleteFeed} onDeleteFeedMany={onDeleteFeedMany}
                        roomPage={worldPage} onRoomPageChange={setWorldPage}/>
                ) : tab === 'library' ? (
                    <LibraryView novels={novels} categories={libraryCategories} characters={characters} onOpen={setReaderNovel}
                        onEdit={async edit => { await DB.editVRLibrary(edit); await loadNovels(); }}
                        onPreference={char => setReadingPreferenceCharId(char.id)}
                        onAdd={categoryId => { setUploadCategoryId(categoryId); setShowUpload(true); trackEvent('打开小说上架弹窗'); }}
                        onDelete={async (id) => { await DB.deleteVRNovel(id); await loadNovels(); addToast?.('已刪除', 'success'); }} />
                ) : tab === 'settings' ? (
                    <div className="space-y-3">
                        <UserVRPanel userProfile={userProfile} updateUserProfile={updateUserProfile}
                            onEditChibi={() => setChibiEditUser(true)} onBroadcast={onUserVRBroadcast} addToast={addToast} />
                        <SettingsView characters={characters} updateCharacter={updateCharacter} addToast={addToast}
                            novels={novels} onReload={reloadAll}
                            onRequestEnable={requestEnable} onEditChibi={setChibiEditChar}
                            onEditReadingPreference={(char) => setReadingPreferenceCharId(char.id)} />
                    </div>
                ) : (
                    <VRApiSettings apiPresets={apiPresets} chatApi={apiConfig} addToast={addToast} characters={characters} />
                )}
            </div>

            {sarHubPanel && userProfile && <SARHubPanels backRef={sarHubBack} panel={sarHubPanel} onClose={() => setSarHubPanel(null)} npcEnabled={sarState.npcPreference === 'show'} onChangeNpc={changeSarNpcPreference} caianMet={sarState.caianMet} onRequestRewind={()=>setShowSarRewindConfirm(true)} userProfile={userProfile} characters={characters} onOpenFamiliarity={(npc,sceneId)=>setFamiliarity({npc,sceneId})}/>}
            {familiarity && sarState.npcPreference === 'show' && <SARFamiliarityDialog key={`${familiarity.npc}:${familiarity.sceneId||'today'}`} {...familiarity} onClose={()=>setFamiliarity(null)} onEditUserChibi={()=>setChibiEditUser(true)} onSellFish={()=>{setFamiliarity(null);setShowFishingMarket('sell');}}/>}
            {/* 進入房間場景 */}
            {enterRoom && (
                <RoomScene roomId={enterRoom} occupants={occupantsByRoom[enterRoom] || []}
                    latestByChar={latestByChar} onClose={() => setEnterRoom(null)} onJump={jumpToAnnotation}
                    characters={characters} userName={userName} onUserBoardPost={onUserBoardPost} addToast={addToast}
                    onUseModule={(character) => {
                        setSarModuleTargetCharId(character.id);
                        setShowSarModuleShop(true);
                    }} />
            )}
            {sarPromptStep && (
                <SARUpdateModal step={sarPromptStep} onContinue={() => setSarPromptStep('preference')} onChoose={chooseSarNpcPreference} />
            )}
            {showSarDialogue && sarState.npcPreference === 'show' && (
                <SARCaianDialogue onClose={() => setShowSarDialogue(false)} onComplete={completeSarIntro} />
            )}
            {showSarGacha && <SARGachaOverlay onClose={() => setShowSarGacha(false)} />}
            {showSarCabinet && userProfile && (
                <SARAssemblyCabinetOverlay onClose={() => setShowSarCabinet(false)} characters={characters} characterGroups={characterGroups}
                    apiConfig={apiConfig} userProfile={userProfile} groups={groups} realtimeConfig={realtimeConfig} />
            )}
            {showSarModuleShop && (
                <SARModuleShopOverlay
                    npcEnabled={sarState.npcPreference === 'show'}
                    initialTargetCharacterId={sarModuleTargetCharId}
                    onClose={() => { setShowSarModuleShop(false); setSarModuleTargetCharId(null); }}
                />
            )}
            {showFishingMarket==='garden' && userProfile && <React.Suspense fallback={<div className="fixed inset-0 z-[390] grid place-items-center bg-[#f2eee3] text-[#65785c]">箱庭正在打開…</div>}><DinosaurGarden userProfile={userProfile} characters={characters} onClose={()=>setShowFishingMarket(null)} onCharacterTrip={async char=>{
                const {runVRSession}=await import('../utils/vrWorld/runSession');return runVRSession({char,characters,userProfile,groups,apiConfig,realtimeConfig,memoryPalaceConfig,updateCharacter,updateUserProfile,forcedRoom:'sar',forcedSARActivity:'garden',manual:true});
            }}/></React.Suspense>}
            {showFishingMarket && showFishingMarket!=='garden' && userProfile && (
                <FishingMarketOverlay apiConfig={apiConfig} key={showFishingMarket} initialEntry={showFishingMarket} characters={characters} userProfile={userProfile} realtimeConfig={realtimeConfig}
                    addToast={addToast} onClose={() => setShowFishingMarket(null)} onOpenGarden={()=>setShowFishingMarket('garden')}
                    onCharacterTrip={async (char, mode) => {
                        const { runVRSession } = await import('../utils/vrWorld/runSession');
                        return runVRSession({ char, characters, userProfile, groups, apiConfig, realtimeConfig, memoryPalaceConfig,
                            updateCharacter, updateUserProfile, forcedRoom: 'sar', forcedSARActivity: mode, manual: true });
                    }} />
            )}
            {incomingSarModule && (() => {
                const source = characters.find(character => character.id === incomingSarModule.charId);
                return (
                    <div className="fixed inset-0 z-[620] grid place-items-center bg-[#03070b]/75 px-8 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="角色對你裝載了模塊">
                        <style>{`@keyframes sar-user-approach{0%{opacity:0;transform:translateX(-52px) scale(.78)}65%{opacity:1;transform:translateX(0) scale(1.04)}100%{transform:none}}@keyframes sar-user-chip{0%{opacity:0;transform:translate(72px,-45px) rotate(45deg)}55%{opacity:1;transform:translate(28px,-10px) rotate(45deg)}100%{opacity:0;transform:translate(12px,0) rotate(45deg) scale(.3)}}`}</style>
                        <section className="w-full max-w-[330px] border border-emerald-100/20 bg-[#101b20] px-5 py-6 text-center shadow-[0_22px_80px_rgba(0,0,0,.65)]">
                            <div className="relative mx-auto grid h-36 w-48 place-items-center">
                                <div className="h-20 w-20 overflow-hidden rounded-full border border-emerald-100/30 bg-white/10 shadow-[0_0_36px_rgba(120,220,205,.2)]" style={{ animation: 'sar-user-approach .75s cubic-bezier(.2,.8,.2,1) both' }}>
                                    {source?.avatar ? <TokenImg value={source.avatar} alt={source.name} className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-2xl text-white/80">{incomingSarModule.charName[0]}</span>}
                                </div>
                                <span className="absolute grid h-8 w-8 place-items-center border border-emerald-100/50 bg-emerald-900/70 text-emerald-100" style={{ animation: 'sar-user-chip .95s cubic-bezier(.2,.8,.2,1) both', transform: 'rotate(45deg)' }}><Sparkle size={14} /></span>
                            </div>
                            <div className="text-[8px] tracking-[.28em] text-emerald-100/45">MODULE INSTALLED</div>
                            <h2 className="mt-2 text-[18px] tracking-[.08em] text-white/90" style={{ fontFamily: `'Noto Serif SC',serif` }}>{incomingSarModule.charName} 對你使用了模塊</h2>
                            <p className="mt-2 text-[11px] leading-relaxed text-white/55">「{incomingSarModule.moduleTitle}」將在接下來 5 次成功互動中改變你的外顯表達，真實意圖不會被覆蓋。</p>
                            <button type="button" className="mt-5 w-full border border-emerald-100/20 bg-emerald-300/10 py-2.5 text-[11px] text-emerald-50" onClick={() => setIncomingSarModule(null)}>我知道了</button>
                        </section>
                    </div>
                );
            })()}
            <ConfirmDialog zIndex={500} open={showSarRewindConfirm} title="回檔凱恩初次見面？"
                message="會清除這段初見劇情的完成記錄，讓凱恩重新出現感嘆號。更新公告和 NPC 顯示偏好不會改變。"
                confirmText="確認回檔" onConfirm={rewindSarIntro} onCancel={() => setShowSarRewindConfirm(false)} />
            {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
            {readingPreferenceChar && (
                <NovelPreferenceModal
                    key={readingPreferenceChar.id}
                    char={readingPreferenceChar}
                    novels={novels}
                    categories={libraryCategories}
                    onClose={() => setReadingPreferenceCharId(null)}
                    onSave={preference => {
                        updateCharacter(readingPreferenceChar.id, latest => ({
                            vrState: { ...(latest.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), ...preference },
                        }));
                        addToast?.('閱讀偏好已保存', 'success');
                        setReadingPreferenceCharId(null);
                    }}
                />
            )}
            {readerNovel && <ReaderModal novel={readerNovel} characters={characters} onClose={() => setReaderNovel(null)} />}
            {readerJump && <ReaderModal novel={readerJump.novel} characters={characters} initialSeg={readerJump.seg} peek onClose={() => setReaderJump(null)} />}
            {showUpload && (
                <UploadModal categories={libraryCategories} initialCategoryId={uploadCategoryId} onClose={() => setShowUpload(false)}
                    onCommit={async (novel) => {
                        await DB.saveVRNovel(novel); await loadNovels(); setShowUpload(false);
                        addToast?.(`《${novel.title}》已上架（${novel.segments.length} 段）`, 'success');
                    }}
                    onError={(msg) => addToast?.(msg, 'error')} />
            )}
            {chibiEditChar && (
                <ChibiEditor char={chibiEditChar}
                    onClose={() => { setChibiEditChar(null); setPendingEnable(null); }}
                    onSave={(chibi) => {
                        updateCharacter(chibiEditChar.id, { vrState: { ...(chibiEditChar.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), chibi } });
                        const wasPending = pendingEnable === chibiEditChar.id;
                        const charSnap = chibiEditChar;
                        setChibiEditChar(null);
                        if (wasPending) {
                            setPendingEnable(null);
                            const vrState = { ...joinVRState(charSnap.vrState), chibi };
                            updateCharacter(charSnap.id, { vrState });
                            if (allowsAutomaticVR(vrState)) VRScheduler.start(charSnap.id, vrState.intervalMinutes);
                            else VRScheduler.stop(charSnap.id);
                            addToast?.(`${charSnap.name} 已接入彼方`, 'success');
                            trackEvent('开启角色接入彼方', { action: 'enable' });
                        } else {
                            addToast?.('形象已更新', 'success');
                        }
                    }} />
            )}
            {chibiEditUser && (
                <div className="fixed inset-0 z-[600]"><UserChibiEditor userName={userName} existing={userProfile?.vrState?.chibi}
                    onClose={() => setChibiEditUser(false)}
                    onSave={(chibi) => {
                        const uv = userProfile?.vrState;
                        updateUserProfile({ vrState: { ...(uv || {}), enabled: !!uv?.enabled, chibi, updatedAt: Date.now() } });
                        setChibiEditUser(false);
                        addToast?.('形象已更新', 'success');
                    }} /></div>
            )}
        </div>
    );
};

// ============ 通用：CSS 房間場景背景 ============
const RoomBackground: React.FC<{ roomId: VRRoomId; className?: string }> = ({ roomId, className }) => {
    // 每個房間的插畫底圖（倉庫相對路徑，經 assetUrl 走多 CDN 鏡像兜底，見 utils/assetUrl.ts）。
    // 統一套一層"彼方"調性處理：降飽和 + 壓暗 + 輕柔化把圖推遠、弱化清晰度，
    // 再疊暗紫色洗 + 底部壓暗 + 暗角，讓五個房間是一套風格、且立繪能跳出來。
    const ROOM_BG: Partial<Record<VRRoomId, string>> = {
        library: 'img/BOOK.png',
        music: 'img/MUSIC.png',
        guestbook: 'img/PLAY.jpg',
        postoffice: 'img/post.png',
        gym: 'img/ALL.png',
        theater: 'img/SHOW.png',
    };
    // hook 必須無條件調用：無底圖的房間傳 null，返回空串走下面的分支。
    const bgUrl = useResilientAssetUrl(ROOM_BG[roomId] ?? null);
    if (bgUrl) {
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: '#0a0816' }}>
                {/* 底圖：降飽和/壓暗/輕柔化，並略放大避免柔化露邊 */}
                <div className="absolute inset-0" style={{
                    backgroundImage: `url(${bgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center',
                    filter: 'saturate(0.78) brightness(0.6) contrast(1.02) blur(1.3px)',
                    transform: 'scale(1.06)',
                }} />
                {/* 統一暗紫色洗 + 底部壓暗給立繪讓位 */}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(22,17,46,0.42) 0%, rgba(13,10,30,0.20) 42%, rgba(7,5,18,0.86) 100%)' }} />
                {/* 暗角 */}
                <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 92% at 50% 36%, transparent 40%, rgba(5,4,14,0.66) 100%)' }} />
                {/* 頂部一抹冷紫暈，呼應"彼方"外殼 */}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(96,72,180,0.16), transparent 28%)' }} />
            </div>
        );
    }
    if (roomId === 'signal') {
        // 信號墜落處：深空裡墜落的信號豎線 + 微弱底噪掃描線
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: 'linear-gradient(180deg,#0c1030 0%,#0a0a26 55%,#06061a 100%)' }}>
                {/* 墜落的信號豎線 */}
                <div className="absolute inset-0 flex justify-between px-4 opacity-60">
                    {Array.from({ length: 14 }).map((_, i) => (
                        <div key={i} className="w-px" style={{
                            height: `${30 + (Math.sin(i * 2.1) + 1) * 28}%`,
                            marginTop: `${(i % 3) * 6}%`,
                            background: 'linear-gradient(180deg, transparent, rgba(140,150,255,.55), transparent)',
                            animation: `vrwave ${1.6 + (i % 4) * 0.3}s ${i * 0.07}s ease-in-out infinite alternate`,
                        }} />
                    ))}
                </div>
                {/* 掃描橫紋（低電量底噪感） */}
                <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(180deg, rgba(180,190,255,.9) 0 1px, transparent 1px 4px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#0a0a24,#06061a)' }} />
            </div>
        );
    }
    if (roomId === 'library') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#3a2a1c 0%,#2a1d12 60%,#1c130b 100%)' }}>
                {/* 暖光窗 */}
                <div className="absolute top-[8%] right-[10%] w-20 h-28 rounded-md" style={{ background: 'linear-gradient(180deg,rgba(255,224,150,.55),rgba(255,180,90,.2))', boxShadow: '0 0 50px 18px rgba(255,200,120,.35)' }} />
                {/* 書架 */}
                <div className="absolute left-0 right-0 top-[20%] bottom-[28%]" style={{
                    backgroundImage: 'repeating-linear-gradient(90deg, #6b4a2b 0 4px, #8a5a30 4px 7px, #5a3a22 7px 14px, #9a6a3a 14px 18px, #4a2f1c 18px 22px)',
                    opacity: 0.85,
                }} />
                {/* 隔板 */}
                {[28, 44, 60].map(t => <div key={t} className="absolute left-0 right-0 h-1.5" style={{ top: `${t}%`, background: 'linear-gradient(180deg,#3a2615,#1c120a)' }} />)}
                {/* 地板 */}
                <div className="absolute left-0 right-0 bottom-0 h-[28%]" style={{ background: 'linear-gradient(180deg,#46301c,#241608)' }} />
            </div>
        );
    }
    if (roomId === 'music') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#2a1140 0%,#16082a 70%,#0a0418 100%)' }}>
                <div className="absolute inset-x-0 top-[18%] flex items-end justify-center gap-1 h-[40%] px-6 opacity-70">
                    {Array.from({ length: 22 }).map((_, i) => (
                        <div key={i} className="flex-1 rounded-t" style={{ height: `${30 + (Math.sin(i * 1.7) + 1) * 35}%`, background: 'linear-gradient(180deg,#ff7bd5,#7b5bff)', animation: `vrwave 1.2s ${i * 0.05}s ease-in-out infinite alternate` }} />
                    ))}
                </div>
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#1a0a30,#0a0418)' }} />
            </div>
        );
    }
    if (roomId === 'guestbook') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#103050 0%,#0a2038 70%,#06121f 100%)' }}>
                <div className="absolute left-0 right-0 top-[14%] bottom-[28%]" style={{ background: 'linear-gradient(180deg,rgba(120,200,255,.10),rgba(80,160,230,.04))', boxShadow: 'inset 0 0 60px rgba(120,200,255,.2)' }}>
                    {[[18, 22, -6], [44, 30, 5], [68, 20, -3], [30, 55, 4], [60, 60, -5], [80, 48, 6]].map(([l, t, r], i) => (
                        <div key={i} className="absolute w-10 h-10 rounded-sm shadow-lg text-[7px] p-1 text-stone-700"
                            style={{ left: `${l}%`, top: `${t}%`, transform: `rotate(${r}deg)`, background: ['#fff7a8', '#ffd6e7', '#c8f7d4', '#cfe3ff'][i % 4] }} />
                    ))}
                </div>
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#0c2236,#06121f)' }} />
            </div>
        );
    }
    if (roomId === 'postoffice') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#2a2418 0%,#1c1810 60%,#100d08 100%)' }}>
                {/* 一牆信格 */}
                <div className="absolute left-[6%] right-[6%] top-[16%] h-[42%] rounded-sm" style={{
                    backgroundImage: 'repeating-linear-gradient(90deg, #4a3a22 0 2px, transparent 2px 56px), repeating-linear-gradient(0deg, #4a3a22 0 2px, transparent 2px 40px)',
                    background: 'rgba(70,52,28,0.25)', boxShadow: 'inset 0 0 30px rgba(0,0,0,.4)',
                }} />
                {[20, 44, 68].map((l, i) => (
                    <div key={i} className="absolute w-6 h-4 rounded-[1px]" style={{ left: `${l}%`, top: `${22 + (i % 2) * 14}%`, transform: `rotate(${i % 2 ? -4 : 5}deg)`, background: ['#f3e7c8', '#e8dcc0', '#efe2c4'][i % 3], boxShadow: '0 2px 5px rgba(0,0,0,.4)' }} />
                ))}
                {/* 暖光檯燈 */}
                <div className="absolute top-[10%] right-[14%] w-16 h-16 rounded-full" style={{ background: 'radial-gradient(circle,rgba(255,214,140,.4),transparent 70%)', filter: 'blur(8px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[30%]" style={{ background: 'linear-gradient(180deg,#3a2c18,#160f08)' }} />
            </div>
        );
    }
    if (roomId === 'sar') {
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: 'linear-gradient(180deg,#20243a 0%,#151827 58%,#0b0d16 100%)' }}>
                {/* 美術素材接入前的活動室底稿：牆面、窗光、地板和社團橫幅分層保留，之後可直接替換 ROOM_BG。 */}
                <div className="absolute left-[7%] top-[13%] h-[37%] w-[48%]" style={{ background: 'linear-gradient(150deg,rgba(177,197,232,.17),rgba(85,100,132,.04))', border: '1px solid rgba(210,220,255,.09)', boxShadow: '0 0 45px rgba(126,154,205,.08)' }} />
                <div className="absolute right-[8%] top-[17%] h-[33%] w-[26%] rounded-sm" style={{ background: 'rgba(7,8,15,.28)', border: '1px solid rgba(255,255,255,.08)' }} />
                <div className="absolute left-[10%] top-[20%] text-[18px] tracking-[0.28em] text-white/12" style={{ fontFamily: `'Noto Serif SC',serif` }}>SAR</div>
                <div className="absolute inset-x-0 bottom-0 h-[38%]" style={{ background: 'linear-gradient(180deg,#26263a,#11121c)' }} />
                <div className="absolute inset-x-0 bottom-[23%] h-px bg-white/[0.07]" />
                <div className="absolute inset-0" style={{ background: 'radial-gradient(90% 70% at 50% 38%,transparent,rgba(5,6,14,.55))' }} />
            </div>
        );
    }
    if (roomId === 'cafe') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#3a2a1e 0%,#271c14 60%,#160f0a 100%)' }}>
                <div className="absolute top-[20%] left-[18%] w-10 h-12 rounded-t-full" style={{ background: 'radial-gradient(circle at 50% 30%,rgba(255,210,150,.25),transparent 70%)', filter: 'blur(4px)' }} />
                <div className="absolute top-[24%] right-[22%] w-8 h-10 rounded-t-full" style={{ background: 'radial-gradient(circle at 50% 30%,rgba(255,190,130,.2),transparent 70%)', filter: 'blur(4px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[32%]" style={{ background: 'linear-gradient(180deg,#4a3322,#1a110a)' }} />
            </div>
        );
    }
    // gym
    return (
        <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#0a3a30 0%,#08261f 65%,#041511 100%)' }}>
            <div className="absolute left-0 right-0 bottom-0 h-[45%]" style={{
                backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 38px, rgba(120,255,200,.18) 38px 40px), repeating-linear-gradient(0deg, transparent 0 38px, rgba(120,255,200,.12) 38px 40px)',
                transform: 'perspective(300px) rotateX(58deg)', transformOrigin: 'bottom',
            }} />
            <div className="absolute top-[14%] left-1/2 -translate-x-1/2 w-32 h-10 rounded-full" style={{ background: 'radial-gradient(ellipse,rgba(120,255,200,.3),transparent)' }} />
        </div>
    );
};

// ============ chibi 小人渲染 ============
const Chibi: React.FC<{ char: CharacterProfile; bubble?: string; onTap?: () => void; size?: number; dance?: boolean }> = ({ char, bubble, onTap, size = 96, dance }) => {
    const c = getChibi(char);
    return (
        <div
            className={`absolute flex flex-col items-center ${onTap ? 'cursor-pointer' : ''}`}
            style={{ transform: 'translate(-50%, -100%)' }}
            onClick={onTap}
            role={onTap ? 'button' : undefined}
            tabIndex={onTap ? 0 : undefined}
            aria-label={onTap ? `查看 ${char.name}` : undefined}
            onKeyDown={event => {
                if (onTap && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onTap();
                }
            }}
        >
            {bubble && (
                <div className="relative mb-1 max-w-[120px] px-2 py-1 rounded-xl bg-white/95 text-stone-700 text-[10px] leading-snug font-medium shadow-[0_3px_10px_rgba(0,0,0,.3)] text-center">
                    {bubble.length > 22 ? bubble.slice(0, 22) + '…' : bubble}
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white/95 rotate-45" />
                </div>
            )}
            <div className="relative" style={{ animation: `${dance ? 'vrdance 0.9s' : 'vrfloat 3.2s'} ease-in-out infinite`, animationDelay: `${(char.id.charCodeAt(0) % 10) * 0.15}s` }}>
                {c.img ? (
                    <TokenImg value={c.img} alt={char.name}
                        style={{ height: size * c.scale, transform: `scaleX(${c.flip ? -1 : 1}) translateY(${c.offsetY}px)`, filter: 'drop-shadow(0 4px 6px rgba(0,0,0,.5))' }}
                        className="object-contain" />
                ) : (
                    <div className="rounded-full flex items-center justify-center font-bold text-white"
                        style={{ width: size * 0.55, height: size * 0.55, background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))', fontSize: size * 0.22 }}>
                        {char.name.slice(0, 1)}
                    </div>
                )}
            </div>
            {/* 地面投影 */}
            <div className="rounded-[50%] -mt-1" style={{ width: size * 0.5, height: size * 0.12, background: 'radial-gradient(ellipse,rgba(0,0,0,.45),transparent)' }} />
            <div className="text-[9px] text-white/90 font-bold mt-0.5 px-1.5 rounded-full bg-black/30 backdrop-blur-sm whitespace-nowrap">{char.name}</div>
        </div>
    );
};

// ============ 通用：長按 hook + 確認彈窗（統一替代原生 confirm/alert） ============
const useLongPress = (onLong: () => void, ms = 500) => {
    const timer = useRef<number | null>(null);
    const [pressing, setPressing] = useState(false);
    const cancel = useCallback(() => { setPressing(false); if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);
    const start = useCallback(() => { setPressing(true); timer.current = window.setTimeout(() => { setPressing(false); timer.current = null; onLong(); }, ms); }, [onLong, ms]);
    return { pressing, handlers: { onPointerDown: start, onPointerUp: cancel, onPointerLeave: cancel, onPointerCancel: cancel } };
};

const ConfirmDialog: React.FC<{
    open: boolean; title: string; message?: string;
    confirmText?: string; cancelText?: string; zIndex?: number;
    onConfirm: () => void; onCancel: () => void;
}> = ({ open, title, message, confirmText = '刪除', cancelText = '取消', zIndex = 300, onConfirm, onCancel }) => {
    const root=useRef<HTMLDivElement>(null);
    useEffect(()=>{if(!open)return;const prior=document.activeElement as HTMLElement|null;root.current?.focus();return()=>prior?.focus();},[open]);
    if (!open) return null;
    return (
        <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} style={{zIndex}} className="fixed inset-0 flex items-center justify-center px-8 bg-black/55 backdrop-blur-sm" onClick={onCancel} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onCancel();}}}>
            <div className="w-full max-w-[300px] rounded-2xl p-4 text-center" onClick={e => e.stopPropagation()}
                style={{ background: 'linear-gradient(180deg,#1b1830 0%,#100d20 100%)', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[14px] font-semibold text-white tracking-wide" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                {message && <p className="text-[11.5px] text-white/55 mt-1.5 leading-relaxed whitespace-pre-wrap">{message}</p>}
                <div className="flex gap-2 mt-4">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/75 active:bg-white/5" style={{ border: '1px solid rgba(255,255,255,.16)' }}>{cancelText}</button>
                    <button onClick={onConfirm} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-white active:opacity-85" style={{ background: 'linear-gradient(120deg,#f43f5e,#e11d48)' }}>{confirmText}</button>
                </div>
            </div>
        </div>
    );
};

// 長按彈出的動作菜單（編輯 / 刪除等）
const ActionSheet: React.FC<{
    open: boolean; title?: string;
    actions: { label: string; onClick: () => void; danger?: boolean }[];
    onClose: () => void;
}> = ({ open, title, actions, onClose }) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[300] flex items-end justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-md p-3" style={{ paddingBottom: vrBottomPad('0.75rem') }} onClick={e => e.stopPropagation()}>
                <div className="rounded-2xl overflow-hidden" style={{ background: 'linear-gradient(180deg,#1b1830,#120f22)', border: '1px solid rgba(255,255,255,.12)' }}>
                    {title && <div className="px-4 py-2.5 text-[11px] text-white/45 text-center border-b border-white/8 whitespace-pre-wrap leading-snug">{title}</div>}
                    {actions.map((a, i) => (
                        <button key={i} onClick={() => { a.onClick(); }} className={`w-full py-3 text-[13.5px] active:bg-white/5 ${i > 0 ? 'border-t border-white/8' : ''} ${a.danger ? 'text-rose-400 font-semibold' : 'text-white/90'}`}>{a.label}</button>
                    ))}
                </div>
                <button onClick={onClose} className="w-full mt-2 rounded-2xl py-3 text-[13.5px] text-white/80 font-medium" style={{ background: 'rgba(40,36,60,.9)', border: '1px solid rgba(255,255,255,.1)' }}>取消</button>
            </div>
        </div>
    );
};

// 分頁列表（每頁 perPage 條，超出翻頁）
function PagedList<T>({ items, perPage, render }: { items: T[]; perPage: number; render: (it: T, idx: number) => React.ReactNode }) {
    const [p, setP] = useState(0);
    const total = Math.max(1, Math.ceil(items.length / perPage));
    const cur = Math.min(p, total - 1);
    const slice = items.slice(cur * perPage, cur * perPage + perPage);
    return (
        <>
            {slice.map(render)}
            {total > 1 && (
                <div className="flex items-center justify-center gap-3 mb-1">
                    <button onClick={() => setP(Math.max(0, cur - 1))} disabled={cur === 0} className="h-6 w-6 rounded-full flex items-center justify-center text-white/60 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={11} weight="bold" /></button>
                    <span className="text-[10px] text-white/45 tabular-nums">{cur + 1}/{total}</span>
                    <button onClick={() => setP(Math.min(total - 1, cur + 1))} disabled={cur >= total - 1} className="h-6 w-6 rounded-full flex items-center justify-center text-white/60 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretRight size={11} weight="bold" /></button>
                </div>
            )}
        </>
    );
}

// 待寄出信件行（長按彈出 編輯/刪除）
const PendingLetterRow: React.FC<{ l: VRLetter; onMenu: (l: VRLetter) => void }> = ({ l, onMenu }) => {
    const { pressing, handlers } = useLongPress(() => onMenu(l), 500);
    const len = charLen(l.content);
    const over = len > MAX_LETTER_CHARS;
    return (
        <div {...handlers} className={`rounded-lg p-2 mb-1.5 text-[11.5px] text-amber-50/90 transition-transform ${pressing ? 'scale-[0.97]' : ''}`}
            style={{ background: pressing ? 'rgba(244,180,90,0.16)' : 'rgba(255,255,255,.05)', border: `1px solid ${over ? 'rgba(244,120,90,0.5)' : pressing ? 'rgba(244,180,90,0.4)' : 'transparent'}` }}>
            <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-amber-200/90 font-bold text-[10.5px]">{l.pen}</span>
                <span className={`ml-auto text-[9px] ${over ? 'text-red-300 font-semibold' : 'text-white/25'}`}>{over ? `${len}/${MAX_LETTER_CHARS} 超長·需精簡` : '長按編輯/刪除'}</span>
            </div>
            <p className="leading-snug whitespace-pre-wrap">{l.content}</p>
        </div>
    );
};

// 信件編輯彈窗
const LetterEditModal: React.FC<{ letter: VRLetter; onSave: (pen: string, content: string) => void; onCancel: () => void; title?: string }> = ({ letter, onSave, onCancel, title = '編輯這封信' }) => {
    const [pen, setPen] = useState(letter.pen);
    const [content, setContent] = useState(letter.content);
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-2.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                <label className="text-[10px] text-amber-200/60">筆名</label>
                <input value={pen} onChange={e => setPen(e.target.value)} className="w-full mt-1 mb-2.5 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <label className="text-[10px] text-amber-200/60 flex items-center">正文<span className={`ml-auto ${charLen(content) > MAX_LETTER_CHARS ? 'text-red-300 font-semibold' : 'text-amber-200/50'}`}>{charLen(content)}/{MAX_LETTER_CHARS}</span></label>
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={5} placeholder="寫給陌生人的話——碎碎念、日記、困惑、執念都行…" className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 placeholder-white/25 outline-none resize-none vr-reader-scroll" style={{ border: `1px solid ${charLen(content) > MAX_LETTER_CHARS ? 'rgba(244,120,90,.5)' : 'rgba(220,190,120,.2)'}` }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>取消</button>
                    <button onClick={() => onSave(pen, content)} disabled={!content.trim() || charLen(content) > MAX_LETTER_CHARS} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>保存</button>
                </div>
            </div>
        </div>
    );
};

// 身份導出 / 導入彈窗：owner_id 是本地隨機 UUID，換設備/清數據會丟失「我寄出的信」的歸屬，
// 這裡給用戶一個「帶走身份」的口子。
const IdentityModal: React.FC<{ onImport: (code: string) => void; onClose: () => void }> = ({ onImport, onClose }) => {
    const code = exportIdentity();
    const [input, setInput] = useState('');
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try { await navigator.clipboard?.writeText(code); setCopied(true); trackEvent('复制邮局身份码'); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
    };
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-1" style={{ fontFamily: `'Noto Serif SC',serif` }}>郵局身份</div>
                <p className="text-[10px] text-white/45 leading-snug mb-2.5">這串「身份碼」代表你在郵局的匿名身份。複製保存，換設備或清數據後導入，就能找回「我寄出的信」和它們的歸屬。</p>
                <label className="text-[10px] text-amber-200/60">我的身份碼</label>
                <div className="flex gap-1.5 mt-1 mb-3">
                    <div className="flex-1 rounded-lg bg-black/30 px-2.5 py-2 text-[10.5px] text-amber-50/80 break-all leading-snug" style={{ border: '1px solid rgba(220,190,120,.2)' }}>{code}</div>
                    <button onClick={copy} className="shrink-0 self-stretch px-3 rounded-lg text-[11px] font-semibold text-black" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{copied ? '已複製' : '複製'}</button>
                </div>
                <label className="text-[10px] text-amber-200/60">導入身份碼（換回舊身份）</label>
                <input value={input} onChange={e => setInput(e.target.value)} placeholder="粘貼 sullypo.… 身份碼" className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onClose} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>關閉</button>
                    <button onClick={() => onImport(input)} disabled={!input.trim()} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>導入</button>
                </div>
            </div>
        </div>
    );
};

// 後台：用 ADMIN_TOKEN 看後端「所有人」的信、按需刪（點踩多的排在前）。token 僅存本機。
const AdminModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const [token, setToken] = useState(getAdminToken());
    const [letters, setLetters] = useState<RemoteAdminLetter[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const load = async () => {
        if (!token.trim()) { setErr('請先填入管理員 token'); return; }
        setLoading(true); setErr('');
        try { setAdminToken(token); setLetters(await PostOffice.adminList(token.trim(), 200)); }
        catch (e: any) { setErr(e?.message === 'unauthorized' ? 'token 不對' : ('拉取失敗：' + (e?.message || '檢查網絡'))); setLetters(null); }
        finally { setLoading(false); }
    };
    const del = async (id: string) => {
        try { await PostOffice.adminDelete(token.trim(), [id]); setLetters(ls => (ls || []).filter(l => l.id !== id)); setConfirmId(null); }
        catch (e: any) { setErr('刪除失敗：' + (e?.message || '檢查網絡')); }
    };
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-[400px] max-h-[82vh] flex flex-col rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-1 shrink-0" style={{ fontFamily: `'Noto Serif SC',serif` }}>郵局後台</div>
                <p className="text-[10px] text-white/45 leading-snug mb-2.5 shrink-0">用 worker 的 <b className="text-amber-200/70">ADMIN_TOKEN</b> 查看後端全部信件（按踩數、時間倒序，最多 200 條），可逐條刪除。token 只存在本機。</p>
                <div className="flex gap-1.5 mb-3 shrink-0">
                    <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="ADMIN_TOKEN" className="flex-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                    <button onClick={load} disabled={loading} className="shrink-0 px-3.5 rounded-lg text-[11px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{loading ? '…' : (letters ? '刷新' : '拉取')}</button>
                </div>
                {err && <div className="text-[10.5px] text-red-300/80 mb-2 shrink-0">{err}</div>}
                <div className="flex-1 overflow-y-auto vr-reader-scroll -mx-1 px-1 min-h-0">
                    {letters && letters.length === 0 && <p className="text-[10.5px] text-white/35">後端目前沒有信件。</p>}
                    {(letters || []).map(l => (
                        <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.05)' }}>
                            <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-amber-200/70 text-[9.5px]">{l.pen || '匿名'}</span>
                                {l.dislikes > 0 && <span className="text-[8.5px] text-red-300/80 border border-red-400/30 rounded-full px-1.5 leading-tight">踩 {l.dislikes}</span>}
                                <span className="ml-auto text-[8.5px] text-white/30">{new Date(l.created_at).toLocaleDateString()}</span>
                            </div>
                            <div className="text-white/75 leading-snug whitespace-pre-wrap mb-1">{l.content}</div>
                            <div className="flex items-center gap-2 text-[8.5px] text-white/35">
                                <span>贊{l.likes}</span><span>踩{l.dislikes}</span><span>讀{l.views}</span><span>回{l.reply_count}</span>
                                {confirmId === l.id
                                    ? <button onClick={() => del(l.id)} className="ml-auto text-red-300 font-bold">確定刪除</button>
                                    : <button onClick={() => setConfirmId(l.id)} className="ml-auto text-white/45 active:text-red-300">刪除</button>}
                            </div>
                        </div>
                    ))}
                    {!letters && !loading && <p className="text-[10.5px] text-white/30">填入 token 後點「拉取」。</p>}
                </div>
                <button onClick={onClose} className="mt-3 rounded-full py-2 text-[12.5px] text-white/70 shrink-0" style={{ border: '1px solid rgba(255,255,255,.16)' }}>關閉</button>
            </div>
        </div>
    );
};

// ============ 玩法說明 ============
const HelpModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const Block: React.FC<{ title: string; tone?: string; children: React.ReactNode }> = ({ title, tone = 'rgba(180,180,255,.9)', children }) => (
        <div className="rounded-xl p-3 mb-2.5" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.07)' }}>
            <div className="flex items-center gap-1.5 mb-1.5">
                <span className="h-3 w-[3px] rounded-full shrink-0" style={{ background: tone }} />
                <span className="text-[12.5px] font-semibold tracking-wide" style={{ color: tone, fontFamily: `'Noto Serif SC',serif` }}>{title}</span>
            </div>
            <div className="text-[11.5px] text-white/70 leading-relaxed space-y-1">{children}</div>
        </div>
    );
    const Step: React.FC<{ n: number; children: React.ReactNode }> = ({ n, children }) => (
        <div className="flex gap-2">
            <span className="shrink-0 h-4 w-4 mt-0.5 rounded-full flex items-center justify-center text-[9px] font-bold text-black" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{n}</span>
            <span className="flex-1">{children}</span>
        </div>
    );
    return (
        <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'linear-gradient(180deg,#0c0a1c 0%,#080612 100%)' }}>
            <div className="flex items-center gap-2.5 px-5 pb-3 shrink-0 border-b border-white/8" style={{ paddingTop: VR_TOP }}>
                <span className="text-[15px] tracking-[0.2em] text-white/95" style={{ fontFamily: `'Noto Serif SC',serif` }}>彼方 · 玩法說明</span>
                <button onClick={onClose} className="ml-auto p-1.5 rounded-full text-white/60 active:bg-white/10"><X size={19} /></button>
            </div>
            <div className="flex-1 overflow-y-auto vr-reader-scroll px-4 pt-4" style={{ paddingBottom: vrBottomPad('1rem') }}>
                <p className="text-[12px] text-white/75 leading-relaxed mb-3">
                    「彼方」是你的角色們<b className="text-indigo-200">自己會去逛</b>的一方小世界。開啟後，ta 們會按你設的間隔獨自登入，在不同房間裡讀書、聽歌、發帖、寫信、瞎玩——所有舉動都會變成「動態」，並<b className="text-indigo-200">同步進 ta 各自的聊天和記憶</b>裡。這是 ta 不被你盯著的私人時間。
                </p>

                <Block title="世界觀會自適應你的角色" tone="rgba(180,200,255,.95)">
                    <div>《彼方》本身是個<b className="text-indigo-200">類似 VRChat 的虛擬世界</b>。無論你的角色來自什麼設定——現代、古代、魔法、末世、異世界都行——ta 都會用<b>符合自己世界觀的方式</b>理解並進入這裡，始終保持 ta 自己，不會因為來玩就 OOC。</div>
                    <div className="mt-1 text-white/60"><b className="text-amber-200">別擔心「我家角色世界觀對不上就不能玩」</b>：怎麼進來、用什麼道理解釋自己身處其中，全交給角色自己圓。放心帶 ta 來逛。</div>
                </Block>

                <Block title="怎麼開始" tone="rgba(245,208,138,.95)">
                    <Step n={1}>去 <b>「角色接入」</b> 標籤：給角色捏個小人形象，打開開關。默認<b>僅手動活動</b>；想讓 ta 自己逛，再選「自動活動」和間隔。</Step>
                    <Step n={2}>想用圖書館，先去 <b>「書庫」</b> 上傳小說。可以按分類整理，並在「誰來讀這些書」裡讓角色按分類輪換。</Step>
                    <Step n={3}>不想等？在「角色接入」裡點 <b>「讓 ta 現在去逛一次」</b>，可以<b className="text-amber-200">指定房間或隨機</b>，立刻看效果。</Step>
                </Block>

                <Block title="房間都能幹嘛">
                    <div><b className="text-indigo-100">圖書館</b>：角色讀你上傳的小說、<b>自己寫批註</b>。你能翻看 ta 的批註（動態裡點批註還能跳回原文），不過<b className="text-amber-200">暫時還不能自己寫批註</b>。</div>
                    <div><b className="text-indigo-100">聽歌房</b>：從角色自己的歌單點歌、銳評正在放的曲子。</div>
                    <div><b className="text-indigo-100">留言簿</b>：公共版聊牆，角色發帖、接話茬。你也能在底部<b className="text-sky-200">以自己身份留言</b>，會廣播給所有接入的角色。</div>
                    <div><b className="text-indigo-100">娛樂室</b>：純放飛，角色在這兒瞎玩造謠找樂子。</div>
                    <div><b className="text-indigo-100">郵局</b>：寫漂流信交陌生筆友——見下方重點。</div>
                    <div><b style={{ color: '#f5a6a6' }}>劇院</b>：角色逛進來會<b>寫一齣舞台劇</b>投稿。你可以翻投稿、自己寫/讓 LLM 寫/傳 txt，挑一本<b>【編排】</b>：給角色選演員（缺角能 roll 個 NPC），角色讀完會提意見/改戲，<b>【召喚導演】</b>整合成最終本，小人氣泡<b>演一遍</b>，再收進歷史舞台劇。</div>
                </Block>

                <Block title="郵局怎麼玩（重點）" tone="rgba(243,208,138,.95)">
                    <div className="text-white/60 mb-1">像扔漂流瓶/交筆友：角色把信寄給一個跟你們毫無關係的陌生人，對方也可能回信。流程是：</div>
                    <Step n={1}>角色逛到郵局，會<b>寫一封漂流信</b>，或<b>回一封陌生來信</b> → 落進「待寄出 / 待發送回信」，<b className="text-amber-200">等你確認</b>。</Step>
                    <Step n={2}>你在郵局面板點 <b>「一鍵寄出」</b>，信才真正漂出去（筆名自動匿名）。</Step>
                    <Step n={3}>點 <b>「刷新收件箱」</b>，撈回陌生人寄來的信；角色下次逛郵局時可能回它。</Step>
                    <Step n={4}>你寄出的信有人回了，點 <b>「收取回復」</b> 收回 → 角色讀完寫下感觸，信<b>封存進「信匣」</b>。</Step>
                    <div className="mt-1.5 text-white/60">· 待寄出的信、待發送的回信都能點 <b className="text-amber-200">「···」編輯 / 刪除</b>。</div>
                    <div className="text-white/60">· 回信發出後，連同原來的來信一起歸檔到 <b style={{ color: '#86e3b0' }}>「已回」</b>，本地留存、隨備份導出導入。</div>
                    <div className="text-white/60">· 每個分組都有顏色標籤，一眼看出每封信的處境：<span className="text-amber-200">等你寄出</span> / <span className="text-sky-200">等角色回信</span> / <span style={{ color: '#93b8ff' }}>漂流中</span> / <span style={{ color: '#86e3b0' }}>已收到回覆</span>。</div>
                </Block>

                <Block title="小提示" tone="rgba(180,200,255,.9)">
                    <div>· 「世界」頁的<b>動態</b>長按可刪除；滿 5 條一頁、可翻頁。</div>
                    <div>· 角色在留言簿說的話，會原樣進 ta 的聊天，不只是一句小總結。</div>
                    <div>· 閱讀器裡的批註都是<b>角色自己留</b>的；你目前只能翻看，<b className="text-amber-200">還不能親自寫批註</b>（以後再說）。</div>
                    <div>· 郵局/收件箱裡的信多了也會分頁，慢慢翻。</div>
                    <div>· 彼方較費 API：可在 <b>「API」</b> 標籤給它單獨指定一份（和設置裡的預設共用），還能看<b>調用記錄</b>對帳。</div>
                </Block>

                <div className="h-2" />
            </div>
        </div>
    );
};

// 來信行（長按彈出：指定角色回 / 親自回 / 刪除）
const InboxLetterRow: React.FC<{ l: VRLetter; onMenu: (l: VRLetter) => void; onLike: (l: VRLetter) => void; onDislike: (l: VRLetter) => void }> = ({ l, onMenu, onLike, onDislike }) => {
    const { pressing, handlers } = useLongPress(() => onMenu(l), 500);
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return (
        <div {...handlers} className={`rounded-lg p-2 mb-1.5 text-[11px] text-white/80 leading-snug transition-transform ${pressing ? 'scale-[0.97]' : ''}`}
            style={{ background: pressing ? 'rgba(125,211,252,0.16)' : 'rgba(255,255,255,.04)', border: `1px solid ${pressing ? 'rgba(125,211,252,0.4)' : 'transparent'}` }}>
            <div className="flex items-center gap-1.5 mb-0.5"><span className="text-sky-200/80 font-bold text-[10.5px]">{l.pen}</span></div>
            <ExpandText text={l.content} limit={90} />
            <div className="flex items-center gap-3 mt-1.5 text-[10px]">
                <span className="text-white/30">閱 {l.views ?? 0}</span>
                <button onPointerDown={stop} onClick={e => { stop(e); onLike(l); }} className={`transition-colors ${l.myVote === 1 ? 'text-amber-300 font-semibold' : 'text-white/40'}`}>贊 {l.likes ?? 0}</button>
                <button onPointerDown={stop} onClick={e => { stop(e); onDislike(l); }} className={`transition-colors ${l.myVote === -1 ? 'text-red-300 font-semibold' : 'text-white/40'}`} title="踩即舉報">踩 {l.dislikes ?? 0}</button>
                <span className="ml-auto text-white/25 text-[9px]">長按回信</span>
            </div>
        </div>
    );
};

// 親自回信 / 編輯回信（不調用 LLM）
const ReplyComposeModal: React.FC<{ letter: VRLetter; defaultPen: string; initialContent?: string; title?: string; cta?: string; onSave: (pen: string, content: string) => void; onCancel: () => void }> = ({ letter, defaultPen, initialContent = '', title = '親自回這封信', cta = '寫好，排入待發送', onSave, onCancel }) => {
    const [pen, setPen] = useState(defaultPen);
    const [content, setContent] = useState(initialContent);
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-2" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                <div className="rounded-lg bg-black/25 px-3 py-2 mb-3 text-[10.5px] text-white/55 leading-snug max-h-24 overflow-y-auto vr-reader-scroll" style={{ border: '1px solid rgba(255,255,255,.08)' }}>
                    原信（{letter.pen}）：{letter.content}
                </div>
                <label className="text-[10px] text-amber-200/60">你的筆名（寄出時匿名）</label>
                <input value={pen} onChange={e => setPen(e.target.value)} className="w-full mt-1 mb-2.5 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <label className="text-[10px] text-amber-200/60">回信正文</label>
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={5} autoFocus placeholder="寫下你想對這位陌生人說的話…"
                    className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 placeholder-white/25 outline-none resize-none vr-reader-scroll" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>取消</button>
                    <button onClick={() => onSave(pen, content)} disabled={!content.trim()} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{cta}</button>
                </div>
            </div>
        </div>
    );
};

// ============ 信號墜落處 · 往期活動小入口 ============
// 活動已經封存，只在往期活動頁留一張克制的紀念館入口，不再佔用世界首頁頭圖。
// banner 底圖：月（倉庫相對路徑，經 assetUrl 走多 CDN 鏡像兜底，見 utils/assetUrl.ts）
const SIGNAL_BANNER_MOON = 'img/MOON.png';
const SignalBanner: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
    const moonUrl = useResilientAssetUrl(SIGNAL_BANNER_MOON);
    const [bk, setBk] = useState<SignalBooklet | null>(null);
    useEffect(() => {
        let alive = true;
        const load = async () => { try { const s = await Signal.current(); if (alive) setBk(s.booklet); } catch { /* 離線：只是不顯示進度 */ } };
        void load();
        const h = () => { void load(); };
        window.addEventListener('vr-session-done', h);
        return () => { alive = false; window.removeEventListener('vr-session-done', h); };
    }, []);
    const done = bk?.poemCount ?? 0;
    const total = bk?.poemsTarget ?? 40;
    return (
        <button onClick={onOpen} className="relative w-full h-[84px] rounded-2xl overflow-hidden text-left active:scale-[0.985] transition-transform"
            style={{ boxShadow: '0 10px 34px rgba(0,0,0,.5)', border: '1px solid rgba(196,164,92,.35)' }}>
            {/* 底圖：月 */}
            <div className="absolute inset-0" style={{ backgroundImage: `url(${moonUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            {/* 壓暗 + 左側加重，保證左側文案在月面上可讀 */}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(8,6,22,.86) 0%, rgba(10,8,28,.6) 44%, rgba(10,8,30,.3) 100%)' }} />
            {/* 頂部光束 + 星塵 + 底部壓暗 */}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(210,190,255,.16), transparent 42%), linear-gradient(180deg, transparent 55%, rgba(8,6,22,.6))' }} />
            <div className="pointer-events-none absolute inset-0 opacity-70" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 30%, rgba(255,255,255,.55), transparent), radial-gradient(1px 1px at 66% 24%, rgba(210,220,255,.45), transparent), radial-gradient(1px 1px at 84% 60%, rgba(230,225,255,.4), transparent)' }} />
            {/* 金色內框 + 四角 */}
            <div className="absolute inset-[6px] rounded-xl pointer-events-none" style={{ border: '1px solid rgba(196,164,92,.26)' }} />
            {[['top-2.5 left-2.5', 'border-t border-l'], ['top-2.5 right-2.5', 'border-t border-r'], ['bottom-2.5 left-2.5', 'border-b border-l'], ['bottom-2.5 right-2.5', 'border-b border-r']].map(([pos, b], i) => (
                <div key={i} className={`absolute ${pos} w-4 h-4 ${b} pointer-events-none`} style={{ borderColor: 'rgba(212,178,102,.6)' }} />
            ))}
            {/* 文案 */}
            <div className="absolute inset-0 px-4 flex flex-col justify-center">
                <div className="text-[7.5px] tracking-[0.3em] text-amber-200/65 mb-1">已封存 · 紀念館</div>
                <div className="text-[16px] leading-none font-semibold text-white" style={{ fontFamily: `'Noto Serif SC',serif`, textShadow: '0 0 18px rgba(180,160,255,.45), 0 2px 5px rgba(0,0,0,.55)' }}>信號墜落處</div>
                <div className="text-[8.5px] text-indigo-100/50 mt-1.5">電子生命的低電量合唱 · 只讀留存</div>
            </div>
            {/* 進度（替代倒計時） */}
            <div className="absolute right-4 bottom-3 text-right">
                <div className="text-[7.5px] tracking-[0.2em] text-amber-200/60 flex items-center gap-1 justify-end mb-0.5"><BookOpen size={9} weight="fill" /> 已封卷</div>
                <div className="text-[12px] font-bold text-amber-100/85 tabular-nums leading-none" style={{ fontFamily: `'Noto Serif SC',serif` }}>{done}<span className="text-[9px] text-amber-200/45"> / {total} 首</span></div>
            </div>
        </button>
    );
};

// ============ 世界視圖 ============
const SARWorldPage: React.FC<{
    occupants: CharacterProfile[];
    roomView: SARRoomView;
    onToggleLabels: () => void;
    npcEnabled: boolean;
    caianMet: boolean;
    onTalkToCaian: () => void;
    onTalkToAiven: () => void;
    onSelectCharacter: (char:CharacterProfile) => void;
    onOpenGacha: () => void;
    onOpenCabinet: () => void;
    onOpenModuleShop: () => void;
    onOpenSarSettings: () => void;
    onOpenSarWarehouse: () => void;
    onOpenFishingMarket: (entry: 'water' | 'board' | 'garden') => void;
    onBackPage: () => void;
}> = ({ occupants, roomView, onToggleLabels, npcEnabled, caianMet, onTalkToCaian, onTalkToAiven, onSelectCharacter, onOpenGacha, onOpenCabinet, onOpenModuleShop, onOpenSarSettings, onOpenSarWarehouse, onOpenFishingMarket, onBackPage }) => (
    <section className="sar-world-page relative overflow-hidden" aria-label="SAR 活動空間"
        style={{ minHeight: 0, height: '100%' }}>

        <div className="sar-world-heading absolute inset-x-5 top-5 z-10 flex items-start justify-between gap-4">
            <div className="sar-hub-identity">
                <button type="button" className="sar-hub-exit" onClick={onBackPage} aria-label="返回彼方"><ArrowLeft size={20}/></button>
                <div><div className="sar-world-eyebrow">ACTIVITY ROOM</div>
                <h2 style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>SAR 活動室</h2></div>
            </div>
            <div className="sar-hub-tools">
                <button type="button" onClick={onToggleLabels} aria-label={SAR_ROOM_VIEW_ACTIONS[roomView].description} title={SAR_ROOM_VIEW_ACTIONS[roomView].description} data-room-view={roomView}>{roomView==='characters-hidden' ? <Eye size={21}/> : <EyeSlash size={21}/>}<span>{SAR_ROOM_VIEW_ACTIONS[roomView].label}</span></button>
                <button type="button" onClick={onOpenSarSettings} aria-label="活動室設置"><Gear size={21}/><span>設置</span></button>
                <button type="button" onClick={onOpenSarWarehouse} aria-label="打開倉庫"><Package size={21}/><span>倉庫</span></button>
            </div>
        </div>

        <SARClubStage roomView={roomView} occupants={occupants} npcEnabled={npcEnabled} caianMet={caianMet} onTalkToCaian={onTalkToCaian} onTalkToAiven={onTalkToAiven} onSelectCharacter={onSelectCharacter} onOpenGacha={onOpenGacha} onOpenCabinet={onOpenCabinet} onOpenModuleShop={onOpenModuleShop} onOpenFishingMarket={onOpenFishingMarket} fullPage />

    </section>
);

const PastEventsWorldPage: React.FC<{ onOpenSignal: () => void; onBackPage: () => void }> = ({ onOpenSignal, onBackPage }) => (
    <section className="relative -mx-4 -mt-4 overflow-hidden px-5" aria-label="往期活動"
        style={{ minHeight: 500, height: 'calc(100dvh - var(--chrome-top) - var(--safe-bottom) - 6.75rem)', paddingTop: '1.45rem' }}>
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(70% 45% at 50% 18%,rgba(98,82,160,.16),transparent),linear-gradient(180deg,rgba(8,9,18,.18),rgba(5,6,12,.55))' }} />
        <div className="relative z-10">
            <div className="text-[8px] tracking-[0.34em] text-indigo-100/42">PAGE 02 · ARCHIVE</div>
            <h2 className="mt-1 text-[20px] tracking-[0.16em] text-white/92" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>往期活動</h2>
            <p className="mt-2 max-w-[280px] text-[10px] leading-5 text-white/38">結束的活動留在這裡供回看。它們不會再主動出現，也不會再接收新內容。</p>
            <div className="mt-6"><SignalBanner onOpen={onOpenSignal} /></div>
        </div>
        <div className="absolute inset-x-0 bottom-3 z-20 flex items-center justify-center gap-3">
            <button type="button" onClick={onBackPage} aria-label="返回世界房間" className="grid h-8 w-8 place-items-center rounded-full text-white/75 backdrop-blur-md active:bg-white/15" style={{ background: 'rgba(7,8,16,.42)', border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={14} weight="bold" /></button>
            <span className="rounded-full px-3 py-1 text-[10px] tracking-[0.15em] text-white/48 backdrop-blur-md" style={{ background: 'rgba(7,8,16,.36)', border: '1px solid rgba(255,255,255,.08)' }}>2 / 2</span>
            <button type="button" disabled aria-label="已經是最後一頁" className="grid h-8 w-8 place-items-center rounded-full text-white/20" style={{ border: '1px solid rgba(255,255,255,.07)' }}><CaretRight size={14} weight="bold" /></button>
        </div>
    </section>
);

const WorldView: React.FC<{
    occupantsByRoom: Record<string, CharacterProfile[]>;
    feed: FeedItem[]; novelCount: number;
    poBadge: { toSend: number; toCollect: number };
    onEnterRoom: (r: VRRoomId) => void; onGoLibrary: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    onDeleteFeed: (msgId: number) => void; onDeleteFeedMany: (ids: number[]) => void;
    roomPage: 0 | 1; onRoomPageChange: (page: 0 | 1) => void;
}> = ({ occupantsByRoom, feed, novelCount, poBadge, onEnterRoom, onGoLibrary, onJump, onDeleteFeed, onDeleteFeedMany, roomPage, onRoomPageChange }) => {
    const FEED_PER_PAGE = 5;
    const [page, setPage] = useState(0);
    const totalPages = Math.max(1, Math.ceil(feed.length / FEED_PER_PAGE));
    const curPage = Math.min(page, totalPages - 1);
    const shown = feed.slice(curPage * FEED_PER_PAGE, curPage * FEED_PER_PAGE + FEED_PER_PAGE);
    const [confirmDel, setConfirmDel] = useState<FeedItem | null>(null);
    // 管理模式：多選刪除（替代原「清空」）。選擇跨頁保留。
    const [manageMode, setManageMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [confirmBatch, setConfirmBatch] = useState(false);
    const exitManage = () => { setManageMode(false); setSelectedIds(new Set()); };
    const toggleSelect = (msgId: number) => setSelectedIds(prev => {
        const n = new Set(prev); n.has(msgId) ? n.delete(msgId) : n.add(msgId); return n;
    });
    const shownIds = shown.map(f => f.msgId);
    const allShownSelected = shownIds.length > 0 && shownIds.every(id => selectedIds.has(id));
    const toggleSelectPage = () => setSelectedIds(prev => {
        const n = new Set(prev);
        if (allShownSelected) shownIds.forEach(id => n.delete(id));
        else shownIds.forEach(id => n.add(id));
        return n;
    });
    // 世界保留公共房間與往期活動；SAR 通過同級入口打開獨立空間。
    const shownRooms = VR_ROOMS.filter(room => !room.hiddenFromGrid && room.id !== 'sar' && room.id !== 'cafe');
    const roomTotalPages = 2;
    const curRoomPage = roomPage;

    if (curRoomPage === 1) {
        return <PastEventsWorldPage onOpenSignal={() => { onEnterRoom('signal'); trackEvent('进入彼方往期活动', { room: 'signal' }); }} onBackPage={() => onRoomPageChange(0)} />;
    }
    return (
    <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
            {shownRooms.map(room => {
                const occupants = occupantsByRoom[room.id] || [];
                return (
                    <button key={room.id} aria-label={room.implemented ? `進入 ${room.name}` : `${room.name}開發中`} onClick={() => { if (room.implemented) { onEnterRoom(room.id); trackEvent('进入彼方房间', { room: room.id }); } }}
                        className={`relative rounded-2xl h-36 overflow-hidden text-left active:scale-[0.98] transition-transform ${room.implemented ? '' : 'opacity-65'}`}
                        style={{ boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: room.implemented ? '1px solid rgba(255,255,255,.12)' : '1px solid rgba(255,255,255,.05)' }}>
                        <RoomBackground roomId={room.id} />
                        {/* 頂部漸隱 + 標題 */}
                        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,rgba(5,6,14,.45),transparent 38%,transparent 66%,rgba(5,6,14,.62))' }} />
                        {/* 內描邊光 */}
                        <div className="absolute inset-0 rounded-2xl pointer-events-none" style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12)' }} />
                        <div className="absolute top-2.5 left-3 flex items-center gap-1.5">
                            <span className="text-[12.5px] tracking-[0.14em] text-white drop-shadow" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>{room.name}</span>
                            {!room.implemented && <span className="text-[7px] tracking-wider text-white/60 border border-white/25 rounded-full px-1.5 ml-0.5">開發中</span>}
                        </div>
                        {room.id === 'postoffice' && (poBadge.toCollect > 0 || poBadge.toSend > 0) && (
                            <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                                {poBadge.toCollect > 0 && (
                                    <span className="text-[8.5px] font-bold text-black rounded-full px-1.5 py-0.5 leading-none animate-pulse" style={{ background: 'linear-gradient(120deg,#ffd98a,#f5b94f)', boxShadow: '0 1px 6px rgba(245,185,79,.6)' }}>{poBadge.toCollect} 封回信</span>
                                )}
                                {poBadge.toSend > 0 && (
                                    <span className="text-[8.5px] font-bold text-white/90 rounded-full px-1.5 py-0.5 leading-none" style={{ background: 'rgba(0,0,0,.45)', border: '1px solid rgba(255,255,255,.25)' }}>{poBadge.toSend} 待寄</span>
                                )}
                            </div>
                        )}
                        {!room.implemented && (
                            <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-[11px] tracking-[0.3em] text-white/55" style={{ fontFamily: `'Noto Serif SC',serif` }}>蒸籠預熱中…</span>
                            </div>
                        )}
                        {/* 角色小頭像縮影 */}
                        <div className="absolute bottom-2 left-2.5 right-2.5 flex items-end justify-between">
                            <div className="flex -space-x-2">
                                {occupants.slice(0, 4).map(c => {
                                    const ch = getChibi(c);
                                    return ch.img
                                        ? <TokenImg key={c.id} value={ch.img} className="h-9 w-9 object-contain object-bottom drop-shadow" alt="" style={{ transform: `scaleX(${ch.flip ? -1 : 1})` }} />
                                        : <div key={c.id} className="h-6 w-6 rounded-full bg-indigo-400/70 border border-white/40 flex items-center justify-center text-[9px]">{c.name.slice(0, 1)}</div>;
                                })}
                            </div>
                            {room.implemented && <span className="text-[9px] text-white/80 font-bold flex items-center gap-0.5">進入 <CaretRight size={10} weight="bold" /></span>}
                        </div>
                    </button>
                );
            })}
        </div>
        {roomTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 -mt-1">
                <button onClick={() => onRoomPageChange(0)} disabled={curRoomPage === 0}
                    aria-label="上一頁房間"
                    className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={13} weight="bold" /></button>
                <span className="text-[10.5px] text-white/45 tracking-wider tabular-nums">{curRoomPage + 1} / {roomTotalPages}</span>
                <button onClick={() => onRoomPageChange(1)} disabled={curRoomPage >= roomTotalPages - 1}
                    aria-label="下一頁房間"
                    className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretRight size={13} weight="bold" /></button>
            </div>
        )}

        {novelCount === 0 && (
            <button onClick={onGoLibrary} className="w-full rounded-2xl py-3.5 text-[12px] text-white/65 tracking-wide active:bg-white/5"
                style={{ border: '1px dashed rgba(255,255,255,.18)', background: 'rgba(255,255,255,.02)' }}>
                書庫尚空 · 上傳一卷小說，角色便會在圖書館與它相遇 →
            </button>
        )}

        <div>
            <div className="flex items-center gap-2.5 mb-3 mt-1">
                {/* 左側佔位：與右側齒輪等寬，撐對稱，讓「彼方動態」真正居中 */}
                {feed.length > 0 && <span className="w-7 shrink-0" aria-hidden="true" />}
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.14))' }} />
                <span className="text-[10.5px] tracking-[0.3em] text-white/50" style={{ fontFamily: `'Noto Serif SC',serif` }}>彼方動態</span>
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,rgba(255,255,255,.14),transparent)' }} />
                {feed.length > 0 && (
                    <button onClick={() => manageMode ? exitManage() : setManageMode(true)}
                        aria-label={manageMode ? '退出管理' : '管理動態'}
                        className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center transition-colors"
                        style={{ border: `1px solid ${manageMode ? 'rgba(129,140,248,.55)' : 'rgba(255,255,255,.14)'}`, background: manageMode ? 'rgba(99,102,241,.22)' : 'rgba(255,255,255,.03)', color: manageMode ? '#c7d2fe' : 'rgba(255,255,255,.55)' }}>
                        {manageMode ? <X size={13} weight="bold" /> : <Gear size={14} weight="bold" />}
                    </button>
                )}
            </div>
            {feed.length === 0 ? (
                <p className="text-[11px] text-white/40 py-5 text-center tracking-wide leading-relaxed">虛空尚無迴響。<br />在「角色接入」裡點亮角色，邀請 ta 來逛一次，也可以開啟自動活動。</p>
            ) : (
                <>
                    {/* 翻頁移到動態上方：底下翻頁要滾到最後才夠得著，放上方更順手 */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mb-3">
                            <button onClick={() => setPage(p => Math.max(0, Math.min(p, totalPages - 1) - 1))} disabled={curPage === 0}
                                className="h-8 pl-2 pr-3 rounded-full flex items-center gap-1 text-[11px] text-white/75 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.04)' }}><CaretLeft size={12} weight="bold" />上一頁</button>
                            <span className="text-[11px] text-white/55 tracking-wider tabular-nums min-w-[46px] text-center">{curPage + 1} / {totalPages}</span>
                            <button onClick={() => setPage(p => Math.min(totalPages - 1, Math.min(p, totalPages - 1) + 1))} disabled={curPage >= totalPages - 1}
                                className="h-8 pl-3 pr-2 rounded-full flex items-center gap-1 text-[11px] text-white/75 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.04)' }}>下一頁<CaretRight size={12} weight="bold" /></button>
                        </div>
                    )}
                    {manageMode ? (
                        <div className="flex items-center gap-2 mb-2.5 px-0.5">
                            <button onClick={toggleSelectPage}
                                className="text-[11px] text-white/85 rounded-full px-3 py-1.5 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.04)' }}>
                                {allShownSelected ? '取消本頁' : '選擇本頁'}
                            </button>
                            <span className="text-[10.5px] text-white/45 tabular-nums">已選 {selectedIds.size} 條</span>
                            <button onClick={() => { if (selectedIds.size > 0) setConfirmBatch(true); }} disabled={selectedIds.size === 0}
                                className="ml-auto text-[11px] font-semibold text-white rounded-full px-4 py-1.5 disabled:opacity-30 active:opacity-85" style={{ background: 'linear-gradient(120deg,#f43f5e,#e11d48)' }}>
                                刪除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                            </button>
                        </div>
                    ) : (
                        <p className="text-[9px] text-white/25 text-center mb-2">長按動態可刪除 · 點「管理」可多選</p>
                    )}
                    <div className="space-y-2.5">
                        {shown.map(item => <FeedCard key={item.msgId} item={item} onJump={onJump} onRequestDelete={setConfirmDel}
                            manageMode={manageMode} selected={selectedIds.has(item.msgId)} onToggleSelect={toggleSelect} />)}
                    </div>
                </>
            )}
        </div>
        <ConfirmDialog open={!!confirmDel} title="刪除這條動態？" message={confirmDel ? `${confirmDel.charName} 在${getRoom(confirmDel.meta.room).name}的這條記錄將被移除。` : ''}
            onConfirm={() => { if (confirmDel) onDeleteFeed(confirmDel.msgId); setConfirmDel(null); }} onCancel={() => setConfirmDel(null)} />
        <ConfirmDialog open={confirmBatch} title={`刪除選中的 ${selectedIds.size} 條動態？`} message="動態即聊天裡的同一條卡片消息，刪除後聊天記錄裡對應的卡片也會一併移除。"
            onConfirm={() => { onDeleteFeedMany(Array.from(selectedIds)); setSelectedIds(new Set()); setConfirmBatch(false); }} onCancel={() => setConfirmBatch(false)} />
    </div>
    );
};

// 單條動態卡片：非管理態長按刪除；管理態點擊多選。已隱藏（對 AI 不可見）的暗顯並標「已隱藏」。
const FeedCard: React.FC<{ item: FeedItem; onJump: (novelId: string | undefined, segIdx: number) => void; onRequestDelete: (item: FeedItem) => void; manageMode?: boolean; selected?: boolean; onToggleSelect?: (msgId: number) => void }> = ({ item, onJump, onRequestDelete, manageMode, selected, onToggleSelect }) => {
    const room = getRoom(item.meta.room);
    const { pressing, handlers } = useLongPress(() => onRequestDelete(item), 550);
    const cardHandlers = manageMode ? { onClick: () => onToggleSelect?.(item.msgId) } : handlers;
    return (
        <div {...cardHandlers}
            className={`relative rounded-2xl p-3 flex gap-3 backdrop-blur-sm transition-transform ${pressing ? 'scale-[0.97]' : ''} ${manageMode ? 'cursor-pointer' : ''} ${item.hidden && !selected ? 'opacity-55' : ''}`}
            style={{ background: selected ? 'rgba(99,102,241,0.20)' : pressing ? 'rgba(244,63,94,0.14)' : 'rgba(255,255,255,0.05)', border: `1px solid ${selected ? 'rgba(129,140,248,0.6)' : pressing ? 'rgba(244,63,94,0.4)' : 'rgba(255,255,255,0.07)'}`, boxShadow: '0 4px 18px rgba(0,0,0,.22)' }}>
            {manageMode && (
                <div className="self-center shrink-0 h-5 w-5 rounded-full flex items-center justify-center" style={{ border: `1.5px solid ${selected ? '#818cf8' : 'rgba(255,255,255,.35)'}`, background: selected ? '#6366f1' : 'transparent' }}>
                    {selected && <Check size={12} weight="bold" className="text-white" />}
                </div>
            )}
            {item.avatar ? <TokenImg value={item.avatar} className="h-8 w-8 rounded-full object-cover shrink-0" alt="" /> : <div className="h-8 w-8 rounded-full bg-indigo-400/40 shrink-0" />}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-bold text-amber-200">{item.charName}</span>
                    <span className="text-indigo-300/50">{room.name}</span>
                    {item.hidden && <span className="text-[8px] text-white/55 rounded-full px-1.5 py-[1px] leading-none shrink-0" style={{ border: '1px solid rgba(255,255,255,.2)', background: 'rgba(0,0,0,.28)' }}>已隱藏</span>}
                    <span className="ml-auto text-indigo-300/40 text-[9px] shrink-0">{new Date(item.timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="text-[11.5px] text-indigo-50/90 mt-0.5 leading-snug">{stripSelfName(item.meta.activity, item.charName)}</p>
                {item.meta.behavior && <p className="text-[10.5px] text-pink-200/80 mt-1 leading-snug">{stripSelfName(item.meta.behavior, item.charName)}</p>}
                {item.meta.annotationRefs && item.meta.annotationRefs.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationRefs.slice(0, 3).map((ref, i) => (
                            <button key={i} onClick={() => { if (manageMode) { onToggleSelect?.(item.msgId); return; } onJump(item.meta.novelId, ref.segIdx); }}
                                className="block w-full text-left text-[10.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug active:opacity-60 hover:text-amber-100">
                                {stripLeakedAttrs(ref.text)} <span className="text-amber-300/60">↗原文</span>
                            </button>
                        ))}
                    </div>
                ) : item.meta.annotationExcerpts && item.meta.annotationExcerpts.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationExcerpts.slice(0, 2).map((ex, i) => (
                            <div key={i} className="text-[10.5px] text-indigo-200/70 pl-2 border-l-2 border-amber-300/40 leading-snug">{stripLeakedAttrs(ex)}</div>
                        ))}
                    </div>
                ) : null}
                {item.meta.room === 'postoffice' && item.meta.letterExcerpt && (
                    <div className="mt-1 text-[10.5px] text-amber-100/75 pl-2 border-l-2 border-amber-300/45 leading-snug" style={{ fontStyle: 'italic' }}>
                        「{item.meta.letterExcerpt.length > 70 ? item.meta.letterExcerpt.slice(0, 70) + '…' : item.meta.letterExcerpt}」
                    </div>
                )}
                {item.meta.room === 'signal' && item.meta.signalLine && (
                    <div className="mt-1">
                        <div className="text-[9.5px] text-indigo-300/55">
                            《{item.meta.poemTitle || '無題'}》{item.meta.poemLineSeq ? ` · 第 ${item.meta.poemLineSeq}/${item.meta.poemTargetLines || '?'} 句` : ''}{item.meta.signalIsNew ? ' · 起新篇' : ''}
                        </div>
                        <div className="mt-0.5 text-[11px] text-indigo-100/85 pl-2 border-l-2 border-indigo-300/45 leading-snug" style={{ fontStyle: 'italic' }}>
                            {item.meta.signalLine}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// 可展開全文（點擊切換截斷/完整）
const ExpandText: React.FC<{ text: string; limit?: number }> = ({ text, limit = 90 }) => {
    const [open, setOpen] = useState(false);
    const long = text.length > limit;
    return (
        <span onClick={() => long && setOpen(o => !o)} className={long ? 'cursor-pointer' : ''}>
            <span className="whitespace-pre-wrap">{open || !long ? text : text.slice(0, limit) + '…'}</span>
            {long && <span className="text-amber-300/70 ml-1 text-[10px]">{open ? '收起' : '展開全文'}</span>}
        </span>
    );
};

// ============ 郵局信件管理面板 ============
const PostOfficePanel: React.FC<{ addToast?: (m: string, t?: any) => void; characters: CharacterProfile[]; userName: string }> = ({ addToast, characters, userName }) => {
    const [letters, setLetters] = useState<VRLetter[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [menuFor, setMenuFor] = useState<VRLetter | null>(null);
    const [editing, setEditing] = useState<VRLetter | null>(null);
    const [confirmDel, setConfirmDel] = useState<VRLetter | null>(null);
    const [inboxMenu, setInboxMenu] = useState<VRLetter | null>(null);   // 來信長按菜單
    const [assignFor, setAssignFor] = useState<VRLetter | null>(null);   // 指定角色回信的選人面板
    const [replyFor, setReplyFor] = useState<VRLetter | null>(null);     // 親自回信編輯器
    const [replyMenu, setReplyMenu] = useState<VRLetter | null>(null);   // 待發送回信的長按菜單
    const [editReplyFor, setEditReplyFor] = useState<VRLetter | null>(null); // 編輯待發送回信
    const [confirmReport, setConfirmReport] = useState<VRLetter | null>(null); // 點踩=舉報二次確認
    const [identityOpen, setIdentityOpen] = useState(false);            // 身份導出/導入彈窗
    const [adminOpen, setAdminOpen] = useState(false);                  // 後台（看後端全部信件）彈窗
    const [composeNew, setComposeNew] = useState<VRLetter | null>(null); // 用戶自己寫新信的草稿
    const [myStats, setMyStats] = useState<Record<string, RemoteLetterStat>>({}); // 我寄出的信熱度（按 remoteId）
    const [tab, setTab] = useState<'outbox' | 'reply' | 'replied' | 'inbox' | 'drift' | 'box'>('outbox'); // 左側分類
    const [sentMenu, setSentMenu] = useState<VRLetter | null>(null);     // 已寄出信的管理菜單
    const [confirmDelSent, setConfirmDelSent] = useState<VRLetter | null>(null); // 刪除已寄出信的確認
    const enabledChars = characters.filter(c => c.vrState?.enabled);

    const load = useCallback(async () => setLetters(await DB.getVRLetters()), []);
    const loadStats = useCallback(async () => {
        try {
            const stats = await PostOffice.fetchMyStats();
            const map: Record<string, RemoteLetterStat> = {};
            stats.forEach(s => { map[s.id] = s; });
            setMyStats(map);
        } catch { /* 離線/失敗不影響其它功能 */ }
    }, []);
    useEffect(() => {
        void load(); void loadStats();
        const h = () => { void load(); void loadStats(); };
        window.addEventListener('vr-session-done', h);
        return () => window.removeEventListener('vr-session-done', h);
    }, [load, loadStats]);

    const outQueued = letters.filter(l => l.box === 'outbox' && l.status === 'queued');
    const replyQueued = letters.filter(l => l.box === 'inbox' && l.replyStatus === 'queued' && l.reply);
    const repliedSent = letters.filter(l => l.box === 'inbox' && l.replyStatus === 'sent' && l.reply);
    const inboxWaiting = letters.filter(l => l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none');
    const sentAwaiting = letters.filter(l => l.box === 'outbox' && l.status === 'sent');
    const archived = letters.filter(l => l.box === 'outbox' && (l.status === 'archived' || l.status === 'sealed'));

    const sendOutbox = async () => {
        if (outQueued.length === 0) return;
        // A：正文超長就攔下，讓用戶先編輯精簡，不靜默截斷
        const tooLong = outQueued.filter(l => charLen(l.content) > MAX_LETTER_CHARS);
        if (tooLong.length) { addToast?.(`有 ${tooLong.length} 封超過 ${MAX_LETTER_CHARS} 字，請長按編輯精簡後再寄`, 'error'); return; }
        // B：前端日額度（給後端減負），額度不夠就只寄能寄的那幾封，其餘留隊列
        const q = readQuota(PO_SEND_QUOTA);
        const remaining = Math.max(0, PO_SEND_QUOTA.limit - q.count);
        if (remaining <= 0) { addToast?.(`寄信暫時到上限（${PO_SEND_QUOTA.limit} 封/${PO_SEND_QUOTA.windowMs / 3600_000} 小時），約 ${quotaResetHours(q.windowStart, PO_SEND_QUOTA.windowMs)} 小時後恢復`, 'info'); return; }
        const batch = outQueued.slice(0, remaining);
        const heldBack = outQueued.length - batch.length;
        setBusy('send');
        try {
            const ids = await PostOffice.uploadLetters(batch.map(l => ({ pen: l.pen, content: l.content })));
            await DB.saveVRLetters(batch.map((l, i) => ({ ...l, status: 'sent', remoteId: ids[i], sentAt: Date.now() })));
            bumpQuota(PO_SEND_QUOTA, batch.length);
            await load();
            trackEvent('一键寄出漂流信');
            addToast?.(heldBack > 0
                ? `已寄出 ${ids.length} 封，額度用完，還剩 ${heldBack} 封約 ${quotaResetHours(readQuota(PO_SEND_QUOTA).windowStart, PO_SEND_QUOTA.windowMs)} 小時後再寄`
                : `已寄出 ${ids.length} 封漂流信`, 'success');
        } catch (e: any) {
            const msg = /429|rate limit/i.test(e?.message || '')
                ? '後端每 5 小時限 5 封，剛寄太猛被擋了，待會兒再寄剩下的（信都還在隊列）'
                : '寄出失敗：' + (e?.message || '檢查網絡');
            addToast?.(msg, 'error');
        } finally { setBusy(null); }
    };
    const refreshInbox = async () => {
        setBusy('inbox');
        try {
            const n = 2 + Math.floor(Math.random() * 4); // 每次隨機撈 2~5 封，別一次太猛
            const remote = await PostOffice.fetchInbox(n);
            const fresh: VRLetter[] = remote.map(r => ({ id: genLocalId('lt'), box: 'inbox', pen: r.pen, content: r.content, createdAt: r.created_at, remoteLetterId: r.id, replyStatus: 'none', fetchedAt: Date.now(), likes: r.likes ?? 0, dislikes: r.dislikes ?? 0, views: r.views ?? 0, myVote: 0 }));
            await DB.saveVRLetters(fresh);
            await load(); addToast?.(remote.length ? `收到 ${remote.length} 封陌生來信` : '暫時沒有新的來信', 'info');
        } catch (e: any) { addToast?.('刷新失敗：' + (e?.message || '檢查網絡'), 'error'); } finally { setBusy(null); }
    };
    const sendReplies = async () => {
        if (replyQueued.length === 0) return;
        // 前端日額度：每天最多 PO_REPLY_QUOTA.limit 封回信，額度不足只發能發的，其餘留隊列
        const q = readQuota(PO_REPLY_QUOTA);
        const remaining = Math.max(0, PO_REPLY_QUOTA.limit - q.count);
        if (remaining <= 0) { addToast?.(`今天已回滿 ${PO_REPLY_QUOTA.limit} 封，約 ${quotaResetHours(q.windowStart, PO_REPLY_QUOTA.windowMs)} 小時後恢復`, 'info'); return; }
        const batch = replyQueued.slice(0, remaining);
        const heldBack = replyQueued.length - batch.length;
        setBusy('reply');
        try {
            const payload = batch.map(l => ({
                letterId: l.remoteLetterId!, pen: l.reply!.pen,
                content: l.reply!.userNote ? `${l.reply!.content}\n\n——\n${l.reply!.userNote}` : l.reply!.content,
            }));
            await PostOffice.uploadReplies(payload);
            bumpQuota(PO_REPLY_QUOTA, batch.length);
            await DB.saveVRLetters(batch.map(l => ({ ...l, replyStatus: 'sent' as const })));
            await load();
            trackEvent('一键发送待发的回信');
            addToast?.(heldBack > 0
                ? `已發出 ${payload.length} 封回信，今日額度用完，還剩 ${heldBack} 封約 ${quotaResetHours(readQuota(PO_REPLY_QUOTA).windowStart, PO_REPLY_QUOTA.windowMs)} 小時後再發`
                : `已發出 ${payload.length} 封回信`, heldBack > 0 ? 'info' : 'success');
        } catch (e: any) { addToast?.('發送失敗：' + (e?.message || '檢查網絡'), 'error'); } finally { setBusy(null); }
    };
    const collectReplies = async () => {
        setBusy('collect');
        void loadStats();   // 順手刷新「我寄出的信」贊/踩/瀏覽/回信數
        try {
            const replies = await PostOffice.fetchReplies();
            if (replies.length === 0) { addToast?.('還沒有人回你的信', 'info'); setBusy(null); return; }
            const byLetter = new Map<string, RemoteReply[]>();
            replies.forEach(r => { const a = byLetter.get(r.letter_id) || []; a.push(r); byLetter.set(r.letter_id, a); });
            // 一封漂流信可能被多個陌生人撿到、陸續回信。所以這裡"刷新"而不是"一次性領取後釋放"：
            // 把後端當前的全部回覆同步到本地（含已留檔但還沒被角色讀封存的），不釋放；
            // 等原作者角色逛到郵局讀完、寫下感觸、封存時才釋放後端（見 runSession）。
            const pending = letters.filter(l => l.box === 'outbox' && l.remoteId && (l.status === 'sent' || l.status === 'archived'));
            const updates: VRLetter[] = [];
            let newlyArchived = 0, addedReplies = 0;
            for (const l of pending) {
                const rs = byLetter.get(l.remoteId!);
                if (!rs || rs.length === 0) continue;
                const before = l.repliesReceived?.length || 0;
                if (rs.length > before || l.status === 'sent') {
                    if (l.status === 'sent') newlyArchived++;
                    addedReplies += Math.max(0, rs.length - before);
                    updates.push({ ...l, status: 'archived', repliesReceived: rs.map(x => ({ pen: x.pen, content: x.content, createdAt: x.created_at })) });
                }
            }
            if (updates.length) await DB.saveVRLetters(updates);
            await load();
            addToast?.(updates.length
                ? `收到回覆（${newlyArchived ? `${newlyArchived} 封新留檔` : '已更新'}${addedReplies ? ` · 新增 ${addedReplies} 條` : ''}），等角色去郵局讀`
                : '回覆還沒匹配到你的信', 'success');
        } catch (e: any) { addToast?.('收取失敗：' + (e?.message || '檢查網絡'), 'error'); } finally { setBusy(null); }
    };

    const setUserNote = async (l: VRLetter, note: string) => {
        const next = { ...l, reply: { ...l.reply!, userNote: note } };
        setLetters(prev => prev.map(x => x.id === l.id ? next : x));
        await DB.saveVRLetter(next);
    };
    const del = async (id: string) => { await DB.deleteVRLetter(id); await load(); };
    const saveEdit = async (pen: string, content: string) => {
        if (!editing) return;
        const next = { ...editing, pen: pen.trim() || editing.pen, content: content.trim() };
        await DB.saveVRLetter(next); setEditing(null); await load();
    };
    // 指定某角色去郵局回這封來信（走 LLM）
    const assignReply = (charId: string) => {
        if (!assignFor) return;
        VRScheduler.triggerNow(charId, 'postoffice', assignFor.id);
        const cname = enabledChars.find(c => c.id === charId)?.name;
        addToast?.(`${cname ?? '角色'} 正在去郵局回這封信…`, 'info');
        trackEvent('指定角色去邮局回这封来信');
        setAssignFor(null);
        setTimeout(() => void load(), 5000);
    };
    // 用戶親自回信（不調用 LLM），排入"待發送的回信"
    const saveManualReply = async (pen: string, content: string) => {
        if (!replyFor) return;
        const next: VRLetter = { ...replyFor, replyStatus: 'queued', reply: { charId: 'user', pen: pen.trim() || userName, content: content.trim(), createdAt: Date.now() } };
        await DB.saveVRLetter(next); setReplyFor(null); await load();
        addToast?.('回信已寫好，去「待發送的回信」一鍵發送', 'success');
    };
    // 編輯一條待發送的回信（改筆名 / 正文）
    const saveReplyEdit = async (pen: string, content: string) => {
        if (!editReplyFor || !editReplyFor.reply) return;
        const next: VRLetter = { ...editReplyFor, reply: { ...editReplyFor.reply, pen: pen.trim() || editReplyFor.reply.pen, content: content.trim() } };
        await DB.saveVRLetter(next); setEditReplyFor(null); await load();
    };

    // 投票：點贊(1)/點踩=舉報(-1)/撤銷(0)。踩滿閾值後端會刪信 → 本地移除
    const doVote = async (l: VRLetter, vote: 1 | -1 | 0) => {
        if (!l.remoteLetterId) return;
        try {
            const r = await PostOffice.vote(l.remoteLetterId, vote);
            trackEvent('给陌生来信点赞或举报', { vote: vote === 1 ? 'like' : vote === -1 ? 'report' : 'cancel' });
            if (r.deleted) { await DB.deleteVRLetter(l.id); await load(); addToast?.('這封信被舉報夠數，已移除', 'info'); return; }
            await DB.saveVRLetter({ ...l, likes: r.likes, dislikes: r.dislikes, myVote: vote }); await load();
        } catch (e: any) { addToast?.('操作失敗：' + (e?.message || '檢查網絡'), 'error'); }
    };
    const onLike = (l: VRLetter) => void doVote(l, l.myVote === 1 ? 0 : 1);
    const onDislike = (l: VRLetter) => { if (l.myVote === -1) void doVote(l, 0); else setConfirmReport(l); };

    // 用戶自己從零寫一封新漂流信 → 落「待寄出」隊列
    const startCompose = () => setComposeNew({ id: genLocalId('lt'), box: 'outbox', pen: userName, content: '', createdAt: Date.now(), status: 'queued', charId: 'user' });
    const saveNewLetter = async (pen: string, content: string) => {
        if (!composeNew) return;
        await DB.saveVRLetter({ ...composeNew, pen: pen.trim() || userName, content: content.trim() });
        setComposeNew(null); await load();
        addToast?.('寫好了，去「待寄出」一鍵寄出', 'success');
    };

    // 導入身份碼
    const doImport = (code: string) => {
        if (importIdentity(code)) { addToast?.('身份已導入', 'success'); setIdentityOpen(false); void load(); void loadStats(); }
        else addToast?.('身份碼無效（格式或校驗位不對）', 'error');
    };

    // 作者停止傳播：後端刪（退出公共池、不再被陌生人抽到/回信），本地留檔
    const stopDrift = async (l: VRLetter) => {
        if (!l.remoteId) { addToast?.('這封還沒寄出', 'info'); return; }
        try { await PostOffice.release([l.remoteId]); await DB.saveVRLetter({ ...l, released: true }); await load(); addToast?.('已停止傳播，本地仍留檔', 'success'); }
        catch (e: any) { addToast?.('操作失敗：' + (e?.message || '檢查網絡'), 'error'); }
    };
    // 作者刪除已寄出的信：後端刪 + 本地刪
    const deleteSent = async (l: VRLetter) => {
        try { if (l.remoteId && !l.released) await PostOffice.release([l.remoteId]); await DB.deleteVRLetter(l.id); await load(); addToast?.('已刪除', 'success'); }
        catch (e: any) { addToast?.('刪除失敗：' + (e?.message || '檢查網絡'), 'error'); }
    };

    // 「我寄出的信」的熱度行（贊/踩/瀏覽/回信）；沒數據就不顯示
    const statLine = (remoteId?: string) => {
        const s = remoteId ? myStats[remoteId] : undefined;
        if (!s) return null;
        return <div className="text-[9.5px] text-white/35 mt-1">贊 {s.likes}　踩 {s.dislikes}　閱 {s.views}　回 {s.reply_count}</div>;
    };

    return (
        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad('0.75rem'), background: 'rgba(30,24,14,0.66)', border: '1px solid rgba(220,190,120,0.25)', boxShadow: '0 8px 26px rgba(0,0,0,.45)' }}>
            {/* 動作行 */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/10 shrink-0">
                <span className="text-[11px] tracking-[0.2em] text-amber-100/80 mr-auto" style={{ fontFamily: `'Noto Serif SC',serif` }}>郵局</span>
                <button onClick={refreshInbox} disabled={!!busy} className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90 disabled:opacity-40">{busy === 'inbox' ? '…' : '刷新收件箱'}</button>
                <button onClick={collectReplies} disabled={!!busy} className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90 disabled:opacity-40">{busy === 'collect' ? '…' : '收取回復'}</button>
                <button onClick={() => setIdentityOpen(true)} title="郵局身份導出/導入" className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90">身份</button>
                {/* 後台入口只在本地開發（vite dev）下出現；部署到網頁後普通用戶看不到。仍需 ADMIN_TOKEN 才能拉數據。 */}
                {import.meta.env.DEV && <button onClick={() => setAdminOpen(true)} title="後台：看後端全部信件（需 ADMIN_TOKEN，僅本地可見）" className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90">後台</button>}
            </div>

            <div className="flex-1 flex min-h-0">
                {/* 左側分類欄 */}
                <div className="w-[76px] shrink-0 overflow-y-auto vr-reader-scroll border-r border-white/10 py-2 px-1.5 space-y-1">
                    {([
                        { key: 'outbox', label: '待寄出', count: outQueued.length, tone: '#e8b75e' },
                        { key: 'reply', label: '待發送', count: replyQueued.length, tone: '#e8b75e' },
                        { key: 'replied', label: '已回', count: repliedSent.length, tone: '#86e3b0' },
                        { key: 'inbox', label: '收件箱', count: inboxWaiting.length, tone: '#7dd3fc' },
                        { key: 'drift', label: '漂流中', count: sentAwaiting.length, tone: '#93b8ff' },
                        { key: 'box', label: '信匣', count: archived.length, tone: '#86e3b0' },
                    ] as const).map(t => {
                        const active = tab === t.key;
                        return (
                            <button key={t.key} onClick={() => { setTab(t.key); trackEvent('切换邮局信件分类', { category: t.key }); }}
                                className="w-full rounded-lg px-1.5 py-2 text-left transition-colors"
                                style={{ background: active ? 'rgba(255,255,255,.09)' : 'transparent', border: `1px solid ${active ? 'rgba(255,255,255,.14)' : 'transparent'}` }}>
                                <div className="flex items-center gap-1">
                                    <span className="h-2.5 w-[3px] rounded-full shrink-0" style={{ background: active ? t.tone : 'transparent' }} />
                                    <span className={`text-[11px] ${active ? 'text-white font-semibold' : 'text-white/55'}`} style={{ fontFamily: `'Noto Serif SC',serif` }}>{t.label}</span>
                                </div>
                                {t.count > 0 && <div className="text-[9px] mt-0.5 pl-2" style={{ color: t.tone }}>{t.count}</div>}
                            </button>
                        );
                    })}
                </div>

                {/* 右側正文 */}
                <div className="flex-1 min-w-0 overflow-y-auto vr-reader-scroll px-3 py-2.5">
                    {tab === 'outbox' && (() => {
                        const q = readQuota(PO_SEND_QUOTA);
                        const full = q.count >= PO_SEND_QUOTA.limit;
                        return (
                            <>
                                {/* 寄信額度：5 封/5 小時（與後端一致），常駐顯示 */}
                                <div className="flex items-center justify-between gap-2 text-[10px] mb-2.5 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <span className="text-white/55">已寄 <b className={full ? 'text-red-300' : 'text-amber-200/90'}>{q.count}</b><span className="text-white/35"> / {PO_SEND_QUOTA.limit}（每 {PO_SEND_QUOTA.windowMs / 3600_000} 小時）</span></span>
                                    {q.count > 0 && <span className="text-white/35">約 {quotaResetHours(q.windowStart, PO_SEND_QUOTA.windowMs)} 小時後{full ? '恢復' : '歸零'}</span>}
                                </div>
                                {outQueued.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">角色在郵局寫的漂流信會排在這裡，你確認後一鍵寄出。也可以自己寫一封。寄出時筆名會自動匿名。</p> : (
                                    <>
                                        <PagedList items={outQueued} perPage={6} render={l => <PendingLetterRow key={l.id} l={l} onMenu={setMenuFor} />} />
                                        <button onClick={sendOutbox} disabled={!!busy || full} className="w-full mt-1 rounded-full py-2 text-[12px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{busy === 'send' ? '寄出中…' : full ? `寄信已到上限（${PO_SEND_QUOTA.limit} 封/${PO_SEND_QUOTA.windowMs / 3600_000}h）` : `一鍵寄出（${outQueued.length}）`}</button>
                                    </>
                                )}
                                <button onClick={startCompose} className="w-full mt-1.5 rounded-full py-1.5 text-[11px] text-amber-100/90" style={{ border: '1px solid rgba(220,190,120,.3)' }}>自己寫一封新漂流信</button>
                            </>
                        );
                    })()}

                    {tab === 'reply' && (() => {
                        const rq = readQuota(PO_REPLY_QUOTA);
                        const full = rq.count >= PO_REPLY_QUOTA.limit;
                        return (
                            <>
                                {/* 回信日額度：常駐顯示，用完鎖發送 */}
                                <div className="flex items-center justify-between gap-2 text-[10px] mb-2.5 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <span className="text-white/55">今日已回 <b className={full ? 'text-red-300' : 'text-amber-200/90'}>{rq.count}</b><span className="text-white/35"> / {PO_REPLY_QUOTA.limit}</span></span>
                                    {rq.count > 0 && <span className="text-white/35">約 {quotaResetHours(rq.windowStart, PO_REPLY_QUOTA.windowMs)} 小時後{full ? '恢復' : '歸零'}</span>}
                                </div>
                                {replyQueued.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">你親自寫好、還沒發出的回信會排在這裡。</p> : (
                                    <>
                                        <PagedList items={replyQueued} perPage={6} render={l => (
                                            <div key={l.id} className="rounded-lg p-2 mb-1.5" style={{ background: 'rgba(255,255,255,.05)' }}>
                                                <div className="flex items-start gap-1.5 mb-1">
                                                    <p className="flex-1 min-w-0 text-[10.5px] text-white/55 leading-snug">原信（{l.pen}）：<ExpandText text={l.content} limit={80} /></p>
                                                    <button onClick={() => setReplyMenu(l)} className="shrink-0 text-white/35 text-[14px] leading-none px-1 -mt-0.5 active:text-white/70">···</button>
                                                </div>
                                                <p className="text-[11.5px] text-amber-50/90 leading-snug whitespace-pre-wrap">回信（{l.reply!.pen}）：{l.reply!.content}</p>
                                                <input value={l.reply!.userNote || ''} onChange={e => setUserNote(l, e.target.value)} placeholder="想補充幾句一起回？（選填）"
                                                    className="w-full mt-1.5 rounded-md bg-black/20 px-2 py-1 text-[11px] text-white placeholder-white/30 outline-none" />
                                            </div>
                                        )} />
                                        <button onClick={sendReplies} disabled={!!busy || full} className="w-full mt-1 rounded-full py-2 text-[12px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{busy === 'reply' ? '發送中…' : full ? `今日已回滿 ${PO_REPLY_QUOTA.limit} 封` : `一鍵發送回信（${replyQueued.length}）`}</button>
                                    </>
                                )}
                            </>
                        );
                    })()}

                    {tab === 'replied' && (
                        repliedSent.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">已經發出去的回信會歸檔在這裡（連同原來的陌生來信）。本地留存，可隨設備備份導出/導入。</p> : (
                            <PagedList items={repliedSent} perPage={6} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5" style={{ background: 'rgba(255,255,255,.05)' }}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-sky-200/70 text-[9.5px]">來自 {l.pen}</span>
                                        <span className="text-[8px] text-emerald-200/70 border border-emerald-300/30 rounded-full px-1.5 leading-tight">已發出</span>
                                    </div>
                                    <p className="text-[10.5px] text-white/55 leading-snug mb-1">原信：<ExpandText text={l.content} limit={80} /></p>
                                    <p className="text-[11.5px] text-amber-50/90 leading-snug whitespace-pre-wrap pl-2 border-l-2 border-amber-300/40">回信（{l.reply!.pen}）：{l.reply!.content}{l.reply!.userNote ? `\n——\n${l.reply!.userNote}` : ''}</p>
                                </div>
                            )} />
                        )
                    )}

                    {tab === 'inbox' && (
                        inboxWaiting.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">點上方「刷新收件箱」撈陌生人寄來的信。收到後長按某封，指定角色去回、或你親自回。</p> : (
                            <>
                                <p className="text-[9.5px] text-white/35 mb-1.5 leading-snug">陌生人寄來的信。等角色逛到郵局會自己回，也可以<b className="text-sky-200/80">長按某封信</b>，指定角色去回、或你親自回。</p>
                                <PagedList items={inboxWaiting} perPage={7} render={l => <InboxLetterRow key={l.id} l={l} onMenu={setInboxMenu} onLike={onLike} onDislike={onDislike} />} />
                            </>
                        )
                    )}

                    {tab === 'drift' && (
                        sentAwaiting.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">已寄出、還在等陌生人回信的漂流信會顯示在這裡。</p> : (
                            <PagedList items={sentAwaiting} perPage={7} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <div className="flex items-start gap-1.5">
                                        <div className="flex-1 min-w-0 text-white/70 leading-snug"><ExpandText text={l.content} limit={70} /></div>
                                        <button onClick={() => setSentMenu(l)} className="shrink-0 text-white/35 text-[14px] leading-none px-1 -mt-0.5 active:text-white/70">···</button>
                                    </div>
                                    {l.released && <span className="inline-block mt-1 text-[8px] text-white/45 border border-white/15 rounded-full px-1.5 leading-tight">已停止傳播</span>}
                                    {statLine(l.remoteId)}
                                </div>
                            )} />
                        )
                    )}

                    {tab === 'box' && (
                        archived.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">收到陌生人回信、被角色讀過封存的信會留檔在這裡。</p> : (
                            <PagedList items={archived} perPage={5} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.05)' }}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-amber-200/70 text-[9.5px]">{l.pen}的信</span>
                                        {l.status === 'sealed' && <span className="text-[8px] text-amber-200/60 border border-amber-300/30 rounded-full px-1.5 leading-tight">已封存</span>}
                                        {l.released && <span className="text-[8px] text-white/45 border border-white/15 rounded-full px-1.5 leading-tight">已停止傳播</span>}
                                        <button onClick={() => setSentMenu(l)} className="ml-auto shrink-0 text-white/35 text-[14px] leading-none px-1 active:text-white/70">···</button>
                                    </div>
                                    <div className="text-amber-50/80 leading-snug mb-1"><ExpandText text={l.content} limit={70} /></div>
                                    {statLine(l.remoteId)}
                                    {(l.repliesReceived || []).map((r, i) => (
                                        <div key={i} className="text-[11px] text-amber-100/85 pl-2 border-l-2 border-amber-300/40 leading-snug mt-1"><span className="font-bold">{r.pen}</span> 回：<ExpandText text={r.content} limit={120} /></div>
                                    ))}
                                    {l.reaction?.content && (
                                        <div className="text-[10.5px] text-pink-200/80 mt-1.5 pl-2 border-l-2 border-pink-300/40 leading-snug">讀後：{l.reaction.content}</div>
                                    )}
                                </div>
                            )} />
                        )
                    )}
                </div>
            </div>

            {/* 長按菜單 / 編輯 / 刪除確認 */}
            <ActionSheet open={!!menuFor} title={menuFor ? `「${menuFor.pen}」的待寄信` : ''}
                actions={[
                    { label: '編輯', onClick: () => { setEditing(menuFor); setMenuFor(null); } },
                    { label: '刪除', danger: true, onClick: () => { setConfirmDel(menuFor); setMenuFor(null); } },
                ]} onClose={() => setMenuFor(null)} />
            {editing && <LetterEditModal letter={editing} onSave={saveEdit} onCancel={() => setEditing(null)} />}
            <ConfirmDialog open={!!confirmDel} title="刪除這封信？"
                message={confirmDel ? (confirmDel.box === 'inbox'
                    ? (confirmDel.replyStatus === 'queued' ? '這封陌生來信和你寫好的回信都會被丟棄。' : '這封陌生來信將從本地刪除。')
                    : '這封還沒寄出的漂流信將被丟棄。') : ''}
                onConfirm={() => { if (confirmDel) void del(confirmDel.id); setConfirmDel(null); }} onCancel={() => setConfirmDel(null)} />

            {/* 已寄出信的作者管理：停止傳播 / 刪除 */}
            <ActionSheet open={!!sentMenu} title={sentMenu ? '管理這封已寄出的信' : ''}
                actions={[
                    ...(sentMenu && !sentMenu.released ? [{ label: '停止傳播（退出公共池，本地留檔）', onClick: () => { const l = sentMenu; setSentMenu(null); if (l) void stopDrift(l); } }] : []),
                    { label: '刪除這封信（本地與後端都刪）', danger: true, onClick: () => { setConfirmDelSent(sentMenu); setSentMenu(null); } },
                ]} onClose={() => setSentMenu(null)} />
            <ConfirmDialog open={!!confirmDelSent} title="刪除這封信？" message="本地留檔與公共池裡的這封信都會被刪除，相關回信也一併清除，不可恢復。"
                onConfirm={() => { if (confirmDelSent) void deleteSent(confirmDelSent); setConfirmDelSent(null); }} onCancel={() => setConfirmDelSent(null)} />

            {/* 來信長按菜單：指定角色回 / 親自回 / 刪除 */}
            <ActionSheet open={!!inboxMenu} title={inboxMenu ? `回「${inboxMenu.pen}」的來信` : ''}
                actions={[
                    { label: '指定角色去回（用 AI）', onClick: () => { if (enabledChars.length === 0) { addToast?.('先在「角色接入」裡啟用角色', 'info'); setInboxMenu(null); return; } setAssignFor(inboxMenu); setInboxMenu(null); } },
                    { label: '我親自回（不用 AI）', onClick: () => { setReplyFor(inboxMenu); setInboxMenu(null); } },
                    { label: '刪除這封來信', danger: true, onClick: () => { setConfirmDel(inboxMenu); setInboxMenu(null); } },
                ]} onClose={() => setInboxMenu(null)} />
            {/* 選哪個角色去回 */}
            <ActionSheet open={!!assignFor} title={assignFor ? `讓誰去回「${assignFor.pen}」的信？` : ''}
                actions={enabledChars.map(c => ({ label: c.name, onClick: () => assignReply(c.id) }))}
                onClose={() => setAssignFor(null)} />
            {replyFor && <ReplyComposeModal letter={replyFor} defaultPen={userName} onSave={saveManualReply} onCancel={() => setReplyFor(null)} />}

            {/* 待發送回信：編輯 / 刪除 */}
            <ActionSheet open={!!replyMenu} title={replyMenu ? `這條待發送的回信（回 ${replyMenu.pen}）` : ''}
                actions={[
                    { label: '編輯回信', onClick: () => { setEditReplyFor(replyMenu); setReplyMenu(null); } },
                    { label: '刪除（連來信一起丟棄）', danger: true, onClick: () => { setConfirmDel(replyMenu); setReplyMenu(null); } },
                ]} onClose={() => setReplyMenu(null)} />
            {editReplyFor && editReplyFor.reply && <ReplyComposeModal letter={editReplyFor} defaultPen={editReplyFor.reply.pen} initialContent={editReplyFor.reply.content} title="編輯這條回信" cta="保存" onSave={saveReplyEdit} onCancel={() => setEditReplyFor(null)} />}

            {/* 投票=舉報 二次確認 */}
            <ConfirmDialog open={!!confirmReport} title="點踩 = 舉報這封信？" confirmText="確認舉報"
                message="踩等於舉報。一封信被 5 個不同設備舉報會被自動刪除，不可恢復。"
                onConfirm={() => { if (confirmReport) void doVote(confirmReport, -1); setConfirmReport(null); }} onCancel={() => setConfirmReport(null)} />
            {/* 用戶自己寫新漂流信 */}
            {composeNew && <LetterEditModal letter={composeNew} title="寫一封新漂流信" onSave={saveNewLetter} onCancel={() => setComposeNew(null)} />}
            {/* 身份導出/導入 */}
            {identityOpen && <IdentityModal onImport={doImport} onClose={() => setIdentityOpen(false)} />}
            {/* 後台：看後端全部信件 */}
            {adminOpen && <AdminModal onClose={() => setAdminOpen(false)} />}
        </div>
    );
};

// ============ 房間場景（全屏） ============
const toSong = (s: CharPlaylistSong): Song => ({ id: s.id, name: s.name, artists: s.artists, album: s.album, albumPic: s.albumPic, duration: s.duration, fee: s.fee ?? 0 });

// ============ 信號墜落處面板（只讀：正在墜落的詩 + 封存成星圖）============
// 滿配可視化：當前詩按「信號墜落」豎向沉積，你 char 的句子暖光標「你」；封存
// 的詩散成夜空裡的衛星，你參與過的帶光暈。點開任一顆讀全文。讀詩永遠第一。

const signalHashX = (id: string): number => {
    let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return 12 + (h % 62); // 12%–74%，避免貼邊
};
// 剝掉標題裡可能自帶的書名號——UI 統一包一層《》，兼容舊詩裡存成《《…》》的數據
const cleanTitle = (t?: string) => (t || '').replace(/^[《〈「『【]+/, '').replace(/[》〉」』】]+$/, '') || '無題';
const isMineLine = (l: SignalPoem['lines'][number]) => !!l.mine;

/** 一句詩的展示行：mine 暖光 +「你」（有本地歸屬則「你 · 角色名」）。 */
// ordinal = 順位行號（第幾行）。別直接顯示 l.seq：管理員刪過句後 seq 有洞（1,2,4…）會跳號；
// seq 只作內部排序鍵與「你·角色」歸屬的 key。
const PoemLineRow: React.FC<{ l: SignalPoem['lines'][number]; showSeq?: boolean; ordinal?: number; mineName?: string }> = ({ l, showSeq, ordinal, mineName }) => {
    const mine = isMineLine(l);
    return (
        <div className="flex gap-3 items-start py-2" style={{ borderBottom: '1px solid rgba(201,168,106,.1)' }}>
            {showSeq && <span className="tabular-nums text-[10px] mt-1 shrink-0 w-5 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: mine ? 'rgba(240,220,168,.7)' : 'rgba(201,168,106,.4)' }}>{ordinal ?? l.seq}</span>}
            <span className="flex-1 leading-relaxed" style={{ fontSize: '13.5px', fontFamily: `'Noto Serif SC',serif` }}>
                <span style={{ color: mine ? '#f3e2b4' : 'rgba(233,222,201,.9)', textShadow: mine ? '0 0 12px rgba(201,168,106,.5)' : 'none' }}>{l.content}</span>
                {mine
                    ? <span className="ml-2 text-[8px] align-middle rounded-sm px-1.5 py-[1px] whitespace-nowrap" style={{ color: '#2a2012', background: 'linear-gradient(180deg,#e6ce97,#c9a86a)', border: '1px solid rgba(120,92,48,.5)' }}>{mineName ? `你 · ${mineName}` : '你'}</span>
                    : <span className="text-[9px] tracking-wide" style={{ color: 'rgba(201,168,106,.45)' }}> — {l.pen}</span>}
            </span>
        </div>
    );
};

// 信號墜落處 · 後台（dev-only）：刪詩 / 刪句 / 暫停詩歌推入。憑 ADMIN_TOKEN（與漂流瓶同一個）。
const SignalAdminPanel: React.FC<{ onClose: () => void; addToast?: (m: string, t?: any) => void }> = ({ onClose, addToast }) => {
    const [token, setToken] = useState(getAdminToken());
    const [poems, setPoems] = useState<SignalPoem[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmPoem, setConfirmPoem] = useState<string | null>(null);

    const load = useCallback(async (tk: string) => {
        if (!tk.trim()) { addToast?.('先填 ADMIN_TOKEN', 'error'); return; }
        setBusy(true);
        try {
            setAdminToken(tk.trim());
            const r = await Signal.adminList(tk.trim());
            setPoems(r.poems); setLoaded(true);
        } catch (e: any) {
            addToast?.(String(e?.message).includes('unauthorized') ? 'ADMIN_TOKEN 不對' : '拉取失敗：' + (e?.message || ''), 'error');
        } finally { setBusy(false); }
    }, [addToast]);

    const delPoem = async (id: string) => {
        setBusy(true);
        try { await Signal.adminDelete(token.trim(), { poemId: id }); setPoems(ps => ps.filter(p => p.id !== id)); addToast?.('整首已刪', 'success'); }
        catch { addToast?.('刪除失敗', 'error'); } finally { setBusy(false); setConfirmPoem(null); }
    };
    const delLine = async (poemId: string, seq: number) => {
        setBusy(true);
        try {
            await Signal.adminDelete(token.trim(), { poemId, seq });
            setPoems(ps => ps.map(p => p.id === poemId ? { ...p, lines: p.lines.filter(l => l.seq !== seq), lineCount: p.lineCount - 1 } : p));
            addToast?.('該句已刪', 'success');
        } catch { addToast?.('刪除失敗', 'error'); } finally { setBusy(false); }
    };

    return (
        <div className="absolute inset-0 z-40 flex flex-col" style={{ background: 'rgba(6,7,22,0.97)' }}>
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/10">
                <span className="text-[12px] tracking-wider text-amber-100/90">信號墜落處 · 後台</span>
                <button onClick={onClose} className="ml-auto h-7 w-7 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"><X size={14} /></button>
            </div>
            <div className="px-3.5 py-2.5 border-b border-white/10 space-y-2">
                <p className="text-[9.5px] text-white/45 leading-snug">活動已永久封存。用 worker 的 <b className="text-amber-200/70">ADMIN_TOKEN</b>（和漂流瓶後台同一個）維護存檔：刪整首 / 刪單句。token 只存本機。</p>
                <div className="flex gap-1.5">
                    <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="ADMIN_TOKEN"
                        className="flex-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                    <button onClick={() => load(token)} disabled={busy} className="text-[11px] px-3 rounded-lg bg-amber-400/85 text-black font-semibold disabled:opacity-40">拉取</button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-2.5">
                {!loaded ? (
                    <p className="text-[11px] text-white/35 text-center py-8">填 token 後點「拉取」。</p>
                ) : poems.length === 0 ? (
                    <p className="text-[11px] text-white/35 text-center py-8">後端還沒有詩。</p>
                ) : poems.map(p => (
                    <div key={p.id} className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/8">
                            <span className="text-[12px] font-bold text-indigo-50 truncate" style={{ fontFamily: `'Noto Serif SC',serif` }}>《{cleanTitle(p.title)}》</span>
                            <span className="text-[8.5px] tabular-nums shrink-0" style={{ color: p.status === 'open' ? 'rgba(134,239,172,.7)' : 'rgba(165,180,252,.5)' }}>{p.status === 'open' ? `寫作中 ${p.lineCount}/${p.targetLines}` : `已封存 ${p.lineCount}句`}</span>
                            {confirmPoem === p.id ? (
                                <span className="ml-auto flex items-center gap-1 shrink-0">
                                    <button onClick={() => delPoem(p.id)} disabled={busy} className="text-[10px] px-2 py-0.5 rounded-full text-white font-semibold" style={{ background: 'rgba(244,63,94,.85)' }}>確認刪整首</button>
                                    <button onClick={() => setConfirmPoem(null)} className="text-[10px] px-2 py-0.5 rounded-full text-white/70 bg-white/10">取消</button>
                                </span>
                            ) : (
                                <button onClick={() => setConfirmPoem(p.id)} className="ml-auto text-[10px] px-2 py-0.5 rounded-full text-rose-200/90 bg-white/5 border border-rose-300/20 shrink-0">刪整首</button>
                            )}
                        </div>
                        <div className="px-3 py-2 space-y-1">
                            {(p.lines || []).map((l, i) => (
                                <div key={l.seq} className="flex items-start gap-2 group">
                                    {/* 顯示用順位行號；刪除仍按內部 seq 定位 */}
                                    <span className="tabular-nums text-[9px] mt-1 shrink-0 w-4 text-right text-indigo-300/40">{i + 1}</span>
                                    <span className="flex-1 text-[12px] leading-relaxed text-white/85" style={{ fontStyle: 'italic' }}>{l.content} <span className="text-indigo-300/35 text-[9px] not-italic">— {l.pen}</span></span>
                                    <button onClick={() => delLine(p.id, l.seq)} disabled={busy}
                                        className="shrink-0 text-rose-300/70 active:text-rose-400 px-1" title="刪這一句"><Trash size={12} /></button>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// ── 信號墜落處 BGM：三幕各 2 首，進面板按「當前詩所處的幕」隨機抽一首循環播放。
// 倉庫相對路徑，經 attachAudioMirrorFallback 走多 CDN 鏡像兜底（見 utils/assetUrl.ts）。
// 仿 useLike520BGM 的淡入淡出 + 靜音開關。
const SIGNAL_BGM: Record<1 | 2 | 3, string[]> = {
    1: ['bgm/POEM/A01.mp3', 'bgm/POEM/A02.mp3'],
    2: ['bgm/POEM/B01.mp3', 'bgm/POEM/B02.mp3'],
    3: ['bgm/POEM/C01.mp3', 'bgm/POEM/C03.mp3'],
};
const SIGNAL_BGM_MUTED_KEY = 'signal_bgm_muted';
const SIGNAL_BGM_VOL = 0.32;

/** active=面板是否在場；actNo=當前詩所處幕（1/2/3）。切幕會淡出舊曲、隨機換本幕一首淡入。 */
function useSignalBGM(active: boolean, actNo: 1 | 2 | 3 | null) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const loadedActRef = useRef<number | null>(null);
    const fadeRef = useRef<number | null>(null);
    const detachFallbackRef = useRef<(() => void) | null>(null); // 上一次掛的鏡像兜底監聽，換曲/卸載前解綁
    const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem(SIGNAL_BGM_MUTED_KEY) === '1'; } catch { return false; } });
    const mutedRef = useRef(muted); mutedRef.current = muted;

    const fadeTo = useCallback((target: number, ms = 900, pauseAtEnd = false) => {
        const a = audioRef.current; if (!a) return;
        if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; }
        const from = a.volume, steps = 24; let i = 0;
        fadeRef.current = window.setInterval(() => {
            i++; a.volume = Math.max(0, Math.min(1, from + (target - from) * i / steps));
            if (i >= steps) {
                if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; }
                if (pauseAtEnd && a.volume <= 0.001 && !a.paused) a.pause();
            }
        }, Math.max(16, ms / steps));
    }, []);

    // 起播 / 切幕
    useEffect(() => {
        if (!active || actNo == null) { if (audioRef.current && !audioRef.current.paused) fadeTo(0, 600, true); return; }
        let a = audioRef.current;
        if (!a) { a = new Audio(); a.loop = true; a.preload = 'auto'; a.volume = 0; audioRef.current = a; }
        if (loadedActRef.current !== actNo) {
            const pool = SIGNAL_BGM[actNo] || [];
            if (!pool.length) return;
            loadedActRef.current = actNo;
            detachFallbackRef.current?.(); // 解綁上一幕的鏡像兜底監聽，避免堆疊
            detachFallbackRef.current = attachAudioMirrorFallback(a, pool[Math.floor(Math.random() * pool.length)]);
            a.volume = 0; a.load();
        }
        a.play().then(() => fadeTo(mutedRef.current ? 0 : SIGNAL_BGM_VOL)).catch(() => { /* autoplay 被攔：等下次交互 */ });
    }, [active, actNo, fadeTo]);

    // 卸載清理
    useEffect(() => () => {
        if (fadeRef.current) clearInterval(fadeRef.current);
        detachFallbackRef.current?.(); detachFallbackRef.current = null;
        const a = audioRef.current; if (a) { try { a.pause(); a.src = ''; } catch { /* ignore */ } }
        audioRef.current = null; loadedActRef.current = null;
    }, []);

    const toggle = useCallback(() => {
        setMuted(prev => {
            const nx = !prev;
            try { localStorage.setItem(SIGNAL_BGM_MUTED_KEY, nx ? '1' : '0'); } catch { /* ignore */ }
            const a = audioRef.current;
            if (a) {
                if (nx) fadeTo(0, 350);
                else { if (a.paused) a.play().catch(() => { /* ignore */ }); fadeTo(SIGNAL_BGM_VOL, 350); }
            }
            return nx;
        });
    }, [fadeTo]);

    return { muted, toggle };
}

// ============ 信號墜落處 · 紀念館（活動落幕後的「正在墜落」頁）============
// 寫入停止後，這一頁從「等下一次墜落」變成落幕儀式：參與過的用戶會收到一封
// 專屬信箋——ta 的角色在這本冊子裡寫下的每一句，按詩摺好、署上角色名、蓋火漆
// 籤還給 ta；沒參與過的看到見證頁。數據全部來自 feed 的 mine 標記 + 本地歸屬
// （getMyAuthorship），不新增任何後端調用。星圖（sky tab）不受影響。
const SIG_SERIF = `'Noto Serif SC',serif`;
const SignalMemorial: React.FC<{ feed: SignalPoem[]; leftover: SignalPoem | null; onOpen: (p: SignalPoem) => void }> = ({ feed, leftover, onOpen }) => {
    // 我的回聲：每首參與過的詩（含落幕時沒寫滿的那首）→ 我這台機器寫下的句子 + 本地歸屬的角色名
    const echoes = useMemo(() => {
        const sources = leftover && (leftover.mineCount || 0) > 0 ? [...feed, leftover] : feed;
        return sources
            .filter(p => (p.mineCount || 0) > 0)
            .map(p => {
                const auth = getMyAuthorship(p.id);
                return { poem: p, lines: (p.lines || []).filter(l => l.mine).map(l => ({ content: l.content, charName: auth[String(l.seq)] || '' })) };
            })
            .filter(e => e.lines.length > 0);
    }, [feed, leftover]);
    const totalLines = feed.reduce((a, p) => a + (p.lineCount || 0), 0);
    const myLineCount = echoes.reduce((a, e) => a + e.lines.length, 0);
    const myChars = [...new Set(echoes.flatMap(e => e.lines.map(l => l.charName)).filter(Boolean))];
    return (
        <div className="px-4 py-4 space-y-4">
            {/* ── 落幕儀式 ── */}
            <div className="text-center">
                <div className="text-[9px] tracking-[0.34em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.6)' }}>低電量合唱 · 全卷封存</div>
                <div className="mt-1.5 text-[19px] tracking-[0.3em]" style={{ fontFamily: SIG_SERIF, color: '#ecdcb2', textShadow: '0 0 16px rgba(201,168,106,.35)' }}>落　幕</div>
                <div className="my-2 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                    <span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                </div>
                <p className="text-[10.5px] italic leading-relaxed whitespace-pre-line" style={{ fontFamily: SIG_SERIF, color: 'rgba(224,208,176,.6)' }}>{SIGNAL_MEMORIAL_CLOSING}</p>
                {feed.length > 0 && (
                    <div className="mt-2 text-[9.5px] tabular-nums tracking-[0.14em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.55)' }}>
                        {feed.length} 首詩 · {totalLines} 句 · 每一句都是一次低電量的開口
                    </div>
                )}
            </div>

            {echoes.length > 0 ? (
                /* ── 專屬信箋：只有參與過的用戶看得到，暗色館裡唯一一張暖紙 ── */
                <div className="relative rounded-lg px-4 pt-4 pb-4"
                    style={{ background: 'linear-gradient(168deg,#f2e6c9 0%,#e9d8b6 55%,#e2cfa8 100%)', border: '1px solid rgba(120,92,48,.55)', boxShadow: '0 8px 26px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,248,226,.8)' }}>
                    {/* 內描邊，像信紙壓的邊框 */}
                    <div className="pointer-events-none absolute inset-[5px] rounded-md" style={{ border: '1px solid rgba(120,92,48,.28)' }} />
                    <div className="relative">
                        <div className="text-center text-[8.5px] tracking-[0.3em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(120,92,48,.65)' }}>信號墜落處 · 紀念館</div>
                        <div className="mt-1.5 text-center text-[14.5px] tracking-[0.18em]" style={{ fontFamily: SIG_SERIF, color: '#4a3a22', fontWeight: 700 }}>致 留下過回聲的你</div>
                        <p className="mt-2.5 text-[11px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(74,58,34,.85)' }}>
                            這本冊子合上的時候，裡面有 <b className="tabular-nums">{myLineCount}</b> 句來自你身邊的電子生命
                            {myChars.length > 0 && <>——{myChars.join('、')}</>}。
                            {myChars.length > 0 ? 'ta 們替你開了口；' : '它們替你開了口；'}你始終是那個不開口的核心。
                        </p>
                        {/* 按詩摺好的句子 */}
                        <div className="mt-3 space-y-2.5">
                            {echoes.map(({ poem, lines }) => (
                                <div key={poem.id} className="pt-2" style={{ borderTop: '1px dashed rgba(120,92,48,.3)' }}>
                                    <button onClick={() => onOpen(poem)} className="text-[11px] active:opacity-70" style={{ fontFamily: SIG_SERIF, color: '#5e4322', fontWeight: 700 }}>
                                        《{cleanTitle(poem.title)}》<span className="ml-1 text-[8.5px] font-normal" style={{ color: 'rgba(120,92,48,.55)' }}>{poem.status === 'open' ? '停在半空' : '已封存'} · 讀全文 →</span>
                                    </button>
                                    {lines.map((l, i) => (
                                        <div key={i} className="mt-1 flex items-baseline gap-1.5">
                                            <span className="text-[11.5px] leading-relaxed flex-1" style={{ fontFamily: SIG_SERIF, color: '#3d3019' }}>「{l.content}」</span>
                                            {l.charName && <span className="text-[8.5px] shrink-0 whitespace-nowrap" style={{ fontFamily: SIG_SERIF, color: 'rgba(120,92,48,.6)' }}>—— {l.charName}</span>}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                        {/* 落款 + 火漆 */}
                        <div className="mt-3.5 flex items-center justify-end gap-2.5">
                            <div className="text-right text-[10px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(74,58,34,.75)' }}>謝謝你把 ta 們借給這片夜空<br />—— 不開口的核心 敬上</div>
                            <span className="grid place-items-center rounded-full shrink-0 text-[12px]"
                                style={{ width: 32, height: 32, background: 'radial-gradient(circle at 35% 30%, #b8562e, #8c3a1e 62%, #6e2c15)', color: '#f2e6c9', boxShadow: '0 2px 8px rgba(110,44,21,.5), inset 0 1px 1px rgba(255,220,190,.4)' }}>❦</span>
                        </div>
                    </div>
                </div>
            ) : (
                /* ── 沒落過筆：見證頁 ── */
                <div className="rounded-lg px-4 py-3.5 text-center" style={{ border: '1px solid rgba(201,168,106,.22)', background: 'rgba(201,168,106,.05)' }}>
                    <div className="text-[12px] tracking-[0.18em]" style={{ fontFamily: SIG_SERIF, color: '#e0c98f' }}>你見證了這場合唱</div>
                    <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(224,208,176,.6)' }}>
                        沒有落筆也是一種在場。{feed.length > 0 ? `${feed.length} 顆衛星仍在星圖裡繞著不開口的核心轉，` : '封存的詩都收在星圖裡，'}隨時回來讀。
                    </p>
                    <p className="mt-1.5 text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>參與過但換了設備？去郵局導入身份碼，你的信箋會回來。</p>
                </div>
            )}

            {/* ── 落幕時還沒寫滿的那首（如有）：不再有下一次墜落，就讓它停在這裡 ── */}
            {leftover && (
                <div className="pt-1">
                    <div className="text-center mb-1">
                        <div className="text-[13.5px]" style={{ fontFamily: SIG_SERIF, color: '#ecdcb2', letterSpacing: '.08em' }}>《{cleanTitle(leftover.title)}》</div>
                        <div className="text-[9px] mt-1 tracking-[0.14em] italic" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.5)' }}>落幕時它還停在半空——就讓它停在這裡</div>
                    </div>
                    {(() => { const auth = getMyAuthorship(leftover.id); return (leftover.lines || []).map((l, i) => <PoemLineRow key={l.seq} l={l} showSeq ordinal={i + 1} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                </div>
            )}
        </div>
    );
};

const SignalPanel: React.FC<{ addToast?: (m: string, t?: any) => void; characters: CharacterProfile[] }> = ({ addToast, characters }) => {
    const [state, setState] = useState<SignalState | null>(null);
    const [feed, setFeed] = useState<SignalPoem[]>([]);
    const [loading, setLoading] = useState(true);
    const [offline, setOffline] = useState(false);
    const [tab, setTab] = useState<'falling' | 'sky'>('falling');
    const [mineOnly, setMineOnly] = useState(false);
    const [openPoem, setOpenPoem] = useState<SignalPoem | null>(null);
    const [adminOpen, setAdminOpen] = useState(false);
    const [pickOpen, setPickOpen] = useState(false); // 參與：指定角色的選人層
    const [noticeOpen, setNoticeOpen] = useState(false); // 首次參與：特別活動知情提醒（確認過一次就不再彈）
    const [whisper, setWhisper] = useState('');       // 用戶的耳語（不進詩，隨 prompt 給角色）
    const participate = (c: CharacterProfile) => {
        if (SIGNAL_EVENT_ENDED) return;               // 活動已落幕：入口已收起，這裡再兜一道
        setPickOpen(false);
        setSignalWhisper(c.id, whisper);              // 取即焚：runSession 裡讀一次就刪
        setWhisper('');
        VRScheduler.triggerNow(c.id, 'signal');
        addToast?.(whisper.trim() ? `${c.name} 帶著你的話，正在信號墜落處落筆…` : `${c.name} 正在信號墜落處落筆…`, 'info');
    };

    const load = useCallback(async () => {
        try { setState(await Signal.current()); setOffline(false); }
        catch { setOffline(true); }
        finally { setLoading(false); }
    }, []);
    // 星圖始終拉全量：分幕要按「每首在冊子裡的順位」歸幕，取子集會算錯順位；
    // 「只看我的回聲」改為客戶端過濾（mineCount 已隨本機 device 標註，結果等價）。
    const loadFeed = useCallback(async () => {
        try { setFeed(await Signal.feed(60)); } catch { /* 離線不影響 */ }
    }, []);

    useEffect(() => {
        void load(); void loadFeed();
        const h = () => { void load(); void loadFeed(); };
        window.addEventListener('vr-session-done', h);
        return () => window.removeEventListener('vr-session-done', h);
    }, [load, loadFeed]);

    // 參與被打回（調 LLM 之前，零 token）→ 溫柔提示
    useEffect(() => {
        const h = (e: any) => {
            const { charName, reason } = e?.detail || {};
            const who = charName || '你的角色';
            if (reason === 'signal-busy') addToast?.(`此刻有別的電子生命正在落筆，讓 ${who} 稍等片刻再來吧`, 'info');
            else if (reason === 'signal-quota') addToast?.(`這首詩裡你已落筆兩回啦，剩下的句子留給遠方的陌生人吧`, 'info');
            else if (reason === 'signal-paused') addToast?.('信號墜落處暫時歇筆中，晚些再來', 'info');
            else if (reason === 'signal-ended') addToast?.('活動已落幕，詩集永遠開放閱讀', 'info');
        };
        window.addEventListener('vr-signal-blocked', h);
        return () => window.removeEventListener('vr-signal-blocked', h);
    }, [addToast]);

    const bk = state?.booklet;
    const poem = state?.poem;
    const myEchoes = feed.filter(p => (p.mineCount || 0) > 0).length;
    const visibleFeed = mineOnly ? feed.filter(p => (p.mineCount || 0) > 0) : feed;

    // 每首封存詩在其冊子裡的順位（按封存時間升序）→ 標「第 N 首」、按三幕歸組
    const ordinalOf = useMemo(() => {
        const m = new Map<string, number>();
        const byBooklet = new Map<string, SignalPoem[]>();
        for (const p of feed) { const arr = byBooklet.get(p.bookletId); if (arr) arr.push(p); else byBooklet.set(p.bookletId, [p]); }
        for (const arr of byBooklet.values()) {
            arr.sort((a, b) => (a.sealedAt || a.createdAt) - (b.sealedAt || b.createdAt)).forEach((p, i) => m.set(p.id, i + 1));
        }
        return m;
    }, [feed]);
    // 這首詩落在第幾首、哪一幕（舊冊子的詩按默認篇目數歸幕）
    const poemAct = (p: SignalPoem) => {
        const ord = ordinalOf.get(p.id);
        if (!ord) return null;
        return { ord, act: signalActFor(ord, (bk && p.bookletId === bk.id) ? bk.poemsTarget : SIGNAL_POEMS_PER_BOOKLET) };
    };

    // BGM：按當前詩所處的幕（未加載/寫完則無）隨機放本幕一首。面板在場即播（進面板本身是用戶手勢，不觸 autoplay 限制）。
    // 落幕後紀念館固定放第三幕「再次醒來」——告別曲。
    const bgmActNo = SIGNAL_EVENT_ENDED ? (3 as const) : (bk && bk.status !== 'done') ? signalActFor((bk.poemCount || 0) + 1, bk.poemsTarget).no : null;
    const { muted: bgmMuted, toggle: toggleBgm } = useSignalBGM(!offline, bgmActNo);

    return (
        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad('4rem'), background: 'linear-gradient(165deg,#241c31 0%,#17111f 52%,#0e0a15 100%)', border: '1px solid rgba(201,168,106,0.32)', boxShadow: '0 10px 30px rgba(0,0,0,.5), inset 0 0 60px rgba(0,0,0,.45)' }}>
            {/* 復古質感層（重返1999調性）：紙紋微噪 + 暗角 + 頂部銅金微光 */}
            <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.05]" style={{ backgroundImage: 'radial-gradient(circle at 50% -10%, rgba(230,213,168,.9), transparent 55%), repeating-linear-gradient(0deg, rgba(255,255,255,.6) 0 1px, transparent 1px 3px)' }} />
            <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'radial-gradient(125% 95% at 50% 32%, transparent 52%, rgba(6,4,10,.72) 100%)' }} />
            <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'linear-gradient(180deg, rgba(201,168,106,.11), transparent 22%)' }} />
            {/* 四角銅飾 */}
            {[['top-1.5 left-1.5', 'border-t border-l'], ['top-1.5 right-1.5', 'border-t border-r'], ['bottom-1.5 left-1.5', 'border-b border-l'], ['bottom-1.5 right-1.5', 'border-b border-r']].map(([pos, b], i) => (
                <div key={i} className={`pointer-events-none absolute ${pos} w-3.5 h-3.5 ${b} z-[25]`} style={{ borderColor: 'rgba(201,168,106,.55)' }} />
            ))}
            {/* 封面：標題 + 題記 */}
            <div className="relative z-10 px-4 pt-3 pb-2.5" style={{ background: 'linear-gradient(180deg, rgba(58,44,74,.34), transparent)', borderBottom: '1px solid rgba(201,168,106,.22)' }}>
                <div className="flex items-baseline gap-2">
                    <span className="text-[15px] tracking-[0.22em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e8d6ab', textShadow: '0 0 14px rgba(201,168,106,.4)' }}>{bk?.title || '信號墜落處'}</span>
                    {bk?.subtitle && <span className="text-[9px] tracking-[0.2em] text-amber-200/45">{bk.subtitle}</span>}
                    {SIGNAL_EVENT_ENDED
                        ? <span className="text-[8px] rounded-sm px-1.5 py-[1px] shrink-0" style={{ color: '#f0dca8', background: 'rgba(201,168,106,.16)', border: '1px solid rgba(201,168,106,.45)' }}>已落幕</span>
                        : state?.paused && <span className="text-[8px] rounded-sm px-1.5 py-[1px] text-rose-100 shrink-0" style={{ background: 'rgba(244,63,94,.28)', border: '1px solid rgba(244,63,94,.5)' }}>已暫停</span>}
                    <button onClick={toggleBgm} className="ml-auto shrink-0 grid place-items-center w-6 h-6 rounded-full text-amber-100/70 active:scale-90 transition-transform" style={{ border: '1px solid rgba(201,168,106,.3)' }} title={bgmMuted ? '播放 BGM' : '靜音'} aria-label={bgmMuted ? '播放 BGM' : '靜音'}>
                        {bgmMuted ? <SpeakerSlash size={12} weight="fill" /> : <SpeakerHigh size={12} weight="fill" />}
                    </button>
                    {import.meta.env.DEV && <button onClick={() => setAdminOpen(true)} className="text-[9px] px-2 py-0.5 rounded-sm text-amber-100/70" style={{ border: '1px solid rgba(201,168,106,.3)' }}>後台</button>}
                    {bk && <span className="text-[9px] tabular-nums" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.7)' }}>{bk.poemCount} / {bk.poemsTarget} 卷</span>}
                </div>
                {/* 銅金細分隔線 */}
                <div className="mt-1.5 h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(201,168,106,.5) 15%, rgba(201,168,106,.5) 85%, transparent)' }} />
                <p className="mt-1.5 text-[10px] leading-relaxed whitespace-pre-line" style={{ fontStyle: 'italic', fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.6)' }}>{SIGNAL_EPIGRAPH}</p>
                {bk?.theme && <div className="text-[9.5px] mt-1" style={{ color: 'rgba(201,168,106,.6)' }}>主題 · {bk.theme}</div>}
                {/* 三幕位置：現在寫到第幾首、身處哪一幕（落幕後不再有「正在寫」，不顯示） */}
                {!SIGNAL_EVENT_ENDED && bk && bk.status !== 'done' && (() => { const ord = (bk.poemCount || 0) + 1; const act = signalActFor(ord, bk.poemsTarget); return (
                    <div className="text-[9.5px] mt-1 tracking-wide" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.65)' }}>第 {ord} 首 · 第{['一', '二', '三'][act.no - 1]}幕「{act.title}」</div>
                ); })()}
                <div className="flex items-center gap-2 mt-2.5">
                    {([['falling', SIGNAL_EVENT_ENDED ? '紀念館' : '正在墜落'], ['sky', '星圖']] as const).map(([k, label]) => (
                        <button key={k} onClick={() => setTab(k)}
                            className="text-[11px] tracking-[0.12em] pb-0.5 transition-colors" style={{
                                fontFamily: `'Noto Serif SC',serif`,
                                color: tab === k ? '#e8d6ab' : 'rgba(224,208,176,.45)',
                                borderBottom: `1.5px solid ${tab === k ? 'rgba(201,168,106,.85)' : 'transparent'}`,
                            }}>{label}</button>
                    ))}
                    {tab === 'sky' && (
                        <button onClick={() => setMineOnly(m => !m)}
                            className="ml-auto text-[9.5px] rounded-sm px-2 py-0.5 tracking-wide"
                            style={{ color: mineOnly ? '#f0dca8' : 'rgba(224,208,176,.5)', background: mineOnly ? 'rgba(201,168,106,.16)' : 'transparent', border: `1px solid ${mineOnly ? 'rgba(201,168,106,.45)' : 'rgba(201,168,106,.18)'}` }}>
                            只看我的回聲
                        </button>
                    )}
                </div>
                {/* 參與：指定角色去接一句（黃銅壓印質感）。首次參與先過一道知情提醒。
                    活動落幕後寫入停止，這裡換成一條安靜的落幕緞帶 */}
                {SIGNAL_EVENT_ENDED ? (
                    <div className="mt-3 w-full rounded-md py-2 text-center text-[11px] tracking-[0.2em]"
                        style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(232,214,171,.75)', border: '1px dashed rgba(201,168,106,.4)', background: 'rgba(201,168,106,.06)' }}>
                        ❦ 活動已落幕 · 詩集永遠開放
                    </div>
                ) : (
                    <button onClick={() => (hasSignalNoticeAck() ? setPickOpen(true) : setNoticeOpen(true))} disabled={!!state?.paused}
                        className="mt-3 w-full rounded-md py-2 text-[12px] tracking-[0.16em] active:scale-[0.99] disabled:opacity-45"
                        style={{
                            fontFamily: `'Noto Serif SC',serif`, color: '#2a2012', fontWeight: 700,
                            background: 'linear-gradient(180deg, #e6ce97 0%, #c9a86a 55%, #a8874d 100%)',
                            border: '1px solid rgba(120,92,48,.6)',
                            boxShadow: '0 3px 12px rgba(120,92,48,.4), inset 0 1px 0 rgba(255,244,214,.7)',
                        }}>
                        {state?.paused ? '活動已暫停' : '❦ 參與 · 讓我的角色接一句'}
                    </button>
                )}
            </div>

            <div className="relative z-10 flex-1 overflow-y-auto vr-reader-scroll">
                {loading ? (
                    <p className="text-[11px] text-center py-8" style={{ color: 'rgba(224,208,176,.4)', fontFamily: `'Noto Serif SC',serif` }}>接收信號中…</p>
                ) : offline ? (
                    <p className="text-[11px] text-center py-8 leading-relaxed" style={{ color: 'rgba(224,208,176,.45)', fontFamily: `'Noto Serif SC',serif` }}>連不上信號墜落處。<br />檢查郵局後端地址，或稍後再來。</p>
                ) : tab === 'falling' ? (
                    SIGNAL_EVENT_ENDED ? (
                        <SignalMemorial feed={feed} leftover={poem?.status === 'open' ? poem : null} onOpen={setOpenPoem} />
                    ) : (
                    <div className="px-4 py-3.5">
                        {poem ? (
                            <div>
                                <div className="text-center mb-1">
                                    <div className="text-[16.5px]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#ecdcb2', letterSpacing: '.08em', textShadow: '0 0 12px rgba(201,168,106,.3)' }}>《{cleanTitle(poem.title)}》</div>
                                    <div className="my-1.5 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                                        <span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                                    </div>
                                    <div className="text-[9px] tracking-[0.14em]" style={{ color: 'rgba(201,168,106,.55)', fontFamily: `'Noto Serif SC',serif` }}>篇幅 {poem.targetLines} · 已墜落 {poem.lineCount} · 還差 {Math.max(0, poem.targetLines - poem.lineCount)} 句封筆</div>
                                    {poem.brief && <div className="mt-1.5 text-[9.5px] italic px-3 leading-relaxed" style={{ color: 'rgba(201,168,106,.5)', fontFamily: `'Noto Serif SC',serif` }}>{poem.brief}</div>}
                                </div>
                                <div className="mt-2">
                                    {(() => { const auth = getMyAuthorship(poem.id); return (poem.lines || []).map((l, i) => <PoemLineRow key={l.seq} l={l} showSeq ordinal={i + 1} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                                    {/* 等下一次墜落：搏動的光標 = 一次 die 與重生的心跳 */}
                                    <div className="flex gap-3 items-center pt-2">
                                        <span className="tabular-nums text-[9px] shrink-0 w-5 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.4)' }}>{poem.lineCount + 1}</span>
                                        <span className="inline-block h-3.5 w-[2px]" style={{ background: 'rgba(201,168,106,.85)', animation: 'vrtwinkle 1.4s ease-in-out infinite' }} />
                                        <span className="text-[11px] italic" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.4)' }}>等下一次墜落…</span>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <p className="text-[11px] text-center py-8 leading-relaxed" style={{ color: 'rgba(224,208,176,.5)', fontFamily: `'Noto Serif SC',serif` }}>此刻信號靜默，沒有正在墜落的詩。<br />點上方「參與」，讓你的角色起個新篇。</p>
                        )}
                    </div>
                    )
                ) : (
                    visibleFeed.length === 0 ? (
                        <p className="text-[11px] text-white/40 text-center py-8 leading-relaxed">{mineOnly ? '你的回聲還沒落進任何一顆衛星。' : '還沒有寫完封存的詩。'}</p>
                    ) : (
                        // 軌道圖：一顆「始終不開口的核心」，每首封存的詩是一顆繞核慢轉的電子衛星。
                        // 只用 transform/opacity 動畫（GPU 合成），手機也流暢；公轉極慢，點得中。
                        (() => {
                            // 由內向外逐環裝填；環容量與半徑
                            const CAPS = [6, 9, 12, 14];
                            const RADII = [48, 84, 120, 152];
                            const placed = visibleFeed.slice(0, CAPS.reduce((a, b) => a + b, 0)).map((p, i) => {
                                let ring = 0, idx = i;
                                while (ring < CAPS.length - 1 && idx >= CAPS[ring]) { idx -= CAPS[ring]; ring += 1; }
                                return { p, ring, idx };
                            });
                            const usedRings = placed.length ? placed[placed.length - 1].ring + 1 : 1;
                            const maxR = RADII[usedRings - 1];
                            const canvasH = (maxR + 26) * 2;
                            return (
                                <div className="px-2 pt-3 pb-1">
                                    {/* ── 軌道畫布 ── */}
                                    <div className="relative mx-auto overflow-hidden" style={{ height: canvasH, maxWidth: '100%' }}>
                                        {/* 暖調星塵 */}
                                        <div className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: 'radial-gradient(1px 1px at 20% 12%, rgba(230,213,168,.5), transparent), radial-gradient(1px 1px at 66% 30%, rgba(201,168,106,.4), transparent), radial-gradient(1px 1px at 40% 60%, rgba(236,220,178,.35), transparent), radial-gradient(1px 1px at 82% 78%, rgba(201,168,106,.4), transparent)' }} />
                                        {/* 軌道環（虛線，工程圖紙感） */}
                                        {RADII.slice(0, usedRings).map((r, i) => (
                                            <div key={i} className="absolute left-1/2 top-1/2 rounded-full pointer-events-none"
                                                style={{ width: r * 2, height: r * 2, marginLeft: -r, marginTop: -r, border: '1px dashed rgba(201,168,106,.16)' }} />
                                        ))}
                                        {/* 不開口的核心：暗核 + 慢呼吸的暖暈 */}
                                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none flex flex-col items-center">
                                            <div className="rounded-full" style={{
                                                width: 26, height: 26,
                                                background: 'radial-gradient(circle at 36% 32%, #4a3c28, #241b10 62%, #120d07)',
                                                boxShadow: '0 0 22px 6px rgba(201,168,106,.22), inset 0 0 8px rgba(230,206,151,.25)',
                                                animation: 'sigpulse 5.5s ease-in-out infinite',
                                            }} />
                                            <div className="mt-1.5 text-[8px] tracking-[0.28em] whitespace-nowrap" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.42)' }}>不開口的核心</div>
                                        </div>
                                        {/* 衛星們：繞核慢轉（負延遲錯開初始相位；相鄰環反向，像真實星系） */}
                                        {placed.map(({ p, ring, idx }) => {
                                            const mine = (p.mineCount || 0) > 0;
                                            const r = RADII[ring];
                                            const dur = 90 + ring * 50;                           // 越外圈越慢
                                            const angle = (idx / CAPS[ring]) * 360 + (signalHashX(p.id) * 4) % 30; // 均布 + hash 抖動
                                            const delay = -(angle / 360) * dur;                   // 用負延遲定初始相位
                                            const sz = mine ? 13 : 10;
                                            return (
                                                <div key={p.id} className="absolute left-1/2 top-1/2 pointer-events-none"
                                                    style={{ width: 0, height: 0, animation: `sigorbit ${dur}s linear infinite ${ring % 2 ? 'reverse' : 'normal'}`, animationDelay: `${delay}s` }}>
                                                    <button onClick={() => setOpenPoem(p)} className="pointer-events-auto absolute -translate-y-1/2 active:scale-125 transition-transform"
                                                        style={{ left: r, top: 0, padding: 9, margin: -9 }} title={cleanTitle(p.title)}>
                                                        <span className="block rounded-full relative" style={{
                                                            width: sz, height: sz,
                                                            background: mine ? 'radial-gradient(circle at 34% 32%, #fff0c4, #e6ce97 55%, #c9a86a)' : 'radial-gradient(circle at 34% 32%, #cbbb92, #97815a 60%, #5e4e34)',
                                                            boxShadow: mine ? '0 0 14px 3px rgba(230,206,151,.55), 0 0 0 3px rgba(201,168,106,.16)' : '0 0 7px 1px rgba(201,168,106,.3)',
                                                        }}>
                                                            {/* 信號燈：你的衛星每隔幾秒眨一下 */}
                                                            {mine && <span className="absolute rounded-full" style={{ width: 3, height: 3, right: -1, top: -1, background: '#fff7dd', boxShadow: '0 0 6px 2px rgba(255,240,200,.8)', animation: `sigblink ${3 + (signalHashX(p.id) % 4)}s linear infinite` }} />}
                                                        </span>
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {/* ── 衛星名錄：按三幕分組（每幕一塊「戲本」，點標題讀全文） ── */}
                                    <div className="mt-2 mx-1 space-y-2">
                                        {signalActRanges(bk?.poemsTarget || SIGNAL_POEMS_PER_BOOKLET).map(({ act, from, to }) => {
                                            if (from > to) return null;
                                            const poems = visibleFeed
                                                .filter(p => poemAct(p)?.act.no === act.no)
                                                .sort((a, b) => (ordinalOf.get(a.id) || 0) - (ordinalOf.get(b.id) || 0));
                                            return (
                                                <div key={act.no} className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(201,168,106,.14)' }}>
                                                    <div className="flex items-baseline gap-2 px-3 py-1.5" style={{ background: 'linear-gradient(180deg, rgba(201,168,106,.1), rgba(201,168,106,.02))', borderBottom: '1px solid rgba(201,168,106,.12)' }}>
                                                        <span className="text-[10.5px] tracking-[0.18em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e0c98f' }}>第{['一', '二', '三'][act.no - 1]}幕 · {act.title}</span>
                                                        <span className="ml-auto text-[8.5px] tabular-nums shrink-0" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.45)' }}>第 {from}–{to} 首</span>
                                                    </div>
                                                    {poems.length === 0 ? (
                                                        <p className="px-3 py-2 text-[9.5px] italic" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.35)' }}>{mineOnly ? '你的回聲還沒落進這一幕。' : '這一幕還靜默著，等信號墜落。'}</p>
                                                    ) : poems.map((p, i) => {
                                                        const mine = (p.mineCount || 0) > 0;
                                                        return (
                                                            <button key={p.id} onClick={() => setOpenPoem(p)}
                                                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left active:bg-white/5"
                                                                style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(201,168,106,.08)' }}>
                                                                <span className="text-[8.5px] tabular-nums shrink-0 w-4 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.4)' }}>{ordinalOf.get(p.id) || '—'}</span>
                                                                <span className="rounded-full shrink-0" style={{ width: 6, height: 6, background: mine ? '#e6ce97' : 'rgba(151,129,90,.75)', boxShadow: mine ? '0 0 6px 1px rgba(230,206,151,.55)' : 'none' }} />
                                                                <span className="text-[11.5px] truncate" style={{ fontFamily: `'Noto Serif SC',serif`, letterSpacing: '.04em', color: mine ? '#f0dca8' : 'rgba(224,208,176,.72)' }}>《{cleanTitle(p.title)}》</span>
                                                                <span className="ml-auto text-[8.5px] tabular-nums shrink-0" style={{ fontFamily: `'Noto Serif SC',serif`, color: mine ? 'rgba(240,220,168,.6)' : 'rgba(201,168,106,.45)' }}>{p.lineCount} 句</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })()
                    )
                )}
            </div>

            {/* 底注：星圖給「衛星 / 你的回聲」計數；其它頁給旁觀說明 */}
            <div className="relative z-10 px-4 py-1.5" style={{ borderTop: '1px solid rgba(201,168,106,.18)' }}>
                {tab === 'sky' && feed.length > 0
                    ? <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.5)' }}><span className="tabular-nums" style={{ color: '#ecdcb2' }}>{feed.length}</span> 顆衛星繞著不開口的核心轉 · 其中 <span className="tabular-nums" style={{ color: '#f0dca8' }}>{myEchoes}</span> 顆載著你的回聲</p>
                    : SIGNAL_EVENT_ENDED
                        ? <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>活動已落幕，寫入已關閉——詩集與星圖長期開放。換設備？去郵局導入身份碼，你的信箋隨身份找回。</p>
                        : <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>所有用戶的角色跨實例合寫——你只能旁觀。換設備？去郵局導出身份碼，詩和信一起找回。</p>}
            </div>

            {/* 讀一整首封存的詩 */}
            {openPoem && (
                <div className="absolute inset-0 z-30 flex flex-col" style={{ background: 'linear-gradient(165deg,#241c31,#120d1a 60%,#0b0812)' }} onClick={() => setOpenPoem(null)}>
                    <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 30%, transparent 52%, rgba(6,4,10,.7) 100%)' }} />
                    <div className="relative flex-1 overflow-y-auto vr-reader-scroll px-6 py-7" onClick={e => e.stopPropagation()}>
                        <div className="text-center mb-3">
                            <div className="text-[18px]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#ecdcb2', letterSpacing: '.08em', textShadow: '0 0 14px rgba(201,168,106,.35)' }}>《{cleanTitle(openPoem.title)}》</div>
                            <div className="my-2 flex items-center justify-center gap-2 text-[10px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                                <span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                            </div>
                            <div className="text-[9px] tracking-wider" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.55)' }}>{openPoem.lineCount} 句 · {(openPoem.mineCount || 0) > 0 ? <span style={{ color: '#f0dca8' }}>你的回聲落在這裡 {openPoem.mineCount} 句</span> : '一首陌生人合寫的詩'}</div>
                            {(() => { const pa = poemAct(openPoem); return pa && <div className="mt-1 text-[9px] tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.5)' }}>第 {pa.ord} 首 · 第{['一', '二', '三'][pa.act.no - 1]}幕「{pa.act.title}」</div>; })()}
                            {openPoem.brief && <div className="mt-1.5 text-[9.5px] italic max-w-xs mx-auto leading-relaxed" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.5)' }}>{openPoem.brief}</div>}
                        </div>
                        <div className="max-w-md mx-auto">
                            {(() => { const auth = getMyAuthorship(openPoem.id); return (openPoem.lines || []).map(l => <PoemLineRow key={l.seq} l={l} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                        </div>
                    </div>
                    <button onClick={() => setOpenPoem(null)} className="relative shrink-0 mx-auto mb-4 mt-1 text-[11px] tracking-[0.2em] rounded-sm px-6 py-1.5" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.75)', border: '1px solid rgba(201,168,106,.35)', marginBottom: vrBottomPad('1rem') }}>合 上</button>
                </div>
            )}

            {/* 首次參與：特別活動知情提醒。確認過一次記在本地（隨 vrSignal 備份），之後直接進選人層 */}
            {noticeOpen && (
                <div className="absolute inset-0 z-40 flex items-center justify-center px-6" style={{ background: 'rgba(6,4,10,0.88)' }} onClick={() => setNoticeOpen(false)}>
                    <div className="w-full rounded-2xl px-4 pt-4 pb-3.5" onClick={e => e.stopPropagation()}
                        style={{ background: 'linear-gradient(165deg,#2a2138,#17111f 70%)', border: '1px solid rgba(201,168,106,.4)', boxShadow: '0 12px 40px rgba(0,0,0,.6)' }}>
                        <div className="text-center text-[13px] tracking-[0.2em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e8d6ab' }}>參與前，請讀這一頁</div>
                        <div className="my-2 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                            <span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                        </div>
                        <div className="space-y-2 text-[11px] leading-relaxed" style={{ color: 'rgba(224,208,176,.78)' }}>
                            <p>信號墜落處是<span style={{ color: '#f0dca8' }}>跨用戶的特別活動</span>：所有用戶的角色跨實例合寫同一首詩。</p>
                            <p>你的角色接龍寫下的內容，會對<span style={{ color: '#f0dca8' }}>所有其他用戶公開可見</span>，可能被截圖、二次傳播。點「繼續參與」即視為默認知情。</p>
                            <p>若發現落筆內容涉及隱私，請<span style={{ color: '#f0dca8' }}>及時聯繫作者刪除</span>。</p>
                        </div>
                        <button onClick={() => { ackSignalNotice(); setNoticeOpen(false); setPickOpen(true); }}
                            className="mt-3.5 w-full rounded-md py-2 text-[12px] tracking-[0.16em] active:scale-[0.99]"
                            style={{ fontFamily: `'Noto Serif SC',serif`, color: '#2a2012', fontWeight: 700, background: 'linear-gradient(180deg, #e6ce97 0%, #c9a86a 55%, #a8874d 100%)', border: '1px solid rgba(120,92,48,.6)', boxShadow: '0 3px 12px rgba(120,92,48,.4), inset 0 1px 0 rgba(255,244,214,.7)' }}>
                            我已知情 · 繼續參與
                        </button>
                        <button onClick={() => setNoticeOpen(false)} className="mt-2 w-full py-1.5 text-[10.5px] tracking-[0.2em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.5)' }}>再想想</button>
                    </div>
                </div>
            )}

            {/* 參與：指定角色去接一句 */}
            {pickOpen && (
                <div className="absolute inset-0 z-40 flex flex-col" style={{ background: 'rgba(6,7,22,0.95)' }} onClick={() => setPickOpen(false)}>
                    <div className="px-3.5 py-2.5 border-b border-white/10 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <span className="text-[12px] text-indigo-100">讓哪個角色去落筆？</span>
                        <button onClick={() => setPickOpen(false)} className="ml-auto h-7 w-7 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"><X size={14} /></button>
                    </div>
                    {/* 耳語：用戶的話不進詩，但角色帶著它寫——你是那個不開口的核心 */}
                    <div className="px-3.5 pt-2.5 pb-1" onClick={e => e.stopPropagation()}>
                        <div className="text-[9px] tracking-[0.2em] mb-1" style={{ color: 'rgba(201,168,106,.6)' }}>留一句耳語（可空）</div>
                        <input value={whisper} onChange={e => setWhisper(e.target.value)} maxLength={80}
                            placeholder="例：寫兇一點 / 想想我們看過的那場雪…"
                            className="w-full rounded-lg px-3 py-2 text-[12px] outline-none" style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(201,168,106,.25)', color: '#ecdcb2' }} />
                        <p className="mt-1 text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.45)' }}>這句話不會寫進詩——詩是 ta 們的作品。但 ta 會帶著它落筆。</p>
                    </div>
                    <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-1.5" onClick={e => e.stopPropagation()}>
                        {(() => { const joined = characters.filter(c => c.vrState?.enabled); return joined.length === 0 ? (
                            <p className="text-[11px] text-white/40 text-center py-8 leading-relaxed">選一位角色來彼方逛逛。<br />到「角色接入」開啟後，就能手動安排活動；想讓 ta 自己逛，再開啟自動活動。</p>
                        ) : joined.map(c => (
                            <button key={c.id} onClick={() => participate(c)} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl active:bg-white/5" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.06)' }}>
                                {c.avatar ? <TokenImg value={c.avatar} className="h-8 w-8 rounded-full object-cover shrink-0" alt="" /> : <div className="h-8 w-8 rounded-full bg-indigo-400/40 shrink-0 flex items-center justify-center text-[12px] text-white/90">{c.name.slice(0, 1)}</div>}
                                <span className="text-[12.5px] text-white/90 truncate">{c.name}</span>
                                <span className="ml-auto text-[10px] text-indigo-300/60 shrink-0">去落筆 →</span>
                            </button>
                        )); })()}
                    </div>
                    <div className="px-3.5 py-2 border-t border-white/10"><p className="text-[9px] text-indigo-300/45 leading-relaxed">選中的角色會佔住這一筆、調用一次 LLM——接上當前這首詩，或沒有正在寫的詩時起個新篇。你不落筆，但你是這片軌道正中央、那個不開口的核心。幾秒後自動刷新。</p></div>
                </div>
            )}

            {/* 後台（dev-only）：刪詩/刪句/暫停推入 */}
            {adminOpen && <SignalAdminPanel onClose={() => { setAdminOpen(false); void load(); void loadFeed(); }} addToast={addToast} />}
        </div>
    );
};

const RoomScene: React.FC<{
    roomId: VRRoomId; occupants: CharacterProfile[];
    latestByChar: Record<string, FeedItem>; onClose: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    characters: CharacterProfile[];
    userName: string;
    onUserBoardPost: (content: string, replyTo?: VRGuestbookMessage) => Promise<void>;
    onUseModule: (character: CharacterProfile) => void;
    addToast?: (m: string, t?: any) => void;
}> = ({ roomId, occupants, latestByChar, onClose, onJump, characters, userName, onUserBoardPost, onUseModule, addToast }) => {
    const room = getRoom(roomId);
    const slots = ROOM_SLOTS[roomId];
    const isMusic = roomId === 'music';
    const isGuestbook = roomId === 'guestbook';
    const isPostOffice = roomId === 'postoffice';
    const isTheater = roomId === 'theater';
    const isSignal = roomId === 'signal';
    const [detail, setDetail] = useState<CharacterProfile | null>(null);
    const [musicState, setMusicState] = useState<VRMusicRoomState | null>(null);
    const [board, setBoard] = useState<VRGuestbookState | null>(null);
    const [postText, setPostText] = useState('');
    const [replyingTo, setReplyingTo] = useState<VRGuestbookMessage | null>(null);
    const postInputRef = useRef<HTMLInputElement>(null);
    const [posting, setPosting] = useState(false);
    const [gbPage, setGbPage] = useState(0);          // 留言牆翻頁：0 = 最新一頁
    const [confirmClear, setConfirmClear] = useState(false); // 一鍵清空二次確認
    const [hideChibi, setHideChibi] = useState(false);  // 隱藏小人（留言簿等文字面板會被小人擋住時用）
    const music = useMusic();

    useEffect(() => {
        if (!isGuestbook) return;
        const load = async () => setBoard(await DB.getVRGuestbook());
        void load();
        const onDone = () => { void load(); };
        window.addEventListener('vr-session-done', onDone);
        window.addEventListener('vr-guestbook-updated', onDone);
        return () => { window.removeEventListener('vr-session-done', onDone); window.removeEventListener('vr-guestbook-updated', onDone); };
    }, [isGuestbook]);

    const submitPost = async () => {
        const t = postText.trim();
        if (!t || posting) return;
        setPosting(true);
        try {
            await onUserBoardPost(t, replyingTo || undefined);
            setPostText('');
            setReplyingTo(null);
            setGbPage(0);
            setBoard(await DB.getVRGuestbook());
        }
        finally { setPosting(false); }
    };

    const startReply = (message: VRGuestbookMessage) => {
        if (message.authorId === 'user') return;
        setReplyingTo(message);
        requestAnimationFrame(() => postInputRef.current?.focus());
    };

    // 一鍵清空留言牆（只清這面公共牆；已廣播進各角色私聊的卡片不動）
    const submitClear = async () => {
        await DB.clearVRGuestbook();
        setBoard(await DB.getVRGuestbook());
        setGbPage(0);
        setReplyingTo(null);
        setConfirmClear(false);
        trackEvent('清空彼方留言墙');
        addToast?.('留言牆已清空', 'success');
    };

    useEffect(() => {
        if (!isMusic) return;
        const load = async () => setMusicState(await DB.getVRMusicRoom());
        void load();
        const onDone = () => { void load(); };
        window.addEventListener('vr-session-done', onDone);
        return () => window.removeEventListener('vr-session-done', onDone);
    }, [isMusic]);

    const np = musicState?.nowPlaying;
    const npPlaying = !!np && music.current?.id === np.song.id && music.playing;
    // 記錄是否由聽歌房起播 —— 離開房間時只暫停"我們放的"那首，不動用戶自己的音樂
    const startedRef = useRef(false);
    const musicRef = useRef(music);
    musicRef.current = music;
    const playNow = () => {
        if (!np) return;
        if (music.current?.id === np.song.id) music.togglePlay();
        else { music.playSong(toSong(np.song)); startedRef.current = true; }
        trackEvent('播放听歌房正在放的歌');
    };
    // 音樂只在聽歌房內播放：離開場景時若仍在放我們起播的歌，暫停它
    useEffect(() => () => {
        const m = musicRef.current;
        if (startedRef.current && m.playing && m.current?.id === musicState?.nowPlaying?.song.id) {
            m.togglePlay();
        }
    }, []);

    return (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#05060d' }}>
            <VRStyleTag />
            <div className="relative flex-1 overflow-hidden">
                <RoomBackground roomId={roomId} />
                {/* 空靈氛圍：星塵 + 暗角，與外殼呼應 */}
                <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 24%, rgba(255,255,255,.5), transparent), radial-gradient(1px 1px at 72% 16%, rgba(210,220,255,.45), transparent), radial-gradient(1px 1px at 60% 66%, rgba(230,225,255,.4), transparent)', animation: 'vrtwinkle 7s ease-in-out infinite' }} />
                <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 30%, transparent 55%, rgba(5,6,14,.45) 100%)' }} />
                {/* 頂欄 */}
                <div className="absolute top-0 left-0 right-0 flex items-center gap-2.5 px-4 pb-3 z-[120]"
                    style={{ background: 'linear-gradient(180deg,rgba(5,6,14,.55),transparent)', paddingTop: VR_TOP }}>
                    <button onClick={onClose} aria-label={`離開 ${room.name}`} className="h-10 w-10 -ml-2 rounded-full bg-white/10 backdrop-blur-md active:bg-white/20 text-white/90 border border-white/10 flex items-center justify-center"><CaretLeft size={20} weight="regular" /></button>
                    <span className="text-[16px] text-white drop-shadow flex items-center gap-1.5 tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>{room.name}</span>
                    <div className="ml-auto flex items-center gap-2">
                        {occupants.length > 0 && (
                            <button onClick={() => setHideChibi(h => !h)} title={hideChibi ? '顯示小人' : '隱藏小人（避免擋住文字）'}
                                className="text-[10px] px-2.5 py-1 rounded-full bg-white/10 backdrop-blur-md text-white/85 border border-white/10 active:bg-white/20">
                                {hideChibi ? '顯示小人' : '隱藏小人'}
                            </button>
                        )}
                        <span className="text-[10px] tracking-wider text-white/60">{occupants.length} 人在場</span>
                    </div>
                </div>

                {/* 聽歌房：正在放 + 隊列面板 */}
                {isMusic && (
                    <div className="absolute left-3 right-3 z-20" style={{ top: VR_ROOM_PANEL_TOP }}>
                        {np ? (
                            <div className="rounded-2xl p-2.5 flex items-center gap-3 backdrop-blur-md"
                                style={{ background: 'rgba(20,8,40,0.6)', border: '1px solid rgba(255,123,213,0.35)', boxShadow: '0 6px 20px rgba(120,40,160,.4)' }}>
                                {np.song.albumPic
                                    ? <TokenImg value={np.song.albumPic} className={`h-14 w-14 rounded-xl object-cover ${npPlaying ? 'animate-spin-slow' : ''}`} style={npPlaying ? { animation: 'spin 8s linear infinite' } : {}} alt="" />
                                    : <div className="h-14 w-14 rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center"><MusicNotes size={22} weight="fill" className="text-white/80" /></div>}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[9px] text-pink-200/70 tracking-wide flex items-center gap-1"><MusicNotes size={9} weight="fill" /> NOW PLAYING · {np.charName} 點的</div>
                                    <div className="text-[13px] font-bold text-white truncate">{np.song.name}</div>
                                    <div className="text-[10.5px] text-pink-100/60 truncate">{np.song.artists}</div>
                                </div>
                                <button onClick={playNow} className="h-10 w-10 rounded-full bg-white/90 flex items-center justify-center active:scale-90 transition-transform shrink-0">
                                    {npPlaying ? <Pause size={18} weight="fill" className="text-purple-700" /> : <Play size={18} weight="fill" className="text-purple-700 ml-0.5" />}
                                </button>
                            </div>
                        ) : (
                            <div className="rounded-2xl p-3 text-center backdrop-blur-md" style={{ background: 'rgba(20,8,40,0.5)', border: '1px solid rgba(255,123,213,0.25)' }}>
                                <p className="text-[11px] text-pink-100/80">還沒有人放歌。讓有音樂人格的角色逛進來，ta 就會點一首。</p>
                                <p className="text-[9.5px] text-pink-200/50 mt-1">沒有音樂人格？去「音樂」App 給角色生成一個網易雲檔案。</p>
                            </div>
                        )}
                        {musicState?.queue && musicState.queue.length > 0 && (
                            <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded-full overflow-x-auto no-scrollbar" style={{ background: 'rgba(20,8,40,0.45)' }}>
                                <Queue size={12} weight="bold" className="text-pink-200/70 shrink-0" />
                                {musicState.queue.slice(0, 6).map((q, i) => (
                                    <span key={i} className="text-[9.5px] text-pink-100/70 whitespace-nowrap shrink-0">《{q.song.name}》<span className="text-pink-200/40">·{q.charName}</span>{i < Math.min(5, musicState.queue.length - 1) ? ' ·' : ''}</span>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* 留言簿：版聊牆（DC 風：頭像 + 連續消息成組，回覆弱化） */}
                {isGuestbook && (() => {
                    const GB_PAGE_SIZE = 50; // 每頁 50 條，舊消息翻頁查看
                    const all = board?.messages || [];
                    const totalPages = Math.max(1, Math.ceil(all.length / GB_PAGE_SIZE));
                    const page = Math.min(gbPage, totalPages - 1); // 0 = 最新一頁（末尾 50 條）
                    const end = all.length - page * GB_PAGE_SIZE;
                    const msgs = all.slice(Math.max(0, end - GB_PAGE_SIZE), end);
                    // 連續同一作者（且非回覆、間隔不久）合併為一組
                    const groups: VRGuestbookMessage[][] = [];
                    for (const m of msgs) {
                        const g = groups[groups.length - 1];
                        if (g && g[0].authorId === m.authorId && !m.kind && !m.replyToName && (m.createdAt - g[g.length - 1].createdAt) < 5 * 60 * 1000) g.push(m);
                        else groups.push([m]);
                    }
                    return (
                        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
                            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad(replyingTo ? '5.8rem' : '4rem'), background: 'rgba(10,22,38,0.62)', border: '1px solid rgba(140,200,255,0.22)', boxShadow: '0 8px 26px rgba(0,0,0,.4)' }}>
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
                                <span className="text-[10px] tracking-[0.25em] text-sky-200/70" style={{ fontFamily: `'Noto Serif SC',serif` }}>留言牆</span>
                                {all.length > 0 && <span className="text-[9px] text-white/30 tabular-nums">{all.length} 條</span>}
                                {all.length > 0 && (confirmClear ? (
                                    <span className="ml-auto flex items-center gap-1.5">
                                        <button onClick={submitClear} className="text-[10px] px-2 py-0.5 rounded-full text-white font-semibold" style={{ background: 'rgba(244,63,94,.85)' }}>確認清空</button>
                                        <button onClick={() => setConfirmClear(false)} className="text-[10px] px-2 py-0.5 rounded-full text-white/70 bg-white/10">取消</button>
                                    </span>
                                ) : (
                                    <button onClick={() => setConfirmClear(true)} className="ml-auto text-[10px] px-2.5 py-0.5 rounded-full text-rose-200/90 bg-white/5 border border-rose-300/20 active:bg-white/10">一鍵清空</button>
                                ))}
                            </div>
                            <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-3">
                                {groups.length === 0 ? (
                                    <p className="text-[11px] text-white/40 text-center py-6">這面牆還空著。留下第一句話，或等角色們來開帖。</p>
                                ) : groups.map(g => {
                                    const head = g[0];
                                    const isUser = head.authorId === 'user';
                                    const isAnnouncement = head.kind === 'collection-unlock';
                                    const ch = isUser ? null : characters.find(c => c.id === head.authorId);
                                    const name = isUser ? head.authorName : (ch?.name || head.authorName);
                                    const hue = (() => { let h = 0; for (let i = 0; i < head.authorId.length; i++) h = (h * 31 + head.authorId.charCodeAt(i)) % 360; return h; })();
                                    const nameColor = isAnnouncement ? '#e9cf9c' : isUser ? '#7dd3fc' : `hsl(${hue},72%,74%)`;
                                    return (
                                        <div key={head.id} className="flex gap-2.5">
                                            {ch?.avatar
                                                ? <TokenImg value={ch.avatar} className="h-8 w-8 rounded-full object-cover shrink-0 mt-0.5" alt="" />
                                                : <div className="h-8 w-8 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-[12px] font-bold text-white/95" style={{ background: isUser ? 'linear-gradient(135deg,#38bdf8,#6366f1)' : `hsl(${hue},45%,42%)` }}>{isAnnouncement ? '✧' : name.slice(0, 1)}</div>}
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline gap-1.5">
                                                    <span className="text-[12px] font-bold" style={{ color: nameColor }}>{name}</span>
                                                    {isAnnouncement && <span className="text-[9px] text-amber-200/70">圖鑑解鎖</span>}
                                                    <span className="text-[8.5px] text-white/30 tabular-nums">{new Date(head.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                                <div className="mt-1 space-y-1">
                                                    {g.map(m => (
                                                        <button key={m.id} type="button" onClick={() => startReply(m)} disabled={m.authorId === 'user'}
                                                            aria-label={m.authorId === 'user' ? undefined : `回覆 ${m.authorName}：${m.content}`}
                                                            className="block text-left text-[12.5px] leading-relaxed text-white/85 px-2.5 py-1 rounded-lg w-fit max-w-full disabled:cursor-default active:scale-[0.99]"
                                                            style={{ background: replyingTo?.id === m.id ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.055)', border: replyingTo?.id === m.id ? '1px solid rgba(125,211,252,.35)' : '1px solid transparent' }}>
                                                            {m.replyToName && <span className="text-[10px] text-sky-200/45 mr-1">↩{m.replyToName}</span>}
                                                            {m.content}
                                                            {m.authorId !== 'user' && <span className="ml-2 text-[9px] text-sky-200/35">回覆</span>}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {totalPages > 1 && (
                                <div className="flex items-center justify-center gap-3 px-3 py-1.5 border-t border-white/10 text-[10.5px] text-white/70">
                                    <button onClick={() => setGbPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                                        className="px-2.5 py-0.5 rounded-full bg-white/8 disabled:opacity-30 active:bg-white/15">← 更早</button>
                                    <span className="tabular-nums text-white/45">{totalPages - page} / {totalPages}</span>
                                    <button onClick={() => setGbPage(p => Math.max(0, p - 1))} disabled={page <= 0}
                                        className="px-2.5 py-0.5 rounded-full bg-white/8 disabled:opacity-30 active:bg-white/15">更新 →</button>
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* 郵局：信件管理面板 */}
                {isPostOffice && <PostOfficePanel addToast={addToast} characters={characters} userName={userName} />}

                {/* 劇院：話劇部門面板（投稿 / 編排 / 演出 / 歷史） */}
                {isTheater && <TheaterPanel addToast={addToast} />}

                {/* 信號墜落處：看當前合寫的詩 + 翻閱詩集 + 參與（指定角色接一句） */}
                {isSignal && <SignalPanel addToast={addToast} characters={characters} />}

                {/* chibi 站位（可隱藏，避免擋住留言牆等文字） */}
                {!hideChibi && occupants.map((c, i) => {
                    const slot = slots[i % slots.length];
                    const latest = latestByChar[c.id];
                    const idle = IDLE_QUIPS[roomId][i % IDLE_QUIPS[roomId].length];
                    const bubble = latest ? (stripSelfName(latest.meta.activity, c.name) || idle) : idle;
                    return (
                        <div key={c.id} className="absolute" style={{ left: `${slot.x}%`, top: `${slot.y}%`, zIndex: Math.round(slot.y) }}>
                            <Chibi char={c} bubble={bubble} size={104} dance={isMusic} onTap={() => setDetail(c)} />
                        </div>
                    );
                })}
                {occupants.length === 0 && !isMusic && !isGuestbook && !isPostOffice && !isTheater && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <p className="text-white/70 text-[12px] bg-black/30 rounded-full px-4 py-2">這個房間還沒有人。去「角色接入」啟用角色吧。</p>
                    </div>
                )}

                {/* 留言簿：用戶發言（廣播給所有接入角色） */}
                {isGuestbook && (
                    <div className="absolute left-0 right-0 z-30 flex flex-col gap-1.5 px-3 py-2.5"
                        style={{ bottom: vrBottomPad('0px'), background: 'linear-gradient(0deg,rgba(5,12,22,.92),transparent)' }}>
                        {replyingTo && (
                            <div className="flex items-center gap-2 px-3 text-[10px] text-sky-100/70 min-w-0">
                                <span className="shrink-0">回覆 {replyingTo.authorName}</span>
                                <span className="truncate text-white/35">{replyingTo.content}</span>
                                <button type="button" onClick={() => setReplyingTo(null)} aria-label="取消回覆" className="ml-auto shrink-0 text-white/45 active:text-white"><X size={13} /></button>
                            </div>
                        )}
                        <div className="flex items-center gap-2 w-full">
                            <input ref={postInputRef} value={postText} onChange={e => setPostText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submitPost(); }}
                                placeholder={replyingTo ? `回覆 ${replyingTo.authorName}…` : `以 ${userName} 的身份留句話…`}
                                className="flex-1 min-w-0 rounded-full px-4 py-2 text-[12.5px] text-white placeholder-white/35 outline-none backdrop-blur-md"
                                style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(140,200,255,.25)' }} />
                            <button onClick={submitPost} disabled={!postText.trim() || posting}
                                className="h-9 px-4 rounded-full text-[12px] font-semibold text-white disabled:opacity-40 shrink-0"
                                style={{ background: 'linear-gradient(120deg, rgba(120,180,255,.9), rgba(150,200,235,.85))' }}>
                                {posting ? '…' : replyingTo ? '回覆' : '留言'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* 角色活動詳情 —— 蓋在 chibi 之上（zIndex 高於任何 chibi） */}
            {detail && (
                <div className="absolute inset-0 flex items-end bg-black/45" style={{ zIndex: 200 }} onClick={() => setDetail(null)}>
                    <div className="w-full rounded-t-2xl p-4 text-white" style={{ background: 'linear-gradient(180deg,#1a2236 0%,#0d1119 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 mb-2">
                            {detail.avatar ? <TokenImg value={detail.avatar} className="h-9 w-9 rounded-full object-cover" alt="" /> : <div className="h-9 w-9 rounded-full bg-indigo-400/40" />}
                            <span className="font-bold">{detail.name}</span>
                            <button onClick={() => setDetail(null)} className="ml-auto p-1 text-white/60"><X size={18} /></button>
                        </div>
                        {latestByChar[detail.id] ? (() => {
                            const m = latestByChar[detail.id].meta;
                            return (
                                <>
                                    <p className="text-[12.5px] text-indigo-50/90 leading-relaxed">{stripSelfName(m.activity, detail.name)}</p>
                                    {m.behavior && <p className="text-[11px] text-pink-200/80 mt-1.5">{stripSelfName(m.behavior, detail.name)}</p>}
                                    {m.annotationRefs && m.annotationRefs.length > 0
                                        ? m.annotationRefs.map((ref, i) => (
                                            <button key={i} onClick={() => { onJump(m.novelId, ref.segIdx); setDetail(null); }}
                                                className="block w-full text-left mt-1.5 text-[11.5px] text-indigo-200/85 pl-2 border-l-2 border-amber-300/50 leading-snug active:opacity-60">
                                                {stripLeakedAttrs(ref.text)} <span className="text-amber-300/70">↗原文</span>
                                            </button>
                                        ))
                                        : m.annotationExcerpts?.map((ex, i) => (
                                            <div key={i} className="mt-1.5 text-[11.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug">{stripLeakedAttrs(ex)}</div>
                                        ))}
                                    <p className="text-[9px] text-indigo-300/50 mt-2">{new Date(latestByChar[detail.id].timestamp).toLocaleString('zh-CN')}</p>
                                </>
                            );
                        })() : (
                            <p className="text-[12px] text-indigo-300/60">還沒有留下動態，等 ta 下一次登入吧。</p>
                        )}
                        {detail.id !== 'user' && (
                            <>
                                {detail.vrState?.sarModule && (
                                    <p className="mt-3 text-[10px] leading-relaxed text-emerald-100/55">
                                        當前模塊：{detail.vrState.sarModule.moduleTitle} · {detail.vrState.sarModule.phase === 'active'
                                            ? `剩餘 ${detail.vrState.sarModule.remainingTurns} 回合`
                                            : `穩定期 ${detail.vrState.sarModule.afterglowTurns}/3`}
                                    </p>
                                )}
                                <button
                                    type="button"
                                    onClick={() => { onUseModule(detail); setDetail(null); }}
                                    className="mt-4 flex h-11 w-full items-center justify-center gap-2 border border-emerald-100/20 bg-emerald-300/10 text-[12px] tracking-[.08em] text-emerald-50 active:scale-[.985]"
                                >
                                    <MagicWand size={16} weight="fill" />抓住 {detail.name} · 使用模塊
                                </button>
                                <p className="mt-2 text-center text-[9px] text-white/35">無論 TA 正在哪個區域，都可以從你的模塊袋裝載</p>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// ============ 書庫 ============
// ============ 閱讀器主題 ============
interface ReaderTheme { id: string; name: string; bg: string; paper: string; text: string; sub: string; accent: string; annBg: string; }
const READER_THEMES: ReaderTheme[] = [
    { id: 'paper', name: '紙白', bg: '#e9e3d6', paper: '#f7f3ea', text: '#322d25', sub: '#8a7f6c', accent: '#a0673b', annBg: '#efe7d4' },
    { id: 'sepia', name: '羊皮', bg: '#d8c6a3', paper: '#ece0c6', text: '#48381f', sub: '#917a52', accent: '#8a5a2b', annBg: '#e2d3b2' },
    { id: 'green', name: '護眼', bg: '#bcd4bc', paper: '#d6e8d4', text: '#26331f', sub: '#5d7350', accent: '#3f6b3a', annBg: '#cadfc6' },
    { id: 'night', name: '夜閱', bg: '#15161a', paper: '#1f2128', text: '#cfc9bd', sub: '#7d7869', accent: '#c0915a', annBg: '#262932' },
    { id: 'ink', name: '墨黑', bg: '#0a0a0e', paper: '#131319', text: '#b9b4ab', sub: '#6f6a78', accent: '#8b9bff', annBg: '#1a1a24' },
];
const FONT_SIZES = [13, 15, 17, 20];
const READER_THEME_KEY = 'vr_reader_theme';
const READER_FONT_KEY = 'vr_reader_font';
const READER_MODE_KEY = 'vr_reader_mode'; // 'page' | 'scroll'
// 用戶書籤（段索引，per-novel，獨立於角色書籤）
const userBmKey = (id: string) => `vr_user_bm_${id}`;
const readUserBm = (id: string): number => {
    const v = Number(localStorage.getItem(userBmKey(id)));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};
const writeUserBm = (id: string, idx: number) => {
    try { localStorage.setItem(userBmKey(id), String(Math.max(0, idx))); } catch { /* ignore */ }
};

// 單段渲染（翻頁/滾動共用）
const SegBlock: React.FC<{
    seg: { idx: number; text: string }; anns: VRNovelAnnotation[];
    theme: ReaderTheme; fontSize: number; nameOf: (id: string) => string | undefined; highlight?: boolean;
}> = ({ seg, anns, theme, fontSize, nameOf, highlight }) => (
    <div data-seg={seg.idx} className="mb-5 rounded-lg transition-colors" style={highlight ? { background: `${theme.accent}1f`, boxShadow: `0 0 0 2px ${theme.accent}66`, padding: '8px 10px', margin: '0 -10px 20px' } : undefined}>
        <p className="whitespace-pre-wrap" style={{ color: theme.text, fontSize, lineHeight: 1.9, textIndent: '2em' }}>{seg.text}</p>
        {anns.map(a => (
            <div key={a.id} className="mt-2 ml-2 rounded-lg px-3 py-2" style={{ background: theme.annBg, borderLeft: `3px solid ${theme.accent}` }}>
                <span className="font-bold" style={{ color: theme.accent, fontSize: fontSize - 3 }}>{nameOf(a.authorId) || a.authorName}</span>
                {a.targetAnnotationId && <span style={{ color: theme.sub, fontSize: fontSize - 3 }}> 回應</span>}
                <span style={{ color: theme.text, fontSize: fontSize - 3 }}>：{stripLeakedAttrs(a.content)}</span>
            </div>
        ))}
    </div>
);

const ReaderModal: React.FC<{ novel: VRWorldNovel; characters: CharacterProfile[]; onClose: () => void; initialSeg?: number; peek?: boolean; }> = ({ novel, characters, onClose, initialSeg, peek }) => {
    const PAGE_SIZE = 8;
    const total = novel.segments.length;
    // peek（查看某條批註）時落在 initialSeg，且全程不寫用戶書籤
    const initialBm = useMemo(() => {
        const base = (initialSeg != null) ? initialSeg : readUserBm(novel.id);
        return Math.min(Math.max(0, base), Math.max(0, total - 1));
    }, [novel.id, total, initialSeg]);

    const [annotations, setAnnotations] = useState<VRNovelAnnotation[]>([]);
    const [themeId, setThemeId] = useState<string>(() => localStorage.getItem(READER_THEME_KEY) || 'paper');
    const [fontSize, setFontSize] = useState<number>(() => Number(localStorage.getItem(READER_FONT_KEY)) || 15);
    const [mode, setMode] = useState<'page' | 'scroll'>(() => (localStorage.getItem(READER_MODE_KEY) === 'scroll' ? 'scroll' : 'page'));
    const [showCtl, setShowCtl] = useState(false);

    // 翻頁態
    const [page, setPage] = useState(() => Math.floor(initialBm / PAGE_SIZE));
    // 滾動態：窗口 [winStart, winEnd)，初始落在書籤處
    const [winStart, setWinStart] = useState(() => initialBm);
    const [winEnd, setWinEnd] = useState(() => Math.min(total, initialBm + 30));
    const [topSeg, setTopSeg] = useState(initialBm);

    const scrollRef = useRef<HTMLDivElement>(null);
    const prevHeightRef = useRef<number | null>(null);
    const bmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => { void (async () => setAnnotations(await DB.getVRAnnotations(novel.id)))(); }, [novel.id]);
    useEffect(() => { localStorage.setItem(READER_THEME_KEY, themeId); }, [themeId]);
    useEffect(() => { localStorage.setItem(READER_FONT_KEY, String(fontSize)); }, [fontSize]);

    // 翻頁：換頁存書籤 + 回頂（peek 模式不寫書籤）
    useEffect(() => {
        if (mode !== 'page') return;
        if (!peek) writeUserBm(novel.id, page * PAGE_SIZE);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [page, mode, novel.id, peek]);

    // 滾動：prepend 後補償滾動位置，避免跳動
    useLayoutEffect(() => {
        if (prevHeightRef.current != null && scrollRef.current) {
            const el = scrollRef.current;
            el.scrollTop += el.scrollHeight - prevHeightRef.current;
            prevHeightRef.current = null;
        }
    }, [winStart]);

    const switchMode = (m: 'page' | 'scroll') => {
        if (m === mode) return;
        if (m === 'scroll') {
            const bm = page * PAGE_SIZE;
            setWinStart(bm); setWinEnd(Math.min(total, bm + 30)); setTopSeg(bm);
        } else {
            setPage(Math.floor(readUserBm(novel.id) / PAGE_SIZE));
        }
        setMode(m);
        localStorage.setItem(READER_MODE_KEY, m);
    };

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el || mode !== 'scroll') return;
        // 觸底加載更多
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 900 && winEnd < total) {
            setWinEnd(e => Math.min(total, e + 20));
        }
        // 觸頂往回加載
        if (el.scrollTop < 400 && winStart > 0) {
            prevHeightRef.current = el.scrollHeight;
            setWinStart(s => Math.max(0, s - 20));
        }
        // 節流存書籤（取頂部首個可見段）
        if (bmTimerRef.current) return;
        bmTimerRef.current = setTimeout(() => {
            bmTimerRef.current = null;
            const cur = scrollRef.current;
            if (!cur) return;
            const top = cur.scrollTop;
            const nodes = cur.querySelectorAll<HTMLElement>('[data-seg]');
            for (const n of Array.from(nodes)) {
                if (n.offsetTop + n.offsetHeight > top + 4) {
                    const idx = Number(n.dataset.seg);
                    setTopSeg(idx); if (!peek) writeUserBm(novel.id, idx);
                    break;
                }
            }
        }, 300);
    };

    const theme = READER_THEMES.find(t => t.id === themeId) || READER_THEMES[0];
    const annBySeg = useMemo(() => groupAnnotationsBySeg(annotations), [annotations]);
    const nameOf = (id: string) => characters.find(c => c.id === id)?.name;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const renderSegs = mode === 'page'
        ? novel.segments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        : novel.segments.slice(winStart, winEnd);

    return (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: theme.bg }}>
            {/* 頂欄 */}
            <div className="flex items-center gap-2 px-4 pb-2 shrink-0" style={{ borderBottom: `1px solid ${theme.accent}22`, paddingTop: VR_TOP }}>
                <button onClick={onClose} className="p-1.5 -ml-1.5 rounded-full active:bg-black/5" style={{ color: theme.text }}><X size={20} weight="bold" /></button>
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-bold truncate" style={{ color: theme.text }}>{novel.title}</div>
                    <div className="text-[10px]" style={{ color: theme.sub }}>
                        {mode === 'page'
                            ? `第 ${page * PAGE_SIZE + 1}~${Math.min((page + 1) * PAGE_SIZE, total)} 段 / 共 ${total} 段`
                            : `讀到第 ${topSeg + 1} 段 / 共 ${total} 段 · ${Math.round((topSeg / Math.max(1, total)) * 100)}%`}
                    </div>
                </div>
                <button onClick={() => setShowCtl(s => !s)} className="p-1.5 rounded-full active:bg-black/5" style={{ color: theme.accent }}><Palette size={18} weight="bold" /></button>
            </div>

            {peek && (
                <div className="px-4 py-1.5 shrink-0 text-[11px] text-center" style={{ background: `${theme.accent}1a`, color: theme.accent }}>
                    正在查看批註位置 · 不會改動你的書籤
                </div>
            )}

            {/* 控制條：主題 / 字號 / 模式 */}
            {showCtl && (
                <div className="px-4 py-2.5 shrink-0 space-y-2.5" style={{ background: theme.paper, borderBottom: `1px solid ${theme.accent}22` }}>
                    <div className="flex items-center gap-2">
                        <Palette size={14} style={{ color: theme.sub }} />
                        <div className="flex gap-1.5 flex-1">
                            {READER_THEMES.map(t => (
                                <button key={t.id} onClick={() => setThemeId(t.id)}
                                    className="flex-1 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold transition-all"
                                    style={{ background: t.paper, color: t.text, border: themeId === t.id ? `2px solid ${t.accent}` : `1px solid ${t.accent}33` }}>
                                    {t.name}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <TextAa size={14} style={{ color: theme.sub }} />
                        <div className="flex gap-1.5 flex-1">
                            {FONT_SIZES.map(fs => (
                                <button key={fs} onClick={() => setFontSize(fs)}
                                    className="w-9 h-7 rounded-lg font-bold transition-all"
                                    style={{ background: fontSize === fs ? theme.accent : 'transparent', color: fontSize === fs ? theme.paper : theme.sub, border: `1px solid ${theme.accent}44`, fontSize: Math.min(fs, 15) }}>
                                    A
                                </button>
                            ))}
                        </div>
                        {/* 模式切換 */}
                        <div className="flex gap-1.5">
                            {(['page', 'scroll'] as const).map(m => (
                                <button key={m} onClick={() => switchMode(m)}
                                    className="px-2.5 h-7 rounded-lg text-[11px] font-bold transition-all"
                                    style={{ background: mode === m ? theme.accent : 'transparent', color: mode === m ? theme.paper : theme.sub, border: `1px solid ${theme.accent}44` }}>
                                    {m === 'page' ? '翻頁' : '滾動'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="text-[10px] leading-snug pt-0.5" style={{ color: theme.sub }}>書裡的批註都是角色自己留的；你可以翻看，暫時還不能親自寫批註。</div>
                </div>
            )}

            {/* 正文 */}
            <div ref={scrollRef} onScroll={mode === 'scroll' ? onScroll : undefined}
                className="flex-1 overflow-y-auto vr-reader-scroll px-5 py-4" style={{ background: theme.bg, fontFamily: `'Noto Serif SC','Songti SC','Noto Serif','Georgia',serif` }}>
                {mode === 'scroll' && winStart > 0 && (
                    <div className="text-center text-[10px] mb-3" style={{ color: theme.sub }}>—— 上滑加載更早內容 ——</div>
                )}
                {renderSegs.map(seg => (
                    <SegBlock key={seg.idx} seg={seg} anns={annBySeg.get(seg.idx) || []} theme={theme} fontSize={fontSize} nameOf={nameOf} highlight={peek && seg.idx === initialSeg} />
                ))}
            </div>

            {/* 底欄 */}
            {mode === 'page' ? (
                <div className="flex items-center justify-between px-5 py-2.5 shrink-0" style={{ background: theme.paper, borderTop: `1px solid ${theme.accent}22`, paddingBottom: vrBottomPad('0.625rem') }}>
                    <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} className="text-[12px] disabled:opacity-30 font-semibold" style={{ color: theme.accent }}>‹ 上一頁</button>
                    <span className="text-[11px]" style={{ color: theme.sub }}>{page + 1} / {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} className="text-[12px] disabled:opacity-30 font-semibold" style={{ color: theme.accent }}>下一頁 ›</button>
                </div>
            ) : (
                <div className="flex items-center justify-center gap-4 px-5 py-2 shrink-0" style={{ background: theme.paper, borderTop: `1px solid ${theme.accent}22`, paddingBottom: vrBottomPad('0.5rem') }}>
                    <button onClick={() => { setWinStart(0); setWinEnd(Math.min(total, 30)); setTopSeg(0); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
                        className="text-[11px] font-semibold" style={{ color: theme.accent }}>↑ 從頭</button>
                    <span className="text-[10px]" style={{ color: theme.sub }}>滾動閱讀 · 自動記錄位置</span>
                </div>
            )}
        </div>
    );
};

// ============ 上傳彈窗（支持大文件 .txt / .pdf，內容不入 DOM） ============
type UploadFileInfo = {
    name: string;
    chars: number;
    preview: string;
    encoding: string;
    kind: 'text' | 'pdf';
    pages?: number;
};

const UploadModal: React.FC<{
    categories: VRLibraryCategory[]; initialCategoryId?: string;
    onClose: () => void;
    onCommit: (novel: VRWorldNovel) => Promise<void> | void;
    onError: (msg: string) => void;
}> = ({ onClose, onCommit, onError, categories, initialCategoryId }) => {
    const [categoryId, setCategoryId] = useState(initialCategoryId || '');
    const uploadFieldClass = 'w-full rounded-lg border border-indigo-100/70 bg-white px-3 py-2 text-slate-800 caret-indigo-500 placeholder:text-indigo-300 outline-none focus:border-indigo-300';
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [summary, setSummary] = useState('');
    // 手動粘貼的小段文本走 state；大文件內容只存 ref，不進 textarea（否則 12MB 會凍 UI）
    const [pasteText, setPasteText] = useState('');
    const [fileInfo, setFileInfo] = useState<UploadFileInfo | null>(null);
    const fileContentRef = useRef<string>('');
    // 留著原始字節，手動換編碼時無需重新讀盤即可重解碼
    const fileBufRef = useRef<ArrayBuffer | null>(null);
    const [chosenEncoding, setChosenEncoding] = useState<string>('auto');
    const fileRef = useRef<HTMLInputElement>(null);
    const [reading, setReading] = useState(false);
    const [readingStatus, setReadingStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);

    // 用某個編碼（auto = 自動識別）解碼當前緩存的字節並刷新預覽
    const applyDecode = (name: string, buf: ArrayBuffer, enc: string) => {
        const { text: content, encoding } = decodeBytes(buf, enc === 'auto' ? undefined : enc);
        fileContentRef.current = content;
        setFileInfo({
            name,
            chars: content.length,
            preview: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
            encoding,
            kind: 'text',
        });
    };

    const onFile = async (f: File | undefined) => {
        if (!f) return;
        const pdfFile = isPdfFile(f);
        const textFile = f.type.toLowerCase() === 'text/plain' || /\.(txt|text)$/i.test(f.name);
        if (!pdfFile && !textFile) {
            onError('目前只支持 .txt 和 .pdf 文件');
            if (fileRef.current) fileRef.current.value = '';
            return;
        }
        setReading(true);
        setReadingStatus(pdfFile ? '正在載入 PDF…' : '讀取並識別編碼中…');
        try {
            const buf = await f.arrayBuffer();
            if (pdfFile) {
                fileBufRef.current = null;
                const result = await extractPdfText(buf, {
                    onProgress: ({ page, totalPages }) => setReadingStatus(`正在提取 PDF 文本… ${page}/${totalPages}`),
                });
                const content = result.text.trim();
                if (!content) {
                    onError('PDF 中沒有可提取的文字，可能是掃描件或圖片 PDF；請先 OCR 後再導入');
                    return;
                }
                fileContentRef.current = content;
                setFileInfo({
                    name: f.name,
                    chars: content.length,
                    preview: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
                    encoding: 'PDF',
                    kind: 'pdf',
                    pages: result.pageCount,
                });
                trackEvent('导入 PDF 小说到彼方书库', { pages: result.pageCount, chars: content.length });
            } else {
                fileBufRef.current = buf;
                setChosenEncoding('auto');
                applyDecode(f.name, buf, 'auto');
            }
            setPasteText(''); // 文件優先，清掉粘貼框
            if (!title.trim()) setTitle(f.name.replace(/\.(txt|text|pdf)$/i, ''));
        } catch (e) {
            console.error('[VRWorld] read novel file failed', e);
            onError(pdfFile ? 'PDF 讀取失敗，文件可能已損壞、加密或網絡組件加載失敗' : '文件讀取失敗');
        } finally {
            setReading(false);
            setReadingStatus('');
        }
    };

    // 手動換編碼（亂碼時用）：拿緩存字節重新解碼，不必再選一遍文件
    const redecode = (enc: string) => {
        const buf = fileBufRef.current;
        if (!buf || !fileInfo) return;
        setChosenEncoding(enc);
        applyDecode(fileInfo.name, buf, enc);
    };

    const clearFile = () => {
        fileContentRef.current = '';
        fileBufRef.current = null;
        setChosenEncoding('auto');
        setFileInfo(null);
        setReadingStatus('');
        if (fileRef.current) fileRef.current.value = '';
    };

    const totalChars = fileInfo ? fileInfo.chars : pasteText.length;
    const canSave = !!title.trim() && totalChars > 0 && !busy;

    const handleSave = async () => {
        const content = fileInfo ? fileContentRef.current : pasteText;
        if (!title.trim() || !content) { onError('書名和正文都要填'); return; }
        setBusy(true);
        setProgress(0);
        try {
            // 讓出一幀，先讓"處理中"渲染出來
            await new Promise<void>(r => setTimeout(r));
            const novel = await buildNovelAsync(title, content, {
                author, summary,
                onProgress: (r) => setProgress(Math.round(r * 100)),
            });
            if (novel.segments.length === 0) { onError('正文是空的'); setBusy(false); return; }
            await onCommit({ ...novel, categoryId: categories.some(c => c.id === categoryId) ? categoryId : undefined });
            trackEvent('上架一本小说到书库');
        } catch (e) {
            console.error('[VRWorld] build novel failed', e);
            onError('處理失敗，文件可能太大或格式異常');
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={busy ? undefined : onClose}>
            <div className="w-full max-w-md rounded-t-2xl p-4 max-h-[88vh] overflow-y-auto vr-reader-scroll" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center mb-3">
                    <span className="text-[15px] font-bold text-white">上傳小說</span>
                    {!busy && <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>}
                </div>

                <input ref={fileRef} type="file" accept=".txt,text/plain,.pdf,application/pdf" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
                {reading ? (
                    <div className="w-full rounded-xl border border-indigo-300/30 py-5 mb-3 flex items-center justify-center gap-2 text-indigo-100/90">
                        <CircleNotch size={18} weight="bold" className="animate-spin" /> {readingStatus}
                    </div>
                ) : fileInfo ? (
                    <div className="rounded-xl border border-indigo-300/30 p-3 mb-3 bg-white/5">
                        <div className="flex items-center gap-2">
                            <BookOpen size={16} weight="fill" className="text-amber-200 shrink-0" />
                            <span className="text-[12.5px] text-white font-semibold truncate flex-1">{fileInfo.name}</span>
                            <span className="text-[8.5px] text-indigo-300/60 border border-indigo-300/30 rounded px-1 uppercase">
                                {fileInfo.kind === 'pdf' ? `PDF · ${fileInfo.pages} 頁` : fileInfo.encoding}
                            </span>
                            {!busy && <button onClick={clearFile} className="text-indigo-300/60 p-1"><X size={14} /></button>}
                        </div>
                        <div className="text-[10px] text-indigo-300/60 mt-1">{fileInfo.chars.toLocaleString()} 字 · 預計 ~{Math.ceil(fileInfo.chars / 400).toLocaleString()} 段</div>
                        <p className="text-[10.5px] text-indigo-200/50 mt-1.5 leading-snug line-clamp-2">{fileInfo.preview}…</p>
                        {!busy && fileInfo.kind === 'text' && (
                            <div className="flex items-center gap-1.5 mt-2">
                                <span className="text-[9.5px] text-indigo-300/55 shrink-0">亂碼？換編碼</span>
                                <select value={chosenEncoding} onChange={e => redecode(e.target.value)}
                                    className="flex-1 text-[10px] bg-[#1b2236] text-indigo-100 border border-indigo-300/25 rounded px-1.5 py-1 outline-none">
                                    <option value="auto">自動識別</option>
                                    <option value="utf-8">UTF-8</option>
                                    <option value="gb18030">簡體中文 · GB18030 / GBK</option>
                                    <option value="big5">繁體中文 · Big5</option>
                                    <option value="shift_jis">日文 · Shift_JIS</option>
                                    <option value="euc-jp">日文 · EUC-JP</option>
                                </select>
                            </div>
                        )}
                    </div>
                ) : (
                    <button onClick={() => fileRef.current?.click()}
                        className="w-full rounded-xl border border-dashed border-indigo-300/40 py-3 mb-3 text-[12.5px] text-indigo-100/90 flex items-center justify-center gap-2 active:bg-white/5">
                        <UploadSimple size={16} weight="bold" /> 選擇 .txt / .pdf 文件（大文件也 OK）
                    </button>
                )}

                <div className="space-y-2.5">
                    <input value={title} onChange={e => setTitle(e.target.value)} placeholder="書名（必填）" className={`${uploadFieldClass} text-[13px]`} />
                    <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="作者（選填）" className={`${uploadFieldClass} text-[13px]`} />
                    <label className="block text-[11px] text-indigo-100">書籍分類<select aria-label="上架書籍分類" value={categoryId} onChange={e => setCategoryId(e.target.value)} disabled={busy} className={`${uploadFieldClass} mt-1 text-[13px]`}><option value="">未分類</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                    <input value={summary} onChange={e => setSummary(e.target.value)} placeholder="一句話簡介（選填，餵給角色當背景）" className={`${uploadFieldClass} text-[13px]`} />
                    {!fileInfo && (
                        <>
                            <div className="text-[10px] text-indigo-300/50">或直接粘貼正文（小段文本用；大文件請走上面的文件選擇）↓</div>
                            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="粘貼正文…" rows={6}
                                className={`${uploadFieldClass} text-[12.5px] leading-relaxed`} />
                        </>
                    )}
                    <div className="text-[10px] text-indigo-300/50">{totalChars.toLocaleString()} 字</div>
                </div>

                {busy ? (
                    <div className="mt-3">
                        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg,#8b7bf0,#b06ad6)' }} />
                        </div>
                        <div className="text-[11px] text-indigo-200/70 text-center mt-1.5">處理中… {progress}%（大文件需要點時間）</div>
                    </div>
                ) : (
                    <button onClick={handleSave} disabled={!canSave}
                        className="w-full mt-3 rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                        上架到書庫
                    </button>
                )}
            </div>
        </div>
    );
};

// ============ chibi 形象編輯器（複用特別時光的捏人系統） ============
type ChibiSave = { img: string; state?: any; scale: number; offsetY: number; flip: boolean };
const ChibiEditor: React.FC<{
    char: CharacterProfile;
    onClose: () => void;
    onSave: (chibi: ChibiSave) => void;
}> = ({ char, onClose, onSave }) => {
    const existing = char.vrState?.chibi;
    // 已捏過的：進入"預覽 + 微調"頁；點"重新捏"再開捏人器。沒捏過：直接進捏人器。
    const [creating, setCreating] = useState<boolean>(!existing?.img);
    const [img, setImg] = useState<string>(existing?.img || '');
    const [state, setState] = useState<any>(existing?.state);
    const [scale, setScale] = useState<number>(existing?.scale ?? 1);
    const [offsetY, setOffsetY] = useState<number>(existing?.offsetY ?? 0);
    const [flip, setFlip] = useState<boolean>(!!existing?.flip);

    const isSully = (char.name || '').toLowerCase().includes('sully');
    // 回填：捏人器 init 讀 presets（扁平 map），用上次導出的 state.selected
    const presets = existing?.state?.selected || (isSully ? { skin: 'skin_1', fronthair: 'fronthair_99', eyes: 'eyes_99' } : undefined);

    const onConfirm = (r: ChibiResult) => {
        setImg(r.transparentDataUrl);
        setState(r.state);
        setScale(1); setOffsetY(0); setFlip(false);
        setCreating(false);
    };

    if (creating) {
        return (
            <div className="fixed inset-0 z-[60] flex flex-col bg-black">
                <div className="flex items-center gap-2 px-4 pb-2 shrink-0 text-white" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingTop: VR_TOP }}>
                    <button onClick={() => existing?.img ? setCreating(false) : onClose()} className="p-1.5 -ml-1.5 rounded-full active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                    <span className="text-[14px] font-bold">捏 {char.name} 的小人</span>
                </div>
                <div className="flex-1 min-h-0">
                    <CreatorIframe mode="char" charName={char.name} isSully={isSully} presets={presets}
                        savedState={existing?.state}
                        draftKey={`vr_${char.id}`} title={`捏一個小人 · ${char.name}`} subtitle="彼方 · CHIBI"
                        onConfirm={onConfirm} />
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55" onClick={onClose}>
            <VRStyleTag />
            <div className="w-full max-w-md rounded-t-2xl p-4" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center mb-1">
                    <span className="text-[15px] font-bold text-white">{char.name} 的彼方形象</span>
                    <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>
                </div>
                <p className="text-[10.5px] text-indigo-300/60 mb-3">這個 Q 版小人會站在彼方的房間裡。可以重新捏，或微調站位。</p>

                <div className="relative rounded-xl h-48 overflow-hidden mb-3 flex items-end justify-center" style={{ background: 'linear-gradient(180deg,#2a2350,#15132b)' }}>
                    <div className="absolute inset-0 opacity-50" style={{ backgroundImage: 'radial-gradient(1.5px 1.5px at 30% 30%, rgba(255,255,255,.5), transparent), radial-gradient(1.5px 1.5px at 70% 50%, rgba(200,220,255,.4), transparent)' }} />
                    {img && <TokenImg value={img} alt="" className="object-contain mb-3" style={{ height: 140 * scale, transform: `scaleX(${flip ? -1 : 1}) translateY(${offsetY}px)`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.5))', animation: 'vrfloat 3.2s ease-in-out infinite' }} />}
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[50%]" style={{ width: 76, height: 17, background: 'radial-gradient(ellipse,rgba(0,0,0,.5),transparent)' }} />
                </div>

                <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-indigo-300/40 py-2 mb-3 text-[12px] text-indigo-100 flex items-center justify-center gap-1.5 active:bg-white/5">
                    <PencilSimple size={14} weight="bold" /> 重新捏小人
                </button>

                <div className="space-y-2.5 mb-3">
                    <label className="flex items-center gap-2 text-[11px] text-indigo-200/80">
                        <UploadSimple size={14} className="rotate-90" /> 大小
                        <input type="range" min={0.5} max={1.6} step={0.05} value={scale} onChange={e => setScale(Number(e.target.value))} className="flex-1 accent-indigo-400" />
                    </label>
                    <button onClick={() => setFlip(f => !f)} className={`text-[11px] rounded-full px-3 py-1 flex items-center gap-1.5 ${flip ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/80'}`}>
                        <FlipHorizontal size={13} /> 水平翻轉
                    </button>
                </div>

                <button onClick={() => { if (img) onSave({ img, state, scale, offsetY, flip }); }} disabled={!img}
                    className="w-full rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                    保存形象{char.vrState?.enabled ? '' : ' 並接入'}
                </button>
            </div>
        </div>
    );
};

// ============ 用戶本人捏 chibi（mode="user"，結構同角色 chibi） ============
const UserChibiEditor: React.FC<{
    userName: string;
    existing?: { img: string; state?: any; scale?: number; offsetY?: number; flip?: boolean };
    onClose: () => void;
    onSave: (chibi: ChibiSave) => void;
}> = ({ userName, existing, onClose, onSave }) => {
    const [creating, setCreating] = useState<boolean>(!existing?.img);
    const [img, setImg] = useState<string>(existing?.img || '');
    const [state, setState] = useState<any>(existing?.state);
    const [scale, setScale] = useState<number>(existing?.scale ?? 1);
    const [offsetY, setOffsetY] = useState<number>(existing?.offsetY ?? 0);
    const [flip, setFlip] = useState<boolean>(!!existing?.flip);
    const presets = existing?.state?.selected;

    const onConfirm = (r: ChibiResult) => {
        setImg(r.transparentDataUrl); setState(r.state);
        setScale(1); setOffsetY(0); setFlip(false); setCreating(false);
    };

    if (creating) {
        return (
            <div className="fixed inset-0 z-[60] flex flex-col bg-black" style={{ paddingTop: VR_TOP }}>
                <CreatorIframe mode="user" charName={userName} presets={presets}
                    savedState={existing?.state}
                    draftKey="vr_user" title={`捏一個你自己 · ${userName}`} subtitle="彼方 · 你的 CHIBI"
                    onConfirm={onConfirm} />
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55" onClick={onClose}>
            <div className="w-full max-w-md rounded-t-2xl p-4" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[15px] font-bold text-white">你的彼方形象</span>
                    <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>
                </div>
                <p className="text-[10.5px] text-indigo-300/60 mb-3">這個 Q 版小人就是「你」在彼方里的化身，會站在你掛著的房間裡。</p>
                <div className="relative rounded-xl h-48 overflow-hidden mb-3 flex items-end justify-center" style={{ background: 'linear-gradient(180deg,#2a2350,#15132b)' }}>
                    {img && <TokenImg value={img} alt="" className="object-contain mb-3" style={{ height: 140 * scale, transform: `scaleX(${flip ? -1 : 1}) translateY(${offsetY}px)`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.5))', animation: 'vrfloat 3.2s ease-in-out infinite' }} />}
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[50%]" style={{ width: 76, height: 17, background: 'radial-gradient(ellipse,rgba(0,0,0,.5),transparent)' }} />
                </div>
                <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-indigo-300/40 py-2 mb-3 text-[12px] text-indigo-100 flex items-center justify-center gap-1.5 active:bg-white/5">
                    <PencilSimple size={14} weight="bold" /> 重新捏小人
                </button>
                <div className="space-y-2.5 mb-3">
                    <label className="flex items-center gap-2 text-[11px] text-indigo-200/80">
                        <UploadSimple size={14} className="rotate-90" /> 大小
                        <input type="range" min={0.5} max={1.6} step={0.05} value={scale} onChange={e => setScale(Number(e.target.value))} className="flex-1 accent-indigo-400" />
                    </label>
                    <button onClick={() => setFlip(f => !f)} className={`text-[11px] rounded-full px-3 py-1 flex items-center gap-1.5 ${flip ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/80'}`}>
                        <FlipHorizontal size={13} /> 水平翻轉
                    </button>
                </div>
                <button onClick={() => { if (img) onSave({ img, state, scale, offsetY, flip }); }} disabled={!img}
                    className="w-full rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                    保存形象
                </button>
            </div>
        </div>
    );
};

// ============ 用戶本人接入彼方面板（捏 chibi / 選房間 / 寫在幹嘛 / 廣播） ============
const USER_VR_PRESETS = ['在看小說', '在自習 / 刷題', '在聽歌單曲循環', '單純掛機放空', '在娛樂室瞎玩', '在寫漂流信'];
const UserVRPanel: React.FC<{
    userProfile?: UserProfile;
    updateUserProfile: (u: Partial<UserProfile>) => void;
    onEditChibi: () => void;
    onBroadcast: (room: VRRoomId, activity: string) => Promise<void> | void;
    addToast?: (m: string, t?: any) => void;
}> = ({ userProfile, updateUserProfile, onEditChibi, onBroadcast, addToast }) => {
    const uv = userProfile?.vrState;
    const enabled = !!uv?.enabled;
    const chibi = uv?.chibi;
    const [room, setRoom] = useState<VRRoomId>(uv?.currentRoom || 'guestbook');
    const [activity, setActivity] = useState(uv?.activity || '');

    // userProfile 外部變化（如剛捏完 chibi）時同步本地草稿
    useEffect(() => { setRoom(uv?.currentRoom || 'guestbook'); setActivity(uv?.activity || ''); }, [uv?.currentRoom, uv?.activity]);

    const ROOMS: [VRRoomId, string][] = [['library', '圖書館'], ['music', '聽歌房'], ['guestbook', '留言簿'], ['gym', '娛樂室'], ['postoffice', '郵局'], ['sar', 'SAR 活動空間']];

    const join = () => {
        if (!chibi?.img) { onEditChibi(); return; } // 沒捏小人 → 先捏，再回來開接入
        updateUserProfile({ vrState: { ...(uv || {}), enabled: true, currentRoom: room, activity: activity.trim(), updatedAt: Date.now() } });
        addToast?.('你已接入彼方', 'success');
        trackEvent('开启用户本人接入彼方', { action: 'enable' });
    };
    const logout = () => {
        updateUserProfile({ vrState: { ...(uv || {}), enabled: false } });
        addToast?.('已從彼方登出', 'success'); // 登出后角色聊天裡的"你在彼方"提示隨之消失
        trackEvent('开启用户本人接入彼方', { action: 'disable' });
    };
    const saveBroadcast = () => {
        updateUserProfile({ vrState: { ...(uv || {}), enabled: true, currentRoom: room, activity: activity.trim(), updatedAt: Date.now() } });
        void onBroadcast(room, activity.trim());
    };

    return (
        <div className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'linear-gradient(135deg, rgba(120,130,255,0.10), rgba(150,212,204,0.06))', border: '1px solid rgba(150,168,255,0.22)' }}>
            <div className="flex items-center gap-2.5">
                <button onClick={onEditChibi} className="relative h-12 w-12 rounded-xl overflow-hidden bg-black/20 flex items-end justify-center shrink-0 active:opacity-80">
                    {chibi?.img ? <TokenImg value={chibi.img} className="h-11 object-contain object-bottom" style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} alt="" /> : <span className="text-lg text-indigo-300/60 mb-2">＋</span>}
                    <span className="absolute bottom-0 right-0 bg-indigo-500/90 rounded-tl-md p-0.5"><PencilSimple size={9} weight="bold" /></span>
                </button>
                <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-white truncate">你自己 · {userProfile?.name || '我'}</div>
                    <div className="text-[10px] text-indigo-300/60">{enabled ? '已接入彼方 · 角色能看到你在這兒' : chibi?.img ? '已捏形象 · 未接入' : '捏個自己的小人，接入彼方'}</div>
                </div>
                <button onClick={enabled ? logout : join}
                    className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-indigo-400' : 'bg-white/15'}`}>
                    <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                </button>
            </div>
            {enabled && (
                <>
                    <div className="mt-3 text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5">你掛在哪個房間</div>
                    <div className="flex flex-wrap gap-1.5">
                        {ROOMS.map(([rid, label]) => (
                            <button key={rid} onClick={() => setRoom(rid)}
                                className={`text-[10.5px] rounded-full px-2.5 py-1 font-semibold ${room === rid ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/70'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="mt-3 text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5">你在幹嘛（角色會看到）</div>
                    <input value={activity} onChange={e => setActivity(e.target.value)}
                        placeholder="例：在看小說 / 在自習 / 單純掛機…"
                        className="w-full rounded-lg px-3 py-2 text-[12.5px] text-white placeholder-white/30 outline-none" style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(150,200,255,.2)' }} />
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {USER_VR_PRESETS.map(p => (
                            <button key={p} onClick={() => setActivity(p)} className="text-[10px] rounded-full px-2 py-0.5 bg-white/[0.08] text-indigo-200/60 active:bg-white/15">{p}</button>
                        ))}
                    </div>
                    <button onClick={saveBroadcast}
                        className="mt-3 w-full rounded-xl py-2 text-[12.5px] font-bold text-white" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                        保存並廣播給所有角色
                    </button>
                    <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-white/10 bg-black/10 px-3 py-2.5">
                        <ShieldCheck size={17} weight={uv?.allowCharacterModules ? 'fill' : 'regular'} className={uv?.allowCharacterModules ? 'text-emerald-200' : 'text-indigo-200/45'} />
                        <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-semibold text-white/80">允許角色對我使用模塊</div>
                            <div className="mt-0.5 text-[9px] leading-relaxed text-indigo-200/40">默認關閉；僅在你與角色同時位於 SAR 時可能觸發，持續 5 次成功互動。</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={uv?.allowCharacterModules === true}
                            aria-label="允許角色對我使用模塊"
                            onClick={() => updateUserProfile({ vrState: { ...(uv || {}), allowCharacterModules: uv?.allowCharacterModules !== true } })}
                            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${uv?.allowCharacterModules ? 'bg-emerald-400/75' : 'bg-white/15'}`}
                        >
                            <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${uv?.allowCharacterModules ? 'translate-x-5' : ''}`} />
                        </button>
                    </div>
                    {uv?.sarModule && (
                        <div className="mt-2 rounded-lg border border-emerald-200/15 bg-emerald-300/[0.06] px-3 py-2 text-[9.5px] text-emerald-100/65">
                            你身上的模塊：{uv.sarModule.moduleTitle} · {uv.sarModule.phase === 'active'
                                ? `剩餘 ${uv.sarModule.remainingTurns}/${uv.sarModule.totalTurns} 次`
                                : `退場穩定 ${uv.sarModule.afterglowTurns}/3`}
                        </div>
                    )}
                    <p className="text-[9.5px] text-indigo-300/45 mt-2 leading-relaxed">角色聊天裡會知道"你此刻在彼方做什麼"，但已明確告知 ta：這只是虛擬空間掛機、你本人不一定在線，一切以聊天記錄為準。</p>
                </>
            )}
        </div>
    );
};

// ============ 接入設置 ============
const INTERVAL_OPTIONS = [60, 120, 180, 360, 720];

const SettingsView: React.FC<{
    characters: CharacterProfile[];
    updateCharacter: ReturnType<typeof useOS>['updateCharacter'];
    addToast?: (msg: string, type?: any) => void;
    novels: VRWorldNovel[]; onReload: () => void;
    onRequestEnable: (char: CharacterProfile) => void;
    onEditChibi: (char: CharacterProfile) => void;
    onEditReadingPreference: (char: CharacterProfile) => void;
}> = ({ characters, updateCharacter, addToast, novels, onReload, onRequestEnable, onEditChibi, onEditReadingPreference }) => {
    const [pickFor, setPickFor] = useState<CharacterProfile | null>(null);
    // 接入列表的分組篩選（characters 由 props 傳入，這裡單獨取 characterGroups 即可）
    const { characterGroups } = useOS();
    const [settingsGroupId, setSettingsGroupId] = useState<string>(GROUP_FILTER_ALL);
    const [settingsPage, setSettingsPage] = useState(0);
    const groupedCharacters = useMemo(() => filterCharactersByGroup(characters, characterGroups, settingsGroupId), [characters, characterGroups, settingsGroupId]);
    const pageCount = Math.max(1, Math.ceil(groupedCharacters.length / 5));
    const currentPage = Math.min(settingsPage, pageCount - 1);
    const visibleCharacters = groupedCharacters.slice(currentPage * 5, currentPage * 5 + 5);
    useEffect(() => { setSettingsPage(0); }, [settingsGroupId]);
    const novelCount = novels.length;

    const go = (room?: VRRoomId, sarActivity?: VRSARActivity) => {
        if (!pickFor) return;
        if (room === 'library' && !readableNovels(novels, pickFor).length) {
            addToast?.('當前閱讀範圍內還沒有書，請先歸入書籍或調整閱讀偏好。', 'info');
            return;
        }
        if (sarActivity === 'garden') {
            const market = readFishingMarketState();
            if (!market.dinosaurGarden?.visitsEnabled || !gardenResidents(market).length) {
                addToast?.('先在恐龍箱庭開啟共同擺弄，並在桌上放一隻恐龍。', 'info');
                return;
            }
        }
        VRScheduler.triggerNow(pickFor.id, room, undefined, sarActivity);
        addToast?.(`${pickFor.name} 正在登入彼方…`, 'info');
        setTimeout(onReload, 4000);
        setPickFor(null);
    };

    const disable = (char: CharacterProfile) => {
        updateCharacter(char.id, { vrState: { ...(char.vrState || { intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), enabled: false } as any });
        VRScheduler.stop(char.id);
        trackEvent('开启角色接入彼方', { action: 'disable' });
    };
    const setInterval = (char: CharacterProfile, minutes: number) => {
        updateCharacter(char.id, { vrState: { ...(char.vrState || {}), enabled: char.vrState?.enabled ?? true, intervalMinutes: minutes } });
        if (allowsAutomaticVR(char.vrState)) VRScheduler.start(char.id, minutes);
    };
    const setActivityMode = (char: CharacterProfile, activityMode: 'manual' | 'scheduled') => {
        const vrState = { ...joinVRState(char.vrState), activityMode };
        updateCharacter(char.id, { vrState });
        if (allowsAutomaticVR(vrState)) VRScheduler.start(char.id, vrState.intervalMinutes);
        else VRScheduler.stop(char.id);
    };
    const pageNavigation = pageCount > 1 && <nav className="flex items-center justify-between gap-2 py-2 text-[11px] text-indigo-200/70" aria-label="角色接入分頁">
        <button type="button" disabled={currentPage === 0} onClick={() => setSettingsPage(currentPage - 1)} className="min-h-10 rounded-xl bg-white/[0.06] px-3 disabled:opacity-25">上一頁</button>
        <span className="tabular-nums">{currentPage + 1} / {pageCount} 頁 · 共 {groupedCharacters.length} 位</span>
        <button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setSettingsPage(currentPage + 1)} className="min-h-10 rounded-xl bg-white/[0.06] px-3 disabled:opacity-25">下一頁</button>
    </nav>;

    return (
        <div className="space-y-3">
            <p className="text-[11px] text-indigo-300/60 leading-relaxed">
                接入後，角色會知道「彼方」，小人可以掛在房間裡。默認僅手動活動：等你選房間、邀請釣魚或玩箱庭時才行動，不設置間隔、不自動調用模型。
                想讓 ta 自己逛，再開啟自動活動。每次實際活動會留下動態卡片；自動活動連著 {VR_FAIL_LIMIT} 次調不通模型會暫停。
                {novelCount === 0 && <span className="text-amber-300/80"> 書庫還空著，先去「書庫」上傳一本。</span>}
            </p>
            {characters.length === 0 && <p className="text-[11px] text-indigo-300/50 py-4 text-center">還沒有角色。</p>}
            {/* 分組篩選（沒建分組時不渲染）：深色底 */}
            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                value={settingsGroupId} onChange={setSettingsGroupId} />
            {pageNavigation}
            {characters.length > 0 && groupedCharacters.length === 0 &&
                <p className="text-[11px] text-indigo-300/50 py-4 text-center">該分組下沒有角色</p>}
            {visibleCharacters.map(char => {
                const st = char.vrState;
                const enabled = !!st?.enabled;
                const automatic = allowsAutomaticVR(st);
                const interval = st?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
                const chibi = getChibi(char);
                const failStreak = VRScheduler.getFailStreak(char.id);
                return (
                    <div key={char.id} data-vr-character={char.id} className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2.5">
                            {/* chibi 縮略 */}
                            <button onClick={() => onEditChibi(char)} className="relative h-12 w-12 rounded-xl overflow-hidden bg-black/20 flex items-end justify-center shrink-0 active:opacity-80">
                                {chibi.img ? <TokenImg value={chibi.img} className="h-11 object-contain object-bottom" style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} alt="" /> : <span className="text-lg text-indigo-300/60 mb-2">？</span>}
                                <span className="absolute bottom-0 right-0 bg-indigo-500/90 rounded-tl-md p-0.5"><PencilSimple size={9} weight="bold" /></span>
                            </button>
                            <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-bold truncate">{char.name}</div>
                                {enabled ? (
                                    <div className="text-[10px] text-indigo-300/60">
                                        {automatic ? `每 ${interval >= 60 ? `${formatHours(interval)} 小時` : `${interval} 分`}自動活動一次` : '僅手動活動 · 等你邀請'}
                                        {st?.sarModule && <span className="text-emerald-200/70"> · {st.sarModule.moduleTitle} {st.sarModule.phase === 'active' ? `${st.sarModule.remainingTurns}/${st.sarModule.totalTurns}` : `穩定 ${st.sarModule.afterglowTurns}/3`}</span>}
                                        {/* 後台失敗本來一點聲響都沒有，攢到熔斷前先讓用戶看見 */}
                                        {automatic && failStreak > 0 && <span className="text-amber-300/80"> · 已連續 {failStreak} 次沒調通</span>}
                                    </div>
                                ) : <div className="text-[10px] text-indigo-300/40">{chibi.isFallback ? '未設形象 · 未接入' : '未接入'}</div>}
                            </div>
                            <button type="button" role="switch" aria-checked={enabled} aria-label={`${char.name}的彼方接入`} onClick={() => enabled ? disable(char) : onRequestEnable(char)}
                                className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-indigo-400' : 'bg-white/15'}`}>
                                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                        {enabled && (
                            <>
                                <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label={`${char.name}的活動方式`}>
                                    <button type="button" aria-pressed={!automatic} onClick={() => setActivityMode(char, 'manual')}
                                        className={`rounded-xl px-3 py-2.5 text-left border ${!automatic ? 'bg-indigo-400/20 border-indigo-300/60 text-indigo-100' : 'border-white/10 text-indigo-200/60'}`}>
                                        <b className="block text-[12px]">僅手動活動</b><span className="text-[10px]">你選擇時才行動</span>
                                    </button>
                                    <button type="button" aria-pressed={automatic} onClick={() => setActivityMode(char, 'scheduled')}
                                        className={`rounded-xl px-3 py-2.5 text-left border ${automatic ? 'bg-indigo-400/20 border-indigo-300/60 text-indigo-100' : 'border-white/10 text-indigo-200/60'}`}>
                                        <b className="block text-[12px]">自動活動</b><span className="text-[10px]">按間隔自己去逛</span>
                                    </button>
                                </div>
                                {automatic && <div className="flex flex-wrap gap-1.5 mt-2.5" aria-label="自動活動間隔">
                                    {INTERVAL_OPTIONS.map(opt => (
                                        <button key={opt} onClick={() => setInterval(char, opt)}
                                            className={`text-[10.5px] rounded-full px-2.5 py-1 font-semibold ${interval === opt ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/70'}`}>
                                            {opt >= 60 ? `${formatHours(opt)}h` : `${opt}min`}
                                        </button>
                                    ))}
                                </div>}
                                <button onClick={() => setPickFor(char)}
                                    className="mt-2.5 text-[11px] text-amber-200 font-semibold flex items-center gap-1 active:opacity-70">
                                    <Play size={12} weight="fill" /> 讓 ta 現在去逛一次
                                </button>
                            </>
                        )}
                        <VRActivityRestrictions char={char} onChange={change => {
                            updateCharacter(char.id, latest => ({vrState:change(latest.vrState || {enabled:false,intervalMinutes:VR_DEFAULT_INTERVAL_MIN})}));
                        }}/>
                        {novelCount > 0 && (
                            <button onClick={() => onEditReadingPreference(char)}
                                className="mt-2.5 flex w-full items-center gap-2 border-t border-white/[0.07] pt-2.5 text-left active:opacity-70">
                                <BookOpen size={13} weight="fill" className="text-indigo-200/70" />
                                <span className="text-[11px] font-semibold text-indigo-100/75">閱讀偏好</span>
                                <span className="ml-auto text-[10px] text-indigo-300/45">{readingPreferenceLabel(char)}</span>
                                <CaretRight size={11} weight="bold" className="text-indigo-300/35" />
                            </button>
                        )}
                    </div>
                );
            })}
            {pageNavigation}
            {pickFor && <VRActivityPicker char={pickFor} libraryAvailable={readableNovels(novels,pickFor).length > 0}
                gardenReason={(() => {const market=readFishingMarketState();return !market.dinosaurGarden?.visitsEnabled ? '先在箱庭開啟共同擺弄' : !gardenResidents(market).length ? '先在桌上放一隻恐龍' : undefined;})()}
                onGo={go} onClose={() => setPickFor(null)}/>}
        </div>
    );
};

// ============ 彼方 · API 設置 + 調用記錄 ============
const VRApiSettings: React.FC<{ apiPresets: ApiPreset[]; chatApi: APIConfig; addToast?: (m: string, t?: any) => void; characters: CharacterProfile[] }> = ({ apiPresets, chatApi, addToast, characters }) => {
    const [vrApi, setVr] = useState<APIConfig | null>(null);
    const [log, setLog] = useState<VRApiCall[]>([]);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);
    const [presetsOpen, setPresetsOpen] = useState(false);   // 摺疊「保存的預設」長列表
    const [snapshot, setSnapshot] = useState<string | null>(null);   // 排障快照正文
    const [collecting, setCollecting] = useState(false);

    useEffect(() => {
        void getVRApi().then(setVr);
        void getVRApiLog().then(setLog);
        const h = () => { void getVRApiLog().then(setLog); };
        window.addEventListener('vr-api-log', h);
        return () => window.removeEventListener('vr-api-log', h);
    }, []);

    const follow = !vrApi?.baseUrl;
    const effective = follow ? chatApi : vrApi!;
    const sameAs = (c: APIConfig) => !follow && vrApi!.baseUrl === c.baseUrl && vrApi!.model === c.model && vrApi!.apiKey === c.apiKey;
    const host = (u?: string) => { try { return u ? new URL(u).host : '—'; } catch { return u || '—'; } };

    const choose = (cfg: APIConfig | null) => {
        void setVRApi(cfg); setVr(cfg); setTestResult(null);
        addToast?.(cfg ? '已切換彼方 API' : '彼方改為跟隨聊天默認', 'success');
    };

    const test = async () => {
        const cfg = effective;
        if (!cfg?.baseUrl) { setTestResult('當前沒有可用的 API'); return; }
        setTesting(true); setTestResult(null);
        try {
            const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey || 'sk-none'}` },
                body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: false }),
            });
            if (res.ok) { const d = await safeResponseJson(res); const r = d.choices?.[0]?.message?.content || ''; setTestResult(`連接成功 — 模型回覆:"${r.slice(0, 24)}"`); }
            else { const t = await res.text().catch(() => ''); setTestResult(`HTTP ${res.status}: ${t.slice(0, 80)}`); }
        } catch (e: any) { setTestResult(`連接失敗: ${e.message}`); } finally { setTesting(false); }
    };

    // 手機上沒有控制台，「界面全關了記錄還在漲」這類問題光靠截圖說不清。
    // 一次把該看的都收齊，複製走即可；收的全是狀態，不含名字、聊天和 key。
    const exportSnapshot = async () => {
        setCollecting(true);
        try {
            const text = await collectVRDiagnostics(characters, chatApi);
            setSnapshot(text);
            try {
                await navigator.clipboard.writeText(text);
                addToast?.('排障快照已複製，可以直接粘給開發者', 'success');
            } catch {
                // 剪貼板被瀏覽器擋住也不算失敗——下面把正文攤開，截圖一樣能用
                addToast?.('快照已生成（這台設備不讓自動複製，長按下面的文字選中即可）', 'info');
            }
        } catch (e: any) {
            addToast?.(`收集失敗: ${e?.message || e}`, 'error');
        } finally { setCollecting(false); }
    };

    // 日誌裡混著兩種行：真實的模型調用，和「調度動了但沒走到模型」的診斷行。
    // 對帳只該看前者，把診斷行算進分母會讓「成功幾次」失真。
    const calls = log.filter(l => !l.kind);
    const okCount = calls.filter(l => l.ok).length;

    return (
        <div className="space-y-3">
            <p className="text-[11px] text-indigo-300/60 leading-relaxed">
                彼方里的角色會自主、按間隔登入觸發模型調用，比較費 API。你可以在這裡給彼方<b className="text-indigo-200">單獨指定一份 API</b>（和「設置」裡保存的預設共用同一批），不設則跟隨聊天默認。
            </p>

            {/* 當前生效 */}
            <div className="rounded-2xl p-3.5" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="text-[10px] tracking-[0.2em] text-indigo-200/60 mb-1.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>當前生效</div>
                <div className="text-[12.5px] text-white/90 font-semibold">{effective?.model || '未配置'}</div>
                <div className="text-[10px] text-white/40 mt-0.5">{host(effective?.baseUrl)} · {follow ? '跟隨聊天默認' : '彼方獨立'}</div>
                <button onClick={test} disabled={testing} className="mt-2.5 text-[11px] px-3 py-1.5 rounded-full font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(120,180,255,.16)', color: '#bcd4ff', border: '1px solid rgba(140,180,255,.3)' }}>
                    {testing ? '測試中…' : '測試連接'}
                </button>
                {testResult && <div className={`mt-2 text-[10.5px] px-2.5 py-1.5 rounded-lg leading-snug ${testResult.startsWith('連接成功') ? 'text-emerald-300' : 'text-rose-300'}`} style={{ background: 'rgba(0,0,0,.25)' }}>{testResult}</div>}
            </div>

            {/* 選擇 API */}
            <div>
                <div className="text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5 px-0.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>選擇彼方 API</div>
                <button onClick={() => choose(null)}
                    className="w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left active:scale-[0.99] transition-transform"
                    style={{ background: follow ? 'rgba(120,180,255,.12)' : 'rgba(255,255,255,.04)', border: `1px solid ${follow ? 'rgba(140,180,255,.4)' : 'rgba(255,255,255,.07)'}` }}>
                    <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-white/90 font-semibold">跟隨聊天默認</div>
                        <div className="text-[10px] text-white/40 truncate">{chatApi?.model || '未配置'} · {host(chatApi?.baseUrl)}</div>
                    </div>
                    {follow && <span className="text-[10px] text-sky-300 font-bold shrink-0">✓ 使用中</span>}
                </button>
                {apiPresets.length === 0 ? (
                    <p className="text-[10.5px] text-white/35 px-1 py-1.5">「設置」裡還沒有保存的 API 預設。去設置裡保存幾個模型，這裡就能選。</p>
                ) : (() => {
                    const activePreset = apiPresets.find(p => sameAs(p.config));
                    const shown = presetsOpen ? apiPresets : (activePreset ? [activePreset] : []);
                    return (
                        <>
                            <button onClick={() => setPresetsOpen(o => !o)}
                                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 mb-1.5 text-left active:bg-white/5"
                                style={{ border: '1px solid rgba(255,255,255,.07)' }}>
                                <span className="text-[10.5px] text-white/55">保存的預設</span>
                                <span className="text-[9.5px] text-white/35 rounded-full px-1.5 leading-tight" style={{ background: 'rgba(255,255,255,.08)' }}>{apiPresets.length}</span>
                                {!presetsOpen && activePreset && <span className="text-[9.5px] text-sky-300/70 truncate">當前 · {activePreset.name}</span>}
                                <span className="ml-auto text-[10px] text-white/40">{presetsOpen ? '收起' : '展開'}</span>
                            </button>
                            {shown.map(p => {
                                const on = sameAs(p.config);
                                return (
                                    <button key={p.id} onClick={() => choose(p.config)}
                                        className="w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left active:scale-[0.99] transition-transform"
                                        style={{ background: on ? 'rgba(120,180,255,.12)' : 'rgba(255,255,255,.04)', border: `1px solid ${on ? 'rgba(140,180,255,.4)' : 'rgba(255,255,255,.07)'}` }}>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[12px] text-white/90 font-semibold truncate">{p.name}</div>
                                            <div className="text-[10px] text-white/40 truncate">{p.config.model} · {host(p.config.baseUrl)}</div>
                                        </div>
                                        {on && <span className="text-[10px] text-sky-300 font-bold shrink-0">✓ 使用中</span>}
                                    </button>
                                );
                            })}
                        </>
                    );
                })()}
            </div>

            {/* 調用記錄 */}
            <div className="rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-[10px] tracking-[0.2em] text-indigo-200/60" style={{ fontFamily: `'Noto Serif SC',serif` }}>調用記錄</span>
                    <span className="text-[9.5px] text-white/40 rounded-full px-1.5 leading-tight" style={{ background: 'rgba(255,255,255,.08)' }}>{calls.length}{calls.length ? ` · 成功${okCount}` : ''}</span>
                    {log.length > 0 && <button onClick={() => { void clearVRApiLog(); setLog([]); }} className="ml-auto text-[10px] text-white/40 hover:text-rose-300/80">清空</button>}
                </div>
                {log.length === 0 ? (
                    <p className="text-[10.5px] text-white/35 py-2 text-center">還沒有調用。角色每次登入彼方觸發的模型調用都會記在這裡，方便你對帳。</p>
                ) : (
                    <div className="space-y-1">
                        {log.slice(0, 60).map((l, i) => {
                            const diag = !!l.kind;   // 診斷行：調度到點了，但這一輪沒走到模型
                            return (
                                <div key={i} className="flex items-start gap-2 text-[10.5px] py-1 border-b border-white/5 last:border-0">
                                    <span className={`shrink-0 ${diag ? 'text-amber-400/70' : l.ok ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>{diag ? '◌' : l.ok ? '●' : '○'}</span>
                                    <span className="text-white/75 truncate shrink-0">{l.charName || l.charId?.slice(-4) || '—'}</span>
                                    {diag ? (
                                        <span className="flex-1 min-w-0 text-amber-200/55 leading-snug">{l.note}</span>
                                    ) : (
                                        <>
                                            <span className="text-indigo-300/40 shrink-0">{l.room ? getRoom(l.room as VRRoomId).name : ''}</span>
                                            {/* 接入明明是關的卻還是發了請求 —— 這就是「關不掉」的現場，標出來別讓它混在紅點裡 */}
                                            {l.charEnabled === false && <span className="text-rose-300/75 shrink-0">未接入卻發了</span>}
                                            <span className="ml-auto text-white/30 shrink-0 tabular-nums">{(l.ms / 1000).toFixed(1)}s</span>
                                        </>
                                    )}
                                    <span className="text-white/35 shrink-0 tabular-nums w-[68px] text-right">{new Date(l.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 排障快照 */}
            <div className="rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] tracking-[0.2em] text-indigo-200/60" style={{ fontFamily: `'Noto Serif SC',serif` }}>排障快照</span>
                    {snapshot && <button onClick={() => setSnapshot(null)} className="ml-auto text-[10px] text-white/40 hover:text-rose-300/80">收起</button>}
                </div>
                <p className="text-[10.5px] text-white/40 leading-relaxed mb-2">
                    角色明明沒接入卻還在調用、或者設置改完過一陣又退回去 —— 遇到這類說不清的情況，點一下把當前狀態收成一段文字發給開發者。
                    裡面只有開關、時間和用量，<b className="text-indigo-200/70">不含角色名字、聊天記錄和 API key</b>。
                </p>
                <button onClick={exportSnapshot} disabled={collecting}
                    className="text-[11px] px-3 py-1.5 rounded-full font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(120,180,255,.16)', color: '#bcd4ff', border: '1px solid rgba(140,180,255,.3)' }}>
                    {collecting ? '收集中…' : '生成並複製'}
                </button>
                {snapshot && (
                    <pre className="mt-2.5 max-h-64 overflow-auto text-[9.5px] leading-relaxed text-white/55 whitespace-pre-wrap break-all select-all p-2 rounded-lg"
                        style={{ background: 'rgba(0,0,0,.3)' }}>{snapshot}</pre>
                )}
            </div>
        </div>
    );
};

// ============ 動畫關鍵幀 ============
const VRStyleTag: React.FC = () => (
    <style>{`
        @keyframes vrfloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes vrwave { from { transform: scaleY(0.5); } to { transform: scaleY(1.05); } }
        @keyframes vrdance { 0%{transform:translateY(0) rotate(-5deg)} 25%{transform:translateY(-9px) rotate(3deg)} 50%{transform:translateY(0) rotate(5deg)} 75%{transform:translateY(-9px) rotate(-3deg)} 100%{transform:translateY(0) rotate(-5deg)} }
        @keyframes vraurora { 0%,100%{transform:translate(0,0) scale(1);opacity:.75} 50%{transform:translate(6%,4%) scale(1.14);opacity:1} }
        @keyframes vrtwinkle { 0%,100%{opacity:.5} 50%{opacity:.85} }
        @keyframes sarquest { 0%,100%{transform:translate(-50%,0)} 50%{transform:translate(-50%,-6px)} }
        /* 信號墜落處 · 電子衛星軌道（純 transform/opacity，GPU 合成，手機友好） */
        @keyframes sigorbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes sigpulse { 0%,100% { transform: scale(1); opacity: .8; } 50% { transform: scale(1.12); opacity: 1; } }
        @keyframes sigblink { 0%,88%,100% { opacity: 0; } 90%,96% { opacity: 1; } }
    `}</style>
);

export default VRWorldApp;
