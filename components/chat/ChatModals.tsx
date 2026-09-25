
import React, { useRef, useState } from 'react';
import { ArrowsClockwise, DownloadSimple, X } from '@phosphor-icons/react';
import Modal from '../os/Modal';
import TokenImg from '../os/TokenImg';
import { CharacterProfile, Message, EmojiCategory, DailySchedule, ScheduleSlot, ApiPreset, APIConfig } from '../../types';
import ScheduleCard from '../schedule/ScheduleCard';
import EmotionSettingsPanel from './EmotionSettingsPanel';
import EmotionStatusPanel from './EmotionStatusPanel';
import ChatApiSettingsPanel from './ChatApiSettingsPanel';
import CustomMeterPanel from '../schedule/CustomMeterPanel';
import type { CharacterCustomMeter } from '../../types';
import ChatInputSettings from './ChatInputSettings';
import ChatSettingsSection from './ChatSettingsSection';
import ChatSettingsPage, { type ChatBlockAction, type ChatSettingsPatch } from './ChatSettingsPage';
import type { ChatInputPreferences } from '../../utils/chatInputPreferences';
import { isTranslationLangPreset, normalizeTranslationLangLabel, TRANSLATION_LANG_MAX_LENGTH, TRANSLATION_LANG_PRESETS } from '../../utils/translationLang';
import type { ContextRangeMode, ContextRangeSnapshot } from '../../utils/chatContextRange';
import { trackEvent } from '../../utils/analytics';
import { CANTONESE_VOICE_SUPPORT_NOTE, VOICE_LANGUAGE_OPTIONS } from '../../utils/voiceLanguage';
import { chatMessageFuzzyMatchesKeyword } from '../../utils/chatMessageSearch';

interface ChatModalsProps {
    modalType: string;
    setModalType: (v: any) => void;
    // Data Props
    transferAmt: string;
    setTransferAmt: (v: string) => void;
    transferNote: string;
    setTransferNote: (v: string) => void;
    emojiImportText: string;
    setEmojiImportText: (v: string) => void;
    settingsContextLimit: number;
    setSettingsContextLimit: (v: number) => void;
    settingsContextRangeMode: ContextRangeMode;
    setSettingsContextRangeMode: (v: ContextRangeMode) => void;
    settingsHideSysLogs: boolean;
    setSettingsHideSysLogs: (v: boolean) => void;
    settingsInputPreferences: ChatInputPreferences;
    setSettingsInputPreferences: (value: ChatInputPreferences) => void;
    contextSuiteAnyEnabled: boolean;
    contextSuiteAllEnabled: boolean;
    onToggleContextSuite: () => void;
    editContent: string;
    setEditContent: (v: string) => void;
    
    // New Category Props
    newCategoryName: string;
    setNewCategoryName: (v: string) => void;
    onAddCategory: () => void;

    // Emoji rename Props
    newEmojiName: string;
    setNewEmojiName: (v: string) => void;
    onRenameEmoji: () => void;

    // Archive Props
    archivePrompts: {id: string, name: string, content: string}[];
    selectedPromptId: string;
    setSelectedPromptId: (id: string) => void;
    editingPrompt: {id: string, name: string, content: string} | null;
    setEditingPrompt: (p: any) => void;
    isSummarizing: boolean;
    archiveProgress?: string;

    // Selection Props
    selectedMessage: Message | null;
    selectedEmoji: {name: string, url: string} | null;
    selectedCategory: EmojiCategory | null;
    activeCharacter: CharacterProfile;
    messages: Message[];
    allHistoryMessages?: Message[];
    contextRangeSnapshot?: ContextRangeSnapshot;

    // Handlers
    onTransfer: () => void;
    onImportEmoji: () => void;
    onSaveSettings: (patch?: ChatSettingsPatch) => void;
    /** 這個私聊裡生效的「你」（名字、頭像），聊天設定頁頂部用。 */
    chatUser: { name: string; avatar: string };
    onOpenHistoryCleanup?: () => void;
    onArchive: () => void;
    onCreatePrompt: () => void;
    onEditPrompt: () => void;
    onSavePrompt: () => void;
    onDeletePrompt: (id: string) => void;
    onSetHistoryStart: (id: number | undefined) => void;
    onRestoreAdaptiveContext?: () => void;
    onJumpToMessageInChat?: (id: number) => void;
    onEnterSelectionMode: () => void;
    onReplyMessage: () => void;
    onEditMessageStart: () => void;
    onConfirmEditMessage: () => void;
    onDeleteMessage: () => void;
    onCopyMessage: () => void;
    onToggleMessageFavorite?: () => void;
    messageFavorited?: boolean;
    onDownloadImage?: (msg: Message) => void;
    onRegenerateImage?: (msg: Message) => void;
    regeneratingImageId?: number | null;
    onDeleteEmoji: () => void;
    onDeleteCategory: () => void;
    onRenameCategory: () => void;
    onDownloadCategory: () => void;
    // Category Visibility
    allCharacters?: CharacterProfile[];
    onSaveCategoryVisibility?: (categoryId: string, allowedCharacterIds: string[] | undefined) => void;
    // Translation
    translationEnabled?: boolean;
    onToggleTranslation?: () => void;
    translationExpanded?: boolean;
    onToggleTranslationExpanded?: () => void;
    translateSourceLang?: string;
    translateTargetLang?: string;
    onSetTranslateSourceLang?: (lang: string) => void;
    onSetTranslateLang?: (lang: string) => void;
    // XHS toggle
    xhsEnabled?: boolean;
    onToggleXhs?: () => void;
    // HTML mode
    htmlModeEnabled?: boolean;
    onToggleHtmlMode?: () => void;
    htmlModeCustomPrompt?: string;
    setHtmlModeCustomPrompt?: (v: string) => void;
    // Voice TTS
    chatVoiceEnabled?: boolean;
    onToggleChatVoice?: () => void;
    chatVoiceAutoPlay?: boolean;
    onToggleChatVoiceAutoPlay?: () => void;
    chatVoiceLang?: string;
    onSetChatVoiceLang?: (lang: string) => void;
    // Voice generation from long-press
    onGenerateVoice?: () => void;
    voiceAvailable?: boolean; // true if char has voiceProfile configured
    onDownloadVoice?: () => void;
    voiceDownloadable?: boolean; // true if the selected message already has generated voice
    voiceCollectable?: boolean; // true for a generated voice or an unsynthesized <語音> message
    onToggleVoiceFavorite?: () => void;
    voiceFavorited?: boolean;
    // Schedule
    scheduleData?: DailySchedule | null;
    isScheduleGenerating?: boolean;
    onScheduleEdit?: (index: number, slot: ScheduleSlot) => void;
    onScheduleDelete?: (index: number) => void;
    onScheduleReroll?: () => void;
    onScheduleCoverChange?: (dataUrl: string) => void;
    onScheduleStyleChange?: (style: 'lifestyle' | 'mindful') => void;
    onPlayTheater?: (index: number) => void;
    // Schedule master toggle
    isScheduleFeatureEnabled?: boolean;
    onToggleScheduleFeature?: () => void;
    // Memory Palace force vectorize
    isMemoryPalaceEnabled?: boolean;
    isVectorizing?: boolean;
    /** 待處理條數（排除熱區的真實緩衝區口徑）：null=未算出/未開彈窗，0=已全同步 */
    vectorizePendingCount?: number | null;
    /** 處理中的逐輪進度文案，如「第 2 輪 · 剩餘 340 條」 */
    vectorizeProgress?: string;
    retainRecentForVectorize?: boolean;
    setRetainRecentForVectorize?: (value: boolean) => void;
    vectorizeResult?: {
        processedMessages: number;
        storedMemories: number;
        retainedMessages: number;
        waterlineAlreadyAhead: boolean;
    } | null;
    onForceVectorize?: () => void;
    // Emotion (embedded under schedule modal, synced on/off with scheduleStyle)
    apiPresets?: ApiPreset[];
    onAddApiPreset?: (name: string, config: APIConfig) => void;
    onSaveEmotion?: (config: NonNullable<CharacterProfile['emotionConfig']>) => void;
    onSaveChatApi?: (config: CharacterProfile['chatApi']) => void;
    onChatBlockAction?: (action: ChatBlockAction) => void;
    onSaveInnerVoices?: (entries: CharacterCustomMeter[]) => void;
    onGenerateInnerVoice?: (entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>) => Promise<Partial<Pick<CharacterCustomMeter, 'content' | 'value' | 'statusNote'>> | null>;
    onSaveAffinities?: (entries: CharacterCustomMeter[]) => void;
    onGenerateAffinity?: (entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>) => Promise<Partial<Pick<CharacterCustomMeter, 'content' | 'value' | 'statusNote'>> | null>;
    onClearBuffs?: () => void;
}

