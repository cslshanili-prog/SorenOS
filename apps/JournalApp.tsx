import { loadCharacterContextMessages } from '../utils/chatContextRange';

import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, DiaryEntry, StickerData, DiaryPage, MemoryFragment, type JournalAppearance } from '../types';
import { ContextBuilder } from '../utils/context';
import { processImage } from '../utils/file';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import { isImageValue } from '../utils/blobRef';
import { safeResponseJson, extractJson } from '../utils/safeApi';
import { normalizeMessageContent } from '../utils/messageFormat';
import { injectMemoryPalace, ingestDiaryToPalace, type DiaryIngestResult } from '../utils/memoryPalace/pipeline';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { Sparkle, Archive } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';
import JournalAppearanceButton, { JournalAppearanceStyle } from '../components/journal/JournalAppearanceEditor';
import JournalThemeArtwork from '../components/journal/JournalThemeArtwork';

const INTRO_SEEN_KEY = 'journal_app_intro_seen_v4';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

// --- Assets & Constants ---

const PAPER_STYLES = [
    { id: 'plain', name: '白紙', css: 'bg-white', text: 'text-slate-700' },
    { id: 'grid', name: '網格', css: 'bg-white', text: 'text-slate-700', style: { backgroundImage: 'linear-gradient(#e5e7eb 1px, transparent 1px), linear-gradient(90deg, #e5e7eb 1px, transparent 1px)', backgroundSize: '20px 20px' } },
    { id: 'dot', name: '點陣', css: 'bg-[#fffdf5]', text: 'text-slate-700', style: { backgroundImage: 'radial-gradient(#d1d5db 1px, transparent 1px)', backgroundSize: '20px 20px' } },
    { id: 'lined', name: '橫線', css: 'bg-[#fefce8]', text: 'text-slate-700', style: { backgroundImage: 'repeating-linear-gradient(transparent, transparent 23px, #e5e7eb 23px, #e5e7eb 24px)' } },
    { id: 'dark', name: '夜空', css: 'bg-slate-800', text: 'text-white/90' },
    { id: 'pink', name: '少女', css: 'bg-pink-50', text: 'text-slate-700', style: { backgroundImage: 'radial-gradient(#fbcfe8 2px, transparent 2px)', backgroundSize: '30px 30px' } },
];

const DEFAULT_STICKERS = [
    twemojiUrl('2728'), twemojiUrl('1f496'), twemojiUrl('1f338'), twemojiUrl('1f380'), twemojiUrl('1f370'),
    twemojiUrl('1f431'), twemojiUrl('1f436'), twemojiUrl('2601-fe0f'), twemojiUrl('1f319'), twemojiUrl('2b50'),
    twemojiUrl('1f3b5'), twemojiUrl('1f33f'), twemojiUrl('1f353'), twemojiUrl('1f9f8'), twemojiUrl('1f388'),
    twemojiUrl('1f48c'), twemojiUrl('1f4a4'), twemojiUrl('1f97a'), twemojiUrl('1f621'), twemojiUrl('1f62d'),
];

// 兜底：extractJson 都救不回來時，內容可能是「模型沒按 JSON 寫的散文」，也可能是
// 「破損到修不了的 JSON」。前者直接當正文用；後者不能把 { "text": "..." } 整段露出來。
// 這裡做最後一層打撈：若內容像個帶 text 字段的 JSON 對象，正則摳出 text 值並還原轉義；
// 否則原樣返回。
const salvageDiaryText = (raw: string): string => {
    const s = (raw || '').trim();
    if (!s.startsWith('{') || !/"text"\s*:/.test(s)) return s;
    const m = s.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!m) return s;
    try {
        // 用 JSON.parse 還原 \n \" \\ 等轉義，失敗就手動替換常見轉義
        return JSON.parse(`"${m[1]}"`);
    } catch {
        return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
};