interface TranslationLanguagePickerProps {
    label: string;
    value?: string;
    tone: 'source' | 'target';
    inputPlaceholder: string;
    onSelect?: (lang: string) => void;
}

const TranslationLanguagePicker: React.FC<TranslationLanguagePickerProps> = ({
    label,
    value,
    tone,
    inputPlaceholder,
    onSelect,
}) => {
    const [customLang, setCustomLang] = useState('');
    const selectedClass = tone === 'source' ? 'bg-slate-700 text-white' : 'bg-primary text-white';
    const customSelected = !!value && !isTranslationLangPreset(value);
    const normalizedCustomLang = normalizeTranslationLangLabel(customLang);

    const applyCustomLang = () => {
        if (!normalizedCustomLang) return;
        onSelect?.(normalizedCustomLang);
        setCustomLang('');
    };

    return (
        <div>
            <label className="text-[10px] font-bold text-slate-400 mb-1.5 block">{label}</label>
            <div className="flex flex-wrap gap-1.5">
                {TRANSLATION_LANG_PRESETS.map(lang => (
                    <button
                        type="button"
                        key={`${tone}-${lang}`}
                        onClick={() => onSelect?.(lang)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all ${value === lang ? selectedClass : 'bg-slate-100 text-slate-500'}`}
                    >
                        {lang}
                    </button>
                ))}
                {customSelected && (
                    <button
                        type="button"
                        onClick={() => value && onSelect?.(value)}
                        className={`max-w-full px-2.5 py-1 rounded-full text-[11px] font-bold transition-all truncate ${selectedClass}`}
                        title={value}
                    >
                        {value}
                    </button>
                )}
            </div>
            <div className="mt-2 flex gap-1.5">
                <input
                    value={customLang}
                    onChange={e => setCustomLang(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            applyCustomLang();
                        }
                    }}
                    maxLength={TRANSLATION_LANG_MAX_LENGTH}
                    placeholder={inputPlaceholder}
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 outline-none focus:border-primary"
                />
                <button
                    type="button"
                    onClick={applyCustomLang}
                    disabled={!normalizedCustomLang}
                    className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${normalizedCustomLang ? selectedClass : 'bg-slate-100 text-slate-300'}`}
                >
                    套用
                </button>
            </div>
        </div>
    );
};

const ChatModals: React.FC<ChatModalsProps> = ({
    modalType, setModalType,
    transferAmt, setTransferAmt,
    transferNote, setTransferNote,
    emojiImportText, setEmojiImportText,
    settingsContextLimit, setSettingsContextLimit,
    settingsContextRangeMode, setSettingsContextRangeMode,
    settingsHideSysLogs, setSettingsHideSysLogs,
    settingsInputPreferences, setSettingsInputPreferences,
    contextSuiteAnyEnabled, contextSuiteAllEnabled, onToggleContextSuite,
    editContent, setEditContent,
    newCategoryName, setNewCategoryName, onAddCategory,
    newEmojiName, setNewEmojiName, onRenameEmoji,
    archivePrompts, selectedPromptId, setSelectedPromptId,
    editingPrompt, setEditingPrompt, isSummarizing, archiveProgress,
    selectedMessage, selectedEmoji, selectedCategory, activeCharacter, messages,
    allHistoryMessages = [],
    contextRangeSnapshot,
    onTransfer, onImportEmoji, onSaveSettings, chatUser,
    onOpenHistoryCleanup,
    onArchive, onCreatePrompt, onEditPrompt, onSavePrompt, onDeletePrompt,
    onSetHistoryStart, onRestoreAdaptiveContext, onJumpToMessageInChat, onEnterSelectionMode, onReplyMessage, onEditMessageStart, onConfirmEditMessage, onDeleteMessage, onCopyMessage, onToggleMessageFavorite, messageFavorited, onDownloadImage, onRegenerateImage, regeneratingImageId, onDeleteEmoji, onDeleteCategory, onRenameCategory, onDownloadCategory,
    allCharacters = [], onSaveCategoryVisibility,
    translationEnabled, onToggleTranslation, translationExpanded, onToggleTranslationExpanded, translateSourceLang, translateTargetLang, onSetTranslateSourceLang, onSetTranslateLang,
    xhsEnabled, onToggleXhs,
    htmlModeEnabled, onToggleHtmlMode, htmlModeCustomPrompt, setHtmlModeCustomPrompt,
    chatVoiceEnabled, onToggleChatVoice, chatVoiceAutoPlay, onToggleChatVoiceAutoPlay, chatVoiceLang, onSetChatVoiceLang,
    onGenerateVoice, voiceAvailable, onDownloadVoice, voiceDownloadable, voiceCollectable, onToggleVoiceFavorite, voiceFavorited,
    scheduleData, isScheduleGenerating, onScheduleEdit, onScheduleDelete, onScheduleReroll, onScheduleCoverChange,
    onScheduleStyleChange, onPlayTheater,
    isScheduleFeatureEnabled, onToggleScheduleFeature,
    isMemoryPalaceEnabled, isVectorizing, vectorizePendingCount, vectorizeProgress,
    retainRecentForVectorize, setRetainRecentForVectorize, vectorizeResult, onForceVectorize,
    apiPresets, onAddApiPreset, onSaveEmotion, onClearBuffs, onSaveChatApi, onChatBlockAction,
    onSaveInnerVoices, onGenerateInnerVoice, onSaveAffinities, onGenerateAffinity,
}) => {
    const [visibilitySelection, setVisibilitySelection] = useState<Set<string>>(new Set());
    const [historyPage, setHistoryPage] = useState(0);
    const [historySearch, setHistorySearch] = useState('');
    const longPressTimerRef = useRef<number | null>(null);
    const longPressTriggeredRef = useRef(false);
    const HISTORY_PAGE_SIZE = 50;
    const HISTORY_SEARCH_MAX = 200;
    const LONG_PRESS_MS = 450;

    const startHistoryLongPress = (msgId: number) => {
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = window.setTimeout(() => {
            longPressTriggeredRef.current = true;
            if (onJumpToMessageInChat) {
                setModalType('none');
                setHistoryPage(0);
                setHistorySearch('');
                onJumpToMessageInChat(msgId);
            }
        }, LONG_PRESS_MS);
    };
    const cancelHistoryLongPress = () => {
        if (longPressTimerRef.current) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };
    const handleHistoryItemClick = (msgId: number) => {
        if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            return;
        }
        // 範圍內直接設置；範圍外由上層直接提示先調整拉桿。
        onSetHistoryStart(msgId);
    };

    // 高亮命中的連續子串（優先），否則不高亮（subsequence 命中時高亮意義不大）。
    const renderHighlighted = (text: string, query: string, baseClass: string) => {
        if (!query) return <span className={baseClass}>{text}</span>;
        const lower = text.toLowerCase();
        const q = query.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx < 0) return <span className={baseClass}>{text}</span>;
        return (
            <span className={baseClass}>
                {text.slice(0, idx)}
                <mark className="bg-yellow-200 text-slate-800 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
                {text.slice(idx + q.length)}
            </span>
        );
    };

    const openVisibilityModal = () => {
        if (selectedCategory) {
            setVisibilitySelection(new Set(selectedCategory.allowedCharacterIds || []));
            setModalType('category-visibility');
        }
    };

    const toggleVisibilityChar = (charId: string) => {
        setVisibilitySelection(prev => {
            const next = new Set(prev);
            if (next.has(charId)) next.delete(charId);
            else next.add(charId);
            return next;
        });
    };

    const handleSaveVisibility = () => {
        if (selectedCategory && onSaveCategoryVisibility) {
            const ids = Array.from(visibilitySelection);
            onSaveCategoryVisibility(selectedCategory.id, ids.length > 0 ? ids : undefined);
        }
        setModalType('none');
    };

    return (
        <>
            <Modal 
                isOpen={modalType === 'transfer'} title="Credits 轉帳" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={onTransfer} className="flex-1 py-3 bg-orange-500 text-white rounded-2xl">確認</button></>}
            >
                <input type="number" value={transferAmt} onChange={e => setTransferAmt(e.target.value)} placeholder="金額" className="w-full bg-slate-100 rounded-2xl px-5 py-4 text-lg font-bold" autoFocus />
                <input type="text" value={transferNote} onChange={e => setTransferNote(e.target.value)} maxLength={30} placeholder="添加轉帳留言（選填）" className="w-full bg-slate-100 rounded-2xl px-5 py-3 text-sm mt-3" />
            </Modal>

            {/* New Category Modal */}
            <Modal 
                isOpen={modalType === 'add-category'} title="新建表情分類" onClose={() => setModalType('none')}
                footer={<button onClick={onAddCategory} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">創建</button>}
            >
                <input 
                    value={newCategoryName} 
                    onChange={e => setNewCategoryName(e.target.value)} 
                    placeholder="輸入分類名稱..." 
                    className="w-full bg-slate-100 rounded-2xl px-5 py-4 text-base font-bold focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all text-slate-700" 
                    autoFocus 
                />
            </Modal>

            <Modal 
                isOpen={modalType === 'emoji-import'} title="表情注入" onClose={() => setModalType('none')}
                footer={<button onClick={onImportEmoji} className="w-full py-4 bg-primary text-white font-bold rounded-2xl">添加至當前分類</button>}
            >
                <div className="space-y-3">
                    <p className="text-xs text-slate-400">表情將導入到你當前選中的分類。</p>
                    <textarea value={emojiImportText} onChange={e => setEmojiImportText(e.target.value)} placeholder="Name--URL (每行一個)" className="w-full h-40 bg-slate-100 rounded-2xl p-4 resize-none" />
                </div>
            </Modal>

            <ChatSettingsPage
                isOpen={modalType === 'chat-settings'}
                char={activeCharacter}
                chatUser={chatUser}
                onClose={() => setModalType('none')}
                onSave={onSaveSettings}
                onBlockAction={onChatBlockAction}
            >
                    {onSaveChatApi && (
                        <ChatSettingsSection title="🧠 AI 模型（可單獨為這個角色配置）" summary="默認用全局API，也可以單獨換一個模型" defaultOpen>
                            <ChatApiSettingsPanel
                                char={activeCharacter}
                                apiPresets={apiPresets || []}
                                addApiPreset={onAddApiPreset || (() => {})}
                                onSave={onSaveChatApi}
                            />
                        </ChatSettingsSection>
                    )}
                    <ChatSettingsSection title="輸入與發送" summary="表情聯想、回車與自動回覆">
                        <ChatInputSettings value={settingsInputPreferences} onChange={setSettingsInputPreferences} />
                    </ChatSettingsSection>
                    <ChatSettingsSection title="消息顯示" summary="系統日誌顯示設置">
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex justify-between items-center cursor-pointer" onClick={() => setSettingsHideSysLogs(!settingsHideSysLogs)}>
                                <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">隱藏系統日誌</label>
                                <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${settingsHideSysLogs ? 'bg-primary' : 'bg-slate-200'}`}>
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${settingsHideSysLogs ? 'translate-x-4' : ''}`}></div>
                                </div>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                                開啟後隱藏見面/小程序等自動產生的灰色提示（轉帳、戳一戳、發圖提示除外）。
                            </p>
                        </div>
                    </ChatSettingsSection>
                    <ChatSettingsSection title="上下文與記憶" summary="智能語境、原文範圍與記憶整理">
                        <div className="rounded-2xl border border-violet-200 bg-violet-50 p-3.5">
                            <div className="flex items-center gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-bold text-violet-700">智能語境</div>
                                    <p className="mt-1 text-[10px] leading-relaxed text-violet-600/90">
                                        更準確地承接上下文、跟隨交流節奏，並持續關注正在展開的事情。對所有私聊生效，本地完成，不增加 API 調用。
                                    </p>
                                    <p className="mt-1.5 text-[10px] font-bold text-violet-600">
                                        {contextSuiteAllEnabled
                                            ? '已開啟'
                                            : contextSuiteAnyEnabled
                                                ? '舊版的部分能力仍在運行；關閉後可統一重新開啟'
                                                : '已關閉，回覆保持原有行為'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={onToggleContextSuite}
                                    aria-pressed={contextSuiteAnyEnabled}
                                    className={`shrink-0 rounded-full px-3.5 py-2 text-[11px] font-extrabold transition-colors ${contextSuiteAnyEnabled
                                        ? 'bg-white text-violet-700 ring-1 ring-violet-200'
                                        : 'bg-violet-600 text-white'}`}
                                >
                                    {contextSuiteAnyEnabled ? '關閉' : '開啟'}
                                </button>
                            </div>
                        </div>

                        <div>
                            {(activeCharacter.autoArchiveEnabled || activeCharacter.contextFollowsMemoryPalaceHwm) && settingsContextRangeMode === 'adaptive' ? (
                                <div className="rounded-2xl border border-violet-200 bg-violet-50 p-3.5">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <div className="text-xs font-bold text-violet-700">
                                                {activeCharacter.autoArchiveEnabled ? '自適應全自動記憶中' : '原文範圍跟隨記憶水位線'}
                                            </div>
                                            <p className="text-[10px] text-violet-600/80 mt-1 leading-relaxed">
                                                已處理原文不再重複注入，更早內容通過向量記憶召回。非特殊需求請勿調整。
                                            </p>
                                            {activeCharacter.contextUserStartMessageId && (
                                                <p className="text-[10px] text-sky-700 mt-1.5 leading-relaxed">
                                                    當前另有用戶斷點，實際原文範圍會在自適應上限內進一步縮小。
                                                </p>
                                            )}
                                        </div>
                                        <div className="shrink-0 flex flex-col gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => setSettingsContextRangeMode('manual')}
                                                className="px-3 py-1.5 rounded-xl bg-white border border-violet-200 text-[11px] font-bold text-violet-700"
                                            >
                                                自定義範圍
                                            </button>
                                            {activeCharacter.contextUserStartMessageId && (
                                                <button
                                                    type="button"
                                                    onClick={onRestoreAdaptiveContext}
                                                    className="px-3 py-1.5 rounded-xl bg-violet-600 text-[11px] font-bold text-white"
                                                >
                                                    一鍵還原
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center justify-between gap-2 mb-2">
                                        <label className="text-xs font-bold text-slate-400 uppercase">上下文最大條數 ({settingsContextLimit})</label>
                                        {(activeCharacter.autoArchiveEnabled || activeCharacter.contextFollowsMemoryPalaceHwm) && (
                                            <button
                                                type="button"
                                                onClick={onRestoreAdaptiveContext}
                                                className="text-[10px] font-bold text-violet-600 bg-violet-50 border border-violet-100 rounded-full px-2.5 py-1"
                                            >
                                                {activeCharacter.autoArchiveEnabled ? '一鍵恢復自適應' : '恢復水位跟隨'}
                                            </button>
                                        )}
                                    </div>
                                    <input
                                        type="range"
                                        min="10"
                                        max="5000"
                                        step="10"
                                        value={settingsContextLimit}
                                        onChange={e => {
                                            setSettingsContextRangeMode('manual');
                                            setSettingsContextLimit(parseInt(e.target.value));
                                        }}
                                        className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-primary"
                                    />
                                    <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>10 (省流)</span><span>5000 (最大範圍)</span></div>
                                    {(activeCharacter.autoArchiveEnabled || activeCharacter.contextFollowsMemoryPalaceHwm) && (
                                        <p className="text-[10px] text-amber-600 mt-2 leading-relaxed">
                                            自定義只改變 AI 可直接讀取的原文範圍，不會回退記憶宮殿水位線，也不會讓舊消息重新向量化。
                                        </p>
                                    )}
                                </>
                            )}
                        </div>

                        {/* 時間感知 / 自定義時區 / 線下時間感知 已統一遷移至「神經鏈接」角色設定頁 */}

                        <div className="pt-2 border-t border-slate-100">
                            <button onClick={() => setModalType('history-manager')} className="w-full py-3 bg-slate-50 text-slate-600 font-bold rounded-2xl border border-slate-200 active:scale-95 transition-transform flex items-center justify-center gap-2">
                                查看原文範圍 / 設置用戶斷點
                            </button>
                            <p className="text-[10px] text-slate-400 mt-2 text-center">查看拉桿上限、記憶水位線，並可在最大範圍內進一步縮小 AI 原文範圍。</p>
                        </div>

                        {/* 記憶宮殿：一鍵向量化所有聊天記錄 */}
                        {isMemoryPalaceEnabled && <p className="mt-3 rounded-xl bg-violet-50 p-3 text-xs leading-relaxed text-violet-700">
                            全自動記憶用戶大部分時候無需操作下方的一鍵向量化等手動工具。日常聊天會按條件自動整理；這些不是常規必點按鈕，僅在明確瞭解用途與影響時使用。查看和修改記憶可前往「神經鏈接」中的角色記憶頁。
                        </p>}
                        {isMemoryPalaceEnabled && onForceVectorize && (
                            <div className="pt-2 border-t border-slate-100">
                                <button
                                    type="button"
                                    onClick={() => setRetainRecentForVectorize?.(!retainRecentForVectorize)}
                                    className={`w-full mb-2.5 rounded-2xl border p-3 text-left transition-colors ${retainRecentForVectorize ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}
                                >
                                    <span className="flex items-center gap-2.5">
                                        <span className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${retainRecentForVectorize ? 'bg-amber-500 border-amber-500' : 'bg-white border-slate-300'}`}>
                                            {retainRecentForVectorize && <span className="text-white text-[11px] font-bold">✓</span>}
                                        </span>
                                        <span>
                                            <span className="block text-xs font-bold text-slate-700">為我保留最近 10 條注入到上下文</span>
                                            <span className="block text-[10px] text-slate-400 mt-0.5 leading-relaxed">不開啟則處理到當前最後一條，已處理原文不再直接發送給模型。</span>
                                        </span>
                                    </span>
                                </button>
                                <button
                                    onClick={() => { setModalType('memory-vectorize-confirm'); trackEvent('一键把聊天存进记忆宫殿'); }}
                                    disabled={isVectorizing}
                                    className="w-full py-3 bg-emerald-50 text-emerald-600 font-bold rounded-2xl border border-emerald-200 active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-70"
                                >
                                    {(vectorizePendingCount != null && vectorizePendingCount > 0)
                                        ? `🏰 一鍵存進記憶宮殿 · 待處理 ${vectorizePendingCount} 條`
                                        : (vectorizePendingCount === 0)
                                            ? '🏰 同步原文範圍 · 當前無待處理'
                                            : '🏰 一鍵把所有聊天存進記憶宮殿'}
                                </button>
                                <p className="text-[10px] text-slate-400 mt-2 text-center leading-relaxed">
                                    使用副 API 分批整理。正式開始前會再次說明影響，不會直接執行。
                                </p>
                            </div>
                        )}
                    </ChatSettingsSection>
                    <ChatSettingsSection title="翻譯與語音" summary="消息語言、語音與自動播放">
                        {/* Translation Settings */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex justify-between items-center cursor-pointer" onClick={onToggleTranslation}>
                                <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">消息翻譯</label>
                                <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${translationEnabled ? 'bg-primary' : 'bg-slate-200'}`}>
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${translationEnabled ? 'translate-x-4' : ''}`}></div>
                                </div>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                開啟後，AI 消息自動翻譯為「選」的語言顯示，點「譯」切換到目標語言。
                            </p>
                            {translationEnabled && (
                                <div className="mt-3 space-y-3">
                                    <TranslationLanguagePicker
                                        label="選（氣泡顯示語言）"
                                        value={translateSourceLang}
                                        tone="source"
                                        inputPlaceholder="自定義，如 粵語"
                                        onSelect={onSetTranslateSourceLang}
                                    />
                                    <TranslationLanguagePicker
                                        label="譯（翻譯目標語言）"
                                        value={translateTargetLang}
                                        tone="target"
                                        inputPlaceholder="自定義，如 中文（繁體）"
                                        onSelect={onSetTranslateLang}
                                    />
                                    <button
                                        type="button"
                                        onClick={onToggleTranslationExpanded}
                                        className="w-full flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left active:bg-slate-50"
                                    >
                                        <span>
                                            <span className="block text-[11px] font-bold text-slate-600">原文與譯文同時展開</span>
                                            <span className="block mt-0.5 text-[9px] leading-relaxed text-slate-400">開啟後不再逐條點擊切換，雙語氣泡會直接上下顯示兩種語言。</span>
                                        </span>
                                        <span className={`shrink-0 w-10 h-6 rounded-full p-1 transition-colors flex items-center ${translationExpanded ? 'bg-primary' : 'bg-slate-200'}`}>
                                            <span className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${translationExpanded ? 'translate-x-4' : ''}`} />
                                        </span>
                                    </button>
                                    {/* Preview */}
                                    <div className="text-[11px] text-center text-slate-500 bg-slate-50 rounded-lg py-2">
                                        選<span className="font-bold text-slate-700">{translateSourceLang || '?'}</span> 譯<span className="font-bold text-primary">{translateTargetLang || '?'}</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Voice TTS */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex justify-between items-center cursor-pointer" onClick={onToggleChatVoice}>
                                <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">語音消息</label>
                                <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${chatVoiceEnabled ? 'bg-emerald-400' : 'bg-slate-200'}`}>
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${chatVoiceEnabled ? 'translate-x-4' : ''}`}></div>
                                </div>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                開啟後，AI 回覆裡會出現語音條（需配置 MiniMax 和角色語音）。
                            </p>
                            {chatVoiceEnabled && (
                                <div className="mt-3 pt-3 border-t border-slate-100">
                                    <div className="flex justify-between items-center cursor-pointer" onClick={onToggleChatVoiceAutoPlay}>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase pointer-events-none">收到就自動播放</label>
                                        <div className={`w-9 h-5 rounded-full p-1 transition-colors flex items-center ${chatVoiceAutoPlay ? 'bg-emerald-400' : 'bg-slate-200'}`}>
                                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform ${chatVoiceAutoPlay ? 'translate-x-4' : ''}`}></div>
                                        </div>
                                    </div>
                                    <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                        開啟後收到消息就合成語音並播放。關閉時語音條照常出現，點一下才合成並播放，不聽就不消耗語音額度（也可以點「轉文字」直接看內容）。
                                    </p>
                                </div>
                            )}
                            {chatVoiceEnabled && (
                                <div className="mt-3">
                                    <label className="text-[10px] font-bold text-slate-400 mb-1.5 block">語音語種</label>
                                    <div className="flex flex-wrap gap-1.5">
                                        {VOICE_LANGUAGE_OPTIONS.map(opt => (
                                            <button key={opt.value} onClick={() => onSetChatVoiceLang?.(opt.value)}
                                                className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all ${chatVoiceLang === opt.value ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                    {chatVoiceLang === 'yue' && <p className="text-[10px] text-amber-600/80 mt-1.5">{CANTONESE_VOICE_SUPPORT_NOTE}</p>}
                                    {chatVoiceLang && <p className="text-[10px] text-emerald-600/70 mt-1.5">選擇非默認語種時，AI 台詞會先翻譯再生成語音。</p>}
                                </div>
                            )}
                        </div>
                    </ChatSettingsSection>
                    <ChatSettingsSection title="擴展功能" summary="小紅書與 HTML 卡片">
                        {/* XHS Toggle */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex justify-between items-center cursor-pointer" onClick={onToggleXhs}>
                                <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">小紅書</label>
                                <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${xhsEnabled ? 'bg-red-400' : 'bg-slate-200'}`}>
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${xhsEnabled ? 'translate-x-4' : ''}`}></div>
                                </div>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                                開啟後，角色在聊天中可以搜索、瀏覽、發帖、評論小紅書。需要在全局設置中配置 MCP 或 Cookie。
                            </p>
                        </div>

                        {/* HTML 模塊模式 */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex justify-between items-center cursor-pointer" onClick={onToggleHtmlMode}>
                                <label className="text-xs font-bold text-slate-400 uppercase pointer-events-none">HTML 模塊模式</label>
                                <div className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center ${htmlModeEnabled ? 'bg-fuchsia-500' : 'bg-slate-200'}`}>
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${htmlModeEnabled ? 'translate-x-4' : ''}`}></div>
                                </div>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                                開啟後注入"用 [html]...[/html] 包裹的精美卡片"提示詞，AI 會在合適場景輸出邀請函 / 票據 / 通知等可視化模塊。
                            </p>
                            {htmlModeEnabled && (
                                <div className="mt-3">
                                    <label className="text-[10px] font-bold text-slate-400 mb-1.5 block">自定義提示詞補充（追加在內置提示詞之後，不會覆蓋）</label>
                                    <textarea
                                        value={htmlModeCustomPrompt || ''}
                                        onChange={e => setHtmlModeCustomPrompt?.(e.target.value)}
                                        placeholder="比如：偏好暖色調 / 默認風格走 minimal 雜誌感 / 票據類必須含二維碼佔位…"
                                        className="w-full h-28 bg-slate-50 rounded-2xl p-3 text-[12px] resize-none border border-slate-200 focus:outline-none focus:border-fuchsia-300"
                                    />
                                    <p className="text-[10px] text-slate-400 mt-1">留空則只使用內置提示詞。</p>
                                </div>
                            )}
                        </div>
                    </ChatSettingsSection>
                    <ChatSettingsSection title="聊天記錄" summary="按範圍清理或保留最近消息">
                        {onOpenHistoryCleanup && <div>
                            <button type="button" onClick={onOpenHistoryCleanup} className="w-full rounded-2xl border border-red-100 bg-red-50 py-3 text-sm font-bold text-red-600">清理指定範圍 / 保留最近 N 條</button>
                            <p className="mt-2 text-center text-[10px] text-slate-400">按頁選擇記錄，永久刪除前需要兩次確認。</p>
                        </div>}
                    </ChatSettingsSection>
            </ChatSettingsPage>

            <Modal
                isOpen={modalType === 'memory-vectorize-confirm'}
                title="確認存進記憶宮殿"
                onClose={() => { if (!isVectorizing) setModalType('chat-settings'); }}
                footer={isVectorizing ? (
                    <div className="w-full py-3 rounded-2xl bg-emerald-50 text-emerald-700 text-center text-sm font-bold flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        {vectorizeProgress || '正在處理...'}
                    </div>
                ) : (
                    <div className="w-full flex gap-2">
                        <button type="button" onClick={() => setModalType('chat-settings')} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-600 font-bold">取消</button>
                        <button type="button" onClick={onForceVectorize} className="flex-1 py-3 rounded-2xl bg-emerald-500 text-white font-bold">確認開始</button>
                    </div>
                )}
            >
                <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
                        <p className="font-bold text-emerald-800 mb-2">按下確認後：</p>
                        <ul className="space-y-1.5 text-xs text-emerald-900/80 list-disc pl-4">
                            <li>當前可處理的聊天內容會全部完成記憶整理。</li>
                            <li>{retainRecentForVectorize ? '最近 10 條原文繼續注入聊天上下文。' : '已處理原文不再直接注入聊天上下文。'}</li>
                            <li>紫色水位線與橙色原文範圍會同步，待處理統計從新水位重新開始。</li>
                            <li className="font-bold text-red-600">該功能非常規使用功能，全自動模式下記憶宮殿會自己處理，如您確認確實需要使用該功能，請點擊“確認開始”</li>
                        </ul>
                    </div>
                    <p className="text-[11px] text-slate-400">處理期間請保持應用打開，不要清空聊天。任何一批失敗都不會移動水位線，可安全重試。</p>
                </div>
            </Modal>

            <Modal
                isOpen={modalType === 'memory-vectorize-result'}
                title="記憶處理完成"
                onClose={() => { setModalType('none'); }}
                footer={<button type="button" onClick={() => setModalType('none')} className="w-full py-3 rounded-2xl bg-emerald-500 text-white font-bold">知道了</button>}
            >
                <div className="space-y-3">
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4 text-center">
                        <div className="text-2xl mb-1">✓</div>
                        <p className="text-sm font-bold text-emerald-800">當前聊天的記憶處理邊界已同步</p>
                        <p className="text-[11px] text-emerald-700/70 mt-1">
                            處理 {vectorizeResult?.processedMessages || 0} 條內容 · 新增 {vectorizeResult?.storedMemories || 0} 條長期記憶
                        </p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-3.5 text-xs text-slate-600 leading-relaxed">
                        {(vectorizeResult?.retainedMessages || 0) > 0
                            ? <>最近 <b>{vectorizeResult?.retainedMessages}</b> 條原文會繼續注入聊天上下文；更早的已處理原文不再重複注入。</>
                            : <>已處理原文不會再直接注入聊天上下文，更早內容改由記憶宮殿按需召回。</>}
                    </div>
                    <p className="text-[11px] text-slate-400 text-center">向量化待處理統計已經從新的水位線重新開始。</p>
                    {vectorizeResult?.waterlineAlreadyAhead && (
                        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-2.5 leading-relaxed">
                            最近 10 條此前已經處理過。為避免重複向量化，水位線沒有回退，但這 10 條原文仍已按你的選擇保留在上下文中。
                        </p>
                    )}
                </div>
            </Modal>

            {/* Archive Settings Modal */}
            <Modal isOpen={modalType === 'archive-settings'} title="記憶歸檔設置" onClose={() => { if (!isSummarizing) setModalType('none'); }} footer={
                isSummarizing ?
                <div className="w-full py-3 bg-slate-100 text-indigo-600 font-bold rounded-2xl text-center flex items-center justify-center gap-2"><div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>{archiveProgress || '歸檔中...'}</div> :
                <button onClick={onArchive} disabled={isSummarizing} className="w-full py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200">開始歸檔</button>
            }>
                <div className="space-y-4">
                    {(() => {
                        const palaceOn = !!(activeCharacter as any).memoryPalaceEnabled;
                        const autoOn = !!(activeCharacter as any).autoArchiveEnabled;
                        const activePrompt = archivePrompts.find(p => p.id === selectedPromptId);
                        const activeName = activePrompt?.name || '理性精煉 (Rational)';
                        if (palaceOn && autoOn) {
                            return (
                                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-[11px] text-emerald-800 leading-relaxed">
                                    ✅ <b>自動歸檔已開啟</b>。palace 處理後系統會按日期自動把聊天歸檔到"本月日度總結"。<br/>
                                    自動歸檔走的是 <b>記憶宮殿內置風格</b>（保證向量檢索質量穩定），
                                    下方模板<b>只對這裡的"開始歸檔"按鈕生效</b>——你在這換風格不會影響自動歸檔。
                                </div>
                            );
                        }
                        if (palaceOn && !autoOn) {
                            return (
                                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900 leading-relaxed">
                                    ⚠️ 記憶宮殿已開，但<b>自動歸檔沒開</b>——記憶宮殿只在後台默默建記憶，不會寫進月度總結。<br/>
                                    想讓它自動寫 → 神經鏈接 → 角色 → 記憶宮殿開關下面的 <b>"📚 自動歸檔"</b>；
                                    或者繼續用下方按鈕手動按當前選中的 <b>「{activeName}」</b> 風格跑。
                                </div>
                            );
                        }
                        return (
                            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-[11px] text-slate-700 leading-relaxed">
                                📋 <b>純手動模式</b>（沒開記憶宮殿）。下方按鈕會用選中的
                                <b className="text-slate-900"> 「{activeName}」</b> 風格把聊天按天總結到"本月日度總結"。
                                歸檔完會自動隱藏已總結的舊消息（保留最近一部分可見）。
                            </div>
                        );
                    })()}
                    <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
                        <label className="text-[10px] font-bold text-indigo-400 uppercase mb-2 block">選擇提示詞模板</label>
                        <div className="flex flex-col gap-2">
                            {archivePrompts.map(p => {
                                const isSelected = selectedPromptId === p.id;
                                return (
                                <div key={p.id} onClick={() => setSelectedPromptId(p.id)} className={`p-3 rounded-lg border cursor-pointer flex items-center justify-between ${isSelected ? 'bg-white border-indigo-500 shadow-sm ring-1 ring-indigo-500' : 'bg-white/50 border-indigo-200 hover:bg-white'}`}>
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className={`text-xs font-bold ${isSelected ? 'text-indigo-700' : 'text-slate-600'}`}>{p.name}</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <button onClick={(e) => { e.stopPropagation(); setSelectedPromptId(p.id); onEditPrompt(); }} className="text-[10px] text-slate-400 hover:text-indigo-500 px-2 py-1 rounded bg-slate-100 hover:bg-indigo-50">編輯/查看</button>
                                        {!p.id.startsWith('preset_') && (
                                            <button onClick={(e) => { e.stopPropagation(); onDeletePrompt(p.id); }} className="text-[10px] text-red-300 hover:text-red-500 px-2 py-1 rounded hover:bg-red-50">×</button>
                                        )}
                                    </div>
                                </div>
                                );
                            })}
                        </div>
                        <button onClick={onCreatePrompt} className="mt-3 w-full py-2 text-xs font-bold text-indigo-500 border border-dashed border-indigo-300 rounded-lg hover:bg-indigo-100">+ 新建自定義提示詞</button>
                    </div>
                    <div className="text-[10px] text-slate-400 bg-slate-50 p-3 rounded-xl leading-relaxed">
                        • <b>理性精煉</b>: 適合生成條理清晰的事件日誌，便於 AI 長期記憶檢索。<br/>
                        • <b>日記風格</b>: 適合生成第一人稱的角色日記，更有代入感和情感色彩。<br/>
                        • 支持變量: <code>{'${dateStr}'}</code>, <code>{'${char.name}'}</code>, <code>{'${userProfile.name}'}</code>, <code>{'${rawLog}'}</code>
                    </div>
                </div>
            </Modal>

            {/* Prompt Editor Modal */}
            <Modal isOpen={modalType === 'prompt-editor'} title="編輯提示詞" onClose={() => setModalType('archive-settings')} footer={<button onClick={onSavePrompt} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">保存預設</button>}>
                <div className="space-y-3">
                    <input 
                        value={editingPrompt?.name || ''} 
                        onChange={e => setEditingPrompt((prev: any) => prev ? {...prev, name: e.target.value} : null)}
                        placeholder="預設名稱"
                        className="w-full px-4 py-2 bg-slate-100 rounded-xl text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <textarea 
                        value={editingPrompt?.content || ''} 
                        onChange={e => setEditingPrompt((prev: any) => prev ? {...prev, content: e.target.value} : null)}
                        className="w-full h-64 bg-slate-100 rounded-xl p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 leading-relaxed"
                        placeholder="輸入提示詞內容..."
                    />
                </div>
            </Modal>

            {/* History Manager Modal */}
            <Modal
                isOpen={modalType === 'history-manager'} title="AI 原文讀取範圍" onClose={() => { setModalType('none'); setHistoryPage(0); setHistorySearch(''); }}
                footer={<><button onClick={() => onSetHistoryStart(undefined)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">清除用戶斷點</button><button onClick={() => { setModalType('none'); setHistoryPage(0); setHistorySearch(''); }} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">完成</button></>}
            >
                <div className="space-y-2 max-h-[50vh] overflow-y-auto no-scrollbar p-1">
                    <p className="text-xs text-slate-400 text-center mb-2"><b>短按</b>消息 = 設置用戶斷點（只能縮小範圍） · <b>長按</b>消息 = 跳轉查看原文</p>
                    <div className="grid gap-2 mb-2">
                        <div className="bg-violet-50 border border-violet-200 rounded-xl p-2.5 text-[11px] text-violet-800 leading-relaxed">
                            <b>紫色 · 記憶宮殿水位線</b>：此前消息已經處理，不會因調整上下文再次向量化。
                        </div>
                        <div className="bg-orange-50 border border-orange-200 rounded-xl p-2.5 text-[11px] text-orange-800 leading-relaxed">
                            <b>橙色 · 最大範圍起點</b>：由{contextRangeSnapshot?.mode === 'adaptive' ? (activeCharacter.contextFollowsMemoryPalaceHwm ? '記憶水位線' : '全自動記憶') : `拉桿 ${settingsContextLimit} 條`}決定，用戶斷點不能越過它讀取更早內容。
                            {contextRangeSnapshot?.mode === 'adaptive' && !contextRangeSnapshot.maxRangeStartMessageId && ' 當前水位線後為 0 條，因此列表中沒有額外橙色起點。'}
                        </div>
                        {contextRangeSnapshot?.userStartMessageId && (
                            <div className="bg-sky-50 border border-sky-200 rounded-xl p-2.5 text-[11px] text-sky-800 leading-relaxed">
                                <b>藍色 · 用戶斷點</b>：只在最大範圍內進一步隱藏更早原文；被移動中的最大範圍越過後會自動失效。
                            </div>
                        )}
                    </div>
                    <div className="sticky top-0 bg-white/95 backdrop-blur-sm z-10 pb-1.5 -mx-1 px-1">
                        <div className="relative">
                            <input
                                type="text"
                                value={historySearch}
                                onChange={(e) => { setHistorySearch(e.target.value); setHistoryPage(0); }}
                                placeholder="模糊搜索歷史消息（關鍵詞 / 字符順序匹配）"
                                className="w-full pl-8 pr-8 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-primary focus:bg-white transition-colors"
                            />
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                            </svg>
                            {historySearch && (
                                <button onClick={() => { setHistorySearch(''); setHistoryPage(0); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-base leading-none">×</button>
                            )}
                        </div>
                    </div>
                    {(() => {
                        const reversed = allHistoryMessages.slice().reverse();
                        const query = historySearch.trim();
                        const filtered = query ? reversed.filter(message => chatMessageFuzzyMatchesKeyword(message, query)) : reversed;
                        const limited = query ? filtered.slice(0, HISTORY_SEARCH_MAX) : filtered;
                        const totalPages = Math.max(1, Math.ceil(limited.length / HISTORY_PAGE_SIZE));
                        const pageMessages = limited.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);
                        const hwm = contextRangeSnapshot?.hwm || 0;
                        const maxCut = contextRangeSnapshot?.maxRangeStartMessageId;
                        const userCut = contextRangeSnapshot?.userStartMessageId;
                        const effectiveCut = contextRangeSnapshot?.effectiveStartMessageId;
                        return (<>
                            {query && (
                                <div className="text-xs text-slate-500 px-1 py-1">
                                    找到 <b className="text-primary">{filtered.length}</b> 條匹配
                                    {filtered.length > HISTORY_SEARCH_MAX && <span className="text-slate-400">（僅顯示前 {HISTORY_SEARCH_MAX} 條）</span>}
                                </div>
                            )}
                            {!query && filtered.length === 0 && (
                                <div className="text-xs text-slate-400 text-center py-4">暫無歷史消息</div>
                            )}
                            {query && filtered.length === 0 && (
                                <div className="text-xs text-slate-400 text-center py-4">沒有匹配的消息</div>
                            )}
                            {limited.length > HISTORY_PAGE_SIZE && (
                                <div className="flex items-center justify-between px-1 py-1">
                                    <button onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={historyPage === 0} className={`px-3 py-1 text-xs rounded-lg ${historyPage === 0 ? 'text-slate-300' : 'text-primary hover:bg-primary/10'}`}>上一頁</button>
                                    <span className="text-xs text-slate-400">{historyPage + 1} / {totalPages}（共 {limited.length} 條）</span>
                                    <button onClick={() => setHistoryPage(p => Math.min(totalPages - 1, p + 1))} disabled={historyPage >= totalPages - 1} className={`px-3 py-1 text-xs rounded-lg ${historyPage >= totalPages - 1 ? 'text-slate-300' : 'text-primary hover:bg-primary/10'}`}>下一頁</button>
                                </div>
                            )}
                            {pageMessages.map(m => {
                                const isWatermark = hwm === m.id;
                                const isMaxStart = maxCut === m.id;
                                const isUserStart = userCut === m.id;
                                const isHidden = !!(effectiveCut && m.id < effectiveCut);
                                const isVectorized = hwm > 0 && m.id <= hwm;
                                const cls = isUserStart
                                    ? 'bg-sky-50 border-sky-300 ring-1 ring-sky-300'
                                    : isMaxStart
                                        ? 'bg-orange-50 border-orange-300 ring-1 ring-orange-300'
                                        : isWatermark
                                            ? 'bg-violet-50 border-violet-300 ring-1 ring-violet-300'
                                            : isHidden
                                                ? 'bg-slate-50 border-slate-100 opacity-55'
                                                : 'bg-white border-slate-100 hover:bg-slate-50';
                                const contentClass = isHidden ? 'text-slate-400 line-through decoration-slate-300/70' : 'text-slate-500';
                                return (
                                    <div
                                        key={m.id}
                                        id={`history-msg-${m.id}`}
                                        onClick={() => handleHistoryItemClick(m.id)}
                                        onPointerDown={() => startHistoryLongPress(m.id)}
                                        onPointerUp={cancelHistoryLongPress}
                                        onPointerLeave={cancelHistoryLongPress}
                                        onPointerCancel={cancelHistoryLongPress}
                                        onContextMenu={(e) => e.preventDefault()}
                                        className={`p-3 rounded-xl border cursor-pointer text-xs flex gap-2 items-start transition-colors select-none ${cls}`}
                                    >
                                        <span className="text-slate-400 font-mono whitespace-nowrap pt-0.5">[{new Date(m.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}]</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="font-bold text-slate-600 mb-0.5">{m.role === 'user' ? '我' : activeCharacter.name}</div>
                                            <div className="truncate">{renderHighlighted(m.content || '', query, contentClass)}</div>
                                        </div>
                                        <div className="flex flex-wrap justify-end gap-1 max-w-[42%]">
                                            {isWatermark && <span className="text-violet-600 font-bold text-[9px] bg-white px-1.5 rounded-full border border-violet-200">水位線</span>}
                                            {isMaxStart && <span className="text-orange-600 font-bold text-[9px] bg-white px-1.5 rounded-full border border-orange-200">最大範圍</span>}
                                            {isUserStart && <span className="text-sky-600 font-bold text-[9px] bg-white px-1.5 rounded-full border border-sky-200">用戶斷點</span>}
                                            {!isWatermark && !isMaxStart && !isUserStart && isHidden && <span className="text-slate-400 font-bold text-[9px] bg-white px-1.5 rounded-full border border-slate-200">AI 不讀原文</span>}
                                            {!isWatermark && !isMaxStart && !isUserStart && isVectorized && !isHidden && <span className="text-violet-400 font-bold text-[9px] bg-white px-1.5 rounded-full border border-violet-100">已向量化</span>}
                                        </div>
                                    </div>
                                );
                            })}
                            {limited.length > HISTORY_PAGE_SIZE && (
                                <div className="flex items-center justify-center px-1 pt-2">
                                    <span className="text-xs text-slate-400">{historyPage + 1} / {totalPages}</span>
                                </div>
                            )}
                        </>);
                    })()}
                </div>
            </Modal>

            <Modal isOpen={modalType === 'message-options'} title="消息操作" onClose={() => setModalType('none')}>
                <div className="space-y-3">
                    <button onClick={onEnterSelectionMode} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        多選 / 批量刪除
                    </button>
                    <button onClick={onReplyMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        引用 / 回覆
                    </button>
                    {selectedMessage?.type === 'text' && (
                        <button onClick={onEditMessageStart} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            編輯內容
                        </button>
                    )}
                    {selectedMessage?.type === 'text' && (
                        <button onClick={onCopyMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            複製文字
                        </button>
                    )}
                    {selectedMessage && onToggleMessageFavorite && (
                        <button onClick={() => { onToggleMessageFavorite(); setModalType('none'); }} className={`w-full py-3 font-medium rounded-2xl transition-colors flex items-center justify-center gap-2 ${messageFavorited ? 'bg-violet-100 text-violet-700 active:bg-violet-200' : 'bg-violet-50 text-violet-600 active:bg-violet-100'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={messageFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m11.48 3.499-2.13 4.316-4.763.692c-.963.14-1.348 1.323-.651 2.002l3.447 3.36-.814 4.744c-.165.96.842 1.691 1.703 1.238L12.532 17.6l4.26 2.24c.862.453 1.869-.278 1.704-1.238l-.814-4.744 3.447-3.36c.697-.679.312-1.862-.651-2.002l-4.763-.692-2.13-4.316c-.43-.873-1.675-.873-2.105.011Z" /></svg>
                            {messageFavorited
                                ? (selectedMessage.type === 'image' ? '取消收藏圖片' : '取消收藏聊天消息')
                                : (selectedMessage.type === 'image' ? '收藏圖片' : '收藏聊天消息')}
                        </button>
                    )}
                    {voiceAvailable && selectedMessage?.role === 'assistant' && selectedMessage?.type === 'text' && onGenerateVoice && (
                        <button onClick={() => { onGenerateVoice(); setModalType('none'); }} className="w-full py-3 bg-emerald-50 text-emerald-600 font-medium rounded-2xl active:bg-emerald-100 transition-colors flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" /></svg>
                            轉換語音
                        </button>
                    )}
                    {voiceDownloadable && onDownloadVoice && (
                        <button onClick={() => { onDownloadVoice(); setModalType('none'); }} className="w-full py-3 bg-sky-50 text-sky-600 font-medium rounded-2xl active:bg-sky-100 transition-colors flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                            下載語音
                        </button>
                    )}
                    {voiceCollectable && selectedMessage?.role === 'assistant' && onToggleVoiceFavorite && (
                        <button onClick={() => { onToggleVoiceFavorite(); setModalType('none'); }} className={`w-full py-3 font-medium rounded-2xl transition-colors flex items-center justify-center gap-2 ${voiceFavorited ? 'bg-amber-100 text-amber-700 active:bg-amber-200' : 'bg-amber-50 text-amber-600 active:bg-amber-100'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={voiceFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m11.48 3.499-2.13 4.316-4.763.692c-.963.14-1.348 1.323-.651 2.002l3.447 3.36-.814 4.744c-.165.96.842 1.691 1.703 1.238L12.532 17.6l4.26 2.24c.862.453 1.869-.278 1.704-1.238l-.814-4.744 3.447-3.36c.697-.679.312-1.862-.651-2.002l-4.763-.692-2.13-4.316c-.43-.873-1.675-.873-2.105.011Z" /></svg>
                            {voiceFavorited ? '取消收藏語音' : '收藏語音'}
                        </button>
                    )}
                    <button onClick={onDeleteMessage} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2">
                        刪除消息
                    </button>
                </div>
            </Modal>

            {/* 圖片全屏放大預覽（點圖片本身打開，跟長按的"消息操作"菜單分開） */}
            {modalType === 'image-zoom' && selectedMessage?.type === 'image' && selectedMessage.content && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/85" onClick={() => setModalType('none')}>
                    <button
                        type="button"
                        onClick={() => setModalType('none')}
                        aria-label="關閉"
                        className="absolute z-10 w-10 h-10 grid place-items-center rounded-full bg-white/10 text-white"
                        style={{ top: 'max(16px, env(safe-area-inset-top))', right: 16 }}
                    >
                        <X size={22} />
                    </button>
                    <div className="absolute z-10 flex items-center gap-2" style={{ top: 'max(16px, env(safe-area-inset-top))', left: 16 }}>
                        {onRegenerateImage && selectedMessage.role === 'assistant' && typeof selectedMessage.metadata?.imagePrompt === 'string' && (
                            <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); onRegenerateImage(selectedMessage); }}
                                disabled={regeneratingImageId === selectedMessage.id}
                                aria-label="重新生成"
                                className="w-10 h-10 grid place-items-center rounded-full bg-white/10 text-white disabled:opacity-50"
                            >
                                <ArrowsClockwise size={18} weight="bold" className={regeneratingImageId === selectedMessage.id ? 'animate-spin' : ''} />
                            </button>
                        )}
                        {onDownloadImage && (
                            <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); onDownloadImage(selectedMessage); }}
                                aria-label="下載"
                                className="w-10 h-10 grid place-items-center rounded-full bg-white/10 text-white"
                            >
                                <DownloadSimple size={18} weight="bold" />
                            </button>
                        )}
                    </div>
                    <TokenImg value={selectedMessage.content} alt="" className="max-w-full max-h-full object-contain" onClick={(event) => event.stopPropagation()} />
                </div>
            )}

             <Modal
                isOpen={modalType === 'delete-emoji'} title="刪除表情包" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={onDeleteEmoji} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">刪除</button></>}
            >
                <div className="flex flex-col items-center gap-4 py-2">
                    {Array.isArray(selectedEmoji) ? (
                        <div className="flex flex-wrap justify-center gap-2 max-h-48 overflow-y-auto no-scrollbar w-full px-2">
                            {selectedEmoji.map((e: any, idx: number) => (
                                <TokenImg key={idx} value={e.url} className="w-16 h-16 object-contain rounded-xl border border-slate-200" />
                            ))}
                        </div>
                    ) : (
                        selectedEmoji && <TokenImg value={selectedEmoji.url} className="w-24 h-24 object-contain rounded-xl border" />
                    )}
                    <p className="text-center text-sm text-slate-500">
                        {Array.isArray(selectedEmoji) ? `確定要刪除這 ${selectedEmoji.length} 個表情包嗎？` : "確定要刪除這個表情包嗎？"}
                    </p>
                </div>
            </Modal>

            {/* Emoji Options Modal (shown on long-press) */}
            <Modal isOpen={modalType === 'emoji-options'} title="表情包操作" onClose={() => setModalType('none')}>
                <div className="flex flex-col items-center gap-4 py-1">
                    {selectedEmoji && !Array.isArray(selectedEmoji) && (
                        <div className="flex flex-col items-center gap-2">
                            <TokenImg value={selectedEmoji.url} className="w-20 h-20 object-contain rounded-xl border border-slate-200" />
                            <span className="text-sm font-medium text-slate-600 max-w-[12rem] truncate">{selectedEmoji.name}</span>
                        </div>
                    )}
                    <div className="w-full space-y-3">
                        <button
                            onClick={() => { if (selectedEmoji && !Array.isArray(selectedEmoji)) setNewEmojiName(selectedEmoji.name); setModalType('rename-emoji'); }}
                            className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                            </svg>
                            修改名稱
                        </button>
                        <button
                            onClick={() => setModalType('delete-emoji')}
                            className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                            </svg>
                            刪除
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Rename Emoji Modal */}
            <Modal
                isOpen={modalType === 'rename-emoji'} title="修改表情包名稱" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={onRenameEmoji} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">保存</button></>}
            >
                <input
                    value={newEmojiName}
                    onChange={e => setNewEmojiName(e.target.value)}
                    placeholder="輸入表情包名稱..."
                    className="w-full bg-slate-100 rounded-2xl px-5 py-4 text-base font-bold focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all text-slate-700"
                    autoFocus
                />
            </Modal>

            {/* Delete Category Modal */}
            <Modal
                isOpen={modalType === 'delete-category'} title="刪除分類" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={onDeleteCategory} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">刪除</button></>}
            >
                <div className="py-4 text-center">
                    <p className="text-sm text-slate-600">確定要刪除分類 <br/><span className="font-bold">"{selectedCategory?.name}"</span> 嗎？</p>
                    <p className="text-[10px] text-red-400 mt-2">注意：分類下的所有表情也將被刪除！</p>
                </div>
            </Modal>

            <Modal isOpen={modalType === 'rename-category'} title="重命名分類" onClose={() => setModalType('none')}
                footer={<button onClick={onRenameCategory} className="w-full py-3 bg-primary text-white rounded-2xl">保存</button>}>
                <input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} placeholder="輸入分類名稱" autoFocus className="w-full p-3 bg-slate-50 rounded-xl" />
            </Modal>
            {/* Category Options Modal (shown on long-press) */}
            <Modal isOpen={modalType === 'category-options'} title="分類操作" onClose={() => setModalType('none')}>
                <div className="space-y-3">
                    <button onClick={onDownloadCategory} className="w-full py-3 bg-slate-50 text-slate-700 rounded-2xl">下載分類全部原圖</button>
                    {selectedCategory && !selectedCategory.isSystem && selectedCategory.id !== 'default' && <button onClick={() => { setNewCategoryName(selectedCategory.name); setModalType('rename-category'); }} className="w-full py-3 bg-slate-50 text-slate-700 rounded-2xl">重命名分類</button>}
                    <button onClick={openVisibilityModal} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                        設置可見角色
                    </button>
                    {selectedCategory && !selectedCategory.isSystem && selectedCategory.id !== 'default' && (
                        <button onClick={() => setModalType('delete-category')} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                            </svg>
                            刪除分類
                        </button>
                    )}
                </div>
            </Modal>

            {/* Category Visibility Modal */}
            <Modal
                isOpen={modalType === 'category-visibility'} title={`"${selectedCategory?.name}" 可見角色`} onClose={() => setModalType('none')}
                footer={<button onClick={handleSaveVisibility} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">保存設置</button>}
            >
                <div className="space-y-3">
                    <p className="text-xs text-slate-400 leading-relaxed">
                        選擇哪些角色可以使用此表情分組。不勾選任何角色表示所有角色均可使用。
                    </p>
                    <div className="space-y-2 max-h-[40vh] overflow-y-auto no-scrollbar">
                        {allCharacters.map(c => (
                            <div
                                key={c.id}
                                onClick={() => toggleVisibilityChar(c.id)}
                                className={`flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all ${visibilitySelection.has(c.id) ? 'bg-primary/5 border-primary/30' : 'bg-white border-slate-100 hover:bg-slate-50'}`}
                            >
                                <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors shrink-0 ${visibilitySelection.has(c.id) ? 'bg-primary border-primary' : 'bg-slate-100 border-slate-300'}`}>
                                    {visibilitySelection.has(c.id) && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                </div>
                                <TokenImg value={c.avatar} className="w-9 h-9 rounded-xl object-cover" />
                                <div className="flex-1 min-w-0">
                                    <div className="font-bold text-sm text-slate-700">{c.name}</div>
                                    <div className="text-[10px] text-slate-400 truncate">{c.description}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                    {visibilitySelection.size > 0 && (
                        <div className="text-[11px] text-center text-slate-500 bg-slate-50 rounded-lg py-2">
                            已選 <span className="font-bold text-primary">{visibilitySelection.size}</span> 個角色可使用此分組
                        </div>
                    )}
                </div>
            </Modal>

            <Modal
                isOpen={modalType === 'edit-message'} title="編輯內容" onClose={() => setModalType('none')}
                footer={<><button onClick={() => setModalType('none')} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={onConfirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">保存</button></>}
            >
                <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed"
                />
            </Modal>

            {/* Schedule Modal */}
            <Modal
                isOpen={modalType === 'schedule'} title={`${activeCharacter?.name || '角色'}の日程/情緒`} onClose={() => setModalType('none')}
            >
                <div className="max-h-[70vh] overflow-y-auto -mx-2 px-2">
                    {/* 總開關：關閉時不調副 API、不生成日程、不注入情緒 buff */}
                    {onToggleScheduleFeature && (
                        <div className="mb-4 bg-slate-50 border border-slate-200 rounded-2xl p-3">
                            <div className="flex items-center justify-between">
                                <div className="flex-1 min-w-0 pr-3">
                                    <p className="text-xs font-bold text-slate-700">日程與情緒 Buff</p>
                                    <p className="text-[10px] text-slate-500 leading-relaxed mt-0.5">
                                        {isScheduleFeatureEnabled
                                            ? '已開啟：角色會有今日日程，並在聊天中帶上當下情緒。'
                                            : '已關閉：不調副 API，不生成日程，不注入情緒 buff。'}
                                    </p>
                                </div>
                                <button
                                    onClick={onToggleScheduleFeature}
                                    aria-label="切換日程與情緒總開關"
                                    className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center flex-shrink-0 ${isScheduleFeatureEnabled ? 'bg-primary' : 'bg-slate-300'}`}
                                >
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${isScheduleFeatureEnabled ? 'translate-x-4' : ''}`}></div>
                                </button>
                            </div>
                        </div>
                    )}

                    {isScheduleFeatureEnabled && (
                        <>
                            {/* Schedule Style Selector */}
                            {onScheduleStyleChange && (
                                <div className="mb-4">
                                    {!activeCharacter?.scheduleStyle && (
                                        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 mb-3">
                                            <p className="text-xs text-amber-700 font-bold mb-1">請選擇日程風格</p>
                                            <p className="text-[11px] text-amber-600 leading-relaxed">
                                                不同風格會影響角色的內心獨白生成方式。選擇後會自動重新生成今日日程。
                                            </p>
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => onScheduleStyleChange('lifestyle')}
                                            disabled={isScheduleGenerating}
                                            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                                                (activeCharacter?.scheduleStyle || 'lifestyle') === 'lifestyle'
                                                    ? 'bg-violet-100 border-violet-300 text-violet-700'
                                                    : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                                            }`}
                                        >
                                            <span className="block text-sm mb-0.5">生活系</span>
                                            <span className="block text-[10px] opacity-70 font-normal">虛構日常 · 跑步做飯逛街</span>
                                        </button>
                                        <button
                                            onClick={() => onScheduleStyleChange('mindful')}
                                            disabled={isScheduleGenerating}
                                            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                                                activeCharacter?.scheduleStyle === 'mindful'
                                                    ? 'bg-teal-100 border-teal-300 text-teal-700'
                                                    : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                                            }`}
                                        >
                                            <span className="block text-sm mb-0.5">意識系</span>
                                            <span className="block text-[10px] opacity-70 font-normal">真實內心 · 不虛構不說謊</span>
                                        </button>
                                    </div>
                                </div>
                            )}

                            <ScheduleCard
                                schedule={scheduleData || null}
                                character={activeCharacter}
                                compact={false}
                                onEdit={onScheduleEdit}
                                onDelete={onScheduleDelete}
                                onReroll={onScheduleReroll}
                                onCoverImageChange={onScheduleCoverChange}
                                onPlayTheater={onPlayTheater}
                                isGenerating={isScheduleGenerating}
                            />
                            <p className="text-[10px] text-slate-400 text-center mt-3 leading-relaxed">
                                點擊日程項可編輯 · 長按可刪除
                            </p>

                            {/* 當前情緒狀態 — 從下面收合的「情緒/意識流API」拆出來，單獨常駐顯示，放在日程和心聲中間 */}
                            {activeCharacter && onClearBuffs && (
                                <div className="mt-4 pt-4 border-t border-slate-100">
                                    <EmotionStatusPanel char={activeCharacter} onClearBuffs={onClearBuffs} />
                                </div>
                            )}
                        </>
                    )}

                    {/* 心聲 / 好感度 — 用戶自定義標題 + 提示詞，獨立於日程總開關 */}
                    {activeCharacter && onSaveInnerVoices && onGenerateInnerVoice && (
                        <div className="mt-4 pt-4 border-t border-slate-100">
                            <CustomMeterPanel
                                kind="text"
                                heading="心聲"
                                icon="💭"
                                description="針對你自定義的標題，生成一段角色的第一人稱內心獨白。"
                                entries={activeCharacter.innerVoices || []}
                                onChange={onSaveInnerVoices}
                                onGenerate={onGenerateInnerVoice}
                                emptyHint="還沒有心聲條目——點下面「+ 新增心聲」，填個標題和提示詞試試。"
                            />
                        </div>
                    )}
                    {activeCharacter && onSaveAffinities && onGenerateAffinity && (
                        <div className="mt-4 pt-4 border-t border-slate-100">
                            <CustomMeterPanel
                                kind="number"
                                heading="好感度"
                                icon="💗"
                                description="針對你自定義的標題，評估一個 0-100 的數值條。"
                                entries={activeCharacter.affinities || []}
                                onChange={onSaveAffinities}
                                onGenerate={onGenerateAffinity}
                                emptyHint="還沒有好感度條目——點下面「+ 新增好感度」，填個標題和提示詞試試。"
                            />
                        </div>
                    )}

                    {/* 情緒 / 意識流 API — 與日程強制同步；預設一多這塊會很長，收合起來放最下面 */}
                    {activeCharacter && apiPresets && onAddApiPreset && onSaveEmotion && (
                        <div className="mt-4 pt-4 border-t border-slate-100">
                            <ChatSettingsSection title="情緒 / 意識流 API" summary="副 API 配置與我的預設">
                                <EmotionSettingsPanel
                                    char={activeCharacter}
                                    apiPresets={apiPresets}
                                    addApiPreset={onAddApiPreset}
                                    onSave={onSaveEmotion}
                                />
                            </ChatSettingsSection>
                        </div>
                    )}
                </div>
            </Modal>
        </>
    );
};

export default ChatModals;