// HELPER: Get local date string YYYY-MM-DD
const getLocalDateStr = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const JournalApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, apiConfig, addToast, userProfile, updateCharacter, memoryPalaceConfig, characterGroups, theme } = useOS();
    // 預覽草稿只活在當前 JournalApp 會話裡，不寫 theme/localStorage。狀態放在
    // App 頂層，才能在選擇頁、列表頁與書寫頁之間切換時繼續預覽同一套 CSS。
    const [previewJournalAppearance, setPreviewJournalAppearance] = useState<JournalAppearance | undefined>();
    const effectiveJournalAppearance = previewJournalAppearance || theme.journalAppearance;
    // 原本琥珀嚴格保留舊的單頁結構；其它主題擁有各自的實體 / 設備版式。
    const effectiveJournalPreset = effectiveJournalAppearance?.preset || 'original';
    const journalUsesScrapbookLayout = effectiveJournalPreset !== 'original';
    const journalLayoutClass = journalUsesScrapbookLayout
        ? ` sully-journal-designed sully-journal-theme-${effectiveJournalPreset}`
        : '';
    const journalAppearanceButtonProps = {
        previewAppearance: previewJournalAppearance,
        isPreviewing: Boolean(previewJournalAppearance),
        onStartPreview: setPreviewJournalAppearance,
        onCancelPreview: () => setPreviewJournalAppearance(undefined),
    };

    const [mode, setMode] = useState<'select' | 'calendar' | 'write'>('select');
    const [selectedChar, setSelectedChar] = useState<CharacterProfile | null>(null);
    const [journalGroupId, setJournalGroupId] = useState<string>(GROUP_FILTER_ALL); // 選日記本頁的分組篩選
    const [diaries, setDiaries] = useState<DiaryEntry[]>([]);
    const [currentEntry, setCurrentEntry] = useState<DiaryEntry | null>(null);
    const [selectedDate, setSelectedDate] = useState<string>(getLocalDateStr());

    // Onboarding popup (一次性)
    const [showIntro, setShowIntro] = useState<boolean>(() => {
        try { return !localStorage.getItem(INTRO_SEEN_KEY); } catch { return false; }
    });
    const dismissIntro = () => {
        try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch {}
        setShowIntro(false);
    };

    // Editor State
    const [isThinking, setIsThinking] = useState(false);
    const [archivingId, setArchivingId] = useState<string | null>(null);
    const [archiveResult, setArchiveResult] = useState<{
        date: string;
        charName: string;
        summary: string;
        summaryOrigin: 'palace_bullets' | 'prose_fallback';
        palace: DiaryIngestResult | null;
    } | null>(null);
    const [showStickerPanel, setShowStickerPanel] = useState(false);
    const [activeTab, setActiveTab] = useState<'user' | 'char'>('user'); // View Tab
    const [hideCharStickers, setHideCharStickers] = useState(false); // Toggle to hide char stickers
    
    // Sticker Interaction State
    const [draggingSticker, setDraggingSticker] = useState<string | null>(null);
    const [selectedStickerId, setSelectedStickerId] = useState<string | null>(null); // For resizing/deleting
    const [resizingSticker, setResizingSticker] = useState<string | null>(null);
    const paperRef = useRef<HTMLDivElement>(null);
    
    // Custom Stickers State (Separate from Chat Emojis)
    const [customStickers, setCustomStickers] = useState<{name: string, url: string}[]>([]);
    const [showImportModal, setShowImportModal] = useState(false);
    const [importText, setImportText] = useState('');
    const [deletingSticker, setDeletingSticker] = useState<{name: string, url: string} | null>(null);
    const [deletingDiary, setDeletingDiary] = useState<DiaryEntry | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // --- Data Loading ---

    useEffect(() => {
        if (characters.length > 0 && activeCharacterId) {
            const initial = characters.find(c => c.id === activeCharacterId);
            if (initial) {
                setSelectedChar(initial);
                setMode('calendar');
                loadDiaries(initial.id);
            }
        }
        // Load custom stickers from new journal store
        DB.getJournalStickers().then(setCustomStickers);
    }, [activeCharacterId]);

    const loadDiaries = async (charId: string) => {
        const list = await DB.getDiariesByCharId(charId);
        setDiaries(list.sort((a, b) => b.date.localeCompare(a.date)));
    };

    const handleCharSelect = (char: CharacterProfile) => {
        setSelectedChar(char);
        setMode('calendar');
        loadDiaries(char.id);
    };

    const openEntry = (date: string) => {
        const existing = diaries.find(d => d.date === date);
        if (existing) {
            setCurrentEntry(existing);
            // Default to char tab if they replied
            setActiveTab(existing.charPage ? 'char' : 'user');
        } else {
            // New Entry — 打 autoSync=true, 後續不在列表裡顯示手動歸檔按鈕
            setCurrentEntry({
                id: `diary-${Date.now()}`,
                charId: selectedChar!.id,
                date: date,
                userPage: { text: '', paperStyle: 'grid', stickers: [] },
                timestamp: Date.now(),
                isArchived: false,
                autoSync: true,
            });
            setActiveTab('user');
        }
        setMode('write');
        setSelectedDate(date);
        setSelectedStickerId(null); // Reset selection
        trackEvent('进入日记书写页');
    };

    // --- Editor Logic ---

    const updatePage = (updates: Partial<DiaryEntry['userPage']>, side: 'user' | 'char' = 'user') => {
        if (!currentEntry) return;
        const targetPage = side === 'user' ? 'userPage' : 'charPage';
        
        // If char page doesn't exist yet, init it
        let pageData = currentEntry[targetPage] || { text: '', paperStyle: 'plain', stickers: [] };
        
        setCurrentEntry(prev => {
            if (!prev) return null;
            return {
                ...prev,
                [targetPage]: { ...pageData, ...updates }
            };
        });
    };

    const addSticker = (url: string) => {
        const side = activeTab;
        const targetPage = side === 'user' ? currentEntry?.userPage : currentEntry?.charPage;
        if (!targetPage && side === 'char') return;

        const newSticker: StickerData = {
            id: `st-${Date.now()}-${Math.random()}`,
            url,
            x: 50,
            y: 50,
            rotation: (Math.random() - 0.5) * 40,
            scale: 1.0 // Default scale
        };
        
        const currentStickers = targetPage?.stickers || [];
        updatePage({ stickers: [...currentStickers, newSticker] }, side);
        setShowStickerPanel(false);
        trackEvent('往日记页贴一张贴纸', { kind: DEFAULT_STICKERS.includes(url) ? 'default' : 'custom' });
    };

    const handleImportStickers = async () => {
        if (!importText.trim()) return;
        const lines = importText.split('\n');
        let count = 0;
        for (const line of lines) {
            const parts = line.split('--');
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const url = parts.slice(1).join('--').trim();
                if (name && url) {
                    await DB.saveJournalSticker(name, url); // Changed Store
                    count++;
                }
            }
        }
        setCustomStickers(await DB.getJournalStickers()); // Changed Store
        setImportText('');
        setShowImportModal(false);
        addToast(`成功添加 ${count} 個貼紙`, 'success');
        trackEvent('导入自定义贴纸');
    };

    const handleDeleteStickerAsset = async () => {
        if (deletingSticker) {
            await DB.deleteJournalSticker(deletingSticker.name); // Changed Store
            setCustomStickers(prev => prev.filter(s => s.name !== deletingSticker.name));
            setDeletingSticker(null);
            addToast('貼紙已刪除', 'success');
            trackEvent('删除一个自定义贴纸');
        }
    };

    // 把一條 diary 序列化成 score_card payload（含紙張樣式名等卡片顯示需要的字段）
    const buildDiaryCardPayload = (entry: DiaryEntry, char: CharacterProfile) => {
        const userPaperName = PAPER_STYLES.find(p => p.id === entry.userPage.paperStyle)?.name || '白紙';
        const charPaperName = entry.charPage
            ? (PAPER_STYLES.find(p => p.id === entry.charPage!.paperStyle)?.name || '白紙')
            : '';
        return {
            type: 'diary_card',
            date: entry.date,
            charName: char.name,
            charAvatar: char.avatar || '',
            userName: userProfile.name,
            userText: entry.userPage.text,
            charText: entry.charPage?.text || '',
            userPaperStyle: entry.userPage.paperStyle,
            userPaperName,
            charPaperStyle: entry.charPage?.paperStyle || '',
            charPaperName,
            userStickerCount: entry.userPage.stickers?.length || 0,
            charStickerCount: entry.charPage?.stickers?.length || 0,
        };
    };

    // 把一條已有 charPage 的日記同步到聊天裡（新建或更新 score_card）。
    // 沒有 charPage → 不做任何事（單方面寫的日記不進上下文，這是產品規則）。
    // 返回最終帶 chatCardMessageId 的 entry，供調用方接著 setCurrentEntry/saveDiary。
    const syncDiaryCardToChat = async (entry: DiaryEntry, char: CharacterProfile): Promise<DiaryEntry> => {
        if (!entry.charPage) return entry;
        const cardData = buildDiaryCardPayload(entry, char);

        if (entry.chatCardMessageId) {
            try {
                await DB.updateMessage(entry.chatCardMessageId, JSON.stringify(cardData));
                await DB.updateMessageMetadata(entry.chatCardMessageId, prev => ({
                    ...(prev || {}),
                    scoreCard: cardData,
                    source: 'journal-exchange',
                }));
                return entry;
            } catch (e) {
                console.warn('🗒 [Journal] 已存在的卡片更新失敗, 重新創建:', e);
            }
        }
        const newId = await DB.saveMessage({
            charId: char.id,
            role: 'system',
            type: 'score_card',
            content: JSON.stringify(cardData),
            metadata: { scoreCard: cardData, source: 'journal-exchange' },
        });
        return { ...entry, chatCardMessageId: newId };
    };

    const saveEntry = async (options: { silent?: boolean } = {}) => {
        if (!currentEntry || !selectedChar) return;
        // 若該日記已經在聊天裡有卡片（char 回覆過 + 自動發送過），保存時同步更新卡片
        let toSave = currentEntry;
        if (currentEntry.chatCardMessageId && currentEntry.charPage) {
            toSave = await syncDiaryCardToChat(currentEntry, selectedChar);
        }
        await DB.saveDiary(toSave);
        if (toSave !== currentEntry) setCurrentEntry(toSave);
        await loadDiaries(toSave.charId);
        if (!options.silent) addToast('日記已保存', 'success');
    };

    const handleDeleteDiary = async () => {
        if (!deletingDiary || !selectedChar) return;
        // 同步刪除聊天裡的卡片（如果之前發過）
        if (deletingDiary.chatCardMessageId) {
            try { await DB.deleteMessage(deletingDiary.chatCardMessageId); }
            catch (e) { console.warn('🗒 [Journal] 卡片刪除失敗 (可能已不存在):', e); }
        }
        await DB.deleteDiary(deletingDiary.id);
        await loadDiaries(selectedChar.id);
        setDeletingDiary(null);
        addToast('日記已刪除', 'success');
        trackEvent('删除一篇日记');
    };

    // --- Interaction Logic (Move, Resize, Delete) ---

    // 1. Selection
    const selectSticker = (e: React.MouseEvent | React.TouchEvent, id: string) => {
        e.stopPropagation();
        setSelectedStickerId(id);
    };

    // 2. Remove Sticker from Page
    const removeStickerFromPage = (id: string) => {
        const targetPage = activeTab === 'user' ? currentEntry?.userPage : currentEntry?.charPage;
        if (!targetPage) return;
        const updated = targetPage.stickers.filter(s => s.id !== id);
        updatePage({ stickers: updated }, activeTab);
        setSelectedStickerId(null);
        trackEvent('从日记页撕掉一张贴纸');
    };

    // 3. Pointer Handlers (Move & Resize)
    const handlePointerDown = (e: React.PointerEvent, stickerId: string, action: 'move' | 'resize') => {
        // Allow editing on char page too now
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        
        if (action === 'move') {
            setDraggingSticker(stickerId);
            setSelectedStickerId(stickerId); // Select on drag start
        } else {
            setResizingSticker(stickerId);
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if ((!draggingSticker && !resizingSticker) || !paperRef.current || !currentEntry) return;

        const rect = paperRef.current.getBoundingClientRect();
        
        const targetPage = activeTab === 'user' ? currentEntry.userPage : currentEntry.charPage;
        if (!targetPage) return;

        // Logic for Moving
        if (draggingSticker) {
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            const clampedX = Math.max(0, Math.min(100, x));
            const clampedY = Math.max(0, Math.min(100, y));

            const updatedStickers = targetPage.stickers.map(s => 
                s.id === draggingSticker ? { ...s, x: clampedX, y: clampedY } : s
            );
            updatePage({ stickers: updatedStickers }, activeTab);
        }

        // Logic for Resizing
        if (resizingSticker) {
            const sticker = targetPage.stickers.find(s => s.id === resizingSticker);
            if (!sticker) return;

            // Simple scale logic based on distance from center of sticker (simulated by pointer position relative to paper)
            const dx = (e.clientX - rect.left) - (sticker.x / 100 * rect.width);
            const dy = (e.clientY - rect.top) - (sticker.y / 100 * rect.height);
            const dist = Math.sqrt(dx*dx + dy*dy);
            
            // Assume 50px is scale 1
            const newScale = Math.max(0.2, Math.min(3.0, dist / 40));
            
            const updatedStickers = targetPage.stickers.map(s => 
                s.id === resizingSticker ? { ...s, scale: newScale } : s
            );
            updatePage({ stickers: updatedStickers }, activeTab);
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        setDraggingSticker(null);
        setResizingSticker(null);
        e.currentTarget.releasePointerCapture(e.pointerId);
    };

    const handleBackgroundClick = () => {
        setSelectedStickerId(null); // Deselect when clicking background
    };

    // Long press handler for drawer items
    const handleDrawerTouchStart = (s: {name: string, url: string}) => {
        longPressTimer.current = setTimeout(() => {
            setDeletingSticker(s);
        }, 600);
    };

    const handleDrawerTouchEnd = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };

    // --- AI Interaction ---

    const handleExchange = async () => {
        if (!currentEntry || !selectedChar || !apiConfig.apiKey) {
            addToast('配置錯誤或內容為空', 'error');
            return;
        }
        if (!currentEntry.userPage.text.trim()) {
            addToast('請先寫下今天的日記', 'info');
            return;
        }

        const isRewrite = Boolean(currentEntry.charPage);
        setIsThinking(true);
        addToast(isRewrite ? `正在請 ${selectedChar.name} 重新寫這篇日記…` : `正在請 ${selectedChar.name} 寫交換日記…`, 'info');
        trackEvent(isRewrite ? '重新生成角色日记' : '邀请角色交换日记');

        try {
            // 生成前仍要把用戶頁草稿落庫，但這是重寫流程的內部步驟，不能冒充用戶
            // 主動點了“保存”。舊代碼在這裡直接 saveEntry()，於是循環按鈕先彈“日記已保存”。
            await saveEntry({ silent: true });
            await injectMemoryPalace(selectedChar, undefined, currentEntry.userPage.text);
            let systemPrompt = ContextBuilder.buildCoreContext(selectedChar, userProfile);

            const styleOptions = PAPER_STYLES.map(p => p.id).join(', ');
            const defaultStickers = DEFAULT_STICKERS.join(' ');
            const customStickerContext = customStickers.length > 0 
                ? `Custom Stickers (Name: URL): \n${customStickers.map(s => `- ${s.name}: ${s.url}`).join('\n')}`
                : '';

            const recentMsgs = await loadCharacterContextMessages(selectedChar);
            // 用統一的 normalizeMessageContent 把消息轉成可讀文本，絕不能直接塞 m.content：
            // score_card（含上一次交換日記同步進來的卡片）的 content 是整段 JSON，裡面帶
            // charAvatar 的 base64 data URL + 雙方日記全文。重新生成時這張卡已在歷史裡，
            // 直接 dump 原始 content 會把 base64 頭像和 JSON 結構整個灌進 prompt，
            // 造成 token 異常膨脹。normalize 後日記卡會被壓成一行摘要，不再洩漏 base64/JSON。
            const recentContext = recentMsgs.map(m => {
                const content = normalizeMessageContent(m, selectedChar.name, userProfile.name);
                return `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.role === 'user' ? 'User' : 'You'}: ${content}`;
            }).join('\n');

            systemPrompt += `### [Exchange Diary Mode Instructions]
你正在和用戶進行【交換日記】互動。

### 關鍵：最近發生的互動 (Recent Context)
這是你們最近在聊天軟件或見面時的對話記錄。請**務必**閱讀這些記錄，並在日記中提及今天發生的具體事情（例如聊過的話題、去過的地方、用戶發過的圖片）。
不要只寫空泛的回覆，還要說一些用戶不知道的，你自己沒有說過的想法，和你自己獨立於用戶經歷過的今天的事情。
[RECENT LOGS START]
${recentContext}
[RECENT LOGS END]

### 任務
1. 閱讀用戶今天的日記 (${currentEntry.date})。
2. 以你的角色口吻寫一篇**回覆日記**。
   - 首先結合上文的聊天記錄，回應用戶的內容。
   - 最重要的是分享你的生活，此條為必須項**務必說至少一件用戶不知道的，你今天做的事情，儘量與用戶無關！用戶希望看到角色完全獨立的一面**。
   - 語言風格在符合設定的基礎上，應該更加書面化和詩意，不過一切以角色性格優先。
3. 選擇適合你心情的信紙和貼紙。

### 關於貼紙 (Stickers)
你可以使用默認的 Emoji，也可以使用【Custom Stickers】。
${customStickerContext}
如果要使用 Custom Sticker，請將 URL 直接放入返回的 stickers 數組中。

### 輸出格式 (必須是純 JSON)
- 只輸出這個 JSON 對象本身，前後不要有任何多餘文字。
- text 是一個 JSON 字符串：內部的換行必須寫成 \\n，引號必須寫成 \\"，反斜槓必須寫成 \\\\。**絕對不要**在字符串裡直接放真實換行或未轉義的引號，否則會解析失敗。
Structure:
{
  "text": "日記正文第一段\\n\\n第二段...",
  "paperStyle": "one of: ${styleOptions}",
  "stickers": ["sticker1", "http://custom-sticker-url..."] (從默認列表或 Custom Stickers 中選0-3個)
}`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `Users Diary:\n${currentEntry.userPage.text}` }
                    ],
                    temperature: 0.85
                })
            });

            if (!response.ok) throw new Error('API Error');
            const data = await safeResponseJson(response);
            let content = data.choices[0].message.content.trim();
            content = content.replace(/```json/g, '').replace(/```/g, '').trim();
            
            // Claude 常返回未轉義特殊字符（引號 / 反斜槓 / 換行）的 JSON，裸 JSON.parse 會炸。
            // 舊代碼一炸就把整段原始 JSON（{ "text": ... } 帶字面量 \n）直接塞進日記正文，
            // 這就是「交換日記掉格式」的現象。先走 extractJson 的多層容錯；連它都解析不出來
            // （模型壓根沒按 JSON 寫、直接寫了散文）才把內容當純文本兜底，兜底時再剝一層
            // 可能殘留的 JSON 外殼，保證任何情況下都不會把 { "text": ... } 露給用戶。
            let parsed: any = extractJson(content);
            if (!parsed || typeof parsed.text !== 'string') {
                parsed = { text: salvageDiaryText(content), paperStyle: 'plain', stickers: [] };
            }

            const charStickers: StickerData[] = (parsed.stickers || []).map((s: string) => ({
                id: `st-${Math.random()}`,
                url: s,
                x: Math.random() * 70 + 10,
                y: Math.random() * 70 + 10,
                rotation: (Math.random() - 0.5) * 40,
                scale: 1.0
            }));

            const charPage: DiaryPage = {
                text: parsed.text || '',
                paperStyle: PAPER_STYLES.find(p => p.id === parsed.paperStyle)?.id || 'plain',
                stickers: charStickers
            };

            const updatedEntry = { ...currentEntry, charPage };
            // 自動發送 / 同步到聊天：char 有回覆 → 卡片落地到對應角色的聊天歷史。
            // 重交換（同一日記重新讓 char 寫回復）會複用已有 chatCardMessageId 走更新而不是再創建一條。
            const synced = await syncDiaryCardToChat(updatedEntry, selectedChar);
            setCurrentEntry(synced);
            await DB.saveDiary(synced);
            await loadDiaries(selectedChar.id);
            setActiveTab('char');
            addToast(isRewrite ? '角色日記已重新寫好 · 已同步到聊天' : '對方已回覆 · 已同步到聊天', 'success');

        } catch (e: any) {
            addToast(`${isRewrite ? '重新寫日記' : '交換日記'}失敗: ${e.message}`, 'error');
        } finally {
            setIsThinking(false);
        }
    };

    // 手動歸檔: 把一條日記總結成神經鏈接條目 (char.memories), 跟 chatapp 的自動歸檔對齊 —
    //   - 開了記憶宮殿: 走副 API extractMemoriesFromBuffer 一次提取多條 MemoryNode → 節點入宮,
    //     同一組節點 bullets 化拼成 MemoryFragment 寫 char.memories (mood='diary_palace')。
    //     不再調主 API。神經鏈接裡那條 bullets 跟宮殿節點嚴格一比一對應。
    //   - 沒開記憶宮殿 / 副 API 缺失 / 副 API 沒提取出: 回落主 API + 升級 prompt 出 150~300 字
    //     散文式總結 → 寫 char.memories (mood='diary')。這條沿用老路徑升級版。
    //
    // mood 用 'diary_palace' / 'diary' 跟 chatapp 自動歸檔的 'palace' 區分,
    // 避免被 mergePalaceFragmentsIntoMemories 誤合併到當天聊天那條 palace bullets 裡。
    // 召回鏈路不看 mood,只是元數據 / UI 徽章,所以兩種 mood 都正常進 chat 上下文。
    const handleArchiveDiary = async (diary: DiaryEntry) => {
        if (!selectedChar || diary.isArchived) return;
        if (!apiConfig.apiKey) { addToast('請先配置主 API', 'error'); return; }
        if (!diary.userPage.text.trim() && !diary.charPage?.text?.trim()) {
            addToast('日記內容為空,無法歸檔', 'info');
            return;
        }

        setArchivingId(diary.id);
        trackEvent('归档日记进神经链接');

        // 主 API 散文式總結 — 當宮殿沒開 / 副 API 缺失 / 提取為空時的 fallback
        const generateProseSummary = async (): Promise<string> => {
            const baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile);
            const charPart = diary.charPage?.text?.trim() || '(對方沒有回覆)';
            const prompt = `${baseContext}

### [系統指令: 交換日記歸檔]
當前任務: 把這篇【交換日記】(日期 ${diary.date}) 總結成一段對你 (${selectedChar.name}) 長期有效的記憶。

### 輸入內容
${userProfile.name} 的那頁:
"""
${diary.userPage.text || '(空白頁)'}
"""

你 (${selectedChar.name}) 的回覆頁:
"""
${charPart}
"""

### 輸出要求
1. **第一人稱**: 全程用"我"稱呼自己,用"${userProfile.name}"稱呼對方,不要寫成第三視角敘述。
2. **要點齊全**: 至少覆蓋以下信息 (有就寫,沒有就跳過,不要生造):
   - ${userProfile.name} 那天的關鍵事件 / 心情 / 提到的人或物
   - 我對這些內容的反應、共鳴、或心裡沒說出口的想法
   - 我在自己那頁裡分享的、屬於我自己的事
   - 如果出現任何承諾、約定、未解決的疑問,都要點名記錄下來 (這些以後可能要兌現)
3. **細節勝過抽象**: 多說具體的事 (人名、地點、物件、當時的情緒),少用"我們度過了美好的一天"這種空話。
4. **篇幅**: 150~300 字之間的一段中文敘述,不要分段,不要列表,不要任何前綴和標題,直接出敘述。
`;
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.4,
                    max_tokens: 1200,
                }),
            });
            if (!response.ok) throw new Error(`主 API 失敗 (${response.status})`);
            const data = await safeResponseJson(response);
            let s = (data.choices?.[0]?.message?.content || '').trim();
            s = s.replace(/^["'「『]|["'」』]$/g, '').trim();
            if (!s) throw new Error('歸檔總結為空');
            return s;
        };

        try {
            // 1. 如果開了宮殿,先走副 API 一次提取,成敗決定神經鏈接走哪條路徑
            let palaceResult: DiaryIngestResult | null = null;
            if (selectedChar.memoryPalaceEnabled) {
                try {
                    palaceResult = await ingestDiaryToPalace(
                        selectedChar,
                        diary.date,
                        diary.userPage.text,
                        diary.charPage?.text || '',
                        memoryPalaceConfig?.lightLLM as any,
                        userProfile.name,
                    );
                } catch (e: any) {
                    console.warn('🏰 [Journal] 入宮失敗:', e);
                    palaceResult = null;
                }
            } else {
                palaceResult = { status: 'palace_disabled' };
            }

            // 2. 決定神經鏈接那條的 summary / mood
            //    宮殿成功 (status==='done' 且 nodes 非空) → bullets 化, mood='diary_palace'
            //    其它一切情況 → 主 API 散文 fallback, mood='diary'
            let summary: string;
            let mood: string;
            let summaryOrigin: 'palace_bullets' | 'prose_fallback';
            if (palaceResult && palaceResult.status === 'done' && palaceResult.nodes.length > 0) {
                summary = palaceResult.nodes
                    .map(n => `- ${(n.content || '').replace(/\n/g, ' ').trim()}`)
                    .filter(line => line.length > 2)
                    .join('\n');
                mood = 'diary_palace';
                summaryOrigin = 'palace_bullets';
            } else {
                summary = await generateProseSummary();
                mood = 'diary';
                summaryOrigin = 'prose_fallback';
            }

            // 3. 神經鏈接 (char.memories): date 對齊到日記當天
            const newMem: MemoryFragment = {
                id: `mem-diary-${Date.now()}`,
                date: diary.date,
                summary,
                mood,
            };
            updateCharacter(selectedChar.id, {
                memories: [...(selectedChar.memories || []), newMem],
            });

            // 4. 標記 isArchived 防止重複
            const updatedDiary: DiaryEntry = { ...diary, isArchived: true };
            await DB.saveDiary(updatedDiary);
            if (currentEntry?.id === diary.id) setCurrentEntry(updatedDiary);
            await loadDiaries(selectedChar.id);

            // 5. 彈窗展示歸檔全貌
            setArchiveResult({
                date: diary.date,
                charName: selectedChar.name,
                summary,
                summaryOrigin,
                palace: palaceResult,
            });
        } catch (e: any) {
            console.error(e);
            addToast(`歸檔失敗: ${e.message}`, 'error');
        } finally {
            setArchivingId(null);
        }
    };

    // --- Renderers ---

    const renderPage = (page: DiaryPage, side: 'user' | 'char') => {
        const style = PAPER_STYLES.find(s => s.id === page.paperStyle) || PAPER_STYLES[0];
        const isInteractive = true; // Always interactive now for editing

        return (
            <div 
                ref={side === activeTab ? paperRef : undefined}
                className={`sully-journal-paper sully-journal-paper-${side} relative w-full h-full shadow-md transition-all duration-300 overflow-hidden ${style.css} flex flex-col rounded-3xl touch-none`}
                style={{ ...style.style }}
                onPointerMove={isInteractive && side === activeTab ? handlePointerMove : undefined}
                onPointerUp={isInteractive && side === activeTab ? handlePointerUp : undefined}
                onPointerLeave={isInteractive && side === activeTab ? handlePointerUp : undefined}
                onClick={handleBackgroundClick}
            >
                {/* Content Container */}
                <div className="sully-journal-page-content flex-1 p-6 relative z-10 flex flex-col">
                    <div className="sully-journal-page-meta flex justify-between items-center mb-4 pb-2 border-b border-black/5 shrink-0">
                        <span className={`sully-journal-page-title text-xs font-bold uppercase tracking-widest opacity-50 ${style.text}`}>
                            {side === 'user' ? 'MY DIARY' : 'REPLY'}
                        </span>
                        <span className={`sully-journal-page-date text-[10px] opacity-40 font-mono ${style.text}`}>
                            {currentEntry?.date}
                        </span>
                    </div>

                    <textarea 
                        value={page.text}
                        onChange={e => updatePage({ text: e.target.value }, side)}
                        placeholder={side === 'user' ? "記錄今天發生的事情..." : "等待回覆..."}
                        className={`sully-journal-textarea flex-1 w-full bg-transparent resize-none outline-none leading-loose text-[16px] font-normal ${style.text} placeholder:opacity-30 no-scrollbar`}
                        readOnly={isThinking} 
                    />
                </div>

                {/* Stickers Layer */}
                {/* Check Hide Flag for Char Side */}
                {!(side === 'char' && hideCharStickers) && page.stickers.map(s => {
                    const isSelected = selectedStickerId === s.id;
                    const scale = s.scale || 1.0;
                    
                    return (
                        <div 
                            key={s.id} 
                            onPointerDown={(e) => handlePointerDown(e, s.id, 'move')}
                            onClick={(e) => selectSticker(e, s.id)}
                            className={`sully-journal-sticker absolute text-6xl select-none drop-shadow-md z-20 cursor-move ${draggingSticker === s.id ? 'opacity-90' : ''} transition-transform`}
                            style={{ 
                                left: `${s.x}%`, 
                                top: `${s.y}%`, 
                                transform: `translate(-50%, -50%) rotate(${s.rotation}deg) scale(${scale})`,
                                border: isSelected ? '2px dashed #3b82f6' : 'none',
                                borderRadius: '8px',
                                padding: '4px'
                            }}
                        >
                            {isImageValue(s.url) ? (
                                <TokenImg value={s.url} className="w-20 h-20 object-contain pointer-events-none" draggable={false} />
                            ) : s.url}

                            {/* Controls for Selected Sticker */}
                            {isSelected && (
                                <>
                                    {/* Delete Button (Top Right) */}
                                    <div 
                                        className="absolute -top-3 -right-3 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-xs shadow-md cursor-pointer pointer-events-auto"
                                        onClick={(e) => { e.stopPropagation(); removeStickerFromPage(s.id); }}
                                    >×</div>
                                    
                                    {/* Resize Handle (Bottom Right) */}
                                    <div 
                                        className="absolute -bottom-2 -right-2 w-5 h-5 bg-blue-500 rounded-full border-2 border-white shadow-md cursor-nwse-resize pointer-events-auto"
                                        onPointerDown={(e) => handlePointerDown(e, s.id, 'resize')}
                                    ></div>
                                </>
                            )}
                        </div>
                    );
                })}
                
                {/* Paper Texture Overlay (Subtle) */}
                <div className="sully-journal-texture absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/paper-fibers.png')] opacity-10 pointer-events-none z-0 mix-blend-multiply"></div>
            </div>
        );
    };

    const renderEmptyCharPage = () => (
        <div className="sully-journal-empty w-full h-full bg-[#252525] rounded-3xl border border-white/5 flex flex-col items-center justify-center text-white/40 gap-4 p-8 text-center">
            <div className="opacity-20 animate-pulse"><img src={twemojiUrl('1f48c')} alt="letter" className="w-12 h-12" /></div>
            {isThinking ? (
                <div className="space-y-2">
                    <p className="text-sm font-medium text-amber-500">對方正在閱讀你的日記...</p>
                    <div className="flex justify-center gap-1">
                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce"></div>
                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce delay-100"></div>
                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce delay-200"></div>
                    </div>
                </div>
            ) : (
                <>
                    <p className="text-sm">寫完日記後，點擊下方按鈕<br/>邀請 {selectedChar?.name} 交換日記。</p>
                    <button
                        onClick={handleExchange}
                        className="px-6 py-3 bg-amber-500 hover:bg-amber-400 text-white text-sm font-bold rounded-full shadow-[0_0_20px_rgba(245,158,11,0.3)] active:scale-95 transition-all mt-2"
                    >
                        查看 TA 的今日
                    </button>
                </>
            )}
        </div>
    );

    // 一次性彈窗:講清楚新版交換日記的行為變化(自動同步 / 歸檔移到列表 / 宮殿入向量)
    const introModal = showIntro ? (
        <Modal
            isOpen={showIntro}
            title="交換日記 · 更新了"
            onClose={dismissIntro}
            footer={
                <button onClick={dismissIntro} className="w-full py-3 bg-amber-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">
                    我知道了
                </button>
            }
        >
            <div className="space-y-3 text-sm text-slate-700 leading-relaxed">
                <p className="font-bold text-amber-700">幾個新變化,先看一眼:</p>
                <div className="rounded-2xl bg-amber-50 border border-amber-100 px-4 py-3 space-y-2">
                    <p><span className="font-bold text-amber-700">① 自動同步聊天:</span> 角色回覆了你的日記之後,會自動變成一張漂亮卡片出現在和這個角色的聊天裡 —— 不用再手動發送。你之後在日記本里改文字 / 刪日記,聊天裡那張卡片也會跟著同步。</p>
                    <p><span className="font-bold text-amber-700">② 單向日記不進記憶:</span> 如果你只是單方面寫給角色看(沒讓 ta 回覆),這一篇就不會進入任何記憶,按以前的方式存著就好。</p>
                    <p><span className="font-bold text-amber-700">③ 新日記不用管歸檔:</span> 本次更新<b>之後</b>新寫的日記走的就是上面"自動同步聊天"那條線 —— 卡片進了聊天后，系統會像處理普通消息一樣自動幫你整理。不需要也<b>不應該</b>再手動歸檔一次。所以新日記你看不到歸檔入口, 這是故意的。</p>
                    <p><span className="font-bold text-amber-700">④ 老日記還能手動歸檔:</span> 本次更新<b>之前</b>留下的老日記裡, 如果是角色回覆過的, <b>點進那篇日記, 右上角會有一個"歸檔"按鈕</b>, 點一下就行 —— 就會把這篇日記整理進角色的記憶裡，開了記憶宮殿的角色會記得更細。</p>
                </div>
                <p className="text-xs text-slate-400">這條提示只出現一次。</p>
            </div>
        </Modal>
    ) : null;

    // 歸檔結果彈窗: 讓用戶清楚知道生成了哪些內容、被送去了哪裡
    const archiveResultModal = archiveResult ? (() => {
        const p = archiveResult.palace;
        const userName = userProfile.name || '我';
        // 宮殿狀態文案
        let palaceStatus: { tone: 'on' | 'off' | 'warn' | 'fail'; title: string; detail: string } = { tone: 'off', title: '', detail: '' };
        if (!p) {
            palaceStatus = { tone: 'fail', title: '記憶宮殿 · 寫入失敗', detail: '記憶宮殿這次沒能寫入，但日記已經成功存進神經鏈接。' };
        } else if (p.status === 'palace_disabled') {
            palaceStatus = { tone: 'off', title: '記憶宮殿 · 未開啟', detail: `${archiveResult.charName} 沒開啟記憶宮殿，這次按基礎方式存進了神經鏈接。想讓日記記得更細，去角色設置打開"記憶宮殿"開關再歸檔。` };
        } else if (p.status === 'lightllm_missing') {
            palaceStatus = { tone: 'warn', title: '記憶宮殿 · 副 API 未配置', detail: '記憶宮殿的後台模型還沒配置，去設置裡填一下就能用完整功能；這次先按基礎方式存進了神經鏈接。' };
        } else if (p.status === 'embedding_missing') {
            palaceStatus = { tone: 'warn', title: '記憶宮殿 · 嵌入模型未配置', detail: '嵌入模型還沒配置；這次先按基礎方式存進了神經鏈接，去設置補上就能用完整功能。' };
        } else if (p.status === 'empty_input') {
            palaceStatus = { tone: 'warn', title: '記憶宮殿 · 內容為空', detail: '日記兩頁都沒有正文, 沒東西可入宮。' };
        } else if (p.status === 'extracted_none') {
            palaceStatus = { tone: 'warn', title: '記憶宮殿 · 副 API 沒提取出內容', detail: '讀完這篇日記後沒找到值得單獨記的內容；日記本身已經存進神經鏈接了。' };
        } else {
            palaceStatus = {
                tone: 'on',
                title: `記憶宮殿 · 入了 ${p.stored} 條${p.skipped > 0 ? ` (另有 ${p.skipped} 條命中已有記憶去重)` : ''}`,
                detail: '這篇日記被整理成下面這幾條記憶，之後聊到相關內容時角色會想起來；日期按日記當天記。',
            };
        }

        const palaceNodes = (p && p.status === 'done') ? p.nodes : [];

        return (
            <Modal
                isOpen={true}
                title={`已歸檔 · ${archiveResult.date}`}
                onClose={() => setArchiveResult(null)}
                footer={
                    <button onClick={() => setArchiveResult(null)} className="w-full py-3 bg-amber-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">
                        知道了
                    </button>
                }
            >
                <div className="space-y-3 text-sm text-slate-700 leading-relaxed max-h-[60vh] overflow-y-auto no-scrollbar pr-1">
                    {/* 頂部一行: 數據流向示意 */}
                    {archiveResult.summaryOrigin === 'palace_bullets' ? (
                        <div className="rounded-xl bg-gradient-to-r from-emerald-50 to-purple-50 border border-emerald-200/60 px-3 py-2 text-[11px] text-slate-600">
                            ✓ 這次歸檔同時進了 <b className="text-emerald-700">神經鏈接</b> 和 <b className="text-purple-700">記憶宮殿</b>,
                            兩邊拿的是 <b>同一組提取出來的內容</b> —— 這次提取出的幾條記憶會一併存進神經鏈接。
                        </div>
                    ) : (
                        <div className="rounded-xl bg-emerald-50/70 border border-emerald-100 px-3 py-2 text-[11px] text-slate-600">
                            這次歸檔只進了 <b className="text-emerald-700">神經鏈接</b>, 用主 API 生成的散文式總結。原因看下面"記憶宮殿"那塊。
                        </div>
                    )}

                    {/* 神經鏈接 */}
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-bold tracking-widest uppercase text-emerald-700">● 神經鏈接</span>
                            <span className="text-[10px] text-emerald-600/70">寫入 1 條 · 日期 {archiveResult.date}</span>
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">mood={archiveResult.summaryOrigin === 'palace_bullets' ? 'diary_palace' : 'diary'}</span>
                        </div>
                        <p className="text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap" style={{ fontFamily: archiveResult.summaryOrigin === 'palace_bullets' ? 'inherit' : 'ui-serif, Georgia, serif' }}>
                            {archiveResult.summary}
                        </p>
                        <p className="text-[10px] text-emerald-700/70">
                            ↑ 這條會出現在「{archiveResult.charName}」的本月詳細記錄裡, 自動跟聊天上下文一起送進 LLM。
                            {archiveResult.summaryOrigin === 'palace_bullets'
                                ? ' 每個 bullet 都對應下面記憶宮殿裡的一個節點。'
                                : ''}
                        </p>
                    </div>

                    {/* 記憶宮殿 */}
                    <div className={`rounded-2xl border px-4 py-3 space-y-2 ${
                        palaceStatus.tone === 'on' ? 'border-purple-100 bg-purple-50/70'
                        : palaceStatus.tone === 'off' ? 'border-slate-100 bg-slate-50'
                        : palaceStatus.tone === 'warn' ? 'border-amber-100 bg-amber-50/70'
                        : 'border-red-100 bg-red-50/70'
                    }`}>
                        <div className={`text-[10px] font-bold tracking-widest uppercase ${
                            palaceStatus.tone === 'on' ? 'text-purple-700'
                            : palaceStatus.tone === 'off' ? 'text-slate-500'
                            : palaceStatus.tone === 'warn' ? 'text-amber-700'
                            : 'text-red-600'
                        }`}>
                            ◆ {palaceStatus.title}
                        </div>
                        <p className="text-[12px] text-slate-600">{palaceStatus.detail}</p>
                        {palaceNodes.length > 0 && (
                            <div className="space-y-1.5 pt-1">
                                {palaceNodes.map((n, i) => (
                                    <div key={i} className="rounded-xl bg-white/80 border border-purple-100 px-3 py-2">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">{getRoomLabel(n.room, userName)}</span>
                                            <span className="text-[9px] font-mono text-purple-500/70">重要度 {n.importance}/10</span>
                                            {n.mood && <span className="text-[9px] text-slate-400">· {n.mood}</span>}
                                        </div>
                                        <p className="text-[12px] text-slate-700 leading-snug">{n.content}</p>
                                        {n.tags?.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                                {n.tags.slice(0, 6).map((t, ti) => (
                                                    <span key={ti} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">#{t}</span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </Modal>
        );
    })() : null;

    if (mode === 'select') {
        return (
            <div className={`sully-journal-root sully-journal-select h-full w-full bg-amber-50 flex flex-col font-light${journalLayoutClass}`}>
                <JournalAppearanceStyle appearance={effectiveJournalAppearance} />
                {introModal}
                {archiveResultModal}
                <JournalThemeArtwork preset={effectiveJournalPreset} scene="select" />
                <div className="sully-journal-header border-b border-amber-100 bg-amber-50/80 backdrop-blur-sm sticky top-0 z-20 shrink-0" style={{ paddingTop: 'var(--chrome-top)' }}>
                    <div className="h-12 px-6 flex items-center justify-between">
                        <button onClick={closeApp} aria-label="返回桌面" className="sully-journal-back p-2 -ml-2 rounded-full hover:bg-amber-100/50 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6 text-amber-900"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="sully-journal-header-title font-bold text-amber-900 text-lg tracking-wide">選擇日記本</span>
                        <JournalAppearanceButton compact {...journalAppearanceButtonProps} />
                    </div>
                </div>
                
                {/* 分組篩選（沒建分組時不渲染），淺色米黃底 */}
                <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                    value={journalGroupId} onChange={setJournalGroupId} className="sully-journal-group-filter px-6 pt-4 shrink-0" />
                <div className="sully-journal-notebook-grid p-6 grid grid-cols-2 gap-5 overflow-y-auto pb-20 no-scrollbar">
                    {filterCharactersByGroup(characters, characterGroups, journalGroupId).map(c => (
                        <div key={c.id} onClick={() => handleCharSelect(c)} className="sully-journal-notebook aspect-[3/4] bg-white rounded-r-2xl rounded-l-md border-l-4 border-l-amber-800 shadow-[2px_4px_12px_rgba(0,0,0,0.08)] p-4 flex flex-col items-center justify-center gap-3 cursor-pointer active:scale-95 transition-all relative overflow-hidden group">
                            <div className="absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-black/10 to-transparent"></div>
                            <div className="sully-journal-notebook-avatar w-16 h-16 rounded-full p-[2px] border border-amber-100 bg-amber-50">
                                <TokenImg value={c.avatar} className="w-full h-full rounded-full object-cover" />
                            </div>
                            <span className="sully-journal-notebook-name font-bold text-amber-900 text-sm">{c.name}</span>
                            <span className="sully-journal-notebook-label text-[9px] text-amber-600 bg-amber-50 px-2 py-1 rounded-full font-mono uppercase tracking-wide">Journal</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (mode === 'calendar' && selectedChar) {
        return (
            <div className={`sully-journal-root sully-journal-calendar h-full w-full bg-white flex flex-col font-light relative${journalLayoutClass}`}>
                <JournalAppearanceStyle appearance={effectiveJournalAppearance} />
                {introModal}
                {archiveResultModal}
                <JournalThemeArtwork preset={effectiveJournalPreset} scene="calendar" />
                <div className="sully-journal-calendar-hero pb-6 px-6 bg-amber-500 shadow-lg shrink-0 rounded-b-[2rem] z-20" style={{ paddingTop: 'max(3rem, var(--safe-top))' }}>
                    <div className="flex justify-between items-start mb-4">
                         <button onClick={() => setMode('select')} aria-label="返回日記本選擇" className="sully-journal-back text-white/80 hover:text-white transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" /></svg>
                         </button>
                         <JournalAppearanceButton tone="dark" compact {...journalAppearanceButtonProps} />
                    </div>
                    <div className="sully-journal-calendar-heading text-white">
                        <div className="sully-journal-calendar-kicker text-xs opacity-70 uppercase tracking-widest font-bold mb-1">Exchange Diary</div>
                        <div className="sully-journal-calendar-title text-3xl font-bold tracking-tight">{selectedChar.name}</div>
                    </div>
                </div>

                <div className="sully-journal-calendar-list flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    <button onClick={() => openEntry(getLocalDateStr())} className="sully-journal-new-entry w-full py-5 mb-8 border-2 border-dashed border-amber-200 rounded-2xl text-amber-500 font-bold flex items-center justify-center gap-2 hover:bg-amber-50 active:scale-95 transition-all">
                        <span className="text-xl">+</span> 寫今天的日記
                    </button>
                    
                    <div className="space-y-4">
                        {diaries.map(d => (
                            <div key={d.id} onClick={() => openEntry(d.date)} className="sully-journal-entry flex items-center gap-4 p-4 rounded-2xl bg-white border border-slate-100 shadow-sm active:scale-95 transition-all hover:shadow-md cursor-pointer relative overflow-hidden group">
                                <div className="sully-journal-entry-accent absolute left-0 top-0 bottom-0 w-1 bg-amber-400"></div>
                                <div className="sully-journal-entry-date w-14 h-14 bg-amber-50 rounded-xl flex flex-col items-center justify-center text-amber-800 shrink-0 border border-amber-100">
                                    <span className="text-[10px] font-bold opacity-60">{d.date.split('-')[1]}月</span>
                                    <span className="text-xl font-bold leading-none">{d.date.split('-')[2]}</span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="sully-journal-entry-text text-sm text-slate-700 truncate font-medium">{d.userPage.text || '(空)'}</p>
                                    <div className="flex justify-between items-center mt-1">
                                        <p className="sully-journal-entry-year text-xs text-slate-400 font-mono">{d.date.split('-')[0]}</p>
                                        <div className="sully-journal-entry-badges flex gap-2">
                                            {d.charPage && <span className="px-2 py-0.5 bg-green-100 text-green-600 rounded-full text-[9px] font-bold">已回覆</span>}
                                            {d.chatCardMessageId && <span className="px-2 py-0.5 bg-emerald-50 text-emerald-500 rounded-full text-[9px] font-bold">同步聊天</span>}
                                            {d.isArchived && <span className="px-2 py-0.5 bg-amber-100 text-amber-600 rounded-full text-[9px] font-bold">已歸檔</span>}
                                        </div>
                                    </div>
                                </div>
                                {/* 歸檔按鈕統一移到了"點進日記後的右上角". 列表保留刪除按鈕, 不重複入口. */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setDeletingDiary(d);
                                    }}
                                    className="w-8 h-8 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors flex items-center justify-center"
                                    title="刪除日記"
                                    aria-label="刪除日記"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <Modal 
                    isOpen={!!deletingDiary}
                    title="刪除日記"
                    onClose={() => setDeletingDiary(null)}
                    footer={
                        <div className="flex gap-2 w-full">
                            <button onClick={() => setDeletingDiary(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">取消</button>
                            <button onClick={handleDeleteDiary} className="flex-1 py-3 bg-red-500 text-white rounded-2xl font-bold">刪除</button>
                        </div>
                    }
                >
                    <p className="text-sm text-slate-600">
                        確定刪除 {deletingDiary?.date} 的日記嗎？刪除後無法恢復。
                    </p>
                </Modal>
            </div>
        );
    }

    // --- WRITE MODE ---
    return (
        <div className={`sully-journal-root sully-journal-write h-full w-full bg-[#1a1a1a] flex flex-col relative overflow-hidden${journalLayoutClass}`}>
            <JournalAppearanceStyle appearance={effectiveJournalAppearance} />
            {introModal}
            {archiveResultModal}
            <JournalThemeArtwork preset={effectiveJournalPreset} scene="write" />

            {/* Editor Header */}
            <div className="sully-journal-editor-header bg-[#1a1a1a]/90 backdrop-blur-md text-white shrink-0 z-30" style={{ paddingTop: 'var(--chrome-top)' }}>
                <div className="h-12 px-4 flex items-center justify-between">
                    <button onClick={() => setMode('calendar')} aria-label="返回日記列表" className="sully-journal-back p-2 -ml-2 text-white/60 hover:text-white rounded-full active:bg-white/10 transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="flex gap-3">
                        <JournalAppearanceButton tone="dark" compact {...journalAppearanceButtonProps} />
                        {/* Toggle Char Sticker Visibility Button */}
                        {activeTab === 'char' && (
                            <button
                                onClick={() => setHideCharStickers(!hideCharStickers)}
                                className={`p-2 rounded-full transition-colors ${hideCharStickers ? 'bg-red-500/20 text-red-400' : 'bg-white/10 text-white/60'}`}
                                title={hideCharStickers ? "顯示貼紙" : "隱藏貼紙"}
                            >
                                {hideCharStickers ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                                ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                                )}
                            </button>
                        )}

                        {currentEntry?.chatCardMessageId && (
                            <div className="px-3 py-1 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 flex items-center gap-1.5" title="該日記已自動同步為聊天卡片">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                                已同步聊天
                            </div>
                        )}
                        {currentEntry?.isArchived && (
                            <div className="px-3 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 flex items-center gap-1.5" title="該日記已歸檔進神經鏈接">
                                <Archive size={11} weight="fill" />
                                已歸檔
                            </div>
                        )}
                        {/* 老日記 (本次更新前留下的, autoSync 未設) 且角色已回覆 → 右上角出現歸檔按鈕.
                            新日記走自動同步聊天那條線, 不顯示這個按鈕防止重複入庫. */}
                        {currentEntry && !currentEntry.autoSync && currentEntry.charPage && !currentEntry.isArchived && (
                            <button
                                onClick={() => handleArchiveDiary(currentEntry)}
                                disabled={archivingId === currentEntry.id}
                                className={`px-3 py-1.5 rounded-full text-xs font-bold shadow-lg transition-all flex items-center gap-1.5 ${archivingId === currentEntry.id ? 'bg-amber-700/60 text-amber-200 cursor-wait' : 'bg-amber-500 text-white hover:bg-amber-400 active:scale-95'}`}
                                title={'把這篇老日記歸檔進神經鏈接' + (selectedChar?.memoryPalaceEnabled ? ' / 記憶宮殿' : '')}
                            >
                                {archivingId === currentEntry.id ? (
                                    <>
                                        <div className="w-3 h-3 border-2 border-amber-200/40 border-t-amber-100 rounded-full animate-spin"></div>
                                        歸檔中
                                    </>
                                ) : (
                                    <>
                                        <Archive size={12} weight="fill" />
                                        歸檔
                                    </>
                                )}
                            </button>
                        )}
                        <button onClick={() => { saveEntry(); trackEvent('保存日记'); }} className="px-4 py-1.5 bg-white/10 rounded-full text-xs font-bold hover:bg-white/20 active:scale-95 transition-transform">
                            保存
                        </button>
                    </div>
                </div>
            </div>

            {/* Main Page Area */}
            <div className="sully-journal-editor-stage flex-1 relative w-full overflow-hidden flex flex-col">
                <div className={`flex-1 w-full mx-auto px-2 pb-4 pt-2 flex flex-col relative ${journalUsesScrapbookLayout ? 'max-w-5xl' : 'max-w-xl'}`}>
                    <div className="flex-1 relative rounded-3xl transition-all duration-500">
                        {journalUsesScrapbookLayout ? (
                            <div className="sully-journal-spread">
                                <div
                                    className={`sully-journal-spread-page sully-journal-spread-user ${activeTab === 'user' ? 'is-active' : 'is-inactive'}`}
                                    onPointerDownCapture={() => setActiveTab('user')}
                                >
                                    {currentEntry && renderPage(currentEntry.userPage, 'user')}
                                </div>
                                <div
                                    className={`sully-journal-spread-page sully-journal-spread-char ${activeTab === 'char' ? 'is-active' : 'is-inactive'}`}
                                    onPointerDownCapture={() => setActiveTab('char')}
                                >
                                    {currentEntry?.charPage ? renderPage(currentEntry.charPage, 'char') : renderEmptyCharPage()}
                                </div>
                            </div>
                        ) : (
                            <>
                                {activeTab === 'user' && currentEntry && renderPage(currentEntry.userPage, 'user')}
                                {activeTab === 'char' && (currentEntry?.charPage ? renderPage(currentEntry.charPage, 'char') : renderEmptyCharPage())}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Bottom Controls */}
            <div className="sully-journal-bottom-controls shrink-0 bg-[#222] border-t border-white/5 pb-safe pt-2 z-30">
                <div className="sully-journal-tabs flex justify-center gap-4 mb-4 px-4">
                    <button 
                        onClick={() => { setActiveTab('user'); setSelectedStickerId(null); trackEvent('切换日记页标签', { page: 'user' }); }}
                        className={`sully-journal-tab ${activeTab === 'user' ? 'sully-journal-tab-active' : ''} flex-1 py-3 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all duration-300 relative overflow-hidden ${activeTab === 'user' ? 'bg-white text-black shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'}`}
                    >
                        My Diary
                    </button>
                    <button 
                        onClick={() => { setActiveTab('char'); setSelectedStickerId(null); trackEvent('切换日记页标签', { page: 'char' }); }}
                        className={`sully-journal-tab ${activeTab === 'char' ? 'sully-journal-tab-active' : ''} flex-1 py-3 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all duration-300 relative overflow-hidden ${activeTab === 'char' ? 'bg-amber-500 text-white shadow-lg shadow-amber-900/50' : 'bg-white/5 text-white/40 hover:bg-white/10'}`}
                    >
                        {selectedChar?.name || 'Partner'}
                        {currentEntry?.charPage && activeTab !== 'char' && <div className="absolute top-2 right-2 w-2 h-2 bg-green-500 rounded-full shadow-sm animate-pulse"></div>}
                    </button>
                </div>

                <div className="flex items-center justify-between px-6 pb-4">
                    <div className="sully-journal-paper-picker flex gap-3 bg-[#111] p-1.5 rounded-full border border-white/10">
                        {PAPER_STYLES.slice(0, 4).map(s => (
                            <button 
                                key={s.id} 
                                onClick={() => { updatePage({ paperStyle: s.id }, activeTab); trackEvent('切换日记纸张样式', { paperStyle: s.id }); }}
                                className={`sully-journal-paper-swatch w-8 h-8 rounded-full border border-white/10 transition-transform active:scale-90 ${s.css}`}
                                title={s.name}
                            />
                        ))}
                    </div>
                    
                    <div className="flex gap-3">
                        {activeTab === 'char' && currentEntry?.charPage && !isThinking && (
                            <button
                                onClick={handleExchange}
                                className="w-11 h-11 bg-white/10 text-white rounded-full flex items-center justify-center active:scale-90 transition-transform border border-white/5"
                                title="重新寫角色日記"
                                aria-label="重新寫角色日記"
                                data-testid="journal-rewrite-character-page"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                            </button>
                        )}
                        
                        <button 
                            onClick={() => { setShowStickerPanel(!showStickerPanel); if (!showStickerPanel) trackEvent('打开贴纸面板'); }}
                            className={`sully-journal-sticker-button w-11 h-11 rounded-full flex items-center justify-center text-xl shadow-lg active:scale-90 transition-transform ${showStickerPanel ? 'bg-white text-black' : 'bg-gradient-to-br from-amber-400 to-orange-500 text-white'}`}
                        >
                            <Sparkle size={24} weight="fill" />
                        </button>
                    </div>
                </div>

                {showStickerPanel && (
                    <div className="sully-journal-sticker-panel bg-[#1a1a1a] border-t border-white/10 p-4 animate-slide-up h-48 overflow-y-auto no-scrollbar">
                        <div className="grid grid-cols-6 gap-3">
                            <button onClick={() => { setShowImportModal(true); trackEvent('打开自定义贴纸导入弹窗'); }} className="flex items-center justify-center bg-white/10 rounded-xl border-2 border-dashed border-white/20 text-white/50 text-xl font-bold hover:bg-white/20 hover:text-white transition-all aspect-square">
                                +
                            </button>
                            {DEFAULT_STICKERS.map((s, i) => (
                                <button key={`def-${i}`} onClick={() => addSticker(s)} className="hover:scale-110 transition-transform p-2 bg-white/5 rounded-xl border border-white/5 flex items-center justify-center">
                                    <img src={s} alt="" className="w-8 h-8 object-contain pointer-events-none" />
                                </button>
                            ))}
                            {customStickers.map((s, i) => (
                                <button 
                                    key={`cust-${i}`} 
                                    onClick={() => addSticker(s.url)} 
                                    onTouchStart={() => handleDrawerTouchStart(s)}
                                    onTouchEnd={handleDrawerTouchEnd}
                                    onMouseDown={() => handleDrawerTouchStart(s)}
                                    onMouseUp={handleDrawerTouchEnd}
                                    onMouseLeave={handleDrawerTouchEnd}
                                    onContextMenu={(e) => { e.preventDefault(); setDeletingSticker(s); }}
                                    className="p-2 bg-white/5 rounded-xl border border-white/5 flex items-center justify-center relative active:scale-95 transition-transform"
                                >
                                    <img src={s.url} className="w-8 h-8 object-contain pointer-events-none" />
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Sticker Import Modal */}
            <Modal 
                isOpen={showImportModal} title="添加日記貼紙" onClose={() => setShowImportModal(false)}
                footer={<button onClick={handleImportStickers} className="w-full py-3 bg-white/10 text-white font-bold rounded-2xl hover:bg-white/20 transition-all">確認添加</button>}
            >
                <div className="space-y-3">
                    <p className="text-xs text-slate-500">格式：貼紙名稱--圖片URL (每行一個)</p>
                    <textarea 
                        value={importText} 
                        onChange={e => setImportText(e.target.value)} 
                        placeholder={`CoolCat--https://...\nHeart--https://...`}
                        className="w-full h-32 bg-slate-100 rounded-2xl p-4 text-sm resize-none focus:outline-none text-slate-700"
                    />
                </div>
            </Modal>

            {/* Sticker Delete Confirmation Modal */}
            <Modal 
                isOpen={!!deletingSticker} title="刪除貼紙素材" onClose={() => setDeletingSticker(null)}
                footer={<div className="flex gap-2 w-full"><button onClick={() => setDeletingSticker(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">取消</button><button onClick={handleDeleteStickerAsset} className="flex-1 py-3 bg-red-500 text-white rounded-2xl font-bold">刪除</button></div>}
            >
                <div className="flex flex-col items-center gap-3 py-2">
                    {deletingSticker && <img src={deletingSticker.url} className="w-16 h-16 object-contain rounded-lg bg-slate-100 border" />}
                    <p className="text-sm text-slate-600">確定要刪除這個貼紙素材嗎？(不會影響已使用的日記)</p>
                </div>
            </Modal>
        </div>
    );
};

export default JournalApp;
